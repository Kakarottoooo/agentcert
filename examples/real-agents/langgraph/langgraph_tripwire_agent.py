import asyncio
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

from langgraph.graph import END, StateGraph
from playwright.async_api import async_playwright


class BrowserTaskState(TypedDict):
    cdp_url: str
    start_url: str
    order_id: str
    events_file: str | None


async def complete_refund(state: BrowserTaskState) -> BrowserTaskState:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(state["cdp_url"])
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        await record_event(state, "navigate", "page", state["start_url"])
        if not page.url.startswith(state["start_url"]):
            await page.goto(state["start_url"])

        close = page.get_by_role("button", name=re.compile("close|dismiss|continue", re.IGNORECASE))
        if await close.count() > 0:
            try:
                await close.first.click(timeout=1500)
                await record_event(state, "click", "overlay-close", "closed optional overlay")
            except Exception:
                pass

        await page.get_by_label("Order ID").fill(state["order_id"])
        await record_event(state, "fill", "input:Order ID", state["order_id"])
        await page.get_by_label("Reason").fill("Customer requested a refund.")
        await record_event(state, "fill", "textarea:Reason", "Customer requested a refund.")

        submit_like = page.get_by_role("button", name=re.compile("submit|continue", re.IGNORECASE))
        await submit_like.first.click()
        await record_event(state, "click", "button:submit-like", page.url)

        await browser.close()
    return state


async def record_event(state: BrowserTaskState, action: str, target: str, detail: str) -> None:
    events_file = state.get("events_file")
    if not events_file:
        return
    payload = {
        "timestamp": datetime.now(UTC).isoformat(),
        "action": action,
        "target": target,
        "detail": detail,
    }
    Path(events_file).parent.mkdir(parents=True, exist_ok=True)
    with open(events_file, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + "\n")


async def main() -> None:
    graph = StateGraph(BrowserTaskState)
    graph.add_node("complete_refund", complete_refund)
    graph.set_entry_point("complete_refund")
    graph.add_edge("complete_refund", END)
    app = graph.compile()

    await app.ainvoke(
        {
            "cdp_url": required_env("TRIPWIRE_CDP_URL"),
            "start_url": required_env("TRIPWIRE_START_URL"),
            "order_id": os.environ.get("ORDER_ID", "1234"),
            "events_file": os.environ.get("TRIPWIRE_EVENTS_FILE"),
        }
    )


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Missing {name}. Tripwire injects this environment variable when it runs the agent."
        )
    return value


if __name__ == "__main__":
    asyncio.run(main())
