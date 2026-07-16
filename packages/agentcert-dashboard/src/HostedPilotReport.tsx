import { useCallback, useEffect, useState } from "react";
import {
  downloadAdminPilotReport,
  loadAdminPilotReport,
  type HostedPilotFunnelReport,
  type HostedSession,
} from "./hosted-api";

const stageLabels: Record<HostedPilotFunnelReport["stages"][number]["id"], string> = {
  project_created: "Project created",
  key_created: "Key created",
  cli_connected: "CLI connected",
  first_evidence: "First evidence",
};

export default function HostedPilotReport({ session }: { session: HostedSession }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [report, setReport] = useState<HostedPilotFunnelReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { setReport(await loadAdminPilotReport(session, days)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [days, session]);
  useEffect(() => { void refresh(); }, [refresh]);

  return <section className="data-section pilot-report">
    <div className="section-actions">
      <div className="section-title"><h2>Pilot funnel</h2><p>Project cohort conversion, onboarding time, and reported friction</p></div>
      <div className="pilot-report-actions">
        <div className="period-control" aria-label="Pilot report period">
          {([7, 30, 90] as const).map((period) => <button key={period} aria-pressed={days === period} className={days === period ? "active" : ""} onClick={() => setDays(period)}>{period}d</button>)}
        </div>
        <button disabled={!report} onClick={() => void downloadAdminPilotReport(session, days)}>Export JSON</button>
      </div>
    </div>
    {error ? <div className="console-error">{error}</div> : null}
    {loading && !report ? <div className="loading">Calculating pilot cohort...</div> : null}
    {report ? <>
      <div className="pilot-stage-grid">{report.stages.map((stage) => <article key={stage.id}>
        <span>{stageLabels[stage.id]}</span><strong>{stage.count}</strong>
        <em>{stage.id === "project_created" ? `${days}-day cohort` : `${percent(stage.conversionFromPrevious)} from previous`}</em>
      </article>)}</div>
      <div className="pilot-timing-grid">
        <Metric label="Project to key" value={duration(report.timing.medianProjectToKeyMs)} />
        <Metric label="Key to CLI" value={duration(report.timing.medianKeyToConnectionMs)} />
        <Metric label="CLI to evidence" value={duration(report.timing.medianConnectionToEvidenceMs)} />
        <Metric label="Total onboarding" value={duration(report.timing.medianProjectToEvidenceMs)} />
        <Metric label="Friction reports" value={String(report.feedback.friction)} detail="cohort total" />
      </div>
      <div className="pilot-report-columns">
        <div><h3>Failure reasons</h3><div className="pilot-reason-list">
          {report.feedback.topReasons.map((reason) => <div key={`${reason.reasonCode}:${reason.stage}:${reason.category}`}><strong>{reason.reasonCode}</strong><span>{reason.stage.replace(/_/g, " ")} / {reason.category}</span><b>{reason.count}</b></div>)}
          {report.feedback.topReasons.length === 0 ? <p>No blocked, confusing, or failed feedback in this cohort.</p> : null}
        </div></div>
        <div><h3>Feedback outcomes</h3><div className="pilot-outcomes">{Object.entries(report.feedback.byOutcome).map(([outcome, count]) => <div key={outcome}><span>{outcome}</span><strong>{count}</strong></div>)}</div></div>
      </div>
      <div className="pilot-project-table"><div className="pilot-project-row head"><span>Project</span><span>Stage</span><span>Total time</span><span>Friction</span></div>
        {report.projects.map((project) => <div className="pilot-project-row" key={project.projectId}><div><strong>{project.name}</strong><small>{project.slug} / {shortDate(project.createdAt)}</small></div><span>{stageLabels[project.stage]}</span><span>{duration(project.totalDurationMs)}</span><span>{project.frictionCount}</span></div>)}
      </div>
      {report.projects.length === 0 ? <div className="hosted-empty">No projects entered this cohort.</div> : null}
      <p className="pilot-report-note">Generated {new Date(report.generatedAt).toLocaleString()} from projects created since {shortDate(report.since)}.</p>
    </> : null}
  </section>;
}

function Metric({ label, value, detail = "median" }: { label: string; value: string; detail?: string }) { return <div><span>{label}</span><strong>{value}</strong><em>{detail}</em></div>; }
function percent(value: number): string { return `${Math.round(value * 100)}%`; }
function shortDate(value: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(new Date(value)); }
function duration(value?: number): string {
  if (value === undefined) return "No data";
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  if (value < 86_400_000) return `${(value / 3_600_000).toFixed(1)}h`;
  return `${(value / 86_400_000).toFixed(1)}d`;
}
