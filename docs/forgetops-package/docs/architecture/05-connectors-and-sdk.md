# Connectors and TypeScript Adapter SDK

## 1. Connector philosophy

A connector is not a generic CRUD wrapper. It implements a small, auditable lifecycle contract for a known system.

Every connector declares capabilities and must support dry-run planning separately from execution.

## 2. Rust connector contract

```rust
#[async_trait::async_trait]
pub trait Connector: Send + Sync {
    fn descriptor(&self) -> ConnectorDescriptor;

    async fn health_check(&self) -> Result<HealthStatus, ConnectorError>;

    async fn discover(
        &self,
        subject: &SubjectIdentity,
        request: &DiscoveryRequest,
    ) -> Result<DiscoveryResult, ConnectorError>;

    async fn export(
        &self,
        subject: &SubjectIdentity,
        selection: &ExportSelection,
        sink: &mut dyn ExportSink,
    ) -> Result<ExportResult, ConnectorError>;

    async fn erase(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
        context: &ExecutionContext,
    ) -> Result<EraseResult, ConnectorError>;

    async fn verify(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError>;
}
```

## 3. Capability rules

- `discover` is mandatory.
- `verify` is mandatory for every destructive capability.
- `delete` means remote data can be deleted.
- `anonymize` means identifiable fields can be irreversibly replaced or removed.
- `retain` means the connector can document a configured retention result.
- `export` means the connector can write normalized data into the export sink.

A connector cannot advertise `delete` without `verify`.

## 4. Discovery result

Raw result remains local. The control plane receives a projection.

```rust
pub struct DiscoveryItem {
    pub local_reference: String,
    pub resource_type: String,
    pub proposed_action: ProposedAction,
    pub estimated_count: u64,
    pub risk: RiskLevel,
    pub dependencies: Vec<String>,
    pub retention_reason: Option<String>,
}
```

`local_reference` is encrypted in the agent store and never sent to the control plane.

## 5. Official connector: Supabase

Scope:

- PostgreSQL records configured through declarative table mappings
- Supabase Storage objects configured through bucket/path mapping
- Optional Auth user deletion when the project explicitly enables it

Example policy:

```yaml
connectors:
  supabase:
    tables:
      profiles:
        identity_column: user_id
        delete: true
      documents:
        identity_column: owner_id
        delete: true
      audit_events:
        identity_column: actor_user_id
        action: anonymize
        fields: [actor_user_id, actor_email]
    storage:
      user-uploads:
        prefix: "users/{user_id}/"
        delete: true
```

Safety:

- Table and column names are allowlisted at configuration time.
- Agent uses parameterized queries only.
- Discovery and execution run in transactions where practical.
- Cascades are inspected during health validation and shown as high risk.

## 6. Official connector: Stripe

Scope:

- Discover customer by configured stable mapping.
- Export customer, subscriptions, payment methods, and selected billing objects.
- Apply configured deletion/anonymization operations supported by the customer account and API.
- Mark financial objects retained when project policy requires retention.

ForgetOps does not assume all Stripe data can or should be deleted. The connector returns one of:

- deleted
- anonymized
- retained_by_policy
- unsupported
- needs_review

## 7. Official connector: Clerk

Scope:

- Discover user identity and linked external accounts.
- Export supported profile and identity data.
- Revoke sessions before destructive execution.
- Delete the identity when policy and API capability allow it.
- Verify that active sessions and user identity are absent or disabled.

Default delete dependency:

```text
revoke_sessions -> disable_application_access -> delete_downstream_data -> delete_identity
```

Clerk identity deletion is scheduled after application data deletion to preserve mapping during discovery and execution.

## 8. Custom TypeScript adapter

The adapter runs in the customer's application or a private sidecar. The Rust agent calls it over a private network.

### Package API

```ts
import {
  createForgetOpsAdapter,
  type SubjectIdentity,
  type ResourceDefinition,
} from "@forgetops/adapter";

const documents: ResourceDefinition = {
  name: "documents",
  capabilities: ["discover", "export", "delete", "verify"],

  async discover({ subject, db }) {
    const count = await db.document.count({
      where: { ownerId: subject.userId },
    });
    return { estimatedCount: count, proposedAction: "delete", risk: "medium" };
  },

  async export({ subject, db, writer }) {
    const rows = await db.document.findMany({
      where: { ownerId: subject.userId },
    });
    await writer.json("documents/documents.json", rows);
    return { exportedCount: rows.length };
  },

  async erase({ subject, db, operationKey }) {
    const result = await db.document.deleteMany({
      where: { ownerId: subject.userId },
    });
    return { operationKey, affectedCount: result.count };
  },

  async verify({ subject, db }) {
    const remaining = await db.document.count({
      where: { ownerId: subject.userId },
    });
    return { satisfied: remaining === 0, remainingCount: remaining };
  },
};

export default createForgetOpsAdapter({ resources: [documents] });
```

## 9. Adapter HTTP protocol

Private endpoints:

```text
POST /forgetops/v1/health
POST /forgetops/v1/discover
POST /forgetops/v1/export
POST /forgetops/v1/erase
POST /forgetops/v1/verify
POST /forgetops/v1/identity/send-magic-link
POST /forgetops/v1/identity/verify-magic-link
```

Requests are signed by the agent using an adapter-specific shared secret delivered through Docker secrets. Each request includes timestamp, nonce, and body digest. The adapter rejects requests older than 60 seconds or reused nonces.

## 10. Adapter isolation

- Endpoint is bound to a private Docker network or loopback.
- No public ingress is required.
- Adapter code uses the customer's own database client and business logic.
- Raw results return only to the local agent.
- Adapter logs must use the provided redacting logger.

## 11. Connector configuration lifecycle

1. Admin selects connector type in dashboard.
2. Control plane produces non-secret configuration template.
3. Customer adds secrets to Docker Compose.
4. Agent loads configuration and performs health checks.
5. Agent sends fingerprint and capability metadata.
6. Admin enables connector for staging, then production.

Configuration changes create a new fingerprint and invalidate unexecuted plans that used the previous fingerprint.

## 12. Connector error taxonomy

```text
CREDENTIAL_INVALID
PERMISSION_INSUFFICIENT
RESOURCE_MAPPING_INVALID
SUBJECT_NOT_FOUND
RATE_LIMITED
REMOTE_TIMEOUT
REMOTE_UNAVAILABLE
ACTION_UNSUPPORTED
POLICY_REQUIRES_REVIEW
VERIFICATION_FAILED
DATA_CONFLICT
ADAPTER_PROTOCOL_ERROR
```

Connector error messages sent to the control plane are sanitized. Detailed remote responses remain local.
