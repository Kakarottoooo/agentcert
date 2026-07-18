import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  ActionRecord,
  AgentRecord,
  ApiKeyRecord,
  ApprovalRecord,
  EvidenceRecord,
  EvidenceDeletionRecord,
  EvidenceStorageUsage,
  FailureReviewRecord,
  IncidentRecord,
  IncidentTransitionRecord,
  LegalHoldRequestRecord,
  IdempotencyRecord,
  Membership,
  TeamAuditRecord,
  TeamInvitationRecord,
  TeamMemberRecord,
  Organization,
  Project,
  RunRecord,
  EventRecord,
  MemberRole,
  WebhookDeliveryRecord,
  WebhookJobRecord,
  WebhookJobCounts,
  WebhookRecord,
  SigningKeyRecord,
  TrustHealthSampleRecord,
  WebhookOperationsMetrics,
  NotificationDestinationRecord,
  NotificationDeliveryRecord,
  NotificationJobRecord,
  NotificationJobCounts,
  NotificationVerificationStoreResult,
  PilotFeedbackRecord,
  PilotFunnelSource,
  AssuranceCaseRecord,
  AssuranceCaseDecisionRecord,
  CollectorSourceKeyRecord,
  CollectorHeartbeatRecord,
  TrustedCollectorAlertRecord,
  TrustedCollectorAppendResult,
  TrustedCollectorRecord,
  TrustedCollectorRunRecord,
  TrustedSourceRecord,
} from "./types.js";

export const CONTROL_PLANE_MIGRATIONS = [
  "001_initial.sql",
  "002_failure_reviews.sql",
  "003_evidence_retention.sql",
  "004_legal_holds.sql",
  "005_universal_assurance.sql",
  "006_trust_operations.sql",
  "007_trust_operations_history.sql",
  "008_trust_operations_v04.sql",
  "009_trust_operations_v05.sql",
  "010_default_project_name.sql",
  "011_hosted_onboarding_v02.sql",
  "012_pilot_funnel_indexes.sql",
  "013_assurance_cases.sql",
  "014_team_access_management.sql",
  "015_trusted_action_assurance.sql",
  "016_remote_collector.sql",
  "017_assurance_engagements.sql",
  "018_continuous_assurance.sql",
  "019_continuous_assurance_adoption.sql",
] as const;

const DEFAULT_PROJECT_NAME = "Agent assurance project";
const DEFAULT_PROJECT_SLUG = "agent-assurance";

export interface BootstrapResult {
  organization: Organization;
  project: Project;
  membership: Membership;
}

export class EvidenceQuotaExceededError extends Error {
  constructor(
    readonly scope: "run" | "project",
    readonly limitBytes: number,
    readonly usedBytes: number,
    readonly requestedBytes: number,
  ) {
    super(`${scope} evidence storage quota of ${limitBytes} bytes would be exceeded.`);
    this.name = "EvidenceQuotaExceededError";
  }
}

export class TeamStateConflictError extends Error {
  constructor(readonly reason: "invitation_unavailable" | "member_exists" | "last_owner") {
    super(reason);
    this.name = "TeamStateConflictError";
  }
}

export interface ControlPlaneStore {
  migrate(): Promise<void>;
  bootstrapUser(userId: string, email?: string): Promise<BootstrapResult>;
  listProjectsForUser(userId: string): Promise<Project[]>;
  insertProject(project: Project): Promise<Project>;
  getOrganization(organizationId: string): Promise<Organization | undefined>;
  getProject(projectId: string): Promise<Project | undefined>;
  updateProject(project: Project): Promise<Project>;
  roleForProject(userId: string, projectId: string): Promise<MemberRole | undefined>;
  membershipForOrganization(userId: string, organizationId: string): Promise<Membership | undefined>;
  listTeamMembers(organizationId: string): Promise<TeamMemberRecord[]>;
  listTeamInvitations(organizationId: string): Promise<TeamInvitationRecord[]>;
  getTeamInvitationByTokenHash(tokenHash: string): Promise<TeamInvitationRecord | undefined>;
  saveTeamInvitation(invitation: TeamInvitationRecord): Promise<TeamInvitationRecord>;
  updateTeamInvitation(invitation: TeamInvitationRecord): Promise<TeamInvitationRecord>;
  acceptTeamInvitation(invitationId: string, membership: Membership, projectIds: string[], audit: TeamAuditRecord): Promise<TeamInvitationRecord>;
  updateTeamMember(organizationId: string, userId: string, role: MemberRole, projectIds: string[], actorId: string, audit: TeamAuditRecord): Promise<TeamMemberRecord>;
  removeTeamMember(organizationId: string, userId: string, audit: TeamAuditRecord): Promise<void>;
  appendTeamAudit(record: TeamAuditRecord): Promise<TeamAuditRecord>;
  listTeamAudit(organizationId: string, limit?: number): Promise<TeamAuditRecord[]>;
  insertPilotFeedback(feedback: PilotFeedbackRecord): Promise<PilotFeedbackRecord>;
  listPilotFeedback(projectId: string, limit?: number): Promise<PilotFeedbackRecord[]>;
  pilotFunnelSource(since: string): Promise<PilotFunnelSource>;
  insertAssuranceCase(record: AssuranceCaseRecord): Promise<AssuranceCaseRecord>;
  insertAssuranceCaseWithDecision(record: AssuranceCaseRecord, decision: AssuranceCaseDecisionRecord): Promise<AssuranceCaseRecord>;
  updateAssuranceCase(record: AssuranceCaseRecord, expectedStatus: AssuranceCaseRecord["status"], expectedUpdatedAt?: string): Promise<AssuranceCaseRecord | undefined>;
  transitionAssuranceCase(record: AssuranceCaseRecord, decision: AssuranceCaseDecisionRecord, expectedStatus: AssuranceCaseRecord["status"]): Promise<AssuranceCaseRecord | undefined>;
  getAssuranceCase(projectId: string, caseId: string): Promise<AssuranceCaseRecord | undefined>;
  getAssuranceCaseByPublicId(publicId: string): Promise<AssuranceCaseRecord | undefined>;
  listAssuranceCases(projectId: string, limit?: number): Promise<AssuranceCaseRecord[]>;
  listAssuranceCasesForMaintenance(now: string, before: string, limit?: number): Promise<AssuranceCaseRecord[]>;
  insertAssuranceCaseDecision(record: AssuranceCaseDecisionRecord): Promise<AssuranceCaseDecisionRecord>;
  listAssuranceCaseDecisions(projectId: string, caseId: string): Promise<AssuranceCaseDecisionRecord[]>;
  upsertAgent(agent: AgentRecord): Promise<AgentRecord>;
  getAgent(projectId: string, agentId: string): Promise<AgentRecord | undefined>;
  listAgents(projectId: string): Promise<AgentRecord[]>;
  upsertRun(run: RunRecord): Promise<RunRecord>;
  getRun(projectId: string, runId: string): Promise<RunRecord | undefined>;
  getRunByExternalId(projectId: string, externalId: string): Promise<RunRecord | undefined>;
  listRuns(projectId: string, limit?: number): Promise<RunRecord[]>;
  appendEvents(events: EventRecord[]): Promise<EventRecord[]>;
  listEvents(projectId: string, runId: string): Promise<EventRecord[]>;
  insertAction(action: ActionRecord): Promise<ActionRecord>;
  updateAction(action: ActionRecord): Promise<ActionRecord>;
  getAction(projectId: string, actionId: string): Promise<ActionRecord | undefined>;
  listActions(projectId: string, limit?: number): Promise<ActionRecord[]>;
  insertApproval(approval: ApprovalRecord): Promise<ApprovalRecord>;
  insertEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord>;
  insertEvidenceWithinQuota(evidence: EvidenceRecord, projectLimitBytes: number, runLimitBytes: number): Promise<EvidenceRecord>;
  findEvidenceByDigest(projectId: string, runId: string | undefined, actionId: string | undefined, kind: string, sha256: string, sourcePath?: string): Promise<EvidenceRecord | undefined>;
  getEvidence(projectId: string, evidenceId: string): Promise<EvidenceRecord | undefined>;
  listEvidence(projectId: string, limit?: number): Promise<EvidenceRecord[]>;
  listEvidenceForRun(projectId: string, runId: string): Promise<EvidenceRecord[]>;
  evidenceUsage(projectId: string, runId?: string): Promise<EvidenceStorageUsage>;
  listEvidenceCreatedBefore(before: string, limit?: number): Promise<EvidenceRecord[]>;
  deleteEvidence(projectId: string, evidenceId: string): Promise<boolean>;
  deleteEvidenceUnlessHeld(projectId: string, evidenceId: string, deleteObject: () => Promise<void>): Promise<"deleted" | "held" | "missing">;
  saveLegalHoldRequest(request: LegalHoldRequestRecord, expectedStatus?: LegalHoldRequestRecord["status"]): Promise<LegalHoldRequestRecord>;
  getLegalHoldRequest(requestId: string): Promise<LegalHoldRequestRecord | undefined>;
  listLegalHoldRequests(projectId: string, limit?: number): Promise<LegalHoldRequestRecord[]>;
  listPendingLegalHoldRequests(limit?: number): Promise<LegalHoldRequestRecord[]>;
  listLegalHoldRequestsForAdmin(status?: LegalHoldRequestRecord["status"], limit?: number): Promise<LegalHoldRequestRecord[]>;
  getApprovedLegalHold(projectId: string): Promise<LegalHoldRequestRecord | undefined>;
  insertIncident(incident: IncidentRecord): Promise<IncidentRecord>;
  insertIncidentWithTransition(incident: IncidentRecord, transition: IncidentTransitionRecord): Promise<{ incident: IncidentRecord; transition: IncidentTransitionRecord }>;
  getIncident(projectId: string, incidentId: string): Promise<IncidentRecord | undefined>;
  updateIncident(incident: IncidentRecord): Promise<IncidentRecord>;
  updateIncidentWithTransition(incident: IncidentRecord, transition: IncidentTransitionRecord): Promise<{ incident: IncidentRecord; transition: IncidentTransitionRecord }>;
  getActiveIncidentByFingerprint(projectId: string, fingerprint: string): Promise<IncidentRecord | undefined>;
  getLatestIncidentByFingerprint(projectId: string, fingerprint: string): Promise<IncidentRecord | undefined>;
  listIncidents(projectId: string, limit?: number): Promise<IncidentRecord[]>;
  listIncidentsForRun(projectId: string, runId: string): Promise<IncidentRecord[]>;
  insertIncidentTransition(transition: IncidentTransitionRecord): Promise<IncidentTransitionRecord>;
  listIncidentTransitions(projectId: string, incidentId: string): Promise<IncidentTransitionRecord[]>;
  upsertFailureReview(review: FailureReviewRecord): Promise<FailureReviewRecord>;
  listFailureReviews(projectId: string, runId: string): Promise<FailureReviewRecord[]>;
  listFailureReviewsForProject(projectId: string, limit?: number): Promise<FailureReviewRecord[]>;
  insertEvidenceDeletion(record: EvidenceDeletionRecord): Promise<EvidenceDeletionRecord>;
  listEvidenceDeletions(projectId: string, limit?: number): Promise<EvidenceDeletionRecord[]>;
  getIdempotency(projectId: string, key: string, operation: string): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord>;
  insertWebhook(webhook: WebhookRecord): Promise<WebhookRecord>;
  listWebhooks(projectId: string): Promise<WebhookRecord[]>;
  revokeWebhook(projectId: string, webhookId: string, revokedAt: string): Promise<WebhookRecord | undefined>;
  insertWebhookDelivery(delivery: WebhookDeliveryRecord): Promise<WebhookDeliveryRecord>;
  listWebhookDeliveries(projectId: string, limit?: number): Promise<WebhookDeliveryRecord[]>;
  enqueueWebhookJob(job: WebhookJobRecord): Promise<WebhookJobRecord>;
  claimWebhookJobs(workerId: string, now: string, leaseExpiredBefore: string, limit?: number): Promise<WebhookJobRecord[]>;
  updateWebhookJob(job: WebhookJobRecord): Promise<WebhookJobRecord>;
  getWebhookJob(projectId: string, jobId: string): Promise<WebhookJobRecord | undefined>;
  listWebhookJobs(projectId: string, limit?: number): Promise<WebhookJobRecord[]>;
  webhookJobCounts(projectId: string): Promise<WebhookJobCounts>;
  webhookOperationsMetrics(projectId: string, since: string): Promise<WebhookOperationsMetrics>;
  saveTrustHealthSample(sample: TrustHealthSampleRecord): Promise<TrustHealthSampleRecord>;
  listTrustHealthSamples(projectId: string, since: string, limit?: number): Promise<TrustHealthSampleRecord[]>;
  trustHealthCounts(projectId: string, since: string): Promise<{ total: number; passed: number; failed: number }>;
  saveNotificationDestination(destination: NotificationDestinationRecord): Promise<NotificationDestinationRecord>;
  verifyNotificationDestination(tokenHash: string, now: string): Promise<NotificationVerificationStoreResult>;
  listNotificationDestinations(projectId: string): Promise<NotificationDestinationRecord[]>;
  disableNotificationDestination(projectId: string, destinationId: string, disabledAt: string): Promise<NotificationDestinationRecord | undefined>;
  insertNotificationDelivery(delivery: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord>;
  listNotificationDeliveries(projectId: string, limit?: number): Promise<NotificationDeliveryRecord[]>;
  enqueueNotificationJob(job: NotificationJobRecord): Promise<NotificationJobRecord>;
  claimNotificationJobs(workerId: string, now: string, leaseExpiredBefore: string, limit?: number): Promise<NotificationJobRecord[]>;
  updateNotificationJob(job: NotificationJobRecord): Promise<NotificationJobRecord>;
  getNotificationJob(projectId: string, jobId: string): Promise<NotificationJobRecord | undefined>;
  listNotificationJobs(projectId: string, limit?: number): Promise<NotificationJobRecord[]>;
  notificationJobCounts(projectId: string): Promise<NotificationJobCounts>;
  activateSigningKey(key: SigningKeyRecord): Promise<SigningKeyRecord>;
  getSigningKey(keyId: string): Promise<SigningKeyRecord | undefined>;
  listSigningKeys(): Promise<SigningKeyRecord[]>;
  insertApiKey(apiKey: ApiKeyRecord): Promise<ApiKeyRecord>;
  findApiKeyByHash(secretHash: string): Promise<ApiKeyRecord | undefined>;
  touchApiKey(apiKeyId: string, usedAt: string): Promise<void>;
  listApiKeys(projectId: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(projectId: string, apiKeyId: string, revokedAt: string): Promise<ApiKeyRecord | undefined>;
  activateCollectorSourceKey(key: CollectorSourceKeyRecord): Promise<CollectorSourceKeyRecord>;
  getCollectorSourceKey(projectId: string, keyId: string): Promise<CollectorSourceKeyRecord | undefined>;
  listCollectorSourceKeys(projectId: string): Promise<CollectorSourceKeyRecord[]>;
  revokeCollectorSourceKey(projectId: string, keyId: string, revokedAt: string): Promise<CollectorSourceKeyRecord | undefined>;
  appendTrustedCollectorRecords(projectId: string, runId: string, collectorId: string, sourceKeyId: string, records: TrustedSourceRecord[], receivedAt: string): Promise<TrustedCollectorAppendResult>;
  getTrustedCollectorRun(projectId: string, runId: string): Promise<TrustedCollectorRunRecord | undefined>;
  listTrustedCollectorRuns(projectId: string, limit?: number): Promise<TrustedCollectorRunRecord[]>;
  saveTrustedCollectorReconciliation(projectId: string, runId: string, sourceReceipt: Record<string, unknown>, reconciliation: Record<string, unknown>, serverAttestation: Record<string, unknown>, updatedAt: string): Promise<TrustedCollectorRunRecord>;
  saveCollectorHeartbeat(heartbeat: CollectorHeartbeatRecord): Promise<CollectorHeartbeatRecord>;
  listCollectorHeartbeats(projectId: string): Promise<CollectorHeartbeatRecord[]>;
  listTrustedCollectorAlerts(projectId: string, limit?: number): Promise<TrustedCollectorAlertRecord[]>;
  close(): Promise<void>;
}

export class TrustedCollectorConflictError extends Error {
  constructor(readonly reason: "key_conflict" | "run_conflict" | "sequence_conflict" | "chain_conflict" | "undeclared_gap" | "invalid_start" | "run_closed") {
    super(reason);
    this.name = "TrustedCollectorConflictError";
  }
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private organizations = new Map<string, Organization>();
  private memberships = new Map<string, Membership>();
  private projectMemberships = new Map<string, { projectId: string; userId: string; grantedBy?: string; createdAt: string }>();
  private teamInvitations = new Map<string, TeamInvitationRecord>();
  private teamAudit = new Map<string, TeamAuditRecord>();
  private projects = new Map<string, Project>();
  private agents = new Map<string, AgentRecord>();
  private runs = new Map<string, RunRecord>();
  private events = new Map<string, EventRecord>();
  private actions = new Map<string, ActionRecord>();
  private approvals = new Map<string, ApprovalRecord>();
  private evidence = new Map<string, EvidenceRecord>();
  private incidents = new Map<string, IncidentRecord>();
  private incidentTransitions = new Map<string, IncidentTransitionRecord>();
  private failureReviews = new Map<string, FailureReviewRecord>();
  private apiKeys = new Map<string, ApiKeyRecord>();
  private legalHoldRequests = new Map<string, LegalHoldRequestRecord>();
  private evidenceDeletions = new Map<string, EvidenceDeletionRecord>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private webhooks = new Map<string, WebhookRecord>();
  private webhookDeliveries = new Map<string, WebhookDeliveryRecord>();
  private webhookJobs = new Map<string, WebhookJobRecord>();
  private trustHealthSamples = new Map<string, TrustHealthSampleRecord>();
  private notificationDestinations = new Map<string, NotificationDestinationRecord>();
  private notificationDeliveries = new Map<string, NotificationDeliveryRecord>();
  private notificationJobs = new Map<string, NotificationJobRecord>();
  private signingKeys = new Map<string, SigningKeyRecord>();
  private collectorSourceKeys = new Map<string, CollectorSourceKeyRecord>();
  private trustedCollectorRuns = new Map<string, TrustedCollectorRunRecord>();
  private trustedCollectorRecords = new Map<string, TrustedCollectorRecord>();
  private collectorHeartbeats = new Map<string, CollectorHeartbeatRecord>();
  private trustedCollectorAlerts = new Map<string, TrustedCollectorAlertRecord>();
  private pilotFeedback = new Map<string, PilotFeedbackRecord>();
  private assuranceCases = new Map<string, AssuranceCaseRecord>();
  private assuranceCaseDecisions = new Map<string, AssuranceCaseDecisionRecord>();
  private retentionLocks = new Map<string, Promise<void>>();

  async migrate(): Promise<void> {}

  async bootstrapUser(userId: string, email?: string): Promise<BootstrapResult> {
    const existing = [...this.memberships.values()].find((item) => item.userId === userId);
    if (existing) {
      if (email && existing.email !== email) {
        existing.email = email;
        this.memberships.set(`${existing.organizationId}:${userId}`, existing);
      }
      const organization = required(this.organizations.get(existing.organizationId), "organization");
      const project = required((await this.listProjectsForUser(userId)).find((item) => item.organizationId === organization.id), "project");
      return { organization, project, membership: existing };
    }
    const now = new Date().toISOString();
    const identity = email?.split("@")[0] || "workspace";
    const organization: Organization = {
      id: randomUUID(),
      name: `${identity} workspace`,
      slug: uniqueSlug(identity, [...this.organizations.values()].map((item) => item.slug)),
      createdAt: now,
    };
    const project: Project = {
      id: randomUUID(),
      organizationId: organization.id,
      name: DEFAULT_PROJECT_NAME,
      slug: DEFAULT_PROJECT_SLUG,
      createdAt: now,
    };
    const membership: Membership = { organizationId: organization.id, userId, email, role: "owner", createdAt: now };
    this.organizations.set(organization.id, organization);
    this.projects.set(project.id, project);
    this.memberships.set(`${organization.id}:${userId}`, membership);
    return { organization, project, membership };
  }

  async listProjectsForUser(userId: string): Promise<Project[]> {
    const memberships = [...this.memberships.values()].filter((item) => item.userId === userId);
    const privilegedOrganizations = new Set(memberships.filter((item) => item.role === "owner" || item.role === "admin").map((item) => item.organizationId));
    const assignedProjects = new Set([...this.projectMemberships.values()].filter((item) => item.userId === userId).map((item) => item.projectId));
    return [...this.projects.values()].filter((item) => privilegedOrganizations.has(item.organizationId) || assignedProjects.has(item.id));
  }

  async insertProject(project: Project): Promise<Project> {
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return this.projects.get(projectId);
  }

  async updateProject(project: Project): Promise<Project> {
    if (!this.projects.has(project.id)) throw new Error("Project was not found.");
    this.projects.set(project.id, project);
    return project;
  }

  async getOrganization(organizationId: string): Promise<Organization | undefined> {
    const organization = this.organizations.get(organizationId);
    return organization ? structuredClone(organization) : undefined;
  }

  async membershipForOrganization(userId: string, organizationId: string): Promise<Membership | undefined> {
    const membership = this.memberships.get(`${organizationId}:${userId}`);
    return membership ? structuredClone(membership) : undefined;
  }

  async listTeamMembers(organizationId: string): Promise<TeamMemberRecord[]> {
    const organizationProjectIds = [...this.projects.values()].filter((item) => item.organizationId === organizationId).map((item) => item.id);
    return [...this.memberships.values()].filter((item) => item.organizationId === organizationId).map((item) => ({
      ...structuredClone(item),
      projectIds: item.role === "owner" || item.role === "admin"
        ? organizationProjectIds
        : [...this.projectMemberships.values()].filter((access) => access.userId === item.userId && organizationProjectIds.includes(access.projectId)).map((access) => access.projectId),
    }));
  }

  async listTeamInvitations(organizationId: string): Promise<TeamInvitationRecord[]> {
    return newest([...this.teamInvitations.values()].filter((item) => item.organizationId === organizationId), "createdAt").map((item) => structuredClone(item));
  }

  async getTeamInvitationByTokenHash(tokenHash: string): Promise<TeamInvitationRecord | undefined> {
    const invitation = [...this.teamInvitations.values()].find((item) => item.tokenHash === tokenHash);
    return invitation ? structuredClone(invitation) : undefined;
  }

  async saveTeamInvitation(invitation: TeamInvitationRecord): Promise<TeamInvitationRecord> {
    const duplicate = [...this.teamInvitations.values()].find((item) => item.organizationId === invitation.organizationId && item.email.toLowerCase() === invitation.email.toLowerCase() && item.status === "pending");
    if (duplicate) throw new TeamStateConflictError("invitation_unavailable");
    this.teamInvitations.set(invitation.id, structuredClone(invitation));
    return structuredClone(invitation);
  }

  async updateTeamInvitation(invitation: TeamInvitationRecord): Promise<TeamInvitationRecord> {
    if (!this.teamInvitations.has(invitation.id)) throw new TeamStateConflictError("invitation_unavailable");
    this.teamInvitations.set(invitation.id, structuredClone(invitation));
    return structuredClone(invitation);
  }

  async acceptTeamInvitation(invitationId: string, membership: Membership, projectIds: string[], audit: TeamAuditRecord): Promise<TeamInvitationRecord> {
    const invitation = this.teamInvitations.get(invitationId);
    if (!invitation || invitation.status !== "pending") throw new TeamStateConflictError("invitation_unavailable");
    if (this.memberships.has(`${membership.organizationId}:${membership.userId}`)) throw new TeamStateConflictError("member_exists");
    this.memberships.set(`${membership.organizationId}:${membership.userId}`, structuredClone(membership));
    for (const projectId of projectIds) this.projectMemberships.set(`${projectId}:${membership.userId}`, { projectId, userId: membership.userId, grantedBy: invitation.invitedBy, createdAt: audit.occurredAt });
    const accepted = { ...invitation, status: "accepted" as const, acceptedBy: membership.userId, acceptedAt: audit.occurredAt };
    this.teamInvitations.set(invitationId, accepted);
    this.teamAudit.set(audit.id, structuredClone(audit));
    return structuredClone(accepted);
  }

  async updateTeamMember(organizationId: string, userId: string, role: MemberRole, projectIds: string[], actorId: string, audit: TeamAuditRecord): Promise<TeamMemberRecord> {
    const key = `${organizationId}:${userId}`;
    const current = this.memberships.get(key);
    if (!current) throw new TeamStateConflictError("member_exists");
    if (current.role === "owner" && role !== "owner" && [...this.memberships.values()].filter((item) => item.organizationId === organizationId && item.role === "owner").length === 1) throw new TeamStateConflictError("last_owner");
    const next = { ...current, role };
    this.memberships.set(key, next);
    const organizationProjectIds = new Set([...this.projects.values()].filter((item) => item.organizationId === organizationId).map((item) => item.id));
    for (const [accessKey, access] of this.projectMemberships) if (access.userId === userId && organizationProjectIds.has(access.projectId)) this.projectMemberships.delete(accessKey);
    if (role === "operator" || role === "viewer") for (const projectId of projectIds) this.projectMemberships.set(`${projectId}:${userId}`, { projectId, userId, grantedBy: actorId, createdAt: audit.occurredAt });
    this.teamAudit.set(audit.id, structuredClone(audit));
    return { ...structuredClone(next), projectIds: role === "owner" || role === "admin" ? [...organizationProjectIds] : [...projectIds] };
  }

  async removeTeamMember(organizationId: string, userId: string, audit: TeamAuditRecord): Promise<void> {
    const key = `${organizationId}:${userId}`;
    const current = this.memberships.get(key);
    if (!current) throw new TeamStateConflictError("member_exists");
    if (current.role === "owner" && [...this.memberships.values()].filter((item) => item.organizationId === organizationId && item.role === "owner").length === 1) throw new TeamStateConflictError("last_owner");
    this.memberships.delete(key);
    const organizationProjectIds = new Set([...this.projects.values()].filter((item) => item.organizationId === organizationId).map((item) => item.id));
    for (const [accessKey, access] of this.projectMemberships) if (access.userId === userId && organizationProjectIds.has(access.projectId)) this.projectMemberships.delete(accessKey);
    this.teamAudit.set(audit.id, structuredClone(audit));
  }

  async appendTeamAudit(record: TeamAuditRecord): Promise<TeamAuditRecord> {
    this.teamAudit.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async listTeamAudit(organizationId: string, limit = 100): Promise<TeamAuditRecord[]> {
    return newest([...this.teamAudit.values()].filter((item) => item.organizationId === organizationId), "occurredAt").slice(0, limit).map((item) => structuredClone(item));
  }

  async insertPilotFeedback(feedback: PilotFeedbackRecord): Promise<PilotFeedbackRecord> {
    this.pilotFeedback.set(feedback.id, feedback);
    return feedback;
  }

  async listPilotFeedback(projectId: string, limit = 100): Promise<PilotFeedbackRecord[]> {
    return newest([...this.pilotFeedback.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async pilotFunnelSource(since: string): Promise<PilotFunnelSource> {
    const projects = [...this.projects.values()].filter((project) => project.createdAt >= since);
    const projectIds = new Set(projects.map((project) => project.id));
    return {
      projects: projects.map((project) => {
        const keys = [...this.apiKeys.values()].filter((item) => item.projectId === project.id);
        const firstKeyAt = keys.map((item) => item.createdAt).sort()[0];
        const firstConnectionAt = keys.map((item) => item.lastUsedAt).filter((value): value is string => Boolean(value)).sort()[0];
        const firstEvidenceAt = firstConnectionAt
          ? [...this.evidence.values()].filter((item) => item.projectId === project.id && item.createdAt >= firstConnectionAt)
            .map((item) => item.createdAt).sort()[0]
          : undefined;
        const firstCurrentAt = [...this.assuranceCases.values()]
          .filter((item) => item.projectId === project.id && item.continuousAssurance?.firstCurrentAt)
          .map((item) => item.continuousAssurance!.firstCurrentAt!).sort()[0];
        return { project, firstKeyAt, firstConnectionAt, firstEvidenceAt, firstCurrentAt };
      }),
      feedback: [...this.pilotFeedback.values()].filter((item) => projectIds.has(item.projectId)),
    };
  }

  async insertAssuranceCase(record: AssuranceCaseRecord): Promise<AssuranceCaseRecord> {
    this.assuranceCases.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async insertAssuranceCaseWithDecision(record: AssuranceCaseRecord, decision: AssuranceCaseDecisionRecord): Promise<AssuranceCaseRecord> {
    this.assuranceCases.set(record.id, structuredClone(record));
    this.assuranceCaseDecisions.set(decision.id, structuredClone(decision));
    return structuredClone(record);
  }

  async updateAssuranceCase(record: AssuranceCaseRecord, expectedStatus: AssuranceCaseRecord["status"], expectedUpdatedAt?: string): Promise<AssuranceCaseRecord | undefined> {
    const current = this.assuranceCases.get(record.id);
    if (!current || current.projectId !== record.projectId || current.status !== expectedStatus || (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)) return undefined;
    this.assuranceCases.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async transitionAssuranceCase(record: AssuranceCaseRecord, decision: AssuranceCaseDecisionRecord, expectedStatus: AssuranceCaseRecord["status"]): Promise<AssuranceCaseRecord | undefined> {
    const updated = await this.updateAssuranceCase(record, expectedStatus);
    if (!updated) return undefined;
    this.assuranceCaseDecisions.set(decision.id, structuredClone(decision));
    return updated;
  }

  async getAssuranceCase(projectId: string, caseId: string): Promise<AssuranceCaseRecord | undefined> {
    const record = this.assuranceCases.get(caseId);
    return record?.projectId === projectId ? structuredClone(record) : undefined;
  }

  async getAssuranceCaseByPublicId(publicId: string): Promise<AssuranceCaseRecord | undefined> {
    const record = [...this.assuranceCases.values()].find((item) => item.publicVerificationId === publicId);
    return record ? structuredClone(record) : undefined;
  }

  async listAssuranceCases(projectId: string, limit = 100): Promise<AssuranceCaseRecord[]> {
    return newest([...this.assuranceCases.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit).map((item) => structuredClone(item));
  }

  async listAssuranceCasesForMaintenance(now: string, before: string, limit = 200): Promise<AssuranceCaseRecord[]> {
    return [...this.assuranceCases.values()]
      .filter((item) => assuranceMaintenanceDue(item, now, before))
      .sort((left, right) => left.expiresAt!.localeCompare(right.expiresAt!))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async insertAssuranceCaseDecision(record: AssuranceCaseDecisionRecord): Promise<AssuranceCaseDecisionRecord> {
    this.assuranceCaseDecisions.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async listAssuranceCaseDecisions(projectId: string, caseId: string): Promise<AssuranceCaseDecisionRecord[]> {
    return [...this.assuranceCaseDecisions.values()].filter((item) => item.projectId === projectId && item.assuranceCaseId === caseId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).map((item) => structuredClone(item));
  }

  async roleForProject(userId: string, projectId: string): Promise<MemberRole | undefined> {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    const membership = this.memberships.get(`${project.organizationId}:${userId}`);
    if (!membership) return undefined;
    if (membership.role === "owner" || membership.role === "admin") return membership.role;
    return this.projectMemberships.has(`${projectId}:${userId}`) ? membership.role : undefined;
  }

  async upsertAgent(agent: AgentRecord): Promise<AgentRecord> {
    const existing = [...this.agents.values()].find(
      (item) => item.projectId === agent.projectId && item.externalId === agent.externalId,
    );
    const next = existing ? { ...agent, id: existing.id, createdAt: existing.createdAt } : agent;
    this.agents.set(next.id, next);
    return next;
  }

  async getAgent(projectId: string, agentId: string): Promise<AgentRecord | undefined> {
    const item = this.agents.get(agentId);
    return item?.projectId === projectId ? item : undefined;
  }

  async listAgents(projectId: string): Promise<AgentRecord[]> {
    return newest([...this.agents.values()].filter((item) => item.projectId === projectId), "updatedAt");
  }

  async upsertRun(run: RunRecord): Promise<RunRecord> {
    const existing = [...this.runs.values()].find(
      (item) => item.projectId === run.projectId && item.externalId === run.externalId,
    );
    const next = existing ? { ...run, id: existing.id, startedAt: existing.startedAt } : run;
    this.runs.set(next.id, next);
    return next;
  }

  async getRun(projectId: string, runId: string): Promise<RunRecord | undefined> {
    const item = this.runs.get(runId);
    return item?.projectId === projectId ? item : undefined;
  }

  async listRuns(projectId: string, limit = 100): Promise<RunRecord[]> {
    return newest([...this.runs.values()].filter((item) => item.projectId === projectId), "startedAt").slice(0, limit);
  }

  async appendEvents(events: EventRecord[]): Promise<EventRecord[]> {
    for (const event of events) {
      const existing = [...this.events.values()].find(
        (item) => item.runId === event.runId && item.sequence === event.sequence,
      );
      this.events.set(existing?.id ?? event.id, existing ? { ...event, id: existing.id } : event);
    }
    return events;
  }

  async listEvents(projectId: string, runId: string): Promise<EventRecord[]> {
    return [...this.events.values()]
      .filter((item) => item.projectId === projectId && item.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async insertAction(action: ActionRecord): Promise<ActionRecord> {
    const existing = [...this.actions.values()].find(
      (item) => item.projectId === action.projectId && item.externalId === action.externalId,
    );
    if (existing) return existing;
    this.actions.set(action.id, action);
    return action;
  }

  async updateAction(action: ActionRecord): Promise<ActionRecord> {
    this.actions.set(action.id, action);
    return action;
  }

  async getAction(projectId: string, actionId: string): Promise<ActionRecord | undefined> {
    const item = this.actions.get(actionId);
    return item?.projectId === projectId ? item : undefined;
  }

  async listActions(projectId: string, limit = 100): Promise<ActionRecord[]> {
    return newest([...this.actions.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async insertApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async insertEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord> {
    const existing = await this.findEvidenceByDigest(evidence.projectId, evidence.runId, evidence.actionId, evidence.kind, evidence.sha256, evidenceSourcePath(evidence));
    if (existing && (evidence.runId || evidence.actionId)) return existing;
    this.evidence.set(evidence.id, evidence);
    return evidence;
  }

  async insertEvidenceWithinQuota(evidence: EvidenceRecord, projectLimitBytes: number, runLimitBytes: number): Promise<EvidenceRecord> {
    const existing = await this.findEvidenceByDigest(evidence.projectId, evidence.runId, evidence.actionId, evidence.kind, evidence.sha256, evidenceSourcePath(evidence));
    if (existing && (evidence.runId || evidence.actionId)) return existing;
    const projectUsage = await this.evidenceUsage(evidence.projectId);
    if (projectUsage.bytes + evidence.sizeBytes > projectLimitBytes) {
      throw new EvidenceQuotaExceededError("project", projectLimitBytes, projectUsage.bytes, evidence.sizeBytes);
    }
    if (evidence.runId) {
      const runUsage = await this.evidenceUsage(evidence.projectId, evidence.runId);
      if (runUsage.bytes + evidence.sizeBytes > runLimitBytes) {
        throw new EvidenceQuotaExceededError("run", runLimitBytes, runUsage.bytes, evidence.sizeBytes);
      }
    }
    this.evidence.set(evidence.id, evidence);
    return evidence;
  }

  async getRunByExternalId(projectId: string, externalId: string): Promise<RunRecord | undefined> {
    return [...this.runs.values()].find((item) => item.projectId === projectId && item.externalId === externalId);
  }

  async findEvidenceByDigest(projectId: string, runId: string | undefined, actionId: string | undefined, kind: string, sha256: string, sourcePath?: string): Promise<EvidenceRecord | undefined> {
    return [...this.evidence.values()].find((item) => item.projectId === projectId
      && item.runId === runId && item.actionId === actionId && item.kind === kind && item.sha256 === sha256
      && evidenceSourcePath(item) === sourcePath);
  }

  async getEvidence(projectId: string, evidenceId: string): Promise<EvidenceRecord | undefined> {
    const item = this.evidence.get(evidenceId);
    return item?.projectId === projectId ? item : undefined;
  }

  async listEvidence(projectId: string, limit = 100): Promise<EvidenceRecord[]> {
    return newest([...this.evidence.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async listEvidenceForRun(projectId: string, runId: string): Promise<EvidenceRecord[]> {
    return newest(
      [...this.evidence.values()].filter((item) => item.projectId === projectId && item.runId === runId),
      "createdAt",
    );
  }

  async evidenceUsage(projectId: string, runId?: string): Promise<EvidenceStorageUsage> {
    const evidence = [...this.evidence.values()].filter((item) => item.projectId === projectId && (!runId || item.runId === runId));
    return { count: evidence.length, bytes: evidence.reduce((total, item) => total + item.sizeBytes, 0) };
  }

  async listEvidenceCreatedBefore(before: string, limit = 500): Promise<EvidenceRecord[]> {
    const cutoff = Date.parse(before);
    const heldProjects = new Set([...this.legalHoldRequests.values()]
      .filter((request) => request.status === "approved")
      .map((request) => request.projectId));
    return [...this.evidence.values()]
      .filter((item) => Date.parse(item.createdAt) < cutoff && !heldProjects.has(item.projectId))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(0, limit);
  }

  async deleteEvidence(projectId: string, evidenceId: string): Promise<boolean> {
    const evidence = this.evidence.get(evidenceId);
    return evidence?.projectId === projectId ? this.evidence.delete(evidenceId) : false;
  }

  async deleteEvidenceUnlessHeld(
    projectId: string,
    evidenceId: string,
    deleteObject: () => Promise<void>,
  ): Promise<"deleted" | "held" | "missing"> {
    return this.withRetentionLock(projectId, async () => {
      if (await this.getApprovedLegalHold(projectId)) return "held";
      const evidence = this.evidence.get(evidenceId);
      if (!evidence || evidence.projectId !== projectId) return "missing";
      await deleteObject();
      this.evidence.delete(evidenceId);
      return "deleted";
    });
  }

  async saveLegalHoldRequest(
    request: LegalHoldRequestRecord,
    expectedStatus?: LegalHoldRequestRecord["status"],
  ): Promise<LegalHoldRequestRecord> {
    return this.withRetentionLock(request.projectId, async () => {
      const existing = this.legalHoldRequests.get(request.id);
      if (expectedStatus && existing?.status !== expectedStatus) throw new LegalHoldStateConflictError(expectedStatus);
      const active = [...this.legalHoldRequests.values()].find((item) =>
        item.projectId === request.projectId && item.id !== request.id && (item.status === "requested" || item.status === "approved"));
      if (active && (request.status === "requested" || request.status === "approved")) {
        throw new Error("An active legal hold request already exists for this project.");
      }
      this.legalHoldRequests.set(request.id, request);
      return request;
    });
  }

  async getLegalHoldRequest(requestId: string): Promise<LegalHoldRequestRecord | undefined> {
    return this.legalHoldRequests.get(requestId);
  }

  async listLegalHoldRequests(projectId: string, limit = 20): Promise<LegalHoldRequestRecord[]> {
    return newest([...this.legalHoldRequests.values()].filter((item) => item.projectId === projectId), "requestedAt").slice(0, limit);
  }

  async listPendingLegalHoldRequests(limit = 100): Promise<LegalHoldRequestRecord[]> {
    return [...this.legalHoldRequests.values()].filter((item) => item.status === "requested")
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt)).slice(0, limit);
  }

  async getApprovedLegalHold(projectId: string): Promise<LegalHoldRequestRecord | undefined> {
    return [...this.legalHoldRequests.values()].find((item) => item.projectId === projectId && item.status === "approved");
  }

  private async withRetentionLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.retentionLocks.get(projectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.retentionLocks.set(projectId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.retentionLocks.get(projectId) === queued) this.retentionLocks.delete(projectId);
    }
  }

  async insertIncident(incident: IncidentRecord): Promise<IncidentRecord> {
    this.incidents.set(incident.id, incident);
    return incident;
  }

  async insertIncidentWithTransition(incident: IncidentRecord, transition: IncidentTransitionRecord) {
    this.incidents.set(incident.id, incident);
    this.incidentTransitions.set(transition.id, transition);
    return { incident, transition };
  }

  async getIncident(projectId: string, incidentId: string): Promise<IncidentRecord | undefined> {
    const incident = this.incidents.get(incidentId);
    return incident?.projectId === projectId ? incident : undefined;
  }

  async updateIncident(incident: IncidentRecord): Promise<IncidentRecord> {
    if (!this.incidents.has(incident.id)) throw new Error(`Incident ${incident.id} was not found.`);
    this.incidents.set(incident.id, incident);
    return incident;
  }

  async updateIncidentWithTransition(incident: IncidentRecord, transition: IncidentTransitionRecord) {
    if (!this.incidents.has(incident.id)) throw new Error(`Incident ${incident.id} was not found.`);
    this.incidents.set(incident.id, incident);
    this.incidentTransitions.set(transition.id, transition);
    return { incident, transition };
  }

  async getActiveIncidentByFingerprint(projectId: string, fingerprint: string): Promise<IncidentRecord | undefined> {
    return newest([...this.incidents.values()].filter((item) => item.projectId === projectId && item.fingerprint === fingerprint && item.status !== "resolved"), "createdAt")[0];
  }

  async getLatestIncidentByFingerprint(projectId: string, fingerprint: string): Promise<IncidentRecord | undefined> {
    return newest([...this.incidents.values()].filter((item) => item.projectId === projectId && item.fingerprint === fingerprint), "createdAt")[0];
  }

  async listIncidents(projectId: string, limit = 100): Promise<IncidentRecord[]> {
    return newest([...this.incidents.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async listIncidentsForRun(projectId: string, runId: string): Promise<IncidentRecord[]> {
    return newest(
      [...this.incidents.values()].filter((item) => item.projectId === projectId && item.runId === runId),
      "createdAt",
    );
  }

  async insertIncidentTransition(transition: IncidentTransitionRecord): Promise<IncidentTransitionRecord> {
    this.incidentTransitions.set(transition.id, transition);
    return transition;
  }

  async listIncidentTransitions(projectId: string, incidentId: string): Promise<IncidentTransitionRecord[]> {
    return [...this.incidentTransitions.values()].filter((item) => item.projectId === projectId && item.incidentId === incidentId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  async upsertFailureReview(review: FailureReviewRecord): Promise<FailureReviewRecord> {
    const existing = [...this.failureReviews.values()].find(
      (item) => item.projectId === review.projectId && item.runId === review.runId && item.patternKey === review.patternKey,
    );
    const next = existing ? { ...review, id: existing.id, createdAt: existing.createdAt } : review;
    this.failureReviews.set(next.id, next);
    return next;
  }

  async listFailureReviews(projectId: string, runId: string): Promise<FailureReviewRecord[]> {
    return newest(
      [...this.failureReviews.values()].filter((item) => item.projectId === projectId && item.runId === runId),
      "updatedAt",
    );
  }

  async listLegalHoldRequestsForAdmin(status?: LegalHoldRequestRecord["status"], limit = 200): Promise<LegalHoldRequestRecord[]> {
    return newest([...this.legalHoldRequests.values()].filter((item) => !status || item.status === status), "requestedAt").slice(0, limit);
  }

  async listFailureReviewsForProject(projectId: string, limit = 10_000): Promise<FailureReviewRecord[]> {
    return newest([...this.failureReviews.values()].filter((item) => item.projectId === projectId), "updatedAt").slice(0, limit);
  }

  async insertEvidenceDeletion(record: EvidenceDeletionRecord): Promise<EvidenceDeletionRecord> {
    this.evidenceDeletions.set(record.id, record);
    return record;
  }

  async listEvidenceDeletions(projectId: string, limit = 500): Promise<EvidenceDeletionRecord[]> {
    return newest([...this.evidenceDeletions.values()].filter((item) => item.projectId === projectId), "occurredAt").slice(0, limit);
  }

  async getIdempotency(projectId: string, key: string, operation: string): Promise<IdempotencyRecord | undefined> {
    const record = this.idempotency.get(`${projectId}:${operation}:${key}`);
    if (record && Date.parse(record.expiresAt) > Date.now()) return record;
    return undefined;
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const mapKey = `${record.projectId}:${record.operation}:${record.key}`;
    const existing = this.idempotency.get(mapKey);
    if (existing) return existing;
    this.idempotency.set(mapKey, record);
    return record;
  }

  async insertWebhook(webhook: WebhookRecord): Promise<WebhookRecord> { this.webhooks.set(webhook.id, webhook); return webhook; }
  async listWebhooks(projectId: string): Promise<WebhookRecord[]> {
    return newest([...this.webhooks.values()].filter((item) => item.projectId === projectId), "createdAt");
  }
  async revokeWebhook(projectId: string, webhookId: string, revokedAt: string): Promise<WebhookRecord | undefined> {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook || webhook.projectId !== projectId) return undefined;
    const next = { ...webhook, revokedAt: webhook.revokedAt ?? revokedAt };
    this.webhooks.set(webhookId, next);
    return next;
  }
  async insertWebhookDelivery(delivery: WebhookDeliveryRecord): Promise<WebhookDeliveryRecord> {
    this.webhookDeliveries.set(delivery.id, delivery); return delivery;
  }
  async listWebhookDeliveries(projectId: string, limit = 100): Promise<WebhookDeliveryRecord[]> {
    return newest([...this.webhookDeliveries.values()].filter((item) => item.projectId === projectId), "attemptedAt").slice(0, limit);
  }

  async enqueueWebhookJob(job: WebhookJobRecord): Promise<WebhookJobRecord> {
    this.webhookJobs.set(job.id, job);
    return job;
  }

  async claimWebhookJobs(workerId: string, now: string, leaseExpiredBefore: string, limit = 20): Promise<WebhookJobRecord[]> {
    const due = [...this.webhookJobs.values()]
      .filter((job) => (job.status === "pending" || job.status === "retrying" || (job.status === "processing" && Boolean(job.lockedAt) && job.lockedAt! <= leaseExpiredBefore)) && job.nextAttemptAt <= now)
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, limit);
    return due.map((job) => {
      const claimed = { ...job, status: "processing" as const, lockedAt: now, lockedBy: workerId };
      this.webhookJobs.set(job.id, claimed);
      return claimed;
    });
  }

  async updateWebhookJob(job: WebhookJobRecord): Promise<WebhookJobRecord> {
    this.webhookJobs.set(job.id, job);
    return job;
  }

  async getWebhookJob(projectId: string, jobId: string): Promise<WebhookJobRecord | undefined> {
    const job = this.webhookJobs.get(jobId);
    return job?.projectId === projectId ? job : undefined;
  }

  async listWebhookJobs(projectId: string, limit = 100): Promise<WebhookJobRecord[]> {
    return newest([...this.webhookJobs.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async webhookJobCounts(projectId: string): Promise<WebhookJobCounts> {
    const counts = emptyWebhookJobCounts();
    for (const job of this.webhookJobs.values()) if (job.projectId === projectId) counts[job.status] += 1;
    return counts;
  }

  async webhookOperationsMetrics(projectId: string, since: string): Promise<WebhookOperationsMetrics> {
    return calculateWebhookOperationsMetrics(
      [...this.webhookJobs.values()].filter((job) => job.projectId === projectId && job.createdAt >= since),
    );
  }

  async saveTrustHealthSample(sample: TrustHealthSampleRecord): Promise<TrustHealthSampleRecord> {
    const duplicate = [...this.trustHealthSamples.values()].find(
      (item) => item.projectId === sample.projectId && item.externalId === sample.externalId,
    );
    if (duplicate) return duplicate;
    this.trustHealthSamples.set(sample.id, sample);
    return sample;
  }

  async listTrustHealthSamples(projectId: string, since: string, limit = 100): Promise<TrustHealthSampleRecord[]> {
    return newest(
      [...this.trustHealthSamples.values()].filter((item) => item.projectId === projectId && item.completedAt >= since),
      "completedAt",
    ).slice(0, limit);
  }

  async trustHealthCounts(projectId: string, since: string): Promise<{ total: number; passed: number; failed: number }> {
    const samples = [...this.trustHealthSamples.values()].filter((item) => item.projectId === projectId && item.completedAt >= since && item.source === "production_smoke");
    return { total: samples.length, passed: samples.filter((item) => item.status === "passed").length, failed: samples.filter((item) => item.status === "failed").length };
  }

  async saveNotificationDestination(destination: NotificationDestinationRecord): Promise<NotificationDestinationRecord> {
    const existing = [...this.notificationDestinations.values()].find((item) => item.projectId === destination.projectId && item.email === destination.email);
    const next = existing ? { ...destination, id: existing.id, createdAt: existing.createdAt } : destination;
    this.notificationDestinations.set(next.id, next);
    return next;
  }

  async verifyNotificationDestination(tokenHash: string, now: string): Promise<NotificationVerificationStoreResult> {
    const destination = [...this.notificationDestinations.values()].find((item) => item.verificationTokenHash === tokenHash);
    if (!destination || destination.status === "disabled") return { outcome: "invalid" };
    if (destination.status === "active") return { outcome: "already_verified", destination };
    if (!destination.verificationExpiresAt || destination.verificationExpiresAt < now) return { outcome: "expired" };
    const verified = { ...destination, status: "active" as const, verifiedAt: now };
    this.notificationDestinations.set(destination.id, verified);
    return { outcome: "verified", destination: verified };
  }

  async listNotificationDestinations(projectId: string): Promise<NotificationDestinationRecord[]> {
    return newest([...this.notificationDestinations.values()].filter((item) => item.projectId === projectId), "createdAt");
  }

  async disableNotificationDestination(projectId: string, destinationId: string, disabledAt: string): Promise<NotificationDestinationRecord | undefined> {
    const destination = this.notificationDestinations.get(destinationId);
    if (!destination || destination.projectId !== projectId) return undefined;
    const disabled = { ...destination, status: "disabled" as const, disabledAt };
    this.notificationDestinations.set(destinationId, disabled);
    return disabled;
  }

  async insertNotificationDelivery(delivery: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord> {
    this.notificationDeliveries.set(delivery.id, delivery);
    return delivery;
  }

  async listNotificationDeliveries(projectId: string, limit = 100): Promise<NotificationDeliveryRecord[]> {
    return newest([...this.notificationDeliveries.values()].filter((item) => item.projectId === projectId), "attemptedAt").slice(0, limit);
  }

  async enqueueNotificationJob(job: NotificationJobRecord): Promise<NotificationJobRecord> {
    this.notificationJobs.set(job.id, job);
    return job;
  }

  async claimNotificationJobs(workerId: string, now: string, leaseExpiredBefore: string, limit = 20): Promise<NotificationJobRecord[]> {
    const due = [...this.notificationJobs.values()]
      .filter((job) => (job.status === "pending" || job.status === "retrying" || (job.status === "processing" && Boolean(job.lockedAt) && job.lockedAt! <= leaseExpiredBefore)) && job.nextAttemptAt <= now)
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, limit);
    return due.map((job) => {
      const claimed = { ...job, status: "processing" as const, lockedAt: now, lockedBy: workerId };
      this.notificationJobs.set(job.id, claimed);
      return claimed;
    });
  }

  async updateNotificationJob(job: NotificationJobRecord): Promise<NotificationJobRecord> {
    this.notificationJobs.set(job.id, job);
    return job;
  }

  async getNotificationJob(projectId: string, jobId: string): Promise<NotificationJobRecord | undefined> {
    const job = this.notificationJobs.get(jobId);
    return job?.projectId === projectId ? job : undefined;
  }

  async listNotificationJobs(projectId: string, limit = 100): Promise<NotificationJobRecord[]> {
    return newest([...this.notificationJobs.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async notificationJobCounts(projectId: string): Promise<NotificationJobCounts> {
    const counts = emptyNotificationJobCounts();
    for (const job of this.notificationJobs.values()) if (job.projectId === projectId) counts[job.status] += 1;
    return counts;
  }

  async activateSigningKey(key: SigningKeyRecord): Promise<SigningKeyRecord> {
    const existing = this.signingKeys.get(key.keyId);
    if (existing && existing.publicKeyPem !== key.publicKeyPem) throw new Error(`Signing key ID ${key.keyId} already belongs to another public key.`);
    if (existing?.status === "active") return existing;
    if (existing) throw new Error(`Signing key ID ${key.keyId} is historical and cannot be reactivated.`);
    for (const [id, current] of this.signingKeys) {
      if (id !== key.keyId && current.status === "active") this.signingKeys.set(id, { ...current, status: "retired", retiredAt: key.activatedAt });
    }
    const active = { ...key, status: "active" as const, retiredAt: undefined, revokedAt: undefined };
    this.signingKeys.set(key.keyId, active);
    return active;
  }

  async getSigningKey(keyId: string): Promise<SigningKeyRecord | undefined> { return this.signingKeys.get(keyId); }
  async listSigningKeys(): Promise<SigningKeyRecord[]> { return newest([...this.signingKeys.values()], "activatedAt"); }

  async insertApiKey(apiKey: ApiKeyRecord): Promise<ApiKeyRecord> {
    this.apiKeys.set(apiKey.id, apiKey);
    return apiKey;
  }

  async findApiKeyByHash(secretHash: string): Promise<ApiKeyRecord | undefined> {
    return [...this.apiKeys.values()].find((item) => item.secretHash === secretHash && !item.revokedAt);
  }

  async touchApiKey(apiKeyId: string, usedAt: string): Promise<void> {
    const item = this.apiKeys.get(apiKeyId);
    if (item) this.apiKeys.set(apiKeyId, { ...item, lastUsedAt: usedAt });
  }

  async listApiKeys(projectId: string): Promise<ApiKeyRecord[]> {
    return newest([...this.apiKeys.values()].filter((item) => item.projectId === projectId), "createdAt");
  }

  async revokeApiKey(projectId: string, apiKeyId: string, revokedAt: string): Promise<ApiKeyRecord | undefined> {
    const item = this.apiKeys.get(apiKeyId);
    if (!item || item.projectId !== projectId) return undefined;
    const revoked = { ...item, revokedAt };
    this.apiKeys.set(apiKeyId, revoked);
    return revoked;
  }

  async activateCollectorSourceKey(key: CollectorSourceKeyRecord): Promise<CollectorSourceKeyRecord> {
    const mapKey = `${key.projectId}:${key.keyId}`;
    const existing = this.collectorSourceKeys.get(mapKey);
    if (existing) {
      if (existing.publicKeyPem !== key.publicKeyPem || existing.collectorId !== key.collectorId) throw new TrustedCollectorConflictError("key_conflict");
      return existing;
    }
    const active = [...this.collectorSourceKeys.values()].find((item) => item.projectId === key.projectId && item.collectorId === key.collectorId && item.status === "active");
    if (active) {
      if (key.previousKeyId !== active.keyId) throw new TrustedCollectorConflictError("key_conflict");
      this.collectorSourceKeys.set(`${active.projectId}:${active.keyId}`, { ...active, status: "retired", retiredAt: key.activatedAt });
    } else if (key.previousKeyId) {
      throw new TrustedCollectorConflictError("key_conflict");
    }
    this.collectorSourceKeys.set(mapKey, key);
    return key;
  }

  async getCollectorSourceKey(projectId: string, keyId: string): Promise<CollectorSourceKeyRecord | undefined> {
    return this.collectorSourceKeys.get(`${projectId}:${keyId}`);
  }

  async listCollectorSourceKeys(projectId: string): Promise<CollectorSourceKeyRecord[]> {
    return newest([...this.collectorSourceKeys.values()].filter((item) => item.projectId === projectId), "activatedAt");
  }

  async revokeCollectorSourceKey(projectId: string, keyId: string, revokedAt: string): Promise<CollectorSourceKeyRecord | undefined> {
    const mapKey = `${projectId}:${keyId}`;
    const key = this.collectorSourceKeys.get(mapKey);
    if (!key) return undefined;
    const revoked = { ...key, status: "revoked" as const, revokedAt };
    this.collectorSourceKeys.set(mapKey, revoked);
    return revoked;
  }

  async appendTrustedCollectorRecords(
    projectId: string,
    runId: string,
    collectorId: string,
    sourceKeyId: string,
    records: TrustedSourceRecord[],
    receivedAt: string,
  ): Promise<TrustedCollectorAppendResult> {
    const runKey = `${projectId}:${runId}`;
    let run = this.trustedCollectorRuns.get(runKey);
    const originalRun = run ? structuredClone(run) : undefined;
    let accepted = 0;
    let replayed = 0;
    const alerts: TrustedCollectorAlertRecord[] = [];
    const insertedRecordKeys: string[] = [];
    const insertedAlertIds: string[] = [];
    try { for (const record of records) {
      if (run && (run.collectorId !== collectorId || run.sourceKeyId !== sourceKeyId)) throw new TrustedCollectorConflictError("run_conflict");
      const recordKey = `${projectId}:${runId}:${record.sequence}`;
      const existing = this.trustedCollectorRecords.get(recordKey);
      if (existing) {
        if (existing.eventHash !== record.eventHash || existing.recordId !== record.recordId) throw new TrustedCollectorConflictError("sequence_conflict");
        replayed += 1;
        continue;
      }
      if (!run && (record.sequence !== 0 || record.type !== "RUN_STARTED")) throw new TrustedCollectorConflictError("invalid_start");
      if (run && (run.status === "completed" || run.status === "reconciled")) throw new TrustedCollectorConflictError("run_closed");
      if (run && record.type === "RUN_STARTED") throw new TrustedCollectorConflictError("invalid_start");
      const expectedSequence = run ? run.lastSequence + 1 : 0;
      const gap = record.sequence - expectedSequence;
      const declaredDrop = gap > 0 && record.type === "EVENTS_DROPPED" && positiveInteger(record.payload.count) === gap;
      if (gap < 0) throw new TrustedCollectorConflictError("sequence_conflict");
      if (gap > 0 && !declaredDrop) throw new TrustedCollectorConflictError("undeclared_gap");
      if ((!run && record.previousEventHash !== undefined) || (run && record.previousEventHash !== run.lastEventHash)) {
        throw new TrustedCollectorConflictError("chain_conflict");
      }
      const stored: TrustedCollectorRecord = {
        projectId, runId, sequence: record.sequence, recordId: record.recordId, eventHash: record.eventHash,
        previousEventHash: record.previousEventHash, sourceKeyId, record, receivedAt,
      };
      this.trustedCollectorRecords.set(recordKey, stored);
      insertedRecordKeys.push(recordKey);
      accepted += 1;
      if (!run) {
        run = {
          projectId, runId, collectorId, sourceKeyId, status: "open", firstSequence: record.sequence,
          lastSequence: record.sequence, firstEventHash: record.eventHash, lastEventHash: record.eventHash,
          acceptedEventCount: 1, droppedEventCount: 0, startedAt: record.occurredAt,
          createdAt: receivedAt, updatedAt: receivedAt,
        };
      } else {
        run = {
          ...run, lastSequence: record.sequence, lastEventHash: record.eventHash,
          acceptedEventCount: run.acceptedEventCount + 1, updatedAt: receivedAt,
        };
      }
      if (declaredDrop) {
        run = { ...run, status: "degraded", droppedEventCount: run.droppedEventCount + gap };
        const alert = collectorAlert(projectId, collectorId, runId, "events_dropped", "critical", `${gap} collector event(s) were declared dropped.`, { gap, sequence: record.sequence }, receivedAt);
        this.trustedCollectorAlerts.set(alert.id, alert);
        insertedAlertIds.push(alert.id);
        alerts.push(alert);
      }
      if (record.type === "RUN_COMPLETED") run = { ...run, status: run.droppedEventCount ? "degraded" : "completed", completedAt: record.occurredAt };
      this.trustedCollectorRuns.set(runKey, run);
    }} catch (error) {
      for (const key of insertedRecordKeys) this.trustedCollectorRecords.delete(key);
      for (const id of insertedAlertIds) this.trustedCollectorAlerts.delete(id);
      if (originalRun) this.trustedCollectorRuns.set(runKey, originalRun);
      else this.trustedCollectorRuns.delete(runKey);
      throw error;
    }
    if (!run) throw new TrustedCollectorConflictError("run_conflict");
    return { run, accepted, replayed, ack: { sequence: run.lastSequence, eventHash: run.lastEventHash }, alerts };
  }

  async getTrustedCollectorRun(projectId: string, runId: string): Promise<TrustedCollectorRunRecord | undefined> {
    return this.trustedCollectorRuns.get(`${projectId}:${runId}`);
  }

  async listTrustedCollectorRuns(projectId: string, limit = 100): Promise<TrustedCollectorRunRecord[]> {
    return newest([...this.trustedCollectorRuns.values()].filter((item) => item.projectId === projectId), "updatedAt").slice(0, limit);
  }

  async saveTrustedCollectorReconciliation(projectId: string, runId: string, sourceReceipt: Record<string, unknown>, reconciliation: Record<string, unknown>, serverAttestation: Record<string, unknown>, updatedAt: string): Promise<TrustedCollectorRunRecord> {
    const key = `${projectId}:${runId}`;
    const run = this.trustedCollectorRuns.get(key);
    if (!run) throw new TrustedCollectorConflictError("run_conflict");
    const reconciled = { ...run, status: "reconciled" as const, sourceReceipt, reconciliation, serverAttestation, updatedAt };
    this.trustedCollectorRuns.set(key, reconciled);
    return reconciled;
  }

  async saveCollectorHeartbeat(heartbeat: CollectorHeartbeatRecord): Promise<CollectorHeartbeatRecord> {
    this.collectorHeartbeats.set(`${heartbeat.projectId}:${heartbeat.collectorId}`, heartbeat);
    return heartbeat;
  }

  async listCollectorHeartbeats(projectId: string): Promise<CollectorHeartbeatRecord[]> {
    return newest([...this.collectorHeartbeats.values()].filter((item) => item.projectId === projectId), "receivedAt");
  }

  async listTrustedCollectorAlerts(projectId: string, limit = 100): Promise<TrustedCollectorAlertRecord[]> {
    return newest([...this.trustedCollectorAlerts.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async close(): Promise<void> {}
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
  }

  async migrate(): Promise<void> {
    for (const name of CONTROL_PLANE_MIGRATIONS) {
      const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await this.pool.query(migration);
    }
  }

  async bootstrapUser(userId: string, email?: string): Promise<BootstrapResult> {
    if (email) await this.pool.query("UPDATE agentcert_memberships SET email=$2 WHERE user_id=$1 AND email IS DISTINCT FROM $2", [userId, email]);
    const existing = await this.pool.query(
      `SELECT o.*, m.user_id, m.email AS membership_email, m.role, m.created_at AS membership_created_at, p.id AS project_id,
              p.name AS project_name, p.slug AS project_slug, p.created_at AS project_created_at
       FROM agentcert_memberships m
       JOIN agentcert_organizations o ON o.id = m.organization_id
       JOIN agentcert_projects p ON p.organization_id = o.id
         AND (m.role IN ('owner','admin') OR EXISTS (
           SELECT 1 FROM agentcert_project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=m.user_id
         ))
       WHERE m.user_id = $1 ORDER BY p.created_at ASC LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]) return bootstrapFromRow(existing.rows[0]);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
      const concurrentExisting = await client.query(
        `SELECT o.*, m.user_id, m.email AS membership_email, m.role, m.created_at AS membership_created_at, p.id AS project_id,
                p.name AS project_name, p.slug AS project_slug, p.created_at AS project_created_at
         FROM agentcert_memberships m
         JOIN agentcert_organizations o ON o.id = m.organization_id
         JOIN agentcert_projects p ON p.organization_id = o.id
           AND (m.role IN ('owner','admin') OR EXISTS (
             SELECT 1 FROM agentcert_project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=m.user_id
           ))
         WHERE m.user_id = $1 ORDER BY p.created_at ASC LIMIT 1`,
        [userId],
      );
      if (concurrentExisting.rows[0]) {
        await client.query("COMMIT");
        return bootstrapFromRow(concurrentExisting.rows[0]);
      }
      const now = new Date().toISOString();
      const identity = email?.split("@")[0] || "workspace";
      const organization: Organization = {
        id: randomUUID(),
        name: `${identity} workspace`,
        slug: `${slugify(identity)}-${randomUUID().slice(0, 6)}`,
        createdAt: now,
      };
      const project: Project = {
        id: randomUUID(),
        organizationId: organization.id,
        name: DEFAULT_PROJECT_NAME,
        slug: DEFAULT_PROJECT_SLUG,
        createdAt: now,
      };
      const membership: Membership = { organizationId: organization.id, userId, email, role: "owner", createdAt: now };
      await client.query("INSERT INTO agentcert_organizations (id,name,slug,created_at) VALUES ($1,$2,$3,$4)", [
        organization.id,
        organization.name,
        organization.slug,
        organization.createdAt,
      ]);
      await client.query(
        "INSERT INTO agentcert_memberships (organization_id,user_id,email,role,created_at) VALUES ($1,$2,$3,$4,$5)",
        [organization.id, userId, email ?? null, membership.role, now],
      );
      await client.query(
        "INSERT INTO agentcert_projects (id,organization_id,name,slug,created_at) VALUES ($1,$2,$3,$4,$5)",
        [project.id, organization.id, project.name, project.slug, project.createdAt],
      );
      await client.query("COMMIT");
      return { organization, project, membership };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listProjectsForUser(userId: string): Promise<Project[]> {
    const result = await this.pool.query(
      `SELECT p.* FROM agentcert_projects p JOIN agentcert_memberships m ON m.organization_id=p.organization_id
       WHERE m.user_id=$1 AND (m.role IN ('owner','admin') OR EXISTS (
         SELECT 1 FROM agentcert_project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=m.user_id
       )) ORDER BY p.created_at ASC`,
      [userId],
    );
    return result.rows.map(projectFromRow);
  }

  async insertProject(project: Project): Promise<Project> {
    const result = await this.pool.query(
      "INSERT INTO agentcert_projects (id,organization_id,name,slug,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [project.id, project.organizationId, project.name, project.slug, project.createdAt],
    );
    return projectFromRow(result.rows[0]);
  }

  async getOrganization(organizationId: string): Promise<Organization | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_organizations WHERE id=$1", [organizationId]), organizationFromRow);
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_projects WHERE id=$1", [projectId]), projectFromRow);
  }

  async updateProject(project: Project): Promise<Project> {
    const updated = await one(
      this.pool.query("UPDATE agentcert_projects SET name=$2 WHERE id=$1 RETURNING *", [project.id, project.name]),
      projectFromRow,
    );
    return required(updated, "project");
  }

  async membershipForOrganization(userId: string, organizationId: string): Promise<Membership | undefined> {
    return one(this.pool.query(
      "SELECT organization_id,user_id,email,role,created_at FROM agentcert_memberships WHERE organization_id=$1 AND user_id=$2",
      [organizationId, userId],
    ), membershipFromRow);
  }

  async listTeamMembers(organizationId: string): Promise<TeamMemberRecord[]> {
    const result = await this.pool.query(
      `SELECT m.*, CASE WHEN m.role IN ('owner','admin')
         THEN COALESCE((SELECT jsonb_agg(p.id ORDER BY p.created_at) FROM agentcert_projects p WHERE p.organization_id=m.organization_id),'[]'::jsonb)
         ELSE COALESCE((SELECT jsonb_agg(pm.project_id ORDER BY pm.created_at) FROM agentcert_project_memberships pm
           JOIN agentcert_projects p ON p.id=pm.project_id WHERE pm.user_id=m.user_id AND p.organization_id=m.organization_id),'[]'::jsonb)
       END AS project_ids
       FROM agentcert_memberships m WHERE m.organization_id=$1 ORDER BY m.created_at ASC`,
      [organizationId],
    );
    return result.rows.map(teamMemberFromRow);
  }

  async listTeamInvitations(organizationId: string): Promise<TeamInvitationRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_team_invitations WHERE organization_id=$1 ORDER BY created_at DESC", [organizationId]), teamInvitationFromRow);
  }

  async getTeamInvitationByTokenHash(tokenHash: string): Promise<TeamInvitationRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_team_invitations WHERE token_hash=$1", [tokenHash]), teamInvitationFromRow);
  }

  async saveTeamInvitation(invitation: TeamInvitationRecord): Promise<TeamInvitationRecord> {
    try {
      const result = await this.pool.query(
        `INSERT INTO agentcert_team_invitations
         (id,organization_id,email,role,project_ids,token_hash,status,delivery_status,delivery_error,invited_by,invited_by_email,expires_at,created_at,sent_at,accepted_by,accepted_at,revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        teamInvitationValues(invitation),
      );
      return teamInvitationFromRow(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new TeamStateConflictError("invitation_unavailable");
      throw error;
    }
  }

  async updateTeamInvitation(invitation: TeamInvitationRecord): Promise<TeamInvitationRecord> {
    const result = await this.pool.query(
      `UPDATE agentcert_team_invitations SET status=$2,delivery_status=$3,delivery_error=$4,sent_at=$5,
       accepted_by=$6,accepted_at=$7,revoked_at=$8 WHERE id=$1 RETURNING *`,
      [invitation.id, invitation.status, invitation.deliveryStatus, invitation.deliveryError ?? null, invitation.sentAt ?? null,
        invitation.acceptedBy ?? null, invitation.acceptedAt ?? null, invitation.revokedAt ?? null],
    );
    if (!result.rows[0]) throw new TeamStateConflictError("invitation_unavailable");
    return teamInvitationFromRow(result.rows[0]);
  }

  async acceptTeamInvitation(invitationId: string, membership: Membership, projectIds: string[], audit: TeamAuditRecord): Promise<TeamInvitationRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT * FROM agentcert_team_invitations WHERE id=$1 FOR UPDATE", [invitationId]);
      if (!locked.rows[0] || locked.rows[0].status !== "pending") throw new TeamStateConflictError("invitation_unavailable");
      const member = await client.query("SELECT 1 FROM agentcert_memberships WHERE organization_id=$1 AND user_id=$2", [membership.organizationId, membership.userId]);
      if (member.rows[0]) throw new TeamStateConflictError("member_exists");
      await client.query(
        "INSERT INTO agentcert_memberships (organization_id,user_id,email,role,created_at) VALUES ($1,$2,$3,$4,$5)",
        [membership.organizationId, membership.userId, membership.email ?? null, membership.role, membership.createdAt],
      );
      for (const projectId of projectIds) await client.query(
        "INSERT INTO agentcert_project_memberships (project_id,user_id,granted_by,created_at) VALUES ($1,$2,$3,$4)",
        [projectId, membership.userId, audit.actorId, audit.occurredAt],
      );
      const accepted = await client.query(
        "UPDATE agentcert_team_invitations SET status='accepted',accepted_by=$2,accepted_at=$3 WHERE id=$1 RETURNING *",
        [invitationId, membership.userId, audit.occurredAt],
      );
      await insertTeamAudit(client, audit);
      await client.query("COMMIT");
      return teamInvitationFromRow(accepted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new TeamStateConflictError("member_exists");
      throw error;
    } finally { client.release(); }
  }

  async updateTeamMember(organizationId: string, userId: string, role: MemberRole, projectIds: string[], actorId: string, audit: TeamAuditRecord): Promise<TeamMemberRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`team:${organizationId}`]);
      const current = await client.query("SELECT * FROM agentcert_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE", [organizationId, userId]);
      if (!current.rows[0]) throw new TeamStateConflictError("member_exists");
      if (current.rows[0].role === "owner" && role !== "owner") await assertNotLastOwner(client, organizationId);
      await client.query("UPDATE agentcert_memberships SET role=$3 WHERE organization_id=$1 AND user_id=$2", [organizationId, userId, role]);
      await client.query(`DELETE FROM agentcert_project_memberships pm USING agentcert_projects p
        WHERE pm.project_id=p.id AND p.organization_id=$1 AND pm.user_id=$2`, [organizationId, userId]);
      if (role === "operator" || role === "viewer") for (const projectId of projectIds) await client.query(
        "INSERT INTO agentcert_project_memberships (project_id,user_id,granted_by,created_at) VALUES ($1,$2,$3,$4)",
        [projectId, userId, actorId, audit.occurredAt],
      );
      await insertTeamAudit(client, audit);
      await client.query("COMMIT");
      const members = await this.listTeamMembers(organizationId);
      return required(members.find((item) => item.userId === userId), "team member");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async removeTeamMember(organizationId: string, userId: string, audit: TeamAuditRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`team:${organizationId}`]);
      const current = await client.query("SELECT * FROM agentcert_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE", [organizationId, userId]);
      if (!current.rows[0]) throw new TeamStateConflictError("member_exists");
      if (current.rows[0].role === "owner") await assertNotLastOwner(client, organizationId);
      await client.query(`DELETE FROM agentcert_project_memberships pm USING agentcert_projects p
        WHERE pm.project_id=p.id AND p.organization_id=$1 AND pm.user_id=$2`, [organizationId, userId]);
      await client.query("DELETE FROM agentcert_memberships WHERE organization_id=$1 AND user_id=$2", [organizationId, userId]);
      await insertTeamAudit(client, audit);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async appendTeamAudit(record: TeamAuditRecord): Promise<TeamAuditRecord> {
    await insertTeamAudit(this.pool, record);
    return record;
  }

  async listTeamAudit(organizationId: string, limit = 100): Promise<TeamAuditRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_team_audit WHERE organization_id=$1 ORDER BY occurred_at DESC LIMIT $2", [organizationId, limit]), teamAuditFromRow);
  }

  async insertPilotFeedback(feedback: PilotFeedbackRecord): Promise<PilotFeedbackRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_pilot_feedback
       (id,project_id,user_id,stage,category,outcome,reason_code,message,context,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [feedback.id, feedback.projectId, feedback.userId, feedback.stage, feedback.category, feedback.outcome,
        feedback.reasonCode, feedback.message ?? null, JSON.stringify(feedback.context), feedback.createdAt],
    );
    return pilotFeedbackFromRow(result.rows[0]);
  }

  async listPilotFeedback(projectId: string, limit = 100): Promise<PilotFeedbackRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_pilot_feedback WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]),
      pilotFeedbackFromRow,
    );
  }

  async pilotFunnelSource(since: string): Promise<PilotFunnelSource> {
    const result = await this.pool.query(
      `SELECT p.*,
              key_milestone.first_key_at,
              connection_milestone.first_connection_at,
              evidence_milestone.first_evidence_at,
              current_milestone.first_current_at
       FROM agentcert_projects p
       LEFT JOIN LATERAL (
         SELECT MIN(created_at) AS first_key_at FROM agentcert_api_keys WHERE project_id=p.id
       ) key_milestone ON true
       LEFT JOIN LATERAL (
         SELECT MIN(last_used_at) AS first_connection_at FROM agentcert_api_keys
         WHERE project_id=p.id AND last_used_at IS NOT NULL
       ) connection_milestone ON true
       LEFT JOIN LATERAL (
         SELECT MIN(created_at) AS first_evidence_at FROM agentcert_evidence
         WHERE project_id=p.id AND connection_milestone.first_connection_at IS NOT NULL
           AND created_at >= connection_milestone.first_connection_at
       ) evidence_milestone ON true
       LEFT JOIN LATERAL (
         SELECT MIN(NULLIF(COALESCE(
           continuous_assurance->>'firstCurrentAt',
           continuous_assurance->>'currentSince',
           continuous_assurance->>'validatedAt'
         ), '')::timestamptz) AS first_current_at
         FROM agentcert_assurance_cases
         WHERE project_id=p.id AND continuous_assurance IS NOT NULL
       ) current_milestone ON true
       WHERE p.created_at >= $1 ORDER BY p.created_at DESC`,
      [since],
    );
    const projects = result.rows.map((row) => ({
      project: projectFromRow(row), firstKeyAt: optionalIso(row.first_key_at),
      firstConnectionAt: optionalIso(row.first_connection_at), firstEvidenceAt: optionalIso(row.first_evidence_at),
      firstCurrentAt: optionalIso(row.first_current_at),
    }));
    const projectIds = projects.map((item) => item.project.id);
    if (projectIds.length === 0) return { projects: [], feedback: [] };
    const feedback = await many(
      this.pool.query("SELECT * FROM agentcert_pilot_feedback WHERE project_id = ANY($1::uuid[]) ORDER BY created_at DESC", [projectIds]),
      pilotFeedbackFromRow,
    );
    return { projects, feedback };
  }

  async insertAssuranceCase(record: AssuranceCaseRecord): Promise<AssuranceCaseRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_assurance_cases
       (id,project_id,name,subject,status,policy_pack_version,evaluation_plan,evaluation_plan_sha256,evidence_ids,created_by,reviewer_id,report,public_verification_id,expires_at,created_at,updated_at,engagement,delivery_packet,continuous_assurance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      assuranceCaseValues(record),
    );
    return assuranceCaseFromRow(result.rows[0]);
  }

  async insertAssuranceCaseWithDecision(record: AssuranceCaseRecord, decision: AssuranceCaseDecisionRecord): Promise<AssuranceCaseRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO agentcert_assurance_cases
         (id,project_id,name,subject,status,policy_pack_version,evaluation_plan,evaluation_plan_sha256,evidence_ids,created_by,reviewer_id,report,public_verification_id,expires_at,created_at,updated_at,engagement,delivery_packet,continuous_assurance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`, assuranceCaseValues(record));
      await client.query(
        `INSERT INTO agentcert_assurance_case_decisions
         (id,project_id,assurance_case_id,from_status,to_status,actor_id,actor_email,reason,evidence_ids,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, assuranceDecisionValues(decision));
      await client.query("COMMIT");
      return assuranceCaseFromRow(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async updateAssuranceCase(record: AssuranceCaseRecord, expectedStatus: AssuranceCaseRecord["status"], expectedUpdatedAt?: string): Promise<AssuranceCaseRecord | undefined> {
    return one(this.pool.query(
      `UPDATE agentcert_assurance_cases SET name=$3,subject=$4,status=$5,policy_pack_version=$6,evaluation_plan=$7,
       evaluation_plan_sha256=$8,evidence_ids=$9,reviewer_id=$10,report=$11,public_verification_id=$12,expires_at=$13,updated_at=$14,
        engagement=$15,delivery_packet=$16,continuous_assurance=$17 WHERE project_id=$1 AND id=$2 AND status=$18
        AND ($19::timestamptz IS NULL OR updated_at=$19) RETURNING *`,
      [record.projectId, record.id, record.name, JSON.stringify(record.subject), record.status, record.policyPackVersion,
        JSON.stringify(record.evaluationPlan), record.evaluationPlanSha256, JSON.stringify(record.evidenceIds), record.reviewerId ?? null,
        jsonOrNull(record.report), record.publicVerificationId ?? null, record.expiresAt ?? null, record.updatedAt,
         jsonOrNull(record.engagement), jsonOrNull(record.deliveryPacket), jsonOrNull(record.continuousAssurance), expectedStatus, expectedUpdatedAt ?? null],
    ), assuranceCaseFromRow);
  }

  async transitionAssuranceCase(record: AssuranceCaseRecord, decision: AssuranceCaseDecisionRecord, expectedStatus: AssuranceCaseRecord["status"]): Promise<AssuranceCaseRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE agentcert_assurance_cases SET name=$3,subject=$4,status=$5,policy_pack_version=$6,evaluation_plan=$7,
         evaluation_plan_sha256=$8,evidence_ids=$9,reviewer_id=$10,report=$11,public_verification_id=$12,expires_at=$13,updated_at=$14,
          engagement=$15,delivery_packet=$16,continuous_assurance=$17 WHERE project_id=$1 AND id=$2 AND status=$18 RETURNING *`,
        [record.projectId, record.id, record.name, JSON.stringify(record.subject), record.status, record.policyPackVersion,
          JSON.stringify(record.evaluationPlan), record.evaluationPlanSha256, JSON.stringify(record.evidenceIds), record.reviewerId ?? null,
          jsonOrNull(record.report), record.publicVerificationId ?? null, record.expiresAt ?? null, record.updatedAt,
           jsonOrNull(record.engagement), jsonOrNull(record.deliveryPacket), jsonOrNull(record.continuousAssurance), expectedStatus]);
      if (!result.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      await client.query(
        `INSERT INTO agentcert_assurance_case_decisions
         (id,project_id,assurance_case_id,from_status,to_status,actor_id,actor_email,reason,evidence_ids,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, assuranceDecisionValues(decision));
      await client.query("COMMIT");
      return assuranceCaseFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async getAssuranceCase(projectId: string, caseId: string): Promise<AssuranceCaseRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_assurance_cases WHERE project_id=$1 AND id=$2", [projectId, caseId]), assuranceCaseFromRow);
  }

  async getAssuranceCaseByPublicId(publicId: string): Promise<AssuranceCaseRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_assurance_cases WHERE public_verification_id=$1", [publicId]), assuranceCaseFromRow);
  }

  async listAssuranceCases(projectId: string, limit = 100): Promise<AssuranceCaseRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_assurance_cases WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]), assuranceCaseFromRow);
  }

  async listAssuranceCasesForMaintenance(now: string, before: string, limit = 200): Promise<AssuranceCaseRecord[]> {
    return many(this.pool.query(
      `SELECT * FROM agentcert_assurance_cases
       WHERE status='issued' AND continuous_assurance IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= $1
         AND (
           expires_at <= $2
           OR (
             continuous_assurance #>> '{freshness,status}' = 'CURRENT'
             AND CASE
               WHEN expires_at <= $2::timestamptz + interval '1 day'
                 THEN NOT (COALESCE(continuous_assurance #> '{reminders,expiryThresholdDaysSent}', '[]'::jsonb) @> '[1]'::jsonb)
               WHEN expires_at <= $2::timestamptz + interval '7 days'
                 THEN NOT (COALESCE(continuous_assurance #> '{reminders,expiryThresholdDaysSent}', '[]'::jsonb) @> '[7]'::jsonb)
               ELSE NOT (COALESCE(continuous_assurance #> '{reminders,expiryThresholdDaysSent}', '[]'::jsonb) @> '[30]'::jsonb)
             END
           )
         )
       ORDER BY expires_at ASC LIMIT $3`,
      [before, now, limit],
    ), assuranceCaseFromRow);
  }

  async insertAssuranceCaseDecision(record: AssuranceCaseDecisionRecord): Promise<AssuranceCaseDecisionRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_assurance_case_decisions
       (id,project_id,assurance_case_id,from_status,to_status,actor_id,actor_email,reason,evidence_ids,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [record.id, record.projectId, record.assuranceCaseId, record.fromStatus ?? null, record.toStatus, record.actorId,
        record.actorEmail ?? null, record.reason, JSON.stringify(record.evidenceIds), record.occurredAt],
    );
    return assuranceCaseDecisionFromRow(result.rows[0]);
  }

  async listAssuranceCaseDecisions(projectId: string, caseId: string): Promise<AssuranceCaseDecisionRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_assurance_case_decisions WHERE project_id=$1 AND assurance_case_id=$2 ORDER BY occurred_at ASC",
      [projectId, caseId],
    ), assuranceCaseDecisionFromRow);
  }

  async roleForProject(userId: string, projectId: string): Promise<MemberRole | undefined> {
    const result = await this.pool.query(
      `SELECT m.role FROM agentcert_memberships m JOIN agentcert_projects p ON p.organization_id=m.organization_id
       WHERE m.user_id=$1 AND p.id=$2 AND (m.role IN ('owner','admin') OR EXISTS (
         SELECT 1 FROM agentcert_project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=m.user_id
       ))`,
      [userId, projectId],
    );
    return result.rows[0]?.role as MemberRole | undefined;
  }

  async upsertAgent(agent: AgentRecord): Promise<AgentRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_agents (id,project_id,external_id,name,version,framework,allowed_permissions,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id,external_id) DO UPDATE SET name=excluded.name,version=excluded.version,
       framework=excluded.framework,allowed_permissions=excluded.allowed_permissions,updated_at=excluded.updated_at RETURNING *`,
      [agent.id, agent.projectId, agent.externalId, agent.name, agent.version, agent.framework ?? null, JSON.stringify(agent.allowedPermissions), agent.createdAt, agent.updatedAt],
    );
    return agentFromRow(result.rows[0]);
  }

  async getAgent(projectId: string, agentId: string): Promise<AgentRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_agents WHERE project_id=$1 AND id=$2", [projectId, agentId]), agentFromRow);
  }

  async listAgents(projectId: string): Promise<AgentRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_agents WHERE project_id=$1 ORDER BY updated_at DESC", [projectId]), agentFromRow);
  }

  async upsertRun(run: RunRecord): Promise<RunRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_runs (id,project_id,agent_id,external_id,kind,status,score,schema_version,started_at,completed_at,metadata,trace_id,root_span_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (project_id,external_id) DO UPDATE SET status=excluded.status,score=excluded.score,
       completed_at=excluded.completed_at,metadata=excluded.metadata,trace_id=COALESCE(agentcert_runs.trace_id,excluded.trace_id),
       root_span_id=COALESCE(agentcert_runs.root_span_id,excluded.root_span_id) RETURNING *`,
      [run.id, run.projectId, run.agentId ?? null, run.externalId, run.kind, run.status, run.score ?? null, run.schemaVersion, run.startedAt, run.completedAt ?? null, JSON.stringify(run.metadata), run.traceId ?? null, run.rootSpanId ?? null],
    );
    return runFromRow(result.rows[0]);
  }

  async getRun(projectId: string, runId: string): Promise<RunRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_runs WHERE project_id=$1 AND id=$2", [projectId, runId]), runFromRow);
  }

  async listRuns(projectId: string, limit = 100): Promise<RunRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_runs WHERE project_id=$1 ORDER BY started_at DESC LIMIT $2", [projectId, limit]), runFromRow);
  }

  async appendEvents(events: EventRecord[]): Promise<EventRecord[]> {
    if (events.length === 0) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await client.query(
          `INSERT INTO agentcert_events (id,project_id,run_id,sequence,type,actor,occurred_at,payload,trace_id,span_id,parent_span_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (run_id,sequence) DO UPDATE SET
           type=excluded.type,actor=excluded.actor,occurred_at=excluded.occurred_at,payload=excluded.payload,
           trace_id=excluded.trace_id,span_id=excluded.span_id,parent_span_id=excluded.parent_span_id`,
          [event.id, event.projectId, event.runId, event.sequence, event.type, event.actor, event.occurredAt, JSON.stringify(event.payload), event.traceId ?? null, event.spanId ?? null, event.parentSpanId ?? null],
        );
      }
      await client.query("COMMIT");
      return events;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(projectId: string, runId: string): Promise<EventRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_events WHERE project_id=$1 AND run_id=$2 ORDER BY sequence", [projectId, runId]), eventFromRow);
  }

  async insertAction(action: ActionRecord): Promise<ActionRecord> {
    const existing = await this.pool.query("SELECT * FROM agentcert_actions WHERE project_id=$1 AND external_id=$2", [action.projectId, action.externalId]);
    if (existing.rows[0]) return actionFromRow(existing.rows[0]);
    await this.writeAction(action, false);
    return action;
  }

  async updateAction(action: ActionRecord): Promise<ActionRecord> {
    await this.writeAction(action, true);
    return action;
  }

  private async writeAction(action: ActionRecord, update: boolean): Promise<void> {
    if (update) {
      await this.pool.query(
        `UPDATE agentcert_actions SET decision=$2,status=$3,reasons=$4,observed_state=$5,
       verification_success=$6,updated_at=$7,assurance_context=$8 WHERE id=$1`,
        [action.id, action.decision, action.status, JSON.stringify(action.reasons), jsonOrNull(action.observedState), action.verificationSuccess ?? null, action.updatedAt, JSON.stringify(action.assuranceContext ?? {})],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO agentcert_actions (id,project_id,agent_id,external_id,principal,action_type,target_system,requested_permissions,
       amount,currency,risk_level,risk_score,decision,status,policy_version,reasons,expected_state,observed_state,verification_success,created_at,updated_at,trace_id,span_id,parent_span_id,assurance_context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [action.id, action.projectId, action.agentId ?? null, action.externalId, JSON.stringify(action.principal), action.actionType, action.targetSystem,
       JSON.stringify(action.requestedPermissions), action.amount ?? null, action.currency ?? null, action.riskLevel, action.riskScore, action.decision,
       action.status, action.policyVersion, JSON.stringify(action.reasons), jsonOrNull(action.expectedState), jsonOrNull(action.observedState),
       action.verificationSuccess ?? null, action.createdAt, action.updatedAt, action.traceId ?? null, action.spanId ?? null, action.parentSpanId ?? null,
       JSON.stringify(action.assuranceContext ?? {})],
    );
  }

  async getAction(projectId: string, actionId: string): Promise<ActionRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_actions WHERE project_id=$1 AND id=$2", [projectId, actionId]), actionFromRow);
  }

  async listActions(projectId: string, limit = 100): Promise<ActionRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_actions WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]), actionFromRow);
  }

  async insertApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    await this.pool.query(
      "INSERT INTO agentcert_approvals (id,project_id,action_id,reviewer_id,decision,comment,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [approval.id, approval.projectId, approval.actionId, approval.reviewerId, approval.decision, approval.comment ?? null, approval.createdAt],
    );
    return approval;
  }

  async insertEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_evidence (id,project_id,run_id,action_id,kind,schema_version,object_key,file_name,content_type,sha256,size_bytes,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT DO NOTHING RETURNING *`,
      [evidence.id, evidence.projectId, evidence.runId ?? null, evidence.actionId ?? null, evidence.kind, evidence.schemaVersion,
       evidence.objectKey, evidence.fileName, evidence.contentType, evidence.sha256, evidence.sizeBytes, JSON.stringify(evidence.metadata), evidence.createdAt],
    );
    if (result.rows[0]) return evidenceFromRow(result.rows[0]);
    return required(
      await this.findEvidenceByDigest(evidence.projectId, evidence.runId, evidence.actionId, evidence.kind, evidence.sha256, evidenceSourcePath(evidence)),
      "evidence",
    );
  }

  async insertEvidenceWithinQuota(evidence: EvidenceRecord, projectLimitBytes: number, runLimitBytes: number): Promise<EvidenceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [evidence.projectId]);
      const existing = await client.query(
        `SELECT * FROM agentcert_evidence WHERE project_id=$1 AND run_id IS NOT DISTINCT FROM $2
         AND action_id IS NOT DISTINCT FROM $3 AND kind=$4 AND sha256=$5
         AND COALESCE(metadata->>'sourcePath','')=COALESCE($6,'') ORDER BY created_at LIMIT 1`,
        [evidence.projectId, evidence.runId ?? null, evidence.actionId ?? null, evidence.kind, evidence.sha256, evidenceSourcePath(evidence) ?? null],
      );
      if (existing.rows[0] && (evidence.runId || evidence.actionId)) {
        await client.query("COMMIT");
        return evidenceFromRow(existing.rows[0]);
      }
      const projectUsage = await client.query(
        "SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM agentcert_evidence WHERE project_id=$1",
        [evidence.projectId],
      );
      const projectBytes = Number(projectUsage.rows[0]?.bytes ?? 0);
      if (projectBytes + evidence.sizeBytes > projectLimitBytes) {
        throw new EvidenceQuotaExceededError("project", projectLimitBytes, projectBytes, evidence.sizeBytes);
      }
      if (evidence.runId) {
        const runUsage = await client.query(
          "SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM agentcert_evidence WHERE project_id=$1 AND run_id=$2",
          [evidence.projectId, evidence.runId],
        );
        const runBytes = Number(runUsage.rows[0]?.bytes ?? 0);
        if (runBytes + evidence.sizeBytes > runLimitBytes) {
          throw new EvidenceQuotaExceededError("run", runLimitBytes, runBytes, evidence.sizeBytes);
        }
      }
      const inserted = await client.query(
        `INSERT INTO agentcert_evidence (id,project_id,run_id,action_id,kind,schema_version,object_key,file_name,content_type,sha256,size_bytes,metadata,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [evidence.id, evidence.projectId, evidence.runId ?? null, evidence.actionId ?? null, evidence.kind, evidence.schemaVersion,
         evidence.objectKey, evidence.fileName, evidence.contentType, evidence.sha256, evidence.sizeBytes, JSON.stringify(evidence.metadata), evidence.createdAt],
      );
      await client.query("COMMIT");
      return evidenceFromRow(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRunByExternalId(projectId: string, externalId: string): Promise<RunRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_runs WHERE project_id=$1 AND external_id=$2", [projectId, externalId]), runFromRow);
  }

  async findEvidenceByDigest(projectId: string, runId: string | undefined, actionId: string | undefined, kind: string, sha256: string, sourcePath?: string): Promise<EvidenceRecord | undefined> {
    return one(
      this.pool.query(
        `SELECT * FROM agentcert_evidence WHERE project_id=$1 AND run_id IS NOT DISTINCT FROM $2
         AND action_id IS NOT DISTINCT FROM $3 AND kind=$4 AND sha256=$5
         AND COALESCE(metadata->>'sourcePath','')=COALESCE($6,'') ORDER BY created_at LIMIT 1`,
        [projectId, runId ?? null, actionId ?? null, kind, sha256, sourcePath ?? null],
      ),
      evidenceFromRow,
    );
  }

  async getEvidence(projectId: string, evidenceId: string): Promise<EvidenceRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_evidence WHERE project_id=$1 AND id=$2", [projectId, evidenceId]), evidenceFromRow);
  }

  async listEvidence(projectId: string, limit = 100): Promise<EvidenceRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_evidence WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]), evidenceFromRow);
  }

  async listEvidenceForRun(projectId: string, runId: string): Promise<EvidenceRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_evidence WHERE project_id=$1 AND run_id=$2 ORDER BY created_at DESC", [projectId, runId]),
      evidenceFromRow,
    );
  }

  async evidenceUsage(projectId: string, runId?: string): Promise<EvidenceStorageUsage> {
    const result = runId
      ? await this.pool.query(
        "SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM agentcert_evidence WHERE project_id=$1 AND run_id=$2",
        [projectId, runId],
      )
      : await this.pool.query(
        "SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM agentcert_evidence WHERE project_id=$1",
        [projectId],
      );
    return { count: Number(result.rows[0]?.count ?? 0), bytes: Number(result.rows[0]?.bytes ?? 0) };
  }

  async listEvidenceCreatedBefore(before: string, limit = 500): Promise<EvidenceRecord[]> {
    return many(
      this.pool.query(
        `SELECT e.* FROM agentcert_evidence e
         WHERE e.created_at < $1
           AND NOT EXISTS (
             SELECT 1 FROM agentcert_legal_hold_requests h
             WHERE h.project_id=e.project_id AND h.status='approved'
           )
         ORDER BY e.created_at ASC LIMIT $2`,
        [before, limit],
      ),
      evidenceFromRow,
    );
  }

  async deleteEvidence(projectId: string, evidenceId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM agentcert_evidence WHERE project_id=$1 AND id=$2", [projectId, evidenceId]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteEvidenceUnlessHeld(
    projectId: string,
    evidenceId: string,
    deleteObject: () => Promise<void>,
  ): Promise<"deleted" | "held" | "missing"> {
    const client = await this.pool.connect();
    const lockKey = retentionLockKey(projectId);
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      const hold = await client.query(
        "SELECT 1 FROM agentcert_legal_hold_requests WHERE project_id=$1 AND status='approved' LIMIT 1",
        [projectId],
      );
      if (hold.rows[0]) return "held";
      const evidence = await client.query("SELECT 1 FROM agentcert_evidence WHERE project_id=$1 AND id=$2", [projectId, evidenceId]);
      if (!evidence.rows[0]) return "missing";
      await deleteObject();
      const deleted = await client.query("DELETE FROM agentcert_evidence WHERE project_id=$1 AND id=$2", [projectId, evidenceId]);
      return (deleted.rowCount ?? 0) > 0 ? "deleted" : "missing";
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async saveLegalHoldRequest(
    request: LegalHoldRequestRecord,
    expectedStatus?: LegalHoldRequestRecord["status"],
  ): Promise<LegalHoldRequestRecord> {
    const client = await this.pool.connect();
    const lockKey = retentionLockKey(request.projectId);
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      const values = [request.id, request.projectId, request.status, request.reason, request.requestedBy, request.requestedByEmail ?? null,
        request.requestedAt, request.reviewedBy ?? null, request.reviewedByEmail ?? null, request.reviewNote ?? null,
        request.reviewedAt ?? null, request.releasedBy ?? null, request.releasedByEmail ?? null, request.releaseNote ?? null,
        request.releasedAt ?? null];
      const result = expectedStatus
        ? await client.query(
          `UPDATE agentcert_legal_hold_requests SET status=$3,reviewed_by=$8,reviewed_by_email=$9,
           review_note=$10,reviewed_at=$11,released_by=$12,released_by_email=$13,release_note=$14,released_at=$15
           WHERE id=$1 AND project_id=$2 AND status=$16 RETURNING *`,
          [...values, expectedStatus],
        )
        : await client.query(
          `INSERT INTO agentcert_legal_hold_requests
           (id,project_id,status,reason,requested_by,requested_by_email,requested_at,reviewed_by,reviewed_by_email,review_note,reviewed_at,released_by,released_by_email,release_note,released_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          values,
        );
      if (!result.rows[0] && expectedStatus) throw new LegalHoldStateConflictError(expectedStatus);
      return legalHoldFromRow(result.rows[0]);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async getLegalHoldRequest(requestId: string): Promise<LegalHoldRequestRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_legal_hold_requests WHERE id=$1", [requestId]), legalHoldFromRow);
  }

  async listLegalHoldRequests(projectId: string, limit = 20): Promise<LegalHoldRequestRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_legal_hold_requests WHERE project_id=$1 ORDER BY requested_at DESC LIMIT $2", [projectId, limit]),
      legalHoldFromRow,
    );
  }

  async listPendingLegalHoldRequests(limit = 100): Promise<LegalHoldRequestRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_legal_hold_requests WHERE status='requested' ORDER BY requested_at ASC LIMIT $1", [limit]),
      legalHoldFromRow,
    );
  }

  async getApprovedLegalHold(projectId: string): Promise<LegalHoldRequestRecord | undefined> {
    return one(
      this.pool.query("SELECT * FROM agentcert_legal_hold_requests WHERE project_id=$1 AND status='approved' ORDER BY reviewed_at DESC LIMIT 1", [projectId]),
      legalHoldFromRow,
    );
  }

  async insertIncident(incident: IncidentRecord): Promise<IncidentRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_incidents
       (id,project_id,agent_id,run_id,action_id,severity,type,status,summary,first_divergence,fingerprint,
        occurrence_count,consecutive_passes,last_failed_at,last_passed_at,acknowledged_by,acknowledged_by_email,
        acknowledged_at,recovered_at,resolved_by,resolved_by_email,github_issue_number,github_issue_url,created_at,updated_at,resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING *`,
      [incident.id, incident.projectId, incident.agentId ?? null, incident.runId ?? null, incident.actionId ?? null, incident.severity,
       incident.type, incident.status, incident.summary, incident.firstDivergence ?? null, incident.fingerprint ?? null,
       incident.occurrenceCount, incident.consecutivePasses, incident.lastFailedAt ?? null, incident.lastPassedAt ?? null,
       incident.acknowledgedBy ?? null, incident.acknowledgedByEmail ?? null, incident.acknowledgedAt ?? null,
       incident.recoveredAt ?? null, incident.resolvedBy ?? null, incident.resolvedByEmail ?? null,
       incident.githubIssueNumber ?? null, incident.githubIssueUrl ?? null, incident.createdAt, incident.updatedAt, incident.resolvedAt ?? null],
    );
    return incidentFromRow(result.rows[0]);
  }

  async insertIncidentWithTransition(incident: IncidentRecord, transition: IncidentTransitionRecord) {
    return this.persistIncidentWithTransition("insert", incident, transition);
  }

  async getIncident(projectId: string, incidentId: string): Promise<IncidentRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_incidents WHERE project_id=$1 AND id=$2", [projectId, incidentId]), incidentFromRow);
  }

  async updateIncident(incident: IncidentRecord): Promise<IncidentRecord> {
    const result = await this.pool.query(
      `UPDATE agentcert_incidents SET status=$3,summary=$4,first_divergence=$5,occurrence_count=$6,
       consecutive_passes=$7,last_failed_at=$8,last_passed_at=$9,acknowledged_by=$10,acknowledged_by_email=$11,
       acknowledged_at=$12,recovered_at=$13,resolved_by=$14,resolved_by_email=$15,github_issue_number=$16,
       github_issue_url=$17,updated_at=$18,resolved_at=$19 WHERE project_id=$1 AND id=$2 RETURNING *`,
      [incident.projectId, incident.id, incident.status, incident.summary, incident.firstDivergence ?? null,
       incident.occurrenceCount, incident.consecutivePasses, incident.lastFailedAt ?? null, incident.lastPassedAt ?? null,
       incident.acknowledgedBy ?? null, incident.acknowledgedByEmail ?? null, incident.acknowledgedAt ?? null,
       incident.recoveredAt ?? null, incident.resolvedBy ?? null, incident.resolvedByEmail ?? null,
       incident.githubIssueNumber ?? null, incident.githubIssueUrl ?? null, incident.updatedAt, incident.resolvedAt ?? null],
    );
    if (!result.rows[0]) throw new Error(`Incident ${incident.id} was not found.`);
    return incidentFromRow(result.rows[0]);
  }

  async updateIncidentWithTransition(incident: IncidentRecord, transition: IncidentTransitionRecord) {
    return this.persistIncidentWithTransition("update", incident, transition);
  }

  private async persistIncidentWithTransition(
    operation: "insert" | "update",
    incident: IncidentRecord,
    transition: IncidentTransitionRecord,
  ): Promise<{ incident: IncidentRecord; transition: IncidentTransitionRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const incidentResult = operation === "insert"
        ? await client.query(
          `INSERT INTO agentcert_incidents
           (id,project_id,agent_id,run_id,action_id,severity,type,status,summary,first_divergence,fingerprint,
            occurrence_count,consecutive_passes,last_failed_at,last_passed_at,acknowledged_by,acknowledged_by_email,
            acknowledged_at,recovered_at,resolved_by,resolved_by_email,github_issue_number,github_issue_url,created_at,updated_at,resolved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
           RETURNING *`,
          incidentQueryValues(incident),
        )
        : await client.query(
          `UPDATE agentcert_incidents SET status=$3,summary=$4,first_divergence=$5,occurrence_count=$6,
           consecutive_passes=$7,last_failed_at=$8,last_passed_at=$9,acknowledged_by=$10,acknowledged_by_email=$11,
           acknowledged_at=$12,recovered_at=$13,resolved_by=$14,resolved_by_email=$15,github_issue_number=$16,
           github_issue_url=$17,updated_at=$18,resolved_at=$19 WHERE project_id=$1 AND id=$2 RETURNING *`,
          incidentUpdateQueryValues(incident),
        );
      if (!incidentResult.rows[0]) throw new Error(`Incident ${incident.id} was not found.`);
      const transitionResult = await client.query(
        `INSERT INTO agentcert_incident_transitions
         (id,project_id,incident_id,from_status,to_status,actor_type,actor_id,actor_email,reason,evidence,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        incidentTransitionQueryValues(transition),
      );
      await client.query("COMMIT");
      return { incident: incidentFromRow(incidentResult.rows[0]), transition: incidentTransitionFromRow(transitionResult.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveIncidentByFingerprint(projectId: string, fingerprint: string): Promise<IncidentRecord | undefined> {
    return one(this.pool.query(
      "SELECT * FROM agentcert_incidents WHERE project_id=$1 AND fingerprint=$2 AND status<>'resolved' ORDER BY created_at DESC LIMIT 1",
      [projectId, fingerprint],
    ), incidentFromRow);
  }

  async getLatestIncidentByFingerprint(projectId: string, fingerprint: string): Promise<IncidentRecord | undefined> {
    return one(this.pool.query(
      "SELECT * FROM agentcert_incidents WHERE project_id=$1 AND fingerprint=$2 ORDER BY created_at DESC LIMIT 1",
      [projectId, fingerprint],
    ), incidentFromRow);
  }

  async listIncidents(projectId: string, limit = 100): Promise<IncidentRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_incidents WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]), incidentFromRow);
  }

  async listIncidentsForRun(projectId: string, runId: string): Promise<IncidentRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_incidents WHERE project_id=$1 AND run_id=$2 ORDER BY created_at DESC", [projectId, runId]),
      incidentFromRow,
    );
  }

  async insertIncidentTransition(transition: IncidentTransitionRecord): Promise<IncidentTransitionRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_incident_transitions
       (id,project_id,incident_id,from_status,to_status,actor_type,actor_id,actor_email,reason,evidence,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [transition.id, transition.projectId, transition.incidentId, transition.fromStatus ?? null, transition.toStatus,
       transition.actorType, transition.actorId ?? null, transition.actorEmail ?? null, transition.reason,
       JSON.stringify(transition.evidence), transition.occurredAt],
    );
    return incidentTransitionFromRow(result.rows[0]);
  }

  async listIncidentTransitions(projectId: string, incidentId: string): Promise<IncidentTransitionRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_incident_transitions WHERE project_id=$1 AND incident_id=$2 ORDER BY occurred_at ASC",
      [projectId, incidentId],
    ), incidentTransitionFromRow);
  }

  async upsertFailureReview(review: FailureReviewRecord): Promise<FailureReviewRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_failure_reviews
       (id,project_id,run_id,pattern_key,suggested_type,type,status,reviewer_id,reviewer,note,confidence,evidence_context,taxonomy_rationale,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (run_id,pattern_key) DO UPDATE SET suggested_type=excluded.suggested_type,type=excluded.type,
       status=excluded.status,reviewer_id=excluded.reviewer_id,reviewer=excluded.reviewer,note=excluded.note,
       confidence=excluded.confidence,evidence_context=excluded.evidence_context,taxonomy_rationale=excluded.taxonomy_rationale,
       updated_at=excluded.updated_at RETURNING *`,
      [review.id, review.projectId, review.runId, review.patternKey, review.suggestedType ?? null, review.type, review.status,
       review.reviewerId, review.reviewer, review.note ?? null, review.confidence ?? null, JSON.stringify(review.evidenceContext),
       JSON.stringify(review.taxonomyRationale), review.createdAt, review.updatedAt],
    );
    return failureReviewFromRow(result.rows[0]);
  }

  async listFailureReviews(projectId: string, runId: string): Promise<FailureReviewRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_failure_reviews WHERE project_id=$1 AND run_id=$2 ORDER BY updated_at DESC", [projectId, runId]),
      failureReviewFromRow,
    );
  }

  async listLegalHoldRequestsForAdmin(status?: LegalHoldRequestRecord["status"], limit = 200): Promise<LegalHoldRequestRecord[]> {
    return status
      ? many(this.pool.query("SELECT * FROM agentcert_legal_hold_requests WHERE status=$1 ORDER BY requested_at DESC LIMIT $2", [status, limit]), legalHoldFromRow)
      : many(this.pool.query("SELECT * FROM agentcert_legal_hold_requests ORDER BY requested_at DESC LIMIT $1", [limit]), legalHoldFromRow);
  }

  async listFailureReviewsForProject(projectId: string, limit = 10_000): Promise<FailureReviewRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_failure_reviews WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2", [projectId, limit]),
      failureReviewFromRow,
    );
  }

  async insertEvidenceDeletion(record: EvidenceDeletionRecord): Promise<EvidenceDeletionRecord> {
    await this.pool.query(
      `INSERT INTO agentcert_evidence_deletions
       (id,project_id,evidence_id,run_id,action_id,object_key,file_name,kind,sha256,size_bytes,outcome,reason,error,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [record.id, record.projectId, record.evidenceId, record.runId ?? null, record.actionId ?? null, record.objectKey,
       record.fileName, record.kind, record.sha256, record.sizeBytes, record.outcome, record.reason, record.error ?? null, record.occurredAt],
    );
    return record;
  }

  async listEvidenceDeletions(projectId: string, limit = 500): Promise<EvidenceDeletionRecord[]> {
    return many(
      this.pool.query("SELECT * FROM agentcert_evidence_deletions WHERE project_id=$1 ORDER BY occurred_at DESC LIMIT $2", [projectId, limit]),
      evidenceDeletionFromRow,
    );
  }

  async getIdempotency(projectId: string, key: string, operation: string): Promise<IdempotencyRecord | undefined> {
    return one(
      this.pool.query("SELECT * FROM agentcert_idempotency WHERE project_id=$1 AND key=$2 AND operation=$3 AND expires_at>now()", [projectId, key, operation]),
      idempotencyFromRow,
    );
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_idempotency (project_id,key,operation,request_hash,response_status,response_body,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (project_id,key,operation) DO UPDATE SET key=excluded.key RETURNING *`,
      [record.projectId, record.key, record.operation, record.requestHash, record.responseStatus, JSON.stringify(record.responseBody), record.createdAt, record.expiresAt],
    );
    return idempotencyFromRow(result.rows[0]);
  }

  async insertWebhook(webhook: WebhookRecord): Promise<WebhookRecord> {
    await this.pool.query(
      `INSERT INTO agentcert_webhooks (id,project_id,url,event_types,secret_ciphertext,created_by,created_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [webhook.id, webhook.projectId, webhook.url, JSON.stringify(webhook.eventTypes), webhook.secretCiphertext, webhook.createdBy, webhook.createdAt, null],
    );
    return webhook;
  }

  async listWebhooks(projectId: string): Promise<WebhookRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_webhooks WHERE project_id=$1 ORDER BY created_at DESC", [projectId]), webhookFromRow);
  }

  async revokeWebhook(projectId: string, webhookId: string, revokedAt: string): Promise<WebhookRecord | undefined> {
    return one(this.pool.query(
      "UPDATE agentcert_webhooks SET revoked_at=COALESCE(revoked_at,$3) WHERE project_id=$1 AND id=$2 RETURNING *",
      [projectId, webhookId, revokedAt],
    ), webhookFromRow);
  }

  async insertWebhookDelivery(delivery: WebhookDeliveryRecord): Promise<WebhookDeliveryRecord> {
    await this.pool.query(
      `INSERT INTO agentcert_webhook_deliveries
       (id,project_id,webhook_id,event_id,event_type,status,response_status,error,attempted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [delivery.id, delivery.projectId, delivery.webhookId, delivery.eventId, delivery.eventType, delivery.status,
       delivery.responseStatus ?? null, delivery.error ?? null, delivery.attemptedAt],
    );
    return delivery;
  }

  async listWebhookDeliveries(projectId: string, limit = 100): Promise<WebhookDeliveryRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_webhook_deliveries WHERE project_id=$1 ORDER BY attempted_at DESC LIMIT $2",
      [projectId, limit],
    ), webhookDeliveryFromRow);
  }

  async enqueueWebhookJob(job: WebhookJobRecord): Promise<WebhookJobRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_webhook_jobs
       (id,project_id,webhook_id,event_id,event_type,payload,status,attempt_count,max_attempts,next_attempt_at,locked_at,locked_by,last_response_status,last_error,created_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [job.id, job.projectId, job.webhookId, job.eventId, job.eventType, JSON.stringify(job.payload), job.status,
       job.attemptCount, job.maxAttempts, job.nextAttemptAt, job.lockedAt ?? null, job.lockedBy ?? null,
       job.lastResponseStatus ?? null, job.lastError ?? null, job.createdAt, job.completedAt ?? null],
    );
    return webhookJobFromRow(result.rows[0]);
  }

  async claimWebhookJobs(workerId: string, now: string, leaseExpiredBefore: string, limit = 20): Promise<WebhookJobRecord[]> {
    return many(this.pool.query(
      `WITH due AS (
         SELECT id FROM agentcert_webhook_jobs
         WHERE next_attempt_at <= $2
           AND (status IN ('pending','retrying') OR (status='processing' AND locked_at <= $3))
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       UPDATE agentcert_webhook_jobs jobs
       SET status='processing', locked_at=$2, locked_by=$1
       FROM due WHERE jobs.id=due.id
       RETURNING jobs.*`,
      [workerId, now, leaseExpiredBefore, limit],
    ), webhookJobFromRow);
  }

  async updateWebhookJob(job: WebhookJobRecord): Promise<WebhookJobRecord> {
    const result = await this.pool.query(
      `UPDATE agentcert_webhook_jobs SET
       status=$2,attempt_count=$3,max_attempts=$4,next_attempt_at=$5,locked_at=$6,locked_by=$7,
       last_response_status=$8,last_error=$9,completed_at=$10
       WHERE id=$1 RETURNING *`,
      [job.id, job.status, job.attemptCount, job.maxAttempts, job.nextAttemptAt, job.lockedAt ?? null,
       job.lockedBy ?? null, job.lastResponseStatus ?? null, job.lastError ?? null, job.completedAt ?? null],
    );
    if (!result.rows[0]) throw new Error(`Webhook job ${job.id} was not found.`);
    return webhookJobFromRow(result.rows[0]);
  }

  async getWebhookJob(projectId: string, jobId: string): Promise<WebhookJobRecord | undefined> {
    return one(this.pool.query(
      "SELECT * FROM agentcert_webhook_jobs WHERE project_id=$1 AND id=$2",
      [projectId, jobId],
    ), webhookJobFromRow);
  }

  async listWebhookJobs(projectId: string, limit = 100): Promise<WebhookJobRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_webhook_jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2",
      [projectId, limit],
    ), webhookJobFromRow);
  }

  async webhookJobCounts(projectId: string): Promise<WebhookJobCounts> {
    const counts = emptyWebhookJobCounts();
    const result = await this.pool.query(
      "SELECT status, count(*)::integer AS count FROM agentcert_webhook_jobs WHERE project_id=$1 GROUP BY status",
      [projectId],
    );
    for (const row of result.rows) counts[text(row.status) as WebhookJobRecord["status"]] = number(row.count);
    return counts;
  }

  async webhookOperationsMetrics(projectId: string, since: string): Promise<WebhookOperationsMetrics> {
    const [bucketResult, summaryResult] = await Promise.all([this.pool.query(
      `SELECT date_trunc('day', created_at)::date::text AS date,
              count(*)::integer AS total,
              count(*) FILTER (WHERE status='delivered')::integer AS delivered,
              count(*) FILTER (WHERE attempt_count > 1)::integer AS retried,
              count(*) FILTER (WHERE status='dead_letter')::integer AS dead_letter,
              COALESCE(round(avg(extract(epoch FROM (completed_at-created_at)) * 1000)
                FILTER (WHERE status='delivered' AND completed_at IS NOT NULL))::integer, 0) AS average_latency_ms,
              COALESCE(round(percentile_cont(0.95) WITHIN GROUP
                (ORDER BY extract(epoch FROM (completed_at-created_at)) * 1000)
                FILTER (WHERE status='delivered' AND completed_at IS NOT NULL))::integer, 0) AS p95_latency_ms
       FROM agentcert_webhook_jobs
       WHERE project_id=$1 AND created_at >= $2
       GROUP BY date_trunc('day', created_at)::date
       ORDER BY date ASC`,
      [projectId, since],
    ), this.pool.query(
      `SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE status='delivered')::integer AS delivered,
              count(*) FILTER (WHERE attempt_count > 1)::integer AS retried,
              count(*) FILTER (WHERE status='dead_letter')::integer AS dead_letter,
              COALESCE(round(avg(extract(epoch FROM (completed_at-created_at)) * 1000)
                FILTER (WHERE status='delivered' AND completed_at IS NOT NULL))::integer, 0) AS average_latency_ms,
              COALESCE(round(percentile_cont(0.95) WITHIN GROUP
                (ORDER BY extract(epoch FROM (completed_at-created_at)) * 1000)
                FILTER (WHERE status='delivered' AND completed_at IS NOT NULL))::integer, 0) AS p95_latency_ms
       FROM agentcert_webhook_jobs WHERE project_id=$1 AND created_at >= $2`,
      [projectId, since],
    )]);
    const summary = summaryResult.rows[0];
    return {
      total: number(summary.total), delivered: number(summary.delivered), retried: number(summary.retried),
      deadLetter: number(summary.dead_letter), averageLatencyMs: number(summary.average_latency_ms), p95LatencyMs: number(summary.p95_latency_ms),
      buckets: bucketResult.rows.map((row) => ({
      date: text(row.date), total: number(row.total), delivered: number(row.delivered), retried: number(row.retried),
      deadLetter: number(row.dead_letter), averageLatencyMs: number(row.average_latency_ms), p95LatencyMs: number(row.p95_latency_ms),
      })),
    };
  }

  async saveTrustHealthSample(sample: TrustHealthSampleRecord): Promise<TrustHealthSampleRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_trust_health_samples
       (id,project_id,external_id,source,status,started_at,completed_at,duration_ms,checks,error,workflow_run_id,workflow_run_url,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (project_id,external_id) DO UPDATE SET
         status=EXCLUDED.status,completed_at=EXCLUDED.completed_at,duration_ms=EXCLUDED.duration_ms,
         checks=EXCLUDED.checks,error=EXCLUDED.error,workflow_run_id=EXCLUDED.workflow_run_id,
         workflow_run_url=EXCLUDED.workflow_run_url
       RETURNING *`,
      [sample.id, sample.projectId, sample.externalId, sample.source, sample.status, sample.startedAt, sample.completedAt,
       sample.durationMs, JSON.stringify(sample.checks), sample.error ?? null, sample.workflowRunId ?? null,
       sample.workflowRunUrl ?? null, sample.createdAt],
    );
    return trustHealthSampleFromRow(result.rows[0]);
  }

  async listTrustHealthSamples(projectId: string, since: string, limit = 100): Promise<TrustHealthSampleRecord[]> {
    return many(this.pool.query(
      `SELECT * FROM agentcert_trust_health_samples
       WHERE project_id=$1 AND completed_at >= $2 ORDER BY completed_at DESC LIMIT $3`,
      [projectId, since, limit],
    ), trustHealthSampleFromRow);
  }

  async trustHealthCounts(projectId: string, since: string): Promise<{ total: number; passed: number; failed: number }> {
    const result = await this.pool.query(
      `SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE status='passed')::integer AS passed,
              count(*) FILTER (WHERE status='failed')::integer AS failed
       FROM agentcert_trust_health_samples WHERE project_id=$1 AND source='production_smoke' AND completed_at >= $2`,
      [projectId, since],
    );
    return { total: number(result.rows[0].total), passed: number(result.rows[0].passed), failed: number(result.rows[0].failed) };
  }

  async saveNotificationDestination(destination: NotificationDestinationRecord): Promise<NotificationDestinationRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_notification_destinations
       (id,project_id,email,alert_types,status,verification_token_hash,verification_expires_at,verified_at,created_by,created_at,disabled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (project_id,email) DO UPDATE SET alert_types=EXCLUDED.alert_types,status=EXCLUDED.status,
       verification_token_hash=EXCLUDED.verification_token_hash,verification_expires_at=EXCLUDED.verification_expires_at,
       verified_at=NULL,disabled_at=NULL RETURNING *`,
      [destination.id, destination.projectId, destination.email, destination.alertTypes, destination.status,
       destination.verificationTokenHash ?? null, destination.verificationExpiresAt ?? null, destination.verifiedAt ?? null,
       destination.createdBy, destination.createdAt, destination.disabledAt ?? null],
    );
    return notificationDestinationFromRow(result.rows[0]);
  }

  async verifyNotificationDestination(tokenHash: string, now: string): Promise<NotificationVerificationStoreResult> {
    const verified = await one(this.pool.query(
      `UPDATE agentcert_notification_destinations SET status='active',verified_at=$2
       WHERE verification_token_hash=$1 AND status='pending_verification'
       AND verification_expires_at >= $2 RETURNING *`,
      [tokenHash, now],
    ), notificationDestinationFromRow);
    if (verified) return { outcome: "verified", destination: verified };
    const destination = await one(this.pool.query(
      "SELECT * FROM agentcert_notification_destinations WHERE verification_token_hash=$1",
      [tokenHash],
    ), notificationDestinationFromRow);
    if (!destination || destination.status === "disabled") return { outcome: "invalid" };
    if (destination.status === "active") return { outcome: "already_verified", destination };
    if (!destination.verificationExpiresAt || destination.verificationExpiresAt < now) return { outcome: "expired" };
    return { outcome: "invalid" };
  }

  async listNotificationDestinations(projectId: string): Promise<NotificationDestinationRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_notification_destinations WHERE project_id=$1 ORDER BY created_at DESC",
      [projectId],
    ), notificationDestinationFromRow);
  }

  async disableNotificationDestination(projectId: string, destinationId: string, disabledAt: string): Promise<NotificationDestinationRecord | undefined> {
    return one(this.pool.query(
      "UPDATE agentcert_notification_destinations SET status='disabled',disabled_at=$3 WHERE project_id=$1 AND id=$2 RETURNING *",
      [projectId, destinationId, disabledAt],
    ), notificationDestinationFromRow);
  }

  async insertNotificationDelivery(delivery: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_notification_deliveries
       (id,project_id,destination_id,job_id,alert_type,subject,status,provider,provider_message_id,error,attempt_count,attempted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [delivery.id, delivery.projectId, delivery.destinationId, delivery.jobId ?? null, delivery.alertType, delivery.subject, delivery.status,
       delivery.provider, delivery.providerMessageId ?? null, delivery.error ?? null, delivery.attemptCount, delivery.attemptedAt],
    );
    return notificationDeliveryFromRow(result.rows[0]);
  }

  async listNotificationDeliveries(projectId: string, limit = 100): Promise<NotificationDeliveryRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_notification_deliveries WHERE project_id=$1 ORDER BY attempted_at DESC LIMIT $2",
      [projectId, limit],
    ), notificationDeliveryFromRow);
  }

  async enqueueNotificationJob(job: NotificationJobRecord): Promise<NotificationJobRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_notification_jobs
       (id,project_id,destination_id,alert_type,recipient,subject,text_body,html_body,status,attempt_count,max_attempts,
        next_attempt_at,locked_at,locked_by,provider,provider_message_id,last_error,created_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [job.id, job.projectId, job.destinationId, job.alertType, job.recipient, job.subject, job.text, job.html,
       job.status, job.attemptCount, job.maxAttempts, job.nextAttemptAt, job.lockedAt ?? null, job.lockedBy ?? null,
       job.provider ?? null, job.providerMessageId ?? null, job.lastError ?? null, job.createdAt, job.completedAt ?? null],
    );
    return notificationJobFromRow(result.rows[0]);
  }

  async claimNotificationJobs(workerId: string, now: string, leaseExpiredBefore: string, limit = 20): Promise<NotificationJobRecord[]> {
    return many(this.pool.query(
      `WITH due AS (
         SELECT id FROM agentcert_notification_jobs
         WHERE next_attempt_at <= $2
           AND (status IN ('pending','retrying') OR (status='processing' AND locked_at <= $3))
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       UPDATE agentcert_notification_jobs jobs
       SET status='processing', locked_at=$2, locked_by=$1
       FROM due WHERE jobs.id=due.id
       RETURNING jobs.*`,
      [workerId, now, leaseExpiredBefore, limit],
    ), notificationJobFromRow);
  }

  async updateNotificationJob(job: NotificationJobRecord): Promise<NotificationJobRecord> {
    const result = await this.pool.query(
      `UPDATE agentcert_notification_jobs SET
       status=$2,attempt_count=$3,max_attempts=$4,next_attempt_at=$5,locked_at=$6,locked_by=$7,
       provider=$8,provider_message_id=$9,last_error=$10,completed_at=$11
       WHERE id=$1 RETURNING *`,
      [job.id, job.status, job.attemptCount, job.maxAttempts, job.nextAttemptAt, job.lockedAt ?? null,
       job.lockedBy ?? null, job.provider ?? null, job.providerMessageId ?? null, job.lastError ?? null, job.completedAt ?? null],
    );
    if (!result.rows[0]) throw new Error(`Notification job ${job.id} was not found.`);
    return notificationJobFromRow(result.rows[0]);
  }

  async getNotificationJob(projectId: string, jobId: string): Promise<NotificationJobRecord | undefined> {
    return one(this.pool.query(
      "SELECT * FROM agentcert_notification_jobs WHERE project_id=$1 AND id=$2",
      [projectId, jobId],
    ), notificationJobFromRow);
  }

  async listNotificationJobs(projectId: string, limit = 100): Promise<NotificationJobRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_notification_jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2",
      [projectId, limit],
    ), notificationJobFromRow);
  }

  async notificationJobCounts(projectId: string): Promise<NotificationJobCounts> {
    const counts = emptyNotificationJobCounts();
    const result = await this.pool.query(
      "SELECT status, count(*)::integer AS count FROM agentcert_notification_jobs WHERE project_id=$1 GROUP BY status",
      [projectId],
    );
    for (const row of result.rows) counts[text(row.status) as NotificationJobRecord["status"]] = number(row.count);
    return counts;
  }

  async activateSigningKey(key: SigningKeyRecord): Promise<SigningKeyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agentcert-signing-keyring'))");
      const existing = await client.query("SELECT * FROM agentcert_signing_keys WHERE key_id=$1", [key.keyId]);
      if (existing.rows[0] && text(existing.rows[0].public_key_pem) !== key.publicKeyPem) {
        throw new Error(`Signing key ID ${key.keyId} already belongs to another public key.`);
      }
      if (existing.rows[0]) {
        const current = signingKeyFromRow(existing.rows[0]);
        if (current.status !== "active") throw new Error(`Signing key ID ${key.keyId} is historical and cannot be reactivated.`);
        await client.query("COMMIT");
        return current;
      }
      await client.query(
        "UPDATE agentcert_signing_keys SET status='retired',retired_at=$2 WHERE status='active' AND key_id<>$1",
        [key.keyId, key.activatedAt],
      );
      const result = await client.query(
        `INSERT INTO agentcert_signing_keys
         (key_id,algorithm,public_key_pem,status,created_at,activated_at,retired_at,revoked_at)
         VALUES ($1,$2,$3,'active',$4,$5,NULL,NULL)
         ON CONFLICT (key_id) DO NOTHING
         RETURNING *`,
        [key.keyId, key.algorithm, key.publicKeyPem, key.createdAt, key.activatedAt],
      );
      await client.query("COMMIT");
      return signingKeyFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getSigningKey(keyId: string): Promise<SigningKeyRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_signing_keys WHERE key_id=$1", [keyId]), signingKeyFromRow);
  }

  async listSigningKeys(): Promise<SigningKeyRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_signing_keys ORDER BY activated_at DESC"), signingKeyFromRow);
  }

  async insertApiKey(apiKey: ApiKeyRecord): Promise<ApiKeyRecord> {
    await this.pool.query(
      `INSERT INTO agentcert_api_keys (id,project_id,name,prefix,secret_hash,created_by,created_at,last_used_at,revoked_at,scopes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [apiKey.id, apiKey.projectId, apiKey.name, apiKey.prefix, apiKey.secretHash, apiKey.createdBy, apiKey.createdAt, null, null, JSON.stringify(apiKey.scopes)],
    );
    return apiKey;
  }

  async findApiKeyByHash(secretHash: string): Promise<ApiKeyRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_api_keys WHERE secret_hash=$1 AND revoked_at IS NULL", [secretHash]), apiKeyFromRow);
  }

  async touchApiKey(apiKeyId: string, usedAt: string): Promise<void> {
    await this.pool.query("UPDATE agentcert_api_keys SET last_used_at=$2 WHERE id=$1", [apiKeyId, usedAt]);
  }

  async listApiKeys(projectId: string): Promise<ApiKeyRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_api_keys WHERE project_id=$1 ORDER BY created_at DESC", [projectId]), apiKeyFromRow);
  }

  async revokeApiKey(projectId: string, apiKeyId: string, revokedAt: string): Promise<ApiKeyRecord | undefined> {
    return one(
      this.pool.query(
        "UPDATE agentcert_api_keys SET revoked_at=COALESCE(revoked_at,$3) WHERE project_id=$1 AND id=$2 RETURNING *",
        [projectId, apiKeyId, revokedAt],
      ),
      apiKeyFromRow,
    );
  }

  async activateCollectorSourceKey(key: CollectorSourceKeyRecord): Promise<CollectorSourceKeyRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`collector-key:${key.projectId}:${key.collectorId}`]);
      const existing = await client.query("SELECT * FROM agentcert_collector_source_keys WHERE project_id=$1 AND key_id=$2", [key.projectId, key.keyId]);
      if (existing.rows[0]) {
        const current = collectorSourceKeyFromRow(existing.rows[0]);
        if (current.publicKeyPem !== key.publicKeyPem || current.collectorId !== key.collectorId) throw new TrustedCollectorConflictError("key_conflict");
        await client.query("COMMIT");
        return current;
      }
      const activeResult = await client.query("SELECT * FROM agentcert_collector_source_keys WHERE project_id=$1 AND collector_id=$2 AND status='active' FOR UPDATE", [key.projectId, key.collectorId]);
      if (activeResult.rows[0]) {
        const active = collectorSourceKeyFromRow(activeResult.rows[0]);
        if (key.previousKeyId !== active.keyId) throw new TrustedCollectorConflictError("key_conflict");
        await client.query("UPDATE agentcert_collector_source_keys SET status='retired',retired_at=$3 WHERE project_id=$1 AND key_id=$2", [key.projectId, active.keyId, key.activatedAt]);
      } else if (key.previousKeyId) {
        throw new TrustedCollectorConflictError("key_conflict");
      }
      const inserted = await client.query(
        `INSERT INTO agentcert_collector_source_keys
         (project_id,collector_id,key_id,algorithm,public_key_pem,public_key_sha256,status,previous_key_id,created_at,activated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9) RETURNING *`,
        [key.projectId, key.collectorId, key.keyId, key.algorithm, key.publicKeyPem, key.publicKeySha256, key.previousKeyId ?? null, key.createdAt, key.activatedAt],
      );
      await client.query("COMMIT");
      return collectorSourceKeyFromRow(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new TrustedCollectorConflictError("key_conflict");
      throw error;
    } finally { client.release(); }
  }

  async getCollectorSourceKey(projectId: string, keyId: string): Promise<CollectorSourceKeyRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_collector_source_keys WHERE project_id=$1 AND key_id=$2", [projectId, keyId]), collectorSourceKeyFromRow);
  }

  async listCollectorSourceKeys(projectId: string): Promise<CollectorSourceKeyRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_collector_source_keys WHERE project_id=$1 ORDER BY activated_at DESC", [projectId]), collectorSourceKeyFromRow);
  }

  async revokeCollectorSourceKey(projectId: string, keyId: string, revokedAt: string): Promise<CollectorSourceKeyRecord | undefined> {
    return one(this.pool.query(
      "UPDATE agentcert_collector_source_keys SET status='revoked',revoked_at=COALESCE(revoked_at,$3) WHERE project_id=$1 AND key_id=$2 RETURNING *",
      [projectId, keyId, revokedAt],
    ), collectorSourceKeyFromRow);
  }

  async appendTrustedCollectorRecords(
    projectId: string,
    runId: string,
    collectorId: string,
    sourceKeyId: string,
    records: TrustedSourceRecord[],
    receivedAt: string,
  ): Promise<TrustedCollectorAppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`trusted-run:${projectId}:${runId}`]);
      let run = await one(client.query("SELECT * FROM agentcert_trusted_collector_runs WHERE project_id=$1 AND run_id=$2 FOR UPDATE", [projectId, runId]), trustedCollectorRunFromRow);
      let accepted = 0;
      let replayed = 0;
      const alerts: TrustedCollectorAlertRecord[] = [];
      for (const record of records) {
        if (run && (run.collectorId !== collectorId || run.sourceKeyId !== sourceKeyId)) throw new TrustedCollectorConflictError("run_conflict");
        const existing = await one(client.query(
          "SELECT * FROM agentcert_trusted_collector_records WHERE project_id=$1 AND run_id=$2 AND sequence=$3",
          [projectId, runId, record.sequence],
        ), trustedCollectorRecordFromRow);
        if (existing) {
          if (existing.eventHash !== record.eventHash || existing.recordId !== record.recordId) throw new TrustedCollectorConflictError("sequence_conflict");
          replayed += 1;
          continue;
        }
        if (!run && (record.sequence !== 0 || record.type !== "RUN_STARTED")) throw new TrustedCollectorConflictError("invalid_start");
        if (run && (run.status === "completed" || run.status === "reconciled")) throw new TrustedCollectorConflictError("run_closed");
        if (run && record.type === "RUN_STARTED") throw new TrustedCollectorConflictError("invalid_start");
        const expectedSequence = run ? run.lastSequence + 1 : 0;
        const gap = record.sequence - expectedSequence;
        const declaredDrop = gap > 0 && record.type === "EVENTS_DROPPED" && positiveInteger(record.payload.count) === gap;
        if (gap < 0) throw new TrustedCollectorConflictError("sequence_conflict");
        if (gap > 0 && !declaredDrop) throw new TrustedCollectorConflictError("undeclared_gap");
        if ((!run && record.previousEventHash !== undefined) || (run && record.previousEventHash !== run.lastEventHash)) throw new TrustedCollectorConflictError("chain_conflict");
        if (!run) {
          const inserted = await client.query(
            `INSERT INTO agentcert_trusted_collector_runs
             (project_id,run_id,collector_id,source_key_id,status,first_sequence,last_sequence,first_event_hash,last_event_hash,
              accepted_event_count,dropped_event_count,started_at,created_at,updated_at)
             VALUES ($1,$2,$3,$4,'open',$5,$5,$6,$6,1,0,$7,$8,$8) RETURNING *`,
            [projectId, runId, collectorId, sourceKeyId, record.sequence, record.eventHash, record.occurredAt, receivedAt],
          );
          run = trustedCollectorRunFromRow(inserted.rows[0]);
        } else {
          run = { ...run, lastSequence: record.sequence, lastEventHash: record.eventHash, acceptedEventCount: run.acceptedEventCount + 1, updatedAt: receivedAt };
        }
        await client.query(
          `INSERT INTO agentcert_trusted_collector_records
           (project_id,run_id,sequence,record_id,event_hash,previous_event_hash,source_key_id,record,received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [projectId, runId, record.sequence, record.recordId, record.eventHash, record.previousEventHash ?? null, sourceKeyId, JSON.stringify(record), receivedAt],
        );
        accepted += 1;
        if (declaredDrop) {
          run = { ...run, status: "degraded", droppedEventCount: run.droppedEventCount + gap };
          const alert = collectorAlert(projectId, collectorId, runId, "events_dropped", "critical", `${gap} collector event(s) were declared dropped.`, { gap, sequence: record.sequence }, receivedAt);
          await insertCollectorAlert(client, alert);
          alerts.push(alert);
        }
        if (record.type === "RUN_COMPLETED") run = { ...run, status: run.droppedEventCount ? "degraded" : "completed", completedAt: record.occurredAt };
        await client.query(
          `UPDATE agentcert_trusted_collector_runs SET status=$3,last_sequence=$4,last_event_hash=$5,accepted_event_count=$6,
           dropped_event_count=$7,completed_at=$8,updated_at=$9 WHERE project_id=$1 AND run_id=$2`,
          [projectId, runId, run.status, run.lastSequence, run.lastEventHash, run.acceptedEventCount, run.droppedEventCount, run.completedAt ?? null, receivedAt],
        );
      }
      if (!run) throw new TrustedCollectorConflictError("run_conflict");
      await client.query("COMMIT");
      return { run, accepted, replayed, ack: { sequence: run.lastSequence, eventHash: run.lastEventHash }, alerts };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new TrustedCollectorConflictError("sequence_conflict");
      throw error;
    } finally { client.release(); }
  }

  async getTrustedCollectorRun(projectId: string, runId: string): Promise<TrustedCollectorRunRecord | undefined> {
    return one(this.pool.query("SELECT * FROM agentcert_trusted_collector_runs WHERE project_id=$1 AND run_id=$2", [projectId, runId]), trustedCollectorRunFromRow);
  }

  async listTrustedCollectorRuns(projectId: string, limit = 100): Promise<TrustedCollectorRunRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_trusted_collector_runs WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2", [projectId, limit]), trustedCollectorRunFromRow);
  }

  async saveTrustedCollectorReconciliation(projectId: string, runId: string, sourceReceipt: Record<string, unknown>, reconciliation: Record<string, unknown>, serverAttestation: Record<string, unknown>, updatedAt: string): Promise<TrustedCollectorRunRecord> {
    const result = await this.pool.query(
      `UPDATE agentcert_trusted_collector_runs SET status='reconciled',source_receipt=$3,reconciliation=$4,server_attestation=$5,updated_at=$6
       WHERE project_id=$1 AND run_id=$2 RETURNING *`,
      [projectId, runId, JSON.stringify(sourceReceipt), JSON.stringify(reconciliation), JSON.stringify(serverAttestation), updatedAt],
    );
    if (!result.rows[0]) throw new TrustedCollectorConflictError("run_conflict");
    return trustedCollectorRunFromRow(result.rows[0]);
  }

  async saveCollectorHeartbeat(heartbeat: CollectorHeartbeatRecord): Promise<CollectorHeartbeatRecord> {
    const result = await this.pool.query(
      `INSERT INTO agentcert_collector_heartbeats
       (project_id,collector_id,source_key_id,run_id,occurred_at,received_at,pending_record_count,last_ack_sequence,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id,collector_id) DO UPDATE SET source_key_id=EXCLUDED.source_key_id,run_id=EXCLUDED.run_id,
       occurred_at=EXCLUDED.occurred_at,received_at=EXCLUDED.received_at,pending_record_count=EXCLUDED.pending_record_count,
       last_ack_sequence=EXCLUDED.last_ack_sequence,status=EXCLUDED.status RETURNING *`,
      [heartbeat.projectId, heartbeat.collectorId, heartbeat.sourceKeyId, heartbeat.runId ?? null, heartbeat.occurredAt,
        heartbeat.receivedAt, heartbeat.pendingRecordCount, heartbeat.lastAckSequence ?? null, heartbeat.status],
    );
    return collectorHeartbeatFromRow(result.rows[0]);
  }

  async listCollectorHeartbeats(projectId: string): Promise<CollectorHeartbeatRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_collector_heartbeats WHERE project_id=$1 ORDER BY received_at DESC", [projectId]), collectorHeartbeatFromRow);
  }

  async listTrustedCollectorAlerts(projectId: string, limit = 100): Promise<TrustedCollectorAlertRecord[]> {
    return many(this.pool.query("SELECT * FROM agentcert_trusted_collector_alerts WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2", [projectId, limit]), trustedCollectorAlertFromRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function projectFromRow(row: Record<string, unknown>): Project {
  return { id: text(row.id), organizationId: text(row.organization_id), name: text(row.name), slug: text(row.slug), createdAt: iso(row.created_at) };
}
function organizationFromRow(row: Record<string, unknown>): Organization {
  return { id: text(row.id), name: text(row.name), slug: text(row.slug), createdAt: iso(row.created_at) };
}
function membershipFromRow(row: Record<string, unknown>): Membership {
  return { organizationId: text(row.organization_id), userId: text(row.user_id), email: optionalText(row.email), role: text(row.role) as MemberRole, createdAt: iso(row.created_at) };
}
function teamMemberFromRow(row: Record<string, unknown>): TeamMemberRecord {
  return { ...membershipFromRow(row), projectIds: stringArray(row.project_ids) };
}
function teamInvitationValues(record: TeamInvitationRecord): unknown[] {
  return [record.id, record.organizationId, record.email, record.role, JSON.stringify(record.projectIds), record.tokenHash,
    record.status, record.deliveryStatus, record.deliveryError ?? null, record.invitedBy, record.invitedByEmail ?? null,
    record.expiresAt, record.createdAt, record.sentAt ?? null, record.acceptedBy ?? null, record.acceptedAt ?? null, record.revokedAt ?? null];
}
function teamInvitationFromRow(row: Record<string, unknown>): TeamInvitationRecord {
  return {
    id: text(row.id), organizationId: text(row.organization_id), email: text(row.email), role: text(row.role) as MemberRole,
    projectIds: stringArray(row.project_ids), tokenHash: text(row.token_hash), status: text(row.status) as TeamInvitationRecord["status"],
    deliveryStatus: text(row.delivery_status) as TeamInvitationRecord["deliveryStatus"], deliveryError: optionalText(row.delivery_error),
    invitedBy: text(row.invited_by), invitedByEmail: optionalText(row.invited_by_email), expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at), sentAt: optionalIso(row.sent_at), acceptedBy: optionalText(row.accepted_by),
    acceptedAt: optionalIso(row.accepted_at), revokedAt: optionalIso(row.revoked_at),
  };
}
function teamAuditFromRow(row: Record<string, unknown>): TeamAuditRecord {
  return {
    id: text(row.id), organizationId: text(row.organization_id), action: text(row.action) as TeamAuditRecord["action"],
    actorId: text(row.actor_id), actorEmail: optionalText(row.actor_email), targetUserId: optionalText(row.target_user_id),
    targetEmail: optionalText(row.target_email), metadata: object(row.metadata), occurredAt: iso(row.occurred_at),
  };
}
async function insertTeamAudit(client: pg.Pool | pg.PoolClient, record: TeamAuditRecord): Promise<void> {
  await client.query(
    `INSERT INTO agentcert_team_audit (id,organization_id,action,actor_id,actor_email,target_user_id,target_email,metadata,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [record.id, record.organizationId, record.action, record.actorId, record.actorEmail ?? null, record.targetUserId ?? null,
      record.targetEmail ?? null, JSON.stringify(record.metadata), record.occurredAt],
  );
}
async function assertNotLastOwner(client: pg.PoolClient, organizationId: string): Promise<void> {
  const owners = await client.query("SELECT COUNT(*)::int AS count FROM agentcert_memberships WHERE organization_id=$1 AND role='owner'", [organizationId]);
  if (Number(owners.rows[0]?.count) <= 1) throw new TeamStateConflictError("last_owner");
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}
function pilotFeedbackFromRow(row: Record<string, unknown>): PilotFeedbackRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), userId: text(row.user_id),
    stage: text(row.stage) as PilotFeedbackRecord["stage"], category: text(row.category) as PilotFeedbackRecord["category"],
    outcome: text(row.outcome) as PilotFeedbackRecord["outcome"], reasonCode: text(row.reason_code),
    message: optionalText(row.message), context: object(row.context), createdAt: iso(row.created_at),
  };
}
function agentFromRow(row: Record<string, unknown>): AgentRecord {
  return { id: text(row.id), projectId: text(row.project_id), externalId: text(row.external_id), name: text(row.name), version: text(row.version),
    framework: optionalText(row.framework), allowedPermissions: stringArray(row.allowed_permissions), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function runFromRow(row: Record<string, unknown>): RunRecord {
  return { id: text(row.id), projectId: text(row.project_id), agentId: optionalText(row.agent_id), externalId: text(row.external_id), kind: text(row.kind) as RunRecord["kind"],
    status: text(row.status) as RunRecord["status"], score: optionalNumber(row.score), schemaVersion: text(row.schema_version), startedAt: iso(row.started_at),
    completedAt: optionalIso(row.completed_at), metadata: object(row.metadata), traceId: optionalText(row.trace_id), rootSpanId: optionalText(row.root_span_id) };
}
function eventFromRow(row: Record<string, unknown>): EventRecord {
  return { id: text(row.id), projectId: text(row.project_id), runId: text(row.run_id), sequence: number(row.sequence), type: text(row.type), actor: text(row.actor), occurredAt: iso(row.occurred_at), payload: object(row.payload),
    traceId: optionalText(row.trace_id), spanId: optionalText(row.span_id), parentSpanId: optionalText(row.parent_span_id) };
}
function actionFromRow(row: Record<string, unknown>): ActionRecord {
  return { id: text(row.id), projectId: text(row.project_id), agentId: optionalText(row.agent_id), externalId: text(row.external_id), principal: object(row.principal),
    actionType: text(row.action_type) as ActionRecord["actionType"], targetSystem: text(row.target_system), requestedPermissions: stringArray(row.requested_permissions),
    amount: optionalNumber(row.amount), currency: optionalText(row.currency), riskLevel: text(row.risk_level) as ActionRecord["riskLevel"], riskScore: number(row.risk_score),
    decision: text(row.decision) as ActionRecord["decision"], status: text(row.status) as ActionRecord["status"], policyVersion: text(row.policy_version),
    reasons: stringArray(row.reasons), expectedState: optionalObject(row.expected_state), observedState: optionalObject(row.observed_state),
    verificationSuccess: optionalBoolean(row.verification_success), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    traceId: optionalText(row.trace_id), spanId: optionalText(row.span_id), parentSpanId: optionalText(row.parent_span_id),
    assuranceContext: optionalObject(row.assurance_context) as ActionRecord["assuranceContext"] };
}
function evidenceFromRow(row: Record<string, unknown>): EvidenceRecord {
  return { id: text(row.id), projectId: text(row.project_id), runId: optionalText(row.run_id), actionId: optionalText(row.action_id), kind: text(row.kind),
    schemaVersion: text(row.schema_version), objectKey: text(row.object_key), fileName: text(row.file_name), contentType: text(row.content_type), sha256: text(row.sha256),
    sizeBytes: number(row.size_bytes), metadata: object(row.metadata), createdAt: iso(row.created_at) };
}

function assuranceCaseValues(record: AssuranceCaseRecord): unknown[] {
  return [record.id, record.projectId, record.name, JSON.stringify(record.subject), record.status, record.policyPackVersion,
    JSON.stringify(record.evaluationPlan), record.evaluationPlanSha256, JSON.stringify(record.evidenceIds), record.createdBy,
    record.reviewerId ?? null, jsonOrNull(record.report), record.publicVerificationId ?? null, record.expiresAt ?? null,
    record.createdAt, record.updatedAt, jsonOrNull(record.engagement), jsonOrNull(record.deliveryPacket), jsonOrNull(record.continuousAssurance)];
}

function assuranceDecisionValues(record: AssuranceCaseDecisionRecord): unknown[] {
  return [record.id, record.projectId, record.assuranceCaseId, record.fromStatus ?? null, record.toStatus, record.actorId,
    record.actorEmail ?? null, record.reason, JSON.stringify(record.evidenceIds), record.occurredAt];
}

function assuranceCaseFromRow(row: Record<string, unknown>): AssuranceCaseRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), name: text(row.name), subject: object(row.subject) as unknown as AssuranceCaseRecord["subject"],
    status: text(row.status) as AssuranceCaseRecord["status"], policyPackVersion: text(row.policy_pack_version),
    evaluationPlan: object(row.evaluation_plan) as unknown as AssuranceCaseRecord["evaluationPlan"],
    evaluationPlanSha256: text(row.evaluation_plan_sha256), evidenceIds: stringArray(row.evidence_ids), createdBy: text(row.created_by),
    reviewerId: optionalText(row.reviewer_id), report: optionalObject(row.report) as unknown as AssuranceCaseRecord["report"],
    engagement: optionalObject(row.engagement) as unknown as AssuranceCaseRecord["engagement"],
    deliveryPacket: optionalObject(row.delivery_packet) as unknown as AssuranceCaseRecord["deliveryPacket"],
    continuousAssurance: optionalObject(row.continuous_assurance) as unknown as AssuranceCaseRecord["continuousAssurance"],
    publicVerificationId: optionalText(row.public_verification_id), expiresAt: optionalIso(row.expires_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function assuranceCaseDecisionFromRow(row: Record<string, unknown>): AssuranceCaseDecisionRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), assuranceCaseId: text(row.assurance_case_id),
    fromStatus: optionalText(row.from_status) as AssuranceCaseDecisionRecord["fromStatus"],
    toStatus: text(row.to_status) as AssuranceCaseDecisionRecord["toStatus"], actorId: text(row.actor_id),
    actorEmail: optionalText(row.actor_email), reason: text(row.reason), evidenceIds: stringArray(row.evidence_ids), occurredAt: iso(row.occurred_at),
  };
}

export class LegalHoldStateConflictError extends Error {
  constructor(readonly expectedStatus: LegalHoldRequestRecord["status"]) {
    super(`Legal hold status changed before the ${expectedStatus} transition completed.`);
    this.name = "LegalHoldStateConflictError";
  }
}
function evidenceSourcePath(evidence: EvidenceRecord): string | undefined {
  return typeof evidence.metadata.sourcePath === "string" ? evidence.metadata.sourcePath : undefined;
}
function retentionLockKey(projectId: string): string { return `agentcert-retention:${projectId}`; }
function legalHoldFromRow(row: Record<string, unknown>): LegalHoldRequestRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), status: text(row.status) as LegalHoldRequestRecord["status"],
    reason: text(row.reason), requestedBy: text(row.requested_by), requestedByEmail: optionalText(row.requested_by_email),
    requestedAt: iso(row.requested_at), reviewedBy: optionalText(row.reviewed_by), reviewedByEmail: optionalText(row.reviewed_by_email),
    reviewNote: optionalText(row.review_note), reviewedAt: optionalIso(row.reviewed_at), releasedBy: optionalText(row.released_by),
    releasedByEmail: optionalText(row.released_by_email), releaseNote: optionalText(row.release_note), releasedAt: optionalIso(row.released_at),
  };
}
function incidentQueryValues(incident: IncidentRecord): unknown[] {
  return [incident.id, incident.projectId, incident.agentId ?? null, incident.runId ?? null, incident.actionId ?? null, incident.severity,
    incident.type, incident.status, incident.summary, incident.firstDivergence ?? null, incident.fingerprint ?? null,
    incident.occurrenceCount, incident.consecutivePasses, incident.lastFailedAt ?? null, incident.lastPassedAt ?? null,
    incident.acknowledgedBy ?? null, incident.acknowledgedByEmail ?? null, incident.acknowledgedAt ?? null,
    incident.recoveredAt ?? null, incident.resolvedBy ?? null, incident.resolvedByEmail ?? null,
    incident.githubIssueNumber ?? null, incident.githubIssueUrl ?? null, incident.createdAt, incident.updatedAt, incident.resolvedAt ?? null];
}
function incidentUpdateQueryValues(incident: IncidentRecord): unknown[] {
  return [incident.projectId, incident.id, incident.status, incident.summary, incident.firstDivergence ?? null,
    incident.occurrenceCount, incident.consecutivePasses, incident.lastFailedAt ?? null, incident.lastPassedAt ?? null,
    incident.acknowledgedBy ?? null, incident.acknowledgedByEmail ?? null, incident.acknowledgedAt ?? null,
    incident.recoveredAt ?? null, incident.resolvedBy ?? null, incident.resolvedByEmail ?? null,
    incident.githubIssueNumber ?? null, incident.githubIssueUrl ?? null, incident.updatedAt, incident.resolvedAt ?? null];
}
function incidentTransitionQueryValues(transition: IncidentTransitionRecord): unknown[] {
  return [transition.id, transition.projectId, transition.incidentId, transition.fromStatus ?? null, transition.toStatus,
    transition.actorType, transition.actorId ?? null, transition.actorEmail ?? null, transition.reason,
    JSON.stringify(transition.evidence), transition.occurredAt];
}
function incidentFromRow(row: Record<string, unknown>): IncidentRecord {
  return { id: text(row.id), projectId: text(row.project_id), agentId: optionalText(row.agent_id), runId: optionalText(row.run_id), actionId: optionalText(row.action_id),
    severity: text(row.severity) as IncidentRecord["severity"], type: text(row.type), status: text(row.status) as IncidentRecord["status"], summary: text(row.summary),
    firstDivergence: optionalText(row.first_divergence), fingerprint: optionalText(row.fingerprint), occurrenceCount: optionalNumber(row.occurrence_count) ?? 1,
    consecutivePasses: optionalNumber(row.consecutive_passes) ?? 0, lastFailedAt: optionalIso(row.last_failed_at), lastPassedAt: optionalIso(row.last_passed_at),
    acknowledgedBy: optionalText(row.acknowledged_by), acknowledgedByEmail: optionalText(row.acknowledged_by_email), acknowledgedAt: optionalIso(row.acknowledged_at),
    recoveredAt: optionalIso(row.recovered_at), resolvedBy: optionalText(row.resolved_by), resolvedByEmail: optionalText(row.resolved_by_email),
    githubIssueNumber: optionalNumber(row.github_issue_number), githubIssueUrl: optionalText(row.github_issue_url),
    createdAt: iso(row.created_at), updatedAt: row.updated_at ? iso(row.updated_at) : iso(row.created_at), resolvedAt: optionalIso(row.resolved_at) };
}
function incidentTransitionFromRow(row: Record<string, unknown>): IncidentTransitionRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), incidentId: text(row.incident_id),
    fromStatus: optionalText(row.from_status) as IncidentTransitionRecord["fromStatus"],
    toStatus: text(row.to_status) as IncidentTransitionRecord["toStatus"], actorType: text(row.actor_type) as IncidentTransitionRecord["actorType"],
    actorId: optionalText(row.actor_id), actorEmail: optionalText(row.actor_email), reason: text(row.reason),
    evidence: object(row.evidence), occurredAt: iso(row.occurred_at),
  };
}
function notificationDestinationFromRow(row: Record<string, unknown>): NotificationDestinationRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), email: text(row.email),
    alertTypes: stringArray(row.alert_types) as NotificationDestinationRecord["alertTypes"],
    status: text(row.status) as NotificationDestinationRecord["status"], verificationTokenHash: optionalText(row.verification_token_hash),
    verificationExpiresAt: optionalIso(row.verification_expires_at), verifiedAt: optionalIso(row.verified_at),
    createdBy: text(row.created_by), createdAt: iso(row.created_at), disabledAt: optionalIso(row.disabled_at),
  };
}
function notificationDeliveryFromRow(row: Record<string, unknown>): NotificationDeliveryRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), destinationId: text(row.destination_id), jobId: optionalText(row.job_id),
    alertType: text(row.alert_type) as NotificationDeliveryRecord["alertType"], subject: text(row.subject),
    status: text(row.status) as NotificationDeliveryRecord["status"], provider: text(row.provider),
    providerMessageId: optionalText(row.provider_message_id), error: optionalText(row.error),
    attemptCount: optionalNumber(row.attempt_count) ?? 1, attemptedAt: iso(row.attempted_at),
  };
}
function notificationJobFromRow(row: Record<string, unknown>): NotificationJobRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), destinationId: text(row.destination_id),
    alertType: text(row.alert_type) as NotificationJobRecord["alertType"], recipient: text(row.recipient),
    subject: text(row.subject), text: text(row.text_body), html: text(row.html_body),
    status: text(row.status) as NotificationJobRecord["status"], attemptCount: number(row.attempt_count),
    maxAttempts: number(row.max_attempts), nextAttemptAt: iso(row.next_attempt_at), lockedAt: optionalIso(row.locked_at),
    lockedBy: optionalText(row.locked_by), provider: optionalText(row.provider), providerMessageId: optionalText(row.provider_message_id),
    lastError: optionalText(row.last_error), createdAt: iso(row.created_at), completedAt: optionalIso(row.completed_at),
  };
}
function apiKeyFromRow(row: Record<string, unknown>): ApiKeyRecord {
  return { id: text(row.id), projectId: text(row.project_id), name: text(row.name), prefix: text(row.prefix), secretHash: text(row.secret_hash), createdBy: text(row.created_by),
    createdAt: iso(row.created_at), scopes: stringArray(row.scopes) as ApiKeyRecord["scopes"], lastUsedAt: optionalIso(row.last_used_at), revokedAt: optionalIso(row.revoked_at) };
}

function evidenceDeletionFromRow(row: Record<string, unknown>): EvidenceDeletionRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), evidenceId: text(row.evidence_id), runId: optionalText(row.run_id),
    actionId: optionalText(row.action_id), objectKey: text(row.object_key), fileName: text(row.file_name), kind: text(row.kind),
    sha256: text(row.sha256), sizeBytes: number(row.size_bytes), outcome: text(row.outcome) as EvidenceDeletionRecord["outcome"],
    reason: text(row.reason), error: optionalText(row.error), occurredAt: iso(row.occurred_at),
  };
}

function idempotencyFromRow(row: Record<string, unknown>): IdempotencyRecord {
  return {
    projectId: text(row.project_id), key: text(row.key), operation: text(row.operation), requestHash: text(row.request_hash),
    responseStatus: number(row.response_status), responseBody: row.response_body, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
  };
}

function webhookFromRow(row: Record<string, unknown>): WebhookRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), url: text(row.url), eventTypes: stringArray(row.event_types),
    secretCiphertext: text(row.secret_ciphertext), createdBy: text(row.created_by), createdAt: iso(row.created_at), revokedAt: optionalIso(row.revoked_at),
  };
}

function webhookDeliveryFromRow(row: Record<string, unknown>): WebhookDeliveryRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), webhookId: text(row.webhook_id), eventId: text(row.event_id),
    eventType: text(row.event_type), status: text(row.status) as WebhookDeliveryRecord["status"], responseStatus: optionalNumber(row.response_status),
    error: optionalText(row.error), attemptedAt: iso(row.attempted_at),
  };
}

function webhookJobFromRow(row: Record<string, unknown>): WebhookJobRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), webhookId: text(row.webhook_id), eventId: text(row.event_id),
    eventType: text(row.event_type), payload: object(row.payload), status: text(row.status) as WebhookJobRecord["status"],
    attemptCount: number(row.attempt_count), maxAttempts: number(row.max_attempts), nextAttemptAt: iso(row.next_attempt_at),
    lockedAt: optionalIso(row.locked_at), lockedBy: optionalText(row.locked_by), lastResponseStatus: optionalNumber(row.last_response_status),
    lastError: optionalText(row.last_error), createdAt: iso(row.created_at), completedAt: optionalIso(row.completed_at),
  };
}

function signingKeyFromRow(row: Record<string, unknown>): SigningKeyRecord {
  return {
    keyId: text(row.key_id), algorithm: text(row.algorithm) as "Ed25519", publicKeyPem: text(row.public_key_pem),
    status: text(row.status) as SigningKeyRecord["status"], createdAt: iso(row.created_at), activatedAt: iso(row.activated_at),
    retiredAt: optionalIso(row.retired_at), revokedAt: optionalIso(row.revoked_at),
  };
}

function collectorSourceKeyFromRow(row: Record<string, unknown>): CollectorSourceKeyRecord {
  return {
    projectId: text(row.project_id), collectorId: text(row.collector_id), keyId: text(row.key_id), algorithm: "Ed25519",
    publicKeyPem: text(row.public_key_pem), publicKeySha256: text(row.public_key_sha256),
    status: text(row.status) as CollectorSourceKeyRecord["status"], previousKeyId: optionalText(row.previous_key_id),
    createdAt: iso(row.created_at), activatedAt: iso(row.activated_at), retiredAt: optionalIso(row.retired_at), revokedAt: optionalIso(row.revoked_at),
  };
}

function trustedCollectorRecordFromRow(row: Record<string, unknown>): TrustedCollectorRecord {
  return {
    projectId: text(row.project_id), runId: text(row.run_id), sequence: number(row.sequence), recordId: text(row.record_id),
    eventHash: text(row.event_hash), previousEventHash: optionalText(row.previous_event_hash), sourceKeyId: text(row.source_key_id),
    record: object(row.record) as unknown as TrustedSourceRecord, receivedAt: iso(row.received_at),
  };
}

function trustedCollectorRunFromRow(row: Record<string, unknown>): TrustedCollectorRunRecord {
  return {
    projectId: text(row.project_id), runId: text(row.run_id), collectorId: text(row.collector_id), sourceKeyId: text(row.source_key_id),
    status: text(row.status) as TrustedCollectorRunRecord["status"], firstSequence: number(row.first_sequence), lastSequence: number(row.last_sequence),
    firstEventHash: text(row.first_event_hash), lastEventHash: text(row.last_event_hash), acceptedEventCount: number(row.accepted_event_count),
    droppedEventCount: number(row.dropped_event_count), startedAt: iso(row.started_at), completedAt: optionalIso(row.completed_at),
    sourceReceipt: optionalObject(row.source_receipt), reconciliation: optionalObject(row.reconciliation), serverAttestation: optionalObject(row.server_attestation),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function collectorHeartbeatFromRow(row: Record<string, unknown>): CollectorHeartbeatRecord {
  return {
    projectId: text(row.project_id), collectorId: text(row.collector_id), sourceKeyId: text(row.source_key_id), runId: optionalText(row.run_id),
    occurredAt: iso(row.occurred_at), receivedAt: iso(row.received_at), pendingRecordCount: number(row.pending_record_count),
    lastAckSequence: optionalNumber(row.last_ack_sequence), status: text(row.status) as CollectorHeartbeatRecord["status"],
  };
}

function trustedCollectorAlertFromRow(row: Record<string, unknown>): TrustedCollectorAlertRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), collectorId: text(row.collector_id), runId: optionalText(row.run_id),
    kind: text(row.kind) as TrustedCollectorAlertRecord["kind"], severity: text(row.severity) as TrustedCollectorAlertRecord["severity"],
    message: text(row.message), details: object(row.details), createdAt: iso(row.created_at),
  };
}

function collectorAlert(
  projectId: string,
  collectorId: string,
  runId: string | undefined,
  kind: TrustedCollectorAlertRecord["kind"],
  severity: TrustedCollectorAlertRecord["severity"],
  message: string,
  details: Record<string, unknown>,
  createdAt: string,
): TrustedCollectorAlertRecord {
  return { id: randomUUID(), projectId, collectorId, runId, kind, severity, message, details, createdAt };
}

async function insertCollectorAlert(client: pg.Pool | pg.PoolClient, alert: TrustedCollectorAlertRecord): Promise<void> {
  await client.query(
    `INSERT INTO agentcert_trusted_collector_alerts (id,project_id,collector_id,run_id,kind,severity,message,details,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [alert.id, alert.projectId, alert.collectorId, alert.runId ?? null, alert.kind, alert.severity, alert.message, JSON.stringify(alert.details), alert.createdAt],
  );
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function assuranceMaintenanceDue(item: AssuranceCaseRecord, now: string, before: string): boolean {
  if (item.status !== "issued" || !item.continuousAssurance || !item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  const nowAt = Date.parse(now);
  if (!Number.isFinite(expiresAt) || expiresAt > Date.parse(before)) return false;
  if (expiresAt <= nowAt) return true;
  if (item.continuousAssurance.freshness.status !== "CURRENT") return false;
  const remainingMs = expiresAt - nowAt;
  const threshold = ([1, 7, 30] as const).find((days) => remainingMs <= days * 86_400_000);
  return threshold !== undefined && !(item.continuousAssurance.reminders?.expiryThresholdDaysSent ?? []).includes(threshold);
}
function trustHealthSampleFromRow(row: Record<string, unknown>): TrustHealthSampleRecord {
  return {
    id: text(row.id), projectId: text(row.project_id), externalId: text(row.external_id),
    source: text(row.source) as TrustHealthSampleRecord["source"], status: text(row.status) as TrustHealthSampleRecord["status"],
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at), durationMs: number(row.duration_ms),
    checks: stringArray(row.checks), error: optionalText(row.error), workflowRunId: optionalText(row.workflow_run_id),
    workflowRunUrl: optionalText(row.workflow_run_url), createdAt: iso(row.created_at),
  };
}
function emptyWebhookJobCounts(): WebhookJobCounts {
  return { pending: 0, processing: 0, retrying: 0, delivered: 0, dead_letter: 0 };
}

function emptyNotificationJobCounts(): NotificationJobCounts {
  return { pending: 0, processing: 0, retrying: 0, delivered: 0, dead_letter: 0 };
}

function calculateWebhookOperationsMetrics(jobs: WebhookJobRecord[]): WebhookOperationsMetrics {
  const grouped = new Map<string, WebhookJobRecord[]>();
  for (const job of jobs) {
    const date = job.createdAt.slice(0, 10);
    grouped.set(date, [...(grouped.get(date) ?? []), job]);
  }
  const buckets = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, items]) => {
    const latencies = items.filter((item) => item.status === "delivered" && item.completedAt)
      .map((item) => Math.max(0, Date.parse(item.completedAt!) - Date.parse(item.createdAt))).sort((left, right) => left - right);
    return {
      date, total: items.length, delivered: items.filter((item) => item.status === "delivered").length,
      retried: items.filter((item) => item.attemptCount > 1).length,
      deadLetter: items.filter((item) => item.status === "dead_letter").length,
      averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
      p95LatencyMs: percentile(latencies, 0.95),
    };
  });
  const latencies = jobs.filter((item) => item.status === "delivered" && item.completedAt)
    .map((item) => Math.max(0, Date.parse(item.completedAt!) - Date.parse(item.createdAt))).sort((left, right) => left - right);
  return {
    total: jobs.length, delivered: jobs.filter((item) => item.status === "delivered").length,
    retried: jobs.filter((item) => item.attemptCount > 1).length,
    deadLetter: jobs.filter((item) => item.status === "dead_letter").length,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    p95LatencyMs: percentile(latencies, 0.95),
    buckets,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
}
function failureReviewFromRow(row: Record<string, unknown>): FailureReviewRecord {
  const context = object(row.evidence_context);
  const rationale = object(row.taxonomy_rationale);
  return {
    id: text(row.id), projectId: text(row.project_id), runId: text(row.run_id), patternKey: text(row.pattern_key),
    suggestedType: optionalText(row.suggested_type), type: text(row.type) as FailureReviewRecord["type"],
    status: text(row.status) as FailureReviewRecord["status"], reviewerId: text(row.reviewer_id), reviewer: text(row.reviewer),
    note: optionalText(row.note), confidence: optionalNumber(row.confidence),
    evidenceContext: {
      firstDivergenceSnippet: optionalText(context.firstDivergenceSnippet),
      screenshotPointer: optionalText(context.screenshotPointer),
      tracePointer: optionalText(context.tracePointer),
      stepIndex: optionalNumber(context.stepIndex),
    },
    taxonomyRationale: {
      primaryReason: text(rationale.primaryReason),
      supportingSignals: stringArray(rationale.supportingSignals),
      contradictingSignals: stringArray(rationale.contradictingSignals),
      classifierLimitation: optionalText(rationale.classifierLimitation),
    },
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
function bootstrapFromRow(row: Record<string, unknown>): BootstrapResult {
  const organization: Organization = { id: text(row.id), name: text(row.name), slug: text(row.slug), createdAt: iso(row.created_at) };
  const project: Project = { id: text(row.project_id), organizationId: organization.id, name: text(row.project_name), slug: text(row.project_slug), createdAt: iso(row.project_created_at) };
  const membership: Membership = { organizationId: organization.id, userId: text(row.user_id), email: optionalText(row.membership_email), role: text(row.role) as MemberRole, createdAt: iso(row.membership_created_at) };
  return { organization, project, membership };
}

async function one<T>(query: Promise<pg.QueryResult>, map: (row: Record<string, unknown>) => T): Promise<T | undefined> {
  const result = await query;
  return result.rows[0] ? map(result.rows[0]) : undefined;
}
async function many<T>(query: Promise<pg.QueryResult>, map: (row: Record<string, unknown>) => T): Promise<T[]> {
  return (await query).rows.map(map);
}
function newest<T extends Record<K, string>, K extends keyof T>(values: T[], key: K): T[] {
  return values.sort((left, right) => right[key].localeCompare(left[key]));
}
function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
function uniqueSlug(value: string, existing: string[]): string {
  const base = slugify(value);
  return existing.includes(base) ? `${base}-${randomUUID().slice(0, 6)}` : base;
}
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}
function text(value: unknown): string { return String(value); }
function optionalText(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function number(value: unknown): number { return Number(value); }
function optionalNumber(value: unknown): number | undefined { return value === null || value === undefined ? undefined : Number(value); }
function optionalBoolean(value: unknown): boolean | undefined { return value === null || value === undefined ? undefined : Boolean(value); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalIso(value: unknown): string | undefined { return value === null || value === undefined ? undefined : iso(value); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function optionalObject(value: unknown): Record<string, unknown> | undefined { return value === null || value === undefined ? undefined : object(value); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function jsonOrNull(value: unknown): string | null { return value === undefined ? null : JSON.stringify(value); }
