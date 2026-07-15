import { access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ArtifactValidationResult {
  checked: number;
  missing: string[];
}

interface ArtifactPathEntry {
  path: string;
  root: string;
}

export async function validateEvidenceArtifacts(input: unknown, artifactRoot: string): Promise<ArtifactValidationResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { checked: 0, missing: [] };
  }
  const paths = collectArtifactPaths(input as Record<string, unknown>, artifactRoot);
  const uniquePaths = dedupeArtifactPathEntries(paths).filter((entry) => !looksLikeUrl(entry.path));
  const missing: string[] = [];
  for (const entry of uniquePaths) {
    const fullPath = isAbsolute(entry.path) ? entry.path : resolve(entry.root, entry.path);
    try {
      await access(fullPath);
    } catch {
      missing.push(entry.path);
    }
  }
  return { checked: uniquePaths.length, missing };
}

function collectArtifactPaths(bundle: Record<string, unknown>, artifactRoot: string): ArtifactPathEntry[] {
  const paths: ArtifactPathEntry[] = [];
  const productRoots = productArtifactRoots(bundle, artifactRoot);
  collectStringValues(bundle.artifacts, paths, artifactRoot);
  const results = Array.isArray(bundle.results) ? bundle.results : [];
  for (const result of results) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const resultRecord = result as Record<string, unknown>;
      collectStringValues(resultRecord.artifacts, paths, artifactRoot);
    }
  }
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  for (const item of evidence) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const itemRecord = item as Record<string, unknown>;
      const artifactPath = itemRecord.artifactPath;
      if (typeof artifactPath === "string" && artifactPath.length > 0) {
        const source = typeof itemRecord.source === "string" ? itemRecord.source : undefined;
        paths.push({ path: artifactPath, root: source ? (productRoots.get(source) ?? artifactRoot) : artifactRoot });
      }
    }
  }
  return paths;
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

function collectStringValues(input: unknown, paths: ArtifactPathEntry[], root: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return;
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) {
      paths.push({ path: value, root });
    }
  }
}

function dedupeArtifactPathEntries(entries: ArtifactPathEntry[]): ArtifactPathEntry[] {
  const seen = new Set<string>();
  const deduped: ArtifactPathEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.root}\0${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
