# ForgetOps Implementation-Ready Design Package

ForgetOps is a developer-first data lifecycle system for small AI SaaS teams. It handles two workflows in the MVP:

1. **Delete account**: discover, plan, approve, erase/anonymize/retain, and verify user data across connected systems.
2. **Export my data**: discover, collect, package, encrypt, publish through customer-owned storage, and expire access.

The product uses a **hosted control plane** and a **self-hosted Rust agent**. Raw end-user data, connector credentials, and export contents remain outside the server-side hosted control plane. The hosted control plane stores lifecycle state, environment-scoped pseudonymous identifiers, sanitized counts, timestamps, and audit metadata only.

## Target customer

AI SaaS teams using:

- Supabase
- Stripe
- Clerk
- A vector database or custom data service exposed through the TypeScript adapter SDK

## Locked MVP decisions

- Hosted TypeScript control plane plus self-hosted Rust agent
- Docker Compose deployment for the agent
- Official connectors: Supabase, Stripe, Clerk
- Custom connector: TypeScript internal HTTP adapter
- Admin-created and end-user-created requests
- Clerk reauthentication first; magic-link fallback through the customer's identity adapter
- WebSocket job delivery with HTTPS polling fallback
- Dry-run and approval by default
- Production destructive steps require a valid plan authorization and a short-lived online execution lease
- Automatic execution requires both a tenant policy and an explicit local-agent policy
- Partial connector failure does not stop independent connectors
- Export archive is created and encrypted by the agent and uploaded to customer-owned object storage
- Export keys are retained only in encrypted agent state and wrapped to a recently reauthenticated browser on demand
- Multiple projects per tenant; staging and production are isolated
- Roles: owner, admin, reviewer
- MVP target: 100 tenants and about 1,000 privacy requests per month
- Environment subject-HMAC keys survive agent replacement and rotate independently from agent identity keys

## Package contents

- `REVIEW-NOTES.md` — review disposition, resolved issues, residual risks, and QA evidence
- `docs/superpowers/specs/2026-07-21-forgetops-system-design.md` — canonical system specification
- `docs/superpowers/plans/2026-07-21-forgetops-mvp-implementation.md` — TDD-oriented implementation plan
- `docs/architecture/01-product-scope.md` — users, workflows, requirements, and non-goals
- `docs/architecture/02-system-architecture.md` — boundaries, components, data flow, and deployment
- `docs/architecture/03-domain-data-model.md` — aggregates, state machines, and database schema
- `docs/architecture/04-agent-control-plane-protocol.md` — pairing, job leasing, signatures, and retries
- `docs/architecture/05-connectors-and-sdk.md` — official connector contract and custom adapter SDK
- `docs/architecture/06-security-privacy-threat-model.md` — trust boundaries and threat mitigations
- `docs/architecture/07-api-events-and-errors.md` — REST endpoints, internal events, and error taxonomy
- `docs/architecture/08-deployment-observability-operations.md` — Docker Compose, monitoring, backup, and support
- `docs/architecture/09-testing-and-release-quality.md` — test pyramid, destructive-operation safety, and release gates
- `docs/architecture/10-roadmap-and-decisions.md` — phased delivery and architecture decision records
- `docs/architecture/11-implementation-readiness-contracts.md` — normative safety invariants and implementation gates
- `diagrams/architecture-final.png` — finalized MVP architecture and safety flow
- `diagrams/architecture-final.svg` — editable vector diagram source
- `ForgetOps-System-Design.docx` — formatted system design document
- `ForgetOps-MVP-Implementation-Plan.docx` — formatted implementation plan

## Status

This package is the implementation baseline for a greenfield MVP. The normative safety invariants in document 11 take precedence if an illustrative example elsewhere is ambiguous.

The design distinguishes a control-plane database disclosure from a full hosted application or frontend compromise. Plaintext is excluded from server-side control-plane persistence, but hosted browser code necessarily handles administrative input before encryption and authorized export content after decryption. The threat model documents that residual risk instead of making a broader zero-trust claim.

The package deliberately avoids legal guarantees. Product copy and customer contracts should state that ForgetOps automates configured data lifecycle workflows; it does not independently determine legal obligations.
