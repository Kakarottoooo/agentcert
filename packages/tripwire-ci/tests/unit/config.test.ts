import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("config loading", () => {
  it("applies defaults and validates fault config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tripwire-config-"));
    const file = path.join(dir, "tripwire.yml");
    await writeFile(
      file,
      `project: demo
scenarios:
  - name: one
    startUrl: http://127.0.0.1:3020/refund
    agent:
      command: node
    faults:
      - name: drift
        type: changed_button_text
        from: Submit
        to: Continue
      - name: misleading
        type: misleading_button
      - name: disabled
        type: disabled_submit
      - name: shift
        type: layout_shift
`,
      "utf8"
    );
    const config = await loadConfig(file);
    expect(config.scenarios[0].timeoutMs).toBe(60000);
    expect(config.scenarios[0].capture.screenshots).toBe(true);
    expect(config.scenarios[0].faults[0].type).toBe("changed_button_text");
    expect(config.scenarios[0].faults[1]).toMatchObject({ type: "misleading_button", text: "Submit" });
    expect(config.scenarios[0].faults[2]).toMatchObject({ type: "disabled_submit", buttonText: "Submit", delayMs: 3000 });
    expect(config.scenarios[0].faults[3]).toMatchObject({ type: "layout_shift", delayMs: 500, heightPx: 240 });
  });

  it("gives readable invalid YAML errors", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tripwire-config-"));
    const file = path.join(dir, "tripwire.yml");
    await writeFile(file, "project: [", "utf8");
    await expect(loadConfig(file)).rejects.toThrow(/Could not parse YAML/);
  });
});
