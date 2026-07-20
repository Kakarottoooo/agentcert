import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { evaluateSemanticGoldenDataset, parseSemanticGoldenDataset } from "../src/semantic-calibration.js";
import { classifySemanticEvent } from "../src/semantics.js";
import type { EventRecord, RunRecord } from "../src/types.js";

const datasetUrl = new URL("../../../datasets/agent-semantics/golden-v0.1.json", import.meta.url);

describe("semantic adapter calibration", () => {
  it("covers exactly five source-pinned external integrations", async () => {
    const dataset = parseSemanticGoldenDataset(JSON.parse(await readFile(datasetUrl, "utf8")));
    expect(dataset.adapters.map((adapter) => adapter.category)).toEqual(["browser", "coding", "data", "messaging", "finance"]);
    expect(dataset.adapters.every((adapter) => /^[a-f0-9]{40}$/.test(adapter.sourceRef))).toBe(true);
  });

  it("reports exact matches, false unknowns, misclassifications, and false known controls", async () => {
    const report = evaluateSemanticGoldenDataset(JSON.parse(await readFile(datasetUrl, "utf8")), "2026-07-20T00:00:00.000Z");
    expect(report).toMatchObject({
      status: "passed",
      metrics: { total: 33, expectedKnown: 28, expectedUnknown: 5, exact: 33, falseUnknown: 0, misclassified: 0, falseKnown: 0, exactMatchRate: 100, falseUnknownRate: 0 },
      controls: { status: "passed" },
    });
    expect(report.adapters).toHaveLength(5);
    expect(report.adapters.every((adapter) => adapter.status === "passed")).toBe(true);
  });

  it("uses OpenHands command arguments to distinguish editor reads from writes", () => {
    expect(classifyOpenHandsEditor("view")).toMatchObject({ capabilityId: "coding.read", resolution: "adapter_rule" });
    expect(classifyOpenHandsEditor("str_replace")).toMatchObject({ capabilityId: "coding.write", resolution: "adapter_rule" });
    expect(classifyOpenHandsEditor("unrecognized_command")).toMatchObject({ capabilityId: undefined, resolution: "unknown" });
  });
});

function classifyOpenHandsEditor(command: string) {
  const run: RunRecord = {
    id: "00000000-0000-4000-8000-000000000010", projectId: "00000000-0000-4000-8000-000000000001",
    externalId: `editor-${command}`, kind: "custom", status: "passed", schemaVersion: "1",
    startedAt: "2026-07-20T00:00:00.000Z", metadata: { framework: "OpenHands" },
  };
  const event: EventRecord = {
    id: "00000000-0000-4000-8000-000000000011", projectId: run.projectId, runId: run.id, sequence: 0,
    type: "tool.completed", actor: "openhands", occurredAt: run.startedAt,
    payload: { toolName: "str_replace_editor", tool_input: { command } },
  };
  return classifySemanticEvent({ event, run });
}
