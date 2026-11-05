// External watchdog for the uptime monitor (specs/001-monitor-watchdog/spec.md).
//
// The Worker watches every service and job, but nothing on Cloudflare can report that the Worker
// itself stopped. This check runs on a GitHub-hosted runner (scripts/watchdog.ts, hourly workflow),
// reads the public /status and alerts Telegram directly. On a healthy check it posts the heartbeat
// `monitor-watchdog`, so the Worker reports in turn when the watchdog stops.
//
// Not bundled into the Worker (nothing in worker.ts imports it). No imports, so Node can run it
// straight from TypeScript.

/** 5-minute crons plus the 60 s public edge cache, with a wide margin. */
export const STALE_AFTER_MINUTES = 30;
const STATUS_TIMEOUT_MS = 20_000;
const POST_TIMEOUT_MS = 15_000;
const DEFAULT_BASE = 'https://monitor.bookchaowalit.com';

export interface WatchdogEnv {
  STATUS_URL?: string;
  HEARTBEAT_URL?: string;
  HEARTBEAT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface WatchdogDeps {
  env: WatchdogEnv;
  fetch: typeof fetch;
  now: Date;
  log: (line: string) => void;
}

/** Problems with a parsed /status body; empty when the monitor is healthy. */
export function assessStatus(body: unknown, now: Date): string[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return ['unexpected status shape (no results array)'];
  const times = results
    .map((r) => Date.parse(String((r as { checkedAt?: unknown } | null)?.checkedAt ?? '')))
    .filter((t) => Number.isFinite(t));
  if (!times.length) return ['status has no probed targets'];
  const ageMinutes = Math.floor((now.getTime() - Math.max(...times)) / 60_000);
  if (ageMinutes > STALE_AFTER_MINUTES) {
    return [`no target probed for ${ageMinutes} min (both cron shards stopped?)`];
  }
  return [];
}

/** One watchdog run. Returns the process exit code: 0 healthy and recorded, 1 otherwise. */
export async function runWatchdog({ env, fetch, now, log }: WatchdogDeps): Promise<number> {
  const statusUrl = env.STATUS_URL?.trim() || `${DEFAULT_BASE}/status`;
  const heartbeatUrl = env.HEARTBEAT_URL?.trim() || `${DEFAULT_BASE}/heartbeat/monitor-watchdog`;

  let problems: string[];
  try {
    const res = await fetch(statusUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
      problems = [`status unreachable: HTTP ${res.status}`];
    } else {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      problems = body === undefined ? ['status unreachable: body is not JSON'] : assessStatus(body, now);
    }
  } catch (err) {
    problems = [`status unreachable: ${errorName(err)}`];
  }

  if (problems.length) {
    const text = `🔴 uptime monitor: ${problems.join('; ')}. Its alerts are not reaching you; check the Worker solo-empire-monitor.`;
    log(`problem: ${problems.join('; ')}`);
    const sent = await sendTelegram(env, text, fetch);
    log(sent ? 'telegram: alert sent' : 'telegram: alert NOT sent (failed or not configured); this failed run is the fallback');
    return 1;
  }

  log('ok: monitor is probing');
  const token = env.HEARTBEAT_TOKEN?.trim();
  if (!token) {
    log('heartbeat: HEARTBEAT_TOKEN missing, not recorded');
    return 1;
  }
  try {
    const res = await fetch(heartbeatUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, checkedAt: now.toISOString() }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log(`heartbeat: HTTP ${res.status}, not recorded`);
      return 1;
    }
  } catch (err) {
    log(`heartbeat: ${errorName(err)}, not recorded`);
    return 1;
  }
  log('heartbeat: recorded');
  return 0;
}

async function sendTelegram(env: WatchdogEnv, text: string, fetchFn: WatchdogDeps['fetch']): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `[monitor-watchdog] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // The error message can contain the request URL, which holds the bot token: never log it.
    return false;
  }
}

/** Error class name only: messages can carry URLs with secrets in them. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}
