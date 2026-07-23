import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  InMemoryHierarchyStore,
  type AuthContextProvider,
} from "../src/index.js";

const tenantA = { id: "tenant_a", name: "Tenant A", plan: "trial" as const };
const tenantB = { id: "tenant_b", name: "Tenant B", plan: "trial" as const };

function testApp(
  role: "owner" | "admin" | "reviewer" = "owner",
  tenantId = tenantA.id,
  store = new InMemoryHierarchyStore({ tenants: [tenantA, tenantB] }),
) {
  const authProvider: AuthContextProvider = async () => ({
    actorId: "actor_1",
    tenantId,
    role,
  });
  return buildApp({ authProvider, store });
}

describe("tenant hierarchy routes", () => {
  it("rejects a sixth project with a stable 422 error", async () => {
    const app = testApp();
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tenants/tenant_a/projects",
        payload: { name: `Project ${index + 1}`, slug: `project-${index + 1}` },
      });
      expect(response.statusCode).toBe(201);
    }

    const response = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant_a/projects",
      payload: { name: "Project 6", slug: "project-6" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "PROJECT_LIMIT_REACHED" },
    });
  });

  it("does not leak a project belonging to another tenant", async () => {
    const store = new InMemoryHierarchyStore({ tenants: [tenantA, tenantB] });
    const appA = testApp("owner", tenantA.id, store);
    const created = await appA.inject({
      method: "POST",
      url: "/v1/tenants/tenant_a/projects",
      payload: { name: "Private", slug: "private" },
    });
    const appB = testApp("owner", tenantB.id, store);

    const response = await appB.inject({
      method: "GET",
      url: `/v1/projects/${created.json().project.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("requires trusted auth context instead of arbitrary client headers", async () => {
    const app = buildApp({
      store: new InMemoryHierarchyStore({ tenants: [tenantA] }),
      authProvider: async () => null,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant_a/projects",
      headers: { "x-tenant-id": "tenant_a", "x-role": "owner" },
      payload: { name: "Nope", slug: "nope" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("enforces project ownership and environment uniqueness", async () => {
    const app = testApp();
    const projectResponse = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant_a/projects",
      payload: { name: "Warehouse", slug: "warehouse" },
    });
    const projectId = projectResponse.json().project.id as string;

    const first = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments`,
      payload: { kind: "production" },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments`,
      payload: { kind: "production" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "ENVIRONMENT_ALREADY_EXISTS" },
    });
  });

  it("denies reviewer project writes while allowing read routes", async () => {
    const app = testApp("reviewer");
    const write = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant_a/projects",
      payload: { name: "Nope", slug: "nope" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const read = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant_a",
    });
    expect(read.statusCode).toBe(200);
  });
});
