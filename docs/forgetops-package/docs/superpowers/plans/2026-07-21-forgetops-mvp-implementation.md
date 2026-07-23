# ForgetOps MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ForgetOps MVP with a hosted TypeScript control plane, a self-hosted Rust agent, official Supabase/Stripe/Clerk connectors, a TypeScript custom adapter, approved delete workflows, and encrypted customer-owned export delivery.

**Architecture:** The control plane is a modular monolith deployed as web, API, and worker processes over PostgreSQL and Redis. The Rust agent keeps raw identities, connector credentials, discovery results, execution DAGs, and export contents in the customer environment. Control-plane commands and agent messages are signed; deletion requires an authorization bound to the exact approved plan.

**Tech Stack:** TypeScript, Node.js 22+, pnpm, Next.js, Fastify, Zod, Drizzle ORM, PostgreSQL, Redis, BullMQ, Vitest, Playwright, Testcontainers, Rust stable 1.85+, Tokio, serde, sqlx/SQLite, reqwest, tokio-tungstenite, ed25519-dalek, x25519-dalek, chacha20poly1305, cargo-nextest, Docker Compose.

## Global Constraints

- The control plane must never persist raw end-user identifiers, connector credentials, record contents, export contents, or archive encryption keys in plaintext.
- Production deletion requires a signed, unexpired authorization bound to environment ID, agent ID, request ID, plan version, plan fingerprint, and single-use nonce.
- Every mutating API and every connector step must be idempotent.
- Staging and production are isolated by separate environment IDs, keys, agents, connector configuration, and subject hashes.
- Every destructive connector capability must provide verification.
- Cross-service deletion rollback is not promised; partial completion is represented explicitly.
- The MVP supports one active agent per environment, at most five projects per tenant, and about 1,000 privacy requests per month.
- Use fixed roles: owner, admin, reviewer.
- Use Docker Compose for customer agent deployment; do not add Kubernetes support.
- Follow TDD for state transitions, signatures, connector behavior, and destructive operations.

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
  packages/
    contracts/
      src/
      fixtures/
    domain/
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
- Create: `packages/contracts/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/database/package.json`
- Create: `sdk/typescript/package.json`
- Test: `packages/domain/tests/smoke.test.ts`
- Test: `agent/crates/agent-core/tests/smoke.rs`

**Interfaces:**
- Consumes: none
- Produces: repeatable TypeScript and Rust build/test commands used by every later task

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
- Create: `packages/contracts/tests/contracts.test.ts`
- Create: `agent/crates/agent-protocol/src/lib.rs`
- Create: `agent/crates/agent-protocol/tests/fixtures.rs`

**Interfaces:**
- Consumes: workspace from Task 1
- Produces: `PrivacyRequestStatusSchema`, `AgentMessageSchema`, `ExecutionAuthorizationClaimsSchema`, Rust equivalents, and cross-language fixtures

- [ ] **Step 1: Write failing TypeScript contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  AgentMessageSchema,
  ExecutionAuthorizationClaimsSchema,
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
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
]);

export const ExecutionAuthorizationClaimsSchema = z.object({
  issuer: z.literal("forgetops-control-plane"),
  environmentId: z.string().min(1),
  agentId: z.string().min(1),
  requestId: z.string().min(1),
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  planFingerprint: z.string().regex(/^sha256:/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(16),
});

export const AgentMessageSchema = z.object({
  protocolVersion: z.literal("1.0"),
  messageType: z.string().min(1),
  messageId: z.string().min(1),
  environmentId: z.string().min(1),
  agentId: z.string().min(1),
  sequence: z.string().regex(/^\d+$/),
  sentAt: z.string().datetime(),
  payload: z.unknown(),
  signature: z.string().min(32),
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
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAuthorizationClaims {
    pub issuer: String,
    pub environment_id: String,
    pub agent_id: String,
    pub request_id: String,
    pub plan_id: String,
    pub plan_version: u32,
    pub plan_fingerprint: String,
    pub issued_at: String,
    pub expires_at: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub protocol_version: String,
    pub message_type: String,
    pub message_id: String,
    pub environment_id: String,
    pub agent_id: String,
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

Expected: both runtimes parse the committed fixtures with identical field names.

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
  identity_verification_pending: ["identity_verified", "cancelled"],
  identity_verified: ["planning"],
  planning: ["awaiting_approval", "execution_authorized", "failed"],
  awaiting_approval: ["execution_authorized", "cancelled"],
  execution_authorized: ["executing", "cancelled"],
  executing: ["completed", "partially_completed", "failed"],
  completed: [],
  partially_completed: [],
  failed: [],
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
- Create: `packages/database/src/unit-of-work.ts`
- Create: `packages/database/migrations/0001_initial.sql`
- Create: `packages/database/tests/privacy-request-repository.test.ts`
- Create: `packages/database/tests/tenant-isolation.test.ts`

**Interfaces:**
- Consumes: domain aggregate and events from Task 3
- Produces: transactional persistence with audit event and outbox insertion

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

create unique index privacy_requests_idempotency_uq
  on privacy_requests(environment_id, idempotency_key);

create unique index privacy_requests_one_active_subject_type_uq
  on privacy_requests(environment_id, subject_hash, type)
  where subject_hash is not null
    and status not in ('completed', 'partially_completed', 'failed', 'cancelled');
```

- [ ] **Step 3: Implement one transaction for request, audit, and outbox**

```ts
await db.transaction(async (tx) => {
  await upsertPrivacyRequest(tx, aggregate.snapshot());
  for (const event of aggregate.pullEvents()) {
    const audit = auditEventFromDomainEvent(event, previousHash);
    await tx.insert(auditEvents).values(audit);
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

- [ ] **Step 4: Run database tests**

```bash
pnpm --filter @forgetops/database test
```

Expected: real PostgreSQL tests pass and transaction rollback leaves no partial rows.

- [ ] **Step 5: Commit**

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
- Test: `apps/api/tests/tenant-project-environment.test.ts`

**Interfaces:**
- Consumes: database and shared IDs
- Produces: tenant-scoped request context and role checks for later API routes

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
- Create: `agent/bin/forgetops-agent/src/pair.rs`
- Test: `agent/crates/agent-core/tests/identity.rs`

**Interfaces:**
- Consumes: environment authorization and protocol contracts
- Produces: paired agent identity with Ed25519 and X25519 public keys

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
    pub subject_hmac_key: [u8; 32],
}

impl AgentIdentity {
    pub fn generate(rng: &mut impl rand_core::CryptoRngCore) -> Self {
        Self {
            signing: ed25519_dalek::SigningKey::generate(rng),
            encryption_secret: x25519_dalek::StaticSecret::random_from_rng(rng),
            subject_hmac_key: rand::random(),
        }
    }
}
```

- [ ] **Step 3: Persist private material with owner-only permissions**

```rust
pub fn write_secret(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    std::io::Write::write_all(&mut file, bytes)?;
    Ok(())
}
```

- [ ] **Step 4: Test production replacement requires owner confirmation**

Run:

```bash
pnpm --filter @forgetops/api test -- agent-pairing
cargo nextest run -p agent-core identity
```

Expected: one-use token, key validation, and replacement guard pass.

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
- Create: `apps/api/src/modules/agent-gateway/job-repository.ts`
- Create: `apps/api/src/modules/agent-gateway/websocket.ts`
- Create: `apps/api/src/modules/agent-gateway/polling-routes.ts`
- Create: `apps/api/tests/agent-gateway.test.ts`
- Create: `agent/crates/agent-protocol/src/signing.rs`
- Create: `agent/crates/agent-core/src/connection.rs`
- Test: `agent/crates/agent-protocol/tests/signing.rs`

**Interfaces:**
- Consumes: paired agent keys and shared message schema
- Produces: authenticated at-least-once job delivery with leasing

- [ ] **Step 1: Add a cross-language signature fixture test**

```ts
it("verifies the committed Rust-compatible signature fixture", () => {
  const fixture = readFixture("signed-agent-message.json");
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

- [ ] **Step 2: Implement job leasing in PostgreSQL**

```sql
update agent_jobs
set leased_by_agent_id = $1,
    lease_expires_at = now() + interval '60 seconds',
    attempt = attempt + 1
where id = $2
  and environment_id = $3
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

- [ ] **Step 4: Test duplicate delivery and expired lease**

Expected assertions:

```ts
expect(await jobRunner.executionCount("job_1")).toBe(1);
expect(await leases.leaseExpired("job_2")).toBe(true);
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
- Create: `agent/crates/agent-core/src/subject.rs`
- Create: `agent/crates/agent-store/src/crypto.rs`
- Test: `agent/crates/agent-core/tests/subject.rs`

**Interfaces:**
- Consumes: agent X25519 public key and job delivery
- Produces: encrypted subject transport and control-plane-visible subject HMAC

- [ ] **Step 1: Write browser envelope test**

```ts
it("does not include the plaintext identifier in the serialized envelope", async () => {
  const envelope = await encryptSubject({ email: "canary@example.com" }, publicKey);
  expect(JSON.stringify(envelope)).not.toContain("canary@example.com");
});
```

- [ ] **Step 2: Define canonical identity normalization**

```rust
pub fn canonical_identity(subject: &SubjectIdentity) -> anyhow::Result<String> {
    if let Some(user_id) = &subject.user_id {
        return Ok(format!("user_id:{}", user_id.trim()));
    }
    if let Some(email) = &subject.email {
        return Ok(format!("email:{}", email.trim().to_lowercase()));
    }
    anyhow::bail!("SUBJECT_IDENTIFIER_REQUIRED")
}
```

- [ ] **Step 3: Compute subject HMAC in the agent**

```rust
pub fn subject_hash(key: &[u8], canonical: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("valid HMAC key");
    mac.update(canonical.as_bytes());
    format!("hmac-sha256:{}", hex::encode(mac.finalize().into_bytes()))
}
```

- [ ] **Step 4: Add ciphertext cleanup test**

```ts
it("removes the envelope after subject binding", async () => {
  await service.bindSubject("req_1", "hmac-sha256:abc");
  expect(await envelopes.find("req_1")).toBeNull();
});
```

- [ ] **Step 5: Run and commit**

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
}

pub fn runnable<'a>(steps: &'a [ExecutionStep]) -> Vec<&'a ExecutionStep> {
    steps
        .iter()
        .filter(|step| step.status == StepStatus::Pending)
        .filter(|step| {
            step.dependencies.iter().all(|id| {
                steps.iter().any(|candidate| {
                    &candidate.id == id && candidate.status == StepStatus::Succeeded
                })
            })
        })
        .collect()
}
```

- [ ] **Step 3: Persist operation completion before acknowledging job progress**

```rust
let result = connector.execute(&step, context).await?;
store.transaction(|tx| {
    tx.mark_step_succeeded(&step.id, &result)?;
    tx.enqueue_progress_event(progress_from(&step, &result))?;
    Ok(())
}).await?;
```

- [ ] **Step 4: Test restart recovery and duplicate operation key**

Run:

```bash
cargo nextest run -p agent-store -p agent-core
```

Expected: after reopening SQLite, succeeded steps are not scheduled again.

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
  timestamp: string;
  nonce: string;
  body: Uint8Array;
  signature: string;
}): boolean {
  const ageMs = Math.abs(Date.now() - Date.parse(input.timestamp));
  if (ageMs > 60_000) return false;
  const material = concat(input.timestamp, input.nonce, sha256(input.body));
  return timingSafeEqual(hmacSha256(input.secret, material), decode(input.signature));
}
```

- [ ] **Step 4: Add payload-size and nonce-replay tests**

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

- [ ] **Step 4: Implement export writer paths without subject identifiers**

```text
supabase/profiles/records.json
supabase/documents/records.json
supabase/storage/user-uploads/files/000001.bin
```

- [ ] **Step 5: Run integration tests and commit**

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

- [ ] **Step 4: Test remote failures with fake HTTP servers**

Run:

```bash
cargo nextest run -p connector-stripe -p connector-clerk
```

Expected: rate-limit, permission, unsupported action, idempotent replay, and verification tests pass.

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
- Create: `apps/api/src/modules/authorizations/authorization-signer.ts`
- Create: `apps/api/src/modules/privacy-requests/routes.ts`
- Create: `apps/api/tests/approval-authorization.test.ts`
- Create: `agent/crates/agent-core/src/authorization.rs`
- Test: `agent/crates/agent-core/tests/authorization.rs`

**Interfaces:**
- Consumes: domain state machine, agent plan projection, control-plane signing key
- Produces: exact-plan approval and single-use execution authorization

- [ ] **Step 1: Write stale-plan rejection test**

```ts
it("does not issue authorization after connector fingerprint changes", async () => {
  const plan = await fixture.approvedPlan({ connectorFingerprint: "old" });
  await fixture.updateConnectorFingerprint("new");
  await expect(service.authorize(plan.requestId)).rejects.toThrow(
    "PLAN_VERSION_MISMATCH",
  );
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
  issuer: "forgetops-control-plane",
  environmentId: request.environmentId,
  agentId: request.agentId,
  requestId: request.id,
  planId: plan.id,
  planVersion: plan.version,
  planFingerprint: plan.fingerprint,
  issuedAt: now.toISOString(),
  expiresAt: addMinutes(now, 30).toISOString(),
  nonce: randomBytes(24).toString("base64url"),
});
return signCanonicalJson(claims, signingKey);
```

- [ ] **Step 4: Consume nonce before destructive scheduling**

```rust
store.transaction(|tx| {
    if tx.nonce_consumed(&claims.nonce)? {
        anyhow::bail!("AUTHORIZATION_ALREADY_CONSUMED");
    }
    tx.consume_nonce(&claims.nonce, &claims.request_id)?;
    tx.mark_execution_authorized(&claims.request_id, claims.plan_version)?;
    Ok(())
}).await?;
```

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @forgetops/api test -- approval-authorization
cargo nextest run -p agent-core authorization

git add apps/api/src/modules apps/api/tests/approval-authorization.test.ts agent/crates/agent-core
git commit -m "feat: authorize exact approved deletion plans"
```

---

### Task 14: Build export archive, encryption, and customer-owned storage delivery

**Files:**
- Create: `agent/crates/export-builder/src/manifest.rs`
- Create: `agent/crates/export-builder/src/archive.rs`
- Create: `agent/crates/export-builder/src/encryption.rs`
- Create: `agent/crates/export-builder/src/storage.rs`
- Create: `agent/crates/export-builder/tests/export.rs`
- Create: `apps/api/src/modules/exports/export-capability-service.ts`
- Create: `apps/web/app/portal/requests/[id]/download/page.tsx`
- Test: `apps/web/tests/export-download.spec.ts`

**Interfaces:**
- Consumes: connector export sink and browser ephemeral public key
- Produces: encrypted archive, expiring customer-storage link, and encrypted data-key envelope

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

- [ ] **Step 3: Encrypt archive and seal the data key**

```rust
let data_key = chacha20poly1305::Key::from_slice(&random_key_bytes);
let cipher = XChaCha20Poly1305::new(data_key);
let ciphertext = cipher.encrypt(&nonce, archive_bytes.as_ref())?;
let sealed_key = seal_to_browser_public_key(&random_key_bytes, browser_public_key)?;
```

- [ ] **Step 4: Upload and return only capability metadata**

```rust
pub struct ExportCapabilityProjection {
    pub object_key_hash: String,
    pub download_url: String,
    pub expires_at: String,
    pub encrypted_archive_key: String,
    pub archive_size_bytes: u64,
}
```

- [ ] **Step 5: Test browser download and local decryption**

Run:

```bash
cargo nextest run -p export-builder
pnpm --filter @forgetops/web test:e2e -- export-download
```

Expected: archive decrypts in browser test; control-plane logs do not contain archive key or file contents.

- [ ] **Step 6: Commit**

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
  && new Date(plan.expiresAt) > new Date();
```

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
  issuer: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  subjectEnvelope: z.string().min(32),
  authenticationMethod: z.literal("clerk_reauthentication"),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(16),
});
```

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

- [ ] **Step 3: Issue a request-scoped portal token**

```ts
const token = await portalTokens.sign({
  requestId: request.id,
  projectId: request.projectId,
  permissions: ["read_status", "download_export"],
  expiresAt: addHours(now, 1),
});
```

- [ ] **Step 4: Test that one portal token cannot read another request**

```ts
expect(await getRequestWithToken(tokenForRequestA, requestB.id)).toMatchObject({
  status: 404,
});
```

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @forgetops/api test -- privacy-portal
pnpm --filter @forgetops/web test:e2e -- privacy-portal

git add apps/api/src/modules/identity-verification apps/api/src/modules/privacy-portal apps/web sdk/typescript
git commit -m "feat: add verified end-user privacy portal"
```

---

### Task 17: Implement audit chain, notifications, webhooks, and retry UI

**Files:**
- Create: `packages/domain/src/audit/canonical-event.ts`
- Create: `packages/domain/src/audit/hash-chain.ts`
- Create: `apps/worker/src/jobs/outbox.ts`
- Create: `apps/worker/src/jobs/notifications.ts`
- Create: `apps/worker/src/jobs/webhooks.ts`
- Create: `apps/api/src/modules/audit/routes.ts`
- Create: `apps/api/src/modules/retries/routes.ts`
- Create: `apps/web/components/audit-timeline.tsx`
- Test: `packages/domain/tests/audit-chain.test.ts`
- Test: `apps/worker/tests/outbox.test.ts`

**Interfaces:**
- Consumes: domain events and sanitized step progress
- Produces: tamper-evident audit history, deadline notifications, customer webhooks, and failed-step retry command

- [ ] **Step 1: Write audit tamper-detection test**

```ts
it("detects a modified event payload", () => {
  const chain = buildChain([event("created"), event("planning")]);
  chain[0].metadata.status = "executing";
  expect(verifyChain(chain)).toEqual({ valid: false, brokenAt: chain[0].id });
});
```

- [ ] **Step 2: Implement outbox claim with skip locked**

```sql
select * from outbox_events
where published_at is null
order by occurred_at
for update skip locked
limit 100;
```

- [ ] **Step 3: Sign customer webhooks**

```ts
const signature = hmacSha256(
  webhookSecret,
  `${timestamp}.${deliveryId}.${JSON.stringify(payload)}`,
);
```

- [ ] **Step 4: Retry only selected failed steps with a new signed authorization**

```ts
const retryPlan = plan.selectSteps(command.stepIds);
assertEveryStepRetryable(retryPlan);
return authorizationService.signRetry(request, retryPlan);
```

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

**Interfaces:**
- Consumes: every application and agent log call
- Produces: sanitized telemetry, deployable Compose stacks, and execution pause controls

- [ ] **Step 1: Write PII canary tests**

```ts
it("redacts email-like and configured sensitive values", () => {
  const output = captureLog(() =>
    logger.info({ email: "canary@example.com", requestId: "req_1" }, "test"),
  );
  expect(output).not.toContain("canary@example.com");
  expect(output).toContain("req_1");
});
```

- [ ] **Step 2: Block authorization issuance when kill switch is active**

```ts
if (await killSwitch.isExecutionPaused()) {
  throw new ServiceUnavailableError("EXECUTION_GLOBALLY_PAUSED");
}
```

- [ ] **Step 3: Harden agent container**

```yaml
read_only: true
cap_drop: ["ALL"]
security_opt:
  - no-new-privileges:true
tmpfs:
  - /tmp:size=256m,mode=0700
```

- [ ] **Step 4: Verify Compose health**

Run:

```bash
docker compose -f deploy/control-plane/docker-compose.yml up -d --build
docker compose -f deploy/agent-compose/docker-compose.yml up -d --build
curl --fail http://localhost:3001/health/ready
```

Expected: control plane and agent report healthy; agent has no public inbound port.

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
expect(await stack.operationCount("delete_documents")).toBe(1);
```

- [ ] **Step 4: Add agent image signing**

```yaml
- name: Build image
  run: docker build -t ghcr.io/${{ github.repository }}/agent:${{ github.sha }} -f agent/Dockerfile .
- name: Push image
  run: docker push ghcr.io/${{ github.repository }}/agent:${{ github.sha }}
- name: Sign image
  run: cosign sign --yes ghcr.io/${{ github.repository }}/agent:${{ github.sha }}
```

- [ ] **Step 5: Run the release gate**

```bash
pnpm test
cargo nextest run --workspace
pnpm exec playwright test
pnpm build
docker compose -f deploy/control-plane/docker-compose.yml config
docker compose -f deploy/agent-compose/docker-compose.yml config
```

Expected: all unit, contract, integration, security, and E2E tests pass.

- [ ] **Step 6: Rehearse the global pause runbook**

Expected result:

```text
- Existing planning jobs continue.
- No new execution authorization is issued.
- Agents reject unsigned manual delete attempts.
- Dashboard displays execution paused.
- Audit event GlobalExecutionPaused is recorded.
```

- [ ] **Step 7: Commit**

```bash
git add tests packages/testing .github/workflows docs/runbooks
git commit -m "test: add ForgetOps destructive-operation release gates"
```

---

## Implementation sequence and review gates

| Gate | Tasks | Working deliverable |
|---|---|---|
| G1 | 1-4 | Tested state machine and persistent metadata core |
| G2 | 5-9 | Tenant-isolated control plane and secure connected agent |
| G3 | 10-12 | Custom, Supabase, Stripe, and Clerk connectors |
| G4 | 13-14 | Approved deletion and encrypted export delivery |
| G5 | 15-17 | Admin dashboard, end-user portal, audit, and retries |
| G6 | 18-19 | Production hardening and release safety evidence |

Do not start G4 destructive production work until G1-G3 tests pass in CI. Do not onboard a production pilot until G6 passes and the global execution pause has been rehearsed.

## Spec coverage self-review

- Hosted control plane and Rust agent: Tasks 1, 6-9
- Request state machine and split orchestration: Tasks 3, 7, 9, 13
- Tenant/project/environment/RBAC: Task 5
- Raw identity isolation and HMAC: Task 8
- Supabase, Stripe, Clerk, custom adapter: Tasks 10-12
- Dry-run, approval, exact-plan authorization: Task 13
- Encrypted customer-owned export: Task 14
- Admin and end-user request creation: Tasks 15-16
- Partial failure and retries: Tasks 9, 13, 17
- Audit, notification, webhook: Task 17
- PII-safe operations and Docker Compose: Task 18
- Destructive safety and release gates: Task 19

No design requirement is intentionally omitted from the MVP plan.
