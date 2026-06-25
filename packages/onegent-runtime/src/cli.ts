#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { approveProcurementWalkthrough, resetProcurementWalkthrough } from "./procurement-walkthrough.js";
import { renderProcurementWalkthroughHtml, renderPurchaseOrderHtml } from "./ui.js";
import { startActionGatewayServer } from "./server.js";
import { loadPolicyConfig } from "./policy-config.js";

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
} else {
  process.stdout.write(`Usage:
  onegent-runtime procurement-demo --out .onegent/procurement [--policy onegent.policy.json]
  onegent-runtime serve --port 3310 [--policy onegent.policy.json]
`);
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
