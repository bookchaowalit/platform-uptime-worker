# Core 22 SDLC diagram pack — platform-uptime-worker

ชุดภาพ Core 22 ตาม SDLC Diagram Catalog v2 วาดจากโค้ดและ config ใน repo นี้ (ณ `origin/main` `fe04d27`, 2026-11-03) repo นี้คือ Cloudflare Worker `solo-empire-monitor` (Workers free plan): probe 65 targets ใน 2 cron shards, รับ heartbeat จาก 18 scheduled jobs และส่ง alert ไป Telegram

ทุกไฟล์มี `Sources:` ใต้ภาพ และ "Open questions" สำหรับสิ่งที่ยืนยันจากโค้ดไม่ได้ เอกสารที่มีอยู่แล้วถูก link (reuse) ไม่ได้คัดลอก: [`PRODUCT.md`](../../PRODUCT.md), [`README.md`](../../README.md), central [ADR-0002](https://github.com/bookchaowalit/architecture-docs/blob/main/docs/architecture/decisions/ADR-0002-production-baseline-monitoring-backups.md) และ workspace [PRJ-DSO-02](https://github.com/bookchaowalit/architecture-docs/blob/main/operations/platform/devsecops-phase2-prod-baseline/README.md)

| # | Item | Status | File | Sources read |
|---|---|---|---|---|
| 01 | Business process As-Is / To-Be | done (To-Be = open question) | [01-business-process.md](01-business-process.md) | `src/*.ts`, `wrangler.toml`, `PRODUCT.md`, `README.md`, central ADR-0002 |
| 02 | Use cases | done | [02-use-cases.md](02-use-cases.md) | `src/worker.ts`, `src/targets.ts`, `README.md` |
| 03 | User flows | done | [03-user-flows.md](03-user-flows.md) | `src/worker.ts`, `src/monitor.ts`, central `12-operations-maintenance.md` |
| 04 | Traceability (RTM) | done (reuses central FR/NFR) | [04-traceability.md](04-traceability.md) | central `06-requirements-engineering.md`, `PRODUCT.md`, `src/`, `test/`, `ci.yml` |
| 05 | C4 Context | done | [05-c4-context.md](05-c4-context.md) | `src/*.ts`, `wrangler.toml`, `README.md` |
| 06 | C4 Container | done | [06-c4-container.md](06-c4-container.md) | `wrangler.toml`, `src/worker.ts`, `src/sentry.ts` |
| 07 | C4 Component | done | [07-c4-component.md](07-c4-component.md) | `src/*.ts` |
| 08 | ADRs | done (6, + reused central ADR-0002) | [08-adr/](08-adr/) | `wrangler.toml`, `src/*.ts`, `ci.yml`, `README.md`, `git log`, `wrangler deployments list` |
| 09 | ERD | done (KV key model) | [09-erd.md](09-erd.md) | `src/monitor.ts` types, `src/worker.ts` keys, `wrangler.toml` |
| 10 | Sequences | done (4) | [10-sequences.md](10-sequences.md) | `src/worker.ts`, `src/monitor.ts`, `test/worker.test.ts` |
| 11 | State machines | done (4) | [11-state-machines.md](11-state-machines.md) | `src/monitor.ts`, `src/worker.ts` |
| 12 | API & integrations | done | [12-api-integration.md](12-api-integration.md) | `src/worker.ts`, `src/targets.ts`, `src/sentry.ts` |
| 13 | Threat model | done (extends central T-01..T-09) | [13-threat-model.md](13-threat-model.md) | `src/*.ts`, `wrangler.toml`, `README.md`, central `04-feasibility.md` |
| 14 | Backup & DR | done | [14-backup-dr.md](14-backup-dr.md) | `wrangler.toml`, `README.md`, `src/worker.ts`, central `06` NFR-06 |
| 15 | CI/CD pipeline | done | [15-cicd-pipeline.md](15-cicd-pipeline.md) | `ci.yml`, platform-ci-workflows `ci-node.yml` / `security.yml` @ `87dc5e1c`, `renovate.json`, `gh run list` |
| 16 | Deployment | done | [16-deployment.md](16-deployment.md) | `wrangler.toml`, `package.json`, `README.md`, `PRODUCT.md` |
| 17 | Test coverage matrix | done | [17-test-coverage-matrix.md](17-test-coverage-matrix.md) | `test/*.ts`, `ci.yml` |
| 18 | Git & release workflow | done | [18-git-release-workflow.md](18-git-release-workflow.md) | `git log --first-parent`, `gh pr list`, branch protection API |
| 19 | Service dependency map | done | [19-service-dependency-map.md](19-service-dependency-map.md) | `src/targets.ts`, `src/worker.ts`, `wrangler.toml` |
| 20 | Observability | done | [20-observability.md](20-observability.md) | `src/*.ts`, `wrangler.toml`, `PRODUCT.md` |
| 21 | Incident response | reused + extended | [21-incident-response.md](21-incident-response.md) → central `12-operations-maintenance.md` | `src/*.ts`, `README.md`, central runbook + INC log |
| 22 | DORA | done (4/5 computed, FDRT not computable) | [22-dora.md](22-dora.md) | `git log`, `gh run list`, `wrangler deployments list` |

## ADR list

- [ADR-0001](08-adr/ADR-0001-cloudflare-worker-free-plan-kv.md) Cloudflare Worker free plan + KV + cron
- [ADR-0002](08-adr/ADR-0002-name-hash-shards-and-cross-shard-watch.md) Name-hash shards + cross-shard stale watch (TD-004)
- [ADR-0003](08-adr/ADR-0003-hourly-probes-for-sleeping-railway-services.md) Hourly probes for Railway sleeping services
- [ADR-0004](08-adr/ADR-0004-telegram-only-alert-channel-with-durable-queue.md) Telegram only, durable queue + parked keys
- [ADR-0005](08-adr/ADR-0005-optional-sentry-errors-only.md) Optional Sentry, errors only
- [ADR-0006](08-adr/ADR-0006-manual-wrangler-deploy-with-infisical.md) Manual wrangler deploy, no CD

## Drift ที่พบระหว่างทำ (docs vs code)

- `PRODUCT.md` / `README.md`: 52 targets, 31 sleeping → โค้ด 65 / 40; heartbeat list ใน `PRODUCT.md` ขาด `jobs-marts`, `job-radar`, `posture-monitor`
- central FR-03: queue cap 40 → โค้ด `MAX_PENDING_ALERTS = 200`; FR-01: 26 per shard → 39 / 26
- `DOCPACK/00-product-card.md` (2026-10-11) ยังเขียน "0 tests, no CI"
