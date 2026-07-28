# System Architecture

## 1. Architecture choice

The MVP uses a **modular monolith control plane** and a **separate self-hosted data-plane agent**.

This choice minimizes operational burden for a solo developer while preserving clear boundaries that can be extracted later. Microservices and a full event bus are intentionally deferred.

## 2. Trust boundaries

```text
Hosted Server Side                    Customer Infrastructure
--------------------------------      --------------------------------
Tenant/project configuration          Raw subject identity
Request lifecycle                     Environment subject-HMAC key
Plan projection                       Supabase/Stripe/Clerk credentials
Approval metadata                     Connector responses
Step counts and status                Record IDs and contents
Audit metadata                        Full execution graph
Billing and notifications             Export archive and encryption keys
                                      Temporary workspace
```

Administrative and end-user browsers form a separate boundary. They temporarily handle plaintext before subject encryption or after export decryption. The server-side control plane is not trusted with customer application data. The agent is trusted to execute authorized policy within one environment, subject to local policy and online destructive leases.

## 3. Control-plane components

### Web application

Responsibilities:

- Owner/admin/reviewer dashboard
- Privacy portal
- Request review and approval
- Agent and connector status
- Audit report rendering
- Billing and tenant settings

Recommended implementation: Next.js with server-side rendering for authenticated pages and a small client surface for live request progress.

### API application

Responsibilities:

- REST endpoints
- WebSocket agent gateway
- Authentication and authorization
- State-machine commands
- Agent pairing and key rotation
- Signed execution authorization
- Short-lived execution leases
- Webhooks for customer applications

Recommended implementation: Fastify with Zod-based validation and OpenAPI generation.

### Isolated authorization signer

Responsibilities:

- Verify current request and aggregate version
- Verify plan, policy, connector fingerprint, and allowed step scope
- Verify recent reviewer reauthentication and approval evidence
- Enforce separation of duty, authorization TTL, and global pause
- Sign execution authorization and lease claims through a narrow interface

The signing key is isolated from ordinary application secrets. The signer does not expose a generic `sign(bytes)` API.

### Background worker

Responsibilities:

- Notification delivery
- Request deadline reminders
- Agent offline detection
- Expired authorization cleanup
- Outbox event processing
- Billing usage aggregation

Recommended implementation: BullMQ backed by Redis.

### PostgreSQL

Source of truth for:

- Tenants and memberships
- Projects and environments
- Agent public identities
- Environment subject-key versions
- Connector metadata
- Privacy request lifecycle
- Sanitized plans and step projections
- Approvals
- Audit chain
- Job and outbox state
- Idempotency records and serialized audit-chain heads

### Redis

Used for:

- Background queues
- Short-lived rate limits
- WebSocket presence
- Idempotency response cache

Redis is not the source of truth for request state.

## 4. Agent components

### Connection manager

- Maintains outbound WebSocket connection.
- Falls back to authenticated HTTPS polling.
- Handles reconnect, jitter, and server backoff instructions.
- Never opens an inbound public port.

### Command verifier

- Verifies control-plane signatures.
- Checks environment, request, plan version, expiry, and nonce.
- Rejects replayed or stale execution authorization.
- Requires a fresh online execution lease before scheduling a destructive step.

### Workflow engine

- Converts a sanitized plan plus local discovery results into an execution DAG.
- Persists local step state.
- Leases runnable steps.
- Applies retry and backoff.
- Supports cancellation before irreversible execution begins.
- Reconciles uncertain `in_flight` steps through verification before retry.

### Connector runtime

- Loads official connector configuration.
- Calls Supabase, Stripe, and Clerk APIs.
- Calls custom TypeScript adapter through private HTTP.
- Enforces connector capabilities and credential scopes.

### Local state store

SQLite database containing:

- Encrypted local subject identity after envelope decryption
- Full discovery output
- Execution graph
- Step attempt history
- Export artifact manifest
- Local audit details

Sensitive columns are encrypted using XChaCha20-Poly1305 with a master key supplied through a Docker secret. Generated agent identity keys are encrypted in the state volume; the Compose secret itself remains read-only. The environment subject-HMAC key is a separately provisioned, versioned secret that survives agent replacement.

### Export builder

- Normalizes connector output into a documented archive layout.
- Produces `manifest.json` and `index.html`.
- Creates an archive.
- Encrypts archive content.
- Uploads to customer-owned object storage.
- Returns only sanitized metadata and capability references.

## 5. Data flow: delete request

```text
Admin/User
  -> browser encrypts subject to agent public key
  -> Control Plane creates request
  -> Agent receives planning job
  -> Agent decrypts and computes subject HMAC
  -> Connectors discover matching resources
  -> Agent creates local DAG and sanitized plan
  -> Control Plane stores plan projection
  -> Reviewer approves exact plan version
  -> Control Plane signs execution authorization
  -> Agent verifies authorization
  -> Agent obtains short-lived online execution lease
  -> Agent persists step intent
  -> Agent executes independent steps
  -> Agent verifies uncertain and completed outcomes
  -> Agent verifies each connector outcome
  -> Agent sends sanitized progress events
  -> Control Plane closes request or marks partial failure
```

## 6. Data flow: export request

```text
Verified request
  -> discovery and plan
  -> authorization
  -> connector exports to local workspace
  -> archive builder normalizes data as a bounded stream
  -> chunked archive encrypted with random data key
  -> archive uploaded to customer object storage
  -> data key retained only as encrypted agent state
  -> verified browser creates ephemeral public key
  -> agent wraps data key on demand to that browser session
  -> control plane returns sealed key envelope and expiring link metadata
  -> verified browser streams download and decryption
  -> archive and link expire
```

## 7. Control-plane module boundaries

```text
modules/
  identity-access/
  tenants-projects/
  agent-management/
  connector-registry/
  privacy-requests/
  identity-verification/
  execution-plans/
  approvals/
  audit/
  notifications/
  billing/
```

Rules:

- Each module owns its domain model, application use cases, and repository interfaces.
- Cross-module communication uses application services or internal domain events.
- No module imports another module's database repository.
- Public module APIs use shared domain contracts, not ORM models.
- State transitions occur through command methods, not direct status updates.
- Transport schemas map to application request models; domain code does not import Zod or framework types.
- Concrete repositories and external gateways are wired only in composition roots.

## 8. Suggested repository structure

```text
forgetops/
  apps/
    web/                  # Next.js dashboard and privacy portal
    api/                  # Fastify REST and agent gateway
    worker/               # BullMQ jobs
  packages/
    contracts/            # Zod schemas and generated JSON Schema
    domain/               # State machines, value objects, policies
    application/          # Use cases and repository/gateway ports
    database/             # Drizzle adapters, schema, and migrations
    auth/                 # Clerk-backed admin authentication and RBAC
    observability/        # Logging, metrics, tracing helpers
    testing/              # Fixtures and Testcontainers helpers
  agent/
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
  deploy/
    control-plane/
    agent-compose/
  docs/
```

CI enforces this dependency direction:

```text
domain <- application <- contracts/interface adapters <- applications/frameworks
```

## 9. Deployment topology

### Hosted

- Web application
- API application
- Worker process
- Managed PostgreSQL
- Managed Redis
- S3-compatible metadata storage, excluding export payloads
- Isolated authorization signer or signing boundary

The applications may run from one container image with separate commands. This preserves a modular monolith while allowing web, API, and worker processes to scale independently.

### Customer environment

```text
Docker Compose
  forgetops-agent
  customer-app or custom-adapter
  encrypted state volume
  Docker secrets for master key, environment subject key, and connector credentials
  outbound Internet access
```

## 10. Evolution path

Extract a service only when one of these conditions is met:

- Independent scaling is repeatedly required.
- A module needs a different availability or security boundary.
- Deployment coupling causes measurable release risk.
- A separate team owns the module.

Likely first extractions:

1. Agent gateway
2. Notification worker
3. Audit/report service

The privacy-request state machine remains the source of truth until there is a proven reason to split it.
