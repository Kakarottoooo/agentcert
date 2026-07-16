# Bounded Vendor Sandbox Egress v0.4

AgentCert can make one narrowly defined read against an official vendor sandbox
and retain a redacted assurance report. This is not a general HTTP client and
does not permit production access.

## Stripe read-only flow

Prerequisites:

1. Use a Stripe **Sandbox** or test-mode account.
2. Create a restricted test key whose value starts with `rk_test_`.
3. Grant **Read** access to PaymentIntents and leave unrelated resources at
   **None**.
4. Choose an existing sandbox PaymentIntent ID beginning with `pi_`.

Stripe documents restricted key creation and permission choices in its
[restricted API key guide](https://docs.stripe.com/keys/restricted-api-keys).
The command uses Stripe's
[retrieve PaymentIntent](https://docs.stripe.com/api/payment_intents/retrieve)
API only for the selected observation.

PowerShell:

```powershell
$env:STRIPE_RESTRICTED_TEST_KEY = "rk_test_..."
npx agentcert sandbox stripe-readonly --payment-intent pi_...
Remove-Item Env:STRIPE_RESTRICTED_TEST_KEY
```

Bash:

```bash
STRIPE_RESTRICTED_TEST_KEY="rk_test_..." \
  npx agentcert sandbox stripe-readonly --payment-intent pi_...
```

The report is written to
`.agentcert/sandbox/stripe-readonly-report.json`. After `agentcert connect`,
add `--push` to retain it in the Hosted **Sandbox certifications** workspace.

```bash
npx agentcert sandbox stripe-readonly --payment-intent pi_... --push
```

The Stripe key is accepted only through `STRIPE_RESTRICTED_TEST_KEY`. There is
no Stripe credential CLI flag. Do not commit the key, put it in a config file,
or paste it into evidence.

## Fixed boundary

The public CLI fixes the effective policy to:

| Control | Value |
| --- | --- |
| Origin | `https://api.stripe.com` |
| Method | `GET` |
| Resources | PaymentIntent retrieve and bounded list |
| Request timeout | 5 seconds |
| Process-local rate cap | 10 requests per minute |
| Redirects | Rejected |
| Response requirement | `livemode` must be exactly `false` |

Origin, method, resource ID, and route pattern are checked before `fetch` is
called. Timeout uses an abort signal plus a deterministic race, so an
unresponsive provider cannot hold the CLI open indefinitely. The rate cap is
process-local and intentionally conservative; it is not a distributed vendor
quota manager.

## Evidence boundary

The v0.4 report records:

- the effective allowlist and bounds;
- request ID, resource, method, origin, outcome, status, and duration;
- a narrow PaymentIntent observation (`id`, `livemode`, amounts, currency,
  status, and creation time when present);
- deterministic pass/fail controls and a disclaimer.

It never records the Authorization header, API key, raw response body,
`client_secret`, metadata, customer data, or vendor error body. The report
contract is published as
`packages/onegent-runtime/stripe-sandbox-readonly.schema.json`.

## What this proves

- AgentCert enforced the declared read-only network boundary for this run.
- The observed Stripe object explicitly reported test mode.
- The retained observation and request audit conform to the redacted v0.4
  report shape.

## What this does not prove

- that the Stripe key has no permissions beyond PaymentIntent reads;
- that Stripe's own controls are certified by AgentCert;
- that production behavior matches sandbox behavior;
- that any create, confirm, capture, cancel, refund, payout, or other write is
  safe or authorized.

Key permission review remains a human setup step. AgentCert deliberately does
not probe unrelated endpoints to infer permissions because that would broaden
the boundary it is meant to constrain.

For the protected GitHub environment, independent pre-upload scan, production
retention, and historical regression gate, continue with
[Real Vendor Acceptance v0.5](real-vendor-acceptance.md).
