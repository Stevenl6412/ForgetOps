# Roadmap and Architecture Decisions

## 1. Delivery phases

### Phase 0: Safety foundation

- Monorepo and CI
- Shared TypeScript/Rust contracts
- Request state machine
- Execution-attempt and retry model
- Agent pairing and signatures
- Stable environment subject-key lifecycle
- Local encrypted state
- Audit event chain
- Isolated authorization signer
- Online destructive execution lease and global pause
- Synthetic end-to-end environment

Exit condition: a signed non-destructive planning job runs end to end and every Gate S0 safety contract passes.

### Phase 1: Administrative export

- Tenant/project/environment management
- Agent dashboard
- Supabase connector export
- Custom adapter export
- Encrypted customer-storage archive
- Bounded streaming archive and on-demand browser key wrapping
- Admin request creation

Exit condition: pilot tenant can export a synthetic user without raw data entering control plane.

### Phase 2: Approved deletion

- Supabase deletion/anonymization
- Clerk session revocation and identity deletion
- Stripe retain/anonymize outcomes
- Dry-run plan review
- Signed execution authorization
- Short-lived online destructive execution lease
- Verification and partial completion
- Crash-consistent uncertain-operation recovery

Exit condition: destructive sandbox suite passes and first pilot executes synthetic deletion.

### Phase 3: End-user privacy portal

- Clerk reauthentication assertion
- Magic-link fallback adapter
- Request-scoped portal token
- Export download capability
- User-facing status page

Exit condition: an end user completes export and deletion without admin data entry.

### Phase 4: Operational hardening

- Billing
- Usage metering
- Notifications and webhooks
- Support bundle
- Backup restore test
- Signed agent releases

Exit condition: system supports 100 tenants and stated release gates.

## 2. Architecture decision records

### ADR-001: Hosted control plane and self-hosted agent

**Decision:** Keep raw data and credentials in customer infrastructure; host lifecycle and audit metadata.

**Reason:** Reduces trust burden and allows recurring SaaS operations without centralizing sensitive data.

**Trade-off:** Agent deployment and support are more complex than a fully hosted connector service.

### ADR-002: Modular monolith control plane

**Decision:** Use one codebase and database with strict modules; deploy web, API, and worker processes.

**Reason:** Solo-developer speed and operational simplicity.

**Trade-off:** Discipline is required to prevent cross-module coupling.

### ADR-003: Rust agent, TypeScript control plane

**Decision:** Rust for long-running customer agent; TypeScript for web, API, worker, and custom adapter.

**Reason:** Small reliable agent binary and rapid product development.

**Trade-off:** Cross-language contracts and build pipelines increase complexity.

### ADR-004: WebSocket with polling fallback

**Decision:** Maintain outbound WebSocket; use long polling when unavailable.

**Reason:** Near-real-time experience without customer inbound firewall changes.

**Trade-off:** Two delivery paths must share leasing and idempotency logic.

### ADR-005: Split orchestration

**Decision:** Control plane owns business lifecycle; agent owns detailed execution DAG.

**Reason:** Control plane remains useful without receiving raw discovery data.

**Trade-off:** Reconciliation protocol is required after disconnects.

### ADR-006: Dry-run and approval by default

**Decision:** All destructive requests plan first and require approval unless owner enables auto-execution policy.

**Reason:** Safe default for irreversible operations.

**Trade-off:** More steps before completion.

### ADR-007: Partial progress over global rollback

**Decision:** Independent connector failures do not stop other connectors; completed destructive work is not rolled back.

**Reason:** Cross-service rollback is generally impossible and can create worse inconsistency.

**Trade-off:** Requests may require manual resolution and end as partially completed.

### ADR-008: Customer-owned export storage

**Decision:** Agent uploads encrypted archive to a customer bucket.

**Reason:** Export content never enters hosted infrastructure.

**Trade-off:** Customer must configure storage credentials and lifecycle policy.

### ADR-009: HMAC subject identity

**Decision:** Agent computes environment-scoped keyed HMAC; control plane never stores plain hash of email.

**Reason:** Protects low-entropy identifiers against offline guessing after control-plane data theft.

**Trade-off:** Cross-environment correlation is intentionally impossible.

### ADR-010: TypeScript internal HTTP adapter

**Decision:** Custom customer logic is exposed through a signed private HTTP adapter rather than WASM or dynamic Rust plugins.

**Reason:** Best developer experience for target AI SaaS teams.

**Trade-off:** Adapter runs as a separate process and needs protocol versioning.

### ADR-011: Stable environment subject identity

**Decision:** The subject-HMAC key belongs to an environment and rotates independently from replaceable agent signing and encryption keys.

**Reason:** Agent replacement must not silently break duplicate detection or subject correlation.

**Trade-off:** Customers must preserve versioned environment key material through backup and replacement.

### ADR-012: Online lease for destructive scheduling

**Decision:** Plan authorization is long enough for restart recovery, but each newly scheduled destructive step also requires an online lease valid for at most 90 seconds.

**Reason:** Revocation, cancellation, and global pause otherwise cannot affect an offline authorized agent.

**Trade-off:** Destructive availability depends on the control plane; an in-flight remote call still cannot always be interrupted.

### ADR-013: Execution attempts for retries

**Decision:** Initial runs and retries are immutable execution attempts. A retry authorization names the exact allowed steps.

**Reason:** Reopening a terminal state or reusing a plan-wide nonce makes audit history and retry scope ambiguous.

**Trade-off:** The data model and UI expose one additional concept.

### ADR-014: Streaming export with on-demand key wrap

**Decision:** The agent streams a chunked encrypted archive, retains its key only in encrypted local state, and wraps that key to a recently reauthenticated browser on demand.

**Reason:** The browser can recover after refresh or key loss, and large exports do not require whole-file memory buffering.

**Trade-off:** Download readiness requires an online agent for the key-wrap job.

## 3. Deferred decisions with selected defaults

These are not unresolved blockers; the MVP uses the stated default.

| Topic | MVP default | Revisit trigger |
|---|---|---|
| Multi-region | One region | Contractual residency demand |
| Kubernetes | Docker Compose | Repeated enterprise demand |
| Custom RBAC | Three fixed roles | Organizations need delegated permissions |
| Agent HA | One active agent/environment | Execution availability becomes a sales blocker |
| Message bus | PostgreSQL outbox + Redis jobs | Sustained throughput or service extraction |
| Customer KMS | Docker secrets | Security review requires external KMS |
| Customer authorization co-signing | Isolated hosted signer plus local policy | Customer threat model includes a fully malicious hosted control plane |
| Legal rule engine | Customer-configured policy | Proven repeated jurisdiction workflow |

## 4. Product expansion after MVP

- Automated account-closure retention workflows
- Scheduled orphan-data cleanup
- Additional vector database connectors
- Data warehouse export/deletion
- Customer-managed KMS
- Self-hosted control plane
- Team approval policies
- Compliance evidence integrations

Expansion should follow observed request volume and connector demand, not a generic connector-count goal.
