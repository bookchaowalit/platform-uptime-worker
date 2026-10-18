---
title: "Solo Empire Cloud Monitor"
tags: [documentation, infra]
created: 2026-07-09
updated: 2026-08-08
description: "Documentation for Solo Empire Cloud Monitor."
---

# Solo Empire Cloud Monitor

Cloudflare Worker that monitors your services 24/7 on the **free tier**.

## Features

- Checks every production service (own + hosted client services) every 5 minutes. The list
  lives in `src/targets.ts`; two cron triggers split it into shards so each run stays under the
  free plan's 50-subrequest limit.
- Telegram alert when a target fails twice in a row (about 10 minutes), a reminder every 6 hours
  while it stays down, and a recovery message.
- Heartbeats for scheduled jobs: `POST /heartbeat/<job>` with `Authorization: Bearer
  <HEARTBEAT_TOKEN>`. A report with `"ok": false` alerts straight away; a job that misses its window
  (`db-backup`: 26 hours) alerts too.
- `/status`: public JSON limited to own services, without URLs or errors. With
  `Authorization: Bearer <MONITOR_TOKEN>` it returns everything, heartbeats included.
- `/check?shard=0|1` (token-protected) runs one shard right away.
- One KV write per shard run (about 576 a day), inside the free plan's 1,000 writes a day.

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
