import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  loadHostedEvidenceBlob,
  loadHostedEvidenceDocument,
  loadHostedRunAnalysis,
  reviewHostedFailure,
  type HostedEvidence,
  type HostedProject,
  type HostedRun,
  type HostedRunAnalysis,
  type HostedSession,
} from "./hosted-api";
import {
  FAILURE_TYPES,
  artifactPointers,
  eventMessage,
  findingsForBundle,
  firstDivergence,
  matchesUploadedArtifact,
  parseEvidenceBundle,
  type EvidenceBundleDocument,
  type EvidenceFinding,
} from "./evidence-analysis";

export default function HostedRunsView({ runs, project, session }: { runs: HostedRun[]; project: HostedProject; session: HostedSession }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(() => runs.filter((run) => {
    const haystack = `${run.externalId} ${run.kind} ${run.status} ${JSON.stringify(run.metadata)}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (kind === "all" || run.kind === kind) && (status === "all" || run.status === status);
  }), [kind, query, runs, status]);
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRun = runs.find((run) => run.id === selectedId) ?? filtered[0];
  const [analysis, setAnalysis] = useState<HostedRunAnalysis>();
  const [bundle, setBundle] = useState<EvidenceBundleDocument>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function refreshAnalysis(runId: string) {
    setLoading(true); setError(undefined); setBundle(undefined);
    try {
      const next = await loadHostedRunAnalysis(session, project.id, runId);
      setAnalysis(next);
      const bundleEvidence = next.evidence.find((item) => item.kind === "evidence_bundle");
      if (bundleEvidence) {
        const document = await loadHostedEvidenceDocument(session, project.id, bundleEvidence.id);
        setBundle(parseEvidenceBundle(document));
      }
    } catch (reason) {
      setAnalysis(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (selectedRun) void refreshAnalysis(selectedRun.id);
  }, [selectedRun?.id]);

  if (runs.length === 0) return <section className="data-section"><RunSectionTitle title="Run evidence" caption="No runs have been ingested yet." /><div className="hosted-empty">Push an evidence bundle from the CLI to begin analysis.</div></section>;
  const findings = findingsForBundle(bundle, analysis?.reviews ?? []);
  const pointers = artifactPointers(bundle);
  const divergence = firstDivergence(analysis?.reviews ?? [], analysis?.incidents ?? [], analysis?.events ?? [], findings);

  return <div className="run-analysis-page">
    <section className="run-filter-bar" aria-label="Run filters">
      <label><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Run ID, agent, fault, version" /></label>
      <label><span>Product</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All products</option>{unique(runs.map((run) => run.kind)).map((value) => <option key={value}>{value}</option>)}</select></label>
      <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{unique(runs.map((run) => run.status)).map((value) => <option key={value}>{value}</option>)}</select></label>
      <div className="filter-result"><strong>{filtered.length}</strong><span>matching runs</span></div>
    </section>

    <section className="run-analysis-layout">
      <div className="run-selector" role="listbox" aria-label="Assurance runs">
        {filtered.map((run) => <button key={run.id} className={run.id === selectedRun?.id ? "active" : ""} onClick={() => setSelectedId(run.id)}>
          <span><strong>{run.externalId}</strong><small>{run.kind.replace(/_/g, " ")}</small></span>
          <span><RunStatus value={run.status} /><small>{compactTime(run.startedAt)}</small></span>
        </button>)}
        {filtered.length === 0 ? <div className="hosted-empty">No runs match these filters.</div> : null}
      </div>

      <div className="run-analysis-content">
        {error ? <div className="console-error">{error}</div> : null}
        {loading || !analysis || analysis.run.id !== selectedRun?.id ? <div className="analysis-loading">Loading run evidence...</div> : <>
          <RunSummary analysis={analysis} bundle={bundle} divergence={divergence} />
          <div className="analysis-grid">
            <TimelinePanel analysis={analysis} />
            <BundlePanel bundle={bundle} />
          </div>
          <TaxonomyReviewPanel
            findings={findings}
            analysis={analysis}
            pointers={pointers}
            divergence={divergence}
            onSaved={() => refreshAnalysis(analysis.run.id)}
            project={project}
            session={session}
          />
          <ArtifactPanel analysis={analysis} pointers={pointers} project={project} session={session} />
        </>}
      </div>
    </section>
  </div>;
}

function RunSummary({ analysis, bundle, divergence }: { analysis: HostedRunAnalysis; bundle?: EvidenceBundleDocument; divergence?: string }) {
  const run = analysis.run;
  const completeness = analysis.evidenceCompleteness;
  return <section className="hosted-run-summary">
    <div><span className="eyebrow">{run.kind.replace(/_/g, " ")}</span><h2>{run.externalId}</h2><p>{divergence ?? "No behavior divergence was recorded for this run."}</p>{completeness.reasons.length ? <p className="evidence-completeness-reason">{completeness.reasons.join(" ")}</p> : null}</div>
    <div className="hosted-run-statuses"><RunStatus value={run.status} /><RunStatus value={completeness.status} /></div>
    <dl>
      <div><dt>Score</dt><dd>{score(run.score ?? bundle?.verdict.score)}</dd></div>
      <div><dt>Events</dt><dd>{analysis.events.length}</dd></div>
      <div><dt>Evidence</dt><dd>{completeness.evidenceCount} · {compactBytes(completeness.bytesUsed)}</dd></div>
      <div><dt>Completeness</dt><dd>{label(completeness.status)}</dd></div>
      <div><dt>Retention</dt><dd>{completeness.expiresAt ? compactDate(completeness.expiresAt) : `${completeness.retentionDays} days`}</dd></div>
      <div><dt>Reviews</dt><dd>{analysis.reviews.length}</dd></div>
      <div><dt>Duration</dt><dd>{duration(run.startedAt, run.completedAt)}</dd></div>
    </dl>
  </section>;
}

function TimelinePanel({ analysis }: { analysis: HostedRunAnalysis }) {
  return <section className="data-section evidence-timeline-section"><RunSectionTitle title="Behavior timeline" caption={`${analysis.events.length} ordered events from the agent or runner`} />
    <div className="hosted-timeline">
      {analysis.events.map((event) => <div className={timelineClass(event.type)} key={event.id}><i /><div><header><strong>{event.type}</strong><span>#{event.sequence} · {compactTime(event.occurredAt)}</span></header><p>{eventMessage(event)}</p><small>{event.actor}</small></div></div>)}
      {analysis.events.length === 0 ? <div className="hosted-empty">No step events were uploaded for this run.</div> : null}
    </div>
  </section>;
}

function BundlePanel({ bundle }: { bundle?: EvidenceBundleDocument }) {
  return <section className="data-section bundle-inspector"><RunSectionTitle title="Evidence bundle" caption={bundle ? bundle.schemaVersion : "No valid AgentCert bundle found"} />
    {bundle ? <>
      <div className="bundle-verdict"><span>{bundle.subject.type}</span><strong>{bundle.subject.name}</strong><RunStatus value={bundle.verdict.passed ? "passed" : "failed"} /></div>
      <dl><div><dt>Products</dt><dd>{bundle.summary.products.join(", ") || "-"}</dd></div><div><dt>High / critical</dt><dd>{bundle.summary.highEvidence} / {bundle.summary.criticalEvidence}</dd></div><div><dt>Total findings</dt><dd>{bundle.summary.totalEvidence}</dd></div></dl>
      <div className="bundle-results">{bundle.results.map((result) => <div key={`${result.product}-${result.runId}`}><span><strong>{result.product}</strong><small>{result.phase}</small></span><RunStatus value={result.passed ? "passed" : "failed"} /><b>{score(result.score)}</b></div>)}</div>
    </> : <div className="hosted-empty">The run is still inspectable through events and uploaded artifacts, but its JSON is not an AgentCert evidence bundle.</div>}
  </section>;
}

function TaxonomyReviewPanel({ findings, analysis, pointers, divergence, onSaved, project, session }: {
  findings: EvidenceFinding[];
  analysis: HostedRunAnalysis;
  pointers: ReturnType<typeof artifactPointers>;
  divergence?: string;
  onSaved: () => Promise<void>;
  project: HostedProject;
  session: HostedSession;
}) {
  const [selectedPattern, setSelectedPattern] = useState<string>();
  const selected = findings.find((finding) => finding.patternKey === selectedPattern) ?? findings[0];
  return <section className="data-section hosted-taxonomy-review"><RunSectionTitle title="Failure taxonomy review" caption="Human-confirm or correct generated labels; reviews are retained in the project ledger" />
    <div className="taxonomy-workspace">
      <div className="finding-queue" role="listbox" aria-label="Failure findings">
        {findings.map((finding) => <button type="button" key={finding.patternKey} className={finding.patternKey === selected?.patternKey ? "active" : ""} onClick={() => setSelectedPattern(finding.patternKey)}>
          <span><strong>{finding.message}</strong><small>{finding.kind} · {label(finding.review?.type ?? finding.suggestedType)}</small></span>
          <RunStatus value={finding.review?.status ?? "unreviewed"} />
        </button>)}
      </div>
      {selected ? <FailureReviewEditor key={`${selected.patternKey}-${selected.review?.updatedAt ?? "new"}`} finding={selected} analysis={analysis} pointers={pointers} divergence={divergence} onSaved={onSaved} project={project} session={session} /> : null}
      {findings.length === 0 ? <div className="hosted-empty">No medium, high, or critical findings are present in this bundle.</div> : null}
    </div>
  </section>;
}

function FailureReviewEditor({ finding, analysis, pointers, divergence, onSaved, project, session }: {
  finding: EvidenceFinding;
  analysis: HostedRunAnalysis;
  pointers: ReturnType<typeof artifactPointers>;
  divergence?: string;
  onSaved: () => Promise<void>;
  project: HostedProject;
  session: HostedSession;
}) {
  const review = finding.review;
  const [type, setType] = useState(review?.type ?? finding.suggestedType);
  const [confidence, setConfidence] = useState(String(review?.confidence ?? 0.8));
  const [reason, setReason] = useState(review?.taxonomyRationale.primaryReason ?? `The recorded evidence is most consistent with ${label(finding.suggestedType)}.`);
  const [signals, setSignals] = useState((review?.taxonomyRationale.supportingSignals ?? [finding.message]).join("; "));
  const [snippet, setSnippet] = useState(review?.evidenceContext.firstDivergenceSnippet ?? divergence ?? finding.message);
  const [note, setNote] = useState(review?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const screenshot = review?.evidenceContext.screenshotPointer ?? pointers.find((pointer) => pointer.kind === "screenshot")?.path;
  const trace = review?.evidenceContext.tracePointer ?? pointers.find((pointer) => pointer.kind === "trace")?.path;

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(undefined);
    try {
      await reviewHostedFailure(session, project.id, analysis.run.id, {
        patternKey: finding.patternKey,
        suggestedType: finding.suggestedType,
        type,
        status: type === finding.suggestedType ? "confirmed" : "corrected",
        confidence: clamp(Number(confidence), 0, 1),
        note: note || undefined,
        evidenceContext: { firstDivergenceSnippet: snippet || undefined, screenshotPointer: screenshot, tracePointer: trace },
        taxonomyRationale: { primaryReason: reason, supportingSignals: splitSignals(signals), contradictingSignals: [] },
      });
      await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setSaving(false); }
  }

  return <form className={`hosted-finding-card ${review?.status ?? "unreviewed"}`} onSubmit={submit}>
    <div className="finding-heading"><div><span className="eyebrow">{finding.severity} · {finding.kind}</span><strong>{finding.message}</strong></div>{review ? <RunStatus value={review.status} /> : <RunStatus value="unreviewed" />}</div>
    <div className="review-fields">
      <label><span>Taxonomy label</span><select value={type} onChange={(event) => setType(event.target.value)}>{FAILURE_TYPES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label><span>Reviewer confidence</span><input type="number" min="0" max="1" step="0.05" value={confidence} onChange={(event) => setConfidence(event.target.value)} /></label>
      <label className="wide"><span>Why this label</span><textarea required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <label className="wide"><span>First divergence snippet</span><textarea value={snippet} onChange={(event) => setSnippet(event.target.value)} /></label>
      <label className="wide"><span>Supporting signals</span><input value={signals} onChange={(event) => setSignals(event.target.value)} placeholder="Separate signals with semicolons" /></label>
      <label className="wide"><span>Review note</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional reviewer note" /></label>
    </div>
    {review ? <p className="review-provenance">Reviewed by {review.reviewer} · {compactTime(review.updatedAt)}</p> : null}
    {error ? <div className="form-error">{error}</div> : null}
    <button className="primary-action compact" disabled={saving}>{saving ? "Saving..." : type === finding.suggestedType ? "Confirm label" : "Save correction"}</button>
  </form>;
}

function ArtifactPanel({ analysis, pointers, project, session }: { analysis: HostedRunAnalysis; pointers: ReturnType<typeof artifactPointers>; project: HostedProject; session: HostedSession }) {
  const screenshot = analysis.evidence.find((item) => item.contentType.startsWith("image/") || item.kind === "screenshot");
  return <section className="data-section hosted-artifact-section"><RunSectionTitle title="Artifacts and provenance" caption={`${label(analysis.evidenceCompleteness.status)} evidence · ${analysis.evidenceCompleteness.retentionDays}-day retention · uploaded objects are private and hash-addressed`} />
    <div className="artifact-workspace">
      <div className="hosted-artifact-preview">{screenshot ? <AuthenticatedImage evidence={screenshot} project={project} session={session} /> : <div><strong>No hosted screenshot</strong><p>Upload screenshot files as run evidence to preview them here.</p></div>}</div>
      <div className="hosted-artifact-list">
        {analysis.evidence.map((item) => <article key={item.id}><span><strong>{item.fileName}</strong><small>{item.kind} · {compactBytes(item.sizeBytes)}</small><code>{item.sha256.slice(0, 18)}...</code></span><button onClick={() => void downloadArtifact(item, project, session)}>Download</button></article>)}
        {pointers.filter((pointer) => !matchesUploadedArtifact(pointer.path, analysis.evidence)).map((pointer) => <article className="pointer-only" key={pointer.path}><span><strong>{pointer.label}</strong><small>{pointer.kind} · pointer only</small><code>{pointer.path}</code></span><em>Not uploaded</em></article>)}
      </div>
    </div>
  </section>;
}

function AuthenticatedImage({ evidence, project, session }: { evidence: HostedEvidence; project: HostedProject; session: HostedSession }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let objectUrl: string | undefined;
    loadHostedEvidenceBlob(session, project.id, evidence.id).then((blob) => { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }).catch(() => setError(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [evidence.id, project.id, session]);
  if (error) return <div><strong>Screenshot unavailable</strong><p>The evidence object could not be loaded.</p></div>;
  return url ? <img src={url} alt={`Evidence ${evidence.fileName}`} /> : <div>Loading screenshot...</div>;
}

async function downloadArtifact(evidence: HostedEvidence, project: HostedProject, session: HostedSession) {
  const blob = await loadHostedEvidenceBlob(session, project.id, evidence.id);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = evidence.fileName; link.click(); URL.revokeObjectURL(url);
}

function RunSectionTitle({ title, caption }: { title: string; caption: string }) { return <div className="section-title"><h2>{title}</h2><p>{caption}</p></div>; }
function RunStatus({ value }: { value: string }) { return <span className={`hosted-status ${value.toLowerCase().replace(/_/g, "-")}`}>{value.replace(/_/g, " ")}</span>; }
function timelineClass(type: string): string {
  if (/fail|error|diverg|inject/i.test(type)) return "failure";
  if (/network|http|request/i.test(type)) return "network";
  if (/page|dom|screen/i.test(type)) return "page";
  return "action";
}
function splitSignals(value: string): string[] { return value.split(";").map((item) => item.trim()).filter(Boolean); }
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function label(value: string): string { return value.replace(/_/g, " "); }
function clamp(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }
function compactTime(value: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function compactDate(value: string): string { return new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value)); }
function compactBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function score(value?: number): string { if (value === undefined) return "-"; return `${Math.round(value <= 1 ? value * 100 : value)}%`; }
function duration(start: string, end?: string): string { if (!end) return "In progress"; const ms = Math.max(0, Date.parse(end) - Date.parse(start)); return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`; }
