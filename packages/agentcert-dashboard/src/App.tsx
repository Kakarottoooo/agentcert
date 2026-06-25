import { useEffect, useMemo, useState } from "react";
import { compactDate, compactDuration, loadMonitorSnapshot, percent } from "./data";
import type { LifecycleGate, MonitorRun, MonitorSnapshot, SummaryBucket } from "./types";

type View = "overview" | "runs" | "patterns";

export default function App() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>("overview");
  const [selectedRunId, setSelectedRunId] = useState<string>();

  useEffect(() => {
    loadMonitorSnapshot().then(setSnapshot).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const selectedRun = useMemo(() => {
    if (!snapshot) return undefined;
    return snapshot.recentRuns.find((run) => run.id === selectedRunId) ?? snapshot.recentRuns[0];
  }, [selectedRunId, snapshot]);

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
          <span>Generated from AgentCert corpus JSONL.</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="page-header">
          <div>
            <h1>AgentCert Monitor</h1>
            <p>{snapshot.subject}</p>
          </div>
          <div className="header-actions">
            {snapshot.links.detailUrl ? <a href={snapshot.links.detailUrl}>Open evidence detail</a> : null}
            <a href="https://github.com/Kakarottoooo/agentcert">GitHub</a>
          </div>
        </header>

        <section className="lifecycle-grid" aria-label="Lifecycle gates">
          {snapshot.lifecycle.map((gate) => (
            <LifecycleCard key={gate.id} gate={gate} />
          ))}
        </section>

        {view === "overview" ? <Overview snapshot={snapshot} selectedRun={selectedRun} onSelectRun={setSelectedRunId} /> : null}
        {view === "runs" ? <RunsView snapshot={snapshot} selectedRun={selectedRun} onSelectRun={setSelectedRunId} /> : null}
        {view === "patterns" ? <PatternsView snapshot={snapshot} /> : null}
      </main>
    </div>
  );
}

function Overview({
  snapshot,
  selectedRun,
  onSelectRun,
}: {
  snapshot: MonitorSnapshot;
  selectedRun?: MonitorRun;
  onSelectRun: (id: string) => void;
}) {
  return (
    <div className="dashboard-grid">
      <section className="metrics-panel">
        <Metric label="Corpus records" value={String(snapshot.summary.totalRecords)} detail="Accumulated evidence rows" />
        <Metric label="Pass rate" value={percent(snapshot.summary.passRate)} detail={`${snapshot.summary.failedRecords} failed records`} />
        <Metric label="Failure patterns" value={String(snapshot.failurePatterns.length)} detail="Top grouped failures" />
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
        <PanelHeader title="Recent Runs" action="Click a row to inspect" />
        <RunTable runs={snapshot.recentRuns.slice(0, 8)} selectedRun={selectedRun} onSelectRun={onSelectRun} />
      </section>

      <RunInspector run={selectedRun} detailUrl={snapshot.links.detailUrl} />
    </div>
  );
}

function RunsView({
  snapshot,
  selectedRun,
  onSelectRun,
}: {
  snapshot: MonitorSnapshot;
  selectedRun?: MonitorRun;
  onSelectRun: (id: string) => void;
}) {
  return (
    <div className="dashboard-grid two-column">
      <section className="wide-panel">
        <PanelHeader title="All Recent Runs" action={`${snapshot.recentRuns.length} records shown`} />
        <RunTable runs={snapshot.recentRuns} selectedRun={selectedRun} onSelectRun={onSelectRun} />
      </section>
      <RunInspector run={selectedRun} detailUrl={snapshot.links.detailUrl} />
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
        <span>Duration</span>
      </div>
      {runs.map((run) => (
        <button
          key={run.id}
          className={`run-row ${selectedRun?.id === run.id ? "selected" : ""}`}
          role="row"
          onClick={() => onSelectRun(run.id)}
        >
          <span>
            <strong>{run.product}</strong>
            <small>{run.phase}</small>
          </span>
          <span>
            <strong>{run.faultName ?? "product-run"}</strong>
            <small>{run.scenarioName ?? run.subject}</small>
          </span>
          <Status passed={run.passed} />
          <span>{run.evidenceCount}</span>
          <span>{compactDuration(run.durationMs)}</span>
        </button>
      ))}
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
