import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMonitorSnapshot } from "../src/data";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public monitor loading", () => {
  it("falls back to the bundled snapshot when a hosted SPA serves HTML for the local API path", async () => {
    const snapshot = { kind: "agentcert.monitor_snapshot", schemaVersion: "1" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("window", { location: { protocol: "https:" } });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadMonitorSnapshot()).resolves.toEqual({ snapshot, source: "static" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the local API only when it returns a valid monitor snapshot", async () => {
    const snapshot = { kind: "agentcert.monitor_snapshot", schemaVersion: "1" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("window", { location: { protocol: "http:" } });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadMonitorSnapshot()).resolves.toEqual({ snapshot, source: "api" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not probe local write-back APIs from a public read-only surface", async () => {
    const snapshot = { kind: "agentcert.monitor_snapshot", schemaVersion: "1" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("window", { location: { protocol: "https:" } });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadMonitorSnapshot(false)).resolves.toEqual({ snapshot, source: "static" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("data/monitor.json");
  });
});
