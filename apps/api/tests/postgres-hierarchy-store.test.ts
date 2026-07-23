import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDatabase, type DatabaseConnection } from "@forgetops/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EnvironmentConflictError,
  HierarchyNotFoundError,
  PostgresHierarchyStore,
  ProjectLimitError,
} from "../src/hierarchy-store.js";

let container: StartedPostgreSqlContainer;
let database: DatabaseConnection;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("forgetops_api_test")
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
}, 60_000);

beforeEach(async () => {
  await database.client.unsafe(
    "truncate table outbox_events, audit_events, privacy_requests, agents, environments, projects, tenants cascade",
  );
});

afterAll(async () => {
  await database.close();
  await container.stop();
});

describe("PostgresHierarchyStore", () => {
  it("scopes project and environment reads to the tenant", async () => {
    await seedTenant("tenant_a");
    await seedTenant("tenant_b");
    const store = new PostgresHierarchyStore(database.client);
    const project = await store.createProject("tenant_a", {
      name: "Private",
      slug: "private",
    });
    const environment = await store.createEnvironment("tenant_a", project.id, {
      kind: "production",
    });

    expect(await store.getProject("tenant_b", project.id)).toBeNull();
    expect(await store.getEnvironment("tenant_b", environment.id)).toBeNull();
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(environment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("serializes and rejects a sixth project", async () => {
    await seedTenant("tenant_a");
    const store = new PostgresHierarchyStore(database.client);
    for (let index = 0; index < 5; index += 1) {
      await store.createProject("tenant_a", {
        name: `Project ${index + 1}`,
        slug: `project-${index + 1}`,
      });
    }

    await expect(
      store.createProject("tenant_a", { name: "Project 6", slug: "project-6" }),
    ).rejects.toBeInstanceOf(ProjectLimitError);
  });

  it("serializes concurrent project creation at the tenant limit", async () => {
    await seedTenant("tenant_a");
    const store = new PostgresHierarchyStore(database.client);
    for (let index = 0; index < 4; index += 1) {
      await store.createProject("tenant_a", {
        name: `Existing ${index + 1}`,
        slug: `existing-${index + 1}`,
      });
    }

    const attempts = await Promise.allSettled([
      store.createProject("tenant_a", {
        name: "Concurrent A",
        slug: "concurrent-a",
      }),
      store.createProject("tenant_a", {
        name: "Concurrent B",
        slug: "concurrent-b",
      }),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(
      attempts.find((attempt) => attempt.status === "rejected")?.reason,
    ).toBeInstanceOf(ProjectLimitError);
    expect(await store.listProjects("tenant_a")).toHaveLength(5);
  });

  it("enforces project ownership and maps the environment uniqueness constraint", async () => {
    await seedTenant("tenant_a");
    await seedTenant("tenant_b");
    const store = new PostgresHierarchyStore(database.client);
    const project = await store.createProject("tenant_a", {
      name: "Private",
      slug: "private",
    });

    await expect(
      store.createEnvironment("tenant_b", project.id, { kind: "production" }),
    ).rejects.toBeInstanceOf(HierarchyNotFoundError);
    await store.createEnvironment("tenant_a", project.id, {
      kind: "production",
    });
    await expect(
      store.createEnvironment("tenant_a", project.id, { kind: "production" }),
    ).rejects.toBeInstanceOf(EnvironmentConflictError);
  });
});

async function seedTenant(tenantId: string): Promise<void> {
  await database.client`
    insert into tenants (id, name, plan)
    values (${tenantId}, ${tenantId}, 'trial')
  `;
}
