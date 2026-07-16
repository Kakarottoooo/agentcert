import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { AgentCertCorpusRecord } from "./corpus.js";

export type CorpusConsent = "private" | "anonymous" | "public" | "denied";

export interface CorpusGovernance {
  schemaVersion: "agentcert.corpus_governance.v0.1";
  consent: CorpusConsent;
  consentSource: string;
  consentRecordedAt: string;
  provenance: {
    sourcePath: string;
    sourceRecordSha256: string;
    collectedAt: string;
  };
  redaction: {
    policyVersion: "agentcert.redaction.v0.1";
    replacements: number;
    secretScanPassed: boolean;
  };
}

export interface CorpusDeletionTombstone {
  schemaVersion: "agentcert.corpus_deletion.v0.1";
  recordIdSha256: string;
  reason: string;
  deletedAt: string;
}

const SECRET_PATTERNS = [
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{16,}\b/g,
  /\brk_(?:live|test)_[A-Za-z0-9]{12,}\b/g,
  /\bnpm_[A-Za-z0-9]{16,}\b/g,
  /\bac_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function governCorpusRecords(
  records: AgentCertCorpusRecord[],
  input: { consent: CorpusConsent; consentSource: string; recordedAt?: string },
): AgentCertCorpusRecord[] {
  if (input.consent === "denied") throw new Error("Corpus consent is denied; no record was retained.");
  if (!input.consentSource.trim()) throw new Error("Corpus consent source is required.");
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  return records.map((record) => {
    const [redacted, replacements] = redactValue(structuredClone(record), input.consent === "anonymous");
    const governed = redacted as AgentCertCorpusRecord;
    if (input.consent === "anonymous") {
      const identity = pseudonym(record.subject);
      governed.subject = `anonymous-${identity}`;
      governed.agentName = `anonymous-agent-${identity}`;
      governed.sourcePath = basename(record.sourcePath.replaceAll("\\", "/"));
      governed.artifacts = Object.fromEntries(Object.entries(governed.artifacts).map(([key, value]) => [key, basename(value.replaceAll("\\", "/"))]));
    }
    governed.governance = {
      schemaVersion: "agentcert.corpus_governance.v0.1",
      consent: input.consent,
      consentSource: redactText(input.consentSource, input.consent === "anonymous")[0],
      consentRecordedAt: recordedAt,
      provenance: {
        sourcePath: input.consent === "anonymous" ? basename(record.sourcePath.replaceAll("\\", "/")) : record.sourcePath,
        sourceRecordSha256: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
        collectedAt: record.ingestedAt,
      },
      redaction: { policyVersion: "agentcert.redaction.v0.1", replacements, secretScanPassed: !containsSecret(JSON.stringify(governed)) },
    };
    if (!governed.governance.redaction.secretScanPassed) throw new Error(`Corpus record ${record.id} still contains a recognized secret after redaction.`);
    return governed;
  });
}

export function exportGovernedCorpus(records: AgentCertCorpusRecord[], allowed: CorpusConsent[] = ["public", "anonymous"]): AgentCertCorpusRecord[] {
  const allow = new Set(allowed);
  return records
    .filter((record) => record.governance && allow.has(record.governance.consent))
    .map((record) => {
      const [redacted, replacements] = redactValue(structuredClone(record), record.governance!.consent === "anonymous");
      const exported = redacted as AgentCertCorpusRecord;
      if (record.governance!.consent === "anonymous") {
        const identity = record.subject.startsWith("anonymous-") ? record.subject.slice("anonymous-".length) : pseudonym(record.subject);
        exported.subject = `anonymous-${identity}`;
        exported.agentName = `anonymous-agent-${identity}`;
        exported.sourcePath = basename(record.sourcePath.replaceAll("\\", "/"));
        exported.artifacts = Object.fromEntries(Object.entries(exported.artifacts).map(([key, value]) => [key, basename(value.replaceAll("\\", "/"))]));
      }
      exported.governance = {
        ...record.governance!,
        redaction: {
          ...record.governance!.redaction,
          replacements: record.governance!.redaction.replacements + replacements,
          secretScanPassed: !containsSecret(JSON.stringify(exported)),
        },
      };
      if (!exported.governance.redaction.secretScanPassed) throw new Error(`Corpus record ${record.id} failed the export secret scan.`);
      return exported;
    });
}

export function deleteCorpusRecords(records: AgentCertCorpusRecord[], ids: string[], reason: string, deletedAt = new Date().toISOString()): {
  retained: AgentCertCorpusRecord[];
  tombstones: CorpusDeletionTombstone[];
} {
  if (!reason.trim()) throw new Error("Corpus deletion requires a reason.");
  const requested = new Set(ids);
  const deleted = records.filter((record) => requested.has(record.id));
  return {
    retained: records.filter((record) => !requested.has(record.id)),
    tombstones: deleted.map((record) => ({
      schemaVersion: "agentcert.corpus_deletion.v0.1",
      recordIdSha256: createHash("sha256").update(record.id).digest("hex"),
      reason: redactText(reason, true)[0],
      deletedAt,
    })),
  };
}

export function parseCorpusConsent(value: string | undefined): CorpusConsent {
  const consent = value ?? "private";
  if (consent === "private" || consent === "anonymous" || consent === "public" || consent === "denied") return consent;
  throw new Error(`Unsupported corpus consent "${consent}". Use private, anonymous, public, or denied.`);
}

function redactValue(value: unknown, anonymous: boolean): [unknown, number] {
  if (typeof value === "string") return redactText(value, anonymous);
  if (Array.isArray(value)) {
    let replacements = 0;
    const output = value.map((item) => { const [next, count] = redactValue(item, anonymous); replacements += count; return next; });
    return [output, replacements];
  }
  if (value && typeof value === "object") {
    let replacements = 0;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const [next, count] = redactValue(item, anonymous); output[key] = next; replacements += count;
    }
    return [output, replacements];
  }
  return [value, 0];
}

function redactText(value: string, anonymous: boolean): [string, number] {
  let output = value;
  let replacements = 0;
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, () => { replacements += 1; return "[REDACTED_SECRET]"; });
  if (anonymous) output = output.replace(EMAIL_PATTERN, () => { replacements += 1; return "[REDACTED_EMAIL]"; });
  return [output, replacements];
}

function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(value); });
}

function pseudonym(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
