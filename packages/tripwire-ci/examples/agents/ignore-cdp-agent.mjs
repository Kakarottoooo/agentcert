import { appendFile } from "node:fs/promises";

if (process.env.TRIPWIRE_EVENTS_FILE) {
  await appendFile(
    process.env.TRIPWIRE_EVENTS_FILE,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "noop",
      note: "This demo agent intentionally ignores TRIPWIRE_CDP_URL."
    })}\n`
  );
}

process.exit(0);
