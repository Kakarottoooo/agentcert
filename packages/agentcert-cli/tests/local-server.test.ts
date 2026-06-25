import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCorpus } from "../src/corpus.js";
import { buildRunDetail } from "../src/local-server.js";

describe("AgentCert local server run detail", () => {
  it("builds an evidence detail payload from Tripwire artifacts", async () => {
    const records = await readCorpus("../../public-demo/browser-agent-robustness/evidence/agentcert-corpus.jsonl");
    const failed = records.find((record) => record.faultName === "modal-overlay");

    expect(failed).toBeDefined();
    const detail = await buildRunDetail(
      failed!,
      resolve("../../public-demo/browser-agent-robustness/evidence/tripwire-public-demo"),
    );

    expect(detail.assertions.some((assertion) => assertion.pass === false)).toBe(true);
    expect(detail.timeline.some((item) => item.kind === "failure")).toBe(true);
    expect(detail.timeline.some((item) => item.kind === "agent-action")).toBe(true);
    expect(detail.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
    expect(detail.finalUrl).toContain("/refund");
  });
});
