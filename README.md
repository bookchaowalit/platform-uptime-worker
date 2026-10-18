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

## Setup (After Re-authenticating Cloudflare)

1. **Re-authenticate Wrangler:**
   ```bash
   npx wrangler login
   ```

2. **Create KV namespace:**
   ```bash
   cd cloud-monitor
   npx wrangler kv:namespace create MONITOR_KV
   ```

3. **Update `wrangler.toml`** with the KV namespace ID from step 2

4. **Configure the secrets** (`MONITOR_TOKEN`, `HEARTBEAT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`):
   ```bash
   npx wrangler secret put MONITOR_TOKEN
   npx wrangler secret put HEARTBEAT_TOKEN
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

   `/status` remains public for the status page. `/check` returns `401` without
   `Authorization: Bearer <MONITOR_TOKEN>` and is disabled until the secret exists.

5. **Deploy:**
   ```bash
   npx wrangler deploy
   ```

6. **Add Cron Trigger:**
   ```bash
   npx wrangler triggers deploy
   ```

## Usage

- **View status page:** `https://solo-empire-monitor.<subdomain>.workers.dev`
- **Get JSON status:** `https://solo-empire-monitor.<subdomain>.workers.dev/status`
- **Manual check:** `curl -H "Authorization: Bearer $MONITOR_TOKEN" https://solo-empire-monitor.<subdomain>.workers.dev/check`

## Cost

**$0/month** on the Workers free plan: about 52 checks every 5 minutes is roughly 15,000 requests
a day (limit 100,000) and about 576 KV writes a day (limit 1,000).

## ที่มา

ย้ายมาจาก `solo-empire/infra/cloud-monitor/` (2026-10-11) พร้อมประวัติ git. Worker ที่ deploy: `solo-empire-monitor` (monitor.bookchaowalit.com). `wrangler.toml` ยังมี KV id เป็น placeholder — ตั้ง KV จริงก่อน deploy ใหม่; deploy ต้องได้รับอนุมัติจากเจ้าของ.
