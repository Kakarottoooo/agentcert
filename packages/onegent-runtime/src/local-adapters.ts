import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ActionAuditPacket,
  ActionIntent,
  AuditStore,
  LocalActionAdapter,
} from "./types.js";

export function createLocalEchoAdapter(name = "local-echo-adapter"): LocalActionAdapter {
  return {
    name,
    execute: (action: ActionIntent) => ({
      method: "LOCAL_ADAPTER",
      targetSystem: action.targetSystem,
      previousState: action.beforeState,
      observedState: action.proposedAfterState,
    }),
  };
}

export function createInMemoryAuditStore(name = "in-memory-audit-store"): AuditStore & {
  packets: ActionAuditPacket[];
} {
  const packets: ActionAuditPacket[] = [];
  return {
    name,
    packets,
    writeAuditPacket: (packet) => {
      packets.push(packet);
    },
  };
}

export function createJsonlAuditStore(filePath: string, name = "jsonl-audit-store"): AuditStore & { filePath: string } {
  const absolutePath = resolve(filePath);
  return {
    name,
    filePath: absolutePath,
    writeAuditPacket: async (packet) => {
      await mkdir(dirname(absolutePath), { recursive: true });
      await appendFile(absolutePath, `${JSON.stringify(packet)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(absolutePath, 0o600);
    },
  };
}

export interface StateSandboxAdapterOptions {
  name?: string;
  allowedTargetSystems: string[];
  initialState?: Record<string, Record<string, unknown>>;
}

export function createStateSandboxAdapter(options: StateSandboxAdapterOptions): LocalActionAdapter & {
  getState(businessObjectId: string): Record<string, unknown> | undefined;
} {
  if (options.allowedTargetSystems.length === 0) throw new Error("A sandbox adapter requires at least one allowed target system.");
  const states = new Map(
    Object.entries(options.initialState ?? {}).map(([key, value]) => [key, structuredClone(value)]),
  );
  const safety = {
    mode: "sandbox" as const,
    allowedTargetSystems: [...new Set(options.allowedTargetSystems)],
    networkAccess: false as const,
  };
  const assertSafe = (action: ActionIntent) => {
    if (action.environment === "production") throw new Error("The state sandbox adapter refuses production actions.");
    if (!safety.allowedTargetSystems.includes(action.targetSystem)) {
      throw new Error(`Target system ${action.targetSystem} is not on the sandbox allowlist.`);
    }
  };
  return {
    name: options.name ?? "state-sandbox-adapter",
    safety,
    execute: (action) => {
      assertSafe(action);
      const previousState = structuredClone(states.get(action.businessObjectId) ?? action.beforeState);
      const observedState = structuredClone(action.proposedAfterState);
      states.set(action.businessObjectId, observedState);
      return {
        method: "LOCAL_ADAPTER",
        targetSystem: action.targetSystem,
        previousState,
        observedState,
        rollbackToken: action.idempotencyKey,
      };
    },
    rollback: (action, execution) => {
      assertSafe(action);
      const restored = structuredClone(execution.previousState ?? action.beforeState);
      states.set(action.businessObjectId, restored);
      return { success: true, observedState: restored, message: "Sandbox state restored to the pre-execution snapshot." };
    },
    getState: (businessObjectId) => {
      const value = states.get(businessObjectId);
      return value ? structuredClone(value) : undefined;
    },
  };
}
