import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadHostedRunAnalysis,
  createHostedProject,
  loadHostedOnboarding,
  HostedApiError,
  readHostedAuthCallbackError,
  requestHostedLegalHold,
  resendSignUpConfirmation,
  reviewHostedFailure,
  type HostedConfig,
} from "../src/hosted-api";

const config: HostedConfig = {
  kind: "agentcert.control_plane_config",
  hosted: true,
  publicUrl: "https://agentcert.example.com",
  auth: {
    provider: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    registrationOpen: true,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hosted signup recovery", () => {
  it("resends signup confirmation to the configured public URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resendSignUpConfirmation(config, "user@example.com")).resolves.toBe(
      "Confirmation email sent. Use the newest link to finish signing up.",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/resend?redirect_to=https%3A%2F%2Fagentcert.example.com",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "user@example.com", type: "signup" }),
      }),
    );
  });

  it("turns an expired callback into an actionable message and clears the hash", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        hash: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
        pathname: "/",
        search: "",
      },
      history: { replaceState },
    });

    expect(readHostedAuthCallbackError()).toBe(
      "This confirmation link is invalid or has expired. Enter your email and request a new confirmation email.",
    );
    expect(replaceState).toHaveBeenCalledWith({}, "", "/");
  });

  it("ignores URL fragments that are not auth errors", () => {
    vi.stubGlobal("window", {
      location: { hash: "#section", pathname: "/", search: "" },
      history: { replaceState: vi.fn() },
    });

    expect(readHostedAuthCallbackError()).toBeUndefined();
  });
});

describe("hosted run analysis", () => {
  it("creates projects and loads computed onboarding status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "project-2", name: "Coding agents" }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projectId: "project-2", completedSteps: 0, totalSteps: 3, complete: false, steps: [], connection: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createHostedProject({ accessToken: "user-token" }, "Coding agents");
    await loadHostedOnboarding({ accessToken: "user-token" }, "project-2");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/projects", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Coding agents" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/v1/projects/project-2/onboarding", expect.any(Object));
  });

  it("preserves structured diagnosis and request IDs from hosted errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "API key is not scoped to this project.", code: "project_scope_mismatch",
      recovery: "Create a key in the selected project.", requestId: "request-123",
    }), { status: 403, headers: { "content-type": "application/json" } })));

    await expect(loadHostedOnboarding({ accessToken: "wrong-key" }, "project-2")).rejects.toMatchObject<Partial<HostedApiError>>({
      status: 403, code: "project_scope_mismatch", requestId: "request-123", recovery: "Create a key in the selected project.",
    });
  });

  it("loads the unified analysis endpoint with the human session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      run: { id: "run-1" }, events: [], evidence: [], incidents: [], reviews: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadHostedRunAnalysis({ accessToken: "user-token" }, "project-1", "run-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/projects/project-1/runs/run-1/analysis",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer user-token" }) }),
    );
  });

  it("submits legal hold applications through the project-scoped endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "hold-1", status: "requested" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await requestHostedLegalHold(
      { accessToken: "user-token" },
      "project-1",
      "Preserve evidence for an active enterprise legal matter.",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/projects/project-1/legal-holds",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "Preserve evidence for an active enterprise legal matter." }),
      }),
    );
  });

  it("submits structured human taxonomy review fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "review-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      patternKey: "finding-1",
      type: "ui_drift",
      status: "confirmed",
      confidence: 0.9,
      taxonomyRationale: { primaryReason: "The DOM changed before the click." },
    };

    await reviewHostedFailure({ accessToken: "user-token" }, "project-1", "run-1", input);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/projects/project-1/runs/run-1/failure-reviews",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
  });
});
