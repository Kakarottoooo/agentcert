import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTrustedBrowserSubmitDemo } from "../src/trusted-browser-demo.js";

describe("trusted browser SUBMIT demo", () => {
  it("binds a mandate, uses a controlled write adapter, probes the outcome, and emits strong evidence", async () => {
    const output = await mkdtemp(join(tmpdir(), "agentcert-browser-submit-"));
    const result = await runTrustedBrowserSubmitDemo(output);
    const packetText = await readFile(result.auditPacketPath, "utf8");
    const packet = JSON.parse(packetText) as Record<string, any>;

    expect(result.evidenceStrength).toBe("outcome_verified");
    expect(packet.actionIntent).toMatchObject({ actionType: "SUBMIT", businessObjectId: "PO-4850" });
    expect(packet.actionIntent.mandateId).toMatch(/^mandate-procurement-submit-4850-/);
    expect(packet.trustedActionEvidence.runReceipt.journal).toMatchObject({ valid: true, complete: true, droppedEventCount: 0 });
    expect(packet.trustedActionEvidence.verification).toMatchObject({ success: true, verificationMethod: "INDEPENDENT_PROBE" });
    expect(packetText).not.toContain("local-demo-");
    await expect(readFile(result.journalPath, "utf8")).resolves.toContain('"type":"RUN_COMPLETED"');
  });

  it("preserves prior evidence when the demo is rerun in the same output directory", async () => {
    const output = await mkdtemp(join(tmpdir(), "agentcert-browser-submit-rerun-"));
    const first = await runTrustedBrowserSubmitDemo(output);
    const second = await runTrustedBrowserSubmitDemo(output);

    expect(second.journalPath).not.toBe(first.journalPath);
    await expect(readFile(first.journalPath, "utf8")).resolves.toContain('"type":"RUN_COMPLETED"');
    await expect(readFile(second.journalPath, "utf8")).resolves.toContain('"type":"RUN_COMPLETED"');
  });
});
