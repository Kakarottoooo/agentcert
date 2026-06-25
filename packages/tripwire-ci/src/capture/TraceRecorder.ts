import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { AgentEvent, CaptureConfig, FaultConfig, TraceMetadata, TraceStep } from "../types.js";
import { ensureDir, sha256 } from "../utils/files.js";

export class TraceRecorder {
  private timer?: NodeJS.Timeout;
  private capturing = false;
  private stepIndex = 0;
  private consoleErrors: string[] = [];
  private networkErrors: string[] = [];
  private requests: string[] = [];
  private consumedEvents = 0;
  private warnings: string[] = [];
  private steps: TraceStep[] = [];

  constructor(
    private readonly page: Page,
    private readonly options: {
      runId: string;
      scenarioName: string;
      fault: FaultConfig;
      startUrl: string;
      cdpUrl: string;
      runDir: string;
      capture: CaptureConfig;
      eventsFile: string;
    }
  ) {}

  async start(): Promise<void> {
    await ensureDir(path.join(this.options.runDir, "screenshots"));
    await ensureDir(path.join(this.options.runDir, "dom"));
    this.page.on("console", (message) => {
      if (message.type() === "error") this.consoleErrors.push(message.text());
    });
    this.page.on("request", (request) => {
      this.requests.push(request.url());
    });
    this.page.on("requestfailed", (request) => {
      this.networkErrors.push(`${request.url()} :: ${request.failure()?.errorText ?? "failed"}`);
    });
    await this.capture("initial");
    this.timer = setInterval(() => void this.capture("interval"), this.options.capture.intervalMs);
  }

  async stop(): Promise<TraceMetadata> {
    if (this.timer) clearInterval(this.timer);
    await this.capture("final");
    const metadata: TraceMetadata = {
      runId: this.options.runId,
      scenarioName: this.options.scenarioName,
      fault: this.options.fault,
      startUrl: this.options.startUrl,
      cdpUrl: this.options.cdpUrl,
      startedAt: this.steps[0]?.timestamp ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      warnings: this.warnings,
      requests: [...this.requests],
      networkErrors: [...this.networkErrors],
      consoleErrors: [...this.consoleErrors],
      steps: this.steps
    };
    await writeFile(path.join(this.options.runDir, "trace.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return metadata;
  }

  getRequests(): string[] {
    return [...this.requests];
  }

  getConsoleErrors(): string[] {
    return [...this.consoleErrors];
  }

  getNetworkErrors(): string[] {
    return [...this.networkErrors];
  }

  private async capture(reason: "initial" | "interval" | "final"): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    try {
      if (this.page.isClosed()) return;
      const stepNumber = ++this.stepIndex;
      const padded = String(stepNumber).padStart(4, "0");
      const timestamp = new Date().toISOString();
      const [url, title, html, visibleText] = await Promise.all([
        this.page.url(),
        this.page.title().catch(() => undefined),
        this.page.content().catch(() => ""),
        this.page.locator("body").innerText({ timeout: 500 }).catch(() => "")
      ]);

      let screenshotPath: string | undefined;
      if (this.options.capture.screenshots) {
        screenshotPath = `screenshots/${padded}.png`;
        await this.page.screenshot({ path: path.join(this.options.runDir, screenshotPath), fullPage: true }).catch((error) => {
          this.warnings.push(`Screenshot capture failed at step ${stepNumber}: ${messageOf(error)}`);
          screenshotPath = undefined;
        });
      }

      let domSnapshotPath: string | undefined;
      if (this.options.capture.domSnapshots) {
        domSnapshotPath = `dom/${padded}.html`;
        await writeFile(path.join(this.options.runDir, domSnapshotPath), html, "utf8");
      }

      const events = await this.readNewAgentEvents();
      this.steps.push({
        stepIndex: stepNumber,
        timestamp,
        url,
        title,
        screenshotPath,
        domSnapshotPath,
        domHash: sha256(html),
        textHash: sha256(visibleText),
        visibleTextSample: truncate(visibleText.replace(/\s+/g, " ").trim(), 1200),
        consoleErrors: this.consoleErrors.slice(-10),
        networkErrors: this.networkErrors.slice(-10),
        agentEvents: events
      });
      if (reason === "final") await this.readNewAgentEvents();
    } catch (error) {
      this.warnings.push(`Trace capture failed: ${messageOf(error)}`);
    } finally {
      this.capturing = false;
    }
  }

  private async readNewAgentEvents(): Promise<AgentEvent[]> {
    let raw = "";
    try {
      raw = await readFile(this.options.eventsFile, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const fresh = lines.slice(this.consumedEvents);
    this.consumedEvents = lines.length;
    const events: AgentEvent[] = [];
    for (const line of fresh) {
      try {
        const parsed = JSON.parse(line) as AgentEvent;
        if (parsed && typeof parsed === "object") events.push(parsed);
      } catch {
        this.warnings.push(`Invalid JSONL agent event ignored: ${truncate(line, 160)}`);
      }
    }
    return events;
  }
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max)}...` : input;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
