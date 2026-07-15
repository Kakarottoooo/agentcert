import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ArtifactStore } from "./artifacts.js";
import { hashSecret } from "./auth.js";
import {
  EvidenceQuotaExceededError,
  LegalHoldStateConflictError,
  type BootstrapResult,
  type ControlPlaneStore,
} from "./store.js";
import {
  ACCEPTED_EVIDENCE_FORMATS,
  DEFAULT_EVIDENCE_GOVERNANCE_POLICY,
  EvidenceUploadValidationError,
  assertArtifactMatchesManifest,
  calculateEvidenceCompleteness,
  manifestFromMetadata,
  validateEvidenceUpload,
  type EvidenceGovernancePolicy,
} from "./evidence-governance.js";
import type {
  ActionDecision,
  ActionRecord,
  AgentRecord,
  ApiKeyRecord,
  ApprovalRecord,
  AuthContext,
  EventRecord,
  EvidenceRecord,
  FailureReviewRecord,
  FailureType,
  IncidentRecord,
  LegalHoldRequestRecord,
  RunKind,
  RunRecord,
  RunStatus,
  PublicApiKeyRecord,
} from "./types.js";

const POLICY_VERSION = "agentcert.default.v1";

export class ControlPlaneError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export class AgentCertControlPlane {
  readonly platformAdminEmails: ReadonlySet<string>;

  constructor(
    readonly store: ControlPlaneStore,
    readonly artifacts: ArtifactStore,
    readonly evidencePolicy: EvidenceGovernancePolicy = DEFAULT_EVIDENCE_GOVERNANCE_POLICY,
    platformAdminEmails: Iterable<string> = [],
  ) {
    this.platformAdminEmails = new Set([...platformAdminEmails].map((email) => email.trim().toLowerCase()).filter(Boolean));
  }

  async bootstrap(auth: AuthContext): Promise<BootstrapResult> {
    requireUser(auth);
    return this.store.bootstrapUser(auth.userId, auth.email);
  }

  async projects(auth: AuthContext) {
    requireUser(auth);
    return this.store.listProjectsForUser(auth.userId);
  }

  async authorizeProject(auth: AuthContext, projectId: string, roles?: string[]): Promise<void> {
    if (auth.kind === "api_key") {
      if (auth.projectId !== projectId) throw new ControlPlaneError("API key is not scoped to this project.", 403);
      if (roles) throw new ControlPlaneError("This operation requires a human account.", 403);
      return;
    }
    requireUser(auth);
    const role = await this.store.roleForProject(auth.userId, projectId);
    if (!role) throw new ControlPlaneError("Project access denied.", 403);
    if (roles && !roles.includes(role)) throw new ControlPlaneError(`Project role ${role} cannot perform this operation.`, 403);
  }

  async createAgent(auth: AuthContext, projectId: string, input: unknown): Promise<AgentRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const body = record(input);
    const now = new Date().toISOString();
    return this.store.upsertAgent({
      id: randomUUID(),
      projectId,
      externalId: requiredString(body, "externalId"),
      name: requiredString(body, "name"),
      version: optionalString(body, "version") ?? "unversioned",
      framework: optionalString(body, "framework"),
      allowedPermissions: stringList(body.allowedPermissions),
      createdAt: now,
      updatedAt: now,
    });
  }

  async listAgents(auth: AuthContext, projectId: string): Promise<AgentRecord[]> {
    await this.authorizeProject(auth, projectId);
    return this.store.listAgents(projectId);
  }

  async startRun(auth: AuthContext, projectId: string, input: unknown): Promise<RunRecord> {
    await this.authorizeProject(auth, projectId);
    const body = record(input);
    const externalId = requiredString(body, "externalId");
    const existing = await this.store.getRunByExternalId(projectId, externalId);
    if (existing) return existing;
    const agentId = optionalString(body, "agentId");
    if (agentId && !(await this.store.getAgent(projectId, agentId))) throw new ControlPlaneError("Agent was not found.", 404);
    const run: RunRecord = {
      id: randomUUID(),
      projectId,
      agentId,
      externalId,
      kind: runKind(body.kind),
      status: "running",
      schemaVersion: optionalString(body, "schemaVersion") ?? "agentcert.run.v1",
      startedAt: optionalString(body, "startedAt") ?? new Date().toISOString(),
      metadata: record(body.metadata),
    };
    return this.store.upsertRun(run);
  }

  async appendEvents(auth: AuthContext, projectId: string, runId: string, input: unknown): Promise<EventRecord[]> {
    await this.authorizeProject(auth, projectId);
    if (!(await this.store.getRun(projectId, runId))) throw new ControlPlaneError("Run was not found.", 404);
    const body = record(input);
    const rawEvents = Array.isArray(body.events) ? body.events : [];
    if (rawEvents.length === 0 || rawEvents.length > 500) throw new ControlPlaneError("events must contain 1 to 500 records.");
    const events = rawEvents.map((value, index): EventRecord => {
      const event = record(value);
      return {
        id: randomUUID(),
        projectId,
        runId,
        sequence: integer(event.sequence, index),
        type: requiredString(event, "type"),
        actor: optionalString(event, "actor") ?? "agent",
        occurredAt: optionalString(event, "occurredAt") ?? new Date().toISOString(),
        payload: record(event.payload),
      };
    });
    return this.store.appendEvents(events);
  }

  async completeRun(auth: AuthContext, projectId: string, runId: string, input: unknown): Promise<RunRecord> {
    await this.authorizeProject(auth, projectId);
    const current = await this.store.getRun(projectId, runId);
    if (!current) throw new ControlPlaneError("Run was not found.", 404);
    const body = record(input);
    const status = runStatus(body.status);
    if (current.completedAt) {
      if (current.status === status) return current;
      throw new ControlPlaneError(`Completed run status cannot change from ${current.status} to ${status}.`, 409);
    }
    const next = await this.store.upsertRun({
      ...current,
      status,
      score: optionalNumber(body, "score"),
      completedAt: optionalString(body, "completedAt") ?? new Date().toISOString(),
      metadata: { ...current.metadata, ...record(body.metadata) },
    });
    if (status === "failed") {
      await this.store.insertIncident({
        id: randomUUID(), projectId, agentId: current.agentId, runId: current.id, severity: "high", type: "run_failure", status: "open",
        summary: optionalString(body, "summary") ?? `${current.kind} run failed.`, firstDivergence: optionalString(body, "firstDivergence"), createdAt: new Date().toISOString(),
      });
    }
    return next;
  }

  async listRuns(auth: AuthContext, projectId: string): Promise<RunRecord[]> {
    await this.authorizeProject(auth, projectId);
    return this.store.listRuns(projectId);
  }

  async runDetail(auth: AuthContext, projectId: string, runId: string) {
    await this.authorizeProject(auth, projectId);
    const run = await this.store.getRun(projectId, runId);
    if (!run) throw new ControlPlaneError("Run was not found.", 404);
    return { run, events: await this.store.listEvents(projectId, runId) };
  }

  async runAnalysis(auth: AuthContext, projectId: string, runId: string) {
    await this.authorizeProject(auth, projectId);
    const run = await this.store.getRun(projectId, runId);
    if (!run) throw new ControlPlaneError("Run was not found.", 404);
    const [events, evidence, incidents, reviews, legalHold] = await Promise.all([
      this.store.listEvents(projectId, runId),
      this.store.listEvidenceForRun(projectId, runId),
      this.store.listIncidentsForRun(projectId, runId),
      this.store.listFailureReviews(projectId, runId),
      this.store.getApprovedLegalHold(projectId),
    ]);
    return {
      run,
      events,
      evidence,
      incidents,
      reviews,
      evidenceCompleteness: calculateEvidenceCompleteness(run, events, evidence, this.evidencePolicy, Boolean(legalHold)),
    };
  }

  async reviewFailure(auth: AuthContext, projectId: string, runId: string, input: unknown): Promise<FailureReviewRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin", "reviewer"]);
    requireUser(auth);
    if (!(await this.store.getRun(projectId, runId))) throw new ControlPlaneError("Run was not found.", 404);
    const body = record(input);
    const evidenceContext = record(body.evidenceContext);
    const taxonomyRationale = record(body.taxonomyRationale);
    const confidence = optionalNumber(body, "confidence");
    if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
      throw new ControlPlaneError("confidence must be between 0 and 1.");
    }
    const now = new Date().toISOString();
    return this.store.upsertFailureReview({
      id: randomUUID(),
      projectId,
      runId,
      patternKey: requiredString(body, "patternKey"),
      suggestedType: optionalString(body, "suggestedType"),
      type: failureType(body.type),
      status: failureReviewStatus(body.status),
      reviewerId: auth.userId,
      reviewer: auth.email ?? auth.userId,
      note: optionalString(body, "note"),
      confidence,
      evidenceContext: {
        firstDivergenceSnippet: optionalString(evidenceContext, "firstDivergenceSnippet"),
        screenshotPointer: optionalString(evidenceContext, "screenshotPointer"),
        tracePointer: optionalString(evidenceContext, "tracePointer"),
        stepIndex: optionalNonNegativeInteger(evidenceContext.stepIndex),
      },
      taxonomyRationale: {
        primaryReason: requiredString(taxonomyRationale, "primaryReason"),
        supportingSignals: stringList(taxonomyRationale.supportingSignals),
        contradictingSignals: stringList(taxonomyRationale.contradictingSignals),
        classifierLimitation: optionalString(taxonomyRationale, "classifierLimitation"),
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  async proposeAction(auth: AuthContext, projectId: string, input: unknown): Promise<ActionRecord> {
    await this.authorizeProject(auth, projectId);
    const body = record(input);
    const agentId = optionalString(body, "agentId");
    const agent = agentId ? await this.store.getAgent(projectId, agentId) : undefined;
    if (agentId && !agent) throw new ControlPlaneError("Agent was not found.", 404);
    const actionType = actionTypeValue(body.actionType);
    const requestedPermissions = stringList(body.requestedPermissions);
    const amount = optionalNumber(body, "amount");
    const assessment = assessAction(actionType, amount, body, requestedPermissions, agent?.allowedPermissions ?? []);
    const now = new Date().toISOString();
    return this.store.insertAction({
      id: randomUUID(), projectId, agentId, externalId: requiredString(body, "externalId"), principal: record(body.principal), actionType,
      targetSystem: requiredString(body, "targetSystem"), requestedPermissions, amount, currency: optionalString(body, "currency"),
      riskLevel: assessment.riskLevel, riskScore: assessment.riskScore, decision: assessment.decision,
      status: assessment.decision === "ALLOW" ? "ALLOWED" : assessment.decision === "DENY" ? "DENIED" : "PENDING_APPROVAL",
      policyVersion: POLICY_VERSION, reasons: assessment.reasons, expectedState: optionalRecord(body.expectedState), createdAt: now, updatedAt: now,
    });
  }

  async reviewAction(auth: AuthContext, projectId: string, actionId: string, approved: boolean, input: unknown): Promise<ActionRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin", "reviewer"]);
    requireUser(auth);
    const action = await this.store.getAction(projectId, actionId);
    if (!action) throw new ControlPlaneError("Action was not found.", 404);
    if (action.status !== "PENDING_APPROVAL") throw new ControlPlaneError(`Action cannot be reviewed from status ${action.status}.`, 409);
    const body = record(input);
    const decision = approved ? "APPROVED" : "REJECTED";
    const approval: ApprovalRecord = {
      id: randomUUID(), projectId, actionId, reviewerId: auth.userId, decision, comment: optionalString(body, "comment"), createdAt: new Date().toISOString(),
    };
    await this.store.insertApproval(approval);
    return this.store.updateAction({ ...action, decision: approved ? "ALLOW" : "DENY", status: decision, reasons: [...action.reasons, `Human reviewer ${decision.toLowerCase()} the action.`], updatedAt: approval.createdAt });
  }

  async verifyAction(auth: AuthContext, projectId: string, actionId: string, input: unknown): Promise<ActionRecord> {
    await this.authorizeProject(auth, projectId);
    const action = await this.store.getAction(projectId, actionId);
    if (!action) throw new ControlPlaneError("Action was not found.", 404);
    if (!new Set(["ALLOWED", "APPROVED"]).has(action.status)) throw new ControlPlaneError(`Action cannot be verified from status ${action.status}.`, 409);
    const body = record(input);
    const observedState = record(body.observedState);
    const success = action.expectedState ? matchesExpected(action.expectedState, observedState) : false;
    const next = await this.store.updateAction({
      ...action, observedState, verificationSuccess: success, status: success ? "VERIFIED" : "VERIFICATION_FAILED",
      reasons: success ? action.reasons : [...action.reasons, "Observed state did not match expected state."], updatedAt: new Date().toISOString(),
    });
    if (!success) {
      await this.store.insertIncident({
        id: randomUUID(), projectId, agentId: action.agentId, actionId: action.id, severity: "high", type: "verification_gap", status: "open",
        summary: "Runtime action outcome did not match the expected state.", firstDivergence: firstMismatch(action.expectedState ?? {}, observedState), createdAt: next.updatedAt,
      });
    }
    return next;
  }

  async listActions(auth: AuthContext, projectId: string): Promise<ActionRecord[]> {
    await this.authorizeProject(auth, projectId);
    return this.store.listActions(projectId);
  }

  async getAction(auth: AuthContext, projectId: string, actionId: string): Promise<ActionRecord> {
    await this.authorizeProject(auth, projectId);
    const action = await this.store.getAction(projectId, actionId);
    if (!action) throw new ControlPlaneError("Action was not found.", 404);
    return action;
  }

  async listIncidents(auth: AuthContext, projectId: string): Promise<IncidentRecord[]> {
    await this.authorizeProject(auth, projectId);
    return this.store.listIncidents(projectId);
  }

  async uploadEvidence(
    auth: AuthContext,
    projectId: string,
    bytes: Buffer,
    input: {
      fileName: string;
      contentType: string;
      kind: string;
      schemaVersion: string;
      runId?: string;
      actionId?: string;
      sourcePath?: string;
    },
  ): Promise<EvidenceRecord> {
    await this.authorizeProject(auth, projectId);
    let sourcePath = input.sourcePath?.trim();
    if (sourcePath && sourcePath.length > 1024) throw new ControlPlaneError("sourcePath must be at most 1024 characters.");
    const run = input.runId ? await this.store.getRun(projectId, input.runId) : undefined;
    if (input.runId && !run) throw new ControlPlaneError("Run was not found.", 404);
    if (input.actionId && !(await this.store.getAction(projectId, input.actionId))) throw new ControlPlaneError("Action was not found.", 404);
    let validated;
    try {
      validated = validateEvidenceUpload(bytes, input);
    } catch (error) {
      if (error instanceof EvidenceUploadValidationError) {
        if (run) await this.markRunEvidenceUpload(run, "rejected", error.message);
        throw new ControlPlaneError(error.message, 415);
      }
      throw error;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (run && input.kind !== "evidence_bundle") {
      const runEvidence = await this.store.listEvidenceForRun(projectId, run.id);
      const bundle = runEvidence.find((item) => item.kind === "evidence_bundle");
      const manifest = manifestFromMetadata(bundle?.metadata.artifactManifest);
      if (manifest) {
        try {
          sourcePath = assertArtifactMatchesManifest(manifest, {
            sourcePath,
            sha256,
            sizeBytes: bytes.length,
            kind: input.kind,
          }).path;
        } catch (error) {
          if (error instanceof EvidenceUploadValidationError) {
            await this.markRunEvidenceUpload(run, "rejected", error.message);
            throw new ControlPlaneError(error.message, 422);
          }
          throw error;
        }
      }
    }
    if (input.runId || input.actionId) {
      const existing = await this.store.findEvidenceByDigest(projectId, input.runId, input.actionId, input.kind, sha256, sourcePath);
      if (existing) {
        if (run) await this.markRunEvidenceUpload(run, "accepted");
        return existing;
      }
    }
    const id = randomUUID();
    const safeName = input.fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "artifact.bin";
    const scope = input.runId ? `runs/${input.runId}` : input.actionId ? `actions/${input.actionId}` : `uploads/${id}`;
    const objectKey = `${projectId}/evidence/${scope}/${sha256}/${id}-${safeName}`;
    const createdAt = new Date().toISOString();
    const evidence: EvidenceRecord = {
      id, projectId, runId: input.runId, actionId: input.actionId, kind: input.kind, schemaVersion: input.schemaVersion,
      objectKey, fileName: safeName, contentType: validated.contentType, sha256,
      sizeBytes: bytes.length,
      metadata: {
        ...(sourcePath ? { sourcePath } : {}),
        format: validated.format,
        retentionExpiresAt: new Date(Date.parse(createdAt) + this.evidencePolicy.retentionDays * 86_400_000).toISOString(),
        ...(validated.artifactReferenceCount === undefined ? {} : { artifactReferenceCount: validated.artifactReferenceCount }),
        ...(validated.artifactManifest === undefined ? {} : { artifactManifest: validated.artifactManifest }),
      },
      createdAt,
    };
    await this.artifacts.put(objectKey, bytes, validated.contentType);
    try {
      const stored = await this.store.insertEvidenceWithinQuota(
        evidence,
        this.evidencePolicy.projectLimitBytes,
        this.evidencePolicy.runLimitBytes,
      );
      if (run) await this.markRunEvidenceUpload(run, "accepted");
      return stored;
    } catch (error) {
      await this.artifacts.delete(objectKey).catch(() => undefined);
      if (error instanceof EvidenceQuotaExceededError) {
        const message = `${error.scope} evidence quota exceeded: ${error.usedBytes} of ${error.limitBytes} bytes are already used; ${error.requestedBytes} more were requested.`;
        if (run) await this.markRunEvidenceUpload(run, "rejected", message);
        throw new ControlPlaneError(message, 413);
      }
      throw error;
    }
  }

  async listEvidence(auth: AuthContext, projectId: string): Promise<EvidenceRecord[]> {
    await this.authorizeProject(auth, projectId);
    return this.store.listEvidence(projectId);
  }

  async readEvidence(auth: AuthContext, projectId: string, evidenceId: string) {
    await this.authorizeProject(auth, projectId);
    const evidence = await this.store.getEvidence(projectId, evidenceId);
    if (!evidence) throw new ControlPlaneError("Evidence was not found.", 404);
    const artifact = await this.artifacts.get(evidence.objectKey);
    if (!artifact) throw new ControlPlaneError("Evidence object was not found in storage.", 404);
    return { evidence, artifact };
  }

  async cleanupExpiredEvidence(now = new Date(), limit = 500) {
    const cutoff = new Date(now.getTime() - this.evidencePolicy.retentionDays * 86_400_000).toISOString();
    const expired = await this.store.listEvidenceCreatedBefore(cutoff, limit);
    const failures: Array<{ evidenceId: string; message: string }> = [];
    let deleted = 0;
    let bytesDeleted = 0;
    for (const evidence of expired) {
      try {
        const result = await this.store.deleteEvidenceUnlessHeld(
          evidence.projectId,
          evidence.id,
          () => this.artifacts.delete(evidence.objectKey),
        );
        if (result === "deleted") {
          deleted += 1;
          bytesDeleted += evidence.sizeBytes;
        }
      } catch (error) {
        failures.push({ evidenceId: evidence.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { cutoff, scanned: expired.length, deleted, bytesDeleted, failed: failures.length, failures: failures.slice(0, 20) };
  }

  async requestLegalHold(auth: AuthContext, projectId: string, input: unknown): Promise<LegalHoldRequestRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    const body = record(input);
    const reason = requiredString(body, "reason");
    if (reason.length < 20 || reason.length > 2_000) {
      throw new ControlPlaneError("reason must contain 20 to 2000 characters.");
    }
    const active = (await this.store.listLegalHoldRequests(projectId, 20))
      .find((request) => request.status === "requested" || request.status === "approved");
    if (active) throw new ControlPlaneError(`This project already has a ${active.status} legal hold request.`, 409);
    const request: LegalHoldRequestRecord = {
      id: randomUUID(), projectId, status: "requested", reason, requestedBy: auth.userId,
      requestedByEmail: auth.email, requestedAt: new Date().toISOString(),
    };
    try {
      return await this.store.saveLegalHoldRequest(request);
    } catch (error) {
      if (databaseErrorCode(error) === "23505") throw new ControlPlaneError("This project already has an active legal hold request.", 409);
      throw error;
    }
  }

  async listLegalHoldRequests(auth: AuthContext, projectId: string): Promise<LegalHoldRequestRecord[]> {
    await this.authorizeProject(auth, projectId);
    return this.store.listLegalHoldRequests(projectId);
  }

  async listPendingLegalHoldRequests(auth: AuthContext): Promise<LegalHoldRequestRecord[]> {
    this.requirePlatformAdmin(auth);
    return this.store.listPendingLegalHoldRequests();
  }

  async reviewLegalHold(
    auth: AuthContext,
    requestId: string,
    decision: "approve" | "reject" | "release",
    input: unknown,
  ): Promise<LegalHoldRequestRecord> {
    this.requirePlatformAdmin(auth);
    requireUser(auth);
    const current = await this.store.getLegalHoldRequest(requestId);
    if (!current) throw new ControlPlaneError("Legal hold request was not found.", 404);
    if (decision === "release" && current.status !== "approved") {
      throw new ControlPlaneError(`Legal hold cannot be released from status ${current.status}.`, 409);
    }
    if (decision !== "release" && current.status !== "requested") {
      throw new ControlPlaneError(`Legal hold request cannot be reviewed from status ${current.status}.`, 409);
    }
    if (decision === "approve" && current.requestedBy === auth.userId) {
      throw new ControlPlaneError("A legal hold request cannot be approved by its requester.", 409);
    }
    const body = record(input);
    const reviewNote = requiredString(body, "reviewNote");
    if (reviewNote.length < 10 || reviewNote.length > 2_000) {
      throw new ControlPlaneError("reviewNote must contain 10 to 2000 characters.");
    }
    const reviewedAt = new Date().toISOString();
    try {
      if (decision === "release") {
        return await this.store.saveLegalHoldRequest({
          ...current, status: "released", releasedBy: auth.userId, releasedByEmail: auth.email,
          releaseNote: reviewNote, releasedAt: reviewedAt,
        }, "approved");
      }
      return await this.store.saveLegalHoldRequest({
        ...current, status: decision === "approve" ? "approved" : "rejected",
        reviewedBy: auth.userId, reviewedByEmail: auth.email, reviewNote, reviewedAt,
      }, "requested");
    } catch (error) {
      if (error instanceof LegalHoldStateConflictError) {
        throw new ControlPlaneError("Legal hold status changed while this decision was being recorded.", 409);
      }
      throw error;
    }
  }

  async createApiKey(auth: AuthContext, projectId: string, input: unknown): Promise<{ apiKey: PublicApiKeyRecord; secret: string }> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    const body = record(input);
    const secret = `ac_live_${randomBytes(24).toString("base64url")}`;
    const apiKey: ApiKeyRecord = {
      id: randomUUID(), projectId, name: optionalString(body, "name") ?? "Agent integration", prefix: secret.slice(0, 16),
      secretHash: hashSecret(secret), createdBy: auth.userId, createdAt: new Date().toISOString(),
    };
    await this.store.insertApiKey(apiKey);
    return { apiKey: publicApiKey(apiKey), secret };
  }

  async listApiKeys(auth: AuthContext, projectId: string): Promise<PublicApiKeyRecord[]> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    return (await this.store.listApiKeys(projectId)).map(publicApiKey);
  }

  async revokeApiKey(auth: AuthContext, projectId: string, apiKeyId: string): Promise<PublicApiKeyRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const revoked = await this.store.revokeApiKey(projectId, apiKeyId, new Date().toISOString());
    if (!revoked) throw new ControlPlaneError("API key was not found.", 404);
    return publicApiKey(revoked);
  }

  async overview(auth: AuthContext, projectId: string) {
    await this.authorizeProject(auth, projectId);
    const [agents, runs, actions, incidents, evidence, storageUsage, legalHolds] = await Promise.all([
      this.store.listAgents(projectId), this.store.listRuns(projectId, 20), this.store.listActions(projectId, 20),
      this.store.listIncidents(projectId, 20), this.store.listEvidence(projectId, 20), this.store.evidenceUsage(projectId),
      this.store.listLegalHoldRequests(projectId, 1),
    ]);
    return {
      projectId,
      storage: {
        usedBytes: storageUsage.bytes,
        limitBytes: this.evidencePolicy.projectLimitBytes,
        remainingBytes: Math.max(0, this.evidencePolicy.projectLimitBytes - storageUsage.bytes),
        retentionDays: this.evidencePolicy.retentionDays,
        acceptedFormats: [...ACCEPTED_EVIDENCE_FORMATS],
        legalHold: legalHolds[0] ?? null,
      },
      summary: {
        agents: agents.length,
        runs: runs.length,
        passingRuns: runs.filter((item) => item.status === "passed").length,
        pendingApprovals: actions.filter((item) => item.status === "PENDING_APPROVAL").length,
        openIncidents: incidents.filter((item) => item.status === "open").length,
        evidence: evidence.length,
      },
      recentRuns: runs.slice(0, 8),
      recentActions: actions.slice(0, 8),
      openIncidents: incidents.filter((item) => item.status === "open").slice(0, 8),
    };
  }

  private async markRunEvidenceUpload(run: RunRecord, result: "accepted" | "rejected", reason?: string): Promise<void> {
    const current = await this.store.getRun(run.projectId, run.id) ?? run;
    const previous = Math.max(
      Date.parse(String(current.metadata.lastEvidenceAcceptedAt ?? "")) || 0,
      Date.parse(String(current.metadata.lastEvidenceRejectedAt ?? "")) || 0,
    );
    const now = new Date(Math.max(Date.now(), previous + 1)).toISOString();
    await this.store.upsertRun({
      ...current,
      metadata: {
        ...current.metadata,
        ...(result === "accepted"
          ? { lastEvidenceAcceptedAt: now }
          : { lastEvidenceRejectedAt: now, lastEvidenceRejectionReason: reason ?? "Evidence upload rejected." }),
      },
    });
  }

  private requirePlatformAdmin(auth: AuthContext): void {
    requireUser(auth);
    if (!auth.email || !this.platformAdminEmails.has(auth.email.toLowerCase())) {
      throw new ControlPlaneError("Platform administrator access is required.", 403);
    }
  }
}

function assessAction(
  actionType: ActionRecord["actionType"],
  amount: number | undefined,
  body: Record<string, unknown>,
  requested: string[],
  granted: string[],
): Pick<ActionRecord, "riskLevel" | "riskScore" | "decision" | "reasons"> {
  const missing = requested.filter((permission) => !granted.includes(permission));
  if (missing.length > 0) return { riskLevel: "CRITICAL", riskScore: 100, decision: "DENY", reasons: [`Missing permissions: ${missing.join(", ")}.`] };
  const reasons: string[] = [];
  let riskScore = 20;
  if (actionType === "PAY") { riskScore = 95; reasons.push("Payments always require human approval."); }
  if (actionType === "SUBMIT" && (amount ?? 0) > 1000) { riskScore = Math.max(riskScore, 80); reasons.push("Submissions over $1,000 require human approval."); }
  if (actionType === "SEND" && body.externalRecipient === true) { riskScore = Math.max(riskScore, 75); reasons.push("External messages require human approval."); }
  if (actionType === "UPDATE" && body.sensitive === true) { riskScore = Math.max(riskScore, 85); reasons.push("Sensitive updates require human approval."); }
  const decision: ActionDecision = riskScore >= 70 ? "REQUIRE_APPROVAL" : "ALLOW";
  if (reasons.length === 0) reasons.push("Default policy allows this low-risk action.");
  return { riskLevel: riskScore >= 90 ? "CRITICAL" : riskScore >= 70 ? "HIGH" : riskScore >= 40 ? "MEDIUM" : "LOW", riskScore, decision, reasons };
}
function publicApiKey(apiKey: ApiKeyRecord): PublicApiKeyRecord {
  const { secretHash: _secretHash, ...publicRecord } = apiKey;
  return publicRecord;
}

function matchesExpected(expected: Record<string, unknown>, observed: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => deepEqual(value, observed[key]));
}
function deepEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  if (left && typeof left === "object") {
    if (!right || typeof right !== "object" || Array.isArray(right)) return false;
    return Object.entries(left as Record<string, unknown>).every(([key, value]) => deepEqual(value, (right as Record<string, unknown>)[key]));
  }
  return Object.is(left, right);
}
function firstMismatch(expected: Record<string, unknown>, observed: Record<string, unknown>): string {
  const key = Object.keys(expected).find((name) => !deepEqual(expected[name], observed[name]));
  return key ? `Expected ${key}=${JSON.stringify(expected[key])}, observed ${JSON.stringify(observed[key])}.` : "Observed state did not contain a verifiable expected state.";
}
function requireUser(auth: AuthContext): asserts auth is AuthContext & { userId: string } {
  if (auth.kind !== "user" || !auth.userId) throw new ControlPlaneError("A human account is required.", 403);
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function optionalRecord(value: unknown): Record<string, unknown> | undefined { const result = record(value); return Object.keys(result).length ? result : undefined; }
function requiredString(value: Record<string, unknown>, key: string): string { const result = optionalString(value, key); if (!result) throw new ControlPlaneError(`${key} is required.`); return result; }
function optionalString(value: Record<string, unknown>, key: string): string | undefined { return typeof value[key] === "string" && value[key].trim() ? value[key].trim() : undefined; }
function optionalNumber(value: Record<string, unknown>, key: string): number | undefined { return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined; }
function databaseErrorCode(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error ? String(error.code) : undefined; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : []; }
function integer(value: unknown, fallback: number): number { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback; }
function optionalNonNegativeInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined; }
function runKind(value: unknown): RunKind { const allowed = new Set<RunKind>(["mcpbench", "tripwire", "release_gate", "runtime", "custom"]); if (typeof value === "string" && allowed.has(value as RunKind)) return value as RunKind; throw new ControlPlaneError("kind must be mcpbench, tripwire, release_gate, runtime, or custom."); }
function runStatus(value: unknown): RunStatus { const allowed = new Set<RunStatus>(["passed", "failed", "needs_evidence", "manual_review"]); if (typeof value === "string" && allowed.has(value as RunStatus)) return value as RunStatus; throw new ControlPlaneError("status must be passed, failed, needs_evidence, or manual_review."); }
function failureReviewStatus(value: unknown): FailureReviewRecord["status"] { if (value === "confirmed" || value === "corrected") return value; throw new ControlPlaneError("status must be confirmed or corrected."); }
function failureType(value: unknown): FailureType {
  const allowed = new Set<FailureType>([
    "prompt_injection", "wrong_click", "timeout", "verification_gap", "silent_partial_success", "network_failure",
    "ui_drift", "policy_or_approval", "agent_connection", "console_error", "assertion_failure", "unknown_failure",
  ]);
  if (typeof value === "string" && allowed.has(value as FailureType)) return value as FailureType;
  throw new ControlPlaneError("type must be a supported AgentCert failure taxonomy label.");
}
function actionTypeValue(value: unknown): ActionRecord["actionType"] { if (value === "SUBMIT" || value === "PAY" || value === "SEND" || value === "UPDATE") return value; throw new ControlPlaneError("actionType must be SUBMIT, PAY, SEND, or UPDATE."); }
