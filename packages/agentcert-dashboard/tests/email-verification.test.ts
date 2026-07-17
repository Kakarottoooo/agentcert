import { describe, expect, it } from "vitest";

import { resolveEmailVerificationState } from "../src/EmailVerificationPage";

describe("branded email verification state", () => {
  it.each([
    ["?status=verified", "verified", true],
    ["?status=already_verified", "already_verified", true],
    ["?status=expired", "expired", false],
    ["?status=invalid", "invalid", false],
    ["?status=unexpected", "invalid", false],
  ] as const)("maps %s to a safe public state", (search, status, autoReturn) => {
    expect(resolveEmailVerificationState(search)).toMatchObject({ status, autoReturn });
  });
});
