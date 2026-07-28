import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import type { FastifyInstance } from "fastify";

export interface PortalRequestView {
  id: string;
  projectId: string;
  status: string;
  type: "delete" | "export";
  deadlineAt: string;
}

export interface PortalRequestStore {
  findRequest(id: string): Promise<PortalRequestView | null>;
}

export interface PortalCapabilityClaims {
  type: "forgetops.portal-capability";
  version: 1;
  audience: "forgetops-privacy-portal";
  requestId: string;
  projectId: string;
  portalSessionId: string;
  tokenId: string;
  permissions: readonly ("read_status" | "download_export")[];
  issuedAt: string;
  expiresAt: string;
}

export class PortalCapabilityService {
  constructor(
    private readonly secret: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (secret.byteLength < 32) {
      throw new TypeError("Portal capability secret must be at least 32 bytes");
    }
  }

  issue(input: {
    requestId: string;
    projectId: string;
    portalSessionId: string;
    permissions: readonly ("read_status" | "download_export")[];
    ttlMs?: number;
  }): string {
    const now = this.now();
    const ttlMs = input.ttlMs ?? 60 * 60 * 1000;
    if (ttlMs <= 0 || ttlMs > 60 * 60 * 1000) {
      throw new RangeError("PORTAL_CAPABILITY_TTL_INVALID");
    }
    const claims: PortalCapabilityClaims = {
      type: "forgetops.portal-capability",
      version: 1,
      audience: "forgetops-privacy-portal",
      requestId: input.requestId,
      projectId: input.projectId,
      portalSessionId: input.portalSessionId,
      tokenId: randomBytes(16).toString("hex"),
      permissions: [...new Set(input.permissions)],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    const payload = Buffer.from(canonical(claims)).toString("base64url");
    const signature = createHmac("sha256", this.secret)
      .update("forgetops.portal-capability.v1")
      .update(Buffer.from([0]))
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  verify(token: string): PortalCapabilityClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra)
      throw new Error("PORTAL_TOKEN_INVALID");
    const expected = createHmac("sha256", this.secret)
      .update("forgetops.portal-capability.v1")
      .update(Buffer.from([0]))
      .update(payload)
      .digest();
    const received = Buffer.from(signature, "base64url");
    if (
      received.length !== expected.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new Error("PORTAL_TOKEN_INVALID");
    }
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as PortalCapabilityClaims;
    if (
      claims.type !== "forgetops.portal-capability" ||
      claims.version !== 1 ||
      claims.audience !== "forgetops-privacy-portal" ||
      Date.parse(claims.expiresAt) <= this.now().getTime()
    ) {
      throw new Error("PORTAL_TOKEN_INVALID");
    }
    return claims;
  }
}

export function registerPrivacyPortalRoutes(
  app: FastifyInstance,
  dependencies: {
    capabilities: PortalCapabilityService;
    requests: PortalRequestStore;
  },
): void {
  app.get<{ Params: { requestId: string } }>(
    "/v1/privacy-portal/requests/:requestId",
    async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!token)
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED" } });
      let claims: PortalCapabilityClaims;
      try {
        claims = dependencies.capabilities.verify(token);
      } catch {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED" } });
      }
      if (
        claims.requestId !== request.params.requestId ||
        !claims.permissions.includes("read_status")
      ) {
        return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      }
      const view = await dependencies.requests.findRequest(
        request.params.requestId,
      );
      if (!view || view.projectId !== claims.projectId) {
        return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      }
      return { request: view };
    },
  );
}

function canonical(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new TypeError("PORTAL_TOKEN_INVALID");
  return serialized;
}
