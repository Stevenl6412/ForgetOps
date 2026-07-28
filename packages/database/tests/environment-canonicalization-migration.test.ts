import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseConnection } from "../src/client.js";

let container: StartedPostgreSqlContainer;
let database: DatabaseConnection;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("forgetops_migration_test")
    .withUsername("forgetops")
    .withPassword("forgetops")
    .start();
  database = createDatabase(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  if (database) await database.close();
  if (container) await container.stop();
});

describe("0002 environment canonicalization migration", () => {
  it("backfills the earlier environment schema and enforces a positive not-null version", async () => {
    await database.client.unsafe(`
      create table environments (
        id text primary key,
        project_id text not null,
        kind text not null,
        status text not null,
        subject_hash_key_version integer not null,
        created_at timestamptz not null default now()
      );
      insert into environments (
        id, project_id, kind, status, subject_hash_key_version
      ) values ('env_existing', 'project_a', 'production', 'active', 1);
    `);

    const migration = await readMigrationOrEmpty();
    if (migration) await database.client.unsafe(migration);

    const columns = await database.client<
      { isNullable: string; columnDefault: string | null }[]
    >`
      select is_nullable as "isNullable", column_default as "columnDefault"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'environments'
        and column_name = 'subject_canonicalization_version'
    `;
    expect(columns[0]).toMatchObject({
      isNullable: "NO",
      columnDefault: "1",
    });
    await expect(
      database.client`
        select subject_canonicalization_version as version
        from environments
        where id = 'env_existing'
      `,
    ).resolves.toMatchObject([{ version: 1 }]);
    await expect(
      database.client`
        update environments
        set subject_canonicalization_version = 0
        where id = 'env_existing'
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.client`
        update environments
        set subject_canonicalization_version = null
        where id = 'env_existing'
      `,
    ).rejects.toMatchObject({ code: "23502" });
  });
});

async function readMigrationOrEmpty(): Promise<string> {
  try {
    return await readFile(
      fileURLToPath(
        new URL(
          "../migrations/0002_environment_subject_canonicalization.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}
