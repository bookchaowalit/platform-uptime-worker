# SPEC-003 — Daily sweep of the static sites

Standard: ADR-0004 (TDD + SDD).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-003 / 1.0 |
| Status | approved |
| Repository / path | bookchaowalit/platform-uptime-worker / `specs/003-static-sweep/spec.md` |
| Owner (maker) | Claude Code (interface-coverage goal, wave 2) |
| Reviewer (checker) | Codex review Stop hook |
| Approver | Owner (bookchaowalit), goal "Interface & Platform Coverage" 2026-11-12, done-criterion 6 (every live service is monitored) |
| Requirement links | solo-empire `interface-coverage.yaml` `ops_baseline.static_sites`: 115 live Vercel-only sites with no automated check (portfolio `deploy-smoke` runs by hand only) |
| Main-only | yes |
| Created / approved | 2026-11-12 / 2026-11-12 |

## 1. Problem and intent

The Worker probes 70 services every 5 minutes, but the free plan allows 50 subrequests per run, so
the 115 static portfolio sites cannot join it. Nothing tells the owner when one of them breaks
(expired domain, deleted Vercel project, failed build). A daily check from a GitHub-hosted runner
is enough for sites that change only when someone deploys them.

## 2. Scope

| In scope | Out of scope |
|---|---|
| `src/static-sites.ts` (generated list), `src/static-sweep.ts` (logic), `scripts/static-sweep.ts`, `.github/workflows/static-sweep.yml` (daily), heartbeat `static-sweep` | content checks, performance, the 70 services the Worker already probes |

## 3. Behaviour

### AC-01 — A site is up when it answers below 400 after redirects
HEAD first; on 403/405/501 retry with GET. A network error or timeout (15 s) is retried once. 4xx/5xx after that is down.

### AC-02 — All up: heartbeat ok, no message
Posts heartbeat `static-sweep` `{ok:true, sites:n}`, sends no Telegram message, exit 0.

### AC-03 — Some down: one Telegram message, heartbeat not ok
One message `[static-sweep] 🔴 n of m sites down:` with up to 20 `status url` lines (and "+k more"); heartbeat `{ok:false, failed:n}` so the Worker alerts too; exit 1.

### AC-04 — The list is generated and sane
Every entry is a unique `https://…/` URL; the list is not empty.

### AC-05 — Bounded concurrency
At most 8 requests in flight.

### AC-06 — The Worker watches the sweep
`HEARTBEATS` has `static-sweep` with a 26 h window.

## 4. Rollback

Disable the workflow (`gh workflow disable static-sweep.yml`) and drop the heartbeat entry.
