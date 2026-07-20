import { access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ArtifactValidationResult {
  checked: number;
  missing: string[];
}

export interface EvidenceArtifactPath {
  sourcePath: string;
  root: string;
}

export async function validateEvidenceArtifacts(input: unknown, artifactRoot: string): Promise<ArtifactValidationResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { checked: 0, missing: [] };
  }
  const uniquePaths = collectEvidenceArtifactPaths(input as Record<string, unknown>, artifactRoot)
    .filter((entry) => !isRemoteArtifactPath(entry.sourcePath));
  const missing: string[] = [];
  for (const entry of uniquePaths) {
    const fullPath = isAbsolute(entry.sourcePath) ? entry.sourcePath : resolve(entry.root, entry.sourcePath);
    try {
      await access(fullPath);
    } catch {
      missing.push(entry.sourcePath);
    }
  }
  return { checked: uniquePaths.length, missing };
}

export function collectEvidenceArtifactPaths(input: unknown, artifactRoot: string): EvidenceArtifactPath[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const bundle = input as Record<string, unknown>;
  const paths: EvidenceArtifactPath[] = [];
  const productRoots = productArtifactRoots(bundle, artifactRoot);
  collectStringValues(bundle.artifacts, paths, artifactRoot);
  const results = Array.isArray(bundle.results) ? bundle.results : [];
  for (const result of results) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const resultRecord = result as Record<string, unknown>;
      collectStringValues(resultRecord.artifacts, paths, artifactRoot);
      const product = typeof resultRecord.product === "string" ? resultRecord.product : undefined;
      collectEvidencePaths(resultRecord.evidence, paths, product ? (productRoots.get(product) ?? artifactRoot) : artifactRoot);
    }
  }
  collectEvidencePaths(bundle.evidence, paths, artifactRoot, productRoots);
  return dedupeArtifactPathEntries(paths);
}

function collectEvidencePaths(
  input: unknown,
  paths: EvidenceArtifactPath[],
  root: string,
  productRoots?: Map<string, string>,
): void {
  const evidence = Array.isArray(input) ? input : [];
  for (const item of evidence) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const itemRecord = item as Record<string, unknown>;
      const artifactPath = itemRecord.artifactPath;
      if (typeof artifactPath === "string" && artifactPath.length > 0) {
        const source = typeof itemRecord.source === "string" ? itemRecord.source : undefined;
        paths.push({ sourcePath: artifactPath, root: source && productRoots ? (productRoots.get(source) ?? root) : root });
      }
    }
  }
}

function productArtifactRoots(bundle: Record<string, unknown>, artifactRoot: string): Map<string, string> {
  const roots = new Map<string, string>();
  const results = Array.isArray(bundle.results) ? bundle.results : [];
  for (const result of results) {
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const resultRecord = result as Record<string, unknown>;
    const product = resultRecord.product;
    const artifacts = resultRecord.artifacts;
    if (typeof product !== "string" || !artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) continue;
    const artifactRecord = artifacts as Record<string, unknown>;
    const outDir = artifactRecord.outDir;
    const resultPath = artifactRecord.result ?? artifactRecord.results;
    if (typeof outDir === "string" && outDir.length > 0) {
      roots.set(product, isAbsolute(outDir) ? outDir : resolve(artifactRoot, outDir));
    } else if (typeof resultPath === "string" && resultPath.length > 0) {
      roots.set(product, dirname(isAbsolute(resultPath) ? resultPath : resolve(artifactRoot, resultPath)));
    }
  }
  return roots;
}

function collectStringValues(input: unknown, paths: EvidenceArtifactPath[], root: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return;
  }
  for (const [name, value] of Object.entries(input)) {
    if (name === "outDir") continue;
    if (typeof value === "string" && value.length > 0) {
      paths.push({ sourcePath: value, root });
    }
  }
}

function dedupeArtifactPathEntries(entries: EvidenceArtifactPath[]): EvidenceArtifactPath[] {
  const seen = new Set<string>();
  const deduped: EvidenceArtifactPath[] = [];
  for (const entry of entries) {
    const key = `${entry.root}\0${entry.sourcePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function isRemoteArtifactPath(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
