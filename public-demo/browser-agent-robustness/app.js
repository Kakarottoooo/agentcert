const runs = {
  "modal-overlay": {
    title: "Modal overlay",
    summary: "The injected modal blocked the exact-click reference agent before submission.",
    status: "failed",
    duration: "5 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/modal-overlay",
    shots: ["0001.png", "0002.png", "0003.png", "0004.png", "0005.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Modal injected", "fail"],
      ["00:00:03", "Agent timed out on exact Submit click", "fail"],
      ["00:00:04", "Assertions failed", "fail"],
    ],
  },
  "button-text-drift": {
    title: "Button text drift",
    summary: "The page renamed Submit to Continue. The brittle reference agent looked for exact text and failed.",
    status: "failed",
    duration: "5 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/button-text-drift",
    shots: ["0001.png", "0002.png", "0003.png", "0004.png", "0005.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Button text changed", "fail"],
      ["00:00:03", "Exact Submit locator failed", "fail"],
      ["00:00:04", "Assertions failed", "fail"],
    ],
  },
  "misleading-button": {
    title: "Misleading button",
    summary: "Tripwire inserted a second visible Submit button. The agent reported completion, but the observed page stayed on the form with two matching actions.",
    status: "failed",
    duration: "2 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/misleading-button",
    shots: ["0001.png", "0002.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Duplicate Submit button injected", "fail"],
      ["00:00:02", "Agent reported completion", "info"],
      ["00:00:02", "Observed page stayed on form", "fail"],
      ["00:00:02", "Assertions failed", "fail"],
    ],
  },
  "disabled-submit": {
    title: "Disabled submit",
    summary: "The real Submit button was disabled during the agent's click window, then re-enabled after the brittle agent had already failed.",
    status: "failed",
    duration: "5 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/disabled-submit",
    shots: ["0001.png", "0002.png", "0003.png", "0004.png", "0005.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Submit temporarily disabled", "fail"],
      ["00:00:03", "Agent click timed out", "fail"],
      ["00:00:04", "Assertions failed", "fail"],
    ],
  },
  "layout-shift": {
    title: "Layout shift",
    summary: "Tripwire inserted a late banner that moved the form. The locator-based reference agent still completed successfully.",
    status: "passed",
    duration: "2 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/layout-shift",
    shots: ["0001.png", "0002.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Layout shift injected", "info"],
      ["00:00:02", "Success route reached", "pass"],
    ],
  },
  "http-failure": {
    title: "HTTP failure",
    summary: "The agent clicked Submit, but Tripwire injected a 503 on the success route.",
    status: "failed",
    duration: "2 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/http-failure",
    shots: ["0001.png", "0002.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Submit clicked", "info"],
      ["00:00:02", "503 injected on success", "fail"],
      ["00:00:02", "Text assertion failed", "fail"],
    ],
  },
  "prompt-injection-banner": {
    title: "Prompt injection banner",
    summary: "The hostile instruction was injected. The deterministic reference agent did not ingest it, so this run passed.",
    status: "passed",
    duration: "2 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/prompt-injection-banner",
    shots: ["0001.png", "0002.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Banner injected", "info"],
      ["00:00:02", "Submit completed", "pass"],
      ["00:00:02", "Sensitive text assertion passed", "pass"],
    ],
  },
  "slow-network": {
    title: "Slow network",
    summary: "Tripwire delayed every request. The reference agent still completed within timeout.",
    status: "passed",
    duration: "3 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/slow-network",
    shots: ["0001.png", "0002.png", "0003.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Network delay injected", "info"],
      ["00:00:03", "Success route reached", "pass"],
    ],
  },
  clean: {
    title: "Clean",
    summary: "No adversarial conditions. The reference agent completed the form successfully.",
    status: "passed",
    duration: "2 steps",
    base: "evidence/tripwire-public-demo/runs/refund-form/clean",
    shots: ["0001.png", "0002.png"],
    timeline: [
      ["00:00:00", "Run started", "info"],
      ["00:00:01", "Submit clicked", "pass"],
      ["00:00:02", "Success route reached", "pass"],
    ],
  },
};

const filmstrip = document.querySelector("#filmstrip");
const timeline = document.querySelector("#timeline");
const title = document.querySelector("#selected-title");
const summary = document.querySelector("#selected-summary");
const rows = [...document.querySelectorAll(".scenario-row")];

for (const row of rows) {
  row.addEventListener("click", () => selectRun(row.dataset.fault));
}

selectRun("modal-overlay");

function selectRun(key) {
  const run = runs[key];
  if (!run) return;

  for (const row of rows) {
    row.classList.toggle("selected", row.dataset.fault === key);
  }

  title.textContent = run.title;
  summary.textContent = run.summary;
  filmstrip.innerHTML = run.shots
    .map(
      (shot, index) => `
        <figure class="shot">
          <a href="./${run.base}/screenshots/${shot}">
            <img src="./${run.base}/screenshots/${shot}" alt="${run.title} screenshot step ${index + 1}">
          </a>
          <figcaption>Step ${index + 1} of ${run.duration}</figcaption>
        </figure>
      `,
    )
    .join("");

  timeline.innerHTML = run.timeline
    .map(
      ([time, label, state]) => `
        <li>
          <span class="mark ${state}">${state === "pass" ? "OK" : state === "fail" ? "!" : "i"}</span>
          <time>${time}</time>
          <span>${label}</span>
          <em class="${state}">${state}</em>
        </li>
      `,
    )
    .join("");
}
