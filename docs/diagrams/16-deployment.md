# 16 — Deployment

```mermaid
flowchart TB
    subgraph Dev["Operator machine"]
        CL["Local clone, main"]
        INF["Infisical CLI: --path /cloudflare"]
        WR["npx wrangler deploy (wrangler 4.151.1)"]
        CL --> WR
        INF --> WR
    end
    subgraph CF["Cloudflare account (Workers free plan)"]
        WK["Worker solo-empire-monitor, main = src/worker.ts, compatibility_date 2026-10-01, flags nodejs_als"]
        RT["Route: monitor.bookchaowalit.com (custom domain; workers_dev = false)"]
        TR["Cron triggers: */5 * * * * and 2-59/5 * * * *"]
        KV[("KV binding MONITOR_KV")]
        SC["Secrets: MONITOR_TOKEN, HEARTBEAT_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SENTRY_DSN"]
        RT --> WK
        TR --> WK
        WK --> KV
        SC -.-> WK
    end
    WR -- "upload bundle" --> WK
    VC["monitor.bookchaowalit.com (points to Vercel, not this Worker)"]
```

Sources: `wrangler.toml`, `package.json`, `README.md` (Deploy, secrets, ที่มา), `PRODUCT.md`

| Item | Value |
|---|---|
| Hosting | Cloudflare Workers free plan |
| Environments | production เท่านั้น (ไม่มี `[env.*]` ใน `wrangler.toml`) |
| Custom domain | `monitor.bookchaowalit.com` (2026-11-04); `workers.dev` ปิด |
| Bindings | KV `MONITOR_KV` อย่างเดียว (ไม่มี D1 / R2 / DO / Queue) |
| Deploy trigger | manual; ไม่ใช่ push to `main` |
| Deployment history | `wrangler deployments list` (ล่าสุด 10 ครั้ง, `source: wrangler`) |
| Rollback | ไม่มีเอกสารใน repo; Wrangler รองรับ `wrangler rollback` แต่ไม่ได้ระบุใน README |

## Open questions

- ควรย้าย `monitor.bookchaowalit.com` มาที่ Worker นี้ไหม
- rollback procedure ที่ใช้จริงคืออะไร
