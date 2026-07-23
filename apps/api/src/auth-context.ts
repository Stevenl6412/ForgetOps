import {
  AuthorizationError,
  authorize,
  type Permission,
  type Role,
} from "@forgetops/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface AuthContext {
  actorId: string;
  tenantId: string;
  role: Role;
}

export type AuthContextProvider = (
  request: FastifyRequest,
) => Promise<AuthContext | null>;

export async function requireTenantContext(
  request: FastifyRequest,
  reply: FastifyReply,
  authProvider: AuthContextProvider,
  requestedTenantId?: string,
): Promise<AuthContext | null> {
  const context = await authProvider(request);
  if (!context) {
    await reply
      .code(401)
      .send(errorBody("UNAUTHENTICATED", "Authentication is required"));
    return null;
  }
  if (requestedTenantId && context.tenantId !== requestedTenantId) {
    await reply.code(404).send(errorBody("NOT_FOUND", "Resource not found"));
    return null;
  }
  return context;
}

export async function requireAuthContext(
  request: FastifyRequest,
  reply: FastifyReply,
  authProvider: AuthContextProvider,
  permission: Permission,
  requestedTenantId?: string,
): Promise<AuthContext | null> {
  const context = await requireTenantContext(
    request,
    reply,
    authProvider,
    requestedTenantId,
  );
  if (!context) return null;
  try {
    authorize(context.role, permission);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) {
      throw error;
    }
    await reply.code(403).send(errorBody(error.code, error.message));
    return null;
  }
  return context;
}

export async function requireRoleContext(
  request: FastifyRequest,
  reply: FastifyReply,
  authProvider: AuthContextProvider,
  requiredRole: Role,
  requestedTenantId?: string,
): Promise<AuthContext | null> {
  const context = await requireTenantContext(
    request,
    reply,
    authProvider,
    requestedTenantId,
  );
  if (!context) return null;
  if (context.role !== requiredRole) {
    await reply
      .code(403)
      .send(
        errorBody(
          "FORBIDDEN",
          "The current role is not allowed to perform this action",
        ),
      );
    return null;
  }
  return context;
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}
