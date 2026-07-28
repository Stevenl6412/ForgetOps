import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type {
  PrivacyRequestRecord,
  PrivacyRequestStore,
} from "@forgetops/application";
import type {
  DomainEvent,
  ExecutionAttempt,
  PrivacyRequestAggregate,
  PrivacyRequestSnapshot,
  PrivacyRequestStatus,
} from "@forgetops/domain";
import type { Sql, TransactionSql } from "postgres";
import { v7 as uuidv7 } from "uuid";
import { inTenantTransaction } from "../unit-of-work.js";

const terminalStatuses = new Set<PrivacyRequestStatus>([
  "completed",
  "cancelled",
]);

export class PrivacyRequestConcurrencyError extends Error {
  readonly code = "REQUEST_CONCURRENCY_CONFLICT";

  constructor(readonly requestId: string) {
    super("REQUEST_CONCURRENCY_CONFLICT");
    this.name = "PrivacyRequestConcurrencyError";
  }
}

export class TenantScopeError extends Error {
  readonly code = "TENANT_SCOPE_VIOLATION";

  constructor() {
    super("TENANT_SCOPE_VIOLATION");
    this.name = "TenantScopeError";
  }
}

export interface PersistenceDependencies {
  newEventId: () => string;
  now: () => Date;
}

export type PersistedPrivacyRequest = PrivacyRequestRecord;

const defaults: PersistenceDependencies = {
  newEventId: uuidv7,
  now: () => new Date(),
};

export class PrivacyRequestRepository implements PrivacyRequestStore {
  private readonly dependencies: PersistenceDependencies;

  constructor(
    private readonly client: Sql,
    private readonly tenantId: string,
    dependencies: Partial<PersistenceDependencies> = {},
  ) {
    this.dependencies = { ...defaults, ...dependencies };
  }

  async findById(id: string): Promise<PersistedPrivacyRequest | null> {
    return inTenantTransaction(
      this.client,
      this.tenantId,
      async (transaction) => {
        const rows = await transaction<
          {
            id: string;
            tenant_id: string;
            environment_id: string;
            type: string;
            source: string;
            subject_hash: string | null;
            subject_hash_key_version: number | null;
            subject_canonicalization_version: number | null;
            duplicate_override: boolean;
            duplicate_of_request_id: string | null;
            status: string;
            policy_version: number;
            deadline_at: Date | string;
            created_by_actor_id: string;
            created_at: Date | string;
            completed_at: Date | string | null;
            current_attempt_id: string | null;
            version: number;
          }[]
        >`
        select id, tenant_id, environment_id, type, source, subject_hash,
          subject_hash_key_version, subject_canonicalization_version,
          duplicate_override, duplicate_of_request_id, status, policy_version,
          deadline_at, created_by_actor_id, created_at, completed_at,
          current_attempt_id, version
        from privacy_requests
        where id = ${id}
      `;
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id,
          tenantId: row.tenant_id,
          environmentId: row.environment_id,
          type: row.type,
          source: row.source,
          subjectHash: row.subject_hash,
          subjectHashKeyVersion: row.subject_hash_key_version,
          subjectCanonicalizationVersion: row.subject_canonicalization_version,
          duplicateOverride: row.duplicate_override,
          duplicateOfRequestId: row.duplicate_of_request_id,
          status: row.status,
          policyVersion: row.policy_version,
          deadlineAt: isoTimestamp(row.deadline_at),
          createdByActorId: row.created_by_actor_id,
          createdAt: isoTimestamp(row.created_at),
          completedAt: row.completed_at ? isoTimestamp(row.completed_at) : null,
          currentAttemptId: row.current_attempt_id,
          version: row.version,
        };
      },
    );
  }

  async save(
    aggregate: PrivacyRequestAggregate,
    expectedVersion: number,
  ): Promise<void> {
    const snapshot = aggregate.snapshot();
    const pendingEvents = aggregate.pendingEvents();
    if (
      expectedVersion < 0 ||
      pendingEvents.length === 0 ||
      snapshot.version !== expectedVersion + pendingEvents.length
    ) {
      throw new PrivacyRequestConcurrencyError(snapshot.id);
    }

    await inTenantTransaction(
      this.client,
      this.tenantId,
      async (transaction) => {
        await this.assertEnvironmentOwnership(
          transaction,
          snapshot.environmentId,
        );
        await this.persistSnapshot(transaction, snapshot, expectedVersion);
        await this.persistAttempts(
          transaction,
          snapshot,
          aggregate.executionAttempts(),
        );
        await this.persistEvents(transaction, snapshot, pendingEvents);
      },
    );

    aggregate.markEventsCommitted(pendingEvents.length);
  }

  private async assertEnvironmentOwnership(
    transaction: TransactionSql,
    environmentId: string,
  ): Promise<void> {
    const rows = await transaction<{ id: string }[]>`
      select e.id
      from environments e
      join projects p on p.id = e.project_id
      where e.id = ${environmentId} and p.tenant_id = ${this.tenantId}
    `;
    if (!rows[0]) throw new TenantScopeError();
  }

  private async persistSnapshot(
    transaction: TransactionSql,
    snapshot: PrivacyRequestSnapshot,
    expectedVersion: number,
  ): Promise<void> {
    const persistedAt = this.dependencies.now();
    const persistedAtValue = persistedAt.toISOString();
    const completedAt = terminalStatuses.has(snapshot.status)
      ? persistedAtValue
      : null;
    let rows: readonly { id: string }[];

    if (expectedVersion === 0) {
      rows = await transaction<{ id: string }[]>`
        insert into privacy_requests (
          id, tenant_id, environment_id, type, source, subject_hash, status,
          policy_version, deadline_at, created_by_actor_id, created_at,
          completed_at, current_attempt_id, version
        ) values (
          ${snapshot.id}, ${this.tenantId}, ${snapshot.environmentId},
          ${snapshot.type}, ${snapshot.source}, null, ${snapshot.status},
          ${snapshot.policyVersion}, ${snapshot.deadlineAt},
          ${snapshot.createdByActorId}, ${persistedAtValue}, ${completedAt},
          ${snapshot.currentAttemptId}, ${snapshot.version}
        )
        on conflict (id) do nothing
        returning id
      `;
    } else {
      rows = await transaction<{ id: string }[]>`
        update privacy_requests
        set status = ${snapshot.status},
          policy_version = ${snapshot.policyVersion},
          deadline_at = ${snapshot.deadlineAt},
          completed_at = ${completedAt},
          current_attempt_id = ${snapshot.currentAttemptId},
          version = ${snapshot.version}
        where id = ${snapshot.id}
          and tenant_id = ${this.tenantId}
          and environment_id = ${snapshot.environmentId}
          and version = ${expectedVersion}
        returning id
      `;
    }

    if (!rows[0]) throw new PrivacyRequestConcurrencyError(snapshot.id);
  }

  private async persistAttempts(
    transaction: TransactionSql,
    snapshot: PrivacyRequestSnapshot,
    attempts: readonly Readonly<ExecutionAttempt>[],
  ): Promise<void> {
    for (const attempt of attempts) {
      await transaction`
        insert into execution_attempts (
          id, tenant_id, environment_id, request_id, attempt_number, kind,
          plan_id, plan_version, plan_fingerprint, allowed_step_ids, status,
          created_at, completed_at
        ) values (
          ${attempt.id}, ${this.tenantId}, ${snapshot.environmentId},
          ${snapshot.id}, ${attempt.attemptNumber}, ${attempt.kind},
          ${attempt.planId}, ${attempt.planVersion}, ${attempt.planFingerprint},
          ${JSON.stringify(attempt.allowedStepIds)}, ${attempt.status},
          ${attempt.createdAt}, ${attempt.completedAt}
        )
        on conflict (id) do update
        set status = excluded.status,
          completed_at = excluded.completed_at
        where execution_attempts.completed_at is null
      `;
    }
  }

  private async persistEvents(
    transaction: TransactionSql,
    snapshot: PrivacyRequestSnapshot,
    events: readonly DomainEvent[],
  ): Promise<void> {
    await transaction`
      insert into audit_chain_heads (
        tenant_id, environment_id, sequence, event_hash
      ) values (
        ${this.tenantId}, ${snapshot.environmentId}, 0, null
      )
      on conflict (environment_id) do nothing
    `;
    const headRows = await transaction<
      { sequence: string; event_hash: string | null }[]
    >`
      select sequence::text, event_hash
      from audit_chain_heads
      where environment_id = ${snapshot.environmentId}
      for update
    `;
    const head = headRows[0];
    if (!head) throw new TenantScopeError();
    let sequence = BigInt(head.sequence);
    let previousHash = head.event_hash;

    for (const domainEvent of events) {
      sequence += 1n;
      const sequenceValue = sequence.toString();
      const id = this.dependencies.newEventId();
      const occurredAt = this.dependencies.now();
      const occurredAtValue = occurredAt.toISOString();
      const actor = eventActor(domainEvent);
      const eventWithoutHashes = {
        id,
        tenantId: this.tenantId,
        environmentId: snapshot.environmentId,
        sequence: sequenceValue,
        requestId: snapshot.id,
        actorType: actor.type,
        actorId: actor.id,
        action: domainEvent.type,
        metadata: domainEvent.payload,
        createdAt: occurredAtValue,
      };
      const canonicalEvent = canonicalize(eventWithoutHashes);
      if (canonicalEvent === undefined) {
        throw new TypeError("Audit event must be canonical JSON");
      }
      const previousHashBytes = previousHash
        ? Buffer.from(previousHash, "hex")
        : Buffer.alloc(0);
      if (previousHashBytes.length !== (previousHash ? 32 : 0)) {
        throw new TypeError("Audit chain head hash is invalid");
      }
      const eventHash = createHash("sha256")
        .update("forgetops.audit-event.v1", "utf8")
        .update(Buffer.from([0]))
        .update(previousHashBytes)
        .update(canonicalEvent, "utf8")
        .digest("hex");

      await transaction`
        insert into audit_events (
          id, tenant_id, environment_id, sequence, request_id, actor_type,
          actor_id, action, metadata, previous_event_hash, event_hash, created_at
        ) values (
          ${id}, ${this.tenantId}, ${snapshot.environmentId}, ${sequenceValue},
          ${snapshot.id}, ${actor.type}, ${actor.id}, ${domainEvent.type},
          ${JSON.stringify(domainEvent.payload)}, ${previousHash},
          ${eventHash}, ${occurredAtValue}
        )
      `;
      await transaction`
        update audit_chain_heads
        set sequence = ${sequenceValue}, event_hash = ${eventHash}
        where environment_id = ${snapshot.environmentId}
      `;
      await transaction`
        insert into outbox_events (
          id, tenant_id, environment_id, aggregate_id, type, payload, occurred_at
        ) values (
          ${id}, ${this.tenantId}, ${snapshot.environmentId}, ${snapshot.id},
          ${domainEvent.type}, ${JSON.stringify(domainEvent.payload)},
          ${occurredAtValue}
        )
      `;
      previousHash = eventHash;
    }
  }
}

function eventActor(event: DomainEvent): {
  type: "user" | "agent" | "system";
  id: string;
} {
  const agentId = event.payload.agentId;
  if (typeof agentId === "string") return { type: "agent", id: agentId };
  const actorId = event.payload.actorId;
  if (typeof actorId === "string") return { type: "user", id: actorId };
  const decidedBy = event.payload.decidedBy;
  if (typeof decidedBy === "string") return { type: "user", id: decidedBy };
  return { type: "system", id: "forgetops-domain" };
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
