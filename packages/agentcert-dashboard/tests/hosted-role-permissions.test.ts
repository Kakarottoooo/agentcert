import { describe, expect, it } from "vitest";

import { canManageHostedProjects } from "../src/hosted-role-permissions";

describe("hosted project role permissions", () => {
  it("loads project onboarding and mutation controls only for owners and admins", () => {
    expect(canManageHostedProjects("owner")).toBe(true);
    expect(canManageHostedProjects("admin")).toBe(true);
    expect(canManageHostedProjects("operator")).toBe(false);
    expect(canManageHostedProjects("viewer")).toBe(false);
    expect(canManageHostedProjects(undefined)).toBe(false);
  });
});
