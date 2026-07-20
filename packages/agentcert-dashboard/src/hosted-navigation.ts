import type { HostedView } from "./hosted-routing";

export type WorkspaceArea = "current" | "release" | "runtime" | "evidence" | "setup" | "advanced" | "account";

export interface WorkspaceNavigationItem {
  view: HostedView;
  label: string;
  description: string;
}

export const PRIMARY_WORKSPACE_NAVIGATION: readonly WorkspaceNavigationItem[] = [
  { view: "overview", label: "Current assurance", description: "Validity and attention required" },
  { view: "assurance", label: "Release assurance", description: "Reviews, test runs, and release gates" },
  { view: "actions", label: "Runtime assurance", description: "Action decisions and incidents" },
  { view: "evidence", label: "Evidence & audit", description: "Integrity, retention, and export" },
];

const AREA_BY_VIEW: Record<HostedView, WorkspaceArea> = {
  overview: "current",
  assurance: "release",
  runs: "release",
  gates: "release",
  actions: "runtime",
  incidents: "runtime",
  evidence: "evidence",
  agents: "setup",
  integrations: "setup",
  team: "setup",
  sandbox: "advanced",
  governance: "advanced",
  account: "account",
};

const TABS_BY_AREA: Partial<Record<WorkspaceArea, readonly WorkspaceNavigationItem[]>> = {
  release: [
    { view: "assurance", label: "Reviews & validity", description: "Scoped decisions and continuous assurance" },
    { view: "runs", label: "Test runs", description: "Behavior traces and diagnostics" },
    { view: "gates", label: "Release gates", description: "Automated release decisions" },
  ],
  runtime: [
    { view: "actions", label: "Action queue", description: "Policy, approval, and outcome verification" },
    { view: "incidents", label: "Incidents", description: "Investigation, recovery, and resolution" },
  ],
  setup: [
    { view: "agents", label: "Agents", description: "Identity, version, and permissions" },
    { view: "integrations", label: "Connections", description: "CLI, API keys, webhooks, and alerts" },
    { view: "team", label: "Team & access", description: "Members, roles, and project grants" },
  ],
  advanced: [
    { view: "sandbox", label: "Sandbox certification", description: "Adapter and vendor test-mode checks" },
    { view: "governance", label: "Platform governance", description: "Legal holds, retention, and pilot operations" },
  ],
};

const AREA_HEADINGS: Record<WorkspaceArea, { title: string; description: string }> = {
  current: { title: "Current assurance", description: "Is this agent still within its reviewed and verified scope?" },
  release: { title: "Release assurance", description: "Test the declared scope and decide whether it is ready to ship." },
  runtime: { title: "Runtime assurance", description: "Decide consequential actions and verify what actually happened." },
  evidence: { title: "Evidence & audit", description: "Inspect integrity, provenance, retention, and signed records." },
  setup: { title: "Setup", description: "Connect agents, machine credentials, alerts, and team access." },
  advanced: { title: "Advanced", description: "Operate sandbox certification and platform governance controls." },
  account: { title: "Account center", description: "Manage this user session and account security." },
};

export function workspaceAreaForView(view: HostedView): WorkspaceArea {
  return AREA_BY_VIEW[view];
}

export function workspaceHeading(view: HostedView): { title: string; description: string } {
  return AREA_HEADINGS[workspaceAreaForView(view)];
}

export function workspaceTabs(view: HostedView, platformAdmin: boolean): readonly WorkspaceNavigationItem[] {
  const area = workspaceAreaForView(view);
  const tabs = TABS_BY_AREA[area] ?? [];
  return platformAdmin ? tabs : tabs.filter((item) => item.view !== "governance");
}

export function secondaryWorkspaceNavigation(platformAdmin: boolean): Array<{
  id: "setup" | "advanced";
  label: string;
  items: readonly WorkspaceNavigationItem[];
}> {
  return [
    { id: "setup", label: "Setup", items: TABS_BY_AREA.setup! },
    { id: "advanced", label: "Advanced", items: platformAdmin ? TABS_BY_AREA.advanced! : TABS_BY_AREA.advanced!.filter((item) => item.view !== "governance") },
  ];
}
