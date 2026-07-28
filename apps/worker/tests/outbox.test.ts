import { describe, expect, it } from "vitest";
import {
  NotificationJob,
  OutboxPublisher,
  type OutboxEvent,
} from "../src/index.js";

const event: OutboxEvent = {
  id: "event_1",
  tenantId: "tenant_1",
  type: "PrivacyRequestCompleted",
  payload: {
    requestId: "req_1",
    affectedCount: 2,
    email: "secret@example.com",
  },
  occurredAt: "2026-07-24T00:00:00.000Z",
  publishedAt: null,
};

describe("worker jobs", () => {
  it("claims, publishes, and marks an outbox event once", async () => {
    const published: string[] = [];
    let marked = 0;
    const publisher = new OutboxPublisher(
      {
        claim: () => [event],
        markPublished: () => {
          marked += 1;
        },
      },
      {
        publish: (item) => {
          published.push(item.id);
        },
        now: () => new Date("2026-07-24T00:01:00.000Z"),
      },
    );
    expect(await publisher.runOnce()).toBe(1);
    expect(published).toEqual(["event_1"]);
    expect(marked).toBe(1);
  });

  it("strips raw identifiers from notification payloads", async () => {
    let received: Record<string, unknown> | undefined;
    const job = new NotificationJob({
      send: (input) => {
        received = input.payload;
      },
    });
    await job.handle(event);
    expect(received).toEqual({ requestId: "req_1", affectedCount: 2 });
  });
});
