import { useEffect, useMemo, useState } from "react";
import { parseEvidenceBundle } from "./evidence-analysis";
import {
  loadHostedEvidenceDocument,
  loadHostedRunAnalysis,
  type HostedProject,
  type HostedRun,
  type HostedRunAnalysis,
  type HostedSession,
} from "./hosted-api";
import { sandboxCertificationFromBundle, type SandboxCertificationView } from "./sandbox-certifications";

export default function HostedSandboxView({ runs, project, session }: {
  runs: HostedRun[];
  project: HostedProject;
  session: HostedSession;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(() => runs.filter((run) => {
    const haystack = `${run.externalId} ${run.status} ${run.schemaVersion} ${JSON.stringify(run.metadata)}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (status === "all" || run.status === status);
  }), [query, runs, status]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = runs.find((run) => run.id === selectedId) ?? filtered[0];
  const [analysis, setAnalysis] = useState<HostedRunAnalysis>();
  const [certification, setCertification] = useState<SandboxCertificationView>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setLoading(true); setError(undefined); setCertification(undefined);
    loadHostedRunAnalysis(session, project.id, selected.id).then(async (next) => {
      const evidence = next.evidence.find((item) => item.kind === "evidence_bundle");
      const bundle = evidence ? parseEvidenceBundle(await loadHostedEvidenceDocument(session, project.id, evidence.id)) : undefined;
      if (active) { setAnalysis(next); setCertification(sandboxCertificationFromBundle(bundle)); }
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project.id, selected?.id, session]);

  if (runs.length === 0) return <section className="data-section sandbox-empty-state"><div><span className="eyebrow">Sandbox onboarding</span><h2>No sandbox certifications yet</h2><p>Generate a dependency-free adapter, certify it locally, then upload the report through your saved project connection.</p></div><pre>{`npx agentcert sandbox init\nnpx agentcert sandbox certify --adapter ./agentcert.sandbox.mjs\nnpx agentcert sandbox push --adapter ./agentcert.sandbox.mjs`}</pre></section>;

  return <div className="sandbox-certification-page">
    <section className="run-filter-bar" aria-label="Sandbox certification filters">
      <label><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Adapter, target, schema version" /></label>
      <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{unique(runs.map((run) => run.status)).map((value) => <option key={value}>{value}</option>)}</select></label>
      <div className="filter-result"><strong>{filtered.length}</strong><span>certifications</span></div>
    </section>
    <section className="sandbox-certification-layout">
      <div className="run-selector" role="listbox" aria-label="Sandbox certifications">
        {filtered.map((run) => <button key={run.id} className={run.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(run.id)}><span><strong>{text(run.metadata.implementation) || run.externalId}</strong><small>{text(run.metadata.evidenceType) || run.schemaVersion}</small></span><span><Status value={run.status} /><small>{compactTime(run.startedAt)}</small></span></button>)}
        {filtered.length === 0 ? <div className="hosted-empty">No sandbox certifications match these filters.</div> : null}
      </div>
      <div className="sandbox-certification-content">
        {error ? <div className="console-error">{error}</div> : null}
        {loading || !analysis || analysis.run.id !== selected?.id ? <div className="analysis-loading">Loading certification evidence...</div> : <CertificationDetail analysis={analysis} certification={certification} />}
      </div>
    </section>
  </div>;
}

function CertificationDetail({ analysis, certification }: { analysis: HostedRunAnalysis; certification?: SandboxCertificationView }) {
  const completeness = analysis.evidenceCompleteness;
  const checks = certification?.checks ?? [];
  const policy = certification?.egressPolicy;
  return <>
    <section className="sandbox-certification-summary">
      <div><span className="eyebrow">{policy ? "Bounded vendor sandbox egress" : "Synthetic sandbox contract"}</span><h2>{certification?.implementation ?? text(analysis.run.metadata.implementation) ?? analysis.run.externalId}</h2><p>{certification?.disclaimer ?? "Certification evidence is limited to synthetic or vendor test-mode behavior and does not authorize production access."}</p></div>
      <div className="sandbox-score"><strong>{Math.round(certification?.score ?? score(analysis.run.score))}</strong><span>/ 100</span><Status value={certification ? (certification.passed ? "passed" : "failed") : analysis.run.status} /></div>
      <dl><div><dt>Schema</dt><dd>{certification?.schemaVersion ?? analysis.run.schemaVersion}</dd></div><div><dt>Evidence</dt><dd>{completeness.status}</dd></div><div><dt>Manifest</dt><dd>{completeness.reconciliation.legacy ? "legacy" : `${completeness.reconciliation.matched}/${completeness.reconciliation.declared} matched`}</dd></div><div><dt>Retention</dt><dd>{completeness.legalHoldActive ? "legal hold" : `${completeness.retentionDays} days`}</dd></div></dl>
    </section>
    <section className="data-section sandbox-checks"><div className="section-title"><h2>Certification controls</h2><p>{policy ? "Allowlist, sandbox response, and evidence redaction controls" : "Adapter contract and active synthetic sandbox safety controls"}</p></div><div className="sandbox-check-list">{checks.map((check) => <article key={`${check.layer}-${check.id}`}><Status value={check.status} /><div><strong>{check.id.replace(/-/g, " ")}</strong><p>{check.message}</p></div><span>{check.layer}</span></article>)}{checks.length === 0 ? <div className="hosted-empty">The run was retained, but its certification report could not be parsed.</div> : null}</div></section>
    {policy ? <section className="data-section sandbox-egress-policy"><div className="section-title"><h2>Bounded egress policy</h2><p>Effective vendor sandbox boundary and retained request outcomes</p></div><dl><div><dt>Vendor</dt><dd>{policy.vendor ?? "vendor"} / {policy.environment ?? "sandbox"}</dd></div><div><dt>Origin</dt><dd>{policy.allowedOrigins.join(", ")}</dd></div><div><dt>Methods</dt><dd>{policy.allowedMethods.join(", ")}</dd></div><div><dt>Resources</dt><dd>{policy.allowedResources.join(", ")}</dd></div><div><dt>Timeout</dt><dd>{policy.timeoutMs ?? 0} ms</dd></div><div><dt>Rate cap</dt><dd>{policy.maxRequestsPerMinute ?? 0} / minute</dd></div></dl><div className="sandbox-check-list">{certification?.requestAudit.map((entry) => <article key={entry.requestId}><Status value={entry.outcome} /><div><strong>{entry.method} {entry.resource}</strong><p>{entry.status ? `HTTP ${entry.status}, ` : ""}{entry.durationMs} ms</p></div><span>request</span></article>)}</div></section> : null}
    <section className="data-section sandbox-provenance"><div className="section-title"><h2>Evidence provenance</h2><p>Server-retained report bytes and reconciliation state</p></div><dl><div><dt>Run</dt><dd>{analysis.run.id}</dd></div><div><dt>Generated</dt><dd>{compactTime(certification?.generatedAt ?? analysis.run.startedAt)}</dd></div><div><dt>Objects</dt><dd>{completeness.evidenceCount}</dd></div><div><dt>Stored bytes</dt><dd>{compactBytes(completeness.bytesUsed)}</dd></div></dl></section>
  </>;
}

function Status({ value }: { value: string }) { return <span className={`hosted-status ${value.toLowerCase().replace(/_/g, "-")}`}>{value.replace(/_/g, " ")}</span>; }
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function score(value?: number): number { if (value === undefined) return 0; return value <= 1 ? value * 100 : value; }
function compactTime(value: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function compactBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
