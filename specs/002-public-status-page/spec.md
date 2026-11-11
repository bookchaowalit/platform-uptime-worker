# SPEC-002 — Public status page for customers

Standard: ADR-0004 (TDD + SDD), private architecture-docs repository. Design floor: ADR-0007 (WCAG 2.2).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-002 / 1.0 |
| Status | approved |
| Repository / path | bookchaowalit/platform-uptime-worker / `specs/002-public-status-page/spec.md` |
| Owner (maker) | Claude Code (interface-coverage goal, wave 1) |
| Reviewer (checker) | Codex review Stop hook |
| Approver | Owner (bookchaowalit), goal "Interface & Platform Coverage" 2026-11-12 (backlog P-status, Linear BOO-422) |
| Requirement links | solo-empire `repository-catalog/registries/interface-coverage.yaml` → matrix C `status-page-uptime` (partial: no customer-facing status page) |
| Main-only | yes |
| Created / approved | 2026-11-12 / 2026-11-12 |

## 1. Problem and intent

- **Problem:** `monitor.bookchaowalit.com/` shows a bare English list of 58 internal service names (`tasks-api`, `cash-flow-api`, …). A customer of a SaaS product cannot tell from it whether *their* product works, the page is blank without JavaScript, colour is the only state signal on the cards, and stale probes look healthy.
- **Outcome:** One public status page that SaaS footers can link to: Thai first with English labels, services grouped by the product a customer knows, an overall verdict at the top, stale data shown as such, readable without JavaScript, and accessible (WCAG 2.2 AA).
- **Non-goals:** incident history, subscriptions, uptime percentages (no history is stored; KV write budget is fixed), showing `client` targets (unchanged: public JSON stays limited to `own`).

## 2. Scope

| In scope | Out of scope |
|---|---|
| `src/status-page.ts` (pure grouping + verdict + HTML), route `/` in `src/worker.ts`, tests | `/status` JSON shape (unchanged), `src/targets.ts` (unchanged), alerting |

## 3. Behaviour — scenarios

### AC-01 — Every public target lands in exactly one product group
- **Given** the public `/status` results
- **When** `groupResults` runs
- **Then** every result is in exactly one group; group order is fixed (Life OS, Finance, CRM & sales, AI, Data & knowledge, Platform, Websites); an unmatched name goes to Platform
- **Test:** `test/status-page.test.ts > "AC-01 …"`

### AC-02 — Overall verdict
- **Given** results
- **Then** verdict is `down` when any result is `down`, else `degraded` when any is `unknown` or `stale`, else `up`; each verdict has a Thai and English sentence
- **Test:** `AC-02 …`

### AC-03 — A group's state is its worst member
- `down` > `degraded` (unknown or stale) > `up`
- **Test:** `AC-03 …`

### AC-04 — Page works without JavaScript and is accessible
- **Then** the HTML has `lang="th"`, a `<main>` landmark, a `<noscript>` link to `/status`, an `aria-live="polite"` region for the verdict, state written as text (not colour only), `prefers-color-scheme` dark tokens, `prefers-reduced-motion` respected, no external script or style URLs
- **Test:** `AC-04 …`

### AC-05 — Route and headers
- **Given** `GET /`
- **Then** 200 `text/html; charset=utf-8`, `Cache-Control: public, max-age=60`, a `Content-Security-Policy` that allows only same-origin `connect-src` and the page's inline script/style, `X-Content-Type-Options: nosniff`
- **Test:** `test/worker.test.ts > routing`

## 4. Non-functional

- No extra KV reads: the page fetches `/status`, which is already edge-cached for 60 s.
- Page HTML under 20 KB.
- Refreshes itself every 60 s while visible.

## 5. Rollback

Redeploy the previous Worker version (`wrangler rollback`) — the route and JSON are unchanged.
