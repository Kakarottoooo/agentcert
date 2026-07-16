import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  ApiKeyScope,
  EventRecord,
  EvidenceRecord,
  FailureReviewRecord,
  FailureType,
  IncidentRecord,
  IncidentTransitionRecord,
  IncidentStatus,
  LegalHoldRequestRecord,
  RunKind,
  RunRecord,
  RunStatus,
  PublicApiKeyRecord,
  PublicWebhookRecord,
  FailureQualityMetrics,
  SigningKeyRecord,
  TrustHealthSampleRecord,
  NotificationAlertType,
  NotificationDestinationRecord,
  PublicNotificationDestinationRecord,
  WebhookJobRecord,
  WebhookRecord,
} from "./types.js";
import { DisabledEmailProvider, type EmailProvider } from "./notifications.js";
import { EnvelopeValidationError, isSpanId, isTraceId, parseUniversalEnvelope, type UniversalEnvelope } from "./protocol.js";
import { EvidenceSigner, type EvidenceAttestationPayload } from "./signing.js";
import type { CoordinationHealth } from "./coordination.js";
import {
  DEFAULT_API_KEY_SCOPES,
  WebhookSecretVault,
  createWebhookSignature,
  deliverWebhook,
  parseApiKeyScopes,
  type WebhookEvent,
} from "./security.js";

const POLICY_VERSION = "agentcert.default.v1";
const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;
const DEFAULT_WEBHOOK_LEASE_MS = 60_000;
const DEFAULT_WEBHOOK_RETRY_BASE_MS = 5_000;
const MAX_WEBHOOK_RETRY_MS = 60 * 60 * 1000;
const PRODUCTION_SMOKE_FINGERPRINT = "trust-operations:production-smoke";
const TRUST_SLO_OBJECTIVE = 0.99;

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
    readonly evidenceSigner?: EvidenceSigner,
    readonly webhookVault?: WebhookSecretVault,
    readonly webhookFetch: typeof fetch = fetch,
    readonly emailProvider: EmailProvider = new DisabledEmailProvider(),
    readonly publicUrl = "http://127.0.0.1:8787",
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

  async authorizeProject(auth: AuthContext, projectId: string, roles?: string[], scope?: ApiKeyScope): Promise<void> {
    if (auth.kind === "api_key") {
      if (auth.projectId !== projectId) throw new ControlPlaneError("API key is not scoped to this project.", 403);
      if (roles) throw new ControlPlaneError("This operation requires a human account.", 403);
      if (scope && !(auth.scopes ?? DEFAULT_API_KEY_SCOPES).includes(scope)) {
        throw new ControlPlaneError(`API key requires the ${scope} scope.`, 403);
      }
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
    await this.authorizeProject(auth, projectId, undefined, "agents:read");
    return this.store.listAgents(projectId);
  }

  async startRun(auth: AuthContext, projectId: string, input: unknown): Promise<RunRecord> {
    await this.authorizeProject(auth, projectId, undefined, "runs:write");
    const body = record(input);
    const externalId = requiredString(body, "externalId");
    const existing = await this.store.getRunByExternalId(projectId, externalId);
    if (existing) return existing;
    const agentId = optionalString(body, "agentId");
    if (agentId && !(await this.store.getAgent(projectId, agentId))) throw new ControlPlaneError("Agent was not found.", 404);
    const traceId = optionalString(body, "traceId")?.toLowerCase();
    const rootSpanId = optionalString(body, "rootSpanId")?.toLowerCase();
    validateTraceIds(traceId, rootSpanId);
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
      traceId,
      rootSpanId,
    };
    return this.store.upsertRun(run);
  }

  async appendEvents(auth: AuthContext, projectId: string, runId: string, input: unknown): Promise<EventRecord[]> {
    await this.authorizeProject(auth, projectId, undefined, "events:write");
    if (!(await this.store.getRun(projectId, runId))) throw new ControlPlaneError("Run was not found.", 404);
    const body = record(input);
    const rawEvents = Array.isArray(body.events) ? body.events : [];
    if (rawEvents.length === 0 || rawEvents.length > 500) throw new ControlPlaneError("events must contain 1 to 500 records.");
    const events = rawEvents.map((value, index): EventRecord => {
      const event = record(value);
      const traceId = optionalString(event, "traceId")?.toLowerCase();
      const spanId = optionalString(event, "spanId")?.toLowerCase();
      const parentSpanId = optionalString(event, "parentSpanId")?.toLowerCase();
      validateTraceIds(traceId, spanId, parentSpanId);
      return {
        id: randomUUID(),
        projectId,
        runId,
        sequence: integer(event.sequence, index),
        type: requiredString(event, "type"),
        actor: optionalString(event, "actor") ?? "agent",
        occurredAt: optionalString(event, "occurredAt") ?? new Date().toISOString(),
        payload: record(event.payload),
        traceId,
        spanId,
        parentSpanId,
      };
    });
    return this.store.appendEvents(events);
  }

  capabilities(auth: AuthContext) {
    requireUser(auth);
    return {
      platformAdmin: Boolean(auth.email && this.platformAdminEmails.has(auth.email.toLowerCase())),
      evidenceSigning: Boolean(this.evidenceSigner),
      signedWebhooks: Boolean(this.webhookVault),
    };
  }

  async ingestEnvelope(auth: AuthContext, projectId: string, input: unknown): Promise<{ envelope: UniversalEnvelope; run: RunRecord; event?: EventRecord; action?: ActionRecord }> {
    let envelope: UniversalEnvelope;
    try {
      envelope = parseUniversalEnvelope(input);
    } catch (error) {
      if (error instanceof EnvelopeValidationError) throw new ControlPlaneError(error.message, 422);
      throw error;
    }
    const run = await this.startRun(auth, projectId, {
      externalId: envelope.run.externalId,
      kind: envelope.run.kind ?? (envelope.kind === "action" ? "runtime" : "custom"),
      schemaVersion: envelope.schemaVersion,
      startedAt: envelope.occurredAt,
      traceId: envelope.trace.traceId,
      rootSpanId: envelope.trace.parentSpanId ?? envelope.trace.spanId,
      metadata: {
        sourceAgentId: envelope.source.agentId,
        sourceAgentVersion: envelope.source.agentVersion,
        framework: envelope.source.framework,
        adapter: envelope.source.adapter,
      },
    });
    if (envelope.kind === "event" && envelope.event) {
      const [event] = await this.appendEvents(auth, projectId, run.id, { events: [{
        sequence: envelope.event.sequence,
        type: envelope.event.type,
        actor: envelope.event.actor ?? "agent",
        occurredAt: envelope.occurredAt,
        payload: { ...envelope.event.attributes, envelopeId: envelope.envelopeId, envelopeSchemaVersion: envelope.schemaVersion },
        traceId: envelope.trace.traceId,
        spanId: envelope.trace.spanId,
        parentSpanId: envelope.trace.parentSpanId,
      }] });
      return { envelope, run, event };
    }
    const action = await this.proposeAction(auth, projectId, {
      ...envelope.action,
      traceId: envelope.trace.traceId,
      spanId: envelope.trace.spanId,
      parentSpanId: envelope.trace.parentSpanId,
      envelopeId: envelope.envelopeId,
      runExternalId: envelope.run.externalId,
    });
    return { envelope, run, action };
  }

  async completeRun(auth: AuthContext, projectId: string, runId: string, input: unknown): Promise<RunRecord> {
    await this.authorizeProject(auth, projectId, undefined, "runs:write");
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
      const incidentAt = new Date().toISOString();
      await this.store.insertIncident({
        id: randomUUID(), projectId, agentId: current.agentId, runId: current.id, severity: "high", type: "run_failure", status: "open",
        summary: optionalString(body, "summary") ?? `${current.kind} run failed.`, firstDivergence: optionalString(body, "firstDivergence"),
        occurrenceCount: 1, consecutivePasses: 0, createdAt: incidentAt, updatedAt: incidentAt,
      });
    }
    await this.emitWebhook(projectId, "run.completed", next.id, next);
    return next;
  }

  async listRuns(auth: AuthContext, projectId: string): Promise<RunRecord[]> {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    return this.store.listRuns(projectId);
  }

  async runDetail(auth: AuthContext, projectId: string, runId: string) {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    const run = await this.store.getRun(projectId, runId);
    if (!run) throw new ControlPlaneError("Run was not found.", 404);
    return { run, events: await this.store.listEvents(projectId, runId) };
  }

  async runAnalysis(auth: AuthContext, projectId: string, runId: string) {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
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
    await this.authorizeProject(auth, projectId, undefined, "actions:write");
    const body = record(input);
    const agentId = optionalString(body, "agentId");
    const agent = agentId ? await this.store.getAgent(projectId, agentId) : undefined;
    if (agentId && !agent) throw new ControlPlaneError("Agent was not found.", 404);
    const actionType = actionTypeValue(body.actionType);
    const requestedPermissions = stringList(body.requestedPermissions);
    const amount = optionalNumber(body, "amount");
    const assessment = assessAction(actionType, amount, body, requestedPermissions, agent?.allowedPermissions ?? []);
    const traceId = optionalString(body, "traceId")?.toLowerCase();
    const spanId = optionalString(body, "spanId")?.toLowerCase();
    const parentSpanId = optionalString(body, "parentSpanId")?.toLowerCase();
    validateTraceIds(traceId, spanId, parentSpanId);
    const now = new Date().toISOString();
    return this.store.insertAction({
      id: randomUUID(), projectId, agentId, externalId: requiredString(body, "externalId"), principal: record(body.principal), actionType,
      targetSystem: requiredString(body, "targetSystem"), requestedPermissions, amount, currency: optionalString(body, "currency"),
      riskLevel: assessment.riskLevel, riskScore: assessment.riskScore, decision: assessment.decision,
      status: assessment.decision === "ALLOW" ? "ALLOWED" : assessment.decision === "DENY" ? "DENIED" : "PENDING_APPROVAL",
      policyVersion: POLICY_VERSION, reasons: assessment.reasons, expectedState: optionalRecord(body.expectedState), createdAt: now, updatedAt: now,
      traceId, spanId, parentSpanId,
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
    const next = await this.store.updateAction({ ...action, decision: approved ? "ALLOW" : "DENY", status: decision, reasons: [...action.reasons, `Human reviewer ${decision.toLowerCase()} the action.`], updatedAt: approval.createdAt });
    await this.emitWebhook(projectId, approved ? "action.approved" : "action.rejected", next.id, next);
    return next;
  }

  async verifyAction(auth: AuthContext, projectId: string, actionId: string, input: unknown): Promise<ActionRecord> {
    await this.authorizeProject(auth, projectId, undefined, "actions:write");
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
        summary: "Runtime action outcome did not match the expected state.", firstDivergence: firstMismatch(action.expectedState ?? {}, observedState),
        occurrenceCount: 1, consecutivePasses: 0, createdAt: next.updatedAt, updatedAt: next.updatedAt,
      });
    }
    await this.emitWebhook(projectId, "action.verified", next.id, next);
    return next;
  }

  async listActions(auth: AuthContext, projectId: string): Promise<ActionRecord[]> {
    await this.authorizeProject(auth, projectId, undefined, "actions:read");
    return this.store.listActions(projectId);
  }

  async getAction(auth: AuthContext, projectId: string, actionId: string): Promise<ActionRecord> {
    await this.authorizeProject(auth, projectId, undefined, "actions:read");
    const action = await this.store.getAction(projectId, actionId);
    if (!action) throw new ControlPlaneError("Action was not found.", 404);
    return action;
  }

  async listIncidents(auth: AuthContext, projectId: string): Promise<IncidentRecord[]> {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
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
    await this.authorizeProject(auth, projectId, undefined, "evidence:write");
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
    const attestationPayload: EvidenceAttestationPayload = {
      evidenceId: id, projectId, runId: input.runId, actionId: input.actionId, kind: input.kind,
      schemaVersion: input.schemaVersion, sha256, sizeBytes: bytes.length, createdAt,
    };
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
        failurePatternCount: inferFailurePatternCount(bytes, validated.contentType),
        ...(this.evidenceSigner ? {
          serverAttestation: this.evidenceSigner.attest(attestationPayload),
          attestationPayload,
        } : {}),
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
      await this.emitWebhook(projectId, "evidence.accepted", stored.id, stored);
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
    await this.authorizeProject(auth, projectId, undefined, "evidence:read");
    return this.store.listEvidence(projectId);
  }

  async readEvidence(auth: AuthContext, projectId: string, evidenceId: string) {
    await this.authorizeProject(auth, projectId, undefined, "evidence:read");
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
      const occurredAt = new Date().toISOString();
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
        await this.store.insertEvidenceDeletion({
          id: randomUUID(), projectId: evidence.projectId, evidenceId: evidence.id, runId: evidence.runId, actionId: evidence.actionId,
          objectKey: evidence.objectKey, fileName: evidence.fileName, kind: evidence.kind, sha256: evidence.sha256,
          sizeBytes: evidence.sizeBytes, outcome: result, reason: `Expired after ${this.evidencePolicy.retentionDays}-day retention window.`, occurredAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ evidenceId: evidence.id, message });
        await this.store.insertEvidenceDeletion({
          id: randomUUID(), projectId: evidence.projectId, evidenceId: evidence.id, runId: evidence.runId, actionId: evidence.actionId,
          objectKey: evidence.objectKey, fileName: evidence.fileName, kind: evidence.kind, sha256: evidence.sha256,
          sizeBytes: evidence.sizeBytes, outcome: "failed", reason: `Expired after ${this.evidencePolicy.retentionDays}-day retention window.`, error: message, occurredAt,
        }).catch(() => undefined);
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

  async listAdminLegalHoldRequests(auth: AuthContext, status?: LegalHoldRequestRecord["status"]): Promise<LegalHoldRequestRecord[]> {
    this.requirePlatformAdmin(auth);
    return this.store.listLegalHoldRequestsForAdmin(status);
  }

  async legalHoldReport(auth: AuthContext, projectId: string) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    return this.buildRetentionReport(projectId);
  }

  async adminLegalHoldReport(auth: AuthContext, requestId: string) {
    this.requirePlatformAdmin(auth);
    const request = await this.store.getLegalHoldRequest(requestId);
    if (!request) throw new ControlPlaneError("Legal hold request was not found.", 404);
    return this.buildRetentionReport(request.projectId);
  }

  private async buildRetentionReport(projectId: string) {
    const [requests, deletions, usage, evidence] = await Promise.all([
      this.store.listLegalHoldRequests(projectId, 200),
      this.store.listEvidenceDeletions(projectId, 1_000),
      this.store.evidenceUsage(projectId),
      this.store.listEvidence(projectId, 1_000),
    ]);
    return {
      schemaVersion: "agentcert.retention_report.v0.1",
      projectId,
      generatedAt: new Date().toISOString(),
      policy: { retentionDays: this.evidencePolicy.retentionDays, projectLimitBytes: this.evidencePolicy.projectLimitBytes },
      usage,
      activeEvidence: evidence.map((item) => ({ id: item.id, kind: item.kind, sha256: item.sha256, sizeBytes: item.sizeBytes, createdAt: item.createdAt })),
      legalHolds: requests,
      deletionJournal: deletions,
    };
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
    let scopes: ApiKeyScope[];
    try { scopes = parseApiKeyScopes(body.scopes); }
    catch (error) { throw new ControlPlaneError(error instanceof Error ? error.message : String(error)); }
    const apiKey: ApiKeyRecord = {
      id: randomUUID(), projectId, name: optionalString(body, "name") ?? "Agent integration", prefix: secret.slice(0, 16),
      secretHash: hashSecret(secret), createdBy: auth.userId, createdAt: new Date().toISOString(), scopes,
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
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    const [agents, runs, actions, incidents, evidence, storageUsage, legalHolds, reviews, deletions, qualityRuns, qualityEvidence] = await Promise.all([
      this.store.listAgents(projectId), this.store.listRuns(projectId, 20), this.store.listActions(projectId, 20),
      this.store.listIncidents(projectId, 20), this.store.listEvidence(projectId, 20), this.store.evidenceUsage(projectId),
      this.store.listLegalHoldRequests(projectId, 1),
      this.store.listFailureReviewsForProject(projectId),
      this.store.listEvidenceDeletions(projectId, 100),
      this.store.listRuns(projectId, 10_000),
      this.store.listEvidence(projectId, 10_000),
    ]);
    const quality = failureQualityMetrics(qualityRuns, reviews, qualityEvidence);
    return {
      projectId,
      storage: {
        usedBytes: storageUsage.bytes,
        limitBytes: this.evidencePolicy.projectLimitBytes,
        remainingBytes: Math.max(0, this.evidencePolicy.projectLimitBytes - storageUsage.bytes),
        retentionDays: this.evidencePolicy.retentionDays,
        acceptedFormats: [...ACCEPTED_EVIDENCE_FORMATS],
        legalHold: legalHolds[0] ?? null,
        deletionCount: deletions.length,
      },
      summary: {
        agents: agents.length,
        runs: runs.length,
        passingRuns: runs.filter((item) => item.status === "passed").length,
        pendingApprovals: actions.filter((item) => item.status === "PENDING_APPROVAL").length,
        openIncidents: incidents.filter((item) => item.status !== "resolved").length,
        evidence: evidence.length,
        taxonomyQuality: quality,
      },
      recentRuns: runs.slice(0, 8),
      recentActions: actions.slice(0, 8),
      openIncidents: incidents.filter((item) => item.status !== "resolved").slice(0, 8),
    };
  }

  signingKey() {
    if (!this.evidenceSigner) throw new ControlPlaneError("Server evidence signing is not configured.", 503);
    return { schemaVersion: "agentcert.signing_key.v0.1", keyId: this.evidenceSigner.keyId, algorithm: "Ed25519", publicKeyPem: this.evidenceSigner.publicKeyPem };
  }

  async recordTrustHealthSample(auth: AuthContext, projectId: string, input: unknown) {
    await this.authorizeProject(auth, projectId, undefined, "runs:write");
    const body = record(input);
    const externalId = requiredString(body, "externalId");
    const source = body.source === "manual" ? "manual" : body.source === "production_smoke" ? "production_smoke" : undefined;
    if (!source) throw new ControlPlaneError("source must be production_smoke or manual.");
    const status = body.status === "passed" ? "passed" : body.status === "failed" ? "failed" : undefined;
    if (!status) throw new ControlPlaneError("status must be passed or failed.");
    const startedAt = requiredTimestamp(body, "startedAt");
    const completedAt = requiredTimestamp(body, "completedAt");
    if (Date.parse(completedAt) < Date.parse(startedAt)) throw new ControlPlaneError("completedAt cannot be before startedAt.");
    const error = optionalString(body, "error");
    if (error && error.length > 2_000) throw new ControlPlaneError("error cannot exceed 2000 characters.");
    const workflowRunUrl = optionalString(body, "workflowRunUrl");
    if (workflowRunUrl) {
      let parsed: URL;
      try { parsed = new URL(workflowRunUrl); }
      catch { throw new ControlPlaneError("workflowRunUrl must be a valid HTTPS URL."); }
      if (parsed.protocol !== "https:") throw new ControlPlaneError("workflowRunUrl must be a valid HTTPS URL.");
    }
    const now = new Date().toISOString();
    const sample = await this.store.saveTrustHealthSample({
      id: randomUUID(), projectId, externalId, source, status, startedAt, completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), checks: stringList(body.checks), error,
      workflowRunId: optionalString(body, "workflowRunId"), workflowRunUrl, createdAt: now,
    });
    const lifecycle = source === "production_smoke" ? await this.applyProductionSmokeOutcome(auth, sample) : {};
    return { sample, ...lifecycle };
  }

  private async applyProductionSmokeOutcome(
    auth: AuthContext,
    sample: TrustHealthSampleRecord,
  ): Promise<{ operationalIncident?: IncidentRecord; incidentTransition?: IncidentTransitionRecord }> {
    const active = await this.store.getActiveIncidentByFingerprint(sample.projectId, PRODUCTION_SMOKE_FINGERPRINT);
    if (sample.status === "failed") {
      if (!active) {
        const now = sample.completedAt;
        const incident: IncidentRecord = {
          id: randomUUID(), projectId: sample.projectId, severity: "high", type: "production_smoke", status: "open",
          summary: "Production trust smoke failed.", firstDivergence: sample.error, fingerprint: PRODUCTION_SMOKE_FINGERPRINT,
          occurrenceCount: 1, consecutivePasses: 0, lastFailedAt: now, createdAt: now, updatedAt: now,
        };
        let inserted: IncidentRecord;
        try { inserted = await this.store.insertIncident(incident); }
        catch (error) {
          if (databaseErrorCode(error) !== "23505") throw error;
          inserted = await this.store.getActiveIncidentByFingerprint(sample.projectId, PRODUCTION_SMOKE_FINGERPRINT) ?? incident;
        }
        if (inserted.id !== incident.id) return this.applyProductionSmokeOutcome(auth, sample);
        const transition = await this.appendIncidentTransition(inserted, undefined, "open", auth, "Production smoke failure opened the incident.", sampleEvidence(sample));
        await this.sendIncidentNotification("incident_opened", inserted, transition);
        return { operationalIncident: inserted, incidentTransition: transition };
      }
      const regressed = active.status === "recovered";
      const next: IncidentRecord = {
        ...active, status: regressed ? "open" : active.status, occurrenceCount: active.occurrenceCount + 1,
        consecutivePasses: 0, lastFailedAt: sample.completedAt, firstDivergence: sample.error ?? active.firstDivergence,
        updatedAt: sample.completedAt,
      };
      const updated = await this.store.updateIncident(next);
      const transition = await this.appendIncidentTransition(
        updated, active.status, updated.status, auth,
        regressed ? "Production smoke failed after recovery." : "Another production smoke failure was observed.",
        sampleEvidence(sample),
      );
      if (regressed) await this.sendIncidentNotification("incident_regressed", updated, transition);
      return { operationalIncident: updated, incidentTransition: transition };
    }

    if (!active) {
      const latest = await this.store.getLatestIncidentByFingerprint(sample.projectId, PRODUCTION_SMOKE_FINGERPRINT);
      return latest?.status === "resolved" ? { operationalIncident: latest } : {};
    }
    const consecutivePasses = active.consecutivePasses + 1;
    const recovered = consecutivePasses >= 2 && (active.status === "open" || active.status === "investigating");
    const next = await this.store.updateIncident({
      ...active, status: recovered ? "recovered" : active.status, consecutivePasses, lastPassedAt: sample.completedAt,
      recoveredAt: recovered ? sample.completedAt : active.recoveredAt, updatedAt: sample.completedAt,
    });
    if (!recovered) return { operationalIncident: next };
    const transition = await this.appendIncidentTransition(
      next, active.status, "recovered", auth, "Two consecutive production smoke runs passed.",
      { ...sampleEvidence(sample), consecutivePasses },
    );
    await this.sendIncidentNotification("incident_recovered", next, transition);
    return { operationalIncident: next, incidentTransition: transition };
  }

  async acknowledgeOperationalIncident(auth: AuthContext, projectId: string, incidentId: string, input: unknown) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    const incident = await this.store.getIncident(projectId, incidentId);
    if (!incident?.fingerprint) throw new ControlPlaneError("Operational incident was not found.", 404);
    if (incident.status === "investigating") return { incident, transitions: await this.store.listIncidentTransitions(projectId, incidentId) };
    if (incident.status !== "open") throw new ControlPlaneError(`Incident cannot be acknowledged from ${incident.status}.`, 409);
    const reason = reviewReason(input);
    const now = new Date().toISOString();
    const updated = await this.store.updateIncident({
      ...incident, status: "investigating", acknowledgedBy: auth.userId, acknowledgedByEmail: auth.email,
      acknowledgedAt: now, updatedAt: now,
    });
    const transition = await this.appendIncidentTransition(updated, "open", "investigating", auth, reason, {});
    return { incident: updated, transition, transitions: await this.store.listIncidentTransitions(projectId, incidentId) };
  }

  async resolveOperationalIncident(auth: AuthContext, projectId: string, incidentId: string, input: unknown) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    const incident = await this.store.getIncident(projectId, incidentId);
    if (!incident?.fingerprint) throw new ControlPlaneError("Operational incident was not found.", 404);
    if (incident.status === "resolved") return { incident, transitions: await this.store.listIncidentTransitions(projectId, incidentId) };
    if (incident.status !== "recovered") throw new ControlPlaneError("Incident must have two consecutive passing smokes before resolution.", 409);
    const reason = reviewReason(input);
    const now = new Date().toISOString();
    const updated = await this.store.updateIncident({
      ...incident, status: "resolved", resolvedBy: auth.userId, resolvedByEmail: auth.email, resolvedAt: now, updatedAt: now,
    });
    const transition = await this.appendIncidentTransition(updated, "recovered", "resolved", auth, reason, {});
    await this.sendIncidentNotification("incident_resolved", updated, transition);
    return { incident: updated, transition, transitions: await this.store.listIncidentTransitions(projectId, incidentId) };
  }

  async linkOperationalIncidentGitHub(auth: AuthContext, projectId: string, incidentId: string, input: unknown) {
    await this.authorizeProject(auth, projectId, undefined, "runs:write");
    const incident = await this.store.getIncident(projectId, incidentId);
    if (!incident?.fingerprint) throw new ControlPlaneError("Operational incident was not found.", 404);
    const body = record(input);
    const issueNumber = optionalNonNegativeInteger(body.issueNumber);
    const issueUrl = optionalString(body, "issueUrl");
    if (!issueNumber || !issueUrl) throw new ControlPlaneError("issueNumber and issueUrl are required.");
    let parsed: URL;
    try { parsed = new URL(issueUrl); } catch { throw new ControlPlaneError("issueUrl must be a valid GitHub HTTPS URL."); }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new ControlPlaneError("issueUrl must be a valid GitHub HTTPS URL.");
    return this.store.updateIncident({ ...incident, githubIssueNumber: issueNumber, githubIssueUrl: issueUrl, updatedAt: new Date().toISOString() });
  }

  async createNotificationDestination(auth: AuthContext, projectId: string, input: unknown): Promise<PublicNotificationDestinationRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    if (!this.emailProvider.configured) throw new ControlPlaneError("Email notifications are not configured by the AgentCert platform.", 503);
    const body = record(input);
    const email = notificationEmail(requiredString(body, "email"));
    const alertTypes = notificationAlertTypes(body.alertTypes);
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const destination = await this.store.saveNotificationDestination({
      id: randomUUID(), projectId, email, alertTypes, status: "pending_verification", verificationTokenHash: createHash("sha256").update(token).digest("hex"),
      verificationExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), createdBy: auth.userId, createdAt: now.toISOString(),
    });
    const verificationUrl = `${this.publicUrl.replace(/\/$/, "")}/v1/notification-destinations/verify?token=${encodeURIComponent(token)}`;
    await this.deliverEmail(destination, "destination_verification", "Verify your AgentCert alert email", {
      text: `Verify this email for AgentCert project alerts: ${verificationUrl}\n\nThis link expires in 24 hours.`,
      html: `<p>Verify this email for AgentCert project alerts.</p><p><a href="${escapeHtml(verificationUrl)}">Verify alert email</a></p><p>This link expires in 24 hours.</p>`,
    }, true);
    return publicNotificationDestination(destination);
  }

  async verifyNotificationDestination(token: string): Promise<PublicNotificationDestinationRecord> {
    if (!token || token.length > 512) throw new ControlPlaneError("Verification token is invalid.");
    const destination = await this.store.verifyNotificationDestination(createHash("sha256").update(token).digest("hex"), new Date().toISOString());
    if (!destination) throw new ControlPlaneError("Verification token is invalid or expired.", 400);
    return publicNotificationDestination(destination);
  }

  async listNotificationDestinations(auth: AuthContext, projectId: string) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    return (await this.store.listNotificationDestinations(projectId)).map(publicNotificationDestination);
  }

  async disableNotificationDestination(auth: AuthContext, projectId: string, destinationId: string) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const destination = await this.store.disableNotificationDestination(projectId, destinationId, new Date().toISOString());
    if (!destination) throw new ControlPlaneError("Notification destination was not found.", 404);
    return publicNotificationDestination(destination);
  }

  async operationsOverview(auth: AuthContext, projectId: string, coordination?: CoordinationHealth, now = new Date()) {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const [jobs, jobCounts, deliveries, signingKeys, smokeSamples, latestSmokeSamples, webhookMetrics, slo30, slo90, incidents] = await Promise.all([
      this.store.listWebhookJobs(projectId, 100),
      this.store.webhookJobCounts(projectId),
      this.store.listWebhookDeliveries(projectId, 100),
      this.store.listSigningKeys(),
      this.store.listTrustHealthSamples(projectId, since, 100),
      this.store.listTrustHealthSamples(projectId, "1970-01-01T00:00:00.000Z", 1),
      this.store.webhookOperationsMetrics(projectId, since),
      this.store.trustHealthCounts(projectId, since30),
      this.store.trustHealthCounts(projectId, since90),
      this.store.listIncidents(projectId, 50),
    ]);
    const activeKey = signingKeys.find((key) => key.status === "active");
    const coordinationState = coordination ?? { backend: "memory" as const, state: "degraded" as const, shared: false };
    const redisAlert = coordinationState.state === "ready" && coordinationState.shared
      ? alert("healthy", "Shared Redis coordination is ready.")
      : alert("critical", "Shared Redis coordination is unavailable; rate limits and idempotency are not cross-instance.");
    const keyAgeDays = activeKey ? Math.max(0, Math.floor((now.getTime() - Date.parse(activeKey.activatedAt)) / 86_400_000)) : undefined;
    const signingAlert = !this.evidenceSigner
      ? alert("critical", "Server evidence signing is not configured in this runtime.")
      : !activeKey
        ? alert("critical", "No active server evidence signing key is available.")
      : keyAgeDays! >= 180
        ? alert("critical", `Active signing key is ${keyAgeDays} days old and must be rotated.`)
        : keyAgeDays! >= 90
          ? alert("warning", `Active signing key is ${keyAgeDays} days old; schedule rotation.`)
          : alert("healthy", `Active signing key is ${keyAgeDays} days old.`);
    const latestSmoke = latestSmokeSamples[0];
    const smokeAgeHours = latestSmoke ? (now.getTime() - Date.parse(latestSmoke.completedAt)) / 3_600_000 : undefined;
    const smokeAlert = !latestSmoke
      ? alert("warning", "No production smoke result has been recorded.")
      : latestSmoke.status === "failed"
        ? alert("critical", `Latest production smoke failed ${compactAge(smokeAgeHours!)} ago.`)
        : smokeAgeHours! > 72
          ? alert("critical", `Latest passing production smoke is stale (${compactAge(smokeAgeHours!)} old).`)
          : smokeAgeHours! > 36
            ? alert("warning", `Latest passing production smoke is ${compactAge(smokeAgeHours!)} old.`)
            : alert("healthy", `Latest production smoke passed ${compactAge(smokeAgeHours!)} ago.`);
    const webhookAlert = jobCounts.dead_letter > 0
      ? alert("critical", `${jobCounts.dead_letter} webhook deliveries require dead-letter review.`)
      : jobCounts.retrying > 0
        ? alert("warning", `${jobCounts.retrying} webhook deliveries are retrying.`)
        : alert("healthy", "No webhook deliveries require operator action.");
    const smokeBuckets = trustHealthBuckets(smokeSamples, now, 7);
    const webhookBuckets = fillWebhookBuckets(webhookMetrics.buckets, now, 7);
    const smokePassed = smokeSamples.filter((sample) => sample.status === "passed").length;
    const operationalIncidents = incidents.filter((incident) => incident.fingerprint);
    const activeIncident = operationalIncidents.find((incident) => incident.status !== "resolved") ?? null;
    const incidentAlert = !activeIncident
      ? alert("healthy", "No active production trust incident.")
      : activeIncident.status === "recovered"
        ? alert("warning", "Production trust incident recovered and awaits human resolution.")
        : alert("critical", `Production trust incident is ${activeIncident.status}.`);
    const alertStates = [redisAlert.status, signingAlert.status, smokeAlert.status, webhookAlert.status, incidentAlert.status];
    const status = alertStates.includes("critical") ? "critical" : alertStates.includes("warning") ? "warning" : "healthy";
    const incidentForLedger = activeIncident ?? operationalIncidents[0] ?? null;
    const transitions = incidentForLedger ? await this.store.listIncidentTransitions(projectId, incidentForLedger.id) : [];
    return {
      schemaVersion: "agentcert.trust_operations.v0.4",
      projectId,
      status,
      generatedAt: now.toISOString(),
      coordination: coordinationState,
      alerts: { redis: redisAlert, signing: signingAlert, scheduledSmoke: smokeAlert, webhooks: webhookAlert, incidents: incidentAlert },
      webhooks: {
        queue: jobCounts,
        recentJobs: jobs.slice(0, 50),
        recentFailures: deliveries.filter((delivery) => delivery.status === "failed").slice(0, 20),
        deadLetters: jobs.filter((job) => job.status === "dead_letter").slice(0, 20),
      },
      signing: {
        configured: Boolean(this.evidenceSigner),
        activeKey: activeKey ?? null,
        historicalKeys: signingKeys.filter((key) => key.status !== "active").length,
        keys: signingKeys,
      },
      smoke: { latest: latestSmoke ?? null, recent: smokeSamples.slice(0, 20) },
      incidents: { active: activeIncident, recent: operationalIncidents.slice(0, 10), transitions },
      notifications: {
        provider: this.emailProvider.name,
        configured: this.emailProvider.configured,
        destinations: (await this.store.listNotificationDestinations(projectId)).map(publicNotificationDestination),
        recentDeliveries: await this.store.listNotificationDeliveries(projectId, 20),
      },
      slo: {
        objective: TRUST_SLO_OBJECTIVE,
        windows: [sloWindow(30, slo30, TRUST_SLO_OBJECTIVE), sloWindow(90, slo90, TRUST_SLO_OBJECTIVE)],
      },
      trends: {
        windowDays: 7,
        health: smokeBuckets,
        webhooks: webhookBuckets,
        summary: {
          smokeSuccessRate: smokeSamples.length ? smokePassed / smokeSamples.length : 0,
          webhookSuccessRate: webhookMetrics.total ? webhookMetrics.delivered / webhookMetrics.total : 0,
          retryRate: webhookMetrics.total ? webhookMetrics.retried / webhookMetrics.total : 0,
          deadLetterRate: webhookMetrics.total ? webhookMetrics.deadLetter / webhookMetrics.total : 0,
          averageLatencyMs: webhookMetrics.averageLatencyMs,
          p95LatencyMs: webhookMetrics.p95LatencyMs,
        },
      },
    };
  }

  async activateSigningKey(now = new Date()): Promise<SigningKeyRecord | undefined> {
    if (!this.evidenceSigner) return undefined;
    const timestamp = now.toISOString();
    return this.store.activateSigningKey({
      keyId: this.evidenceSigner.keyId,
      algorithm: "Ed25519",
      publicKeyPem: this.evidenceSigner.publicKeyPem,
      status: "active",
      createdAt: timestamp,
      activatedAt: timestamp,
    });
  }

  async signingKeys() {
    const keys = await this.store.listSigningKeys();
    return { schemaVersion: "agentcert.signing_keyset.v0.1", keys };
  }

  async signingKeyById(keyId: string): Promise<SigningKeyRecord> {
    const key = await this.store.getSigningKey(keyId);
    if (!key) throw new ControlPlaneError("Signing key was not found.", 404);
    return key;
  }

  async createWebhook(auth: AuthContext, projectId: string, input: unknown): Promise<{ webhook: PublicWebhookRecord; secret: string }> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    if (!this.webhookVault) throw new ControlPlaneError("Webhook signing is not configured.", 503);
    const body = record(input);
    const url = webhookUrl(requiredString(body, "url"));
    const eventTypes = stringList(body.eventTypes);
    if (eventTypes.length === 0 || eventTypes.length > 20) throw new ControlPlaneError("eventTypes must contain 1 to 20 event names.");
    return this.createWebhookRecord(auth, projectId, url, eventTypes);
  }

  async createTestWebhook(auth: AuthContext, projectId: string, publicUrl: string) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    if (!this.webhookVault) throw new ControlPlaneError("Webhook signing is not configured.", 503);
    const prefix = `${publicUrl.replace(/\/$/, "")}/v1/webhook-test-receiver/${encodeURIComponent(projectId)}/`;
    const existing = (await this.store.listWebhooks(projectId)).find((item) => !item.revokedAt && item.url.startsWith(prefix));
    if (existing) return { webhook: publicWebhook(existing), reused: true };
    const id = randomUUID();
    return { ...(await this.createWebhookRecord(auth, projectId, webhookUrl(`${prefix}${id}`), ["run.completed"], id)), reused: false };
  }

  private async createWebhookRecord(auth: AuthContext, projectId: string, url: URL, eventTypes: string[], id = randomUUID()): Promise<{ webhook: PublicWebhookRecord; secret: string }> {
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const webhook: WebhookRecord = {
      id, projectId, url: url.toString(), eventTypes, secretCiphertext: this.webhookVault!.encrypt(secret),
      createdBy: auth.userId!, createdAt: new Date().toISOString(),
    };
    await this.store.insertWebhook(webhook);
    return { webhook: publicWebhook(webhook), secret };
  }

  async acceptTestWebhook(projectId: string, webhookId: string, headers: Record<string, string | undefined>, bytes: Buffer, now = new Date()): Promise<void> {
    if (!this.webhookVault) throw new ControlPlaneError("Webhook signing is not configured.", 503);
    const webhook = (await this.store.listWebhooks(projectId)).find((item) => item.id === webhookId && !item.revokedAt);
    const timestamp = headers["x-agentcert-timestamp"];
    const signature = headers["x-agentcert-signature"];
    if (!webhook || !timestamp || !signature || !/^\d+$/.test(timestamp)) throw new ControlPlaneError("Webhook signature is invalid.", 401);
    if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > 300) throw new ControlPlaneError("Webhook timestamp is outside the accepted window.", 401);
    const expected = createWebhookSignature(this.webhookVault.decrypt(webhook.secretCiphertext), timestamp, bytes.toString("utf8"));
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(signature);
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) throw new ControlPlaneError("Webhook signature is invalid.", 401);
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(bytes.toString("utf8"))); }
    catch { throw new ControlPlaneError("Webhook body must be valid JSON.", 400); }
    if (event.projectId !== projectId || event.id !== headers["x-agentcert-event-id"] || event.type !== headers["x-agentcert-event"]) {
      throw new ControlPlaneError("Webhook headers do not match the signed event.", 400);
    }
  }

  async listWebhooks(auth: AuthContext, projectId: string) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const [webhooks, deliveries, jobs] = await Promise.all([
      this.store.listWebhooks(projectId),
      this.store.listWebhookDeliveries(projectId),
      this.store.listWebhookJobs(projectId),
    ]);
    return { webhooks: webhooks.map(publicWebhook), deliveries, jobs };
  }

  async revokeWebhook(auth: AuthContext, projectId: string, webhookId: string): Promise<PublicWebhookRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const webhook = await this.store.revokeWebhook(projectId, webhookId, new Date().toISOString());
    if (!webhook) throw new ControlPlaneError("Webhook was not found.", 404);
    return publicWebhook(webhook);
  }

  private async emitWebhook(projectId: string, type: string, id: string, data: unknown): Promise<void> {
    if (!this.webhookVault) return;
    const webhooks = (await this.store.listWebhooks(projectId)).filter((item) => !item.revokedAt && (item.eventTypes.includes(type) || item.eventTypes.includes("*")));
    if (webhooks.length === 0) return;
    const event: WebhookEvent = { id, type, projectId, occurredAt: new Date().toISOString(), data };
    await Promise.all(webhooks.map((webhook) => this.store.enqueueWebhookJob({
      id: randomUUID(),
      projectId,
      webhookId: webhook.id,
      eventId: event.id,
      eventType: event.type,
      payload: event as unknown as Record<string, unknown>,
      status: "pending",
      attemptCount: 0,
      maxAttempts: DEFAULT_WEBHOOK_MAX_ATTEMPTS,
      nextAttemptAt: event.occurredAt,
      createdAt: event.occurredAt,
    })));
  }

  async retryWebhookJob(auth: AuthContext, projectId: string, jobId: string): Promise<WebhookJobRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const job = await this.store.getWebhookJob(projectId, jobId);
    if (!job) throw new ControlPlaneError("Webhook job was not found.", 404);
    if (job.status !== "dead_letter") throw new ControlPlaneError("Only dead-letter webhook jobs can be retried.", 409);
    return this.store.updateWebhookJob({
      ...job,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date().toISOString(),
      lockedAt: undefined,
      lockedBy: undefined,
      lastResponseStatus: undefined,
      lastError: undefined,
      completedAt: undefined,
    });
  }

  async processWebhookJobs(
    workerId: string,
    now = new Date(),
    limit = 20,
    leaseMs = DEFAULT_WEBHOOK_LEASE_MS,
  ): Promise<{ claimed: number; delivered: number; retrying: number; deadLetter: number }> {
    if (!this.webhookVault) return { claimed: 0, delivered: 0, retrying: 0, deadLetter: 0 };
    const jobs = await this.store.claimWebhookJobs(
      workerId,
      now.toISOString(),
      new Date(now.getTime() - leaseMs).toISOString(),
      limit,
    );
    const result = { claimed: jobs.length, delivered: 0, retrying: 0, deadLetter: 0 };
    for (const job of jobs) {
      const webhook = (await this.store.listWebhooks(job.projectId)).find((item) => item.id === job.webhookId);
      if (!webhook || webhook.revokedAt) {
        await this.finishWebhookJob(job, undefined, "Webhook was removed or revoked before delivery.", now, result);
        continue;
      }
      const delivery = await deliverWebhook(webhook, job.payload as unknown as WebhookEvent, this.webhookVault, this.webhookFetch);
      await this.store.insertWebhookDelivery(delivery);
      await this.finishWebhookJob(job, delivery.responseStatus, delivery.error, now, result, delivery.status === "delivered");
    }
    return result;
  }

  private async finishWebhookJob(
    job: WebhookJobRecord,
    responseStatus: number | undefined,
    error: string | undefined,
    now: Date,
    result: { delivered: number; retrying: number; deadLetter: number },
    delivered = false,
  ): Promise<void> {
    const attemptCount = job.attemptCount + 1;
    if (delivered) {
      result.delivered += 1;
      await this.store.updateWebhookJob({
        ...job, status: "delivered", attemptCount, lastResponseStatus: responseStatus, lastError: undefined,
        lockedAt: undefined, lockedBy: undefined, completedAt: now.toISOString(),
      });
      return;
    }
    const deadLetter = attemptCount >= job.maxAttempts;
    result[deadLetter ? "deadLetter" : "retrying"] += 1;
    await this.store.updateWebhookJob({
      ...job,
      status: deadLetter ? "dead_letter" : "retrying",
      attemptCount,
      lastResponseStatus: responseStatus,
      lastError: error ?? "Webhook delivery failed.",
      nextAttemptAt: deadLetter ? now.toISOString() : new Date(now.getTime() + webhookRetryDelay(attemptCount)).toISOString(),
      lockedAt: undefined,
      lockedBy: undefined,
      completedAt: deadLetter ? now.toISOString() : undefined,
    });
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

  private async appendIncidentTransition(
    incident: IncidentRecord,
    fromStatus: IncidentStatus | undefined,
    toStatus: IncidentStatus,
    auth: AuthContext,
    reason: string,
    evidence: Record<string, unknown>,
  ): Promise<IncidentTransitionRecord> {
    return this.store.insertIncidentTransition({
      id: randomUUID(),
      projectId: incident.projectId,
      incidentId: incident.id,
      fromStatus,
      toStatus,
      actorType: auth.kind,
      actorId: auth.userId ?? auth.apiKeyId,
      actorEmail: auth.email,
      reason,
      evidence,
      occurredAt: new Date().toISOString(),
    });
  }

  private async sendIncidentNotification(
    alertType: Exclude<NotificationAlertType, "destination_verification">,
    incident: IncidentRecord,
    transition: IncidentTransitionRecord,
  ): Promise<void> {
    if (!this.emailProvider.configured) return;
    const destinations = (await this.store.listNotificationDestinations(incident.projectId))
      .filter((destination) => destination.status === "active" && destination.alertTypes.includes(alertType));
    const label = alertType.replace(/^incident_/, "").replace("regressed", "regressed to open");
    const subject = `[AgentCert] Production trust incident ${label}`;
    const details = [
      `Incident: ${incident.summary}`,
      `Status: ${incident.status}`,
      `Occurrences: ${incident.occurrenceCount}`,
      `Reason: ${transition.reason}`,
      `Project: ${incident.projectId}`,
    ].join("\n");
    await Promise.all(destinations.map((destination) => this.deliverEmail(destination, alertType, subject, {
      text: `${details}\n\nOpen AgentCert: ${this.publicUrl}`,
      html: `<p><strong>${escapeHtml(incident.summary)}</strong></p><ul><li>Status: ${escapeHtml(incident.status)}</li><li>Occurrences: ${incident.occurrenceCount}</li><li>Reason: ${escapeHtml(transition.reason)}</li></ul><p><a href="${escapeHtml(this.publicUrl)}">Open AgentCert</a></p>`,
    })));
  }

  private async deliverEmail(
    destination: NotificationDestinationRecord,
    alertType: NotificationAlertType,
    subject: string,
    content: { text: string; html: string },
    failRequest = false,
  ): Promise<void> {
    const attemptedAt = new Date().toISOString();
    try {
      const result = await this.emailProvider.send({ to: destination.email, subject, ...content });
      await this.store.insertNotificationDelivery({
        id: randomUUID(), projectId: destination.projectId, destinationId: destination.id, alertType, subject,
        status: "delivered", provider: result.provider, providerMessageId: result.messageId, attemptedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Email delivery failed.";
      await this.store.insertNotificationDelivery({
        id: randomUUID(), projectId: destination.projectId, destinationId: destination.id, alertType, subject,
        status: "failed", provider: this.emailProvider.name, error: message, attemptedAt,
      });
      if (failRequest) throw new ControlPlaneError(`Verification email could not be delivered: ${message}`, 502);
    }
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

function webhookRetryDelay(attemptCount: number): number {
  return Math.min(DEFAULT_WEBHOOK_RETRY_BASE_MS * (2 ** Math.max(0, attemptCount - 1)), MAX_WEBHOOK_RETRY_MS);
}
function publicApiKey(apiKey: ApiKeyRecord): PublicApiKeyRecord {
  const { secretHash: _secretHash, ...publicRecord } = apiKey;
  return publicRecord;
}

function publicWebhook(webhook: WebhookRecord): PublicWebhookRecord {
  const { secretCiphertext: _secretCiphertext, ...publicRecord } = webhook;
  return publicRecord;
}

type OperationalAlertStatus = "healthy" | "warning" | "critical";
function alert(status: OperationalAlertStatus, message: string) { return { status, message }; }

function sampleEvidence(sample: TrustHealthSampleRecord): Record<string, unknown> {
  return {
    sampleId: sample.id,
    externalId: sample.externalId,
    status: sample.status,
    completedAt: sample.completedAt,
    workflowRunId: sample.workflowRunId,
    workflowRunUrl: sample.workflowRunUrl,
    error: sample.error,
  };
}

function reviewReason(input: unknown): string {
  const reason = requiredString(record(input), "reason");
  if (reason.length < 10) throw new ControlPlaneError("reason must contain at least 10 characters.");
  if (reason.length > 2_000) throw new ControlPlaneError("reason cannot exceed 2000 characters.");
  return reason;
}

function notificationEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ControlPlaneError("email must be a valid address.");
  return email;
}

function notificationAlertTypes(value: unknown): NotificationAlertType[] {
  const allowed = new Set<NotificationAlertType>(["incident_opened", "incident_regressed", "incident_recovered", "incident_resolved"]);
  const selected = stringList(value);
  if (selected.length === 0 || selected.some((item) => !allowed.has(item as NotificationAlertType))) {
    throw new ControlPlaneError("alertTypes must contain one or more supported incident alert types.");
  }
  return selected as NotificationAlertType[];
}

function publicNotificationDestination(destination: NotificationDestinationRecord): PublicNotificationDestinationRecord {
  const { verificationTokenHash: _verificationTokenHash, ...publicRecord } = destination;
  return publicRecord;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function sloWindow(
  days: 30 | 90,
  counts: { total: number; passed: number; failed: number },
  objective: number,
) {
  if (counts.total === 0) return { days, ...counts, attainment: null, errorBudgetRemaining: null, burnRate: null };
  const attainment = counts.passed / counts.total;
  const allowedFailureRate = 1 - objective;
  const failureRate = counts.failed / counts.total;
  return {
    days,
    ...counts,
    attainment,
    errorBudgetRemaining: 1 - failureRate / allowedFailureRate,
    burnRate: failureRate / allowedFailureRate,
  };
}

function compactAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))}m`;
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

function trustHealthBuckets(samples: TrustHealthSampleRecord[], now: Date, days: number) {
  const byDate = new Map<string, TrustHealthSampleRecord[]>();
  for (const sample of samples) {
    const date = sample.completedAt.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), sample]);
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - index - 1)))
      .toISOString().slice(0, 10);
    const bucket = byDate.get(date) ?? [];
    const passed = bucket.filter((sample) => sample.status === "passed").length;
    const failed = bucket.length - passed;
    return { date, total: bucket.length, passed, failed, successRate: bucket.length ? passed / bucket.length : 0 };
  });
}

function fillWebhookBuckets(buckets: Array<{ date: string; total: number; delivered: number; retried: number; deadLetter: number; averageLatencyMs: number; p95LatencyMs: number }>, now: Date, days: number) {
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - index - 1)))
      .toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, total: 0, delivered: 0, retried: 0, deadLetter: 0, averageLatencyMs: 0, p95LatencyMs: 0 };
  });
}

function failureQualityMetrics(runs: RunRecord[], reviews: FailureReviewRecord[], evidence: EvidenceRecord[]): FailureQualityMetrics {
  const failedRuns = runs.filter((run) => run.status === "failed").length;
  const declaredFailures = evidence.reduce((total, item) => total + (typeof item.metadata.failurePatternCount === "number" ? item.metadata.failurePatternCount : 0), 0);
  const reviewedFailures = reviews.length;
  const confirmedFailures = reviews.filter((review) => review.status === "confirmed").length;
  const correctedFailures = reviews.filter((review) => review.status === "corrected").length;
  const ratio = (numerator: number, denominator: number) => denominator === 0 ? 0 : numerator / denominator;
  return {
    schemaVersion: "agentcert.failure_quality_metrics.v0.1",
    totalFailures: Math.max(declaredFailures, failedRuns, reviewedFailures),
    reviewedFailures,
    confirmedFailures,
    correctedFailures,
    reviewCoverage: ratio(reviewedFailures, Math.max(declaredFailures, failedRuns, reviewedFailures)),
    autoLabelPrecision: ratio(confirmedFailures, reviewedFailures),
    correctionRate: ratio(correctedFailures, reviewedFailures),
    calculatedAt: new Date().toISOString(),
  };
}

function inferFailurePatternCount(bytes: Buffer, contentType: string): number {
  if (contentType !== "application/json") return 0;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const results = Array.isArray(value.results) ? value.results : [];
    const findings = Array.isArray(value.findings) ? value.findings : [];
    return results.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return record.status === "failed" || record.passed === false || record.success === false;
    }).length + findings.length;
  } catch {
    return 0;
  }
}

function validateTraceIds(traceId?: string, spanId?: string, parentSpanId?: string): void {
  if (traceId && !isTraceId(traceId)) throw new ControlPlaneError("traceId must be 32 lowercase hex characters and cannot be all zeroes.");
  if (spanId && !isSpanId(spanId)) throw new ControlPlaneError("spanId must be 16 lowercase hex characters and cannot be all zeroes.");
  if (parentSpanId && !isSpanId(parentSpanId)) throw new ControlPlaneError("parentSpanId must be 16 lowercase hex characters and cannot be all zeroes.");
}

function webhookUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ControlPlaneError("Webhook URL must be a valid absolute URL."); }
  if (url.protocol !== "https:") throw new ControlPlaneError("Webhook URL must use HTTPS.");
  if (url.username || url.password) throw new ControlPlaneError("Webhook URL cannot contain credentials.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host)) {
    throw new ControlPlaneError("Webhook URL cannot target loopback, link-local, or private networks.");
  }
  return url;
}

function isPrivateAddress(host: string): boolean {
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
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
function requiredTimestamp(value: Record<string, unknown>, key: string): string {
  const result = requiredString(value, key);
  if (!Number.isFinite(Date.parse(result))) throw new ControlPlaneError(`${key} must be a valid timestamp.`);
  return new Date(result).toISOString();
}
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
