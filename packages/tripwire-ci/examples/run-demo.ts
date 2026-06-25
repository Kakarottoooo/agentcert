import path from "node:path";
import http from "node:http";
import { startDemoServer } from "./demo-server.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { TripwireRunner } from "../src/runner/TripwireRunner.js";

const failUnderArg = process.argv.indexOf("--fail-under");
const failUnder = failUnderArg >= 0 ? Number(process.argv[failUnderArg + 1]) : undefined;

const server = await startDemoServer(3020);
try {
  await waitForHealth(`${server.url}/health`);
  const config = await loadConfig(path.resolve("examples/tripwire.yml"));
  const result = await new TripwireRunner(config).run({ outDir: ".tripwire/latest", failUnder });
  const reportPath = path.resolve(".tripwire/latest/tripwire-report.html");
  console.log(`Tripwire score ${result.summary.overallScore.toFixed(2)} (${result.summary.passedRuns}/${result.summary.totalRuns} runs passed)`);
  console.log(`Report: ${reportPath}`);
  if (!result.gate.passed) process.exitCode = 1;
} finally {
  await server.close();
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
