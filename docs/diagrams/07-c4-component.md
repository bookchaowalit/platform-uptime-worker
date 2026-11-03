# 07 — C4 Component

แยกเป็น 4 module: `worker.ts` (Workers APIs: routing, KV, fetch, Telegram), `monitor.ts` (pure logic, ไม่มี Workers API เพื่อ unit test), `targets.ts` (config ในโค้ด), `sentry.ts` (optional wrapper)

```mermaid
C4Component
    title Components inside the solo-empire-monitor Worker
    ContainerDb(kv, "MONITOR_KV", "Workers KV")
    System_Ext(telegram, "Telegram Bot API")
    System_Ext(targets, "Monitored targets")

    Container_Boundary(w, "solo-empire-monitor") {
        Component(sentry, "withOptionalSentry", "src/sentry.ts", "Wraps handler only when SENTRY_DSN is set; scrubEvent allowlist")
        Component(router, "fetch router", "src/worker.ts", "/status, /check, /heartbeat/job, /, 404")
        Component(status, "handleStatus", "src/worker.ts", "Public or full view, edge cache")
        Component(check, "handleManualCheck", "src/worker.ts", "Read-only runShard")
        Component(hb, "handleHeartbeat", "src/worker.ts", "Record hb:job, alert or park")
        Component(run, "runShard", "src/worker.ts", "Probe, apply, watch, queue, deliver, write")
        Component(probe, "checkTarget", "src/worker.ts", "GET, 10 s timeout")
        Component(tg, "sendTelegram / deliver", "src/worker.ts", "Chunks, max 5 messages per run")
        Component(logic, "monitor logic", "src/monitor.ts", "applyResults, shardOfName, staleTargets, staleHeartbeats, queueAlerts, chunkAlerts")
        Component(cfg, "TARGETS / HEARTBEATS / SHARDS", "src/targets.ts", "65 targets, 18 jobs, 2 shards")
    }

    Rel(sentry, router, "fetch")
    Rel(sentry, run, "scheduled")
    Rel(router, status, "")
    Rel(router, check, "")
    Rel(router, hb, "")
    Rel(check, run, "readOnly true")
    Rel(run, probe, "6 at a time")
    Rel(probe, targets, "HTTPS")
    Rel(run, logic, "")
    Rel(status, logic, "mergeShardStates, isStale")
    Rel(run, cfg, "")
    Rel(hb, cfg, "")
    Rel(run, tg, "")
    Rel(hb, tg, "")
    Rel(tg, telegram, "HTTPS")
    Rel(run, kv, "state, hb, hbstale, hbalert")
    Rel(status, kv, "state, hb")
    Rel(hb, kv, "hb, hbalert")
```

Sources: `src/worker.ts`, `src/monitor.ts`, `src/targets.ts`, `src/sentry.ts`
