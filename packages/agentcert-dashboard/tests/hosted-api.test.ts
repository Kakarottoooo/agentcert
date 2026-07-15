import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readHostedAuthCallbackError,
  resendSignUpConfirmation,
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
