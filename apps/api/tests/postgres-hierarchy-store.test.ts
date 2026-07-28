import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  createDatabase,
  PostgresHierarchyStore,
  type DatabaseConnection,
} from "@forgetops/database";
import { TenantHierarchyUseCases } from "@forgetops/application/tenant-hierarchy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EnvironmentConflictError,
  HierarchyNotFoundError,
  ProjectLimitError,
} from "../src/hierarchy-store.js";

let container: StartedPostgreSqlContainer;
let database: DatabaseConnection;
let runtimeDatabase: DatabaseConnection;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("forgetops_api_test")
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
  await database.client.unsafe(
    "create role forgetops_runtime login password 'forgetops_runtime' in role forgetops_app",
  );
  const runtimeUrl = new URL(container.getConnectionUri());
  runtimeUrl.username = "forgetops_runtime";
  runtimeUrl.password = "forgetops_runtime";
  runtimeDatabase = createDatabase(runtimeUrl.toString());
}, 120_000);

beforeEach(async () => {
  await database.client.unsafe(
    "truncate table outbox_events, audit_events, subject_envelopes, privacy_requests, agents, environments, projects, tenants cascade",
  );
});

afterAll(async () => {
  if (runtimeDatabase) await runtimeDatabase.close();
  if (database) await database.close();
  if (container) await container.stop();
});

describe("PostgresHierarchyStore", () => {
  it("wires PostgreSQL adapters through the API composition root", async () => {
    await seedTenant("tenant_a");
    const { createApiCompositionRoot } =
      await import("../src/composition-root.js");
    const app = createApiCompositionRoot({
      database: runtimeDatabase,
      authProvider: async () => ({
        actorId: "owner_a",
        tenantId: "tenant_a",
        role: "owner",
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant_a",
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  }, 30_000);

  it("sets transaction-local tenant context for an RLS runtime role", async () => {
    await seedTenant("tenant_a");
    const hierarchy = createHierarchy();

    await expect(hierarchy.getTenant("tenant_a")).resolves.toMatchObject({
      id: "tenant_a",
    });
  });

  it("scopes project and environment reads to the tenant", async () => {
    await seedTenant("tenant_a");
    await seedTenant("tenant_b");
    const hierarchy = createHierarchy();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Private",
      slug: "private",
    });
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );

    expect(await hierarchy.getProject("tenant_b", project.id)).toBeNull();
    expect(
      await hierarchy.getEnvironment("tenant_b", environment.id),
    ).toBeNull();
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(environment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("serializes and rejects a sixth project", async () => {
    await seedTenant("tenant_a");
    const hierarchy = createHierarchy();
    for (let index = 0; index < 5; index += 1) {
      await hierarchy.createProject("tenant_a", {
        name: `Project ${index + 1}`,
        slug: `project-${index + 1}`,
      });
    }

    await expect(
      hierarchy.createProject("tenant_a", {
        name: "Project 6",
        slug: "project-6",
      }),
    ).rejects.toBeInstanceOf(ProjectLimitError);
  });

  it("serializes concurrent project creation at the tenant limit", async () => {
    await seedTenant("tenant_a");
    const hierarchy = createHierarchy();
    for (let index = 0; index < 4; index += 1) {
      await hierarchy.createProject("tenant_a", {
        name: `Existing ${index + 1}`,
        slug: `existing-${index + 1}`,
      });
    }

    const attempts = await Promise.allSettled([
      hierarchy.createProject("tenant_a", {
        name: "Concurrent A",
        slug: "concurrent-a",
      }),
      hierarchy.createProject("tenant_a", {
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
    expect(await hierarchy.listProjects("tenant_a")).toHaveLength(5);
  });

  it("enforces project ownership and maps the environment uniqueness constraint", async () => {
    await seedTenant("tenant_a");
    await seedTenant("tenant_b");
    const hierarchy = createHierarchy();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Private",
      slug: "private",
    });
    const otherProject = await hierarchy.createProject("tenant_b", {
      name: "Other",
      slug: "other",
    });

    await expect(
      hierarchy.createEnvironment("tenant_b", project.id, {
        kind: "production",
      }),
    ).rejects.toBeInstanceOf(HierarchyNotFoundError);
    const environment = await hierarchy.createEnvironment(
      "tenant_a",
      project.id,
      {
        kind: "production",
      },
    );
    await expect(
      hierarchy.createEnvironment("tenant_a", project.id, {
        kind: "production",
      }),
    ).rejects.toBeInstanceOf(EnvironmentConflictError);
    await expect(
      runtimeDatabase.client.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', 'tenant_a', true)`;
        await transaction`
          update environments
          set project_id = ${otherProject.id}
          where id = ${environment.id}
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("does not translate an unrelated unique violation", async () => {
    await seedTenant("tenant_a");
    const hierarchy = createHierarchy();
    const project = await hierarchy.createProject("tenant_a", {
      name: "Private",
      slug: "private",
    });
    await database.client.unsafe(`
      create function force_unrelated_unique_violation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'forced unrelated unique violation'
          using errcode = '23505', constraint = 'unrelated_environment_uq';
      end;
      $$;
      create trigger environments_unrelated_unique_violation
      before insert on environments
      for each row execute function force_unrelated_unique_violation();
    `);

    try {
      await expect(
        hierarchy.createEnvironment("tenant_a", project.id, {
          kind: "production",
        }),
      ).rejects.toMatchObject({
        code: "23505",
        constraint_name: "unrelated_environment_uq",
      });
    } finally {
      await database.client.unsafe(`
        drop trigger environments_unrelated_unique_violation on environments;
        drop function force_unrelated_unique_violation();
      `);
    }
  });
});

async function seedTenant(tenantId: string): Promise<void> {
  await database.client`
    insert into tenants (id, name, plan)
    values (${tenantId}, ${tenantId}, 'trial')
  `;
}

function createHierarchy(): TenantHierarchyUseCases {
  return new TenantHierarchyUseCases(
    new PostgresHierarchyStore(runtimeDatabase.client),
  );
}
