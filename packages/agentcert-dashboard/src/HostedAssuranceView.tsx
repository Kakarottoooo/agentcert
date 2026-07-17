import { useEffect, useState, type FormEvent } from "react";
import {
  createHostedAssuranceCase,
  loadHostedAssuranceCase,
  transitionHostedAssuranceCase,
  type HostedAssuranceCase,
  type HostedAssuranceDecision,
  type HostedEvidence,
  type HostedProject,
  type HostedSession,
} from "./hosted-api";

const TRANSITIONS: Partial<Record<HostedAssuranceCase["status"], Array<{ id: Parameters<typeof transitionHostedAssuranceCase>[3]; label: string }>>> = {
  draft: [{ id: "start", label: "Start evaluation" }, { id: "revoke", label: "Revoke" }],
  evaluating: [{ id: "submit", label: "Submit for review" }, { id: "revoke", label: "Revoke" }],
  review_required: [{ id: "return", label: "Return to evaluation" }, { id: "issue", label: "Issue signed report" }, { id: "revoke", label: "Revoke" }],
  issued: [{ id: "suspend", label: "Suspend" }, { id: "revoke", label: "Revoke" }, { id: "expire", label: "Mark expired" }],
  suspended: [{ id: "resume", label: "Resume evaluation" }, { id: "revoke", label: "Revoke" }],
  expired: [{ id: "resume", label: "Re-evaluate" }, { id: "revoke", label: "Revoke" }],
};

export default function HostedAssuranceView({ cases, evidence, project, session, refresh }: {
  cases: HostedAssuranceCase[];
  evidence: HostedEvidence[];
  project: HostedProject;
  session: HostedSession;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(cases[0]?.id);
  const [decisions, setDecisions] = useState<HostedAssuranceDecision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const selected = cases.find((item) => item.id === selectedId);

  useEffect(() => {
    setSelectedEvidenceIds([]);
    if (!selectedId) { setDecisions([]); return; }
    void loadHostedAssuranceCase(session, project.id, selectedId)
      .then((detail) => setDecisions(detail.decisions))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [project.id, selectedId, session]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      const controlId = String(form.get("controlId") ?? "release-evidence").trim();
      const created = await createHostedAssuranceCase(session, project.id, {
        name: form.get("name"),
        subject: { id: form.get("subjectId"), name: form.get("subjectName"), version: form.get("subjectVersion"), kind: form.get("subjectKind") },
        policyPackVersion: form.get("policyPackVersion"),
        evaluationPlan: {
          requiredEvidenceKinds: String(form.get("evidenceKinds") ?? "evidence_bundle").split(",").map((item) => item.trim()).filter(Boolean),
          controls: [{ id: controlId, title: form.get("controlTitle"), mode: form.get("controlMode") }],
          limitations: String(form.get("limitations") ?? "").split("\n").map((item) => item.trim()).filter(Boolean),
        },
        engagement: {
          customer: { name: form.get("customerName"), contactEmail: form.get("customerEmail") },
          sandbox: { name: form.get("sandboxName"), kind: form.get("sandboxKind"), baseUrl: form.get("sandboxBaseUrl") },
          workflow: {
            name: form.get("workflowName"), description: form.get("workflowDescription"), highRiskAction: form.get("highRiskAction"),
            expectedOutcome: { [String(form.get("expectedOutcomeKey") ?? "status")]: form.get("expectedOutcomeValue") },
          },
        },
      });
      setOpen(false); setSelectedId(created.id); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function transition(id: Parameters<typeof transitionHostedAssuranceCase>[3]) {
    if (!selected) return;
    const reason = window.prompt(`Reason for ${id}:`);
    if (!reason?.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const input: Record<string, unknown> = { reason: reason.trim() };
      if (id === "submit" && !selected.engagement) input.evidenceIds = evidence.map((item) => item.id);
      if (id === "issue") {
        input.publish = window.confirm("Publish the scoped report and delivery packet? This exposes the customer, subject version, sandbox description, workflow, decision, and limitations. Reviews are private by default.");
        if (selected.engagement) {
          const verdict = window.prompt("Verdict: RELEASE, RELEASE_WITH_CONTROLS, or BLOCK", "RELEASE_WITH_CONTROLS");
          if (verdict !== "RELEASE" && verdict !== "RELEASE_WITH_CONTROLS" && verdict !== "BLOCK") throw new Error("Choose RELEASE, RELEASE_WITH_CONTROLS, or BLOCK.");
          const observedText = window.prompt("Observed outcome as JSON", JSON.stringify(selected.engagement.workflow.expectedOutcome));
          if (!observedText) return;
          input.verdict = verdict;
          input.rationale = requiredPrompt("Decision rationale");
          input.firstDivergence = requiredPrompt("First behavior divergence, or explicitly state that none was observed", "No behavior divergence observed.");
          input.authorizationGaps = linesPrompt("Authorization gaps, one per line");
          input.controlsRequired = verdict === "RELEASE_WITH_CONTROLS" ? linesPrompt("Required controls, one per line", "Keep the action gateway mandatory.") : [];
          input.limitations = linesPrompt("Review limitations, one per line", selected.evaluationPlan.limitations.join("\n"));
          input.outcome = { observed: JSON.parse(observedText), verified: window.confirm("Was this outcome independently verified against the sandbox state?") };
        }
      }
      await transitionHostedAssuranceCase(session, project.id, selected.id, id, input);
      const detail = await loadHostedAssuranceCase(session, project.id, selected.id);
      setDecisions(detail.decisions); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function recordEngagementPhase(action: "baseline" | "retest") {
    if (!selected || selectedEvidenceIds.length === 0) { setError("Select at least one evidence record first."); return; }
    setBusy(true); setError(undefined);
    try {
      await transitionHostedAssuranceCase(session, project.id, selected.id, action, { evidenceIds: selectedEvidenceIds });
      setSelectedEvidenceIds([]); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function recordRemediation() {
    if (!selected) return;
    const titles = linesPrompt("Remediation items, one per line");
    if (titles.length === 0) return;
    setBusy(true); setError(undefined);
    try {
      await transitionHostedAssuranceCase(session, project.id, selected.id, "remediation", { items: titles.map((title, index) => ({ id: `remediation-${index + 1}`, title, status: "open", evidenceIds: [] })) });
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  function downloadDeliveryPacket() {
    if (!selected?.deliveryPacket) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(selected.deliveryPacket, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `agentcert-assurance-delivery-${selected.id}.json`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className={`assurance-layout ${selected ? "" : "empty"}`}>
    <section className="data-section">
      <div className="section-actions"><div><h2>7-Day Assurance Reviews</h2><p>One locked workflow, one baseline, one retest, and one independently signed release decision.</p></div><button className="primary-action compact" onClick={() => setOpen(!open)}>{open ? "Cancel" : "Create engagement"}</button></div>
      {error ? <div className="console-error">{error}</div> : null}
      {open ? <form className="inline-form assurance-form" onSubmit={create}>
        <div className="wide assurance-offer"><strong>$5,000 fixed scope</strong><span>One workflow · one retest · private by default · delivery due in seven days</span></div>
        <label>Customer<input name="customerName" required /></label><label>Customer contact<input name="customerEmail" type="email" placeholder="security@example.com" /></label>
        <label>Case name<input name="name" required /></label><label>Subject ID<input name="subjectId" required /></label>
        <label>Subject name<input name="subjectName" required /></label><label>Agent version<input name="subjectVersion" required placeholder="1.0.0 or commit SHA" /></label>
        <label>Subject kind<input name="subjectKind" required placeholder="browser, coding, workflow" /></label><label>Policy pack<input name="policyPackVersion" required defaultValue="agentcert.base.v0.1" /></label>
        <label>Sandbox name<input name="sandboxName" required placeholder="Customer staging" /></label><label>Sandbox kind<input name="sandboxKind" required placeholder="synthetic, vendor-test, staging" /></label>
        <label className="wide">Sandbox URL (optional)<input name="sandboxBaseUrl" type="url" placeholder="https://sandbox.example.com" /></label>
        <label>Workflow name<input name="workflowName" required /></label><label>High-risk action<select name="highRiskAction" defaultValue="SUBMIT"><option>SUBMIT</option><option>PAY</option><option>SEND</option><option>UPDATE</option></select></label>
        <label className="wide">Workflow description<textarea name="workflowDescription" required /></label>
        <label>Expected outcome field<input name="expectedOutcomeKey" required defaultValue="status" /></label><label>Expected value<input name="expectedOutcomeValue" required /></label>
        <label>Control ID<input name="controlId" required defaultValue="release-evidence" /></label><label>Control title<input name="controlTitle" required defaultValue="Release evidence reviewed" /></label>
        <label>Control mode<select name="controlMode" defaultValue="evidence_required"><option value="automated">Automated</option><option value="evidence_required">Evidence required</option><option value="manual">Manual</option></select></label>
        <label>Evidence kinds<input name="evidenceKinds" defaultValue="evidence_bundle" /></label>
        <label className="wide">Limitations<textarea name="limitations" required defaultValue="Assessment applies only to the declared subject version and evidence plan." /></label>
        <button className="primary-action compact" disabled={busy}>Lock engagement plan</button>
      </form> : null}
      <div className="entity-list">{cases.map((item) => <button className={`assurance-case-row ${selectedId === item.id ? "active" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)}><span><strong>{item.name}</strong><small>{item.subject.name} {item.subject.version ?? ""}</small></span><span><b>{item.status.replaceAll("_", " ")}</b><small>{item.policyPackVersion}</small></span></button>)}{cases.length === 0 ? <p>No assurance cases yet. Create one only when the claim and required evidence are known.</p> : null}</div>
    </section>
    {selected ? <section className="data-section assurance-detail">
      <div className="section-actions"><div><span className="eyebrow">{selected.subject.kind}</span><h2>{selected.name}</h2></div><strong>{selected.status.replaceAll("_", " ")}</strong></div>
      <dl><div><dt>Plan SHA-256</dt><dd className="hash">{selected.evaluationPlanSha256}</dd></div><div><dt>Evidence</dt><dd>{selected.evidenceIds.length} attached / {selected.evaluationPlan.requiredEvidenceKinds.join(", ")}</dd></div><div><dt>Signed report</dt><dd>{selected.report?.attestation?.keyId ?? "Not issued"}</dd></div><div><dt>Expires</dt><dd>{selected.expiresAt ?? "Not issued"}</dd></div></dl>
      {selected.engagement ? <div className="engagement-summary">
        <div><span>Customer</span><strong>{selected.engagement.customer.name}</strong></div><div><span>Workflow</span><strong>{selected.engagement.workflow.name}</strong></div>
        <div><span>Due</span><strong>{new Date(selected.engagement.dueAt).toLocaleString()}</strong></div><div><span>Scope</span><strong>$5,000 · 1 workflow · 1 retest</strong></div>
        <div><span>First valid evidence</span><strong>{selected.engagement.timeToFirstEvidenceSeconds === undefined ? "Waiting" : duration(selected.engagement.timeToFirstEvidenceSeconds)}</strong></div>
        <div><span>Decision</span><strong>{selected.engagement.decision?.verdict ?? "Pending"}</strong></div>
      </div> : null}
      {selected.engagement && selected.status === "evaluating" ? <div className="engagement-progress">
        <h3>Review evidence</h3><p>Select immutable evidence for the next phase. Baseline and retest cannot be replaced after recording.</p>
        <div className="evidence-picker">{evidence.map((item) => <label key={item.id}><input type="checkbox" checked={selectedEvidenceIds.includes(item.id)} onChange={(event) => setSelectedEvidenceIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span><strong>{item.fileName}</strong><small>{item.kind} · {item.sha256.slice(0, 12)}</small></span></label>)}</div>
        <div className="approval-actions"><button disabled={busy || Boolean(selected.engagement.baseline)} onClick={() => void recordEngagementPhase("baseline")}>Record baseline</button><button disabled={busy} onClick={() => void recordRemediation()}>Set remediation</button><button disabled={busy || !selected.engagement.baseline || Boolean(selected.engagement.retest)} onClick={() => void recordEngagementPhase("retest")}>Record included retest</button></div>
        <ol className="engagement-timeline"><li className={selected.engagement.baseline ? "done" : ""}>Baseline {selected.engagement.baseline ? "locked" : "pending"}</li><li className={selected.engagement.remediationItems.length ? "done" : ""}>Remediation {selected.engagement.remediationItems.length ? `${selected.engagement.remediationItems.length} item(s)` : "pending"}</li><li className={selected.engagement.retest ? "done" : ""}>Retest {selected.engagement.retest ? "locked" : "pending"}</li></ol>
      </div> : null}
      <h3>Controls</h3><ul>{selected.evaluationPlan.controls.map((control) => <li key={control.id}><strong>{control.title}</strong> <span>{control.mode}</span></li>)}</ul>
      <h3>Limitations</h3><ul>{selected.evaluationPlan.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
      <div className="approval-actions">{(TRANSITIONS[selected.status] ?? []).map((item) => <button key={item.id} disabled={busy} className={item.id === "revoke" ? "danger-action" : ""} onClick={() => void transition(item.id)}>{item.label}</button>)}</div>
      {selected.deliveryPacket ? <button className="primary-action compact" onClick={downloadDeliveryPacket}>Download signed delivery packet</button> : null}
      {selected.publicVerificationId ? <p><a href={`/v1/public/assurance-reports/${encodeURIComponent(selected.publicVerificationId)}`} target="_blank" rel="noreferrer">Open public verification record</a></p> : null}
      <h3>Decision ledger</h3><div className="trust-ops-list">{decisions.map((item) => <article key={item.id}><div><strong>{item.toStatus.replaceAll("_", " ")}</strong><span>{item.reason}</span></div><small>{item.actorEmail ?? "recorded actor"}<br />{new Date(item.occurredAt).toLocaleString()}</small></article>)}</div>
    </section> : null}
  </div>;
}

function requiredPrompt(label: string, fallback = ""): string {
  const value = window.prompt(label, fallback)?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function linesPrompt(label: string, fallback = ""): string[] {
  const value = window.prompt(label, fallback);
  return value ? value.split("\n").map((item) => item.trim()).filter(Boolean) : [];
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3_600).toFixed(1)}h`;
}
