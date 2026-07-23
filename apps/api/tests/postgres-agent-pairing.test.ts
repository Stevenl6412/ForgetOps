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
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../../../packages/database/migrations/0001_initial.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  await database.client.unsafe(migration);
}, 120_000);

beforeEach(async () => {
  await database.client.unsafe(
    "truncate table agent_pairing_tokens, outbox_events, audit_events, privacy_requests, agents, environments, projects, tenants cascade",
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
    version: "1.0.0",
    protocolVersion: "1.0",
    instanceFingerprint: "sha256:instance-a",
  };
  return {
    ...fields,
    proof: sign(
      null,
      Buffer.from(createPairingProofPayload(fields)),
      signing.privateKey,
    ).toString("base64url"),
  };
}
