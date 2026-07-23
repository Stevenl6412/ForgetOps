# ForgetOps Design Package

ForgetOps is a developer-first data lifecycle system for small AI SaaS teams. It handles two workflows in the MVP:

1. **Delete account**: discover, plan, approve, erase/anonymize/retain, and verify user data across connected systems.
2. **Export my data**: discover, collect, package, encrypt, publish through customer-owned storage, and expire access.

The product uses a **hosted control plane** and a **self-hosted Rust agent**. Raw end-user data, connector credentials, and export contents remain inside the customer's infrastructure. The hosted control plane stores lifecycle state, hashed identifiers, sanitized counts, timestamps, and audit metadata only.

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
- Dry-run and approval by default; tenant-configurable automatic execution
- Partial connector failure does not stop independent connectors
- Export archive is created and encrypted by the agent and uploaded to customer-owned object storage
- Multiple projects per tenant; staging and production are isolated
- Roles: owner, admin, reviewer
- MVP target: 100 tenants and about 1,000 privacy requests per month

## Package contents

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
- `diagrams/architecture-options.png` — architecture comparison infographic
- `ForgetOps-System-Design.docx` — formatted system design document
- `ForgetOps-MVP-Implementation-Plan.docx` — formatted implementation plan

## Status

This package is a complete design baseline for a greenfield implementation. It deliberately avoids legal guarantees. Product copy and customer contracts should state that ForgetOps automates configured data lifecycle workflows; it does not independently determine legal obligations.
