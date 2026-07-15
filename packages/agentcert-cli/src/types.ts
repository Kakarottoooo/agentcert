export type EvidenceSeverity = "critical" | "high" | "medium" | "low" | "info";

export type AgentCertPhase = "pre-release" | "runtime";

export const AGENTCERT_EVIDENCE_SCHEMA_VERSION = "agentcert.evidence.v0.1" as const;
export const AGENTCERT_EVIDENCE_SCHEMA_SEMVER = "0.1.0" as const;

export interface AgentCertEvidence {
  id: string;
  kind: string;
  severity: EvidenceSeverity;
  message: string;
  source?: string;
  artifactPath?: string;
  suggestedFix?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentCertResult {
  schemaVersion: "1";
  product: "mcpbench" | "tripwire-ci" | "onegent-runtime" | "agentcert-cli";
  runId: string;
  timestamp: string;
  phase: AgentCertPhase;
  score: number;
  passed: boolean;
  certLevel?: string;
  summary?: string;
  artifacts: Record<string, string>;
  evidence: AgentCertEvidence[];
}

export interface AgentCertBundle {
  schemaName: "agentcert.evidence_bundle";
  schemaVersion: typeof AGENTCERT_EVIDENCE_SCHEMA_VERSION;
  schemaSemver: typeof AGENTCERT_EVIDENCE_SCHEMA_SEMVER;
  kind: "agentcert.evidence_bundle";
  runId: string;
  generatedAt: string;
  subject: {
    name: string;
    type: "agent" | "mcp-server" | "tool" | "application" | "unknown";
  };
  verdict: {
    passed: boolean;
    score: number;
    level: string;
  };
  summary: {
    products: string[];
    criticalEvidence: number;
    highEvidence: number;
    totalEvidence: number;
  };
  results: AgentCertResult[];
  evidence: AgentCertEvidence[];
  artifacts: Record<string, string>;
  standards: Array<{
    id: string;
    name: string;
    status: "mapped" | "planned";
    note: string;
  }>;
}

export interface AgentCertConfig {
  schemaVersion: "1";
  subject: {
    name: string;
    type: AgentCertBundle["subject"]["type"];
  };
  artifacts: {
    mcpbench?: string;
    tripwire?: string;
    onegent?: string;
  };
  outputDir: string;
}
