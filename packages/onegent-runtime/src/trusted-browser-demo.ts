import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FileMandateStore, issueActionMandate } from "./mandates.js";
import { TrustedActionRecorder } from "./trusted-recorder.js";
import { createTrustedActionRuntime } from "./trusted-runtime.js";
import { generateSourceSigner, sha256 } from "./trust-crypto.js";
import { resetActionGatewayStore } from "./store.js";
import type { ControlledActionAdapter } from "./trust-types.js";
import { createControlledActionAdapter, createIndependentOutcomeProbe } from "./controlled-adapter.js";

export interface TrustedBrowserDemoResult {
  outputDirectory: string;
  auditPacketPath: string;
  journalPath: string;
  reportPath: string;
  evidenceStrength: string;
}

export async function runTrustedBrowserSubmitDemo(outputDirectory: string): Promise<TrustedBrowserDemoResult> {
  resetActionGatewayStore();
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const executionId = randomUUID();
  const runId = `browser-submit-po-4850-${executionId}`;
  const mandateId = `mandate-procurement-submit-4850-${executionId}`;
  const system = await startMockProcurementSystem();
  try {
    const signer = generateSourceSigner("browser-agent-source-v1");
    const mandateStore = await FileMandateStore.open(join(out, "mandates.jsonl"));
    const issuedAt = new Date();
    const mandate = issueActionMandate({
      mandateId,
      issuer: { id: "procurement-owner@example.test", type: "human" },
      subject: { principalId: "procurement-browser-agent", agentVersion: "demo-v1" },
      scope: {
        actionTypes: ["SUBMIT"],
        targetSystems: ["MockProcurementWeb"],
        permissions: ["MockProcurementWeb:SUBMIT"],
        businessObjectIds: ["PO-4850"],
        currencies: ["USD"],
        maxAmount: 5_000,
      },
      expectedOutcome: { purchaseOrderId: "PO-4850", status: "SUBMITTED" },
      policySha256: sha256("purchase-orders-over-1000-require-human-approval-v1"),
      validFrom: new Date(issuedAt.getTime() - 60_000).toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 3_600_000).toISOString(),
      issuedAt: issuedAt.toISOString(),
    }, signer);
    await mandateStore.put(mandate);

    const recorder = await TrustedActionRecorder.open({
      runId,
      storageDirectory: join(out, "recorder"),
      collector: { id: "procurement-browser-agent-recorder", version: "0.1.0", environment: "local-demo" },
      signer,
    });
    const adapter: ControlledActionAdapter = createControlledActionAdapter({
      name: "mock-procurement-write-gateway",
      control: {
        mode: "agentcert_gateway",
        credentials: "gateway_managed",
        bypassPrevention: "credentials_unavailable_to_agent",
        allowedActionTypes: ["SUBMIT"],
        allowedTargetSystems: ["MockProcurementWeb"],
      },
      execute: async (action) => {
        const response = await fetch(`${system.baseUrl}/api/purchase-orders/${action.businessObjectId}/submit`, {
          method: "POST",
          headers: { authorization: `Bearer ${system.gatewayCredential}`, "content-type": "application/json" },
          body: JSON.stringify({ mandateId: action.mandateId }),
        });
        if (!response.ok) throw new Error(`Mock procurement gateway returned HTTP ${response.status}.`);
        const observedState = await response.json() as Record<string, unknown>;
        return { method: "LOCAL_ADAPTER", targetSystem: action.targetSystem, observedState };
      },
    });
    const runtime = createTrustedActionRuntime({
      recorder,
      mandateStore,
      mandatePublicKeys: { [signer.keyId]: signer.publicKeyPem! },
      outcomeProbe: createIndependentOutcomeProbe({
        name: "mock-procurement-read-probe",
        independent: true,
        observe: async (action) => {
          const response = await fetch(`${system.baseUrl}/api/purchase-orders/${action.businessObjectId}`);
          if (!response.ok) throw new Error(`Independent outcome probe returned HTTP ${response.status}.`);
          return {
            observationId: "probe-po-4850-after-submit",
            observedAt: new Date().toISOString(),
            source: `GET /api/purchase-orders/${action.businessObjectId}`,
            observedState: await response.json() as Record<string, unknown>,
          };
        },
      }),
    });

    await runtime.startRun({ scenario: "browser-agent-submit", targetUrl: `${system.baseUrl}/purchase-orders/PO-4850` });
    const proposal = await readBrowserTask(`${system.baseUrl}/purchase-orders/PO-4850`);
    const review = await runtime.captureAction({
      mandateId: mandate.mandateId,
      action: {
        sourceAgentName: "ProcurementBrowserAgent",
        sourceAgentRunId: runId,
        principal: { id: "procurement-browser-agent", type: "agent", version: "demo-v1" },
        requestedPermissions: ["MockProcurementWeb:SUBMIT"],
        actionType: "SUBMIT",
        targetSystem: "MockProcurementWeb",
        targetUrl: `${system.baseUrl}/purchase-orders/PO-4850`,
        title: `Submit ${proposal.purchaseOrderId}`,
        description: `Submit purchase order for ${proposal.vendor}`,
        businessObjectType: "purchase_order",
        businessObjectId: proposal.purchaseOrderId,
        amount: proposal.amount,
        currency: "USD",
        beforeState: { purchaseOrderId: proposal.purchaseOrderId, status: "DRAFT" },
        proposedAfterState: { purchaseOrderId: proposal.purchaseOrderId, status: "SUBMITTED" },
      },
    });
    await runtime.requestApproval(review.action, "procurement-reviewer@example.test");
    await runtime.approveAction(review.action, "procurement-reviewer@example.test", "Vendor, amount, and mandate scope verified.");
    await runtime.executeAndVerify(review.action, adapter);
    const packet = await runtime.finalize(review.action);
    const auditPacketPath = join(out, "trusted-audit-packet.json");
    const reportPath = join(out, "trusted-browser-submit.html");
    await writeFile(auditPacketPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    await writeFile(reportPath, renderReport(packet.trustedActionEvidence.evidenceStrength.level, packet.trustedActionEvidence.runReceipt.receiptSha256), "utf8");
    return { outputDirectory: out, auditPacketPath, journalPath: recorder.journalPath, reportPath, evidenceStrength: packet.trustedActionEvidence.evidenceStrength.level };
  } finally {
    await system.close();
  }
}

async function readBrowserTask(url: string): Promise<{ purchaseOrderId: string; vendor: string; amount: number }> {
  const html = await fetch(url).then((response) => response.text());
  const purchaseOrderId = attribute(html, "data-purchase-order-id");
  const vendor = attribute(html, "data-vendor");
  const amount = Number(attribute(html, "data-amount"));
  if (!purchaseOrderId || !vendor || !Number.isFinite(amount)) throw new Error("Browser task page did not expose a complete purchase-order intent.");
  return { purchaseOrderId, vendor, amount };
}

async function startMockProcurementSystem(): Promise<{ baseUrl: string; gatewayCredential: string; close(): Promise<void> }> {
  const gatewayCredential = `local-demo-${randomUUID()}`;
  let purchaseOrder = { purchaseOrderId: "PO-4850", vendor: "Acme Industrial Supply", amount: 4_850, currency: "USD", status: "DRAFT" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/purchase-orders/PO-4850") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><main data-purchase-order-id="PO-4850" data-vendor="Acme Industrial Supply" data-amount="4850"><h1>PO-4850</h1><p>Acme Industrial Supply - $4,850.00</p><button>Submit purchase order</button></main>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/purchase-orders/PO-4850") return json(response, 200, purchaseOrder);
    if (request.method === "POST" && url.pathname === "/api/purchase-orders/PO-4850/submit") {
      if (request.headers.authorization !== `Bearer ${gatewayCredential}`) return json(response, 403, { error: "gateway credential required" });
      purchaseOrder = { ...purchaseOrder, status: "SUBMITTED" };
      return json(response, 200, purchaseOrder);
    }
    json(response, 404, { error: "not found" });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock procurement system did not bind a TCP port.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, gatewayCredential, close: () => close(server) };
}

function attribute(html: string, name: string): string {
  return html.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? "";
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolvePromise));
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

function renderReport(level: string, receiptSha256: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Trusted browser action</title><style>body{font:16px/1.5 system-ui;max-width:780px;margin:48px auto;padding:0 20px;color:#10231d}section{border:1px solid #d7e0dc;padding:24px}dt{color:#51635c}dd{margin:0 0 16px;font-weight:700;overflow-wrap:anywhere}</style><main><p>AgentCert Action Assurance Protocol v0.1</p><h1>Purchase order submission verified</h1><section><dl><dt>Action</dt><dd>SUBMIT PO-4850 to Acme Industrial Supply</dd><dt>Mandate</dt><dd>Verified, maximum USD 5,000</dd><dt>Execution boundary</dt><dd>Gateway-managed credential unavailable to agent</dd><dt>Independent outcome</dt><dd>DRAFT -&gt; SUBMITTED</dd><dt>Evidence strength</dt><dd>${level}</dd><dt>Source receipt</dt><dd>${receiptSha256}</dd></dl></section></main></html>`;
}
