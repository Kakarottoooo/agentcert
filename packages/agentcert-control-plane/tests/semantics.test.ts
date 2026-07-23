import { describe, expect, it } from "vitest";
import {
  buildSemanticCoverage,
  parseCapabilityManifest,
  unknownCapabilityKey,
  type CapabilityCorrectionRecord,
} from "../src/semantics.js";
import type { ActionRecord, EventRecord, RunRecord } from "../src/types.js";

const now = "2026-07-20T12:00:00.000Z";
const run: RunRecord = {
  id: "run-1", projectId: "project-1", externalId: "release-1", kind: "release_gate", status: "passed",
  schemaVersion: "agentcert.run.v1", startedAt: now, metadata: { framework: "langgraph" },
};

function event(id: string, sequence: number, observedName: string, invocationId: string, phase: "started" | "completed", capabilityId?: string): EventRecord {
  return {
    id, projectId: "project-1", runId: run.id, sequence, type: `agentcert.tool.${phase}`, actor: "agent",
    occurredAt: now,
    payload: { semantic: {
      schemaVersion: "agentcert.semantic_event.v0.1", observedName, invocationId, phase, capabilityId,
      evidenceStrength: "outcome_verified",
    } },
  };
}

function action(verified = false): ActionRecord {
  return {
    id: "action-1", projectId: "project-1", externalId: "send-1", principal: { id: "agent-1" }, actionType: "SEND",
    targetSystem: "MailSandbox", requestedPermissions: ["messages:send"], riskLevel: "HIGH", riskScore: 80,
    decision: "ALLOW", status: "EXECUTED", policyVersion: "v1", reasons: [], verificationSuccess: verified,
    createdAt: now, updatedAt: now,
    assuranceContext: { mandateId: "mandate-1", mandateDigestSha256: "a".repeat(64), evidenceStrength: verified ? "outcome_verified" : "enforced" },
  } as ActionRecord;
}

function coverage(input: { events: EventRecord[]; actions?: ActionRecord[]; corrections?: CapabilityCorrectionRecord[]; independentlyReviewed?: boolean }) {
  return buildSemanticCoverage({
    projectId: "project-1", runs: [run], events: input.events, actions: input.actions ?? [], customManifests: [],
    corrections: input.corrections ?? [], periodDays: 30, generatedAt: now, since: "2026-06-20T12:00:00.000Z",
    independentlyReviewed: input.independentlyReviewed,
  });
}

describe("universal agent semantics", () => {
  it("validates capability manifests deterministically", () => {
    expect(() => parseCapabilityManifest({ schemaVersion: "wrong" })).toThrow("schemaVersion");
  });

  it("deduplicates invocation phases and never trusts producer-declared enforcement", () => {
    const result = coverage({
      events: [
        event("e-1", 0, "send_email", "invoke-send", "started", "messaging.send"),
        event("e-2", 1, "send_email", "invoke-send", "completed", "messaging.send"),
        event("e-3", 2, "mystery_tool", "invoke-unknown", "started"),
        event("e-4", 3, "mystery_tool", "invoke-unknown", "completed"),
      ],
      actions: [action(false)],
    });

    expect(result.coverage.semantic).toMatchObject({ numerator: 2, denominator: 4, percent: 50 });
    expect(result.totals).toMatchObject({ sideEffectingExecutions: 2, enforcedExecutions: 1, outcomeVerifiedExecutions: 0 });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ observedName: "mystery_tool", occurrences: 1 });
    expect(result.domains.find((item) => item.domain === "messaging")).toMatchObject({ observed: 2, recognized: 2, enforced: 1, verified: 0 });
    expect(result.evidenceStrength).toBe("enforced");
    expect(result.bypassRisk.status).toBe("critical");
  });

  it("applies a human correction and only grants reviewed strength to a complete window", () => {
    const events = [event("e-1", 0, "repo_lookup", "invoke-1", "started"), event("e-2", 1, "repo_lookup", "invoke-1", "completed")];
    const key = unknownCapabilityKey("langgraph", "repo_lookup", "agentcert.tool.completed");
    const correction: CapabilityCorrectionRecord = {
      id: "correction-1", projectId: "project-1", unknownKey: key, observedName: "repo_lookup", framework: "langgraph",
      eventType: "agentcert.tool.completed", capabilityId: "coding.read", rationale: "This tool reads repository source without modifying it.",
      confidence: 1, reviewerId: "reviewer-1", source: "human", createdAt: now, updatedAt: now,
    };

    const result = coverage({ events, corrections: [correction], independentlyReviewed: true });

    expect(result.unknown).toEqual([]);
    expect(result.coverage.semantic).toMatchObject({ numerator: 2, denominator: 2, percent: 100 });
    expect(result.domains.find((item) => item.domain === "coding")).toMatchObject({ observed: 1, recognized: 1 });
    expect(result.evidenceStrength).toBe("independently_reviewed");
  });

  it("redacts nested credentials before an unknown sample can leave the service", () => {
    const unknown = event("e-1", 0, "private_tool", "invoke-private", "completed");
    unknown.payload.context = {
      apiKey: "must-not-leak",
      nested: { authorization: "Bearer must-not-leak", safe: "visible" },
    };

    const result = coverage({ events: [unknown] });

    expect(result.unknown[0]?.sample).toMatchObject({
      context: { apiKey: "[REDACTED]", nested: { authorization: "[REDACTED]", safe: "visible" } },
    });
    expect(JSON.stringify(result.unknown[0]?.sample)).not.toContain("must-not-leak");
  });
});
