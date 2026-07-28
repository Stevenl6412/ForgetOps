# ForgetOps Public Developer Preview Launch Design

Date: 2026-07-28

Owner: `@plantrungnampl`

Target repository: `https://github.com/plantrungnampl/ForgetOps`

License: Apache-2.0

## 1. Objective

Publish ForgetOps as a credible open-source Developer Preview that a developer
can understand, build, evaluate, and contribute to without overstating product
maturity.

The launch should maximize the conditions that can lead to adoption and GitHub
stars:

- a clear and differentiated problem statement;
- a trustworthy, reproducible build;
- one obvious path to evaluate the project;
- visible security and contribution practices;
- honest project status and limits.

Repository setup cannot guarantee a star count. Distribution, user value,
maintainer responsiveness, and continued delivery remain necessary after the
repository is public.

## 2. Current State

- The local repository is on `feature/forgetops-mvp`.
- `main` contains the original design baseline.
- The working tree contains the implementation and design-package refresh that
  the user explicitly wants published in full.
- TypeScript production builds pass.
- Rust compilation currently fails in `export-builder` because four
  `XNonce` values are passed by value where the crypto API requires references.
- API tests that require Testcontainers cannot run without a local Docker
  runtime; non-container API tests pass.
- The repository has no root README, license, contribution guide, security
  policy, code of conduct, or issue templates.
- The GitHub account `plantrungnampl` is authenticated and the repository name
  `ForgetOps` is available.

## 3. Launch Approach

### Selected: honest Developer Preview

Fix release-blocking compilation errors, verify the repository, add the minimum
open-source launch surface, then publish the implementation on `main`.

### Rejected alternatives

1. **Publish the current WIP unchanged.** Fast, but a red Rust build and missing
   project entrypoint would damage trust on first contact.
2. **Keep the repository private until the complete MVP exists.** Safer, but it
   delays real feedback and encourages additional implementation before product
   validation.

## 4. Product Positioning

Primary message:

> Privacy-preserving data deletion and export orchestration for modern SaaS.

Supporting message:

> ForgetOps coordinates discover, approve, delete, export, and verify workflows
> through a hosted TypeScript control plane and a self-hosted Rust agent, so raw
> customer data and connector credentials stay in the customer's environment.

Primary audience:

- technical founders and small engineering teams;
- SaaS products using Supabase or custom internal services;
- teams that need safer account-deletion and data-export workflows but do not
  want a broad enterprise privacy suite.

The README must label the project **Developer Preview** and must not claim legal
compliance, production readiness, complete connector coverage, or guaranteed
deletion from backups.

## 5. Public Repository Surface

### Root README

`README.md` will contain, in this order:

1. project name, one-sentence pitch, and Developer Preview badge;
2. the two supported product workflows;
3. why ForgetOps exists and the control-plane/customer-plane boundary;
4. architecture diagram from the authoritative design package;
5. current implemented capability and known limits;
6. verified development quickstart;
7. safety model: dry run, exact-plan approval, short-lived execution lease,
   idempotency, verification, and partial-completion handling;
8. monorepo map;
9. roadmap with near-term milestones only;
10. contribution and security-reporting links;
11. Apache-2.0 license notice.

The README will avoid large badge walls, speculative benchmarks, fake user
quotes, and unimplemented usage examples.

### Community and governance files

Add:

- `LICENSE` using the Apache License 2.0 text;
- `CONTRIBUTING.md` with environment setup, checks, pull-request expectations,
  and scoped contribution guidance;
- `SECURITY.md` directing private reports to GitHub private vulnerability
  reporting and documenting supported versions as Developer Preview only;
- `CODE_OF_CONDUCT.md` using Contributor Covenant 2.1 with enforcement handled
  by `@plantrungnampl`;
- `.github/CODEOWNERS`;
- `.github/PULL_REQUEST_TEMPLATE.md`;
- `.github/ISSUE_TEMPLATE/bug_report.yml`;
- `.github/ISSUE_TEMPLATE/feature_request.yml`;
- `.github/ISSUE_TEMPLATE/connector_request.yml`;
- `.github/ISSUE_TEMPLATE/config.yml`.

No governance committee, funding file, citation file, or release automation will
be added before the project has users who need them.

### Visual identity

Use the existing architecture diagram in the README. Add one simple 1280x640
social-preview image with the project name, concise pitch, and TypeScript/Rust
agent motif. Do not create a broader brand system or marketing site.

## 6. Code and Verification Gate

Before public creation:

1. scan tracked and untracked publish candidates for credentials and private
   material;
2. fix only the four Rust nonce-reference compilation errors;
3. run formatting checks;
4. run `pnpm build`;
5. run TypeScript tests that do not require Docker;
6. run the Rust workspace tests;
7. run container-backed tests if Docker is available;
8. record any environment-blocked checks honestly in the launch commit.

A failing compile, detected secret, or failing non-environment-dependent test
blocks publication to `main`.

Docker unavailability may be documented as an environment limitation only if
GitHub Actions is configured to execute the container-backed suite on the public
repository.

## 7. Git History and Branch Strategy

1. Preserve existing history.
2. Commit the approved public-launch design separately.
3. Commit the current full implementation scope with a truthful Developer
   Preview commit message after secret scanning and verification.
4. Commit open-source launch assets separately.
5. Fast-forward local `main` to the verified Developer Preview commit.
6. Create the public GitHub repository without generating remote starter files.
7. Push `main` and `feature/forgetops-mvp`.
8. Set `main` as the default branch.

No force push, history rewrite, squashing of existing commits, or deletion of the
feature branch is allowed.

## 8. GitHub Repository Settings

Configure:

- visibility: public;
- description: `Privacy-preserving data deletion and export orchestration for modern SaaS`;
- default branch: `main`;
- issues: enabled;
- discussions: enabled;
- wiki: disabled;
- projects: disabled until used;
- merge method: squash enabled; merge commits and rebase disabled;
- automatically delete merged branches: enabled;
- private vulnerability reporting: enabled where supported;
- dependency graph, Dependabot alerts, and secret scanning: enabled where
  supported for the public repository;
- topics:
  `privacy`, `gdpr`, `data-deletion`, `data-export`, `dsar`, `rust`,
  `typescript`, `self-hosted`, `supabase`, `developer-tools`.

Branch protection is deferred until the first external collaborator because a
solo-maintainer ruleset with unknown CI check names adds friction without
protecting against another writer.

## 9. Initial Growth Loop

The repository launch supports, but does not replace, distribution:

1. provide one reproducible Supabase-oriented evaluation path;
2. convert real setup friction into documentation fixes;
3. label only genuinely bounded issues as `good first issue`;
4. use Discussions for integration requests and design questions;
5. publish releases only after a tested vertical slice exists;
6. prioritize the first design partner over adding more speculative connectors.

The success signal for continued development is not stars alone. It is at least
one external team completing a dry run and agreeing to evaluate the agent in a
staging environment.

## 10. Non-goals

This launch does not include:

- a production-readiness claim;
- new product workflows or connectors;
- a hosted marketing site;
- billing, sponsorship, or monetization setup;
- fabricated adoption metrics or testimonials;
- broad refactoring unrelated to publication;
- a promise or purchase of GitHub stars.

## 11. Acceptance Criteria

The launch is complete when:

- `https://github.com/plantrungnampl/ForgetOps` is public;
- `main` contains the complete approved Developer Preview scope;
- the root README explains the project in under two minutes;
- Apache-2.0 and all selected community-health files are visible;
- no publish candidate contains a detected credential;
- TypeScript builds pass;
- the Rust workspace compiles and its tests pass;
- GitHub Actions starts on the pushed `main`;
- repository metadata, topics, Discussions, and security settings are applied;
- the local and remote commit SHAs match;
- known limitations are documented without being presented as completed work.
