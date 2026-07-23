import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  FIXED_ROLE_PERMISSIONS,
  authorize,
  can,
  type Permission,
  type Role,
} from "../src/index.js";

const permissions = [
  "manage_billing",
  "manage_members",
  "pair_agent",
  "configure_connectors",
  "create_request",
  "approve_request",
  "change_execution_policy",
  "read_audit",
] as const satisfies readonly Permission[];

const expected: Record<Role, readonly Permission[]> = {
  owner: permissions,
  admin: [
    "configure_connectors",
    "create_request",
    "approve_request",
    "read_audit",
  ],
  reviewer: ["approve_request", "read_audit"],
};

describe("fixed role authorization", () => {
  it.each(
    Object.entries(expected).flatMap(([role, allowed]) =>
      permissions.map(
        (permission) =>
          [role, permission, allowed.includes(permission)] as const,
      ),
    ),
  )("%s %s => %s", (role, permission, expectedResult) => {
    expect(can(role, permission)).toBe(expectedResult);
  });

  it("exports the same immutable matrix used by can", () => {
    expect([...FIXED_ROLE_PERMISSIONS.owner]).toEqual(permissions);
    expect(Object.isFrozen(FIXED_ROLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(FIXED_ROLE_PERMISSIONS.owner)).toBe(true);
    expect(() =>
      (FIXED_ROLE_PERMISSIONS.owner as Permission[]).push("manage_billing"),
    ).toThrow(TypeError);
    expect(can("unknown", "read_audit")).toBe(false);
    expect(can("owner", "unknown")).toBe(false);
  });

  it("throws an explicit typed error at the authorize boundary", () => {
    expect(() => authorize("reviewer", "create_request")).toThrowError(
      new AuthorizationError("reviewer", "create_request"),
    );
    expect(() => authorize("reviewer", "read_audit")).not.toThrow();
  });
});
