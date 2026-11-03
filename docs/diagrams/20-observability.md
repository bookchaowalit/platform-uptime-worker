# 20 — Observability

repo นี้ **คือ** uptime monitor + heartbeat hub ของทั้ง estate (ส่วนหนึ่งของ prod baseline, central ADR-0002) ภาพนี้แยก (ก) สิ่งที่มันเฝ้า และ (ข) สัญญาณของตัวมันเอง

```mermaid
flowchart LR
    subgraph Watched["What it watches"]
        T["65 HTTP targets: 25 every 5 min, 40 sleeping hourly"]
        H["18 heartbeat jobs with windows 3 h .. 840 h"]
        X["The other shard: target not probed for 0.5 h / 2.5 h"]
    end
    T --> W["solo-empire-monitor"]
    H --> W
    X --> W
    W -- "down, still down, recovered, not probed, run failed, has not reported" --> TG["Telegram book_noti_bot chat"]
    W -- "results, stale flag, heartbeats" --> ST["/status JSON + / page"]
    subgraph Self["Signals about the monitor itself"]
        L["console.warn / console.error (Telegram not configured or send failed)"]
        S["Sentry errors via withOptionalSentry"]
        R["/check read-only probe on demand"]
        Q["pendingAlerts count in state and /check"]
    end
    W --> L
    W --> S
    W --> R
    W --> Q
    N["Nothing external watches the monitor (R-08, BL-06)"] -.-> W
```

Sources: `src/worker.ts`, `src/monitor.ts`, `src/targets.ts`, `src/sentry.ts`, `wrangler.toml`, `PRODUCT.md`, `README.md`

| Signal | Source | Destination | Watched by |
|---|---|---|---|
| Probe result, latency, error | `checkTarget` | KV `state:<shard>`, `/status` | owner via Telegram / `/status` |
| Transitions | `applyResults`, `formatTransitions` | Telegram | owner |
| Stale target | `staleTargets` | Telegram, `stale` flag ใน `/status` | owner |
| Heartbeat | `POST /heartbeat/<job>` | KV `hb:<job>`, Telegram on `ok:false` | owner |
| Missed heartbeat | `staleHeartbeats` (shard 0) | Telegram | owner |
| Worker errors | `@sentry/cloudflare` | Sentry project `personal-yu0/platform-uptime-worker` (`PRODUCT.md`) | owner |
| Worker logs | `console.*` | Cloudflare Workers logs | ไม่มีใครเฝ้า; `wrangler.toml` ไม่มี `[observability]` block |

ไม่มี PostHog, metrics หรือ tracing (tracing ปิดโดยตั้งใจใน `sentry.ts`)

## Open questions

- เปิด Workers Logs (`[observability] enabled = true`) หรือไม่
- BL-06: ใครหรืออะไรจะเฝ้า monitor (เช่น heartbeat ภายนอก หรือข้อความ "still alive" รายวัน)
