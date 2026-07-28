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
  subjectCanonicalizationVersion: number;
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

export interface HierarchyRepository {
  getTenant(tenantId: string): Promise<TenantRecord | null>;
  listProjects(tenantId: string): Promise<readonly ProjectRecord[]>;
  getProject(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectRecord | null>;
  createProjectWithinLimit(
    tenantId: string,
    input: CreateProjectInput,
    maxProjects: number,
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

export type HierarchyStore = HierarchyRepository;
