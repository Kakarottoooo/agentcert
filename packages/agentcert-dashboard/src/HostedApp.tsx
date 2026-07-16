import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  bootstrap,
  createHostedAgent,
  createHostedApiKey,
  createHostedTestWebhook,
  downloadRetentionReport,
  downloadAdminLegalHoldReport,
  evidenceContentUrl,
  loadHostedActions,
  loadHostedApiKeys,
  loadHostedAgents,
  loadHostedEvidence,
  loadHostedIncidents,
  loadHostedRuns,
  loadHostedCapabilities,
  loadAdminLegalHolds,
  loadRetentionReport,
  loadOverview,
  loadHostedOperations,
  readHostedAuthCallbackError,
  readHostedSession,
  requestHostedLegalHold,
  resendSignUpConfirmation,
  reviewHostedAction,
  reviewAdminLegalHold,
  revokeHostedApiKey,
  retryHostedWebhookJob,
  signIn,
  signOut,
  signUp,
  type HostedAction,
  type HostedAgent,
  type HostedApiKey,
  type HostedConfig,
  type HostedCapabilities,
  type HostedEvidence,
  type HostedIncident,
  type HostedOverview,
  type HostedOperations,
  type HostedProject,
  type HostedRun,
  type HostedSession,
  type HostedLegalHoldRequest,
  type HostedRetentionReport,
} from "./hosted-api";
import HostedRunsView from "./HostedRunsView";

type HostedView = "overview" | "agents" | "runs" | "gates" | "actions" | "incidents" | "evidence" | "integrations" | "governance";

interface ConsoleData {
  overview: HostedOverview;
  operations: HostedOperations;
  agents: HostedAgent[];
  runs: HostedRun[];
  actions: HostedAction[];
  incidents: HostedIncident[];
  evidence: HostedEvidence[];
}

export default function HostedApp({ config }: { config: HostedConfig }) {
  useEffect(() => { document.title = "AgentCert Control Plane"; }, []);
  const [session, setSession] = useState(() => readHostedSession(config));
  if (!session) return <AuthScreen config={config} onAuthenticated={setSession} />;
  return <HostedConsole config={config} session={session} onSignOut={() => { void signOut(config, session).finally(() => setSession(undefined)); }} />;
}

function AuthScreen({ config, onAuthenticated }: { config: HostedConfig; onAuthenticated: (session: HostedSession) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
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
    <main className="auth-page">
      <section className="auth-intro">
        <div className="hosted-brand">AgentCert</div>
        <h1>Independent evidence for agents that take real actions.</h1>
        <p>Gate releases, review high-risk actions, verify outcomes, and retain evidence in one control plane.</p>
        <ol>
          <li><strong>Know</strong> what every agent is allowed to do.</li>
          <li><strong>Prove</strong> reliability before release.</li>
          <li><strong>Decide</strong> whether a live action should proceed.</li>
          <li><strong>Trace</strong> what happened and who approved it.</li>
        </ol>
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
        <p className="auth-note">Registration is open. Confirmed accounts receive an isolated organization and first project.</p>
      </section>
    </main>
  );
}

function HostedConsole({ config, session, onSignOut }: { config: HostedConfig; session: HostedSession; onSignOut: () => void }) {
  const [view, setView] = useState<HostedView>("overview");
  const [project, setProject] = useState<HostedProject>();
  const [data, setData] = useState<ConsoleData>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<HostedCapabilities>();

  const refresh = useCallback(async () => {
    if (!project) return;
    setLoading(true); setError(undefined);
    try {
      const [overview, operations, agents, runs, actions, incidents, evidence] = await Promise.all([
        loadOverview(session, project.id), loadHostedOperations(session, project.id), loadHostedAgents(session, project.id), loadHostedRuns(session, project.id),
        loadHostedActions(session, project.id), loadHostedIncidents(session, project.id), loadHostedEvidence(session, project.id),
      ]);
      setData({ overview, operations, agents, runs, actions, incidents, evidence });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [project, session]);

  useEffect(() => {
    Promise.all([bootstrap(session), loadHostedCapabilities(session)])
      .then(([result, nextCapabilities]) => { setProject(result.project); setCapabilities(nextCapabilities); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [session]);
  useEffect(() => { if (project) void refresh(); }, [project, refresh]);

  const navigation: Array<[HostedView, string, number?]> = [
    ["overview", "Overview"], ["agents", "Agents", data?.agents.length], ["runs", "Runs", data?.runs.length],
    ["gates", "Release gates", data?.runs.filter((run) => run.kind === "release_gate").length],
    ["actions", "Runtime actions", data?.actions.filter((action) => action.status === "PENDING_APPROVAL").length],
    ["incidents", "Incidents", data?.incidents.filter((incident) => incident.status === "open").length],
    ["evidence", "Evidence", data?.evidence.length], ["integrations", "Integrations"],
    ...(capabilities?.platformAdmin ? [["governance", "Governance"] as [HostedView, string]] : []),
  ];

  return (
    <div className="hosted-shell">
      <aside className="hosted-sidebar">
        <div className="hosted-brand">AgentCert</div>
        <div className="project-switcher"><span>Project</span><strong>{project?.name ?? "Loading..."}</strong></div>
        <nav>{navigation.map(([id, label, count]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}><span>{label}</span>{count ? <em>{count}</em> : null}</button>)}</nav>
        <div className="account-block"><span>{session.email ?? config.auth.provider}</span><button onClick={onSignOut}>Sign out</button></div>
      </aside>
      <main className="hosted-workspace">
        <header className="hosted-header"><div><span className="eyebrow">{project?.slug ?? "workspace"}</span><h1>{viewTitle(view)}</h1></div><button onClick={() => void refresh()} disabled={loading}>Refresh</button></header>
        {error ? <div className="console-error">{error}</div> : null}
        {!data || !project ? <div className="loading">Loading control plane...</div> : (
          <HostedViewContent view={view} data={data} project={project} session={session} refresh={refresh} onNavigate={setView} />
        )}
      </main>
    </div>
  );
}

function HostedViewContent({ view, data, project, session, refresh, onNavigate }: { view: HostedView; data: ConsoleData; project: HostedProject; session: HostedSession; refresh: () => Promise<void>; onNavigate: (view: HostedView) => void }) {
  if (view === "overview") return <HostedOverviewView data={data} project={project} onNavigate={onNavigate} />;
  if (view === "agents") return <AgentsView agents={data.agents} project={project} session={session} refresh={refresh} />;
  if (view === "runs") return <HostedRunsView runs={data.runs} project={project} session={session} />;
  if (view === "gates") return <RunsTable runs={data.runs.filter((run) => run.kind === "release_gate")} empty="No release-gate runs have been ingested." />;
  if (view === "actions") return <ActionsView actions={data.actions} project={project} session={session} refresh={refresh} />;
  if (view === "incidents") return <IncidentsView incidents={data.incidents} />;
  if (view === "evidence") return <EvidenceView evidence={data.evidence} overview={data.overview} project={project} session={session} refresh={refresh} />;
  if (view === "governance") return <GovernanceView project={project} session={session} />;
  return <IntegrationsView project={project} session={session} operations={data.operations} refresh={refresh} />;
}

function HostedOverviewView({ data, project, onNavigate }: { data: ConsoleData; project: HostedProject; onNavigate: (view: HostedView) => void }) {
  const summary = data.overview.summary;
  const firstEvidenceReady = summary.runs > 0 && summary.evidence > 0;
  return <>
    <section className={`onboarding-band ${firstEvidenceReady ? "complete" : ""}`}>
      <div className="onboarding-copy">
        <span className="eyebrow">{firstEvidenceReady ? "Connection verified" : "First evidence"}</span>
        <h2>{firstEvidenceReady ? "This project is receiving AgentCert evidence." : "Connect an external agent in three steps."}</h2>
        <p>{firstEvidenceReady ? `${summary.runs} runs and ${summary.evidence} evidence objects are available for review.` : "Create a project key, connect the CLI, then push one deterministic run. The API key remains project-scoped and cannot approve runtime actions."}</p>
      </div>
      {firstEvidenceReady ? <button onClick={() => onNavigate("runs")}>Review runs</button> : <button className="primary-action compact" onClick={() => onNavigate("integrations")}>Open integrations</button>}
      <ol>
        <li className="done"><b>1</b><span><strong>Workspace ready</strong><small>{project.name}</small></span></li>
        <li className={firstEvidenceReady ? "done" : ""}><b>2</b><span><strong>CLI connected</strong><small>Validated project credentials</small></span></li>
        <li className={firstEvidenceReady ? "done" : ""}><b>3</b><span><strong>Evidence received</strong><small>Run, report, and provenance</small></span></li>
      </ol>
    </section>
    <section className="trust-operations-band">
      <AlertSummary label="Production health" alert={{ status: data.operations.status, message: `Checked ${compactTime(data.operations.generatedAt)}` }} />
      <AlertSummary label="Shared coordination" alert={data.operations.alerts.redis} />
      <AlertSummary label="Webhook delivery" alert={data.operations.alerts.webhooks} />
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
    <section className="operations-band"><div><SectionTitle title="Runtime queue" caption="Actions waiting for a human decision" /><ActionRows actions={data.actions.filter((action) => action.status === "PENDING_APPROVAL").slice(0, 5)} /></div><div><SectionTitle title="Open incidents" caption="Failed runs and verification gaps" /><IncidentRows incidents={data.incidents.filter((incident) => incident.status === "open").slice(0, 5)} /></div></section>
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

function IncidentsView({ incidents }: { incidents: HostedIncident[] }) { return <section className="data-section"><SectionTitle title="Incidents" caption="Failed runs, verification gaps, and first divergence" /><IncidentRows incidents={incidents} /></section>; }
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
  async function createKey() { try { const scopes = keyMode === "read-only" ? ["agents:read", "runs:read", "actions:read", "evidence:read"] : ["agents:read", "runs:read", "runs:write", "events:write", "actions:read", "actions:write", "evidence:read", "evidence:write"]; const result = await createHostedApiKey(session, project.id, keyMode === "read-only" ? "Read-only integration" : "Ingest integration", scopes); setSecret(result.secret); await refreshKeys(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }
  async function revokeKey(id: string) { try { await revokeHostedApiKey(session, project.id, id); setPendingRevoke(undefined); await refreshKeys(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }
  async function retryWebhook(jobId: string) { try { await retryHostedWebhookJob(session, project.id, jobId); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }
  async function enableTestReceiver() { setTestReceiverBusy(true); try { await createHostedTestWebhook(session, project.id); setTestReceiverEnabled(true); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setTestReceiverBusy(false); } }
  const endpoint = window.location.origin;
  return <div className="integration-layout"><section className="connection-quickstart"><div><span className="eyebrow">Recommended</span><h2>Connect this project once</h2><p>The CLI validates the key before storing it in your user profile. Future push commands reuse the saved connection.</p></div><pre>{`npx agentcert connect --server ${endpoint} --project ${project.id}`}</pre></section><section className="data-section"><div className="section-actions"><SectionTitle title="API access" caption="Project-scoped credentials for agents and CI" /><div className="key-create-controls"><select value={keyMode} onChange={(event) => setKeyMode(event.target.value as "ingest" | "read-only")}><option value="ingest">Ingest + read</option><option value="read-only">Read only</option></select><button className="primary-action compact" onClick={() => void createKey()}>Create API key</button></div></div>{secret ? <div className="secret-box"><div><strong>Copy this key now. It will not be shown again.</strong><button onClick={() => { void navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? "Copied" : "Copy key"}</button></div><code>{secret}</code></div> : null}{error ? <div className="form-error">{error}</div> : null}<div className="entity-list key-list">{keys.map((key) => <article key={key.id}><div><strong>{key.name}</strong><span>{key.prefix}...</span></div><div><b>{key.revokedAt ? "Revoked" : "Active"}</b><span>{key.scopes.join(", ")}</span></div>{key.revokedAt ? null : pendingRevoke === key.id ? <div className="key-revoke-actions"><button onClick={() => setPendingRevoke(undefined)}>Cancel</button><button className="danger-action" onClick={() => void revokeKey(key.id)}>Confirm revoke</button></div> : <button onClick={() => setPendingRevoke(key.id)}>Revoke</button>}</article>)}{keys.length === 0 ? <EmptyHosted text="No API keys created yet. Create one, then run the connection command above." /> : null}</div></section><section className="data-section"><div className="section-actions"><SectionTitle title="Trust operations" caption="Webhook delivery and historical signing-key state" /><button className="primary-action compact" disabled={testReceiverBusy || testReceiverEnabled} onClick={() => void enableTestReceiver()}>{testReceiverEnabled ? "Self-test receiver ready" : testReceiverBusy ? "Enabling..." : "Enable self-test receiver"}</button></div><div className="trust-ops-list"><article><div><strong>Coordination backend</strong><span>{operations.coordination.backend} / {operations.coordination.state}</span></div><Status value={operations.status} /></article><article><div><strong>Signing key</strong><span>{operations.signing.activeKey?.keyId ?? "Not configured"}</span></div><span>{operations.signing.historicalKeys} retained</span></article>{operations.webhooks.deadLetters.map((job) => <article key={job.id}><div><strong>{job.eventType}</strong><span>{job.lastError ?? "Delivery exhausted"}</span></div><div className="key-revoke-actions"><Status value={job.status} /><button onClick={() => void retryWebhook(job.id)}>Retry</button></div></article>)}{operations.webhooks.deadLetters.length === 0 ? <EmptyHosted text="No webhook deliveries are in the dead-letter queue." /> : null}</div></section><section className="data-section"><SectionTitle title="First upload" caption="Run locally, then send the validated evidence bundle" /><pre>{`npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --push\n# or: npx agentcert push --evidence .agentcert/latest/agentcert-evidence.json`}</pre></section><section className="data-section"><SectionTitle title="CI environment" caption="Use secret-manager variables for ephemeral runners and SDK integrations" /><pre>{`AGENTCERT_BASE_URL=${endpoint}\nAGENTCERT_PROJECT_ID=${project.id}\nAGENTCERT_API_KEY=ac_live_...`}</pre></section></div>;
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
    <section className="data-section"><div className="section-actions"><SectionTitle title="Legal hold review" caption="Independent approval, rejection, and release decisions" /><button onClick={() => void downloadRetentionReport(session, project.id)}>Export retention report</button></div>
      <div className="governance-list">{holds.map((hold) => <article key={hold.id}><div><span className="eyebrow">{hold.projectId}</span><strong>{hold.reason}</strong><small>Requested by {hold.requestedByEmail ?? "unknown"} on {compactTime(hold.requestedAt)}</small></div><Status value={hold.status} />
        <div className="governance-actions"><button onClick={() => void downloadAdminLegalHoldReport(session, hold.id)}>Export report</button>{(hold.status === "requested" || hold.status === "approved") ? <>{selected === hold.id ? <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Decision rationale and preservation scope" /> : null}{hold.status === "requested" ? <><button onClick={() => void decide(hold, "reject")}>Reject</button><button className="primary-action compact" onClick={() => void decide(hold, "approve")}>Approve</button></> : <button className="danger-action" onClick={() => void decide(hold, "release")}>Release hold</button>}</> : null}</div>
      </article>)}{holds.length === 0 ? <EmptyHosted text="No legal hold requests have been submitted." /> : null}</div>
    </section>
    <section className="data-section"><SectionTitle title="Deletion journal" caption="Immutable retention cleanup outcomes for the current project" /><div className="ops-table deletion-table"><div className="ops-row head"><span>Evidence</span><span>Kind</span><span>Outcome</span><span>Size</span><span>Occurred</span></div>{report?.deletionJournal.map((item) => <div className="ops-row" key={item.id}><strong>{item.fileName}</strong><span>{item.kind}</span><Status value={item.outcome} /><span>{compactBytes(item.sizeBytes)}</span><span>{compactTime(item.occurredAt)}</span></div>)}</div>{report?.deletionJournal.length === 0 ? <EmptyHosted text="No evidence deletions have been recorded." /> : null}</section>
  </div>;
}

function ActionRows({ actions }: { actions: HostedAction[] }) { return <div className="compact-list">{actions.map((action) => <div key={action.id}><strong>{action.externalId}</strong><span>{action.actionType} · {action.riskLevel}</span><Status value={action.status} /></div>)}{actions.length === 0 ? <EmptyHosted text="No actions waiting for approval." /> : null}</div>; }
function IncidentRows({ incidents }: { incidents: HostedIncident[] }) { return <div className="compact-list">{incidents.map((incident) => <div key={incident.id}><strong>{incident.summary}</strong><span>{incident.type}{incident.firstDivergence ? ` · ${incident.firstDivergence}` : ""}</span><Status value={incident.severity} /></div>)}{incidents.length === 0 ? <EmptyHosted text="No open incidents." /> : null}</div>; }
function ControlMetric({ label, value, detail, attention }: { label: string; value: number | string; detail?: string; attention?: boolean }) { return <div className={attention ? "attention" : ""}><span>{label}</span><strong>{value}</strong><em>{detail ?? "Current project"}</em></div>; }
function AlertSummary({ label, alert }: { label: string; alert: { status: string; message: string } }) { return <div><span>{label}</span><strong><Status value={alert.status} /></strong><em>{alert.message}</em></div>; }
function OperationsTrends({ operations }: { operations: HostedOperations }) {
  const maxLatency = Math.max(1, ...operations.trends.webhooks.map((item) => item.p95LatencyMs));
  return <section className="operations-trends">
    <div className="trend-heading"><div><span className="eyebrow">Last 7 days</span><h2>Trust health history</h2><p>{operations.alerts.scheduledSmoke.message}</p></div><Status value={operations.alerts.scheduledSmoke.status} /></div>
    <div className="trend-grid">
      <div className="trend-series"><div className="trend-summary"><strong>{percent(operations.trends.summary.smokeSuccessRate)}</strong><span>production smoke pass rate</span></div><div className="trend-bars" aria-label="Daily production smoke pass rate">{operations.trends.health.map((item) => <div key={item.date} title={`${item.date}: ${item.passed}/${item.total} passed`}><i className={item.failed > 0 ? "failed" : item.total === 0 ? "empty" : "passed"} style={{ height: `${item.total ? Math.max(8, item.successRate * 100) : 4}%` }} /><small>{item.date.slice(5)}</small></div>)}</div></div>
      <div className="trend-series"><div className="trend-summary webhook"><span><strong>{compactDuration(operations.trends.summary.p95LatencyMs)}</strong><em>p95 latency</em></span><span><strong>{percent(operations.trends.summary.retryRate)}</strong><em>retry rate</em></span><span><strong>{operations.trends.summary.deadLetterRate === 0 ? "0" : percent(operations.trends.summary.deadLetterRate)}</strong><em>DLQ rate</em></span></div><div className="trend-bars latency" aria-label="Daily webhook p95 latency">{operations.trends.webhooks.map((item) => <div key={item.date} title={`${item.date}: p95 ${compactDuration(item.p95LatencyMs)}, ${item.retried} retried, ${item.deadLetter} DLQ`}><i className={item.deadLetter > 0 ? "failed" : item.retried > 0 ? "warning" : "passed"} style={{ height: `${Math.max(4, item.p95LatencyMs / maxLatency * 100)}%` }} /><small>{item.date.slice(5)}</small></div>)}</div></div>
    </div>
  </section>;
}
function SectionTitle({ title, caption }: { title: string; caption: string }) { return <div className="section-title"><h2>{title}</h2><p>{caption}</p></div>; }
function Status({ value }: { value: string }) { return <span className={`hosted-status ${value.toLowerCase().replace(/_/g, "-")}`}>{value.replace(/_/g, " ")}</span>; }
function EmptyHosted({ text }: { text: string }) { return <div className="hosted-empty">{text}</div>; }
function viewTitle(view: HostedView): string { return ({ overview: "Operational overview", agents: "Agent registry", runs: "Assurance runs", gates: "Release gates", actions: "Runtime actions", incidents: "Incident ledger", evidence: "Evidence registry", integrations: "Integrations", governance: "Governance administration" })[view]; }
function compactTime(value: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function compactBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function percent(value: number): string { return `${Math.round(value * 100)}%`; }
function compactDuration(value: number): string { return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms`; }
async function downloadEvidence(session: HostedSession, url: string, fileName: string) { const response = await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}` } }); if (!response.ok) throw new Error("Evidence download failed."); const href = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = href; link.download = fileName; link.click(); URL.revokeObjectURL(href); }
