export const STRIPE_TEST_API_ORIGIN = "https://api.stripe.com" as const;

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
  };
  retrievePaymentIntent(id: string): Promise<StripePaymentIntentSnapshot>;
  listPaymentIntents(limit?: number): Promise<StripePaymentIntentSnapshot[]>;
}

export interface StripeTestModeReadOnlyOptions {
  restrictedApiKey: string;
  fetch?: typeof fetch;
}

export function createStripeTestModeReadOnlyAdapter(
  options: StripeTestModeReadOnlyOptions,
): StripeTestModeReadOnlyAdapter {
  const apiKey = options.restrictedApiKey.trim();
  if (!/^rk_test_[A-Za-z0-9_]{8,}$/.test(apiKey)) {
    throw new Error("Stripe read-only reference adapter requires an rk_test_ restricted test-mode key.");
  }
  const requestFetch = options.fetch ?? fetch;
  const get = async (path: string): Promise<unknown> => {
    const url = new URL(path, STRIPE_TEST_API_ORIGIN);
    if (url.origin !== STRIPE_TEST_API_ORIGIN) throw new Error("Stripe adapter request escaped the fixed test API origin.");
    const response = await requestFetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "user-agent": "agentcert-onegent-runtime/stripe-test-readonly-v0.2",
      },
      redirect: "error",
    });
    const payload = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const message = stripeErrorMessage(payload);
      throw new Error(`Stripe test-mode read failed (${response.status})${message ? `: ${message}` : "."}`);
    }
    return payload;
  };

  return Object.freeze({
    name: "stripe-test-mode-readonly" as const,
    safety: Object.freeze({
      mode: "sandbox" as const,
      access: "read-only" as const,
      vendor: "stripe" as const,
      allowedOrigins: Object.freeze([STRIPE_TEST_API_ORIGIN]) as readonly [typeof STRIPE_TEST_API_ORIGIN],
    }),
    retrievePaymentIntent: async (id: string) => {
      if (!/^pi_[A-Za-z0-9]{8,128}$/.test(id)) throw new Error("Stripe PaymentIntent ID is invalid.");
      return paymentIntentSnapshot(await get(`/v1/payment_intents/${encodeURIComponent(id)}`));
    },
    listPaymentIntents: async (limit = 10) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("Stripe read-only list limit must be an integer from 1 to 10.");
      const payload = await get(`/v1/payment_intents?limit=${limit}`);
      if (!isRecord(payload) || payload.object !== "list" || !Array.isArray(payload.data)) {
        throw new Error("Stripe returned an invalid PaymentIntent list response.");
      }
      return payload.data.map(paymentIntentSnapshot);
    },
  });
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

function stripeErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return undefined;
  return value.error.message.slice(0, 300);
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
