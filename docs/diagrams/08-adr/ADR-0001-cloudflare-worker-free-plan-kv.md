# ADR-0001 — Cloudflare Worker บน free plan + Workers KV + cron triggers

- Status: accepted (retro-documented)
- Date: 2026-11-03 (decision ตามจริง 2026-07-09 สร้าง Worker; ยืนยันใน central ADR-0002 2026-10-18)
- Upstream decision: [central ADR-0002](https://github.com/bookchaowalit/architecture-docs/blob/main/docs/architecture/decisions/ADR-0002-production-baseline-monitoring-backups.md) (reused, ไม่คัดลอก)

## Context
เจ้าของต้องการรู้เมื่อบริการล่มโดยไม่มี fixed cost (`README.md` Cost: $0/month) และต้องมี state ระหว่างรอบ (สถานะ down/up, heartbeat)

## Decision
รันเป็น Cloudflare Worker `solo-empire-monitor` (`wrangler.toml` `name`, `workers_dev = true`) ใช้ cron triggers สองตัว และเก็บ state ใน KV binding `MONITOR_KV` หนึ่ง namespace ไม่มี D1 / R2 / Durable Object / Queue

## Evidence
- `wrangler.toml`: `[triggers] crons`, `[[kv_namespaces]] binding = "MONITOR_KV"`
- `src/worker.ts`: `export interface Env { MONITOR_KV: KVNamespace ... }`, `scheduled()`
- `README.md` Cost: ~15,000 requests/day (limit 100,000), ~576 KV writes/day (limit 1,000)

## Consequences
- ทุก design choice ต้องอยู่ใต้ 50 subrequests ต่อ invocation และ 1,000 KV writes/day (ดู ADR-0002 ของ repo นี้)
- KV เป็น eventually consistent (`README.md` Known limits)
- ถ้า cron ทั้งสองหยุด ไม่มีใครรายงาน (R-08 / BL-06)
