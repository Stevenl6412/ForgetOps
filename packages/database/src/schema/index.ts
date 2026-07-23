import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
};

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    plan: text("plan").notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "tenants_plan_check",
      sql`${table.plan} in ('trial', 'starter', 'team')`,
    ),
  ],
);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ...timestamps,
});

export const environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    subjectHashKeyVersion: integer("subject_hash_key_version").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("environments_project_kind_uq").on(table.projectId, table.kind),
    check(
      "environments_kind_check",
      sql`${table.kind} in ('staging', 'production')`,
    ),
    check(
      "environments_status_check",
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check(
      "environments_subject_hash_key_version_check",
      sql`${table.subjectHashKeyVersion} > 0`,
    ),
  ],
);

export const agentPairingTokens = pgTable(
  "agent_pairing_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    tokenHash: text("token_hash").notNull(),
    allowReplacement: boolean("allow_replacement").notNull().default(false),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("agent_pairing_tokens_hash_uq").on(table.tokenHash),
    index("agent_pairing_tokens_environment_idx").on(table.environmentId),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    publicSigningKey: text("public_signing_key").notNull(),
    publicEncryptionKey: text("public_encryption_key").notNull(),
    version: text("version").notNull(),
    protocolVersion: text("protocol_version").notNull(),
    instanceFingerprint: text("instance_fingerprint").notNull(),
    status: text("status").notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastSequence: text("last_sequence").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agents_one_active_per_environment_uq")
      .on(table.environmentId)
      .where(
        sql`${table.status} in ('pairing', 'online', 'offline', 'outdated')`,
      ),
    check(
      "agents_status_check",
      sql`${table.status} in ('pairing', 'online', 'offline', 'outdated', 'revoked')`,
    ),
  ],
);

export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    type: text("type").notNull(),
    source: text("source").notNull(),
    subjectHash: text("subject_hash"),
    status: text("status").notNull(),
    policyVersion: integer("policy_version").notNull(),
    deadlineAt: timestamp("deadline_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    ...timestamps,
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    version: integer("version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    uniqueIndex("privacy_requests_idempotency_uq").on(
      table.environmentId,
      table.idempotencyKey,
    ),
    uniqueIndex("privacy_requests_one_active_subject_type_uq")
      .on(table.environmentId, table.subjectHash, table.type)
      .where(
        sql`${table.subjectHash} is not null and ${table.status} not in ('completed', 'partially_completed', 'failed', 'cancelled')`,
      ),
    check(
      "privacy_requests_type_check",
      sql`${table.type} in ('delete', 'export')`,
    ),
    check(
      "privacy_requests_source_check",
      sql`${table.source} in ('admin', 'privacy_portal', 'api')`,
    ),
    check(
      "privacy_requests_status_check",
      sql`${table.status} in ('created', 'identity_verification_pending', 'identity_verified', 'planning', 'awaiting_approval', 'execution_authorized', 'executing', 'completed', 'partially_completed', 'failed', 'cancelled')`,
    ),
    check(
      "privacy_requests_policy_version_check",
      sql`${table.policyVersion} > 0`,
    ),
    check("privacy_requests_version_check", sql`${table.version} > 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    requestId: text("request_id").references(() => privacyRequests.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
    previousEventHash: text("previous_event_hash"),
    eventHash: text("event_hash").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    check(
      "audit_events_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'system')`,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    aggregateId: text("aggregate_id")
      .notNull()
      .references(() => privacyRequests.id),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("outbox_events_unpublished_occurred_at_idx")
      .on(table.occurredAt)
      .where(sql`${table.publishedAt} is null`),
  ],
);
