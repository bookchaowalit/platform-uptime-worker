# 10 — Sequence diagrams

## 1. Cron shard run (`scheduled` → `runShard`, readOnly false)

```mermaid
sequenceDiagram
    autonumber
    participant CF as Cloudflare cron
    participant W as Worker runShard
    participant T as Targets
    participant KV as MONITOR_KV
    participant TG as Telegram API
    CF->>W: scheduled(event.cron)
    W->>W: shard = SHARD_CRONS.indexOf(cron), filter isDue
    par up to 6 at a time
        W->>T: GET url (10 s timeout, User-Agent SoloEmpireMonitor/2.0)
        T-->>W: status or timeout
    end
    W->>KV: get state:shard and state:other
    W->>W: newestStates, applyResults, handoverStates
    opt shard 0
        W->>KV: get hb:job and hbstale:job for 18 jobs
        W->>W: staleHeartbeats
    end
    W->>W: staleTargets(next shard), queueAlerts
    loop up to 5 chunks
        W->>TG: POST sendMessage "[monitor] ..."
        TG-->>W: ok or error
    end
    W->>KV: put state:shard (targets, pendingAlerts, staleWatch, watchSince)
    W->>KV: put hbstale:job for newly stale jobs
    opt shard 0 and queue empty
        W->>KV: list hbalert: (limit 3), get each
        W->>TG: sendMessage
        W->>KV: delete key after ok
    end
```

## 2. Heartbeat report (`POST /heartbeat/<job>`)

```mermaid
sequenceDiagram
    autonumber
    participant J as Scheduled job
    participant W as Worker handleHeartbeat
    participant KV as MONITOR_KV
    participant TG as Telegram API
    J->>W: POST /heartbeat/job, Bearer HEARTBEAT_TOKEN, JSON body
    alt not POST / no token configured / bad token / unknown job
        W-->>J: 405 / 503 / 401 / 404
    else accepted
        W->>W: ok = body.ok === true (non-JSON = failed)
        W->>KV: put hb:job {at, ok, detail}
        opt ok is false
            W->>TG: "job run failed: failed list"
            alt Telegram not ok
                W->>KV: put hbalert:job:ms:uuid
            end
        end
        W-->>J: 200 {recorded: true}
    end
```

## 3. Public and full `/status`

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant W as Worker handleStatus
    participant EC as caches.default
    participant KV as MONITOR_KV
    C->>W: GET /status (optional Bearer MONITOR_TOKEN)
    alt public
        W->>EC: match /status
        EC-->>W: hit returns cached JSON
    end
    W->>KV: get state:0, state:1
    W->>W: mergeShardStates, isStale, filter own if public
    opt full view
        W->>KV: get hb:job for each job
    end
    alt public
        W->>EC: put with Cache-Control public, max-age=60
    end
    W-->>C: JSON results, heartbeats (full only), timestamp
```

## 4. Manual check (`GET /check?shard=N`)

```mermaid
sequenceDiagram
    autonumber
    participant O as Owner
    participant W as Worker handleManualCheck
    participant T as Targets
    participant KV as MONITOR_KV
    O->>W: GET /check?shard=N, Bearer MONITOR_TOKEN
    alt token unset / wrong / bad shard
        W-->>O: 503 / 401 / 400
    else ok
        W->>T: probe every target of shard (sleepers included)
        W->>KV: read state (no writes)
        W-->>O: shard, checked, transitions, pendingAlerts, readOnly true
    end
```

Sources: `src/worker.ts`, `src/monitor.ts`, `test/worker.test.ts`
