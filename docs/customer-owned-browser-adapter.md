# Customer-owned Browser Adapter Kit v0.1

The kit lets a customer keep its browser sandbox, credentials, and execution
code while AgentCert verifies a narrow enforcement boundary. It ships as
`agentcert/browser-adapter-kit`; it is not a separate product or credential
vault.

## Required boundary

- Exact HTTPS sandbox-origin allowlist.
- Bounded action type, operation, resource, and target system.
- Write credential resolved inside the execution closure and unavailable to
  the agent.
- Separate read-only credential for outcome and target-audit verification.
- Idempotency key for every execution.
- Independently observed state and exactly one matching target audit event.
- Idempotent credential-lease revocation.
- Digest-only conformance output with no secrets.

The v0.1 kit rejects production actions. Passing conformance does not prove
that the vendor, browser, customer secret provider, or production system is
secure.

## Two-hour onboarding

### 0-15 minutes: prove the starter

```bash
npx agentcert browser-adapter init
npx agentcert browser-adapter certify --adapter agentcert.browser-adapter.mjs
```

The synthetic fixture should pass at 100%. This proves package resolution,
Node runtime, public subpath, and local reporting before customer code enters.

### 15-45 minutes: bind the sandbox

Replace `targetSystem`, `allowedOrigins`, `allowedOperation`, and
`allowedResource`. Paths, wildcards, HTTP origins, and embedded credentials
are rejected. Leave `sandbox: true` unchanged.

### 45-75 minutes: connect customer credentials

Implement `resolveWriteCredential` and `resolveReadCredential` with separate
secret-provider references. Never place credentials in the fixture, action,
browser prompt, tool arguments, logs, evidence, or AgentCert Hosted.

### 75-105 minutes: connect execution and verification

Implement the write callback, independent read-only outcome callback, and
target audit query. Return one audit event bound to the action, operation,
resource, and parameter digest. Use the provided idempotency key at the vendor
boundary.

### 105-120 minutes: certify and review

```bash
npx agentcert browser-adapter certify \
  --adapter agentcert.browser-adapter.mjs \
  --out .agentcert/browser-adapter/conformance.json
```

Do not proceed if credential separation, target audit reconciliation, outcome
verification, revocation, or secret redaction fails.

## Hosted path

Use `agentcert-sdk` to register the gateway's Ed25519 runtime identity, issue a
short-lived execution grant for an approved and mandated action, and revoke
unused grants. Runtime claims and evidence remain customer-signed and are
verified by AgentCert Hosted.

See [Browser Enforcement Boundary v0.2](browser-enforcement-boundary.md) and
[Evidence Trust Chain](evidence-trust-chain.md) for protocol limitations.
