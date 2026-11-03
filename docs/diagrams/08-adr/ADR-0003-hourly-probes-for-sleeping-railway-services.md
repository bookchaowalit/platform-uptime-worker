# ADR-0003 — probe Railway "sleep when idle" services ชั่วโมงละครั้ง

- Status: accepted (retro-documented)
- Date: 2026-11-03 (implemented 2026-10-18, PR #3 `ee6c76d`)

## Context
Railway พา service ที่ใช้ `sleepApplication` ไปหลับหลัง ~10 นาทีไม่มี traffic; probe ทุก 5 นาทีทำให้ตื่นตลอดและถูกคิดเงิน (comment ใน `src/targets.ts`)

## Decision
ชื่อใน `SLEEPS` ถูก mark `sleeps: true`; `isDue()` probe เฉพาะเมื่อ `getUTCMinutes() < 5` (shard 0 ที่ :00, shard 1 ที่ :02) ส่วน `/check` probe ทุกตัว; stale limit 2.5 h แทน 0.5 h

## Evidence
`src/targets.ts` `SLEEPS` (40 ชื่อ), `RAILWAY_CUSTOM_DOMAINS = ['gateway.bookchaowalit.com']`; `src/monitor.ts` `isDue`, `STALE_AFTER_HOURS`; `test/monitor.test.ts` "isDue"; `test/targets.test.ts` "only marks Railway services as sleeping"

## Consequences
outage ของ sleeping service รู้ภายในราว 2 ชั่วโมง (`PRODUCT.md` Limits) แลกกับค่า Railway
