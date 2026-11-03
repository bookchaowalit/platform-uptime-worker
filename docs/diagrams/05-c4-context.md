# 05 — C4 Context

```mermaid
C4Context
    title System Context: solo-empire-monitor
    Person(owner, "Owner", "Reads Telegram alerts, full /status, /check")
    Person(visitor, "Public visitor", "Status page and public /status")
    System(monitor, "solo-empire-monitor", "Cloudflare Worker: uptime probes, heartbeats, Telegram alerts")
    System_Ext(jobs, "Scheduled jobs", "db-backup*, token-rotate, restore-drill, job-capture, news-capture, checkin-daily, backlog-sync, sheet-summaries, registry-export, jobs-marts, job-radar, posture-monitor")
    System_Ext(own, "Own services (55 targets)", "Railway APIs, Cloudflare Workers, gateway, bookchaowalit.com, tracking")
    System_Ext(client, "Hosted client services (10 targets)", "ev3, a2n, tma, scannpop, teeparinwat on Railway and Vercel")
    System_Ext(telegram, "Telegram Bot API", "api.telegram.org sendMessage")
    System_Ext(sentry, "Sentry", "Errors only, when SENTRY_DSN is set")

    Rel(visitor, monitor, "GET / and /status", "HTTPS")
    Rel(owner, monitor, "GET /status, /check with MONITOR_TOKEN", "HTTPS")
    Rel(jobs, monitor, "POST /heartbeat/job with HEARTBEAT_TOKEN", "HTTPS")
    Rel(monitor, own, "GET health URL", "HTTPS")
    Rel(monitor, client, "GET health URL", "HTTPS")
    Rel(monitor, telegram, "Alerts", "HTTPS")
    Rel(monitor, sentry, "Error events", "HTTPS")
    Rel(telegram, owner, "Messages prefixed [monitor]")
```

Sources: `src/worker.ts`, `src/targets.ts`, `src/sentry.ts`, `wrangler.toml`, `README.md`

หมายเหตุ: `monitor.bookchaowalit.com` ชี้ไป Vercel ไม่ใช่ Worker นี้ (`README.md`, `PRODUCT.md`) จึงไม่อยู่ในภาพ
