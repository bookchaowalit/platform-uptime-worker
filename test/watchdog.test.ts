import { describe, expect, it } from 'vitest';
import { assessStatus, runWatchdog, STALE_AFTER_MINUTES, type WatchdogEnv } from '../src/watchdog';

// SPEC-001: external watchdog for the uptime monitor. Each test names its scenario.

const NOW = new Date('2026-11-05T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const ENV: WatchdogEnv = {
  STATUS_URL: 'https://monitor.example/status',
  HEARTBEAT_URL: 'https://monitor.example/heartbeat/monitor-watchdog',
  HEARTBEAT_TOKEN: 'hb-secret',
  TELEGRAM_BOT_TOKEN: 'tg-secret',
  TELEGRAM_CHAT_ID: '42',
};

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fake fetch: `status` answers GET /status, `heartbeat` and `telegram` answer the POSTs. */
function fakeFetch(opts: {
  status?: () => Response | Promise<Response>;
  heartbeat?: () => Response | Promise<Response>;
  telegram?: () => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://api.telegram.org/')) return (opts.telegram ?? (() => new Response('{}')))();
    if (url === ENV.HEARTBEAT_URL) return (opts.heartbeat ?? (() => Response.json({ recorded: true })))();
    if (url === ENV.STATUS_URL) return (opts.status ?? (() => new Response('nope', { status: 500 })))();
    throw new Error(`unexpected url ${url}`);
  };
  return { fn: fn as typeof fetch, calls };
}

const statusBody = (...checked: (string | undefined)[]) =>
  Response.json({ results: checked.map((c, i) => ({ name: `t${i}`, checkedAt: c })), timestamp: NOW.toISOString() });

const logs = () => {
  const lines: string[] = [];
  return { log: (s: string) => lines.push(s), lines };
};

describe('assessStatus', () => {
  it('AC-01 healthy when the newest checkedAt is within the window', () => {
    expect(assessStatus({ results: [{ checkedAt: minutesAgo(90) }, { checkedAt: minutesAgo(3) }] }, NOW)).toEqual([]);
    expect(assessStatus({ results: [{ checkedAt: minutesAgo(STALE_AFTER_MINUTES) }] }, NOW)).toEqual([]);
  });

  it('AC-02 flags stopped crons when every checkedAt is older than the window', () => {
    const problems = assessStatus({ results: [{ checkedAt: minutesAgo(31) }, { checkedAt: minutesAgo(200) }] }, NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no target probed for 31 min/);
  });

  it('AC-04 flags empty results, missing or invalid checkedAt, and a wrong shape', () => {
    expect(assessStatus({ results: [] }, NOW)[0]).toMatch(/no probed targets/);
    expect(assessStatus({ results: [{ checkedAt: 'not a date' }, {}] }, NOW)[0]).toMatch(/no probed targets/);
    expect(assessStatus({ nope: true }, NOW)[0]).toMatch(/unexpected status shape/);
    expect(assessStatus(null, NOW)[0]).toMatch(/unexpected status shape/);
  });
});

describe('runWatchdog', () => {
  it('AC-01 healthy: no Telegram, heartbeat ok:true with the token, exit 0', async () => {
    const f = fakeFetch({ status: () => statusBody(minutesAgo(2)) });
    const l = logs();
    expect(await runWatchdog({ env: ENV, fetch: f.fn, now: NOW, log: l.log })).toBe(0);
    expect(f.calls.some((c) => c.url.includes('telegram'))).toBe(false);
    const hb = f.calls.find((c) => c.url === ENV.HEARTBEAT_URL)!;
    expect(hb.init?.method).toBe('POST');
    expect(new Headers(hb.init?.headers).get('authorization')).toBe('Bearer hb-secret');
    expect(JSON.parse(String(hb.init?.body))).toMatchObject({ ok: true });
  });

  it('AC-02 stale data: Telegram alert, no heartbeat, exit 1', async () => {
    const f = fakeFetch({ status: () => statusBody(minutesAgo(45)) });
    expect(await runWatchdog({ env: ENV, fetch: f.fn, now: NOW, log: () => {} })).toBe(1);
    const tg = f.calls.find((c) => c.url.includes('telegram'))!;
    expect(tg.url).toBe('https://api.telegram.org/bottg-secret/sendMessage');
    const body = JSON.parse(String(tg.init?.body));
    expect(body.chat_id).toBe('42');
    expect(body.text).toMatch(/^\[monitor-watchdog\] .*no target probed for 45 min/s);
    expect(f.calls.some((c) => c.url === ENV.HEARTBEAT_URL)).toBe(false);
  });

  it('AC-03 unreachable: non-2xx, thrown fetch, timeout and bad JSON all alert', async () => {
    const cases: (() => Response | Promise<Response>)[] = [
      () => new Response('error code: 1042', { status: 404 }),
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      () => new Response('<html>', { status: 200 }),
    ];
    for (const status of cases) {
      const f = fakeFetch({ status });
      expect(await runWatchdog({ env: ENV, fetch: f.fn, now: NOW, log: () => {} })).toBe(1);
      const tg = f.calls.find((c) => c.url.includes('telegram'))!;
      expect(JSON.parse(String(tg.init?.body)).text).toMatch(/status unreachable/);
    }
  });

  it('AC-03 passes a timeout signal to the status fetch', async () => {
    const f = fakeFetch({ status: () => statusBody(minutesAgo(1)) });
    await runWatchdog({ env: ENV, fetch: f.fn, now: NOW, log: () => {} });
    expect(f.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('AC-05 Telegram failure or missing config still exits 1 and never logs a secret', async () => {
    const variants: { env: WatchdogEnv; telegram?: () => Response }[] = [
      { env: ENV, telegram: () => new Response('{"description":"Unauthorized tg-secret"}', { status: 401 }) },
      {
        env: ENV,
        telegram: () => {
          throw new Error('connect https://api.telegram.org/bottg-secret/sendMessage');
        },
      },
      { env: { ...ENV, TELEGRAM_BOT_TOKEN: '' } },
      { env: { ...ENV, TELEGRAM_CHAT_ID: undefined } },
    ];
    for (const v of variants) {
      const f = fakeFetch({ status: () => statusBody(minutesAgo(99)), telegram: v.telegram });
      const l = logs();
      expect(await runWatchdog({ env: v.env, fetch: f.fn, now: NOW, log: l.log })).toBe(1);
      const out = l.lines.join('\n');
      expect(out).toMatch(/telegram/i);
      expect(out).not.toContain('tg-secret');
      expect(out).not.toContain('hb-secret');
    }
  });

  it('AC-08 heartbeat failure or missing token: no Telegram, exit 1', async () => {
    for (const v of [
      { env: ENV, heartbeat: () => new Response('no', { status: 401 }) },
      {
        env: ENV,
        heartbeat: () => {
          throw new Error('fetch failed');
        },
      },
      { env: { ...ENV, HEARTBEAT_TOKEN: ' ' } },
    ]) {
      const f = fakeFetch({ status: () => statusBody(minutesAgo(1)), heartbeat: v.heartbeat });
      const l = logs();
      expect(await runWatchdog({ env: v.env, fetch: f.fn, now: NOW, log: l.log })).toBe(1);
      expect(f.calls.some((c) => c.url.includes('telegram'))).toBe(false);
      expect(l.lines.join('\n')).not.toContain('hb-secret');
    }
  });

  it('uses the production URLs when none are configured', async () => {
    const f: Call[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      f.push({ url: String(input), init });
      return String(input).endsWith('/status') ? statusBody(minutesAgo(1)) : Response.json({ recorded: true });
    }) as typeof fetch;
    await runWatchdog({ env: { HEARTBEAT_TOKEN: 'x' }, fetch: fn, now: NOW, log: () => {} });
    expect(f.map((c) => c.url)).toEqual([
      'https://monitor.bookchaowalit.com/status',
      'https://monitor.bookchaowalit.com/heartbeat/monitor-watchdog',
    ]);
  });
});
