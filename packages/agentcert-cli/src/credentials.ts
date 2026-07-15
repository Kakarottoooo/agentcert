import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_AGENTCERT_SERVER = "https://agentcert-control-plane.onrender.com";

export interface HostedConnection {
  server: string;
  projectId: string;
  apiKey: string;
}

export interface CredentialStoreOptions {
  configHome?: string;
}

export interface ResolveConnectionOptions extends CredentialStoreOptions {
  name?: string;
  server?: string;
  projectId?: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
}

interface CredentialFile {
  schemaVersion: "agentcert.credentials.v1";
  defaultConnection: string;
  connections: Record<string, HostedConnection>;
}

export async function saveConnection(
  name: string,
  input: HostedConnection,
  options: CredentialStoreOptions = {},
): Promise<string> {
  const connectionName = validateConnectionName(name);
  const connection = validateConnection(input);
  const path = credentialsPath(options);
  const current = await readCredentialFile(path);
  const next: CredentialFile = {
    schemaVersion: "agentcert.credentials.v1",
    defaultConnection: connectionName,
    connections: { ...current?.connections, [connectionName]: connection },
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export async function loadConnection(
  name?: string,
  options: CredentialStoreOptions = {},
): Promise<HostedConnection | undefined> {
  const file = await readCredentialFile(credentialsPath(options));
  if (!file) return undefined;
  const connectionName = name ? validateConnectionName(name) : file.defaultConnection;
  const connection = file.connections[connectionName];
  return connection ? validateConnection(connection) : undefined;
}

export async function resolveConnection(options: ResolveConnectionOptions = {}): Promise<HostedConnection> {
  const env = options.env ?? process.env;
  const stored = options.server && options.projectId && options.apiKey
    ? undefined
    : await loadConnection(options.name, options);
  const candidate = {
    server: options.server ?? env.AGENTCERT_BASE_URL ?? stored?.server,
    projectId: options.projectId ?? env.AGENTCERT_PROJECT_ID ?? stored?.projectId,
    apiKey: options.apiKey ?? env.AGENTCERT_API_KEY ?? stored?.apiKey,
  };
  const missing = Object.entries(candidate).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Hosted connection is incomplete (${missing.join(", ")} missing). Run \`npx agentcert connect\` or set AGENTCERT_BASE_URL, AGENTCERT_PROJECT_ID, and AGENTCERT_API_KEY.`,
    );
  }
  return validateConnection(candidate as HostedConnection);
}

export function credentialsPath(options: CredentialStoreOptions = {}): string {
  const configHome = options.configHome ?? process.env.AGENTCERT_CONFIG_HOME ?? join(homedir(), ".agentcert");
  return join(configHome, "credentials.json");
}

function validateConnection(input: HostedConnection): HostedConnection {
  const projectId = input.projectId.trim();
  const apiKey = input.apiKey.trim();
  if (!projectId) throw new Error("AgentCert project ID is required.");
  if (!apiKey.startsWith("ac_live_")) throw new Error("AgentCert API key must start with ac_live_.");
  return { server: normalizeServer(input.server), projectId, apiKey };
}

function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("AgentCert server must be a valid HTTP or HTTPS URL.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("AgentCert server must use HTTPS. Plain HTTP is allowed only for localhost development.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AgentCert server URL cannot contain credentials, query parameters, or a fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function validateConnectionName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error("Connection name must contain 1-64 letters, numbers, dots, underscores, or hyphens.");
  }
  return name;
}

async function readCredentialFile(path: string): Promise<CredentialFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`AgentCert credentials file is not valid JSON: ${path}`);
  }
  if (!isCredentialFile(value)) {
    throw new Error(`AgentCert credentials file has an unsupported format: ${path}`);
  }
  return value;
}

function isCredentialFile(value: unknown): value is CredentialFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Partial<CredentialFile>;
  return file.schemaVersion === "agentcert.credentials.v1"
    && typeof file.defaultConnection === "string"
    && Boolean(file.connections)
    && typeof file.connections === "object"
    && !Array.isArray(file.connections);
}
