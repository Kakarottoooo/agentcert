export interface HostedConfig {
  kind: "agentcert.control_plane_config";
  hosted: true;
  publicUrl: string;
  auth: {
    provider: "supabase" | "development";
    supabaseUrl?: string;
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
  externalId: string;
  kind: string;
  status: string;
  score?: number;
  startedAt: string;
  completedAt?: string;
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
  severity: string;
  type: string;
  status: string;
  summary: string;
  firstDivergence?: string;
  createdAt: string;
}

export interface HostedEvidence {
  id: string;
  kind: string;
  schemaVersion: string;
  fileName: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface HostedApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface HostedOverview {
  projectId: string;
  summary: {
    agents: number;
    runs: number;
    passingRuns: number;
    pendingApprovals: number;
    openIncidents: number;
    evidence: number;
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

export async function loadOverview(session: HostedSession, projectId: string): Promise<HostedOverview> {
  return apiRequest(session, path(projectId, "overview"));
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

export async function createHostedApiKey(session: HostedSession, projectId: string, name: string): Promise<{ secret: string; apiKey: { prefix: string; name: string } }> {
  return apiRequest(session, path(projectId, "api-keys"), { method: "POST", body: JSON.stringify({ name }) });
}

export async function loadHostedApiKeys(session: HostedSession, projectId: string): Promise<HostedApiKey[]> {
  return (await apiRequest<{ apiKeys: HostedApiKey[] }>(session, path(projectId, "api-keys"))).apiKeys;
}

export async function revokeHostedApiKey(session: HostedSession, projectId: string, apiKeyId: string): Promise<HostedApiKey> {
  return apiRequest(session, path(projectId, `api-keys/${encodeURIComponent(apiKeyId)}`), { method: "DELETE" });
}

export function evidenceContentUrl(projectId: string, evidenceId: string): string {
  return path(projectId, `evidence/${encodeURIComponent(evidenceId)}/content`);
}

async function apiRequest<T>(session: HostedSession, url: string, init: RequestInit = {}): Promise<T> {
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
  const value = await response.json().catch(() => ({}));
  if (response.status === 401) saveHostedSession(undefined);
  if (!response.ok) throw new Error(value.error ?? `AgentCert API request failed (${response.status}).`);
  return value as T;
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
  if (!config.auth.supabaseUrl || !config.auth.supabaseAnonKey) throw new Error("Supabase authentication is not configured.");
  return fetch(`${config.auth.supabaseUrl.replace(/\/$/, "")}${route}`, {
    ...init,
    headers: { apikey: config.auth.supabaseAnonKey, "content-type": "application/json", ...init.headers },
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
