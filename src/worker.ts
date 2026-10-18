/// <reference types="@cloudflare/workers-types" />

// Solo Empire Cloud Monitor: uptime checks for every production service, heartbeats for
// scheduled jobs (nightly database backups), and Telegram alerts. Runs on the Workers free plan.

import {
  applyResults,
  formatTransitions,
  staleHeartbeats,
  targetsForShard,
  type CheckResult,
  type HeartbeatRecord,
  type TargetState,
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

const stateKey = (shard: number) => `state:${shard}`;
const heartbeatKey = (job: string) => `hb:${job}`;

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
  const states: Record<string, TargetState> = {};
  for (let shard = 0; shard < SHARDS; shard++) {
    Object.assign(states, (await env.MONITOR_KV.get<Record<string, TargetState>>(stateKey(shard), 'json')) ?? {});
  }
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
  return Response.json({ results, heartbeats, timestamp: new Date().toISOString() });
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
    await sendTelegram(env, `🔴 ${job} run failed${list}`);
  }
  return Response.json({ recorded: true });
}

async function runShard(env: Env, shard: number) {
  const now = new Date();
  const targets = targetsForShard(TARGETS, shard, SHARDS);
  const results = await Promise.all(targets.map(checkTarget));

  const previous = (await env.MONITOR_KV.get<Record<string, TargetState>>(stateKey(shard), 'json')) ?? {};
  const { state, transitions } = applyResults(previous, results, now);
  await env.MONITOR_KV.put(stateKey(shard), JSON.stringify(state));

  const messages: string[] = [];
  if (transitions.length) messages.push(formatTransitions(transitions, now));

  // Shard 0 also watches the scheduled jobs.
  if (shard === 0) {
    const records: Record<string, HeartbeatRecord | null> = {};
    for (const h of HEARTBEATS) records[h.job] = await env.MONITOR_KV.get<HeartbeatRecord>(heartbeatKey(h.job), 'json');
    for (const spec of staleHeartbeats(HEARTBEATS, records, now)) {
      const last = records[spec.job]?.at;
      messages.push(`⏰ ${spec.job} has not reported for over ${spec.maxAgeHours}h${last ? ` (last: ${last})` : ' (never)'}`);
      const record: HeartbeatRecord = records[spec.job] ?? { at: new Date(0).toISOString(), ok: false };
      await env.MONITOR_KV.put(heartbeatKey(spec.job), JSON.stringify({ ...record, staleAlertedAt: now.toISOString() }));
    }
  }

  if (messages.length) await sendTelegram(env, messages.join('\n'));
  return { shard, checked: results.length, transitions, timestamp: now.toISOString() };
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

async function sendTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn('Telegram is not configured; alert not sent:', text);
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `[monitor] ${text}`, disable_web_page_preview: true }),
  });
  if (!response.ok) console.error('Telegram send failed', response.status, await response.text());
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
