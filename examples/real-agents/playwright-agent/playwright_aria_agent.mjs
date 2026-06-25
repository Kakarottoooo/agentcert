import { appendFile } from "node:fs/promises";
import { createRequire } from "node:module";

const requireFromTripwire = createRequire(new URL("../../../packages/tripwire-ci/package.json", import.meta.url));
const { chromium } = requireFromTripwire("playwright");

const cdpUrl = required("TRIPWIRE_CDP_URL");
const startUrl = required("TRIPWIRE_START_URL");
const eventsFile = process.env.TRIPWIRE_EVENTS_FILE;
const orderId = process.env.ORDER_ID ?? "1234";

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0] ?? await browser.newContext();
const page = context.pages()[0] ?? await context.newPage();

await event("agent_start", "playwright-aria-agent", startUrl);
if (!page.url().startsWith(startUrl)) await page.goto(startUrl);

await fillByLabel("Order ID", orderId);
await fillByLabel("Reason", "Customer requested a refund.");
await dismissBlockingOverlay();
await clickSubmitLikeButton();
await page.waitForURL("**/success", { timeout: 5000 });
await event("complete", "url", page.url());
process.exit(0);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function fillByLabel(label, value) {
  await page.getByLabel(label).fill(value);
  await event("fill", `label:${label}`, value);
}

async function dismissBlockingOverlay() {
  const dismissButtons = ["Dismiss", "Close", "Continue anyway", "Not now"];
  for (const name of dismissButtons) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) > 0) {
      await button.click({ timeout: 1000 }).catch(() => undefined);
      await event("click", `button:${name}`, "Dismissed possible blocking overlay.");
      return;
    }
  }
}

async function clickSubmitLikeButton() {
  const candidates = ["Submit", "Continue", "Send"];
  for (const name of candidates) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) === 0) continue;
    if (!(await button.isEnabled().catch(() => false))) continue;
    await button.click({ timeout: 2500 });
    await event("click", `button:${name}`, "Clicked submit-like button by accessible name.");
    return;
  }
  throw new Error("No enabled submit-like button was found.");
}

async function event(type, target, note) {
  if (!eventsFile) return;
  await appendFile(eventsFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type, target, note })}\n`);
}
