import { randomUUID } from "node:crypto";
import {
  EnvironmentConflictError,
  HierarchyNotFoundError,
  MAX_PROJECTS_PER_TENANT,
  ProjectLimitError,
  type CreateEnvironmentInput,
  type CreateProjectInput,
  type EnvironmentKind,
  type EnvironmentRecord,
  type EnvironmentStatus,
  type HierarchyStore,
  type ProjectRecord,
  type TenantPlan,
  type TenantRecord,
} from "@forgetops/application/tenant-hierarchy";

export { EnvironmentConflictError, HierarchyNotFoundError, ProjectLimitError };
export type {
  CreateEnvironmentInput,
  CreateProjectInput,
  EnvironmentKind,
  EnvironmentRecord,
  EnvironmentStatus,
  HierarchyStore,
  ProjectRecord,
  TenantPlan,
  TenantRecord,
};

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

  async createProjectWithinLimit(
    tenantId: string,
    input: CreateProjectInput,
    maxProjects: number,
  ): Promise<ProjectRecord> {
    if (!this.tenants.has(tenantId)) {
      throw new HierarchyNotFoundError("Tenant not found");
    }
    if ((await this.listProjects(tenantId)).length >= maxProjects) {
      throw new ProjectLimitError("The tenant project limit has been reached");
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

  async createProject(
    tenantId: string,
    input: CreateProjectInput,
  ): Promise<ProjectRecord> {
    return this.createProjectWithinLimit(
      tenantId,
      input,
      MAX_PROJECTS_PER_TENANT,
    );
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
      subjectCanonicalizationVersion: 1,
      createdAt: new Date().toISOString(),
    };
    this.environments.set(environment.id, environment);
    return environment;
  }
}
