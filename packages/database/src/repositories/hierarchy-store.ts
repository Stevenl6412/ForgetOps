import { randomUUID } from "node:crypto";
import {
  EnvironmentConflictError,
  HierarchyNotFoundError,
  ProjectLimitError,
  type CreateEnvironmentInput,
  type CreateProjectInput,
  type EnvironmentRecord,
  type HierarchyRepository,
  type ProjectRecord,
  type TenantRecord,
} from "@forgetops/application/tenant-hierarchy";
import type { DatabaseConnection } from "../client.js";
import { inTenantTransaction } from "../unit-of-work.js";

type SqlClient = DatabaseConnection["client"];
type DatabaseTenantRow = Omit<TenantRecord, "createdAt"> & {
  createdAt: Date | string;
};
type DatabaseProjectRow = Omit<ProjectRecord, "createdAt"> & {
  createdAt: Date | string;
};
type DatabaseEnvironmentRow = Omit<EnvironmentRecord, "createdAt"> & {
  createdAt: Date | string;
};

export class PostgresHierarchyStore implements HierarchyRepository {
  constructor(private readonly client: SqlClient) {}

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const rows = await transaction<DatabaseTenantRow[]>`
        select id, name, plan, created_at as "createdAt"
        from tenants
        where id = ${tenantId}
      `;
      return rows[0] ? normalizeCreatedAt(rows[0]) : null;
    });
  }

  async listProjects(tenantId: string): Promise<readonly ProjectRecord[]> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const rows = await transaction<DatabaseProjectRow[]>`
        select id, tenant_id as "tenantId", name, slug, created_at as "createdAt"
        from projects
        where tenant_id = ${tenantId}
        order by created_at, id
      `;
      return rows.map(normalizeCreatedAt);
    });
  }

  async getProject(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const rows = await transaction<DatabaseProjectRow[]>`
        select id, tenant_id as "tenantId", name, slug, created_at as "createdAt"
        from projects
        where id = ${projectId} and tenant_id = ${tenantId}
      `;
      return rows[0] ? normalizeCreatedAt(rows[0]) : null;
    });
  }

  async createProjectWithinLimit(
    tenantId: string,
    input: CreateProjectInput,
    maxProjects: number,
  ): Promise<ProjectRecord> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const tenantRows = await transaction<{ id: string }[]>`
        select id from tenants where id = ${tenantId} for update
      `;
      if (!tenantRows[0]) {
        throw new HierarchyNotFoundError("Tenant not found");
      }
      const countRows = await transaction<{ count: string }[]>`
        select count(*)::text as count from projects where tenant_id = ${tenantId}
      `;
      if (Number(countRows[0]?.count ?? 0) >= maxProjects) {
        throw new ProjectLimitError(
          "The tenant project limit has been reached",
        );
      }
      const projectId = `prj_${randomUUID()}`;
      const rows = await transaction<DatabaseProjectRow[]>`
        insert into projects (id, tenant_id, name, slug)
        values (${projectId}, ${tenantId}, ${input.name}, ${input.slug})
        returning id, tenant_id as "tenantId", name, slug, created_at as "createdAt"
      `;
      return normalizeCreatedAt(rows[0]);
    });
  }

  async listEnvironments(
    tenantId: string,
    projectId: string,
  ): Promise<readonly EnvironmentRecord[]> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const rows = await transaction<DatabaseEnvironmentRow[]>`
        select e.id, e.project_id as "projectId", e.kind, e.status,
               e.subject_hash_key_version as "subjectHashKeyVersion",
               e.subject_canonicalization_version as "subjectCanonicalizationVersion",
               e.created_at as "createdAt"
        from environments e
        inner join projects p on p.id = e.project_id
        where e.project_id = ${projectId} and p.tenant_id = ${tenantId}
        order by e.created_at, e.id
      `;
      return rows.map(normalizeCreatedAt);
    });
  }

  async getEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | null> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const rows = await transaction<DatabaseEnvironmentRow[]>`
        select e.id, e.project_id as "projectId", e.kind, e.status,
               e.subject_hash_key_version as "subjectHashKeyVersion",
               e.subject_canonicalization_version as "subjectCanonicalizationVersion",
               e.created_at as "createdAt"
        from environments e
        inner join projects p on p.id = e.project_id
        where e.id = ${environmentId} and p.tenant_id = ${tenantId}
      `;
      return rows[0] ? normalizeCreatedAt(rows[0]) : null;
    });
  }

  async createEnvironment(
    tenantId: string,
    projectId: string,
    input: CreateEnvironmentInput,
  ): Promise<EnvironmentRecord> {
    try {
      return await inTenantTransaction(
        this.client,
        tenantId,
        async (transaction) => {
          const projectRows = await transaction<{ id: string }[]>`
            select p.id
            from projects p
            where p.id = ${projectId} and p.tenant_id = ${tenantId}
          `;
          if (!projectRows[0]) {
            throw new HierarchyNotFoundError("Project not found");
          }
          const environmentId = `env_${randomUUID()}`;
          const rows = await transaction<DatabaseEnvironmentRow[]>`
            insert into environments (
              id, project_id, kind, status, subject_hash_key_version,
              subject_canonicalization_version
            ) values (
              ${environmentId}, ${projectId}, ${input.kind}, 'active', 1, 1
            )
            returning id, project_id as "projectId", kind, status,
                      subject_hash_key_version as "subjectHashKeyVersion",
                      subject_canonicalization_version as "subjectCanonicalizationVersion",
                      created_at as "createdAt"
          `;
          return normalizeCreatedAt(rows[0]);
        },
      );
    } catch (error) {
      if (isEnvironmentKindConflict(error)) {
        throw new EnvironmentConflictError(
          "This project already has that environment kind",
        );
      }
      throw error;
    }
  }
}

function isEnvironmentKindConflict(
  error: unknown,
): error is { code: string; constraint_name: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint_name" in error &&
    error.constraint_name === "environments_project_kind_uq"
  );
}

function normalizeCreatedAt<T extends { createdAt: Date | string }>(
  record: T,
): Omit<T, "createdAt"> & { createdAt: string } {
  const createdAt =
    record.createdAt instanceof Date
      ? record.createdAt
      : new Date(record.createdAt);
  return {
    ...record,
    createdAt: createdAt.toISOString(),
  };
}
