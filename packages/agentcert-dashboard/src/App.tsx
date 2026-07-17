import { useEffect, useMemo, useState } from "react";
import { compactBytes, compactDate, compactDuration, loadMonitorSnapshot, loadRunDetail, percent, submitFailureReview } from "./data";
import HostedApp from "./HostedApp";
import { BrandLink, ProductHeader } from "./Brand";
import { detectHostedConfig, type HostedConfig } from "./hosted-api";
import { LandingPage, PricingPage, SecurityPage } from "./ProductSite";
import { isPublicArchiveLocation, resolveHostedSurface, type SurfaceRoute } from "./surface-routing";
import type {
  EvidenceArtifact,
  EvidenceTimelineItem,
  FailurePattern,
  FailureReviewEvidenceContext,
  FailureReviewInput,
  LifecycleGate,
  MonitorRun,
  MonitorSnapshot,
  RunDetail,
  SummaryBucket,
} from "./types";

type View = "overview" | "runs" | "patterns";
type MonitorDeployment = "hosted" | "archive" | "local";
type FilterState = {
  agent: string;
  fault: string;
  version: string;
  failureType: string;
  reviewStatus: string;
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
  if (isPublicArchiveLocation(window.location)) {
    return <MonitorApp deployment="archive" />;
  }
  return <ProductSurface route={resolveHostedSurface(window.location.pathname, window.location.hash)} />;
}

function ProductSurface({ route }: { route: SurfaceRoute }) {
  useEffect(() => {
    if (route.normalizedPath) {
      window.history.replaceState(
        {},
        document.title,
        `${route.normalizedPath}${window.location.search}${window.location.hash}`,
      );
    }
    document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.setAttribute(
      "content",
      route.surface === "workspace" ? "noindex,nofollow" : "index,follow",
    );
  }, [route.normalizedPath, route.surface]);

  if (route.surface === "home") return <LandingPage />;
  if (route.surface === "public-evidence") return <MonitorApp deployment="hosted" />;
  if (route.surface === "pricing") return <PricingPage />;
  if (route.surface === "security") return <SecurityPage />;
  if (route.surface === "workspace") return <WorkspaceSurface />;
  return <NotFound />;
}

function WorkspaceSurface() {
  const [hostedConfig, setHostedConfig] = useState<HostedConfig | null>();

  useEffect(() => {
    detectHostedConfig().then((config) => setHostedConfig(config ?? null));
  }, []);

  if (hostedConfig === undefined) {
    return <div className="loading">Opening AgentCert workspace...</div>;
  }
  if (hostedConfig) {
    return <HostedApp config={hostedConfig} />;
  }
  return <ErrorState message="The hosted workspace configuration is unavailable. Open the public evidence page or retry after the control plane is running." />;
}

function MonitorApp({ deployment }: { deployment: MonitorDeployment }) {
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
    reviewStatus: ALL,
  });

  useEffect(() => {
    if (deployment !== "hosted") return;
    const title = "Public Evidence | AgentCert";
    const description = "Inspect versioned AgentCert evidence, lifecycle checks, failure patterns, and reviewed agent behavior.";
    document.title = title;
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", description);
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.setAttribute("content", title);
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.setAttribute("content", description);
    document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute("content", `${window.location.origin}/evidence`);
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", `${window.location.origin}/evidence`);
  }, [deployment]);

  useEffect(() => {
    loadMonitorSnapshot(deployment === "local")
      .then((result) => {
        setSnapshot(result.snapshot);
        setSource(result.source);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [deployment]);

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

  async function handleFailureReview(input: FailureReviewInput): Promise<void> {
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
        confidence: input.confidence,
        evidenceContext: input.evidenceContext,
        taxonomyRationale: input.taxonomyRationale,
      });
      setRunDetail(nextDetail);
      const refreshed = await loadMonitorSnapshot(deployment === "local");
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

  const brandHref = deployment === "hosted"
    ? "/"
    : deployment === "archive"
      ? "https://agentcert.app/evidence"
      : "https://github.com/Kakarottoooo/agentcert";
  const publicDetailUrl = snapshot.links.detailUrl
    ? publicEvidenceUrl(snapshot.links.detailUrl, deployment)
    : undefined;

  return (
    <div className="evidence-surface">
      {deployment === "hosted" ? (
        <ProductHeader active="evidence" />
      ) : (
        <header className="evidence-utility-nav">
          <BrandLink href={brandHref} suffix={deployment === "archive" ? "Evidence archive" : "Local monitor"} />
          <a href="https://agentcert.app/evidence">Open hosted evidence</a>
        </header>
      )}

      <main className="evidence-workspace">
        {deployment === "archive" ? (
          <section className="migration-banner" aria-label="AgentCert public evidence migration">
            <div>
              <strong>This snapshot is now the public evidence archive.</strong>
              <span>The current evidence explorer and authenticated workspace share one product surface in AgentCert Hosted.</span>
            </div>
            <a href="https://agentcert.app/evidence">Open current evidence</a>
          </section>
        ) : null}
        <header className="evidence-page-header">
          <div className="evidence-title-block">
            <span className="surface-mode">Public evidence</span>
            <h1>Observed agent behavior, open for inspection.</h1>
            <p>Versioned lifecycle checks, traces, artifacts, failure taxonomy, and reviewer decisions.</p>
            <div className="evidence-context-note">
              Failures on this page are findings from evaluated agents and scenarios. They are not AgentCert service-health incidents.
            </div>
          </div>
          <div className="header-actions">
            <span className={`source-badge ${source}`}>{source === "api" ? "Local server" : "Evidence snapshot"}</span>
            <a href={source === "api" ? "/api/corpus/reviewed-dataset" : publicEvidenceUrl("../browser-agent-robustness/evidence/reviewed-failure-dataset.jsonl", deployment)}>
              Export reviewed dataset
            </a>
            {publicDetailUrl ? <a href={publicDetailUrl}>Open evidence detail</a> : null}
            {deployment === "hosted" ? <a className="workspace-action" href="/app">Open workspace</a> : null}
            <a href="https://github.com/Kakarottoooo/agentcert">GitHub</a>
          </div>
        </header>

        <nav className="evidence-tabs" aria-label="Evidence views">
          <button className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>Overview</button>
          <button className={view === "runs" ? "active" : ""} onClick={() => setView("runs")}>Runs</button>
          <button className={view === "patterns" ? "active" : ""} onClick={() => setView("patterns")}>Patterns</button>
          <span>{source === "api" ? "Live local server API" : "Versioned public snapshot"}</span>
        </nav>

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
            detailUrl={publicDetailUrl}
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
            detailUrl={publicDetailUrl}
          />
        ) : null}
        {view === "patterns" ? <PatternsView snapshot={snapshot} /> : null}
      </main>
      <footer className="evidence-footer">
        <span>AgentCert public beta</span>
        <a href="/">Product</a>
        <a href="/security">Security</a>
        <a href="/app?mode=signup">Create workspace</a>
      </footer>
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
  detailUrl,
}: {
  snapshot: MonitorSnapshot;
  runs: MonitorRun[];
  selectedRun?: MonitorRun;
  runDetail?: RunDetail;
  source: "api" | "static";
  reviewSaving: boolean;
  reviewError?: string;
  onSelectRun: (id: string) => void;
  onReview: (input: FailureReviewInput) => Promise<void>;
  detailUrl?: string;
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
        <Metric
          label="Review coverage"
          value={percent(snapshot.summary.taxonomy.reviewCoverage)}
          detail={`${percent(snapshot.summary.taxonomy.autoLabelPrecision)} reviewed-label precision`}
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

      <RunInspector run={selectedRun} detailUrl={detailUrl} />

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
  detailUrl,
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
  onReview: (input: FailureReviewInput) => Promise<void>;
  detailUrl?: string;
}) {
  return (
    <div className="evidence-grid">
      <section className="wide-panel">
        <PanelHeader title="All Recent Runs" action={`${runs.length}/${snapshot.recentRuns.length} records shown`} />
        <RunTable runs={runs} selectedRun={selectedRun} onSelectRun={onSelectRun} />
      </section>
      <EvidenceTimelinePanel run={selectedRun} detail={runDetail} loading={detailLoading} source={source} />
      <TaxonomyReviewPanel run={selectedRun} detail={runDetail} source={source} saving={reviewSaving} error={reviewError} onReview={onReview} />
      <ArtifactPanel run={selectedRun} detail={runDetail} detailUrl={detailUrl} source={source} />
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

function NotFound() {
  return (
    <main className="surface-not-found">
      <div className="hosted-brand">AgentCert</div>
      <h1>Page not found</h1>
      <p>Return to the product site, inspect public evidence, or sign in to your workspace.</p>
      <div>
        <a href="/">AgentCert home</a>
        <a href="/evidence">Public evidence</a>
      </div>
    </main>
  );
}

function publicEvidenceUrl(value: string, deployment: MonitorDeployment): string {
  if (deployment !== "hosted" || /^https?:\/\//.test(value)) return value;
  const normalized = value.replace(/^\.\.\//, "").replace(/^\.\//, "").replace(/^\/+/, "");
  return `https://kakarottoooo.github.io/agentcert/public-demo/${normalized}`;
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
      <FilterSelect
        label="Review status"
        value={filters.reviewStatus}
        options={snapshot.filters.reviewStatuses}
        onChange={(reviewStatus) => onChange({ ...filters, reviewStatus })}
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
  if (filters.reviewStatus !== ALL && run.taxonomyReviewStatus !== filters.reviewStatus) return false;
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
  onReview: (input: FailureReviewInput) => Promise<void>;
}) {
  const patterns = detail?.failurePatterns ?? run?.failurePatterns ?? [];
  const evidenceContext = useMemo(() => reviewEvidenceContextFromDetail(detail), [detail]);
  return (
    <section className="wide-panel taxonomy-review-panel">
      <PanelHeader title="Failure Taxonomy Review" action={source === "api" ? "Write-back enabled" : "Copy command for local corpus"} />
      {error ? <div className="review-error">{error}</div> : null}
      {run && patterns.length > 0 ? (
        <div className="taxonomy-review-list">
          {patterns.map((pattern) => (
            <FailurePatternReview
              key={pattern.key}
              run={run}
              pattern={pattern}
              evidenceContext={evidenceContext}
              source={source}
              saving={saving}
              onReview={onReview}
            />
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
  evidenceContext,
  source,
  saving,
  onReview,
}: {
  run: MonitorRun;
  pattern: FailurePattern;
  evidenceContext?: FailureReviewEvidenceContext;
  source: "api" | "static";
  saving: boolean;
  onReview: (input: FailureReviewInput) => Promise<void>;
}) {
  const suggestedType = pattern.suggestedType ?? pattern.type;
  const [selectedType, setSelectedType] = useState(pattern.type);
  const [note, setNote] = useState(pattern.reviewNote ?? "");
  const [confidence, setConfidence] = useState(formatConfidence(pattern.reviewConfidence ?? 0.8));
  const [firstDivergenceSnippet, setFirstDivergenceSnippet] = useState(
    pattern.reviewEvidenceContext?.firstDivergenceSnippet ?? evidenceContext?.firstDivergenceSnippet ?? "",
  );
  const [screenshotPath, setScreenshotPath] = useState(pattern.reviewEvidenceContext?.screenshotPath ?? evidenceContext?.screenshotPath ?? "");
  const [why, setWhy] = useState(
    pattern.taxonomyRationale?.primaryReason ?? defaultTaxonomyReason(pattern, pattern.type, pattern.reviewStatus ?? "unreviewed"),
  );
  const [supportingSignals, setSupportingSignals] = useState((pattern.taxonomyRationale?.supportingSignals ?? []).join("; "));
  const [classifierLimitation, setClassifierLimitation] = useState(pattern.taxonomyRationale?.classifierLimitation ?? "");

  useEffect(() => {
    setSelectedType(pattern.type);
    setNote(pattern.reviewNote ?? "");
    setConfidence(formatConfidence(pattern.reviewConfidence ?? 0.8));
    setFirstDivergenceSnippet(pattern.reviewEvidenceContext?.firstDivergenceSnippet ?? evidenceContext?.firstDivergenceSnippet ?? "");
    setScreenshotPath(pattern.reviewEvidenceContext?.screenshotPath ?? evidenceContext?.screenshotPath ?? "");
    setWhy(pattern.taxonomyRationale?.primaryReason ?? defaultTaxonomyReason(pattern, pattern.type, pattern.reviewStatus ?? "unreviewed"));
    setSupportingSignals((pattern.taxonomyRationale?.supportingSignals ?? []).join("; "));
    setClassifierLimitation(pattern.taxonomyRationale?.classifierLimitation ?? "");
  }, [evidenceContext, pattern]);

  const reviewStatus = pattern.reviewStatus ?? "unreviewed";
  const correctionStatus = selectedType === suggestedType ? "confirmed" : "corrected";
  const draftReview = buildFailureReviewInput({
    run,
    pattern,
    type: selectedType,
    status: correctionStatus,
    note,
    confidence,
    evidenceContext,
    firstDivergenceSnippet,
    screenshotPath,
    why,
    supportingSignals,
    classifierLimitation,
  });
  const command = reviewCommand(draftReview);

  return (
    <div className={`taxonomy-review-card ${reviewStatus}`}>
      <div className="taxonomy-card-main">
        <strong>{pattern.key}</strong>
        <p>{pattern.message}</p>
        <div className="taxonomy-badges">
          <span>suggested: {formatFilterValue(suggestedType)}</span>
          <span>effective: {formatFilterValue(pattern.type)}</span>
          <span>{formatFilterValue(reviewStatus)}</span>
          {pattern.reviewConfidence !== undefined ? <span>confidence: {Math.round(pattern.reviewConfidence * 100)}%</span> : null}
        </div>
        {pattern.taxonomyRationale?.primaryReason ? <p className="taxonomy-rationale">{pattern.taxonomyRationale.primaryReason}</p> : null}
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
      <label className="taxonomy-confidence">
        <span>Reviewer confidence</span>
        <input min="0" max="1" step="0.05" type="number" value={confidence} onChange={(event) => setConfidence(event.target.value)} />
      </label>
      <label className="taxonomy-note taxonomy-wide">
        <span>Why this taxonomy label</span>
        <textarea value={why} onChange={(event) => setWhy(event.target.value)} placeholder="Structured rationale for training and evaluation" rows={2} />
      </label>
      <label className="taxonomy-note">
        <span>First divergence snippet</span>
        <textarea
          value={firstDivergenceSnippet}
          onChange={(event) => setFirstDivergenceSnippet(event.target.value)}
          placeholder="First visible behavior or state divergence"
          rows={2}
        />
      </label>
      <label className="taxonomy-note">
        <span>Screenshot pointer</span>
        <input value={screenshotPath} onChange={(event) => setScreenshotPath(event.target.value)} placeholder="runs/.../screenshot.png" />
      </label>
      <label className="taxonomy-note">
        <span>Review note</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional freeform note" />
      </label>
      <label className="taxonomy-note">
        <span>Supporting signals</span>
        <input value={supportingSignals} onChange={(event) => setSupportingSignals(event.target.value)} placeholder="semicolon-separated evidence signals" />
      </label>
      <label className="taxonomy-note">
        <span>Classifier limitation</span>
        <input
          value={classifierLimitation}
          onChange={(event) => setClassifierLimitation(event.target.value)}
          placeholder="What the automatic rule missed"
        />
      </label>
      {source === "api" ? (
        <div className="taxonomy-actions">
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              onReview(
                buildFailureReviewInput({
                  run,
                  pattern,
                  type: suggestedType,
                  status: "confirmed",
                  note,
                  confidence,
                  evidenceContext,
                  firstDivergenceSnippet,
                  screenshotPath,
                  why,
                  supportingSignals,
                  classifierLimitation,
                }),
              )
            }
          >
            Confirm suggestion
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onReview(draftReview)}
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

function reviewCommand(review: FailureReviewInput): string {
  const parts = [
    "node packages/agentcert-cli/dist/cli.js corpus review",
    "--corpus public-demo/browser-agent-robustness/evidence/agentcert-corpus.jsonl",
    "--reviews public-demo/browser-agent-robustness/evidence/failure-reviews.jsonl",
    `--record-id ${quoteArg(review.runId)}`,
    `--pattern-key ${quoteArg(review.patternKey)}`,
    `--type ${quoteArg(review.type)}`,
    `--status ${quoteArg(review.status)}`,
    "--reviewer you@example.com",
  ];
  if (review.confidence !== undefined) {
    parts.push(`--confidence ${review.confidence}`);
  }
  if (review.note?.trim()) {
    parts.push(`--note ${quoteArg(oneLine(review.note))}`);
  }
  if (review.evidenceContext?.firstDivergenceSnippet) {
    parts.push(`--first-divergence ${quoteArg(oneLine(review.evidenceContext.firstDivergenceSnippet))}`);
  }
  if (review.evidenceContext?.screenshotPath) {
    parts.push(`--screenshot ${quoteArg(review.evidenceContext.screenshotPath)}`);
  }
  if (review.evidenceContext?.tracePath) {
    parts.push(`--trace ${quoteArg(review.evidenceContext.tracePath)}`);
  }
  if (review.evidenceContext?.stepIndex !== undefined) {
    parts.push(`--step-index ${review.evidenceContext.stepIndex}`);
  }
  if (review.taxonomyRationale?.primaryReason) {
    parts.push(`--why ${quoteArg(oneLine(review.taxonomyRationale.primaryReason))}`);
  }
  for (const signal of review.taxonomyRationale?.supportingSignals ?? []) {
    parts.push(`--signal ${quoteArg(oneLine(signal))}`);
  }
  if (review.taxonomyRationale?.classifierLimitation) {
    parts.push(`--classifier-limitation ${quoteArg(oneLine(review.taxonomyRationale.classifierLimitation))}`);
  }
  return parts.join(" ");
}

function quoteArg(input: string): string {
  return `"${input.replaceAll('"', '\\"')}"`;
}

function buildFailureReviewInput(input: {
  run: MonitorRun;
  pattern: FailurePattern;
  type: string;
  status: "confirmed" | "corrected";
  note: string;
  confidence: string;
  evidenceContext?: FailureReviewEvidenceContext;
  firstDivergenceSnippet: string;
  screenshotPath: string;
  why: string;
  supportingSignals: string;
  classifierLimitation: string;
}): FailureReviewInput {
  const confidence = Number(input.confidence);
  const firstDivergenceSnippet = input.firstDivergenceSnippet.trim();
  const screenshotPath = input.screenshotPath.trim();
  const tracePath = input.evidenceContext?.tracePath;
  const stepIndex = input.evidenceContext?.stepIndex;
  return {
    runId: input.run.id,
    patternKey: input.pattern.key,
    type: input.type,
    status: input.status,
    note: input.note.trim() || undefined,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : undefined,
    evidenceContext:
      firstDivergenceSnippet || screenshotPath || input.evidenceContext?.screenshotUrl || tracePath || stepIndex !== undefined
        ? {
            firstDivergenceSnippet: firstDivergenceSnippet || undefined,
            screenshotPath: screenshotPath || undefined,
            screenshotUrl: input.evidenceContext?.screenshotUrl,
            tracePath,
            stepIndex,
          }
        : undefined,
    taxonomyRationale: {
      primaryReason:
        input.why.trim() || defaultTaxonomyReason(input.pattern, input.type, input.status === "corrected" ? "corrected" : "confirmed"),
      supportingSignals: splitSignals(input.supportingSignals),
      classifierLimitation: input.classifierLimitation.trim() || undefined,
    },
  };
}

function reviewEvidenceContextFromDetail(detail?: RunDetail): FailureReviewEvidenceContext | undefined {
  if (!detail) return undefined;
  const divergence = detail.timeline.find((item) => item.title === "First observed page divergence") ?? detail.timeline.find((item) => item.kind === "failure");
  const screenshot = detail.artifacts.find((artifact) => artifact.kind === "screenshot");
  const trace = detail.artifacts.find((artifact) => artifact.kind === "trace");
  const firstDivergenceSnippet = truncateSnippet(divergence?.message ?? detail.traceSummary?.lastStepText ?? detail.traceSummary?.firstStepText);
  if (!firstDivergenceSnippet && !screenshot && !trace && detail.traceSummary?.firstDivergenceStep === undefined) {
    return undefined;
  }
  return {
    firstDivergenceSnippet,
    screenshotPath: screenshot?.path,
    screenshotUrl: screenshot?.url,
    tracePath: trace?.path,
    stepIndex: divergence?.stepIndex ?? detail.traceSummary?.firstDivergenceStep,
  };
}

function defaultTaxonomyReason(pattern: FailurePattern, type: string, status: "unreviewed" | "confirmed" | "corrected"): string {
  const suggestedType = pattern.suggestedType ?? pattern.type;
  if (status === "corrected" || type !== suggestedType) {
    return `Human review corrected ${formatFilterValue(suggestedType)} to ${formatFilterValue(type)} based on the run evidence.`;
  }
  return `Human review confirmed ${formatFilterValue(type)} based on the run evidence.`;
}

function formatConfidence(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function splitSignals(input: string): string[] | undefined {
  const values = input
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function truncateSnippet(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const value = oneLine(input);
  return value.length > 320 ? `${value.slice(0, 317)}...` : value;
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
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
