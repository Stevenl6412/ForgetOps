# Agent-Control Plane Protocol

## 1. Goals

The protocol must:

- Keep all connections outbound from the customer network.
- Authenticate both control plane and agent.
- Prevent replay and cross-environment commands.
- Support near-real-time WebSocket delivery and polling fallback.
- Tolerate duplicate delivery.
- Avoid transmitting raw PII in progress events.
- Preserve safe execution after disconnect and restart.

## 2. Protocol versions

Every message includes:

```json
{
  "type": "forgetops.agent-message",
  "protocolVersion": "1.0",
  "messageType": "job.available",
  "messageId": "msg_01...",
  "keyId": "cp-signing-2026-07",
  "environmentId": "env_01...",
  "agentId": "agt_01...",
  "direction": "control_to_agent",
  "sequence": "1042",
  "sentAt": "2026-07-21T10:00:00Z",
  "payload": {},
  "signature": "base64url(...)"
}
```

Unknown major versions are rejected. Unknown minor fields are ignored.

## 3. Pairing

### Control-plane preparation

1. Owner creates an environment.
2. Control plane generates a one-time pairing token valid for 15 minutes.
3. Token is shown once.

### Agent initialization

1. Agent generates:
   - Ed25519 signing key pair
   - X25519 encryption key pair
2. Customer provisions or reuses:
   - Versioned environment subject-HMAC key
   - Agent-state master encryption key
3. Generated private identity keys are encrypted under the master key and written to the persistent state volume. Docker secrets remain read-only.
4. Agent sends pairing token, public keys, key IDs, protocol version, and instance fingerprint.
5. Control plane binds the public keys to the environment.
6. Pairing token is destroyed.

### Replacement

A new agent cannot silently replace an active production agent. Owner must approve replacement. Normal replacement is blocked while unconsumed subject envelopes or active execution attempts exist. Forced replacement revokes the previous agent, marks affected requests `needs_review`, and requires identity resubmission when an old X25519 private key is unavailable.

## 4. Transport

### Primary: WebSocket

- Endpoint: `wss://api.forgetops.example/v1/agent-stream`
- Authentication: signed `agent.hello` message plus short-lived connection challenge.
- Heartbeat: every 30 seconds.
- Server closes silent connections after 90 seconds.

### Fallback: HTTPS polling

- Endpoint: `POST /v1/agent-jobs/poll`
- Long-poll timeout: 45 seconds.
- Agent uses exponential reconnect backoff with jitter, capped at 60 seconds.

## 5. Message signing

Signature input:

```text
UTF8("forgetops.agent-message.v1") ||
0x00 ||
RFC8785_JCS(unsignedMessage)
```

The sender signs these bytes using Ed25519. Cross-language fixtures contain the exact canonical bytes, signature, and public key. The receiver verifies:

- public key
- key ID and permitted key purpose
- environment and agent binding
- message direction
- timestamp freshness
- unsigned 64-bit monotonic sequence for that direction
- unseen message ID

Message IDs are retained in replay cache for at least 24 hours. Send and receive sequences are persisted independently. Only one delivery transport is active for an agent session; switching to polling invalidates the previous WebSocket session before polling may lease work.

## 6. Job model

```ts
export interface AgentJob {
  jobId: string;
  requestId: string;
  environmentId: string;
  kind:
    | "bind_subject"
    | "plan"
    | "execute"
    | "lease_execution"
    | "wrap_export_key"
    | "cancel"
    | "health_check";
  planVersion: number | null;
  payloadCiphertext: string | null;
  authorization: string | null;
  availableAt: string;
  expiresAt: string;
  attempt: number;
}
```

## 7. Leasing

1. Agent receives `job.available`.
2. Agent requests a lease.
3. Control plane atomically marks job leased to that agent for 60 seconds.
4. Agent sends heartbeat every 20 seconds while running.
5. Lease extends only while agent remains valid.
6. If lease expires, job becomes available again.

A job may be delivered more than once. Agent deduplicates by `jobId` and persisted execution state.

## 8. Planning flow

```text
job: bind_subject
  -> decrypt subject envelope
  -> normalize identity
  -> compute versioned environment-scoped HMAC
  -> control plane serializes subject binding and duplicate resolution
  -> return subject.bound or subject.duplicate

job: plan
  -> discover across enabled connectors
  -> build local execution graph
  -> save graph and raw discovery locally
  -> return sanitized plan projection
```

Sanitized plan response:

```json
{
  "requestId": "req_01...",
  "planVersion": 3,
  "planFingerprint": "sha256:...",
  "steps": [
    {
      "stepId": "step_01...",
      "connectorType": "supabase",
      "resourceType": "documents",
      "action": "delete",
      "estimatedCount": 17,
      "risk": "medium"
    }
  ]
}
```

## 9. Execution authorization

The isolated signer signs an authorization after validating current state, aggregate version, approval evidence or valid auto-execution policy, plan fingerprint, connector-configuration fingerprint, policy version, allowed step scope, and global pause.

Agent checks:

- Signature matches configured control-plane public key.
- Key ID, type, version, issuer, and audience are allowed.
- Environment and agent IDs match local configuration.
- Request, execution attempt, and plan exist locally.
- Plan fingerprint, version, policy version, connector fingerprint, and allowed step IDs match.
- Authorization is unexpired.
- `notBefore` and maximum TTL are valid.
- Nonce has not been consumed.
- Current policy does not require a stronger local guard.

The nonce is persisted as consumed when the local attempt becomes authorized. Restart resumes the persisted attempt; it does not consume or replay the authorization again.

## 10. Online execution lease

Authorization alone does not permit offline destructive scheduling. Before scheduling a destructive step, the agent obtains a signed execution lease bound to environment, agent, request, attempt, and allowed step IDs.

- Maximum lease TTL: 90 seconds.
- Lease is not renewed when the agent is revoked, request is cancelled, connector is disabled, policy changes, or any global/tenant/environment pause is active.
- Agent stops scheduling new destructive steps when the lease expires.
- A remote call that already started may finish and is reconciled through verification.
- Planning, reporting, and non-destructive reconciliation may continue offline.

## 11. Progress events

Allowed metadata:

- request ID
- step ID
- connector type
- resource type category
- action
- status
- affected count
- duration
- retry attempt
- normalized error category

Prohibited metadata:

- raw subject identifiers
- record IDs
- file paths containing user identifiers
- SQL or API response bodies
- exported data
- connector secrets

## 12. Retry policy

Default connector retry:

```text
Attempt 1: immediate
Attempt 2: 5 seconds + jitter
Attempt 3: 30 seconds + jitter
Attempt 4: 2 minutes + jitter
Attempt 5: 10 minutes + jitter
```

Do not retry:

- invalid credentials
- authorization mismatch
- unsupported capability
- policy violation
- deterministic validation error

Retry with server guidance:

- rate limit
- remote timeout
- temporary network failure
- service unavailable

## 13. Idempotency and crash recovery

Each operation uses:

```text
operationKey = requestId + attemptId + planVersion + stepId + actionVersion
```

Official connectors persist a `prepared` intent before every remote mutation and a completion record after verification. When a remote API lacks idempotency support, an uncertain restart verifies whether the intended final state already exists before deciding whether another call is safe. ForgetOps guarantees idempotent final state, not exactly one remote call.

## 14. Cancellation

Cancellation is advisory until acknowledged by the agent.

- Planning jobs can always be cancelled.
- Authorized jobs can be cancelled before the nonce is consumed.
- During execution, the agent stops scheduling new steps.
- Running steps finish unless connector cancellation is safe.
- Completed destructive steps are not rolled back.
- Request becomes `partially_completed` if irreversible work occurred.

## 15. Offline behavior

- Agent may finish an already-started remote call while disconnected.
- Progress events are queued locally and sent after reconnect.
- Agent cannot schedule another destructive step without a fresh online execution lease.
- Agent never infers approval from control-plane unavailability.

## 16. Protocol errors

```text
AUTH_SIGNATURE_INVALID
AUTH_AGENT_REVOKED
AUTH_ENVIRONMENT_MISMATCH
AUTH_REPLAY_DETECTED
JOB_LEASE_EXPIRED
JOB_PAYLOAD_UNREADABLE
PLAN_VERSION_MISMATCH
AUTHORIZATION_EXPIRED
AUTHORIZATION_ALREADY_CONSUMED
EXECUTION_LEASE_REQUIRED
EXECUTION_LEASE_EXPIRED
EXECUTION_GLOBALLY_PAUSED
CONNECTOR_FINGERPRINT_MISMATCH
PROTOCOL_VERSION_UNSUPPORTED
```

Security errors are not automatically retried and generate control-plane alerts.
