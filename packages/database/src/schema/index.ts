import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    subjectCanonicalizationVersion: integer("subject_canonicalization_version")
      .notNull()
      .default(1),
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
    check(
      "environments_subject_canonicalization_version_check",
      sql`${table.subjectCanonicalizationVersion} > 0`,
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
    replacementMode: text("replacement_mode").notNull().default("none"),
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
    signingKeyId: text("signing_key_id"),
    encryptionKeyId: text("encryption_key_id"),
    version: text("version").notNull(),
    protocolVersion: text("protocol_version").notNull(),
    instanceFingerprint: text("instance_fingerprint").notNull(),
    status: text("status").notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastSequence: text("last_sequence").notNull(),
    lastControlSequence: text("last_control_sequence").notNull().default("0"),
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

export const agentMessageReceipts = pgTable(
  "agent_message_receipts",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    messageId: text("message_id").notNull(),
    sequence: text("sequence").notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_message_receipts_pkey",
      columns: [table.agentId, table.messageId],
    }),
    uniqueIndex("agent_message_receipts_agent_sequence_uq").on(
      table.agentId,
      table.sequence,
    ),
    index("agent_message_receipts_received_at_idx").on(table.receivedAt),
  ],
);

export const agentTransportSessions = pgTable(
  "agent_transport_sessions",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    transport: text("transport").notNull(),
    sessionId: text("session_id").notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_transport_sessions_tenant_idx").on(
      table.tenantId,
      table.environmentId,
    ),
    check(
      "agent_transport_sessions_transport_check",
      sql`${table.transport} in ('websocket', 'polling')`,
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
    subjectHashKeyVersion: integer("subject_hash_key_version"),
    subjectCanonicalizationVersion: integer("subject_canonicalization_version"),
    duplicateOverride: boolean("duplicate_override").notNull().default(false),
    duplicateOfRequestId: text("duplicate_of_request_id"),
    currentAttemptId: text("current_attempt_id"),
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
  },
  (table) => [
    uniqueIndex("privacy_requests_one_active_subject_type_uq")
      .on(table.environmentId, table.subjectHash, table.type)
      .where(
        sql`${table.subjectHash} is not null and ${table.duplicateOverride} = false and ${table.status} not in ('completed', 'cancelled')`,
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
      sql`${table.status} in ('created', 'identity_verification_pending', 'identity_verified', 'planning', 'awaiting_approval', 'execution_authorized', 'executing', 'needs_review', 'completed', 'partially_completed', 'failed', 'cancelled')`,
    ),
    check(
      "privacy_requests_subject_hash_key_version_check",
      sql`${table.subjectHashKeyVersion} is null or ${table.subjectHashKeyVersion} > 0`,
    ),
    check(
      "privacy_requests_subject_canonicalization_version_check",
      sql`${table.subjectCanonicalizationVersion} is null or ${table.subjectCanonicalizationVersion} > 0`,
    ),
    check(
      "privacy_requests_policy_version_check",
      sql`${table.policyVersion} > 0`,
    ),
    check("privacy_requests_version_check", sql`${table.version} > 0`),
  ],
);

export const executionAttempts = pgTable(
  "execution_attempts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    requestId: text("request_id")
      .notNull()
      .references(() => privacyRequests.id),
    attemptNumber: integer("attempt_number").notNull(),
    kind: text("kind").notNull(),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    planFingerprint: text("plan_fingerprint").notNull(),
    allowedStepIds: jsonb("allowed_step_ids").$type<string[]>().notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("execution_attempts_request_number_uq").on(
      table.requestId,
      table.attemptNumber,
    ),
    uniqueIndex("execution_attempts_id_request_uq").on(
      table.id,
      table.requestId,
    ),
    check(
      "execution_attempts_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "execution_attempts_kind_check",
      sql`${table.kind} in ('initial', 'retry')`,
    ),
    check(
      "execution_attempts_plan_version_check",
      sql`${table.planVersion} > 0`,
    ),
    check(
      "execution_attempts_allowed_step_ids_check",
      sql`jsonb_typeof(${table.allowedStepIds}) = 'array' and jsonb_array_length(${table.allowedStepIds}) > 0`,
    ),
    check(
      "execution_attempts_status_check",
      sql`${table.status} in ('planned', 'awaiting_approval', 'authorized', 'running', 'succeeded', 'partially_succeeded', 'failed', 'needs_review', 'cancelled')`,
    ),
    check(
      "execution_attempts_completion_check",
      sql`(${table.status} in ('succeeded', 'partially_succeeded', 'failed', 'needs_review', 'cancelled')) = (${table.completedAt} is not null)`,
    ),
  ],
);

export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    requestId: text("request_id")
      .notNull()
      .references(() => privacyRequests.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    kind: text("kind").notNull(),
    planVersion: integer("plan_version"),
    payloadCiphertext: text("payload_ciphertext"),
    payloadEncryptionKeyId: text("payload_encryption_key_id"),
    authorization: text("authorization_payload"),
    availableAt: timestamp("available_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    leasedByAgentId: text("leased_by_agent_id").references(() => agents.id),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    attempt: integer("attempt").notNull().default(0),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    ...timestamps,
  },
  (table) => [
    index("agent_jobs_available_idx")
      .on(table.environmentId, table.availableAt)
      .where(sql`${table.completedAt} is null`),
    check(
      "agent_jobs_kind_check",
      sql`${table.kind} in ('bind_subject', 'plan', 'execute', 'lease_execution', 'wrap_export_key', 'cancel', 'health_check')`,
    ),
    check(
      "agent_jobs_plan_version_check",
      sql`${table.planVersion} is null or ${table.planVersion} > 0`,
    ),
    check("agent_jobs_attempt_check", sql`${table.attempt} >= 0`),
  ],
);

export const subjectEnvelopes = pgTable(
  "subject_envelopes",
  {
    requestId: text("request_id")
      .primaryKey()
      .references(() => privacyRequests.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    ciphertext: text("ciphertext").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "string",
    }),
    ...timestamps,
  },
  (table) => [
    index("subject_envelopes_environment_active_idx").on(
      table.environmentId,
      table.expiresAt,
    ),
  ],
);

export const subjectIdentityAliases = pgTable(
  "subject_identity_aliases",
  {
    requestId: text("request_id")
      .notNull()
      .references(() => privacyRequests.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    identifierKind: text("identifier_kind").notNull(),
    subjectHash: text("subject_hash").notNull(),
    subjectHashKeyVersion: integer("subject_hash_key_version").notNull(),
    canonicalizationVersion: integer("canonicalization_version").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: "subject_identity_aliases_pkey",
      columns: [table.requestId, table.identifierKind, table.subjectHash],
    }),
    index("subject_identity_aliases_environment_hash_idx").on(
      table.environmentId,
      table.subjectHash,
    ),
    check(
      "subject_identity_aliases_kind_check",
      sql`${table.identifierKind} = 'email'`,
    ),
    check(
      "subject_identity_aliases_subject_hash_check",
      sql`${table.subjectHash} ~ '^hmac-sha256:[0-9a-f]{64}$'`,
    ),
    check(
      "subject_identity_aliases_key_version_check",
      sql`${table.subjectHashKeyVersion} > 0`,
    ),
    check(
      "subject_identity_aliases_canonicalization_version_check",
      sql`${table.canonicalizationVersion} > 0`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    scope: text("scope").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    ...timestamps,
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_records_scope_actor_key_uq").on(
      table.tenantId,
      table.scope,
      table.actorId,
      table.idempotencyKey,
    ),
    check("idempotency_records_scope_check", sql`length(${table.scope}) > 0`),
    check(
      "idempotency_records_actor_id_check",
      sql`length(${table.actorId}) > 0`,
    ),
    check(
      "idempotency_records_key_check",
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      "idempotency_records_request_hash_check",
      sql`length(${table.requestHash}) > 0`,
    ),
    check(
      "idempotency_records_response_status_check",
      sql`${table.responseStatus} is null or ${table.responseStatus} between 100 and 599`,
    ),
    check(
      "idempotency_records_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const auditChainHeads = pgTable(
  "audit_chain_heads",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environmentId: text("environment_id")
      .primaryKey()
      .references(() => environments.id),
    sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
    eventHash: text("event_hash"),
  },
  (table) => [
    check("audit_chain_heads_sequence_check", sql`${table.sequence} >= 0`),
    check(
      "audit_chain_heads_hash_check",
      sql`(${table.sequence} = 0) = (${table.eventHash} is null)`,
    ),
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
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    requestId: text("request_id").references(() => privacyRequests.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    metadata: jsonb("metadata")
      .$type<
        Record<string, string | number | boolean | null | readonly string[]>
      >()
      .notNull(),
    previousEventHash: text("previous_event_hash"),
    eventHash: text("event_hash").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("audit_events_environment_sequence_uq").on(
      table.environmentId,
      table.sequence,
    ),
    check("audit_events_sequence_check", sql`${table.sequence} > 0`),
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
      .$type<
        Record<string, string | number | boolean | null | readonly string[]>
      >()
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
