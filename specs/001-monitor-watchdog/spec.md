# SPEC-001 — External watchdog for the uptime monitor

Standard: ADR-0004 (TDD + SDD), private architecture-docs repository.

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-001 / 1.0 |
| Status | approved |
| Repository / path | bookchaowalit/platform-uptime-worker / `specs/001-monitor-watchdog/spec.md` |
| Owner (maker) | Claude Code |
| Reviewer (checker) | Codex review Stop hook + a fresh Claude reviewer |
| Approver | Owner (bookchaowalit), in chat 2026-11-05 ("เฝ้า monitor ก่อน", after the audit proposed an hourly GitHub Actions check of `/status` with a Telegram alert) |
| Requirement links | Audit 2026-11-05, gap 1: "if both Worker crons stop, nothing reports it" |
| Main-only | yes (red run is local, red and green pushed together) |
| Created / approved | 2026-11-05 / 2026-11-05 |

## 1. Problem and intent

- **Problem:** The Worker `solo-empire-monitor` watches every service and every scheduled job, and each shard watches the other shard. Nothing watches the Worker itself: if both cron triggers stop, the Worker is deleted, the custom domain breaks, or Cloudflare cron triggers fail, no alert goes out. The posture monitor reports through the same Worker, so it goes silent too.
- **Outcome:** A check that runs outside Cloudflare (GitHub Actions on a GitHub-hosted runner) reads the public `/status` every hour and sends a Telegram message straight to the owner when the monitor is unreachable or its data is old. The Worker watches the watchdog back through a heartbeat, so if one of them stops, the other one reports it.
- **Why now:** Audit 2026-11-05 marked this as the highest-risk gap. It is also the smallest one to fix.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| `src/watchdog.ts` (pure check + run with injected fetch), `scripts/watchdog.ts` (entry point), `.github/workflows/watchdog.yml` (hourly), heartbeat `monitor-watchdog` in `HEARTBEATS` | Checking that the Worker's own Telegram token works (a broken token makes the Worker mute, and only the owner noticing missing alerts covers that); recovery messages and alert de-duplication (repeat each hour while broken; see AC-06) |

## 3. Behaviour — scenarios

Constants: `STALE_AFTER_MINUTES = 30` (5-minute crons plus a 60 s edge cache, with plenty of margin).

### AC-01 — Healthy monitor
- **Given** `/status` returns 200 with JSON `results` whose newest `checkedAt` is at most 30 minutes old
- **When** the watchdog runs
- **Then** it reports no problems, sends no Telegram message, and posts heartbeat `monitor-watchdog` with `{"ok":true}`, exit code 0
- **Test:** `test/watchdog.test.ts > "AC-01 ..."` · unit

### AC-02 — Crons stopped
- **Given** `/status` returns 200 but the newest `checkedAt` across all targets is older than 30 minutes
- **When** the watchdog runs
- **Then** it reports "no target probed for N min (both cron shards stopped?)", sends it to Telegram, posts no heartbeat, exit code 1
- **Test:** `test/watchdog.test.ts > "AC-02 ..."` · unit

### AC-03 — Monitor unreachable
- **Given** the `/status` fetch throws, times out (20 s), returns a non-2xx status, or returns a body that is not the expected JSON
- **When** the watchdog runs
- **Then** it reports "status unreachable: <reason>", sends it to Telegram, exit code 1
- **Test:** `test/watchdog.test.ts > "AC-03 ..."` · unit

### AC-04 — No usable data
- **Given** `/status` returns 200 with empty `results`, or with no valid `checkedAt` at all
- **When** the watchdog runs
- **Then** it reports "status has no probed targets", exit code 1
- **Test:** `test/watchdog.test.ts > "AC-04 ..."` · unit

### AC-05 — Telegram fails or is not configured
- **Given** a problem was found and the Telegram send fails (non-2xx or throws) or the token/chat ID is missing
- **When** the watchdog runs
- **Then** the exit code is still 1, so GitHub marks the run failed and emails the owner (second channel). The log says only that the send failed and never prints the token, the URL with the token, or the response body.
- **Test:** `test/watchdog.test.ts > "AC-05 ..."` · unit

### AC-06 — Repeats while broken
- **Given** the monitor stays broken
- **Then** every hourly run alerts again. No state is kept between runs (accepted: a rare outage, at most one message an hour).

### AC-07 — The Worker watches the watchdog
- **Given** `HEARTBEATS` in `src/targets.ts`
- **Then** it contains `{ job: 'monitor-watchdog', maxAgeHours: 6 }`. GitHub's hourly schedule often skips or delays runs, so the window allows several missed runs. It also catches GitHub turning off the schedule after 60 days of no repository activity.
- **Test:** `test/targets.test.ts > "AC-07 ..."` · unit

### AC-08 — Heartbeat failure does not hide a healthy check
- **Given** the check is healthy but the heartbeat POST fails or `HEARTBEAT_TOKEN` is missing
- **Then** no Telegram message is sent (the Worker reports the missing heartbeat after 6 h), and the exit code is 1 so the run shows red
- **Test:** `test/watchdog.test.ts > "AC-08 ..."` · unit

## 4. Interfaces and data

| Interface | Change | Contract |
|---|---|---|
| `GET https://monitor.bookchaowalit.com/status` | read only | `{ results: [{ name, checkedAt? }], timestamp }` (public, edge-cached 60 s) |
| `POST /heartbeat/monitor-watchdog` | new job | Bearer `HEARTBEAT_TOKEN`, body `{"ok":true}` |
| Telegram `sendMessage` | new caller | `book_noti_bot`, same chat as the Worker, text prefixed `[monitor-watchdog]` |
| GitHub secrets | new | `HEARTBEAT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (values from Infisical, never printed) |

- **Data model / migration:** N/A, no stored state.
- **Backward compatibility:** The Worker only gains one heartbeat entry.

## 5. Non-functional requirements

- Public repository: the log prints only the problem text and exit status (target names and ages, which `/status` already makes public), never a secret.
- Node 24 runs the TypeScript entry point directly (type stripping). The runtime needs no dependency install.
- Runtime < 1 min, job timeout 5 min, GitHub-hosted runner (public repo, free).

## 6. TDD log

| AC | Red (local, base 7e06147) | Green |
|---|---|---|
| AC-01..AC-05, AC-08 | `npx vitest run` → `Error: Cannot find module '../src/watchdog'` | `src/watchdog.ts`, tip CI |
| AC-07 | `npx vitest run` → `AssertionError: expected undefined to deeply equal { job: 'monitor-watchdog', …(1) }` | `src/targets.ts` entry, tip CI |

Live smoke before push: `HEARTBEAT_TOKEN= node scripts/watchdog.ts` against production → `ok: monitor is probing`, then `heartbeat: HEARTBEAT_TOKEN missing`, exit 1 (as AC-08 says).
