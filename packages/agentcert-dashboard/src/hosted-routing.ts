import type { HostedNextAction } from "./hosted-api";

export const HOSTED_VIEWS = [
  "overview", "agents", "runs", "assurance", "sandbox", "gates", "actions", "incidents", "evidence", "integrations", "team", "governance", "account",
] as const;

export type HostedView = typeof HOSTED_VIEWS[number];
export type HostedFocus = "email-alerts";
export type HostedTarget = { kind: "case" | "action" | "incident" | "run"; id: string };

export interface HostedRoute {
  view: HostedView;
  focus?: HostedFocus;
  projectId?: string;
  target?: HostedTarget;
}

export function resolveHostedRoute(search: string): HostedRoute {
  const params = new URLSearchParams(search);
  const requestedView = params.get("view");
  const view = HOSTED_VIEWS.includes(requestedView as HostedView) ? requestedView as HostedView : "overview";
  const focus = params.get("focus") === "email-alerts" ? "email-alerts" : undefined;
  const projectId = params.get("project")?.trim() || undefined;
  const target = params.get("incidentId")?.trim()
    ? { kind: "incident" as const, id: params.get("incidentId")!.trim() }
    : params.get("actionId")?.trim()
      ? { kind: "action" as const, id: params.get("actionId")!.trim() }
      : params.get("caseId")?.trim()
        ? { kind: "case" as const, id: params.get("caseId")!.trim() }
        : params.get("runId")?.trim() ? { kind: "run" as const, id: params.get("runId")!.trim() } : undefined;
  return {
    view,
    ...(focus ? { focus } : {}),
    ...(projectId ? { projectId } : {}),
    ...(target ? { target } : {}),
  };
}

export function buildHostedWorkspaceUrl(publicUrl: string, route: HostedRoute): string {
  const url = new URL("/app", publicUrl);
  if (route.view !== "overview") url.searchParams.set("view", route.view);
  if (route.focus) url.searchParams.set("focus", route.focus);
  if (route.projectId) url.searchParams.set("project", route.projectId);
  if (route.target) url.searchParams.set(`${route.target.kind}Id`, route.target.id);
  return url.toString();
}

export function targetForNextAction(action: Pick<HostedNextAction, "context">): HostedTarget | undefined {
  if (action.context.incidentId) return { kind: "incident", id: action.context.incidentId };
  if (action.context.actionId) return { kind: "action", id: action.context.actionId };
  if (action.context.assuranceCaseId) return { kind: "case", id: action.context.assuranceCaseId };
  if (action.context.runId) return { kind: "run", id: action.context.runId };
  return undefined;
}
