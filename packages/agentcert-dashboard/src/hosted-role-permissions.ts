import type { HostedMemberRole } from "./hosted-api";

export function canManageHostedProjects(role?: HostedMemberRole): boolean {
  return role === "owner" || role === "admin";
}
