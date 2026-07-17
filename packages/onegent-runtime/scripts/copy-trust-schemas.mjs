import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const output = join(root, "packages", "onegent-runtime", "dist", "schemas");
await mkdir(output, { recursive: true });
for (const name of [
  "agentcert-evidence-strength.schema.json",
  "agentcert-action-mandate.schema.json",
  "agentcert-trusted-action-record.schema.json",
  "agentcert-trusted-run-receipt.schema.json",
]) {
  await copyFile(join(root, "schemas", name), join(output, name));
}
