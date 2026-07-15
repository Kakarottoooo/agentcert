import { describe, expect, it } from "vitest";
import { publicHttpError } from "../src/server.js";
import { ControlPlaneError } from "../src/service.js";

describe("control-plane error boundary", () => {
  it("keeps expected client errors actionable", () => {
    expect(publicHttpError(new ControlPlaneError("Project access denied.", 403))).toEqual({
      status: 403,
      message: "Project access denied.",
    });
  });

  it("does not return internal infrastructure details to clients", () => {
    expect(publicHttpError(new Error("password authentication failed for postgres at internal-host"))).toEqual({
      status: 500,
      message: "Internal server error.",
    });
  });
});
