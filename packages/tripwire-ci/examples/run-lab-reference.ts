import path from "node:path";
import http from "node:http";
import { startDemoServer } from "./demo-server.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { TripwireRunner } from "../src/runner/TripwireRunner.js";

const repoRoot = path.resolve("../..");
const configArg = readFlag("--config") ?? "examples/real-agents/robustness-lab/tripwire.reference-robust.yml";
const outArg = readFlag("--out") ?? "public-demo/real-agent-robustness/evidence/reference-robust";

process.chdir(repoRoot);

const server = await startDemoServer(3020);
try {
  await waitForHealth(`${server.url}/health`);
  const config = await loadConfig(path.resolve(configArg));
  const result = await new TripwireRunner(config).run({ outDir: path.resolve(outArg), failUnder: 0 });
  console.log(`Reference lab score ${result.summary.overallScore.toFixed(2)} (${result.summary.passedRuns}/${result.summary.totalRuns} runs passed)`);
  console.log(`Report: ${path.join(path.resolve(outArg), "tripwire-report.html")}`);
} finally {
  await server.close();
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await healthy(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Demo server did not become healthy at ${url}`);
}

function healthy(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}
