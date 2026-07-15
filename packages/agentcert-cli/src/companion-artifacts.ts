import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  collectEvidenceArtifactPaths,
  isRemoteArtifactPath,
  type EvidenceArtifactPath,
} from "./artifact-validation.js";
import type { AgentCertBundle } from "./types.js";

export const DEFAULT_COMPANION_ARTIFACT_LIMITS = {
  maxFiles: 25,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
} as const;
export const MAX_REPORTED_COMPANION_ARTIFACT_SKIPS = 50;

export interface CompanionArtifactLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface PreparedCompanionArtifact {
  sourcePath: string;
  fileName: string;
  kind: string;
  contentType: string;
  bytes: Uint8Array;
}

export type CompanionArtifactSkipReason =
  | "remote_url"
  | "unsupported_type"
  | "missing"
  | "outside_artifact_root"
  | "symlink"
  | "not_file"
  | "file_too_large"
  | "file_limit"
  | "total_size_limit"
  | "unreadable";

export interface SkippedCompanionArtifact {
  sourcePath: string;
  reason: CompanionArtifactSkipReason;
  detail?: string;
}

export interface PreparedCompanionArtifacts {
  artifacts: PreparedCompanionArtifact[];
  skipped: SkippedCompanionArtifact[];
  totalBytes: number;
  limits: CompanionArtifactLimits;
}

export async function collectCompanionArtifacts(
  bundle: AgentCertBundle,
  artifactRoot: string,
  limits: CompanionArtifactLimits = DEFAULT_COMPANION_ARTIFACT_LIMITS,
): Promise<PreparedCompanionArtifacts> {
  validateLimits(limits);
  const root = await realpath(resolve(artifactRoot));
  const artifacts: PreparedCompanionArtifact[] = [];
  const skipped: SkippedCompanionArtifact[] = [];
  const uploadedRealPaths = new Set<string>();
  let totalBytes = 0;

  for (const entry of collectEvidenceArtifactPaths(bundle, root)) {
    if (isRemoteArtifactPath(entry.sourcePath)) {
      skipped.push(skip(entry, "remote_url"));
      continue;
    }
    const descriptor = describeArtifact(entry.sourcePath);
    if (!descriptor) {
      skipped.push(skip(entry, "unsupported_type", "accepted formats: PNG, JPEG, WebP, JSON, JSONL, HTML, PDF, ZIP"));
      continue;
    }
    if (artifacts.length >= limits.maxFiles) {
      skipped.push(skip(entry, "file_limit", `maximum ${limits.maxFiles} files`));
      continue;
    }

    const candidate = isAbsolute(entry.sourcePath)
      ? resolve(entry.sourcePath)
      : resolve(entry.root, entry.sourcePath);
    if (!isWithinRoot(root, candidate)) {
      skipped.push(skip(entry, "outside_artifact_root"));
      continue;
    }
    let candidateInfo;
    try {
      candidateInfo = await lstat(candidate);
    } catch (error) {
      skipped.push(skip(entry, errorCode(error) === "ENOENT" ? "missing" : "unreadable", errorMessage(error)));
      continue;
    }
    if (candidateInfo.isSymbolicLink()) {
      skipped.push(skip(entry, "symlink"));
      continue;
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(candidate);
    } catch (error) {
      skipped.push(skip(entry, errorCode(error) === "ENOENT" ? "missing" : "unreadable", errorMessage(error)));
      continue;
    }
    if (!isWithinRoot(root, resolvedPath)) {
      skipped.push(skip(entry, "outside_artifact_root"));
      continue;
    }
    if (uploadedRealPaths.has(resolvedPath)) continue;

    let fileInfo;
    try {
      fileInfo = await stat(resolvedPath);
    } catch (error) {
      skipped.push(skip(entry, errorCode(error) === "ENOENT" ? "missing" : "unreadable", errorMessage(error)));
      continue;
    }
    if (!fileInfo.isFile()) {
      skipped.push(skip(entry, "not_file"));
      continue;
    }
    if (fileInfo.size > limits.maxFileBytes) {
      skipped.push(skip(entry, "file_too_large", `${fileInfo.size} bytes exceeds ${limits.maxFileBytes}`));
      continue;
    }
    if (totalBytes + fileInfo.size > limits.maxTotalBytes) {
      skipped.push(skip(entry, "total_size_limit", `maximum ${limits.maxTotalBytes} bytes`));
      continue;
    }

    const remainingBytes = limits.maxTotalBytes - totalBytes;
    let readResult: BoundedReadResult;
    try {
      readResult = await readBounded(resolvedPath, Math.min(limits.maxFileBytes, remainingBytes));
    } catch (error) {
      skipped.push(skip(entry, "unreadable", errorMessage(error)));
      continue;
    }
    if (readResult.exceeded) {
      const reason = remainingBytes < limits.maxFileBytes ? "total_size_limit" : "file_too_large";
      skipped.push(skip(entry, reason));
      continue;
    }

    artifacts.push({
      sourcePath: normalizeSourcePath(entry.sourcePath),
      fileName: basename(resolvedPath),
      kind: descriptor.kind,
      contentType: descriptor.contentType,
      bytes: readResult.bytes,
    });
    uploadedRealPaths.add(resolvedPath);
    totalBytes += readResult.bytes.byteLength;
  }

  return { artifacts, skipped, totalBytes, limits: { ...limits } };
}

function validateLimits(limits: CompanionArtifactLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

interface BoundedReadResult {
  bytes: Uint8Array;
  exceeded: boolean;
}

async function readBounded(path: string, maxBytes: number): Promise<BoundedReadResult> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, null);
      if (bytesRead === 0) return { bytes: Buffer.concat(chunks, total), exceeded: false };
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return { bytes: new Uint8Array(), exceeded: true };
  } finally {
    await handle.close();
  }
}

function describeArtifact(path: string): { kind: string; contentType: string } | undefined {
  const lower = path.toLowerCase();
  const extension = extname(lower);
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const imageType = extension === ".jpg" ? "jpeg" : extension.slice(1);
    return { kind: "screenshot", contentType: `image/${imageType}` };
  }
  if (extension === ".zip") return { kind: "trace", contentType: "application/zip" };
  if ([".html", ".htm"].includes(extension)) return { kind: "dom", contentType: "text/html; charset=utf-8" };
  if (extension === ".json") return { kind: lower.includes("trace") ? "trace" : lower.includes("dom") ? "dom" : "json", contentType: "application/json" };
  if (extension === ".jsonl") return { kind: lower.includes("trace") ? "trace" : "json", contentType: "application/x-ndjson" };
  if (extension === ".pdf") return { kind: "report", contentType: "application/pdf" };
  return undefined;
}

function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").slice(0, 1024);
}

function skip(entry: EvidenceArtifactPath, reason: CompanionArtifactSkipReason, detail?: string): SkippedCompanionArtifact {
  return { sourcePath: normalizeSourcePath(entry.sourcePath), reason, ...(detail ? { detail } : {}) };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
