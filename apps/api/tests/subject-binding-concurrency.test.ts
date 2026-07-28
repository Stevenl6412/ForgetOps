import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDatabase, type DatabaseConnection } from "@forgetops/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresSubjectEnvelopeRepository,
  SubjectEnvelopeService,
} from "../src/modules/privacy-requests/subject-envelope-service.js";

let container: StartedPostgreSqlContainer;
let database: DatabaseConnection;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("forgetops_subject_test")
    .withUsername("forgetops")
    .withPassword("forgetops")
    .start();
  database = createDatabase(container.getConnectionUri());
  for (const migrationName of [
    "0001_initial.sql",
    "0002_environment_subject_canonicalization.sql",
    "0003_agent_pairing_replacement.sql",
    "0004_agent_gateway_rls.sql",
    "0005_subject_identity_binding.sql",
    "0006_audit_and_job_kind_upgrades.sql",
  ]) {
    const migration = await readFile(
      fileURLToPath(
        new URL(
          `../../../packages/database/migrations/${migrationName}`,
          import.meta.url,
        ),
      ),
      "utf8",
    );
    await database.client.unsafe(migration);
  }
}, 120_000);

beforeEach(async () => {
  await database.client.unsafe(
    "truncate table subject_identity_aliases, subject_envelopes, outbox_events, audit_events, audit_chain_heads, privacy_requests, agents, environments, projects, tenants cascade",
  );
  await database.client`
    insert into tenants (id, name, plan) values ('tenant_subject', 'Subjects', 'trial')
  `;
  await database.client`
    insert into projects (id, tenant_id, name, slug)
    values ('project_subject', 'tenant_subject', 'Subjects', 'subjects')
  `;
  await database.client`
    insert into environments (
      id, project_id, kind, status, subject_hash_key_version,
      subject_canonicalization_version
    ) values ('env_subject', 'project_subject', 'production', 'active', 1, 1)
  `;
  await database.client`
    insert into agents (
      id, environment_id, public_signing_key, public_encryption_key,
      signing_key_id, encryption_key_id, version, protocol_version,
      instance_fingerprint, status, last_sequence
    ) values (
      'agent_subject', 'env_subject', 'signing-key', 'encryption-key',
      ${`ed25519:sha256:${"a".repeat(64)}`},
      ${`x25519:sha256:${"b".repeat(64)}`},
      '1.0.0', '1.0', 'sha256:subject-agent', 'online', '0'
    )
  `;
});

afterAll(async () => {
  if (database) await database.close();
  if (container) await container.stop();
});

describe("subject binding concurrency", () => {
  it("stores only a versioned envelope for the active agent key", async () => {
    await insertRequest("req_store", "2026-07-23T00:00:00Z");
    const service = new SubjectEnvelopeService(
      new PostgresSubjectEnvelopeRepository(database.client),
      { now: () => new Date("2026-07-24T01:00:00Z") },
    );
    const encryptionKeyId = `x25519:sha256:${"b".repeat(64)}`;

    await service.storeEnvelope({
      tenantId: "tenant_subject",
      environmentId: "env_subject",
      requestId: "req_store",
      ciphertext: serializedEnvelope("req_store", encryptionKeyId),
      encryptionKeyId,
      expiresAt: "2026-07-25T00:00:00Z",
    });

    expect(
      await database.client`
        select request_id, encryption_key_id
        from subject_envelopes
        where request_id = 'req_store'
      `,
    ).toEqual([
      { request_id: "req_store", encryption_key_id: encryptionKeyId },
    ]);
  });

  it("keeps the older request active and cancels the newer duplicate", async () => {
    await insertRequest("req_old", "2026-07-23T00:00:00Z");
    await insertRequest("req_new", "2026-07-24T00:00:00Z");
    await insertEnvelope("req_old");
    await insertEnvelope("req_new");

    const service = new SubjectEnvelopeService(
      new PostgresSubjectEnvelopeRepository(database.client),
      { now: () => new Date("2026-07-24T01:00:00Z") },
    );
    const input = (requestId: string, expectedVersion = 1) => ({
      tenantId: "tenant_subject",
      environmentId: "env_subject",
      requestId,
      agentId: "agent_subject",
      subjectHash:
        "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      subjectHashKeyVersion: 1,
      canonicalizationVersion: 1,
      expectedVersion,
      aliases: [
        {
          identifierKind: "email" as const,
          subjectHash:
            "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          subjectHashKeyVersion: 1,
          canonicalizationVersion: 1,
        },
      ],
    });

    await Promise.all([
      service.bindSubject(input("req_new")),
      service.bindSubject(input("req_old")),
    ]);

    const rows = await database.client`
      select id, status, subject_hash, duplicate_of_request_id, duplicate_override
      from privacy_requests
      order by id
    `;
    expect(rows).toEqual([
      {
        id: "req_new",
        status: "cancelled",
        subject_hash:
          "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        duplicate_of_request_id: "req_old",
        duplicate_override: false,
      },
      {
        id: "req_old",
        status: "identity_verified",
        subject_hash:
          "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        duplicate_of_request_id: null,
        duplicate_override: false,
      },
    ]);
    expect(
      await database.client`select count(*)::int as count from subject_envelopes`,
    ).toEqual([{ count: 0 }]);
    expect(
      await database.client`
        select count(*)::int as count
        from subject_identity_aliases
        where request_id in ('req_old', 'req_new')
      `,
    ).toEqual([{ count: 2 }]);
    expect(
      await database.client`
        select count(*)::int as count
        from audit_events
        where action = 'PrivacyRequestDuplicateCancelled'
      `,
    ).toEqual([{ count: 1 }]);
    await expect(service.bindSubject(input("req_new"))).resolves.toMatchObject({
      requestId: "req_new",
      outcome: "duplicate_cancelled",
      duplicateOfRequestId: "req_old",
    });
  });

  it("allows an explicit owner override and records it", async () => {
    await insertRequest("req_a", "2026-07-23T00:00:00Z");
    await insertRequest("req_b", "2026-07-24T00:00:00Z");
    await insertEnvelope("req_a");
    await insertEnvelope("req_b");
    const service = new SubjectEnvelopeService(
      new PostgresSubjectEnvelopeRepository(database.client),
      { now: () => new Date("2026-07-24T01:00:00Z") },
    );
    const base = {
      tenantId: "tenant_subject",
      environmentId: "env_subject",
      agentId: "agent_subject",
      subjectHash:
        "hmac-sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      subjectHashKeyVersion: 1,
      canonicalizationVersion: 1,
      expectedVersion: 1,
    } as const;

    await service.bindSubject({ ...base, requestId: "req_a" });
    await service.bindSubject({
      ...base,
      requestId: "req_b",
      duplicateOverride: {
        ownerActorId: "owner_subject",
        reason: "separate legal basis",
      },
    });

    const rows = await database.client`
      select id, status, duplicate_override
      from privacy_requests
      order by id
    `;
    expect(rows).toEqual([
      { id: "req_a", status: "identity_verified", duplicate_override: false },
      { id: "req_b", status: "identity_verified", duplicate_override: true },
    ]);
    expect(
      await database.client`
        select actor_type, actor_id, action
        from audit_events
        where action = 'SubjectDuplicateOverrideApplied'
      `,
    ).toEqual([
      {
        actor_type: "user",
        actor_id: "owner_subject",
        action: "SubjectDuplicateOverrideApplied",
      },
    ]);
  });
});

async function insertRequest(id: string, createdAt: string): Promise<void> {
  await database.client`
    insert into privacy_requests (
      id, tenant_id, environment_id, type, source, status,
      policy_version, deadline_at, created_by_actor_id, created_at, version
    ) values (
      ${id}, 'tenant_subject', 'env_subject', 'delete', 'privacy_portal',
      'identity_verification_pending', 1, '2026-08-01T00:00:00Z',
      'portal_actor', ${createdAt}, 1
    )
  `;
}

async function insertEnvelope(requestId: string): Promise<void> {
  await database.client`
    insert into subject_envelopes (
      request_id, tenant_id, environment_id, ciphertext,
      encryption_key_id, expires_at
    ) values (
      ${requestId}, 'tenant_subject', 'env_subject', ${`opaque-${requestId}`},
      ${`x25519:sha256:${"b".repeat(64)}`}, '2026-07-25T00:00:00Z'
    )
  `;
}

function serializedEnvelope(
  requestId: string,
  encryptionKeyId: string,
): string {
  return JSON.stringify({
    version: 1,
    algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
    requestId,
    environmentId: "env_subject",
    encryptionKeyId,
    ephemeralPublicKey: Buffer.alloc(32, 1).toString("base64url"),
    salt: Buffer.alloc(32, 2).toString("base64url"),
    iv: Buffer.alloc(12, 3).toString("base64url"),
    ciphertext: Buffer.alloc(32, 4).toString("base64url"),
  });
}
