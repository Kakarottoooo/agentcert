#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateSemanticGoldenDataset } from "./semantic-calibration.js";

const datasetPath = resolve(argument("--dataset") ?? "datasets/agent-semantics/golden-v0.1.json");
const outputPath = resolve(argument("--out") ?? ".agentcert/compatibility/semantic-adapter-matrix.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as unknown;
const report = evaluateSemanticGoldenDataset(dataset);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Semantic adapter calibration: ${report.status}\n`);
process.stdout.write(`Exact: ${report.metrics.exact}/${report.metrics.total}; false-unknown: ${report.metrics.falseUnknown} (${report.metrics.falseUnknownRate}%)\n`);
process.stdout.write(`Report: ${outputPath}\n`);
if (report.status !== "passed") process.exitCode = 1;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
