import { describe, expect, it } from "vitest";
import { parseAgentTemplate, starterAdapter, starterProfile } from "../src/onboarding-templates.js";

describe("external agent onboarding templates", () => {
  it.each(["browser", "coding", "mcp", "workflow", "data"] as const)("builds the %s profile", (template) => {
    const profile = starterProfile(template, `test-${template}`);
    expect(profile).toMatchObject({ schemaVersion: "1", subject: { name: `test-${template}`, type: "agent" } });
  });

  it("preserves the browser and MCP artifact conventions", () => {
    expect(starterProfile("browser", "browser").artifacts).toEqual({ tripwire: ".tripwire/latest/tripwire-result.json" });
    expect(starterProfile("mcp", "mcp").artifacts).toEqual({ mcpbench: ".mcpbench/latest/results.json" });
  });

  it("generates a secret-free universal envelope adapter", () => {
    const adapter = starterAdapter("workflow", "approval-workflow");
    expect(adapter).toContain("agentcert.envelope.v0.1");
    expect(adapter).toContain("AGENTCERT_API_KEY");
    expect(adapter).not.toMatch(/ac_live_[A-Za-z0-9_-]+/);
  });

  it("rejects unknown templates with the complete recovery list", () => {
    expect(() => parseAgentTemplate("robot")).toThrow("Use browser, coding, mcp, workflow, or data");
  });
});
