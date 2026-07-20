import { describe, expect, it } from "vitest";
import { resolveCurrentAssurance, resolveProjectNextAction } from "../src/next-action.js";
import type { ActionRecord, AssuranceCaseRecord, EvidenceCompleteness, IncidentRecord, MemberRole } from "../src/types.js";

const owner = { kind: "user", role: "owner" } as const;
const operator = { kind: "user", role: "operator" } as const;
const viewer = { kind: "user", role: "viewer" } as const;

function assuranceCase(
  id: string,
  status: "CURRENT" | "REVALIDATION_REQUIRED" | "SUSPENDED" | "EXPIRED",
  options: { supersedesCaseId?: string; lastRunId?: string; updatedAt?: string } = {},
): AssuranceCaseRecord {
  return {
    id,
    name: `${id} review`,
    updatedAt: options.updatedAt ?? "2026-07-19T00:00:00.000Z",
    continuousAssurance: {
      supersedesCaseId: options.supersedesCaseId,
      lastRunId: options.lastRunId,
      freshness: { status, reason: `${id} is ${status}.` },
    },
  } as AssuranceCaseRecord;
}

function incident(id: string, severity: "low" | "medium" | "high" | "critical", status: "open" | "investigating" | "recovered" = "open"): IncidentRecord {
  return {
    id, severity, status, summary: `${id} incident`, createdAt: "2026-07-19T00:00:00.000Z",
  } as IncidentRecord;
}

function action(id: string, riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"): ActionRecord {
  return {
    id, actionType: "PAY", targetSystem: "MockERP", riskLevel, status: "PENDING_APPROVAL",
    reasons: ["Policy requires approval."], createdAt: "2026-07-19T00:00:00.000Z",
  } as ActionRecord;
}

function evidence(status: "complete" | "partial" | "rejected"): EvidenceCompleteness {
  return { status, reasons: status === "complete" ? [] : [`Evidence is ${status}.`] } as EvidenceCompleteness;
}

function resolve(input: {
  role?: MemberRole;
  assuranceCases?: AssuranceCaseRecord[];
  actions?: ActionRecord[];
  incidents?: IncidentRecord[];
  evidenceStatus?: "complete" | "partial" | "rejected";
}) {
  return resolveProjectNextAction({
    actor: { kind: "user", role: input.role ?? "owner" },
    assuranceCases: input.assuranceCases ?? [],
    actions: input.actions ?? [],
    incidents: input.incidents ?? [],
    ...(input.evidenceStatus ? {
      evidence: { runId: "run-1", runExternalId: "release-42", completeness: evidence(input.evidenceStatus) },
    } : {}),
  });
}

describe("role-aware project next action", () => {
  it("prioritizes the highest-severity active incident over approvals and release work", () => {
    const next = resolveProjectNextAction({
      actor: owner,
      assuranceCases: [assuranceCase("case-1", "REVALIDATION_REQUIRED")],
      actions: [action("action-1", "CRITICAL")],
      incidents: [incident("low", "low"), incident("critical", "critical")],
    });

    expect(next).toMatchObject({
      kind: "ACKNOWLEDGE_INCIDENT",
      priority: "critical",
      context: { incidentId: "critical" },
      permission: { canPerform: true, actor: "owner" },
    });
  });

  it("lets operators review pending actions but gives viewers an inspect-only handoff", () => {
    const operatorAction = resolve({ role: "operator", assuranceCases: [assuranceCase("case-1", "CURRENT")], actions: [action("action-1", "HIGH")] });
    const viewerAction = resolveProjectNextAction({ actor: viewer, assuranceCases: [assuranceCase("case-1", "CURRENT")], actions: [action("action-1", "HIGH")], incidents: [] });

    expect(operatorAction).toMatchObject({ kind: "REVIEW_PENDING_ACTION", actionLabel: "Review pending action", permission: { canPerform: true } });
    expect(viewerAction).toMatchObject({ kind: "REVIEW_PENDING_ACTION", actionLabel: "Inspect pending action", permission: { canPerform: false } });
    expect(viewerAction.permission.note).toContain("owner, admin, or operator");
  });

  it("routes non-current assurance to an owner-managed revalidation", () => {
    expect(resolve({ role: "operator", assuranceCases: [assuranceCase("case-1", "EXPIRED")] })).toMatchObject({
      kind: "REVALIDATE_ASSURANCE",
      actionLabel: "Review revalidation requirement",
      context: { assuranceCaseId: "case-1" },
      permission: { canPerform: false, requiredRoles: ["owner", "admin"] },
    });
  });

  it("requires a baseline before treating unrelated run evidence as assurance", () => {
    expect(resolve({ evidenceStatus: "partial" })).toMatchObject({ kind: "ESTABLISH_BASELINE" });
  });

  it("surfaces rejected or partial evidence after the reviewed scope is current", () => {
    expect(resolve({ assuranceCases: [assuranceCase("case-1", "CURRENT")], evidenceStatus: "rejected" })).toMatchObject({
      kind: "COMPLETE_EVIDENCE",
      priority: "high",
      destination: { view: "runs" },
      context: { runId: "run-1", evidenceStatus: "rejected" },
    });
  });

  it("returns a no-intervention state only when all higher-priority signals are clear", () => {
    expect(resolve({ assuranceCases: [assuranceCase("case-1", "CURRENT")], evidenceStatus: "complete" })).toMatchObject({
      kind: "MONITOR_ASSURANCE",
      priority: "normal",
      permission: { canPerform: true },
    });
  });

  it("ignores a stale contract after a newer revalidation supersedes it", () => {
    const oldCase = assuranceCase("old", "SUSPENDED");
    const replacement = assuranceCase("replacement", "CURRENT", { supersedesCaseId: "old", updatedAt: "2026-07-20T00:00:00.000Z" });

    expect(resolveCurrentAssurance([oldCase, replacement])).toMatchObject({
      status: "CURRENT",
      assuranceCaseId: "replacement",
    });
  });
});
