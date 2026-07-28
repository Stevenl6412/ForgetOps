# Implementation Readiness Contracts

This document is normative. It resolves safety-sensitive details that must not be left to implementation judgment. If an illustrative example in another document conflicts with this file, this file takes precedence.

## 1. Security claim boundary

ForgetOps makes these MVP claims:

1. A disclosure of the hosted control-plane database, backups, logs, or ordinary metadata storage does not reveal plaintext subject identifiers, connector credentials, record contents, export contents, or archive data keys.
2. A destructive step cannot begin without:
   - an authorization for the exact local plan,
   - an allowed local execution policy,
   - and a valid short-lived online execution lease.
3. Revocation, cancellation, or the global pause prevents the agent from scheduling another destructive step after the current lease expires. A remote call that has already started may finish.
4. ForgetOps provides idempotent final-state execution and verification. It does not claim that every remote API is called exactly once.

A full compromise of the hosted web application, API runtime, signing boundary, or JavaScript supply chain is stronger than a database disclosure. It may expose future browser-entered identifiers, misrepresent a plan to a reviewer, or attempt to obtain an authorization. The MVP reduces this risk with isolated signing, reviewer reauthentication, strict Content Security Policy, short leases, local policy, and audit alerts, but does not describe the hosted control plane as zero trust.

Customers requiring protection from a fully malicious control plane must enable customer co-signing after MVP or run a self-hosted control plane.

## 2. Explicit trust boundaries

The runtime has these independently authenticated boundaries:

```text
Administrative browser <-> hosted web/API
End-user browser <-> privacy portal
API/application services <-> isolated authorization signer
Hosted agent gateway <-> customer agent
Customer agent <-> official SaaS APIs
Customer agent <-> custom adapter
Customer agent <-> customer object storage
Worker <-> customer webhook destinations
```

The browser is not part of the server-side control plane and is not automatically part of the customer data plane. It is an authorized endpoint that temporarily handles plaintext.

## 3. Request and execution-attempt model

`PrivacyRequest` owns the user-visible lifecycle. `ExecutionAttempt` owns one plan authorization and one run or retry. Completed attempts are immutable.

### Request statuses

```text
created
identity_verification_pending
identity_verified
planning
awaiting_approval
execution_authorized
executing
needs_review
completed
partially_completed
failed
cancelled
```

Only `completed` and `cancelled` are permanently terminal. `failed`, `partially_completed`, and `needs_review` may enter a new planning or retry attempt through an explicit command.

### Request transitions

```text
created -> identity_verification_pending | identity_verified | cancelled
identity_verification_pending -> identity_verified | failed | cancelled
identity_verified -> planning | cancelled
planning -> awaiting_approval | execution_authorized | failed | cancelled
awaiting_approval -> execution_authorized | planning | cancelled
execution_authorized -> executing | awaiting_approval | cancelled
executing -> completed | partially_completed | failed | needs_review
partially_completed -> planning | execution_authorized | needs_review | completed
failed -> planning | execution_authorized | needs_review | cancelled
needs_review -> planning | execution_authorized | partially_completed | completed | cancelled
```

Rules:

- `awaiting_approval -> planning` creates a new plan version and invalidates prior approvals.
- A rejected approval either cancels the request with reason `plan_rejected` or returns it to planning with reason `changes_requested`.
- `execution_authorized -> awaiting_approval` is used when authorization expires before consumption or safety inputs change.
- Accepting a documented retained outcome may move `needs_review` or `partially_completed` to `completed`; the acceptance actor and reason are audited.

### Execution attempt

```ts
export interface ExecutionAttempt {
  id: string;
  requestId: string;
  attemptNumber: number;
  kind: "initial" | "retry";
  planId: string;
  planVersion: number;
  planFingerprint: string;
  allowedStepIds: string[];
  status:
    | "planned"
    | "awaiting_approval"
    | "authorized"
    | "running"
    | "succeeded"
    | "partially_succeeded"
    | "failed"
    | "needs_review"
    | "cancelled";
  createdAt: string;
  completedAt: string | null;
}
```

A selective retry creates a new attempt. It never mutates or reuses the previous authorization.

## 4. Concurrency and idempotency

Every state-changing command includes:

- tenant and actor context derived from authentication,
- an idempotency key,
- an expected aggregate version,
- and a canonical request fingerprint.

HTTP clients send `Idempotency-Key` and either `If-Match` or `expectedVersion`. A generic `idempotency_records` table stores scope, actor, request hash, response, and retention expiry. Request creation records remain for at least the privacy-request retention period; shorter administrative mutations remain for at least 24 hours.

The API derives `source`, `createdByActorId`, tenant, and environment from the authenticated route context. Clients cannot assign audit identity fields.

## 5. Subject identity and key lifecycle

The subject-HMAC key belongs to the environment, not to an agent instance.

```ts
export interface SubjectBinding {
  requestId: string;
  environmentId: string;
  subjectHash: string;
  subjectHashKeyVersion: number;
  canonicalizationVersion: number;
  duplicateOfRequestId: string | null;
}
```

Rules:

- Agent signing and X25519 keys may rotate during replacement.
- The environment subject-HMAC key survives replacement.
- HMAC rotation keeps old key versions until all requests and correlation windows using them have expired.
- A request stores both HMAC key version and canonicalization version.
- A customer-stable application user ID is preferred over email. Alternate identifiers are explicit aliases, not silently interchangeable canonical forms.
- Identifier normalization is versioned and tested with cross-language fixtures.

Subject binding is serialized per `(environment_id, subject_hash, request_type)` using a transaction-scoped advisory lock or equivalent. When a duplicate is discovered, the newer request is cancelled with `duplicateOfRequestId` and its envelope is destroyed. An owner override sets an audited `duplicateOverride` flag and bypasses the ordinary partial unique index.

Agent replacement is normally blocked while there are unconsumed subject envelopes or running attempts. A forced replacement marks affected requests `needs_review` and requires identity resubmission. The control plane cannot re-encrypt an envelope that was encrypted to a lost private key.

## 6. Signed message contract

All cross-language signed values use RFC 8785 JSON Canonicalization Scheme, not field concatenation.

```text
signature_input =
  UTF8("forgetops.agent-message.v1") ||
  0x00 ||
  JCS(unsigned_message)
```

The unsigned message includes:

```ts
export interface UnsignedAgentMessage {
  type: "forgetops.agent-message";
  protocolVersion: "1.0";
  messageType: string;
  messageId: string;
  keyId: string;
  environmentId: string;
  agentId: string;
  direction: "control_to_agent" | "agent_to_control";
  sequence: string;
  sentAt: string;
  payload: unknown;
}
```

Sequence is an unsigned 64-bit decimal string and is monotonic per agent and direction. Only one delivery transport is active for an agent session. Switching from WebSocket to polling invalidates the previous connection session before polling can lease work.

The receiver validates schema, signature, key ID, direction, environment, agent, freshness, sequence, message ID, and payload-specific authorization before dispatch.

## 7. Execution authorization and lease

Authorization is immutable and plan-scoped:

```ts
export interface ExecutionAuthorizationClaims {
  type: "forgetops.execution-authorization";
  version: 1;
  keyId: string;
  issuer: "forgetops-control-plane";
  audience: "forgetops-agent";
  environmentId: string;
  agentId: string;
  requestId: string;
  attemptId: string;
  authorizationKind: "initial" | "retry";
  planId: string;
  planVersion: number;
  planFingerprint: string;
  policyVersion: number;
  connectorConfigurationFingerprint: string;
  allowedStepIds: string[];
  approvalEvidenceHash: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  nonce: string;
}
```

The authorization signer has a narrow interface. It verifies current request state, expected version, current plan, current connector configuration, approval evidence, actor permission, separation-of-duty policy, kill-switch state, and maximum TTL before signing.

A separate execution lease is required before scheduling destructive work:

```ts
export interface ExecutionLeaseClaims {
  type: "forgetops.execution-lease";
  version: 1;
  keyId: string;
  environmentId: string;
  agentId: string;
  requestId: string;
  attemptId: string;
  allowedStepIds: string[];
  issuedAt: string;
  expiresAt: string;
  leaseId: string;
}
```

Lease TTL is at most 90 seconds. The agent must be online to acquire or renew it. The agent consumes the authorization nonce once, but a persisted authorized attempt may resume after restart while it can obtain fresh leases.

## 8. Crash-consistent connector execution

Each local step uses this state machine:

```text
pending -> prepared -> in_flight -> verifying -> succeeded
                                  -> failed
                                  -> needs_review
```

Before the remote call, the agent persists:

- operation key,
- desired final state,
- plan and attempt binding,
- remote idempotency key when supported,
- and an encrypted verification expectation.

After an uncertain restart, the agent verifies the remote state before calling the mutation again. If verification proves the intended result, it records success. If not, connector-specific recovery policy decides whether retry is safe.

Tests assert one effective final-state change. They assert one remote call only for APIs that provide a durable idempotency guarantee.

## 9. Export key and archive contract

The archive uses a versioned, chunked authenticated-encryption container. The agent never buffers the complete export in memory.

Minimum container properties:

- XChaCha20-Poly1305 per chunk,
- random archive data key,
- unique nonce derivation per chunk,
- manifest hash and request/format version as associated data,
- per-file hashes and final archive hash,
- explicit maximum archive size, temporary disk quota, and file-count limit.

The agent uploads ciphertext to customer-owned private storage and retains the archive data key only as encrypted local state until archive expiry.

Download flow:

1. User recently reauthenticates.
2. Browser generates an ephemeral X25519 key pair.
3. Browser sends the public key with a request-scoped portal capability.
4. Control plane dispatches an on-demand key-wrap job.
5. Agent seals the archive key using X25519, HKDF-SHA-256, and XChaCha20-Poly1305 with request, portal session, key ID, and expiry as associated data.
6. Portal returns a short-lived presigned URL and sealed key envelope.
7. Browser streams download and decryption.

If the browser private key is lost, the user reauthenticates and requests a new wrapped key. A raw presigned URL is short-lived and revocable but is not described as strictly single-download.

## 10. Audit-chain serialization

Each environment has one `audit_chain_heads` row. In the same PostgreSQL transaction as the state change:

1. lock the chain-head row with `SELECT ... FOR UPDATE`,
2. allocate the next sequence,
3. calculate the event hash,
4. insert the immutable event,
5. update the chain head,
6. insert the outbox event.

```text
eventHash =
  SHA-256(
    UTF8("forgetops.audit-event.v1") ||
    0x00 ||
    previousEventHashBytes ||
    JCS(eventWithoutHashes)
  )
```

Unique constraints cover `(environment_id, sequence)` and `(environment_id, event_hash)`. Daily heads use a signing key and key purpose distinct from execution authorization.

## 11. Clean architecture dependency rule

The source dependency direction is:

```text
domain <- application <- interface adapters <- frameworks/drivers
```

Rules:

- `packages/domain` contains plain types, invariants, and state machines. It imports no Zod, ORM, HTTP, queue, database, or framework package.
- `packages/application` owns use cases and repository/gateway ports.
- `packages/contracts` owns transport schemas and maps to application request/response models.
- `packages/database` implements application ports and never exports ORM rows across the boundary.
- API, web, worker, and agent binaries are composition roots.
- CI runs an architecture dependency test and rejects forbidden imports or cycles.

## 12. Implementation gates

### Gate S0: Safety contracts

- State transitions and retry attempts are executable specifications.
- JCS fixtures verify TypeScript and Rust signatures byte-for-byte.
- Environment key replacement and subject deduplication tests pass.
- Audit concurrency test produces one linear chain.
- Online lease expiry prevents another destructive step.

### Gate S1: Non-destructive vertical slice

- Administrative intake, subject binding, planning, and export work end to end.
- No raw PII reaches server-side control-plane persistence or telemetry.
- Archive download can be recovered after browser key loss through reauthentication.

### Gate S2: Destructive sandbox

- Crash injection runs before call, after call, and before local commit.
- Revocation and global pause stop new destructive scheduling within the lease TTL.
- Target data reaches the intended final state and unrelated data remains unchanged.
- Retry authorization cannot execute a step outside `allowedStepIds`.

### Gate S3: Production pilot

- All release gates pass at the maximum modeled 1,000 connected agents.
- Signer, agent-compromise, restore, webhook SSRF, and global-pause runbooks are rehearsed.
- Production auto-execution remains disabled unless both hosted and local policies explicitly allow it.
