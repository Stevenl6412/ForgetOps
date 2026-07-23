# ForgetOps Implementation Understanding Checklist

## Problem

- [x] The repository began as a design-only package with no executable workspace.
- [x] TypeScript and Rust need one repeatable monorepo toolchain before feature work.
- [ ] Explain the request-state branches and terminal outcomes introduced in Task 3.
- [ ] Explain why request state, audit rows, and outbox rows commit or roll back together.
- [ ] Explain why an injected trusted auth context is safer than accepting tenant/role headers.
- [ ] Explain why a cross-tenant resource returns `404` instead of an authorization detail.
- [ ] Explain why a pairing token is shown once while PostgreSQL stores only its SHA-256 hash.
- [ ] Explain why agent replacement permission must be carried by the owner-issued token.

## Solution

- [x] The workspace uses Node.js 22+ and the latest stable pnpm release.
- [x] Turborepo coordinates build, test, and lint while Cargo owns Rust checks.
- [x] The web and Rust projects are generated with their official CLIs.
- [ ] Explain why control-plane dependencies point inward toward contracts and domain code.
- [ ] Explain how the tenant-scoped repository derives ownership and detects optimistic-concurrency conflicts.
- [ ] Explain why pending domain events are acknowledged only after a successful transaction.
- [ ] Explain how the fixed role matrix denies unknown roles/permissions by default.
- [ ] Explain why project creation locks the tenant row before enforcing the five-project limit.
- [ ] Explain why PostgreSQL `timestamptz` is normalized at the store boundary.
- [ ] Explain which fields the canonical Ed25519 pairing proof binds and why.
- [ ] Explain why token consumption locks both the token and environment rows.
- [ ] Explain how create-new secret files prevent a second pairing from overwriting an identity.

## Broader context

- [x] CI runs the same format, lint, test, and build commands used locally.
- [x] Docker Desktop and Testcontainers provide the real PostgreSQL integration-test runtime for persistence work.
- [ ] Explain the privacy boundary between the hosted control plane and customer agent.
- [ ] Explain the release gates for destructive operations before a production pilot.
- [ ] Explain why audit rows are append-only and why the full canonical audit verifier remains a later task.
- [ ] Explain why project/environment writes use the explicit owner guard when the approved matrix has no project-management permission.
- [ ] Explain which identity-provider and lifecycle seams are intentionally deferred to later tasks.
- [ ] Explain the public/private key boundary between the control plane and customer agent.
- [ ] Explain why transport, identity reload, and execution authorization remain Task 7+ concerns.
