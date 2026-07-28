import type {
  CreateEnvironmentInput,
  CreateProjectInput,
  HierarchyRepository,
} from "./ports.js";

export const MAX_PROJECTS_PER_TENANT = 5;

export class TenantHierarchyUseCases {
  constructor(private readonly repository: HierarchyRepository) {}

  getTenant(tenantId: string) {
    return this.repository.getTenant(tenantId);
  }

  listProjects(tenantId: string) {
    return this.repository.listProjects(tenantId);
  }

  getProject(tenantId: string, projectId: string) {
    return this.repository.getProject(tenantId, projectId);
  }

  createProject(tenantId: string, input: CreateProjectInput) {
    return this.repository.createProjectWithinLimit(
      tenantId,
      input,
      MAX_PROJECTS_PER_TENANT,
    );
  }

  listEnvironments(tenantId: string, projectId: string) {
    return this.repository.listEnvironments(tenantId, projectId);
  }

  getEnvironment(tenantId: string, environmentId: string) {
    return this.repository.getEnvironment(tenantId, environmentId);
  }

  createEnvironment(
    tenantId: string,
    projectId: string,
    input: CreateEnvironmentInput,
  ) {
    return this.repository.createEnvironment(tenantId, projectId, input);
  }
}
