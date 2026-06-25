import path from "node:path";
import { startDemoServer } from "./demo-server.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { TripwireRunner } from "../src/runner/TripwireRunner.js";

const runs = Number(process.env.TRIPWIRE_REPEAT_RUNS ?? 3);
const tolerance = Number(process.env.TRIPWIRE_REPEAT_TOLERANCE ?? 0);
const server = await startDemoServer(3020);

try {
  const scores: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const config = await loadConfig(path.resolve("examples/tripwire.yml"));
    const result = await new TripwireRunner(config).run({ outDir: `.tripwire/repeat/run-${index + 1}` });
    scores.push(result.summary.overallScore);
    console.log(`Run ${index + 1}: score ${result.summary.overallScore.toFixed(2)} (${result.summary.passedRuns}/${result.summary.totalRuns})`);
  }
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min > tolerance) {
    throw new Error(`Brittle demo score varied by ${(max - min).toFixed(2)} across ${runs} runs, above tolerance ${tolerance}.`);
  }
  console.log(`Repeatability check passed: scores ${scores.map((score) => score.toFixed(2)).join(", ")}`);
} finally {
  await server.close();
}
