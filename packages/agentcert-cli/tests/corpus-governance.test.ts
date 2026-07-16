import { describe, expect, it } from "vitest";
import { deleteCorpusRecords, exportGovernedCorpus, governCorpusRecords } from "../src/corpus-governance.js";
import type { AgentCertCorpusRecord } from "../src/corpus.js";

function record(): AgentCertCorpusRecord {
  return {
    schemaVersion: "1", kind: "product_run", id: "record-1", ingestedAt: "2026-07-16T00:00:00.000Z",
    subject: "customer@example.com", agentName: "Customer agent", agentVersion: "1", product: "tripwire-ci", phase: "pre-release",
    runId: "run-1", timestamp: "2026-07-16T00:00:00.000Z", score: 0, passed: false, evidenceCount: 1,
    highOrCriticalEvidenceCount: 1, failurePatterns: [], artifacts: { trace: "private/run/trace.json" },
    sourcePath: "private/run/result.json", metadata: { token: `sk-proj-${"a".repeat(16)}` },
  };
}

describe("corpus governance", () => {
  it("redacts secrets and pseudonymizes anonymous exports", () => {
    const [governed] = governCorpusRecords([record()], { consent: "anonymous", consentSource: "customer@example.com", recordedAt: "2026-07-16T01:00:00.000Z" });
    expect(governed?.subject).toMatch(/^anonymous-/);
    expect(JSON.stringify(governed)).not.toContain("sk-proj-");
    expect(JSON.stringify(governed)).not.toContain("customer@example.com");
    expect(governed?.governance?.redaction.secretScanPassed).toBe(true);
    const [exported] = exportGovernedCorpus([governed!]);
    expect(exported?.subject).toBe(governed?.subject);
    expect(exported?.governance?.provenance).toEqual(governed?.governance?.provenance);
  });

  it("keeps private and legacy records out of default exports", () => {
    const [privateRecord] = governCorpusRecords([record()], { consent: "private", consentSource: "local" });
    expect(exportGovernedCorpus([privateRecord!, record()])).toEqual([]);
  });

  it("rejects denied retention and emits non-identifying deletion tombstones", () => {
    expect(() => governCorpusRecords([record()], { consent: "denied", consentSource: "declined" })).toThrow(/no record was retained/i);
    const result = deleteCorpusRecords([record()], ["record-1"], "participant withdrawal", "2026-07-16T02:00:00.000Z");
    expect(result.retained).toEqual([]);
    expect(result.tombstones[0]).toMatchObject({ schemaVersion: "agentcert.corpus_deletion.v0.1", reason: "participant withdrawal" });
    expect(JSON.stringify(result.tombstones)).not.toContain("record-1");
  });
});
