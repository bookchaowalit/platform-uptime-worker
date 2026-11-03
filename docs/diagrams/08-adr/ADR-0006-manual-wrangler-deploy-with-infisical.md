# ADR-0006 — deploy ด้วย `wrangler deploy` แบบ manual, credentials จาก Infisical, ไม่มี CD

- Status: accepted (retro-documented)
- Date: 2026-11-03

## Decision
CI (`.github/workflows/ci.yml`) ทำแค่ typecheck, test + coverage gate 98, bundle dry run (`npx wrangler deploy --dry-run --outdir dist`) และ security scans; ไม่มี deploy job ไม่มี Cloudflare credentials ใน GitHub. Deploy ทำโดยเจ้าของ/agent ด้วย `infisical run ... --path /cloudflare -- npx wrangler deploy`; Worker secrets ตั้งด้วย `wrangler secret put`

## Evidence
`README.md` "Deploy", `PRODUCT.md` "A push to `main` does not deploy", `.github/workflows/ci.yml`; `wrangler deployments list` แสดง 10 deployments ล่าสุดทั้งหมด `source: wrangler` (ดู [22-dora.md](../22-dora.md))

## Consequences
- deploy ไม่ถูก gate ด้วย CI: บาง deploy เกิดก่อน CI run ของ commit เดียวกันจะเริ่มด้วยซ้ำ (เช่น `fe04d27` deploy 15:57:48Z, CI run สร้าง 15:57:55Z)
- ไม่มี branch protection บน `main` (`gh api .../branches/main/protection` → 404)
- ประวัติ deploy เก่ากว่า 10 ครั้งล่าสุดดูจาก wrangler ไม่ได้
