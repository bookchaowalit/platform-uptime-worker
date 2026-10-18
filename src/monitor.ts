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
  staleAlertedAt?: string;
}

/** A target is declared down after this many failed checks in a row (10 minutes at 5-minute cron). */
export const FAILURES_BEFORE_DOWN = 2;
/** While a target stays down, repeat the alert this often. */
export const REMINDER_HOURS = 6;

export function shardOf(index: number, shards: number): number {
  return index % shards;
}

export function targetsForShard(targets: Target[], shard: number, shards: number): Target[] {
  return targets.filter((_, i) => shardOf(i, shards) === shard);
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

/** Heartbeats that are overdue and have not been alerted since their last report. */
export function staleHeartbeats(
  specs: HeartbeatSpec[],
  records: Record<string, HeartbeatRecord | null>,
  now: Date,
): HeartbeatSpec[] {
  return specs.filter((spec) => {
    const record = records[spec.job];
    if (!record) return true;
    if (hoursBetween(record.at, now) < spec.maxAgeHours) return false;
    // Alert once per missed window, then again every REMINDER_HOURS.
    return !record.staleAlertedAt || hoursBetween(record.staleAlertedAt, now) >= REMINDER_HOURS;
  });
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
