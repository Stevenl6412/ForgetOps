# Testing and Release Quality

## 1. Testing strategy

Destructive-operation safety is the highest priority. Tests must prove both that intended data is processed and that unrelated data is not processed.

## 2. Test layers

### Unit tests

Control plane:

- Request state transitions
- Execution-attempt and selective-retry transitions
- RBAC decisions
- Plan approval binding
- Authorization claim construction
- Audit hash calculation
- Generic idempotency and optimistic-concurrency behavior
- PII redaction

Agent:

- Signature verification
- Replay prevention
- Execution-lease expiry and revocation
- DAG scheduling
- Uncertain `in_flight` recovery
- Retry classification
- Local encryption
- Export manifest generation

### Contract tests

- TypeScript Zod schemas against Rust serde fixtures
- Agent message canonicalization and signatures
- Authorization and export-key-wrap canonicalization
- Custom adapter HTTP request and response schemas
- Webhook signature verification

Every protocol fixture is checked into the repository and consumed by both languages.

### Connector tests

Each connector has:

- Fake server tests
- Sandbox integration tests
- Permission-denied tests
- Rate-limit tests
- Partial data tests
- Idempotent re-execution tests
- Verification failure tests

### Database tests

Run against real PostgreSQL through Testcontainers:

- Tenant isolation
- Partial unique indexes
- Concurrent subject binding and owner override
- Optimistic concurrency
- Outbox atomicity
- Linear audit-chain insertion under concurrency
- Append-only audit protections

### End-to-end tests

A disposable environment contains:

- Control-plane services
- Rust agent
- Fake Supabase-compatible test database
- Stripe and Clerk fake servers
- Custom adapter fixture
- S3-compatible object storage

Scenarios:

1. Admin export succeeds.
2. End-user deletion with reauthentication succeeds.
3. Magic-link fallback succeeds.
4. One connector rate-limits and later succeeds.
5. One connector permanently fails; others complete.
6. Plan changes after approval and execution is rejected.
7. Authorization replay is rejected.
8. Agent restart resumes without repeating successful deletion.
9. Control plane disconnects during execution and later reconciles.
10. Canary PII never appears in control-plane logs.
11. Agent replacement preserves subject correlation and drains or fails pending envelopes safely.
12. Global pause prevents another destructive step within 90 seconds.
13. Selective retry cannot execute an unlisted step.
14. Browser key loss is recovered through reauthentication and on-demand key rewrap.

## 3. Destructive-operation test pattern

For every delete mapping:

- Create target subject data.
- Create unrelated subject data.
- Run discovery and assert target count.
- Execute deletion.
- Verify target state.
- Verify unrelated state is byte-for-byte unchanged where practical.
- Repeat execution with same operation key.
- Assert no additional side effects.

## 4. Property-based tests

Use generated state-machine command sequences to prove:

- Forbidden transitions never succeed.
- Terminal states remain terminal.
- Approval never applies to another plan version.
- Cancellation never reopens a request.
- Duplicate messages do not produce duplicate state changes.
- Retry authorization never expands the approved step set.
- Audit chains never fork under concurrent state transitions.

## 5. Security tests

- Tampered message signatures
- Expired timestamp
- Reused nonce
- Cross-environment authorization
- Revoked agent
- Modified plan fingerprint
- Modified policy or connector-configuration fingerprint
- Execution without a current online lease
- Stolen portal token used for another request
- Path traversal in export filenames
- Zip-bomb and oversized adapter responses
- SQL identifier injection in Supabase mapping
- Log injection and PII canary detection
- Webhook SSRF, redirect SSRF, and DNS-rebinding attempts
- Malicious or stale browser public-key registration
- Agent replacement with unconsumed envelopes

## 6. Load tests

MVP profile:

- 100 tenants
- 1,000 simultaneously connected agents
- 1,000 requests per month
- Burst of 50 new requests in five minutes
- 100 progress events per active request

Pass conditions:

- p95 dashboard reads below 500 ms
- agent message processing p95 below 250 ms excluding network
- no lost state transitions
- outbox lag below 30 seconds
- no duplicate authorization issuance
- pause-to-stop-scheduling time at or below 90 seconds

## 7. Failure injection

- Kill agent during deletion.
- Kill agent before remote call, after remote success, and before local completion commit.
- Kill worker after outbox read but before acknowledgement.
- Drop WebSocket connection repeatedly.
- Delay database commits.
- Return malformed connector data.
- Expire object-storage credentials during upload.
- Advance clock to test authorization expiry.
- Revoke the agent and activate global pause during a disconnected session.
- Run concurrent audit writes for the same environment.

## 8. Release gates

A release cannot reach production unless:

- TypeScript unit, integration, and E2E tests pass.
- Rust unit, integration, and protocol tests pass.
- Cross-language contract fixtures pass.
- Database migrations are tested forward and backward where reversible.
- Container scans have no unresolved critical vulnerability.
- SBOMs are generated.
- Agent image is signed.
- PII log canary test passes.
- Destructive sandbox smoke test passes.
- Global execution kill switch is verified.
- Customer-side release signature verification is documented and tested.
- Authorization signer rejects stale version, stale fingerprint, invalid approval evidence, and active pause.

## 9. Production rollout

1. Deploy control plane with feature disabled.
2. Run migrations.
3. Enable for internal tenant.
4. Pair staging agent and run export.
5. Run non-destructive delete dry-run.
6. Execute deletion on synthetic data.
7. Enable for one pilot production tenant.
8. Observe for 24 hours.
9. Expand gradually.

## 10. Definition of done for MVP

- A new tenant can complete onboarding without developer assistance.
- Agent remains connected or falls back to polling.
- Supabase, Stripe, Clerk, and custom adapter participate in one request.
- Dry-run plan can be approved and executed.
- Partial failure is visible and retryable.
- Retry creates a new attempt scoped to selected steps.
- Export is encrypted and delivered from customer storage.
- Export uses bounded streaming and supports on-demand key rewrap.
- Audit report contains a verifiable hash chain.
- No raw PII reaches control-plane persistence or logs in automated tests.
