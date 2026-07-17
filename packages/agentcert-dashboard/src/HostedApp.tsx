import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  bootstrap,
  acknowledgeHostedIncident,
  createHostedNotificationDestination,
  createHostedAgent,
  createHostedApiKey,
  createHostedTestWebhook,
  downloadRetentionReport,
  disableHostedNotificationDestination,
  downloadAdminLegalHoldReport,
  evidenceContentUrl,
  loadHostedActions,
  loadHostedApiKeys,
  loadHostedAgents,
  loadHostedEvidence,
  loadHostedAssuranceCases,
  loadHostedIncidents,
  loadHostedRuns,
  loadHostedCapabilities,
  loadHostedOnboarding,
  loadProjects,
  loadAdminLegalHolds,
  loadRetentionReport,
  loadOverview,
  loadHostedOperations,
  readHostedAuthCallbackError,
  readHostedSession,
  requestHostedLegalHold,
  resendSignUpConfirmation,
  resolveHostedIncident,
  reviewHostedAction,
  reviewAdminLegalHold,
  revokeHostedApiKey,
  retryHostedWebhookJob,
  retryHostedNotificationJob,
  sendHostedTestNotification,
  signIn,
  signOut,
  signUp,
  type HostedAction,
  type HostedAgent,
  type HostedApiKey,
  type HostedConfig,
  type HostedCapabilities,
  type HostedEvidence,
  type HostedAssuranceCase,
  type HostedIncident,
  type HostedOverview,
  type HostedOperations,
  type HostedOnboardingStatus,
  type HostedProject,
  type HostedRun,
  type HostedSession,
  type HostedLegalHoldRequest,
  type HostedNotificationAlertType,
  type HostedRetentionReport,
} from "./hosted-api";
import HostedRunsView from "./HostedRunsView";
import HostedSandboxView from "./HostedSandboxView";
import HostedOnboarding from "./HostedOnboarding";
import HostedProjectSwitcher from "./HostedProjectSwitcher";
import HostedPilotReport from "./HostedPilotReport";
import HostedAssuranceView from "./HostedAssuranceView";
import { BrandMark, ProductHeader } from "./Brand";
import { resolveAuthMode } from "./auth-routing";
import { isSandboxCertificationRun } from "./sandbox-certifications";

type HostedView = "overview" | "agents" | "runs" | "assurance" | "sandbox" | "gates" | "actions" | "incidents" | "evidence" | "integrations" | "governance";

interface ConsoleData {
  overview: HostedOverview;
  operations: HostedOperations;
  agents: HostedAgent[];
  runs: HostedRun[];
  actions: HostedAction[];
  incidents: HostedIncident[];
  evidence: HostedEvidence[];
  assuranceCases: HostedAssuranceCase[];
}

export default function HostedApp({ config }: { config: HostedConfig }) {
  useEffect(() => { document.title = "AgentCert Control Plane"; }, []);
  const [session, setSession] = useState(() => readHostedSession(config));
  if (!session) return <AuthScreen config={config} onAuthenticated={setSession} />;
  return <HostedConsole config={config} session={session} onSignOut={() => { void signOut(config, session).finally(() => setSession(undefined)); }} />;
}

function AuthScreen({ config, onAuthenticated }: { config: HostedConfig; onAuthenticated: (session: HostedSession) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">(() => resolveAuthMode(window.location.search));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string | undefined>(() => readHostedAuthCallbackError());

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined); setMessage(undefined);
    try {
      if (mode === "signin") onAuthenticated(await signIn(config, email, password));
      else {
        const result = await signUp(config, email, password);
        setMessage(result.message);
        if (result.session) onAuthenticated(result.session);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  async function resendConfirmation() {
    setBusy(true); setError(undefined); setMessage(undefined);
    try {
      setMessage(await resendSignUpConfirmation(config, email));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-surface">
      <ProductHeader />
      <main className="auth-page">
        <section className="auth-intro">
          <span className="surface-mode inverse">Workspace access</span>
          <h1>Independent evidence for agents that take real actions.</h1>
          <p>Gate releases, review high-risk actions, verify outcomes, and retain evidence in one control plane.</p>
          <ol>
            <li><strong>Know</strong> what every agent is allowed to do.</li>
            <li><strong>Prove</strong> reliability before release.</li>
            <li><strong>Decide</strong> whether a live action should proceed.</li>
            <li><strong>Trace</strong> what happened and who approved it.</li>
          </ol>
          <a className="auth-evidence-link" href="/evidence">Inspect public evidence before signing in</a>
        </section>
        <section className="auth-form-panel">
          <div className="auth-tabs" role="tablist">
            <button className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button>
            <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Create account</button>
          </div>
          <h2>{mode === "signin" ? "Sign in to AgentCert" : "Start an AgentCert workspace"}</h2>
          <form onSubmit={submit}>
            <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input type="password" required minLength={10} autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {error ? <div className="form-error">{error}</div> : null}
            {message ? <div className="form-message">{message}</div> : null}
            <button className="primary-action" disabled={busy}>{busy ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}</button>
            {mode === "signin" && config.auth.provider === "supabase" ? (
              <button type="button" className="auth-secondary-action" disabled={busy || !email.trim()} onClick={() => void resendConfirmation()}>
                Resend confirmation email
              </button>
            ) : null}
          </form>
          <p className="auth-note">Registration is open. Confirmed accounts receive an isolated organization and assurance project.</p>
        </section>
      </main>
    </div>
  );
}

function HostedConsole({ config, session, onSignOut }: { config: HostedConfig; session: HostedSession; onSignOut: () => void }) {
  const [view, setView] = useState<HostedView>("overview");
  const [project, setProject] = useState<HostedProject>();
  const [projects, setProjects] = useState<HostedProject[]>([]);
  const [onboarding, setOnboarding] = useState<HostedOnboardingStatus>();
  const [data, setData] = useState<ConsoleData>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<HostedCapabilities>();

  const refresh = useCallback(async () => {
    if (!project) return;
    setLoading(true); setError(undefined);
    try {
      const [overview, operations, agents, runs, actions, incidents, evidence, assuranceCases, nextOnboarding] = await Promise.all([
        loadOverview(session, project.id), loadHostedOperations(session, project.id), loadHostedAgents(session, project.id), loadHostedRuns(session, project.id),
        loadHostedActions(session, project.id), loadHostedIncidents(session, project.id), loadHostedEvidence(session, project.id), loadHostedAssuranceCases(session, project.id),
        loadHostedOnboarding(session, project.id),
      ]);
      setData({ overview, operations, agents, runs, actions, incidents, evidence, assuranceCases });
      setOnboarding(nextOnboarding);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [project, session]);

  useEffect(() => {
    Promise.all([bootstrap(session), loadHostedCapabilities(session), loadProjects(session)])
      .then(([result, nextCapabilities, nextProjects]) => {
        setProjects(nextProjects);
        setProject(nextProjects.find((item) => item.id === result.project.id) ?? nextProjects[0] ?? result.project);
        setCapabilities(nextCapabilities);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [session]);
  useEffect(() => { if (project) { setData(undefined); setOnboarding(undefined); void refresh(); } }, [project, refresh]);
  useEffect(() => {
    if (!project || onboarding?.complete) return;
    const timer = window.setInterval(() => {
      void loadHostedOnboarding(session, project.id).then(setOnboarding).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [onboarding?.complete, project, session]);
  useEffect(() => {
    if (onboarding?.complete && data && data.overview.summary.evidence === 0) void refresh();
  }, [data, onboarding?.complete, refresh]);

  const navigation: Array<[HostedView, string, number?]> = [
    ["overview", "Overview"], ["agents", "Agents", data?.agents.length], ["runs", "Runs", data?.runs.length],
    ["assurance", "Assurance cases", data?.assuranceCases.filter((item) => item.status === "review_required").length],
    ["sandbox", "Sandbox certifications", data?.runs.filter(isSandboxCertificationRun).length],
    ["gates", "Release gates", data?.runs.filter((run) => run.kind === "release_gate").length],
    ["actions", "Runtime actions", data?.actions.filter((action) => action.status === "PENDING_APPROVAL").length],
    ["incidents", "Incidents", data?.incidents.filter((incident) => incident.status !== "resolved").length],
    ["evidence", "Evidence", data?.evidence.length], ["integrations", "Integrations"],
    ...(capabilities?.platformAdmin ? [["governance", "Governance"] as [HostedView, string]] : []),
  ];

  return (
    <div className="hosted-shell">
      <aside className="hosted-sidebar">
        <a className="workspace-brand" href="/">
          <BrandMark />
          <span><strong>AgentCert</strong><small>Workspace</small></span>
        </a>
        <div className="workspace-return-links"><a href="/evidence">Public evidence</a><a href="/">Product site</a></div>
        <HostedProjectSwitcher session={session} projects={projects} current={project} onSelect={setProject} onChange={(nextProjects, selected) => { setProjects(nextProjects); setProject(selected); }} />
        <nav>{navigation.map(([id, label, count]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}><span>{label}</span>{count ? <em>{count}</em> : null}</button>)}</nav>
        <div className="account-block"><span>{session.email ?? config.auth.provider}</span><button onClick={onSignOut}>Sign out</button></div>
      </aside>
      <main className="hosted-workspace">
        <header className="hosted-header"><div><span className="surface-mode">Workspace</span><span className="workspace-project">{project?.slug ?? "project"}</span><h1>{viewTitle(view)}</h1></div><button onClick={() => void refresh()} disabled={loading}>Refresh</button></header>
        {error ? <div className="console-error">{error}</div> : null}
        {!data || !project ? <div className="loading">Loading control plane...</div> : (
          <HostedViewContent view={view} data={data} project={project} session={session} onboarding={onboarding} refresh={refresh} onNavigate={setView} />
        )}
      </main>
    </div>
  );
}

function HostedViewContent({ view, data, project, session, onboarding, refresh, onNavigate }: { view: HostedView; data: ConsoleData; project: HostedProject; session: HostedSession; onboarding?: HostedOnboardingStatus; refresh: () => Promise<void>; onNavigate: (view: HostedView) => void }) {
  if (view === "overview") return <HostedOverviewView data={data} project={project} session={session} onboarding={onboarding} refresh={refresh} onNavigate={onNavigate} />;
  if (view === "agents") return <AgentsView agents={data.agents} project={project} session={session} refresh={refresh} />;
  if (view === "runs") return <HostedRunsView runs={data.runs} project={project} session={session} />;
  if (view === "assurance") return <HostedAssuranceView cases={data.assuranceCases} evidence={data.evidence} project={project} session={session} refresh={refresh} />;
  if (view === "sandbox") return <HostedSandboxView runs={data.runs.filter(isSandboxCertificationRun)} project={project} session={session} />;
  if (view === "gates") return <RunsTable runs={data.runs.filter((run) => run.kind === "release_gate")} empty="No release-gate runs have been ingested." />;
  if (view === "actions") return <ActionsView actions={data.actions} project={project} session={session} refresh={refresh} />;
  if (view === "incidents") return <IncidentsView incidents={data.incidents} operations={data.operations} project={project} session={session} refresh={refresh} />;
  if (view === "evidence") return <EvidenceView evidence={data.evidence} overview={data.overview} project={project} session={session} refresh={refresh} />;
  if (view === "governance") return <GovernanceView project={project} session={session} />;
  return <IntegrationsView project={project} session={session} operations={data.operations} refresh={refresh} />;
}

function HostedOverviewView({ data, project, session, onboarding, refresh, onNavigate }: { data: ConsoleData; project: HostedProject; session: HostedSession; onboarding?: HostedOnboardingStatus; refresh: () => Promise<void>; onNavigate: (view: HostedView) => void }) {
  const summary = data.overview.summary;
  return <>
    {onboarding ? <HostedOnboarding status={onboarding} project={project} session={session} refresh={refresh} onOpenIntegrations={() => onNavigate("integrations")} onReviewRuns={() => onNavigate("runs")} /> : null}
    <section className="trust-operations-band">
      <AlertSummary label="Production health" alert={{ status: data.operations.status, message: `Checked ${compactTime(data.operations.generatedAt)}` }} />
      <AlertSummary label="Shared coordination" alert={data.operations.alerts.redis} />
      <AlertSummary label="Webhook delivery" alert={data.operations.alerts.webhooks} />
      <AlertSummary label="Email delivery" alert={data.operations.alerts.notifications} />
      <AlertSummary label="SLO burn rate" alert={data.operations.alerts.sloBurnRate} />
      <AlertSummary label="Evidence signing" alert={data.operations.alerts.signing} />
    </section>
    <OperationsTrends operations={data.operations} />
    <section className="control-metrics">
      <ControlMetric label="Registered agents" value={summary.agents} />
      <ControlMetric label="Recent runs" value={summary.runs} detail={`${summary.passingRuns} passing`} />
      <ControlMetric label="Pending approvals" value={summary.pendingApprovals} attention={summary.pendingApprovals > 0} />
      <ControlMetric label="Open incidents" value={summary.openIncidents} attention={summary.openIncidents > 0} />
      <ControlMetric
        label="Evidence storage"
        value={compactBytes(data.overview.storage.usedBytes)}
        detail={`${summary.evidence} objects · ${compactBytes(data.overview.storage.limitBytes)} cap · ${data.overview.storage.legalHold?.status === "approved" ? "legal hold" : `${data.overview.storage.retentionDays}d retention`}`}
      />
      <ControlMetric label="Review coverage" value={percent(summary.taxonomyQuality.reviewCoverage)} detail={`${summary.taxonomyQuality.reviewedFailures}/${summary.taxonomyQuality.totalFailures} failures reviewed`} />
      <ControlMetric label="Label precision" value={percent(summary.taxonomyQuality.autoLabelPrecision)} detail={`${summary.taxonomyQuality.correctedFailures} corrections`} />
      <ControlMetric label="Correction rate" value={percent(summary.taxonomyQuality.correctionRate)} detail="Human-reviewed taxonomy" attention={summary.taxonomyQuality.correctionRate > 0.25} />
    </section>
    <section className="operations-band"><div><SectionTitle title="Runtime queue" caption="Actions waiting for a human decision" /><ActionRows actions={data.actions.filter((action) => action.status === "PENDING_APPROVAL").slice(0, 5)} /></div><div><SectionTitle title="Active incidents" caption="Open, investigating, and recovered incidents" /><IncidentRows incidents={data.incidents.filter((incident) => incident.status !== "resolved").slice(0, 5)} /></div></section>
    <section className="data-section"><SectionTitle title="Recent runs" caption="Pre-release and runtime assurance activity" /><RunsTable runs={data.runs.slice(0, 8)} /></section>
  </>;
}

function AgentsView({ agents, project, session, refresh }: { agents: HostedAgent[]; project: HostedProject; session: HostedSession; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(agents.length === 0);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    try { await createHostedAgent(session, project.id, { externalId: values.get("externalId"), name: values.get("name"), version: values.get("version"), framework: values.get("framework"), allowedPermissions: String(values.get("permissions") ?? "").split(",").map((item) => item.trim()).filter(Boolean) }); setOpen(false); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <section className="data-section"><div className="section-actions"><SectionTitle title="Agents" caption="Identities, versions, frameworks, and granted permissions" /><button className="primary-action compact" onClick={() => setOpen(!open)}>{open ? "Cancel" : "Register agent"}</button></div>{open ? <form className="inline-form" onSubmit={submit}><label>External ID<input name="externalId" required /></label><label>Name<input name="name" required /></label><label>Version<input name="version" defaultValue="0.1.0" /></label><label>Framework<input name="framework" placeholder="browser-use, LangGraph, MCP" /></label><label className="wide">Allowed permissions<input name="permissions" placeholder="MockERP:SUBMIT, Email:SEND" /></label>{error ? <div className="form-error wide">{error}</div> : null}<button className="primary-action compact">Create</button></form> : null}<div className="entity-list">{agents.map((agent) => <article key={agent.id}><div><strong>{agent.name}</strong><span>{agent.externalId} · {agent.framework ?? "custom"}</span></div><div><b>{agent.version}</b><span>{agent.allowedPermissions.length ? agent.allowedPermissions.join(", ") : "No permissions granted"}</span></div></article>)}{agents.length === 0 ? <EmptyHosted text="No agents registered yet." /> : null}</div></section>;
}

function RunsTable({ runs, empty = "No runs recorded yet." }: { runs: HostedRun[]; empty?: string }) {
  if (runs.length === 0) return <EmptyHosted text={empty} />;
  return <div className="ops-table"><div className="ops-row head"><span>Run</span><span>Kind</span><span>Status</span><span>Score</span><span>Started</span></div>{runs.map((run) => <div className="ops-row" key={run.id}><strong>{run.externalId}</strong><span>{run.kind.replace("_", " ")}</span><Status value={run.status} /><span>{run.score ?? "-"}</span><span>{compactTime(run.startedAt)}</span></div>)}</div>;
}

function ActionsView({ actions, project, session, refresh }: { actions: HostedAction[]; project: HostedProject; session: HostedSession; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<string>(); const [error, setError] = useState<string>();
  async function review(actionId: string, decision: "approve" | "reject") { setBusy(actionId); setError(undefined); try { await reviewHostedAction(session, project.id, actionId, decision); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(undefined); } }
  return <section className="data-section"><SectionTitle title="Runtime actions" caption="Policy decisions, human approvals, and observed-state verification" />{error ? <div className="console-error">{error}</div> : null}<div className="action-list">{actions.map((action) => <article key={action.id}><div className="action-main"><div><span className="eyebrow">{action.actionType} · {action.targetSystem}</span><strong>{action.externalId}</strong></div><Status value={action.status} /><p>{action.reasons.join(" ")}</p></div><dl><div><dt>Risk</dt><dd>{action.riskLevel} ({action.riskScore})</dd></div><div><dt>Decision</dt><dd>{action.decision}</dd></div><div><dt>Verification</dt><dd>{action.verificationSuccess === undefined ? "Not submitted" : action.verificationSuccess ? "Matched" : "Mismatch"}</dd></div></dl>{action.status === "PENDING_APPROVAL" ? <div className="approval-actions"><button disabled={busy === action.id} onClick={() => void review(action.id, "reject")}>Reject</button><button className="primary-action compact" disabled={busy === action.id} onClick={() => void review(action.id, "approve")}>Approve</button></div> : null}</article>)}{actions.length === 0 ? <EmptyHosted text="No runtime actions have been proposed." /> : null}</div></section>;
}

function IncidentsView({ incidents, operations, project, session, refresh }: {
  incidents: HostedIncident[];
  operations: HostedOperations;
  project: HostedProject;
  session: HostedSession;
  refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function transition(incident: HostedIncident, action: "acknowledge" | "resolve") {
    if (selected !== incident.id || reason.trim().length < 10) {
      setSelected(incident.id);
      setError("Enter an operator rationale of at least 10 characters.");
      return;
    }
    setBusy(true); setError(undefined);
    try {
      if (action === "acknowledge") await acknowledgeHostedIncident(session, project.id, incident.id, reason);
      else await resolveHostedIncident(session, project.id, incident.id, reason);
      setSelected(undefined); setReason(""); await refresh();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }
  return <div className="incident-workspace">
    <section className="data-section"><SectionTitle title="Incident lifecycle" caption="Human acknowledgement, deterministic recovery evidence, and explicit resolution" />
      {error ? <div className="console-error">{error}</div> : null}
      <div className="incident-ledger">{incidents.map((incident) => <article key={incident.id}>
        <div className="incident-heading"><div><span className="eyebrow">{incident.type} · {incident.severity}</span><strong>{incident.summary}</strong></div><Status value={incident.status} /></div>
        <p>{incident.firstDivergence ?? "No first divergence recorded."}</p>
        <dl><div><dt>Occurrences</dt><dd>{incident.occurrenceCount}</dd></div><div><dt>Passing streak</dt><dd>{incident.consecutivePasses}/2</dd></div><div><dt>Updated</dt><dd>{compactTime(incident.updatedAt ?? incident.createdAt)}</dd></div><div><dt>GitHub</dt><dd>{incident.githubIssueUrl ? <a href={incident.githubIssueUrl} target="_blank" rel="noreferrer">#{incident.githubIssueNumber}</a> : "Not linked"}</dd></div></dl>
        {selected === incident.id ? <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Record the investigation or resolution rationale" /> : null}
        {incident.fingerprint && incident.status === "open" ? <button className="primary-action compact" disabled={busy} onClick={() => void transition(incident, "acknowledge")}>Acknowledge and investigate</button> : null}
        {incident.fingerprint && incident.status === "recovered" ? <button className="primary-action compact" disabled={busy} onClick={() => void transition(incident, "resolve")}>Resolve after review</button> : null}
      </article>)}{incidents.length === 0 ? <EmptyHosted text="No incidents recorded." /> : null}</div>
    </section>
    <section className="data-section"><SectionTitle title="Transition evidence" caption="Append-only state changes for the current operational incident" />
      <div className="transition-ledger">{operations.incidents.transitions.map((transition) => <div key={transition.id}><span>{compactTime(transition.occurredAt)}</span><strong>{transition.fromStatus ?? "created"} → {transition.toStatus}</strong><p>{transition.reason}</p><small>{transition.actorEmail ?? transition.actorType}</small></div>)}{operations.incidents.transitions.length === 0 ? <EmptyHosted text="No operational incident transitions yet." /> : null}</div>
    </section>
  </div>;
}
function EvidenceView({ evidence, overview, project, session, refresh }: {
  evidence: HostedEvidence[];
  overview: HostedOverview;
  project: HostedProject;
  session: HostedSession;
  refresh: () => Promise<void>;
}) {
  const legalHold = overview.storage.legalHold;
  const canApply = !legalHold || legalHold.status === "rejected" || legalHold.status === "released";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function apply(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await requestHostedLegalHold(session, project.id, reason); setReason(""); await refresh(); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }
  return <div className="evidence-registry-layout">
    <section className={`legal-hold-panel ${legalHold?.status ?? "none"}`}>
      <div><span className="eyebrow">Retention control</span><h2>{legalHold?.status === "approved" ? "Legal hold active" : `${overview.storage.retentionDays}-day default retention`}</h2>
        <p>{legalHold?.status === "approved" ? "Automatic evidence deletion is paused for this project until a platform administrator releases the hold." : legalHold?.status === "requested" ? "The application is awaiting platform review. Normal retention continues until approval." : "Evidence is deleted after the retention window. Enterprise projects may apply for a reviewed legal hold."}</p></div>
      {legalHold ? <dl><div><dt>Status</dt><dd><Status value={legalHold.status} /></dd></div><div><dt>Requested</dt><dd>{compactTime(legalHold.requestedAt)}</dd></div>{legalHold.reviewNote ? <div><dt>Review</dt><dd>{legalHold.reviewNote}</dd></div> : null}</dl> : null}
      {canApply ? <form onSubmit={apply}><label><span>Legal hold reason</span><textarea required minLength={20} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Describe the legal matter, preservation scope, and enterprise contact." /></label>{error ? <div className="form-error">{error}</div> : null}<button className="primary-action compact" disabled={busy}>{busy ? "Submitting..." : "Apply for legal hold"}</button></form> : null}
    </section>
    <section className="data-section"><SectionTitle title="Evidence" caption="Private artifacts with SHA-256 provenance" /><div className="entity-list">{evidence.map((item) => <article key={item.id}><div><strong>{item.fileName}</strong><span>{item.kind} · {item.schemaVersion}</span></div><div><b>{compactBytes(item.sizeBytes)}</b><span className="hash">{item.sha256.slice(0, 20)}...</span></div><button onClick={() => void downloadEvidence(session, evidenceContentUrl(project.id, item.id), item.fileName)}>Open</button></article>)}{evidence.length === 0 ? <EmptyHosted text="No evidence uploaded yet." /> : null}</div></section>
  </div>;
}

function IntegrationsView({ project, session, operations, refresh }: { project: HostedProject; session: HostedSession; operations: HostedOperations; refresh: () => Promise<void> }) {
  const [secret, setSecret] = useState<string>(); const [copied, setCopied] = useState(false); const [error, setError] = useState<string>(); const [keys, setKeys] = useState<HostedApiKey[]>([]); const [pendingRevoke, setPendingRevoke] = useState<string>();
  const [keyMode, setKeyMode] = useState<"ingest" | "read-only">("ingest");
  const [testReceiverEnabled, setTestReceiverEnabled] = useState(false);
  const [testReceiverBusy, setTestReceiverBusy] = useState(false);
  const refreshKeys = useCallback(async () => { try { setKeys(await loadHostedApiKeys(session, project.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }, [project.id, session]);
  useEffect(() => { void refreshKeys(); }, [refreshKeys]);
  async function createKey() {
    try {
      const scopes = keyMode === "read-only"
        ? ["agents:read", "runs:read", "actions:read", "evidence:read"]
        : ["agents:read", "runs:read", "runs:write", "events:write", "actions:read", "actions:write", "evidence:read", "evidence:write"];
      const result = await createHostedApiKey(session, project.id, keyMode === "read-only" ? "Read-only integration" : "Ingest integration", scopes);
      setSecret(result.secret);
      await Promise.all([refreshKeys(), refresh()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function revokeKey(id: string) { try { await revokeHostedApiKey(session, project.id, id); setPendingRevoke(undefined); await refreshKeys(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }
  async function retryWebhook(jobId: string) { try { await retryHostedWebhookJob(session, project.id, jobId); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }
  async function retryNotification(jobId: string) { try { await retryHostedNotificationJob(session, project.id, jobId); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }
  async function enableTestReceiver() { setTestReceiverBusy(true); try { await createHostedTestWebhook(session, project.id); setTestReceiverEnabled(true); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setTestReceiverBusy(false); } }
  const endpoint = window.location.origin;
  return <div className="integration-layout"><section className="connection-quickstart"><div><span className="eyebrow">Recommended</span><h2>Connect this project once</h2><p>The CLI validates the key before storing it in your user profile. Future push commands reuse the saved connection.</p></div><pre>{`npx agentcert connect --server ${endpoint} --project ${project.id}`}</pre></section><section className="data-section"><div className="section-actions"><SectionTitle title="API access" caption="Project-scoped credentials for agents and CI" /><div className="key-create-controls"><select value={keyMode} onChange={(event) => setKeyMode(event.target.value as "ingest" | "read-only")}><option value="ingest">Ingest + read</option><option value="read-only">Read only</option></select><button className="primary-action compact" onClick={() => void createKey()}>Create API key</button></div></div>{secret ? <div className="secret-box"><div><strong>Copy this key now. It will not be shown again.</strong><button onClick={() => { void navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? "Copied" : "Copy key"}</button></div><code>{secret}</code></div> : null}{error ? <div className="form-error">{error}</div> : null}<div className="entity-list key-list">{keys.map((key) => <article key={key.id}><div><strong>{key.name}</strong><span>{key.prefix}...</span></div><div><b>{key.revokedAt ? "Revoked" : "Active"}</b><span>{key.scopes.join(", ")}</span></div>{key.revokedAt ? null : pendingRevoke === key.id ? <div className="key-revoke-actions"><button onClick={() => setPendingRevoke(undefined)}>Cancel</button><button className="danger-action" onClick={() => void revokeKey(key.id)}>Confirm revoke</button></div> : <button onClick={() => setPendingRevoke(key.id)}>Revoke</button>}</article>)}{keys.length === 0 ? <EmptyHosted text="No API keys created yet. Create one, then run the connection command above." /> : null}</div></section><section className="data-section"><div className="section-actions"><SectionTitle title="Trust operations" caption="Durable webhook and email delivery with historical signing-key state" /><button className="primary-action compact" disabled={testReceiverBusy || testReceiverEnabled} onClick={() => void enableTestReceiver()}>{testReceiverEnabled ? "Self-test receiver ready" : testReceiverBusy ? "Enabling..." : "Enable self-test receiver"}</button></div><div className="trust-ops-list"><article><div><strong>Coordination backend</strong><span>{operations.coordination.backend} / {operations.coordination.state}</span></div><Status value={operations.status} /></article><article><div><strong>Signing key</strong><span>{operations.signing.activeKey?.keyId ?? "Not configured"}</span></div><span>{operations.signing.historicalKeys} retained</span></article>{operations.webhooks.deadLetters.map((job) => <article key={job.id}><div><strong>{job.eventType}</strong><span>{job.lastError ?? "Delivery exhausted"}</span></div><div className="key-revoke-actions"><Status value={job.status} /><button onClick={() => void retryWebhook(job.id)}>Retry webhook</button></div></article>)}{operations.notifications.deadLetters.map((job) => <article key={job.id}><div><strong>{job.subject}</strong><span>{job.recipient}: {job.lastError ?? "Delivery exhausted"}</span></div><div className="key-revoke-actions"><Status value={job.status} /><button onClick={() => void retryNotification(job.id)}>Retry email</button></div></article>)}{operations.webhooks.deadLetters.length + operations.notifications.deadLetters.length === 0 ? <EmptyHosted text="No deliveries are in a dead-letter queue." /> : null}</div></section><NotificationDestinations project={project} session={session} operations={operations} refresh={refresh} /><section className="data-section"><SectionTitle title="First upload" caption="Run locally, then send the validated evidence bundle" /><pre>{`npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --push\n# or: npx agentcert push --evidence .agentcert/latest/agentcert-evidence.json`}</pre></section><section className="data-section"><SectionTitle title="CI environment" caption="Use secret-manager variables for ephemeral runners and SDK integrations" /><pre>{`AGENTCERT_BASE_URL=${endpoint}\nAGENTCERT_PROJECT_ID=${project.id}\nAGENTCERT_API_KEY=ac_live_...`}</pre></section></div>;
}

function NotificationDestinations({ project, session, operations, refresh }: { project: HostedProject; session: HostedSession; operations: HostedOperations; refresh: () => Promise<void> }) {
  const alertTypes: HostedNotificationAlertType[] = ["incident_opened", "incident_regressed", "incident_recovered", "incident_resolved", "slo_burn_rate"];
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState<HostedNotificationAlertType[]>(alertTypes);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined); setMessage(undefined);
    try {
      await createHostedNotificationDestination(session, project.id, email, selected);
      setEmail(""); setMessage("Verification email sent. Alerts begin only after the recipient verifies the address."); await refresh();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }
  async function disable(id: string) {
    setBusy(true); setError(undefined);
    try { await disableHostedNotificationDestination(session, project.id, id); await refresh(); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }
  async function sendTest(id: string) {
    setTestingId(id); setError(undefined); setMessage(undefined);
    try {
      await sendHostedTestNotification(session, project.id, id);
      setMessage("Test alert queued. Delivery status will update below without creating an Incident.");
      await refresh();
      window.setTimeout(() => { void refresh(); }, 2_000);
      window.setTimeout(() => { void refresh(); }, 5_000);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setTestingId(undefined); }
  }
  return <section className="data-section notification-destinations"><SectionTitle title="Email alerts" caption="Verified recipients choose incident alerts; AgentCert owns provider credentials" />
    {!operations.notifications.configured ? <div className="form-message">Platform email delivery is not configured yet.</div> : <form onSubmit={submit}><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="security@example.com" /></label><div className="alert-type-options">{alertTypes.map((type) => <label key={type}><input type="checkbox" checked={selected.includes(type)} onChange={() => setSelected((current) => current.includes(type) ? current.filter((item) => item !== type) : [...current, type])} />{type.replace("incident_", "").replace("_", " ")}</label>)}</div><button className="primary-action compact" disabled={busy || selected.length === 0}>Send verification</button></form>}
    {message ? <div className="form-message">{message}</div> : null}{error ? <div className="form-error">{error}</div> : null}
    <div className="entity-list">{operations.notifications.destinations.map((destination) => {
      const testJob = operations.notifications.recentJobs.find((job) => job.destinationId === destination.id && job.alertType === "test_alert");
      const testDelivery = testJob ? operations.notifications.recentDeliveries.find((delivery) => delivery.jobId === testJob.id) : undefined;
      const testStatus = testDelivery?.status ?? testJob?.status;
      return <article key={destination.id}><div><strong>{destination.email}</strong><span>{destination.alertTypes.map((type) => type.replace("incident_", "")).join(", ")}</span></div><div className="notification-health"><Status value={destination.status} />{testStatus ? <span>Last test: <Status value={testStatus} /> {testDelivery ? compactTime(testDelivery.attemptedAt) : "queued"}</span> : <span>No test delivery recorded.</span>}</div><div className="notification-actions">{destination.status === "active" ? <button disabled={Boolean(testingId)} onClick={() => void sendTest(destination.id)}>{testingId === destination.id ? "Queueing..." : "Send test alert"}</button> : null}{destination.status === "disabled" ? null : <button disabled={busy || Boolean(testingId)} onClick={() => void disable(destination.id)}>Disable</button>}</div></article>;
    })}{operations.notifications.destinations.length === 0 ? <EmptyHosted text="No alert recipients configured." /> : null}</div>
  </section>;
}

function GovernanceView({ project, session }: { project: HostedProject; session: HostedSession }) {
  const [holds, setHolds] = useState<HostedLegalHoldRequest[]>([]);
  const [report, setReport] = useState<HostedRetentionReport>();
  const [selected, setSelected] = useState<string>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try { const [nextHolds, nextReport] = await Promise.all([loadAdminLegalHolds(session), loadRetentionReport(session, project.id)]); setHolds(nextHolds); setReport(nextReport); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [project.id, session]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function decide(request: HostedLegalHoldRequest, decision: "approve" | "reject" | "release") {
    if (selected !== request.id || note.trim().length < 10) { setSelected(request.id); setError("Enter a review note of at least 10 characters before recording the decision."); return; }
    try { await reviewAdminLegalHold(session, request.id, decision, note); setSelected(undefined); setNote(""); setError(undefined); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <div className="governance-layout">
    {error ? <div className="console-error">{error}</div> : null}
    <HostedPilotReport session={session} />
    <section className="data-section"><div className="section-actions"><SectionTitle title="Legal hold review" caption="Independent approval, rejection, and release decisions" /><button onClick={() => void downloadRetentionReport(session, project.id)}>Export retention report</button></div>
      <div className="governance-list">{holds.map((hold) => <article key={hold.id}><div><span className="eyebrow">{hold.projectId}</span><strong>{hold.reason}</strong><small>Requested by {hold.requestedByEmail ?? "unknown"} on {compactTime(hold.requestedAt)}</small></div><Status value={hold.status} />
        <div className="governance-actions"><button onClick={() => void downloadAdminLegalHoldReport(session, hold.id)}>Export report</button>{(hold.status === "requested" || hold.status === "approved") ? <>{selected === hold.id ? <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Decision rationale and preservation scope" /> : null}{hold.status === "requested" ? <><button onClick={() => void decide(hold, "reject")}>Reject</button><button className="primary-action compact" onClick={() => void decide(hold, "approve")}>Approve</button></> : <button className="danger-action" onClick={() => void decide(hold, "release")}>Release hold</button>}</> : null}</div>
      </article>)}{holds.length === 0 ? <EmptyHosted text="No legal hold requests have been submitted." /> : null}</div>
    </section>
    <section className="data-section"><SectionTitle title="Deletion journal" caption="Immutable retention cleanup outcomes for the current project" /><div className="ops-table deletion-table"><div className="ops-row head"><span>Evidence</span><span>Kind</span><span>Outcome</span><span>Size</span><span>Occurred</span></div>{report?.deletionJournal.map((item) => <div className="ops-row" key={item.id}><strong>{item.fileName}</strong><span>{item.kind}</span><Status value={item.outcome} /><span>{compactBytes(item.sizeBytes)}</span><span>{compactTime(item.occurredAt)}</span></div>)}</div>{report?.deletionJournal.length === 0 ? <EmptyHosted text="No evidence deletions have been recorded." /> : null}</section>
  </div>;
}

function ActionRows({ actions }: { actions: HostedAction[] }) { return <div className="compact-list">{actions.map((action) => <div key={action.id}><strong>{action.externalId}</strong><span>{action.actionType} · {action.riskLevel}</span><Status value={action.status} /></div>)}{actions.length === 0 ? <EmptyHosted text="No actions waiting for approval." /> : null}</div>; }
function IncidentRows({ incidents }: { incidents: HostedIncident[] }) { return <div className="compact-list">{incidents.map((incident) => <div key={incident.id}><strong>{incident.summary}</strong><span>{incident.type}{incident.firstDivergence ? ` · ${incident.firstDivergence}` : ""}</span><Status value={incident.status} /></div>)}{incidents.length === 0 ? <EmptyHosted text="No active incidents." /> : null}</div>; }
function ControlMetric({ label, value, detail, attention }: { label: string; value: number | string; detail?: string; attention?: boolean }) { return <div className={attention ? "attention" : ""}><span>{label}</span><strong>{value}</strong><em>{detail ?? "Current project"}</em></div>; }
function AlertSummary({ label, alert }: { label: string; alert: { status: string; message: string } }) { return <div><span>{label}</span><strong><Status value={alert.status} /></strong><em>{alert.message}</em></div>; }
function OperationsTrends({ operations }: { operations: HostedOperations }) {
  const maxLatency = Math.max(1, ...operations.trends.webhooks.map((item) => item.p95LatencyMs));
  return <section className="operations-trends">
    <div className="trend-heading"><div><span className="eyebrow">Last 7 days</span><h2>Trust health history</h2><p>{operations.alerts.scheduledSmoke.message}</p></div><Status value={operations.alerts.scheduledSmoke.status} /></div>
    <div className="slo-grid">{operations.slo.windows.map((window) => <article key={window.days}><div><span>{window.days}-day SLO</span><strong>{window.attainment === null ? "No data" : percent(window.attainment)}</strong></div><dl><div><dt>Target</dt><dd>{percent(operations.slo.objective)}</dd></div><div><dt>Error budget</dt><dd>{window.errorBudgetRemaining === null ? "-" : percent(window.errorBudgetRemaining)}</dd></div><div><dt>Burn rate</dt><dd>{window.burnRate === null ? "-" : `${window.burnRate.toFixed(1)}x`}</dd></div><div><dt>Samples</dt><dd>{window.total}</dd></div></dl></article>)}{operations.slo.burnRate.windows.map((window) => <article key={window.label}><div><span>{window.label} alert window</span><strong>{window.burnRate === null ? "No data" : `${window.burnRate.toFixed(1)}x`}</strong></div><dl><div><dt>Status</dt><dd><Status value={operations.slo.burnRate.status} /></dd></div><div><dt>Errors</dt><dd>{window.failed}/{window.total}</dd></div></dl></article>)}</div>
    <div className="trend-grid">
      <div className="trend-series"><div className="trend-summary"><strong>{percent(operations.trends.summary.smokeSuccessRate)}</strong><span>production smoke pass rate</span></div><div className="trend-bars" aria-label="Daily production smoke pass rate">{operations.trends.health.map((item) => <div key={item.date} title={`${item.date}: ${item.passed}/${item.total} passed`}><i className={item.failed > 0 ? "failed" : item.total === 0 ? "empty" : "passed"} style={{ height: `${item.total ? Math.max(8, item.successRate * 100) : 4}%` }} /><small>{item.date.slice(5)}</small></div>)}</div></div>
      <div className="trend-series"><div className="trend-summary webhook"><span><strong>{compactDuration(operations.trends.summary.p95LatencyMs)}</strong><em>p95 latency</em></span><span><strong>{percent(operations.trends.summary.retryRate)}</strong><em>retry rate</em></span><span><strong>{operations.trends.summary.deadLetterRate === 0 ? "0" : percent(operations.trends.summary.deadLetterRate)}</strong><em>DLQ rate</em></span></div><div className="trend-bars latency" aria-label="Daily webhook p95 latency">{operations.trends.webhooks.map((item) => <div key={item.date} title={`${item.date}: p95 ${compactDuration(item.p95LatencyMs)}, ${item.retried} retried, ${item.deadLetter} DLQ`}><i className={item.deadLetter > 0 ? "failed" : item.retried > 0 ? "warning" : "passed"} style={{ height: `${Math.max(4, item.p95LatencyMs / maxLatency * 100)}%` }} /><small>{item.date.slice(5)}</small></div>)}</div></div>
    </div>
  </section>;
}
function SectionTitle({ title, caption }: { title: string; caption: string }) { return <div className="section-title"><h2>{title}</h2><p>{caption}</p></div>; }
function Status({ value }: { value: string }) { return <span className={`hosted-status ${value.toLowerCase().replace(/_/g, "-")}`}>{value.replace(/_/g, " ")}</span>; }
function EmptyHosted({ text }: { text: string }) { return <div className="hosted-empty">{text}</div>; }
function viewTitle(view: HostedView): string { return ({ overview: "Operational overview", agents: "Agent registry", runs: "Assurance runs", assurance: "Assurance lifecycle", sandbox: "Sandbox certifications", gates: "Release gates", actions: "Runtime actions", incidents: "Incident ledger", evidence: "Evidence registry", integrations: "Integrations", governance: "Governance administration" })[view]; }
function compactTime(value: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function compactBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function percent(value: number): string { return `${Math.round(value * 100)}%`; }
function compactDuration(value: number): string { return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms`; }
async function downloadEvidence(session: HostedSession, url: string, fileName: string) { const response = await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}` } }); if (!response.ok) throw new Error("Evidence download failed."); const href = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = href; link.download = fileName; link.click(); URL.revokeObjectURL(href); }
