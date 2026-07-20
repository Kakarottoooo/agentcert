import { describe, expect, it } from "vitest";

import { summarizeCurrentAssurance } from "../src/current-assurance";
import type { HostedAssuranceCase } from "../src/hosted-api";

function assuranceCase(status: "CURRENT" | "REVALIDATION_REQUIRED" | "SUSPENDED" | "EXPIRED", reason = `${status} reason`): HostedAssuranceCase {
  return {
    id: status,
    name: `${status} case`,
    continuousAssurance: {
      freshness: { status, reason },
    },
  } as HostedAssuranceCase;
}

describe("current assurance summary", () => {
  it("makes an absent baseline explicit", () => {
    expect(summarizeCurrentAssurance([])).toMatchObject({
      status: "NOT_CONFIGURED",
      title: "No reviewed assurance baseline",
    });
  });

  it("reports a current reviewed scope", () => {
    expect(summarizeCurrentAssurance([assuranceCase("CURRENT")])).toMatchObject({
      status: "CURRENT",
      title: "The reviewed scope is current",
      reason: "CURRENT reason",
    });
  });

  it("surfaces the most restrictive state across multiple contracts", () => {
    const summary = summarizeCurrentAssurance([
      assuranceCase("CURRENT"),
      assuranceCase("REVALIDATION_REQUIRED"),
      assuranceCase("EXPIRED"),
      assuranceCase("SUSPENDED", "Policy owner suspended this scope."),
    ]);

    expect(summary).toMatchObject({
      status: "SUSPENDED",
      reason: "Policy owner suspended this scope.",
      assuranceCase: { id: "SUSPENDED" },
    });
  });
});
