import { describe, expect, it } from "vitest";
import { PortalCapabilityService } from "../src/modules/privacy-portal/routes.js";
import {
  MagicLinkError,
  MagicLinkService,
} from "../src/modules/identity-verification/magic-link-service.js";

describe("privacy portal capabilities", () => {
  it("binds a portal token to exactly one request", () => {
    const service = new PortalCapabilityService(
      new Uint8Array(32).fill(5),
      () => new Date("2026-07-24T00:00:00.000Z"),
    );
    const token = service.issue({
      requestId: "req_a",
      projectId: "project_1",
      portalSessionId: "session_1",
      permissions: ["read_status"],
    });
    expect(service.verify(token).requestId).toBe("req_a");
  });

  it("consumes magic-link tokens once", async () => {
    const service = new MagicLinkService(
      {
        sendMagicLink: () => {},
        verifyMagicLink: () => true,
      },
      () => new Date("2026-07-24T00:00:00.000Z"),
    );
    const link = await service.create({
      projectId: "project_1",
      portalBaseUrl: "https://privacy.example",
    });
    await expect(
      service.consume({
        challengeId: link.challengeId,
        token: link.token,
      }),
    ).resolves.toEqual({ projectId: "project_1" });
    await expect(
      service.consume({
        challengeId: link.challengeId,
        token: link.token,
      }),
    ).rejects.toThrowError(new MagicLinkError("MAGIC_LINK_REPLAYED"));
  });
});
