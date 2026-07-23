import { randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { HierarchyStore } from "../../hierarchy-store.js";
import {
  createPairingProofPayload,
  decodeAgentKey,
  sha256Token,
  verifyAgentProof,
  type PairingProofFields,
} from "./signature-verifier.js";

export const PAIRING_TOKEN_TTL_MS = 15 * 60 * 1000;

export type AgentStatus =
  "pairing" | "online" | "offline" | "outdated" | "revoked";

export interface AgentRecord {
  id: string;
  environmentId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  version: string;
  protocolVersion: string;
  instanceFingerprint: string;
  status: AgentStatus;
  lastSeenAt: string | null;
  lastSequence: string;
  createdAt: string;
}

export interface AgentRegistration extends PairingProofFields {
  proof: string;
}

export interface CreatePairingTokenInput {
  tenantId: string;
  environmentId: string;
  actorId: string;
  allowReplacement?: boolean;
}

export interface IssuedPairingToken {
  plaintext: string;
  expiresAt: string;
}

export interface PairingTokenRecord {
  id: string;
  tenantId: string;
  environmentId: string;
  tokenHash: string;
  allowReplacement: boolean;
  createdByActorId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

interface PersistPairingTokenInput {
  id: string;
  tenantId: string;
  environmentId: string;
  tokenHash: string;
  allowReplacement: boolean;
  createdByActorId: string;
  createdAt: string;
  expiresAt: string;
}

interface ConsumeAndPairInput {
  tokenHash: string;
  registration: AgentRegistration;
  now: string;
}

export interface PairingRepository {
  issueToken(input: PersistPairingTokenInput): Promise<void>;
  findToken(tokenHash: string): Promise<PairingTokenRecord | null>;
  consumeAndPair(input: ConsumeAndPairInput): Promise<AgentRecord>;
  findAgent(tenantId: string, agentId: string): Promise<AgentRecord | null>;
  revokeAgent(tenantId: string, agentId: string): Promise<void>;
}

export type PairingErrorCode =
  | "PAIRING_TOKEN_INVALID"
  | "AGENT_REPLACEMENT_REQUIRES_OWNER_CONFIRMATION"
  | "AGENT_ALREADY_ACTIVE"
  | "AGENT_NOT_FOUND"
  | "INVALID_AGENT_KEY"
  | "NOT_FOUND";

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  readonly statusCode: number;

  constructor(code: PairingErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "PairingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PairingTokenInvalidError extends PairingError {
  constructor(message = "The pairing token is invalid or expired") {
    super("PAIRING_TOKEN_INVALID", message, 400);
    this.name = "PairingTokenInvalidError";
  }
}

export class AgentReplacementRequiresOwnerConfirmationError extends PairingError {
  constructor(message = "The owner must approve agent replacement") {
    super("AGENT_REPLACEMENT_REQUIRES_OWNER_CONFIRMATION", message, 409);
    this.name = "AgentReplacementRequiresOwnerConfirmationError";
  }
}

export class AgentAlreadyActiveError extends PairingError {
  constructor(message = "This agent identity is already active") {
    super("AGENT_ALREADY_ACTIVE", message, 409);
    this.name = "AgentAlreadyActiveError";
  }
}

export class AgentNotFoundError extends PairingError {
  constructor(message = "Agent not found") {
    super("AGENT_NOT_FOUND", message, 404);
    this.name = "AgentNotFoundError";
  }
}

export class InvalidAgentKeyError extends PairingError {
  constructor(message = "Agent keys or proof are invalid") {
    super("INVALID_AGENT_KEY", message, 400);
    this.name = "InvalidAgentKeyError";
  }
}

export class PairingResourceNotFoundError extends PairingError {
  constructor(message = "Resource not found") {
    super("NOT_FOUND", message, 404);
    this.name = "PairingResourceNotFoundError";
  }
}

export class PairingService {
  private readonly repository: PairingRepository;
  private readonly now: () => Date;
  private readonly tokenTtlMs: number;

  constructor(
    repository: PairingRepository,
    options: { now?: () => Date; tokenTtlMs?: number } = {},
  ) {
    this.repository = repository;
    this.now = options.now ?? (() => new Date());
    this.tokenTtlMs = options.tokenTtlMs ?? PAIRING_TOKEN_TTL_MS;
  }

  async createToken(
    input: CreatePairingTokenInput,
  ): Promise<IssuedPairingToken> {
    const now = this.now();
    const plaintext = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.tokenTtlMs);
    await this.repository.issueToken({
      id: `apt_${randomUUID()}`,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      tokenHash: sha256Token(plaintext),
      allowReplacement: input.allowReplacement === true,
      createdByActorId: input.actorId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return { plaintext, expiresAt: expiresAt.toISOString() };
  }

  async consume(
    pairingToken: string,
    registration: AgentRegistration,
  ): Promise<AgentRecord> {
    if (registration.pairingToken !== pairingToken) {
      throw new PairingTokenInvalidError();
    }
    const tokenHash = sha256Token(pairingToken);
    const token = await this.repository.findToken(tokenHash);
    const now = this.now();
    if (
      !token ||
      token.consumedAt !== null ||
      new Date(token.expiresAt).getTime() <= now.getTime()
    ) {
      throw new PairingTokenInvalidError();
    }
    if (registration.environmentId !== token.environmentId) {
      throw new PairingTokenInvalidError();
    }
    validateRegistration(registration);
    const proofPayload = createPairingProofPayload(registration);
    if (
      !verifyAgentProof({
        publicSigningKey: registration.publicSigningKey,
        proof: registration.proof,
        payload: proofPayload,
      })
    ) {
      throw new InvalidAgentKeyError();
    }

    return this.repository.consumeAndPair({
      tokenHash,
      registration,
      now: now.toISOString(),
    });
  }

  pair(registration: AgentRegistration): Promise<AgentRecord> {
    return this.consume(registration.pairingToken, registration);
  }

  async revoke(input: { tenantId: string; agentId: string }): Promise<void> {
    await this.repository.revokeAgent(input.tenantId, input.agentId);
  }

  getAgent(tenantId: string, agentId: string): Promise<AgentRecord | null> {
    return this.repository.findAgent(tenantId, agentId);
  }
}

function validateRegistration(registration: AgentRegistration): void {
  const requiredFields: Array<keyof AgentRegistration> = [
    "pairingToken",
    "environmentId",
    "publicSigningKey",
    "publicEncryptionKey",
    "version",
    "protocolVersion",
    "instanceFingerprint",
    "proof",
  ];
  for (const field of requiredFields) {
    if (
      typeof registration[field] !== "string" ||
      registration[field].length === 0
    ) {
      throw new InvalidAgentKeyError();
    }
  }
  try {
    if (decodeAgentKey(registration.publicSigningKey).length !== 32) {
      throw new Error("invalid signing key");
    }
    const encryptionKey = decodeAgentKey(registration.publicEncryptionKey);
    if (
      encryptionKey.length !== 32 ||
      encryptionKey.every((byte) => byte === 0)
    ) {
      throw new Error("invalid encryption key");
    }
    const proofBytes = Buffer.from(registration.proof, "base64url");
    if (
      proofBytes.length !== 64 ||
      proofBytes.toString("base64url") !== registration.proof
    ) {
      throw new Error("invalid proof");
    }
  } catch {
    throw new InvalidAgentKeyError();
  }
}

export class InMemoryPairingRepository implements PairingRepository {
  private readonly tokens = new Map<string, PairingTokenRecord>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly agentTenants = new Map<string, string>();

  constructor(private readonly hierarchy?: HierarchyStore) {}

  async issueToken(input: PersistPairingTokenInput): Promise<void> {
    if (this.hierarchy) {
      const environment = await this.hierarchy.getEnvironment(
        input.tenantId,
        input.environmentId,
      );
      if (!environment) throw new PairingResourceNotFoundError();
    }
    this.tokens.set(input.tokenHash, {
      ...input,
      consumedAt: null,
    });
  }

  async findToken(tokenHash: string): Promise<PairingTokenRecord | null> {
    const token = this.tokens.get(tokenHash);
    return token ? { ...token } : null;
  }

  async consumeAndPair(input: ConsumeAndPairInput): Promise<AgentRecord> {
    const token = this.tokens.get(input.tokenHash);
    if (
      !token ||
      token.consumedAt !== null ||
      new Date(token.expiresAt).getTime() <= new Date(input.now).getTime()
    ) {
      throw new PairingTokenInvalidError();
    }
    const active = [...this.agents.values()].find(
      (agent) =>
        agent.environmentId === token.environmentId &&
        agent.status !== "revoked",
    );
    if (active) {
      if (active.publicSigningKey === input.registration.publicSigningKey) {
        throw new AgentAlreadyActiveError();
      }
      if (!token.allowReplacement) {
        throw new AgentReplacementRequiresOwnerConfirmationError();
      }
      this.agents.set(active.id, { ...active, status: "revoked" });
    }
    const agent: AgentRecord = {
      id: `agt_${randomUUID()}`,
      environmentId: token.environmentId,
      publicSigningKey: input.registration.publicSigningKey,
      publicEncryptionKey: input.registration.publicEncryptionKey,
      version: input.registration.version,
      protocolVersion: input.registration.protocolVersion,
      instanceFingerprint: input.registration.instanceFingerprint,
      status: "pairing",
      lastSeenAt: null,
      lastSequence: "0",
      createdAt: input.now,
    };
    token.consumedAt = input.now;
    this.tokens.set(input.tokenHash, token);
    this.agents.set(agent.id, agent);
    this.agentTenants.set(agent.id, token.tenantId);
    return { ...agent };
  }

  async findAgent(
    tenantId: string,
    agentId: string,
  ): Promise<AgentRecord | null> {
    if (this.agentTenants.get(agentId) !== tenantId) return null;
    const agent = this.agents.get(agentId);
    return agent ? { ...agent } : null;
  }

  async revokeAgent(tenantId: string, agentId: string): Promise<void> {
    if (this.agentTenants.get(agentId) !== tenantId) {
      throw new AgentNotFoundError();
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentNotFoundError();
    if (agent.status !== "revoked") {
      this.agents.set(agentId, { ...agent, status: "revoked" });
    }
  }
}

type SqlClient = Sql;
type DateLike = Date | string;

interface TokenRow {
  id: string;
  tenantId: string;
  environmentId: string;
  tokenHash: string;
  allowReplacement: boolean;
  createdByActorId: string;
  createdAt: DateLike;
  expiresAt: DateLike;
  consumedAt: DateLike | null;
}

interface AgentRow {
  id: string;
  environmentId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  version: string;
  protocolVersion: string;
  instanceFingerprint: string;
  status: AgentStatus;
  lastSeenAt: DateLike | null;
  lastSequence: string;
  createdAt: DateLike;
}

export class PostgresPairingRepository implements PairingRepository {
  constructor(private readonly client: SqlClient) {}

  async issueToken(input: PersistPairingTokenInput): Promise<void> {
    const environment = await this.client<{ id: string }[]>`
      select e.id
      from environments e
      inner join projects p on p.id = e.project_id
      where e.id = ${input.environmentId} and p.tenant_id = ${input.tenantId}
    `;
    if (!environment[0]) throw new PairingResourceNotFoundError();
    await this.client`
      insert into agent_pairing_tokens (
        id, tenant_id, environment_id, token_hash, allow_replacement,
        created_by_actor_id, created_at, expires_at
      ) values (
        ${input.id}, ${input.tenantId}, ${input.environmentId}, ${input.tokenHash},
        ${input.allowReplacement}, ${input.createdByActorId},
        ${input.createdAt}, ${input.expiresAt}
      )
    `;
  }

  async findToken(tokenHash: string): Promise<PairingTokenRecord | null> {
    const rows = await this.client<TokenRow[]>`
      select t.id, t.tenant_id as "tenantId", t.environment_id as "environmentId",
             t.token_hash as "tokenHash", t.allow_replacement as "allowReplacement",
             t.created_by_actor_id as "createdByActorId", t.created_at as "createdAt",
             t.expires_at as "expiresAt", t.consumed_at as "consumedAt"
      from agent_pairing_tokens t
      inner join environments e on e.id = t.environment_id
      inner join projects p on p.id = e.project_id and p.tenant_id = t.tenant_id
      where t.token_hash = ${tokenHash}
    `;
    return rows[0] ? normalizeToken(rows[0]) : null;
  }

  async consumeAndPair(input: ConsumeAndPairInput): Promise<AgentRecord> {
    return (await this.client.begin(async (transaction) => {
      const tokenRows = await transaction<TokenRow[]>`
        select t.id, t.tenant_id as "tenantId", t.environment_id as "environmentId",
               t.token_hash as "tokenHash", t.allow_replacement as "allowReplacement",
               t.created_by_actor_id as "createdByActorId", t.created_at as "createdAt",
               t.expires_at as "expiresAt", t.consumed_at as "consumedAt"
        from agent_pairing_tokens t
        inner join environments e on e.id = t.environment_id
        inner join projects p on p.id = e.project_id and p.tenant_id = t.tenant_id
        where t.token_hash = ${input.tokenHash}
        for update of t
      `;
      const token = tokenRows[0] ? normalizeToken(tokenRows[0]) : null;
      const now = new Date(input.now);
      if (
        !token ||
        token.consumedAt !== null ||
        new Date(token.expiresAt).getTime() <= now.getTime()
      ) {
        throw new PairingTokenInvalidError();
      }

      const environmentRows = await transaction<{ id: string }[]>`
        select e.id
        from environments e
        inner join projects p on p.id = e.project_id and p.tenant_id = ${token.tenantId}
        where e.id = ${token.environmentId}
        for update of e
      `;
      if (!environmentRows[0]) throw new PairingTokenInvalidError();

      const activeRows = await transaction<AgentRow[]>`
        select id, environment_id as "environmentId",
               public_signing_key as "publicSigningKey",
               public_encryption_key as "publicEncryptionKey", version,
               protocol_version as "protocolVersion",
               instance_fingerprint as "instanceFingerprint", status,
               last_seen_at as "lastSeenAt", last_sequence as "lastSequence",
               created_at as "createdAt"
        from agents
        where environment_id = ${token.environmentId}
          and status in ('pairing', 'online', 'offline', 'outdated')
        for update
      `;
      const active = activeRows[0] ? normalizeAgent(activeRows[0]) : null;
      if (active) {
        if (active.publicSigningKey === input.registration.publicSigningKey) {
          throw new AgentAlreadyActiveError();
        }
        if (!token.allowReplacement) {
          throw new AgentReplacementRequiresOwnerConfirmationError();
        }
        await transaction`
          update agents set status = 'revoked'
          where id = ${active.id} and environment_id = ${token.environmentId}
        `;
      }

      const agentId = `agt_${randomUUID()}`;
      const rows = await transaction<AgentRow[]>`
        insert into agents (
          id, environment_id, public_signing_key, public_encryption_key,
          version, protocol_version, instance_fingerprint, status, last_sequence
        ) values (
          ${agentId}, ${token.environmentId},
          ${input.registration.publicSigningKey},
          ${input.registration.publicEncryptionKey},
          ${input.registration.version}, ${input.registration.protocolVersion},
          ${input.registration.instanceFingerprint}, 'pairing', '0'
        )
        returning id, environment_id as "environmentId",
                  public_signing_key as "publicSigningKey",
                  public_encryption_key as "publicEncryptionKey", version,
                  protocol_version as "protocolVersion",
                  instance_fingerprint as "instanceFingerprint", status,
                  last_seen_at as "lastSeenAt", last_sequence as "lastSequence",
                  created_at as "createdAt"
      `;
      await transaction`
        update agent_pairing_tokens
        set consumed_at = ${input.now}
        where id = ${token.id} and consumed_at is null
      `;
      return normalizeAgent(rows[0]);
    })) as AgentRecord;
  }

  async findAgent(
    tenantId: string,
    agentId: string,
  ): Promise<AgentRecord | null> {
    const rows = await this.client<AgentRow[]>`
      select a.id, a.environment_id as "environmentId",
             a.public_signing_key as "publicSigningKey",
             a.public_encryption_key as "publicEncryptionKey", a.version,
             a.protocol_version as "protocolVersion",
             a.instance_fingerprint as "instanceFingerprint", a.status,
             a.last_seen_at as "lastSeenAt", a.last_sequence as "lastSequence",
             a.created_at as "createdAt"
      from agents a
      inner join environments e on e.id = a.environment_id
      inner join projects p on p.id = e.project_id
      where a.id = ${agentId} and p.tenant_id = ${tenantId}
    `;
    return rows[0] ? normalizeAgent(rows[0]) : null;
  }

  async revokeAgent(tenantId: string, agentId: string): Promise<void> {
    const result = await this.client`
      update agents a
      set status = 'revoked'
      from environments e
      inner join projects p on p.id = e.project_id
      where a.id = ${agentId}
        and a.environment_id = e.id
        and p.tenant_id = ${tenantId}
        and a.status <> 'revoked'
    `;
    if (result.count === 0) {
      const existing = await this.findAgent(tenantId, agentId);
      if (!existing) throw new AgentNotFoundError();
    }
  }
}

function normalizeToken(row: TokenRow): PairingTokenRecord {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
    expiresAt: toIso(row.expiresAt),
    consumedAt: row.consumedAt === null ? null : toIso(row.consumedAt),
  };
}

function normalizeAgent(row: AgentRow): AgentRecord {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
    lastSeenAt: row.lastSeenAt === null ? null : toIso(row.lastSeenAt),
  };
}

function toIso(value: DateLike): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export { createPairingProofPayload, verifyAgentProof };
