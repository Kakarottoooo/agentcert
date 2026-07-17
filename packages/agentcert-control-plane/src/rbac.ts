import type { ApiKeyScope, MemberRole } from "./types.js";

const READ_ROLES: readonly MemberRole[] = ["owner", "admin", "operator", "viewer"];
const WRITE_ROLES: readonly MemberRole[] = ["owner", "admin", "operator"];

export function rolesForHumanScope(scope?: ApiKeyScope): readonly MemberRole[] {
  if (!scope || scope.endsWith(":read")) return READ_ROLES;
  return WRITE_ROLES;
}

export function canInviteRole(actor: MemberRole, invited: MemberRole): boolean {
  if (actor === "owner") return true;
  return actor === "admin" && (invited === "operator" || invited === "viewer");
}

export function canManageMember(actor: MemberRole, target: MemberRole, next?: MemberRole): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin" || target === "owner" || target === "admin") return false;
  return !next || next === "operator" || next === "viewer";
}

export function roleNeedsExplicitProjects(role: MemberRole): boolean {
  return role === "operator" || role === "viewer";
}
