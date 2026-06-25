import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AgentConfig, AgentRunResult } from "../types.js";

export async function runAgentCommand(
  agent: AgentConfig,
  env: Record<string, string>,
  timeoutMs: number
): Promise<AgentRunResult> {
  const started = Date.now();
  const child = spawn(agent.command, agent.args, {
    env: { ...process.env, ...agent.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, timeoutMs);
  timer.unref();

  const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);

  return {
    exitCode,
    timedOut,
    stdout,
    stderr,
    durationMs: Date.now() - started
  };
}
