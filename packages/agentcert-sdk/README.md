# AgentCert TypeScript SDK

```ts
import { AgentCertClient } from "@agentcert/sdk";

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
