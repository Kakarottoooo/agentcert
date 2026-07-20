import type { HostedAssuranceCase } from "./hosted-api";

export type CurrentAssuranceStatus = "CURRENT" | "REVALIDATION_REQUIRED" | "SUSPENDED" | "EXPIRED" | "NOT_CONFIGURED";

export interface CurrentAssuranceSummary {
  status: CurrentAssuranceStatus;
  title: string;
  reason: string;
  assuranceCase?: HostedAssuranceCase;
}

const STATUS_PRIORITY = {
  SUSPENDED: 0,
  EXPIRED: 1,
  REVALIDATION_REQUIRED: 2,
  CURRENT: 3,
} as const;

const STATUS_TITLE = {
  CURRENT: "The reviewed scope is current",
  REVALIDATION_REQUIRED: "The reviewed scope must be revalidated",
  SUSPENDED: "Assurance is suspended",
  EXPIRED: "The assurance decision has expired",
} as const;

export function summarizeCurrentAssurance(cases: HostedAssuranceCase[]): CurrentAssuranceSummary {
  const assuranceCase = cases
    .filter((item) => item.continuousAssurance)
    .sort((left, right) => STATUS_PRIORITY[left.continuousAssurance!.freshness.status] - STATUS_PRIORITY[right.continuousAssurance!.freshness.status])[0];

  if (!assuranceCase?.continuousAssurance) return {
    status: "NOT_CONFIGURED",
    title: "No reviewed assurance baseline",
    reason: "Create a scoped review before treating test results as a current release decision.",
  };

  const freshness = assuranceCase.continuousAssurance.freshness;
  return {
    status: freshness.status,
    title: STATUS_TITLE[freshness.status],
    reason: freshness.reason,
    assuranceCase,
  };
}
