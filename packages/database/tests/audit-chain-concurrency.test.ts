import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrivacyRequestAggregate } from "@forgetops/domain";
import { PrivacyRequestRepository } from "../src/repositories/privacy-request-repository.js";
import {
  resetDatabase,
  seedTenantHierarchy,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from "./postgres-fixture.js";

describe("serialized audit chain", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await stopTestDatabase(database);
  });

  beforeEach(async () => {
    await resetDatabase(database.client);
  });

  it("keeps one contiguous chain across 50 concurrent transitions", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "audit_concurrency",
    );
    const repository = new PrivacyRequestRepository(database.client, tenantId);
    const requests = Array.from({ length: 50 }, (_, index) =>
      PrivacyRequestAggregate.create({
        id: `req_concurrent_${index}`,
        environmentId,
        type: "delete",
        source: "api",
        policyVersion: 1,
        createdByActorId: `usr_${index}`,
        deadlineAt: "2026-08-20T00:00:00.000Z",
      }),
    );

    await Promise.all(requests.map((request) => repository.save(request, 0)));

    const events = await database.client`
      select sequence::int, previous_event_hash, event_hash
      from audit_events
      where environment_id = ${environmentId}
      order by sequence
    `;
    const heads = await database.client`
      select sequence::int, event_hash
      from audit_chain_heads
      where environment_id = ${environmentId}
    `;

    expect(events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(events[0]?.previous_event_hash).toBeNull();
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.previous_event_hash).toBe(
        events[index - 1]?.event_hash,
      );
    }
    expect(new Set(events.map(({ event_hash }) => event_hash)).size).toBe(50);
    expect(heads).toEqual([
      {
        sequence: 50,
        event_hash: events.at(-1)?.event_hash,
      },
    ]);
  });
});
