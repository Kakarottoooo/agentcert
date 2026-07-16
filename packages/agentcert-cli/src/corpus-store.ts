import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentCertCorpusRecord } from "./corpus.js";
import { appendCorpusRecords, readCorpus } from "./corpus.js";

export type CorpusStoreKind = "jsonl" | "sqlite" | "postgres";

export interface CorpusStoreOptions {
  kind?: CorpusStoreKind;
  jsonlPath?: string;
  sqlitePath?: string;
  databaseUrl?: string;
  tableName?: string;
}

export interface CorpusWriteOptions {
  replace?: boolean;
}

export interface CorpusStore {
  kind: CorpusStoreKind;
  description: string;
  append(records: AgentCertCorpusRecord[], options?: CorpusWriteOptions): Promise<void>;
  readAll(): Promise<AgentCertCorpusRecord[]>;
  close(): Promise<void>;
}

const DEFAULT_TABLE_NAME = "agentcert_corpus_records";

export async function openCorpusStore(options: CorpusStoreOptions): Promise<CorpusStore> {
  const kind = options.kind ?? "jsonl";
  if (kind === "jsonl") {
    return createJsonlCorpusStore(options.jsonlPath ?? ".agentcert/corpus/corpus.jsonl");
  }
  if (kind === "sqlite") {
    return createSqliteCorpusStore(options.sqlitePath ?? ".agentcert/corpus/agentcert.sqlite", options.tableName);
  }
  if (kind === "postgres") {
    if (!options.databaseUrl) {
      throw new Error("Postgres corpus store requires --database-url or AGENTCERT_DATABASE_URL.");
    }
    return createPostgresCorpusStore(options.databaseUrl, options.tableName);
  }
  throw new Error(`Unsupported corpus store: ${kind}`);
}

export function parseCorpusStoreKind(input: string | undefined): CorpusStoreKind {
  const value = input ?? "jsonl";
  if (value === "jsonl" || value === "sqlite" || value === "postgres") {
    return value;
  }
  throw new Error(`Unsupported corpus store "${value}". Use jsonl, sqlite, or postgres.`);
}

export function validateCorpusTableName(input: string | undefined): string {
  const tableName = input ?? DEFAULT_TABLE_NAME;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error("Corpus table name must contain only letters, numbers, and underscores, and cannot start with a number.");
  }
  return tableName;
}

function createJsonlCorpusStore(path: string): CorpusStore {
  return {
    kind: "jsonl",
    description: `JSONL corpus at ${resolve(path)}`,
    append: (records, options) => appendCorpusRecords(path, records, options?.replace ?? false),
    readAll: () => readCorpus(path),
    close: async () => {},
  };
}

async function createSqliteCorpusStore(path: string, tableNameInput?: string): Promise<CorpusStore> {
  const tableName = validateCorpusTableName(tableNameInput);
  const table = quoteIdentifier(tableName);
  const outPath = resolve(path);
  await mkdir(dirname(outPath), { recursive: true });

  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error("SQLite corpus store requires Node.js 22+ with node:sqlite available. Use --store jsonl on Node 20.");
  }

  const db = new sqlite.DatabaseSync(outPath);
  db.exec(corpusTableSql(table));
  db.exec(indexSqls(tableName, table).join(";\n"));
  const insert = db.prepare(insertSql(table));
  const select = db.prepare(`SELECT record_json FROM ${table} ORDER BY timestamp DESC, id ASC`);

  return {
    kind: "sqlite",
    description: `SQLite corpus at ${outPath}`,
    append: async (records, options) => {
      db.exec("BEGIN");
      try {
        if (options?.replace) db.exec(`DELETE FROM ${table}`);
        for (const record of records) {
          insert.run(...recordSqlValues(record, "sqlite"), JSON.stringify(record));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    readAll: async () =>
      (select.all() as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json) as AgentCertCorpusRecord),
    close: async () => {
      db.close();
    },
  };
}

async function createPostgresCorpusStore(databaseUrl: string, tableNameInput?: string): Promise<CorpusStore> {
  const tableName = validateCorpusTableName(tableNameInput);
  const table = quoteIdentifier(tableName);
  const pg = await importOptionalPg();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(corpusTableSql(table, "jsonb"));
  for (const sql of indexSqls(tableName, table)) {
    await client.query(sql);
  }

  return {
    kind: "postgres",
    description: `Postgres corpus table ${tableName}`,
    append: async (records, options) => {
      await client.query("BEGIN");
      try {
        if (options?.replace) await client.query(`DELETE FROM ${table}`);
        for (const record of records) {
          await client.query(insertSql(table, "$"), [...recordSqlValues(record, "postgres"), JSON.stringify(record)]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
    readAll: async () => {
      const result = await client.query(`SELECT record_json FROM ${table} ORDER BY timestamp DESC, id ASC`);
      return result.rows.map((row) => recordFromDatabaseJson(row.record_json));
    },
    close: async () => {
      await client.end();
    },
  };
}

function corpusTableSql(table: string, jsonType = "TEXT"): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  ingested_at TEXT NOT NULL,
  subject TEXT NOT NULL,
  product TEXT NOT NULL,
  phase TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  run_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  score REAL NOT NULL,
  scenario_name TEXT,
  fault_name TEXT,
  evidence_count INTEGER NOT NULL,
  high_or_critical_evidence_count INTEGER NOT NULL,
  failure_types TEXT NOT NULL,
  source_path TEXT NOT NULL,
  record_json ${jsonType} NOT NULL
)`;
}

function indexSqls(tableName: string, table: string): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tableName}_product_idx`)} ON ${table} (product)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tableName}_timestamp_idx`)} ON ${table} (timestamp)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tableName}_fault_idx`)} ON ${table} (fault_name)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tableName}_agent_idx`)} ON ${table} (agent_name)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tableName}_version_idx`)} ON ${table} (agent_version)`,
  ];
}

function insertSql(table: string, placeholderPrefix = "?"): string {
  const values =
    placeholderPrefix === "?"
      ? new Array(18).fill("?").join(", ")
      : new Array(18)
          .fill(undefined)
          .map((_, index) => `$${index + 1}`)
          .join(", ");
  return `
INSERT INTO ${table} (
  id,
  ingested_at,
  subject,
  product,
  phase,
  agent_name,
  agent_version,
  run_id,
  timestamp,
  passed,
  score,
  scenario_name,
  fault_name,
  evidence_count,
  high_or_critical_evidence_count,
  failure_types,
  source_path,
  record_json
) VALUES (${values})
ON CONFLICT(id) DO UPDATE SET
  ingested_at = excluded.ingested_at,
  subject = excluded.subject,
  product = excluded.product,
  phase = excluded.phase,
  agent_name = excluded.agent_name,
  agent_version = excluded.agent_version,
  run_id = excluded.run_id,
  timestamp = excluded.timestamp,
  passed = excluded.passed,
  score = excluded.score,
  scenario_name = excluded.scenario_name,
  fault_name = excluded.fault_name,
  evidence_count = excluded.evidence_count,
  high_or_critical_evidence_count = excluded.high_or_critical_evidence_count,
  failure_types = excluded.failure_types,
  source_path = excluded.source_path,
  record_json = excluded.record_json`;
}

function recordSqlValues(record: AgentCertCorpusRecord, dialect: "sqlite"): SqliteValue[];
function recordSqlValues(record: AgentCertCorpusRecord, dialect: "postgres"): PostgresValue[];
function recordSqlValues(record: AgentCertCorpusRecord, dialect: "sqlite" | "postgres"): PostgresValue[] {
  return [
    record.id,
    record.ingestedAt,
    record.subject,
    record.product,
    record.phase,
    record.agentName,
    record.agentVersion,
    record.runId,
    record.timestamp,
    dialect === "sqlite" ? Number(record.passed) : record.passed,
    record.score,
    record.scenarioName ?? null,
    record.faultName ?? null,
    record.evidenceCount,
    record.highOrCriticalEvidenceCount,
    [...new Set(record.failurePatterns.map((pattern) => pattern.type))].join(","),
    record.sourcePath,
  ];
}

type SqliteValue = string | number | null;
type PostgresValue = SqliteValue | boolean;

function quoteIdentifier(input: string): string {
  return `"${validateCorpusTableName(input)}"`;
}

function recordFromDatabaseJson(input: unknown): AgentCertCorpusRecord {
  if (typeof input === "string") {
    return JSON.parse(input) as AgentCertCorpusRecord;
  }
  return input as AgentCertCorpusRecord;
}

interface PgModule {
  Client: new (options: { connectionString: string }) => PgClient;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

async function importOptionalPg(): Promise<PgModule> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    return (await dynamicImport("pg")) as PgModule;
  } catch {
    throw new Error("Postgres corpus store requires the optional dependency 'pg'. Run npm install in packages/agentcert-cli.");
  }
}
