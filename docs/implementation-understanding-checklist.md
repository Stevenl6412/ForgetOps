# ForgetOps Implementation Understanding Checklist

## Problem

- [x] The repository began as a design-only package with no executable workspace.
- [x] TypeScript and Rust need one repeatable monorepo toolchain before feature work.
- [ ] Explain the request-state branches and terminal outcomes introduced in Task 3.
- [ ] Explain why request state, audit rows, and outbox rows commit or roll back together.

## Solution

- [x] The workspace uses Node.js 22+ and the latest stable pnpm release.
- [x] Turborepo coordinates build, test, and lint while Cargo owns Rust checks.
- [x] The web and Rust projects are generated with their official CLIs.
- [ ] Explain why control-plane dependencies point inward toward contracts and domain code.
- [ ] Explain how the tenant-scoped repository derives ownership and detects optimistic-concurrency conflicts.
- [ ] Explain why pending domain events are acknowledged only after a successful transaction.

## Broader context

- [x] CI runs the same format, lint, test, and build commands used locally.
- [x] Docker Desktop and Testcontainers provide the real PostgreSQL integration-test runtime for persistence work.
- [ ] Explain the privacy boundary between the hosted control plane and customer agent.
- [ ] Explain the release gates for destructive operations before a production pilot.
- [ ] Explain why audit rows are append-only and why the full canonical audit verifier remains a later task.
