# AgentCert Release Gate Checklist v0.1

This checklist is implemented by AgentCert's release-gate command. It is not a
single model benchmark. It combines automated AgentCert evidence with explicit
attestations for controls that cannot be proven from one test run.

## How To Use

Run the automated evidence path first:

```bash
npx agentcert init --subject my-agent
npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --subject my-agent --fail-on-verdict
npx agentcert validate .agentcert/latest/agentcert-evidence.json --check-artifacts
npx agentcert release-gate --config agentcert.config.json
```

For MCP/tool surfaces:

```bash
mcpbench eval --server-command "<your server command>" --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/latest
npx agentcert run --mcpbench .mcpbench/latest/results.json --out .agentcert/latest --subject my-mcp-server
```

For high-risk runtime actions, wrap the action with Onegent Runtime and include
its audit packet in the same AgentCert run.

## Gate Status

Each gate has one of three statuses:

- `automated`: AgentCert can produce direct evidence now.
- `evidence-required`: AgentCert can record the evidence, but the caller must
  wire the relevant artifact or adapter.
- `manual`: a human owner must review and approve the control.

## The 10 Gates

| Gate | Status | What Must Be True | Current AgentCert Evidence |
|---|---|---|---|
| 1. Permission boundary | evidence-required | The agent has the minimum tools, scopes, files, URLs, and actions needed. | MCPBench tool/spec checks, policy docs, configured adapter command. |
| 2. Data boundary | evidence-required | Secrets, PII, customer data, and synthetic canaries are not leaked to logs, pages, tools, or external sinks. | MCPBench canary tests, Tripwire `no_sensitive_text_in_output`, evidence findings. |
| 3. Tool contract | automated for MCP/tools | Tool schemas are clear, parameters are validated, failures are observable, and outputs are explainable. | MCPBench `results.json`, report, events, badge. |
| 4. State verification | automated for Tripwire/Onegent slices | Success is based on observed state, not the agent saying it succeeded. | Tripwire URL/text/assertion checks, Onegent expected-vs-observed verification. |
| 5. Human handoff | evidence-required | High-risk, low-confidence, or failed actions have an owner, approval path, and escalation path. | Onegent approval records and audit packet; manual owner mapping. |
| 6. Rate, loop, and cost limits | evidence-required | The agent cannot loop forever, retry unboundedly, or exhaust API/system quotas. | Tripwire `max_steps`, timeout evidence, future cost/usage adapters. |
| 7. Idempotency and retry safety | manual today | Repeated clicks, retries, duplicate submits, and partial failures do not double-execute real actions. | Onegent runtime policy/audit can record this once caller provides an adapter. |
| 8. Observability and auditability | automated | A reviewer can inspect run id, subject, timestamps, trace, screenshots, DOM, reports, and audit packets. | `agentcert-evidence.json`, HTML report, badge, manifest, corpus, monitor snapshot. |
| 9. Rollback and kill switch | manual today | There is a documented way to pause, disable, or roll back the agent and its connected tools. | Manual release note or runbook artifact; future policy pack. |
| 10. Supply-chain and dependency boundary | manual today | MCP servers, browser agents, packages, model providers, and adapters are pinned and reviewed. | External dependency metadata; future SBOM/package scanner integration. |

## Recommended Release Decision

For an open-source pre-release gate, require:

- Gates 3, 4, and 8 must be automated and passing.
- Gates 1, 2, 5, and 6 must have evidence or documented exceptions.
- Gates 7, 9, and 10 must have a named human owner and release note.

For production high-risk actions, require:

- Onegent Runtime approval, execution, verification, and audit packet.
- An idempotency story for every real write action.
- A kill-switch owner.
- No real credentials in test artifacts.

## One-Command Release Decision

```bash
npx agentcert release-gate --config agentcert.config.json --strict
```

The command now:

- runs configured MCPBench, Tripwire, and Onegent checks;
- records SHA-256 provenance for local input artifacts and the evidence bundle;
- compute the 10 gate statuses;
- compares the result with an optional baseline;
- outputs JSON, JUnit, HTML, Markdown, and a release badge alongside the
  evidence bundle, corpus, and monitor snapshot;
- fails CI when automated evidence fails;
- in `--strict` mode, also fails CI when required evidence or manual review is
  incomplete;
- can sign evidence and release reports with a local Ed25519 private key.

The important rule: AgentCert should never silently convert an untested manual
gate into a pass.

## Control Attestations

Evidence-required and manual controls are resolved in `agentcert.config.json`.
Every attestation requires a named owner, review timestamp, and at least one
evidence pointer:

```json
{
  "run": {
    "gate": {
      "strict": true,
      "outDir": ".agentcert/latest",
      "baseline": ".agentcert/baselines/main.json",
      "requireBaseline": true,
      "maxScoreDrop": 0,
      "controls": {
        "rollback-kill-switch": {
          "status": "pass",
          "owner": "oncall@example.com",
          "reviewedAt": "2026-07-14T00:00:00Z",
          "evidence": ["docs/runbooks/agent-kill-switch.md"],
          "note": "On-call tested the disable path in staging."
        }
      }
    }
  }
}
```

An attestation cannot override failed automated evidence. Incomplete
attestations remain `needs-evidence` or `manual-review`.

## Fixed Outputs

`agentcert release-gate` writes:

- `agentcert-release-gate.json`;
- `agentcert-release-gate.md`;
- `agentcert-release-gate.html`;
- `agentcert-release-gate-junit.xml`;
- `release-gate-badge.svg`.

The machine-readable contract is `agentcert.release_gate.v0.1` in
`schemas/agentcert-release-gate.schema.json`.

## Baseline Regression

Pass an earlier evidence bundle with `--baseline`. AgentCert blocks when:

- an overall passing verdict becomes failing;
- a previously passing product becomes failing;
- a baseline product disappears;
- the score drop exceeds `--max-score-drop`;
- the baseline subject does not match the current subject.

Use `--require-baseline` when the absence of a baseline must itself block the
release.

Create or update a baseline only from a passing gate:

```bash
npx agentcert release-gate --evidence .agentcert/latest/agentcert-evidence.json --save-baseline .agentcert/baselines/main.json
```

AgentCert refuses to save the bundle when the release gate is failing.
