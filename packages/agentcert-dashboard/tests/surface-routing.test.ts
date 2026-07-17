import { describe, expect, it } from "vitest";

import { absoluteSurfaceUrl, isPublicArchiveLocation, resolveHostedSurface } from "../src/surface-routing";

describe("hosted product surface routing", () => {
  it("opens the product homepage at the root without authentication", () => {
    expect(resolveHostedSurface("/", "")).toEqual({
      surface: "home",
      access: "public",
      canonicalPath: "/",
    });
  });

  it("keeps old demo links working while making evidence the canonical public path", () => {
    expect(resolveHostedSurface("/demo", "")).toEqual({
      surface: "public-evidence",
      access: "public",
      canonicalPath: "/evidence",
      normalizedPath: "/evidence",
    });
    expect(resolveHostedSurface("/evidence", "")).toEqual({
      surface: "public-evidence",
      access: "public",
      canonicalPath: "/evidence",
    });
  });

  it("serves pricing and security as public product surfaces", () => {
    expect(resolveHostedSurface("/pricing", "")).toMatchObject({ surface: "pricing", access: "public" });
    expect(resolveHostedSurface("/security/", "")).toMatchObject({
      surface: "security",
      access: "public",
      normalizedPath: "/security",
    });
  });

  it("serves notification verification as a public branded surface", () => {
    expect(resolveHostedSurface("/verify-email", "")).toEqual({
      surface: "email-verification",
      access: "public",
      canonicalPath: "/verify-email",
    });
    expect(resolveHostedSurface("/verify-email/", "")).toMatchObject({
      surface: "email-verification",
      normalizedPath: "/verify-email",
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
    expect(resolveHostedSurface("/evidence", "#error=access_denied&error_code=otp_expired")).toMatchObject({
      surface: "workspace",
      access: "authenticated",
      normalizedPath: "/app",
    });
  });

  it("does not silently map unknown paths into the authenticated application", () => {
    expect(resolveHostedSurface("/private-evidence", "")).toEqual({
      surface: "not-found",
      access: "public",
      canonicalPath: "/",
    });
  });

  it("builds stable public and workspace URLs", () => {
    expect(absoluteSurfaceUrl("https://agentcert.example.com/", "/")).toBe("https://agentcert.example.com/");
    expect(absoluteSurfaceUrl("https://agentcert.example.com/", "/evidence")).toBe("https://agentcert.example.com/evidence");
    expect(absoluteSurfaceUrl("https://agentcert.example.com", "/app")).toBe("https://agentcert.example.com/app");
  });

  it("recognizes the immutable GitHub Pages evidence archive", () => {
    expect(isPublicArchiveLocation({ hostname: "kakarottoooo.github.io", pathname: "/agentcert/public-demo/agentcert-monitor/", protocol: "https:" })).toBe(true);
    expect(isPublicArchiveLocation({ hostname: "agentcert.app", pathname: "/evidence", protocol: "https:" })).toBe(false);
  });
});
