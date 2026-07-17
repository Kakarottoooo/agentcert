#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { approveProcurementWalkthrough, resetProcurementWalkthrough } from "./procurement-walkthrough.js";
import { renderProcurementWalkthroughHtml, renderPurchaseOrderHtml } from "./ui.js";
import { startActionGatewayServer } from "./server.js";
import { loadPolicyConfig } from "./policy-config.js";
import { createInMemorySandboxSystem, runSandboxCertificationSuite, writeSandboxReport } from "./sandbox-harness.js";
import { runSandboxAdapterConformanceSuite, writeSandboxAdapterConformanceReport } from "./sandbox-adapter-kit.js";
import { uploadSandboxCertificationReport, type HostedSandboxReport } from "./sandbox-hosted.js";

const command = process.argv[2] ?? "help";

if (command === "procurement-demo") {
  const outDir = resolve(readFlag("--out") ?? ".onegent/procurement");
  const policyPath = readFlag("--policy");
  const policyRules = policyPath ? await loadPolicyConfig(resolve(policyPath)) : undefined;
  await mkdir(outDir, { recursive: true });

  const before = resetProcurementWalkthrough(policyRules);
  await writeFile(`${outDir}/walkthrough-before-approval.html`, renderProcurementWalkthroughHtml(before));

  const after = approveProcurementWalkthrough();
  await writeFile(`${outDir}/walkthrough-after-approval.html`, renderProcurementWalkthroughHtml(after));
  await writeFile(`${outDir}/mock-purchase-order.html`, renderPurchaseOrderHtml(after.purchaseOrder));
  await writeFile(`${outDir}/audit-packet.json`, JSON.stringify(after.auditPacket, null, 2));

  process.stdout.write(`Wrote procurement walkthrough demo to ${outDir}\n`);
  process.stdout.write(`Audit packet: ${outDir}\\audit-packet.json\n`);
} else if (command === "serve") {
  const port = Number(readFlag("--port") ?? "3310");
  const policyPath = readFlag("--policy");
  const policyRules = policyPath ? await loadPolicyConfig(resolve(policyPath)) : undefined;
  startActionGatewayServer(Number.isFinite(port) ? port : 3310, { policyRules });
} else if (command === "sandbox-certify") {
  const outDir = resolve(readFlag("--out") ?? ".onegent/sandbox-certification");
  const report = await runSandboxCertificationSuite({ implementation: readFlag("--implementation") });
  const reportPath = await writeSandboxReport(report, `${outDir}/sandbox-certification.json`);
  process.stdout.write(`Sandbox certification: ${report.verdict.passed ? "PASS" : "FAIL"} (${report.verdict.score}/100)\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
  for (const check of report.checks) process.stdout.write(`- ${check.status.toUpperCase()} ${check.id}: ${check.message}\n`);
  await uploadIfRequested(report);
  if (!report.verdict.passed) process.exitCode = 1;
} else if (command === "sandbox-conformance") {
  const outDir = resolve(readFlag("--out") ?? ".onegent/sandbox-conformance");
  const system = createInMemorySandboxSystem({ allowedTargetSystems: [readFlag("--target") ?? "SandboxCRM"] });
  const report = await runSandboxAdapterConformanceSuite({
    system,
    implementation: readFlag("--implementation") ?? "agentcert-in-memory-reference",
  });
  const reportPath = await writeSandboxAdapterConformanceReport(report, `${outDir}/sandbox-adapter-conformance.json`);
  process.stdout.write(`Sandbox adapter conformance: ${report.verdict.passed ? "PASS" : "FAIL"} (${report.verdict.score}/100)\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
  for (const check of report.checks) process.stdout.write(`- ${check.status.toUpperCase()} ${check.id}: ${check.message}\n`);
  await uploadIfRequested(report);
  if (!report.verdict.passed) process.exitCode = 1;
} else {
  process.stdout.write(`Usage:
  onegent-runtime procurement-demo --out .onegent/procurement [--policy onegent.policy.json]
  onegent-runtime sandbox-certify --out .onegent/sandbox-certification [--implementation my-sandbox] [--push]
  onegent-runtime sandbox-conformance --out .onegent/sandbox-conformance [--implementation my-adapter] [--push]
  onegent-runtime serve --port 3310 [--policy onegent.policy.json]

Hosted upload flags/env:
  --server URL       or AGENTCERT_BASE_URL
  --project ID       or AGENTCERT_PROJECT_ID
  AGENTCERT_API_KEY  required; never accepted as a command-line flag
`);
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function uploadIfRequested(report: HostedSandboxReport): Promise<void> {
  if (!process.argv.includes("--push")) return;
  const result = await uploadSandboxCertificationReport(report, {
    baseUrl: readFlag("--server") ?? process.env.AGENTCERT_BASE_URL ?? "https://agentcert.app",
    projectId: readFlag("--project") ?? process.env.AGENTCERT_PROJECT_ID ?? "",
    apiKey: process.env.AGENTCERT_API_KEY ?? "",
  });
  process.stdout.write(`Hosted run: ${String(result.run.id)}\n`);
  process.stdout.write(`Hosted evidence: ${String(result.evidence.id)}\n`);
}
