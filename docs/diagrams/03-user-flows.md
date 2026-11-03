# 03 — User flows

Worker นี้มี "หน้า" เดียวคือ HTML status page ที่ `/` ซึ่ง fetch `/status` ฝั่ง browser นอกนั้นเป็น HTTP API และข้อความ Telegram จึงเขียน flow ต่อ role

## Public visitor: ดูหน้าสถานะ

```mermaid
flowchart TD
    A["Open https://solo-empire-monitor.bookchaowalit.workers.dev/"] --> B["Worker returns inline STATUS_PAGE HTML"]
    B --> C["Browser script fetch /status"]
    C --> D{"Edge cache hit?"}
    D -- yes --> E["Cached JSON (max-age 60)"]
    D -- no --> F["Read state:0 and state:1 from KV, keep own targets only"]
    F --> G["Put response into caches.default"]
    E --> H["Render one card per service: up / down / unknown + latency"]
    G --> H
```

## Owner: รับ alert แล้วตรวจ

```mermaid
flowchart TD
    A["Telegram message prefixed [monitor]"] --> B{"Kind"}
    B -- "red: name (error)" --> C["Target down after 2 failed probes"]
    B -- "still down: name for ..." --> C
    B -- "name recovered" --> Z["No action"]
    B -- "name not probed for ..." --> D["A shard cron stopped or target never due"]
    B -- "job run failed / has not reported" --> E["Scheduled job problem"]
    C --> F["curl full /status with MONITOR_TOKEN: url + error"]
    D --> F
    E --> F
    F --> G["Optional: curl /check?shard=N (read-only probe now)"]
    G --> H["Fix the service or src/targets.ts, redeploy"]
```

## Scheduled job: รายงานผล

```mermaid
flowchart TD
    A["Job finishes"] --> B["POST /heartbeat/job with Bearer HEARTBEAT_TOKEN and JSON body"]
    B --> C{"Response"}
    C -- "405" --> X1["Not POST"]
    C -- "503" --> X2["HEARTBEAT_TOKEN not set on Worker"]
    C -- "401" --> X3["Wrong token"]
    C -- "404" --> X4["Job not in HEARTBEATS"]
    C -- "200 recorded true" --> D{"body.ok === true"}
    D -- yes --> OK["Window reset"]
    D -- no --> AL["Immediate Telegram alert, lists body.failed"]
```

Sources: `src/worker.ts` (`STATUS_PAGE`, `handleStatus`, `handleManualCheck`, `handleHeartbeat`), `src/monitor.ts` (`formatTransitions`, `staleTargets`), `README.md` (Usage), central [12-operations-maintenance.md](https://github.com/bookchaowalit/architecture-docs/blob/main/operations/platform/devsecops-phase2-prod-baseline/12-operations-maintenance.md) (runbook table)

## Open questions

- หน้า `/` ไม่แสดง `stale` flag ที่ `/status` ส่งมา ตั้งใจหรือไม่
