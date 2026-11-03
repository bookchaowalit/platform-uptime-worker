# 02 — Use cases

Actors มาจากระดับ auth จริงใน `src/worker.ts`: ไม่มี token (public), `MONITOR_TOKEN` (owner/operator), `HEARTBEAT_TOKEN` (scheduled jobs) และ cron trigger ของ Cloudflare ฝั่งรับคือ Telegram chat ของเจ้าของ

```mermaid
flowchart LR
    Visitor(["Public visitor (no token)"])
    Owner(["Owner with MONITOR_TOKEN"])
    Job(["Scheduled job with HEARTBEAT_TOKEN"])
    Cron(["Cloudflare cron trigger"])
    TG(["Owner Telegram chat (book_noti_bot)"])

    subgraph W["solo-empire-monitor Worker"]
        UC1(["View HTML status page /"])
        UC2(["Read public /status (own services, cached 60 s)"])
        UC3(["Read full /status (all targets, URL, error, heartbeats)"])
        UC4(["Run read-only probe /check?shard=0|1"])
        UC5(["Report job run POST /heartbeat/job"])
        UC6(["Probe shard targets and alert on transitions"])
        UC7(["Watch next shard for unprobed targets"])
        UC8(["Detect missed heartbeat windows (shard 0)"])
        UC9(["Retry queued and parked alerts"])
    end

    Visitor --> UC1
    Visitor --> UC2
    Owner --> UC3
    Owner --> UC4
    Job --> UC5
    Cron --> UC6
    UC6 --> UC7
    UC6 --> UC8
    UC6 --> UC9
    UC5 -- "ok false" --> TG
    UC6 --> TG
    UC7 --> TG
    UC8 --> TG
    UC9 --> TG
```

Sources: `src/worker.ts` (`authorized`, `handleStatus`, `handleManualCheck`, `handleHeartbeat`, `scheduled`, `runShard`), `src/targets.ts` (`HEARTBEATS`), `README.md` (Deploy, Telegram bot)

| Actor | Auth ในโค้ด | Use cases |
|---|---|---|
| Public visitor | ไม่มี; token ผิดถือเป็น public (`test/worker.test.ts` "treats a wrong token as a public request") | UC1, UC2 |
| Owner | `Authorization: Bearer <MONITOR_TOKEN>`; ถ้าไม่ตั้ง secret `/check` ตอบ 503 | UC3, UC4 |
| Scheduled job | `Authorization: Bearer <HEARTBEAT_TOKEN>`; job ต้องอยู่ใน `HEARTBEATS` ไม่งั้น 404 | UC5 |
| Cron trigger | `scheduled()` จาก `wrangler.toml` `[triggers]` | UC6–UC9 |

Heartbeat callers ที่ระบุใน comment ของ `src/targets.ts`: platform-db-backup (`db-backup*`, `restore-drill`), platform-empire (`token-rotate`, `backlog-sync`), career-job-scraper (`job-capture`), content-news-scraper (`news-capture`), life-checkin-worker (`checkin-daily`), data-lake-pipelines (`sheet-summaries`, `registry-export`, `jobs-marts`), sales-crm (`job-radar`), platform-posture-monitor (`posture-monitor`)

## Open questions

- ทุก job ใช้ `HEARTBEAT_TOKEN` ตัวเดียวกัน จึงแยกไม่ได้ว่า caller ไหนส่ง heartbeat ของ job ไหน ตั้งใจหรือไม่
