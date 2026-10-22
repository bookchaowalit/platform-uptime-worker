// Pure monitoring logic, kept free of Workers APIs so it can be unit tested.

import type { HeartbeatSpec, Target } from './targets';

export type CheckStatus = 'up' | 'down';

export interface CheckResult {
  name: string;
  ok: boolean;
  latency: number;
  error?: string;
}

export interface TargetState {
  status: CheckStatus;
  consecutiveFailures: number;
  since: string; // when `status` last changed
  lastAlertAt?: string; // last down alert or reminder
  latency: number;
  error?: string;
  checkedAt: string;
}

export interface HeartbeatRecord {
  at: string;
  ok: boolean;
  detail?: unknown;
}

/** Per-shard state stored as one KV value: target states plus alerts not yet delivered. */
export interface ShardState {
  targets: Record<string, TargetState>;
  pendingAlerts: string[];
  /** Staleness watch over the next shard's targets (TD-004), and when that watch started. */
  staleWatch: StaleWatch;
  watchSince?: string;
}

/** Undelivered alert lines kept for retry; the oldest are dropped beyond this. */
export const MAX_PENDING_ALERTS = 200;

/** A target is declared down after this many failed checks in a row (10 minutes at 5-minute cron). */
export const FAILURES_BEFORE_DOWN = 2;
/** While a target stays down, repeat the alert this often. */
export const REMINDER_HOURS = 6;

/**
 * Whether a target is probed in this run. Sleeping services only in the first cron tick of each
 * hour (shard 0 runs at :00, shard 1 at :02), everything else every run.
 */
export function isDue(target: Target, now: Date): boolean {
  return !target.sleeps || now.getUTCMinutes() < 5;
}

/**
 * Shard of a target, from its name only (32-bit FNV-1a). Index-based sharding moved every later
 * target to the other shard whenever one was inserted (TD-004).
 */
export function shardOfName(name: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shards;
}

export function targetsForShard(targets: Target[], shard: number, shards: number): Target[] {
  return targets.filter((t) => shardOfName(t.name, shards) === shard);
}

/** The shard whose targets this shard checks for staleness: a stopped cron cannot report itself. */
export function watchedShard(shard: number, shards: number): number {
  return (shard + 1) % shards;
}

/** One state per target, read from the shard that owns it, whatever other shards still hold. */
export function mergeShardStates(
  shardStates: Record<string, TargetState>[],
  targets: Target[],
  shards: number,
): Record<string, TargetState> {
  const merged: Record<string, TargetState> = {};
  for (const t of targets) {
    const state = shardStates[shardOfName(t.name, shards)]?.[t.name];
    if (state) merged[t.name] = state;
  }
  return merged;
}

/**
 * Previous state for the targets this shard owns: the newest copy in any shard. A target that
 * changed shard keeps its real state (an ongoing outage stays down, its recovery is still
 * reported), and an old copy left behind by an earlier owner always loses.
 */
export function newestStates(
  shardStates: Record<string, TargetState>[],
  targets: Target[],
  shard: number,
  shards: number,
): Record<string, TargetState> {
  const seeded: Record<string, TargetState> = {};
  for (const t of targetsForShard(targets, shard, shards)) {
    for (const states of shardStates) {
      const candidate = states[t.name];
      if (candidate && (!seeded[t.name] || candidate.checkedAt > seeded[t.name].checkedAt)) seeded[t.name] = candidate;
    }
  }
  return seeded;
}

export interface Transition {
  name: string;
  kind: 'down' | 'reminder' | 'recovered';
  error?: string;
  downSince?: string;
}

/** Apply one round of results to the previous state and report what should be alerted. */
export function applyResults(
  previous: Record<string, TargetState>,
  results: CheckResult[],
  now: Date,
): { state: Record<string, TargetState>; transitions: Transition[] } {
  const state: Record<string, TargetState> = {};
  const transitions: Transition[] = [];
  const nowIso = now.toISOString();

  for (const result of results) {
    const prev = previous[result.name];
    if (result.ok) {
      if (prev?.status === 'down') {
        transitions.push({ name: result.name, kind: 'recovered', downSince: prev.since });
      }
      state[result.name] = {
        status: 'up',
        consecutiveFailures: 0,
        since: prev?.status === 'up' ? prev.since : nowIso,
        latency: result.latency,
        checkedAt: nowIso,
      };
      continue;
    }

    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const wasDown = prev?.status === 'down';
    const next: TargetState = {
      status: wasDown || failures >= FAILURES_BEFORE_DOWN ? 'down' : 'up',
      consecutiveFailures: failures,
      since: prev?.since ?? nowIso,
      lastAlertAt: prev?.lastAlertAt,
      latency: result.latency,
      error: result.error,
      checkedAt: nowIso,
    };

    if (!wasDown && next.status === 'down') {
      next.since = nowIso;
      next.lastAlertAt = nowIso;
      transitions.push({ name: result.name, kind: 'down', error: result.error });
    } else if (wasDown && hoursBetween(prev?.lastAlertAt ?? prev.since, now) >= REMINDER_HOURS) {
      next.lastAlertAt = nowIso;
      transitions.push({ name: result.name, kind: 'reminder', error: result.error, downSince: prev.since });
    }
    state[result.name] = next;
  }

  return { state, transitions };
}

/**
 * Heartbeats that are overdue. `staleAlertedAt` is kept under its own key so the cron never
 * rewrites a heartbeat record (a POST landing between read and write would otherwise be lost).
 */
export function staleHeartbeats(
  specs: HeartbeatSpec[],
  records: Record<string, HeartbeatRecord | null>,
  staleAlertedAt: Record<string, string | null>,
  now: Date,
): HeartbeatSpec[] {
  return specs.filter((spec) => {
    const record = records[spec.job];
    if (record && hoursBetween(record.at, now) < spec.maxAgeHours) return false;
    const alerted = staleAlertedAt[spec.job];
    // An alert sent before the latest report belongs to an earlier missed window.
    const alertedThisWindow = alerted && (!record || alerted > record.at);
    // Alert once per missed window, then again every REMINDER_HOURS.
    return !alertedThisWindow || hoursBetween(alerted as string, now) >= REMINDER_HOURS;
  });
}

/** A target counts as not probed after this long (sleeping services are probed hourly). */
export const STALE_AFTER_HOURS = { awake: 0.5, sleeping: 2.5 };

/** Per watched target: when it was first seen without any state, and the last stale alert. */
export type StaleWatch = Record<string, { firstSeen?: string; alertedAt?: string }>;

export function isStale(target: Target, state: TargetState | undefined, now: Date): boolean {
  return Boolean(state) && hoursBetween((state as TargetState).checkedAt, now) > staleLimit(target);
}

function staleLimit(target: Target): number {
  return target.sleeps ? STALE_AFTER_HOURS.sleeping : STALE_AFTER_HOURS.awake;
}

const latest = (...isos: (string | undefined)[]) =>
  isos.filter((x): x is string => Boolean(x)).reduce((a, b) => (a > b ? a : b));

/**
 * Targets whose last probe is too old: a stopped shard cron, or a target that is never due.
 * Each target gets a full window from `watchSince` (when the watcher started) and, without any
 * state, from when it was first seen. Alerts once per stale window, then every REMINDER_HOURS.
 */
export function staleTargets(
  targets: Target[],
  states: Record<string, TargetState>,
  watch: StaleWatch,
  now: Date,
  watchSince?: string,
): { lines: string[]; watch: StaleWatch } {
  const nowIso = now.toISOString();
  const next: StaleWatch = {};
  const lines: string[] = [];
  for (const target of targets) {
    const state = states[target.name];
    const seen = watch[target.name] ?? {};
    const firstSeen = state ? undefined : (seen.firstSeen ?? nowIso);
    const last = latest(state?.checkedAt, firstSeen, watchSince);
    if (hoursBetween(last, now) <= staleLimit(target)) {
      if (seen.alertedAt) lines.push(`✅ ${target.name} is being probed again`);
      if (firstSeen) next[target.name] = { firstSeen };
      continue;
    }
    if (!seen.alertedAt || hoursBetween(seen.alertedAt, now) >= REMINDER_HOURS) {
      const expected = target.sleeps ? '1h' : '5m';
      lines.push(
        `⏰ ${target.name} not probed for ${durationText(last, now)} (last check: ${state?.checkedAt ?? 'never'}; expected every ${expected})`,
      );
      next[target.name] = { ...(firstSeen ? { firstSeen } : {}), alertedAt: nowIso };
    } else {
      next[target.name] = { ...(firstSeen ? { firstSeen } : {}), alertedAt: seen.alertedAt };
    }
  }
  return { lines, watch: next };
}

/** Telegram rejects messages over 4096 characters; stay below it with room for the prefix. */
export const MAX_MESSAGE_CHARS = 3900;

/**
 * Group alert lines into Telegram-sized messages without splitting a line. A single line longer
 * than the limit is shortened with a marker rather than dropped.
 */
export function chunkAlerts(lines: string[], max = MAX_MESSAGE_CHARS): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const raw of lines) {
    const line = raw.length > max ? `${raw.slice(0, max - 20)} … (truncated)` : raw;
    const added = (current.length ? 1 : 0) + line.length;
    if (current.length && size + added > max) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    size += (current.length ? 1 : 0) + line.length;
    current.push(line);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Queue new alert lines behind undelivered ones, keeping the newest MAX_PENDING_ALERTS. */
export function queueAlerts(pending: string[], fresh: string[]): string[] {
  return [...pending, ...fresh].slice(-MAX_PENDING_ALERTS);
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function formatTransitions(transitions: Transition[], now: Date): string {
  const lines = transitions.map((t) => {
    if (t.kind === 'recovered') {
      return `✅ ${t.name} recovered (down ${durationText(t.downSince, now)})`;
    }
    const prefix = t.kind === 'down' ? '🔴' : '⏰ still down:';
    const since = t.kind === 'reminder' ? ` for ${durationText(t.downSince, now)}` : '';
    return `${prefix} ${t.name}${since}${t.error ? ` (${t.error})` : ''}`;
  });
  return lines.join('\n');
}

export function hoursBetween(fromIso: string, now: Date): number {
  return (now.getTime() - new Date(fromIso).getTime()) / 3_600_000;
}

function durationText(fromIso: string | undefined, now: Date): string {
  if (!fromIso) return 'unknown';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
