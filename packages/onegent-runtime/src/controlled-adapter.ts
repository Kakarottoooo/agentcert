import type { ControlledActionAdapter, IndependentOutcomeProbe } from "./trust-types.js";

const registeredAdapters = new WeakSet<object>();
const registeredProbes = new WeakSet<object>();

export function createControlledActionAdapter(adapter: ControlledActionAdapter): ControlledActionAdapter {
  validateBoundary(adapter);
  const controlled = Object.freeze({
    ...adapter,
    control: Object.freeze({
      ...adapter.control,
      allowedActionTypes: Object.freeze([...adapter.control.allowedActionTypes]),
      allowedTargetSystems: Object.freeze([...adapter.control.allowedTargetSystems]),
    }),
  }) as ControlledActionAdapter;
  registeredAdapters.add(controlled);
  return controlled;
}

export function isRegisteredControlledActionAdapter(adapter: ControlledActionAdapter): boolean {
  return registeredAdapters.has(adapter);
}

export function createIndependentOutcomeProbe(probe: IndependentOutcomeProbe): IndependentOutcomeProbe {
  if (!probe.name?.trim() || probe.independent !== true) throw new Error("Independent outcome probe name and boundary are required.");
  const controlled = Object.freeze({ ...probe, independent: true as const });
  registeredProbes.add(controlled);
  return controlled;
}

export function isRegisteredIndependentOutcomeProbe(probe: IndependentOutcomeProbe): boolean {
  return registeredProbes.has(probe);
}

function validateBoundary(adapter: ControlledActionAdapter): void {
  if (!adapter.name?.trim()) throw new Error("Controlled adapter name is required.");
  const control = adapter.control;
  if (!control || control.mode !== "agentcert_gateway" || control.credentials !== "gateway_managed"
    || control.bypassPrevention !== "credentials_unavailable_to_agent") {
    throw new Error(`Adapter ${adapter.name} does not provide the required AgentCert credential-isolated gateway boundary.`);
  }
  if (!control.allowedActionTypes.length || !control.allowedTargetSystems.length) {
    throw new Error(`Adapter ${adapter.name} must declare bounded action types and target systems.`);
  }
}
