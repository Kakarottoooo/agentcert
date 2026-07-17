export const HOSTED_VIEWS = [
  "overview", "agents", "runs", "assurance", "sandbox", "gates", "actions", "incidents", "evidence", "integrations", "governance", "account",
] as const;

export type HostedView = typeof HOSTED_VIEWS[number];
export type HostedFocus = "email-alerts";

export interface HostedRoute {
  view: HostedView;
  focus?: HostedFocus;
  projectId?: string;
}

export function resolveHostedRoute(search: string): HostedRoute {
  const params = new URLSearchParams(search);
  const requestedView = params.get("view");
  const view = HOSTED_VIEWS.includes(requestedView as HostedView) ? requestedView as HostedView : "overview";
  const focus = params.get("focus") === "email-alerts" ? "email-alerts" : undefined;
  const projectId = params.get("project")?.trim() || undefined;
  return {
    view,
    ...(focus ? { focus } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

export function buildHostedWorkspaceUrl(publicUrl: string, route: HostedRoute): string {
  const url = new URL("/app", publicUrl);
  if (route.view !== "overview") url.searchParams.set("view", route.view);
  if (route.focus) url.searchParams.set("focus", route.focus);
  if (route.projectId) url.searchParams.set("project", route.projectId);
  return url.toString();
}
