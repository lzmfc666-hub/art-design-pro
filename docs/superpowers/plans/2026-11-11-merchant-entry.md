# Independent Merchant Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the confirmed `merchant.jinxiaodun.top` through its own Node entrance while sharing the existing business API/database.

**Architecture:** Add an independently deployed minimal stdlib Node gateway on127.0.0.1:3009. It reads the current admin production build without editing it, executes merchant bootstrap before modules and proxies merchant-only cookies/channel to the fixed current API. Retain request Host and Origin so current CSRF validation remains intact. Install this gateway outside `/www/studio-app`; do not change the running application release or restart existing API/player.

**Tech Stack:** Node24 stdlib HTTP/HTTPS/filesystem, existing source-address protection helper, current optimized Vue assets, Nginx/BT.

**Spec:** ../specs/2026-11-11-merchant-entry.md

## Global Constraints

- Original C root, live business data, accounts, images, configuration and backups stay untouched.
- User manually operates all server changes; no remote tool actions.
- No second business service/database, dependency installation, modified build assets or weakened Origin/identity checks.
- Base release72540 remains unchanged on production; new package lives under `/www/studio-merchant`.

## Review Focus

- Preserve valid hash deep links, queries and same-origin redirects, including root paths beginning with double slashes.
- Actual public HTTPS Origin works through preserved Host; foreign Origin remains403.
- Forged admin channel/cookies/auth/forwarding headers cannot grant main-backend privileges.
- Binary upload, private images, logout/owner transitions still use real merchant authorization.
- New host defaults to merchant login before import-time client selection; no redirect loop or internal login screen.

### Task1: Gateway contract and implementation

**Files:** Create scripts/merchant-client-server.mjs; create tests/merchant-proxy.test.mjs. Reuse existing server/runtime-protection.mjs unmodified in independent package.

- [ ] Write isolated real HTTP/merchant integration tests and observe missing-module RED.
- [ ] Implement createMerchantClientServer({staticRoot,apiTarget,trustedProxies}), fixed-upstream merchant channel/cookie filtering, retainedHost/Origin and no-store bootstrap/static checks.
- [ ] Execute focused proxy/security tests GREEN; review lifecycle, errors, HEAD, binary bytes and cache boundaries.

### Task2: Browser and regression validation

- [ ] Verify actual optimized build/root/deep-link login/staff/logout/upload/image against real isolated API and independent Node entry, no mocked responses.
- [ ] Run complete existing Node suite without unrelated source changes; verify original747 runtime source/build hashes unchanged apart from new gateway/test/config paths.

### Task3: Independent package and manual rollout

- [ ] Package gateway+unchanged source helper+minimal package metadata+Nginx example+ASCII instructions with per-file manifest and ZIP SHA, excluding DB/env/dependencies.
- [ ] Independently verify package and extracted gateway; provide one upload/extraction path and BT Node startup settings3009.
- [ ] Guide DNS A record, new merchant Node project, Nginx reverse proxy and HTTPS; verify local3009 and publicmerchant login/real shared data.
- [ ] Resume earlier redundant backup cleanup/native reserve and all production acceptance checks.

The existing primary persistent plan in the original merchant-staff project's selected `.planning` directory owns this continuation.
