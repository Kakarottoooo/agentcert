import type { ActionRecord, ApprovalRecord, EventRecord, EvidenceRecord, RunRecord } from "./types.js";

export interface TraceSpanView {
  id: string;
  parentId?: string;
  sourceSpanId?: string;
  entityType: "run" | "event" | "action" | "approval" | "evidence";
  entityId: string;
  name: string;
  actor: string;
  status: "ok" | "error" | "pending" | "unknown";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  sequence?: number;
  attributes: Record<string, unknown>;
}

export interface RunObservability {
  schemaVersion: "agentcert.run_observability.v0.1";
  traceId?: string;
  rootSpanId?: string;
  complete: boolean;
  diagnostics: Array<{ code: string; message: string; values?: Array<string | number> }>;
  spans: TraceSpanView[];
  risk: {
    maxRiskLevel: "NONE" | ActionRecord["riskLevel"];
    totalActions: number;
    highRiskActions: number;
    deniedActions: number;
    approvalRequiredActions: number;
    approvedActions: number;
    rejectedActions: number;
    verifiedActions: number;
    verificationFailures: number;
    policyViolations: number;
    decisions: Record<ActionRecord["decision"], number>;
  };
}

export interface ObservabilitySnapshot {
  schemaVersion: "agentcert.observability_snapshot.v0.1";
  generatedAt: string;
  since: string;
  periodDays: number;
  truncated: { any: boolean; runs: boolean; events: boolean; actions: boolean; approvals: boolean; limitPerEntity: number };
  totals: { runs: number; events: number; actions: number; approvals: number };
  assurance: {
    passRate: number;
    currentRate: number;
    faultPassRate?: number;
  };
  risk: {
    highRiskActions: number;
    blockedRate: number;
    approvalRate: number;
    verificationFailureRate: number;
    policyViolationRate: number;
    averageApprovalLatencyMs?: number;
    distribution: Record<ActionRecord["riskLevel"], number>;
  };
  daily: Array<{ date: string; runs: number; passed: number; failed: number; highRiskActions: number; blockedActions: number; policyViolations: number; verificationFailures: number }>;
  topPolicyReasons: Array<{ reason: string; count: number }>;
  topEventTypes: Array<{ type: string; count: number }>;
}

export function buildRunObservability(
  run: RunRecord,
  events: EventRecord[],
  actions: ActionRecord[],
  approvals: ApprovalRecord[],
  evidence: EvidenceRecord[],
): RunObservability {
  const sortedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const diagnostics: RunObservability["diagnostics"] = [];
  const gaps = sequenceGaps(sortedEvents.map((event) => event.sequence));
  if (gaps.length > 0) diagnostics.push({ code: "event_sequence_gap", message: "The event sequence contains gaps.", values: gaps });

  const traceIds = unique([run.traceId, ...sortedEvents.map((event) => event.traceId), ...actions.map((action) => action.traceId)]);
  if (!run.traceId || !run.rootSpanId) diagnostics.push({ code: "run_trace_context_missing", message: "The run does not declare both traceId and rootSpanId." });
  if (traceIds.length > 1) diagnostics.push({ code: "mixed_trace_ids", message: "Records linked to this run use more than one trace ID.", values: traceIds });

  const rootId = `run:${run.id}`;
  const sourceParents = new Map<string, string>();
  if (run.rootSpanId) sourceParents.set(run.rootSpanId, rootId);
  for (const event of sortedEvents) if (event.spanId && !sourceParents.has(event.spanId)) sourceParents.set(event.spanId, `event:${event.id}`);
  for (const action of actions) if (action.spanId && !sourceParents.has(action.spanId)) sourceParents.set(action.spanId, `action:${action.id}`);

  const referencedParents = unique([
    ...sortedEvents.map((event) => event.parentSpanId),
    ...actions.map((action) => action.parentSpanId),
  ]);
  const orphanParents = referencedParents.filter((parent) => !sourceParents.has(parent));
  if (orphanParents.length > 0) diagnostics.push({ code: "orphan_parent_span", message: "Some records reference parent spans that are not present.", values: orphanParents });

  const spans: TraceSpanView[] = [{
    id: rootId,
    entityType: "run",
    entityId: run.id,
    sourceSpanId: run.rootSpanId,
    name: `${run.kind} run`,
    actor: "agentcert.runner",
    status: run.status === "passed" ? "ok" : run.status === "running" ? "pending" : run.status === "failed" ? "error" : "unknown",
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: elapsed(run.startedAt, run.completedAt),
    attributes: { externalId: run.externalId, schemaVersion: run.schemaVersion, score: run.score, status: run.status },
  }];

  for (const event of sortedEvents) {
    spans.push({
      id: `event:${event.id}`,
      parentId: resolveParent(event.parentSpanId, sourceParents, rootId),
      sourceSpanId: event.spanId,
      entityType: "event",
      entityId: event.id,
      name: event.type,
      actor: event.actor,
      status: eventStatus(event),
      startedAt: event.occurredAt,
      sequence: event.sequence,
      attributes: event.payload,
    });
  }
  for (const action of actions) {
    const actionId = `action:${action.id}`;
    spans.push({
      id: actionId,
      parentId: resolveParent(action.parentSpanId, sourceParents, rootId),
      sourceSpanId: action.spanId,
      entityType: "action",
      entityId: action.id,
      name: `${action.actionType} ${action.targetSystem}`,
      actor: "onegent.gateway",
      status: actionStatus(action),
      startedAt: action.createdAt,
      completedAt: action.updatedAt,
      durationMs: elapsed(action.createdAt, action.updatedAt),
      attributes: {
        externalId: action.externalId,
        riskLevel: action.riskLevel,
        riskScore: action.riskScore,
        decision: action.decision,
        status: action.status,
        policyVersion: action.policyVersion,
        reasons: action.reasons,
        expectedState: action.expectedState,
        observedState: action.observedState,
        verificationSuccess: action.verificationSuccess,
        assuranceContext: action.assuranceContext,
      },
    });
  }
  for (const approval of approvals) {
    spans.push({
      id: `approval:${approval.id}`,
      parentId: `action:${approval.actionId}`,
      entityType: "approval",
      entityId: approval.id,
      name: `Human ${approval.decision.toLowerCase()}`,
      actor: approval.reviewerId,
      status: approval.decision === "APPROVED" ? "ok" : "error",
      startedAt: approval.createdAt,
      attributes: { actionId: approval.actionId, decision: approval.decision, comment: approval.comment },
    });
  }
  for (const artifact of evidence) {
    spans.push({
      id: `evidence:${artifact.id}`,
      parentId: artifact.actionId ? `action:${artifact.actionId}` : rootId,
      entityType: "evidence",
      entityId: artifact.id,
      name: artifact.kind,
      actor: "agentcert.evidence",
      status: "ok",
      startedAt: artifact.createdAt,
      attributes: { fileName: artifact.fileName, contentType: artifact.contentType, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
    });
  }

  const linkedApprovals = new Map<string, ApprovalRecord[]>();
  for (const approval of approvals) linkedApprovals.set(approval.actionId, [...(linkedApprovals.get(approval.actionId) ?? []), approval]);
  const decisions = { ALLOW: 0, DENY: 0, REQUIRE_APPROVAL: 0 } satisfies Record<ActionRecord["decision"], number>;
  for (const action of actions) decisions[action.decision] += 1;
  return {
    schemaVersion: "agentcert.run_observability.v0.1",
    traceId: run.traceId ?? traceIds[0],
    rootSpanId: run.rootSpanId,
    complete: diagnostics.length === 0,
    diagnostics,
    spans: spans.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
      || spanEntityOrder(left.entityType) - spanEntityOrder(right.entityType)
      || (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)),
    risk: {
      maxRiskLevel: maxRisk(actions),
      totalActions: actions.length,
      highRiskActions: actions.filter((action) => action.riskLevel === "HIGH" || action.riskLevel === "CRITICAL").length,
      deniedActions: actions.filter((action) => action.decision === "DENY").length,
      approvalRequiredActions: actions.filter((action) => action.decision === "REQUIRE_APPROVAL" || linkedApprovals.has(action.id)).length,
      approvedActions: approvals.filter((approval) => approval.decision === "APPROVED").length,
      rejectedActions: approvals.filter((approval) => approval.decision === "REJECTED").length,
      verifiedActions: actions.filter((action) => action.verificationSuccess === true).length,
      verificationFailures: actions.filter((action) => action.verificationSuccess === false).length,
      policyViolations: actions.filter((action) => action.decision === "DENY").length + sortedEvents.filter(isPolicyViolation).length,
      decisions,
    },
  };
}

export function buildObservabilitySnapshot(input: {
  runs: RunRecord[];
  events: EventRecord[];
  actions: ActionRecord[];
  approvals: ApprovalRecord[];
  since: string;
  periodDays: number;
  generatedAt: string;
  truncated: Omit<ObservabilitySnapshot["truncated"], "any">;
}): ObservabilitySnapshot {
  const { runs, events, actions, approvals } = input;
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const actionIdsWithApproval = new Set(approvals.map((approval) => approval.actionId));
  const passed = runs.filter((run) => run.status === "passed").length;
  const current = runs.filter(isCurrentRun).length;
  const faultEvents = events.filter(isFaultAssertion);
  const faultPassed = faultEvents.filter((event) => event.payload.passed === true || event.payload.status === "passed").length;
  const blocked = actions.filter((action) => action.decision === "DENY").length;
  const approvalRequired = actions.filter((action) => action.decision === "REQUIRE_APPROVAL" || actionIdsWithApproval.has(action.id)).length;
  const verificationOutcomes = actions.filter((action) => action.verificationSuccess !== undefined);
  const policyViolations = events.filter(isPolicyViolation).length + blocked;
  const highRisk = actions.filter((action) => action.riskLevel === "HIGH" || action.riskLevel === "CRITICAL").length;
  const approvalLatencies = approvals.flatMap((approval) => {
    const action = actionById.get(approval.actionId);
    return action ? [Math.max(0, Date.parse(approval.createdAt) - Date.parse(action.createdAt))] : [];
  });
  const dates = dateRange(input.since, input.generatedAt);
  const daily = dates.map((date) => {
    const dayRuns = runs.filter((run) => run.startedAt.slice(0, 10) === date);
    const dayActions = actions.filter((action) => action.createdAt.slice(0, 10) === date);
    const dayEvents = events.filter((event) => event.occurredAt.slice(0, 10) === date);
    return {
      date,
      runs: dayRuns.length,
      passed: dayRuns.filter((run) => run.status === "passed").length,
      failed: dayRuns.filter((run) => run.status === "failed").length,
      highRiskActions: dayActions.filter((action) => action.riskLevel === "HIGH" || action.riskLevel === "CRITICAL").length,
      blockedActions: dayActions.filter((action) => action.decision === "DENY").length,
      policyViolations: dayActions.filter((action) => action.decision === "DENY").length + dayEvents.filter(isPolicyViolation).length,
      verificationFailures: dayActions.filter((action) => action.verificationSuccess === false).length,
    };
  });
  const distribution = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 } satisfies Record<ActionRecord["riskLevel"], number>;
  for (const action of actions) distribution[action.riskLevel] += 1;
  const truncated = { ...input.truncated, any: Object.entries(input.truncated).some(([key, value]) => key !== "limitPerEntity" && value === true) };
  return {
    schemaVersion: "agentcert.observability_snapshot.v0.1",
    generatedAt: input.generatedAt,
    since: input.since,
    periodDays: input.periodDays,
    truncated,
    totals: { runs: runs.length, events: events.length, actions: actions.length, approvals: approvals.length },
    assurance: { passRate: ratio(passed, runs.length), currentRate: ratio(current, runs.length), ...(faultEvents.length ? { faultPassRate: ratio(faultPassed, faultEvents.length) } : {}) },
    risk: {
      highRiskActions: highRisk,
      blockedRate: ratio(blocked, actions.length),
      approvalRate: ratio(approvalRequired, actions.length),
      verificationFailureRate: ratio(actions.filter((action) => action.verificationSuccess === false).length, verificationOutcomes.length),
      policyViolationRate: ratio(policyViolations, Math.max(actions.length + events.length, 1)),
      ...(approvalLatencies.length ? { averageApprovalLatencyMs: Math.round(approvalLatencies.reduce((sum, value) => sum + value, 0) / approvalLatencies.length) } : {}),
      distribution,
    },
    daily,
    topPolicyReasons: topCounts(actions.flatMap((action) => action.reasons), "reason"),
    topEventTypes: topCounts(events.map((event) => event.type), "type"),
  };
}

function eventStatus(event: EventRecord): TraceSpanView["status"] {
  const type = event.type.toLowerCase();
  if (event.payload.passed === false || event.payload.success === false || /(fail|error|denied|violation)/.test(type)) return "error";
  if (event.payload.passed === true || event.payload.success === true || /(passed|verified|completed|accepted)/.test(type)) return "ok";
  return "unknown";
}

function spanEntityOrder(entityType: TraceSpanView["entityType"]): number {
  return { run: 0, event: 1, action: 2, approval: 3, evidence: 4 }[entityType];
}

function actionStatus(action: ActionRecord): TraceSpanView["status"] {
  if (action.verificationSuccess === false || action.decision === "DENY" || action.status === "REJECTED" || action.status === "VERIFICATION_FAILED") return "error";
  if (action.status === "PENDING_APPROVAL") return "pending";
  if (action.verificationSuccess === true || action.status === "VERIFIED" || action.status === "ALLOWED" || action.status === "APPROVED") return "ok";
  return "unknown";
}

function maxRisk(actions: ActionRecord[]): RunObservability["risk"]["maxRiskLevel"] {
  const rank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;
  return actions.reduce<RunObservability["risk"]["maxRiskLevel"]>((highest, action) => highest === "NONE" || rank[action.riskLevel] > rank[highest] ? action.riskLevel : highest, "NONE");
}

function resolveParent(parentSpanId: string | undefined, parents: Map<string, string>, rootId: string): string {
  return parentSpanId ? parents.get(parentSpanId) ?? rootId : rootId;
}

function sequenceGaps(sequences: number[]): number[] {
  if (sequences.length === 0) return [];
  const present = new Set(sequences);
  const last = Math.max(...sequences);
  const gaps: number[] = [];
  for (let sequence = 0; sequence <= last && gaps.length < 50; sequence += 1) if (!present.has(sequence)) gaps.push(sequence);
  return gaps;
}

function elapsed(start: string, end?: string): number | undefined {
  return end ? Math.max(0, Date.parse(end) - Date.parse(start)) : undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function isPolicyViolation(event: EventRecord): boolean {
  return /policy.*(violation|denied|blocked)|violation.*policy/i.test(event.type) || event.payload.policyViolation === true;
}

function isFaultAssertion(event: EventRecord): boolean {
  return /fault|assertion/i.test(event.type);
}

function isCurrentRun(run: RunRecord): boolean {
  const assurance = object(run.metadata.continuousAssurance);
  const reconciliation = object(assurance.reconciliation);
  return reconciliation.nextStatus === "CURRENT" && reconciliation.authoritative === true;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dateRange(since: string, generatedAt: string): string[] {
  const start = new Date(since); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(generatedAt); end.setUTCHours(0, 0, 0, 0);
  const values: string[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime() && values.length < 92; cursor += 86_400_000) values.push(new Date(cursor).toISOString().slice(0, 10));
  return values;
}

function topCounts<Key extends "reason" | "type">(values: string[], key: Key): Array<Record<Key, string> & { count: number }> {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 8).map(([value, count]) => ({ [key]: value, count }) as Record<Key, string> & { count: number });
}
