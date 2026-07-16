export function renderCommandHelp(command: string): string | undefined {
  if (command === "sandbox") return undefined;
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
  --artifact-root <dir>  Allowed root for companion artifacts (default: current directory)
  --no-artifacts         Upload only the evidence bundle
  --help, -h             Show this help
`;
}
