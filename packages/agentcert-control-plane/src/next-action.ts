import type {
  ActionRecord,
  ApiKeyScope,
  AssuranceCaseRecord,
  CurrentAssuranceStatus,
  CurrentAssuranceSummary,
  EvidenceCompleteness,
  IncidentRecord,
  MemberRole,
  ProjectNextAction,
  ProjectNextActionKind,
  ProjectNextActionPriority,
  ProjectNextActionView,
} from "./types.js";

export type NextActionActor =
  | { kind: "user"; role: MemberRole }
  | { kind: "api_key"; scopes: readonly ApiKeyScope[] };

export interface NextActionEvidenceAssessment {
  runId: string;
  runExternalId: string;
  completeness: EvidenceCompleteness;
}

export interface ResolveProjectNextActionInput {
  actor: NextActionActor;
  assuranceCases: AssuranceCaseRecord[];
  actions: ActionRecord[];
  incidents: IncidentRecord[];
  evidence?: NextActionEvidenceAssessment;
}

const ALL_ROLES: readonly MemberRole[] = ["owner", "admin", "operator", "viewer"];
const WRITE_ROLES: readonly MemberRole[] = ["owner", "admin", "operator"];
const ADMIN_ROLES: readonly MemberRole[] = ["owner", "admin"];
const FRESHNESS_PRIORITY: Record<Exclude<CurrentAssuranceStatus, "NOT_CONFIGURED">, number> = {
  SUSPENDED: 0,
  EXPIRED: 1,
  REVALIDATION_REQUIRED: 2,
  CURRENT: 3,
};
const FRESHNESS_TITLE: Record<Exclude<CurrentAssuranceStatus, "NOT_CONFIGURED">, string> = {
  CURRENT: "The reviewed scope is current",
  REVALIDATION_REQUIRED: "The reviewed scope must be revalidated",
  SUSPENDED: "Assurance is suspended",
  EXPIRED: "The assurance decision has expired",
};
const INCIDENT_SEVERITY = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const ACTION_RISK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

export function resolveCurrentAssurance(cases: AssuranceCaseRecord[]): CurrentAssuranceSummary {
  const assuranceCase = effectiveContinuousCases(cases)[0];
  if (!assuranceCase?.continuousAssurance) {
    return {
      status: "NOT_CONFIGURED",
      title: "No reviewed assurance baseline",
      reason: "Create a scoped review before treating test results as a current release decision.",
    };
  }
  const freshness = assuranceCase.continuousAssurance.freshness;
  return {
    status: freshness.status,
    title: FRESHNESS_TITLE[freshness.status],
    reason: freshness.reason,
    assuranceCaseId: assuranceCase.id,
    assuranceCaseName: assuranceCase.name,
    expiresAt: assuranceCase.expiresAt,
  };
}

export function preferredEvidenceRunId(cases: AssuranceCaseRecord[], fallbackRunId?: string): string | undefined {
  return effectiveContinuousCases(cases).find((item) => item.continuousAssurance?.lastRunId)?.continuousAssurance?.lastRunId
    ?? fallbackRunId;
}

export function resolveProjectNextAction(input: ResolveProjectNextActionInput): ProjectNextAction {
  const incident = highestPriorityIncident(input.incidents);
  if (incident) return incidentAction(input.actor, incident);

  const pendingAction = highestPriorityApproval(input.actions);
  if (pendingAction) return approvalAction(input.actor, pendingAction);

  const assurance = resolveCurrentAssurance(input.assuranceCases);
  if (assurance.status !== "CURRENT" && assurance.status !== "NOT_CONFIGURED") {
    return candidate(input.actor, {
      kind: "REVALIDATE_ASSURANCE",
      priority: assurance.status === "SUSPENDED" ? "critical" : "high",
      title: assurance.title,
      reason: assurance.reason,
      performLabel: "Start revalidation",
      inspectLabel: "Review revalidation requirement",
      view: "assurance",
      requiredRoles: ADMIN_ROLES,
      permissionNote: "An owner or admin must create and lock the revalidation scope.",
      context: { assuranceCaseId: assurance.assuranceCaseId },
    });
  }

  if (assurance.status === "NOT_CONFIGURED") {
    return candidate(input.actor, {
      kind: "ESTABLISH_BASELINE",
      priority: "medium",
      title: assurance.title,
      reason: assurance.reason,
      performLabel: "Create assurance review",
      inspectLabel: "Review release assurance",
      view: "assurance",
      requiredRoles: ADMIN_ROLES,
      permissionNote: "An owner or admin must define the first locked assurance scope.",
      context: {},
    });
  }

  if (input.evidence && input.evidence.completeness.status !== "complete") {
    const completeness = input.evidence.completeness;
    const rejected = completeness.status === "rejected";
    return candidate(input.actor, {
      kind: "COMPLETE_EVIDENCE",
      priority: rejected ? "high" : "medium",
      title: rejected ? "Evidence was rejected" : "Evidence is incomplete",
      reason: `Run ${input.evidence.runExternalId} is ${completeness.status}. ${completeness.reasons[0] ?? "The evidence manifest is not complete."}`,
      performLabel: rejected ? "Resolve evidence rejection" : "Complete run evidence",
      inspectLabel: "Inspect evidence gap",
      view: "runs",
      requiredRoles: WRITE_ROLES,
      requiredScope: "evidence:write",
      permissionNote: "An owner, admin, operator, or evidence-writer credential must upload corrected evidence.",
      context: { runId: input.evidence.runId, evidenceStatus: completeness.status },
    });
  }

  return candidate(input.actor, {
    kind: "MONITOR_ASSURANCE",
    priority: "normal",
    title: "No intervention is required",
    reason: "The reviewed scope is current and no incident, approval, or evidence gap requires attention.",
    performLabel: "Review current scope",
    inspectLabel: "Review current scope",
    view: "assurance",
    requiredRoles: ALL_ROLES,
    requiredScope: "runs:read",
    context: { assuranceCaseId: assurance.assuranceCaseId },
  });
}

function effectiveContinuousCases(cases: AssuranceCaseRecord[]): AssuranceCaseRecord[] {
  const superseded = new Set(cases.map((item) => item.continuousAssurance?.supersedesCaseId).filter((id): id is string => Boolean(id)));
  return cases
    .filter((item) => item.continuousAssurance && !superseded.has(item.id))
    .sort((left, right) => {
      const freshness = FRESHNESS_PRIORITY[left.continuousAssurance!.freshness.status]
        - FRESHNESS_PRIORITY[right.continuousAssurance!.freshness.status];
      if (freshness !== 0) return freshness;
      const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return updated || left.id.localeCompare(right.id);
    });
}

function highestPriorityIncident(incidents: IncidentRecord[]): IncidentRecord | undefined {
  return incidents
    .filter((item) => item.status !== "resolved")
    .sort((left, right) => rankDifference(right.severity, left.severity, INCIDENT_SEVERITY)
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.id.localeCompare(right.id))[0];
}

function highestPriorityApproval(actions: ActionRecord[]): ActionRecord | undefined {
  return actions
    .filter((item) => item.status === "PENDING_APPROVAL")
    .sort((left, right) => rankDifference(right.riskLevel, left.riskLevel, ACTION_RISK)
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.id.localeCompare(right.id))[0];
}

function rankDifference<T extends string>(higher: T, lower: T, ranks: Record<T, number>): number {
  return ranks[higher] - ranks[lower];
}

function incidentAction(actor: NextActionActor, incident: IncidentRecord): ProjectNextAction {
  const transition = incident.status === "recovered"
    ? { kind: "RESOLVE_INCIDENT" as const, label: "Resolve recovered incident" }
    : incident.status === "investigating"
      ? { kind: "INVESTIGATE_INCIDENT" as const, label: "Continue investigation" }
      : { kind: "ACKNOWLEDGE_INCIDENT" as const, label: "Acknowledge incident" };
  return candidate(actor, {
    kind: transition.kind,
    priority: incident.severity === "critical" ? "critical" : "high",
    title: incident.summary,
    reason: `A ${incident.severity} incident is ${incident.status}; runtime safety takes precedence over release work.`,
    performLabel: transition.label,
    inspectLabel: "Inspect incident",
    view: "incidents",
    requiredRoles: ADMIN_ROLES,
    permissionNote: "An owner or admin must manage the incident lifecycle.",
    context: { incidentId: incident.id },
  });
}

function approvalAction(actor: NextActionActor, action: ActionRecord): ProjectNextAction {
  return candidate(actor, {
    kind: "REVIEW_PENDING_ACTION",
    priority: action.riskLevel === "CRITICAL" ? "critical" : "high",
    title: `${action.actionType} requires human approval`,
    reason: `${action.targetSystem} is waiting on a ${action.riskLevel.toLowerCase()}-risk decision. ${action.reasons[0] ?? "Policy requires a human reviewer."}`,
    performLabel: "Review pending action",
    inspectLabel: "Inspect pending action",
    view: "actions",
    requiredRoles: WRITE_ROLES,
    permissionNote: "An owner, admin, or operator must approve or reject this action.",
    context: { actionId: action.id },
  });
}

interface Candidate {
  kind: ProjectNextActionKind;
  priority: ProjectNextActionPriority;
  title: string;
  reason: string;
  performLabel: string;
  inspectLabel: string;
  view: ProjectNextActionView;
  requiredRoles: readonly MemberRole[];
  requiredScope?: ApiKeyScope;
  permissionNote?: string;
  context: ProjectNextAction["context"];
}

function candidate(actor: NextActionActor, input: Candidate): ProjectNextAction {
  const canPerform = actor.kind === "user"
    ? input.requiredRoles.includes(actor.role)
    : Boolean(input.requiredScope && actor.scopes.includes(input.requiredScope));
  return {
    schemaVersion: "agentcert.next_action.v0.2",
    kind: input.kind,
    priority: input.priority,
    title: input.title,
    reason: input.reason,
    actionLabel: canPerform ? input.performLabel : input.inspectLabel,
    destination: { view: input.view },
    permission: {
      canPerform,
      actor: actor.kind === "user" ? actor.role : "api_key",
      requiredRoles: [...input.requiredRoles],
      ...(!canPerform && input.permissionNote ? { note: input.permissionNote } : {}),
    },
    context: input.context,
  };
}
