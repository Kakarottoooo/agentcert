import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Authenticator } from "./auth.js";
import { AgentCertControlPlane, ControlPlaneError } from "./service.js";
import type { PublicConfig } from "./types.js";
import { rateLimitIdentity, requestHash, setRateLimitHeaders, type RateLimiter } from "./security.js";
import { LocalIdempotencyCoordinator, type CoordinationHealth, type IdempotencyCoordinator } from "./coordination.js";

const localIdempotency = new LocalIdempotencyCoordinator();

export interface ControlPlaneServerOptions {
  service: AgentCertControlPlane;
  authenticator: Authenticator;
  publicConfig: PublicConfig;
  host: string;
  port: number;
  dashboardDir: string;
  maxArtifactBytes: number;
  rateLimiter?: RateLimiter;
  idempotencyCoordinator?: IdempotencyCoordinator;
  coordinationHealth?: () => CoordinationHealth;
}

export async function startControlPlaneServer(options: ControlPlaneServerOptions): Promise<void> {
  const server = createControlPlaneHttpServer(options);
  await new Promise<void>((resolveListen) => server.listen(options.port, options.host, resolveListen));
  process.stdout.write(`AgentCert Control Plane listening at http://${options.host}:${options.port}\n`);
}

export function createControlPlaneHttpServer(options: ControlPlaneServerOptions): Server {
  const staticRoot = resolve(options.dashboardDir);
  return createServer(async (request, response) => {
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
      const { status, message, code, recovery } = publicHttpError(error);
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: status >= 500 ? "error" : "warn",
        event: "http_error",
        requestId,
        status,
        message: internalMessage,
      })}\n`);
      sendJson(response, status, { error: message, code, recovery, requestId });
    }
  });
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
    const coordination = options.coordinationHealth?.() ?? { backend: "memory", state: "degraded", shared: false };
    sendJson(response, 200, { ok: true, service: "agentcert-control-plane", coordination });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/config") {
    sendJson(response, 200, options.publicConfig);
    return;
  }
  const testReceiver = url.pathname.match(/^\/v1\/webhook-test-receiver\/([^/]+)\/([^/]+)$/);
  if (request.method === "POST" && testReceiver) {
    if (options.rateLimiter) {
      const limit = await options.rateLimiter.consume(`webhook-receiver:${rateLimitIdentity(request)}`);
      setRateLimitHeaders(response, limit);
      if (!limit.allowed) throw new ControlPlaneError("Webhook receiver rate limit exceeded.", 429);
    }
    const bytes = await readBody(request, 1_048_576);
    await options.service.acceptTestWebhook(decodeURIComponent(testReceiver[1]!), decodeURIComponent(testReceiver[2]!), {
      "x-agentcert-timestamp": request.headers["x-agentcert-timestamp"]?.toString(),
      "x-agentcert-signature": request.headers["x-agentcert-signature"]?.toString(),
      "x-agentcert-event": request.headers["x-agentcert-event"]?.toString(),
      "x-agentcert-event-id": request.headers["x-agentcert-event-id"]?.toString(),
    }, bytes);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/signing-keys/current") {
    sendJson(response, 200, options.service.signingKey());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/signing-keys") {
    sendJson(response, 200, await options.service.signingKeys());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/notification-destinations/verify") {
    const result = await options.service.verifyNotificationDestination(url.searchParams.get("token") ?? "");
    const verified = result.outcome === "verified" || result.outcome === "already_verified";
    if (request.headers.accept?.includes("text/html")) {
      sendRedirect(response, `/verify-email?status=${encodeURIComponent(result.outcome)}`);
    } else {
      sendJson(response, verified ? 200 : 400, { verified, outcome: result.outcome });
    }
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/signing-keys/")) {
    sendJson(response, 200, await options.service.signingKeyById(decodeURIComponent(url.pathname.slice("/v1/signing-keys/".length))));
    return;
  }
  const publicAssuranceReport = url.pathname.match(/^\/v1\/public\/assurance-reports\/([^/]+)$/);
  if (request.method === "GET" && publicAssuranceReport) {
    sendJson(response, 200, await options.service.publicAssuranceReport(decodeURIComponent(publicAssuranceReport[1]!)));
    return;
  }
  if (!url.pathname.startsWith("/v1/")) {
    await serveStatic(response, staticRoot, url.pathname);
    return;
  }

  const auth = await options.authenticator.authenticate(request.headers.authorization);
  if (!auth) throw new ControlPlaneError("Authentication required.", 401, "authentication_required", "Sign in again or replace the revoked/invalid project API key.");
  if (options.rateLimiter) {
    const limit = await options.rateLimiter.consume(rateLimitIdentity(request, auth.apiKeyId ?? auth.userId));
    setRateLimitHeaders(response, limit);
    if (!limit.allowed) throw new ControlPlaneError("Rate limit exceeded. Retry after the interval in the Retry-After header.", 429);
  }
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "POST" && url.pathname === "/v1/onboarding/bootstrap") {
    sendJson(response, 200, await options.service.bootstrap(auth));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/projects") {
    sendJson(response, 200, { projects: await options.service.projects(auth) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/projects") {
    sendJson(response, 201, await options.service.createProject(auth, await readJson(request)));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/me/capabilities") {
    sendJson(response, 200, options.service.capabilities(auth));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/invitations/accept") {
    sendJson(response, 200, await options.service.acceptTeamInvitation(auth, await readJson(request)));
    return;
  }
  if (segments[1] === "organizations" && segments[2]) {
    const organizationId = segments[2];
    const collection = segments[3];
    const entityId = segments[4];
    if (collection === "team" && request.method === "GET" && !entityId) {
      sendJson(response, 200, await options.service.teamSnapshot(auth, organizationId));
    } else if (collection === "invitations" && request.method === "POST" && !entityId) {
      sendJson(response, 201, await options.service.createTeamInvitation(auth, organizationId, await readJson(request)));
    } else if (collection === "invitations" && request.method === "DELETE" && entityId) {
      sendJson(response, 200, await options.service.revokeTeamInvitation(auth, organizationId, entityId));
    } else if (collection === "members" && request.method === "PATCH" && entityId) {
      sendJson(response, 200, await options.service.updateTeamMember(auth, organizationId, entityId, await readJson(request)));
    } else if (collection === "members" && request.method === "DELETE" && entityId) {
      await options.service.removeTeamMember(auth, organizationId, entityId);
      sendJson(response, 200, { removed: true });
    } else {
      throw new ControlPlaneError("Team management route was not found.", 404, "route_not_found");
    }
    return;
  }

  if (segments[1] === "admin" && segments[2] === "legal-hold-requests") {
    const requestId = segments[3];
    const decision = segments[4];
    if (request.method === "GET" && requestId && decision === "report") {
      sendJson(response, 200, await options.service.adminLegalHoldReport(auth, requestId));
    } else if (request.method === "GET" && !requestId) {
      const status = url.searchParams.get("status") ?? undefined;
      if (status && !new Set(["requested", "approved", "rejected", "released"]).has(status)) throw new ControlPlaneError("Invalid legal hold status.");
      sendJson(response, 200, { requests: await options.service.listAdminLegalHoldRequests(auth, status as "requested" | "approved" | "rejected" | "released" | undefined) });
    } else if (request.method === "POST" && requestId && (decision === "approve" || decision === "reject" || decision === "release")) {
      sendJson(response, 200, await options.service.reviewLegalHold(auth, requestId, decision, await readJson(request)));
    } else {
      throw new ControlPlaneError("Legal hold administration route was not found.", 404);
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/admin/pilot-report") {
    const days = Number(url.searchParams.get("days") ?? "30");
    sendJson(response, 200, await options.service.pilotFunnelReport(auth, days));
    return;
  }

  const projectId = segments[1] === "projects" ? segments[2] : undefined;
  if (!projectId) throw new ControlPlaneError("Project route was not found.", 404);
  const collection = segments[3];
  const entityId = segments[4];
  const child = segments[5];

  if (!collection && request.method === "PATCH") {
    sendJson(response, 200, await options.service.renameProject(auth, projectId, await readJson(request)));
    return;
  }
  if (collection === "onboarding" && request.method === "GET" && !entityId) {
    sendJson(response, 200, await options.service.onboardingStatus(auth, projectId));
    return;
  }
  if (collection === "pilot-feedback" && !entityId) {
    if (request.method === "GET") sendJson(response, 200, { feedback: await options.service.listPilotFeedback(auth, projectId) });
    else if (request.method === "POST") sendJson(response, 201, await options.service.submitPilotFeedback(auth, projectId, await readJson(request)));
    else throw new ControlPlaneError("Pilot feedback route was not found.", 404, "route_not_found");
    return;
  }
  if (collection === "assurance-cases") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { assuranceCases: await options.service.listAssuranceCases(auth, projectId) });
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.createAssuranceCase(auth, projectId, await readJson(request)));
    else if (request.method === "GET" && entityId && !child) sendJson(response, 200, await options.service.getAssuranceCase(auth, projectId, entityId));
    else if (request.method === "POST" && entityId && child) sendJson(response, 200, await options.service.transitionAssuranceCase(auth, projectId, entityId, child, await readJson(request)));
    else throw new ControlPlaneError("Assurance case route was not found.", 404);
    return;
  }

  if (collection === "envelopes" && request.method === "POST" && !entityId) {
    await sendIdempotentJson(request, response, options.service, projectId, "envelopes.create", 202,
      (body) => options.service.ingestEnvelope(auth, projectId, body), options.idempotencyCoordinator);
    return;
  }
  if (collection === "collector-keys") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { keys: await options.service.listCollectorSourceKeys(auth, projectId) });
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.registerCollectorSourceKey(auth, projectId, await readJson(request)));
    else if (request.method === "DELETE" && entityId) sendJson(response, 200, await options.service.revokeCollectorSourceKey(auth, projectId, entityId));
    else throw new ControlPlaneError("Collector key route was not found.", 404, "route_not_found");
    return;
  }
  if (collection === "trusted-runs" && entityId) {
    if (request.method === "POST" && child === "records") {
      await sendIdempotentJson(request, response, options.service, projectId, `trusted-runs.${entityId}.records`, 202,
        (body) => options.service.appendTrustedCollectorRecords(auth, projectId, entityId, body), options.idempotencyCoordinator);
    } else if (request.method === "POST" && child === "reconcile") {
      await sendIdempotentJson(request, response, options.service, projectId, `trusted-runs.${entityId}.reconcile`, 200,
        (body) => options.service.reconcileTrustedCollectorRun(auth, projectId, entityId, body), options.idempotencyCoordinator);
    } else {
      throw new ControlPlaneError("Trusted collector run route was not found.", 404, "route_not_found");
    }
    return;
  }
  if (collection === "collector-heartbeats" && request.method === "POST" && !entityId) {
    sendJson(response, 202, await options.service.recordCollectorHeartbeat(auth, projectId, await readJson(request)));
    return;
  }
  if (collection === "collector-status" && request.method === "GET" && !entityId) {
    sendJson(response, 200, await options.service.trustedCollectorStatus(auth, projectId));
    return;
  }
  if (collection === "overview" && request.method === "GET") {
    sendJson(response, 200, await options.service.overview(auth, projectId));
    return;
  }
  if (collection === "operations" && entityId === "smoke-runs" && request.method === "POST") {
    sendJson(response, 201, await options.service.recordTrustHealthSample(auth, projectId, await readJson(request)));
    return;
  }
  if (collection === "operations" && request.method === "GET" && !entityId) {
    sendJson(response, 200, await options.service.operationsOverview(auth, projectId, options.coordinationHealth?.()));
    return;
  }
  if (collection === "operational-incidents" && entityId && child === "acknowledge" && request.method === "POST") {
    sendJson(response, 200, await options.service.acknowledgeOperationalIncident(auth, projectId, entityId, await readJson(request)));
    return;
  }
  if (collection === "operational-incidents" && entityId && child === "resolve" && request.method === "POST") {
    sendJson(response, 200, await options.service.resolveOperationalIncident(auth, projectId, entityId, await readJson(request)));
    return;
  }
  if (collection === "operational-incidents" && entityId && child === "github" && request.method === "POST") {
    sendJson(response, 200, await options.service.linkOperationalIncidentGitHub(auth, projectId, entityId, await readJson(request)));
    return;
  }
  if (collection === "notification-destinations") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { destinations: await options.service.listNotificationDestinations(auth, projectId) });
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.createNotificationDestination(auth, projectId, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "test") sendJson(response, 202, await options.service.sendTestNotification(auth, projectId, entityId));
    else if (request.method === "DELETE" && entityId) sendJson(response, 200, await options.service.disableNotificationDestination(auth, projectId, entityId));
    else throw new ControlPlaneError("Notification destination route was not found.", 404);
    return;
  }
  if (collection === "notification-jobs" && entityId && child === "retry" && request.method === "POST") {
    sendJson(response, 200, await options.service.retryNotificationJob(auth, projectId, entityId));
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
    else if (request.method === "POST" && !entityId) await sendIdempotentJson(request, response, options.service, projectId, "runs.create", 201,
      (body) => options.service.startRun(auth, projectId, body), options.idempotencyCoordinator);
    else if (request.method === "GET" && entityId && !child) sendJson(response, 200, await options.service.runDetail(auth, projectId, entityId));
    else if (request.method === "GET" && entityId && child === "analysis") sendJson(response, 200, await options.service.runAnalysis(auth, projectId, entityId));
    else if (request.method === "POST" && entityId && child === "failure-reviews") sendJson(response, 200, await options.service.reviewFailure(auth, projectId, entityId, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "events") await sendIdempotentJson(request, response, options.service, projectId, `runs.${entityId}.events`, 202,
      async (body) => ({ events: await options.service.appendEvents(auth, projectId, entityId, body) }), options.idempotencyCoordinator);
    else if (request.method === "POST" && entityId && child === "complete") await sendIdempotentJson(request, response, options.service, projectId, `runs.${entityId}.complete`, 200,
      (body) => options.service.completeRun(auth, projectId, entityId, body), options.idempotencyCoordinator);
    else throw new ControlPlaneError("Run route was not found.", 404);
    return;
  }
  if (collection === "actions") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { actions: await options.service.listActions(auth, projectId) });
    else if (request.method === "GET" && entityId && !child) sendJson(response, 200, await options.service.getAction(auth, projectId, entityId));
    else if (request.method === "POST" && !entityId) await sendIdempotentJson(request, response, options.service, projectId, "actions.create", 201,
      (body) => options.service.proposeAction(auth, projectId, body), options.idempotencyCoordinator);
    else if (request.method === "POST" && entityId && child === "approve") sendJson(response, 200, await options.service.reviewAction(auth, projectId, entityId, true, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "reject") sendJson(response, 200, await options.service.reviewAction(auth, projectId, entityId, false, await readJson(request)));
    else if (request.method === "POST" && entityId && child === "verify") await sendIdempotentJson(request, response, options.service, projectId, `actions.${entityId}.verify`, 200,
      (body) => options.service.verifyAction(auth, projectId, entityId, body), options.idempotencyCoordinator);
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
        sourcePath: url.searchParams.get("sourcePath") ?? undefined,
      });
      sendJson(response, 201, evidence);
      return;
    }
    if (request.method === "GET" && entityId && child === "content") {
      const { evidence, artifact } = await options.service.readEvidence(auth, projectId, entityId);
      response.writeHead(200, {
        "content-type": evidence.contentType,
        "content-length": String(artifact.bytes.length),
        "content-disposition": `${evidence.contentType.startsWith("image/") ? "inline" : "attachment"}; filename="${evidence.fileName.replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
      });
      response.end(artifact.bytes);
      return;
    }
    throw new ControlPlaneError("Evidence route was not found.", 404);
  }
  if (collection === "legal-holds") {
    if (request.method === "GET" && !entityId) {
      sendJson(response, 200, { requests: await options.service.listLegalHoldRequests(auth, projectId) });
    } else if (request.method === "POST" && !entityId) {
      sendJson(response, 201, await options.service.requestLegalHold(auth, projectId, await readJson(request)));
    } else {
      throw new ControlPlaneError("Legal hold route was not found.", 404);
    }
    return;
  }
  if (collection === "retention-report" && request.method === "GET") {
    sendJson(response, 200, await options.service.legalHoldReport(auth, projectId));
    return;
  }
  if (collection === "api-keys") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, { apiKeys: await options.service.listApiKeys(auth, projectId) });
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.createApiKey(auth, projectId, await readJson(request)));
    else if (request.method === "DELETE" && entityId) sendJson(response, 200, await options.service.revokeApiKey(auth, projectId, entityId));
    else throw new ControlPlaneError("API key route was not found.", 404);
    return;
  }
  if (collection === "webhooks") {
    if (request.method === "GET" && !entityId) sendJson(response, 200, await options.service.listWebhooks(auth, projectId));
    else if (request.method === "POST" && !entityId) sendJson(response, 201, await options.service.createWebhook(auth, projectId, await readJson(request)));
    else if (request.method === "POST" && entityId === "test-receiver") sendJson(response, 201, await options.service.createTestWebhook(auth, projectId, options.publicConfig.publicUrl));
    else if (request.method === "DELETE" && entityId) sendJson(response, 200, await options.service.revokeWebhook(auth, projectId, entityId));
    else throw new ControlPlaneError("Webhook route was not found.", 404);
    return;
  }
  if (collection === "webhook-jobs" && entityId && child === "retry" && request.method === "POST") {
    sendJson(response, 200, await options.service.retryWebhookJob(auth, projectId, entityId));
    return;
  }
  throw new ControlPlaneError("Control plane route was not found.", 404);
}

async function sendIdempotentJson(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentCertControlPlane,
  projectId: string,
  operation: string,
  status: number,
  execute: (body: unknown) => Promise<unknown>,
  idempotencyCoordinator?: IdempotencyCoordinator,
): Promise<void> {
  const body = await readJson(request);
  const key = request.headers["idempotency-key"]?.toString().trim();
  if (!key) {
    sendJson(response, status, await execute(body));
    return;
  }
  if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new ControlPlaneError("Idempotency-Key must be 1 to 200 URL-safe characters.");
  const hash = requestHash(operation, body);
  const existing = await service.store.getIdempotency(projectId, key, operation);
  if (existing) {
    if (existing.requestHash !== hash) throw new ControlPlaneError("Idempotency-Key was already used with a different request body.", 409);
    response.setHeader("idempotency-replayed", "true");
    sendJson(response, existing.responseStatus, existing.responseBody);
    return;
  }
  const coordinator = idempotencyCoordinator ?? localIdempotency;
  const lock = await coordinator.runExclusive(`${projectId}:${operation}:${key}`, async () => {
    const raced = await service.store.getIdempotency(projectId, key, operation);
    if (raced) return { record: raced, replayed: true };
    const result = await execute(body);
    const now = new Date();
    const stored = await service.store.saveIdempotency({
      projectId, key, operation, requestHash: hash, responseStatus: status, responseBody: result,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
    return { record: stored, replayed: false };
  });
  if (!lock.acquired || !lock.value) throw new ControlPlaneError("A request with this Idempotency-Key is already in progress. Retry shortly.", 409);
  if (lock.value.record.requestHash !== hash) throw new ControlPlaneError("Idempotency-Key was already used with a different request body.", 409);
  if (lock.value.replayed) response.setHeader("idempotency-replayed", "true");
  sendJson(response, lock.value.record.responseStatus, lock.value.record.responseBody);
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

function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": "no-store", "content-length": "0" });
  response.end();
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
export function publicHttpError(error: unknown): { status: number; message: string; code: string; recovery?: string } {
  if (error instanceof ControlPlaneError) {
    return { status: error.status, message: error.message, code: error.code, recovery: error.recovery };
  }
  return { status: 500, message: "Internal server error.", code: "internal_error", recovery: "Retry once. If the error persists, provide the request ID to AgentCert support." };
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
