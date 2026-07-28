# Deployment, Observability, and Operations

## 1. Control-plane deployment

The MVP uses one region and three application processes built from one monorepo:

```text
web      Next.js
api      Fastify + WebSocket gateway
worker   BullMQ consumers and scheduled jobs
signer   Policy-validating execution authorization boundary
```

Managed dependencies:

- PostgreSQL with point-in-time recovery
- Redis
- S3-compatible storage for reports and signed audit chain heads
- Transactional email provider
- Error tracking and metrics platform

## 2. Agent Docker Compose

```yaml
services:
  forgetops-agent:
    image: ghcr.io/forgetops/agent@sha256:<verified-release-digest>
    restart: unless-stopped
    read_only: true
    cap_drop: ["ALL"]
    security_opt:
      - no-new-privileges:true
    environment:
      FORGETOPS_CONTROL_PLANE_URL: https://api.forgetops.example
      FORGETOPS_CONFIG_PATH: /config/agent.yaml
      FORGETOPS_STATE_PATH: /state/agent.db
    secrets:
      - agent_master_key
      - environment_subject_key
      - supabase_service_key
      - supabase_url
      - stripe_secret_key
      - clerk_secret_key
      - adapter_shared_secret
      - export_access_key
      - export_secret_key
    volumes:
      - ./config:/config:ro
      - forgetops_state:/state
    networks:
      - forgetops_private
      - default

secrets:
  agent_master_key:
    file: ./secrets/agent_master_key
  environment_subject_key:
    file: ./secrets/environment_subject_key
  supabase_url:
    file: ./secrets/supabase_url
  supabase_service_key:
    file: ./secrets/supabase_service_key
  stripe_secret_key:
    file: ./secrets/stripe_secret_key
  clerk_secret_key:
    file: ./secrets/clerk_secret_key
  adapter_shared_secret:
    file: ./secrets/adapter_shared_secret
  export_access_key:
    file: ./secrets/export_access_key
  export_secret_key:
    file: ./secrets/export_secret_key

volumes:
  forgetops_state:

networks:
  forgetops_private:
    internal: true
```

The custom adapter joins `forgetops_private`. Official SaaS connectors also require outbound Internet access through the agent's default network.

## 3. Agent configuration

```yaml
agent:
  environment: production
  log_level: info
  local_retention_days: 30
  allow_production_auto_execution: false

control_plane:
  websocket: true
  polling_fallback: true

connectors:
  supabase:
    enabled: true
    url_secret: supabase_url
    service_key_secret: supabase_service_key
    mapping_file: /config/supabase-mapping.yaml
  stripe:
    enabled: true
    secret_key_secret: stripe_secret_key
  clerk:
    enabled: true
    secret_key_secret: clerk_secret_key
  custom:
    enabled: true
    base_url: http://customer-app:8080/forgetops/v1
    shared_secret: adapter_shared_secret

export:
  provider: s3_compatible
  bucket: customer-privacy-exports
  expiry_days: 7
  max_archive_bytes: 536870912
  max_temporary_bytes: 1073741824
  chunk_bytes: 4194304
```

The image digest is matched to a signed release before first deployment or upgrade. Generated agent keys are encrypted in `/state`; the read-only Compose secrets provide key-encryption and environment key material.

## 4. Health endpoints

Agent exposes a local-only endpoint:

```text
GET /health/live
GET /health/ready
GET /health/connectors
```

It binds to loopback or the private Docker network, not public interfaces.

## 5. Metrics

### Control plane

- HTTP request rate, latency, errors
- WebSocket connections and reconnects
- Queue depth and age
- State-transition failures
- Agent offline count
- Approval waiting time
- Request completion time
- Audit outbox lag
- Authorization signer denial and latency
- Email/webhook failures

### Agent

- Job lease and execution duration
- Destructive execution-lease age and renewal failures
- Connector call latency and error category
- Retry count
- Local queue size
- Local database size
- Export archive size and duration
- Progress event backlog
- Clock skew estimate

Metrics labels must not contain subject hash, request subject, record ID, or customer-supplied free text.

## 6. Logging

Required fields:

```text
timestamp
level
service
version
request_id or job_id
agent_id when applicable
environment_id
operation
status
error_code
```

Prohibited fields:

- raw email
- raw user ID
- connector response body
- SQL parameters containing identity
- export paths containing identifiers

## 7. Tracing

Distributed tracing covers control-plane request and agent job metadata through correlation IDs. Traces stop at the customer boundary; raw connector spans remain local and are summarized.

## 8. Alerts

Critical:

- Invalid control-plane signature accepted by any test or production component
- Unauthorized destructive execution attempt
- Cross-tenant access detection
- Audit chain break
- Global execution kill switch activation

High:

- Production agent offline for more than 15 minutes
- Queue oldest job above 10 minutes
- More than 10% connector failure rate over one hour
- Export artifact cleanup failure

## 9. Backup and recovery

### PostgreSQL

- Daily full backup
- Point-in-time recovery
- Quarterly restore test
- Recovery point objective: 15 minutes
- Recovery time objective: four hours for MVP

### Agent local state

The agent state database can be backed up by the customer. ForgetOps does not centrally back it up. A lost agent state during execution forces the request into `needs_review`; it must not blindly recreate destructive steps.

A useful restore requires the matching agent master key and environment subject-key versions. Restore drills verify both decryption and uncertain-step reconciliation.

### Audit chain heads

Daily signed chain heads are copied to versioned object storage.

## 10. Upgrades

- Control plane uses backward-compatible protocol support for the current and previous agent minor versions.
- Agent reports version and protocol at heartbeat.
- Outdated agents remain able to finish already authorized work when protocol is compatible.
- New destructive jobs are blocked when agent version is below the configured safety floor.

## 11. Operational kill switches

Global:

- Stop issuing all execution authorizations.
- Stop issuing or renewing all destructive execution leases.
- Stop new agent pairings.
- Disable privacy portal request creation.

Tenant/environment:

- Revoke agent.
- Disable connector.
- Force approval for all workflows.
- Pause execution while allowing planning.

Effect boundary:

- New destructive steps stop no later than the active lease expiry, at most 90 seconds.
- A remote API call that already started may finish.
- Offline agents may reconcile and report but cannot schedule another destructive step.

## 12. Customer support diagnostics

Customers can generate a support bundle containing:

- Agent version and platform
- Connector health categories
- Sanitized configuration fingerprints
- Job IDs and error categories
- Local log excerpts passed through PII redaction
- Active key IDs, never key material
- Current execution-lease state and clock-skew category

The bundle never includes secrets, subject identities, record contents, or export files.
