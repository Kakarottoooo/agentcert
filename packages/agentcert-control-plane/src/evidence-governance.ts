import { extname } from "node:path";
import type {
  EventRecord,
  EvidenceCompleteness,
  EvidenceRecord,
  RunRecord,
} from "./types.js";

export const DEFAULT_EVIDENCE_GOVERNANCE_POLICY: EvidenceGovernancePolicy = {
  projectLimitBytes: 1024 * 1024 * 1024,
  runLimitBytes: 100 * 1024 * 1024,
  retentionDays: 90,
};

export const ACCEPTED_EVIDENCE_FORMATS = ["PNG", "JPEG", "WebP", "JSON", "JSONL", "HTML", "PDF", "ZIP"] as const;
export const ACCEPTED_EVIDENCE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/json",
  "application/x-ndjson",
  "text/html",
  "application/pdf",
  "application/zip",
] as const;

export interface EvidenceGovernancePolicy {
  projectLimitBytes: number;
  runLimitBytes: number;
  retentionDays: number;
}

export interface ValidatedEvidenceUpload {
  contentType: string;
  format: typeof ACCEPTED_EVIDENCE_FORMATS[number];
  artifactReferenceCount?: number;
}

export class EvidenceUploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceUploadValidationError";
  }
}

const FORMAT_BY_EXTENSION = new Map<string, ValidatedEvidenceUpload>([
  [".png", { format: "PNG", contentType: "image/png" }],
  [".jpg", { format: "JPEG", contentType: "image/jpeg" }],
  [".jpeg", { format: "JPEG", contentType: "image/jpeg" }],
  [".webp", { format: "WebP", contentType: "image/webp" }],
  [".json", { format: "JSON", contentType: "application/json" }],
  [".jsonl", { format: "JSONL", contentType: "application/x-ndjson" }],
  [".html", { format: "HTML", contentType: "text/html" }],
  [".htm", { format: "HTML", contentType: "text/html" }],
  [".pdf", { format: "PDF", contentType: "application/pdf" }],
  [".zip", { format: "ZIP", contentType: "application/zip" }],
]);

const FORMATS_BY_KIND = new Map<string, ReadonlySet<string>>([
  ["evidence_bundle", new Set(["JSON"])],
  ["screenshot", new Set(["PNG", "JPEG", "WebP"])],
  ["trace", new Set(["JSON", "JSONL", "ZIP"])],
  ["dom", new Set(["HTML", "JSON"])],
  ["json", new Set(["JSON", "JSONL"])],
  ["report", new Set(["HTML", "PDF", "JSON"])],
  ["artifact", new Set(ACCEPTED_EVIDENCE_FORMATS)],
]);

export function validateEvidenceUpload(
  bytes: Buffer,
  input: { fileName: string; contentType: string; kind: string },
): ValidatedEvidenceUpload {
  if (isExecutable(bytes)) throw new EvidenceUploadValidationError("Executable files are not accepted as evidence.");
  const descriptor = FORMAT_BY_EXTENSION.get(extname(input.fileName).toLowerCase());
  if (!descriptor) {
    throw new EvidenceUploadValidationError(`Unsupported evidence format. Accepted formats: ${ACCEPTED_EVIDENCE_FORMATS.join(", ")}.`);
  }
  const suppliedContentType = input.contentType.split(";", 1)[0]?.trim().toLowerCase();
  const compatibleContentTypes = descriptor.format === "JSONL"
    ? new Set(["application/x-ndjson", "application/json"])
    : descriptor.format === "ZIP"
      ? new Set(["application/zip", "application/x-zip-compressed"])
      : new Set([descriptor.contentType]);
  if (!suppliedContentType || !compatibleContentTypes.has(suppliedContentType)) {
    throw new EvidenceUploadValidationError(`${input.fileName} must use ${[...compatibleContentTypes].join(" or ")}.`);
  }
  const allowedFormats = FORMATS_BY_KIND.get(input.kind);
  if (!allowedFormats || !allowedFormats.has(descriptor.format)) {
    throw new EvidenceUploadValidationError(`Evidence kind ${input.kind} does not accept ${descriptor.format} files.`);
  }

  const parsedJson = validateContent(bytes, descriptor.format);
  return {
    ...descriptor,
    ...(input.kind === "evidence_bundle" ? { artifactReferenceCount: countArtifactReferences(parsedJson) } : {}),
  };
}

export function calculateEvidenceCompleteness(
  run: RunRecord,
  events: EventRecord[],
  evidence: EvidenceRecord[],
  policy: EvidenceGovernancePolicy,
): EvidenceCompleteness {
  const bytesUsed = evidence.reduce((total, item) => total + item.sizeBytes, 0);
  const base = {
    evidenceCount: evidence.length,
    bytesUsed,
    runLimitBytes: policy.runLimitBytes,
    remainingBytes: Math.max(0, policy.runLimitBytes - bytesUsed),
    retentionDays: policy.retentionDays,
    expiresAt: earliestExpiry(evidence, policy.retentionDays),
  };
  const acceptedAt = timestamp(run.metadata.lastEvidenceAcceptedAt);
  const rejectedAt = timestamp(run.metadata.lastEvidenceRejectedAt);
  if (rejectedAt > 0 && rejectedAt >= acceptedAt) {
    return {
      ...base,
      status: "rejected",
      reasons: [typeof run.metadata.lastEvidenceRejectionReason === "string"
        ? run.metadata.lastEvidenceRejectionReason
        : "The latest evidence upload was rejected by server policy."],
    };
  }

  const bundle = evidence.find((item) => item.kind === "evidence_bundle");
  if (!bundle) return { ...base, status: "partial", reasons: ["No evidence bundle has been uploaded for this run."] };
  const processed = [...events].reverse().find((item) => item.type === "agentcert.companion_artifacts.processed");
  const skippedCount = numeric(processed?.payload.skippedCount);
  if (processed && skippedCount > 0) {
    return { ...base, status: "partial", reasons: [`${skippedCount} referenced companion artifact(s) were skipped.`] };
  }
  const expected = numeric(bundle.metadata.artifactReferenceCount);
  const uploadedSources = new Set(evidence
    .filter((item) => item.kind !== "evidence_bundle")
    .map((item) => item.metadata.sourcePath)
    .filter((value): value is string => typeof value === "string"));
  if (expected > uploadedSources.size) {
    return {
      ...base,
      status: "partial",
      reasons: [`The bundle references ${expected} artifact(s), but only ${uploadedSources.size} companion source path(s) are hosted.`],
    };
  }
  return { ...base, status: "complete", reasons: [] };
}

function validateContent(bytes: Buffer, format: typeof ACCEPTED_EVIDENCE_FORMATS[number]): unknown {
  if (format === "PNG" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalidContent(format);
  if (format === "JPEG" && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) invalidContent(format);
  if (format === "WebP" && !(bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")) invalidContent(format);
  if (format === "PDF" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") invalidContent(format);
  if (format === "ZIP" && !isZip(bytes)) invalidContent(format);
  if (format === "HTML") {
    const text = decodeUtf8(bytes, format);
    if (text.includes("\0") || !text.trimStart().startsWith("<")) invalidContent(format);
  }
  if (format === "JSON") {
    try { return JSON.parse(decodeUtf8(bytes, format)); } catch { invalidContent(format); }
  }
  if (format === "JSONL") {
    const lines = decodeUtf8(bytes, format).split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) invalidContent(format);
    try { for (const line of lines) JSON.parse(line); } catch { invalidContent(format); }
    return lines;
  }
  return undefined;
}

function invalidContent(format: string): never {
  throw new EvidenceUploadValidationError(`Evidence bytes do not match the declared ${format} format.`);
}

function decodeUtf8(bytes: Buffer, format: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalidContent(format); }
}

function isExecutable(bytes: Buffer): boolean {
  const four = bytes.subarray(0, 4);
  return bytes.subarray(0, 2).toString("ascii") === "MZ"
    || four.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || four.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xce]))
    || four.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))
    || four.equals(Buffer.from([0xce, 0xfa, 0xed, 0xfe]))
    || four.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
    || four.equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
}

function isZip(bytes: Buffer): boolean {
  const signature = bytes.subarray(0, 4);
  return signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    || signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
}

function countArtifactReferences(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const bundle = value as Record<string, unknown>;
  const paths = new Set<string>();
  addRecordValues(paths, bundle.artifacts);
  for (const result of Array.isArray(bundle.results) ? bundle.results : []) {
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const record = result as Record<string, unknown>;
    addRecordValues(paths, record.artifacts);
    addEvidenceValues(paths, record.evidence);
  }
  addEvidenceValues(paths, bundle.evidence);
  return [...paths].filter((path) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)).length;
}

function addRecordValues(paths: Set<string>, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const item of Object.values(value)) if (typeof item === "string" && item) paths.add(item);
}

function addEvidenceValues(paths: Set<string>, value: unknown): void {
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const path = (item as Record<string, unknown>).artifactPath;
    if (typeof path === "string" && path) paths.add(path);
  }
}

function earliestExpiry(evidence: EvidenceRecord[], retentionDays: number): string | undefined {
  const oldest = evidence.map((item) => Date.parse(item.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return oldest === undefined ? undefined : new Date(oldest + retentionDays * 86_400_000).toISOString();
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
