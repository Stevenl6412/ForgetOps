import type { FastifyInstance } from "fastify";
import {
  requireTenantContext,
  type AuthContextProvider,
} from "../../auth-context.js";
import type { HierarchyStore } from "../../hierarchy-store.js";
import { tenantParamsSchema } from "../../route-schema.js";

interface TenantParams {
  tenantId: string;
}

export function registerTenantRoutes(
  app: FastifyInstance,
  dependencies: { authProvider: AuthContextProvider; store: HierarchyStore },
): void {
  app.get<{ Params: TenantParams }>(
    "/v1/tenants/:tenantId",
    { schema: { params: tenantParamsSchema } },
    async (request, reply) => {
      const context = await requireTenantContext(
        request,
        reply,
        dependencies.authProvider,
        request.params.tenantId,
      );
      if (!context) return;

      const tenant = await dependencies.store.getTenant(context.tenantId);
      if (!tenant)
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Resource not found" },
        });
      return { tenant };
    },
  );
}
