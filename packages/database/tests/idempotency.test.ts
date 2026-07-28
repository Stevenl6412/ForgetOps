import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  IdempotencyRepository,
} from "../src/repositories/idempotency-repository.js";
import {
  resetDatabase,
  seedTenantHierarchy,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from "./postgres-fixture.js";

const command = {
  scope: "privacy_requests.create",
  actorId: "usr_1",
  idempotencyKey: "idem_1",
  requestHash: "sha256:request-a",
  expiresAt: "2026-08-21T00:00:00.000Z",
};

describe("generic idempotency records", () => {
  let database: TestDatabase;
  let tenantId: string;
  let repository: IdempotencyRepository;

  beforeAll(async () => {
    database = await startTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await stopTestDatabase(database);
  });

  beforeEach(async () => {
    await resetDatabase(database.client);
    ({ tenantId } = await seedTenantHierarchy(database.client, "idempotency"));
    repository = new IdempotencyRepository(database.client, tenantId);
  });

  it("replays the stored response for the same canonical request", async () => {
    await expect(repository.claim(command)).resolves.toEqual({
      state: "claimed",
    });
    await expect(repository.claim(command)).resolves.toEqual({
      state: "in_progress",
    });

    await repository.complete({
      ...command,
      responseStatus: 201,
      responseBody: { requestId: "req_1" },
    });

    await expect(repository.claim(command)).resolves.toEqual({
      state: "replay",
      responseStatus: 201,
      responseBody: { requestId: "req_1" },
    });
  });

  it("rejects reuse of a key with a different request hash", async () => {
    await repository.claim(command);

    await expect(
      repository.claim({
        ...command,
        requestHash: "sha256:request-b",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("scopes keys by tenant, operation, and actor", async () => {
    await repository.claim(command);

    await expect(
      repository.claim({ ...command, actorId: "usr_2" }),
    ).resolves.toEqual({ state: "claimed" });
    await expect(
      repository.claim({ ...command, scope: "privacy_requests.update" }),
    ).resolves.toEqual({ state: "claimed" });
  });
});
