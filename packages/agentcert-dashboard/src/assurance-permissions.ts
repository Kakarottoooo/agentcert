import type { HostedMemberRole } from "./hosted-api";

export type AssuranceTransition = "start" | "submit" | "return" | "issue" | "suspend" | "resume" | "revoke" | "expire";

export function canManageAssurance(role?: HostedMemberRole): boolean {
  return role === "owner" || role === "admin";
}

export function canUseAssuranceTransition(role: HostedMemberRole | undefined, transition: AssuranceTransition): boolean {
  if (transition === "issue") return role === "owner" || role === "admin" || role === "operator";
  return canManageAssurance(role);
}
