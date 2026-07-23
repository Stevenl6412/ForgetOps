import type { DatabaseConnection } from "@forgetops/database";
import Fastify, { type FastifyInstance } from "fastify";
import type { AuthContextProvider } from "./auth-context.js";
import {
  EnvironmentConflictError,
  HierarchyNotFoundError,
  PostgresHierarchyStore,
  ProjectLimitError,
  type HierarchyStore,
} from "./hierarchy-store.js";
import { registerEnvironmentRoutes } from "./modules/environments/routes.js";
import { registerProjectRoutes } from "./modules/projects/routes.js";
import { registerTenantRoutes } from "./modules/tenants/routes.js";

export interface AppOptions {
  authProvider: AuthContextProvider;
  store?: HierarchyStore;
  database?: DatabaseConnection;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const store = resolveStore(options);
  const app = Fastify({ logger: false });
  const dependencies = { authProvider: options.authProvider, store };

  registerTenantRoutes(app, dependencies);
  registerProjectRoutes(app, dependencies);
  registerEnvironmentRoutes(app, dependencies);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProjectLimitError) {
      return reply.code(422).send(errorResponse(error.code, error.message));
    }
    if (error instanceof EnvironmentConflictError) {
      return reply.code(409).send(errorResponse(error.code, error.message));
    }
    if (error instanceof HierarchyNotFoundError) {
      return reply
        .code(404)
        .send(errorResponse(error.code, "Resource not found"));
    }
    if (isValidationError(error)) {
      return reply
        .code(400)
        .send(errorResponse("VALIDATION_ERROR", error.message));
    }
    throw error;
  });

  return app;
}

export const createApp = buildApp;

function resolveStore(options: AppOptions): HierarchyStore {
  if (options.store) return options.store;
  if (options.database)
    return new PostgresHierarchyStore(options.database.client);
  throw new TypeError(
    "buildApp requires a hierarchy store or database connection",
  );
}

function errorResponse(code: string, message: string) {
  return { error: { code, message } };
}

function isValidationError(
  error: unknown,
): error is { validation: unknown; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    "message" in error &&
    typeof error.message === "string"
  );
}
