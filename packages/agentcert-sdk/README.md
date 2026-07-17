# AgentCert TypeScript SDK

```ts
import { AgentCertClient } from "agentcert-sdk";

const agentcert = new AgentCertClient({
  baseUrl: process.env.AGENTCERT_BASE_URL!,
  projectId: process.env.AGENTCERT_PROJECT_ID!,
  apiKey: process.env.AGENTCERT_API_KEY!,
});

const action = await agentcert.assessAction({
  externalId: "purchase-order-4850",
  principal: { id: "procurement-agent", type: "agent" },
  actionType: "SUBMIT",
  targetSystem: "MockERP",
  requestedPermissions: ["MockERP:SUBMIT"],
  amount: 4850,
  currency: "USD",
  expectedState: { status: "SUBMITTED" },
});

if (action.decision === "REQUIRE_APPROVAL") {
  // Poll getAction(action.id), or wait for your approval webhook integration.
}
```

The SDK submits intent and evidence. It never executes payments, sends email,
mutates external systems, approves actions, or changes agent permissions.
Owners and admins register agent identities and grant permissions in the human
console before giving a project API key to an agent or CI job.

The SDK also exports `createEventEnvelope()` and `sendEnvelope()` for
framework-neutral event ingestion. `verifyServerAttestation()` verifies the
canonical Ed25519 metadata chain returned on hosted evidence records against
the public key from `GET /v1/signing-keys/current`.

## Customer-owned collector gateway

`agentcert-sdk` v0.2 adds a customer-owned process that holds the source
signing key, Hosted API key, and durable offline queue outside the agent
process. It provides idempotent local append, signed heartbeat, restart replay,
receipt reconciliation, key rotation, and a black-box conformance command.

```bash
agentcert-collector-gateway
agentcert-collector-conformance
```

Required gateway environment variables are `AGENTCERT_PROJECT_ID`,
`AGENTCERT_API_KEY`, and `AGENTCERT_GATEWAY_TOKEN`. See
[`docs/customer-owned-collector-gateway.md`](../../docs/customer-owned-collector-gateway.md)
for Docker deployment, protocol details, and non-claims.
