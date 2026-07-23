import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "@forgetops/database";

export type TenantPlan = "trial" | "starter" | "team";
export type EnvironmentKind = "staging" | "production";
export type EnvironmentStatus = "active" | "disabled";

export interface TenantRecord {
  id: string;
  name: string;
  plan: TenantPlan;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface EnvironmentRecord {
  id: string;
  projectId: string;
  kind: EnvironmentKind;
  status: EnvironmentStatus;
  subjectHashKeyVersion: number;
  createdAt: string;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
}

export interface CreateEnvironmentInput {
  kind: EnvironmentKind;
}

export class HierarchyNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
}

export class ProjectLimitError extends Error {
  readonly code = "PROJECT_LIMIT_REACHED" as const;
}

export class EnvironmentConflictError extends Error {
  readonly code = "ENVIRONMENT_ALREADY_EXISTS" as const;
}

export interface HierarchyStore {
  getTenant(tenantId: string): Promise<TenantRecord | null>;
  listProjects(tenantId: string): Promise<readonly ProjectRecord[]>;
  getProject(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectRecord | null>;
  createProject(
    tenantId: string,
    input: CreateProjectInput,
  ): Promise<ProjectRecord>;
  listEnvironments(
    tenantId: string,
    projectId: string,
  ): Promise<readonly EnvironmentRecord[]>;
  getEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | null>;
  createEnvironment(
    tenantId: string,
    projectId: string,
    input: CreateEnvironmentInput,
  ): Promise<EnvironmentRecord>;
}

export class InMemoryHierarchyStore implements HierarchyStore {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly environments = new Map<string, EnvironmentRecord>();

  constructor(
    seed: { tenants?: readonly Omit<TenantRecord, "createdAt">[] } = {},
  ) {
    for (const tenant of seed.tenants ?? []) {
      this.tenants.set(tenant.id, {
        ...tenant,
        createdAt: new Date(0).toISOString(),
      });
    }
  }

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async listProjects(tenantId: string): Promise<readonly ProjectRecord[]> {
    return [...this.projects.values()].filter(
      (project) => project.tenantId === tenantId,
    );
  }

  async getProject(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project?.tenantId === tenantId ? project : null;
  }

  async createProject(
    tenantId: string,
    input: CreateProjectInput,
  ): Promise<ProjectRecord> {
    if (!this.tenants.has(tenantId)) {
      throw new HierarchyNotFoundError("Tenant not found");
    }
    if ((await this.listProjects(tenantId)).length >= 5) {
      throw new ProjectLimitError(
        "A tenant cannot have more than five projects",
      );
    }
    const project: ProjectRecord = {
      id: `prj_${randomUUID()}`,
      tenantId,
      name: input.name,
      slug: input.slug,
      createdAt: new Date().toISOString(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  async listEnvironments(
    tenantId: string,
    projectId: string,
  ): Promise<readonly EnvironmentRecord[]> {
    if (!(await this.getProject(tenantId, projectId))) {
      return [];
    }
    return [...this.environments.values()].filter(
      (environment) => environment.projectId === projectId,
    );
  }

  async getEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | null> {
    const environment = this.environments.get(environmentId);
    if (
      !environment ||
      !(await this.getProject(tenantId, environment.projectId))
    ) {
      return null;
    }
    return environment;
  }

  async createEnvironment(
    tenantId: string,
    projectId: string,
    input: CreateEnvironmentInput,
  ): Promise<EnvironmentRecord> {
    if (!(await this.getProject(tenantId, projectId))) {
      throw new HierarchyNotFoundError("Project not found");
    }
    const duplicate = [...this.environments.values()].some(
      (environment) =>
        environment.projectId === projectId && environment.kind === input.kind,
    );
    if (duplicate) {
      throw new EnvironmentConflictError(
        "This project already has that environment kind",
      );
    }
    const environment: EnvironmentRecord = {
      id: `env_${randomUUID()}`,
      projectId,
      kind: input.kind,
      status: "active",
      subjectHashKeyVersion: 1,
      createdAt: new Date().toISOString(),
    };
    this.environments.set(environment.id, environment);
    return environment;
  }
}

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

export class PostgresHierarchyStore implements HierarchyStore {
  constructor(private readonly client: SqlClient) {}

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    const rows = await this.client<DatabaseTenantRow[]>`
      select id, name, plan, created_at as "createdAt"
      from tenants
      where id = ${tenantId}
    `;
    return rows[0] ? normalizeCreatedAt(rows[0]) : null;
  }

  async listProjects(tenantId: string): Promise<readonly ProjectRecord[]> {
    const rows = await this.client<DatabaseProjectRow[]>`
      select id, tenant_id as "tenantId", name, slug, created_at as "createdAt"
      from projects
      where tenant_id = ${tenantId}
      order by created_at, id
    `;
    return rows.map(normalizeCreatedAt);
  }

  async getProject(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const rows = await this.client<DatabaseProjectRow[]>`
      select id, tenant_id as "tenantId", name, slug, created_at as "createdAt"
      from projects
      where id = ${projectId} and tenant_id = ${tenantId}
    `;
    return rows[0] ? normalizeCreatedAt(rows[0]) : null;
  }

  async createProject(
    tenantId: string,
    input: CreateProjectInput,
  ): Promise<ProjectRecord> {
    return this.client.begin(async (transaction) => {
      const tenantRows = await transaction<{ id: string }[]>`
        select id from tenants where id = ${tenantId} for update
      `;
      if (!tenantRows[0]) {
        throw new HierarchyNotFoundError("Tenant not found");
      }
      const countRows = await transaction<{ count: string }[]>`
        select count(*)::text as count from projects where tenant_id = ${tenantId}
      `;
      if (Number(countRows[0]?.count ?? 0) >= 5) {
        throw new ProjectLimitError(
          "A tenant cannot have more than five projects",
        );
      }
      const projectId = `prj_${randomUUID()}`;
      const rows = await transaction<DatabaseProjectRow[]>`
        insert into projects (id, tenant_id, name, slug)
        values (${projectId}, ${tenantId}, ${input.name}, ${input.slug})
        returning id, tenant_id as "tenantId", name, slug, created_at as "createdAt"
      `;
      return normalizeCreatedAt(rows[0]);
    }) as Promise<ProjectRecord>;
  }

  async listEnvironments(
    tenantId: string,
    projectId: string,
  ): Promise<readonly EnvironmentRecord[]> {
    const rows = await this.client<DatabaseEnvironmentRow[]>`
      select e.id, e.project_id as "projectId", e.kind, e.status,
             e.subject_hash_key_version as "subjectHashKeyVersion",
             e.created_at as "createdAt"
      from environments e
      inner join projects p on p.id = e.project_id
      where e.project_id = ${projectId} and p.tenant_id = ${tenantId}
      order by e.created_at, e.id
    `;
    return rows.map(normalizeCreatedAt);
  }

  async getEnvironment(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRecord | null> {
    const rows = await this.client<DatabaseEnvironmentRow[]>`
      select e.id, e.project_id as "projectId", e.kind, e.status,
             e.subject_hash_key_version as "subjectHashKeyVersion",
             e.created_at as "createdAt"
      from environments e
      inner join projects p on p.id = e.project_id
      where e.id = ${environmentId} and p.tenant_id = ${tenantId}
    `;
    return rows[0] ? normalizeCreatedAt(rows[0]) : null;
  }

  async createEnvironment(
    tenantId: string,
    projectId: string,
    input: CreateEnvironmentInput,
  ): Promise<EnvironmentRecord> {
    const projectRows = await this.client<{ id: string }[]>`
      select p.id from projects p where p.id = ${projectId} and p.tenant_id = ${tenantId}
    `;
    if (!projectRows[0]) {
      throw new HierarchyNotFoundError("Project not found");
    }
    const environmentId = `env_${randomUUID()}`;
    try {
      const rows = await this.client<DatabaseEnvironmentRow[]>`
        insert into environments (id, project_id, kind, status, subject_hash_key_version)
        values (${environmentId}, ${projectId}, ${input.kind}, 'active', 1)
        returning id, project_id as "projectId", kind, status,
                  subject_hash_key_version as "subjectHashKeyVersion",
                  created_at as "createdAt"
      `;
      return normalizeCreatedAt(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EnvironmentConflictError(
          "This project already has that environment kind",
        );
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
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
