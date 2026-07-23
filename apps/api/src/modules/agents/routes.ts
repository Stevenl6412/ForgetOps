import type { FastifyInstance } from "fastify";
import {
  requireRoleContext,
  type AuthContextProvider,
} from "../../auth-context.js";
import { PairingService, type AgentRegistration } from "./pairing-service.js";

interface EnvironmentParams {
  environmentId: string;
}

interface AgentParams {
  agentId: string;
}

interface PairingTokenBody {
  allowReplacement?: boolean;
}

export type AgentPairBody = AgentRegistration;

const environmentParamsSchema = {
  type: "object",
  required: ["environmentId"],
  properties: {
    environmentId: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
} as const;

const agentParamsSchema = {
  type: "object",
  required: ["agentId"],
  properties: { agentId: { type: "string", minLength: 1, maxLength: 200 } },
  additionalProperties: false,
} as const;

const pairingTokenBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { allowReplacement: { type: "boolean" } },
} as const;

const pairBodySchema = {
  type: "object",
  required: [
    "pairingToken",
    "environmentId",
    "publicSigningKey",
    "publicEncryptionKey",
    "version",
    "protocolVersion",
    "instanceFingerprint",
    "proof",
  ],
  additionalProperties: false,
  properties: {
    pairingToken: { type: "string", minLength: 1, maxLength: 512 },
    environmentId: { type: "string", minLength: 1, maxLength: 200 },
    publicSigningKey: { type: "string", minLength: 1, maxLength: 128 },
    publicEncryptionKey: { type: "string", minLength: 1, maxLength: 128 },
    version: { type: "string", minLength: 1, maxLength: 100 },
    protocolVersion: { type: "string", minLength: 1, maxLength: 100 },
    instanceFingerprint: { type: "string", minLength: 1, maxLength: 256 },
    proof: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

export function registerAgentRoutes(
  app: FastifyInstance,
  dependencies: {
    authProvider: AuthContextProvider;
    pairingService: PairingService;
  },
): void {
  app.post<{ Params: EnvironmentParams; Body: PairingTokenBody }>(
    "/v1/environments/:environmentId/agent-pairing-tokens",
    {
      schema: {
        params: environmentParamsSchema,
        body: pairingTokenBodySchema,
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
      const issued = await dependencies.pairingService.createToken({
        tenantId: context.tenantId,
        environmentId: request.params.environmentId,
        actorId: context.actorId,
        allowReplacement: request.body.allowReplacement,
      });
      return reply.code(201).send({
        pairingToken: issued.plaintext,
        expiresAt: issued.expiresAt,
      });
    },
  );

  app.post<{ Body: AgentPairBody }>(
    "/v1/agents/pair",
    { schema: { body: pairBodySchema } },
    async (request, reply) => {
      const agent = await dependencies.pairingService.pair(request.body);
      return reply.code(201).send({ agent });
    },
  );

  app.post<{ Params: AgentParams }>(
    "/v1/agents/:agentId/revoke",
    { schema: { params: agentParamsSchema } },
    async (request, reply) => {
      const context = await requireRoleContext(
        request,
        reply,
        dependencies.authProvider,
        "owner",
      );
      if (!context) return;
      await dependencies.pairingService.revoke({
        tenantId: context.tenantId,
        agentId: request.params.agentId,
      });
      return reply.code(204).send();
    },
  );
}
