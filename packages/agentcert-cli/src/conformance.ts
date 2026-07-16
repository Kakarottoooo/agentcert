import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeManifestPath } from "./artifact-manifest.js";
import { validateAgentCertSchema } from "./schema-validator.js";

export interface ConformanceCheck {
  id: "schema" | "compatibility" | "manifest" | "artifact-bytes";
  status: "passed" | "failed";
  message: string;
  errors: string[];
}

export interface EvidenceConformanceReport {
  schemaVersion: "agentcert.conformance.v0.1";
  kind: "agentcert.evidence_conformance_report";
  implementation: string;
  evidenceFile: string;
  artifactRoot: string;
  generatedAt: string;
  valid: boolean;
  summary: { passed: number; failed: number };
  checks: ConformanceCheck[];
}

const SUPPORTED_TOP_LEVEL_FIELDS = new Set([
  "schemaName", "schemaVersion", "schemaSemver", "kind", "runId", "generatedAt", "subject", "verdict", "summary",
  "results", "evidence", "artifacts", "artifactManifest", "standards",
]);

export async function runEvidenceConformance(
  input: unknown,
  options: { evidenceFile: string; artifactRoot: string; implementation?: string; now?: Date },
): Promise<EvidenceConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const schema = validateAgentCertSchema("evidence-bundle", input);
  checks.push(check("schema", "Evidence bundle satisfies the AgentCert v0.1 semantic contract.", schema.errors));

  const bundle = object(input);
  const compatibilityErrors = bundle
    ? Object.keys(bundle).filter((key) => !SUPPORTED_TOP_LEVEL_FIELDS.has(key)).map((key) => `Unsupported top-level field: ${key}.`)
    : ["Evidence bundle must be an object."];
  checks.push(check("compatibility", "Evidence bundle uses only v0.1-compatible top-level fields.", compatibilityErrors));

  const manifestErrors: string[] = [];
  const entries = parseManifest(bundle?.artifactManifest, manifestErrors);
  checks.push(check("manifest", "Artifact manifest declares unique normalized paths, SHA-256, byte size, and kind.", manifestErrors));

  const byteErrors: string[] = [];
  if (manifestErrors.length === 0) {
    const root = resolve(options.artifactRoot);
    for (const entry of entries) {
      const path = resolve(root, entry.path);
      if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) {
        byteErrors.push(`${entry.path}: resolved path escapes artifact root.`);
        continue;
      }
      try {
        const bytes = await readFile(path);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== entry.sizeBytes) byteErrors.push(`${entry.path}: expected ${entry.sizeBytes} bytes, observed ${bytes.byteLength}.`);
        if (digest !== entry.sha256) byteErrors.push(`${entry.path}: SHA-256 does not match the declared digest.`);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "read_failed";
        byteErrors.push(`${entry.path}: artifact could not be read (${code}).`);
      }
    }
  } else {
    byteErrors.push("Artifact bytes were not checked because the manifest is invalid.");
  }
  checks.push(check("artifact-bytes", "Every declared artifact matches its exact runtime bytes.", byteErrors));

  const passed = checks.filter((item) => item.status === "passed").length;
  const failed = checks.length - passed;
  return {
    schemaVersion: "agentcert.conformance.v0.1",
    kind: "agentcert.evidence_conformance_report",
    implementation: options.implementation?.trim() || "third-party",
    evidenceFile: resolve(options.evidenceFile),
    artifactRoot: resolve(options.artifactRoot),
    generatedAt: (options.now ?? new Date()).toISOString(),
    valid: failed === 0,
    summary: { passed, failed },
    checks,
  };
}

function parseManifest(input: unknown, errors: string[]): Array<{ path: string; sha256: string; sizeBytes: number; kind: string }> {
  const manifest = object(input);
  if (!manifest) {
    errors.push("artifactManifest is required for conformance.");
    return [];
  }
  if (manifest.schemaVersion !== "agentcert.artifact_manifest.v0.1") errors.push("artifactManifest.schemaVersion must be agentcert.artifact_manifest.v0.1.");
  if (!Array.isArray(manifest.entries)) {
    errors.push("artifactManifest.entries must be an array.");
    return [];
  }
  if (manifest.entries.length > 500) errors.push("artifactManifest.entries cannot exceed 500 entries.");
  const paths = new Set<string>();
  const entries: Array<{ path: string; sha256: string; sizeBytes: number; kind: string }> = [];
  manifest.entries.forEach((inputEntry, index) => {
    const entry = object(inputEntry);
    if (!entry) { errors.push(`artifactManifest.entries[${index}] must be an object.`); return; }
    let path: string | undefined;
    try { path = typeof entry.path === "string" ? normalizeManifestPath(entry.path) : undefined; }
    catch (error) { errors.push(`artifactManifest.entries[${index}].path: ${(error as Error).message}`); }
    if (!path) errors.push(`artifactManifest.entries[${index}].path must be a normalized relative path.`);
    else if (paths.has(path)) errors.push(`artifactManifest contains duplicate path ${path}.`);
    else paths.add(path);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) errors.push(`artifactManifest.entries[${index}].sha256 must be 64 lowercase hex characters.`);
    if (!Number.isInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0) errors.push(`artifactManifest.entries[${index}].sizeBytes must be a non-negative integer.`);
    if (typeof entry.kind !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.kind)) errors.push(`artifactManifest.entries[${index}].kind must be a stable lowercase identifier.`);
    if (path && typeof entry.sha256 === "string" && Number.isInteger(entry.sizeBytes) && typeof entry.kind === "string") {
      entries.push({ path, sha256: entry.sha256, sizeBytes: entry.sizeBytes as number, kind: entry.kind });
    }
  });
  return entries;
}

function check(id: ConformanceCheck["id"], message: string, errors: string[]): ConformanceCheck {
  return { id, status: errors.length === 0 ? "passed" : "failed", message, errors };
}

function object(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}
