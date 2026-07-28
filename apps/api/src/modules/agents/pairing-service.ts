import { randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { inTenantTransaction } from "@forgetops/database";
import type { HierarchyStore } from "../../hierarchy-store.js";
import {
  createPairingProofPayload,
  decodeAgentKey,
  keyIdForPublicKey,
  sha256Token,
  verifyAgentProof,
  type PairingProofFields,
} from "./signature-verifier.js";

export const PAIRING_TOKEN_TTL_MS = 15 * 60 * 1000;

export type AgentStatus =
  "pairing" | "online" | "offline" | "outdated" | "revoked";

export type ReplacementMode = "none" | "drain" | "force";

export interface AgentRecord {
  id: string;
  environmentId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  signingKeyId: string;
  encryptionKeyId: string;
  subjectHmacKeyVersion: number;
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
  replacementMode?: ReplacementMode;
  /** @deprecated Use replacementMode. true maps to the safe drain mode. */
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
  replacementMode: ReplacementMode;
  /** @deprecated Kept for callers compiled against the first pairing contract. */
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
  replacementMode: ReplacementMode;
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
  | "AGENT_REPLACEMENT_BLOCKED_ACTIVE_WORK"
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

export class AgentReplacementBlockedActiveWorkError extends PairingError {
  constructor(
    message = "Agent replacement is blocked while active envelopes or execution attempts exist",
  ) {
    super("AGENT_REPLACEMENT_BLOCKED_ACTIVE_WORK", message, 409);
    this.name = "AgentReplacementBlockedActiveWorkError";
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

function resolveReplacementMode(
  input: CreatePairingTokenInput,
): ReplacementMode {
  if (input.replacementMode) return input.replacementMode;
  return input.allowReplacement === true ? "drain" : "none";
}

function addEnvironmentRequest(
  requests: Map<string, Set<string>>,
  environmentId: string,
  requestId: string,
): void {
  const environmentRequests = requests.get(environmentId) ?? new Set<string>();
  environmentRequests.add(requestId);
  requests.set(environmentId, environmentRequests);
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
    const replacementMode = resolveReplacementMode(input);
    await this.repository.issueToken({
      id: `apt_${randomUUID()}`,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      tokenHash: sha256Token(plaintext),
      replacementMode,
      allowReplacement: replacementMode !== "none",
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
      tokenHash: sha256Token(pairingToken),
      registration,
      now: this.now().toISOString(),
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
    "signingKeyId",
    "encryptionKeyId",
    "subjectHmacKeyVersion",
    "version",
    "protocolVersion",
    "instanceFingerprint",
    "proof",
  ];
  for (const field of requiredFields) {
    const value = registration[field];
    if (
      field === "subjectHmacKeyVersion"
        ? typeof value !== "number" || !Number.isInteger(value) || value <= 0
        : typeof value !== "string" || value.length === 0
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
    if (
      registration.signingKeyId !==
        keyIdForPublicKey("ed25519", registration.publicSigningKey) ||
      registration.encryptionKeyId !==
        keyIdForPublicKey("x25519", registration.publicEncryptionKey)
    ) {
      throw new Error("key ID does not match public key");
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
  private readonly subjectEnvelopeRequests = new Map<string, Set<string>>();
  private readonly runningAttemptRequests = new Map<string, Set<string>>();
  private readonly requestStatuses = new Map<string, string>();
  private readonly pendingCiphertexts = new Map<
    string,
    { agentId: string; ciphertext: string }
  >();

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

  markSubjectEnvelopeActive(environmentId: string, requestId: string): void {
    addEnvironmentRequest(
      this.subjectEnvelopeRequests,
      environmentId,
      requestId,
    );
  }

  markAttemptRunning(environmentId: string, requestId: string): void {
    addEnvironmentRequest(
      this.runningAttemptRequests,
      environmentId,
      requestId,
    );
  }

  addPendingCiphertext(
    agentId: string,
    jobId: string,
    ciphertext: string,
  ): void {
    this.pendingCiphertexts.set(jobId, { agentId, ciphertext });
  }

  requestStatus(requestId: string): string | null {
    return this.requestStatuses.get(requestId) ?? null;
  }

  pendingCiphertext(jobId: string): string | null {
    return this.pendingCiphertexts.get(jobId)?.ciphertext ?? null;
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
    if (token.environmentId !== input.registration.environmentId) {
      throw new PairingTokenInvalidError();
    }
    const subjectHmacKeyVersion = this.hierarchy
      ? (
          await this.hierarchy.getEnvironment(
            token.tenantId,
            token.environmentId,
          )
        )?.subjectHashKeyVersion
      : input.registration.subjectHmacKeyVersion;
    if (
      subjectHmacKeyVersion === undefined ||
      subjectHmacKeyVersion !== input.registration.subjectHmacKeyVersion
    ) {
      throw new InvalidAgentKeyError("Subject-HMAC key version is not valid");
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
      if (token.replacementMode === "none") {
        throw new AgentReplacementRequiresOwnerConfirmationError();
      }
      const affectedRequests = new Set([
        ...(this.subjectEnvelopeRequests.get(token.environmentId) ?? []),
        ...(this.runningAttemptRequests.get(token.environmentId) ?? []),
      ]);
      if (token.replacementMode === "drain" && affectedRequests.size > 0) {
        throw new AgentReplacementBlockedActiveWorkError();
      }
      if (token.replacementMode === "force") {
        for (const requestId of affectedRequests) {
          this.requestStatuses.set(requestId, "needs_review");
        }
        this.subjectEnvelopeRequests.delete(token.environmentId);
        this.runningAttemptRequests.delete(token.environmentId);
        for (const [jobId, job] of this.pendingCiphertexts) {
          if (job.agentId === active.id) this.pendingCiphertexts.delete(jobId);
        }
      }
      this.agents.set(active.id, { ...active, status: "revoked" });
    }
    const agent: AgentRecord = {
      id: `agt_${randomUUID()}`,
      environmentId: token.environmentId,
      publicSigningKey: input.registration.publicSigningKey,
      publicEncryptionKey: input.registration.publicEncryptionKey,
      signingKeyId: input.registration.signingKeyId,
      encryptionKeyId: input.registration.encryptionKeyId,
      subjectHmacKeyVersion: input.registration.subjectHmacKeyVersion,
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
  replacementMode: ReplacementMode;
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
  signingKeyId: string | null;
  encryptionKeyId: string | null;
  subjectHmacKeyVersion: number;
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
    await inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const environment = await transaction<{ id: string }[]>`
        select e.id
        from environments e
        inner join projects p on p.id = e.project_id
        where e.id = ${input.environmentId}
          and p.tenant_id = ${input.tenantId}
      `;
        if (!environment[0]) throw new PairingResourceNotFoundError();
        await transaction`
        insert into agent_pairing_tokens (
          id, tenant_id, environment_id, token_hash, replacement_mode,
          allow_replacement, created_by_actor_id, created_at, expires_at
        ) values (
          ${input.id}, ${input.tenantId}, ${input.environmentId}, ${input.tokenHash},
          ${input.replacementMode}, ${input.allowReplacement},
          ${input.createdByActorId}, ${input.createdAt}, ${input.expiresAt}
        )
      `;
      },
    );
  }

  async findToken(tokenHash: string): Promise<PairingTokenRecord | null> {
    const rows = await this.client<TokenRow[]>`
      select id, tenant_id as "tenantId", environment_id as "environmentId",
             token_hash as "tokenHash", replacement_mode as "replacementMode",
             allow_replacement as "allowReplacement",
             created_by_actor_id as "createdByActorId", created_at as "createdAt",
             expires_at as "expiresAt", consumed_at as "consumedAt"
      from lookup_agent_pairing_token(${tokenHash})
    `;
    return rows[0] ? normalizeToken(rows[0]) : null;
  }

  async consumeAndPair(input: ConsumeAndPairInput): Promise<AgentRecord> {
    return (await this.client.begin(async (transaction) => {
      // The token hash is the only pre-tenant lookup. The security-definer
      // function returns one exact token row; all subsequent reads/writes run
      // under the tenant RLS role.
      const bootstrapRows = await transaction<TokenRow[]>`
        select id, tenant_id as "tenantId", environment_id as "environmentId",
               token_hash as "tokenHash", replacement_mode as "replacementMode",
               allow_replacement as "allowReplacement",
               created_by_actor_id as "createdByActorId",
               created_at as "createdAt", expires_at as "expiresAt",
               consumed_at as "consumedAt"
        from lookup_agent_pairing_token(${input.tokenHash})
      `;
      const bootstrapToken = bootstrapRows[0]
        ? normalizeToken(bootstrapRows[0])
        : null;
      if (!bootstrapToken) throw new PairingTokenInvalidError();

      await transaction.unsafe("set local role forgetops_app");
      await transaction`select set_config('app.tenant_id', ${bootstrapToken.tenantId}, true)`;

      const tokenRows = await transaction<TokenRow[]>`
        select t.id, t.tenant_id as "tenantId", t.environment_id as "environmentId",
               t.token_hash as "tokenHash", t.replacement_mode as "replacementMode",
               t.allow_replacement as "allowReplacement",
               t.created_by_actor_id as "createdByActorId", t.created_at as "createdAt",
               t.expires_at as "expiresAt", t.consumed_at as "consumedAt"
        from agent_pairing_tokens t
        where t.id = ${bootstrapToken.id}
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
      if (token.environmentId !== input.registration.environmentId) {
        throw new PairingTokenInvalidError();
      }

      const environmentRows = await transaction<
        { id: string; subjectHmacKeyVersion: number }[]
      >`
        select e.id, e.subject_hash_key_version as "subjectHmacKeyVersion"
        from environments e
        inner join projects p on p.id = e.project_id
        where e.id = ${token.environmentId}
          and p.tenant_id = ${token.tenantId}
        for update of e
      `;
      if (!environmentRows[0]) throw new PairingTokenInvalidError();
      if (
        environmentRows[0].subjectHmacKeyVersion !==
        input.registration.subjectHmacKeyVersion
      ) {
        throw new InvalidAgentKeyError("Subject-HMAC key version is not valid");
      }

      const activeRows = await transaction<AgentRow[]>`
        select id, environment_id as "environmentId",
               public_signing_key as "publicSigningKey",
               public_encryption_key as "publicEncryptionKey",
               signing_key_id as "signingKeyId",
               encryption_key_id as "encryptionKeyId",
               ${environmentRows[0].subjectHmacKeyVersion} as "subjectHmacKeyVersion",
               version,
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
        if (token.replacementMode === "none") {
          throw new AgentReplacementRequiresOwnerConfirmationError();
        }
        const envelopeRows = await transaction<{ requestId: string }[]>`
          select request_id as "requestId"
          from subject_envelopes
          where environment_id = ${token.environmentId}
            and consumed_at is null
          for update
        `;
        const attemptRows = await transaction<{ requestId: string }[]>`
          select request_id as "requestId"
          from execution_attempts
          where environment_id = ${token.environmentId}
            and status in ('authorized', 'running')
          for update
        `;
        const affectedRequestIds = [
          ...new Set([
            ...envelopeRows.map((row) => row.requestId),
            ...attemptRows.map((row) => row.requestId),
          ]),
        ];
        if (
          token.replacementMode === "drain" &&
          affectedRequestIds.length > 0
        ) {
          throw new AgentReplacementBlockedActiveWorkError();
        }
        if (token.replacementMode === "force") {
          if (affectedRequestIds.length > 0) {
            await transaction`
              update privacy_requests
              set status = 'needs_review',
                  version = version + 1,
                  completed_at = null
              where tenant_id = ${token.tenantId}
                and id = any(${affectedRequestIds})
                and status not in ('completed', 'cancelled')
            `;
            await transaction`
              update execution_attempts
              set status = 'needs_review',
                  completed_at = ${input.now}
              where tenant_id = ${token.tenantId}
                and request_id = any(${affectedRequestIds})
                and status in ('authorized', 'running')
            `;
          }
          await transaction`
            delete from subject_envelopes
            where tenant_id = ${token.tenantId}
              and environment_id = ${token.environmentId}
              and consumed_at is null
          `;
          await transaction`
            update agent_jobs
            set payload_ciphertext = null,
                payload_encryption_key_id = null,
                authorization_payload = null,
                leased_by_agent_id = null,
                lease_expires_at = null,
                completed_at = coalesce(completed_at, ${input.now})
            where tenant_id = ${token.tenantId}
              and environment_id = ${token.environmentId}
              and completed_at is null
          `;
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
          signing_key_id, encryption_key_id, version, protocol_version,
          instance_fingerprint, status, last_sequence
        ) values (
          ${agentId}, ${token.environmentId},
          ${input.registration.publicSigningKey},
          ${input.registration.publicEncryptionKey},
          ${input.registration.signingKeyId}, ${input.registration.encryptionKeyId},
          ${input.registration.version}, ${input.registration.protocolVersion},
          ${input.registration.instanceFingerprint}, 'pairing', '0'
        )
        returning id, environment_id as "environmentId",
                  public_signing_key as "publicSigningKey",
                  public_encryption_key as "publicEncryptionKey",
                  signing_key_id as "signingKeyId",
                  encryption_key_id as "encryptionKeyId",
                  ${environmentRows[0].subjectHmacKeyVersion} as "subjectHmacKeyVersion",
                  version,
                  protocol_version as "protocolVersion",
                  instance_fingerprint as "instanceFingerprint", status,
                  last_seen_at as "lastSeenAt", last_sequence as "lastSequence",
                  created_at as "createdAt"
      `;
      const consumed = await transaction`
        update agent_pairing_tokens
        set consumed_at = ${input.now}
        where id = ${token.id} and consumed_at is null
      `;
      if (consumed.count !== 1) throw new PairingTokenInvalidError();
      return normalizeAgent(rows[0]);
    })) as AgentRecord;
  }

  async findAgent(
    tenantId: string,
    agentId: string,
  ): Promise<AgentRecord | null> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const rows = await transaction<AgentRow[]>`
        select a.id, a.environment_id as "environmentId",
               a.public_signing_key as "publicSigningKey",
               a.public_encryption_key as "publicEncryptionKey",
               a.signing_key_id as "signingKeyId",
               a.encryption_key_id as "encryptionKeyId",
               e.subject_hash_key_version as "subjectHmacKeyVersion",
               a.version, a.protocol_version as "protocolVersion",
               a.instance_fingerprint as "instanceFingerprint", a.status,
               a.last_seen_at as "lastSeenAt", a.last_sequence as "lastSequence",
               a.created_at as "createdAt"
        from agents a
        inner join environments e on e.id = a.environment_id
        where a.id = ${agentId}
      `;
      return rows[0] ? normalizeAgent(rows[0]) : null;
    });
  }

  async revokeAgent(tenantId: string, agentId: string): Promise<void> {
    await inTenantTransaction(this.client, tenantId, async (transaction) => {
      const result = await transaction`
        update agents
        set status = 'revoked'
        where id = ${agentId} and status <> 'revoked'
      `;
      if (result.count === 0) {
        const existing = await transaction<{ id: string }[]>`
          select id from agents where id = ${agentId}
        `;
        if (!existing[0]) throw new AgentNotFoundError();
      }
    });
  }
}

function normalizeToken(row: TokenRow): PairingTokenRecord {
  const replacementMode = normalizeReplacementMode(
    row.replacementMode,
    row.allowReplacement,
  );
  return {
    ...row,
    replacementMode,
    allowReplacement: replacementMode !== "none",
    createdAt: toIso(row.createdAt),
    expiresAt: toIso(row.expiresAt),
    consumedAt: row.consumedAt === null ? null : toIso(row.consumedAt),
  };
}

function normalizeAgent(row: AgentRow): AgentRecord {
  const signingKeyId =
    row.signingKeyId ?? keyIdForPublicKey("ed25519", row.publicSigningKey);
  const encryptionKeyId =
    row.encryptionKeyId ?? keyIdForPublicKey("x25519", row.publicEncryptionKey);
  return {
    ...row,
    signingKeyId,
    encryptionKeyId,
    createdAt: toIso(row.createdAt),
    lastSeenAt: row.lastSeenAt === null ? null : toIso(row.lastSeenAt),
  };
}

function normalizeReplacementMode(
  value: string | null | undefined,
  allowReplacement: boolean,
): ReplacementMode {
  if (value === "none" || value === "drain" || value === "force") return value;
  return allowReplacement ? "drain" : "none";
}

function toIso(value: DateLike): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export { createPairingProofPayload, keyIdForPublicKey, verifyAgentProof };
