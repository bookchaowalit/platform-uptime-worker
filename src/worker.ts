/// <reference types="@cloudflare/workers-types" />

// Solo Empire Cloud Monitor: uptime checks for every production service, heartbeats for
// scheduled jobs (nightly database backups), and Telegram alerts. Runs on the Workers free plan.

import {
  applyResults,
  chunkAlerts,
  formatTransitions,
  mapWithConcurrency,
  queueAlerts,
  staleHeartbeats,
  targetsForShard,
  type CheckResult,
  type HeartbeatRecord,
  type ShardState,
} from './monitor';
import { HEARTBEATS, SHARDS, TARGETS, type Target } from './targets';

export interface Env {
  MONITOR_KV: KVNamespace;
  MONITOR_TOKEN?: string;
  HEARTBEAT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
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

/** Messages per run: probes (26) + messages must stay under the 50-subrequest limit. */
const MAX_MESSAGES_PER_RUN = 5;
const PUBLIC_STATUS_CACHE_SECONDS = 60;

async function readShard(env: Env, shard: number): Promise<ShardState> {
  const raw = await env.MONITOR_KV.get<Record<string, unknown>>(stateKey(shard), 'json');
  if (!raw) return { targets: {}, pendingAlerts: [] };
  // Before v2.1 the value was the bare target map.
  if (!('targets' in raw)) return { targets: raw as ShardState['targets'], pendingAlerts: [] };
  const state = raw as Partial<ShardState>;
  return { targets: state.targets ?? {}, pendingAlerts: state.pendingAlerts ?? [] };
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') return handleStatus(request, env);
    if (url.pathname === '/check') return handleManualCheck(request, env);
    if (url.pathname.startsWith('/heartbeat/')) return handleHeartbeat(request, env, url);
    if (url.pathname === '/') return new Response(STATUS_PAGE, { headers: { 'Content-Type': 'text/html' } });
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const shard = Math.max(0, SHARD_CRONS.indexOf(event.cron));
    ctx.waitUntil(runShard(env, shard));
  },
};

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
  const states: ShardState['targets'] = {};
  for (let shard = 0; shard < SHARDS; shard++) Object.assign(states, (await readShard(env, shard)).targets);
  const results = TARGETS.filter((t) => full || t.group === 'own').map((t) => {
    const s = states[t.name];
    return {
      name: t.name,
      group: t.group,
      status: s?.status ?? 'unknown',
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
  return Response.json(await runShard(env, shard));
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
  const record: HeartbeatRecord = { at: new Date().toISOString(), ok, detail };
  await env.MONITOR_KV.put(heartbeatKey(job), JSON.stringify(record));

  if (!ok) {
    const failed = (detail as { failed?: unknown } | null)?.failed;
    const list = Array.isArray(failed) && failed.length ? `: ${failed.join(', ')}` : '';
    const text = `🔴 ${job} run failed${list}`;
    // If Telegram is down, park the alert under its own key; the shard 0 cron retries it.
    if (!(await sendTelegram(env, text))) await env.MONITOR_KV.put(hbAlertKey(job), text);
  }
  return Response.json({ recorded: true });
}

async function runShard(env: Env, shard: number) {
  const now = new Date();
  const targets = targetsForShard(TARGETS, shard, SHARDS);
  const results = await mapWithConcurrency(targets, PROBE_CONCURRENCY, checkTarget);

  const previous = await readShard(env, shard);
  const { state, transitions } = applyResults(previous.targets, results, now);

  const fresh: string[] = [];
  // One queue entry per line, so chunking never has to cut a multi-line block.
  if (transitions.length) fresh.push(...formatTransitions(transitions, now).split('\n'));

  // Shard 0 also watches the scheduled jobs.
  const staleMarks: string[] = [];
  const parkedAlerts: { key: string; text: string }[] = [];
  if (shard === 0) {
    const records: Record<string, HeartbeatRecord | null> = {};
    const alerted: Record<string, string | null> = {};
    for (const h of HEARTBEATS) {
      records[h.job] = await env.MONITOR_KV.get<HeartbeatRecord>(heartbeatKey(h.job), 'json');
      alerted[h.job] = await env.MONITOR_KV.get(staleKey(h.job));
    }
    const listed = await env.MONITOR_KV.list({ prefix: HB_ALERT_PREFIX });
    for (const { name } of listed.keys) {
      const text = await env.MONITOR_KV.get(name);
      if (text) parkedAlerts.push({ key: name, text });
    }
    for (const spec of staleHeartbeats(HEARTBEATS, records, alerted, now)) {
      const last = records[spec.job]?.at;
      fresh.push(`⏰ ${spec.job} has not reported for over ${spec.maxAgeHours}h${last ? ` (last: ${last})` : ' (never)'}`);
      staleMarks.push(spec.job);
    }
  }

  // Undelivered alerts from earlier runs go first; they stay queued until Telegram accepts them.
  const queued = queueAlerts(previous.pendingAlerts, [...parkedAlerts.map((p) => p.text), ...fresh]);
  const pendingAlerts = queued.length ? await deliver(env, queued) : [];

  // The queue is durable before anything that would suppress regenerating an alert is written.
  await env.MONITOR_KV.put(stateKey(shard), JSON.stringify({ targets: state, pendingAlerts }));
  await Promise.all([
    ...staleMarks.map((job) => env.MONITOR_KV.put(staleKey(job), now.toISOString())),
    // These events are now delivered or in the durable shard queue; their keys are immutable, so
    // deleting them cannot drop a newer report.
    ...parkedAlerts.map((p) => env.MONITOR_KV.delete(p.key)),
  ]);
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
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `[monitor] ${text}`, disable_web_page_preview: true }),
    });
    if (!response.ok) console.error('Telegram send failed', response.status);
    return response.ok;
  } catch (error) {
    console.error('Telegram send failed', error instanceof Error ? error.message : error);
    return false;
  }
}

const STATUS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Solo Empire Status</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .service { padding: 12px 15px; margin: 8px 0; border-radius: 8px; }
    .up { background: #d4edda; border-left: 4px solid #28a745; }
    .down { background: #f8d7da; border-left: 4px solid #dc3545; }
    .unknown { background: #e2e3e5; border-left: 4px solid #6c757d; }
    .latency, .last-check { color: #555; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Solo Empire Status</h1>
  <p class="last-check">Loading...</p>
  <div id="services"></div>
  <script>
    fetch('/status').then(r => r.json()).then(data => {
      document.querySelector('.last-check').textContent = 'Updated: ' + new Date(data.timestamp).toLocaleString();
      const list = document.getElementById('services');
      for (const s of data.results) {
        const div = document.createElement('div');
        div.className = 'service ' + s.status;
        const name = document.createElement('strong');
        name.textContent = s.name;
        const meta = document.createElement('div');
        meta.className = 'latency';
        meta.textContent = s.status + (s.latency != null ? ' · ' + s.latency + 'ms' : '');
        div.append(name, meta);
        list.append(div);
      }
    });
  </script>
</body>
</html>`;
