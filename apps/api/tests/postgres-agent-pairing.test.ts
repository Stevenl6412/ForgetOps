import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDatabase, type DatabaseConnection } from "@forgetops/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AgentReplacementRequiresOwnerConfirmationError,
  PostgresPairingRepository,
  PairingService,
  keyIdForPublicKey,
  type AgentRegistration,
} from "../src/modules/agents/pairing-service.js";
import { createPairingProofPayload } from "../src/modules/agents/signature-verifier.js";

let container: StartedPostgreSqlContainer;
let database: DatabaseConnection;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("forgetops_agent_test")
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
    "truncate table agent_pairing_tokens, subject_envelopes, agent_jobs, outbox_events, audit_events, privacy_requests, agents, environments, projects, tenants cascade",
  );
  await database.client`
    insert into tenants (id, name, plan) values ('tenant_a', 'Tenant A', 'trial')
  `;
  await database.client`
    insert into projects (id, tenant_id, name, slug)
    values ('project_a', 'tenant_a', 'Project A', 'project-a')
  `;
  await database.client`
    insert into environments (id, project_id, kind, status, subject_hash_key_version)
    values ('env_a', 'project_a', 'production', 'active', 1)
  `;
});

afterAll(async () => {
  if (database) await database.close();
  if (container) await container.stop();
});

describe("PostgresPairingRepository", () => {
  it("stores only the token hash and atomically consumes it with the agent", async () => {
    const pairing = new PairingService(
      new PostgresPairingRepository(database.client),
    );
    const issued = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
    });
    const tokenRows = await database.client`
      select token_hash, consumed_at from agent_pairing_tokens
    `;
    expect(tokenRows[0]?.token_hash).not.toBe(issued.plaintext);
    expect(tokenRows[0]?.consumed_at).toBeNull();

    const registration = validRegistration(issued.plaintext, "env_a");
    const agent = await pairing.consume(issued.plaintext, registration);
    const rows = await database.client`
      select a.status, t.consumed_at
      from agents a cross join agent_pairing_tokens t
      where a.id = ${agent.id}
    `;
    expect(rows[0]?.status).toBe("pairing");
    expect(rows[0]?.consumed_at).not.toBeNull();
  });

  it("hides agents across tenants and makes revoke idempotent", async () => {
    const pairing = new PairingService(
      new PostgresPairingRepository(database.client),
    );
    const issued = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
    });
    const agent = await pairing.consume(
      issued.plaintext,
      validRegistration(issued.plaintext, "env_a"),
    );

    expect(await pairing.getAgent("tenant_b", agent.id)).toBeNull();
    await expect(
      pairing.revoke({ tenantId: "tenant_b", agentId: agent.id }),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    await pairing.revoke({ tenantId: "tenant_a", agentId: agent.id });
    await pairing.revoke({ tenantId: "tenant_a", agentId: agent.id });
    expect(await pairing.getAgent("tenant_a", agent.id)).toMatchObject({
      status: "revoked",
    });
  });

  it("requires owner-approved replacement and revokes the previous agent atomically", async () => {
    const pairing = new PairingService(
      new PostgresPairingRepository(database.client),
    );
    const firstToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
    });
    const first = await pairing.consume(
      firstToken.plaintext,
      validRegistration(firstToken.plaintext, "env_a"),
    );

    const deniedToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
    });
    await expect(
      pairing.consume(
        deniedToken.plaintext,
        validRegistration(deniedToken.plaintext, "env_a"),
      ),
    ).rejects.toBeInstanceOf(AgentReplacementRequiresOwnerConfirmationError);

    const approvedToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
      allowReplacement: true,
    });
    const replacement = await pairing.consume(
      approvedToken.plaintext,
      validRegistration(approvedToken.plaintext, "env_a"),
    );
    const rows = await database.client`
      select id, status from agents where environment_id = 'env_a' order by id
    `;

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "revoked" }),
        expect.objectContaining({ id: replacement.id, status: "pairing" }),
      ]),
    );
    expect(rows.filter((row) => row.status !== "revoked")).toHaveLength(1);
  });

  it("drains safely and force-replaces by destroying old ciphertext", async () => {
    const pairing = new PairingService(
      new PostgresPairingRepository(database.client),
    );
    const firstToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
    });
    const first = await pairing.consume(
      firstToken.plaintext,
      validRegistration(firstToken.plaintext, "env_a"),
    );
    await database.client`
      insert into privacy_requests (
        id, tenant_id, environment_id, type, source, status,
        policy_version, deadline_at, created_by_actor_id, version
      ) values (
        'req_replace', 'tenant_a', 'env_a', 'delete', 'admin',
        'executing', 1, now() + interval '1 day', 'owner_a', 1
      )
    `;
    await database.client`
      insert into execution_attempts (
        id, tenant_id, environment_id, request_id, attempt_number, kind,
        plan_id, plan_version, plan_fingerprint, allowed_step_ids,
        status, created_at
      ) values (
        'attempt_replace', 'tenant_a', 'env_a', 'req_replace', 1, 'initial',
        'plan_1', 1, 'sha256:plan', '["step_1"]',
        'running', now() - interval '1 minute'
      )
    `;
    await database.client`
      insert into subject_envelopes (
        request_id, tenant_id, environment_id, ciphertext,
        encryption_key_id, expires_at
      ) values (
        'req_replace', 'tenant_a', 'env_a', 'old-ciphertext',
        ${first.encryptionKeyId}, now() + interval '1 hour'
      )
    `;
    await database.client`
      insert into agent_jobs (
        id, tenant_id, request_id, environment_id, kind,
        payload_ciphertext, available_at, expires_at
      ) values (
        'job_replace', 'tenant_a', 'req_replace', 'env_a', 'bind_subject',
        'old-ciphertext', now() - interval '1 minute', now() + interval '1 hour'
      )
    `;

    const drainToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
      replacementMode: "drain",
    });
    await expect(
      pairing.consume(
        drainToken.plaintext,
        validRegistration(drainToken.plaintext, "env_a"),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_REPLACEMENT_BLOCKED_ACTIVE_WORK",
    });

    const forceToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: "env_a",
      actorId: "owner_a",
      replacementMode: "force",
    });
    const replacement = await pairing.consume(
      forceToken.plaintext,
      validRegistration(forceToken.plaintext, "env_a"),
    );
    expect(replacement.id).not.toBe(first.id);
    const rows = await database.client`
      select
        (select status from agents where id = ${first.id}) as old_status,
        (select status from privacy_requests where id = 'req_replace') as request_status,
        (select status from execution_attempts where id = 'attempt_replace') as attempt_status,
        (select count(*)::int from subject_envelopes where request_id = 'req_replace') as envelope_count,
        (select payload_ciphertext from agent_jobs where id = 'job_replace') as payload_ciphertext
    `;
    expect(rows[0]).toMatchObject({
      old_status: "revoked",
      request_status: "needs_review",
      attempt_status: "needs_review",
      envelope_count: 0,
      payload_ciphertext: null,
    });
  });
});

function validRegistration(
  token: string,
  environmentId: string,
): AgentRegistration {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const fields = {
    pairingToken: token,
    environmentId,
    publicSigningKey: signing.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url"),
    publicEncryptionKey: encryption.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url"),
    signingKeyId: "",
    encryptionKeyId: "",
    subjectHmacKeyVersion: 1,
    version: "1.0.0",
    protocolVersion: "1.0",
    instanceFingerprint: "sha256:instance-a",
  };
  fields.signingKeyId = keyIdForPublicKey("ed25519", fields.publicSigningKey);
  fields.encryptionKeyId = keyIdForPublicKey(
    "x25519",
    fields.publicEncryptionKey,
  );
  return {
    ...fields,
    proof: sign(
      null,
      Buffer.from(createPairingProofPayload(fields)),
      signing.privateKey,
    ).toString("base64url"),
  };
}
