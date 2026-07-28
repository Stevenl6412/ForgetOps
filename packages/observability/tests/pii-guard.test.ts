import { describe, expect, it } from "vitest";
import { SafeLogger } from "../src/logger.js";

describe("PII telemetry guard", () => {
  it("emits only allowlisted telemetry fields", () => {
    let output = "";
    const logger = new SafeLogger(
      { write: (line) => (output = line) },
      () => new Date("2026-07-24T00:00:00.000Z"),
    );
    logger.info(
      {
        email: "canary@example.com",
        requestId: "req_1",
        accessToken: "secret-canary",
        unexpectedField: "must-not-escape",
      },
      "request.completed",
    );
    expect(output).not.toContain("canary@example.com");
    expect(output).not.toContain("secret-canary");
    expect(output).not.toContain("must-not-escape");
    expect(output).toContain("req_1");
  });
});
