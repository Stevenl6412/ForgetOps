import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDatabase, type DatabaseConnection } from "@forgetops/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AgentMessageAuthenticator,
  Ed25519MessageSigner,
} from "../src/modules/agent-gateway/message-signer.js";
import { PostgresJobRepository } from "../src/modules/agent-gateway/job-repository.js";

const NOW = new Date("2026-07-23T08:00:00.000Z");
const AGENT_ID = "agt_gateway";
const ENVIRONMENT_ID = "env_gateway";
const agentSigner = Ed25519MessageSigner.fromSeed(
  Buffer.alloc(32, 9),
  "agent-key-postgres",
);

let container: StartedPostgreSqlContainer;
let database: DatabaseConnection;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("forgetops_gateway_test")
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
    "truncate table agent_message_receipts, agent_jobs, agent_pairing_tokens, subject_envelopes, outbox_events, audit_events, privacy_requests, agents, environments, projects, tenants cascade",
  );
  await database.client`
    insert into tenants (id, name, plan) values ('tenant_gateway', 'Gateway Tenant', 'trial')
  `;
  await database.client`
    insert into projects (id, tenant_id, name, slug)
    values ('project_gateway', 'tenant_gateway', 'Gateway Project', 'gateway-project')
  `;
  await database.client`
    insert into environments (id, project_id, kind, status, subject_hash_key_version)
    values (${ENVIRONMENT_ID}, 'project_gateway', 'production', 'active', 1)
  `;
  await database.client`
    insert into agents (
      id, environment_id, public_signing_key, public_encryption_key,
      signing_key_id, version, protocol_version, instance_fingerprint,
      status, last_sequence
    ) values (
      ${AGENT_ID}, ${ENVIRONMENT_ID}, ${agentSigner.publicKey()},
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ${agentSigner.keyId},
      '1.0.0', '1.0', 'sha256:gateway-agent', 'online', '0'
    )
  `;
  await database.client`
    insert into privacy_requests (
      id, tenant_id, environment_id, type, source, subject_hash, status,
      policy_version, deadline_at, created_by_actor_id, version
    ) values (
      'req_gateway', 'tenant_gateway', ${ENVIRONMENT_ID}, 'delete', 'admin',
      'subject_gateway', 'planning', 1, '2026-07-30T00:00:00.000Z',
      'owner_gateway', 1
    )
  `;
});

afterAll(async () => {
  if (database) await database.close();
  if (container) await container.stop();
});

describe("Postgres agent gateway", () => {
  it("rejects tampering, replay, expired messages, and revoked agents", async () => {
    const repository = new PostgresJobRepository(database.client);
    const authenticator = new AgentMessageAuthenticator(repository, {
      now: () => NOW,
    });
    const first = signedAgentMessage("1", "msg_gateway_1");

    await expect(authenticator.authenticate(first)).resolves.toMatchObject({
      agentId: AGENT_ID,
      environmentId: ENVIRONMENT_ID,
    });
    await expect(authenticator.authenticate(first)).rejects.toMatchObject({
      code: "AUTH_REPLAY_DETECTED",
    });

    const tampered = signedAgentMessage("2", "msg_gateway_2");
    tampered.payload = { waitMs: 45_000 };
    await expect(authenticator.authenticate(tampered)).rejects.toMatchObject({
      code: "AUTH_SIGNATURE_INVALID",
    });
    await expect(
      authenticator.authenticate(signedAgentMessage("2", "msg_gateway_2")),
    ).resolves.toBeDefined();
    await expect(
      authenticator.authenticate(signedAgentMessage("1", "msg_gateway_3")),
    ).rejects.toMatchObject({
      code: "AUTH_REPLAY_DETECTED",
    });
    await expect(
      authenticator.authenticate(
        signedAgentMessage(
          "3",
          "msg_gateway_stale",
          "2026-07-23T07:54:59.000Z",
        ),
      ),
    ).rejects.toMatchObject({
      code: "AUTH_SIGNATURE_INVALID",
    });

    await database.client`
      update agents set status = 'revoked' where id = ${AGENT_ID}
    `;
    await expect(
      authenticator.authenticate(
        signedAgentMessage("3", "msg_gateway_revoked"),
      ),
    ).rejects.toMatchObject({
      code: "AUTH_AGENT_REVOKED",
    });
  });

  it("leases idempotently and makes an expired lease available again", async () => {
    const repository = new PostgresJobRepository(database.client);
    await repository.enqueue({
      id: "job_gateway",
      tenantId: "tenant_gateway",
      requestId: "req_gateway",
      environmentId: ENVIRONMENT_ID,
      kind: "plan",
      planVersion: 1,
      payloadCiphertext: null,
      authorization: null,
      availableAt: NOW.toISOString(),
      expiresAt: "2026-07-23T09:00:00.000Z",
    });

    await expect(
      repository.poll({
        tenantId: "tenant_gateway",
        agentId: AGENT_ID,
        environmentId: ENVIRONMENT_ID,
        now: NOW.toISOString(),
      }),
    ).resolves.toMatchObject({ id: "job_gateway", attempt: 0 });

    const first = await repository.lease({
      tenantId: "tenant_gateway",
      jobId: "job_gateway",
      agentId: AGENT_ID,
      environmentId: ENVIRONMENT_ID,
      now: NOW.toISOString(),
    });
    const retry = await repository.lease({
      tenantId: "tenant_gateway",
      jobId: "job_gateway",
      agentId: AGENT_ID,
      environmentId: ENVIRONMENT_ID,
      now: "2026-07-23T08:00:01.000Z",
    });
    expect(first).toMatchObject({ attempt: 1 });
    expect(retry).toMatchObject({
      attempt: 1,
      leaseExpiresAt: first?.leaseExpiresAt,
    });

    const reacquired = await repository.lease({
      tenantId: "tenant_gateway",
      jobId: "job_gateway",
      agentId: AGENT_ID,
      environmentId: ENVIRONMENT_ID,
      now: "2026-07-23T08:01:01.000Z",
    });
    expect(reacquired).toMatchObject({ attempt: 2 });
  });

  it("extends only a live lease and allocates monotonic outbound sequences", async () => {
    const repository = new PostgresJobRepository(database.client);
    await repository.enqueue({
      id: "job_heartbeat",
      tenantId: "tenant_gateway",
      requestId: "req_gateway",
      environmentId: ENVIRONMENT_ID,
      kind: "health_check",
      planVersion: null,
      payloadCiphertext: null,
      authorization: null,
      availableAt: NOW.toISOString(),
      expiresAt: "2026-07-23T09:00:00.000Z",
    });
    await repository.lease({
      tenantId: "tenant_gateway",
      jobId: "job_heartbeat",
      agentId: AGENT_ID,
      environmentId: ENVIRONMENT_ID,
      now: NOW.toISOString(),
    });

    await expect(
      repository.heartbeat({
        tenantId: "tenant_gateway",
        jobId: "job_heartbeat",
        agentId: AGENT_ID,
        environmentId: ENVIRONMENT_ID,
        now: "2026-07-23T08:00:20.000Z",
      }),
    ).resolves.toMatchObject({
      leaseExpiresAt: "2026-07-23T08:01:20.000Z",
    });
    await expect(
      repository.heartbeat({
        tenantId: "tenant_gateway",
        jobId: "job_heartbeat",
        agentId: AGENT_ID,
        environmentId: ENVIRONMENT_ID,
        now: "2026-07-23T08:02:00.000Z",
      }),
    ).resolves.toBeNull();

    await expect(
      repository.nextControlSequence("tenant_gateway", AGENT_ID),
    ).resolves.toBe("1");
    await expect(
      repository.nextControlSequence("tenant_gateway", AGENT_ID),
    ).resolves.toBe("2");
  });
});

function signedAgentMessage(
  sequence: string,
  messageId: string,
  sentAt = NOW.toISOString(),
) {
  return agentSigner.sign({
    type: "forgetops.agent-message",
    protocolVersion: "1.0",
    messageType: "agent.poll",
    messageId,
    keyId: agentSigner.keyId,
    environmentId: ENVIRONMENT_ID,
    agentId: AGENT_ID,
    direction: "agent_to_control",
    sequence,
    sentAt,
    payload: { waitMs: 0 },
  });
}
