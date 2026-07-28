# Domain and Data Model

## 1. Aggregate overview

```text
Tenant
  Project
    Environment
      Agent
      Connector
      Policy
      PrivacyRequest
        ExecutionPlan
        ExecutionAttempt
        ExecutionStepProjection
        Approval
        AuditEvent
```

`PrivacyRequest` is the primary business aggregate. The agent owns the detailed execution graph; the control plane stores a sanitized projection.

## 2. Tenant and membership

```ts
export type Role = "owner" | "admin" | "reviewer";

export interface Tenant {
  id: string;
  name: string;
  plan: "trial" | "starter" | "team";
  createdAt: string;
}

export interface Membership {
  tenantId: string;
  userId: string;
  role: Role;
  createdAt: string;
}
```

Authorization rules:

- Every tenant has at least one owner.
- Only owners manage billing and destructive-operation defaults.
- Owners and admins create requests.
- Owners, admins, and reviewers can approve when separation-of-duty policy allows it.
- The request creator cannot approve their own destructive request when two-person approval is enabled.

## 3. Project and environment

```ts
export interface Project {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Environment {
  id: string;
  projectId: string;
  kind: "staging" | "production";
  status: "active" | "disabled";
  subjectHashKeyVersion: number;
  subjectCanonicalizationVersion: number;
  createdAt: string;
}
```

Constraints:

- Maximum five projects per tenant in the MVP.
- Exactly one staging and one production environment per project.
- Credentials, agents, subject hashes, and requests are environment-scoped.
- Data cannot be moved between staging and production.

## 4. Agent

```ts
export interface Agent {
  id: string;
  environmentId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  version: string;
  protocolVersion: string;
  status: "pairing" | "online" | "offline" | "outdated" | "revoked";
  lastSeenAt: string | null;
  lastSequence: string;
  createdAt: string;
}
```

Only one active agent is allowed per environment in the MVP. Pairing a replacement revokes the previous agent after explicit owner confirmation. The environment subject-HMAC key is not part of the replaceable agent identity and remains stable across ordinary replacement.

## 5. Connector metadata

```ts
export type ConnectorCapability =
  | "discover"
  | "export"
  | "delete"
  | "anonymize"
  | "retain"
  | "verify";

export interface ConnectorMetadata {
  id: string;
  environmentId: string;
  type: "supabase" | "stripe" | "clerk" | "custom";
  displayName: string;
  capabilities: ConnectorCapability[];
  status: "connected" | "degraded" | "disabled";
  configurationFingerprint: string;
  lastHealthCheckAt: string | null;
}
```

The control plane stores no connector secret or endpoint credential.

## 6. Privacy request

```ts
export type PrivacyRequestType = "delete" | "export";
export type PrivacyRequestSource = "admin" | "privacy_portal" | "api";

export type PrivacyRequestStatus =
  | "created"
  | "identity_verification_pending"
  | "identity_verified"
  | "planning"
  | "awaiting_approval"
  | "execution_authorized"
  | "executing"
  | "needs_review"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

export interface PrivacyRequest {
  id: string;
  environmentId: string;
  type: PrivacyRequestType;
  source: PrivacyRequestSource;
  subjectHash: string | null;
  subjectHashKeyVersion: number | null;
  subjectCanonicalizationVersion: number | null;
  duplicateOverride: boolean;
  duplicateOfRequestId: string | null;
  currentAttemptId: string | null;
  status: PrivacyRequestStatus;
  policyVersion: number;
  deadlineAt: string;
  createdByActorId: string;
  createdAt: string;
  completedAt: string | null;
  version: number;
}
```

The `version` field implements optimistic concurrency control.

## 7. State machine

### Allowed transitions

```text
created -> identity_verification_pending
created -> identity_verified                 # trusted administrative API
created -> cancelled
identity_verification_pending -> identity_verified
identity_verification_pending -> failed
identity_verification_pending -> cancelled
identity_verified -> planning
identity_verified -> cancelled
planning -> awaiting_approval
planning -> execution_authorized             # approved auto-execution policy
planning -> failed
planning -> cancelled
awaiting_approval -> execution_authorized
awaiting_approval -> planning                 # re-plan or changes requested
awaiting_approval -> cancelled
execution_authorized -> executing
execution_authorized -> awaiting_approval     # expired or invalidated authorization
execution_authorized -> cancelled             # authorization not consumed
executing -> completed
executing -> partially_completed
executing -> failed
executing -> needs_review
partially_completed -> planning
partially_completed -> execution_authorized  # selected-step retry attempt
partially_completed -> needs_review
partially_completed -> completed             # accepted retained outcome
failed -> planning
failed -> execution_authorized               # selected-step retry attempt
failed -> needs_review
failed -> cancelled
needs_review -> planning
needs_review -> execution_authorized
needs_review -> partially_completed
needs_review -> completed
needs_review -> cancelled
```

Only `completed` and `cancelled` are permanently terminal. Forbidden transitions are rejected at the domain layer and recorded as security events.

## 8. Subject identity

Raw subject identifiers exist only in encrypted envelopes and local agent state.

```ts
export interface SubjectEnvelope {
  requestId: string;
  environmentId: string;
  ciphertext: string;
  encryptionKeyId: string;
  expiresAt: string;
  consumedAt: string | null;
}
```

The agent normalizes identifiers and returns a versioned binding:

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

```text
subjectHash = HMAC-SHA-256(environmentSubjectKeyVersion, canonicalIdentity)
```

The environment subject key remains in the customer data plane. The control plane cannot perform an offline dictionary attack against email hashes. Subject binding is serialized per environment, subject hash, and request type so concurrent duplicate intake resolves deterministically.

## 9. Execution plan

```ts
export interface ExecutionPlan {
  id: string;
  requestId: string;
  version: number;
  fingerprint: string;
  status: "draft" | "approved" | "rejected" | "expired";
  totalSteps: number;
  estimatedRecords: number;
  requiresApproval: boolean;
  generatedAt: string;
  expiresAt: string;
}
```

A plan fingerprint covers the canonical sanitized plan. Approval is invalid if the fingerprint or version changes.

The canonical plan includes policy version and connector-configuration fingerprint.

## 10. Execution attempt

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

A selective retry creates a new immutable attempt with a new authorization and nonce.

## 11. Step projection

```ts
export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_review"
  | "blocked"
  | "skipped";

export interface ExecutionStepProjection {
  id: string;
  requestId: string;
  attemptId: string;
  planVersion: number;
  connectorType: string;
  resourceType: string;
  action: "export" | "delete" | "anonymize" | "retain" | "verify";
  risk: "low" | "medium" | "high";
  status: StepStatus;
  estimatedCount: number | null;
  affectedCount: number | null;
  errorCategory: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
```

Record IDs, queries, and contents are excluded.

## 12. Approval and authorization

```ts
export interface Approval {
  id: string;
  requestId: string;
  planId: string;
  planVersion: number;
  planFingerprint: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  authenticationMethod: "session_reauth" | "webauthn";
  evidenceHash: string;
  comment: string | null;
  createdAt: string;
}
```

Execution authorization is a signed immutable document:

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

Execution authorization permits an attempt but does not by itself allow offline destructive scheduling. A short-lived signed execution lease, valid for at most 90 seconds, is also required.

## 13. Audit event

```ts
export interface AuditEvent {
  id: string;
  tenantId: string;
  environmentId: string;
  requestId: string | null;
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  metadata: Record<string, string | number | boolean | null>;
  sequence: string;
  previousEventHash: string | null;
  eventHash: string;
  createdAt: string;
}
```

Hash calculation:

```text
eventHash = SHA-256(
  UTF8("forgetops.audit-event.v1") ||
  0x00 ||
  previousEventHashBytes ||
  JCS(eventWithoutHashes)
)
```

The application serializes events using RFC 8785 JSON Canonicalization Scheme before hashing. The environment chain-head row is locked while allocating `sequence`, inserting the event, updating the head, and inserting the outbox event.

## 14. Core database tables

```text
tenants
memberships
projects
environments
agents
agent_pairing_tokens
connectors
policies
privacy_requests
subject_envelopes
subject_bindings
execution_plans
execution_attempts
execution_step_projections
approvals
execution_authorizations
execution_leases
agent_jobs
job_leases
idempotency_records
outbox_events
audit_events
audit_chain_heads
notifications
billing_accounts
usage_records
```

## 15. Database integrity rules

- Unique membership on `(tenant_id, user_id)`.
- Unique environment on `(project_id, kind)`.
- Unique active agent on `environment_id` through a partial index.
- Unique idempotency key on `(tenant_id, scope, actor_id, idempotency_key)`.
- Unique ordinary active request on `(environment_id, subject_hash, type)` where status is not permanently terminal and `duplicate_override = false`.
- Unique execution attempt on `(request_id, attempt_number)`.
- Unique audit sequence on `(environment_id, sequence)`.
- Approval must reference the current plan version.
- Audit events cannot be updated or deleted by the application role.
- Tenant ID is copied onto high-volume tables for efficient authorization filters.

## 16. Outbox and audit pattern

Every state transition and its internal event are committed in one PostgreSQL transaction:

```text
BEGIN
  select audit_chain_heads for update
  update privacy_requests
  insert audit_events
  update audit_chain_heads
  insert outbox_events
COMMIT
```

The worker publishes the outbox event to Redis-backed jobs. Delivery is at least once; consumers must be idempotent.
