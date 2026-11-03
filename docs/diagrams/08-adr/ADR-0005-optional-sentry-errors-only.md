# ADR-0005 — Sentry แบบ optional, errors only, allowlist scrub

- Status: accepted (retro-documented)
- Date: 2026-11-03 (implemented `ba0085b` 2026-10-23)

## Decision
`withOptionalSentry` ห่อ handler ด้วย `@sentry/cloudflare` เฉพาะเมื่อมี `SENTRY_DSN`; ไม่มี tracing (`tracesSampleRate: 0`, `ignoreSpans`, `beforeSendTransaction: () => null`), ไม่มี breadcrumbs, `dataCollection` ปิดทั้งหมด, `beforeSend: scrubEvent` ลบ request/user/extra และ redact `/bot<token>`; `compatibility_flags = ["nodejs_als"]` สำหรับ `node:async_hooks`

## Evidence
`src/sentry.ts`, `wrangler.toml`, `package.json` (`@sentry/cloudflare` 11.8.0), `test/sentry.test.ts`, `README.md` "Error reporting (Sentry)"; ตาม `PRODUCT.md` DSN ถูกตั้ง 2026-10-23 (project `personal-yu0/platform-uptime-worker`)

## Consequences
ไม่มี DSN = Worker ทำงานเหมือนไม่มี Sentry; scrub เป็นสำเนาของ shared reference ที่ repo นี้เป็นเจ้าของเอง (ต้องตามแก้เอง)
