import { describe, expect, it } from "vitest";
import { TraceDiffer } from "../../src/diff/TraceDiffer.js";
import type { TraceMetadata } from "../../src/types.js";

describe("TraceDiffer", () => {
  it("finds the first divergent URL and text hash", () => {
    const base = trace(["/one", "/two"], ["a", "b"]);
    const current = trace(["/one", "/three"], ["a", "c"]);
    const diff = TraceDiffer.compare(base, current);
    expect(diff.firstUrlDifference?.stepIndex).toBe(2);
    expect(diff.firstTextHashDifference?.stepIndex).toBe(2);
  });
});

function trace(urls: string[], hashes: string[]): TraceMetadata {
  return {
    runId: "r",
    scenarioName: "s",
    fault: { name: "clean", type: "none" },
    startUrl: urls[0],
    cdpUrl: "http://127.0.0.1:1",
    startedAt: new Date().toISOString(),
    warnings: [],
    requests: [],
    networkErrors: [],
    consoleErrors: [],
    steps: urls.map((url, index) => ({
      stepIndex: index + 1,
      timestamp: new Date().toISOString(),
      url,
      domHash: hashes[index],
      textHash: hashes[index],
      visibleTextSample: "",
      consoleErrors: [],
      networkErrors: [],
      agentEvents: []
    }))
  };
}
