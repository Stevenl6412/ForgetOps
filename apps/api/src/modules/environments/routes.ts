import type { FastifyInstance } from "fastify";
import {
  requireRoleContext,
  requireTenantContext,
  type AuthContextProvider,
} from "../../auth-context.js";
import type {
  CreateEnvironmentInput,
  HierarchyStore,
} from "../../hierarchy-store.js";
import {
  createEnvironmentBodySchema,
  environmentParamsSchema,
  projectParamsSchema,
} from "../../route-schema.js";

interface ProjectParams {
  projectId: string;
}

interface EnvironmentParams {
  environmentId: string;
}

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  dependencies: { authProvider: AuthContextProvider; store: HierarchyStore },
): void {
  app.get<{ Params: ProjectParams }>(
    "/v1/projects/:projectId/environments",
    { schema: { params: projectParamsSchema } },
    async (request, reply) => {
      const context = await requireTenantContext(
        request,
        reply,
        dependencies.authProvider,
      );
      if (!context) return;
      const project = await dependencies.store.getProject(
        context.tenantId,
        request.params.projectId,
      );
      if (!project)
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Resource not found" },
        });
      return {
        environments: await dependencies.store.listEnvironments(
          context.tenantId,
          project.id,
        ),
      };
    },
  );

  app.post<{ Params: ProjectParams; Body: CreateEnvironmentInput }>(
    "/v1/projects/:projectId/environments",
    {
      schema: {
        params: projectParamsSchema,
        body: createEnvironmentBodySchema,
      },
    },
    async (request, reply) => {
      const context = await requireRoleContext(
        request,
        reply,
        dependencies.authProvider,
        "owner",
      );
      if (!context) return;
      const environment = await dependencies.store.createEnvironment(
        context.tenantId,
        request.params.projectId,
        request.body,
      );
      return reply.code(201).send({ environment });
    },
  );

  app.get<{ Params: EnvironmentParams }>(
    "/v1/environments/:environmentId",
    { schema: { params: environmentParamsSchema } },
    async (request, reply) => {
      const context = await requireTenantContext(
        request,
        reply,
        dependencies.authProvider,
      );
      if (!context) return;
      const environment = await dependencies.store.getEnvironment(
        context.tenantId,
        request.params.environmentId,
      );
      if (!environment)
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Resource not found" },
        });
      return { environment };
    },
  );
}
