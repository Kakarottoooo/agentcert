import { useEffect, useMemo, useState } from "react";
import { compactBytes, compactDate, compactDuration, loadMonitorSnapshot, loadRunDetail, percent, submitFailureReview } from "./data";
import type { EvidenceArtifact, EvidenceTimelineItem, FailurePattern, LifecycleGate, MonitorRun, MonitorSnapshot, RunDetail, SummaryBucket } from "./types";

type View = "overview" | "runs" | "patterns";
type FilterState = {
  agent: string;
  fault: string;
  version: string;
  failureType: string;
};

const ALL = "__all__";
const FAILURE_TYPES = [
  "prompt_injection",
  "wrong_click",
  "timeout",
  "verification_gap",
  "silent_partial_success",
  "network_failure",
  "ui_drift",
  "policy_or_approval",
  "agent_connection",
  "console_error",
  "assertion_failure",
  "unknown_failure",
];

export default function App() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>();
  const [source, setSource] = useState<"api" | "static">("static");
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>("overview");
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [runDetail, setRunDetail] = useState<RunDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const [filters, setFilters] = useState<FilterState>({
    agent: ALL,
    fault: ALL,
    version: ALL,
    failureType: ALL,
  });

  useEffect(() => {
    loadMonitorSnapshot()
      .then((result) => {
        setSnapshot(result.snapshot);
        setSource(result.source);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const filteredRuns = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.recentRuns.filter((run) => runMatchesFilters(run, filters));
  }, [filters, snapshot]);

  const selectedRun = useMemo(() => {
    if (!snapshot) return undefined;
    return filteredRuns.find((run) => run.id === selectedRunId) ?? filteredRuns[0];
  }, [filteredRuns, selectedRunId, snapshot]);

  useEffect(() => {
    if (!selectedRun || source !== "api") {
      setRunDetail(undefined);
      return;
    }
    setDetailLoading(true);
    loadRunDetail(selectedRun.id)
      .then(setRunDetail)
      .finally(() => setDetailLoading(false));
  }, [selectedRun, source]);

  async function handleFailureReview(input: {
    runId: string;
    patternKey: string;
    type: string;
    status: "confirmed" | "corrected";
    note?: string;
  }): Promise<void> {
    if (source !== "api") return;
    setReviewSaving(true);
    setReviewError(undefined);
    try {
      const nextDetail = await submitFailureReview(input.runId, {
        patternKey: input.patternKey,
        type: input.type,
        status: input.status,
        reviewer: "local-reviewer",
        note: input.note,
      });
      setRunDetail(nextDetail);
      const refreshed = await loadMonitorSnapshot();
      setSnapshot(refreshed.snapshot);
      setSource(refreshed.source);
    } catch (err: unknown) {
      setReviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewSaving(false);
    }
  }

  if (error) {
    return <ErrorState message={error} />;
  }

  if (!snapshot) {
    return <div className="loading">Loading AgentCert Monitor...</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="AgentCert navigation">
        <a className="brand" href="https://github.com/Kakarottoooo/agentcert">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 2.5 20 6v5.6c0 5.1-3.3 8.8-8 10-4.7-1.2-8-4.9-8-10V6l8-3.5Z" />
              <path d="m8.3 12 2.3 2.3 5.1-5.2" />
            </svg>
          </span>
          <span>AgentCert</span>
        </a>

        <nav>
          <button className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>
            Overview
          </button>
          <button className={view === "runs" ? "active" : ""} onClick={() => setView("runs")}>
            Runs
          </button>
          <button className={view === "patterns" ? "active" : ""} onClick={() => setView("patterns")}>
            Patterns
          </button>
        </nav>

        <div className="sidebar-note">
          <strong>Data source</strong>
          <span>{source === "api" ? "Live local server API." : "Static monitor snapshot."}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="page-header">
          <div>
            <h1>AgentCert Monitor</h1>
            <p>{snapshot.subject}</p>
          </div>
          <div className="header-actions">
            <span className={`source-badge ${source}`}>{source === "api" ? "Local server" : "Static demo"}</span>
            {snapshot.links.detailUrl ? <a href={snapshot.links.detailUrl}>Open evidence detail</a> : null}
            <a href="https://github.com/Kakarottoooo/agentcert">GitHub</a>
          </div>
        </header>

        <section className="lifecycle-grid" aria-label="Lifecycle gates">
          {snapshot.lifecycle.map((gate) => (
            <LifecycleCard key={gate.id} gate={gate} />
          ))}
        </section>

        <FilterBar snapshot={snapshot} filters={filters} onChange={setFilters} filteredCount={filteredRuns.length} />

        {view === "overview" ? (
          <Overview
            snapshot={snapshot}
            runs={filteredRuns}
            selectedRun={selectedRun}
            runDetail={runDetail}
            source={source}
            reviewSaving={reviewSaving}
            reviewError={reviewError}
            onSelectRun={setSelectedRunId}
            onReview={handleFailureReview}
          />
        ) : null}
        {view === "runs" ? (
          <RunsView
            snapshot={snapshot}
            runs={filteredRuns}
            selectedRun={selectedRun}
            runDetail={runDetail}
            detailLoading={detailLoading}
            source={source}
            onSelectRun={setSelectedRunId}
            reviewSaving={reviewSaving}
            reviewError={reviewError}
            onReview={handleFailureReview}
          />
        ) : null}
        {view === "patterns" ? <PatternsView snapshot={snapshot} /> : null}
      </main>
    </div>
  );
}

function Overview({
  snapshot,
  runs,
  selectedRun,
  runDetail,
  source,
  reviewSaving,
  reviewError,
  onSelectRun,
  onReview,
}: {
  snapshot: MonitorSnapshot;
  runs: MonitorRun[];
  selectedRun?: MonitorRun;
  runDetail?: RunDetail;
  source: "api" | "static";
  reviewSaving: boolean;
  reviewError?: string;
  onSelectRun: (id: string) => void;
  onReview: (input: { runId: string; patternKey: string; type: string; status: "confirmed" | "corrected"; note?: string }) => Promise<void>;
}) {
  return (
    <div className="dashboard-grid">
      <section className="metrics-panel">
        <Metric label="Corpus records" value={String(snapshot.summary.totalRecords)} detail="Accumulated evidence rows" />
        <Metric label="Pass rate" value={percent(snapshot.summary.passRate)} detail={`${snapshot.summary.failedRecords} failed records`} />
        <Metric label="Failure patterns" value={String(snapshot.failurePatterns.length)} detail="Top grouped failures" />
        <Metric
          label="Taxonomy reviewed"
          value={`${snapshot.summary.taxonomy.reviewedFailurePatterns}/${snapshot.summary.taxonomy.totalFailurePatterns}`}
          detail={`${snapshot.summary.taxonomy.correctedFailurePatterns} corrected labels`}
        />
        <Metric label="Last generated" value={compactDate(snapshot.generatedAt)} detail="Monitor snapshot timestamp" />
      </section>

      <section className="wide-panel">
        <PanelHeader title="Product Coverage" action="Lifecycle evidence" />
        <div className="bucket-grid">
          {snapshot.summary.byProduct.map((bucket) => (
            <Bucket key={bucket.key} bucket={bucket} />
          ))}
          {snapshot.summary.byProduct.length === 0 ? <EmptyLine text="No product records yet." /> : null}
        </div>
      </section>

      <section className="panel">
        <PanelHeader title="Top Failure Pattern" action="Corpus" />
        {snapshot.failurePatterns[0] ? (
          <div className="failure-spotlight">
            <strong>{snapshot.failurePatterns[0].key}</strong>
            <span>{snapshot.failurePatterns[0].message}</span>
            <em>{snapshot.failurePatterns[0].count} occurrence</em>
          </div>
        ) : (
          <EmptyLine text="No failure patterns yet." />
        )}
      </section>

      <section className="wide-panel">
        <PanelHeader title="Recent Runs" action={`${runs.length} matching records`} />
        <RunTable runs={runs.slice(0, 8)} selectedRun={selectedRun} onSelectRun={onSelectRun} />
      </section>

      <RunInspector run={selectedRun} detailUrl={snapshot.links.detailUrl} />

      <EvidencePreview run={selectedRun} detail={runDetail} source={source} />
      <TaxonomyReviewPanel run={selectedRun} detail={runDetail} source={source} saving={reviewSaving} error={reviewError} onReview={onReview} />
    </div>
  );
}

function RunsView({
  snapshot,
  runs,
  selectedRun,
  runDetail,
  detailLoading,
  source,
  onSelectRun,
  reviewSaving,
  reviewError,
  onReview,
}: {
  snapshot: MonitorSnapshot;
  runs: MonitorRun[];
  selectedRun?: MonitorRun;
  runDetail?: RunDetail;
  detailLoading: boolean;
  source: "api" | "static";
  onSelectRun: (id: string) => void;
  reviewSaving: boolean;
  reviewError?: string;
  onReview: (input: { runId: string; patternKey: string; type: string; status: "confirmed" | "corrected"; note?: string }) => Promise<void>;
}) {
  return (
    <div className="evidence-grid">
      <section className="wide-panel">
        <PanelHeader title="All Recent Runs" action={`${runs.length}/${snapshot.recentRuns.length} records shown`} />
        <RunTable runs={runs} selectedRun={selectedRun} onSelectRun={onSelectRun} />
      </section>
      <EvidenceTimelinePanel run={selectedRun} detail={runDetail} loading={detailLoading} source={source} />
      <TaxonomyReviewPanel run={selectedRun} detail={runDetail} source={source} saving={reviewSaving} error={reviewError} onReview={onReview} />
      <ArtifactPanel run={selectedRun} detail={runDetail} detailUrl={snapshot.links.detailUrl} source={source} />
    </div>
  );
}

function PatternsView({ snapshot }: { snapshot: MonitorSnapshot }) {
  return (
    <div className="dashboard-grid two-column">
      <section className="wide-panel">
        <PanelHeader title="Failure Pattern Library" action="Generated from corpus" />
        <div className="pattern-list">
          {snapshot.failurePatterns.map((pattern) => (
            <div className="pattern-row" key={pattern.key}>
              <div>
                <strong>{pattern.key}</strong>
                <span>{pattern.message}</span>
              </div>
              <em>{pattern.count}</em>
            </div>
          ))}
          {snapshot.failurePatterns.length === 0 ? <EmptyLine text="No failure patterns yet." /> : null}
        </div>
      </section>

      <section className="panel">
        <PanelHeader title="Fault Breakdown" action="Tripwire slice" />
        <div className="bucket-list">
          {snapshot.summary.byFault.map((bucket) => (
            <Bucket key={bucket.key} bucket={bucket} />
          ))}
        </div>
      </section>
    </div>
  );
}

function LifecycleCard({ gate }: { gate: LifecycleGate }) {
  return (
    <section className={`lifecycle-card ${gate.status}`}>
      <div className="phase">{gate.phase}</div>
      <div className="gate-title">
        <strong>{gate.name}</strong>
        <span>{gate.status}</span>
      </div>
      <p>{gate.description}</p>
      <div className="gate-metrics">
        <span>{gate.recordCount} records</span>
        <span>{gate.recordCount === 0 ? "-" : percent(gate.passRate)}</span>
      </div>
    </section>
  );
}

function FilterBar({
  snapshot,
  filters,
  filteredCount,
  onChange,
}: {
  snapshot: MonitorSnapshot;
  filters: FilterState;
  filteredCount: number;
  onChange: (filters: FilterState) => void;
}) {
  return (
    <section className="filter-bar" aria-label="Corpus filters">
      <FilterSelect
        label="Agent"
        value={filters.agent}
        options={snapshot.filters.agents}
        onChange={(agent) => onChange({ ...filters, agent })}
      />
      <FilterSelect
        label="Fault"
        value={filters.fault}
        options={snapshot.filters.faults}
        onChange={(fault) => onChange({ ...filters, fault })}
      />
      <FilterSelect
        label="Version"
        value={filters.version}
        options={snapshot.filters.versions}
        onChange={(version) => onChange({ ...filters, version })}
      />
      <FilterSelect
        label="Failure type"
        value={filters.failureType}
        options={snapshot.filters.failureTypes}
        onChange={(failureType) => onChange({ ...filters, failureType })}
      />
      <div className="filter-count">
        <strong>{filteredCount}</strong>
        <span>matching runs</span>
      </div>
    </section>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="filter-control">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={ALL}>All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {formatFilterValue(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}

function PanelHeader({ title, action }: { title: string; action: string }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      <span>{action}</span>
    </div>
  );
}

function Bucket({ bucket }: { bucket: SummaryBucket }) {
  return (
    <div className="bucket">
      <div>
        <strong>{bucket.key}</strong>
        <span>
          {bucket.passed}/{bucket.total} passed
        </span>
      </div>
      <div className="mini-bar" aria-label={`${bucket.key} pass rate ${percent(bucket.passRate)}`}>
        <i style={{ width: `${bucket.passRate * 100}%` }} />
      </div>
    </div>
  );
}

function RunTable({
  runs,
  selectedRun,
  onSelectRun,
}: {
  runs: MonitorRun[];
  selectedRun?: MonitorRun;
  onSelectRun: (id: string) => void;
}) {
  return (
    <div className="run-table" role="table">
      <div className="run-head" role="row">
        <span>Product</span>
        <span>Fault</span>
        <span>Status</span>
        <span>Evidence</span>
        <span>Time</span>
      </div>
      {runs.map((run) => (
        <button
          key={run.id}
          className={`run-row ${selectedRun?.id === run.id ? "selected" : ""}`}
          role="row"
          onClick={() => onSelectRun(run.id)}
        >
          <span>
            <strong>{run.agentName}</strong>
            <small>
              {run.product} | {run.agentVersion}
            </small>
          </span>
          <span>
            <strong>{run.faultName ?? "product-run"}</strong>
            <small>{run.failureTypes.length > 0 ? run.failureTypes.map(formatFilterValue).join(", ") : (run.scenarioName ?? run.subject)}</small>
            {run.taxonomyReviewStatus !== "none" ? <small>{formatFilterValue(run.taxonomyReviewStatus)}</small> : null}
          </span>
          <Status passed={run.passed} />
          <span>{run.evidenceCount}</span>
          <span>{compactDuration(run.durationMs)}</span>
        </button>
      ))}
      {runs.length === 0 ? <EmptyLine text="No runs match the active filters." /> : null}
    </div>
  );
}

function RunInspector({ run, detailUrl }: { run?: MonitorRun; detailUrl?: string }) {
  return (
    <section className="panel inspector">
      <PanelHeader title="Run Inspector" action={run ? compactDate(run.timestamp) : "No selection"} />
      {run ? (
        <>
          <div className="inspector-status">
            <Status passed={run.passed} />
            <strong>{run.faultName ?? run.product}</strong>
          </div>
          <dl>
            <div>
              <dt>Agent</dt>
              <dd>{run.agentName}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{run.agentVersion}</dd>
            </div>
            <div>
              <dt>Product</dt>
              <dd>{run.product}</dd>
            </div>
            <div>
              <dt>Scenario</dt>
              <dd>{run.scenarioName ?? "-"}</dd>
            </div>
            <div>
              <dt>Score</dt>
              <dd>{run.score}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{run.evidenceCount}</dd>
            </div>
          </dl>
          <div className="failure-message">
            <span>Primary failure</span>
            <p>{run.primaryFailure ?? "No failure recorded for this run."}</p>
          </div>
          {run.taxonomyReviewStatus !== "none" ? (
            <div className={`taxonomy-state ${run.taxonomyReviewStatus}`}>
              <span>Taxonomy</span>
              <p>
                {run.reviewedFailureCount}/{run.failurePatterns.length} reviewed, {run.unreviewedFailureCount} open
              </p>
            </div>
          ) : null}
          <div className="inspector-links">
            {detailUrl ? <a href={detailUrl}>Evidence detail</a> : null}
            {run.artifacts.result ? <span>{run.artifacts.result}</span> : null}
          </div>
        </>
      ) : (
        <EmptyLine text="Select a run to inspect evidence." />
      )}
    </section>
  );
}

function runMatchesFilters(run: MonitorRun, filters: FilterState): boolean {
  if (filters.agent !== ALL && run.agentName !== filters.agent) return false;
  if (filters.fault !== ALL && run.faultName !== filters.fault) return false;
  if (filters.version !== ALL && run.agentVersion !== filters.version) return false;
  if (filters.failureType !== ALL && !run.failureTypes.includes(filters.failureType)) return false;
  return true;
}

function formatFilterValue(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function TaxonomyReviewPanel({
  run,
  detail,
  source,
  saving,
  error,
  onReview,
}: {
  run?: MonitorRun;
  detail?: RunDetail;
  source: "api" | "static";
  saving: boolean;
  error?: string;
  onReview: (input: { runId: string; patternKey: string; type: string; status: "confirmed" | "corrected"; note?: string }) => Promise<void>;
}) {
  const patterns = detail?.failurePatterns ?? run?.failurePatterns ?? [];
  return (
    <section className="wide-panel taxonomy-review-panel">
      <PanelHeader title="Failure Taxonomy Review" action={source === "api" ? "Write-back enabled" : "Copy command for local corpus"} />
      {error ? <div className="review-error">{error}</div> : null}
      {run && patterns.length > 0 ? (
        <div className="taxonomy-review-list">
          {patterns.map((pattern) => (
            <FailurePatternReview key={pattern.key} run={run} pattern={pattern} source={source} saving={saving} onReview={onReview} />
          ))}
        </div>
      ) : (
        <EmptyLine text={run ? "This run has no failure taxonomy labels to review." : "Select a failed run to review taxonomy labels."} />
      )}
    </section>
  );
}

function FailurePatternReview({
  run,
  pattern,
  source,
  saving,
  onReview,
}: {
  run: MonitorRun;
  pattern: FailurePattern;
  source: "api" | "static";
  saving: boolean;
  onReview: (input: { runId: string; patternKey: string; type: string; status: "confirmed" | "corrected"; note?: string }) => Promise<void>;
}) {
  const suggestedType = pattern.suggestedType ?? pattern.type;
  const [selectedType, setSelectedType] = useState(pattern.type);
  const [note, setNote] = useState(pattern.reviewNote ?? "");

  useEffect(() => {
    setSelectedType(pattern.type);
    setNote(pattern.reviewNote ?? "");
  }, [pattern.key, pattern.type, pattern.reviewNote]);

  const reviewStatus = pattern.reviewStatus ?? "unreviewed";
  const correctionStatus = selectedType === suggestedType ? "confirmed" : "corrected";
  const command = reviewCommand(run, pattern, selectedType, correctionStatus, note);

  return (
    <div className={`taxonomy-review-card ${reviewStatus}`}>
      <div className="taxonomy-card-main">
        <strong>{pattern.key}</strong>
        <p>{pattern.message}</p>
        <div className="taxonomy-badges">
          <span>suggested: {formatFilterValue(suggestedType)}</span>
          <span>effective: {formatFilterValue(pattern.type)}</span>
          <span>{formatFilterValue(reviewStatus)}</span>
        </div>
      </div>
      <label className="taxonomy-select">
        <span>Failure type</span>
        <select value={selectedType} onChange={(event) => setSelectedType(event.target.value)}>
          {FAILURE_TYPES.map((type) => (
            <option key={type} value={type}>
              {formatFilterValue(type)}
            </option>
          ))}
        </select>
      </label>
      <label className="taxonomy-note">
        <span>Review note</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why this label is right or wrong" />
      </label>
      {source === "api" ? (
        <div className="taxonomy-actions">
          <button
            type="button"
            disabled={saving}
            onClick={() => onReview({ runId: run.id, patternKey: pattern.key, type: suggestedType, status: "confirmed", note })}
          >
            Confirm suggestion
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onReview({ runId: run.id, patternKey: pattern.key, type: selectedType, status: correctionStatus, note })}
          >
            Save correction
          </button>
        </div>
      ) : (
        <div className="taxonomy-command">
          <code>{command}</code>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(command)}>
            Copy command
          </button>
        </div>
      )}
    </div>
  );
}

function reviewCommand(run: MonitorRun, pattern: FailurePattern, type: string, status: "confirmed" | "corrected", note: string): string {
  const parts = [
    "node packages/agentcert-cli/dist/cli.js corpus review",
    "--corpus public-demo/browser-agent-robustness/evidence/agentcert-corpus.jsonl",
    "--reviews public-demo/browser-agent-robustness/evidence/failure-reviews.jsonl",
    `--record-id ${quoteArg(run.id)}`,
    `--pattern-key ${quoteArg(pattern.key)}`,
    `--type ${quoteArg(type)}`,
    `--status ${quoteArg(status)}`,
    "--reviewer you@example.com",
  ];
  if (note.trim().length > 0) {
    parts.push(`--note ${quoteArg(note.trim())}`);
  }
  return parts.join(" ");
}

function quoteArg(input: string): string {
  return `"${input.replaceAll('"', '\\"')}"`;
}

function EvidencePreview({ run, detail, source }: { run?: MonitorRun; detail?: RunDetail; source: "api" | "static" }) {
  return (
    <section className="wide-panel evidence-preview">
      <PanelHeader title="Evidence Console" action={source === "api" ? "Live artifact inspection" : "Start local server for artifacts"} />
      {source === "static" ? (
        <div className="server-callout">
          <strong>Static mode shows the public snapshot.</strong>
          <span>Run `npm run agentcert:serve` locally to inspect screenshots, DOM snapshots, traces, and assertion details from the corpus.</span>
        </div>
      ) : (
        <div className="evidence-preview-grid">
          <div>
            <span className="preview-label">Selected run</span>
            <strong>{run?.faultName ?? run?.product ?? "No run selected"}</strong>
            <p>{detail?.failurePatterns[0]?.message ?? run?.primaryFailure ?? "No failure recorded for this run."}</p>
          </div>
          <div>
            <span className="preview-label">Trace</span>
            <strong>{detail?.traceSummary?.stepCount ?? "-"} steps</strong>
            <p>{detail?.traceSummary?.lastStepText ?? "Select a run with trace artifacts."}</p>
          </div>
          <div>
            <span className="preview-label">Artifacts</span>
            <strong>{detail?.artifacts.length ?? 0} files</strong>
            <p>{detail?.artifacts[0]?.label ?? "No artifacts loaded."}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function EvidenceTimelinePanel({
  run,
  detail,
  loading,
  source,
}: {
  run?: MonitorRun;
  detail?: RunDetail;
  loading: boolean;
  source: "api" | "static";
}) {
  return (
    <section className="wide-panel timeline-panel">
      <PanelHeader title="Evidence Timeline" action={loading ? "Loading" : detail ? `${detail.timeline.length} events` : "No API detail"} />
      {source === "static" ? (
        <StaticModeNotice />
      ) : detail ? (
        <div className="timeline">
          {detail.assertions.length > 0 ? (
            <div className="assertion-strip">
              {detail.assertions.slice(0, 4).map((assertion) => (
                <span key={`${assertion.type}-${assertion.message}`} className={assertion.pass ? "assert-pass" : "assert-fail"}>
                  {assertion.type}
                </span>
              ))}
            </div>
          ) : null}
          {detail.timeline.map((item, index) => (
            <TimelineItem key={`${item.kind}-${item.timestamp ?? index}-${item.message}`} item={item} />
          ))}
          {detail.timeline.length === 0 ? <EmptyLine text="No timeline events were recorded for this run." /> : null}
        </div>
      ) : (
        <EmptyLine text={run ? "No artifact detail is available for this run." : "Select a run to inspect evidence."} />
      )}
    </section>
  );
}

function TimelineItem({ item }: { item: EvidenceTimelineItem }) {
  return (
    <div className={`timeline-item ${item.kind}`}>
      <i aria-hidden="true" />
      <div>
        <div className="timeline-title">
          <strong>{item.title}</strong>
          <span>{item.stepIndex ? `step ${item.stepIndex}` : item.timestamp ? compactDate(item.timestamp) : ""}</span>
        </div>
        <p>{item.message}</p>
      </div>
    </div>
  );
}

function ArtifactPanel({
  run,
  detail,
  detailUrl,
  source,
}: {
  run?: MonitorRun;
  detail?: RunDetail;
  detailUrl?: string;
  source: "api" | "static";
}) {
  const screenshots = detail?.artifacts.filter((artifact) => artifact.kind === "screenshot") ?? [];
  const latestScreenshot = screenshots[screenshots.length - 1];
  return (
    <section className="panel artifact-panel">
      <PanelHeader title="Artifact Viewer" action={run?.faultName ?? "No selection"} />
      {source === "static" ? (
        <StaticModeNotice />
      ) : detail ? (
        <>
          <div className="artifact-preview">
            {latestScreenshot ? (
              <img src={latestScreenshot.url} alt={`${run?.faultName ?? "run"} screenshot`} />
            ) : (
              <EmptyLine text="No screenshot artifact found." />
            )}
          </div>
          <div className="artifact-meta">
            <span>Final URL</span>
            <strong>{detail.finalUrl ?? "-"}</strong>
          </div>
          <ArtifactList artifacts={detail.artifacts} />
          {detail.diagnostics.length > 0 ? <MessageList title="Diagnostics" messages={detail.diagnostics} /> : null}
          {detail.warnings.length > 0 ? <MessageList title="Warnings" messages={detail.warnings} /> : null}
        </>
      ) : (
        <EmptyLine text={run ? "Artifact detail was not found." : "Select a run to view artifacts."} />
      )}
      {detailUrl ? (
        <div className="inspector-links">
          <a href={detailUrl}>Open public evidence page</a>
        </div>
      ) : null}
    </section>
  );
}

function ArtifactList({ artifacts }: { artifacts: EvidenceArtifact[] }) {
  return (
    <div className="artifact-list">
      {artifacts.map((artifact) => (
        <a key={artifact.path} href={artifact.url} target="_blank" rel="noreferrer">
          <span>
            <strong>{artifact.label}</strong>
            <small>{artifact.kind}</small>
          </span>
          <em>{compactBytes(artifact.sizeBytes)}</em>
        </a>
      ))}
      {artifacts.length === 0 ? <EmptyLine text="No artifacts are linked for this run." /> : null}
    </div>
  );
}

function MessageList({ title, messages }: { title: string; messages: string[] }) {
  return (
    <div className="message-list">
      <span>{title}</span>
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}

function StaticModeNotice() {
  return (
    <div className="server-callout compact">
      <strong>Artifact inspection needs the local server.</strong>
      <span>`npm run agentcert:serve` enables `/api/runs/:id` and `/api/artifacts`.</span>
    </div>
  );
}

function Status({ passed }: { passed: boolean }) {
  return <em className={`status ${passed ? "pass" : "fail"}`}>{passed ? "Passed" : "Failed"}</em>;
}

function EmptyLine({ text }: { text: string }) {
  return <div className="empty-line">{text}</div>;
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="error-state">
      <strong>AgentCert Monitor could not start</strong>
      <span>{message}</span>
    </div>
  );
}
