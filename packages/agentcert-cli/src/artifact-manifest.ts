import { createHash } from "node:crypto";
import type { PreparedCompanionArtifact } from "./companion-artifacts.js";
import {
  AGENTCERT_ARTIFACT_MANIFEST_VERSION,
  type AgentCertArtifactManifest,
  type AgentCertBundle,
} from "./types.js";

export function buildArtifactManifest(artifacts: PreparedCompanionArtifact[]): AgentCertArtifactManifest {
  const entries = artifacts.map((artifact) => ({
    path: normalizeManifestPath(artifact.sourcePath),
    sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
    sizeBytes: artifact.bytes.byteLength,
    kind: artifact.kind,
  })).sort((left, right) => left.path.localeCompare(right.path));

  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`Artifact manifest contains duplicate path ${entry.path}.`);
    paths.add(entry.path);
  }
  return { schemaVersion: AGENTCERT_ARTIFACT_MANIFEST_VERSION, entries };
}

export function withArtifactManifest(
  bundle: AgentCertBundle,
  artifacts: PreparedCompanionArtifact[],
): AgentCertBundle {
  return { ...bundle, artifactManifest: buildArtifactManifest(artifacts) };
}

export function serializeHostedEvidenceBundle(
  bundle: AgentCertBundle,
  artifacts: PreparedCompanionArtifact[],
): { bundle: AgentCertBundle; bytes: Uint8Array } {
  const reconciledBundle = withArtifactManifest(bundle, artifacts);
  return {
    bundle: reconciledBundle,
    bytes: new TextEncoder().encode(`${JSON.stringify(reconciledBundle, null, 2)}\n`),
  };
}

export function normalizeManifestPath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!path || path.length > 1024 || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new Error(`Artifact manifest path must be a relative path: ${value}`);
  }
  if (path.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error(`Artifact manifest path cannot contain empty or parent segments: ${value}`);
  }
  return path;
}
