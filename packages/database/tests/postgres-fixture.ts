import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Sql } from "postgres";
import { createDatabase, type DatabaseConnection } from "../src/client.js";

export interface TestDatabase extends DatabaseConnection {
  container: StartedPostgreSqlContainer;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("forgetops_test")
    .withUsername("forgetops")
    .withPassword("forgetops")
    .start();
  const connection = createDatabase(container.getConnectionUri());
  const migration = await readFile(
    fileURLToPath(new URL("../migrations/0001_initial.sql", import.meta.url)),
    "utf8",
  );
  await connection.client.unsafe(migration);
  return { ...connection, container };
}

export async function stopTestDatabase(database: TestDatabase): Promise<void> {
  await database.close();
  await database.container.stop();
}

export async function resetDatabase(sql: Sql): Promise<void> {
  await sql.unsafe(
    "truncate table outbox_events, audit_events, privacy_requests, agents, environments, projects, tenants cascade",
  );
}

export async function seedTenantHierarchy(
  sql: Sql,
  suffix: string,
): Promise<{ tenantId: string; projectId: string; environmentId: string }> {
  const tenantId = `tenant_${suffix}`;
  const projectId = `project_${suffix}`;
  const environmentId = `env_${suffix}`;
  await sql`
    insert into tenants (id, name, plan)
    values (${tenantId}, ${`Tenant ${suffix}`}, 'trial')
  `;
  await sql`
    insert into projects (id, tenant_id, name, slug)
    values (${projectId}, ${tenantId}, ${`Project ${suffix}`}, ${`project-${suffix}`})
  `;
  await sql`
    insert into environments (id, project_id, kind, status, subject_hash_key_version)
    values (${environmentId}, ${projectId}, 'production', 'active', 1)
  `;
  return { tenantId, projectId, environmentId };
}

export function deterministicPersistence() {
  let sequence = 0;
  return {
    newEventId: () =>
      `01900000-0000-7000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
  };
}
