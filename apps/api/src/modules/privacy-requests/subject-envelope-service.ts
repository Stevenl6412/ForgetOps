import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import { inTenantTransaction } from "@forgetops/database";
import type { Sql, TransactionSql } from "postgres";

const SUBJECT_HASH_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const ACTIVE_AGENT_STATUSES = ["pairing", "online", "offline", "outdated"];
const CANCELLABLE_DUPLICATE_STATUSES = new Set([
  "created",
  "identity_verification_pending",
  "identity_verified",
  "planning",
  "awaiting_approval",
]);
const AGENT_ENCRYPTION_KEY_ID_PATTERN = /^x25519:sha256:[0-9a-f]{64}$/;

export type SubjectAliasKind = "email";

export interface SubjectAliasBinding {
  identifierKind: SubjectAliasKind;
  subjectHash: string;
  subjectHashKeyVersion: number;
  canonicalizationVersion: number;
}

export interface StoreSubjectEnvelopeInput {
  tenantId: string;
  environmentId: string;
  requestId: string;
  ciphertext: string;
  encryptionKeyId: string;
  expiresAt: string;
}

export interface DuplicateOverride {
  ownerActorId: string;
  reason: string;
}

export interface BindSubjectInput {
  tenantId: string;
  environmentId: string;
  requestId: string;
  agentId: string;
  subjectHash: string;
  subjectHashKeyVersion: number;
  canonicalizationVersion: number;
  expectedVersion: number;
  aliases?: readonly SubjectAliasBinding[];
  duplicateOverride?: DuplicateOverride;
}

export interface SubjectBindingResult {
  requestId: string;
  environmentId: string;
  subjectHash: string;
  subjectHashKeyVersion: number;
  canonicalizationVersion: number;
  duplicateOfRequestId: string | null;
  outcome: "bound" | "duplicate_cancelled" | "duplicate_override";
}

export interface BindSubjectRequest extends BindSubjectInput {
  now: string;
}

export interface SubjectEnvelopeRepository {
  storeEnvelope(input: StoreSubjectEnvelopeInput): Promise<void>;
  bindSubject(input: BindSubjectRequest): Promise<SubjectBindingResult>;
}

export interface SubjectEnvelopeServiceDependencies {
  now: () => Date;
}

const defaultDependencies: SubjectEnvelopeServiceDependencies = {
  now: () => new Date(),
};

export class SubjectEnvelopeError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "SubjectEnvelopeError";
  }
}

export class SubjectEnvelopeService {
  private readonly dependencies: SubjectEnvelopeServiceDependencies;

  constructor(
    private readonly repository: SubjectEnvelopeRepository,
    dependencies: Partial<SubjectEnvelopeServiceDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async storeEnvelope(input: StoreSubjectEnvelopeInput): Promise<void> {
    validateScope(input.tenantId, input.environmentId, input.requestId);
    if (typeof input.ciphertext !== "string" || !input.ciphertext.trim()) {
      throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_CIPHERTEXT_REQUIRED");
    }
    if (input.ciphertext.length > 1024 * 1024) {
      throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_TOO_LARGE");
    }
    if (
      typeof input.encryptionKeyId !== "string" ||
      !AGENT_ENCRYPTION_KEY_ID_PATTERN.test(input.encryptionKeyId)
    ) {
      throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_KEY_ID_REQUIRED");
    }
    const expiresAt = new Date(input.expiresAt);
    if (
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= this.dependencies.now().getTime()
    ) {
      throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_EXPIRED");
    }
    validateSerializedEnvelope(input);
    await this.repository.storeEnvelope(input);
  }

  async bindSubject(input: BindSubjectInput): Promise<SubjectBindingResult> {
    validateScope(input.tenantId, input.environmentId, input.requestId);
    validateSubjectHash(input.subjectHash);
    validatePositiveInteger(
      input.subjectHashKeyVersion,
      "SUBJECT_HASH_KEY_VERSION_INVALID",
    );
    validatePositiveInteger(
      input.canonicalizationVersion,
      "SUBJECT_CANONICALIZATION_VERSION_INVALID",
    );
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new SubjectEnvelopeError("REQUEST_VERSION_INVALID");
    }
    validateAliases(input.subjectHash, input);
    if (input.duplicateOverride) {
      if (
        !isNonEmptyString(input.duplicateOverride.ownerActorId) ||
        !isNonEmptyString(input.duplicateOverride.reason)
      ) {
        throw new SubjectEnvelopeError("DUPLICATE_OVERRIDE_INVALID");
      }
    }
    return this.repository.bindSubject({
      ...input,
      now: this.dependencies.now().toISOString(),
    });
  }
}

export class PostgresSubjectEnvelopeRepository implements SubjectEnvelopeRepository {
  constructor(private readonly client: Sql) {}

  async storeEnvelope(input: StoreSubjectEnvelopeInput): Promise<void> {
    await inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const rows = await transaction<
          {
            requestId: string;
            environmentId: string;
            encryptionKeyId: string;
          }[]
        >`
          select r.id as "requestId",
                 r.environment_id as "environmentId",
                 a.encryption_key_id as "encryptionKeyId"
          from privacy_requests r
          join environments e on e.id = r.environment_id
          join projects p on p.id = e.project_id
          join agents a on a.environment_id = r.environment_id
             and a.encryption_key_id = ${input.encryptionKeyId}
             and a.status = any(${ACTIVE_AGENT_STATUSES})
          where r.id = ${input.requestId}
            and r.tenant_id = ${input.tenantId}
            and r.environment_id = ${input.environmentId}
            and p.tenant_id = ${input.tenantId}
          for update of r, a
        `;
        const row = rows[0];
        if (!row) {
          throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_SCOPE_INVALID");
        }
        if (row.encryptionKeyId !== input.encryptionKeyId) {
          throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_KEY_ID_MISMATCH");
        }
        await transaction`
          insert into subject_envelopes (
            request_id, tenant_id, environment_id, ciphertext,
            encryption_key_id, expires_at
          ) values (
            ${input.requestId}, ${input.tenantId}, ${input.environmentId},
            ${input.ciphertext}, ${input.encryptionKeyId}, ${input.expiresAt}
          )
          on conflict (request_id) do update
          set tenant_id = excluded.tenant_id,
              environment_id = excluded.environment_id,
              ciphertext = excluded.ciphertext,
              encryption_key_id = excluded.encryption_key_id,
              expires_at = excluded.expires_at,
              consumed_at = null
        `;
      },
    );
  }

  async bindSubject(input: BindSubjectRequest): Promise<SubjectBindingResult> {
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => this.bindSubjectInTransaction(transaction, input),
    );
  }

  private async bindSubjectInTransaction(
    transaction: TransactionSql,
    input: BindSubjectRequest,
  ): Promise<SubjectBindingResult> {
    const initialRequest = await this.findRequest(
      transaction,
      input.tenantId,
      input.environmentId,
      input.requestId,
    );
    if (!initialRequest) {
      throw new SubjectEnvelopeError("SUBJECT_REQUEST_NOT_FOUND");
    }
    if (
      initialRequest.subjectHash === input.subjectHash &&
      initialRequest.subjectHashKeyVersion === input.subjectHashKeyVersion &&
      initialRequest.subjectCanonicalizationVersion ===
        input.canonicalizationVersion
    ) {
      await transaction`
        delete from subject_envelopes
        where request_id = ${input.requestId}
      `;
      return toBindingResult(initialRequest, existingOutcome(initialRequest));
    }

    const lockKey = JSON.stringify([
      input.environmentId,
      input.subjectHash,
      initialRequest.type,
    ]);
    await transaction`
      select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;

    const request = await this.findRequest(
      transaction,
      input.tenantId,
      input.environmentId,
      input.requestId,
      true,
    );
    if (!request) {
      throw new SubjectEnvelopeError("SUBJECT_REQUEST_NOT_FOUND");
    }
    if (
      request.subjectHash !== null ||
      request.subjectHashKeyVersion !== null ||
      request.subjectCanonicalizationVersion !== null
    ) {
      if (
        request.subjectHash === input.subjectHash &&
        request.subjectHashKeyVersion === input.subjectHashKeyVersion &&
        request.subjectCanonicalizationVersion === input.canonicalizationVersion
      ) {
        await transaction`
          delete from subject_envelopes
          where request_id = ${input.requestId}
        `;
        return toBindingResult(request, existingOutcome(request));
      }
      throw new SubjectEnvelopeError("SUBJECT_ALREADY_BOUND");
    }
    if (request.version !== input.expectedVersion) {
      throw new SubjectEnvelopeError("REQUEST_VERSION_CONFLICT");
    }
    if (!CANCELLABLE_DUPLICATE_STATUSES.has(request.status)) {
      throw new SubjectEnvelopeError("SUBJECT_BINDING_STATE_INVALID");
    }
    if (
      request.subjectHashKeyVersion !== null ||
      request.subjectCanonicalizationVersion !== null
    ) {
      throw new SubjectEnvelopeError("SUBJECT_BINDING_STATE_INVALID");
    }
    if (
      request.environmentSubjectHashKeyVersion !==
        input.subjectHashKeyVersion ||
      request.environmentCanonicalizationVersion !==
        input.canonicalizationVersion
    ) {
      throw new SubjectEnvelopeError("SUBJECT_KEY_VERSION_MISMATCH");
    }

    const agentRows = await transaction<{ encryptionKeyId: string | null }[]>`
      select encryption_key_id as "encryptionKeyId"
      from agents
      where id = ${input.agentId}
        and environment_id = ${input.environmentId}
        and status = any(${ACTIVE_AGENT_STATUSES})
      for update
    `;
    const agent = agentRows[0];
    if (!agent) throw new SubjectEnvelopeError("SUBJECT_AGENT_NOT_ACTIVE");

    const envelopeRows = await transaction<
      { encryptionKeyId: string; expiresAt: Date | string }[]
    >`
      select encryption_key_id as "encryptionKeyId", expires_at as "expiresAt"
      from subject_envelopes
      where request_id = ${input.requestId}
        and tenant_id = ${input.tenantId}
        and environment_id = ${input.environmentId}
      for update
    `;
    const envelope = envelopeRows[0];
    if (!envelope) throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_NOT_FOUND");
    if (
      new Date(envelope.expiresAt).getTime() <= new Date(input.now).getTime()
    ) {
      await transaction`
        delete from subject_envelopes
        where request_id = ${input.requestId}
      `;
      throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_EXPIRED");
    }
    if (
      !agent.encryptionKeyId ||
      envelope.encryptionKeyId !== agent.encryptionKeyId
    ) {
      throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_KEY_MISMATCH");
    }

    const candidates = input.duplicateOverride
      ? []
      : await transaction<DuplicateCandidate[]>`
          select id, created_at as "createdAt", status
          from privacy_requests
          where tenant_id = ${input.tenantId}
            and environment_id = ${input.environmentId}
            and subject_hash = ${input.subjectHash}
            and type = ${request.type}
            and id <> ${input.requestId}
            and duplicate_override = false
            and status not in ('completed', 'cancelled')
          order by created_at, id
          for update
        `;
    const candidate = candidates[0];
    let duplicateOfRequestId: string | null = null;
    let outcome: SubjectBindingResult["outcome"] = input.duplicateOverride
      ? "duplicate_override"
      : "bound";

    if (candidate) {
      const currentIsNewer =
        compareCreatedAt(
          request.createdAt,
          candidate.createdAt,
          request.id,
          candidate.id,
        ) > 0;
      if (
        currentIsNewer ||
        !CANCELLABLE_DUPLICATE_STATUSES.has(candidate.status)
      ) {
        duplicateOfRequestId = candidate.id;
        outcome = "duplicate_cancelled";
      } else {
        await cancelDuplicate(
          transaction,
          input,
          candidate.id,
          request.id,
          input.now,
        );
      }
    }

    const currentStatus =
      outcome === "duplicate_cancelled" ? "cancelled" : "identity_verified";
    await transaction`
      update privacy_requests
      set subject_hash = ${input.subjectHash},
          subject_hash_key_version = ${input.subjectHashKeyVersion},
          subject_canonicalization_version = ${input.canonicalizationVersion},
          duplicate_override = ${outcome === "duplicate_override"},
          duplicate_of_request_id = ${duplicateOfRequestId},
          status = ${currentStatus},
          completed_at = ${currentStatus === "cancelled" ? input.now : null},
          version = version + 1
      where id = ${input.requestId}
        and tenant_id = ${input.tenantId}
        and version = ${input.expectedVersion}
    `;
    await insertAliases(transaction, input);
    await transaction`
      delete from subject_envelopes
      where request_id = ${input.requestId}
    `;

    if (candidate && !duplicateOfRequestId) {
      await appendAuditEvent(transaction, {
        tenantId: input.tenantId,
        environmentId: input.environmentId,
        requestId: candidate.id,
        actorType: "agent",
        actorId: input.agentId,
        action: "PrivacyRequestDuplicateCancelled",
        metadata: { duplicateOfRequestId: input.requestId },
        occurredAt: input.now,
      });
    }
    await appendAuditEvent(transaction, {
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      requestId: input.requestId,
      actorType: input.duplicateOverride ? "user" : "agent",
      actorId: input.duplicateOverride?.ownerActorId ?? input.agentId,
      action: input.duplicateOverride
        ? "SubjectDuplicateOverrideApplied"
        : outcome === "duplicate_cancelled"
          ? "PrivacyRequestDuplicateCancelled"
          : "SubjectIdentityBound",
      metadata: {
        duplicateOfRequestId,
        subjectHashKeyVersion: input.subjectHashKeyVersion,
        canonicalizationVersion: input.canonicalizationVersion,
        ...(input.duplicateOverride
          ? { reason: input.duplicateOverride.reason }
          : {}),
      },
      occurredAt: input.now,
    });

    return {
      requestId: input.requestId,
      environmentId: input.environmentId,
      subjectHash: input.subjectHash,
      subjectHashKeyVersion: input.subjectHashKeyVersion,
      canonicalizationVersion: input.canonicalizationVersion,
      duplicateOfRequestId,
      outcome,
    };
  }

  private async findRequest(
    transaction: TransactionSql,
    tenantId: string,
    environmentId: string,
    requestId: string,
    forUpdate = false,
  ): Promise<RequestRow | null> {
    const rows = await transaction<RequestRow[]>`
      select r.id, r.environment_id as "environmentId", r.type, r.status,
             r.subject_hash as "subjectHash",
             r.subject_hash_key_version as "subjectHashKeyVersion",
             r.subject_canonicalization_version as "subjectCanonicalizationVersion",
             r.duplicate_override as "duplicateOverride",
             r.duplicate_of_request_id as "duplicateOfRequestId",
             r.created_at as "createdAt", r.version,
             e.subject_hash_key_version as "environmentSubjectHashKeyVersion",
             e.subject_canonicalization_version as "environmentCanonicalizationVersion"
      from privacy_requests r
      join environments e on e.id = r.environment_id
      join projects p on p.id = e.project_id
      where r.id = ${requestId}
        and r.tenant_id = ${tenantId}
        and r.environment_id = ${environmentId}
        and p.tenant_id = ${tenantId}
      ${forUpdate ? transaction`for update of r, e` : transaction``}
    `;
    return rows[0] ?? null;
  }
}

interface RequestRow {
  id: string;
  environmentId: string;
  type: string;
  status: string;
  subjectHash: string | null;
  subjectHashKeyVersion: number | null;
  subjectCanonicalizationVersion: number | null;
  duplicateOverride: boolean;
  duplicateOfRequestId: string | null;
  createdAt: Date | string;
  version: number;
  environmentSubjectHashKeyVersion: number;
  environmentCanonicalizationVersion: number;
}

interface DuplicateCandidate {
  id: string;
  createdAt: Date | string;
  status: string;
}

async function cancelDuplicate(
  transaction: TransactionSql,
  input: BindSubjectRequest,
  requestId: string,
  duplicateOfRequestId: string,
  now: string,
): Promise<void> {
  await transaction`
    update privacy_requests
    set status = 'cancelled',
        duplicate_of_request_id = ${duplicateOfRequestId},
        completed_at = ${now},
        version = version + 1
    where id = ${requestId}
      and tenant_id = ${input.tenantId}
      and status not in ('completed', 'cancelled')
  `;
}

async function insertAliases(
  transaction: TransactionSql,
  input: BindSubjectRequest,
): Promise<void> {
  for (const alias of input.aliases ?? []) {
    await transaction`
      insert into subject_identity_aliases (
        request_id, tenant_id, environment_id, identifier_kind,
        subject_hash, subject_hash_key_version, canonicalization_version
      ) values (
        ${input.requestId}, ${input.tenantId}, ${input.environmentId},
        ${alias.identifierKind}, ${alias.subjectHash},
        ${alias.subjectHashKeyVersion}, ${alias.canonicalizationVersion}
      )
      on conflict (request_id, identifier_kind, subject_hash) do nothing
    `;
  }
}

async function appendAuditEvent(
  transaction: TransactionSql,
  input: {
    tenantId: string;
    environmentId: string;
    requestId: string;
    actorType: "user" | "agent" | "system";
    actorId: string;
    action: string;
    metadata: Record<string, unknown>;
    occurredAt: string;
  },
): Promise<void> {
  await transaction`
    insert into audit_chain_heads (tenant_id, environment_id, sequence, event_hash)
    values (${input.tenantId}, ${input.environmentId}, 0, null)
    on conflict (environment_id) do nothing
  `;
  const heads = await transaction<
    { sequence: string; eventHash: string | null }[]
  >`
    select sequence::text, event_hash as "eventHash"
    from audit_chain_heads
    where environment_id = ${input.environmentId}
    for update
  `;
  const head = heads[0];
  if (!head) throw new SubjectEnvelopeError("AUDIT_CHAIN_HEAD_MISSING");
  const sequence = (BigInt(head.sequence) + 1n).toString();
  const event = {
    id: randomUUID(),
    tenantId: input.tenantId,
    environmentId: input.environmentId,
    sequence,
    requestId: input.requestId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    metadata: input.metadata,
    createdAt: input.occurredAt,
  };
  const canonicalEvent = canonicalize(event);
  if (canonicalEvent === undefined) {
    throw new SubjectEnvelopeError("AUDIT_EVENT_NOT_CANONICAL");
  }
  const previousHash = head.eventHash
    ? Buffer.from(head.eventHash, "hex")
    : Buffer.alloc(0);
  if (previousHash.length !== (head.eventHash ? 32 : 0)) {
    throw new SubjectEnvelopeError("AUDIT_CHAIN_HEAD_INVALID");
  }
  const eventHash = createHash("sha256")
    .update("forgetops.audit-event.v1", "utf8")
    .update(Buffer.from([0]))
    .update(previousHash)
    .update(canonicalEvent, "utf8")
    .digest("hex");

  await transaction`
    insert into audit_events (
      id, tenant_id, environment_id, sequence, request_id, actor_type,
      actor_id, action, metadata, previous_event_hash, event_hash, created_at
    ) values (
      ${event.id}, ${input.tenantId}, ${input.environmentId}, ${sequence},
      ${input.requestId}, ${input.actorType}, ${input.actorId}, ${input.action},
      ${JSON.stringify(input.metadata)}, ${head.eventHash}, ${eventHash},
      ${input.occurredAt}
    )
  `;
  await transaction`
    update audit_chain_heads
    set sequence = ${sequence}, event_hash = ${eventHash}
    where environment_id = ${input.environmentId}
  `;
  await transaction`
    insert into outbox_events (
      id, tenant_id, environment_id, aggregate_id, type, payload, occurred_at
    ) values (
      ${event.id}, ${input.tenantId}, ${input.environmentId}, ${input.requestId},
      ${input.action}, ${JSON.stringify(input.metadata)}, ${input.occurredAt}
    )
  `;
}

function validateScope(
  tenantId: string,
  environmentId: string,
  requestId: string,
): void {
  if (
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(environmentId) ||
    !isNonEmptyString(requestId)
  ) {
    throw new SubjectEnvelopeError("SUBJECT_SCOPE_REQUIRED");
  }
}

function validateSubjectHash(subjectHash: string): void {
  if (
    typeof subjectHash !== "string" ||
    !SUBJECT_HASH_PATTERN.test(subjectHash)
  ) {
    throw new SubjectEnvelopeError("SUBJECT_HASH_INVALID");
  }
}

function validateSerializedEnvelope(input: StoreSubjectEnvelopeInput): void {
  let value: unknown;
  try {
    value = JSON.parse(input.ciphertext);
  } catch {
    throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_FORMAT_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_FORMAT_INVALID");
  }
  const envelope = value as Record<string, unknown>;
  const expectedKeys = [
    "algorithm",
    "ciphertext",
    "encryptionKeyId",
    "environmentId",
    "ephemeralPublicKey",
    "iv",
    "requestId",
    "salt",
    "version",
  ];
  if (
    Object.keys(envelope).sort().join("\0") !== expectedKeys.join("\0") ||
    envelope.version !== 1 ||
    envelope.algorithm !== "X25519-HKDF-SHA256-AES-256-GCM" ||
    envelope.environmentId !== input.environmentId ||
    envelope.requestId !== input.requestId ||
    envelope.encryptionKeyId !== input.encryptionKeyId ||
    !isBase64UrlBytes(envelope.ephemeralPublicKey, 32) ||
    !isBase64UrlBytes(envelope.salt, 32) ||
    !isBase64UrlBytes(envelope.iv, 12) ||
    !isBase64UrlBytes(envelope.ciphertext, undefined, 16)
  ) {
    throw new SubjectEnvelopeError("SUBJECT_ENVELOPE_FORMAT_INVALID");
  }
}

function isBase64UrlBytes(
  value: unknown,
  exactLength?: number,
  minimumLength = 0,
): boolean {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  const length = Buffer.from(value, "base64url").length;
  return (
    (exactLength === undefined || length === exactLength) &&
    length >= minimumLength
  );
}

function validatePositiveInteger(value: number, code: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SubjectEnvelopeError(code);
  }
}

function validateAliases(primaryHash: string, input: BindSubjectInput): void {
  if ((input.aliases?.length ?? 0) > 8) {
    throw new SubjectEnvelopeError("SUBJECT_ALIAS_LIMIT_EXCEEDED");
  }
  const seen = new Set<string>();
  for (const alias of input.aliases ?? []) {
    if (alias.identifierKind !== "email") {
      throw new SubjectEnvelopeError("SUBJECT_ALIAS_KIND_INVALID");
    }
    if (alias.subjectHash === primaryHash) {
      throw new SubjectEnvelopeError("SUBJECT_ALIAS_MUST_BE_EXPLICIT");
    }
    validateSubjectHash(alias.subjectHash);
    validatePositiveInteger(
      alias.subjectHashKeyVersion,
      "SUBJECT_ALIAS_KEY_VERSION_INVALID",
    );
    validatePositiveInteger(
      alias.canonicalizationVersion,
      "SUBJECT_ALIAS_CANONICALIZATION_VERSION_INVALID",
    );
    if (
      alias.subjectHashKeyVersion !== input.subjectHashKeyVersion ||
      alias.canonicalizationVersion !== input.canonicalizationVersion
    ) {
      throw new SubjectEnvelopeError("SUBJECT_ALIAS_VERSION_MISMATCH");
    }
    const key = `${alias.identifierKind}:${alias.subjectHash}`;
    if (seen.has(key)) {
      throw new SubjectEnvelopeError("SUBJECT_ALIAS_DUPLICATE");
    }
    seen.add(key);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compareCreatedAt(
  left: Date | string,
  right: Date | string,
  leftId: string,
  rightId: string,
): number {
  const byTime = new Date(left).getTime() - new Date(right).getTime();
  return byTime || leftId.localeCompare(rightId);
}

function toBindingResult(
  request: RequestRow,
  outcome: SubjectBindingResult["outcome"],
): SubjectBindingResult {
  if (
    !request.subjectHash ||
    request.subjectHashKeyVersion === null ||
    request.subjectCanonicalizationVersion === null
  ) {
    throw new SubjectEnvelopeError("SUBJECT_BINDING_STATE_INVALID");
  }
  return {
    requestId: request.id,
    environmentId: request.environmentId,
    subjectHash: request.subjectHash,
    subjectHashKeyVersion: request.subjectHashKeyVersion,
    canonicalizationVersion: request.subjectCanonicalizationVersion,
    duplicateOfRequestId: request.duplicateOfRequestId,
    outcome,
  };
}

function existingOutcome(request: RequestRow): SubjectBindingResult["outcome"] {
  if (request.duplicateOfRequestId) return "duplicate_cancelled";
  if (request.duplicateOverride) return "duplicate_override";
  return "bound";
}
