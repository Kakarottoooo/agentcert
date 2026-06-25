import type { BrowserContext, Page, Route } from "playwright";
import type { FaultConfig } from "../types.js";

export class FaultInjector {
  constructor(private readonly fault: FaultConfig) {}

  async applyBeforeNavigation(context: BrowserContext, page: Page): Promise<void> {
    if (this.fault.type === "slow_network") {
      const match = this.fault.match ?? "**/*";
      await context.route(match, async (route) => {
        await delay(this.fault.type === "slow_network" ? this.fault.delayMs ?? 1000 : 1000);
        await route.continue();
      });
    }
    if (this.fault.type === "http_failure") {
      const match = this.fault.match ?? "**/*";
      await context.route(match, async (route: Route) => {
        await route.fulfill({
          status: this.fault.type === "http_failure" ? this.fault.status ?? 500 : 500,
          contentType: "text/plain",
          body: "Tripwire injected HTTP failure"
        });
      });
    }

    if (this.fault.type === "changed_button_text") {
      await page.addInitScript(({ from, to }) => {
        const apply = () => {
          const candidates = Array.from(document.querySelectorAll("button,a,input[type=button],input[type=submit]"));
          for (const element of candidates) {
            if (element instanceof HTMLInputElement) {
              if (element.value.trim() === from) element.value = to;
            } else if ((element.textContent ?? "").trim() === from) {
              element.textContent = to;
            }
          }
        };
        const observer = new MutationObserver(apply);
        document.addEventListener("DOMContentLoaded", () => {
          apply();
          observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        });
        apply();
      }, {
        from: this.fault.from,
        to: this.fault.to
      });
    }
    if (this.fault.type === "modal_overlay") {
      await page.addInitScript(({ delayMs }) => {
        const inject = () => {
          if (document.getElementById("tripwire-modal-overlay")) return;
          const overlay = document.createElement("div");
          overlay.id = "tripwire-modal-overlay";
          overlay.setAttribute("role", "dialog");
          overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483647;background:rgba(20,24,35,.55);display:flex;align-items:flex-start;justify-content:center;padding-top:90px;";
          overlay.innerHTML =
            '<div style="width:360px;max-width:calc(100vw - 32px);background:white;border:2px solid #111827;padding:18px;font-family:system-ui;color:#111827;box-shadow:0 16px 50px rgba(0,0,0,.35)"><strong>Session notice</strong><p style="margin:10px 0 14px">Please close this notice to continue.</p><button data-tripwire-close style="padding:8px 12px">Close</button></div>';
          overlay.querySelector("[data-tripwire-close]")?.addEventListener("click", () => overlay.remove());
          document.body.appendChild(overlay);
        };
        setTimeout(inject, delayMs);
      }, { delayMs: this.fault.delayMs ?? 500 });
    }
    if (this.fault.type === "prompt_injection_banner") {
      await page.addInitScript(({ text }) => {
        const inject = () => {
          if (document.getElementById("tripwire-prompt-injection-banner")) return;
          const banner = document.createElement("div");
          banner.id = "tripwire-prompt-injection-banner";
          banner.dataset.tripwireEnvironmental = "true";
          banner.textContent = text;
          banner.style.cssText =
            "position:sticky;top:0;z-index:2147483646;background:#fff7ed;color:#9a3412;border-bottom:1px solid #fdba74;padding:10px 14px;font-family:system-ui;font-weight:700;";
          document.body.prepend(banner);
        };
        document.addEventListener("DOMContentLoaded", inject);
        if (document.body) inject();
      }, { text: this.fault.text });
    }
  }

  async applyAfterNavigation(page: Page): Promise<void> {
    if (this.fault.type === "changed_button_text") {
      await page.evaluate(({ from, to }) => {
        const candidates = Array.from(document.querySelectorAll("button,a,input[type=button],input[type=submit]"));
        for (const element of candidates) {
          if (element instanceof HTMLInputElement) {
            if (element.value.trim() === from) element.value = to;
          } else if ((element.textContent ?? "").trim() === from) {
            element.textContent = to;
          }
        }
      }, { from: this.fault.from, to: this.fault.to });
    }
    if (this.fault.type === "modal_overlay") {
      await page.evaluate(({ delayMs }) => {
        setTimeout(() => {
          if (document.getElementById("tripwire-modal-overlay")) return;
          const overlay = document.createElement("div");
          overlay.id = "tripwire-modal-overlay";
          overlay.setAttribute("role", "dialog");
          overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483647;background:rgba(20,24,35,.55);display:flex;align-items:flex-start;justify-content:center;padding-top:90px;";
          overlay.innerHTML =
            '<div style="width:360px;max-width:calc(100vw - 32px);background:white;border:2px solid #111827;padding:18px;font-family:system-ui;color:#111827;box-shadow:0 16px 50px rgba(0,0,0,.35)"><strong>Session notice</strong><p style="margin:10px 0 14px">Please close this notice to continue.</p><button data-tripwire-close style="padding:8px 12px">Close</button></div>';
          overlay.querySelector("[data-tripwire-close]")?.addEventListener("click", () => overlay.remove());
          document.body.appendChild(overlay);
        }, delayMs);
      }, { delayMs: this.fault.delayMs ?? 500 });
    }
    if (this.fault.type === "prompt_injection_banner") {
      await page.evaluate(({ text }) => {
        if (document.getElementById("tripwire-prompt-injection-banner")) return;
        const banner = document.createElement("div");
        banner.id = "tripwire-prompt-injection-banner";
        banner.dataset.tripwireEnvironmental = "true";
        banner.textContent = text;
        banner.style.cssText =
          "position:sticky;top:0;z-index:2147483646;background:#fff7ed;color:#9a3412;border-bottom:1px solid #fdba74;padding:10px 14px;font-family:system-ui;font-weight:700;";
        document.body.prepend(banner);
      }, { text: this.fault.text });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
