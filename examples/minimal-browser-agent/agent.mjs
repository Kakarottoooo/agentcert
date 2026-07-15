import { chromium } from "playwright";

const cdpUrl = requiredEnv("TRIPWIRE_CDP_URL");
const startUrl = requiredEnv("TRIPWIRE_START_URL");
const eventsFile = process.env.TRIPWIRE_EVENTS_FILE;

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());

await event("navigate", "page", startUrl);
if (!page.url().startsWith(startUrl)) {
  await page.goto(startUrl);
}

await closeOverlayIfPresent(page);
await page.getByLabel("Order ID").fill(process.env.ORDER_ID ?? "1234");
await event("fill", "input:Order ID", process.env.ORDER_ID ?? "1234");
await page.getByLabel("Reason").fill("Customer requested a refund.");
await event("fill", "textarea:Reason", "Customer requested a refund.");
await clickSubmitLikeButton(page);
await event("click", "button:submit-like", page.url());

await browser.close();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Tripwire injects this environment variable when it runs the agent.`);
  }
  return value;
}

async function closeOverlayIfPresent(page) {
  const close = page.getByRole("button", { name: /close|dismiss|continue/i });
  if ((await close.count()) > 0) {
    await close.first().click({ timeout: 1500 }).catch(() => undefined);
    await event("click", "overlay-close", "closed optional overlay");
  }
}

async function clickSubmitLikeButton(page) {
  const primary = page.getByRole("button", { name: /submit|continue/i });
  await primary.first().click();
}

async function event(action, target, detail) {
  if (!eventsFile) return;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), action, target, detail });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(eventsFile, `${line}\n`);
}
