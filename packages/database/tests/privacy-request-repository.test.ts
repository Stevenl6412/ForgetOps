import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrivacyRequestAggregate } from "@forgetops/domain";
import {
  PrivacyRequestConcurrencyError,
  PrivacyRequestRepository,
} from "../src/repositories/privacy-request-repository.js";
import {
  deterministicPersistence,
  resetDatabase,
  seedTenantHierarchy,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from "./postgres-fixture.js";

function request(id: string, environmentId: string) {
  return PrivacyRequestAggregate.create({
    id,
    environmentId,
    type: "delete",
    source: "admin",
    policyVersion: 1,
    createdByActorId: "usr_1",
    deadlineAt: "2026-08-20T00:00:00.000Z",
  });
}

describe("PrivacyRequestRepository", () => {
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

  it("persists request state, audit chain, and outbox events atomically", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "happy",
    );
    const aggregate = request("req_happy", environmentId);
    aggregate.markIdentityVerified({ actorId: "usr_1" });
    aggregate.beginPlanning({ agentId: "agt_1" });
    const pendingCount = aggregate.pendingEvents().length;
    const repository = new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    );

    await repository.save(aggregate);

    const requests = await database.client`
      select id, tenant_id, environment_id, status, version, subject_hash
      from privacy_requests where id = 'req_happy'
    `;
    const audits = await database.client`
      select id, previous_event_hash, event_hash, action
      from audit_events order by created_at, id
    `;
    const outbox = await database.client`
      select id, aggregate_id, type, payload, occurred_at
      from outbox_events order by occurred_at, id
    `;

    expect(requests).toEqual([
      expect.objectContaining({
        id: "req_happy",
        tenant_id: tenantId,
        environment_id: environmentId,
        status: "planning",
        version: 3,
        subject_hash: null,
      }),
    ]);
    expect(audits).toHaveLength(pendingCount);
    expect(outbox).toHaveLength(pendingCount);
    expect(audits[0]?.previous_event_hash).toBeNull();
    expect(audits[0]?.event_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(audits[1]?.previous_event_hash).toBe(audits[0]?.event_hash);
    expect(audits[2]?.previous_event_hash).toBe(audits[1]?.event_hash);
    expect(outbox.map((row) => row.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerified",
      "PlanningRequested",
    ]);
    expect(aggregate.pendingEvents()).toEqual([]);
  });

  it("rolls back request and audit writes when outbox insertion fails", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "rollback",
    );
    const aggregate = request("req_rollback", environmentId);
    const repository = new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    );
    await database.client.unsafe(`
      create function reject_outbox_insert() returns trigger language plpgsql as $$
      begin
        raise exception 'forced outbox failure';
      end;
      $$;
      create trigger reject_outbox_insert
      before insert on outbox_events
      for each row execute function reject_outbox_insert();
    `);

    try {
      await expect(repository.save(aggregate)).rejects.toThrow(
        "forced outbox failure",
      );
      const counts = await database.client`
        select
          (select count(*)::int from privacy_requests) as requests,
          (select count(*)::int from audit_events) as audits,
          (select count(*)::int from outbox_events) as outbox
      `;
      expect(counts[0]).toEqual({ requests: 0, audits: 0, outbox: 0 });
      expect(aggregate.pendingEvents().map((event) => event.type)).toEqual([
        "PrivacyRequestCreated",
      ]);
    } finally {
      await database.client.unsafe(`
        drop trigger if exists reject_outbox_insert on outbox_events;
        drop function if exists reject_outbox_insert();
      `);
    }
  });

  it("attributes plan approval audit events to the deciding user", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "approval_actor",
    );
    const aggregate = request("req_approval_actor", environmentId);
    aggregate.markIdentityVerified({ actorId: "usr_1" });
    aggregate.beginPlanning({ agentId: "agt_1" });
    aggregate.attachPlan({
      planId: "plan_1",
      planVersion: 1,
      planFingerprint: "sha256:plan",
      requiresApproval: true,
    });
    aggregate.approvePlan({
      planId: "plan_1",
      planVersion: 1,
      planFingerprint: "sha256:plan",
      decidedBy: "usr_approver",
    });
    await new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    ).save(aggregate);

    const rows = await database.client`
      select actor_type, actor_id from audit_events
      where action = 'ExecutionPlanApproved'
    `;
    expect(rows).toEqual([{ actor_type: "user", actor_id: "usr_approver" }]);
  });

  it("rejects stale aggregate versions and retains their events", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "stale",
    );
    const repository = new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    );
    const current = request("req_stale", environmentId);
    const stale = request("req_stale", environmentId);
    await repository.save(current);
    stale.markEventsCommitted(1);
    current.markIdentityVerified({ actorId: "usr_current" });
    stale.markIdentityVerified({ actorId: "usr_stale" });
    await repository.save(current);

    await expect(repository.save(stale)).rejects.toBeInstanceOf(
      PrivacyRequestConcurrencyError,
    );
    expect(stale.pendingEvents().map((event) => event.type)).toEqual([
      "IdentityVerified",
    ]);
    const rows = await database.client`
      select status, version from privacy_requests where id = 'req_stale'
    `;
    expect(rows[0]).toEqual({ status: "identity_verified", version: 2 });
  });

  it("translates a duplicate initial insert into a concurrency error", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "duplicate",
    );
    const repository = new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    );
    await repository.save(request("req_duplicate", environmentId));
    const duplicate = request("req_duplicate", environmentId);

    await expect(repository.save(duplicate)).rejects.toBeInstanceOf(
      PrivacyRequestConcurrencyError,
    );
    expect(duplicate.pendingEvents()).toHaveLength(1);
  });

  it("rejects UPDATE and DELETE of audit rows at the database level", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "audit",
    );
    const repository = new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    );
    await repository.save(request("req_audit", environmentId));

    await expect(
      database.client`update audit_events set action = 'tampered'`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      database.client`delete from audit_events`,
    ).rejects.toMatchObject({ code: "55000" });
    const rows = await database.client`
      select action, event_hash from audit_events
    `;
    expect(rows).toEqual([
      expect.objectContaining({
        action: "PrivacyRequestCreated",
        event_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });
});
