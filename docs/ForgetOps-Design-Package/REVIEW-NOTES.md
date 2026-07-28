# ForgetOps Design Review Notes

**Review completed:** 2026-07-23
**Disposition:** Implementation-ready design baseline, subject to Gates S0-S3
**Normative source:** `docs/architecture/11-implementation-readiness-contracts.md`
## Outcome

The package is coherent enough to begin implementation after Gate S0 fixtures are approved. The review tightened claims at the trust boundaries, removed ambiguous retry and terminal-state behavior, made crash recovery explicit, and converted the implementation plan into a traceable set of release gates.

“Implementation-ready” does not mean the destructive path is ready for production. Production use remains blocked until the sandbox, pause/revocation, replacement, crash-boundary, export-key-loss, concurrency, and signed-release evidence in Gates S1-S3 passes.

## Resolved design issues

| Review issue | Resolution | Primary source |
|---|---|---|
| Hosted compromise claim was broader than the design could support. | Database-disclosure protection is stated separately from full application, frontend, or signer compromise. | Security threat model; Readiness Contract 1 |
| Failed and partially completed requests behaved like terminal states while also supporting retry. | Only `completed` and `cancelled` are permanently terminal. Retry creates a new immutable execution attempt; uncertain work can enter `needs_review`. | Domain model; Readiness Contract 3 |
| Agent replacement could silently change subject hashes. | The environment subject-HMAC key is stable, versioned, and independent from agent signing and encryption keys. Replacement drains active work or forces review. | Protocol; Readiness Contract 5 |
| Signature input used ambiguous field concatenation. | Signed messages use a domain-separated RFC 8785 canonical JSON preimage with key ID, audience, direction, sequence, nonce, and expiry. | Protocol; Readiness Contract 6 |
| A long-lived authorization weakened cancellation and the global pause while an agent was offline. | Each newly scheduled destructive step also requires an online execution lease valid for at most 90 seconds. | Protocol; Readiness Contract 7 |
| A crash after a remote mutation could repeat the operation. | The agent persists intent, records `in_flight`, and reconciles the remote state before deciding whether retry is safe. The claim is verified final state, not exactly-once API invocation. | Protocol; Readiness Contract 8 |
| Export key recovery and large-file behavior were underspecified. | Export creation is chunked and bounded. The agent retains the data key only in encrypted local state and wraps it on demand to a reauthenticated browser key. | Threat model; Readiness Contract 9 |
| Concurrent audit writers could fork the hash chain. | Sequence allocation and hashing lock a per-environment chain-head row in the same transaction as state and outbox changes. | Domain model; Readiness Contract 10 |
| Module boundaries described a monolith but did not enforce dependency direction. | Domain, application ports, adapters, and composition roots now have an explicit dependency rule and CI architecture test. | System architecture; Readiness Contract 11 |
| The implementation plan did not fully trace operational safety requirements. | Gates S0 and G1-G6 now cover leases, replacement, crash recovery, SSRF-safe webhooks, key loss, audit concurrency, 1,000 agents, and signed immutable releases. | Implementation plan Tasks 1-19 |

## Residual risks and explicit non-goals

- A fully malicious hosted application or served frontend can misrepresent future plans or read plaintext handled by that browser session. Stronger protection requires customer co-signing or a self-hosted control plane.
- An already-started connector call may finish after pause, cancellation, or revocation. The bound applies before the next destructive step and no later than the active lease expiry.
- ForgetOps does not promise exactly-once remote API invocation, global rollback, automatic deletion from immutable backups, universal connector coverage, or legal compliance.
- A compromised custom adapter cannot be constrained to a declared resource allowlist unless it runs under an independently enforced least-privilege service identity.

## Review evidence

- Canonical specification rebuilt from all 11 architecture chapters.
- Final architecture diagram replaced the earlier options diagram and was visually inspected.
- System design DOCX rendered and inspected across 76 pages.
- Implementation plan DOCX rendered and inspected across 43 pages.
- Package integrity is covered by `SHA256SUMS.txt`; the checksum file intentionally does not hash itself.
