import { describe, expect, it } from "vitest";
import { PrivacyRequestStatusSchema } from "@forgetops/contracts";

describe("contracts package boundary", () => {
  it("resolves the contracts source barrel from the package root", () => {
    expect(PrivacyRequestStatusSchema.parse("planning")).toBe("planning");
  });
});
