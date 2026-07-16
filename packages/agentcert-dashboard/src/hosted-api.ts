export interface HostedConfig {
  kind: "agentcert.control_plane_config";
  hosted: true;
  publicUrl: string;
  auth: {
    provider: "supabase" | "development";
    supabaseUrl?: string;
    supabasePublishableKey?: string;
    /** Legacy control-plane response compatibility. */
    supabaseAnonKey?: string;
    registrationOpen: boolean;
  };
}

export interface HostedSession {
  accessToken: string;
  refreshToken?: string;
  email?: string;
}

export interface HostedProject {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface HostedAgent {
  id: string;
  projectId: string;
  externalId: string;
  name: string;
  version: string;
  framework?: string;
  allowedPermissions: string[];
  updatedAt: string;
}

export interface HostedRun {
  id: string;
  projectId: string;
  agentId?: string;
  externalId: string;
  kind: string;
  status: string;
  score?: number;
  schemaVersion: string;
  startedAt: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

export interface HostedEvent {
  id: string;
  projectId: string;
  runId: string;
  sequence: number;
  type: string;
  actor: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface HostedAction {
  id: string;
  externalId: string;
  actionType: string;
  targetSystem: string;
  riskLevel: string;
  riskScore: number;
  decision: string;
  status: string;
  reasons: string[];
  expectedState?: Record<string, unknown>;
  observedState?: Record<string, unknown>;
  verificationSuccess?: boolean;
  createdAt: string;
}

export interface HostedIncident {
  id: string;
  projectId: string;
  runId?: string;
  severity: string;
  type: string;
  status: string;
  summary: string;
  firstDivergence?: string;
  createdAt: string;
}

export interface HostedEvidence {
  id: string;
  projectId: string;
  runId?: string;
  actionId?: string;
  kind: string;
  schemaVersion: string;
  fileName: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface HostedFailureReview {
  id: string;
  projectId: string;
  runId: string;
  patternKey: string;
  suggestedType?: string;
  type: string;
  status: "confirmed" | "corrected";
  reviewer: string;
  note?: string;
  confidence?: number;
  evidenceContext: {
    firstDivergenceSnippet?: string;
    screenshotPointer?: string;
    tracePointer?: string;
    stepIndex?: number;
  };
  taxonomyRationale: {
    primaryReason: string;
    supportingSignals: string[];
    contradictingSignals: string[];
    classifierLimitation?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface HostedRunAnalysis {
  run: HostedRun;
  events: HostedEvent[];
  evidence: HostedEvidence[];
  incidents: HostedIncident[];
  reviews: HostedFailureReview[];
  evidenceCompleteness: {
    status: "complete" | "partial" | "rejected";
    reasons: string[];
    evidenceCount: number;
    bytesUsed: number;
    runLimitBytes: number;
    remainingBytes: number;
    retentionDays: number;
    expiresAt?: string;
    legalHoldActive: boolean;
    reconciliation: {
      manifestVersion?: string;
      declared: number;
      matched: number;
      missing: string[];
      mismatched: Array<{ path: string; fields: string[] }>;
      unexpected: string[];
      legacy: boolean;
    };
  };
}

export interface HostedLegalHoldRequest {
  id: string;
  projectId: string;
  status: "requested" | "approved" | "rejected" | "released";
  reason: string;
  requestedByEmail?: string;
  requestedAt: string;
  reviewedByEmail?: string;
  reviewNote?: string;
  reviewedAt?: string;
  releasedByEmail?: string;
  releaseNote?: string;
  releasedAt?: string;
}

export interface HostedApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  scopes: string[];
}

export interface HostedCapabilities {
  platformAdmin: boolean;
  evidenceSigning: boolean;
  signedWebhooks: boolean;
}

export interface HostedWebhookFailure {
  id: string;
  eventType: string;
  responseStatus?: number;
  error?: string;
  attemptedAt: string;
}

export interface HostedWebhookJob {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "processing" | "retrying" | "delivered" | "dead_letter";
  attemptCount: number;
  maxAttempts: number;
  lastError?: string;
  createdAt: string;
  completedAt?: string;
}

export interface HostedSigningKey {
  keyId: string;
  algorithm: "Ed25519";
  status: "active" | "retired" | "revoked";
  activatedAt: string;
  retiredAt?: string;
}

export interface HostedOperations {
  schemaVersion: "agentcert.trust_operations.v0.3";
  projectId: string;
  status: "healthy" | "warning" | "critical";
  generatedAt: string;
  coordination: { backend: "memory" | "redis"; state: "ready" | "degraded"; shared: boolean };
  alerts: Record<"redis" | "signing" | "scheduledSmoke" | "webhooks", { status: "healthy" | "warning" | "critical"; message: string }>;
  webhooks: {
    queue: Record<HostedWebhookJob["status"], number>;
    recentJobs: HostedWebhookJob[];
    recentFailures: HostedWebhookFailure[];
    deadLetters: HostedWebhookJob[];
  };
  signing: {
    configured: boolean;
    activeKey: HostedSigningKey | null;
    historicalKeys: number;
    keys: HostedSigningKey[];
  };
  smoke: { latest: HostedTrustHealthSample | null; recent: HostedTrustHealthSample[] };
  trends: {
    windowDays: 7;
    health: Array<{ date: string; total: number; passed: number; failed: number; successRate: number }>;
    webhooks: Array<{ date: string; total: number; delivered: number; retried: number; deadLetter: number; averageLatencyMs: number; p95LatencyMs: number }>;
    summary: {
      smokeSuccessRate: number; webhookSuccessRate: number; retryRate: number; deadLetterRate: number;
      averageLatencyMs: number; p95LatencyMs: number;
    };
  };
}

export interface HostedTrustHealthSample {
  id: string;
  externalId: string;
  source: "production_smoke" | "manual";
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  checks: string[];
  error?: string;
  workflowRunUrl?: string;
}

export interface HostedWebhook {
  id: string;
  url: string;
  eventTypes: string[];
  createdAt: string;
  revokedAt?: string;
}

export interface HostedWebhookState {
  webhooks: HostedWebhook[];
  deliveries: HostedWebhookFailure[];
  jobs: HostedWebhookJob[];
}

export interface HostedRetentionReport {
  schemaVersion: "agentcert.retention_report.v0.1";
  projectId: string;
  generatedAt: string;
  policy: { retentionDays: number; projectLimitBytes: number };
  usage: { count: number; bytes: number };
  legalHolds: HostedLegalHoldRequest[];
  deletionJournal: Array<{
    id: string; evidenceId: string; fileName: string; kind: string; sha256: string; sizeBytes: number;
    outcome: "deleted" | "held" | "missing" | "failed"; reason: string; error?: string; occurredAt: string;
  }>;
}

export interface HostedOverview {
  projectId: string;
  storage: {
    usedBytes: number;
    limitBytes: number;
    remainingBytes: number;
    retentionDays: number;
    acceptedFormats: string[];
    legalHold: HostedLegalHoldRequest | null;
    deletionCount: number;
  };
  summary: {
    agents: number;
    runs: number;
    passingRuns: number;
    pendingApprovals: number;
    openIncidents: number;
    evidence: number;
    taxonomyQuality: {
      schemaVersion: "agentcert.failure_quality_metrics.v0.1";
      totalFailures: number;
      reviewedFailures: number;
      confirmedFailures: number;
      correctedFailures: number;
      reviewCoverage: number;
      autoLabelPrecision: number;
      correctionRate: number;
      calculatedAt: string;
    };
  };
  recentRuns: HostedRun[];
  recentActions: HostedAction[];
  openIncidents: HostedIncident[];
}

const SESSION_KEY = "agentcert.hosted.session.v1";
let activeConfig: HostedConfig | undefined;

export async function detectHostedConfig(): Promise<HostedConfig | undefined> {
  if (window.location.protocol === "file:") return undefined;
  const response = await fetch("/v1/config", { cache: "no-store" }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const value = (await response.json()) as HostedConfig;
  if (value.kind === "agentcert.control_plane_config" && value.hosted) {
    activeConfig = value;
    return value;
  }
  return undefined;
}

export function readHostedSession(config: HostedConfig): HostedSession | undefined {
  if (config.auth.provider === "development") return { accessToken: "dev-local-token", email: "developer@localhost" };
  const callbackSession = sessionFromLocationHash();
  if (callbackSession) {
    saveHostedSession(callbackSession);
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
    return callbackSession;
  }
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as HostedSession;
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
    return undefined;
  }
}

export function readHostedAuthCallbackError(): string | undefined {
  if (!window.location.hash.includes("error=")) return undefined;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const error = params.get("error");
  if (!error) return undefined;

  window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
  if (params.get("error_code") === "otp_expired") {
    return "This confirmation link is invalid or has expired. Enter your email and request a new confirmation email.";
  }
  return params.get("error_description") ?? "Authentication failed. Please try again.";
}

export function saveHostedSession(session: HostedSession | undefined): void {
  if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else window.localStorage.removeItem(SESSION_KEY);
}

export async function signUp(config: HostedConfig, email: string, password: string): Promise<{ session?: HostedSession; message: string }> {
  const response = await supabaseRequest(config, `/auth/v1/signup?redirect_to=${encodeURIComponent(config.publicUrl)}`, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.msg ?? value.message ?? "Registration failed.");
  const session = sessionFromSupabase(value);
  if (session) saveHostedSession(session);
  return { session, message: session ? "Account created." : "Check your email to confirm the account, then sign in." };
}

export async function resendSignUpConfirmation(config: HostedConfig, email: string): Promise<string> {
  const normalizedEmail = email.trim();
  if (!normalizedEmail) throw new Error("Enter your email before requesting a new confirmation message.");
  const response = await supabaseRequest(config, `/auth/v1/resend?redirect_to=${encodeURIComponent(config.publicUrl)}`, {
    method: "POST",
    body: JSON.stringify({ email: normalizedEmail, type: "signup" }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.msg ?? value.message ?? "Could not resend the confirmation email.");
  return "Confirmation email sent. Use the newest link to finish signing up.";
}

export async function signIn(config: HostedConfig, email: string, password: string): Promise<HostedSession> {
  const response = await supabaseRequest(config, "/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error_description ?? value.msg ?? "Sign in failed.");
  const session = sessionFromSupabase(value);
  if (!session) throw new Error("Authentication provider did not return a session.");
  saveHostedSession(session);
  return session;
}

export async function signOut(config: HostedConfig, session: HostedSession): Promise<void> {
  if (config.auth.provider === "supabase") {
    await supabaseRequest(config, "/auth/v1/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}` },
    }).catch(() => undefined);
  }
  saveHostedSession(undefined);
}

export async function bootstrap(session: HostedSession) {
  return apiRequest<{ project: HostedProject; organization: { id: string; name: string }; membership: { role: string } }>(session, "/v1/onboarding/bootstrap", { method: "POST" });
}

export async function loadProjects(session: HostedSession): Promise<HostedProject[]> {
  return (await apiRequest<{ projects: HostedProject[] }>(session, "/v1/projects")).projects;
}

export async function loadHostedCapabilities(session: HostedSession): Promise<HostedCapabilities> {
  return apiRequest(session, "/v1/me/capabilities");
}

export async function loadOverview(session: HostedSession, projectId: string): Promise<HostedOverview> {
  return apiRequest(session, path(projectId, "overview"));
}

export async function loadHostedOperations(session: HostedSession, projectId: string): Promise<HostedOperations> {
  return apiRequest(session, path(projectId, "operations"));
}

export async function loadHostedAgents(session: HostedSession, projectId: string): Promise<HostedAgent[]> {
  return (await apiRequest<{ agents: HostedAgent[] }>(session, path(projectId, "agents"))).agents;
}

export async function createHostedAgent(session: HostedSession, projectId: string, input: Record<string, unknown>): Promise<HostedAgent> {
  return apiRequest(session, path(projectId, "agents"), { method: "POST", body: JSON.stringify(input) });
}

export async function loadHostedRuns(session: HostedSession, projectId: string): Promise<HostedRun[]> {
  return (await apiRequest<{ runs: HostedRun[] }>(session, path(projectId, "runs"))).runs;
}

export async function loadHostedRunAnalysis(session: HostedSession, projectId: string, runId: string): Promise<HostedRunAnalysis> {
  return apiRequest(session, path(projectId, `runs/${encodeURIComponent(runId)}/analysis`));
}

export async function reviewHostedFailure(
  session: HostedSession,
  projectId: string,
  runId: string,
  input: Record<string, unknown>,
): Promise<HostedFailureReview> {
  return apiRequest(session, path(projectId, `runs/${encodeURIComponent(runId)}/failure-reviews`), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function loadHostedActions(session: HostedSession, projectId: string): Promise<HostedAction[]> {
  return (await apiRequest<{ actions: HostedAction[] }>(session, path(projectId, "actions"))).actions;
}

export async function reviewHostedAction(session: HostedSession, projectId: string, actionId: string, decision: "approve" | "reject", comment?: string): Promise<HostedAction> {
  return apiRequest(session, path(projectId, `actions/${encodeURIComponent(actionId)}/${decision}`), { method: "POST", body: JSON.stringify({ comment }) });
}

export async function loadHostedIncidents(session: HostedSession, projectId: string): Promise<HostedIncident[]> {
  return (await apiRequest<{ incidents: HostedIncident[] }>(session, path(projectId, "incidents"))).incidents;
}

export async function loadHostedEvidence(session: HostedSession, projectId: string): Promise<HostedEvidence[]> {
  return (await apiRequest<{ evidence: HostedEvidence[] }>(session, path(projectId, "evidence"))).evidence;
}

export async function requestHostedLegalHold(
  session: HostedSession,
  projectId: string,
  reason: string,
): Promise<HostedLegalHoldRequest> {
  return apiRequest(session, path(projectId, "legal-holds"), { method: "POST", body: JSON.stringify({ reason }) });
}

export async function createHostedApiKey(session: HostedSession, projectId: string, name: string, scopes?: string[]): Promise<{ secret: string; apiKey: { prefix: string; name: string; scopes: string[] } }> {
  return apiRequest(session, path(projectId, "api-keys"), { method: "POST", body: JSON.stringify({ name, scopes }) });
}

export async function loadHostedApiKeys(session: HostedSession, projectId: string): Promise<HostedApiKey[]> {
  return (await apiRequest<{ apiKeys: HostedApiKey[] }>(session, path(projectId, "api-keys"))).apiKeys;
}

export async function revokeHostedApiKey(session: HostedSession, projectId: string, apiKeyId: string): Promise<HostedApiKey> {
  return apiRequest(session, path(projectId, `api-keys/${encodeURIComponent(apiKeyId)}`), { method: "DELETE" });
}

export async function retryHostedWebhookJob(session: HostedSession, projectId: string, jobId: string): Promise<HostedWebhookJob> {
  return apiRequest(session, path(projectId, `webhook-jobs/${encodeURIComponent(jobId)}/retry`), { method: "POST" });
}

export async function loadHostedWebhooks(session: HostedSession, projectId: string): Promise<HostedWebhookState> {
  return apiRequest(session, path(projectId, "webhooks"));
}

export async function createHostedTestWebhook(session: HostedSession, projectId: string): Promise<{ webhook: HostedWebhook; reused: boolean }> {
  return apiRequest(session, path(projectId, "webhooks/test-receiver"), { method: "POST" });
}

export async function loadAdminLegalHolds(session: HostedSession): Promise<HostedLegalHoldRequest[]> {
  return (await apiRequest<{ requests: HostedLegalHoldRequest[] }>(session, "/v1/admin/legal-hold-requests")).requests;
}

export async function reviewAdminLegalHold(session: HostedSession, requestId: string, decision: "approve" | "reject" | "release", reviewNote: string): Promise<HostedLegalHoldRequest> {
  return apiRequest(session, `/v1/admin/legal-hold-requests/${encodeURIComponent(requestId)}/${decision}`, {
    method: "POST", body: JSON.stringify({ reviewNote }),
  });
}

export async function loadRetentionReport(session: HostedSession, projectId: string): Promise<HostedRetentionReport> {
  return apiRequest(session, path(projectId, "retention-report"));
}

export async function downloadRetentionReport(session: HostedSession, projectId: string): Promise<void> {
  const report = await loadRetentionReport(session, projectId);
  const href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = `agentcert-retention-report-${projectId}.json`;
  link.click();
  URL.revokeObjectURL(href);
}

export async function downloadAdminLegalHoldReport(session: HostedSession, requestId: string): Promise<void> {
  const report = await apiRequest<HostedRetentionReport>(session, `/v1/admin/legal-hold-requests/${encodeURIComponent(requestId)}/report`);
  downloadJson(report, `agentcert-legal-hold-${requestId}.json`);
}

function downloadJson(value: unknown, fileName: string): void {
  const href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(href);
}

export function evidenceContentUrl(projectId: string, evidenceId: string): string {
  return path(projectId, `evidence/${encodeURIComponent(evidenceId)}/content`);
}

export async function loadHostedEvidenceDocument(session: HostedSession, projectId: string, evidenceId: string): Promise<unknown> {
  return apiRequest(session, evidenceContentUrl(projectId, evidenceId));
}

export async function loadHostedEvidenceBlob(session: HostedSession, projectId: string, evidenceId: string): Promise<Blob> {
  const response = await authenticatedFetch(session, evidenceContentUrl(projectId, evidenceId));
  if (!response.ok) {
    const value = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(value.error ?? `Evidence download failed (${response.status}).`);
  }
  return response.blob();
}

async function apiRequest<T>(session: HostedSession, url: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(session, url, init);
  const value = await response.json().catch(() => ({}));
  if (response.status === 401) saveHostedSession(undefined);
  if (!response.ok) throw new Error(value.error ?? `AgentCert API request failed (${response.status}).`);
  return value as T;
}

async function authenticatedFetch(session: HostedSession, url: string, init: RequestInit = {}): Promise<Response> {
  let currentSession = session;
  let response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${currentSession.accessToken}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (response.status === 401 && currentSession.refreshToken && activeConfig) {
    const refreshed = await refreshSession(activeConfig, currentSession.refreshToken).catch(() => undefined);
    if (refreshed) {
      currentSession = refreshed;
      saveHostedSession(refreshed);
      response = await fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${currentSession.accessToken}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      });
    }
  }
  return response;
}

async function refreshSession(config: HostedConfig, refreshToken: string): Promise<HostedSession> {
  const response = await supabaseRequest(config, "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error("Session refresh failed.");
  const session = sessionFromSupabase(value);
  if (!session) throw new Error("Authentication provider did not return a refreshed session.");
  return session;
}

function path(projectId: string, suffix: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/${suffix}`;
}

async function supabaseRequest(config: HostedConfig, route: string, init: RequestInit): Promise<Response> {
  const publishableKey = config.auth.supabasePublishableKey ?? config.auth.supabaseAnonKey;
  if (!config.auth.supabaseUrl || !publishableKey) throw new Error("Supabase authentication is not configured.");
  return fetch(`${config.auth.supabaseUrl.replace(/\/$/, "")}${route}`, {
    ...init,
    headers: { apikey: publishableKey, "content-type": "application/json", ...init.headers },
  });
}

function sessionFromSupabase(value: Record<string, unknown>): HostedSession | undefined {
  const accessToken = typeof value.access_token === "string" ? value.access_token : undefined;
  if (!accessToken) return undefined;
  const user = value.user && typeof value.user === "object" ? value.user as Record<string, unknown> : {};
  return {
    accessToken,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
    email: typeof user.email === "string" ? user.email : undefined,
  };
}

function sessionFromLocationHash(): HostedSession | undefined {
  if (!window.location.hash.includes("access_token=")) return undefined;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get("access_token") ?? undefined;
  if (!accessToken) return undefined;
  return {
    accessToken,
    refreshToken: params.get("refresh_token") ?? undefined,
  };
}
