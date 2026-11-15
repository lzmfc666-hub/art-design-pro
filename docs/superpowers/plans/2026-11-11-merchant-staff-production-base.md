# Merchant and support production-baseline integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved merchant client and merchant-owned support accounts to verified live release `63422e1fa84eec92f537cea439516ee20fb894c3f0e3799a456a83abdf6180b4`, retaining its existing business behavior.

**Architecture:** Use the exact verified production archive in a new isolated D-drive repository. Merge only merchant functionality from the prior candidate against its common C-repository base, preserving production lottery, order lifecycle/reward policy, private-image processing, runtime capabilities and canonical release identity. Keep the existing merchant role with server-bound merchant scope and derive the single owner from merchant.ownerUserId.

**Tech Stack:** Node24, built-in SQLite, Vue3, TypeScript, Vite, pnpm11; unchanged production dependencies and both lockfiles.

**Spec:** [Merchant support specification](../specs/2026-11-11-merchant-staff.md); full merchant credit/scoping contract in `docs/STUDIO-CONTRACT.md`.

## Global Constraints

- Original C project, real server processes, accounts, database, images and backup schedules stay untouched during development. The user operates production manually.
- The first C-derived merchant support ZIP is incompatible with live production and must never be copied over it or used as authority to remove production-only files.
- Preserve the existing single cancellation/refund entry, cancellationPolicyVersion1, permanent base reward decisions, refund execution closure, lottery invalidation and cached-image authorization.
- Full merchant prerequisite and staff management are both required; the production baseline has no merchant module.
- Owner transfer is super_admin only; old owner disabled. Merchant owner manages only own support. Soft deletion removes login eligibility, preserves stable responsibility and allows a fresh identity to reuse the login name.
- Merchant cancellation is whole-order cancellation before review acceptance and never a money/refund request. Completed/reviewed cancellation remains internal finance.
- Preserve production package.json dependency fields, pnpm-workspace.yaml and both lockfiles. Install only the new isolated project's frozen dependencies for local verification.

## Review Focus

- Unpaid merchant credit authorizes ordinary fulfillment, never stored/refunded/canceled replay paths.
- Same-merchant sharing and duplicate nicknames retain stable creator/operator IDs after deletion and username reuse.
- Merchant-only simple cancellation cannot expose internal refund forms, worker reward amounts or private evidence.
- Role-restricted lottery menus and owner-only staff menus apply both restrictions and invalidate cached access after identity changes.
- Release packaging retains every production source path and unchanged dependencies, includes both new builds and excludes business data, environment files and dependencies.

## Task1: Restore and prove the production base

- [x] Verify archive SHA, all1341 files, embedded live release and all717 source hashes.
- [x] Extract source and old builds into a new isolated root; retain public-only build environment locally and exclude private/data paths.
- [x] Commit the717-source baseline; preserve original C source digest unchanged.
- [x] Install with pnpm11 --frozen-lockfile and verify Node24 sharp0.35.5; no dependency or lock changes.

## Task2: Merge full merchant backend and support management

- [x] Copy merchant tests and record14 expected missing-merchant failures before implementation.
- [x] Three-way merge seven server files while retaining production cancellation/lottery/image implementations.
- [x] Adapt new merchant-only cancellation tests to retained permanent closure, released assignments and zero unsettled reward; keep production tests unchanged.
- [x] Add cross-feature regressions and prove stable audit actorId red-to-green.
- [x] Review all backend changes and run the combined complete suite.

## Task3: Merge the frontend and both-client integration

- [x] Record merchant-entry and owner-route contract failures before implementation.
- [x] Merge merchant client and staff management while preserving production lottery/refund/private-image/navigation changes.
- [x] Verify role+owner route conjunction and merchant cancellation request shape without internal money fields.
- [x] Run both type checks, both production builds and actual browser flows against isolated databases.

## Task4: Reissue a compatible reviewable package

- [x] Record a canonical release and verify every source/build hash and unchanged production dependency metadata.
- [x] Include all production source paths; do not remove any live module as an alleged old file.
- [x] Package with ASCII internal documentation filenames, release verification evidence, explicit live baseline and safe manual deploy/rollback instructions.
- [x] Independently inspect ZIP contents/CRC/hash and source immutability after verification.

## Task5: Resume user-operated cutover

- [ ] Verify uploaded replacement and actual running baseline again.
- [ ] Budget final backup space without reducing native backup protection; take final consistent snapshot after stopping only the exact BT projects.
- [ ] Replace only application source and two whole dist directories; preserve environment, data, dependencies and manager configuration.
- [ ] Verify installed release, both clients, account/order continuity and backup timers; guide explicit merchant-owner assignment.

The primary persistent task plan remains in the original merchant-staff project's named `.planning/2026-11-11-merchant-staff` directory. This file describes the rebase implementation, not a competing task-plan selector.
