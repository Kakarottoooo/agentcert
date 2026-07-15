import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  ActionRecord,
  AgentRecord,
  ApiKeyRecord,
  ApprovalRecord,
  EvidenceRecord,
  EvidenceStorageUsage,
  FailureReviewRecord,
  IncidentRecord,
  LegalHoldRequestRecord,
  Membership,
  Organization,
  Project,
  RunRecord,
  EventRecord,
  MemberRole,
} from "./types.js";

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
  getApprovedLegalHold(projectId: string): Promise<LegalHoldRequestRecord | undefined>;
  insertIncident(incident: IncidentRecord): Promise<IncidentRecord>;
  listIncidents(projectId: string, limit?: number): Promise<IncidentRecord[]>;
  listIncidentsForRun(projectId: string, runId: string): Promise<IncidentRecord[]>;
  upsertFailureReview(review: FailureReviewRecord): Promise<FailureReviewRecord>;
  listFailureReviews(projectId: string, runId: string): Promise<FailureReviewRecord[]>;
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
  private failureReviews = new Map<string, FailureReviewRecord>();
  private apiKeys = new Map<string, ApiKeyRecord>();
  private legalHoldRequests = new Map<string, LegalHoldRequestRecord>();
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

  async listIncidents(projectId: string, limit = 100): Promise<IncidentRecord[]> {
    return newest([...this.incidents.values()].filter((item) => item.projectId === projectId), "createdAt").slice(0, limit);
  }

  async listIncidentsForRun(projectId: string, runId: string): Promise<IncidentRecord[]> {
    return newest(
      [...this.incidents.values()].filter((item) => item.projectId === projectId && item.runId === runId),
      "createdAt",
    );
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
    for (const name of ["001_initial.sql", "002_failure_reviews.sql", "003_evidence_retention.sql", "004_legal_holds.sql"]) {
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
      `INSERT INTO agentcert_runs (id,project_id,agent_id,external_id,kind,status,score,schema_version,started_at,completed_at,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (project_id,external_id) DO UPDATE SET status=excluded.status,score=excluded.score,
       completed_at=excluded.completed_at,metadata=excluded.metadata RETURNING *`,
      [run.id, run.projectId, run.agentId ?? null, run.externalId, run.kind, run.status, run.score ?? null, run.schemaVersion, run.startedAt, run.completedAt ?? null, JSON.stringify(run.metadata)],
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
          `INSERT INTO agentcert_events (id,project_id,run_id,sequence,type,actor,occurred_at,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id,sequence) DO UPDATE SET
           type=excluded.type,actor=excluded.actor,occurred_at=excluded.occurred_at,payload=excluded.payload`,
          [event.id, event.projectId, event.runId, event.sequence, event.type, event.actor, event.occurredAt, JSON.stringify(event.payload)],
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
       amount,currency,risk_level,risk_score,decision,status,policy_version,reasons,expected_state,observed_state,verification_success,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [action.id, action.projectId, action.agentId ?? null, action.externalId, JSON.stringify(action.principal), action.actionType, action.targetSystem,
       JSON.stringify(action.requestedPermissions), action.amount ?? null, action.currency ?? null, action.riskLevel, action.riskScore, action.decision,
       action.status, action.policyVersion, JSON.stringify(action.reasons), jsonOrNull(action.expectedState), jsonOrNull(action.observedState),
       action.verificationSuccess ?? null, action.createdAt, action.updatedAt],
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
    await this.pool.query(
      `INSERT INTO agentcert_incidents (id,project_id,agent_id,run_id,action_id,severity,type,status,summary,first_divergence,created_at,resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [incident.id, incident.projectId, incident.agentId ?? null, incident.runId ?? null, incident.actionId ?? null, incident.severity,
       incident.type, incident.status, incident.summary, incident.firstDivergence ?? null, incident.createdAt, incident.resolvedAt ?? null],
    );
    return incident;
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

  async insertApiKey(apiKey: ApiKeyRecord): Promise<ApiKeyRecord> {
    await this.pool.query(
      `INSERT INTO agentcert_api_keys (id,project_id,name,prefix,secret_hash,created_by,created_at,last_used_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [apiKey.id, apiKey.projectId, apiKey.name, apiKey.prefix, apiKey.secretHash, apiKey.createdBy, apiKey.createdAt, null, null],
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
    completedAt: optionalIso(row.completed_at), metadata: object(row.metadata) };
}
function eventFromRow(row: Record<string, unknown>): EventRecord {
  return { id: text(row.id), projectId: text(row.project_id), runId: text(row.run_id), sequence: number(row.sequence), type: text(row.type), actor: text(row.actor), occurredAt: iso(row.occurred_at), payload: object(row.payload) };
}
function actionFromRow(row: Record<string, unknown>): ActionRecord {
  return { id: text(row.id), projectId: text(row.project_id), agentId: optionalText(row.agent_id), externalId: text(row.external_id), principal: object(row.principal),
    actionType: text(row.action_type) as ActionRecord["actionType"], targetSystem: text(row.target_system), requestedPermissions: stringArray(row.requested_permissions),
    amount: optionalNumber(row.amount), currency: optionalText(row.currency), riskLevel: text(row.risk_level) as ActionRecord["riskLevel"], riskScore: number(row.risk_score),
    decision: text(row.decision) as ActionRecord["decision"], status: text(row.status) as ActionRecord["status"], policyVersion: text(row.policy_version),
    reasons: stringArray(row.reasons), expectedState: optionalObject(row.expected_state), observedState: optionalObject(row.observed_state),
    verificationSuccess: optionalBoolean(row.verification_success), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
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
function incidentFromRow(row: Record<string, unknown>): IncidentRecord {
  return { id: text(row.id), projectId: text(row.project_id), agentId: optionalText(row.agent_id), runId: optionalText(row.run_id), actionId: optionalText(row.action_id),
    severity: text(row.severity) as IncidentRecord["severity"], type: text(row.type), status: text(row.status) as IncidentRecord["status"], summary: text(row.summary),
    firstDivergence: optionalText(row.first_divergence), createdAt: iso(row.created_at), resolvedAt: optionalIso(row.resolved_at) };
}
function apiKeyFromRow(row: Record<string, unknown>): ApiKeyRecord {
  return { id: text(row.id), projectId: text(row.project_id), name: text(row.name), prefix: text(row.prefix), secretHash: text(row.secret_hash), createdBy: text(row.created_by),
    createdAt: iso(row.created_at), lastUsedAt: optionalIso(row.last_used_at), revokedAt: optionalIso(row.revoked_at) };
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
