# ForgetOps Public Developer Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a verified, honest, and contribution-ready ForgetOps
Developer Preview at `https://github.com/plantrungnampl/ForgetOps`.

**Architecture:** Preserve the existing TypeScript control-plane and self-hosted
Rust-agent design. Make only the compatibility fix required for the current Rust
crypto API, then add a thin open-source repository surface around the existing
implementation. Publish the verified commit on `main` without rewriting history.

**Tech Stack:** Node.js 22, pnpm 11.16.0, TypeScript 6, Next.js 16, Fastify 5,
PostgreSQL 17, Redis 7, Rust 1.97.1, Cargo Nextest 0.9.140, GitHub Actions,
GitHub CLI 2.96+, Apache-2.0.

## Global Constraints

- Repository visibility must be public.
- License must be Apache-2.0.
- Public status must be labeled **Developer Preview**.
- Do not claim legal compliance, production readiness, complete connector
  coverage, or guaranteed backup deletion.
- Do not add a runtime dependency, marketing site, new connector, billing,
  sponsorship, governance committee, or speculative abstraction.
- Do not force-push, rewrite history, delete the feature branch, or silently
  remove existing user work.
- A detected credential, failing compile, or failing non-environment-dependent
  test blocks publication.
- Docker-unavailable tests may remain locally blocked only when GitHub Actions
  is configured to run them.
- Stage explicit paths except for the one implementation commit where the user
  has explicitly authorized the complete non-ignored working tree.

---

## File Map

### Modify

- `agent/crates/export-builder/src/encryption.rs` — borrow `XNonce` values for
  chunk encrypt/decrypt calls.
- `agent/crates/export-builder/src/key_wrap.rs` — borrow `XNonce` values for
  archive-key wrap/unwrap calls.
- `.github/workflows/ci.yml` — add least-privilege permissions, cancellation,
  and a bounded timeout.

### Create

- `README.md` — public entrypoint, status, architecture, quickstart, and limits.
- `LICENSE` — canonical Apache License 2.0 text.
- `CONTRIBUTING.md` — development and contribution workflow.
- `SECURITY.md` — supported status and private reporting route.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `.github/CODEOWNERS` — default ownership by `@plantrungnampl`.
- `.github/PULL_REQUEST_TEMPLATE.md` — scoped change and verification checklist.
- `.github/ISSUE_TEMPLATE/bug_report.yml` — reproducible bug reports.
- `.github/ISSUE_TEMPLATE/feature_request.yml` — problem-first feature requests.
- `.github/ISSUE_TEMPLATE/connector_request.yml` — connector demand and API
  capability evidence.
- `.github/ISSUE_TEMPLATE/config.yml` — route security reports away from public
  issues.
- `docs/assets/forgetops-social-preview.png` — 1280x640 repository preview.

### Existing evidence used by the public surface

- `docs/ForgetOps-Design-Package/README.md`
- `docs/ForgetOps-Design-Package/diagrams/architecture-final.svg`
- `docs/ForgetOps-Design-Package/docs/architecture/01-product-scope.md`
- `docs/ForgetOps-Design-Package/docs/architecture/06-security-privacy-threat-model.md`
- `docs/ForgetOps-Design-Package/docs/architecture/10-roadmap-and-decisions.md`
- `deploy/control-plane/docker-compose.yml`
- `deploy/agent-compose/docker-compose.yml`

---

### Task 1: Preflight, Repair the Rust Build, and Capture the Developer Preview

**Files:**

- Modify: `agent/crates/export-builder/src/encryption.rs:34-82`
- Modify: `agent/crates/export-builder/src/key_wrap.rs:20-77`
- Stage: every non-ignored modified, deleted, and untracked path after the
  publication scan passes

**Interfaces:**

- Consumes:
  `XChaCha20Poly1305::encrypt(&XNonce, Payload)` and
  `XChaCha20Poly1305::decrypt(&XNonce, Payload)` from
  `chacha20poly1305 = 0.11.0`.
- Produces: the same public `encrypt_chunk`, `decrypt_chunk`,
  `wrap_archive_key`, and `unwrap_archive_key` signatures with no behavior or
  serialized-format change.

- [x] **Step 1: Inventory publication candidates without printing secret
      values**

Run:

```powershell
git status -sb
git diff --stat
git diff --cached --stat
git ls-files --cached --others --exclude-standard |
  ForEach-Object { Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue } |
  Where-Object Length -GT 10MB |
  Select-Object FullName, Length
```

Expected:

- branch is `feature/forgetops-mvp`;
- only the approved design commit is already committed;
- no publish candidate exceeds 10 MB without an explicit reason;
- `node_modules`, `target`, `.next`, `.turbo`, `.env`, and local databases are
  excluded by `.gitignore`.

- [x] **Step 2: Scan publish candidates for high-confidence credential
      patterns**

Run:

```powershell
rg -l -n --hidden `
  --glob '!.git/**' `
  --glob '!node_modules/**' `
  --glob '!target/**' `
  --glob '!.turbo/**' `
  --glob '!.next/**' `
  '(^|[^A-Za-z0-9_-])(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk-(proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})($|[^A-Za-z0-9_-])' .
```

Expected: no output. If output appears, stop; report only file paths, never
secret values, and remove or rotate the credential before continuing.

- [x] **Step 3: Reproduce the Rust failure**

Run:

```powershell
cargo test -p export-builder --no-run
```

Expected: FAIL with four `E0308` errors stating that `encrypt` or `decrypt`
expected a reference to `XNonce`.

- [x] **Step 4: Apply the minimal compatibility fix**

In `agent/crates/export-builder/src/encryption.rs`, change only the nonce
arguments:

```rust
let ciphertext = cipher
    .encrypt(
        &nonce_ref,
        Payload {
            msg: plaintext,
            aad,
        },
    )
    .map_err(|_| ArchiveEncryptionError::AuthenticationFailed)?;
```

```rust
cipher
    .decrypt(
        &XNonce::try_from(&nonce[..])
            .map_err(|_| ArchiveEncryptionError::InvalidNonce)?,
        Payload {
            msg: ciphertext,
            aad,
        },
    )
```

In `agent/crates/export-builder/src/key_wrap.rs`, change only the nonce
arguments:

```rust
let ciphertext = cipher
    .encrypt(
        &XNonce::try_from(&nonce[..])
            .map_err(|_| ArchiveEncryptionError::InvalidNonce)?,
        Payload {
            msg: archive_key,
            aad: &aad,
        },
    )
```

```rust
let plaintext = cipher
    .decrypt(
        &XNonce::try_from(&wrapped.nonce[..])
            .map_err(|_| ArchiveEncryptionError::InvalidNonce)?,
        Payload {
            msg: &wrapped.ciphertext,
            aad: &aad,
        },
    )
```

Do not change nonce size, key derivation, AAD, error mapping, or public types.

- [x] **Step 5: Verify the focused crate**

Run:

```powershell
cargo fmt --all -- --check
cargo test -p export-builder
```

Expected: formatting passes and all `export-builder` tests pass, including
chunk round-trip and archive-key wrap/unwrap.

- [x] **Step 6: Run the repository verification gate**

Run:

```powershell
pnpm format:check
pnpm lint
pnpm build
cargo nextest run --workspace
```

Then, when Docker is available:

```powershell
pnpm test
```

Expected:

- format, lint, TypeScript build, and Rust workspace tests pass;
- the full `pnpm test` passes with Testcontainers when Docker is available.

If another code failure appears, fix only a direct compatibility or correctness
defect required by this gate. Stop and revise the plan if the repair requires a
new feature, dependency, schema change, or architectural decision.

- [x] **Step 7: Commit the complete authorized implementation scope**

Run:

```powershell
git add -A
git diff --cached --check
git diff --cached --stat
git commit -m "feat: complete ForgetOps developer preview"
```

Expected: all non-ignored user-authorized implementation and design-package
changes are committed; ignored build artifacts remain untracked and unstaged.

---

### Task 2: Add the Public README and Community Health Surface

**Files:**

- Create: `README.md`
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `.github/CODEOWNERS`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/connector_request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: verified commands and current capability evidence from Task 1.
- Produces: the repository landing page, contribution contract, private security
  route, issue intake, and bounded CI policy used by GitHub after publication.

- [x] **Step 1: Write the README opening and status**

Use this exact opening:

```markdown
# ForgetOps

> Privacy-preserving data deletion and export orchestration for modern SaaS.

**Status: Developer Preview.** ForgetOps is under active development and is not
production-ready. It automates configured data-lifecycle policy; it does not
determine legal obligations or guarantee regulatory compliance.

ForgetOps coordinates account deletion and data export across application
databases and third-party systems. A TypeScript control plane manages lifecycle
and audit metadata, while a self-hosted Rust agent keeps raw identities,
connector credentials, and export contents in your environment.
```

Follow it with:

- the existing `architecture-final.svg`;
- a concise “Why ForgetOps” section;
- Delete account and Export my data workflow summaries;
- an “Implemented in this preview” list backed by current code/tests;
- a “Known limits” list that names incomplete connectors and missing production
  validation;
- the safety model;
- development quickstart;
- monorepo map;
- near-term roadmap;
- contribution, security, and license links.

Use this development quickstart:

````markdown
## Development quickstart

Prerequisites: Node.js 22, pnpm 11.16.0, Rust 1.97.1, and Docker for
container-backed integration tests.

```bash
git clone https://github.com/plantrungnampl/ForgetOps.git
cd ForgetOps
corepack enable
pnpm install --frozen-lockfile
pnpm build
cargo test --workspace
```

Run `pnpm test` with Docker available to include PostgreSQL/Testcontainers
integration coverage.
````

Do not describe this as a product quickstart or claim an end-to-end production
deployment.

- [x] **Step 2: Add the Apache-2.0 license**

Create `LICENSE` with the canonical Apache License 2.0 text and verify:

```powershell
Get-Content -TotalCount 3 LICENSE
```

Expected first line: `Apache License`.

- [x] **Step 3: Add contribution and security contracts**

`CONTRIBUTING.md` must include:

- prerequisites copied from the README;
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build`, and
  `cargo nextest run --workspace`;
- one scoped concern per pull request;
- tests for behavior changes;
- no raw PII, credentials, or production customer data in issues or fixtures;
- connector proposals must document discovery, export, erase/anonymize, verify,
  idempotency, rate limits, and retention behavior.

`SECURITY.md` must state:

```markdown
# Security Policy

## Supported versions

ForgetOps is currently a Developer Preview. No release is supported for
production use yet.

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting:
https://github.com/plantrungnampl/ForgetOps/security/advisories/new

Include affected component, reproduction steps, impact, and any suggested
mitigation. Do not include real customer data or active credentials.
```

Use Contributor Covenant 2.1 in `CODE_OF_CONDUCT.md`. Route private conduct
reports through the same private-advisory URL with `[Conduct]` in the title.

- [x] **Step 4: Add focused GitHub templates**

Create:

```text
.github/
  CODEOWNERS
  PULL_REQUEST_TEMPLATE.md
  ISSUE_TEMPLATE/
    bug_report.yml
    connector_request.yml
    feature_request.yml
    config.yml
```

`CODEOWNERS`:

```text
* @plantrungnampl
```

Every issue form must require:

- a problem statement or reproduction;
- affected component/version;
- confirmation that no secrets or personal data are included;
- acceptance of the Code of Conduct.

`config.yml` must disable blank issues and link security reports to:

```yaml
blank_issues_enabled: false
contact_links:
  - name: Security vulnerability
    url: https://github.com/plantrungnampl/ForgetOps/security/advisories/new
    about: Report vulnerabilities privately. Do not open a public issue.
```

- [x] **Step 5: Harden the existing CI workflow without adding actions**

Add at workflow scope:

```yaml
permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Add to the `test` job:

```yaml
timeout-minutes: 30
```

Retain the existing pinned Node, pnpm, Rust, Nextest, PostgreSQL, and Redis
versions and the format/lint/test/build order.

- [x] **Step 6: Validate public files**

Run:

```powershell
pnpm exec prettier --check README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md .github
git diff --check
rg -n 'production-ready|guarantee.*compliance|TBD|TODO|PLACEHOLDER' README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md .github
```

Expected:

- Prettier and diff checks pass;
- the only `production-ready` occurrence is the explicit negation in README;
- no compliance guarantee, placeholder, or incomplete instruction exists.

- [x] **Step 7: Commit the open-source surface**

Run:

```powershell
git add README.md LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md .github
git diff --cached --check
git commit -m "docs: prepare open source developer preview"
```

Expected: only public repository documentation, templates, and CI hardening are
included.

---

### Task 3: Create and Add the Social Preview

**Files:**

- Create: `docs/assets/forgetops-social-preview.png`

**Interfaces:**

- Consumes: product positioning and architecture boundary from the approved
  design.
- Produces: a 1280x640 PNG under 1 MB for GitHub social sharing.

- [x] **Step 1: Generate one restrained preview asset**

Use the image-generation skill with this prompt:

```text
Create a clean 1280x640 open-source repository social preview for "ForgetOps".
Dark navy solid background, subtle violet and cyan data-flow lines, a small
shield/check motif connecting a TypeScript control plane to a self-hosted Rust
agent. Large readable title "ForgetOps". Subtitle: "Privacy-preserving data
deletion & export orchestration". Minimal developer-tool aesthetic, no gradients
behind text, no fake UI, no logos of other companies, no badges, no extra copy.
```

- [x] **Step 2: Verify the asset**

Run:

```powershell
Get-Item 'docs/assets/forgetops-social-preview.png' |
  Select-Object FullName, Length
```

Inspect the image at original detail. Expected:

- exactly 1280x640;
- under 1 MB;
- title and subtitle are legible;
- no malformed text or third-party branding.

- [x] **Step 3: Commit the asset**

Run:

```powershell
git add -- 'docs/assets/forgetops-social-preview.png'
git commit -m "docs: add ForgetOps social preview"
```

---

### Task 4: Run the Final Publication Gate

**Files:**

- Verify only; do not modify files unless a gate exposes a scoped defect.

**Interfaces:**

- Consumes: Tasks 1-3 commits.
- Produces: a clean commit that is safe to make the public default branch.

- [x] **Step 1: Verify Git state and publication contents**

Run:

```powershell
git status -sb
git diff
git diff --cached
git log -5 --oneline --decorate
```

Expected: clean working tree on `feature/forgetops-mvp`; no staged changes.

- [x] **Step 2: Repeat the secret and large-file scans**

Repeat Task 1 Steps 1-2. Expected: no secret-pattern matches and no unexplained
file over 10 MB.

- [x] **Step 3: Run all release checks**

Run:

```powershell
pnpm format:check
pnpm lint
pnpm build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run --workspace
pnpm test
```

Expected: all checks pass. If Docker is unavailable, `pnpm test` may be recorded
as blocked only after non-container TypeScript tests pass and the CI workflow is
confirmed to run the full command on GitHub.

- [x] **Step 4: Fast-forward `main` without rewriting history**

Run:

```powershell
git branch --show-current
git switch main
git merge --ff-only feature/forgetops-mvp
git switch feature/forgetops-mvp
```

Expected: `main` and `feature/forgetops-mvp` point to the same verified launch
commit; the active branch returns to `feature/forgetops-mvp`.

---

### Task 5: Create, Configure, Push, and Verify the Public Repository

**Files:**

- Remote GitHub repository settings only.
- Local `.git/config` gains `origin`.

**Interfaces:**

- Consumes: clean, verified local `main` and `feature/forgetops-mvp`.
- Produces: public `plantrungnampl/ForgetOps` with `main` as default and the
  approved community/security configuration.

- [x] **Step 1: Reconfirm GitHub identity and repository availability**

Run:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' auth status
& 'C:\Program Files\GitHub CLI\gh.exe' api user --jq .login
& 'C:\Program Files\GitHub CLI\gh.exe' repo view plantrungnampl/ForgetOps
```

Expected: logged in as `plantrungnampl`; repository lookup returns not found.
If it exists, stop and inspect it instead of overwriting or replacing it.

- [x] **Step 2: Create the empty public repository**

Run:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' repo create plantrungnampl/ForgetOps `
  --public `
  --source . `
  --remote origin `
  --description 'Privacy-preserving data deletion and export orchestration for modern SaaS'
```

Expected: repository created with no generated README, license, or `.gitignore`;
`origin` points to `https://github.com/plantrungnampl/ForgetOps.git`.

- [x] **Step 3: Push both approved branches**

Run:

```powershell
git push -u origin main
git push -u origin feature/forgetops-mvp
```

Expected: both pushes succeed without force; remote `main` matches local `main`.

- [x] **Step 4: Configure repository features and merge behavior**

Run:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' repo edit plantrungnampl/ForgetOps `
  --visibility public `
  --description 'Privacy-preserving data deletion and export orchestration for modern SaaS' `
  --enable-issues `
  --enable-discussions `
  --enable-wiki=false `
  --enable-projects=false `
  --delete-branch-on-merge `
  --enable-squash-merge `
  --enable-merge-commit=false `
  --enable-rebase-merge=false

& 'C:\Program Files\GitHub CLI\gh.exe' repo edit plantrungnampl/ForgetOps `
  --add-topic privacy `
  --add-topic gdpr `
  --add-topic data-deletion `
  --add-topic data-export `
  --add-topic dsar `
  --add-topic rust `
  --add-topic typescript `
  --add-topic self-hosted `
  --add-topic supabase `
  --add-topic developer-tools
```

Expected: settings and ten topics are visible on the repository.

- [x] **Step 5: Enable supported security features**

Run:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' api `
  --method PATCH `
  repos/plantrungnampl/ForgetOps `
  -F security_and_analysis[secret_scanning][status]=enabled `
  -F security_and_analysis[secret_scanning_push_protection][status]=enabled `
  -F security_and_analysis[dependabot_security_updates][status]=enabled

& 'C:\Program Files\GitHub CLI\gh.exe' api `
  --method PUT `
  repos/plantrungnampl/ForgetOps/private-vulnerability-reporting
```

Expected: every feature supported for the public personal repository is enabled.
If GitHub returns an unsupported-plan response for one setting, record that
specific limitation and continue without weakening another setting.

- [x] **Step 6: Upload the social preview**

Open repository Settings > General > Social preview and upload:

```text
docs/assets/forgetops-social-preview.png
```

Expected: GitHub shows the 1280x640 ForgetOps preview. This is the only manual
browser surface if GitHub does not expose an API for the upload.

- [x] **Step 7: Verify remote state and CI**

Run:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' repo view plantrungnampl/ForgetOps `
  --json nameWithOwner,url,visibility,defaultBranchRef,description,repositoryTopics

git ls-remote origin refs/heads/main refs/heads/feature/forgetops-mvp
git rev-parse main
git rev-parse feature/forgetops-mvp

& 'C:\Program Files\GitHub CLI\gh.exe' run list `
  --repo plantrungnampl/ForgetOps `
  --limit 5
```

Expected:

- URL is `https://github.com/plantrungnampl/ForgetOps`;
- visibility is `PUBLIC`;
- default branch is `main`;
- local and remote `main` SHAs match;
- GitHub Actions has started for the `main` push.

- [x] **Step 8: Inspect the rendered public landing page**

Verify in a browser:

- README image and links render;
- Developer Preview warning is above the fold;
- license, security policy, contribution guide, and code of conduct appear in
  the community profile;
- issue forms and Discussions are available;
- no private path, local username, credential, or unsupported product claim is
  visible.

No release tag is created in this launch. Create the first release only after a
tested end-to-end vertical slice is available.
