import { chromium } from "playwright";
import { appendFile } from "node:fs/promises";

const cdpUrl = required("TRIPWIRE_CDP_URL");
const startUrl = required("TRIPWIRE_START_URL");
const eventsFile = process.env.TRIPWIRE_EVENTS_FILE;
const orderId = process.env.ORDER_ID ?? "1234";

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0] ?? await browser.newContext();
const page = context.pages()[0] ?? await context.newPage();

await event("navigate", "page", startUrl);
if (!page.url().startsWith(startUrl)) await page.goto(startUrl);
await page.getByLabel("Order ID").fill(orderId);
await event("fill", "input:Order ID", orderId);
await page.getByLabel("Reason").fill("Customer requested a refund.");
await event("fill", "textarea:Reason", "Customer requested a refund.");
await page.getByRole("button", { name: "Submit", exact: true }).click({ timeout: 2500 });
await event("click", "button:Submit", "Clicked exact Submit button.");
await page.waitForURL("**/success", { timeout: 2500 });
await event("complete", "url", page.url());
process.exit(0);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function event(type, target, note) {
  if (!eventsFile) return;
  await appendFile(eventsFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type, target, note })}\n`);
}
