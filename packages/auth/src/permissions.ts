const roleValues = ["owner", "admin", "reviewer"] as const;
export type Role = (typeof roleValues)[number];
export const roles: readonly Role[] = Object.freeze([...roleValues]);

const permissionValues = [
  "manage_billing",
  "manage_members",
  "pair_agent",
  "configure_connectors",
  "create_request",
  "approve_request",
  "change_execution_policy",
  "read_audit",
] as const;
export type Permission = (typeof permissionValues)[number];
export const permissions: readonly Permission[] = Object.freeze([
  ...permissionValues,
]);

export const FIXED_ROLE_PERMISSIONS: Readonly<
  Record<Role, readonly Permission[]>
> = Object.freeze({
  owner: freezePermissions(permissions),
  admin: freezePermissions([
    "configure_connectors",
    "create_request",
    "approve_request",
    "read_audit",
  ]),
  reviewer: freezePermissions(["approve_request", "read_audit"]),
});

const rolePermissions: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(FIXED_ROLE_PERMISSIONS.owner),
  admin: new Set(FIXED_ROLE_PERMISSIONS.admin),
  reviewer: new Set(FIXED_ROLE_PERMISSIONS.reviewer),
};

export function can(role: unknown, permission: unknown): boolean {
  if (!isRole(role) || !isPermission(permission)) {
    return false;
  }
  return rolePermissions[role].has(permission);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && roles.includes(value as Role);
}

function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && permissions.includes(value as Permission);
}

function freezePermissions(
  values: readonly Permission[],
): readonly Permission[] {
  return Object.freeze([...values]);
}
