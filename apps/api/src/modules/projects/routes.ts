import type { FastifyInstance } from "fastify";
import {
  requireRoleContext,
  requireTenantContext,
  type AuthContextProvider,
} from "../../auth-context.js";
import type { CreateProjectInput } from "../../hierarchy-store.js";
import type { TenantHierarchyUseCases } from "@forgetops/application/tenant-hierarchy";
import {
  createProjectBodySchema,
  projectParamsSchema,
  tenantParamsSchema,
} from "../../route-schema.js";

interface TenantParams {
  tenantId: string;
}

interface ProjectParams {
  projectId: string;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: {
    authProvider: AuthContextProvider;
    hierarchy: TenantHierarchyUseCases;
  },
): void {
  app.get<{ Params: TenantParams }>(
    "/v1/tenants/:tenantId/projects",
    { schema: { params: tenantParamsSchema } },
    async (request, reply) => {
      const context = await requireTenantContext(
        request,
        reply,
        dependencies.authProvider,
        request.params.tenantId,
      );
      if (!context) return;
      if (!(await dependencies.hierarchy.getTenant(context.tenantId))) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Resource not found" },
        });
      }
      return {
        projects: await dependencies.hierarchy.listProjects(context.tenantId),
      };
    },
  );

  app.post<{ Params: TenantParams; Body: CreateProjectInput }>(
    "/v1/tenants/:tenantId/projects",
    { schema: { params: tenantParamsSchema, body: createProjectBodySchema } },
    async (request, reply) => {
      const context = await requireRoleContext(
        request,
        reply,
        dependencies.authProvider,
        "owner",
        request.params.tenantId,
      );
      if (!context) return;
      const project = await dependencies.hierarchy.createProject(
        context.tenantId,
        request.body,
      );
      return reply.code(201).send({ project });
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/v1/projects/:projectId",
    { schema: { params: projectParamsSchema } },
    async (request, reply) => {
      const context = await requireTenantContext(
        request,
        reply,
        dependencies.authProvider,
      );
      if (!context) return;
      const project = await dependencies.hierarchy.getProject(
        context.tenantId,
        request.params.projectId,
      );
      if (!project)
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Resource not found" },
        });
      return { project };
    },
  );
}
