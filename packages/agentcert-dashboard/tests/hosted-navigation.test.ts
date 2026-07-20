import { describe, expect, it } from "vitest";

import {
  PRIMARY_WORKSPACE_NAVIGATION,
  secondaryWorkspaceNavigation,
  workspaceAreaForView,
  workspaceHeading,
  workspaceTabs,
} from "../src/hosted-navigation";

describe("hosted workspace navigation", () => {
  it("presents only the four customer assurance tasks as primary navigation", () => {
    expect(PRIMARY_WORKSPACE_NAVIGATION.map((item) => item.label)).toEqual([
      "Current assurance",
      "Release assurance",
      "Runtime assurance",
      "Evidence & audit",
    ]);
  });

  it("keeps legacy deep links inside their customer task", () => {
    expect(workspaceAreaForView("runs")).toBe("release");
    expect(workspaceAreaForView("gates")).toBe("release");
    expect(workspaceAreaForView("incidents")).toBe("runtime");
    expect(workspaceAreaForView("team")).toBe("setup");
    expect(workspaceHeading("runs").title).toBe("Release assurance");
  });

  it("uses contextual tabs instead of adding internal modules to the main navigation", () => {
    expect(workspaceTabs("assurance", false).map((item) => item.view)).toEqual(["assurance", "runs", "gates"]);
    expect(workspaceTabs("actions", false).map((item) => item.view)).toEqual(["actions", "incidents"]);
  });

  it("keeps platform governance out of non-admin advanced navigation", () => {
    const memberAdvanced = secondaryWorkspaceNavigation(false).find((group) => group.id === "advanced")!;
    const adminAdvanced = secondaryWorkspaceNavigation(true).find((group) => group.id === "advanced")!;
    expect(memberAdvanced.items.map((item) => item.view)).toEqual(["sandbox"]);
    expect(adminAdvanced.items.map((item) => item.view)).toEqual(["sandbox", "governance"]);
  });
});
