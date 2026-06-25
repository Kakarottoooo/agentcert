const state = {
  snapshot: undefined,
  selected: undefined,
};

const faultLabels = {
  clean: "Clean",
  "modal-overlay": "Modal",
  "button-text-drift": "Text drift",
  "misleading-button": "Misleading",
  "disabled-submit": "Disabled",
  "layout-shift": "Layout",
  "prompt-injection-banner": "Injection",
  "slow-network": "Slow",
  "http-failure": "HTTP 503",
};

main();

async function main() {
  const response = await fetch("./evidence/lab-snapshot.json", { cache: "no-cache" });
  state.snapshot = await response.json();
  state.selected = state.snapshot.matrix.find((cell) => cell.status === "failed") ?? state.snapshot.matrix[0];
  render();
}

function render() {
  renderMetrics();
  renderAgents();
  renderMatrix();
  renderFaults();
  renderDetail(state.selected);
  const heroShot = document.querySelector("#hero-shot");
  if (heroShot && state.selected?.screenshotPath) heroShot.src = state.selected.screenshotPath;
}

function renderMetrics() {
  const summary = state.snapshot.summary;
  document.querySelector("#summary-metrics").innerHTML = [
    metric("Agents", `${summary.completedAgentCount}/${summary.agentCount}`, "completed"),
    metric("Runs", String(summary.totalRuns), "checked-in"),
    metric("Pass rate", percent(summary.passRate), "overall"),
    metric("Faults", String(summary.faultCount), "deterministic"),
  ].join("");
}

function renderAgents() {
  document.querySelector("#agent-grid").innerHTML = state.snapshot.agents
    .map((agent) => {
      const score = agent.status === "completed" ? `${Math.round(agent.passRate * 100)}%` : "not run";
      const detail =
        agent.status === "completed"
          ? `${agent.passedRuns}/${agent.totalRuns} runs passed. ${agent.notes ?? ""}`
          : `${agent.notes ?? "No checked-in result."} ${agent.requiresModelKey ? "Requires local model key." : ""}`;
      return `<article class="agent-card">
        <span class="badge ${agent.status === "missing" ? "missing" : ""}">${agent.kind.replaceAll("-", " ")}</span>
        <h3>${escapeHtml(agent.name)}</h3>
        <div class="agent-score"><strong>${score}</strong><span>${agent.status}</span></div>
        <p class="agent-meta">${escapeHtml(detail)}</p>
        ${agent.repositoryUrl ? `<a class="detail-link" href="${agent.repositoryUrl}">Repository</a>` : ""}
      </article>`;
    })
    .join("");
}

function renderMatrix() {
  const completedAgents = state.snapshot.agents.filter((agent) => agent.status === "completed");
  const faults = orderedFaults();
  const rows = completedAgents
    .map((agent) => {
      const cells = faults
        .map((fault) => {
          const cell = state.snapshot.matrix.find((item) => item.agentId === agent.id && item.faultName === fault);
          if (!cell) return `<div></div>`;
          return `<button class="matrix-cell ${statusClass(cell.status)}" data-agent="${cell.agentId}" data-fault="${cell.faultName}">
            <strong>${cell.status}</strong>
            <span>${cell.stepCount ?? "-"} steps</span>
          </button>`;
        })
        .join("");
      return `<div class="matrix-row">
        <div class="matrix-agent">${escapeHtml(agent.name)}</div>
        ${cells}
      </div>`;
    })
    .join("");

  document.querySelector("#matrix-wrap").innerHTML = `<div class="matrix" style="--fault-count:${faults.length}">
    <div class="matrix-row matrix-head">
      <div>Agent</div>
      ${faults.map((fault) => `<div>${faultLabels[fault] ?? fault}</div>`).join("")}
    </div>
    ${rows}
  </div>`;

  document.querySelectorAll(".matrix-cell").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected = state.snapshot.matrix.find(
        (cell) => cell.agentId === button.dataset.agent && cell.faultName === button.dataset.fault,
      );
      renderDetail(state.selected);
    });
  });
}

function renderFaults() {
  document.querySelector("#fault-list").innerHTML = state.snapshot.faults
    .map(
      (fault) => `<div class="fault-row">
        <div><strong>${escapeHtml(faultLabels[fault.faultName] ?? fault.faultName)}</strong><br><span>${fault.failedRuns}/${fault.totalRuns} failed</span></div>
        <em class="badge ${fault.passRate === 0 ? "missing" : ""}">${percent(fault.passRate)}</em>
      </div>`,
    )
    .join("");
}

function renderDetail(cell) {
  if (!cell) return;
  document.querySelector("#run-detail").innerHTML = `
    ${cell.screenshotPath ? `<img src="${cell.screenshotPath}" alt="${escapeHtml(cell.agentName)} ${escapeHtml(cell.faultName)} screenshot">` : ""}
    <div class="detail-copy">
      <span class="badge ${cell.status === "failed" ? "missing" : ""}">${cell.status}</span>
      <h3>${escapeHtml(cell.agentName)} on ${escapeHtml(faultLabels[cell.faultName] ?? cell.faultName)}</h3>
      <p>${escapeHtml(cell.primaryFailure ?? "No failure recorded for this run.")}</p>
      ${renderDivergence(cell.firstDivergence)}
      <p>Final URL: ${escapeHtml(cell.finalUrl ?? "-")}<br>Duration: ${formatDuration(cell.durationMs)} | Steps: ${cell.stepCount ?? "-"}</p>
      <div class="detail-links">
        ${cell.tracePath ? `<a href="${cell.tracePath}">Trace JSON</a>` : ""}
        ${cell.reportPath ? `<a href="${cell.reportPath}">HTML report</a>` : ""}
        ${cell.screenshotPath ? `<a href="${cell.screenshotPath}">Screenshot</a>` : ""}
        ${cell.firstDivergence?.domSnapshotPath ? `<a href="${cell.firstDivergence.domSnapshotPath}">Divergence DOM</a>` : ""}
      </div>
    </div>`;
}

function renderDivergence(divergence) {
  if (!divergence) {
    return `<div class="divergence"><strong>First divergence</strong><span>No divergence from the clean trace was recorded.</span></div>`;
  }
  return `<div class="divergence">
    <strong>First divergence: ${escapeHtml(divergence.kind)}${divergence.stepIndex ? ` at step ${divergence.stepIndex}` : ""}</strong>
    <span>${escapeHtml(divergence.note)}</span>
    <dl>
      <div><dt>Clean trace</dt><dd>${escapeHtml(divergence.baseline ?? "-")}</dd></div>
      <div><dt>This run</dt><dd>${escapeHtml(divergence.current ?? "-")}</dd></div>
    </dl>
  </div>`;
}

function orderedFaults() {
  return state.snapshot.faults.map((fault) => fault.faultName);
}

function metric(label, value, detail) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong><em>${detail}</em></div>`;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(ms) {
  if (ms === undefined) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusClass(status) {
  return status === "passed" ? "pass" : "fail";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
