# Product Scope

## 1. Product statement

ForgetOps is a data lifecycle runtime for small AI SaaS teams. It gives developers one controlled workflow to discover, export, erase, anonymize, retain, and verify a user's data across application databases and third-party services.

The MVP is not a broad privacy-compliance suite. It focuses on two high-risk engineering jobs:

- A user asks for a copy of their data.
- A user asks for account and data deletion.

## 2. Primary user

The primary customer is a technical founder or small engineering team operating an AI SaaS with a stack similar to:

- Supabase for PostgreSQL, storage, and authentication-adjacent data
- Clerk for user identity
- Stripe for billing records
- A vector database, custom service, or internal database accessed through the custom adapter SDK

The team does not have a dedicated privacy engineering or compliance operations function.

## 3. User roles

### Owner

- Creates the tenant
- Manages billing
- Adds or removes members
- Creates projects and environments
- Pairs or revokes agents
- Changes destructive-operation policy

### Admin

- Configures connectors
- Creates administrative requests
- Reviews request details
- Manages privacy portal configuration
- Retries failed steps

### Reviewer

- Reviews dry-run plans
- Approves or rejects destructive operations
- Accepts justified retention outcomes
- Downloads audit reports

## 4. Core user journeys

### 4.1 Administrative deletion request

1. Admin selects project and production environment.
2. Admin submits a subject identifier in the browser.
3. Browser encrypts the identifier to the environment agent's public key.
4. Control plane creates a request containing only ciphertext and operational metadata.
5. Agent decrypts, normalizes the subject, computes the keyed subject hash, and discovers data.
6. Control plane binds the subject transactionally, cancelling or explicitly overriding a duplicate active request.
7. Agent returns a sanitized plan with counts, actions, risks, policy version, and connector-configuration fingerprint.
8. Reviewer reauthenticates and approves the exact plan version.
9. Isolated signer validates approval evidence and signs an execution authorization.
10. Agent obtains a short-lived online lease before scheduling destructive steps.
11. Agent executes independent steps, reconciles uncertain outcomes, and verifies final state.
12. Control plane shows completion, retained items, and unresolved steps.

### 4.2 End-user deletion request

1. User opens the project's privacy portal.
2. User authenticates through a short-lived assertion produced after Clerk reauthentication.
3. If reauthentication is unavailable, the customer identity adapter performs a magic-link challenge.
4. Control plane creates a verified privacy request without retaining raw identity data.
5. The remaining flow is the same as the administrative request.

### 4.3 Data export request

1. Verified request enters planning.
2. Agent discovers exportable records and generates a sanitized plan.
3. After approval or policy-based auto-authorization, connectors collect data locally.
4. Agent creates a structured archive and manifest.
5. Agent encrypts the archive as a chunked stream and uploads it to customer-owned object storage.
6. Agent retains the archive key only as encrypted local state until archive expiry.
7. After recent identity verification, the browser generates an ephemeral key and requests an on-demand download capability.
8. Agent wraps the archive key to that browser key and returns only a sealed key envelope and short-lived link metadata.
9. Browser streams download and decryption.
10. Link, encrypted local key material, and archive expire according to project policy.

## 5. Functional requirements

### Request management

- Create delete and export requests from dashboard, API, or privacy portal.
- Support idempotency keys and expected aggregate versions on every state-changing operation.
- Enforce one active destructive request per subject and environment unless explicitly overridden by an owner.
- Allow cancellation before execution authorization.
- Prevent cancellation after an irreversible step has started; use compensating status instead.
- Model every initial execution and retry as an immutable execution attempt.

### Identity handling

- Never store raw email, user ID, or external identifiers in control-plane business tables.
- Store a keyed HMAC subject hash for correlation within one environment.
- Store the subject-HMAC key version and canonicalization version with every binding.
- Keep the environment subject-HMAC key stable across agent replacement.
- Encrypt the raw subject to the agent public key before persistence or transit through the control plane.
- Delete subject ciphertext after the agent binds the request or after a maximum 24-hour TTL.
- Block normal agent replacement while unconsumed envelopes or active execution attempts exist.

### Planning

- Every delete workflow runs discovery before execution.
- Plans include connector, resource type, action, estimated count, risk, dependency summary, and retention reason category.
- Plan approval binds to request ID, environment ID, plan ID, plan version, and expiry.
- Any material re-plan invalidates previous approval.
- Connector-configuration, policy, or local-plan fingerprint changes invalidate authorization.

### Execution

- Independent connectors continue when another connector fails.
- Each step is idempotent and independently retryable.
- Agent verifies the result of destructive actions.
- A request completes only when all steps are succeeded, skipped by policy, or accepted as retained/needs-review.
- Control plane never sends an unsigned delete command.
- Production destructive steps require an unexpired online execution lease with a maximum 90-second TTL.
- Offline agents may reconcile and report work but may not schedule another destructive step.
- ForgetOps guarantees an idempotent final state, not exactly one remote API call.

### Export

- Export data never enters the server-side hosted control plane; ciphertext is stored in customer storage and plaintext is handled only by the agent and authorized browser.
- Archive contains a machine-readable manifest and human-readable index.
- Archive is encrypted as a versioned, chunked authenticated stream before upload.
- Storage is customer-owned and private.
- Access link expires and can be revoked.
- Archive keys can be rewrapped after recent user reauthentication without rebuilding the archive.

### Audit

- Every state transition emits an append-only audit event.
- Audit events form a tamper-evident hash chain per environment.
- Audit chain insertion is serialized per environment in the same transaction as state and outbox changes.
- Audit metadata excludes raw PII and record contents.
- Reports show action, actor, timestamps, plan version, connector outcomes, counts, and retention categories.

## 6. Non-functional requirements

### Availability

- Control plane target: 99.5% monthly availability for the MVP.
- Agent tolerates control-plane disconnects and resumes through polling.
- Offline agents may finish a remote call that already started, but they do not schedule another destructive step without a fresh online lease.

### Performance

- Dashboard reads: p95 below 500 ms under normal MVP load.
- Agent heartbeat interval: 30 seconds while connected.
- Job delivery: under 10 seconds through WebSocket, under 60 seconds through polling fallback.
- Planning and execution durations depend on connector APIs and are reported independently.

### Scale

- 100 tenants
- Up to 5 projects per tenant
- Staging and production per project
- About 1,000 privacy requests per month
- One active agent per environment in the MVP
- Capacity test ceiling: 1,000 simultaneously connected agents

### Security

- TLS for all remote transport.
- Ed25519 signatures for agent and control-plane commands.
- Encryption at rest for sensitive local agent state.
- Least-privilege connector credentials.
- No control-plane access to customer records or export content.
- Strict CSP and no third-party JavaScript on identity-entry, approval, and export-decryption pages.
- Database-disclosure and full-application-compromise guarantees are stated separately.

## 7. Non-goals

The MVP does not include:

- Automatic legal interpretation by country
- A universal data catalog
- Data loss prevention or real-time content inspection
- Enterprise custom RBAC
- Kubernetes deployment
- Multi-region control plane
- Customer-managed control-plane encryption keys
- Automatic deletion from immutable backups
- Full workflow rollback after deletion
- Exactly-once remote API invocation
- Guaranteed interruption of a remote call that has already started
- Support for every vector database
- A guarantee of regulatory compliance

## 8. Success metrics

### Activation

- Tenant pairs a production agent and completes a dry-run within 30 minutes.
- At least three connectors are healthy.

### Reliability

- More than 95% of connector steps complete without manual intervention after initial configuration.
- Zero unauthorized destructive executions.
- Zero raw-PII control-plane log incidents.

### Product value

- Median manual engineering time per request is reduced by at least 80% in pilot customers.
- At least 50% of activated tenants complete a second request within 60 days or enable automatic account-closure cleanup.

## 9. Product boundary statement

ForgetOps decides **how to execute configured data handling policy**, not **what the law requires**. A project administrator owns retention rules and connector scope. The product must preserve this distinction in UI copy, documentation, and contracts.
