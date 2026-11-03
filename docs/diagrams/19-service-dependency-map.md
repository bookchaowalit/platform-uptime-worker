# 19 — Service dependency map

Runtime dependencies ของ Worker (ซ้าย = สิ่งที่ Worker ต้องใช้เพื่อทำงาน, ขวา = สิ่งที่ถูกเฝ้า) ชื่อ target ทั้งหมดจาก `src/targets.ts` จัดกลุ่มตาม comment ในไฟล์

```mermaid
flowchart LR
    subgraph Needs["Hard runtime dependencies"]
        CFR["Cloudflare Workers runtime + cron"]
        KV[("Workers KV MONITOR_KV")]
        EC[("Edge cache")]
        TG["Telegram Bot API"]
    end
    subgraph Soft["Optional"]
        SE["Sentry (SENTRY_DSN)"]
    end
    W["solo-empire-monitor"]
    CFR --> W
    W --> KV
    W --> EC
    W --> TG
    W -.-> SE

    subgraph Own["Own targets (55)"]
        PL["Platform: tasks, identity, ai-gateway, checkin-worker, hooks-worker, jobs-worker, mcp-remote, accounts, accounts-metadata, automation, intake, notifications, integrations, saas-catalog, knowledge, ai-usage-display"]
        FI["Finance: 10 APIs"]
        SA["Sales: offers-api"]
        BP["Book Platform: communication, media, data, workflow, commerce, logistics, developer, security (/readyz)"]
        GWY["api-gateway (gateway.bookchaowalit.com)"]
        LI["Life: 13 APIs"]
        VE["Ventures: 2 crm-api, book-job-data-api, awesome-web, bookchaowalit.com, tracking"]
    end
    subgraph Client["Client targets (10)"]
        CL["ev3 api/web, a2n api/web, tma api/moldflow-web, scannpop backend/scanpop.co, raidenai-api/teeparinwat-web"]
    end
    W --> PL
    W --> FI
    W --> SA
    W --> BP
    W --> GWY
    W --> LI
    W --> VE
    W --> CL

    subgraph HB["Heartbeat producers (call in)"]
        H1["platform-db-backup, platform-empire, career-job-scraper, content-news-scraper, life-checkin-worker, data-lake-pipelines, sales-crm, platform-posture-monitor"]
    end
    H1 --> W
```

Sources: `src/targets.ts`, `src/worker.ts`, `src/sentry.ts`, `wrangler.toml`

| Dependency | ถ้าล่ม |
|---|---|
| Cloudflare cron | ไม่มี probe; shard ที่เหลือรายงาน "not probed"; ทั้งสองหยุด = เงียบ |
| KV | `readShard`/`put` throw → รอบนั้นล้ม (ไป Sentry ถ้าเปิด) |
| Telegram | alert ค้างใน queue / parked keys |
| Sentry | ไม่กระทบการทำงาน |
| Target provider (Railway / Vercel) ล่มทั้งหมด | alert หลาย target พร้อมกัน (central runbook "Many targets down at once") |

## Open questions

- `payment-api` ยังไม่อยู่ใน targets (ops record: book-platforms-status, 2026-11-03: รอ Stripe key)
