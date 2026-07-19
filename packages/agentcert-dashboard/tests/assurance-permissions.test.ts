import { describe, expect, it } from "vitest";
import { canManageAssurance, canUseAssuranceTransition } from "../src/assurance-permissions";

describe("assurance role permissions", () => {
  it("allows operators to issue an independent report without administering its contract", () => {
    expect(canUseAssuranceTransition("operator", "issue")).toBe(true);
    expect(canUseAssuranceTransition("operator", "return")).toBe(false);
    expect(canUseAssuranceTransition("operator", "revoke")).toBe(false);
    expect(canManageAssurance("operator")).toBe(false);
  });

  it("keeps assurance administration with owners and admins", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(canManageAssurance(role)).toBe(true);
      expect(canUseAssuranceTransition(role, "issue")).toBe(true);
      expect(canUseAssuranceTransition(role, "revoke")).toBe(true);
    }
    expect(canUseAssuranceTransition("viewer", "issue")).toBe(false);
  });
});
