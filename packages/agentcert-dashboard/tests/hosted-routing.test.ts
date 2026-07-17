import { describe, expect, it } from "vitest";

import { buildHostedWorkspaceUrl, resolveHostedRoute } from "../src/hosted-routing";

describe("hosted workspace routing", () => {
  it("opens the account center from a direct link", () => {
    expect(resolveHostedRoute("?view=account")).toEqual({ view: "account" });
  });

  it("preserves the project and focus for an email-alert deep link", () => {
    expect(resolveHostedRoute("?view=integrations&focus=email-alerts&project=project-1")).toEqual({
      view: "integrations",
      focus: "email-alerts",
      projectId: "project-1",
    });
  });

  it("falls back to overview for an unknown view", () => {
    expect(resolveHostedRoute("?view=unknown")).toEqual({ view: "overview" });
  });

  it("builds a stable project-scoped workspace URL", () => {
    expect(buildHostedWorkspaceUrl("https://agentcert.app/", {
      view: "integrations",
      focus: "email-alerts",
      projectId: "project/1",
    })).toBe("https://agentcert.app/app?view=integrations&focus=email-alerts&project=project%2F1");
  });
});
