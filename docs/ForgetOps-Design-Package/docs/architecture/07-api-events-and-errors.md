# API, Events, and Error Contracts

## 1. API principles

- REST over HTTPS for control-plane APIs.
- JSON request and response bodies.
- Zod schemas are the canonical TypeScript contracts.
- OpenAPI is generated from the same schemas.
- Every mutating endpoint supports `Idempotency-Key`.
- Aggregate mutations require `If-Match` or `expectedVersion`.
- Resource IDs use sortable opaque identifiers.
- All timestamps use UTC RFC 3339 strings.

## 2. Dashboard API

### Create request

```http
POST /v1/environments/{environmentId}/privacy-requests
Idempotency-Key: 7a7f...
```

```json
{
  "type": "delete",
  "subjectEnvelope": {
    "ciphertext": "base64url(...) ",
    "encryptionKeyId": "agt-key-3"
  }
}
```

The server derives request source, actor, tenant, environment, policy version, and deadline from authenticated route context and project policy.

Response:

```json
{
  "id": "req_01...",
  "status": "identity_verified",
  "createdAt": "2026-07-21T10:00:00Z"
}
```

### Get request

```http
GET /v1/privacy-requests/{requestId}
```

Returns request state, sanitized plan, step projections, approvals, and audit timeline.

### Approve plan

```http
POST /v1/privacy-requests/{requestId}/approvals
Idempotency-Key: 912c...
If-Match: "request-version-7"
```

```json
{
  "planId": "plan_01...",
  "planVersion": 3,
  "planFingerprint": "sha256:...",
  "decision": "approved",
  "approvalChallengeId": "aprch_01...",
  "reauthenticationEvidence": "base64url(...)",
  "comment": "Reviewed expected data sources"
}
```

### Cancel request

```http
POST /v1/privacy-requests/{requestId}/cancel
Idempotency-Key: 081a...
If-Match: "request-version-8"
```

Cancellation returns conflict if irreversible execution has started.

### Retry failed steps

```http
POST /v1/privacy-requests/{requestId}/retry
Idempotency-Key: 28bd...
If-Match: "request-version-12"
```

```json
{
  "stepIds": ["step_01...", "step_02..."]
}
```

The control plane creates a new immutable execution attempt and a new signed retry authorization. The authorization contains `authorizationKind: "retry"` and exactly the selected `allowedStepIds`. A material plan or configuration change requires re-planning instead.

## 3. Privacy portal API

### Begin request

```http
POST /v1/portal/{projectSlug}/requests
```

Requires either:

- customer-signed assertion produced after Clerk reauthentication, or
- a pending magic-link challenge handled by the customer identity adapter.

### Portal status token

The portal receives a short-lived, request-scoped capability token. It cannot list other requests or tenant metadata.

When the token expires, the user repeats identity verification to obtain a replacement. The request remains addressable through an opaque challenge reference; raw identity is not used as the lookup key.

### Export capability

```http
POST /v1/portal/requests/{requestId}/export-capability
```

Request:

```json
{
  "browserPublicKey": "base64url(...)",
  "browserKeyId": "browser-key-01"
}
```

The endpoint requires recent reauthentication and dispatches an on-demand key-wrap job to the agent. The response is not available until the agent returns a sealed envelope bound to the request and portal session.

Response:

```json
{
  "downloadUrl": "https://customer-storage/...",
  "expiresAt": "2026-07-28T10:00:00Z",
  "encryptedArchiveKey": "base64url(...) ",
  "keyAlgorithm": "X25519-XChaCha20-Poly1305"
}
```

## 4. Agent API

### Pair

```http
POST /v1/agents/pair
```

### Poll jobs

```http
POST /v1/agent-jobs/poll
```

### Lease job

```http
POST /v1/agent-jobs/{jobId}/lease
```

### Heartbeat lease

```http
POST /v1/agent-jobs/{jobId}/heartbeat
```

### Acquire destructive execution lease

```http
POST /v1/agent-attempts/{attemptId}/execution-lease
```

The signer issues a lease valid for at most 90 seconds only when the agent, request, attempt, policy, connectors, and kill switches remain valid.

### Submit progress event

```http
POST /v1/agent-events
```

All agent payloads are signed independently of TLS.

## 5. State-transition commands

The API layer never updates status fields directly. It calls domain commands:

```ts
request.beginIdentityVerification(actor);
request.markIdentityVerified(verification);
request.beginPlanning(agentId);
request.attachPlan(planProjection);
request.approvePlan(approval);
request.authorizeExecution(authorization);
request.markExecuting(agentId);
request.requestReplan(actor, reason);
request.beginRetry(attempt);
request.markNeedsReview(summary);
request.complete(summary);
request.markPartial(summary);
request.fail(error);
request.cancel(actor, reason);
```

## 6. Internal domain events

```text
TenantCreated
ProjectCreated
EnvironmentCreated
AgentPaired
AgentRevoked
ConnectorHealthChanged
PrivacyRequestCreated
SubjectBound
IdentityVerified
PlanningRequested
ExecutionPlanCreated
ExecutionPlanApproved
ExecutionPlanRejected
ExecutionAuthorized
ExecutionLeaseIssued
ExecutionLeaseDenied
ExecutionStarted
ExecutionAttemptCreated
ExecutionStepChanged
ExportReady
PrivacyRequestCompleted
PrivacyRequestPartiallyCompleted
PrivacyRequestFailed
PrivacyRequestCancelled
AuditChainHeadSigned
```

Events are persisted through the outbox pattern.

## 7. Webhooks to customer application

Optional project webhooks:

```text
privacy_request.created
privacy_request.awaiting_approval
privacy_request.executing
privacy_request.completed
privacy_request.partially_completed
privacy_request.failed
export.ready
```

Webhook payloads contain request IDs, subject hash, state, counts, and timestamps. They exclude raw subject data.

Webhook delivery:

- HMAC signature
- timestamp and delivery ID
- at-least-once delivery
- exponential retry for 24 hours
- replay endpoint in dashboard
- HTTPS destination validation, redirect revalidation, SSRF-safe DNS/IP checks, response-size limit, and dedicated egress policy

## 8. Error response envelope

```json
{
  "error": {
    "code": "PLAN_VERSION_MISMATCH",
    "message": "The approved plan is no longer current.",
    "requestId": "http_01...",
    "retryable": false,
    "details": {
      "expectedVersion": 4,
      "receivedVersion": 3
    }
  }
}
```

## 9. HTTP error mapping

| Status | Use |
|---:|---|
| 400 | Invalid input or unsupported operation |
| 401 | Missing or invalid authentication |
| 403 | Authenticated but unauthorized |
| 404 | Resource not visible in tenant scope |
| 409 | State conflict, stale plan, duplicate active request |
| 422 | Valid JSON but domain rule rejected |
| 429 | Rate limit |
| 503 | Temporary dependency or control-plane issue |

## 10. Error categories

### Domain

```text
REQUEST_STATE_CONFLICT
DUPLICATE_ACTIVE_REQUEST
APPROVAL_REQUIRED
SELF_APPROVAL_FORBIDDEN
PLAN_VERSION_MISMATCH
PLAN_EXPIRED
REQUEST_NOT_CANCELLABLE
REQUEST_VERSION_MISMATCH
RETRY_STEP_NOT_ALLOWED
REPLAN_REQUIRED
```

### Agent

```text
AGENT_OFFLINE
AGENT_REVOKED
AGENT_PROTOCOL_OUTDATED
JOB_LEASE_EXPIRED
AUTHORIZATION_INVALID
EXECUTION_LEASE_REQUIRED
EXECUTION_LEASE_EXPIRED
EXECUTION_GLOBALLY_PAUSED
```

### Connector

```text
CONNECTOR_UNHEALTHY
CREDENTIAL_INVALID
PERMISSION_INSUFFICIENT
RATE_LIMITED
REMOTE_UNAVAILABLE
VERIFICATION_FAILED
```

### Security

```text
SIGNATURE_INVALID
REPLAY_DETECTED
TENANT_SCOPE_VIOLATION
PII_LOG_GUARD_TRIGGERED
```

## 11. Rate limits

MVP defaults:

- Dashboard API: 300 requests per user per five minutes
- Privacy portal request creation: five per IP and project per hour
- Magic-link requests: three per opaque challenge and project per hour, plus customer-adapter identity throttling
- Agent polling: server-controlled; minimum five-second interval when not long-polling
- Webhook replay: 20 deliveries per minute per tenant

## 12. Idempotency behavior

The server stores idempotency scope, actor, canonical request fingerprint, response status, and response body in a generic `idempotency_records` table.

- Same key and same request fingerprint returns the saved response.
- Same key and different fingerprint returns `409 IDEMPOTENCY_KEY_REUSED`.
- Request-creation records remain for at least the privacy-request retention period.
- Other mutation records remain for at least 24 hours.
- Agent step idempotency is permanent for the request retention period.
