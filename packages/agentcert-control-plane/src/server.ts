import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Authenticator } from "./auth.js";
import { AgentCertControlPlane, ControlPlaneError } from "./service.js";
import type { PublicConfig } from "./types.js";

export interface ControlPlaneServerOptions {
  service: AgentCertControlPlane;
  authenticator: Authenticator;
  publicConfig: PublicConfig;
  host: string;
  port: number;
  dashboardDir: string;
  maxArtifactBytes: number;
}

export async function startControlPlaneServer(options: ControlPlaneServerOptions): Promise<void> {
  const staticRoot = resolve(options.dashboardDir);
  const server = createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"]?.toString().slice(0, 128) || randomUUID();
    const startedAt = Date.now();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      process.stdout.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "http_request",
        requestId,
        method: request.method,
        path: request.url?.split("?", 1)[0],
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      })}\n`);
    });
    setSecurityHeaders(request, response);
    try {
      await handleRequest(request, response, options, staticRoot);
    } catch (error) {
      const internalMessage = error instanceof Error ? error.message : "Unknown control plane error.";
      const { status, message } = publicHttpError(error);
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: status >= 500 ? "error" : "warn",
        event: "http_error",
        requestId,
        status,
        message: internalMessage,
      })}\n`);
      sendJson(response, status, { error: message });
    }
  });
  await new Promise<void>((resolveListen) => server.listen(options.port, options.host, resolveListen));
  process.stdout.write(`AgentCert Control Plane listening at http://${options.host}:${options.port}\n`);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneServerOptions,
  staticRoot: string,
): Promise<void> {
  if (!request.url) throw new ControlPlaneError("Missing request URL.");
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "agentcert-control-plane" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/config") {
    sendJson(response, 200, options.publicConfig);
    return;
  }
  if (!url.pathname.startsWith("/v1/")) {
    await serveStatic(response, staticRoot, url.pathname);
    return;
  }

  const auth = await options.authenticator.authenticate(request.headers.authorization);
  if (!auth) throw new ControlPlaneError("Authentication required.", 401);
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "POST" && url.pathname === "/v1/onboarding/bootstrap") {
    sendJson(response, 200, await options.service.bootstrap(auth));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/projects") {
    sendJson(response, 200, { projects: await options.service.projects(auth) });
    return;
  }

  const projectId = segments[1] === "projects" ? segments[2] : undefined;
  if (!projectId) throw new ControlPlaneError("Project route was not found.", 404);
  const collection = segments[3];
  const entityId = segments[4];
  const child = segments[5];

  if (collection === "overview" && request.method === "GET") {
    sendJson(response, 200, await options.service.overview(auth, projectId));
    return;
  }
  if (collection === "agents") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { agents: await options.service.listAgents(auth, projectId) });
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.createAgent(auth, projectId, await readJson(request)));
    else throw new ControlPlaneError("Agent route was not found.", 404);
    return;
  }
  if (collection === "runs") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { runs: await options.service.listRuns(auth, projectId) });
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.startRun(auth, projectId, await readJson(request)));
    else if (request.method === "GET" && entityId && !child) sendJson(response, 200, await options.service.runDetail(auth, projectId, entityId));
    else if (request.method === "GET" && entityId && child === "analysis") sendJson(response, 200, await options.service.runAnalysis(auth, projectId, entityId));
    else if (request.method === "POST" && entityId && child === "failure-reviews") sendJson(response, 200, await options.service.reviewFailure(auth, projectId, entityId, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "events") sendJson(response, 202, { events: await options.service.appendEvents(auth, projectId, entityId, await readJson(request)) });
    else if (request.method === "POST" && entityId && child === "complete") sendJson(response, 200, await options.service.completeRun(auth, projectId, entityId, await readJson(request)));
    else throw new ControlPlaneError("Run route was not found.", 404);
    return;
  }
  if (collection === "actions") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { actions: await options.service.listActions(auth, projectId) });
    else if (request.method === "GET" && entityId && !child) sendJson(response, 200, await options.service.getAction(auth, projectId, entityId));
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.proposeAction(auth, projectId, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "approve") sendJson(response, 200, await options.service.reviewAction(auth, projectId, entityId, true, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "reject") sendJson(response, 200, await options.service.reviewAction(auth, projectId, entityId, false, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "verify") sendJson(response, 200, await options.service.verifyAction(auth, projectId, entityId, await readJson(request)));
    else throw new ControlPlaneError("Action route was not found.", 404);
    return;
  }
  if (collection === "incidents" && request.method === "GET") {
    sendJson(response, 200, { incidents: await options.service.listIncidents(auth, projectId) });
    return;
  }
  if (collection === "evidence") {
    if (request.method === "GET" && !entityId) {
      sendJson(response, 200, { evidence: await options.service.listEvidence(auth, projectId) });
      return;
    }
    if (request.method === "POST" && !entityId) {
      const bytes = await readBody(request, options.maxArtifactBytes);
      const evidence = await options.service.uploadEvidence(auth, projectId, bytes, {
        fileName: requiredQuery(url, "fileName"),
        contentType: request.headers["content-type"] ?? "application/octet-stream",
        kind: url.searchParams.get("kind") ?? "artifact",
        schemaVersion: url.searchParams.get("schemaVersion") ?? "agentcert.evidence.v0.1",
        runId: url.searchParams.get("runId") ?? undefined,
        actionId: url.searchParams.get("actionId") ?? undefined,
      });
      sendJson(response, 201, evidence);
      return;
    }
    if (request.method === "GET" && entityId && child === "content") {
      const { evidence, artifact } = await options.service.readEvidence(auth, projectId, entityId);
      response.writeHead(200, {
        "content-type": evidence.contentType,
        "content-length": String(artifact.bytes.length),
        "content-disposition": `inline; filename="${evidence.fileName.replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
      });
      response.end(artifact.bytes);
      return;
    }
    throw new ControlPlaneError("Evidence route was not found.", 404);
  }
  if (collection === "api-keys") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { apiKeys: await options.service.listApiKeys(auth, projectId) });
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.createApiKey(auth, projectId, await readJson(request)));
    else if (request.method === "DELETE" && entityId) sendJson(response, 200, await options.service.revokeApiKey(auth, projectId, entityId));
    else throw new ControlPlaneError("API key route was not found.", 404);
    return;
  }
  throw new ControlPlaneError("Control plane route was not found.", 404);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBody(request, 1_048_576);
  if (bytes.length === 0) return {};
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ControlPlaneError("Request body must be valid JSON.");
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new ControlPlaneError(`Request body exceeds ${maxBytes} bytes.`, 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

async function serveStatic(response: ServerResponse, root: string, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new ControlPlaneError("Invalid static path.", 400);
  let path = candidate;
  try {
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
  } catch {
    path = resolve(root, "index.html");
  }
  try {
    const bytes = await readFile(path);
    response.writeHead(200, { "content-type": contentType(path), "content-length": String(bytes.length), "cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
    response.end(bytes);
  } catch {
    throw new ControlPlaneError("Dashboard build was not found.", 404);
  }
}

function contentType(path: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}
function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new ControlPlaneError(`${name} query parameter is required.`);
  return value;
}
export function publicHttpError(error: unknown): { status: number; message: string } {
  if (error instanceof ControlPlaneError) return { status: error.status, message: error.message };
  return { status: 500, message: "Internal server error." };
}

function setSecurityHeaders(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self' https://*.supabase.co; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");
  if (request.headers["x-forwarded-proto"] === "https") {
    response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}
