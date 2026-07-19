export function renderCommandHelp(command: string): string | undefined {
  if (command === "sandbox") return undefined;
  if (command === "init") return `Usage:
  agentcert init --template <browser|coding|mcp|workflow|data> [--subject <name>]
  agentcert init --template browser --github-action

Options:
  --template <type>       External agent boundary (default: browser)
  --subject <name>        Agent identity (default: my-<template>-agent)
  --out <path>            Profile output (default: agentcert.config.json)
  --adapter-out <path>    Envelope adapter for coding/workflow/data
  --github-action         Write the browser Tripwire workflow
  --force                 Replace existing starter files
  --help, -h              Show this help without writing files
`;
  if (command === "conformance") return `Usage:
  agentcert conformance <evidence.json> --artifact-root <directory> [--implementation <name>] [--out <report.json>]

Checks schema identity, v0.1 compatibility, artifact manifest structure, and exact artifact hashes and sizes.
`;
  if (command !== "push") return undefined;
  return `Usage:
  agentcert push --evidence .agentcert/latest/agentcert-evidence.json
  agentcert push --evidence <path> --server <url> --project <project-id> [--api-key <key>]

Options:
  --evidence <path>       Evidence bundle (default: .agentcert/latest/agentcert-evidence.json)
  --connection <name>    Saved hosted connection
  --server <url>         Hosted AgentCert base URL
  --project <id>         Hosted project ID
  --api-key <key>        Project API key (prefer AGENTCERT_API_KEY in CI)
  --external-id <id>     Idempotent hosted run ID
  --assurance-case <id>  Issued assurance case to reconcile
  --assurance-scope <p>  Declared agent/model/prompt/tools/policy/suite scope JSON
  --assurance-trigger <t> auto, pull_request, release, or nightly (default: auto)
  --require-current       Fail unless Hosted confirms authoritative CURRENT and complete evidence
  --continuous-health-out <path>  Write the redacted Hosted health contract
  --artifact-root <dir>  Allowed root for companion artifacts (default: current directory)
  --no-artifacts         Upload only the evidence bundle
  --help, -h             Show this help
`;
}
