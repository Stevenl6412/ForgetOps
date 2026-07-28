# Contributing to ForgetOps

Thanks for helping improve the Developer Preview. Before contributing, read the
[security policy](SECURITY.md) and [code of conduct](CODE_OF_CONDUCT.md).

## Prerequisites

Node.js 22, pnpm 11.16.0, Rust 1.97.1, and Docker for container-backed
integration tests. Install the pinned Rust test runner with:

```bash
cargo install cargo-nextest --version 0.9.140 --locked
```

## Before opening a pull request

Keep each pull request to one scoped concern. Add or update tests for behavior
changes, then run:

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm build
cargo nextest run --workspace
```

Do not include raw PII, credentials, or production customer data in issues,
pull requests, logs, screenshots, or fixtures.

## Connector proposals

Connector proposals must document the provider's discovery, export,
erase/anonymize, and verification behavior. They must also explain idempotency,
rate limits, and retention behavior so reviewers can assess safe execution.
