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

    await repository.save(aggregate, 0);

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

  it("matches the audit hash known vector", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "hash_vector",
    );
    const aggregate = request("req_hash_vector", environmentId);
    await new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    ).save(aggregate, 0);

    const rows = await database.client`
      select event_hash
      from audit_events
      where request_id = 'req_hash_vector'
    `;
    expect(rows).toEqual([
      {
        event_hash:
          "4c77a2f81002ee10cfe5fb906b6bcea81c084ce591f9dfc95b41b987e513e26f",
      },
    ]);
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
      await expect(repository.save(aggregate, 0)).rejects.toThrow(
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
    ).save(aggregate, 0);

    const rows = await database.client`
      select actor_type, actor_id from audit_events
      where action = 'ExecutionPlanApproved'
    `;
    expect(rows).toEqual([{ actor_type: "user", actor_id: "usr_approver" }]);
  });

  it("persists immutable attempts and advances only the current retry", async () => {
    const { tenantId, environmentId } = await seedTenantHierarchy(
      database.client,
      "attempts",
    );
    const aggregate = request("req_attempts", environmentId);
    aggregate.markIdentityVerified({ actorId: "usr_1" });
    aggregate.beginPlanning({ agentId: "agt_1" });
    const plan = {
      planId: "plan_1",
      planVersion: 1,
      planFingerprint: "sha256:plan",
    };
    aggregate.attachPlan({ ...plan, requiresApproval: true });
    aggregate.approvePlan({ ...plan, decidedBy: "usr_approver" });
    aggregate.authorizeExecution({
      ...plan,
      agentId: "agt_1",
      attemptId: "att_1",
      allowedStepIds: ["step_1", "step_failed"],
    });
    aggregate.markExecuting({ agentId: "agt_1" });
    aggregate.markPartial({ affectedCount: 1, failedCount: 1 });
    const repository = new PrivacyRequestRepository(
      database.client,
      tenantId,
      deterministicPersistence(),
    );
    await repository.save(aggregate, 0);

    aggregate.beginRetry({
      attemptId: "att_2",
      allowedStepIds: ["step_failed"],
      expectedVersion: aggregate.version,
    });
    await repository.save(aggregate, 8);
    aggregate.markExecuting({ agentId: "agt_1" });
    await repository.save(aggregate, 9);

    const attempts = await database.client`
      select id, attempt_number, kind, allowed_step_ids, status, completed_at
      from execution_attempts
      where request_id = 'req_attempts'
      order by attempt_number
    `;
    expect(attempts).toEqual([
      expect.objectContaining({
        id: "att_1",
        attempt_number: 1,
        kind: "initial",
        allowed_step_ids: ["step_1", "step_failed"],
        status: "partially_succeeded",
        completed_at: expect.any(String),
      }),
      expect.objectContaining({
        id: "att_2",
        attempt_number: 2,
        kind: "retry",
        allowed_step_ids: ["step_failed"],
        status: "running",
        completed_at: null,
      }),
    ]);
    expect(
      await database.client`
        select current_attempt_id
        from privacy_requests
        where id = 'req_attempts'
      `,
    ).toEqual([{ current_attempt_id: "att_2" }]);
    await expect(database.client`
      update execution_attempts set status = 'failed' where id = 'att_1'
    `).rejects.toMatchObject({ code: "55000" });
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
    await repository.save(current, 0);
    stale.markEventsCommitted(1);
    current.markIdentityVerified({ actorId: "usr_current" });
    stale.markIdentityVerified({ actorId: "usr_stale" });
    await repository.save(current, 1);

    await expect(repository.save(stale, 1)).rejects.toBeInstanceOf(
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
    await repository.save(request("req_duplicate", environmentId), 0);
    const duplicate = request("req_duplicate", environmentId);

    await expect(repository.save(duplicate, 0)).rejects.toBeInstanceOf(
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
    await repository.save(request("req_audit", environmentId), 0);

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
