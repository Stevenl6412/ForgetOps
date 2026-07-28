import { describe, expect, it } from "vitest";
import { ExecutionKillSwitch } from "../src/modules/operations/kill-switch.js";

describe("execution kill switch", () => {
  it("blocks until an explicit resume", () => {
    const killSwitch = new ExecutionKillSwitch();
    expect(killSwitch.isExecutionPaused()).toBe(false);
    killSwitch.pause("incident_response");
    expect(killSwitch.status()).toEqual({
      paused: true,
      reason: "incident_response",
    });
    killSwitch.resume();
    expect(killSwitch.isExecutionPaused()).toBe(false);
  });
});
