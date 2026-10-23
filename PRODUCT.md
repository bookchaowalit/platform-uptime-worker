# Solo Empire Cloud Monitor (`platform-uptime-worker`)

## What it is

A Cloudflare Worker (`solo-empire-monitor`) that checks the owner's production services and the
client services we host, watches heartbeats from scheduled jobs, and sends Telegram alerts. It runs
on the Workers free plan.

## Who it is for

The owner (a solo operator). It is internal monitoring, not a product sold to anyone. The public
status page only shows own services, without URLs or errors.

## What works today

- 52 targets in `src/targets.ts`, split over two cron shards (every 5 minutes, offset by 2 minutes)
  by a hash of the target name. Railway services that sleep when idle (31 of them) are probed hourly.
- Telegram alert after two failures in a row, a reminder every 6 hours while down, and a recovery
  message. Undelivered alerts stay queued in KV until Telegram accepts them.
- Each shard checks that the other shard's targets are still being probed (stopped-cron watch).
- Heartbeats: `POST /heartbeat/<job>` with `HEARTBEAT_TOKEN` for `db-backup` (and one per hosted
  client database), `token-rotate`, `restore-drill`, `job-capture` and `checkin-daily`. A failed run
  alerts at once; a missed window alerts too.
- `GET /status` (public, own services, edge-cached 60 s; full view with `MONITOR_TOKEN`),
  `GET /check?shard=0|1` (token, read-only probe) and an HTML status page at `/`.
- Sentry error reporting (`src/sentry.ts`, `@sentry/cloudflare`): errors only, no tracing,
  breadcrumbs or PII, allowlist scrub in `beforeSend` (also redacts the Telegram bot token). It is
  switched on only by a `SENTRY_DSN` Worker secret (set 2026-10-23, Sentry project
  `personal-yu0/platform-uptime-worker`); without it the Sentry code never runs. The
  scrub is a copy of the shared reference `~/work/b-tier-b/sentry-ref/sentry.ts`, owned and adapted
  here.
- Tests: Vitest, 4 files (`test/monitor.test.ts`, `targets.test.ts`, `worker.test.ts`,
  `sentry.test.ts`), all offline (in-memory KV, stubbed fetch). CI: shared
  `platform-ci-workflows` v1.1.1 (typecheck, tests with a coverage gate, Worker bundle dry run,
  security scan).

## How it runs and deploys

Deployed by hand with Wrangler, credentials from Infisical (see README "Deploy"). A push to `main`
does not deploy. Live at https://solo-empire-monitor.bookchaowalit.workers.dev.

## Limits

- If both shard crons stop, nothing inside this Worker can report it; that needs an outside check.
- Sleeping services are probed hourly, so an outage there is reported within about 2 hours.
- Public `/status` cache misses read KV; a flood of uncached requests could use up the free plan's
  daily KV reads (see README "Known limits").
- `monitor.bookchaowalit.com` points at Vercel, not at this Worker.

## Status

In production, maintained by the owner.
