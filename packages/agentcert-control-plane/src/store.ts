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
] as const;

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

export interface ControlPlaneStore {
  migrate(): Promise<void>;
  bootstrapUser(userId: string, email?: string): Promise<BootstrapResult>;
  listProjectsForUser(userId: string): Promise<Project[]>;
  roleForProject(userId: string, projectId: string): Promise<MemberRole | undefined>;
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
  verifyNotificationDestination(tokenHash: string, now: string): Promise<NotificationDestinationRecord | undefined>;
  listNotificationDestinations(projectId: string): Promise<NotificationDestinationRecord[]>;
  disableNotificationDestination(projectId: string, destinationId: string, disabledAt: string): Promise<NotificationDestinationRecord | undefined>;
  insertNotificationDelivery(delivery: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord>;
  listNotificationDeliveries(projectId: string, limit?: number): Promise<NotificationDeliveryRecord[]>;
  activateSigningKey(key: SigningKeyRecord): Promise<SigningKeyRecord>;
  getSigningKey(keyId: string): Promise<SigningKeyRecord | undefined>;
  listSigningKeys(): Promise<SigningKeyRecord[]>;
  insertApiKey(apiKey: ApiKeyRecord): Promise<ApiKeyRecord>;
  findApiKeyByHash(secretHash: string): Promise<ApiKeyRecord | undefined>;
  touchApiKey(apiKeyId: string, usedAt: string): Promise<void>;
  listApiKeys(projectId: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(projectId: string, apiKeyId: string, revokedAt: string): Promise<ApiKeyRecord | undefined>;
  close(): Promise<void>;
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private organizations = new Map<string, Organization>();
  private memberships = new Map<string, Membership>();
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
  private signingKeys = new Map<string, SigningKeyRecord>();
  private retentionLocks = new Map<string, Promise<void>>();

  async migrate(): Promise<void> {}

  async bootstrapUser(userId: string, email?: string): Promise<BootstrapResult> {
    const existing = [...this.memberships.values()].find((item) => item.userId === userId);
    if (existing) {
      const organization = required(this.organizations.get(existing.organizationId), "organization");
      const project = required(
        [...this.projects.values()].find((item) => item.organizationId === organization.id),
        "project",
      );
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
      name: "First project",
      slug: "first-project",
      createdAt: now,
    };
    const membership: Membership = { organizationId: organization.id, userId, role: "owner", createdAt: now };
    this.organizations.set(organization.id, organization);
    this.projects.set(project.id, project);
    this.memberships.set(`${organization.id}:${userId}`, membership);
    return { organization, project, membership };
  }

  async listProjectsForUser(userId: string): Promise<Project[]> {
    const organizationIds = new Set(
      [...this.memberships.values()].filter((item) => item.userId === userId).map((item) => item.organizationId),
    );
    return [...this.projects.values()].filter((item) => organizationIds.has(item.organizationId));
  }

  async roleForProject(userId: string, projectId: string): Promise<MemberRole | undefined> {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    return this.memberships.get(`${project.organizationId}:${userId}`)?.role;
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

  async verifyNotificationDestination(tokenHash: string, now: string): Promise<NotificationDestinationRecord | undefined> {
    const destination = [...this.notificationDestinations.values()].find((item) => item.verificationTokenHash === tokenHash && item.verificationExpiresAt && item.verificationExpiresAt >= now && item.status === "pending_verification");
    if (!destination) return undefined;
    const verified = { ...destination, status: "active" as const, verificationTokenHash: undefined, verificationExpiresAt: undefined, verifiedAt: now };
    this.notificationDestinations.set(destination.id, verified);
    return verified;
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
    const existing = await this.pool.query(
      `SELECT o.*, m.user_id, m.role, m.created_at AS membership_created_at, p.id AS project_id,
              p.name AS project_name, p.slug AS project_slug, p.created_at AS project_created_at
       FROM agentcert_memberships m
       JOIN agentcert_organizations o ON o.id = m.organization_id
       JOIN agentcert_projects p ON p.organization_id = o.id
       WHERE m.user_id = $1 ORDER BY p.created_at ASC LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]) return bootstrapFromRow(existing.rows[0]);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
      const concurrentExisting = await client.query(
        `SELECT o.*, m.user_id, m.role, m.created_at AS membership_created_at, p.id AS project_id,
                p.name AS project_name, p.slug AS project_slug, p.created_at AS project_created_at
         FROM agentcert_memberships m
         JOIN agentcert_organizations o ON o.id = m.organization_id
         JOIN agentcert_projects p ON p.organization_id = o.id
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
        name: "First project",
        slug: "first-project",
        createdAt: now,
      };
      const membership: Membership = { organizationId: organization.id, userId, role: "owner", createdAt: now };
      await client.query("INSERT INTO agentcert_organizations (id,name,slug,created_at) VALUES ($1,$2,$3,$4)", [
        organization.id,
        organization.name,
        organization.slug,
        organization.createdAt,
      ]);
      await client.query(
        "INSERT INTO agentcert_memberships (organization_id,user_id,role,created_at) VALUES ($1,$2,$3,$4)",
        [organization.id, userId, membership.role, now],
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
       WHERE m.user_id=$1 ORDER BY p.created_at ASC`,
      [userId],
    );
    return result.rows.map(projectFromRow);
  }

  async roleForProject(userId: string, projectId: string): Promise<MemberRole | undefined> {
    const result = await this.pool.query(
      `SELECT m.role FROM agentcert_memberships m JOIN agentcert_projects p ON p.organization_id=m.organization_id
       WHERE m.user_id=$1 AND p.id=$2`,
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
         verification_success=$6,updated_at=$7 WHERE id=$1`,
        [action.id, action.decision, action.status, JSON.stringify(action.reasons), jsonOrNull(action.observedState), action.verificationSuccess ?? null, action.updatedAt],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO agentcert_actions (id,project_id,agent_id,external_id,principal,action_type,target_system,requested_permissions,
       amount,currency,risk_level,risk_score,decision,status,policy_version,reasons,expected_state,observed_state,verification_success,created_at,updated_at,trace_id,span_id,parent_span_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [action.id, action.projectId, action.agentId ?? null, action.externalId, JSON.stringify(action.principal), action.actionType, action.targetSystem,
       JSON.stringify(action.requestedPermissions), action.amount ?? null, action.currency ?? null, action.riskLevel, action.riskScore, action.decision,
       action.status, action.policyVersion, JSON.stringify(action.reasons), jsonOrNull(action.expectedState), jsonOrNull(action.observedState),
       action.verificationSuccess ?? null, action.createdAt, action.updatedAt, action.traceId ?? null, action.spanId ?? null, action.parentSpanId ?? null],
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

  async verifyNotificationDestination(tokenHash: string, now: string): Promise<NotificationDestinationRecord | undefined> {
    return one(this.pool.query(
      `UPDATE agentcert_notification_destinations SET status='active',verification_token_hash=NULL,
       verification_expires_at=NULL,verified_at=$2 WHERE verification_token_hash=$1 AND status='pending_verification'
       AND verification_expires_at >= $2 RETURNING *`,
      [tokenHash, now],
    ), notificationDestinationFromRow);
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
       (id,project_id,destination_id,alert_type,subject,status,provider,provider_message_id,error,attempted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [delivery.id, delivery.projectId, delivery.destinationId, delivery.alertType, delivery.subject, delivery.status,
       delivery.provider, delivery.providerMessageId ?? null, delivery.error ?? null, delivery.attemptedAt],
    );
    return notificationDeliveryFromRow(result.rows[0]);
  }

  async listNotificationDeliveries(projectId: string, limit = 100): Promise<NotificationDeliveryRecord[]> {
    return many(this.pool.query(
      "SELECT * FROM agentcert_notification_deliveries WHERE project_id=$1 ORDER BY attempted_at DESC LIMIT $2",
      [projectId, limit],
    ), notificationDeliveryFromRow);
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function projectFromRow(row: Record<string, unknown>): Project {
  return { id: text(row.id), organizationId: text(row.organization_id), name: text(row.name), slug: text(row.slug), createdAt: iso(row.created_at) };
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
    traceId: optionalText(row.trace_id), spanId: optionalText(row.span_id), parentSpanId: optionalText(row.parent_span_id) };
}
function evidenceFromRow(row: Record<string, unknown>): EvidenceRecord {
  return { id: text(row.id), projectId: text(row.project_id), runId: optionalText(row.run_id), actionId: optionalText(row.action_id), kind: text(row.kind),
    schemaVersion: text(row.schema_version), objectKey: text(row.object_key), fileName: text(row.file_name), contentType: text(row.content_type), sha256: text(row.sha256),
    sizeBytes: number(row.size_bytes), metadata: object(row.metadata), createdAt: iso(row.created_at) };
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
    id: text(row.id), projectId: text(row.project_id), destinationId: text(row.destination_id),
    alertType: text(row.alert_type) as NotificationDeliveryRecord["alertType"], subject: text(row.subject),
    status: text(row.status) as NotificationDeliveryRecord["status"], provider: text(row.provider),
    providerMessageId: optionalText(row.provider_message_id), error: optionalText(row.error), attemptedAt: iso(row.attempted_at),
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
  const membership: Membership = { organizationId: organization.id, userId: text(row.user_id), role: text(row.role) as MemberRole, createdAt: iso(row.membership_created_at) };
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
