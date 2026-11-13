/// <reference types="@cloudflare/workers-types" />

// Solo Empire Cloud Monitor: uptime checks for every production service, heartbeats for
// scheduled jobs (nightly database backups), and Telegram alerts. Runs on the Workers free plan.

import {
  applyResults,
  chunkAlerts,
  isDue,
  isStale,
  formatTransitions,
  mapWithConcurrency,
  mergeShardStates,
  handoverStates,
  heartbeatGraceHours,
  FAILURES_BEFORE_DOWN,
  newestStates,
  queueAlerts,
  staleHeartbeats,
  staleTargets,
  targetsForShard,
  watchedShard,
  type CheckResult,
  type HeartbeatRecord,
  type ShardState,
} from './monitor';
import { HEARTBEATS, SHARDS, TARGETS, type Target } from './targets';
import { withOptionalSentry, type WorkerHandler } from './sentry';
import { STATUS_PAGE, STATUS_PAGE_HEADERS } from './status-page';
import { maybeGatewayReport, REPORT_CRON } from './gateway-report';

export interface Env {
  MONITOR_KV: KVNamespace;
  MONITOR_TOKEN?: string;
  HEARTBEAT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Sentry error reporting; unset = Sentry stays off and the handler runs exactly as before. */
  SENTRY_DSN?: string;
  /** Daily gateway report (gateway-report.ts): read-only Analytics token and the zone id. */
  GATEWAY_REPORT_CF_TOKEN?: string;
  GATEWAY_REPORT_ZONE_ID?: string;
}

// Cron expressions in wrangler.toml, in shard order.
const SHARD_CRONS = ['*/5 * * * *', '2-59/5 * * * *'];

// Cloudflare allows six connections waiting for response headers at once; more just queue, and a
// queued probe's timer would already be running. Keep probes at six and start each timer when the
// probe actually starts.
const PROBE_CONCURRENCY = 6;

const stateKey = (shard: number) => `state:${shard}`;
const heartbeatKey = (job: string) => `hb:${job}`;
const staleKey = (job: string) => `hbstale:${job}`;
// A failed-run alert the heartbeat handler could not deliver: one immutable key per event. The
// handler only creates keys, the shard 0 cron only deletes keys it has already copied into its
// durable queue, so no event is ever overwritten or lost.
const HB_ALERT_PREFIX = 'hbalert:';
const hbAlertKey = (job: string) => `${HB_ALERT_PREFIX}${job}:${Date.now()}:${crypto.randomUUID()}`;

/**
 * Parked heartbeat alerts sent per run. A parked key is deleted only after Telegram accepts it, so
 * it never depends on the shard queue. 3 per run keeps deletes under the free plan's 1,000/day.
 */
const MAX_PARKED_PER_RUN = 3;
/** Messages per run: probes (up to 30 per shard) + messages must stay under the 50-subrequest limit. */
const MAX_MESSAGES_PER_RUN = 5;
/** Telegram refuses more than 4,096 characters; `[monitor] ` is added in front. */
const MAX_TEXT = 3900;
/**
 * KV writes are the free plan's tightest limit (1,000 a day for the whole account; 1,150 on
 * 2026-11-11). An unchanged good heartbeat is rewritten only once its record is older than its grace
 * (heartbeatGraceHours: half its window, at most 1 h; staleness adds the grace back),
 * and an unchanged shard state only every 10 minutes (the cross-shard watch allows 30).
 */
const STATE_REWRITE_MS = 10 * 60_000;

function bounded(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 12)}… (cut)`;
}

/** The parts of a shard state that alerting depends on: probe latency and time are left out. */
function essence(state: ShardState): string {
  const targets = Object.fromEntries(
    Object.entries(state.targets)
      .sort(([a], [b]) => a.localeCompare(b))
      // The counter keeps rising while a target stays down; past the threshold that changes nothing.
      .map(([name, t]) => [name, { status: t.status, consecutiveFailures: Math.min(t.consecutiveFailures, FAILURES_BEFORE_DOWN), since: t.since,
        lastAlertAt: t.lastAlertAt, error: t.error }]),
  );
  return JSON.stringify({ targets, pendingAlerts: state.pendingAlerts, staleWatch: state.staleWatch,
    watchSince: state.watchSince });
}
const PUBLIC_STATUS_CACHE_SECONDS = 60;

async function readShard(env: Env, shard: number): Promise<ShardState> {
  const raw = await env.MONITOR_KV.get<Record<string, unknown>>(stateKey(shard), 'json');
  if (!raw) return { targets: {}, pendingAlerts: [], staleWatch: {} };
  // Before v2.1 the value was the bare target map.
  if (!('targets' in raw)) return { targets: raw as ShardState['targets'], pendingAlerts: [], staleWatch: {} };
  const state = raw as Partial<ShardState>;
  return {
    targets: state.targets ?? {},
    pendingAlerts: state.pendingAlerts ?? [],
    staleWatch: state.staleWatch ?? {},
    watchSince: state.watchSince,
    writtenAt: state.writtenAt,
  };
}

/** Send queued lines in Telegram-sized messages; return the lines that were not delivered. */
async function deliver(env: Env, lines: string[]): Promise<string[]> {
  const chunks = chunkAlerts(lines);
  for (let i = 0; i < chunks.length; i++) {
    if (i >= MAX_MESSAGES_PER_RUN || !(await sendTelegram(env, chunks[i].join('\n')))) {
      return chunks.slice(i).flat();
    }
  }
  return [];
}

const handler: WorkerHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') return handleStatus(request, env);
    if (url.pathname === '/check') return handleManualCheck(request, env);
    if (url.pathname.startsWith('/heartbeat/')) return handleHeartbeat(request, env, url);
    if (url.pathname === '/') return new Response(STATUS_PAGE, { headers: STATUS_PAGE_HEADERS });
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // The daily gateway report has its own cron, so it never spends a probe shard's subrequest budget.
    if (event.cron === REPORT_CRON) {
      ctx.waitUntil(maybeGatewayReport(env, new Date(event.scheduledTime), (text) => sendTelegram(env, text)));
      return;
    }
    const shard = Math.max(0, SHARD_CRONS.indexOf(event.cron));
    // The slot comes from the cron's own time: a tick that starts late still probes its hourly sleepers.
    ctx.waitUntil(runShard(env, shard, { readOnly: false, scheduledAt: new Date(event.scheduledTime) }));
  },
};

export default withOptionalSentry(handler);

function authorized(request: Request, token: string | undefined): boolean {
  const expected = token?.trim();
  return Boolean(expected) && request.headers.get('authorization') === `Bearer ${expected}`;
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const full = authorized(request, env.MONITOR_TOKEN);
  // Public requests are served from the edge cache so page traffic cannot use up the KV read
  // allowance the cron depends on.
  const cacheKey = new Request(new URL('/status', request.url).toString());
  if (!full) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  }
  const shardStates: ShardState['targets'][] = [];
  for (let shard = 0; shard < SHARDS; shard++) shardStates.push((await readShard(env, shard)).targets);
  // Each target from the shard that owns it: a copy left in another shard must not win (TD-004).
  const states = mergeShardStates(shardStates, TARGETS, SHARDS);
  const now = new Date();
  const results = TARGETS.filter((t) => full || t.group === 'own').map((t) => {
    const s = states[t.name];
    return {
      name: t.name,
      group: t.group,
      status: s?.status ?? 'unknown',
      stale: isStale(t, s, now),
      since: s?.since,
      latency: s?.latency,
      checkedAt: s?.checkedAt,
      ...(full ? { url: t.url, error: s?.error } : {}),
    };
  });
  const heartbeats = full
    ? Object.fromEntries(
        await Promise.all(
          HEARTBEATS.map(async (h) => [h.job, await env.MONITOR_KV.get(heartbeatKey(h.job), 'json')]),
        ),
      )
    : undefined;
  const response = Response.json({ results, heartbeats, timestamp: new Date().toISOString() });
  if (full) return response;
  response.headers.set('Cache-Control', `public, max-age=${PUBLIC_STATUS_CACHE_SECONDS}`);
  await caches.default.put(cacheKey, response.clone());
  return response;
}

async function handleManualCheck(request: Request, env: Env): Promise<Response> {
  if (!env.MONITOR_TOKEN?.trim()) {
    return Response.json({ error: 'Manual checks are disabled until MONITOR_TOKEN is configured' }, { status: 503 });
  }
  if (!authorized(request, env.MONITOR_TOKEN)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const shard = Number(new URL(request.url).searchParams.get('shard') ?? '0');
  if (!Number.isInteger(shard) || shard < 0 || shard >= SHARDS) {
    return Response.json({ error: 'Invalid shard' }, { status: 400 });
  }
  // Manual runs are read-only: they probe and report, but never write state or send alerts, so
  // they cannot interfere with the cron.
  return Response.json(await runShard(env, shard, { readOnly: true }));
}

async function handleHeartbeat(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405 });
  if (!env.HEARTBEAT_TOKEN?.trim()) return Response.json({ error: 'Heartbeats are disabled' }, { status: 503 });
  if (!authorized(request, env.HEARTBEAT_TOKEN)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const job = url.pathname.slice('/heartbeat/'.length);
  if (!HEARTBEATS.some((h) => h.job === job)) return Response.json({ error: 'Unknown job' }, { status: 404 });

  let detail: unknown = null;
  try {
    detail = await request.json();
  } catch {
    detail = null;
  }
  const ok = typeof detail === 'object' && detail !== null && (detail as { ok?: unknown }).ok === true;
  const now = new Date();
  const record: HeartbeatRecord = { at: now.toISOString(), ok, detail };
  const spec = HEARTBEATS.find((h) => h.job === job)!;
  const last = ok ? await env.MONITOR_KV.get<HeartbeatRecord>(heartbeatKey(job), 'json') : null;
  const fresh = last?.ok === true && now.getTime() - Date.parse(last.at) < heartbeatGraceHours(spec) * 3_600_000;
  // KV allows one write per second per key and can refuse (429); a refused write must never stop the
  // failed-run alert below, so it is retried once and then reported as not recorded.
  const stored = fresh || (await putRetry(env, heartbeatKey(job), JSON.stringify(record)));

  if (!ok) {
    const failed = (detail as { failed?: unknown } | null)?.failed;
    const list = Array.isArray(failed) && failed.length ? `: ${failed.join(', ')}` : '';
    const text = bounded(`🔴 ${job} run failed${list}`);
    // If Telegram is down, park the alert under its own key; the shard 0 cron retries it.
    if (!(await sendTelegram(env, text))) await putRetry(env, hbAlertKey(job), text);
  }
  return stored ? Response.json({ recorded: true }) : Response.json({ recorded: false }, { status: 503 });
}

async function putRetry(env: Env, key: string, value: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await env.MONITOR_KV.put(key, value);
      return true;
    } catch (error) {
      console.error('KV write failed', error instanceof Error ? error.name : 'unknown error');
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }
  return false;
}

async function runShard(env: Env, shard: number, opts: { readOnly: boolean; scheduledAt?: Date }) {
  const now = new Date();
  const slot = opts.scheduledAt ?? now;
  // Manual checks probe everything; the cron skips sleeping services outside their hourly slot.
  const targets = targetsForShard(TARGETS, shard, SHARDS).filter((t) => opts.readOnly || isDue(t, slot));
  const results = await mapWithConcurrency(targets, PROBE_CONCURRENCY, checkTarget);

  const previous = await readShard(env, shard);
  // Every shard's state: owned targets are seeded from their newest copy anywhere, so a target that
  // changed shard keeps its real state and an old copy cannot win (TD-004).
  const allStates: ShardState['targets'][] = [];
  for (let s = 0; s < SHARDS; s++) allStates.push(s === shard ? previous.targets : (await readShard(env, s)).targets);
  const seeded = newestStates(allStates, TARGETS, shard, SHARDS);
  const applied = applyResults(seeded, results, now);
  // Owned targets are written with their seeded or new state. A copy of a target that moved away is
  // kept only until its new owner has an entry; copies of removed targets are dropped.
  const state = { ...handoverStates(previous.targets, allStates, TARGETS, shard, SHARDS), ...seeded, ...applied.state };
  const { transitions } = applied;

  const fresh: string[] = [];
  // One queue entry per line, so chunking never has to cut a multi-line block.
  if (transitions.length) fresh.push(...formatTransitions(transitions, now).split('\n'));

  if (opts.readOnly) {
    return { shard, checked: results.length, results, transitions, pendingAlerts: previous.pendingAlerts.length, readOnly: true,
      timestamp: now.toISOString() };
  }

  // Shard 0 also watches the scheduled jobs.
  const staleMarks: string[] = [];
  if (shard === 0) {
    const records: Record<string, HeartbeatRecord | null> = {};
    const alerted: Record<string, string | null> = {};
    for (const h of HEARTBEATS) {
      records[h.job] = await env.MONITOR_KV.get<HeartbeatRecord>(heartbeatKey(h.job), 'json');
      alerted[h.job] = await env.MONITOR_KV.get(staleKey(h.job));
    }
    for (const spec of staleHeartbeats(HEARTBEATS, records, alerted, now)) {
      const last = records[spec.job]?.at;
      fresh.push(`⏰ ${spec.job} has not reported for over ${spec.maxAgeHours}h${last ? ` (last: ${last})` : ' (never)'}`);
      staleMarks.push(spec.job);
    }
  }

  // Each shard checks that the next shard's targets are still being probed: a stopped cron or a
  // target that is never due cannot report itself.
  const watched = watchedShard(shard, SHARDS);
  const watchedStates = watched === shard ? state : allStates[watched];
  const watchSince = previous.watchSince ?? now.toISOString();
  const stale = staleTargets(targetsForShard(TARGETS, watched, SHARDS), watchedStates, previous.staleWatch, now, watchSince);
  fresh.push(...stale.lines);

  // Undelivered alerts from earlier runs go first; they stay queued until Telegram accepts them.
  const queued = queueAlerts(previous.pendingAlerts, fresh);
  const pendingAlerts = queued.length ? await deliver(env, queued) : [];

  // The queue is durable before anything that would suppress regenerating an alert is written.
  const next: ShardState = { targets: state, pendingAlerts, staleWatch: stale.watch, watchSince };
  const changed = essence(next) !== essence(previous);
  const due = !previous.writtenAt || now.getTime() - Date.parse(previous.writtenAt) >= STATE_REWRITE_MS;
  // A sleeping service is probed once an hour; that probe time must land, or it looks unprobed.
  const sleeperProbed = targets.some((t) => t.sleeps);
  if (changed || due || sleeperProbed) await env.MONITOR_KV.put(stateKey(shard), JSON.stringify({ ...next, writtenAt: now.toISOString() }));
  await Promise.all(staleMarks.map((job) => env.MONITOR_KV.put(staleKey(job), now.toISOString())));

  // Parked failed-run alerts: each key is deleted only after Telegram accepted that alert.
  if (shard === 0 && !pendingAlerts.length) {
    const listed = await env.MONITOR_KV.list({ prefix: HB_ALERT_PREFIX, limit: MAX_PARKED_PER_RUN });
    for (const { name } of listed.keys) {
      const text = await env.MONITOR_KV.get(name);
      if (text === null) continue;
      // One refused alert must not hold back the others; it stays parked for the next run.
      if (!(await sendTelegram(env, bounded(text)))) continue;
      await env.MONITOR_KV.delete(name);
    }
  }
  return { shard, checked: results.length, transitions, pendingAlerts: pendingAlerts.length, timestamp: now.toISOString() };
}

async function checkTarget(target: Target): Promise<CheckResult> {
  const start = Date.now();
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'SoloEmpireMonitor/2.0' },
    });
    // Drain the body so the connection is released.
    await response.arrayBuffer();
    const latency = Date.now() - start;
    return response.ok
      ? { name: target.name, ok: true, latency }
      : { name: target.name, ok: false, latency, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      name: target.name,
      ok: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.name === 'TimeoutError' ? 'timeout after 10s' : error.message : 'unknown error',
    };
  }
}

/** Returns true only when Telegram accepted the message. */
async function sendTelegram(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn('Telegram is not configured; alert kept for retry');
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      // Bounded here too, so no caller can send a text Telegram refuses (limit 4 096).
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `[monitor] ${bounded(text)}`, disable_web_page_preview: true }),
    });
    if (!response.ok) console.error('Telegram send failed', response.status);
    return response.ok;
  } catch (error) {
    // Name only: a fetch error message can carry the request URL, which holds the bot token.
    console.error('Telegram send failed', error instanceof Error ? error.name : 'unknown error');
    return false;
  }
}
