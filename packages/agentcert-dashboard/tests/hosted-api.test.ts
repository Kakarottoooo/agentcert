import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadHostedRunAnalysis,
  createHostedProject,
  loadHostedOnboarding,
  loadHostedTeam,
  loadAdminPilotReport,
  HostedApiError,
  readHostedAuthCallbackError,
  requestPasswordReset,
  requestHostedLegalHold,
  resendSignUpConfirmation,
  reviewHostedFailure,
  sendHostedTestNotification,
  updatePassword,
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

  it("sends password recovery to the branded account center", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPasswordReset(config, "user@example.com")).resolves.toBe(
      "Password reset email sent. Use the newest link to choose a new password.",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/recover?redirect_to=https%3A%2F%2Fagentcert.example.com%2Fapp%3Fview%3Daccount%26mode%3Dpassword-recovery",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "user@example.com" }),
      }),
    );
  });

  it("updates a password only through the authenticated Supabase user endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updatePassword(config, { accessToken: "recovery-token" }, "a-secure-new-password"))
      .resolves.toBe("Password updated. You can continue using this session.");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/user",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ authorization: "Bearer recovery-token" }),
        body: JSON.stringify({ password: "a-secure-new-password" }),
      }),
    );
  });
});

describe("hosted run analysis", () => {
  it("loads a period-bounded platform pilot report", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: "agentcert.pilot_funnel.v0.2", periodDays: 30, stages: [], projects: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadAdminPilotReport({ accessToken: "admin-token" }, 30);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/admin/pilot-report?days=30",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer admin-token" }) }),
    );
  });

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

  it("keeps team and new-project requests scoped to the selected organization", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "project-3", organizationId: "org-2", name: "Team project" }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ organization: { id: "org-2" }, currentMembership: { role: "admin" }, members: [], invitations: [], audit: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createHostedProject({ accessToken: "user-token" }, "Team project", "org-2");
    await loadHostedTeam({ accessToken: "user-token" }, "org-2");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/v1/projects", expect.objectContaining({ body: JSON.stringify({ name: "Team project", organizationId: "org-2" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/v1/organizations/org-2/team", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer user-token" }) }));
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

  it("queues a test alert for one verified project destination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "job-1", alertType: "test_alert", status: "pending",
    }), { status: 202, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await sendHostedTestNotification({ accessToken: "user-token" }, "project-1", "destination-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/projects/project-1/notification-destinations/destination-1/test",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
