import type { ActionAuditPacket, ActionIntent, AuditStore, LocalActionAdapter } from "./types.js";

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
