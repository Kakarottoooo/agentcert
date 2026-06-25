import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type BrowserSessionOptions = {
  headless: boolean;
  startUrl: string;
  timeoutMs: number;
};

export class BrowserSession {
  private static activeSessions = new Set<BrowserSession>();
  private static sigintInstalled = false;
  private process?: ChildProcess;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private userDataDir?: string;
  public cdpUrl = "";

  constructor(private readonly options: BrowserSessionOptions) {}

  async start(): Promise<{ cdpUrl: string; context: BrowserContext; page: Page }> {
    const port = await getFreePort();
    this.cdpUrl = `http://127.0.0.1:${port}`;
    this.userDataDir = await mkdtemp(path.join(tmpdir(), "tripwire-chrome-"));
    const executable = chromium.executablePath();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-popup-blocking",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1365,900",
      this.options.headless ? "--headless=new" : "",
      "about:blank"
    ].filter(Boolean);

    this.process = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    this.process.stderr?.setEncoding("utf8");
    this.process.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    BrowserSession.activeSessions.add(this);
    BrowserSession.installCleanupHandler();

    try {
      await waitForCdp(this.cdpUrl, this.options.timeoutMs, () => this.process?.exitCode ?? null);
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
      this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      return { cdpUrl: this.cdpUrl, context: this.context, page: this.page };
    } catch (error) {
      await this.close();
      throw new Error(
        `Chromium could not launch or expose CDP at ${this.cdpUrl}: ${
          error instanceof Error ? error.message : String(error)
        }${stderr ? `\nChromium stderr:\n${stderr.slice(-4000)}` : ""}`
      );
    }
  }

  async navigate(): Promise<void> {
    if (!this.page) throw new Error("BrowserSession.navigate called before start");
    await this.page.goto(this.options.startUrl, { waitUntil: "domcontentloaded", timeout: this.options.timeoutMs });
  }

  async close(): Promise<void> {
    const browser = this.browser;
    const chrome = this.process;
    const dir = this.userDataDir;
    this.browser = undefined;
    this.process = undefined;
    this.userDataDir = undefined;

    await browser?.close().catch(() => undefined);
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      setTimeout(() => {
        if (chrome.exitCode === null) chrome.kill("SIGKILL");
      }, 1_000).unref();
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    BrowserSession.activeSessions.delete(this);
  }

  private static installCleanupHandler(): void {
    if (BrowserSession.sigintInstalled) return;
    BrowserSession.sigintInstalled = true;
    process.once("SIGINT", () => {
      void Promise.all([...BrowserSession.activeSessions].map((session) => session.close())).finally(() => process.exit(130));
    });
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a local port"));
      });
    });
    server.on("error", reject);
  });
}

async function waitForCdp(url: string, timeoutMs: number, exitCode: () => number | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode() !== null) throw new Error("Chromium exited before CDP became available");
    if (await canReadJsonVersion(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}/json/version`);
}

async function canReadJsonVersion(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${url}/json/version`, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}
