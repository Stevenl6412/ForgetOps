# Security, Privacy, and Threat Model

## 1. Security objectives

1. A control-plane database, backup, or metadata-storage disclosure must not expose plaintext customer records, connector credentials, export contents, or archive data keys.
2. No destructive operation may run without valid policy authorization.
3. Commands and progress events must not be replayable across requests or environments.
4. One tenant must not access another tenant's metadata.
5. Logs and telemetry must not leak raw subject identifiers.
6. Destructive scheduling must stop within the execution-lease TTL after revocation, cancellation, or pause.
7. Custom adapter privileges must be stated honestly: a declared resource allowlist is enforceable only when the adapter also runs with a least-privilege service identity.

A full compromise of hosted application code, the frontend supply chain, or the isolated signing boundary is stronger than database exfiltration and is treated separately below.

## 2. Data classification

### Restricted

- Raw email, user ID, external IDs
- Connector credentials
- Record contents
- Export archive
- Archive encryption keys
- Full discovery graph

Location: customer infrastructure and, when explicitly authorized, transiently in the administrative or end-user browser. Never in server-side hosted control-plane persistence or telemetry.

### Confidential metadata

- Subject HMAC
- Request status
- Connector names and resource categories
- Counts and normalized error categories
- Approval identities
- Audit events

Location: control plane with tenant isolation.

### Operational

- Agent version
- Heartbeats
- Latency and retry metrics
- Protocol version

## 3. Threat actors

- Internet attacker targeting the hosted control plane
- Attacker with a stolen admin session
- Malicious or compromised customer employee
- Compromised agent host
- Malicious hosted frontend or browser supply-chain dependency
- Compromised authorization signer
- Compromised custom adapter
- Supply-chain compromise in an agent or npm dependency
- Accidental operator error
- Cross-tenant application bug

## 4. Trust boundaries

```text
Browser <-> Hosted control plane
API/application services <-> isolated authorization signer
Hosted control plane <-> Customer agent
Customer agent <-> Official SaaS APIs
Customer agent <-> Custom adapter
Customer agent <-> Customer object storage
Worker <-> customer webhook destinations
```

Every boundary authenticates independently.

## 5. Threats and mitigations

### Control-plane database exfiltration

Risk: attacker obtains request metadata and subject hashes.

Mitigations:

- Subject hashes use customer-held keyed HMAC secrets.
- Raw subject envelope is encrypted to agent and deleted after binding.
- No connector secrets or export data are stored.
- Database encryption and strict production access are still required.

### Full hosted application or frontend compromise

Risk:

- Malicious browser code reads a subject before encryption or an export after decryption.
- Compromised API code attempts to submit fabricated approval state to the signer.

Mitigations:

- Do not claim that browser-side encryption protects against malicious JavaScript delivered by the same hosted origin.
- Use strict CSP, Trusted Types where supported, no third-party JavaScript on sensitive pages, reproducible builds, dependency review, and short browser sessions.
- Isolate authorization signing from the API and expose only a typed `authorizeAttempt` interface, never generic byte signing.
- Signer independently validates current plan, expected version, connector fingerprint, policy, approval evidence, separation of duty, maximum TTL, and pause state.
- Production reviewers reauthenticate before approval; high-risk deployments may require WebAuthn approval evidence.
- Customer co-signing or a self-hosted control plane is required when a fully malicious hosted control plane is in scope.

Residual risk: an attacker controlling both the hosted application and signer can authorize destructive work until detected. Short online leases, local policy, and audit alerts bound the operational window but do not create a zero-trust control plane.

### Stolen pairing token

Risk: attacker pairs a fake agent.

Mitigations:

- Token valid for 15 minutes and one use.
- Pairing requires authenticated owner action.
- Production replacement requires explicit confirmation.
- Pairing event sends an out-of-band notification.

### Forged delete command

Risk: attacker sends an execution message directly to agent.

Mitigations:

- Control-plane Ed25519 signature.
- Exact environment, agent, request, plan version, fingerprint, expiry, and nonce binding.
- Nonce persisted before destructive execution.
- Agent rejects unsigned local requests.

### Replay attack

Risk: a valid authorization is reused.

Mitigations:

- Single-use nonce.
- Monotonic sequence numbers.
- Message ID replay cache.
- Authorization expiry.
- Idempotent step operation keys.
- Separate authorization nonce and short-lived execution lease ID.

### Stale-plan approval

Risk: data changes after reviewer approval.

Mitigations:

- Approval binds to plan fingerprint and connector configuration fingerprint.
- Material re-plan invalidates approval.
- Agent checks current local plan before execution.
- Authorization and lease include allowed step IDs, policy version, connector-configuration fingerprint, and execution-attempt ID.

### Cross-tenant metadata access

Risk: application bug exposes another tenant.

Mitigations:

- Tenant-scoped repository interfaces.
- Authorization middleware requires tenant and environment context.
- Database RLS used as defense in depth for dashboard reads.
- Cross-tenant property tests and penetration tests.

### PII leakage through logs

Mitigations:

- Structured logging schema with allowlisted fields.
- Redacting logger in TypeScript and Rust.
- CI tests inject canary emails and fail if they appear in logs.
- Remote API bodies never sent to telemetry.

### Compromised custom adapter

Mitigations:

- Prefer a dedicated least-privilege service account and process.
- If the adapter runs with customer application privileges, ForgetOps does not expand those privileges but also cannot constrain a compromise to declared resources.
- Private network only.
- Signed requests and nonce validation.
- Resource allowlist.
- Agent validates response schema and maximum payload size.
- Adapter cannot issue control-plane commands.

### Export link leakage

Mitigations:

- Customer-owned private bucket.
- Short-lived presigned URL.
- Archive encrypted with random data key.
- Data key wrapped on demand to a recently reauthenticated browser ephemeral public key.
- Sealed key envelope is bound to request, portal session, key ID, and expiry as authenticated data.
- Link revocation and short expiry. A raw presigned URL is not described as strictly single-download.
- Portal requires recent identity verification.

### Agent host compromise

Mitigations:

- Least-privilege connector credentials.
- Docker secrets, read-only root filesystem, dropped Linux capabilities.
- Encrypted local sensitive fields.
- Automatic local cleanup.
- Signed agent releases and documented upgrade channel.

### Offline revocation gap

Risk: a revoked, cancelled, or paused agent continues scheduling destructive work while disconnected.

Mitigations:

- Plan authorization is necessary but not sufficient for destructive scheduling.
- Every new destructive step requires an online execution lease valid for at most 90 seconds.
- Lease renewal checks agent revocation, request state, connector state, policy version, and kill switches.
- A call already in flight may finish and must be reconciled.

### Agent replacement and key loss

Risk: a replacement changes subject hashes, cannot decrypt pending envelopes, or blindly recreates an uncertain DAG.

Mitigations:

- Environment subject-HMAC key is provisioned independently and survives agent replacement.
- Requests store subject-key and canonicalization versions.
- Normal replacement drains pending envelopes and active attempts.
- Forced replacement marks affected requests `needs_review`; it never guesses prior destructive state.

### Webhook SSRF

Risk: a tenant-controlled webhook URL targets control-plane internal services, cloud metadata, or private addresses.

Mitigations:

- HTTPS only by default.
- Resolve and validate every redirect target.
- Block loopback, link-local, metadata, multicast, and private address ranges unless an explicit enterprise egress policy allows them.
- Defend against DNS rebinding by validating resolved IPs at connect time.
- Use a dedicated egress proxy with request, response, redirect, and size limits.

## 6. Key hierarchy

### Agent keys

- Ed25519 signing private key
- X25519 decryption private key
- Versioned environment subject-HMAC key, provisioned independently from agent identity
- Local state encryption key

Stored through Docker secrets or a mounted secret file with owner-only permissions.

### Control-plane keys

- Ed25519 execution-authorization signing key
- Separate Ed25519 audit-head signing key
- Session and application encryption keys
- Notification provider credentials

Production authorization signing key is isolated from general application secrets. The API requests signatures through a narrow policy-validating signer that does not expose generic signing.

## 7. Secret rotation

- Agent signing and encryption keys rotate through an owner-approved re-pair flow.
- Environment subject-HMAC keys rotate independently and retain previous versions for the required correlation window.
- Control-plane signing keys support active and previous key IDs.
- Existing unexpired authorization remains verifiable during a bounded rotation window.
- Connector secret rotation is detected through configuration fingerprint changes.

## 8. Authorization model

| Action | Owner | Admin | Reviewer |
|---|---:|---:|---:|
| Manage billing | Yes | No | No |
| Manage members | Yes | No | No |
| Pair/revoke agent | Yes | No | No |
| Configure connectors | Yes | Yes | No |
| Create admin request | Yes | Yes | No |
| Review plan | Yes | Yes | Yes |
| Approve request | Yes | Yes | Yes |
| Change auto-execution policy | Yes | No | No |
| Download audit report | Yes | Yes | Yes |

Optional two-person approval prohibits request creators from approving the same request.

Production approval requires recent reauthentication. Automatic execution is effective only when both tenant policy and local agent policy permit it.

## 9. Local data retention

Default agent retention:

- Raw subject identity: until no longer required for the active attempt, with a hard maximum of terminal state plus 24 hours
- Full discovery result: seven days after terminal state
- Execution graph and attempt logs: 30 days
- Temporary export files: deleted immediately after upload or after failure recovery window of 24 hours
- Encrypted archive in customer storage: seven days by default

Project policy may shorten these values. Increasing them requires an explicit warning.

## 10. Audit integrity

- Audit events are append-only.
- Each environment has an independent hash chain.
- Chain insertion locks one per-environment chain-head row and allocates a unique monotonic sequence.
- Daily chain head is signed by the control plane and stored in immutable-compatible object storage.
- MVP does not use blockchain.
- Audit integrity detects modification; it does not prevent a privileged database operator from deleting the entire log. Backups and daily signed heads address that risk.

## 11. Secure software supply chain

- Lock dependency versions and pin CI actions and production images to immutable digests.
- Generate SBOM for agent and control-plane images.
- Scan container images in CI.
- Sign release images and document customer-side signature verification before deployment.
- Use minimal runtime images.
- Enforce branch protection before production release.
- Agent auto-update is opt-in in MVP; default is notification plus manual upgrade.

## 12. Incident response minimum

- Revoke all agent sessions by environment.
- Disable destructive execution globally.
- Rotate control-plane signing key.
- Notify affected tenants.
- Preserve audit and access logs.
- Publish a version-specific upgrade or mitigation.

A production runbook must rehearse the global execution kill switch before launch.
