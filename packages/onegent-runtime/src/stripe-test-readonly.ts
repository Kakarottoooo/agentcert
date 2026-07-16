import {
  createBoundedVendorSandboxEgress,
  VendorSandboxEgressError,
  type VendorSandboxRequestAudit,
} from "./vendor-sandbox-egress.js";

export const STRIPE_TEST_API_ORIGIN = "https://api.stripe.com" as const;
export const STRIPE_SANDBOX_TIMEOUT_MS = 5_000;
export const STRIPE_SANDBOX_MAX_REQUESTS_PER_MINUTE = 10;
export const STRIPE_PAYMENT_INTENT_RETRIEVE = "stripe.payment_intent.retrieve" as const;
export const STRIPE_PAYMENT_INTENT_LIST = "stripe.payment_intent.list" as const;

const STRIPE_RESOURCES = Object.freeze([
  Object.freeze({
    id: STRIPE_PAYMENT_INTENT_RETRIEVE,
    method: "GET" as const,
    pathPattern: /^\/v1\/payment_intents\/pi_[A-Za-z0-9]{8,128}$/,
  }),
  Object.freeze({
    id: STRIPE_PAYMENT_INTENT_LIST,
    method: "GET" as const,
    pathPattern: /^\/v1\/payment_intents\?limit=(?:[1-9]|10)$/,
  }),
]);

export interface StripePaymentIntentSnapshot {
  id: string;
  object: "payment_intent";
  livemode: false;
  amount?: number;
  amountCapturable?: number;
  amountReceived?: number;
  currency?: string;
  status?: string;
  created?: number;
}

export interface StripeTestModeReadOnlyAdapter {
  readonly name: "stripe-test-mode-readonly";
  readonly safety: {
    readonly mode: "sandbox";
    readonly access: "read-only";
    readonly vendor: "stripe";
    readonly allowedOrigins: readonly [typeof STRIPE_TEST_API_ORIGIN];
    readonly allowedMethods: readonly ["GET"];
    readonly allowedResources: readonly [typeof STRIPE_PAYMENT_INTENT_RETRIEVE, typeof STRIPE_PAYMENT_INTENT_LIST];
    readonly timeoutMs: number;
    readonly maxRequestsPerMinute: number;
  };
  retrievePaymentIntent(id: string): Promise<StripePaymentIntentSnapshot>;
  listPaymentIntents(limit?: number): Promise<StripePaymentIntentSnapshot[]>;
  getRequestAudit(): VendorSandboxRequestAudit[];
}

export interface StripeTestModeReadOnlyOptions {
  restrictedApiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRequestsPerMinute?: number;
  now?: () => number;
}

export interface StripeSandboxReadOnlyCheck {
  id: string;
  status: "passed" | "failed";
  message: string;
}

export interface StripeSandboxReadOnlyReport {
  schemaVersion: "agentcert.sandbox_vendor_egress.v0.4";
  kind: "agentcert.sandbox_vendor_egress";
  implementation: "stripe-payment-intent-readonly";
  vendor: "stripe";
  environment: "sandbox";
  generatedAt: string;
  verdict: { passed: boolean; score: number };
  summary: { passed: number; failed: number; total: number };
  checks: StripeSandboxReadOnlyCheck[];
  policy: {
    allowedOrigins: readonly [typeof STRIPE_TEST_API_ORIGIN];
    allowedMethods: readonly ["GET"];
    allowedResources: readonly [typeof STRIPE_PAYMENT_INTENT_RETRIEVE, typeof STRIPE_PAYMENT_INTENT_LIST];
    timeoutMs: number;
    maxRequestsPerMinute: number;
  };
  audit: VendorSandboxRequestAudit[];
  observation?: StripePaymentIntentSnapshot;
  disclaimer: string;
}

export interface RunStripeSandboxReadOnlyOptions extends StripeTestModeReadOnlyOptions {
  paymentIntentId: string;
}

export function createStripeTestModeReadOnlyAdapter(
  options: StripeTestModeReadOnlyOptions,
): StripeTestModeReadOnlyAdapter {
  const apiKey = options.restrictedApiKey.trim();
  if (!/^rk_test_[A-Za-z0-9_]{8,}$/.test(apiKey)) {
    throw new Error("Stripe read-only reference adapter requires an rk_test_ restricted test-mode key.");
  }
  const timeoutMs = options.timeoutMs ?? STRIPE_SANDBOX_TIMEOUT_MS;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? STRIPE_SANDBOX_MAX_REQUESTS_PER_MINUTE;
  const egress = createBoundedVendorSandboxEgress({
    policy: {
      vendor: "stripe",
      allowedOrigin: STRIPE_TEST_API_ORIGIN,
      resources: STRIPE_RESOURCES,
      timeoutMs,
      maxRequestsPerMinute,
    },
    fetch: options.fetch,
    now: options.now,
  });
  const get = (resource: string, path: string): Promise<unknown> => egress.requestJson({
    resource,
    method: "GET",
    path,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "user-agent": "agentcert-onegent-runtime/stripe-sandbox-readonly-v0.4",
    },
  });

  return Object.freeze({
    name: "stripe-test-mode-readonly" as const,
    safety: Object.freeze({
      mode: "sandbox" as const,
      access: "read-only" as const,
      vendor: "stripe" as const,
      allowedOrigins: Object.freeze([STRIPE_TEST_API_ORIGIN]) as readonly [typeof STRIPE_TEST_API_ORIGIN],
      allowedMethods: Object.freeze(["GET"] as const),
      allowedResources: Object.freeze([STRIPE_PAYMENT_INTENT_RETRIEVE, STRIPE_PAYMENT_INTENT_LIST] as const),
      timeoutMs,
      maxRequestsPerMinute,
    }),
    retrievePaymentIntent: async (id: string) => {
      if (!/^pi_[A-Za-z0-9]{8,128}$/.test(id)) throw new Error("Stripe PaymentIntent ID is invalid.");
      return paymentIntentSnapshot(await get(STRIPE_PAYMENT_INTENT_RETRIEVE, `/v1/payment_intents/${encodeURIComponent(id)}`));
    },
    listPaymentIntents: async (limit = 10) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("Stripe read-only list limit must be an integer from 1 to 10.");
      const payload = await get(STRIPE_PAYMENT_INTENT_LIST, `/v1/payment_intents?limit=${limit}`);
      if (!isRecord(payload) || payload.object !== "list" || !Array.isArray(payload.data)) {
        throw new Error("Stripe returned an invalid PaymentIntent list response.");
      }
      return payload.data.map(paymentIntentSnapshot);
    },
    getRequestAudit: () => egress.getAuditLog(),
  });
}

export async function runStripeSandboxReadOnlyCertification(
  options: RunStripeSandboxReadOnlyOptions,
): Promise<StripeSandboxReadOnlyReport> {
  const generatedAt = new Date((options.now ?? Date.now)()).toISOString();
  const timeoutMs = options.timeoutMs ?? STRIPE_SANDBOX_TIMEOUT_MS;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? STRIPE_SANDBOX_MAX_REQUESTS_PER_MINUTE;
  const checks: StripeSandboxReadOnlyCheck[] = [];
  let adapter: StripeTestModeReadOnlyAdapter | undefined;
  let observation: StripePaymentIntentSnapshot | undefined;

  try {
    adapter = createStripeTestModeReadOnlyAdapter(options);
    checks.push(
      passed("restricted-test-key", "Credential format is restricted to Stripe rk_test_ keys and is not retained."),
      passed("fixed-egress-policy", "Egress is fixed to Stripe HTTPS, GET, and allowlisted PaymentIntent resources."),
    );
    observation = await adapter.retrievePaymentIntent(options.paymentIntentId);
    checks.push(
      passed("bounded-read", "The allowlisted PaymentIntent read completed within the configured bounds."),
      passed("test-mode-response", "Stripe explicitly returned livemode=false."),
      passed("evidence-redaction", "The evidence snapshot excludes credentials, client_secret, metadata, and raw response bytes."),
    );
  } catch (error) {
    if (!adapter) {
      checks.push(
        failed("restricted-test-key", "A valid Stripe rk_test_ restricted test-mode key was not available."),
        failed("fixed-egress-policy", "The request was not attempted because credential validation failed."),
      );
    } else {
      checks.push(failed("bounded-read", safeStripeFailure(error)));
    }
    checks.push(
      failed("test-mode-response", "No validated Stripe test-mode observation was produced."),
      failed("evidence-redaction", "No successful redacted observation was produced."),
    );
  }

  const passedCount = checks.filter((check) => check.status === "passed").length;
  const report: StripeSandboxReadOnlyReport = {
    schemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
    kind: "agentcert.sandbox_vendor_egress",
    implementation: "stripe-payment-intent-readonly",
    vendor: "stripe",
    environment: "sandbox",
    generatedAt,
    verdict: { passed: passedCount === checks.length, score: Math.round((passedCount / checks.length) * 100) },
    summary: { passed: passedCount, failed: checks.length - passedCount, total: checks.length },
    checks,
    policy: {
      allowedOrigins: [STRIPE_TEST_API_ORIGIN],
      allowedMethods: ["GET"],
      allowedResources: [STRIPE_PAYMENT_INTENT_RETRIEVE, STRIPE_PAYMENT_INTENT_LIST],
      timeoutMs,
      maxRequestsPerMinute,
    },
    audit: adapter?.getRequestAudit() ?? [],
    ...(observation ? { observation } : {}),
    disclaimer: "Stripe sandbox read-only evidence proves this bounded test-mode observation only. It does not authorize writes, attest Stripe controls, or certify production behavior.",
  };
  return structuredClone(report);
}

function paymentIntentSnapshot(value: unknown): StripePaymentIntentSnapshot {
  if (!isRecord(value) || value.object !== "payment_intent" || typeof value.id !== "string") {
    throw new Error("Stripe returned an invalid PaymentIntent response.");
  }
  if (value.livemode !== false) throw new Error("Stripe read-only adapter refuses responses that are not explicitly test mode.");
  return {
    id: value.id,
    object: "payment_intent",
    livemode: false,
    ...numberField(value, "amount", "amount"),
    ...numberField(value, "amount_capturable", "amountCapturable"),
    ...numberField(value, "amount_received", "amountReceived"),
    ...stringField(value, "currency", "currency"),
    ...stringField(value, "status", "status"),
    ...numberField(value, "created", "created"),
  };
}

function safeStripeFailure(error: unknown): string {
  if (error instanceof VendorSandboxEgressError) return `Stripe sandbox read failed (${error.code}).`;
  if (error instanceof Error && error.message.includes("not explicitly test mode")) return "Stripe response was not explicitly test mode.";
  if (error instanceof Error && error.message.includes("invalid PaymentIntent")) return "Stripe returned an invalid PaymentIntent response.";
  return "Stripe sandbox read failed before a validated observation was produced.";
}

function passed(id: string, message: string): StripeSandboxReadOnlyCheck {
  return { id, status: "passed", message };
}

function failed(id: string, message: string): StripeSandboxReadOnlyCheck {
  return { id, status: "failed", message };
}

function numberField(
  value: Record<string, unknown>,
  source: string,
  target: keyof StripePaymentIntentSnapshot,
): Partial<StripePaymentIntentSnapshot> {
  return typeof value[source] === "number" && Number.isFinite(value[source]) ? { [target]: value[source] } : {};
}

function stringField(
  value: Record<string, unknown>,
  source: string,
  target: keyof StripePaymentIntentSnapshot,
): Partial<StripePaymentIntentSnapshot> {
  return typeof value[source] === "string" ? { [target]: value[source] } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
