import { createHash } from "node:crypto";
import type {
  DomainEvent,
  PrivacyRequestAggregate,
  PrivacyRequestSnapshot,
  PrivacyRequestStatus,
} from "@forgetops/domain";
import type { Sql, TransactionSql } from "postgres";
import { v7 as uuidv7 } from "uuid";
import { inTransaction } from "../unit-of-work.js";

const terminalStatuses = new Set<PrivacyRequestStatus>([
  "completed",
  "partially_completed",
  "failed",
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

export interface PersistedPrivacyRequest {
  id: string;
  tenantId: string;
  environmentId: string;
  type: string;
  source: string;
  subjectHash: string | null;
  status: string;
  policyVersion: number;
  deadlineAt: string;
  createdByActorId: string;
  createdAt: string;
  completedAt: string | null;
  version: number;
  idempotencyKey: string;
}

const defaults: PersistenceDependencies = {
  newEventId: uuidv7,
  now: () => new Date(),
};

export class PrivacyRequestRepository {
  private readonly dependencies: PersistenceDependencies;

  constructor(
    private readonly client: Sql,
    private readonly tenantId: string,
    dependencies: Partial<PersistenceDependencies> = {},
  ) {
    this.dependencies = { ...defaults, ...dependencies };
  }

  async findById(id: string): Promise<PersistedPrivacyRequest | null> {
    const rows = await this.client<
      {
        id: string;
        tenant_id: string;
        environment_id: string;
        type: string;
        source: string;
        subject_hash: string | null;
        status: string;
        policy_version: number;
        deadline_at: Date | string;
        created_by_actor_id: string;
        created_at: Date | string;
        completed_at: Date | string | null;
        version: number;
        idempotency_key: string;
      }[]
    >`
      select id, tenant_id, environment_id, type, source, subject_hash, status,
        policy_version, deadline_at, created_by_actor_id, created_at,
        completed_at, version, idempotency_key
      from privacy_requests
      where id = ${id} and tenant_id = ${this.tenantId}
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
      status: row.status,
      policyVersion: row.policy_version,
      deadlineAt: isoTimestamp(row.deadline_at),
      createdByActorId: row.created_by_actor_id,
      createdAt: isoTimestamp(row.created_at),
      completedAt: row.completed_at ? isoTimestamp(row.completed_at) : null,
      version: row.version,
      idempotencyKey: row.idempotency_key,
    };
  }

  async save(aggregate: PrivacyRequestAggregate): Promise<void> {
    const snapshot = aggregate.snapshot();
    const pendingEvents = aggregate.pendingEvents();
    const expectedVersion = snapshot.version - pendingEvents.length;
    if (expectedVersion < 0) {
      throw new PrivacyRequestConcurrencyError(snapshot.id);
    }

    await inTransaction(this.client, async (transaction) => {
      await this.assertEnvironmentOwnership(
        transaction,
        snapshot.environmentId,
      );
      await this.persistSnapshot(transaction, snapshot, expectedVersion);
      await this.persistEvents(transaction, snapshot, pendingEvents);
    });

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
      for update
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
          completed_at, version, idempotency_key
        ) values (
          ${snapshot.id}, ${this.tenantId}, ${snapshot.environmentId},
          ${snapshot.type}, ${snapshot.source}, null, ${snapshot.status},
          ${snapshot.policyVersion}, ${snapshot.deadlineAt},
          ${snapshot.createdByActorId}, ${persistedAtValue}, ${completedAt},
          ${snapshot.version}, ${snapshot.id}
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

  private async persistEvents(
    transaction: TransactionSql,
    snapshot: PrivacyRequestSnapshot,
    events: readonly DomainEvent[],
  ): Promise<void> {
    const previousRows = await transaction<{ event_hash: string }[]>`
      select event_hash
      from audit_events
      where environment_id = ${snapshot.environmentId}
      order by created_at desc, id desc
      limit 1
    `;
    let previousHash = previousRows[0]?.event_hash ?? null;

    for (const domainEvent of events) {
      const id = this.dependencies.newEventId();
      const occurredAt = this.dependencies.now();
      const occurredAtValue = occurredAt.toISOString();
      const actor = eventActor(domainEvent);
      const hashInput = {
        id,
        tenantId: this.tenantId,
        environmentId: snapshot.environmentId,
        requestId: snapshot.id,
        actorType: actor.type,
        actorId: actor.id,
        action: domainEvent.type,
        metadata: domainEvent.payload,
        createdAt: occurredAtValue,
      };
      const eventHash = createHash("sha256")
        .update(previousHash ?? "")
        .update(canonicalJson(hashInput))
        .digest("hex");

      await transaction`
        insert into audit_events (
          id, tenant_id, environment_id, request_id, actor_type, actor_id,
          action, metadata, previous_event_hash, event_hash, created_at
        ) values (
          ${id}, ${this.tenantId}, ${snapshot.environmentId}, ${snapshot.id},
          ${actor.type}, ${actor.id}, ${domainEvent.type},
          ${JSON.stringify(domainEvent.payload)}, ${previousHash},
          ${eventHash}, ${occurredAtValue}
        )
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
