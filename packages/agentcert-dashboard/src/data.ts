import type { MonitorSnapshot } from "./types";

export async function loadMonitorSnapshot(): Promise<MonitorSnapshot> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/monitor.json`, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not load monitor data (${response.status})`);
  }
  const data = (await response.json()) as MonitorSnapshot;
  if (data.kind !== "agentcert.monitor_snapshot") {
    throw new Error("Monitor data is not an AgentCert monitor snapshot.");
  }
  return data;
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
