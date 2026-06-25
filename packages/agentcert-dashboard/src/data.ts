import type { MonitorSnapshot, RunDetail } from "./types";

export interface MonitorLoadResult {
  snapshot: MonitorSnapshot;
  source: "api" | "static";
}

export async function loadMonitorSnapshot(): Promise<MonitorLoadResult> {
  const apiSnapshot = await loadApiMonitorSnapshot();
  if (apiSnapshot) {
    return { snapshot: apiSnapshot, source: "api" };
  }

  const response = await fetch(`${import.meta.env.BASE_URL}data/monitor.json`, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not load monitor data (${response.status})`);
  }
  const data = (await response.json()) as MonitorSnapshot;
  if (data.kind !== "agentcert.monitor_snapshot") {
    throw new Error("Monitor data is not an AgentCert monitor snapshot.");
  }
  return { snapshot: data, source: "static" };
}

export async function loadRunDetail(runId: string): Promise<RunDetail | undefined> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-cache" }).catch(() => undefined);
  if (!response?.ok) {
    return undefined;
  }
  return (await response.json()) as RunDetail;
}

async function loadApiMonitorSnapshot(): Promise<MonitorSnapshot | undefined> {
  if (window.location.protocol === "file:") {
    return undefined;
  }
  const response = await fetch("/api/monitor", { cache: "no-cache" }).catch(() => undefined);
  if (!response?.ok) {
    return undefined;
  }
  const data = (await response.json()) as MonitorSnapshot;
  return data.kind === "agentcert.monitor_snapshot" ? data : undefined;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function compactDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function compactDuration(ms?: number): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function compactBytes(bytes?: number): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
