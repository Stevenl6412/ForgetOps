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
  for (const migrationName of [
    "0001_initial.sql",
    "0002_environment_subject_canonicalization.sql",
    "0003_agent_pairing_replacement.sql",
    "0004_agent_gateway_rls.sql",
    "0005_subject_identity_binding.sql",
    "0006_audit_and_job_kind_upgrades.sql",
  ]) {
    const migration = await readFile(
      fileURLToPath(new URL(`../migrations/${migrationName}`, import.meta.url)),
      "utf8",
    );
    await connection.client.unsafe(migration);
  }
  return { ...connection, container };
}

export async function stopTestDatabase(
  database: TestDatabase | undefined,
): Promise<void> {
  if (!database) return;
  await database.close();
  await database.container.stop();
}

export async function resetDatabase(sql: Sql): Promise<void> {
  await sql.unsafe(
    "truncate table outbox_events, audit_events, audit_chain_heads, idempotency_records, agent_jobs, subject_identity_aliases, subject_envelopes, agent_transport_sessions, execution_attempts, privacy_requests, agents, agent_pairing_tokens, environments, projects, tenants cascade",
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
