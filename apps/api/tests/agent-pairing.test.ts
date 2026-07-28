import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  InMemoryHierarchyStore,
  type AuthContextProvider,
} from "../src/index.js";
import {
  AgentAlreadyActiveError,
  AgentReplacementBlockedActiveWorkError,
  AgentReplacementRequiresOwnerConfirmationError,
  InMemoryPairingRepository,
  InvalidAgentKeyError,
  PairingService,
  PairingTokenInvalidError,
  createPairingProofPayload,
  keyIdForPublicKey,
  type AgentRegistration,
} from "../src/modules/agents/pairing-service.js";

const tenantA = { id: "tenant_a", name: "Tenant A", plan: "trial" as const };
const tenantB = { id: "tenant_b", name: "Tenant B", plan: "trial" as const };

function keys() {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const signingDer = signing.publicKey.export({ type: "spki", format: "der" });
  const encryptionDer = encryption.publicKey.export({
    type: "spki",
    format: "der",
  });
  return {
    signing,
    publicSigningKey: signingDer.subarray(-32).toString("base64url"),
    publicEncryptionKey: encryptionDer.subarray(-32).toString("base64url"),
  };
}

function registration(
  token: string,
  environmentId: string,
  generated = keys(),
): AgentRegistration & { generated: ReturnType<typeof keys> } {
  const unsigned = {
    pairingToken: token,
    environmentId,
    publicSigningKey: generated.publicSigningKey,
    publicEncryptionKey: generated.publicEncryptionKey,
    signingKeyId: keyIdForPublicKey("ed25519", generated.publicSigningKey),
    encryptionKeyId: keyIdForPublicKey("x25519", generated.publicEncryptionKey),
    subjectHmacKeyVersion: 1,
    version: "1.0.0",
    protocolVersion: "1.0",
    instanceFingerprint: "sha256:instance-a",
  };
  const payload = createPairingProofPayload(unsigned);
  return {
    ...unsigned,
    proof: sign(
      null,
      Buffer.from(payload),
      generated.signing.privateKey,
    ).toString("base64url"),
    generated,
  };
}

function fixture() {
  const hierarchy = new InMemoryHierarchyStore({
    tenants: [tenantA, tenantB],
  });
  return hierarchy;
}

describe("agent pairing", () => {
  it("accepts a pairing token once and rejects reuse", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const issued = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    const first = await pairing.consume(
      issued.plaintext,
      registration(issued.plaintext, environment.id),
    );

    expect(first.status).toBe("pairing");
    await expect(
      pairing.consume(
        issued.plaintext,
        registration(issued.plaintext, environment.id),
      ),
    ).rejects.toBeInstanceOf(PairingTokenInvalidError);
  });

  it("rejects expired tokens without consuming them", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    let now = new Date("2026-07-23T00:00:00.000Z");
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
      {
        now: () => now,
      },
    );
    const issued = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    now = new Date("2026-07-23T00:16:00.000Z");

    await expect(
      pairing.consume(
        issued.plaintext,
        registration(issued.plaintext, environment.id),
      ),
    ).rejects.toBeInstanceOf(PairingTokenInvalidError);
  });

  it("verifies proof before binding keys", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const issued = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    const invalid = registration(issued.plaintext, environment.id);
    invalid.instanceFingerprint = "sha256:tampered";

    await expect(
      pairing.consume(issued.plaintext, invalid),
    ).rejects.toBeInstanceOf(InvalidAgentKeyError);
    const valid = registration(issued.plaintext, environment.id);
    await expect(
      pairing.consume(issued.plaintext, valid),
    ).resolves.toMatchObject({
      publicSigningKey: valid.publicSigningKey,
    });
  });

  it("requires owner-approved replacement and revokes the old agent atomically", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const firstToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    const first = await pairing.consume(
      firstToken.plaintext,
      registration(firstToken.plaintext, environment.id),
    );
    const deniedToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    await expect(
      pairing.consume(
        deniedToken.plaintext,
        registration(deniedToken.plaintext, environment.id),
      ),
    ).rejects.toBeInstanceOf(AgentReplacementRequiresOwnerConfirmationError);

    const approvedToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
      allowReplacement: true,
    });
    const replacement = await pairing.consume(
      approvedToken.plaintext,
      registration(approvedToken.plaintext, environment.id),
    );
    expect(replacement.id).not.toBe(first.id);
    expect(await pairing.getAgent("tenant_a", first.id)).toMatchObject({
      status: "revoked",
    });
  });

  it("blocks drain replacement while active work exists and force replacement reviews it", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      { kind: "production" },
    );
    const repository = new InMemoryPairingRepository(hierarchy);
    const pairing = new PairingService(repository);
    const firstToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    const first = await pairing.consume(
      firstToken.plaintext,
      registration(firstToken.plaintext, environment.id),
    );
    repository.markSubjectEnvelopeActive(environment.id, "req_1");
    repository.markAttemptRunning(environment.id, "req_2");
    repository.addPendingCiphertext(first.id, "job_1", "old-ciphertext");

    const drainToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
      replacementMode: "drain",
    });
    await expect(
      pairing.consume(
        drainToken.plaintext,
        registration(drainToken.plaintext, environment.id),
      ),
    ).rejects.toBeInstanceOf(AgentReplacementBlockedActiveWorkError);
    expect(await pairing.getAgent("tenant_a", first.id)).toMatchObject({
      status: "pairing",
    });

    const forceToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
      replacementMode: "force",
    });
    const replacement = await pairing.consume(
      forceToken.plaintext,
      registration(forceToken.plaintext, environment.id),
    );
    expect(replacement.id).not.toBe(first.id);
    expect(await pairing.getAgent("tenant_a", first.id)).toMatchObject({
      status: "revoked",
    });
    expect(repository.requestStatus("req_1")).toBe("needs_review");
    expect(repository.requestStatus("req_2")).toBe("needs_review");
    expect(repository.pendingCiphertext("job_1")).toBeNull();
  });

  it("rejects a key ID that does not hash to the submitted public key", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      { kind: "production" },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const issued = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    const invalid = registration(issued.plaintext, environment.id);
    invalid.signingKeyId = "ed25519:sha256:tampered";
    await expect(
      pairing.consume(issued.plaintext, invalid),
    ).rejects.toBeInstanceOf(InvalidAgentKeyError);
  });

  it("returns stable already-active error for the same active identity", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const firstToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    const firstRegistration = registration(
      firstToken.plaintext,
      environment.id,
    );
    await pairing.consume(firstToken.plaintext, firstRegistration);
    const secondToken = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
      allowReplacement: true,
    });
    await expect(
      pairing.consume(secondToken.plaintext, {
        ...registration(
          secondToken.plaintext,
          environment.id,
          firstRegistration.generated,
        ),
      }),
    ).rejects.toBeInstanceOf(AgentAlreadyActiveError);
  });

  it("keeps revoke tenant-scoped and idempotent", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const issued = await pairing.createToken({
      tenantId: "tenant_a",
      environmentId: environment.id,
      actorId: "owner_a",
    });
    const agent = await pairing.consume(
      issued.plaintext,
      registration(issued.plaintext, environment.id),
    );

    await expect(
      pairing.revoke({ tenantId: "tenant_b", agentId: agent.id }),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    await expect(
      pairing.revoke({ tenantId: "tenant_a", agentId: agent.id }),
    ).resolves.toBeUndefined();
    await expect(
      pairing.revoke({ tenantId: "tenant_a", agentId: agent.id }),
    ).resolves.toBeUndefined();
  });

  it("does not let arbitrary headers authenticate owner routes", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const app = buildApp({
      authProvider: async () => null,
      store: hierarchy,
      pairingService: pairing,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/environments/${environment.id}/agent-pairing-tokens`,
      headers: { "x-role": "owner", "x-tenant-id": "tenant_a" },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("keeps token issuance and revocation owner-only while the token pairs the agent", async () => {
    const hierarchy = fixture();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Project",
      slug: "project",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    const pairing = new PairingService(
      new InMemoryPairingRepository(hierarchy),
    );
    const ownerProvider: AuthContextProvider = async () => ({
      actorId: "owner_a",
      tenantId: "tenant_a",
      role: "owner",
    });
    const ownerApp = buildApp({
      authProvider: ownerProvider,
      store: hierarchy,
      pairingService: pairing,
    });

    const tokenResponse = await ownerApp.inject({
      method: "POST",
      url: `/v1/environments/${environment.id}/agent-pairing-tokens`,
      payload: {},
    });
    expect(tokenResponse.statusCode).toBe(201);
    const pairingToken = tokenResponse.json().pairingToken as string;
    const { generated: _generated, ...pairingBody } = registration(
      pairingToken,
      environment.id,
    );
    const pairResponse = await ownerApp.inject({
      method: "POST",
      url: "/v1/agents/pair",
      payload: pairingBody,
    });
    expect(pairResponse.statusCode).toBe(201);
    const agentId = pairResponse.json().agent.id as string;

    const revokeResponse = await ownerApp.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/revoke`,
    });
    expect(revokeResponse.statusCode).toBe(204);
    await expect(pairing.getAgent("tenant_a", agentId)).resolves.toMatchObject({
      status: "revoked",
    });

    const adminApp = buildApp({
      authProvider: async () => ({
        actorId: "admin_a",
        tenantId: "tenant_a",
        role: "admin",
      }),
      store: hierarchy,
      pairingService: pairing,
    });
    const denied = await adminApp.inject({
      method: "POST",
      url: `/v1/environments/${environment.id}/agent-pairing-tokens`,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});
