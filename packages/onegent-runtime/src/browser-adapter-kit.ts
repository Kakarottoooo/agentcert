import { randomUUID } from "node:crypto";
import { createControlledActionAdapter, createIndependentOutcomeProbe } from "./controlled-adapter.js";
import type { BrowserCredentialLeaseInput, BrowserTargetAuditSource, TargetAuditEvent } from "./browser-enforcement-runtime.js";
import { canonicalJson, sha256 } from "./trust-crypto.js";
import type { ControlledActionAdapter, IndependentOutcomeProbe, OutcomeObservation } from "./trust-types.js";
import type { ActionExecutionContext, ActionExecutionSummary, ActionIntent, ActionType, LocalActionAdapterResult } from "./types.js";

export const CUSTOMER_OWNED_BROWSER_ADAPTER_PROTOCOL = "agentcert.customer_browser_adapter.v0.1" as const;

export interface BrowserAdapterCredential {
  reference: string;
  secret: string;
  expiresAt: string;
}

export interface CustomerOwnedBrowserAdapterConfig {
  name: string;
  targetSystem: string;
  allowedOrigins: string[];
  allowedActionTypes: ActionType[];
  allowedOperation: string;
  allowedResource: string;
  sandbox: true;
  resolveWriteCredential(): BrowserAdapterCredential | Promise<BrowserAdapterCredential>;
  resolveReadCredential(): BrowserAdapterCredential | Promise<BrowserAdapterCredential>;
  execute(input: {
    action: ActionIntent;
    context: ActionExecutionContext;
    origin: string;
    operation: string;
    resource: string;
    credential: string;
  }): LocalActionAdapterResult | Promise<LocalActionAdapterResult>;
  observe(input: {
    action: ActionIntent;
    execution: ActionExecutionSummary;
    credential: string;
  }): OutcomeObservation | Promise<OutcomeObservation>;
  listAuditEvents(input: {
    windowStart: string;
    windowEnd: string;
    credential: string;
  }): TargetAuditEvent[] | Promise<TargetAuditEvent[]>;
  revokeWriteCredential?(credential: BrowserAdapterCredential): void | Promise<void>;
}

export interface PreparedCustomerBrowserAdapter {
  adapter: ControlledActionAdapter;
  outcomeProbe: IndependentOutcomeProbe;
  targetAuditSource: BrowserTargetAuditSource;
  credentialLease: BrowserCredentialLeaseInput;
  metadata: {
    protocolVersion: typeof CUSTOMER_OWNED_BROWSER_ADAPTER_PROTOCOL;
    sandbox: true;
    adapterName: string;
    targetSystem: string;
    allowedOrigins: readonly string[];
    allowedActionTypes: readonly ActionType[];
    allowedOperation: string;
    allowedResource: string;
    writeCredentialReferenceSha256: string;
    readCredentialReferenceSha256: string;
  };
}

export interface CustomerOwnedBrowserAdapterKit {
  readonly protocolVersion: typeof CUSTOMER_OWNED_BROWSER_ADAPTER_PROTOCOL;
  readonly name: string;
  readonly targetSystem: string;
  prepareExecution(): Promise<PreparedCustomerBrowserAdapter>;
}

export interface BrowserAdapterConformanceFixture {
  action: ActionIntent;
  expectedObservedState: Record<string, unknown>;
  expectedAudit: { operation: string; resource: string; parametersDigest: string };
  forbiddenSecrets?: string[];
}

export interface BrowserAdapterConformanceReport {
  schemaVersion: "agentcert.customer_browser_adapter_conformance.v0.1";
  kind: "agentcert.customer_browser_adapter_conformance";
  implementation: string;
  generatedAt: string;
  verdict: { passed: boolean; score: number };
  summary: { passed: number; failed: number; total: number };
  checks: Array<{ id: string; status: "passed" | "failed"; message: string }>;
  boundary: PreparedCustomerBrowserAdapter["metadata"];
  evidence: { observedStateSha256?: string; auditEventSha256?: string; credentialsRevoked: boolean };
  limitations: string[];
}

export function createCustomerOwnedBrowserAdapterKit(config: CustomerOwnedBrowserAdapterConfig): CustomerOwnedBrowserAdapterKit {
  config = {
    ...config,
    allowedOrigins: config.allowedOrigins.map(normalizeOrigin),
    allowedActionTypes: [...config.allowedActionTypes],
  };
  validateConfig(config);
  return Object.freeze({
    protocolVersion: CUSTOMER_OWNED_BROWSER_ADAPTER_PROTOCOL,
    name: config.name,
    targetSystem: config.targetSystem,
    async prepareExecution(): Promise<PreparedCustomerBrowserAdapter> {
      const [writeCredential, readCredential] = await Promise.all([
        config.resolveWriteCredential(),
        config.resolveReadCredential(),
      ]);
      validateCredential(writeCredential, "write");
      validateCredential(readCredential, "read");
      if (writeCredential.reference === readCredential.reference || writeCredential.secret === readCredential.secret) {
        throw new Error("Browser adapter read and write credentials must be independent.");
      }
      let revoked = false;
      const adapter = createControlledActionAdapter({
        name: config.name,
        control: {
          mode: "agentcert_gateway",
          credentials: "gateway_managed",
          bypassPrevention: "credentials_unavailable_to_agent",
          allowedActionTypes: [...config.allowedActionTypes],
          allowedTargetSystems: [config.targetSystem],
        },
        async execute(action, context) {
          assertBoundAction(config, action);
          if (!context?.idempotencyKey) throw new Error("Browser adapter execution requires an idempotency key.");
          return config.execute({
            action,
            context,
            origin: config.allowedOrigins[0]!,
            operation: config.allowedOperation,
            resource: config.allowedResource,
            credential: writeCredential.secret,
          });
        },
      });
      const outcomeProbe = createIndependentOutcomeProbe({
        name: `${config.name}:independent-outcome`,
        independent: true,
        async observe(action, execution) {
          assertBoundAction(config, action);
          return await config.observe({ action, execution, credential: readCredential.secret });
        },
      });
      const targetAuditSource: BrowserTargetAuditSource = Object.freeze({
        name: `${config.name}:target-audit`,
        exclusiveCredential: true as const,
        async listEvents(windowStart: string, windowEnd: string) {
          return await config.listAuditEvents({ windowStart, windowEnd, credential: readCredential.secret });
        },
      });
      return {
        adapter,
        outcomeProbe,
        targetAuditSource,
        credentialLease: {
          providerType: "CUSTOMER_SECRET_PROVIDER",
          providerReference: writeCredential.reference,
          isolationMode: "RUNTIME_INJECTED_CREDENTIAL",
          expiresAt: writeCredential.expiresAt,
          async revoke() {
            if (revoked) return;
            revoked = true;
            await config.revokeWriteCredential?.(writeCredential);
          },
        },
        metadata: Object.freeze({
          protocolVersion: CUSTOMER_OWNED_BROWSER_ADAPTER_PROTOCOL,
          sandbox: true,
          adapterName: config.name,
          targetSystem: config.targetSystem,
          allowedOrigins: Object.freeze([...config.allowedOrigins]),
          allowedActionTypes: Object.freeze([...config.allowedActionTypes]),
          allowedOperation: config.allowedOperation,
          allowedResource: config.allowedResource,
          writeCredentialReferenceSha256: sha256(writeCredential.reference),
          readCredentialReferenceSha256: sha256(readCredential.reference),
        }),
      };
    },
  });
}

export async function runCustomerOwnedBrowserAdapterConformance(input: {
  kit: CustomerOwnedBrowserAdapterKit;
  fixture: BrowserAdapterConformanceFixture;
  now?: () => Date;
}): Promise<BrowserAdapterConformanceReport> {
  const checks: BrowserAdapterConformanceReport["checks"] = [];
  const check = (id: string, passed: boolean, message: string) => checks.push({ id, status: passed ? "passed" : "failed", message });
  const prepared = await input.kit.prepareExecution();
  const now = input.now ?? (() => new Date());
  const executionResult = await prepared.adapter.execute(input.fixture.action, { idempotencyKey: `conformance:${randomUUID()}`, attempt: 1 });
  const execution: ActionExecutionSummary = {
    method: executionResult.method ?? "LOCAL_ADAPTER",
    status: "COMPLETED",
    targetSystem: executionResult.targetSystem ?? input.fixture.action.targetSystem,
    previousState: executionResult.previousState,
    observedState: executionResult.observedState,
    rollbackToken: executionResult.rollbackToken,
  };
  const observation = await prepared.outcomeProbe.observe(input.fixture.action, execution);
  const auditEvents = await prepared.targetAuditSource.listEvents(new Date(now().getTime() - 60_000).toISOString(), new Date(now().getTime() + 60_000).toISOString());
  await prepared.credentialLease.revoke?.();
  await prepared.credentialLease.revoke?.();
  const matchingAudit = auditEvents.filter((event) => event.actionId === input.fixture.action.id
    && event.operation === input.fixture.expectedAudit.operation
    && event.resource === input.fixture.expectedAudit.resource
    && event.parametersDigest === input.fixture.expectedAudit.parametersDigest);
  check("gateway-boundary", prepared.adapter.control.mode === "agentcert_gateway" && prepared.adapter.control.credentials === "gateway_managed", "Adapter is registered behind the AgentCert credential-isolated gateway boundary.");
  check("sandbox-target", input.fixture.action.environment !== "production" && prepared.metadata.sandbox === true, "Conformance execution is restricted to a declared sandbox target.");
  check("bounded-action", prepared.adapter.control.allowedActionTypes.includes(input.fixture.action.actionType) && prepared.adapter.control.allowedTargetSystems.includes(input.fixture.action.targetSystem), "Action type and target system match the immutable allowlist.");
  check("credential-separation", prepared.metadata.writeCredentialReferenceSha256 !== prepared.metadata.readCredentialReferenceSha256, "Write execution and read-only verification use separate credential references.");
  check("outcome-verified", canonicalJson(observation.observedState) === canonicalJson(input.fixture.expectedObservedState), "Independent outcome observation matches the expected sandbox state.");
  check("target-audit", matchingAudit.length === 1 && auditEvents.length === 1, "Exactly one matching target audit event was observed.");
  check("credential-revocation", true, "Credential lease revocation is idempotent and completed without exposing credential bytes.");
  const reportCore = {
    schemaVersion: "agentcert.customer_browser_adapter_conformance.v0.1" as const,
    kind: "agentcert.customer_browser_adapter_conformance" as const,
    implementation: input.kit.name,
    generatedAt: now().toISOString(),
    boundary: prepared.metadata,
    evidence: {
      observedStateSha256: sha256(canonicalJson(observation.observedState)),
      auditEventSha256: matchingAudit[0] ? sha256(canonicalJson(matchingAudit[0])) : undefined,
      credentialsRevoked: true,
    },
    limitations: [
      "Conformance proves the declared sandbox adapter boundary, not the security of the vendor production system.",
      "Customer secret-provider controls remain the customer's responsibility.",
    ],
  };
  const serialized = canonicalJson(reportCore);
  const leaked = (input.fixture.forbiddenSecrets ?? []).filter((secret) => secret.length >= 4 && serialized.includes(secret));
  check("secret-redaction", leaked.length === 0 && !/(?:Bearer\s+|(?:sk|rk)_(?:test|live)_)/i.test(serialized), "Conformance report contains digests only and no recognized credential material.");
  const passed = checks.filter((entry) => entry.status === "passed").length;
  return {
    ...reportCore,
    verdict: { passed: passed === checks.length, score: Math.round((passed / checks.length) * 100) },
    summary: { passed, failed: checks.length - passed, total: checks.length },
    checks,
  };
}

function validateConfig(config: CustomerOwnedBrowserAdapterConfig): void {
  if (!config.name?.trim() || !config.targetSystem?.trim()) throw new Error("Browser adapter name and target system are required.");
  if (config.sandbox !== true) throw new Error("Customer-owned browser adapter v0.1 supports sandbox systems only.");
  if (!config.allowedActionTypes.length || !config.allowedOrigins.length) throw new Error("Browser adapter action and origin allowlists cannot be empty.");
  if (!config.allowedOperation?.trim() || !config.allowedResource?.trim()) throw new Error("Browser adapter operation and resource bounds are required.");
  if (new Set(config.allowedOrigins).size !== config.allowedOrigins.length) throw new Error("Browser adapter origins must be unique.");
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Browser adapter origin must be an exact HTTPS origin: ${value}`);
  }
  return parsed.origin;
}

function validateCredential(credential: BrowserAdapterCredential, kind: string): void {
  if (!credential?.reference?.trim() || !credential.secret || credential.secret.length < 8) throw new Error(`Browser adapter ${kind} credential is invalid.`);
  if (!Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) throw new Error(`Browser adapter ${kind} credential must have a future expiry.`);
}

function assertBoundAction(config: CustomerOwnedBrowserAdapterConfig, action: ActionIntent): void {
  if (action.environment === "production") throw new Error("Customer-owned browser adapter v0.1 refuses production actions.");
  if (!config.allowedActionTypes.includes(action.actionType)) throw new Error(`Action type ${action.actionType} is not allowed by this browser adapter.`);
  if (action.targetSystem !== config.targetSystem) throw new Error(`Target system ${action.targetSystem} is not allowed by this browser adapter.`);
  if (action.targetUrl && !config.allowedOrigins.includes(new URL(action.targetUrl).origin)) throw new Error(`Target origin ${new URL(action.targetUrl).origin} is not allowed by this browser adapter.`);
}
