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
  jobsSummary,
  publicJobs,
  type JobsSummary,
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
// Names of late or failed jobs for the public status, rewritten by shard 0 only when it changes.
const JOBS_SUMMARY_KEY = 'hb-summary';
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
/** Parked keys per list page, and pages per run (free plan: 1 000 list calls a day; 3 pages × 288 runs fits). */
const PARKED_SCAN = 100;
const PARKED_PAGES = 3;
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
  let jobs: unknown = null;
  try {
    const summary = await env.MONITOR_KV.get<JobsSummary>(JOBS_SUMMARY_KEY, 'json');
    // Public callers get counts only: job names can name a client, like the targets this hides.
    jobs = summary && (full ? summary : publicJobs(summary));
  } catch {
    jobs = null;
  }
  const response = Response.json({ results, jobs, heartbeats, timestamp: new Date().toISOString() });
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
  const spec = HEARTBEATS.find((h) => h.job === job)!;
  // A failed KV read must not stop the failed-run alert: treat it as no previous record.
  let last: HeartbeatRecord | null = null;
  try {
    last = await env.MONITOR_KV.get<HeartbeatRecord>(heartbeatKey(job), 'json');
  } catch (error) {
    console.error('KV read failed', error instanceof Error ? error.name : 'unknown error');
  }

  // A streak that never alerted (held below failuresBeforeAlert) recovers silently. The note goes out only
  // after the ok record is stored, so a lost write cannot leave a 'recovered' message over a failed record.
  const recover = ok && !!last && last.ok === false && last.held !== true;
  // While any alert of this job is still parked, new ones park behind it so the job's order holds across
  // streaks (a listing only when something is about to be said: lists are the scarcest KV operation).
  const backlog = (!ok || recover) && (await hasParked(env, job));
  const streak = ok ? 0 : last?.ok === false ? (last.streak ?? 1) + 1 : 1;
  const held = !ok && streak < (spec.failuresBeforeAlert ?? 1);
  // Alert on the first failed run of a streak only: the same failure every run is one problem, not many.
  // A different list of failed parts is new information and alerts again, and so does a failure whose
  // earlier alert was never delivered (alerted: false).
  const sameFailure =
    !ok && last?.ok === false && last.alerted !== false && failedList(last.detail) === failedList(detail);
  let alerted = true;
  // Sticky for the whole streak: once a failure of this streak was parked, its recovery must be parked too.
  let parked = (!ok && last?.ok === false && last.parked === true) || (!ok && backlog);
  if (!ok && !sameFailure && !held) {
    const list = failedList(detail);
    const text = bounded(`🔴 ${job} รันไม่ผ่าน${list ? `: ${list}` : ''}`);
    // If Telegram is down, park the alert under its own key; the shard 0 cron retries it. Behind a backlog it
    // parks straight away.
    const sent = !backlog && (await sendTelegram(env, text));
    const queued = !sent && (await putRetry(env, hbAlertKey(job), text));
    parked = parked || queued;
    alerted = sent || queued;
  }
  const record: HeartbeatRecord = ok
    ? { at: now.toISOString(), ok, detail }
    : {
        at: now.toISOString(),
        ok,
        detail,
        // A held failure sent nothing, so the next failure of the streak must alert.
        alerted: held ? false : alerted,
        streak,
        ...(held ? { held } : {}),
        ...(parked ? { parked } : {}),
      };
  const fresh = ok && last?.ok === true && now.getTime() - Date.parse(last.at) < heartbeatGraceHours(spec) * 3_600_000;
  // KV allows one write per second per key and can refuse (429); it is retried once and then reported
  // as not recorded.
  const stored = fresh || (await putRetry(env, heartbeatKey(job), JSON.stringify(record)));
  if (stored && recover) await noteRecovery(env, job, last!.parked === true || backlog);
  // Neither sent nor parked: answer 503 so the job reports again instead of the alert vanishing.
  if (!alerted) return Response.json({ recorded: stored, alerted: false }, { status: 503 });
  return stored ? Response.json({ recorded: true }) : Response.json({ recorded: false }, { status: 503 });
}

/**
 * One line when a failing job passes again; best effort, a lost recovery note is not worth a retry.
 * When the streak's failed alert went to the parked queue, the note is parked too (a newer key), and the
 * cron sends a parked recovery only after every older parked alert of the same job is gone, so the
 * owner never reads the recovery before the failure. No KV list or rewrite here: both can be stale.
 */
async function noteRecovery(env: Env, job: string, behindParked: boolean): Promise<void> {
  const note = bounded(`🟢 ${job} กลับมาปกติ`);
  // Behind a parked alert it parks too; a refused send parks rather than vanishing.
  if (behindParked || !(await sendTelegram(env, note))) await putRetry(env, hbAlertKey(job), note);
}

/** Whether any alert of this job is parked (a failed listing counts as yes: parking keeps the order). */
async function hasParked(env: Env, job: string): Promise<boolean> {
  try {
    const listed = await env.MONITOR_KV.list({ prefix: `${HB_ALERT_PREFIX}${job}:`, limit: 1 });
    return listed.keys.length > 0;
  } catch {
    return true;
  }
}

/** `16/11 09:30` in Asia/Bangkok, the owner's clock. */
function bangkokTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 7 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function failedList(detail: unknown): string {
  const failed = (detail as { failed?: unknown } | null)?.failed;
  return Array.isArray(failed) ? failed.map(String).join(', ') : '';
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
      fresh.push(`🟡 ${spec.job} ไม่รายงานเกิน ${spec.maxAgeHours} ชม. · ${last ? `ล่าสุด ${bangkokTime(last)}` : 'ยังไม่เคยรายงาน'}`);
      staleMarks.push(spec.job);
    }
    // A failed summary write only leaves the public status a run behind; it never blocks alerts.
    try {
      const summary = JSON.stringify(jobsSummary(HEARTBEATS, records, now));
      if ((await env.MONITOR_KV.get(JOBS_SUMMARY_KEY)) !== summary) await env.MONITOR_KV.put(JOBS_SUMMARY_KEY, summary);
    } catch {
      /* next run retries */
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
    // List reads are cheap, writes are not (free plan): read a wider page and start at an offset that moves
    // every run, so keys Telegram keeps refusing cannot hold back the ones after them (no cursor write).
    const keys: { name: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PARKED_PAGES; page++) {
      const listed = await env.MONITOR_KV.list({ prefix: HB_ALERT_PREFIX, limit: PARKED_SCAN, cursor });
      keys.push(...listed.keys);
      cursor = listed.list_complete ? undefined : listed.cursor;
      if (!cursor) break;
    }
    // More than the pages hold: say so (the rest wait until the first pages drain) instead of hiding it.
    if (cursor) console.warn('parked alerts exceed the per-run scan', PARKED_SCAN * PARKED_PAGES);
    // Per job, oldest key first (keys are `<job>:<time>:<id>`), so a job's alerts keep their order; the
    // jobs take turns from an offset that moves every run, so refused ones cannot starve the others.
    const jobOf = (name: string) => name.slice(HB_ALERT_PREFIX.length).split(':')[0];
    const byJob = new Map<string, string[]>();
    for (const { name } of keys) byJob.set(jobOf(name), [...(byJob.get(jobOf(name)) ?? []), name]);
    const jobs = [...byJob.keys()];
    const offset = jobs.length ? Math.floor(now.getTime() / 300_000) % jobs.length : 0;
    let budget = MAX_PARKED_PER_RUN;
    for (const job of [...jobs.slice(offset), ...jobs.slice(0, offset)]) {
      if (budget <= 0) break;
      const names = byJob.get(job)!.sort();
      const texts = new Map<string, string>();
      for (const name of names) {
        const text = await env.MONITOR_KV.get(name);
        if (text !== null) texts.set(name, text);
      }
      // Order rules: a recovery waits for every older alert of its job, and a failure waits for every older
      // recovery, so the last message a job leaves is always its latest state. Oldest first; an alert parked
      // over an hour (Telegram keeps refusing it) goes to the back, so it cannot use up the budget ahead of
      // the failures after it. Passes repeat while something was sent (a recovery may become sendable).
      const parkedAt = (n: string) => Number(n.slice(HB_ALERT_PREFIX.length).split(':')[1]) || 0;
      const stuck = (n: string) => now.getTime() - parkedAt(n) > 3_600_000;
      const order = [...names.filter((n) => !stuck(n)), ...names.filter(stuck)];
      const tried = new Set<string>();
      let progress = true;
      while (progress && budget > 0) {
        progress = false;
        for (const name of order) {
          if (budget <= 0) break;
          if (!texts.has(name) || tried.has(name)) continue;
          const text = texts.get(name)!;
          const older = names.filter((n) => n < name && texts.has(n));
          const recovery = text.startsWith('🟢');
          if (recovery ? older.length > 0 : older.some((n) => texts.get(n)!.startsWith('🟢'))) continue;
          budget--;
          tried.add(name);
          if (!(await sendTelegram(env, bounded(text)))) continue; // stays parked for the next run
          await env.MONITOR_KV.delete(name);
          texts.delete(name);
          progress = true;
        }
      }
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
