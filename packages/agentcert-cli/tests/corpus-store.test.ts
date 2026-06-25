import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCertCorpusRecord } from "../src/corpus.js";
import { openCorpusStore, validateCorpusTableName } from "../src/corpus-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentCert corpus stores", () => {
  it("keeps JSONL as the default corpus storage behavior", async () => {
    const dir = await tempDir();
    const path = join(dir, "corpus.jsonl");
    const store = await openCorpusStore({ jsonlPath: path });

    try {
      await store.append([record("clean", true)], { replace: true });
      await store.append([record("modal-overlay", false)]);
      const records = await store.readAll();

      expect(store.kind).toBe("jsonl");
      expect(records.map((item) => item.faultName)).toEqual(["clean", "modal-overlay"]);
    } finally {
      await store.close();
    }
  });

  it("stores corpus records in SQLite when node:sqlite is available", async () => {
    if (!hasNodeSqlite()) {
      return;
    }

    const dir = await tempDir();
    const store = await openCorpusStore({ kind: "sqlite", sqlitePath: join(dir, "agentcert.sqlite") });

    try {
      await store.append([record("clean", true), record("modal-overlay", false)], { replace: true });
      await store.append([{ ...record("clean", true), score: 95 }]);

      const records = await store.readAll();

      expect(store.kind).toBe("sqlite");
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ faultName: "modal-overlay", passed: false });
      expect(records.find((item) => item.faultName === "clean")).toMatchObject({ score: 95 });
    } finally {
      await store.close();
    }
  });

  it("rejects unsafe corpus table names before opening a database connection", async () => {
    expect(() => validateCorpusTableName("agentcert_corpus_records")).not.toThrow();
    expect(() => validateCorpusTableName("agentcert-corpus-records")).toThrow(/table name/i);
    await expect(openCorpusStore({ kind: "postgres", databaseUrl: "postgres://example", tableName: "bad;drop" })).rejects.toThrow(
      /table name/i,
    );
  });

  it("requires a Postgres database URL for Postgres storage", async () => {
    await expect(openCorpusStore({ kind: "postgres" })).rejects.toThrow(/database-url/i);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentcert-corpus-store-"));
  tempDirs.push(dir);
  return dir;
}

function hasNodeSqlite(): boolean {
  return Number(process.versions.node.split(".")[0]) >= 22;
}

function record(faultName: string, passed: boolean): AgentCertCorpusRecord {
  return {
    schemaVersion: "1",
    kind: "scenario_run",
    id: `id_${faultName}`,
    ingestedAt: "2026-01-01T00:00:00Z",
    subject: "demo-agent",
    agentName: "demo-agent",
    agentVersion: "unversioned",
    product: "tripwire-ci",
    phase: "pre-release",
    runId: `run_${faultName}`,
    timestamp: passed ? "2026-01-01T00:00:00Z" : "2026-01-01T00:00:01Z",
    score: passed ? 100 : 0,
    passed,
    scenarioName: "refund-form",
    faultName,
    evidenceCount: passed ? 0 : 1,
    highOrCriticalEvidenceCount: passed ? 0 : 1,
    failurePatterns: passed
      ? []
      : [
          {
            key: `tripwire:${faultName}:url_contains`,
            severity: "high",
            message: `${faultName} failed`,
            type: "assertion_failure",
            scenarioName: "refund-form",
            faultName,
          },
        ],
    artifacts: { result: "tripwire-result.json" },
    sourcePath: "tripwire-result.json",
  };
}
