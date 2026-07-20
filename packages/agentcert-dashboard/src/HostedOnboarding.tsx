import { useState, type FormEvent } from "react";
import {
  submitHostedPilotFeedback,
  type HostedOnboardingStatus,
  type HostedProject,
  type HostedSession,
} from "./hosted-api";

const labels = {
  create_key: ["Create a project key", "Project-scoped machine credential"],
  connect_cli: ["Connect the CLI", "Credential validated by the hosted API"],
  upload_evidence: ["Upload first evidence", "Run, provenance, and artifacts received"],
} as const;

export default function HostedOnboarding({ status, project, session, onOpenIntegrations, onReviewRuns, refresh }: {
  status: HostedOnboardingStatus;
  project: HostedProject;
  session: HostedSession;
  onOpenIntegrations?: () => void;
  onReviewRuns: () => void;
  refresh: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<string>();

  return <section className={`onboarding-band ${status.complete ? "complete" : ""}`}>
    <div className="onboarding-copy">
      <span className="eyebrow">{status.complete ? "Connection verified" : `Onboarding ${status.completedSteps}/${status.totalSteps}`}</span>
      <h2>{status.complete ? "This project is receiving AgentCert evidence." : "Connect an external agent in three observable steps."}</h2>
      <p>{status.complete ? "The hosted control plane has authenticated the CLI and retained the first evidence object." : `Project ${project.name} is isolated. The key cannot approve runtime actions.`}</p>
    </div>
    <div className="onboarding-actions">
      {status.complete ? <button onClick={onReviewRuns}>Review runs</button> : onOpenIntegrations ? <button className="primary-action compact" onClick={onOpenIntegrations}>Open integrations</button> : null}
      <button onClick={() => void refresh()}>Check progress</button>
    </div>
    <ol>{status.steps.map((step, index) => <li key={step.id} className={step.status === "complete" ? "done" : ""}>
      <b>{index + 1}</b><span><strong>{labels[step.id][0]}</strong><small>{step.status === "complete" ? labels[step.id][1] : step.diagnosis?.message}</small></span>
      {step.diagnosis ? <details><summary>Fix this step</summary><p>{step.diagnosis.recovery}</p></details> : null}
    </li>)}</ol>
    {!status.complete && status.steps[0]?.status === "complete" ? <div className="onboarding-command">
      <code>{status.connection.command}</code>
      <button onClick={() => { void navigator.clipboard.writeText(status.connection.command); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
    </div> : null}
    <button className="feedback-toggle" onClick={() => setFeedbackOpen((value) => !value)}>Report onboarding friction</button>
    {feedbackOpen ? <PilotFeedbackForm projectId={project.id} session={session} onSubmitted={(message) => { setFeedbackStatus(message); setFeedbackOpen(false); }} /> : null}
    {feedbackStatus ? <p className="feedback-confirmation">{feedbackStatus}</p> : null}
  </section>;
}

function PilotFeedbackForm({ projectId, session, onSubmitted }: { projectId: string; session: HostedSession; onSubmitted: (message: string) => void }) {
  const [stage, setStage] = useState("cli_connect");
  const [category, setCategory] = useState("configuration");
  const [outcome, setOutcome] = useState("confusing");
  const [reasonCode, setReasonCode] = useState("onboarding_friction");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      await submitHostedPilotFeedback(session, projectId, { stage, category, outcome, reasonCode, message });
      onSubmitted("Feedback recorded for this project.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <form className="pilot-feedback-form" onSubmit={(event) => void submit(event)}>
    <select aria-label="Onboarding stage" value={stage} onChange={(event) => setStage(event.target.value)}>
      <option value="project">Project</option><option value="api_key">API key</option><option value="cli_connect">CLI connection</option><option value="first_run">First run</option><option value="evidence_upload">Evidence upload</option><option value="dashboard_review">Dashboard review</option>
    </select>
    <select aria-label="Feedback category" value={category} onChange={(event) => setCategory(event.target.value)}>
      <option value="install">Install</option><option value="authentication">Authentication</option><option value="configuration">Configuration</option><option value="execution">Execution</option><option value="evidence">Evidence</option><option value="dashboard">Dashboard</option><option value="other">Other</option>
    </select>
    <select aria-label="Feedback outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
      <option value="blocked">Blocked</option><option value="confusing">Confusing</option><option value="failed">Failed</option><option value="completed">Completed</option><option value="suggestion">Suggestion</option>
    </select>
    <input aria-label="Reason code" required maxLength={80} value={reasonCode} onChange={(event) => setReasonCode(event.target.value.replace(/[^a-z0-9_.-]/gi, "_"))} />
    <textarea aria-label="Feedback details" maxLength={2000} placeholder="What stopped or confused you? Do not include secrets." value={message} onChange={(event) => setMessage(event.target.value)} />
    {error ? <div className="form-error">{error}</div> : null}<button type="submit" disabled={busy}>{busy ? "Sending..." : "Record feedback"}</button>
  </form>;
}
