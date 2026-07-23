import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrivacyRequestAggregate } from "@forgetops/domain";
import type { Sql } from "postgres";
import {
  PrivacyRequestRepository,
  TenantScopeError,
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
    source: "api",
    policyVersion: 1,
    createdByActorId: "usr_1",
    deadlineAt: "2026-08-20T00:00:00.000Z",
  });
}

async function insertRequest(
  sql: Sql,
  input: {
    id: string;
    tenantId: string;
    environmentId: string;
    idempotencyKey: string;
    subjectHash?: string | null;
    status?: string;
    type?: string;
  },
) {
  await sql`
    insert into privacy_requests (
      id, tenant_id, environment_id, type, source, subject_hash, status,
      policy_version, deadline_at, created_by_actor_id, version, idempotency_key
    ) values (
      ${input.id}, ${input.tenantId}, ${input.environmentId},
      ${input.type ?? "delete"}, 'api', ${input.subjectHash ?? null},
      ${input.status ?? "created"}, 1, '2026-08-20T00:00:00.000Z',
      'usr_1', 1, ${input.idempotencyKey}
    )
  `;
}

describe("tenant isolation and database integrity", () => {
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

  it("filters findById by repository tenant", async () => {
    const tenantA = await seedTenantHierarchy(database.client, "find_a");
    const tenantB = await seedTenantHierarchy(database.client, "find_b");
    const repositoryB = new PrivacyRequestRepository(
      database.client,
      tenantB.tenantId,
      deterministicPersistence(),
    );
    await repositoryB.save(request("req_b", tenantB.environmentId));
    const repositoryA = new PrivacyRequestRepository(
      database.client,
      tenantA.tenantId,
      deterministicPersistence(),
    );

    expect(await repositoryA.findById("req_b")).toBeNull();
    expect(await repositoryB.findById("req_b")).toMatchObject({
      id: "req_b",
      tenantId: tenantB.tenantId,
    });
  });

  it("rejects saving an aggregate for another tenant environment", async () => {
    const tenantA = await seedTenantHierarchy(database.client, "save_a");
    const tenantB = await seedTenantHierarchy(database.client, "save_b");
    const aggregate = request("req_wrong_tenant", tenantB.environmentId);
    const repositoryA = new PrivacyRequestRepository(
      database.client,
      tenantA.tenantId,
      deterministicPersistence(),
    );

    await expect(repositoryA.save(aggregate)).rejects.toBeInstanceOf(
      TenantScopeError,
    );
    expect(aggregate.pendingEvents()).toHaveLength(1);
    const rows = await database.client`
      select count(*)::int as count from privacy_requests
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("creates all four required unique indexes", async () => {
    const rows = await database.client`
      select indexname from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'environments_project_kind_uq',
          'agents_one_active_per_environment_uq',
          'privacy_requests_idempotency_uq',
          'privacy_requests_one_active_subject_type_uq'
        )
      order by indexname
    `;
    expect(rows.map((row) => row.indexname)).toEqual([
      "agents_one_active_per_environment_uq",
      "environments_project_kind_uq",
      "privacy_requests_idempotency_uq",
      "privacy_requests_one_active_subject_type_uq",
    ]);
  });

  it("enforces one environment kind per project", async () => {
    const { projectId } = await seedTenantHierarchy(database.client, "env_uq");

    await expect(database.client`
      insert into environments (id, project_id, kind, status, subject_hash_key_version)
      values ('env_duplicate', ${projectId}, 'production', 'active', 1)
    `).rejects.toMatchObject({
      code: "23505",
      constraint_name: "environments_project_kind_uq",
    });
  });

  it("allows revoked agents but enforces one active agent per environment", async () => {
    const { environmentId } = await seedTenantHierarchy(
      database.client,
      "agent_uq",
    );
    const insertAgent = (id: string, status: string) => database.client`
      insert into agents (
        id, environment_id, public_signing_key, public_encryption_key,
        version, protocol_version, status, last_sequence
      ) values (${id}, ${environmentId}, 'sign', 'encrypt', '1.0.0', '1', ${status}, '0')
    `;

    await insertAgent("agent_revoked_1", "revoked");
    await insertAgent("agent_revoked_2", "revoked");
    await insertAgent("agent_online", "online");
    await expect(insertAgent("agent_offline", "offline")).rejects.toMatchObject(
      {
        code: "23505",
        constraint_name: "agents_one_active_per_environment_uq",
      },
    );
  });

  it("enforces environment-scoped idempotency keys", async () => {
    const hierarchy = await seedTenantHierarchy(database.client, "idem_uq");
    await insertRequest(database.client, {
      id: "req_idem_1",
      ...hierarchy,
      idempotencyKey: "same-key",
    });

    await expect(
      insertRequest(database.client, {
        id: "req_idem_2",
        ...hierarchy,
        idempotencyKey: "same-key",
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint_name: "privacy_requests_idempotency_uq",
    });
  });

  it("allows terminal duplicates but rejects duplicate active subject requests", async () => {
    const hierarchy = await seedTenantHierarchy(database.client, "subject_uq");
    await insertRequest(database.client, {
      id: "req_terminal_1",
      ...hierarchy,
      idempotencyKey: "terminal-1",
      subjectHash: "hmac:subject",
      status: "completed",
    });
    await insertRequest(database.client, {
      id: "req_terminal_2",
      ...hierarchy,
      idempotencyKey: "terminal-2",
      subjectHash: "hmac:subject",
      status: "failed",
    });
    await insertRequest(database.client, {
      id: "req_active_1",
      ...hierarchy,
      idempotencyKey: "active-1",
      subjectHash: "hmac:subject",
    });

    await expect(
      insertRequest(database.client, {
        id: "req_active_2",
        ...hierarchy,
        idempotencyKey: "active-2",
        subjectHash: "hmac:subject",
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint_name: "privacy_requests_one_active_subject_type_uq",
    });
  });
});
