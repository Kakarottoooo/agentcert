import { describe, expect, it } from "vitest";

import { buildHostedWorkspaceUrl, resolveHostedRoute, targetForNextAction } from "../src/hosted-routing";

describe("hosted workspace routing", () => {
  it("opens the account center from a direct link", () => {
    expect(resolveHostedRoute("?view=account")).toEqual({ view: "account" });
  });

  it("opens team access from a direct project link", () => {
    expect(resolveHostedRoute("?view=team&project=project-1")).toEqual({ view: "team", projectId: "project-1" });
  });

  it("preserves the project and focus for an email-alert deep link", () => {
    expect(resolveHostedRoute("?view=integrations&focus=email-alerts&project=project-1")).toEqual({
      view: "integrations",
      focus: "email-alerts",
      projectId: "project-1",
    });
  });

  it("resolves exact next-action resource targets", () => {
    expect(resolveHostedRoute("?view=incidents&project=project-1&incidentId=incident-1")).toEqual({
      view: "incidents",
      projectId: "project-1",
      target: { kind: "incident", id: "incident-1" },
    });
    expect(resolveHostedRoute("?view=runs&runId=run-1")).toEqual({
      view: "runs",
      target: { kind: "run", id: "run-1" },
    });
  });

  it("chooses the concrete resource referenced by a next action", () => {
    expect(targetForNextAction({ context: { actionId: "action-1" } })).toEqual({ kind: "action", id: "action-1" });
    expect(targetForNextAction({ context: { assuranceCaseId: "case-1" } })).toEqual({ kind: "case", id: "case-1" });
  });

  it("falls back to overview for an unknown view", () => {
    expect(resolveHostedRoute("?view=unknown")).toEqual({ view: "overview" });
  });

  it("builds a stable project-scoped workspace URL with an exact target", () => {
    expect(buildHostedWorkspaceUrl("https://agentcert.app/", {
      view: "integrations",
      focus: "email-alerts",
      projectId: "project/1",
      target: { kind: "run", id: "run/1" },
    })).toBe("https://agentcert.app/app?view=integrations&focus=email-alerts&project=project%2F1&runId=run%2F1");
  });
});
