import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const outputRoot = resolve(process.argv[2] ?? ".agentcert/reference-repos");
const templates = ["browser", "coding", "mcp", "workflow", "data"];
await rm(outputRoot, { recursive: true, force: true });

for (const template of templates) {
  const root = join(outputRoot, `agentcert-reference-${template}`);
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(join(root, "README.md"), readme(template));
  await writeFile(join(root, ".gitignore"), ".agentcert/\nagentcert.config.json\ntripwire.yml\nagentcert.adapter.mjs\n");
  await writeFile(join(root, "smoke.mjs"), smoke(template));
  await writeFile(join(root, ".github", "workflows", "daily-smoke.yml"), workflow(template));
}
process.stdout.write(`Generated ${templates.length} reference repositories in ${outputRoot}\n`);

function readme(template) {
  return `# AgentCert ${title(template)} Reference\n\nIndependent daily acceptance for the public \`agentcert\` npm package and the ${template} onboarding contract.\n\nThe workflow installs \`agentcert@latest\`, generates a fresh ${template} adapter, validates it, then sends one idempotent reference event to the Hosted Control Plane. No customer data is used.\n\nRequired repository secrets: \`AGENTCERT_PROJECT_ID\` and \`AGENTCERT_API_KEY\`.\n`;
}

function workflow(template) {
  return `name: AgentCert ${title(template)} daily smoke
on:
  workflow_dispatch:
  schedule:
    - cron: "${13 + templates.indexOf(template) * 7} 10 * * *"
permissions:
  contents: read
concurrency:
  group: agentcert-${template}-daily-smoke
  cancel-in-progress: false
jobs:
  smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      AGENTCERT_BASE_URL: https://agentcert-control-plane.onrender.com
      AGENTCERT_PROJECT_ID: \${{ secrets.AGENTCERT_PROJECT_ID }}
      AGENTCERT_API_KEY: \${{ secrets.AGENTCERT_API_KEY }}
      AGENTCERT_TEMPLATE: ${template}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with: { node-version: "22", package-manager-cache: false }
      - name: Verify public package and generated adapter
        run: |
          npx --yes agentcert@latest --help
          npx --yes agentcert@latest init --template ${template} --subject agentcert-reference-${template} --force
          node smoke.mjs
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: agentcert-${template}-smoke-\${{ github.run_id }}
          path: .agentcert/reference-smoke.json
          if-no-files-found: error
          retention-days: 30
`;
}

function smoke(template) {
  return `import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

for (const name of ["AGENTCERT_BASE_URL", "AGENTCERT_PROJECT_ID", "AGENTCERT_API_KEY"]) if (!process.env[name]) throw new Error(\`\${name} is required.\`);
const profile = JSON.parse(await readFile("agentcert.config.json", "utf8"));
if (profile.subject.name !== "agentcert-reference-${template}") throw new Error("Generated template subject does not match.");
${["coding", "workflow", "data"].includes(template) ? `await import("./agentcert.adapter.mjs");` : ""}
const envelopeId = randomUUID();
const envelope = { schemaVersion: "agentcert.envelope.v0.1", envelopeId, kind: "event", occurredAt: new Date().toISOString(),
  source: { agentId: "agentcert-reference-${template}", agentVersion: process.env.npm_package_version ?? "latest", framework: "${template}", adapter: "reference-smoke-v0.1" },
  run: { externalId: \`daily-${template}-\${new Date().toISOString().slice(0, 10)}\`, kind: "custom" },
  trace: { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") },
  event: { type: "reference.${template}.smoke", actor: "system", sequence: 0, attributes: { synthetic: true } } };
const response = await fetch(\`\${process.env.AGENTCERT_BASE_URL}/v1/projects/\${encodeURIComponent(process.env.AGENTCERT_PROJECT_ID)}/envelopes\`, {
  method: "POST", headers: { authorization: \`Bearer \${process.env.AGENTCERT_API_KEY}\`, "content-type": "application/json", "idempotency-key": envelopeId }, body: JSON.stringify(envelope) });
const body = await response.json().catch(() => ({}));
const result = { schemaVersion: "agentcert.reference_smoke.v0.1", template: "${template}", package: "agentcert@latest", status: response.ok ? "passed" : "failed", httpStatus: response.status, occurredAt: new Date().toISOString(), runId: body.run?.id };
await mkdir(".agentcert", { recursive: true }); await writeFile(".agentcert/reference-smoke.json", JSON.stringify(result, null, 2) + "\\n");
if (!response.ok) throw new Error(\`Hosted smoke failed (\${response.status}): \${body.error ?? "unknown error"}\`);
`;
}

function title(value) { return value[0].toUpperCase() + value.slice(1); }
