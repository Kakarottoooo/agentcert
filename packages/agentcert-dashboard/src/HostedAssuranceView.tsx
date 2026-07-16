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
  const selected = cases.find((item) => item.id === selectedId);

  useEffect(() => {
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
      if (id === "submit") input.evidenceIds = evidence.map((item) => item.id);
      if (id === "issue") input.publish = window.confirm("Publish a public verification URL? The report still states its scope and limitations.");
      await transitionHostedAssuranceCase(session, project.id, selected.id, id, input);
      const detail = await loadHostedAssuranceCase(session, project.id, selected.id);
      setDecisions(detail.decisions); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <div className={`assurance-layout ${selected ? "" : "empty"}`}>
    <section className="data-section">
      <div className="section-actions"><div><h2>Assurance cases</h2><p>Scoped, independently reviewed claims backed by immutable evidence decisions.</p></div><button className="primary-action compact" onClick={() => setOpen(!open)}>{open ? "Cancel" : "Create case"}</button></div>
      {error ? <div className="console-error">{error}</div> : null}
      {open ? <form className="inline-form assurance-form" onSubmit={create}>
        <label>Case name<input name="name" required /></label><label>Subject ID<input name="subjectId" required /></label>
        <label>Subject name<input name="subjectName" required /></label><label>Version<input name="subjectVersion" placeholder="1.0.0" /></label>
        <label>Subject kind<input name="subjectKind" required placeholder="browser, coding, workflow" /></label><label>Policy pack<input name="policyPackVersion" required defaultValue="agentcert.base.v0.1" /></label>
        <label>Control ID<input name="controlId" required defaultValue="release-evidence" /></label><label>Control title<input name="controlTitle" required defaultValue="Release evidence reviewed" /></label>
        <label>Control mode<select name="controlMode" defaultValue="evidence_required"><option value="automated">Automated</option><option value="evidence_required">Evidence required</option><option value="manual">Manual</option></select></label>
        <label>Evidence kinds<input name="evidenceKinds" defaultValue="evidence_bundle" /></label>
        <label className="wide">Limitations<textarea name="limitations" required defaultValue="Assessment applies only to the declared subject version and evidence plan." /></label>
        <button className="primary-action compact" disabled={busy}>Create locked plan</button>
      </form> : null}
      <div className="entity-list">{cases.map((item) => <button className={`assurance-case-row ${selectedId === item.id ? "active" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)}><span><strong>{item.name}</strong><small>{item.subject.name} {item.subject.version ?? ""}</small></span><span><b>{item.status.replaceAll("_", " ")}</b><small>{item.policyPackVersion}</small></span></button>)}{cases.length === 0 ? <p>No assurance cases yet. Create one only when the claim and required evidence are known.</p> : null}</div>
    </section>
    {selected ? <section className="data-section assurance-detail">
      <div className="section-actions"><div><span className="eyebrow">{selected.subject.kind}</span><h2>{selected.name}</h2></div><strong>{selected.status.replaceAll("_", " ")}</strong></div>
      <dl><div><dt>Plan SHA-256</dt><dd className="hash">{selected.evaluationPlanSha256}</dd></div><div><dt>Evidence</dt><dd>{selected.evidenceIds.length} attached / {selected.evaluationPlan.requiredEvidenceKinds.join(", ")}</dd></div><div><dt>Signed report</dt><dd>{selected.report?.attestation?.keyId ?? "Not issued"}</dd></div><div><dt>Expires</dt><dd>{selected.expiresAt ?? "Not issued"}</dd></div></dl>
      <h3>Controls</h3><ul>{selected.evaluationPlan.controls.map((control) => <li key={control.id}><strong>{control.title}</strong> <span>{control.mode}</span></li>)}</ul>
      <h3>Limitations</h3><ul>{selected.evaluationPlan.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
      <div className="approval-actions">{(TRANSITIONS[selected.status] ?? []).map((item) => <button key={item.id} disabled={busy} className={item.id === "revoke" ? "danger-action" : ""} onClick={() => void transition(item.id)}>{item.label}</button>)}</div>
      {selected.publicVerificationId ? <p><a href={`/v1/public/assurance-reports/${encodeURIComponent(selected.publicVerificationId)}`} target="_blank" rel="noreferrer">Open public verification record</a></p> : null}
      <h3>Decision ledger</h3><div className="trust-ops-list">{decisions.map((item) => <article key={item.id}><div><strong>{item.toStatus.replaceAll("_", " ")}</strong><span>{item.reason}</span></div><small>{item.actorEmail ?? "recorded actor"}<br />{new Date(item.occurredAt).toLocaleString()}</small></article>)}</div>
    </section> : null}
  </div>;
}
