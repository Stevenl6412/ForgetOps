# ForgetOps MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ForgetOps MVP with a hosted TypeScript control plane, a self-hosted Rust agent, official Supabase/Stripe/Clerk connectors, a TypeScript custom adapter, approved delete workflows, and encrypted customer-owned export delivery.

**Architecture:** The control plane is a modular monolith deployed as web, API, and worker processes over PostgreSQL and Redis. The Rust agent keeps raw identities, connector credentials, discovery results, execution DAGs, and export contents in the customer environment. Control-plane commands and agent messages are signed; deletion requires an authorization bound to the exact approved plan.

**Tech Stack:** TypeScript, Node.js 22+, pnpm, Next.js, Fastify, Zod, Drizzle ORM, PostgreSQL, Redis, BullMQ, Vitest, Playwright, Testcontainers, Rust stable 1.85+, Tokio, serde, sqlx/SQLite, reqwest, tokio-tungstenite, ed25519-dalek, x25519-dalek, chacha20poly1305, cargo-nextest, Docker Compose.

**Normative safety source:** `docs/architecture/11-implementation-readiness-contracts.md`. If a shortened code example in this plan is ambiguous, the normative contracts take precedence.

## Contents

- [Global Constraints](#global-constraints)
- [Repository map](#repository-map)
- [Pre-implementation Gate S0](#pre-implementation-gate-s0)
- [Task 1 — Monorepo and CI](#task-1-bootstrap-the-monorepo-and-ci-quality-gates)
- [Task 2 — Contracts and protocol fixtures](#task-2-define-shared-ids-request-states-and-protocol-fixtures)
- [Task 3 — Request state machine](#task-3-implement-the-privacy-request-domain-state-machine)
- [Task 4 — Persistence, isolation, and outbox](#task-4-create-postgresql-schema-tenant-isolation-and-outbox-persistence)
- [Task 5 — Tenant and role authorization](#task-5-implement-tenant-project-environment-and-fixed-role-authorization)
- [Task 6 — Agent pairing and keys](#task-6-implement-agent-pairing-key-registration-and-revocation)
- [Task 7 — Agent transport and signing](#task-7-build-signed-agent-messages-websocket-delivery-and-polling-fallback)
- [Task 8 — Subject envelopes and identity binding](#task-8-implement-encrypted-subject-envelopes-and-environment-scoped-identity-binding)
- [Task 9 — Agent state and execution DAG](#task-9-implement-agent-local-encrypted-state-and-execution-dag)
- [Task 10 — Connector SDK](#task-10-define-connector-sdk-and-build-the-custom-typescript-adapter)
- [Task 11 — Supabase connector](#task-11-implement-the-supabase-connector-with-declarative-mappings)
- [Task 12 — Stripe and Clerk connectors](#task-12-implement-stripe-and-clerk-connectors)
- [Task 13 — Planning, approval, and authorization](#task-13-implement-planning-projections-approval-and-signed-execution-authorization)
- [Task 14 — Encrypted export](#task-14-build-export-archive-encryption-and-customer-owned-storage-delivery)
- [Task 15 — Admin dashboard](#task-15-build-admin-dashboard-request-workflow)
- [Task 16 — End-user portal verification](#task-16-build-end-user-portal-identity-verification)
- [Task 17 — Audit, webhooks, and retries](#task-17-complete-audit-evidence-notifications-ssrf-safe-webhooks-and-retry-ui)
- [Task 18 — Operations and kill switches](#task-18-add-observability-pii-guards-docker-compose-and-operational-kill-switches)
- [Task 19 — E2E safety and release](#task-19-build-the-full-end-to-end-safety-suite-and-release-pipeline)
- [Implementation sequence and review gates](#implementation-sequence-and-review-gates)

## Global Constraints

- The control plane must never persist raw end-user identifiers, connector credentials, record contents, export contents, or archive encryption keys in plaintext.
- Production deletion requires a signed, unexpired authorization bound to environment ID, agent ID, request ID, plan version, plan fingerprint, and single-use nonce.
- Every newly scheduled production destructive step also requires a short-lived online execution lease valid for at most 90 seconds.
- Every mutating API and every connector step must be idempotent.
- Every aggregate mutation carries an expected version; every retry creates a new immutable execution attempt.
- Staging and production are isolated by separate environment IDs, keys, agents, connector configuration, and subject hashes.
- The environment subject-HMAC key survives agent replacement and rotates independently from agent signing and X25519 keys.
- Every destructive connector capability must provide verification.
- Cross-service deletion rollback is not promised; partial completion is represented explicitly.
- The MVP supports one active agent per environment, at most five projects per tenant, and about 1,000 privacy requests per month.
- Use fixed roles: owner, admin, reviewer.
- Use Docker Compose for customer agent deployment; do not add Kubernetes support.
- Follow TDD for state transitions, signatures, connector behavior, and destructive operations.
- Use RFC 8785 canonical JSON with domain-separated signatures; do not concatenate variable-length fields.
- Guarantee idempotent final state rather than exactly one remote API call.

---

## Repository map

```text
forgetops/
  apps/
    web/
      app/
      components/
      lib/
      tests/
    api/
      src/
        app.ts
        server.ts
        modules/
      tests/
    worker/
      src/
      tests/
    signer/
      src/
      tests/
  packages/
    contracts/
      src/
      fixtures/
    domain/
      src/
      tests/
    application/
      src/
      tests/
    database/
      src/
      migrations/
      tests/
    auth/
      src/
      tests/
    observability/
      src/
    testing/
      src/
  agent/
    Cargo.toml
    crates/
      agent-core/
      agent-protocol/
      agent-store/
      connector-sdk/
      connector-supabase/
      connector-stripe/
      connector-clerk/
      adapter-http/
      export-builder/
    bin/forgetops-agent/
  sdk/
    typescript/
      src/
      tests/
  deploy/
    control-plane/
    agent-compose/
  docs/
```

---

## Pre-implementation safety gate S0

Before Task 1 is considered complete, record these decisions as executable fixtures:

- Request and execution-attempt transition tables
- Environment subject-key replacement and forced-replacement behavior
- RFC 8785 canonical bytes for signed messages and authorization claims
- Authorization and online execution-lease schemas
- Crash-recovery states for uncertain remote mutations
- Serialized audit-chain transaction
- Export container and on-demand browser key-wrap envelope

No destructive connector implementation begins until the S0 fixtures pass in both TypeScript and Rust.

---

### Task 1: Bootstrap the monorepo and CI quality gates

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `Cargo.toml`
- Create: `.github/workflows/ci.yml`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `apps/api/package.json`
- Create: `apps/web/package.json`
- Create: `apps/worker/package.json`
- Create: `apps/signer/package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/application/package.json`
- Create: `packages/database/package.json`
- Create: `sdk/typescript/package.json`
- Test: `packages/domain/tests/smoke.test.ts`
- Test: `packages/testing/tests/architecture-dependencies.test.ts`
- Test: `agent/crates/agent-core/tests/smoke.rs`

**Interfaces:**
- Consumes: none
- Produces: repeatable TypeScript and Rust build/test commands plus enforceable dependency rules used by every later task

- [ ] **Step 1: Write the initial TypeScript smoke test**

```ts
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("runs TypeScript tests", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Write the initial Rust smoke test**

```rust
#[test]
fn rust_workspace_runs_tests() {
    assert_eq!(2 + 2, 4);
}
```

- [ ] **Step 3: Add root scripts and workspace configuration**

```json
{
  "name": "forgetops",
  "private": true,
  "packageManager": "pnpm@10",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test && cargo nextest run --workspace",
    "lint": "turbo run lint && cargo clippy --workspace --all-targets -- -D warnings",
    "format:check": "prettier --check . && cargo fmt --all -- --check"
  },
  "devDependencies": {
    "prettier": "^3.5.0",
    "turbo": "^2.5.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

```yaml
packages:
  - apps/*
  - packages/*
  - sdk/*
```

- [ ] **Step 4: Add CI commands**

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { components: rustfmt, clippy }
      - uses: taiki-e/install-action@nextest
      - run: pnpm install --frozen-lockfile
      - run: pnpm format:check
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 5: Run the workspace checks**

Run:

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
```

Expected: TypeScript and Rust smoke tests pass; no lint errors.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: bootstrap ForgetOps monorepo"
```

---

### Task 2: Define shared IDs, request states, and protocol fixtures

**Files:**
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/privacy-request.ts`
- Create: `packages/contracts/src/agent-message.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/fixtures/agent-job-plan.json`
- Create: `packages/contracts/fixtures/execution-authorization.json`
- Create: `packages/contracts/fixtures/execution-lease.json`
- Create: `packages/contracts/fixtures/signed-agent-message.json`
- Create: `packages/contracts/tests/contracts.test.ts`
- Create: `agent/crates/agent-protocol/src/lib.rs`
- Create: `agent/crates/agent-protocol/tests/fixtures.rs`

**Interfaces:**
- Consumes: workspace from Task 1
- Produces: `PrivacyRequestStatusSchema`, `AgentMessageSchema`, `ExecutionAuthorizationClaimsSchema`, `ExecutionLeaseClaimsSchema`, Rust equivalents, canonical-byte fixtures, and cross-language signatures

- [ ] **Step 1: Write failing TypeScript contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  AgentMessageSchema,
  ExecutionAuthorizationClaimsSchema,
  ExecutionLeaseClaimsSchema,
  PrivacyRequestStatusSchema,
} from "../src";

it("accepts the locked request states", () => {
  expect(PrivacyRequestStatusSchema.parse("awaiting_approval")).toBe(
    "awaiting_approval",
  );
});

it("rejects an authorization without a plan fingerprint", () => {
  const result = ExecutionAuthorizationClaimsSchema.safeParse({
    issuer: "forgetops-control-plane",
  });
  expect(result.success).toBe(false);
});

it("requires every agent message to include a signature", () => {
  const result = AgentMessageSchema.safeParse({ protocolVersion: "1.0" });
  expect(result.success).toBe(false);
});

it("rejects an execution lease longer than the policy maximum", () => {
  const result = ExecutionLeaseClaimsSchema.safeParse({
    type: "forgetops.execution-lease",
    version: 1,
    keyId: "cp-key-1",
    environmentId: "env_1",
    agentId: "agt_1",
    requestId: "req_1",
    attemptId: "att_1",
    allowedStepIds: ["step_1"],
    issuedAt: "2026-07-21T10:00:00.000Z",
    expiresAt: "2026-07-21T10:02:00.000Z",
    leaseId: "lease_0123456789abcdef",
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Implement the TypeScript schemas**

```ts
import { z } from "zod";

export const PrivacyRequestStatusSchema = z.enum([
  "created",
  "identity_verification_pending",
  "identity_verified",
  "planning",
  "awaiting_approval",
  "execution_authorized",
  "executing",
  "needs_review",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
]);

export const ExecutionAuthorizationClaimsSchema = z.object({
  type: z.literal("forgetops.execution-authorization"),
  version: z.literal(1),
  keyId: z.string().min(1),
  issuer: z.literal("forgetops-control-plane"),
  audience: z.literal("forgetops-agent"),
  environmentId: z.string().min(1),
  agentId: z.string().min(1),
  requestId: z.string().min(1),
  attemptId: z.string().min(1),
  authorizationKind: z.enum(["initial", "retry"]),
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  planFingerprint: z.string().regex(/^sha256:/),
  policyVersion: z.number().int().positive(),
  connectorConfigurationFingerprint: z.string().regex(/^sha256:/),
  allowedStepIds: z.array(z.string().min(1)).min(1),
  approvalEvidenceHash: z.string().regex(/^sha256:/),
  issuedAt: z.string().datetime(),
  notBefore: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(16),
});

export const AgentMessageSchema = z.object({
  type: z.literal("forgetops.agent-message"),
  protocolVersion: z.literal("1.0"),
  messageType: z.string().min(1),
  messageId: z.string().min(1),
  keyId: z.string().min(1),
  environmentId: z.string().min(1),
  agentId: z.string().min(1),
  direction: z.enum(["control_to_agent", "agent_to_control"]),
  sequence: z.string().regex(/^\d+$/),
  sentAt: z.string().datetime(),
  payload: z.unknown(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export const ExecutionLeaseClaimsSchema = z.object({
  type: z.literal("forgetops.execution-lease"),
  version: z.literal(1),
  keyId: z.string().min(1),
  environmentId: z.string().min(1),
  agentId: z.string().min(1),
  requestId: z.string().min(1),
  attemptId: z.string().min(1),
  allowedStepIds: z.array(z.string().min(1)).min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  leaseId: z.string().min(16),
}).superRefine((value, context) => {
  const ttlMs = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  if (ttlMs <= 0 || ttlMs > 90_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "EXECUTION_LEASE_TTL_INVALID",
    });
  }
});
```

- [ ] **Step 3: Add matching Rust types**

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyRequestStatus {
    Created,
    IdentityVerificationPending,
    IdentityVerified,
    Planning,
    AwaitingApproval,
    ExecutionAuthorized,
    Executing,
    NeedsReview,
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAuthorizationClaims {
    pub r#type: String,
    pub version: u8,
    pub key_id: String,
    pub issuer: String,
    pub audience: String,
    pub environment_id: String,
    pub agent_id: String,
    pub request_id: String,
    pub attempt_id: String,
    pub authorization_kind: String,
    pub plan_id: String,
    pub plan_version: u32,
    pub plan_fingerprint: String,
    pub policy_version: u32,
    pub connector_configuration_fingerprint: String,
    pub allowed_step_ids: Vec<String>,
    pub approval_evidence_hash: String,
    pub issued_at: String,
    pub not_before: String,
    pub expires_at: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub r#type: String,
    pub protocol_version: String,
    pub message_type: String,
    pub message_id: String,
    pub key_id: String,
    pub environment_id: String,
    pub agent_id: String,
    pub direction: String,
    pub sequence: String,
    pub sent_at: String,
    pub payload: Value,
    pub signature: String,
}
```

- [ ] **Step 4: Load the same JSON fixtures in both languages**

Run:

```bash
pnpm --filter @forgetops/contracts test
cargo nextest run -p agent-protocol
```

Expected: both runtimes parse the committed fixtures, produce identical RFC 8785 canonical bytes, and verify each other's signatures.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts agent/crates/agent-protocol
git commit -m "feat: define shared request and agent contracts"
```

---

### Task 3: Implement the privacy-request domain state machine

**Files:**
- Create: `packages/domain/src/privacy-request/errors.ts`
- Create: `packages/domain/src/privacy-request/privacy-request.ts`
- Create: `packages/domain/src/privacy-request/index.ts`
- Create: `packages/domain/tests/privacy-request.test.ts`

**Interfaces:**
- Consumes: request status contracts from Task 2
- Produces: `PrivacyRequestAggregate` command methods and emitted domain events

- [ ] **Step 1: Write state-transition tests**

```ts
import { describe, expect, it } from "vitest";
import { PrivacyRequestAggregate, StateConflictError } from "../src/privacy-request";

function created() {
  return PrivacyRequestAggregate.create({
    id: "req_1",
    environmentId: "env_1",
    type: "delete",
    source: "admin",
    policyVersion: 1,
    createdByActorId: "usr_1",
    deadlineAt: "2026-08-20T00:00:00.000Z",
  });
}

it("moves an administrative request into planning after identity binding", () => {
  const request = created();
  request.markIdentityVerified({ actorId: "usr_1" });
  request.beginPlanning({ agentId: "agt_1" });
  expect(request.status).toBe("planning");
});

it("forbids execution before authorization", () => {
  const request = created();
  expect(() => request.markExecuting({ agentId: "agt_1" })).toThrow(
    StateConflictError,
  );
});

it("keeps terminal states terminal", () => {
  const request = created();
  request.cancel({ actorId: "usr_1", reason: "duplicate" });
  expect(() => request.markIdentityVerified({ actorId: "usr_1" })).toThrow(
    StateConflictError,
  );
});
```

- [ ] **Step 2: Implement command methods with an explicit transition table**

```ts
const transitions: Record<string, readonly string[]> = {
  created: ["identity_verification_pending", "identity_verified", "cancelled"],
  identity_verification_pending: ["identity_verified", "failed", "cancelled"],
  identity_verified: ["planning", "cancelled"],
  planning: ["awaiting_approval", "execution_authorized", "failed", "cancelled"],
  awaiting_approval: ["execution_authorized", "planning", "cancelled"],
  execution_authorized: ["executing", "awaiting_approval", "cancelled"],
  executing: ["completed", "partially_completed", "failed", "needs_review"],
  completed: [],
  partially_completed: ["planning", "execution_authorized", "needs_review", "completed"],
  failed: ["planning", "execution_authorized", "needs_review", "cancelled"],
  needs_review: ["planning", "execution_authorized", "partially_completed", "completed", "cancelled"],
  cancelled: [],
};

private transition(next: PrivacyRequestStatus, event: DomainEvent): void {
  if (!transitions[this.status].includes(next)) {
    throw new StateConflictError(this.status, next);
  }
  this.status = next;
  this.version += 1;
  this.events.push(event);
}
```

- [ ] **Step 3: Add approval-binding tests**

```ts
it("rejects approval for a stale plan", () => {
  const request = requestAwaitingApproval({ planVersion: 4, fingerprint: "sha256:new" });
  expect(() =>
    request.approvePlan({
      planId: "plan_1",
      planVersion: 3,
      planFingerprint: "sha256:old",
      decidedBy: "usr_2",
    }),
  ).toThrow("PLAN_VERSION_MISMATCH");
});

it("creates a new immutable attempt for a selected-step retry", () => {
  const request = partiallyCompletedRequest({ planVersion: 4 });
  request.beginRetry({
    attemptId: "att_2",
    allowedStepIds: ["step_failed"],
    expectedVersion: request.version,
  });
  expect(request.currentAttemptId).toBe("att_2");
  expect(request.status).toBe("execution_authorized");
});

it("returns an awaiting approval request to planning when changes are requested", () => {
  const request = requestAwaitingApproval({ planVersion: 4 });
  request.rejectPlan({ decidedBy: "usr_2", disposition: "changes_requested" });
  expect(request.status).toBe("planning");
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @forgetops/domain test
```

Expected: all allowed and forbidden transitions pass.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat: add privacy request state machine"
```

---

### Task 4: Create PostgreSQL schema, tenant isolation, and outbox persistence

**Files:**
- Create: `packages/database/src/schema/*.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/repositories/privacy-request-repository.ts`
- Create: `packages/application/src/privacy-requests/ports.ts`
- Create: `packages/database/src/unit-of-work.ts`
- Create: `packages/database/migrations/0001_initial.sql`
- Create: `packages/database/tests/privacy-request-repository.test.ts`
- Create: `packages/database/tests/tenant-isolation.test.ts`
- Create: `packages/database/tests/audit-chain-concurrency.test.ts`
- Create: `packages/database/tests/idempotency.test.ts`

**Interfaces:**
- Consumes: domain aggregate and events from Task 3
- Produces: transactional persistence with generic idempotency, optimistic concurrency, linear audit-chain insertion, RLS, and outbox insertion

- [ ] **Step 1: Write repository integration tests against PostgreSQL**

```ts
it("persists request state, audit event, and outbox event atomically", async () => {
  const request = await fixture.request("identity_verified");
  request.beginPlanning({ agentId: "agt_1" });

  await repository.save(request);

  expect(await db.query.privacyRequests.findFirst()).toMatchObject({
    id: request.id,
    status: "planning",
  });
  expect(await db.query.auditEvents.findMany()).toHaveLength(1);
  expect(await db.query.outboxEvents.findMany()).toHaveLength(1);
});
```

```ts
it("does not return another tenant request", async () => {
  await fixture.requestForTenant("tenant_b");
  const result = await repositoryForTenant("tenant_a").findById("req_b");
  expect(result).toBeNull();
});
```

- [ ] **Step 2: Define integrity indexes in SQL**

```sql
create unique index environments_project_kind_uq
  on environments(project_id, kind);

create unique index agents_one_active_per_environment_uq
  on agents(environment_id)
  where status in ('pairing', 'online', 'offline', 'outdated');

create unique index idempotency_records_scope_actor_key_uq
  on idempotency_records(tenant_id, scope, actor_id, idempotency_key);

create unique index privacy_requests_one_active_subject_type_uq
  on privacy_requests(environment_id, subject_hash, type)
  where subject_hash is not null
    and duplicate_override = false
    and status not in ('completed', 'cancelled');

create unique index execution_attempts_request_number_uq
  on execution_attempts(request_id, attempt_number);

create unique index audit_events_environment_sequence_uq
  on audit_events(environment_id, sequence);
```

- [ ] **Step 3: Implement one serialized transaction for request, audit, and outbox**

```ts
await db.transaction(async (tx) => {
  await updatePrivacyRequestWithExpectedVersion(
    tx,
    aggregate.snapshot(),
    command.expectedVersion,
  );
  const chainHead = await lockAuditChainHead(tx, aggregate.environmentId);
  for (const event of aggregate.pullEvents()) {
    const audit = auditEventFromDomainEvent(event, chainHead);
    await tx.insert(auditEvents).values(audit);
    await advanceAuditChainHead(tx, audit);
    await tx.insert(outboxEvents).values({
      id: event.id,
      aggregateId: aggregate.id,
      type: event.type,
      payload: event.payload,
      occurredAt: event.occurredAt,
    });
  }
});
```

- [ ] **Step 4: Add RLS and concurrent-chain tests**

Every tenant-owned table has `USING` and `WITH CHECK` policies driven by a transaction-local tenant context. A concurrency test starts at least 50 state transitions for one environment and asserts one contiguous sequence with no hash fork.

- [ ] **Step 5: Run database tests**

```bash
pnpm --filter @forgetops/database test
```

Expected: real PostgreSQL tests pass and transaction rollback leaves no partial rows.

- [ ] **Step 6: Commit**

```bash
git add packages/database
git commit -m "feat: persist requests with audit and outbox"
```

---

### Task 5: Implement tenant, project, environment, and fixed-role authorization

**Files:**
- Create: `packages/auth/src/permissions.ts`
- Create: `packages/auth/src/authorize.ts`
- Create: `packages/auth/tests/authorize.test.ts`
- Create: `apps/api/src/modules/tenants/routes.ts`
- Create: `apps/api/src/modules/projects/routes.ts`
- Create: `apps/api/src/modules/environments/routes.ts`
- Create: `apps/api/src/composition-root.ts`
- Test: `apps/api/tests/tenant-project-environment.test.ts`

**Interfaces:**
- Consumes: database and shared IDs
- Produces: tenant-scoped request context, read/write RLS context, role checks, and a composition root for later API routes

- [ ] **Step 1: Write the permission matrix test**

```ts
const cases = [
  ["owner", "manage_billing", true],
  ["admin", "manage_billing", false],
  ["reviewer", "create_request", false],
  ["admin", "create_request", true],
  ["reviewer", "approve_request", true],
] as const;

it.each(cases)("%s %s => %s", (role, permission, expected) => {
  expect(can(role, permission)).toBe(expected);
});
```

- [ ] **Step 2: Implement fixed permissions**

```ts
const permissions = {
  owner: new Set([
    "manage_billing",
    "manage_members",
    "pair_agent",
    "configure_connectors",
    "create_request",
    "approve_request",
    "change_execution_policy",
    "read_audit",
  ]),
  admin: new Set([
    "configure_connectors",
    "create_request",
    "approve_request",
    "read_audit",
  ]),
  reviewer: new Set(["approve_request", "read_audit"]),
} as const;
```

- [ ] **Step 3: Add API tests for the five-project limit and environment isolation**

```ts
it("rejects a sixth project", async () => {
  const tenant = await fixture.tenantWithProjects(5);
  const response = await api.post(`/v1/tenants/${tenant.id}/projects`, {
    headers: ownerHeaders(tenant.id),
    json: { name: "Project 6" },
  });
  expect(response.statusCode).toBe(422);
});
```

Also prove that a cross-tenant insert or update fails at the database layer even if an application repository is called with the wrong resource ID.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter @forgetops/auth test
pnpm --filter @forgetops/api test

git add packages/auth apps/api/src/modules apps/api/tests
git commit -m "feat: add tenant hierarchy and fixed RBAC"
```

---

### Task 6: Implement agent pairing, key registration, and revocation

**Files:**
- Create: `apps/api/src/modules/agents/pairing-service.ts`
- Create: `apps/api/src/modules/agents/routes.ts`
- Create: `apps/api/src/modules/agents/signature-verifier.ts`
- Create: `apps/api/tests/agent-pairing.test.ts`
- Create: `agent/crates/agent-core/src/identity.rs`
- Create: `agent/crates/agent-core/src/environment_secrets.rs`
- Create: `agent/bin/forgetops-agent/src/pair.rs`
- Test: `agent/crates/agent-core/tests/identity.rs`

**Interfaces:**
- Consumes: environment authorization and protocol contracts
- Produces: replaceable paired agent identity plus stable versioned environment subject-key material

- [ ] **Step 1: Write pairing-token tests**

```ts
it("accepts a pairing token once and rejects reuse", async () => {
  const token = await pairing.createToken({ environmentId: "env_1", actorId: "owner_1" });
  const first = await pairing.consume(token.plaintext, validAgentKeys());
  expect(first.status).toBe("pairing");
  await expect(pairing.consume(token.plaintext, validAgentKeys())).rejects.toThrow(
    "PAIRING_TOKEN_INVALID",
  );
});
```

- [ ] **Step 2: Generate agent keys locally**

```rust
pub struct AgentIdentity {
    pub signing: ed25519_dalek::SigningKey,
    pub encryption_secret: x25519_dalek::StaticSecret,
}

impl AgentIdentity {
    pub fn generate(rng: &mut impl rand_core::CryptoRngCore) -> Self {
        Self {
            signing: ed25519_dalek::SigningKey::generate(rng),
            encryption_secret: x25519_dalek::StaticSecret::random_from_rng(rng),
        }
    }
}

pub struct EnvironmentSecrets {
    pub subject_hmac_key: zeroize::Zeroizing<[u8; 32]>,
    pub subject_hmac_key_version: u32,
    pub state_master_key: zeroize::Zeroizing<[u8; 32]>,
}
```

- [ ] **Step 3: Persist generated identity encrypted in the state volume**

```rust
pub fn write_new_encrypted_identity(
    path: &Path,
    encrypted_identity: &[u8],
) -> anyhow::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    std::io::Write::write_all(&mut file, encrypted_identity)?;
    file.sync_all()?;
    Ok(())
}
```

The encryption key comes from a read-only Docker secret. Generated private keys are not written back into the Docker secret mount.

- [ ] **Step 4: Test replacement drain and forced-replacement behavior**

Assertions:

- subject-HMAC output remains identical after ordinary agent replacement,
- replacement is blocked while an envelope or execution attempt is active,
- forced replacement marks affected requests `needs_review`,
- a pending envelope encrypted to a lost X25519 key is never sent to the replacement agent.

Run:

```bash
pnpm --filter @forgetops/api test -- agent-pairing
cargo nextest run -p agent-core identity
```

Expected: one-use token, key validation, stable subject correlation, drain guard, and forced-replacement behavior pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agents apps/api/tests/agent-pairing.test.ts agent
git commit -m "feat: pair and revoke customer agents"
```

---

### Task 7: Build signed agent messages, WebSocket delivery, and polling fallback

**Files:**
- Create: `apps/api/src/modules/agent-gateway/canonical-json.ts`
- Create: `apps/api/src/modules/agent-gateway/message-signer.ts`
- Create: `apps/api/src/modules/agent-gateway/execution-lease-service.ts`
- Create: `apps/api/src/modules/agent-gateway/job-repository.ts`
- Create: `apps/api/src/modules/agent-gateway/websocket.ts`
- Create: `apps/api/src/modules/agent-gateway/polling-routes.ts`
- Create: `apps/api/tests/agent-gateway.test.ts`
- Create: `agent/crates/agent-protocol/src/signing.rs`
- Create: `agent/crates/agent-core/src/connection.rs`
- Test: `agent/crates/agent-protocol/tests/signing.rs`

**Interfaces:**
- Consumes: paired agent keys and shared message schema
- Produces: authenticated at-least-once job delivery, per-direction replay protection, and short-lived online destructive leases

- [ ] **Step 1: Add a cross-language signature fixture test**

```ts
it("verifies the committed Rust-compatible signature fixture", () => {
  const fixture = readFixture("signed-agent-message.json");
  expect(canonicalUnsignedBytes(fixture.message)).toEqual(
    decodeBase64Url(fixture.canonicalBytes),
  );
  expect(verifyAgentMessage(fixture, fixture.publicKey)).toBe(true);
});
```

```rust
#[test]
fn verifies_typescript_signature_fixture() {
    let fixture = load_fixture("signed-control-message.json");
    verify_message(&fixture.message, &fixture.public_key).unwrap();
}
```

Signature material is exactly:

```text
UTF8("forgetops.agent-message.v1") || 0x00 || RFC8785_JCS(unsignedMessage)
```

Do not construct signatures by concatenating individual variable-length fields.

- [ ] **Step 2: Implement job leasing in PostgreSQL**

```sql
update agent_jobs
set leased_by_agent_id = $1,
    lease_expires_at = now() + interval '60 seconds',
    attempt = attempt + 1
where id = $2
  and environment_id = $3
  and exists (
    select 1 from agents
    where agents.id = $1
      and agents.status in ('online', 'outdated')
  )
  and completed_at is null
  and (lease_expires_at is null or lease_expires_at < now())
returning *;
```

- [ ] **Step 3: Implement agent reconnect loop**

```rust
loop {
    match websocket_session(&config, &identity, &job_runner).await {
        Ok(()) => backoff.reset(),
        Err(error) => {
            tracing::warn!(error = %error, "websocket disconnected");
            poll_until_websocket_retry(&config, &identity, &job_runner, backoff.delay()).await?;
        }
    }
}
```

The fallback first closes or invalidates the WebSocket session at the server. WebSocket and polling never lease concurrently for the same agent session.

- [ ] **Step 4: Test duplicate delivery, transport handoff, and expired execution lease**

Expected assertions:

```ts
expect(await jobRunner.executionCount("job_1")).toBe(1);
expect(await leases.leaseExpired("job_2")).toBe(true);
expect(await destructiveScheduler.scheduledAfterPause()).toBe(0);
```

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @forgetops/api test -- agent-gateway
cargo nextest run -p agent-protocol -p agent-core

git add apps/api/src/modules/agent-gateway apps/api/tests/agent-gateway.test.ts agent
git commit -m "feat: deliver signed jobs to outbound agents"
```

---

### Task 8: Implement encrypted subject envelopes and environment-scoped identity binding

**Files:**
- Create: `apps/web/lib/subject-envelope.ts`
- Create: `apps/api/src/modules/privacy-requests/subject-envelope-service.ts`
- Create: `apps/api/tests/subject-envelope.test.ts`
- Create: `apps/api/tests/subject-binding-concurrency.test.ts`
- Create: `agent/crates/agent-core/src/subject.rs`
- Create: `agent/crates/agent-store/src/crypto.rs`
- Test: `agent/crates/agent-core/tests/subject.rs`

**Interfaces:**
- Consumes: agent X25519 public key and job delivery
- Produces: encrypted subject transport, versioned environment subject binding, deterministic duplicate handling, and explicit identity aliases

- [ ] **Step 1: Write browser envelope test**

```ts
it("does not include the plaintext identifier in the serialized envelope", async () => {
  const envelope = await encryptSubject({ email: "canary@example.com" }, publicKey);
  expect(JSON.stringify(envelope)).not.toContain("canary@example.com");
});
```

- [ ] **Step 2: Define canonical identity normalization**

```rust
pub const CANONICALIZATION_VERSION: u32 = 1;

pub fn canonical_identity(subject: &SubjectIdentity) -> anyhow::Result<String> {
    if let Some(application_user_id) = &subject.application_user_id {
        return Ok(format!("app_user_id:{}", application_user_id.trim()));
    }
    if let Some(email) = &subject.email {
        return Ok(format!("email:{}", email.trim().to_lowercase()));
    }
    anyhow::bail!("SUBJECT_IDENTIFIER_REQUIRED")
}
```

- [ ] **Step 3: Compute subject HMAC in the agent**

```rust
pub fn subject_hash(key: &[u8], key_version: u32, canonical: &str) -> SubjectHash {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("valid HMAC key");
    mac.update(canonical.as_bytes());
    SubjectHash {
        value: format!("hmac-sha256:{}", hex::encode(mac.finalize().into_bytes())),
        key_version,
        canonicalization_version: CANONICALIZATION_VERSION,
    }
}
```

- [ ] **Step 4: Add ciphertext cleanup test**

```ts
it("removes the envelope after subject binding", async () => {
  await service.bindSubject("req_1", "hmac-sha256:abc");
  expect(await envelopes.find("req_1")).toBeNull();
});
```

- [ ] **Step 5: Serialize duplicate binding and test owner override**

Use a transaction-scoped advisory lock derived from environment ID, subject hash, and request type. Two concurrent bindings for the same subject produce one active request and one audited duplicate cancellation. An owner override is explicit, versioned, and excluded from the ordinary partial unique index.

- [ ] **Step 6: Run and commit**

```bash
pnpm --filter @forgetops/web test
pnpm --filter @forgetops/api test -- subject-envelope
cargo nextest run -p agent-core -p agent-store

git add apps/web apps/api/src/modules/privacy-requests agent
git commit -m "feat: bind encrypted subject identities in the agent"
```

---

### Task 9: Implement agent local encrypted state and execution DAG

**Files:**
- Create: `agent/crates/agent-store/src/lib.rs`
- Create: `agent/crates/agent-store/src/migrations.rs`
- Create: `agent/crates/agent-core/src/dag.rs`
- Create: `agent/crates/agent-core/src/runner.rs`
- Test: `agent/crates/agent-store/tests/encryption.rs`
- Test: `agent/crates/agent-core/tests/dag.rs`

**Interfaces:**
- Consumes: decrypted subject, plan job, connector descriptors
- Produces: persistent idempotent step scheduler and restart recovery

- [ ] **Step 1: Write encryption-at-rest test**

```rust
#[tokio::test]
async fn sqlite_file_does_not_contain_plaintext_subject() {
    let store = encrypted_test_store().await;
    store.save_subject("req_1", "canary@example.com").await.unwrap();
    let bytes = std::fs::read(store.path()).unwrap();
    assert!(!bytes.windows(b"canary@example.com".len())
        .any(|window| window == b"canary@example.com"));
}
```

- [ ] **Step 2: Define step state and dependencies**

```rust
pub struct ExecutionStep {
    pub id: String,
    pub operation_key: String,
    pub connector: String,
    pub action: StepAction,
    pub dependencies: Vec<String>,
    pub status: StepStatus,
    pub attempts: u8,
    pub desired_state: VerificationExpectation,
}

pub fn runnable<'a>(steps: &'a [ExecutionStep]) -> Vec<&'a ExecutionStep> {
    steps
        .iter()
        .filter(|step| step.status == StepStatus::Pending)
        .filter(|step| {
            step.dependencies.iter().all(|id| {
                steps.iter().any(|candidate| {
                    &candidate.id == id && candidate.satisfies_dependency()
                })
            })
        })
        .collect()
}
```

When a required dependency fails, is skipped incompatibly, or needs review, downstream steps become `blocked` with a normalized reason instead of remaining pending forever.

- [ ] **Step 3: Persist intent before the remote call and reconcile uncertain outcomes**

```rust
store.transaction(|tx| {
    tx.mark_step_prepared(
        &step.id,
        &step.operation_key,
        &step.desired_state,
    )?;
    Ok(())
}).await?;

store.mark_step_in_flight(&step.id).await?;
let call_result = connector.execute(&step, context).await;

let result = match call_result {
    Ok(result) => result,
    Err(error) if error.outcome_is_uncertain() => {
        connector.reconcile(&step, context).await?
    }
    Err(error) => return Err(error.into()),
};

let verification = connector.verify_step(&step, context).await?;
store.transaction(|tx| {
    tx.finish_step_from_verification(&step.id, &result, &verification)?;
    tx.enqueue_progress_event(progress_from(&step, &result, &verification))?;
    Ok(())
}).await?;
```

- [ ] **Step 4: Test restart at every crash boundary**

Run:

```bash
cargo nextest run -p agent-store -p agent-core
```

Expected:

- a `prepared` step may be called safely,
- an `in_flight` step is verified before another mutation call,
- a verified succeeded step is never scheduled again,
- the effective final state changes once even when a non-idempotent transport attempt is uncertain.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-store agent/crates/agent-core
git commit -m "feat: persist encrypted execution graphs in agent"
```

---

### Task 10: Define connector SDK and build the custom TypeScript adapter

**Files:**
- Create: `agent/crates/connector-sdk/src/lib.rs`
- Create: `sdk/typescript/src/contracts.ts`
- Create: `sdk/typescript/src/create-adapter.ts`
- Create: `sdk/typescript/src/signature.ts`
- Create: `sdk/typescript/src/redacting-logger.ts`
- Create: `sdk/typescript/tests/adapter.test.ts`
- Create: `agent/crates/adapter-http/src/lib.rs`
- Test: `agent/crates/adapter-http/tests/protocol.rs`

**Interfaces:**
- Consumes: subject and DAG contracts
- Produces: Rust `Connector` trait and `createForgetOpsAdapter()` TypeScript API

- [ ] **Step 1: Write TypeScript adapter route tests**

```ts
it("rejects an unsigned erase request", async () => {
  const adapter = createTestAdapter();
  const response = await adapter.inject({
    method: "POST",
    url: "/forgetops/v1/erase",
    payload: validErasePayload(),
  });
  expect(response.statusCode).toBe(401);
});
```

- [ ] **Step 2: Define the Rust connector trait**

```rust
#[async_trait::async_trait]
pub trait Connector: Send + Sync {
    fn descriptor(&self) -> ConnectorDescriptor;
    async fn health_check(&self) -> Result<HealthStatus, ConnectorError>;
    async fn discover(&self, subject: &SubjectIdentity, request: &DiscoveryRequest)
        -> Result<DiscoveryResult, ConnectorError>;
    async fn export(&self, subject: &SubjectIdentity, selection: &ExportSelection,
        sink: &mut dyn ExportSink) -> Result<ExportResult, ConnectorError>;
    async fn erase(&self, subject: &SubjectIdentity, plan: &ErasePlan,
        context: &ExecutionContext) -> Result<EraseResult, ConnectorError>;
    async fn verify(&self, subject: &SubjectIdentity,
        expectation: &VerificationExpectation) -> Result<VerificationResult, ConnectorError>;
}
```

- [ ] **Step 3: Implement signed adapter requests**

```ts
export function verifyAdapterSignature(input: {
  secret: Uint8Array;
  method: string;
  normalizedPath: string;
  timestamp: string;
  nonce: string;
  contentType: string;
  body: Uint8Array;
  signature: string;
}): boolean {
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const ageMs = Math.abs(Date.now() - timestampMs);
  if (ageMs > 60_000) return false;
  const envelope = {
    type: "forgetops.adapter-request",
    version: 1,
    method: input.method,
    path: input.normalizedPath,
    timestamp: input.timestamp,
    nonce: input.nonce,
    contentType: input.contentType,
    bodyDigest: `sha256:${sha256(input.body)}`,
  };
  const material = concat(
    utf8("forgetops.adapter-request.v1"),
    new Uint8Array([0]),
    canonicalJsonBytes(envelope),
  );
  const expected = hmacSha256(input.secret, material);
  const received = decodeBase64Url(input.signature);
  return received.length === expected.length
    && timingSafeEqual(expected, received);
}
```

- [ ] **Step 4: Add payload-size, persistent nonce-replay, timestamp, method, and path-binding tests**

Nonce storage survives adapter restart for at least the 60-second acceptance window. Export responses use bounded streaming frames rather than one unbounded JSON body.

Run:

```bash
pnpm --filter @forgetops/adapter test
cargo nextest run -p adapter-http -p connector-sdk
```

- [ ] **Step 5: Commit**

```bash
git add sdk/typescript agent/crates/connector-sdk agent/crates/adapter-http
git commit -m "feat: add custom TypeScript lifecycle adapter"
```

---

### Task 11: Implement the Supabase connector with declarative mappings

**Files:**
- Create: `agent/crates/connector-supabase/src/config.rs`
- Create: `agent/crates/connector-supabase/src/discover.rs`
- Create: `agent/crates/connector-supabase/src/export.rs`
- Create: `agent/crates/connector-supabase/src/erase.rs`
- Create: `agent/crates/connector-supabase/src/verify.rs`
- Create: `agent/crates/connector-supabase/tests/integration.rs`
- Create: `deploy/agent-compose/config/supabase-mapping.example.yaml`

**Interfaces:**
- Consumes: connector SDK and execution context
- Produces: table/storage discovery, export, delete/anonymize, and verification

- [ ] **Step 1: Create a test schema with target and unrelated users**

```sql
create table profiles (
  user_id text primary key,
  email text not null
);
create table documents (
  id uuid primary key,
  owner_id text not null,
  body text not null
);
insert into profiles values ('user_target', 'target@example.com');
insert into profiles values ('user_other', 'other@example.com');
```

- [ ] **Step 2: Write the destructive safety test**

```rust
#[tokio::test]
async fn deletes_target_and_preserves_unrelated_rows() {
    let fixture = SupabaseFixture::new().await;
    let plan = fixture.connector.plan_delete(&fixture.target()).await.unwrap();
    fixture.connector.erase(&fixture.target(), &plan, &fixture.context()).await.unwrap();
    let verification = fixture.connector.verify(&fixture.target(), &plan.expectation()).await.unwrap();
    assert!(verification.satisfied);
    assert_eq!(fixture.count_documents("user_other").await, 1);
}
```

- [ ] **Step 3: Validate allowlisted identifiers before generating SQL**

```rust
fn validate_identifier(value: &str) -> Result<(), ConfigError> {
    let valid = !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !value.starts_with(|c: char| c.is_ascii_digit());
    if valid { Ok(()) } else { Err(ConfigError::InvalidIdentifier(value.into())) }
}
```

Health validation also proves that the configured production database role cannot read or mutate an unmapped table and cannot invoke an unapproved function.

- [ ] **Step 4: Implement export writer paths without subject identifiers**

```text
supabase/profiles/records.json
supabase/documents/records.json
supabase/storage/user-uploads/files/000001.bin
```

- [ ] **Step 5: Inject crashes around remote commit**

Run the delete through three boundaries: before SQL execution, after PostgreSQL commit but before local completion, and after verification. On recovery, the connector verifies final state before deciding whether another mutation is safe.

- [ ] **Step 6: Run integration tests and commit**

```bash
cargo nextest run -p connector-supabase

git add agent/crates/connector-supabase deploy/agent-compose/config
git commit -m "feat: add declarative Supabase lifecycle connector"
```

---

### Task 12: Implement Stripe and Clerk connectors

**Files:**
- Create: `agent/crates/connector-stripe/src/lib.rs`
- Create: `agent/crates/connector-stripe/tests/integration.rs`
- Create: `agent/crates/connector-clerk/src/lib.rs`
- Create: `agent/crates/connector-clerk/tests/integration.rs`

**Interfaces:**
- Consumes: connector SDK
- Produces: Stripe export/retain/anonymize outcomes and Clerk revoke/export/delete/verify flow

- [ ] **Step 1: Write Stripe outcome classification tests**

```rust
#[test]
fn classifies_policy_retention_without_claiming_deletion() {
    let outcome = classify_stripe_resource(ResourceKind::Invoice, &policy_retain_financial());
    assert_eq!(outcome, ProposedAction::RetainByPolicy);
}
```

- [ ] **Step 2: Implement explicit Stripe result states**

```rust
pub enum StripeLifecycleOutcome {
    Deleted,
    Anonymized,
    RetainedByPolicy { category: String },
    Unsupported { reason: String },
    NeedsReview { reason: String },
}
```

- [ ] **Step 3: Write Clerk dependency-order test**

```rust
#[test]
fn clerk_identity_deletion_runs_after_downstream_steps() {
    let graph = build_clerk_delete_graph();
    assert!(graph.depends_on("delete_clerk_identity", "delete_application_data"));
    assert!(graph.depends_on("delete_application_data", "revoke_clerk_sessions"));
}
```

- [ ] **Step 4: Test idempotency and uncertain recovery with fake HTTP servers**

Run:

```bash
cargo nextest run -p connector-stripe -p connector-clerk
```

Expected: rate-limit, permission, unsupported action, remote-idempotency-key replay, uncertain-response reconciliation, and verification tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/connector-stripe agent/crates/connector-clerk
git commit -m "feat: add Stripe and Clerk lifecycle connectors"
```

---

### Task 13: Implement planning projections, approval, and signed execution authorization

**Files:**
- Create: `apps/api/src/modules/execution-plans/plan-service.ts`
- Create: `apps/api/src/modules/approvals/approval-service.ts`
- Create: `apps/signer/src/authorization-policy.ts`
- Create: `apps/signer/src/authorization-signer.ts`
- Create: `apps/signer/src/execution-lease-signer.ts`
- Create: `apps/api/src/modules/privacy-requests/routes.ts`
- Create: `apps/api/tests/approval-authorization.test.ts`
- Create: `agent/crates/agent-core/src/authorization.rs`
- Test: `agent/crates/agent-core/tests/authorization.rs`

**Interfaces:**
- Consumes: domain state machine, agent plan projection, control-plane signing key
- Produces: exact-plan approval evidence, immutable execution attempts, scoped authorization, and short-lived online execution leases

- [ ] **Step 1: Write stale-plan rejection test**

```ts
it("does not issue authorization after connector fingerprint changes", async () => {
  const plan = await fixture.approvedPlan({ connectorFingerprint: "old" });
  await fixture.updateConnectorFingerprint("new");
  await expect(service.authorize(plan.requestId)).rejects.toThrow(
    "PLAN_VERSION_MISMATCH",
  );
});

it("does not issue authorization without current aggregate version and recent approval evidence", async () => {
  await expect(service.authorize({
    requestId: "req_1",
    expectedVersion: 7,
    approvalChallengeId: "stale",
  })).rejects.toThrow("APPROVAL_EVIDENCE_INVALID");
});
```

- [ ] **Step 2: Canonicalize and fingerprint plan**

```ts
export function planFingerprint(plan: SanitizedPlan): string {
  return `sha256:${sha256(canonicalJson(plan))}`;
}
```

- [ ] **Step 3: Sign authorization claims**

```ts
const claims = ExecutionAuthorizationClaimsSchema.parse({
  type: "forgetops.execution-authorization",
  version: 1,
  keyId: signingKey.id,
  issuer: "forgetops-control-plane",
  audience: "forgetops-agent",
  environmentId: request.environmentId,
  agentId: request.agentId,
  requestId: request.id,
  attemptId: attempt.id,
  authorizationKind: attempt.kind,
  planId: plan.id,
  planVersion: plan.version,
  planFingerprint: plan.fingerprint,
  policyVersion: request.policyVersion,
  connectorConfigurationFingerprint: plan.connectorConfigurationFingerprint,
  allowedStepIds: attempt.allowedStepIds,
  approvalEvidenceHash: approval.evidenceHash,
  issuedAt: now.toISOString(),
  notBefore: now.toISOString(),
  expiresAt: addMinutes(now, 30).toISOString(),
  nonce: randomBytes(24).toString("base64url"),
});
return signDomainSeparatedJcs(
  "forgetops.execution-authorization.v1",
  claims,
  signingKey,
);
```

- [ ] **Step 4: Consume nonce when authorizing the local attempt**

```rust
store.transaction(|tx| {
    if tx.nonce_consumed(&claims.nonce)? {
        anyhow::bail!("AUTHORIZATION_ALREADY_CONSUMED");
    }
    tx.consume_nonce(&claims.nonce, &claims.request_id)?;
    tx.mark_attempt_authorized(
        &claims.attempt_id,
        claims.plan_version,
        &claims.allowed_step_ids,
    )?;
    Ok(())
}).await?;
```

- [ ] **Step 5: Issue and verify online execution leases**

The agent requests a lease before scheduling destructive steps. The signer checks current request version, attempt, agent status, connector fingerprint, policy, cancellation, and all kill switches. Lease TTL is at most 90 seconds and lease scope cannot exceed the authorization's `allowedStepIds`.

- [ ] **Step 6: Run and commit**

```bash
pnpm --filter @forgetops/api test -- approval-authorization
cargo nextest run -p agent-core authorization

git add apps/api/src/modules apps/signer apps/api/tests/approval-authorization.test.ts agent/crates/agent-core
git commit -m "feat: authorize exact approved deletion plans"
```

---

### Task 14: Build export archive, encryption, and customer-owned storage delivery

**Files:**
- Create: `agent/crates/export-builder/src/manifest.rs`
- Create: `agent/crates/export-builder/src/archive.rs`
- Create: `agent/crates/export-builder/src/encryption.rs`
- Create: `agent/crates/export-builder/src/key_wrap.rs`
- Create: `agent/crates/export-builder/src/storage.rs`
- Create: `agent/crates/export-builder/tests/export.rs`
- Create: `apps/api/src/modules/exports/export-capability-service.ts`
- Create: `apps/web/app/portal/requests/[id]/download/page.tsx`
- Test: `apps/web/tests/export-download.spec.ts`

**Interfaces:**
- Consumes: connector export sink and browser ephemeral public key
- Produces: bounded chunked encrypted archive, encrypted local key retention, expiring customer-storage link, and on-demand browser data-key envelope

- [ ] **Step 1: Define archive manifest**

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub format_version: String,
    pub request_id: String,
    pub generated_at: String,
    pub connectors: Vec<ConnectorExportSummary>,
    pub files: Vec<ExportFileEntry>,
    pub archive_format: String,
    pub chunk_bytes: u32,
    pub plaintext_bytes: u64,
    pub ciphertext_sha256: String,
}
```

- [ ] **Step 2: Reject unsafe export paths**

```rust
pub fn safe_archive_path(path: &str) -> anyhow::Result<PathBuf> {
    let candidate = Path::new(path);
    if candidate.is_absolute() || candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        anyhow::bail!("UNSAFE_EXPORT_PATH");
    }
    Ok(candidate.to_path_buf())
}
```

- [ ] **Step 3: Stream a versioned chunked encrypted container**

```rust
let mut writer = EncryptedArchiveWriter::new(
    storage_upload,
    ArchiveFormat::ForgetOpsV1,
    random_key_bytes,
    limits.max_archive_bytes,
    limits.chunk_bytes,
    manifest_aad,
)?;
while let Some(chunk) = archive_stream.next().await {
    writer.write_chunk(&chunk?).await?;
}
let upload_result = writer.finish().await?;
store.save_encrypted_archive_key(
    request_id,
    upload_result.key_material,
    archive_expiry,
).await?;
```

- [ ] **Step 4: Wrap the archive key after recent browser reauthentication**

```rust
let sealed_key = wrap_archive_key(
    &encrypted_local_key,
    &browser_public_key,
    KeyWrapContext {
        request_id,
        portal_session_id,
        browser_key_id,
        expires_at,
    },
)?;
```

The wrap format specifies ephemeral X25519 public key, HKDF-SHA-256 context, XChaCha20-Poly1305 nonce, and authenticated data. Losing the browser private key does not require rebuilding the archive; the user reauthenticates and requests a new envelope.

- [ ] **Step 5: Return only capability metadata**

```rust
pub struct ExportCapabilityProjection {
    pub object_key_hash: String,
    pub download_url: String,
    pub expires_at: String,
    pub encrypted_archive_key: String,
    pub archive_size_bytes: u64,
    pub browser_key_id: String,
    pub key_wrap_version: u16,
}
```

- [ ] **Step 6: Test streaming browser download, key loss, and local decryption**

Run:

```bash
cargo nextest run -p export-builder
pnpm --filter @forgetops/web test:e2e -- export-download
```

Expected: archive decrypts through bounded streaming, a new key envelope works after simulated browser-key loss and reauthentication, quota failures clean temporary files, and control-plane logs contain no archive key or file contents.

- [ ] **Step 7: Commit**

```bash
git add agent/crates/export-builder apps/api/src/modules/exports apps/web
git commit -m "feat: deliver encrypted exports from customer storage"
```

---

### Task 15: Build admin dashboard request workflow

**Files:**
- Create: `apps/web/app/(dashboard)/projects/[projectId]/requests/page.tsx`
- Create: `apps/web/app/(dashboard)/requests/[requestId]/page.tsx`
- Create: `apps/web/components/request-status.tsx`
- Create: `apps/web/components/execution-plan.tsx`
- Create: `apps/web/components/approval-form.tsx`
- Create: `apps/web/tests/admin-request.spec.ts`

**Interfaces:**
- Consumes: privacy-request API, plan projection, roles
- Produces: create, review, approve, cancel, retry, and audit UI

- [ ] **Step 1: Write Playwright happy-path test**

```ts
test("admin creates, reviews, and approves a deletion request", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/projects/prj_1/requests");
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByLabel("Request type").selectOption("delete");
  await page.getByLabel("User email").fill("target@example.com");
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByText("Planning")).toBeVisible();
  await seedAgentPlan();
  await page.reload();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await completeReviewerReauthentication(page);
  await expect(page.getByText("Execution authorized")).toBeVisible();
});
```

- [ ] **Step 2: Render plans without raw identifiers**

```tsx
<ExecutionPlan
  steps={plan.steps.map((step) => ({
    connector: step.connectorType,
    resource: step.resourceType,
    action: step.action,
    count: step.estimatedCount,
    risk: step.risk,
  }))}
/>
```

- [ ] **Step 3: Disable approval when plan is expired or user lacks permission**

```tsx
const canApprove = permissions.includes("approve_request")
  && plan.status === "draft"
  && request.version === displayedExpectedVersion
  && new Date(plan.expiresAt) > new Date();
```

The API still enforces permission, expected version, plan fingerprint, approval evidence, and separation of duty. Client-side disabling is only user experience.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @forgetops/web test:e2e -- admin-request

git add apps/web
git commit -m "feat: add admin privacy request dashboard"
```

---

### Task 16: Build end-user portal identity verification

**Files:**
- Create: `apps/api/src/modules/identity-verification/assertion-verifier.ts`
- Create: `apps/api/src/modules/identity-verification/magic-link-service.ts`
- Create: `apps/api/src/modules/privacy-portal/routes.ts`
- Create: `apps/web/app/portal/[projectSlug]/page.tsx`
- Create: `apps/web/app/portal/[projectSlug]/verify/page.tsx`
- Create: `apps/web/app/portal/requests/[id]/page.tsx`
- Create: `apps/web/tests/privacy-portal.spec.ts`
- Modify: `sdk/typescript/src/create-adapter.ts`

**Interfaces:**
- Consumes: customer-signed Clerk reauthentication assertion or adapter magic-link verification
- Produces: request-scoped portal capability without tenant-wide access

- [ ] **Step 1: Define the customer assertion claims**

```ts
export const SubjectAssertionSchema = z.object({
  type: z.literal("forgetops.subject-assertion"),
  version: z.literal(1),
  issuer: z.string().min(1),
  audience: z.literal("forgetops-privacy-portal"),
  keyId: z.string().min(1),
  assertionId: z.string().min(16),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  requestType: z.enum(["delete", "export"]),
  challengeId: z.string().min(16),
  subjectEnvelope: z.string().min(32),
  authenticationMethod: z.literal("clerk_reauthentication"),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(16),
});
```

Verifier rules:

- issuer and key ID must match the project's configured customer identity key,
- audience, project, environment, request type, challenge, and subject envelope are signature-bound,
- assertion TTL is at most five minutes,
- assertion ID and nonce are single use,
- signature input is domain-separated RFC 8785 canonical JSON.

- [ ] **Step 2: Add magic-link adapter callbacks**

```ts
identity: {
  async sendMagicLink({ email, challengeUrl }) {
    await mailer.send({ to: email, template: "privacy-request", challengeUrl });
  },
  async verifyMagicLink({ token }) {
    return tokenStore.consume(token);
  },
}
```

The control plane stores only opaque challenge state. The agent calls the private adapter to send and consume the challenge. Per-identity throttling occurs inside the customer adapter, which can see the identifier; the hosted portal rate-limits by project, IP risk bucket, and opaque challenge rather than a subject hash that does not exist yet.

- [ ] **Step 3: Issue a request-scoped portal token**

```ts
const token = await portalTokens.sign({
  type: "forgetops.portal-capability",
  audience: "forgetops-privacy-portal",
  requestId: request.id,
  projectId: request.projectId,
  portalSessionId: portalSession.id,
  tokenId: randomId(),
  permissions: ["read_status", "download_export"],
  expiresAt: addHours(now, 1),
});
```

Expired portal capability tokens are replaced only after another identity-verification flow. Download capability additionally requires recent reauthentication and a browser public key for on-demand archive-key wrapping.

- [ ] **Step 4: Test that one portal token cannot read another request**

```ts
expect(await getRequestWithToken(tokenForRequestA, requestB.id)).toMatchObject({
  status: 404,
});
```

Also test assertion replay, challenge mismatch, wrong audience, unknown key ID, excessive TTL, portal-token renewal, and magic-link token replay.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @forgetops/api test -- privacy-portal
pnpm --filter @forgetops/web test:e2e -- privacy-portal

git add apps/api/src/modules/identity-verification apps/api/src/modules/privacy-portal apps/web sdk/typescript
git commit -m "feat: add verified end-user privacy portal"
```

---

### Task 17: Complete audit evidence, notifications, SSRF-safe webhooks, and retry UI

**Files:**
- Create: `packages/domain/src/audit/canonical-event.ts`
- Create: `packages/domain/src/audit/hash-chain.ts`
- Create: `apps/worker/src/jobs/outbox.ts`
- Create: `apps/worker/src/jobs/notifications.ts`
- Create: `apps/worker/src/jobs/webhooks.ts`
- Create: `apps/worker/src/security/webhook-destination.ts`
- Create: `apps/api/src/modules/audit/routes.ts`
- Create: `apps/api/src/modules/retries/routes.ts`
- Create: `apps/web/components/audit-timeline.tsx`
- Test: `packages/domain/tests/audit-chain.test.ts`
- Test: `apps/worker/tests/outbox.test.ts`

**Interfaces:**
- Consumes: domain events and sanitized step progress
- Produces: audit-chain verification and signed daily heads, deadline notifications, SSRF-safe customer webhooks, and attempt-scoped failed-step retry

- [ ] **Step 1: Write audit tamper-detection test**

```ts
it("detects a modified event payload", () => {
  const chain = buildChain([event("created"), event("planning")]);
  chain[0].metadata.status = "executing";
  expect(verifyChain(chain)).toEqual({ valid: false, brokenAt: chain[0].id });
});
```

- [ ] **Step 2: Implement outbox claim and signed daily heads**

```sql
select * from outbox_events
where published_at is null
order by occurred_at
for update skip locked
limit 100;
```

Audit event insertion and chain-head serialization already belong to Task 4. This task verifies full chains and signs daily heads with a key and key purpose distinct from execution authorization.

- [ ] **Step 3: Sign customer webhooks**

```ts
const signature = hmacSha256(
  webhookSecret,
  concat(
    utf8("forgetops.webhook.v1"),
    new Uint8Array([0]),
    canonicalJsonBytes({ timestamp, deliveryId, payload }),
  ),
);
```

Before every connection and redirect, resolve and reject loopback, link-local, metadata, multicast, and private IP targets unless an explicit tenant egress policy allows them. Revalidate after DNS resolution to prevent rebinding. Enforce HTTPS, redirect, response-size, and timeout limits.

- [ ] **Step 4: Retry only selected failed steps with a new signed authorization**

```ts
const retryPlan = plan.selectSteps(command.stepIds);
assertEveryStepRetryable(retryPlan);
const attempt = executionAttempts.createRetry({
  requestId: request.id,
  planId: plan.id,
  planVersion: plan.version,
  allowedStepIds: retryPlan.stepIds,
});
return authorizationService.signRetry(request, attempt, retryPlan);
```

The retry claim contains `attemptId`, `authorizationKind: "retry"`, and exactly `allowedStepIds`. It cannot authorize the full original plan.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @forgetops/domain test -- audit-chain
pnpm --filter @forgetops/worker test
pnpm --filter @forgetops/api test -- retries

git add packages/domain apps/worker apps/api apps/web
git commit -m "feat: add audit chain notifications webhooks and retries"
```

---

### Task 18: Add observability, PII guards, Docker Compose, and operational kill switches

**Files:**
- Create: `packages/observability/src/logger.ts`
- Create: `packages/observability/src/pii-guard.ts`
- Create: `packages/observability/tests/pii-guard.test.ts`
- Create: `agent/crates/agent-core/src/redaction.rs`
- Create: `agent/crates/agent-core/tests/redaction.rs`
- Create: `deploy/agent-compose/docker-compose.yml`
- Create: `deploy/agent-compose/config/agent.example.yaml`
- Create: `deploy/control-plane/docker-compose.yml`
- Create: `apps/api/src/modules/operations/kill-switch.ts`
- Create: `apps/api/tests/kill-switch.test.ts`
- Create: `apps/signer/tests/pause-enforcement.test.ts`

**Interfaces:**
- Consumes: every application and agent log call
- Produces: sanitized telemetry, deployable Compose stacks, and execution pause controls

- [ ] **Step 1: Write PII canary tests**

```ts
it("emits only allowlisted telemetry fields and redacts sensitive values", () => {
  const output = captureLog(() =>
    logger.info({
      email: "canary@example.com",
      requestId: "req_1",
      accessToken: "secret-canary",
      unexpectedField: "must-not-escape",
    }, "test"),
  );
  expect(output).not.toContain("canary@example.com");
  expect(output).not.toContain("secret-canary");
  expect(output).not.toContain("must-not-escape");
  expect(output).toContain("req_1");
});
```

- [ ] **Step 2: Block authorization and execution-lease issuance or renewal when a kill switch is active**

```ts
if (await killSwitch.isExecutionPaused()) {
  throw new ServiceUnavailableError("EXECUTION_GLOBALLY_PAUSED");
}
```

The isolated signer applies this check before signing an authorization and before issuing or renewing an execution lease. The API cannot bypass the check by calling a generic signing primitive. Tests assert that an already started connector call may finish, while no new destructive step starts after the current lease expires (at most 90 seconds).

- [ ] **Step 3: Harden agent container**

```yaml
image: ghcr.io/example/forgetops-agent@sha256:<pinned-digest>
read_only: true
cap_drop: ["ALL"]
security_opt:
  - no-new-privileges:true
tmpfs:
  - /tmp:size=256m,mode=0700
secrets:
  - agent_pairing_token
```

Do not publish an agent port. Keep generated identity state in an encrypted, fsync-safe volume; mount only read-only configuration and task-specific secrets. The control-plane stack includes the signer as a separately permissioned service.

- [ ] **Step 4: Verify Compose health**

Run:

```bash
docker compose -f deploy/control-plane/docker-compose.yml up -d --build
docker compose -f deploy/agent-compose/docker-compose.yml up -d --build
curl --fail http://localhost:3001/health/ready
docker compose -f deploy/agent-compose/docker-compose.yml exec -T agent \
  /usr/local/bin/forgetops-agent healthcheck
```

Expected: control plane, signer, and agent report healthy; the agent has no published inbound port and is reachable only through its outbound control channel.

- [ ] **Step 5: Commit**

```bash
git add packages/observability agent deploy apps/api/src/modules/operations apps/api/tests/kill-switch.test.ts
git commit -m "feat: harden deployment and prevent PII telemetry leaks"
```

---

### Task 19: Build the full end-to-end safety suite and release pipeline

**Files:**
- Create: `packages/testing/src/stack.ts`
- Create: `tests/e2e/delete-request.test.ts`
- Create: `tests/e2e/export-request.test.ts`
- Create: `tests/e2e/agent-restart.test.ts`
- Create: `tests/e2e/control-plane-disconnect.test.ts`
- Create: `tests/e2e/execution-lease-revocation.test.ts`
- Create: `tests/e2e/agent-replacement.test.ts`
- Create: `tests/e2e/audit-concurrency.test.ts`
- Create: `tests/e2e/export-key-loss.test.ts`
- Create: `tests/e2e/pii-log-canary.test.ts`
- Create: `.github/workflows/release-agent.yml`
- Create: `.github/workflows/release-control-plane.yml`
- Create: `docs/runbooks/global-execution-pause.md`
- Create: `docs/runbooks/agent-compromise.md`
- Create: `docs/runbooks/restore-control-plane.md`

**Interfaces:**
- Consumes: complete MVP
- Produces: reproducible safety evidence and signed release artifacts

- [ ] **Step 1: Build a disposable E2E stack**

```ts
const stack = await ForgetOpsTestStack.start({
  postgres: true,
  redis: true,
  objectStorage: true,
  fakeStripe: true,
  fakeClerk: true,
  customAdapter: true,
  rustAgent: true,
});
```

- [ ] **Step 2: Test deletion target and non-target invariants**

```ts
expect(await stack.supabase.count("documents", { owner_id: "target" })).toBe(0);
expect(await stack.supabase.count("documents", { owner_id: "other" })).toBe(1);
expect(await stack.controlPlane.searchLogs("target@example.com")).toHaveLength(0);
```

- [ ] **Step 3: Test restart and disconnect recovery**

```ts
await stack.agent.killDuringStep("delete_documents");
await stack.agent.restart();
await stack.waitForRequest("req_1", "completed");
expect(await stack.supabase.count("documents", { owner_id: "target" })).toBe(0);
expect(await stack.request("req_1")).toMatchObject({
  status: "completed",
  currentAttempt: 1,
});
```

The assertion is the verified final state, not an exactly-once remote-call count. Repeat the test at each crash boundary: intent persisted, call started, response received, verification started, and local commit. An uncertain step must reconcile or require review before a retry is allowed.

- [ ] **Step 4: Test revocation, replacement, retry scope, audit concurrency, and export-key loss**

Required evidence:

- Global pause, agent revocation, request cancellation, connector change, and policy change prevent the next destructive step no later than the active lease's 90-second expiry.
- A replaced agent is drained before takeover; a forced replacement moves in-flight requests to `needs_review`.
- A retry authorization names a new immutable `attemptId` and only failed or blocked `allowedStepIds`.
- Concurrent audit writers produce a continuous, uniquely sequenced hash chain.
- Losing the browser private key requires reauthentication and a new key wrap; the encrypted export remains unchanged and the server never receives plaintext.

- [ ] **Step 5: Add pinned, signed release images**

```yaml
- name: Build image
  run: docker build -t ghcr.io/${{ github.repository }}/agent:${{ github.sha }} -f agent/Dockerfile .
- name: Push image
  run: docker push ghcr.io/${{ github.repository }}/agent:${{ github.sha }}
- name: Sign image
  run: cosign sign --yes ghcr.io/${{ github.repository }}/agent:${{ github.sha }}
- name: Verify image
  run: cosign verify --certificate-identity-regexp '^https://github.com/.+/.github/workflows/release-agent.yml@refs/tags/.+$' ghcr.io/${{ github.repository }}/agent:${{ github.sha }}
```

Pin third-party workflow actions and release tool images by immutable commit or digest. Generate an SBOM and provenance attestation, verify both before promotion, and deploy production Compose files with digests rather than mutable tags.

- [ ] **Step 6: Run the release gate**

```bash
pnpm test
cargo nextest run --workspace
pnpm exec playwright test
pnpm build
docker compose -f deploy/control-plane/docker-compose.yml config
docker compose -f deploy/agent-compose/docker-compose.yml config
```

Expected: all unit, contract, integration, security, migration, architecture-boundary, concurrency, load (1,000 connected agents), and E2E tests pass.

- [ ] **Step 7: Rehearse the global pause runbook**

Expected result:

```text
- Existing planning jobs continue.
- No new execution authorization is issued.
- No new execution lease is issued or renewed.
- Already-started connector calls may finish; no new destructive step starts after the current lease expires.
- Agents reject unsigned manual delete attempts.
- Dashboard displays execution paused.
- Audit event GlobalExecutionPaused is recorded.
```

- [ ] **Step 8: Commit**

```bash
git add tests packages/testing .github/workflows docs/runbooks
git commit -m "test: add ForgetOps destructive-operation release gates"
```

---

## Implementation sequence and review gates

| Gate | Tasks | Working deliverable |
|---|---|---|
| S0 | Pre-implementation | Threat boundary, state machine, canonical signing bytes, key lifecycle, and crash-recovery contracts approved |
| G1 | 1-4 | Tested state machine and persistent metadata core |
| G2 | 5-9 | Tenant-isolated control plane and secure connected agent |
| G3 | 10-12 | Custom, Supabase, Stripe, and Clerk connectors |
| G4 | 13-14 | Approved deletion and encrypted export delivery |
| G5 | 15-17 | Admin dashboard, end-user portal, audit, and retries |
| G6 | 18-19 | Production hardening and release safety evidence |

Do not start implementation until S0 is approved. Do not start G4 destructive production work until G1-G3 tests pass in CI. Do not onboard a production pilot until G6 passes, the global execution pause has been rehearsed, and the release digest and provenance have been verified.

## Spec coverage self-review

- Hosted control plane and Rust agent: Tasks 1, 6-9
- Clean Architecture dependency direction and composition roots: Tasks 1, 5
- Request state machine, immutable execution attempts, and split orchestration: Tasks 3, 7, 9, 13, 17
- Tenant/project/environment/RBAC: Task 5
- Raw identity isolation, stable versioned environment HMAC keys, and duplicate-binding serialization: Tasks 6, 8
- Supabase, Stripe, Clerk, custom adapter: Tasks 10-12
- Dry-run, reauthenticated approval, exact-plan authorization, and online execution leases: Tasks 13, 18
- Encrypted, bounded-stream customer-owned export and on-demand browser key wrapping: Task 14
- Admin and end-user request creation: Tasks 15-16
- Partial failure, uncertain-effect reconciliation, immutable retry attempts, and scoped retry authorization: Tasks 9, 13, 17, 19
- Serialized audit chain, notifications, and SSRF-safe signed webhooks: Tasks 4, 17, 19
- PII-safe operations and Docker Compose: Task 18
- Revocation bounds, replacement behavior, signed immutable releases, and destructive safety gates: Tasks 18-19

Any behavior not explicitly covered by these tasks inherits the normative contracts in `docs/architecture/11-implementation-readiness-contracts.md`; a contradiction blocks the relevant gate rather than becoming an implementation choice.
