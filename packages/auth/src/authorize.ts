import { can, type Permission, type Role } from "./permissions.js";

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN" as const;

  constructor(
    readonly role: unknown,
    readonly permission: unknown,
  ) {
    super("The current role is not allowed to perform this action");
    this.name = "AuthorizationError";
  }
}

export function authorize(
  role: unknown,
  permission: unknown,
): asserts role is Role {
  if (!can(role, permission)) {
    throw new AuthorizationError(role, permission);
  }
}

export type AuthorizationResult =
  { allowed: true } | { allowed: false; error: AuthorizationError };

export function checkAuthorization(
  role: unknown,
  permission: unknown,
): AuthorizationResult {
  if (can(role, permission)) {
    return { allowed: true };
  }
  return { allowed: false, error: new AuthorizationError(role, permission) };
}

export type { Permission, Role };
