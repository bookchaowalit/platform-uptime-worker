# 09 — ERD (Workers KV `MONITOR_KV`)

ไม่มี SQL database; ข้อมูล persisted ทั้งหมดอยู่ใน KV namespace เดียว (`wrangler.toml` binding `MONITOR_KV`) แบ่งด้วย key prefix ภาพนี้แทน key/value เป็น entity และ field จาก TypeScript types ใน `src/monitor.ts` ส่วน config (targets, heartbeat specs) อยู่ในโค้ด ไม่ได้ persisted

```mermaid
erDiagram
    SHARD_STATE {
        string key "state:0 or state:1"
        json targets "Record name to TargetState"
        json pendingAlerts "string array, max 200"
        json staleWatch "Record name to StaleWatchEntry"
        string watchSince "ISO time, optional"
    }
    TARGET_STATE {
        string status "up or down"
        int consecutiveFailures
        string since "ISO, last status change"
        string lastAlertAt "ISO, optional"
        int latency "ms"
        string error "optional"
        string checkedAt "ISO"
    }
    STALE_WATCH_ENTRY {
        string firstSeen "ISO, optional"
        string alertedAt "ISO, optional"
    }
    HEARTBEAT_RECORD {
        string key "hb:job"
        string at "ISO"
        bool ok
        json detail "request body as sent"
    }
    HEARTBEAT_STALE_MARK {
        string key "hbstale:job"
        string value "ISO time of last stale alert"
    }
    PARKED_ALERT {
        string key "hbalert:job:epochMs:uuid"
        string value "alert text"
    }
    TARGET_CONFIG {
        string name PK
        string url
        string group "own or client"
        bool sleeps
    }
    HEARTBEAT_SPEC {
        string job PK
        int maxAgeHours
    }

    SHARD_STATE ||--o{ TARGET_STATE : "targets"
    SHARD_STATE ||--o{ STALE_WATCH_ENTRY : "staleWatch (next shard's targets)"
    TARGET_CONFIG ||--o| TARGET_STATE : "state by name"
    HEARTBEAT_SPEC ||--o| HEARTBEAT_RECORD : "hb:job"
    HEARTBEAT_SPEC ||--o| HEARTBEAT_STALE_MARK : "hbstale:job"
    HEARTBEAT_SPEC ||--o{ PARKED_ALERT : "undelivered ok false alerts"
```

Sources: `src/monitor.ts` (`TargetState`, `HeartbeatRecord`, `ShardState`, `StaleWatch`, `MAX_PENDING_ALERTS`), `src/worker.ts` (`stateKey`, `heartbeatKey`, `staleKey`, `hbAlertKey`, `readShard` รองรับรูปแบบ pre-v2.1), `src/targets.ts` (`Target`, `HeartbeatSpec`), `wrangler.toml`

Edge cache (`caches.default`, key `/status`) เก็บ public JSON 60 s เป็น cache ไม่ใช่ข้อมูลหลัก

| Key | Writer | Reader | ลบเมื่อ |
|---|---|---|---|
| `state:<shard>` | cron shard นั้น (1 put ต่อรอบ) | cron ทั้งสอง shard, `/status`, `/check` | ไม่ลบ (overwrite) |
| `hb:<job>` | `POST /heartbeat/<job>` | cron shard 0, full `/status` | ไม่ลบ |
| `hbstale:<job>` | cron shard 0 | cron shard 0 | ไม่ลบ |
| `hbalert:<job>:<ms>:<uuid>` | heartbeat handler เมื่อ Telegram ล้ม | cron shard 0 (`list` ≤ 3) | หลัง Telegram รับ |

## Open questions

- `detail` ของ heartbeat เก็บ body ทั้งก้อนโดยไม่จำกัดขนาด และคืนใน full `/status` ควรจำกัดขนาดหรือ field หรือไม่
- KV ไม่มี TTL บน key ใด; `hb:` ของ job ที่ถูกถอดออกจาก `HEARTBEATS` จะค้างอยู่
