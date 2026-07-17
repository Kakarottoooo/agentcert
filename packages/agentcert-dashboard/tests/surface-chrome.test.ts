import { describe, expect, it } from "vitest";

import { PRODUCT_NAV_LINKS } from "../src/Brand";
import { resolveAuthMode } from "../src/auth-routing";

describe("shared product chrome", () => {
  it("keeps the public evidence and workspace entry points explicit", () => {
    expect(PRODUCT_NAV_LINKS.map((item) => [item.label, item.href])).toContainEqual(["Evidence", "/evidence"]);
    expect(PRODUCT_NAV_LINKS.map((item) => item.href)).not.toContain("/demo");
  });

  it("opens sign-in by default and sign-up only when explicitly requested", () => {
    expect(resolveAuthMode("")).toBe("signin");
    expect(resolveAuthMode("?mode=signin")).toBe("signin");
    expect(resolveAuthMode("?mode=signup")).toBe("signup");
    expect(resolveAuthMode("?mode=SIGNUP")).toBe("signin");
  });
});
