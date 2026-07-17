# External Pilot Protocol

This protocol is for an agent team evaluating AgentCert from its own repository.
It is designed to expose onboarding friction, not to manufacture a passing
result. Use staging or deterministic fixtures only. Do not provide AgentCert
with production credentials or access to real payments, email, or customer
data.

## Ten-Minute Target

The first useful checkpoint is one locally validated evidence bundle visible in
the hosted control plane.

1. Sign in at the [AgentCert workspace](https://agentcert.app/app).
2. Create or select a project. The Overview page shows live progress for key
   creation, first authenticated CLI use, and first evidence.
3. Open **Integrations**, create a project API key, and keep it out of source
   control and issue reports.
4. Connect the CLI using the command shown for the project. The API key prompt
   is hidden and the credentials are saved in the current user's AgentCert
   profile.

   ```bash
   npx agentcert connect --server https://agentcert.app --project <project-id>
   ```

5. Produce an AgentCert evidence bundle from an existing Tripwire, MCPBench, or
   Onegent artifact, then upload it.

   ```bash
   npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --push
   # or
   npx agentcert push --evidence .agentcert/latest/agentcert-evidence.json
   ```

6. Confirm that **Runs** and **Evidence** show the same run, verdict, schema
   version, and SHA-256 provenance as the local output.

CI runners should use `AGENTCERT_BASE_URL`, `AGENTCERT_PROJECT_ID`, and the
secret `AGENTCERT_API_KEY` instead of persisting a user profile.

## Pilot Paths

Generate the boundary-specific starter from an empty repository:

```bash
npx agentcert init --template <browser|coding|mcp|workflow|data> --subject <agent-name>
```

- Browser or computer-use agent: start with
  [`examples/minimal-browser-agent`](../examples/minimal-browser-agent/) and
  replace the fixture command with the real agent command.
- Real browser agents: compare the
  [`browser-use`](../examples/real-agents/browser-use/) and
  [`Stagehand`](../examples/real-agents/stagehand/) adapters.
- MCP server or tool: run MCPBench and pass its `results.json` through
  `agentcert run --mcpbench <path>`.
- Runtime action: use the Onegent local adapter and mock systems. Do not connect
  a live payment, email, or vendor system during the pilot.

## Acceptance Evidence

Record facts rather than impressions:

- minutes from empty checkout to first local report;
- minutes from API key creation to first hosted evidence;
- commands that required undocumented repository knowledge;
- first failing step and its exact error category;
- whether the report identifies the first behavioral divergence;
- whether a reviewer can connect the verdict to screenshots, traces, and
  source artifacts;
- whether a retry creates duplicate evidence;
- whether revoking the project key blocks the next request.

Success means the integration is reproducible and the evidence is explainable.
It does not require the agent to pass every test.

## Report Friction

Use **Report onboarding friction** on the Hosted Overview page so the stage,
category, outcome, and bounded diagnostic context stay attached to the project.
Public pilots may also use the repository's **External pilot report** issue form. Never paste API keys,
database URLs, access tokens, customer data, or unredacted production traces.
Include links to public or sanitized CI artifacts when possible.

