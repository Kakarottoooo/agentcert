import { useState, type FormEvent } from "react";
import {
  createHostedProject,
  renameHostedProject,
  type HostedProject,
  type HostedSession,
} from "./hosted-api";

interface Props {
  session: HostedSession;
  projects: HostedProject[];
  current?: HostedProject;
  onSelect: (project: HostedProject) => void;
  onChange: (projects: HostedProject[], selected: HostedProject) => void;
}

export default function HostedProjectSwitcher({ session, projects, current, onSelect, onChange }: Props) {
  const [mode, setMode] = useState<"idle" | "create" | "rename">("idle");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  function begin(next: "create" | "rename") {
    setMode(next);
    setName(next === "rename" ? current?.name ?? "" : "");
    setError(undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const currentProject = current;
      if (mode === "idle" || (mode === "rename" && !currentProject)) return;
      let updated: HostedProject;
      if (mode === "create") updated = await createHostedProject(session, name, currentProject?.organizationId);
      else {
        if (!currentProject) return;
        updated = await renameHostedProject(session, currentProject.id, name);
      }
      let next: HostedProject[];
      if (mode === "create") next = [...projects, updated];
      else next = projects.map((project) => project.id === updated.id ? updated : project);
      onChange(next, updated);
      setMode("idle");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="project-switcher">
    <span>Project</span>
    <select aria-label="Current project" value={current?.id ?? ""} onChange={(event) => {
      const selected = projects.find((project) => project.id === event.target.value);
      if (selected) onSelect(selected);
    }}>
      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
    {mode === "idle" ? <div className="project-actions">
      <button type="button" onClick={() => begin("create")}>New</button>
      <button type="button" disabled={!current} onClick={() => begin("rename")}>Rename</button>
    </div> : <form onSubmit={(event) => void submit(event)}>
      <input aria-label="Project name" autoFocus minLength={2} maxLength={80} required value={name} onChange={(event) => setName(event.target.value)} />
      <div className="project-actions"><button type="button" onClick={() => setMode("idle")}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div>
    </form>}
    {error ? <small className="project-error">{error}</small> : null}
  </div>;
}
