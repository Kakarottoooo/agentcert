import { describe, expect, it } from "vitest";
import { renderCommandHelp } from "../src/command-help.js";

describe("CLI command help", () => {
  it("documents push without requiring evidence or credentials", () => {
    const help = renderCommandHelp("push");
    expect(help).toContain("agentcert push --evidence");
    expect(help).toContain("--artifact-root");
    expect(help).toContain("--no-artifacts");
  });

  it("leaves existing command handlers responsible for other help", () => {
    expect(renderCommandHelp("connect")).toBeUndefined();
  });
});
