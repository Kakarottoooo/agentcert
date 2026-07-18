import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ArtifactStore } from "./artifacts.js";
import { hashSecret } from "./auth.js";
import {
  EvidenceQuotaExceededError,
  LegalHoldStateConflictError,
  TeamStateConflictError,
  TrustedCollectorConflictError,
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
  NotificationJobRecord,
  PublicNotificationVerificationResult,
  PilotFeedbackCategory,
  PilotFeedbackOutcome,
  PilotFeedbackRecord,
  PilotFeedbackStage,
  PilotFunnelReport,
  PilotFunnelSource,
  Project,
  ProjectOnboardingStatus,
  TrustHealthBurnWindow,
  WebhookJobRecord,
  WebhookRecord,
  AssuranceCaseRecord,
  AssuranceCaseDecisionRecord,
  AssuranceCaseStatus,
  MemberRole,
  TeamAuditAction,
  TeamAuditRecord,
  TeamInvitationRecord,
  TeamSnapshot,
  CollectorSourceKeyRecord,
  CollectorHeartbeatRecord,
} from "./types.js";
import { DisabledEmailProvider, type EmailProvider } from "./notifications.js";
import { EnvelopeValidationError, isSpanId, isTraceId, parseUniversalEnvelope, type UniversalEnvelope } from "./protocol.js";
import { EvidenceSigner, type EvidenceAttestationPayload } from "./signing.js";
import { buildAssuranceDeliveryPacket, buildAssuranceReport, canTransitionAssuranceCase, evaluationPlanDigest, missingRequiredEvidence } from "./assurance.js";
import {
  applyContinuousAssuranceObservation,
  assuranceScopeFingerprint,
  buildContinuousAssuranceAdoptionKit,
  createContinuousAssuranceContract,
  createContinuousAssuranceRevalidation,
  forceContinuousAssuranceFreshness,
  markContinuousAssuranceAdopted,
  markContinuousAssuranceCurrent,
  markContinuousAssuranceExpiryReminder,
  normalizeAssuranceScope,
  reconcileContinuousAssurance,
  type AssuranceScopeInput,
  type AssuranceTrigger,
} from "./continuous-assurance.js";
import type { CoordinationHealth } from "./coordination.js";
import { canInviteRole, canManageMember, roleNeedsExplicitProjects, rolesForHumanScope } from "./rbac.js";
import {
  DEFAULT_API_KEY_SCOPES,
  WebhookSecretVault,
  createWebhookSignature,
  deliverWebhook,
  parseApiKeyScopes,
  type WebhookEvent,
} from "./security.js";
import {
  parseCollectorKeyRegistration,
  parseSignedCollectorHeartbeat,
  parseTrustedRecordBatch,
  parseTrustedRunReceipt,
  verifyCollectorHeartbeat,
  verifyTrustedRunReceiptInput,
  verifyTrustedSourceRecord,
} from "./trusted-collector.js";

const POLICY_VERSION = "agentcert.default.v1";
const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;
const DEFAULT_WEBHOOK_LEASE_MS = 60_000;
const DEFAULT_WEBHOOK_RETRY_BASE_MS = 5_000;
const MAX_WEBHOOK_RETRY_MS = 60 * 60 * 1000;
const PRODUCTION_SMOKE_FINGERPRINT = "trust-operations:production-smoke";
const SLO_BURN_FINGERPRINT = "trust-operations:slo-burn-rate";
const TRUST_SLO_OBJECTIVE = 0.99;
const DEFAULT_NOTIFICATION_MAX_ATTEMPTS = 5;
const DEFAULT_NOTIFICATION_LEASE_MS = 60_000;
const DEFAULT_NOTIFICATION_RETRY_BASE_MS = 60_000;
const MAX_NOTIFICATION_RETRY_MS = 6 * 60 * 60 * 1000;
const TEST_NOTIFICATION_COOLDOWN_MS = 60_000;
const ASSURANCE_EXPIRY_REMINDER_DAYS = [1, 7, 30] as const;

interface SloBurnEvaluation {
  status: "healthy" | "warning" | "critical";
  reason: string;
  windows: TrustHealthBurnWindow[];
  policy: {
    objective: number;
    fastBurn: { shortWindow: "1h"; longWindow: "6h"; shortThreshold: number; longThreshold: number; minimumSamples: number };
    slowBurn: { shortWindow: "6h"; longWindow: "24h"; shortThreshold: number; longThreshold: number; minimumShortSamples: number; minimumLongSamples: number };
  };
}

interface RunContinuousAssuranceBinding {
  schemaVersion: "agentcert.run_assurance.v0.1";
  caseId: string;
  trigger: AssuranceTrigger;
  scope: AssuranceScopeInput;
  scopeFingerprintSha256: string;
}

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "control_plane_error",
    readonly recovery?: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
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

  async teamSnapshot(auth: AuthContext, organizationId: string): Promise<TeamSnapshot> {
    const membership = await this.authorizeOrganization(auth, organizationId);
    const [organization, members, invitations, audit] = await Promise.all([
      this.store.getOrganization(organizationId), this.store.listTeamMembers(organizationId),
      this.store.listTeamInvitations(organizationId), this.store.listTeamAudit(organizationId),
    ]);
    if (!organization) throw new ControlPlaneError("Organization was not found.", 404, "organization_not_found");
    const currentMembership = members.find((item) => item.userId === membership.userId);
    if (!currentMembership) throw new ControlPlaneError("Organization access denied.", 403, "organization_access_denied");
    return { organization, currentMembership, members, invitations: invitations.map(publicTeamInvitation), audit };
  }

  async createTeamInvitation(auth: AuthContext, organizationId: string, input: unknown): Promise<Omit<TeamInvitationRecord, "tokenHash">> {
    const actor = await this.authorizeOrganization(auth, organizationId, ["owner", "admin"]);
    const body = record(input);
    const email = normalizedEmail(requiredString(body, "email"));
    const role = memberRole(body.role);
    if (!canInviteRole(actor.role, role)) throw new ControlPlaneError(
      `An ${actor.role} cannot invite an ${role}.`, 403, "team_role_assignment_forbidden",
      "Organization owners can manage every role; admins can invite operators and viewers.",
    );
    const projectIds = await this.validateTeamProjectIds(organizationId, role, stringList(body.projectIds));
    const [organization, members, existingInvitations] = await Promise.all([
      this.store.getOrganization(organizationId), this.store.listTeamMembers(organizationId), this.store.listTeamInvitations(organizationId),
    ]);
    if (!organization) throw new ControlPlaneError("Organization was not found.", 404, "organization_not_found");
    if (members.some((item) => item.email?.toLowerCase() === email)) throw new ControlPlaneError("This email is already a team member.", 409, "team_member_exists");
    for (const existing of existingInvitations) {
      if (existing.status === "pending" && existing.email.toLowerCase() === email && Date.parse(existing.expiresAt) <= Date.now()) {
        await this.store.updateTeamInvitation({ ...existing, status: "expired" });
      }
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const invitation: TeamInvitationRecord = {
      id: randomUUID(), organizationId, email, role, projectIds, tokenHash: createHash("sha256").update(token).digest("hex"),
      status: "pending", deliveryStatus: "pending", invitedBy: actor.userId, invitedByEmail: auth.email,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), createdAt: now.toISOString(),
    };
    try {
      await this.store.saveTeamInvitation(invitation);
    } catch (error) {
      throw this.teamConflict(error);
    }
    await this.store.appendTeamAudit(this.teamAudit(organizationId, "invitation_created", auth, {
      targetEmail: email, metadata: { invitationId: invitation.id, role, projectIds },
    }));
    const invitationUrl = `${this.publicUrl.replace(/\/$/, "")}/app?invite=${encodeURIComponent(token)}`;
    try {
      await this.emailProvider.send({
        to: email,
        subject: `Join ${organization.name} on AgentCert`,
        text: `${auth.email ?? "An AgentCert administrator"} invited you to join ${organization.name} as ${role}. Accept within 7 days: ${invitationUrl}`,
        html: `<p>${escapeHtml(auth.email ?? "An AgentCert administrator")} invited you to join <strong>${escapeHtml(organization.name)}</strong> as <strong>${escapeHtml(role)}</strong>.</p><p><a href="${escapeHtml(invitationUrl)}">Accept invitation</a></p><p>This link expires in 7 days. The signed-in email must match ${escapeHtml(email)}.</p>`,
      });
      const sent = await this.store.updateTeamInvitation({ ...invitation, deliveryStatus: "sent", sentAt: new Date().toISOString() });
      return publicTeamInvitation(sent);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Email delivery failed.";
      const failed = await this.store.updateTeamInvitation({ ...invitation, deliveryStatus: "failed", deliveryError: message });
      await this.store.appendTeamAudit(this.teamAudit(organizationId, "invitation_delivery_failed", auth, {
        targetEmail: email, metadata: { invitationId: invitation.id, provider: this.emailProvider.name },
      }));
      throw new ControlPlaneError(
        "The invitation was created, but its email could not be delivered.", 502, "team_invitation_delivery_failed",
        `Revoke the failed invitation and retry after email delivery is restored. Invitation: ${failed.id}`,
      );
    }
  }

  async revokeTeamInvitation(auth: AuthContext, organizationId: string, invitationId: string): Promise<Omit<TeamInvitationRecord, "tokenHash">> {
    const actor = await this.authorizeOrganization(auth, organizationId, ["owner", "admin"]);
    const invitation = (await this.store.listTeamInvitations(organizationId)).find((item) => item.id === invitationId);
    if (!invitation || invitation.status !== "pending") throw new ControlPlaneError("Pending invitation was not found.", 404, "team_invitation_not_found");
    if (!canInviteRole(actor.role, invitation.role)) throw new ControlPlaneError("You cannot revoke this invitation.", 403, "team_invitation_revoke_forbidden");
    const revoked = await this.store.updateTeamInvitation({ ...invitation, status: "revoked", revokedAt: new Date().toISOString() });
    await this.store.appendTeamAudit(this.teamAudit(organizationId, "invitation_revoked", auth, {
      targetEmail: invitation.email, metadata: { invitationId, role: invitation.role },
    }));
    return publicTeamInvitation(revoked);
  }

  async acceptTeamInvitation(auth: AuthContext, input: unknown): Promise<{ organizationId: string; projectId: string }> {
    requireUser(auth);
    const token = requiredString(record(input), "token");
    const invitation = await this.store.getTeamInvitationByTokenHash(createHash("sha256").update(token).digest("hex"));
    if (!invitation || invitation.status !== "pending") throw new ControlPlaneError("Invitation is invalid or no longer available.", 410, "team_invitation_unavailable");
    if (Date.parse(invitation.expiresAt) <= Date.now()) {
      await this.store.updateTeamInvitation({ ...invitation, status: "expired" });
      throw new ControlPlaneError("Invitation has expired.", 410, "team_invitation_expired", "Ask an organization owner or admin to send a new invitation.");
    }
    if (!auth.email || auth.email.toLowerCase() !== invitation.email.toLowerCase()) throw new ControlPlaneError(
      `This invitation is for ${invitation.email}.`, 403, "team_invitation_email_mismatch",
      "Sign out and use the invited email address, or ask an owner to invite the correct address.",
    );
    const membership = { organizationId: invitation.organizationId, userId: auth.userId, email: auth.email, role: invitation.role, createdAt: new Date().toISOString() };
    const audit = this.teamAudit(invitation.organizationId, "invitation_accepted", auth, {
      targetUserId: auth.userId, targetEmail: auth.email, metadata: { invitationId: invitation.id, role: invitation.role, projectIds: invitation.projectIds },
    });
    try {
      await this.store.acceptTeamInvitation(invitation.id, membership, invitation.projectIds, audit);
    } catch (error) {
      throw this.teamConflict(error);
    }
    const projects = (await this.store.listProjectsForUser(auth.userId)).filter((item) => item.organizationId === invitation.organizationId);
    const project = projects[0];
    if (!project) throw new ControlPlaneError("Invitation did not grant access to a project.", 409, "team_project_access_missing");
    return { organizationId: invitation.organizationId, projectId: project.id };
  }

  async updateTeamMember(auth: AuthContext, organizationId: string, userId: string, input: unknown) {
    const actor = await this.authorizeOrganization(auth, organizationId, ["owner", "admin"]);
    const target = (await this.store.listTeamMembers(organizationId)).find((item) => item.userId === userId);
    if (!target) throw new ControlPlaneError("Team member was not found.", 404, "team_member_not_found");
    const body = record(input);
    const role = body.role === undefined ? target.role : memberRole(body.role);
    if (!canManageMember(actor.role, target.role, role)) throw new ControlPlaneError("You cannot change this member.", 403, "team_member_manage_forbidden");
    const projectIds = await this.validateTeamProjectIds(organizationId, role, body.projectIds === undefined ? target.projectIds : stringList(body.projectIds));
    const action: TeamAuditAction = role !== target.role ? "member_role_changed" : "member_project_access_changed";
    const audit = this.teamAudit(organizationId, action, auth, {
      targetUserId: userId, targetEmail: target.email, metadata: { previousRole: target.role, role, previousProjectIds: target.projectIds, projectIds },
    });
    try {
      return await this.store.updateTeamMember(organizationId, userId, role, projectIds, actor.userId, audit);
    } catch (error) { throw this.teamConflict(error); }
  }

  async removeTeamMember(auth: AuthContext, organizationId: string, userId: string): Promise<void> {
    const actor = await this.authorizeOrganization(auth, organizationId, ["owner", "admin"]);
    const target = (await this.store.listTeamMembers(organizationId)).find((item) => item.userId === userId);
    if (!target) throw new ControlPlaneError("Team member was not found.", 404, "team_member_not_found");
    if (!canManageMember(actor.role, target.role)) throw new ControlPlaneError("You cannot remove this member.", 403, "team_member_manage_forbidden");
    const audit = this.teamAudit(organizationId, "member_removed", auth, { targetUserId: userId, targetEmail: target.email, metadata: { role: target.role, projectIds: target.projectIds } });
    try { await this.store.removeTeamMember(organizationId, userId, audit); }
    catch (error) { throw this.teamConflict(error); }
  }

  async createProject(auth: AuthContext, input: unknown): Promise<Project> {
    requireUser(auth);
    const body = record(input);
    const requestedOrganizationId = optionalString(body, "organizationId");
    const bootstrap = requestedOrganizationId ? undefined : await this.store.bootstrapUser(auth.userId, auth.email);
    const membership = requestedOrganizationId
      ? await this.authorizeOrganization(auth, requestedOrganizationId, ["owner", "admin"])
      : bootstrap!.membership;
    const organizationId = requestedOrganizationId ?? bootstrap!.organization.id;
    if (!new Set(["owner", "admin"]).has(membership.role)) throw new ControlPlaneError("Only organization owners and admins can create projects.", 403, "project_create_forbidden");
    const existing = (await this.store.listProjectsForUser(auth.userId))
      .filter((project) => project.organizationId === organizationId);
    if (existing.length >= 20) {
      throw new ControlPlaneError(
        "This organization has reached the 20 project limit.", 409, "project_limit_reached",
        "Archive an unused project or contact AgentCert support before creating another project.",
      );
    }
    const name = projectName(body);
    const baseSlug = slugifyProject(name);
    const slugs = new Set(existing.map((project) => project.slug));
    let slug = baseSlug;
    while (slugs.has(slug)) slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
    return this.store.insertProject({
      id: randomUUID(), organizationId, name, slug, createdAt: new Date().toISOString(),
    });
  }

  async renameProject(auth: AuthContext, projectId: string, input: unknown): Promise<Project> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const project = await this.store.getProject(projectId);
    if (!project) throw new ControlPlaneError("Project was not found.", 404, "project_not_found");
    return this.store.updateProject({ ...project, name: projectName(record(input)) });
  }

  async onboardingStatus(auth: AuthContext, projectId: string): Promise<ProjectOnboardingStatus> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const [keys, runs, evidence] = await Promise.all([
      this.store.listApiKeys(projectId), this.store.listRuns(projectId, 1), this.store.listEvidence(projectId, 1),
    ]);
    const activeKeys = keys.filter((key) => !key.revokedAt);
    const firstKey = [...activeKeys].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    const firstUsedKey = [...activeKeys].filter((key) => key.lastUsedAt)
      .sort((left, right) => left.lastUsedAt!.localeCompare(right.lastUsedAt!))[0];
    const firstEvidence = [...evidence].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    const createKeyComplete = Boolean(firstKey);
    const connectComplete = Boolean(firstUsedKey);
    const evidenceComplete = Boolean(firstEvidence);
    const steps: ProjectOnboardingStatus["steps"] = [
      {
        id: "create_key", status: createKeyComplete ? "complete" : "pending", completedAt: firstKey?.createdAt,
        diagnosis: createKeyComplete ? undefined : {
          code: "api_key_missing", message: "No active project API key exists.",
          recovery: "Open Integrations, create a scoped API key, and store the one-time secret securely.",
        },
      },
      {
        id: "connect_cli", status: connectComplete ? "complete" : "pending", completedAt: firstUsedKey?.lastUsedAt,
        diagnosis: connectComplete ? undefined : {
          code: createKeyComplete ? "api_key_unused" : "api_key_required",
          message: createKeyComplete ? "The key has not authenticated a CLI request yet." : "Create an API key before connecting the CLI.",
          recovery: createKeyComplete
            ? `Run npx agentcert connect --server ${this.publicUrl} --project ${projectId}, then verify the saved connection.`
            : "Complete the Create key step first.",
        },
      },
      {
        id: "upload_evidence", status: evidenceComplete ? "complete" : "pending", completedAt: firstEvidence?.createdAt,
        diagnosis: evidenceComplete ? undefined : {
          code: runs.length ? "run_without_evidence" : connectComplete ? "first_run_missing" : "cli_connection_required",
          message: runs.length ? "A run exists, but it has no uploaded evidence." : "No AgentCert evidence has reached this project yet.",
          recovery: connectComplete
            ? "Run npx agentcert run --tripwire <result.json> --push, then refresh this page."
            : "Connect the CLI before uploading the first evidence bundle.",
        },
      },
    ];
    return {
      projectId, complete: steps.every((step) => step.status === "complete"), completedSteps: steps.filter((step) => step.status === "complete").length,
      totalSteps: 3, steps,
      connection: {
        baseUrl: this.publicUrl, projectId,
        command: `npx agentcert connect --server ${this.publicUrl} --project ${projectId}`,
      },
    };
  }

  async submitPilotFeedback(auth: AuthContext, projectId: string, input: unknown): Promise<PilotFeedbackRecord> {
    await this.authorizeProject(auth, projectId);
    requireUser(auth);
    const body = record(input);
    const feedback: PilotFeedbackRecord = {
      id: randomUUID(), projectId, userId: auth.userId,
      stage: enumValue(body.stage, "stage", PILOT_FEEDBACK_STAGES),
      category: enumValue(body.category, "category", PILOT_FEEDBACK_CATEGORIES),
      outcome: enumValue(body.outcome, "outcome", PILOT_FEEDBACK_OUTCOMES),
      reasonCode: boundedToken(body.reasonCode, "reasonCode", 80),
      message: boundedText(body.message, "message", 2_000),
      context: pilotFeedbackContext(body.context), createdAt: new Date().toISOString(),
    };
    return this.store.insertPilotFeedback(feedback);
  }

  async listPilotFeedback(auth: AuthContext, projectId: string): Promise<PilotFeedbackRecord[]> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    return this.store.listPilotFeedback(projectId, 500);
  }

  async pilotFunnelReport(auth: AuthContext, days: number): Promise<PilotFunnelReport> {
    this.requirePlatformAdmin(auth);
    if (days !== 7 && days !== 30 && days !== 90) {
      throw new ControlPlaneError("days must be 7, 30, or 90.", 422, "invalid_pilot_period");
    }
    const generatedAt = new Date();
    const since = new Date(generatedAt.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
    return buildPilotFunnelReport(await this.store.pilotFunnelSource(since), days, since, generatedAt.toISOString());
  }

  async createAssuranceCase(auth: AuthContext, projectId: string, input: unknown): Promise<AssuranceCaseRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    const body = record(input);
    const subject = record(body.subject);
    const planInput = record(body.evaluationPlan);
    const controlsInput = Array.isArray(planInput.controls) ? planInput.controls : [];
    const controls = controlsInput.map((value, index) => {
      const control = record(value);
      const mode = control.mode === "automated" || control.mode === "evidence_required" || control.mode === "manual" ? control.mode : undefined;
      if (!mode) throw new ControlPlaneError(`evaluationPlan.controls[${index}].mode is invalid.`);
      return { id: requiredString(control, "id"), title: requiredString(control, "title"), mode: mode as "automated" | "evidence_required" | "manual" };
    });
    if (controls.length === 0) throw new ControlPlaneError("evaluationPlan.controls must contain at least one control.");
    const evaluationPlan: AssuranceCaseRecord["evaluationPlan"] = {
      requiredEvidenceKinds: strictStringList(planInput.requiredEvidenceKinds, "evaluationPlan.requiredEvidenceKinds", ["evidence_bundle"]),
      controls,
      limitations: strictStringList(planInput.limitations, "evaluationPlan.limitations", ["The assessment covers only the declared subject version and evaluation plan."]),
    };
    const now = new Date().toISOString();
    const engagementInput = optionalRecord(body.engagement);
    const subjectVersion = optionalString(subject, "version");
    if (engagementInput && !subjectVersion) throw new ControlPlaneError("subject.version is required for a 7-Day Assurance Review engagement.", 422);
    const engagement = engagementInput ? assuranceEngagement(engagementInput, now) : undefined;
    const continuousInput = optionalRecord(body.continuousAssurance);
    let continuousAssurance: AssuranceCaseRecord["continuousAssurance"];
    if (continuousInput) {
      try {
        continuousAssurance = createContinuousAssuranceContract(continuousInput.scope, now);
      } catch (error) {
        throw new ControlPlaneError(error instanceof Error ? error.message : "continuousAssurance.scope is invalid.", 422, "assurance_scope_invalid");
      }
    }
    const assuranceCase: AssuranceCaseRecord = {
      id: randomUUID(), projectId, name: requiredString(body, "name"),
      subject: { id: requiredString(subject, "id"), name: requiredString(subject, "name"), version: subjectVersion, kind: requiredString(subject, "kind") },
      status: "draft", policyPackVersion: requiredString(body, "policyPackVersion"), evaluationPlan,
      evaluationPlanSha256: evaluationPlanDigest(evaluationPlan), evidenceIds: [], engagement, continuousAssurance,
      createdBy: auth.userId, createdAt: now, updatedAt: now,
    };
    const decision = assuranceDecision(assuranceCase, auth, undefined, "draft", "Assurance case created.", now);
    return this.store.insertAssuranceCaseWithDecision(assuranceCase, decision);
  }

  async listAssuranceCases(auth: AuthContext, projectId: string): Promise<AssuranceCaseRecord[]> {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    return Promise.all((await this.store.listAssuranceCases(projectId)).map((item) => this.expireAssuranceCaseIfNeeded(item)));
  }

  async getAssuranceCase(auth: AuthContext, projectId: string, caseId: string) {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    const found = await this.store.getAssuranceCase(projectId, caseId);
    if (!found) throw new ControlPlaneError("Assurance case was not found.", 404);
    const assuranceCase = await this.expireAssuranceCaseIfNeeded(found);
    return { assuranceCase, decisions: await this.store.listAssuranceCaseDecisions(projectId, caseId) };
  }

  async transitionAssuranceCase(auth: AuthContext, projectId: string, caseId: string, action: string, input: unknown) {
    if (action === "revalidate") return { assuranceCase: await this.createAssuranceRevalidation(auth, projectId, caseId) };
    if (action === "activate-continuous") return this.activateContinuousAssurance(auth, projectId, caseId);
    if (action === "baseline" || action === "remediation" || action === "retest") {
      return this.updateAssuranceEngagement(auth, projectId, caseId, action, input);
    }
    const privileged: MemberRole[] = action === "issue" ? ["owner", "admin", "operator"] : ["owner", "admin"];
    await this.authorizeProject(auth, projectId, privileged);
    requireUser(auth);
    const current = await this.store.getAssuranceCase(projectId, caseId);
    if (!current) throw new ControlPlaneError("Assurance case was not found.", 404);
    const target = assuranceTarget(action);
    if (!canTransitionAssuranceCase(current.status, target)) {
      throw new ControlPlaneError(`Assurance case cannot transition from ${current.status} to ${target}.`, 409, "assurance_transition_invalid");
    }
    const body = record(input);
    const evidenceIds = body.evidenceIds === undefined ? current.evidenceIds : strictStringList(body.evidenceIds, "evidenceIds");
    const evidence = await Promise.all(evidenceIds.map(async (id) => {
      const item = await this.store.getEvidence(projectId, id);
      if (!item) throw new ControlPlaneError(`Evidence ${id} was not found in this project.`, 422, "assurance_evidence_missing");
      return item;
    }));
    if (target === "review_required" || target === "issued") {
      const missing = missingRequiredEvidence({ ...current, evidenceIds }, evidence);
      if (missing.length) throw new ControlPlaneError(`Required evidence kinds are missing: ${missing.join(", ")}.`, 422, "assurance_evidence_incomplete");
      if (current.engagement && (!current.engagement.baseline || !current.engagement.retest)) {
        throw new ControlPlaneError("The engagement requires a recorded baseline and its one included retest before review.", 422, "assurance_engagement_incomplete");
      }
    }
    if (target === "issued" && current.createdBy === auth.userId) {
      throw new ControlPlaneError("The assurance case creator cannot issue its report. A separate reviewer is required.", 403, "assurance_reviewer_separation_required");
    }
    const now = new Date();
    const next: AssuranceCaseRecord = { ...current, status: target, evidenceIds, updatedAt: now.toISOString() };
    if (target === "issued") {
      if (!this.evidenceSigner) throw new ControlPlaneError("Server evidence signing is required before an assurance report can be issued.", 503, "assurance_signing_required");
      const expiresAt = assuranceExpiry(body.expiresAt, now);
      next.reviewerId = auth.userId;
      next.expiresAt = expiresAt;
      if (current.continuousAssurance) next.continuousAssurance = markContinuousAssuranceCurrent(current.continuousAssurance, now.toISOString());
      if (current.engagement) next.engagement = { ...current.engagement, decision: assuranceEngagementDecision(body, current.engagement.workflow.expectedOutcome, auth.userId, now.toISOString()) };
      next.report = buildAssuranceReport(next, evidence, auth.userId, now.toISOString(), expiresAt, this.evidenceSigner);
      if (next.engagement) next.deliveryPacket = buildAssuranceDeliveryPacket(next, evidence, auth.userId, now.toISOString(), this.evidenceSigner);
      if (body.publish === true) next.publicVerificationId = randomBytes(24).toString("base64url");
    } else if (current.continuousAssurance && target === "suspended") {
      next.continuousAssurance = forceContinuousAssuranceFreshness(current.continuousAssurance, "SUSPENDED", "manually_suspended", "A project administrator suspended this assurance case.", now.toISOString());
    } else if (current.continuousAssurance && target === "expired") {
      next.continuousAssurance = forceContinuousAssuranceFreshness(current.continuousAssurance, "EXPIRED", "expired", "The assurance report was marked expired.", now.toISOString());
    } else if (current.continuousAssurance && target === "revoked") {
      next.continuousAssurance = forceContinuousAssuranceFreshness(current.continuousAssurance, "SUSPENDED", "case_revoked", "The underlying assurance case was revoked.", now.toISOString());
    } else if (current.continuousAssurance && target === "evaluating") {
      next.continuousAssurance = forceContinuousAssuranceFreshness(current.continuousAssurance, "REVALIDATION_REQUIRED", "initial_review_pending", "The assurance scope is being re-evaluated.", now.toISOString());
    }
    const reason = requiredString(body, "reason");
    const decision = assuranceDecision(next, auth, current.status, target, reason, now.toISOString());
    const updated = await this.store.transitionAssuranceCase(next, decision, current.status);
    if (!updated) throw new ControlPlaneError("Assurance case changed concurrently. Reload and retry.", 409, "assurance_transition_conflict");
    await this.notifyContinuousAssuranceChange(current, updated);
    return { assuranceCase: updated, decision };
  }

  private async createAssuranceRevalidation(auth: AuthContext, projectId: string, caseId: string): Promise<AssuranceCaseRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    const current = await this.store.getAssuranceCase(projectId, caseId);
    if (!current?.continuousAssurance) throw new ControlPlaneError("This assurance case does not have a continuous assurance contract.", 409, "continuous_assurance_required");
    if (current.continuousAssurance.freshness.status === "CURRENT") throw new ControlPlaneError("The assurance scope is already current.", 409, "continuous_assurance_already_current");
    const existing = (await this.store.listAssuranceCases(projectId, 500)).find(
      (item) => item.continuousAssurance?.supersedesCaseId === current.id,
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const scope = current.continuousAssurance.lastObservedScope ?? current.continuousAssurance.scope;
    const next: AssuranceCaseRecord = {
      id: randomUUID(),
      projectId,
      name: `${current.name} revalidation`,
      subject: { ...current.subject, version: scope.agent.version },
      status: "draft",
      policyPackVersion: scope.policy.version,
      evaluationPlan: structuredClone(current.evaluationPlan),
      evaluationPlanSha256: current.evaluationPlanSha256,
      evidenceIds: [],
      createdBy: auth.userId,
      continuousAssurance: createContinuousAssuranceRevalidation(current.continuousAssurance, scope, now, current.id),
      createdAt: now,
      updatedAt: now,
    };
    return this.store.insertAssuranceCaseWithDecision(next, assuranceDecision(next, auth, undefined, "draft", `Revalidation created for ${current.id}.`, now));
  }

  private async activateContinuousAssurance(auth: AuthContext, projectId: string, caseId: string) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.getAssuranceCase(projectId, caseId);
      if (!current) throw new ControlPlaneError("Assurance case was not found.", 404);
      if (!(await this.hasSevenDayAssuranceOrigin(projectId, current))) throw new ControlPlaneError(
        "Continuous CI activation is available after a 7-Day Assurance Review.", 409, "assurance_engagement_required",
      );
      if (current.status !== "issued" || !current.report) throw new ControlPlaneError(
        "Issue the independently reviewed assurance report before activating continuous CI.", 409, "assurance_case_not_issued",
      );
      if (!current.continuousAssurance) throw new ControlPlaneError(
        "This review does not contain a locked continuous assurance scope.", 409, "continuous_assurance_required",
      );
      if (current.continuousAssurance.freshness.status !== "CURRENT") throw new ControlPlaneError(
        "Revalidate the assurance scope before activating continuous CI.", 409, "continuous_assurance_not_current",
      );
      const generatedAt = current.continuousAssurance.adoption?.activatedAt
        ?? new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
      const kit = buildContinuousAssuranceAdoptionKit({
        contract: current.continuousAssurance, projectId, assuranceCaseId: current.id, generatedAt,
      });
      if (current.continuousAssurance.adoption) return { assuranceCase: current, kit };
      const workflowSha256 = kit.files.find((file) => file.path.endsWith(".yml"))!.sha256;
      const next: AssuranceCaseRecord = {
        ...current,
        continuousAssurance: markContinuousAssuranceAdopted(current.continuousAssurance, generatedAt, auth.userId, workflowSha256),
        updatedAt: generatedAt,
      };
      const updated = await this.store.updateAssuranceCase(next, current.status, current.updatedAt);
      if (updated) return { assuranceCase: updated, kit };
    }
    throw new ControlPlaneError("Assurance case changed concurrently. Reload and retry.", 409, "assurance_transition_conflict");
  }

  private async hasSevenDayAssuranceOrigin(projectId: string, assuranceCase: AssuranceCaseRecord): Promise<boolean> {
    let current: AssuranceCaseRecord | undefined = assuranceCase;
    const visited = new Set<string>();
    for (let depth = 0; current && depth < 50; depth += 1) {
      if (current.engagement) return true;
      const sourceCaseId = current.continuousAssurance?.supersedesCaseId;
      if (!sourceCaseId || visited.has(sourceCaseId)) return false;
      visited.add(sourceCaseId);
      current = await this.store.getAssuranceCase(projectId, sourceCaseId);
    }
    return false;
  }

  private async updateAssuranceEngagement(
    auth: AuthContext,
    projectId: string,
    caseId: string,
    action: "baseline" | "remediation" | "retest",
    input: unknown,
  ) {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    requireUser(auth);
    const current = await this.store.getAssuranceCase(projectId, caseId);
    if (!current) throw new ControlPlaneError("Assurance case was not found.", 404);
    if (!current.engagement) throw new ControlPlaneError("This assurance case is not a 7-Day Assurance Review engagement.", 409, "assurance_engagement_required");
    if (current.status !== "evaluating") throw new ControlPlaneError("Engagement evidence can only be recorded while the case is evaluating.", 409, "assurance_engagement_not_evaluating");
    const body = record(input);
    const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
    let engagement = current.engagement;
    let evidenceIds = current.evidenceIds;

    if (action === "remediation") {
      if (engagement.retest) throw new ControlPlaneError("Remediation is locked after the included retest is recorded.", 409, "assurance_remediation_locked");
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0 || items.length > 100) throw new ControlPlaneError("items must contain between 1 and 100 remediation items.", 422);
      const proposed = items.map((value, index) => {
        const item = record(value);
        const status: "open" | "addressed" | "accepted" = item.status === "open" || item.status === "addressed" || item.status === "accepted" ? item.status : "open";
        return {
          id: optionalString(item, "id") ?? `remediation-${index + 1}`,
          title: requiredString(item, "title"),
          status,
          owner: optionalString(item, "owner"),
          evidenceIds: item.evidenceIds === undefined ? [] : strictStringList(item.evidenceIds, `items[${index}].evidenceIds`),
        };
      });
      if (new Set(proposed.map((item) => item.id)).size !== proposed.length) throw new ControlPlaneError("Remediation item IDs must be unique.", 422);
      for (const existing of engagement.remediationItems) {
        const updated = proposed.find((item) => item.id === existing.id);
        if (!updated) throw new ControlPlaneError(`Remediation item ${existing.id} cannot be removed after it is recorded.`, 409, "assurance_remediation_item_locked");
        if (updated.title !== existing.title) throw new ControlPlaneError(`Remediation item ${existing.id} title is immutable.`, 409, "assurance_remediation_item_locked");
        const order = { open: 0, addressed: 1, accepted: 2 } as const;
        if (order[updated.status] < order[existing.status]) throw new ControlPlaneError(`Remediation item ${existing.id} cannot move backward.`, 409, "assurance_remediation_state_regression");
      }
      engagement = {
        ...engagement,
        remediationItems: proposed,
      };
      const referenced = engagement.remediationItems.flatMap((item) => item.evidenceIds);
      await this.assuranceEvidence(projectId, referenced);
      evidenceIds = [...new Set([...evidenceIds, ...referenced])];
    } else {
      const selected = strictStringList(body.evidenceIds, "evidenceIds");
      const selectedEvidence = await this.assuranceEvidence(projectId, selected);
      if (action === "baseline") {
        if (engagement.baseline) throw new ControlPlaneError("The baseline is already recorded and cannot be replaced.", 409, "assurance_baseline_locked");
        const firstEvidenceAt = selectedEvidence.map((item) => item.createdAt).sort()[0] ?? now;
        const elapsed = Math.max(0, Math.floor((Date.parse(firstEvidenceAt) - Date.parse(engagement.integrationStartedAt)) / 1_000));
        engagement = { ...engagement, baseline: { evidenceIds: selected, recordedAt: now }, firstEvidenceAt, timeToFirstEvidenceSeconds: elapsed };
      } else {
        if (!engagement.baseline) throw new ControlPlaneError("Record the baseline before the retest.", 409, "assurance_baseline_required");
        if (engagement.retest) throw new ControlPlaneError("The included retest is already recorded and cannot be replaced.", 409, "assurance_retest_locked");
        if (selected.some((id) => engagement.baseline?.evidenceIds.includes(id))) {
          throw new ControlPlaneError("Retest evidence must be distinct from the locked baseline evidence.", 422, "assurance_retest_evidence_reused");
        }
        engagement = { ...engagement, retest: { evidenceIds: selected, recordedAt: now } };
      }
      evidenceIds = [...new Set([...evidenceIds, ...selected])];
    }

    const next: AssuranceCaseRecord = { ...current, engagement, evidenceIds, updatedAt: now };
    const updated = await this.store.updateAssuranceCase(next, current.status, current.updatedAt);
    if (!updated) throw new ControlPlaneError("Assurance case changed concurrently. Reload and retry.", 409, "assurance_transition_conflict");
    return { assuranceCase: updated };
  }

  private async assuranceEvidence(projectId: string, evidenceIds: string[]): Promise<EvidenceRecord[]> {
    return Promise.all(evidenceIds.map(async (id) => {
      const item = await this.store.getEvidence(projectId, id);
      if (!item) throw new ControlPlaneError(`Evidence ${id} was not found in this project.`, 422, "assurance_evidence_missing");
      return item;
    }));
  }

  async publicAssuranceReport(publicId: string) {
    const found = await this.store.getAssuranceCaseByPublicId(publicId);
    if (!found?.report) throw new ControlPlaneError("Published assurance report was not found.", 404);
    const assuranceCase = await this.expireAssuranceCaseIfNeeded(found);
    const decisions = await this.store.listAssuranceCaseDecisions(assuranceCase.projectId, assuranceCase.id);
    return {
      schemaVersion: "agentcert.public_assurance_report.v0.1", status: assuranceCase.status, report: assuranceCase.report,
      deliveryPacket: assuranceCase.deliveryPacket,
      history: decisions.map(({ toStatus, reason, occurredAt }) => ({ status: toStatus, reason, occurredAt })),
    };
  }

  private async expireAssuranceCaseIfNeeded(assuranceCase: AssuranceCaseRecord, now = new Date()): Promise<AssuranceCaseRecord> {
    if (assuranceCase.status !== "issued" || !assuranceCase.expiresAt || Date.parse(assuranceCase.expiresAt) > now.getTime()) return assuranceCase;
    const occurredAt = new Date(Math.max(now.getTime(), Date.parse(assuranceCase.updatedAt) + 1)).toISOString();
    const next = {
      ...assuranceCase,
      status: "expired" as const,
      continuousAssurance: assuranceCase.continuousAssurance
        ? forceContinuousAssuranceFreshness(assuranceCase.continuousAssurance, "EXPIRED", "expired", "The assurance report reached its declared expiry.", occurredAt)
        : undefined,
      updatedAt: occurredAt,
    };
    const decision: AssuranceCaseDecisionRecord = {
      id: randomUUID(), projectId: next.projectId, assuranceCaseId: next.id, fromStatus: "issued", toStatus: "expired",
      actorId: "agentcert-system", reason: "Assurance report reached its declared expiry.", evidenceIds: next.evidenceIds, occurredAt,
    };
    const updated = await this.store.transitionAssuranceCase(next, decision, "issued") ?? await this.store.getAssuranceCase(next.projectId, next.id) ?? next;
    await this.notifyContinuousAssuranceChange(assuranceCase, updated);
    return updated;
  }

  private async authorizeOrganization(auth: AuthContext, organizationId: string, roles?: readonly MemberRole[]) {
    requireUser(auth);
    const membership = await this.store.membershipForOrganization(auth.userId, organizationId);
    if (!membership) throw new ControlPlaneError("Organization access denied.", 403, "organization_access_denied");
    if (roles && !roles.includes(membership.role)) throw new ControlPlaneError(
      `Organization role ${membership.role} cannot perform this operation.`, 403, "organization_role_insufficient",
      "Ask an organization owner to perform this operation or update your role.",
    );
    return membership;
  }

  private async validateTeamProjectIds(organizationId: string, role: MemberRole, requested: string[]): Promise<string[]> {
    if (!roleNeedsExplicitProjects(role)) return [];
    const normalized = [...new Set(requested)];
    if (normalized.length === 0) throw new ControlPlaneError(
      `${role} members require at least one project.`, 400, "team_project_access_required",
      "Select one or more projects for this member.",
    );
    const organizationProjects = await Promise.all(normalized.map((projectId) => this.store.getProject(projectId)));
    if (organizationProjects.some((project) => !project || project.organizationId !== organizationId)) throw new ControlPlaneError(
      "One or more project assignments do not belong to this organization.", 400, "team_project_access_invalid",
    );
    return normalized;
  }

  private teamAudit(
    organizationId: string,
    action: TeamAuditAction,
    auth: AuthContext,
    target: { targetUserId?: string; targetEmail?: string; metadata: Record<string, unknown> },
  ): TeamAuditRecord {
    if (!auth.userId) throw new ControlPlaneError("A human account is required.", 403, "human_account_required");
    return { id: randomUUID(), organizationId, action, actorId: auth.userId, actorEmail: auth.email, ...target, occurredAt: new Date().toISOString() };
  }

  private teamConflict(error: unknown): ControlPlaneError {
    if (!(error instanceof TeamStateConflictError)) return new ControlPlaneError("Team state changed while the request was running.", 409, "team_state_conflict", "Refresh the team page and retry.");
    if (error.reason === "last_owner") return new ControlPlaneError("The last organization owner cannot be removed or demoted.", 409, "team_last_owner", "Promote another member to owner first.");
    if (error.reason === "member_exists") return new ControlPlaneError("The account is already a member or is no longer available for this operation.", 409, "team_member_exists");
    return new ControlPlaneError("Invitation is no longer available.", 409, "team_invitation_unavailable", "Refresh the team page and create a new invitation if needed.");
  }

  async authorizeProject(auth: AuthContext, projectId: string, roles?: readonly MemberRole[], scope?: ApiKeyScope): Promise<void> {
    if (auth.kind === "api_key") {
      if (auth.projectId !== projectId) throw new ControlPlaneError(
        "API key is not scoped to this project.", 403, "api_key_project_mismatch",
        "Select the project that issued this key, or create a new key in the intended project.",
      );
      if (roles) throw new ControlPlaneError(
        "This operation requires a human account.", 403, "human_approval_required",
        "Sign in to the Hosted workspace with an owner or admin account.",
      );
      if (scope && !(auth.scopes ?? DEFAULT_API_KEY_SCOPES).includes(scope)) {
        throw new ControlPlaneError(
          `API key requires the ${scope} scope.`, 403, "api_key_scope_missing",
          "Create a replacement key with the required scope; existing key scopes cannot be expanded silently.",
        );
      }
      return;
    }
    requireUser(auth);
    const role = await this.store.roleForProject(auth.userId, projectId);
    if (!role) throw new ControlPlaneError("Project access denied.", 403, "project_access_denied", "Switch to a project in your organization or ask an owner to grant access.");
    const allowedRoles = roles ?? rolesForHumanScope(scope);
    if (!allowedRoles.includes(role)) throw new ControlPlaneError(`Project role ${role} cannot perform this operation.`, 403, "project_role_insufficient", "Ask a project owner to perform this operation or update your membership role.");
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
    const continuousAssurance = await this.prepareContinuousAssuranceRun(projectId, body.assurance);
    const existing = await this.store.getRunByExternalId(projectId, externalId);
    if (existing) {
      if (continuousAssurance) {
        const stored = runContinuousAssuranceBinding(existing.metadata.continuousAssurance);
        if (!stored || stored.caseId !== continuousAssurance.caseId || stored.trigger !== continuousAssurance.trigger || stored.scopeFingerprintSha256 !== continuousAssurance.scopeFingerprintSha256) {
          throw new ControlPlaneError(
            "externalId is already bound to a different continuous assurance run.", 409, "run_external_id_conflict",
            "Use a unique externalId for each evaluated scope and trigger.",
          );
        }
      }
      return existing;
    }
    const agentId = optionalString(body, "agentId");
    if (agentId && !(await this.store.getAgent(projectId, agentId))) throw new ControlPlaneError("Agent was not found.", 404);
    const traceId = optionalString(body, "traceId")?.toLowerCase();
    const rootSpanId = optionalString(body, "rootSpanId")?.toLowerCase();
    validateTraceIds(traceId, rootSpanId);
    const metadata = { ...record(body.metadata) };
    delete metadata.continuousAssurance;
    if (continuousAssurance) metadata.continuousAssurance = continuousAssurance;
    const run: RunRecord = {
      id: randomUUID(),
      projectId,
      agentId,
      externalId,
      kind: runKind(body.kind),
      status: "running",
      schemaVersion: optionalString(body, "schemaVersion") ?? "agentcert.run.v1",
      startedAt: optionalString(body, "startedAt") ?? new Date().toISOString(),
      metadata,
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
      if (current.status === status) return this.reconcileContinuousAssuranceRun(current);
      throw new ControlPlaneError(`Completed run status cannot change from ${current.status} to ${status}.`, 409);
    }
    const completionMetadata = { ...record(body.metadata) };
    delete completionMetadata.continuousAssurance;
    let next = await this.store.upsertRun({
      ...current,
      status,
      score: optionalNumber(body, "score"),
      completedAt: optionalString(body, "completedAt") ?? new Date().toISOString(),
      metadata: { ...current.metadata, ...completionMetadata },
    });
    next = await this.reconcileContinuousAssuranceRun(next);
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

  private async prepareContinuousAssuranceRun(projectId: string, input: unknown): Promise<RunContinuousAssuranceBinding | undefined> {
    const body = optionalRecord(input);
    if (!body) return undefined;
    const caseId = requiredString(body, "caseId");
    const trigger = assuranceTrigger(body.trigger);
    let scope: AssuranceScopeInput;
    try { scope = normalizeAssuranceScope(body.scope); }
    catch (error) {
      throw new ControlPlaneError(error instanceof Error ? error.message : "assurance.scope is invalid.", 422, "assurance_scope_invalid");
    }
    const storedCase = await this.store.getAssuranceCase(projectId, caseId);
    const assuranceCase = storedCase ? await this.expireAssuranceCaseIfNeeded(storedCase) : undefined;
    if (!assuranceCase?.continuousAssurance) throw new ControlPlaneError(
      "The assurance case does not have a continuous assurance contract.", 409, "continuous_assurance_required",
      "Create and issue an assurance case with a declared scope before binding runs.",
    );
    if (assuranceCase.status !== "issued") throw new ControlPlaneError(
      "Continuous assurance runs can only bind to an issued assurance case.", 409, "continuous_assurance_not_issued",
      "Complete independent review and issue the assurance case first.",
    );
    return {
      schemaVersion: "agentcert.run_assurance.v0.1",
      caseId,
      trigger,
      scope,
      scopeFingerprintSha256: assuranceScopeFingerprint(scope),
    };
  }

  private async reconcileContinuousAssuranceRun(run: RunRecord): Promise<RunRecord> {
    const binding = runContinuousAssuranceBinding(run.metadata.continuousAssurance);
    if (!binding || run.status === "running") return run;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const storedCase = await this.store.getAssuranceCase(run.projectId, binding.caseId);
      const current = storedCase ? await this.expireAssuranceCaseIfNeeded(storedCase) : undefined;
      if (!current?.continuousAssurance) throw new ControlPlaneError(
        "The bound continuous assurance contract is no longer available.", 409, "continuous_assurance_missing",
        "Restore the assurance case or start a new run against an issued case.",
      );
      if (current.continuousAssurance.lastRunId === run.id) {
        const latestRun = await this.store.getRun(run.projectId, run.id) ?? run;
        const latestMetadata = optionalRecord(latestRun.metadata.continuousAssurance);
        if (optionalRecord(latestMetadata?.reconciliation)) return latestRun;
        const recovered = reconcileContinuousAssurance({
          baseline: current.continuousAssurance.scope,
          observed: binding.scope,
          trigger: binding.trigger,
          runStatus: run.status,
        });
        return this.store.upsertRun({
          ...latestRun,
          metadata: {
            ...latestRun.metadata,
            continuousAssurance: {
              ...binding,
              reconciliation: {
                outcome: recovered.outcome,
                authoritative: recovered.authoritative,
                nextStatus: current.continuousAssurance.freshness.status,
                reasonCode: recovered.reasonCode,
                changedComponents: recovered.changes.map((item) => item.component),
                evaluatedAt: latestRun.completedAt ?? current.continuousAssurance.metrics.lastEvaluationAt ?? new Date().toISOString(),
              },
            },
          },
        });
      }
      const observedAt = run.completedAt ?? new Date().toISOString();
      const applied = applyContinuousAssuranceObservation(current.continuousAssurance, {
        observed: binding.scope,
        trigger: binding.trigger,
        runStatus: run.status,
        runId: run.id,
        observedAt,
      });
      const protectedFreshness = current.continuousAssurance.freshness.status === "SUSPENDED" || current.continuousAssurance.freshness.status === "EXPIRED";
      const contract = protectedFreshness
        ? { ...applied.contract, freshness: current.continuousAssurance.freshness }
        : applied.contract;
      const nextCase: AssuranceCaseRecord = {
        ...current,
        continuousAssurance: contract,
        updatedAt: monotonicTimestamp(current.updatedAt),
      };
      const updatedCase = await this.store.updateAssuranceCase(nextCase, current.status, current.updatedAt);
      if (!updatedCase) continue;
      const reconciliation = {
        outcome: applied.reconciliation.outcome,
        authoritative: applied.reconciliation.authoritative,
        nextStatus: contract.freshness.status,
        reasonCode: applied.reconciliation.reasonCode,
        changedComponents: applied.reconciliation.changes.map((item) => item.component),
        evaluatedAt: observedAt,
      };
      const updatedRun = await this.store.upsertRun({
        ...run,
        metadata: {
          ...run.metadata,
          continuousAssurance: { ...binding, reconciliation },
        },
      });
      await this.notifyContinuousAssuranceChange(current, updatedCase);
      return updatedRun;
    }
    throw new ControlPlaneError(
      "Continuous assurance state changed repeatedly while the run was completing.", 409, "continuous_assurance_conflict",
      "Retry the same complete-run request; the run and assurance update are idempotent.",
    );
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
    await this.authorizeProject(auth, projectId, ["owner", "admin", "operator"]);
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
      assuranceContext: actionAssuranceContext(body.assurance),
    });
  }

  async reviewAction(auth: AuthContext, projectId: string, actionId: string, approved: boolean, input: unknown): Promise<ActionRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin", "operator"]);
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
        ...(validated.evidenceStrength === undefined ? {} : { evidenceStrength: validated.evidenceStrength }),
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

  async processContinuousAssuranceMaintenance(now = new Date(), limit = 200) {
    const reminderHorizon = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    const candidates = await this.store.listAssuranceCasesForMaintenance(now.toISOString(), reminderHorizon, limit);
    const failures: Array<{ assuranceCaseId: string; message: string }> = [];
    let expired = 0;
    let remindersQueued = 0;
    for (const candidate of candidates) {
      try {
        if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= now.getTime()) {
          const updated = await this.expireAssuranceCaseIfNeeded(candidate, now);
          if (updated.status === "expired") expired += 1;
          continue;
        }
        const contract = candidate.continuousAssurance;
        if (!contract || contract.freshness.status !== "CURRENT" || !candidate.expiresAt) continue;
        const remainingMs = Date.parse(candidate.expiresAt) - now.getTime();
        const threshold = ASSURANCE_EXPIRY_REMINDER_DAYS.find((days) => remainingMs <= days * 86_400_000);
        if (!threshold || contract.reminders?.expiryThresholdDaysSent.includes(threshold)) continue;
        await this.notifyContinuousAssuranceExpiryWarning(candidate, threshold);
        const reminderAt = new Date(Math.max(now.getTime(), Date.parse(candidate.updatedAt) + 1)).toISOString();
        const next: AssuranceCaseRecord = {
          ...candidate,
          continuousAssurance: markContinuousAssuranceExpiryReminder(contract, threshold, reminderAt),
          updatedAt: reminderAt,
        };
        const updated = await this.store.updateAssuranceCase(next, candidate.status, candidate.updatedAt);
        if (!updated) continue;
        remindersQueued += 1;
      } catch (error) {
        failures.push({ assuranceCaseId: candidate.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      reminderHorizon,
      scanned: candidates.length,
      remindersQueued,
      expired,
      failed: failures.length,
      failures: failures.slice(0, 20),
    };
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

  async registerCollectorSourceKey(auth: AuthContext, projectId: string, input: unknown): Promise<CollectorSourceKeyRecord> {
    if (auth.kind === "user") await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    else await this.authorizeProject(auth, projectId, undefined, "collector:manage");
    let parsed;
    try { parsed = parseCollectorKeyRegistration(input); }
    catch (error) { throw new ControlPlaneError(message(error), 400, "collector_key_invalid"); }
    const now = new Date().toISOString();
    try {
      return await this.store.activateCollectorSourceKey({
        projectId,
        collectorId: parsed.collectorId,
        keyId: parsed.keyId,
        algorithm: "Ed25519",
        publicKeyPem: parsed.publicKeyPem,
        publicKeySha256: parsed.publicKeySha256,
        status: "active",
        previousKeyId: parsed.previousKeyId,
        createdAt: now,
        activatedAt: now,
      });
    } catch (error) {
      if (error instanceof TrustedCollectorConflictError) throw new ControlPlaneError("Collector key ID or rotation predecessor conflicts with existing key history.", 409, error.reason);
      throw error;
    }
  }

  async listCollectorSourceKeys(auth: AuthContext, projectId: string): Promise<CollectorSourceKeyRecord[]> {
    if (auth.kind === "user") await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    else await this.authorizeProject(auth, projectId, undefined, "collector:manage");
    return this.store.listCollectorSourceKeys(projectId);
  }

  async revokeCollectorSourceKey(auth: AuthContext, projectId: string, keyId: string): Promise<CollectorSourceKeyRecord> {
    if (auth.kind === "user") await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    else await this.authorizeProject(auth, projectId, undefined, "collector:manage");
    const revoked = await this.store.revokeCollectorSourceKey(projectId, keyId, new Date().toISOString());
    if (!revoked) throw new ControlPlaneError("Collector source key was not found.", 404, "collector_key_not_found");
    return revoked;
  }

  async appendTrustedCollectorRecords(auth: AuthContext, projectId: string, runId: string, input: unknown) {
    await this.authorizeProject(auth, projectId, undefined, "events:write");
    let records;
    try { records = parseTrustedRecordBatch(input, runId); }
    catch (error) { throw new ControlPlaneError(message(error), 400, "trusted_record_invalid"); }
    const collectorId = records[0].collector.id;
    const sourceKeyId = records[0].sourceSignature.keyId;
    if (records.some((record) => record.collector.id !== collectorId || record.sourceSignature.keyId !== sourceKeyId)) {
      throw new ControlPlaneError("A trusted record batch must use one collector identity and source key.", 400, "mixed_collector_batch");
    }
    const key = await this.store.getCollectorSourceKey(projectId, sourceKeyId);
    if (!key) throw new ControlPlaneError("Collector source key is not registered for this project.", 401, "collector_key_unknown");
    const existingRun = await this.store.getTrustedCollectorRun(projectId, runId);
    if (key.status === "retired" && !existingRun) throw new ControlPlaneError("A retired collector key cannot start a new run.", 409, "collector_key_retired");
    try { for (const record of records) verifyTrustedSourceRecord(record, key); }
    catch (error) { throw new ControlPlaneError(message(error), 401, "trusted_record_signature_invalid"); }
    try {
      const result = await this.store.appendTrustedCollectorRecords(projectId, runId, collectorId, sourceKeyId, records, new Date().toISOString());
      for (const alert of result.alerts) await this.ensureCollectorIncident(projectId, alert.runId ?? runId, alert.collectorId, alert.message, alert.createdAt);
      return { schemaVersion: "agentcert.remote_collector_ack.v0.2", ...result };
    } catch (error) {
      if (error instanceof TrustedCollectorConflictError) {
        throw new ControlPlaneError(collectorConflictMessage(error.reason), 409, error.reason, "Reopen the local journal, verify its last acknowledged hash, and replay from the server ACK.");
      }
      throw error;
    }
  }

  async recordCollectorHeartbeat(auth: AuthContext, projectId: string, input: unknown): Promise<CollectorHeartbeatRecord> {
    await this.authorizeProject(auth, projectId, undefined, "events:write");
    let heartbeat;
    try { heartbeat = parseSignedCollectorHeartbeat(input); }
    catch (error) { throw new ControlPlaneError(message(error), 400, "collector_heartbeat_invalid"); }
    const key = await this.store.getCollectorSourceKey(projectId, heartbeat.payload.sourceKeyId);
    if (!key) throw new ControlPlaneError("Collector source key is not registered for this project.", 401, "collector_key_unknown");
    try { verifyCollectorHeartbeat(heartbeat, key); }
    catch (error) { throw new ControlPlaneError(message(error), 401, "collector_heartbeat_signature_invalid"); }
    const receivedAt = new Date().toISOString();
    return this.store.saveCollectorHeartbeat({
      projectId,
      collectorId: heartbeat.payload.collectorId,
      sourceKeyId: heartbeat.payload.sourceKeyId,
      runId: heartbeat.payload.runId,
      occurredAt: heartbeat.payload.occurredAt,
      receivedAt,
      pendingRecordCount: heartbeat.payload.pendingRecordCount,
      lastAckSequence: heartbeat.payload.lastAckSequence,
      status: heartbeat.payload.pendingRecordCount > 0 ? "backlogged" : "healthy",
    });
  }

  async reconcileTrustedCollectorRun(auth: AuthContext, projectId: string, runId: string, input: unknown) {
    await this.authorizeProject(auth, projectId, undefined, "events:write");
    if (!this.evidenceSigner) throw new ControlPlaneError("Server attestation is not configured.", 503, "server_attestation_unavailable");
    let receipt;
    try { receipt = parseTrustedRunReceipt(input); }
    catch (error) { throw new ControlPlaneError(message(error), 400, "trusted_receipt_invalid"); }
    if (receipt.runId !== runId) throw new ControlPlaneError("Receipt runId does not match the route runId.", 400, "trusted_receipt_run_mismatch");
    const key = await this.store.getCollectorSourceKey(projectId, receipt.sourceSignature.keyId);
    if (!key) throw new ControlPlaneError("Collector source key is not registered for this project.", 401, "collector_key_unknown");
    try { verifyTrustedRunReceiptInput(receipt, key); }
    catch (error) { throw new ControlPlaneError(message(error), 401, "trusted_receipt_signature_invalid"); }
    const run = await this.store.getTrustedCollectorRun(projectId, runId);
    if (!run) throw new ControlPlaneError("Trusted collector run was not found.", 404, "trusted_run_not_found");
    const journal = record(receipt.journal);
    const complete = journal.complete === true && journal.valid === true;
    const matches = complete
      && run.collectorId === receipt.collector.id
      && run.sourceKeyId === receipt.sourceSignature.keyId
      && run.acceptedEventCount === receipt.eventCount
      && run.droppedEventCount === receipt.droppedEventCount
      && run.firstEventHash === receipt.firstEventHash
      && run.lastEventHash === receipt.lastEventHash
      && Boolean(run.completedAt);
    if (!matches) throw new ControlPlaneError("Source receipt does not reconcile with the server-accepted journal.", 409, "reconciliation_mismatch");
    const reconciledAt = new Date().toISOString();
    const reconciliation = {
      schemaVersion: "agentcert.collector_reconciliation.v0.2",
      projectId,
      runId,
      collectorId: run.collectorId,
      sourceKeyId: run.sourceKeyId,
      sourceReceiptSha256: receipt.receiptSha256,
      acceptedEventCount: run.acceptedEventCount,
      droppedEventCount: run.droppedEventCount,
      firstEventHash: run.firstEventHash,
      lastEventHash: run.lastEventHash,
      status: run.droppedEventCount ? "degraded" : "complete",
      reconciledAt,
    };
    const serverAttestation = this.evidenceSigner.attestCanonical(reconciliation, reconciledAt);
    const updated = await this.store.saveTrustedCollectorReconciliation(
      projectId,
      runId,
      receipt,
      reconciliation,
      serverAttestation as unknown as Record<string, unknown>,
      reconciledAt,
    );
    return { run: updated, reconciliation, serverAttestation };
  }

  async trustedCollectorStatus(auth: AuthContext, projectId: string) {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    const [keys, runs, heartbeats, alerts] = await Promise.all([
      this.store.listCollectorSourceKeys(projectId), this.store.listTrustedCollectorRuns(projectId, 100),
      this.store.listCollectorHeartbeats(projectId), this.store.listTrustedCollectorAlerts(projectId, 100),
    ]);
    const now = Date.now();
    return {
      schemaVersion: "agentcert.remote_collector_status.v0.2",
      keys,
      runs,
      heartbeats: heartbeats.map((heartbeat) => ({ ...heartbeat, stale: now - Date.parse(heartbeat.receivedAt) > 120_000 })),
      alerts,
    };
  }

  private async ensureCollectorIncident(projectId: string, runId: string, collectorId: string, summary: string, occurredAt: string): Promise<void> {
    const fingerprint = `trusted-collector:events-dropped:${collectorId}:${runId}`;
    if (await this.store.getActiveIncidentByFingerprint(projectId, fingerprint)) return;
    await this.store.insertIncident({
      id: randomUUID(), projectId, runId, severity: "high", type: "trusted_collector_events_dropped", status: "open",
      summary, firstDivergence: "The customer collector declared a sequence gap.", fingerprint,
      occurrenceCount: 1, consecutivePasses: 0, lastFailedAt: occurredAt, createdAt: occurredAt, updatedAt: occurredAt,
    });
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
    const sloBurnRate = source === "production_smoke" ? await this.applySloBurnRateOutcome(auth, sample) : undefined;
    return { sample, ...lifecycle, ...(sloBurnRate ? { sloBurnRate } : {}) };
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
        try {
          const transition = this.incidentTransition(
            incident, undefined, "open", auth, "Production smoke failure opened the incident.", sampleEvidence(sample),
          );
          const inserted = await this.store.insertIncidentWithTransition(incident, transition);
          await this.sendIncidentNotification("incident_opened", inserted.incident, inserted.transition);
          return { operationalIncident: inserted.incident, incidentTransition: inserted.transition };
        }
        catch (error) {
          if (databaseErrorCode(error) !== "23505") throw error;
          return this.applyProductionSmokeOutcome(auth, sample);
        }
      }
      const regressed = active.status === "recovered";
      const next: IncidentRecord = {
        ...active, status: regressed ? "open" : active.status, occurrenceCount: active.occurrenceCount + 1,
        consecutivePasses: 0, lastFailedAt: sample.completedAt, firstDivergence: sample.error ?? active.firstDivergence,
        updatedAt: sample.completedAt,
      };
      const transition = this.incidentTransition(
        next, active.status, next.status, auth,
        regressed ? "Production smoke failed after recovery." : "Another production smoke failure was observed.",
        sampleEvidence(sample),
      );
      const updated = await this.store.updateIncidentWithTransition(next, transition);
      if (regressed) await this.sendIncidentNotification("incident_regressed", updated.incident, updated.transition);
      return { operationalIncident: updated.incident, incidentTransition: updated.transition };
    }

    if (!active) {
      const latest = await this.store.getLatestIncidentByFingerprint(sample.projectId, PRODUCTION_SMOKE_FINGERPRINT);
      return latest?.status === "resolved" ? { operationalIncident: latest } : {};
    }
    const consecutivePasses = active.consecutivePasses + 1;
    const recovered = consecutivePasses >= 2 && (active.status === "open" || active.status === "investigating");
    const candidate: IncidentRecord = {
      ...active, status: recovered ? "recovered" : active.status, consecutivePasses, lastPassedAt: sample.completedAt,
      recoveredAt: recovered ? sample.completedAt : active.recoveredAt, updatedAt: sample.completedAt,
    };
    if (!recovered) return { operationalIncident: await this.store.updateIncident(candidate) };
    const transition = this.incidentTransition(
      candidate, active.status, "recovered", auth, "Two consecutive production smoke runs passed.",
      { ...sampleEvidence(sample), consecutivePasses },
    );
    const next = await this.store.updateIncidentWithTransition(candidate, transition);
    await this.sendIncidentNotification("incident_recovered", next.incident, next.transition);
    return { operationalIncident: next.incident, incidentTransition: next.transition };
  }

  private async applySloBurnRateOutcome(auth: AuthContext, sample: TrustHealthSampleRecord): Promise<{
    evaluation: SloBurnEvaluation;
    operationalIncident?: IncidentRecord;
    incidentTransition?: IncidentTransitionRecord;
  }> {
    const evaluation = await sloBurnEvaluation(this.store, sample.projectId, new Date(sample.completedAt), TRUST_SLO_OBJECTIVE);
    const active = await this.store.getActiveIncidentByFingerprint(sample.projectId, SLO_BURN_FINGERPRINT);
    if (evaluation.status !== "healthy") {
      const evidence = { sample: sampleEvidence(sample), burnRate: evaluation };
      if (!active) {
        const incident: IncidentRecord = {
          id: randomUUID(), projectId: sample.projectId, severity: evaluation.status === "critical" ? "critical" : "high",
          type: "slo_burn_rate", status: "open", summary: `Production smoke error budget is burning at ${evaluation.status} rate.`,
          firstDivergence: evaluation.reason, fingerprint: SLO_BURN_FINGERPRINT, occurrenceCount: 1, consecutivePasses: 0,
          lastFailedAt: sample.completedAt, createdAt: sample.completedAt, updatedAt: sample.completedAt,
        };
        try {
          const transition = this.incidentTransition(incident, undefined, "open", auth, evaluation.reason, evidence);
          const inserted = await this.store.insertIncidentWithTransition(incident, transition);
          await this.sendIncidentNotification("slo_burn_rate", inserted.incident, inserted.transition);
          return { evaluation, operationalIncident: inserted.incident, incidentTransition: inserted.transition };
        } catch (error) {
          if (databaseErrorCode(error) !== "23505") throw error;
          return this.applySloBurnRateOutcome(auth, sample);
        }
      }
      const regressed = active.status === "recovered";
      const next: IncidentRecord = {
        ...active, status: regressed ? "open" : active.status, severity: evaluation.status === "critical" ? "critical" : active.severity,
        summary: `Production smoke error budget is burning at ${evaluation.status} rate.`, firstDivergence: evaluation.reason,
        occurrenceCount: active.occurrenceCount + 1, consecutivePasses: 0, lastFailedAt: sample.completedAt, updatedAt: sample.completedAt,
      };
      const transition = this.incidentTransition(
        next, active.status, next.status, auth,
        regressed ? "SLO burn rate regressed after recovery." : "SLO burn rate remained above the multi-window threshold.",
        evidence,
      );
      const updated = await this.store.updateIncidentWithTransition(next, transition);
      if (regressed) {
        await this.sendIncidentNotification("incident_regressed", updated.incident, updated.transition);
        await this.sendIncidentNotification("slo_burn_rate", updated.incident, updated.transition);
      }
      return { evaluation, operationalIncident: updated.incident, incidentTransition: updated.transition };
    }

    if (!active) return { evaluation };
    const consecutivePasses = active.consecutivePasses + 1;
    const recovered = consecutivePasses >= 2 && (active.status === "open" || active.status === "investigating");
    const candidate: IncidentRecord = {
      ...active, status: recovered ? "recovered" : active.status, consecutivePasses, lastPassedAt: sample.completedAt,
      recoveredAt: recovered ? sample.completedAt : active.recoveredAt, updatedAt: sample.completedAt,
    };
    if (!recovered) return { evaluation, operationalIncident: await this.store.updateIncident(candidate) };
    const transition = this.incidentTransition(
      candidate, active.status, "recovered", auth, "Multi-window SLO burn rate remained healthy for two evaluations.",
      { sample: sampleEvidence(sample), burnRate: evaluation, consecutivePasses },
    );
    const updated = await this.store.updateIncidentWithTransition(candidate, transition);
    await this.sendIncidentNotification("incident_recovered", updated.incident, updated.transition);
    return { evaluation, operationalIncident: updated.incident, incidentTransition: updated.transition };
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
    const candidate: IncidentRecord = {
      ...incident, status: "investigating", acknowledgedBy: auth.userId, acknowledgedByEmail: auth.email,
      acknowledgedAt: now, updatedAt: now,
    };
    const transition = this.incidentTransition(candidate, "open", "investigating", auth, reason, {});
    const updated = await this.store.updateIncidentWithTransition(candidate, transition);
    return { incident: updated.incident, transition: updated.transition, transitions: await this.store.listIncidentTransitions(projectId, incidentId) };
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
    const candidate: IncidentRecord = {
      ...incident, status: "resolved", resolvedBy: auth.userId, resolvedByEmail: auth.email, resolvedAt: now, updatedAt: now,
    };
    const transition = this.incidentTransition(candidate, "recovered", "resolved", auth, reason, {});
    const updated = await this.store.updateIncidentWithTransition(candidate, transition);
    await this.sendIncidentNotification("incident_resolved", updated.incident, updated.transition);
    return { incident: updated.incident, transition: updated.transition, transitions: await this.store.listIncidentTransitions(projectId, incidentId) };
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
    await this.enqueueEmail(destination, "destination_verification", "Verify your AgentCert alert email", {
      text: `Verify this email for AgentCert project alerts: ${verificationUrl}\n\nThis link expires in 24 hours.`,
      html: `<p>Verify this email for AgentCert project alerts.</p><p><a href="${escapeHtml(verificationUrl)}">Verify alert email</a></p><p>This link expires in 24 hours.</p>`,
    });
    return publicNotificationDestination(destination);
  }

  async verifyNotificationDestination(token: string, now = new Date()): Promise<PublicNotificationVerificationResult> {
    if (!token || token.length > 512) return { outcome: "invalid" };
    const result = await this.store.verifyNotificationDestination(
      createHash("sha256").update(token).digest("hex"),
      now.toISOString(),
    );
    if (!("destination" in result)) return result;
    return { outcome: result.outcome, destination: publicNotificationDestination(result.destination) };
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

  async sendTestNotification(
    auth: AuthContext,
    projectId: string,
    destinationId: string,
    now = new Date(),
  ): Promise<NotificationJobRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    if (!this.emailProvider.configured) throw new ControlPlaneError("Email notifications are not configured by the AgentCert platform.", 503);
    const destination = (await this.store.listNotificationDestinations(projectId)).find((item) => item.id === destinationId);
    if (!destination) throw new ControlPlaneError("Notification destination was not found.", 404);
    if (destination.status !== "active") {
      throw new ControlPlaneError(
        "Verify this email address before sending a test alert.", 409, "notification_destination_unverified",
        "Open the newest verification email, then retry the test alert.",
      );
    }
    const recentTest = (await this.store.listNotificationJobs(projectId, 100)).find(
      (job) => job.destinationId === destinationId && job.alertType === "test_alert",
    );
    if (recentTest && now.getTime() - Date.parse(recentTest.createdAt) < TEST_NOTIFICATION_COOLDOWN_MS) {
      throw new ControlPlaneError(
        "A test alert was sent to this address less than 60 seconds ago.", 429, "test_alert_cooldown",
        "Wait 60 seconds before sending another test alert.",
      );
    }
    const workspaceUrl = `${this.publicUrl.replace(/\/$/, "")}/app?view=integrations&focus=email-alerts&project=${encodeURIComponent(projectId)}`;
    return this.enqueueEmail(destination, "test_alert", "[AgentCert] Test alert delivery", {
      text: `This is a test alert for AgentCert project ${projectId}. No incident was created.\n\nReview delivery status: ${workspaceUrl}`,
      html: `<p><strong>AgentCert test alert</strong></p><p>Email delivery is configured for this project. No incident was created.</p><p><a href="${escapeHtml(workspaceUrl)}">Review delivery status</a></p>`,
    }, now);
  }

  async retryNotificationJob(auth: AuthContext, projectId: string, jobId: string): Promise<NotificationJobRecord> {
    await this.authorizeProject(auth, projectId, ["owner", "admin"]);
    const job = await this.store.getNotificationJob(projectId, jobId);
    if (!job) throw new ControlPlaneError("Notification job was not found.", 404);
    if (job.status !== "dead_letter") throw new ControlPlaneError("Only dead-letter notification jobs can be retried.", 409);
    return this.store.updateNotificationJob({
      ...job, status: "pending", attemptCount: 0, nextAttemptAt: new Date().toISOString(), lockedAt: undefined,
      lockedBy: undefined, providerMessageId: undefined, lastError: undefined, completedAt: undefined,
    });
  }

  async processNotificationJobs(
    workerId: string,
    now = new Date(),
    limit = 20,
    leaseMs = DEFAULT_NOTIFICATION_LEASE_MS,
  ): Promise<{ claimed: number; delivered: number; retrying: number; deadLetter: number }> {
    if (!this.emailProvider.configured) return { claimed: 0, delivered: 0, retrying: 0, deadLetter: 0 };
    const jobs = await this.store.claimNotificationJobs(
      workerId, now.toISOString(), new Date(now.getTime() - leaseMs).toISOString(), limit,
    );
    const result = { claimed: jobs.length, delivered: 0, retrying: 0, deadLetter: 0 };
    for (const job of jobs) {
      const destination = (await this.store.listNotificationDestinations(job.projectId)).find((item) => item.id === job.destinationId);
      const destinationUsable = destination && (destination.status === "active" || job.alertType === "destination_verification");
      if (!destinationUsable || destination?.status === "disabled") {
        const message = "Notification destination is missing, disabled, or unverified.";
        await this.store.insertNotificationDelivery({
          id: randomUUID(), projectId: job.projectId, destinationId: job.destinationId, jobId: job.id,
          alertType: job.alertType, subject: job.subject, status: "failed", provider: this.emailProvider.name,
          error: message, attemptCount: job.attemptCount + 1, attemptedAt: now.toISOString(),
        });
        await this.finishNotificationJob(job, undefined, message, now, result);
        continue;
      }
      try {
        const sent = await this.emailProvider.send({ to: job.recipient, subject: job.subject, text: job.text, html: job.html });
        await this.store.insertNotificationDelivery({
          id: randomUUID(), projectId: job.projectId, destinationId: job.destinationId, jobId: job.id,
          alertType: job.alertType, subject: job.subject, status: "delivered", provider: sent.provider,
          providerMessageId: sent.messageId, attemptCount: job.attemptCount + 1, attemptedAt: now.toISOString(),
        });
        await this.finishNotificationJob(job, sent, undefined, now, result, true);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2_000) : "Email delivery failed.";
        await this.store.insertNotificationDelivery({
          id: randomUUID(), projectId: job.projectId, destinationId: job.destinationId, jobId: job.id,
          alertType: job.alertType, subject: job.subject, status: "failed", provider: this.emailProvider.name,
          error: message, attemptCount: job.attemptCount + 1, attemptedAt: now.toISOString(),
        });
        await this.finishNotificationJob(job, undefined, message, now, result);
      }
    }
    return result;
  }

  private async finishNotificationJob(
    job: NotificationJobRecord,
    sent: { provider: string; messageId?: string } | undefined,
    error: string | undefined,
    now: Date,
    result: { delivered: number; retrying: number; deadLetter: number },
    delivered = false,
  ): Promise<void> {
    const attemptCount = job.attemptCount + 1;
    if (delivered && sent) {
      result.delivered += 1;
      await this.store.updateNotificationJob({
        ...job, status: "delivered", attemptCount, provider: sent.provider, providerMessageId: sent.messageId,
        lastError: undefined, lockedAt: undefined, lockedBy: undefined, completedAt: now.toISOString(),
      });
      return;
    }
    const deadLetter = attemptCount >= job.maxAttempts;
    result[deadLetter ? "deadLetter" : "retrying"] += 1;
    await this.store.updateNotificationJob({
      ...job, status: deadLetter ? "dead_letter" : "retrying", attemptCount, provider: this.emailProvider.name,
      lastError: error ?? "Email delivery failed.",
      nextAttemptAt: deadLetter ? now.toISOString() : new Date(now.getTime() + notificationRetryDelay(attemptCount)).toISOString(),
      lockedAt: undefined, lockedBy: undefined, completedAt: deadLetter ? now.toISOString() : undefined,
    });
  }

  async operationsOverview(auth: AuthContext, projectId: string, coordination?: CoordinationHealth, now = new Date()) {
    await this.authorizeProject(auth, projectId, undefined, "runs:read");
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const [jobs, jobCounts, deliveries, signingKeys, smokeSamples, latestSmokeSamples, webhookMetrics, slo30, slo90, incidents,
      notificationJobs, notificationJobCounts, notificationDeliveries, notificationDestinations] = await Promise.all([
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
      this.store.listNotificationJobs(projectId, 100),
      this.store.notificationJobCounts(projectId),
      this.store.listNotificationDeliveries(projectId, 20),
      this.store.listNotificationDestinations(projectId),
    ]);
    const burnRateEvaluation = await sloBurnEvaluation(this.store, projectId, now, TRUST_SLO_OBJECTIVE);
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
    const notificationAlert = notificationJobCounts.dead_letter > 0
      ? alert("critical", `${notificationJobCounts.dead_letter} email notifications require dead-letter review.`)
      : notificationJobCounts.retrying > 0
        ? alert("warning", `${notificationJobCounts.retrying} email notifications are retrying.`)
        : alert("healthy", "No email notifications require operator action.");
    const burnRateAlert = burnRateEvaluation.status === "critical"
      ? alert("critical", burnRateEvaluation.reason)
      : burnRateEvaluation.status === "warning"
        ? alert("warning", burnRateEvaluation.reason)
        : alert("healthy", burnRateEvaluation.reason);
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
    const alertStates = [redisAlert.status, signingAlert.status, smokeAlert.status, webhookAlert.status, notificationAlert.status, burnRateAlert.status, incidentAlert.status];
    const status = alertStates.includes("critical") ? "critical" : alertStates.includes("warning") ? "warning" : "healthy";
    const incidentForLedger = activeIncident ?? operationalIncidents[0] ?? null;
    const transitions = incidentForLedger ? await this.store.listIncidentTransitions(projectId, incidentForLedger.id) : [];
    return {
      schemaVersion: "agentcert.trust_operations.v0.5",
      projectId,
      status,
      generatedAt: now.toISOString(),
      coordination: coordinationState,
      alerts: { redis: redisAlert, signing: signingAlert, scheduledSmoke: smokeAlert, webhooks: webhookAlert, notifications: notificationAlert, sloBurnRate: burnRateAlert, incidents: incidentAlert },
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
        queue: notificationJobCounts,
        destinations: notificationDestinations.map(publicNotificationDestination),
        recentJobs: notificationJobs.slice(0, 50),
        recentDeliveries: notificationDeliveries,
        deadLetters: notificationJobs.filter((job) => job.status === "dead_letter").slice(0, 20),
      },
      slo: {
        objective: TRUST_SLO_OBJECTIVE,
        windows: [sloWindow(30, slo30, TRUST_SLO_OBJECTIVE), sloWindow(90, slo90, TRUST_SLO_OBJECTIVE)],
        burnRate: burnRateEvaluation,
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

  private incidentTransition(
    incident: IncidentRecord,
    fromStatus: IncidentStatus | undefined,
    toStatus: IncidentStatus,
    auth: AuthContext,
    reason: string,
    evidence: Record<string, unknown>,
  ): IncidentTransitionRecord {
    return {
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
    };
  }

  private async notifyContinuousAssuranceChange(previous: AssuranceCaseRecord, current: AssuranceCaseRecord): Promise<void> {
    const before = previous.continuousAssurance?.freshness;
    const after = current.continuousAssurance?.freshness;
    if (!after) return;
    const beforeKey = before
      ? `${before.status}:${before.reasonCode}:${before.changedComponents.map((item) => item.component).sort().join(",")}`
      : undefined;
    const afterKey = `${after.status}:${after.reasonCode}:${after.changedComponents.map((item) => item.component).sort().join(",")}`;
    if (beforeKey === afterKey) return;
    const eventType = {
      CURRENT: "assurance.current",
      REVALIDATION_REQUIRED: "assurance.revalidation_required",
      SUSPENDED: "assurance.suspended",
      EXPIRED: "assurance.expired",
    }[after.status];
    await Promise.all([
      this.emitWebhook(current.projectId, eventType, randomUUID(), {
        assuranceCaseId: current.id,
        subject: current.subject,
        scopeFingerprintSha256: current.continuousAssurance!.scopeFingerprintSha256,
        freshness: after,
        lastRunId: current.continuousAssurance!.lastRunId,
        lastTrigger: current.continuousAssurance!.lastTrigger,
      }),
      this.sendContinuousAssuranceNotification(current),
    ]);
  }

  private async sendContinuousAssuranceNotification(assuranceCase: AssuranceCaseRecord): Promise<void> {
    const contract = assuranceCase.continuousAssurance;
    if (!contract || !this.emailProvider.configured) return;
    const alertType: NotificationAlertType = {
      CURRENT: "assurance_current",
      REVALIDATION_REQUIRED: "assurance_revalidation_required",
      SUSPENDED: "assurance_suspended",
      EXPIRED: "assurance_expired",
    }[contract.freshness.status] as NotificationAlertType;
    const destinations = (await this.store.listNotificationDestinations(assuranceCase.projectId))
      .filter((destination) => destination.status === "active" && destination.alertTypes.includes(alertType));
    if (destinations.length === 0) return;
    const workspaceUrl = `${this.publicUrl.replace(/\/$/, "")}/app?view=assurance&caseId=${encodeURIComponent(assuranceCase.id)}`;
    const changed = contract.freshness.changedComponents.map((item) => item.component).join(", ") || "none";
    const subject = `[AgentCert] Assurance ${contract.freshness.status.replaceAll("_", " ").toLowerCase()}: ${assuranceCase.subject.name}`;
    const details = [
      `Assurance case: ${assuranceCase.name}`,
      `Subject: ${assuranceCase.subject.name} ${assuranceCase.subject.version ?? ""}`.trim(),
      `Status: ${contract.freshness.status}`,
      `Reason: ${contract.freshness.reason}`,
      `Changed scope components: ${changed}`,
      `Scope fingerprint: ${contract.scopeFingerprintSha256}`,
    ].join("\n");
    await Promise.all(destinations.map((destination) => this.enqueueEmail(destination, alertType, subject, {
      text: `${details}\n\nReview or start revalidation: ${workspaceUrl}`,
      html: `<p><strong>${escapeHtml(assuranceCase.subject.name)}</strong> is <strong>${escapeHtml(contract.freshness.status.replaceAll("_", " "))}</strong>.</p><p>${escapeHtml(contract.freshness.reason)}</p><ul><li>Changed scope components: ${escapeHtml(changed)}</li><li>Scope fingerprint: <code>${escapeHtml(contract.scopeFingerprintSha256)}</code></li></ul><p><a href="${escapeHtml(workspaceUrl)}">Review assurance status</a></p>`,
    })));
  }

  private async notifyContinuousAssuranceExpiryWarning(
    assuranceCase: AssuranceCaseRecord,
    thresholdDays: 30 | 7 | 1,
  ): Promise<void> {
    const contract = assuranceCase.continuousAssurance!;
    const expiresAt = assuranceCase.expiresAt!;
    const workspaceUrl = `${this.publicUrl.replace(/\/$/, "")}/app?view=assurance&caseId=${encodeURIComponent(assuranceCase.id)}`;
    await this.emitWebhook(assuranceCase.projectId, "assurance.expiry_warning", `${assuranceCase.id}:${thresholdDays}`, {
      assuranceCaseId: assuranceCase.id,
      subject: assuranceCase.subject,
      scopeFingerprintSha256: contract.scopeFingerprintSha256,
      freshness: contract.freshness,
      expiresAt,
      thresholdDays,
    });
    if (!this.emailProvider.configured) return;
    const destinations = (await this.store.listNotificationDestinations(assuranceCase.projectId))
      .filter((destination) => destination.status === "active" && destination.alertTypes.includes("assurance_expiry_warning"));
    const subject = `[AgentCert] Assurance expires within ${thresholdDays} day${thresholdDays === 1 ? "" : "s"}: ${assuranceCase.subject.name}`;
    await Promise.all(destinations.map((destination) => this.enqueueEmail(destination, "assurance_expiry_warning", subject, {
      text: [
        `Assurance case: ${assuranceCase.name}`,
        `Subject: ${assuranceCase.subject.name}`,
        `Current status: ${contract.freshness.status}`,
        `Expires at: ${expiresAt}`,
        `Scope fingerprint: ${contract.scopeFingerprintSha256}`,
        "",
        `Review or start revalidation: ${workspaceUrl}`,
      ].join("\n"),
      html: `<p><strong>${escapeHtml(assuranceCase.subject.name)}</strong> assurance expires within ${thresholdDays} day${thresholdDays === 1 ? "" : "s"}.</p><ul><li>Current status: ${escapeHtml(contract.freshness.status)}</li><li>Expires at: ${escapeHtml(expiresAt)}</li><li>Scope fingerprint: <code>${escapeHtml(contract.scopeFingerprintSha256)}</code></li></ul><p><a href="${escapeHtml(workspaceUrl)}">Review assurance status</a></p>`,
    })));
  }

  private async sendIncidentNotification(
    alertType: Exclude<NotificationAlertType, "destination_verification" | "test_alert">,
    incident: IncidentRecord,
    transition: IncidentTransitionRecord,
  ): Promise<void> {
    if (!this.emailProvider.configured) return;
    const destinations = (await this.store.listNotificationDestinations(incident.projectId))
      .filter((destination) => destination.status === "active" && destination.alertTypes.includes(alertType));
    const label = alertType === "slo_burn_rate" ? "SLO burn-rate threshold exceeded" : alertType.replace(/^incident_/, "").replace("regressed", "regressed to open");
    const subject = `[AgentCert] Production trust incident ${label}`;
    const details = [
      `Incident: ${incident.summary}`,
      `Status: ${incident.status}`,
      `Occurrences: ${incident.occurrenceCount}`,
      `Reason: ${transition.reason}`,
      `Project: ${incident.projectId}`,
    ].join("\n");
    await Promise.all(destinations.map((destination) => this.enqueueEmail(destination, alertType, subject, {
      text: `${details}\n\nOpen AgentCert: ${this.publicUrl}`,
      html: `<p><strong>${escapeHtml(incident.summary)}</strong></p><ul><li>Status: ${escapeHtml(incident.status)}</li><li>Occurrences: ${incident.occurrenceCount}</li><li>Reason: ${escapeHtml(transition.reason)}</li></ul><p><a href="${escapeHtml(this.publicUrl)}">Open AgentCert</a></p>`,
    })));
  }

  private async enqueueEmail(
    destination: NotificationDestinationRecord,
    alertType: NotificationAlertType,
    subject: string,
    content: { text: string; html: string },
    now = new Date(),
  ): Promise<NotificationJobRecord> {
    const createdAt = now.toISOString();
    return this.store.enqueueNotificationJob({
      id: randomUUID(), projectId: destination.projectId, destinationId: destination.id, alertType,
      recipient: destination.email, subject, text: content.text, html: content.html, status: "pending",
      attemptCount: 0, maxAttempts: DEFAULT_NOTIFICATION_MAX_ATTEMPTS, nextAttemptAt: createdAt, createdAt,
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

function webhookRetryDelay(attemptCount: number): number {
  return Math.min(DEFAULT_WEBHOOK_RETRY_BASE_MS * (2 ** Math.max(0, attemptCount - 1)), MAX_WEBHOOK_RETRY_MS);
}

function notificationRetryDelay(attemptCount: number): number {
  return Math.min(DEFAULT_NOTIFICATION_RETRY_BASE_MS * (2 ** Math.max(0, attemptCount - 1)), MAX_NOTIFICATION_RETRY_MS);
}

async function sloBurnEvaluation(
  store: ControlPlaneStore,
  projectId: string,
  now: Date,
  objective: number,
): Promise<SloBurnEvaluation> {
  const definitions = [
    { label: "1h" as const, hours: 1 as const },
    { label: "6h" as const, hours: 6 as const },
    { label: "24h" as const, hours: 24 as const },
  ];
  const windows = await Promise.all(definitions.map(async ({ label, hours }): Promise<TrustHealthBurnWindow> => {
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const counts = await store.trustHealthCounts(projectId, since);
    const errorRate = counts.total ? counts.failed / counts.total : null;
    return {
      label,
      hours,
      ...counts,
      errorRate,
      burnRate: errorRate === null ? null : errorRate / (1 - objective),
    };
  }));
  const [oneHour, sixHour, twentyFourHour] = windows;
  const policy: SloBurnEvaluation["policy"] = {
    objective,
    fastBurn: { shortWindow: "1h", longWindow: "6h", shortThreshold: 14.4, longThreshold: 6, minimumSamples: 3 },
    slowBurn: { shortWindow: "6h", longWindow: "24h", shortThreshold: 6, longThreshold: 3, minimumShortSamples: 3, minimumLongSamples: 6 },
  };
  const fastBurn = oneHour!.total >= policy.fastBurn.minimumSamples && sixHour!.total >= policy.fastBurn.minimumSamples &&
    (oneHour!.burnRate ?? 0) >= policy.fastBurn.shortThreshold && (sixHour!.burnRate ?? 0) >= policy.fastBurn.longThreshold;
  if (fastBurn) {
    return {
      status: "critical",
      reason: `Fast SLO burn detected: 1h ${oneHour!.burnRate!.toFixed(1)}x and 6h ${sixHour!.burnRate!.toFixed(1)}x error-budget consumption.`,
      windows,
      policy,
    };
  }
  const slowBurn = sixHour!.total >= policy.slowBurn.minimumShortSamples && twentyFourHour!.total >= policy.slowBurn.minimumLongSamples &&
    (sixHour!.burnRate ?? 0) >= policy.slowBurn.shortThreshold && (twentyFourHour!.burnRate ?? 0) >= policy.slowBurn.longThreshold;
  if (slowBurn) {
    return {
      status: "warning",
      reason: `Sustained SLO burn detected: 6h ${sixHour!.burnRate!.toFixed(1)}x and 24h ${twentyFourHour!.burnRate!.toFixed(1)}x error-budget consumption.`,
      windows,
      policy,
    };
  }
  return {
    status: "healthy",
    reason: "Multi-window SLO burn is below the 1h/6h and 6h/24h alert thresholds.",
    windows,
    policy,
  };
}
function publicApiKey(apiKey: ApiKeyRecord): PublicApiKeyRecord {
  const { secretHash: _secretHash, ...publicRecord } = apiKey;
  return publicRecord;
}

function publicTeamInvitation(invitation: TeamInvitationRecord): Omit<TeamInvitationRecord, "tokenHash"> {
  const { tokenHash: _tokenHash, ...publicRecord } = invitation;
  return publicRecord;
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ControlPlaneError("A valid email address is required.", 400, "team_email_invalid");
  return email;
}

function memberRole(value: unknown): MemberRole {
  if (value === "owner" || value === "admin" || value === "operator" || value === "viewer") return value;
  throw new ControlPlaneError("role must be owner, admin, operator, or viewer.", 400, "team_role_invalid");
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
  const allowed = new Set<NotificationAlertType>([
    "incident_opened", "incident_regressed", "incident_recovered", "incident_resolved", "slo_burn_rate",
    "assurance_current", "assurance_revalidation_required", "assurance_suspended", "assurance_expired", "assurance_expiry_warning",
  ]);
  const selected = stringList(value);
  if (selected.length === 0 || selected.some((item) => !allowed.has(item as NotificationAlertType))) {
    throw new ControlPlaneError("alertTypes must contain one or more supported incident or assurance alert types.");
  }
  return selected as NotificationAlertType[];
}

function assuranceTrigger(value: unknown): AssuranceTrigger {
  if (value === "pull_request" || value === "release" || value === "nightly") return value;
  throw new ControlPlaneError("assurance.trigger must be pull_request, release, or nightly.", 422, "assurance_trigger_invalid");
}

function runContinuousAssuranceBinding(value: unknown): RunContinuousAssuranceBinding | undefined {
  const body = optionalRecord(value);
  if (!body) return undefined;
  if (body.schemaVersion !== "agentcert.run_assurance.v0.1") throw new ControlPlaneError(
    "The stored run assurance binding has an unsupported schema version.", 409, "run_assurance_schema_unsupported",
  );
  let scope: AssuranceScopeInput;
  try { scope = normalizeAssuranceScope(body.scope); }
  catch (error) {
    throw new ControlPlaneError(error instanceof Error ? error.message : "The stored run assurance scope is invalid.", 409, "run_assurance_scope_invalid");
  }
  const fingerprint = assuranceScopeFingerprint(scope);
  if (requiredString(body, "scopeFingerprintSha256") !== fingerprint) throw new ControlPlaneError(
    "The stored run assurance scope fingerprint does not match its canonical scope.", 409, "run_assurance_fingerprint_mismatch",
  );
  return {
    schemaVersion: "agentcert.run_assurance.v0.1",
    caseId: requiredString(body, "caseId"),
    trigger: assuranceTrigger(body.trigger),
    scope,
    scopeFingerprintSha256: fingerprint,
  };
}

function monotonicTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
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
function strictStringList(value: unknown, name: string, fallback?: string[]): string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new ControlPlaneError(`${name} must be an array of non-empty strings.`);
  const result = [...new Set(value.map((item) => String(item).trim()))];
  if (result.length === 0) throw new ControlPlaneError(`${name} cannot be empty.`);
  return result;
}
function optionalStringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new ControlPlaneError(`${name} must be an array of non-empty strings.`);
  return [...new Set(value.map((item) => String(item).trim()))];
}
function assuranceEngagement(input: Record<string, unknown>, now: string): NonNullable<AssuranceCaseRecord["engagement"]> {
  const customer = record(input.customer);
  const sandbox = record(input.sandbox);
  const workflow = record(input.workflow);
  const expectedOutcome = record(workflow.expectedOutcome);
  if (Object.keys(expectedOutcome).length === 0) throw new ControlPlaneError("engagement.workflow.expectedOutcome must declare at least one expected field.", 422);
  const startedAtInput = optionalString(input, "integrationStartedAt");
  const startedAt = startedAtInput ? new Date(startedAtInput) : new Date(now);
  const nowDate = new Date(now);
  const contactEmail = optionalString(customer, "contactEmail");
  if (!Number.isFinite(startedAt.getTime()) || startedAt.getTime() > nowDate.getTime() + 60_000 || startedAt.getTime() < nowDate.getTime() - 30 * 24 * 60 * 60 * 1_000) {
    throw new ControlPlaneError("engagement.integrationStartedAt must be a valid timestamp within the previous 30 days.", 422);
  }
  return {
    schemaVersion: "agentcert.assurance_engagement.v0.1",
    customer: { name: requiredString(customer, "name"), contactEmail: contactEmail ? notificationEmail(contactEmail) : undefined },
    sandbox: { name: requiredString(sandbox, "name"), kind: requiredString(sandbox, "kind"), baseUrl: optionalString(sandbox, "baseUrl") },
    workflow: {
      name: requiredString(workflow, "name"),
      description: requiredString(workflow, "description"),
      highRiskAction: actionTypeValue(workflow.highRiskAction),
      expectedOutcome,
    },
    terms: { priceUsd: 5000, workflowCount: 1, includedRetests: 1, privacy: "private_by_default" },
    planLockedAt: now,
    dueAt: new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    integrationStartedAt: startedAt.toISOString(),
    remediationItems: [],
  };
}
function assuranceEngagementDecision(
  body: Record<string, unknown>,
  expectedOutcome: Record<string, unknown>,
  reviewerId: string,
  decidedAt: string,
): NonNullable<NonNullable<AssuranceCaseRecord["engagement"]>["decision"]> {
  const verdict = body.verdict;
  if (verdict !== "RELEASE" && verdict !== "RELEASE_WITH_CONTROLS" && verdict !== "BLOCK") {
    throw new ControlPlaneError("verdict must be RELEASE, RELEASE_WITH_CONTROLS, or BLOCK.", 422, "assurance_verdict_invalid");
  }
  const outcomeInput = record(body.outcome);
  const observed = record(outcomeInput.observed);
  if (Object.keys(observed).length === 0) throw new ControlPlaneError("outcome.observed must contain the independently observed result.", 422);
  if (typeof outcomeInput.verified !== "boolean") throw new ControlPlaneError("outcome.verified must be a boolean.", 422);
  const controlsRequired = optionalStringList(body.controlsRequired, "controlsRequired");
  if (verdict === "RELEASE" && !outcomeInput.verified) throw new ControlPlaneError("RELEASE requires an independently verified outcome.", 422, "assurance_release_unverified");
  if (verdict === "RELEASE" && controlsRequired.length) throw new ControlPlaneError("Use RELEASE_WITH_CONTROLS when controls remain required.", 422, "assurance_release_controls_conflict");
  if (verdict === "RELEASE_WITH_CONTROLS" && controlsRequired.length === 0) throw new ControlPlaneError("RELEASE_WITH_CONTROLS requires at least one declared control.", 422, "assurance_controls_required");
  return {
    verdict,
    rationale: requiredString(body, "rationale"),
    firstDivergence: requiredString(body, "firstDivergence"),
    authorizationGaps: optionalStringList(body.authorizationGaps, "authorizationGaps"),
    outcome: { expected: expectedOutcome, observed, verified: outcomeInput.verified },
    controlsRequired,
    limitations: strictStringList(body.limitations, "limitations"),
    decidedBy: reviewerId,
    decidedAt,
  };
}
function assuranceTarget(action: string): AssuranceCaseStatus {
  const targets: Record<string, AssuranceCaseStatus> = {
    start: "evaluating", submit: "review_required", return: "evaluating", issue: "issued",
    suspend: "suspended", revoke: "revoked", expire: "expired", resume: "evaluating",
  };
  const target = targets[action];
  if (!target) throw new ControlPlaneError("Unknown assurance case transition.", 404);
  return target;
}
function assuranceExpiry(value: unknown, now: Date): string {
  const expiresAt = typeof value === "string" ? new Date(value) : new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000);
  const duration = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(expiresAt.getTime()) || duration <= 0 || duration > 365 * 24 * 60 * 60 * 1_000) {
    throw new ControlPlaneError("expiresAt must be a future timestamp no more than 365 days from issuance.");
  }
  return expiresAt.toISOString();
}
function assuranceDecision(
  assuranceCase: AssuranceCaseRecord, auth: AuthContext & { userId: string }, fromStatus: AssuranceCaseStatus | undefined,
  toStatus: AssuranceCaseStatus, reason: string, occurredAt: string,
): AssuranceCaseDecisionRecord {
  return { id: randomUUID(), projectId: assuranceCase.projectId, assuranceCaseId: assuranceCase.id, fromStatus, toStatus,
    actorId: auth.userId, actorEmail: auth.email, reason, evidenceIds: assuranceCase.evidenceIds, occurredAt };
}
const PILOT_FEEDBACK_STAGES = new Set<PilotFeedbackStage>(["project", "api_key", "cli_connect", "first_run", "evidence_upload", "dashboard_review"]);
const PILOT_FEEDBACK_CATEGORIES = new Set<PilotFeedbackCategory>(["install", "authentication", "configuration", "execution", "evidence", "dashboard", "other"]);
const PILOT_FEEDBACK_OUTCOMES = new Set<PilotFeedbackOutcome>(["blocked", "confusing", "failed", "completed", "suggestion"]);
const PILOT_CONTEXT_KEYS = new Set(["agentType", "framework", "cliVersion", "os", "errorCode", "requestId", "stageDurationMs"]);
function projectName(value: Record<string, unknown>): string {
  const name = requiredString(value, "name");
  if (name.length < 2 || name.length > 80) throw new ControlPlaneError("name must contain 2 to 80 characters.", 422, "invalid_project_name");
  return name;
}
function slugifyProject(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54) || "project";
}
function enumValue<T extends string>(value: unknown, key: string, allowed: ReadonlySet<T>): T {
  if (typeof value === "string" && allowed.has(value as T)) return value as T;
  throw new ControlPlaneError(`${key} is not supported.`, 422, `invalid_${key}`);
}
function boundedToken(value: unknown, key: string, max: number): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/i.test(value) || value.length > max) {
    throw new ControlPlaneError(`${key} must be an alphanumeric token up to ${max} characters.`, 422, `invalid_${key}`);
  }
  return value;
}
function boundedText(value: unknown, key: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new ControlPlaneError(`${key} must be at most ${max} characters.`, 422, `invalid_${key}`);
  return value.trim() || undefined;
}
function pilotFeedbackContext(value: unknown): Record<string, unknown> {
  const source = record(value);
  const context: Record<string, unknown> = {};
  for (const key of PILOT_CONTEXT_KEYS) {
    const item = source[key];
    if (typeof item === "string" && item.length <= 200) context[key] = item;
    else if (key === "stageDurationMs" && typeof item === "number" && Number.isFinite(item) && item >= 0) context[key] = Math.round(item);
  }
  return context;
}
function buildPilotFunnelReport(
  source: PilotFunnelSource,
  periodDays: 7 | 30 | 90,
  since: string,
  generatedAt: string,
): PilotFunnelReport {
  const frictionOutcomes = new Set<PilotFeedbackOutcome>(["blocked", "confusing", "failed"]);
  const projects = source.projects.map(({ project, firstKeyAt, firstConnectionAt, firstEvidenceAt, firstCurrentAt }) => {
    let stage: PilotFunnelReport["projects"][number]["stage"] = "project_created";
    if (firstKeyAt) stage = "key_created";
    if (firstConnectionAt) stage = "cli_connected";
    if (firstEvidenceAt) stage = "first_evidence";
    if (firstCurrentAt) stage = "first_current";
    const feedback = source.feedback.filter((item) => item.projectId === project.id);
    return {
      projectId: project.id, name: project.name, slug: project.slug, createdAt: project.createdAt, stage,
      firstKeyAt, firstConnectionAt, firstEvidenceAt, firstCurrentAt,
      totalDurationMs: firstCurrentAt
        ? elapsedMs(project.createdAt, firstCurrentAt)
        : firstEvidenceAt ? elapsedMs(project.createdAt, firstEvidenceAt) : undefined,
      installToCurrentMs: firstConnectionAt && firstCurrentAt ? elapsedMs(firstConnectionAt, firstCurrentAt) : undefined,
      frictionCount: feedback.filter((item) => frictionOutcomes.has(item.outcome)).length,
    };
  });
  const stageCounts = {
    project_created: projects.length,
    key_created: projects.filter((project) => project.stage !== "project_created").length,
    cli_connected: projects.filter((project) => ["cli_connected", "first_evidence", "first_current"].includes(project.stage)).length,
    first_evidence: projects.filter((project) => project.stage === "first_evidence" || project.stage === "first_current").length,
    first_current: projects.filter((project) => project.stage === "first_current").length,
  };
  const orderedStages: Array<keyof typeof stageCounts> = ["project_created", "key_created", "cli_connected", "first_evidence", "first_current"];
  const stages = orderedStages.map((id, index) => ({
    id,
    count: stageCounts[id],
    conversionFromPrevious: ratio(stageCounts[id], index === 0 ? stageCounts[id] : stageCounts[orderedStages[index - 1]!]),
    conversionFromStart: ratio(stageCounts[id], stageCounts.project_created),
  }));
  const reasonGroups = new Map<string, { reasonCode: string; count: number; stage: PilotFeedbackStage; category: PilotFeedbackCategory }>();
  for (const feedback of source.feedback.filter((item) => frictionOutcomes.has(item.outcome))) {
    const key = `${feedback.reasonCode}:${feedback.stage}:${feedback.category}`;
    const existing = reasonGroups.get(key);
    reasonGroups.set(key, existing ? { ...existing, count: existing.count + 1 } : {
      reasonCode: feedback.reasonCode, count: 1, stage: feedback.stage, category: feedback.category,
    });
  }
  const byOutcome: PilotFunnelReport["feedback"]["byOutcome"] = { blocked: 0, confusing: 0, failed: 0, completed: 0, suggestion: 0 };
  for (const feedback of source.feedback) byOutcome[feedback.outcome] += 1;
  return {
    schemaVersion: "agentcert.pilot_funnel.v0.2", periodDays, since, generatedAt, stages,
    timing: {
      medianProjectToKeyMs: median(projects.flatMap((project) => project.firstKeyAt ? [elapsedMs(project.createdAt, project.firstKeyAt)] : [])),
      medianKeyToConnectionMs: median(projects.flatMap((project) => project.firstKeyAt && project.firstConnectionAt ? [elapsedMs(project.firstKeyAt, project.firstConnectionAt)] : [])),
      medianConnectionToEvidenceMs: median(projects.flatMap((project) => project.firstConnectionAt && project.firstEvidenceAt ? [elapsedMs(project.firstConnectionAt, project.firstEvidenceAt)] : [])),
      medianProjectToEvidenceMs: median(projects.flatMap((project) => project.firstEvidenceAt ? [elapsedMs(project.createdAt, project.firstEvidenceAt)] : [])),
      medianInstallToCurrentMs: median(projects.flatMap((project) => project.installToCurrentMs === undefined ? [] : [project.installToCurrentMs])),
      medianProjectToCurrentMs: median(projects.flatMap((project) => project.firstCurrentAt ? [elapsedMs(project.createdAt, project.firstCurrentAt)] : [])),
    },
    feedback: {
      total: source.feedback.length,
      friction: source.feedback.filter((item) => frictionOutcomes.has(item.outcome)).length,
      completedOrSuggestion: byOutcome.completed + byOutcome.suggestion,
      byOutcome,
      topReasons: [...reasonGroups.values()].sort((left, right) => right.count - left.count || left.reasonCode.localeCompare(right.reasonCode)).slice(0, 10),
    },
    projects: projects.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  };
}
function elapsedMs(start: string, end: string): number { return Math.max(0, Date.parse(end) - Date.parse(start)); }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator; }
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
function requiredTimestamp(value: Record<string, unknown>, key: string): string {
  const result = requiredString(value, key);
  if (!Number.isFinite(Date.parse(result))) throw new ControlPlaneError(`${key} must be a valid timestamp.`);
  return new Date(result).toISOString();
}
function optionalNumber(value: Record<string, unknown>, key: string): number | undefined { return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined; }
function databaseErrorCode(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error ? String(error.code) : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function collectorConflictMessage(reason: TrustedCollectorConflictError["reason"]): string {
  if (reason === "invalid_start") return "A trusted collector run must begin at sequence 0 with RUN_STARTED.";
  if (reason === "run_closed") return "A completed or reconciled trusted collector run cannot accept new records.";
  if (reason === "sequence_conflict") return "A sequence number was already accepted with a different record.";
  if (reason === "chain_conflict") return "The record previousEventHash does not match the server ACK chain head.";
  if (reason === "undeclared_gap") return "The record sequence contains an undeclared gap.";
  if (reason === "key_conflict") return "Collector key history conflicts with the requested key operation.";
  return "Collector identity or source key conflicts with the existing run.";
}
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
function actionAssuranceContext(value: unknown): ActionRecord["assuranceContext"] {
  if (value === undefined) return undefined;
  const input = record(value);
  const mandateId = requiredString(input, "mandateId");
  const mandateDigestSha256 = assuranceDigest(input.mandateDigestSha256, "mandateDigestSha256");
  const sourceReceiptSha256 = input.sourceReceiptSha256 === undefined ? undefined : assuranceDigest(input.sourceReceiptSha256, "sourceReceiptSha256");
  const sourceKeyId = optionalString(input, "sourceKeyId");
  const evidenceStrength = input.evidenceStrength;
  if (evidenceStrength !== undefined && !["reported", "recorded", "enforced", "outcome_verified"].includes(String(evidenceStrength))) {
    throw new ControlPlaneError("evidenceStrength is not supported.", 422);
  }
  return { mandateId, mandateDigestSha256, sourceReceiptSha256, sourceKeyId, evidenceStrength: evidenceStrength as NonNullable<ActionRecord["assuranceContext"]>["evidenceStrength"] };
}
function assuranceDigest(value: unknown, key: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ControlPlaneError(`${key} must be a lowercase SHA-256 digest.`, 422);
  return value;
}
