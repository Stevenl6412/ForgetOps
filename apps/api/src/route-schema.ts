export const tenantParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tenantId"],
  properties: { tenantId: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

export const projectParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId"],
  properties: { projectId: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

export const environmentParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["environmentId"],
  properties: {
    environmentId: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

export const createProjectBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "slug"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    slug: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    },
  },
} as const;

export const createEnvironmentBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: { kind: { type: "string", enum: ["staging", "production"] } },
} as const;
