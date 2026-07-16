const reportUrl = "./report.json";

loadReport().catch((error) => {
  document.body.classList.add("load-failed");
  document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="load-error">The public evidence report could not be loaded: ${escapeHtml(error.message)}</div>`);
});

async function loadReport() {
  const response = await fetch(reportUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const report = await response.json();
  if (report.schemaVersion !== "agentcert.public_vendor_acceptance.v0.1") throw new Error("unsupported schema");
  render(report);
}

function render(report) {
  text("verdict-level", report.verdict.level);
  text("published-at", `Published ${formatTime(report.publishedAt)}`);
  const metrics = [
    ["Passing runs", `${report.summary.passingRuns}/${report.summary.totalRuns}`],
    ["Pass rate", `${Math.round(report.summary.passRate * 100)}%`],
    ["Score", `${report.verdict.score}/100`],
    ["Redaction findings", String(report.summary.redactionFindings + report.summary.artifactScanFindings)],
  ];
  document.getElementById("metrics").replaceChildren(...metrics.map(([label, value]) => element("div", "metric", [element("span", "", label), element("strong", "", value)])));

  document.getElementById("evidence-chain").replaceChildren(...report.evidenceChain.map((step) => {
    const item = element("li", "chain-step");
    item.append(element("span", "chain-sequence", String(step.sequence)), element("strong", "", label(step.type)), element("p", "", step.detail), chip(step.status));
    return item;
  }));

  document.getElementById("run-history").replaceChildren(...report.runs.map((run) => {
    const row = document.createElement("tr");
    const workflow = document.createElement("a");
    workflow.href = run.workflowUrl;
    workflow.textContent = `#${run.workflowRunId}`;
    workflow.rel = "noreferrer";
    const hash = element("code", "digest", compactHash(run.reportSha256));
    hash.title = run.reportSha256;
    row.append(
      cell(workflow),
      cell(formatTime(run.startedAt)),
      cell(chip(`${run.score}/100 ${run.status}`)),
      cell(chip(run.trend)),
      cell(`${run.requestDurationMs} ms`),
      cell(hash),
      cell(`${run.scans.preUpload.findings + run.scans.finalArtifacts.findings} findings`),
    );
    return row;
  }));

  const boundary = report.boundary;
  const boundaryRows = [
    ["Origin", boundary.allowedOrigins.join(", ")],
    ["Method", boundary.allowedMethods.join(", ")],
    ["Resource", boundary.allowedResources.join(", ")],
    ["Credential", `${boundary.credentialType} · ${boundary.requiredPermission}`],
    ["Timeout", `${boundary.timeoutMs} ms`],
    ["Rate cap", `${boundary.maxRequestsPerMinute} requests/minute`],
    ["Redirects", boundary.redirects],
    ["Policy SHA-256", compactHash(boundary.policySha256)],
  ];
  document.getElementById("boundary").replaceChildren(...boundaryRows.map(([term, description]) => {
    const wrapper = document.createElement("div");
    wrapper.append(element("dt", "", term), element("dd", "", description));
    if (term === "Policy SHA-256") wrapper.querySelector("dd").title = boundary.policySha256;
    return wrapper;
  }));

  list("limitations", report.limitations);
  list("public-fields", report.disclosure.publicFields);
  list("omitted-fields", report.disclosure.omittedFields);
  text("disclosure-note", report.disclosure.reason);
}

function element(tag, className = "", content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (Array.isArray(content)) node.append(...content);
  else if (content !== undefined) node.textContent = content;
  return node;
}

function chip(value) { return element("span", `status-chip ${String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, value); }
function cell(content) { const node = document.createElement("td"); node.append(content); return node; }
function text(id, value) { document.getElementById(id).textContent = value; }
function list(id, values) { document.getElementById(id).replaceChildren(...values.map((value) => element("li", "", value))); }
function label(value) { return value.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
function compactHash(value) { return `${value.slice(0, 10)}…${value.slice(-8)}`; }
function formatTime(value) { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC"; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
