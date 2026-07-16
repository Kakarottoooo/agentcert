import { describe, expect, it } from "vitest";

import { absoluteSurfaceUrl, isPublicArchiveLocation, resolveHostedSurface } from "../src/surface-routing";

describe("hosted product surface routing", () => {
  it("opens the public demo without authentication and canonicalizes the root URL", () => {
    expect(resolveHostedSurface("/", "")).toEqual({
      surface: "public-demo",
      access: "public",
      canonicalPath: "/demo",
      normalizedPath: "/demo",
    });
    expect(resolveHostedSurface("/demo", "")).toEqual({
      surface: "public-demo",
      access: "public",
      canonicalPath: "/demo",
    });
  });

  it("keeps the private workspace behind the authenticated surface", () => {
    expect(resolveHostedSurface("/app", "")).toEqual({
      surface: "workspace",
      access: "authenticated",
      canonicalPath: "/app",
    });
  });

  it("routes Supabase callbacks to the workspace before auth state is read", () => {
    expect(resolveHostedSurface("/", "#access_token=session-token&refresh_token=refresh-token")).toEqual({
      surface: "workspace",
      access: "authenticated",
      canonicalPath: "/app",
      normalizedPath: "/app",
    });
    expect(resolveHostedSurface("/demo", "#error=access_denied&error_code=otp_expired")).toMatchObject({
      surface: "workspace",
      access: "authenticated",
      normalizedPath: "/app",
    });
  });

  it("does not silently map unknown paths into the authenticated application", () => {
    expect(resolveHostedSurface("/private-evidence", "")).toEqual({
      surface: "not-found",
      access: "public",
      canonicalPath: "/demo",
    });
  });

  it("builds stable public and workspace URLs", () => {
    expect(absoluteSurfaceUrl("https://agentcert.example.com/", "/demo")).toBe("https://agentcert.example.com/demo");
    expect(absoluteSurfaceUrl("https://agentcert.example.com", "/app")).toBe("https://agentcert.example.com/app");
  });

  it("recognizes the immutable GitHub Pages evidence archive", () => {
    expect(isPublicArchiveLocation({ hostname: "kakarottoooo.github.io", pathname: "/agentcert/public-demo/agentcert-monitor/", protocol: "https:" })).toBe(true);
    expect(isPublicArchiveLocation({ hostname: "agentcert-control-plane.onrender.com", pathname: "/demo", protocol: "https:" })).toBe(false);
  });
});
