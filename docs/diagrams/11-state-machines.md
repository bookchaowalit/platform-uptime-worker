# 11 — State machines

## Target status (`TargetState.status` + `consecutiveFailures`)

```mermaid
stateDiagram-v2
    [*] --> Up: first ok probe
    [*] --> Suspect: first failed probe
    Up --> Suspect: probe fails (failures = 1, status still up)
    Suspect --> Up: probe ok (blip forgotten, no alert)
    Suspect --> Down: second failure in a row (down alert)
    Down --> Down: still failing, 6 h since lastAlertAt (reminder)
    Down --> Up: probe ok (recovered alert)
```

Sources: `src/monitor.ts` `applyResults`, `FAILURES_BEFORE_DOWN = 2`, `REMINDER_HOURS = 6`; `test/monitor.test.ts` "applyResults"

## Heartbeat job

```mermaid
stateDiagram-v2
    [*] --> NeverReported
    NeverReported --> Stale: shard 0 run, no hb record
    Fresh --> Failed: POST with ok not true (alert at once)
    Failed --> Fresh: POST with ok true
    Fresh --> Fresh: POST with ok true
    NeverReported --> Fresh: POST ok true
    Fresh --> Stale: age over maxAgeHours (alert, hbstale set)
    Failed --> Stale: age over maxAgeHours
    Stale --> Stale: 6 h since hbstale (reminder)
    Stale --> Fresh: POST ok true
    Stale --> Failed: POST ok false
```

Sources: `src/worker.ts` `handleHeartbeat`, `runShard`; `src/monitor.ts` `staleHeartbeats`; `src/targets.ts` `HEARTBEATS`

## Stale-probe watch (each shard watches the next)

```mermaid
stateDiagram-v2
    [*] --> InWindow: target has state or firstSeen recorded
    InWindow --> NotProbed: last probe older than 0.5 h (awake) or 2.5 h (sleeping)
    NotProbed --> NotProbed: 6 h since alertedAt (reminder)
    NotProbed --> InWindow: probed again ("is being probed again")
```

Sources: `src/monitor.ts` `staleTargets`, `STALE_AFTER_HOURS`, `watchedShard`

## Alert delivery

```mermaid
stateDiagram-v2
    [*] --> Fresh: transition, stale target or stale heartbeat line
    Fresh --> Pending: queueAlerts (behind older lines, cap 200)
    Pending --> Delivered: Telegram ok
    Pending --> Pending: Telegram fails or over 5 messages, kept in state
    Pending --> Dropped: pushed past MAX_PENDING_ALERTS
    [*] --> Parked: heartbeat ok false and Telegram fails
    Parked --> Delivered: shard 0 retry ok, key deleted
    Delivered --> [*]
```

Sources: `src/worker.ts` `deliver`, `HB_ALERT_PREFIX`, `MAX_PARKED_PER_RUN`; `src/monitor.ts` `queueAlerts`, `MAX_PENDING_ALERTS`
