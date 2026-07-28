import { describe, expect, it } from "vitest";
import type {
  CreateEnvironmentInput,
  CreateProjectInput,
  EnvironmentRecord,
  HierarchyRepository,
  ProjectRecord,
  TenantRecord,
} from "../src/tenant-hierarchy/ports.js";

describe("TenantHierarchyUseCases", () => {
  it("passes the application-owned project limit to the atomic repository operation", async () => {
    const useCases = await loadUseCases();
    expect(useCases).toHaveProperty("TenantHierarchyUseCases");
    const repository = new RecordingHierarchyRepository();
    const hierarchy = new useCases.TenantHierarchyUseCases(repository);
    const input = { name: "Project", slug: "project" };

    await hierarchy.createProject("tenant_a", input);

    expect(useCases.MAX_PROJECTS_PER_TENANT).toBe(5);
    expect(repository.projectCreation).toEqual({
      tenantId: "tenant_a",
      input,
      maxProjects: 5,
    });
  });

  it("propagates project-limit enforcement from the atomic repository operation", async () => {
    const useCases = await loadUseCases();
    expect(useCases).toHaveProperty("TenantHierarchyUseCases");
    const expected = new Error("limit enforced atomically");
    const repository = new RecordingHierarchyRepository();
    repository.projectCreationError = expected;

    await expect(
      new useCases.TenantHierarchyUseCases(repository).createProject(
        "tenant_a",
        {
          name: "Project 6",
          slug: "project-6",
        },
      ),
    ).rejects.toBe(expected);
  });
});

async function loadUseCases(): Promise<{
  MAX_PROJECTS_PER_TENANT: number;
  TenantHierarchyUseCases: new (repository: HierarchyRepository) => {
    createProject(
      tenantId: string,
      input: CreateProjectInput,
    ): Promise<ProjectRecord>;
  };
}> {
  return import("../src/tenant-hierarchy/use-cases.js").catch(
    () =>
      ({}) as {
        MAX_PROJECTS_PER_TENANT: number;
        TenantHierarchyUseCases: new (repository: HierarchyRepository) => {
          createProject(
            tenantId: string,
            input: CreateProjectInput,
          ): Promise<ProjectRecord>;
        };
      },
  );
}

class RecordingHierarchyRepository implements HierarchyRepository {
  projectCreation:
    | {
        tenantId: string;
        input: CreateProjectInput;
        maxProjects: number;
      }
    | undefined;
  projectCreationError: Error | undefined;

  async getTenant(_tenantId: string): Promise<TenantRecord | null> {
    return null;
  }

  async listProjects(_tenantId: string): Promise<readonly ProjectRecord[]> {
    return [];
  }

  async getProject(
    _tenantId: string,
    _projectId: string,
  ): Promise<ProjectRecord | null> {
    return null;
  }

  async createProjectWithinLimit(
    tenantId: string,
    input: CreateProjectInput,
    maxProjects: number,
  ): Promise<ProjectRecord> {
    this.projectCreation = { tenantId, input, maxProjects };
    if (this.projectCreationError) throw this.projectCreationError;
    return {
      id: "project_a",
      tenantId,
      ...input,
      createdAt: "2026-07-24T00:00:00.000Z",
    };
  }

  async listEnvironments(
    _tenantId: string,
    _projectId: string,
  ): Promise<readonly EnvironmentRecord[]> {
    return [];
  }

  async getEnvironment(
    _tenantId: string,
    _environmentId: string,
  ): Promise<EnvironmentRecord | null> {
    return null;
  }

  async createEnvironment(
    _tenantId: string,
    _projectId: string,
    _input: CreateEnvironmentInput,
  ): Promise<EnvironmentRecord> {
    throw new Error("not used");
  }
}
