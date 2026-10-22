---
title: "Solo Empire Cloud Monitor"
tags: [documentation, infra]
created: 2026-07-09
updated: 2026-10-22
description: "Documentation for Solo Empire Cloud Monitor."
---

# Solo Empire Cloud Monitor

Cloudflare Worker that monitors your services 24/7 on the **free tier**.

## Features

- Checks every production service (own + hosted client services) every 5 minutes. The list
  lives in `src/targets.ts`; two cron triggers split it into shards (by a hash of the target name,
  so adding or removing a target never moves the others) so each run stays under the
  free plan's 50-subrequest limit.
- The 31 services that use Railway "sleep when idle" are probed once an hour (a 5-minute probe would
  keep them awake and billed all the time), so an outage there is reported within about 2 hours.
  Everything else is probed every 5 minutes.
- Telegram alert when a target fails twice in a row (about 10 minutes), a reminder every 6 hours
  while it stays down, and a recovery message.
- Heartbeats for scheduled jobs: `POST /heartbeat/<job>` with `Authorization: Bearer
  <HEARTBEAT_TOKEN>`. A report with `"ok": false` alerts straight away; a job that misses its window
  (`db-backup`: 26 hours) alerts too.
- `/status`: public JSON limited to own services, without URLs or errors. With
  `Authorization: Bearer <MONITOR_TOKEN>` it returns everything, heartbeats included.
- `/check?shard=0|1` (token-protected) probes one shard right away and reports, read-only: it never writes state or sends alerts.
- Each shard stores only the targets it owns, and `/status` reads every target from its own shard,
  with `stale: true` when the last probe is older than 30 minutes (2.5 hours for sleeping services).
- Each shard also watches the next shard's targets and alerts (`⏰ <name> not probed for …`) when
  one has not been probed within that window: a stopped cron or a target that is never due cannot
  report itself. One reminder every 6 hours, and `✅ <name> is being probed again` when it recovers.
  New targets and a freshly deployed watcher get a full window first.
- One KV write per shard run (about 576 a day), inside the free plan's 1,000 writes a day; the
  staleness watch adds one KV read per run.

## Deploy

The Worker, its KV namespace (`MONITOR_KV`) and its secrets already exist. Credentials come from
Infisical, so nothing depends on a local `wrangler login`:

```bash
source ~/.config/solo-empire/environment.sh
infisical run --projectId "$INFISICAL_PROJECT_ID" --env dev --path /cloudflare --silent -- npx wrangler deploy
```

Worker secrets (`wrangler secret put <NAME>`, value on stdin):

| Secret | Source in Infisical |
|---|---|
| `MONITOR_TOKEN`, `HEARTBEAT_TOKEN` | `/monitoring` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `/telegram` (`TELEGRAM_NOTI_BOT_TOKEN`, `TELEGRAM_NOTI_CHAT_ID`: the `book_noti_bot` that notifications-dispatcher also uses) |

`/status` is public but limited to own services. `/check` and the full `/status` need
`Authorization: Bearer <MONITOR_TOKEN>`; `/heartbeat/<job>` needs `HEARTBEAT_TOKEN`.

## Usage

- **View status page:** `https://solo-empire-monitor.bookchaowalit.workers.dev`
- **Get JSON status:** `https://solo-empire-monitor.bookchaowalit.workers.dev/status`
- **Manual check:** `curl -H "Authorization: Bearer $MONITOR_TOKEN" https://solo-empire-monitor.bookchaowalit.workers.dev/check`

## Cost

**$0/month** on the Workers free plan: about 52 checks every 5 minutes is roughly 15,000 requests
a day (limit 100,000) and about 576 KV writes a day (limit 1,000).

## ที่มา

ย้ายมาจาก `solo-empire/infra/cloud-monitor/` (2026-10-11) พร้อมประวัติ git. Worker ที่ deploy: `solo-empire-monitor` ที่ https://solo-empire-monitor.bookchaowalit.workers.dev (`monitor.bookchaowalit.com` ยังชี้ไป Vercel ไม่ใช่ Worker นี้)

## Known limits (accepted)

- **Public `/status` and KV reads.** Public responses are cached at the edge for 60 s, but cache
  misses are not coalesced, so a flood of uncached requests (an attack) could still use up the
  free plan's 100,000 KV reads a day and make the cron's reads fail until the daily reset. Normal
  traffic is far below this. If it ever happens, add a Cloudflare rate-limiting rule on
  `/status`, or move to Workers Paid.
- **KV is eventually consistent.** A parked heartbeat alert can take up to a minute to appear in
  `list()`. It is picked up on a later run and is never deleted before it has been copied.
