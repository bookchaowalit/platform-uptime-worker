# ADR-0004 — Telegram เป็นช่อง alert เดียว พร้อม durable queue และ parked keys

- Status: accepted (retro-documented)
- Date: 2026-11-03

## Context
domain MX เป็น iCloud จึงใช้ email ไม่ได้ (central ADR-0002 D-02) และเคยเจอ bot token ถูก revoke จน alert หาย (central INC-02)

## Decision
- ส่งทุก alert ผ่าน `https://api.telegram.org/bot<token>/sendMessage` prefix `[monitor]` (`sendTelegram`)
- alert ที่ส่งไม่ได้จาก cron อยู่ใน `pendingAlerts` ของ shard state (สูงสุด `MAX_PENDING_ALERTS = 200`) และส่งก่อน alert ใหม่ ส่งได้สูงสุด 5 ข้อความต่อรอบ
- alert `ok:false` จาก heartbeat ที่ส่งไม่ได้ ถูก park เป็น key `hbalert:<job>:<ms>:<uuid>` แบบ immutable; shard 0 ส่งซ้ำ ≤ 3 ต่อรอบ และลบหลัง Telegram ตอบ ok เท่านั้น
- queue ถูกเขียนลง KV ก่อน `hbstale:*` เพื่อไม่ให้ alert หายถ้ารอบล้ม

## Evidence
`src/worker.ts` `deliver`, `sendTelegram`, `HB_ALERT_PREFIX`, `MAX_PARKED_PER_RUN`, `MAX_MESSAGES_PER_RUN`; `src/monitor.ts` `queueAlerts`, `chunkAlerts`; `test/worker.test.ts` "keeps an undelivered alert queued until Telegram accepts it", "parks the alert under its own key when Telegram is down"

## Consequences
ช่องทางเดียว: ถ้า Telegram หรือ bot token เสีย alert ค้างใน queue และมีแค่ `console.error` (ไม่มีช่องที่สอง)
