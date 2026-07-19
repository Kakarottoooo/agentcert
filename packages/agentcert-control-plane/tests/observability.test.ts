import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { buildObservabilitySnapshot } from "../src/observability.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext, RunRecord } from "../src/types.js";

const user: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };
const traceId = "a".repeat(32);
const rootSpanId = "b".repeat(16);

async function setup() {
  const store = new InMemoryControlPlaneStore();
  const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
  const bootstrap = await service.bootstrap(user);
  return { store, service, projectId: bootstrap.project.id };
}

describe("assurance observability", () => {
  it("correlates run events, policy, approval, outcome, and evidence in one trace", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, {
      externalId: "procurement-observation-1", kind: "runtime", traceId, rootSpanId,
      startedAt: "2026-07-18T10:00:00.000Z",
    });
    await service.appendEvents(user, projectId, run.id, { events: [
      { sequence: 0, type: "agentcert.run.started", actor: "onegent", occurredAt: "2026-07-18T10:00:00.000Z", payload: {}, traceId, spanId: rootSpanId },
      { sequence: 1, type: "onegent.policy.decision", actor: "onegent", occurredAt: "2026-07-18T10:00:01.000Z", payload: { decision: "REQUIRE_APPROVAL" }, traceId, spanId: "c".repeat(16), parentSpanId: rootSpanId },
    ] });
    const action = await service.proposeAction(user, projectId, {
      externalId: "po-4850", principal: { type: "agent", id: "ProcurementAgent" }, actionType: "SUBMIT",
      targetSystem: "mock-erp", requestedPermissions: [], amount: 4_850, currency: "USD",
      expectedState: { status: "SUBMITTED" }, traceId, spanId: "d".repeat(16), parentSpanId: rootSpanId,
    });
    await service.reviewAction(user, projectId, action.id, true, { comment: "Within approved procurement scope." });
    await service.verifyAction(user, projectId, action.id, { observedState: { status: "SUBMITTED" } });
    await service.completeRun(user, projectId, run.id, { status: "passed", completedAt: "2026-07-18T10:00:03.000Z" });

    const analysis = await service.runAnalysis(user, projectId, run.id);
    expect(analysis.actions).toHaveLength(1);
    expect(analysis.approvals).toHaveLength(1);
    expect(analysis.observability).toMatchObject({
      complete: true,
      traceId,
      risk: { maxRiskLevel: "HIGH", highRiskActions: 1, approvedActions: 1, verifiedActions: 1, verificationFailures: 0 },
    });
    expect(analysis.observability.spans.map((span) => span.entityType)).toEqual(expect.arrayContaining(["run", "event", "action", "approval"]));
    expect(analysis.observability.spans[0]?.entityType).toBe("run");

    const snapshot = await service.observability(user, projectId, 30);
    expect(snapshot).toMatchObject({ totals: { runs: 1, events: 2, actions: 1, approvals: 1 }, risk: { highRiskActions: 1, approvalRate: 1, verificationFailureRate: 0 } });
    expect(snapshot.truncated.any).toBe(false);
  });

  it("indexes action approvals once and reports only explicit truncation", () => {
    const generatedAt = "2026-07-18T12:00:00.000Z";
    const actions = Array.from({ length: 2_000 }, (_, index) => ({
      id: `action-${index}`,
      projectId: "project-1",
      externalId: `external-${index}`,
      actionType: "UPDATE" as const,
      targetSystem: "mock-system",
      parameters: {},
      expectedState: {},
      riskLevel: "LOW" as const,
      riskScore: 0.1,
      decision: index % 2 === 0 ? "REQUIRE_APPROVAL" as const : "ALLOW" as const,
      reasons: [],
      policyVersion: "v1",
      status: "CAPTURED" as const,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    }));
    const approvals = actions.filter((_, index) => index % 2 === 1).map((action, index) => ({
      id: `approval-${index}`,
      projectId: "project-1",
      actionId: action.id,
      reviewerId: "reviewer-1",
      decision: "APPROVED" as const,
      createdAt: generatedAt,
    }));
    const snapshot = buildObservabilitySnapshot({
      runs: [], events: [], actions, approvals,
      since: "2026-07-11T12:00:00.000Z", periodDays: 7, generatedAt,
      truncated: { runs: false, events: false, actions: false, approvals: false, limitPerEntity: 10_000 },
    });

    expect(snapshot.risk.approvalRate).toBe(1);
    expect(snapshot.truncated).toMatchObject({ any: false, actions: false, approvals: false });
  });

  it("rejects ambiguous or oversized event batches before persistence", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "bounded-events", kind: "custom", traceId, rootSpanId });
    await expect(service.appendEvents(user, projectId, run.id, { events: [
      { sequence: 0, type: "step", payload: {} }, { sequence: 0, type: "duplicate", payload: {} },
    ] })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "event_sequence_duplicate" });
    await expect(service.appendEvents(user, projectId, run.id, { events: [
      { sequence: 0, type: "step", payload: { value: "x".repeat(70_000) } },
    ] })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 413, code: "event_payload_too_large" });
    await service.appendEvents(user, projectId, run.id, { events: [{ sequence: 0, type: "step", payload: {} }] });
    await expect(service.appendEvents(user, projectId, run.id, { events: [
      { sequence: 0, type: "rewritten-step", payload: {} },
    ] })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "event_sequence_conflict" });
    expect(await service.runDetail(user, projectId, run.id)).toMatchObject({ events: [{ sequence: 0, type: "step" }] });
  });

  it("marks bounded aggregate snapshots as truncated instead of silently claiming completeness", () => {
    const run: RunRecord = {
      id: "run-1", projectId: "project-1", externalId: "run-1", kind: "tripwire", status: "passed",
      schemaVersion: "agentcert.run.v1", startedAt: "2026-07-18T00:00:00.000Z", metadata: {},
    };
    const snapshot = buildObservabilitySnapshot({
      runs: [run], events: [], actions: [], approvals: [], since: "2026-07-17T00:00:00.000Z", periodDays: 7,
      generatedAt: "2026-07-18T00:00:00.000Z",
      truncated: { runs: true, events: false, actions: false, approvals: false, limitPerEntity: 10_000 },
    });
    expect(snapshot.truncated).toMatchObject({ any: true, runs: true, limitPerEntity: 10_000 });
    expect(snapshot.assurance.passRate).toBe(1);
  });
});
