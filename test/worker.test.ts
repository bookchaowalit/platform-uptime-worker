import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker';
import { targetsForShard } from '../src/monitor';
import { HEARTBEATS, SHARDS, TARGETS } from '../src/targets';

// The Worker's fetch and scheduled handlers against an in-memory KV, edge cache and a stubbed
// global fetch: nothing here reaches a monitored service or Telegram.

const ORIGIN = 'https://monitor.test';
const MONITOR_TOKEN = 'monitor-secret';
const HEARTBEAT_TOKEN = 'heartbeat-secret';

class MemoryKV {
  store = new Map<string, string>();
  puts: string[] = [];
  gets = 0;

  async get(key: string, type?: 'json' | 'text') {
    this.gets++;
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key: string, value: string) {
    this.puts.push(key);
    this.store.set(key, value);
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list({ prefix = '', limit = 1000 }: { prefix?: string; limit?: number } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
    return { keys: keys.map((name) => ({ name })), list_complete: true, cacheStatus: null };
  }
}

class MemoryCache {
  entries = new Map<string, Response>();
  async match(request: Request) {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response) {
    this.entries.set(request.url, response);
  }
}

let kv: MemoryKV;
let cache: MemoryCache;
let telegram: string[];
let telegramUp: boolean;
let probed: string[];
let failing: Set<string>;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    MONITOR_KV: kv as unknown as KVNamespace,
    MONITOR_TOKEN,
    HEARTBEAT_TOKEN,
    TELEGRAM_BOT_TOKEN: '123:test',
    TELEGRAM_CHAT_ID: '42',
    ...overrides,
  };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

const request = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const call = (req: Request, env: Env = makeEnv()) => worker.fetch(req, env, makeCtx().ctx);

beforeEach(() => {
  kv = new MemoryKV();
  cache = new MemoryCache();
  telegram = [];
  telegramUp = true;
  probed = [];
  failing = new Set();
  vi.stubGlobal('caches', { default: cache });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.telegram.org/')) {
        if (!telegramUp) return new Response('down', { status: 502 });
        telegram.push(JSON.parse(String(init?.body)).text);
        return Response.json({ ok: true });
      }
      probed.push(url);
      return failing.has(url) ? new Response('err', { status: 503 }) : new Response('ok');
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('routing', () => {
  it('serves the status page at /', async () => {
    const res = await call(request('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toContain('Solo Empire Status');
  });

  it('answers 404 for unknown paths', async () => {
    expect((await call(request('/nope'))).status).toBe(404);
  });
});

describe('/status', () => {
  it('shows only own services publicly, without URLs, errors or heartbeats', async () => {
    const body = (await (await call(request('/status'))).json()) as {
      results: Record<string, unknown>[];
      heartbeats?: unknown;
    };
    expect(body.results.length).toBe(TARGETS.filter((t) => t.group === 'own').length);
    for (const r of body.results) {
      expect(r.group).toBe('own');
      expect(r).not.toHaveProperty('url');
      expect(r).not.toHaveProperty('error');
      expect(r.status).toBe('unknown');
    }
    expect(body.heartbeats).toBeUndefined();
  });

  it('serves public requests from the edge cache so traffic cannot drain KV reads', async () => {
    const first = await call(request('/status'));
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    const readsAfterFirst = kv.gets;
    await call(request('/status'));
    expect(kv.gets).toBe(readsAfterFirst);
  });

  it('returns every target with URLs and heartbeats when given MONITOR_TOKEN', async () => {
    await kv.put('hb:db-backup', JSON.stringify({ at: '2026-10-23T00:00:00Z', ok: true, detail: null }));
    const res = await call(request('/status', { headers: bearer(MONITOR_TOKEN) }));
    expect(res.headers.get('cache-control')).toBeNull();
    const body = (await res.json()) as { results: { url?: string }[]; heartbeats: Record<string, unknown> };
    expect(body.results.length).toBe(TARGETS.length);
    expect(body.results.every((r) => r.url?.startsWith('https://'))).toBe(true);
    expect(Object.keys(body.heartbeats).sort()).toEqual(HEARTBEATS.map((h) => h.job).sort());
    expect(body.heartbeats['db-backup']).toMatchObject({ ok: true });
    expect(cache.entries.size).toBe(0);
  });

  it('treats a wrong token as a public request', async () => {
    const body = (await (await call(request('/status', { headers: bearer('wrong') }))).json()) as {
      results: unknown[];
    };
    expect(body.results.length).toBe(TARGETS.filter((t) => t.group === 'own').length);
  });

  it('reads each target from the shard that owns it and flags old probes as stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:07:00Z'));
    const target = TARGETS.find((t) => t.group === 'own' && !t.sleeps)!;
    const owner = targetsForShard(TARGETS, 0, SHARDS).includes(target) ? 0 : 1;
    const other = 1 - owner;
    const state = (status: string, checkedAt: string) => ({
      targets: { [target.name]: { status, consecutiveFailures: 0, since: checkedAt, checkedAt } },
      pendingAlerts: [],
      staleWatch: {},
    });
    await kv.put(`state:${owner}`, JSON.stringify(state('up', '2026-10-23T09:00:00Z')));
    await kv.put(`state:${other}`, JSON.stringify(state('down', '2026-10-23T10:05:00Z')));
    const body = (await (await call(request('/status', { headers: bearer(MONITOR_TOKEN) }))).json()) as {
      results: { name: string; status: string; stale: boolean }[];
    };
    expect(body.results.find((r) => r.name === target.name)).toMatchObject({ status: 'up', stale: true });
  });
});

describe('/check', () => {
  it('is disabled until MONITOR_TOKEN is configured', async () => {
    const res = await call(request('/check'), makeEnv({ MONITOR_TOKEN: '  ' }));
    expect(res.status).toBe(503);
  });

  it('rejects a missing or wrong token', async () => {
    expect((await call(request('/check'))).status).toBe(401);
    expect((await call(request('/check', { headers: bearer('wrong') }))).status).toBe(401);
  });

  it('rejects an invalid shard', async () => {
    for (const shard of ['2', '-1', '0.5', 'x']) {
      const res = await call(request(`/check?shard=${shard}`, { headers: bearer(MONITOR_TOKEN) }));
      expect(res.status).toBe(400);
    }
  });

  it('probes every target of the shard, sleepers included, and writes or sends nothing', async () => {
    failing = new Set(TARGETS.map((t) => t.url));
    const res = await call(request('/check?shard=1', { headers: bearer(MONITOR_TOKEN) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shard: number; checked: number; readOnly: boolean };
    const shardTargets = targetsForShard(TARGETS, 1, SHARDS);
    expect(body).toMatchObject({ shard: 1, checked: shardTargets.length, readOnly: true });
    expect(probed.sort()).toEqual(shardTargets.map((t) => t.url).sort());
    expect(kv.puts).toEqual([]);
    expect(telegram).toEqual([]);
  });
});

describe('/heartbeat/<job>', () => {
  const beat = (job: string, body: unknown, token = HEARTBEAT_TOKEN, method = 'POST') =>
    request(`/heartbeat/${job}`, { method, headers: bearer(token), body: method === 'POST' ? JSON.stringify(body) : undefined });

  it('accepts POST only', async () => {
    expect((await call(beat('db-backup', null, HEARTBEAT_TOKEN, 'GET'))).status).toBe(405);
  });

  it('is disabled without HEARTBEAT_TOKEN and rejects a wrong token', async () => {
    expect((await call(beat('db-backup', { ok: true }), makeEnv({ HEARTBEAT_TOKEN: undefined }))).status).toBe(503);
    expect((await call(beat('db-backup', { ok: true }, MONITOR_TOKEN))).status).toBe(401);
    expect(kv.puts).toEqual([]);
  });

  it('rejects unknown jobs', async () => {
    expect((await call(beat('not-a-job', { ok: true }))).status).toBe(404);
  });

  it('records a successful run without alerting', async () => {
    const res = await call(beat('db-backup', { ok: true, databases: 3 }));
    expect(await res.json()).toEqual({ recorded: true });
    const record = JSON.parse(kv.store.get('hb:db-backup')!);
    expect(record).toMatchObject({ ok: true, detail: { ok: true, databases: 3 } });
    expect(telegram).toEqual([]);
  });

  it('alerts straight away on a failed run, listing what failed', async () => {
    await call(beat('db-backup', { ok: false, failed: ['finance', 'tasks'] }));
    expect(JSON.parse(kv.store.get('hb:db-backup')!).ok).toBe(false);
    expect(telegram).toEqual(['[monitor] 🔴 db-backup run failed: finance, tasks']);
  });

  it('counts a body that is not JSON as a failed run', async () => {
    await call(request('/heartbeat/restore-drill', { method: 'POST', headers: bearer(HEARTBEAT_TOKEN), body: 'oops' }));
    expect(JSON.parse(kv.store.get('hb:restore-drill')!)).toMatchObject({ ok: false, detail: null });
    expect(telegram).toEqual(['[monitor] 🔴 restore-drill run failed']);
  });

  it('parks the alert under its own key when Telegram is down', async () => {
    telegramUp = false;
    await call(beat('job-capture', { ok: false }));
    const parked = [...kv.store.keys()].filter((k) => k.startsWith('hbalert:job-capture:'));
    expect(parked.length).toBe(1);
    expect(kv.store.get(parked[0])).toBe('🔴 job-capture run failed');
  });
});

describe('scheduled', () => {
  const runCron = async (cron: string, env: Env = makeEnv()) => {
    const { ctx, settle } = makeCtx();
    await worker.scheduled({ cron, scheduledTime: Date.now(), type: 'scheduled' } as ScheduledEvent, env, ctx);
    await settle();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('runs the second cron as shard 1 and skips sleeping services outside their hourly slot', async () => {
    vi.setSystemTime(new Date('2026-10-23T10:07:00Z'));
    await runCron('2-59/5 * * * *');
    const due = targetsForShard(TARGETS, 1, SHARDS).filter((t) => !t.sleeps);
    expect(probed.sort()).toEqual(due.map((t) => t.url).sort());
    const state = JSON.parse(kv.store.get('state:1')!);
    expect(Object.keys(state.targets).sort()).toEqual(due.map((t) => t.name).sort());
    expect(kv.store.has('state:0')).toBe(false);
    expect(telegram).toEqual([]);
  });

  it('alerts after two failures in a row, then on recovery', async () => {
    const target = targetsForShard(TARGETS, 1, SHARDS).find((t) => !t.sleeps)!;
    failing = new Set([target.url]);
    vi.setSystemTime(new Date('2026-10-23T10:07:00Z'));
    await runCron('2-59/5 * * * *');
    expect(telegram).toEqual([]);
    vi.setSystemTime(new Date('2026-10-23T10:12:00Z'));
    await runCron('2-59/5 * * * *');
    expect(telegram).toEqual([`[monitor] 🔴 ${target.name} (HTTP 503)`]);
    failing = new Set();
    vi.setSystemTime(new Date('2026-10-23T10:17:00Z'));
    await runCron('2-59/5 * * * *');
    expect(telegram[1]).toBe(`[monitor] ✅ ${target.name} recovered (down 5m)`);
  });

  it('keeps an undelivered alert queued until Telegram accepts it', async () => {
    const target = targetsForShard(TARGETS, 1, SHARDS).find((t) => !t.sleeps)!;
    failing = new Set([target.url]);
    telegramUp = false;
    for (const minute of ['07', '12']) {
      vi.setSystemTime(new Date(`2026-10-23T10:${minute}:00Z`));
      await runCron('2-59/5 * * * *');
    }
    expect(JSON.parse(kv.store.get('state:1')!).pendingAlerts).toEqual([`🔴 ${target.name} (HTTP 503)`]);
    telegramUp = true;
    vi.setSystemTime(new Date('2026-10-23T10:17:00Z'));
    await runCron('2-59/5 * * * *');
    expect(telegram).toEqual([`[monitor] 🔴 ${target.name} (HTTP 503)`]);
    expect(JSON.parse(kv.store.get('state:1')!).pendingAlerts).toEqual([]);
  });

  it('on shard 0, alerts once for a heartbeat that never reported and delivers parked alerts', async () => {
    vi.setSystemTime(new Date('2026-10-23T10:07:00Z'));
    for (const h of HEARTBEATS) {
      if (h.job !== 'db-backup') await kv.put(`hb:${h.job}`, JSON.stringify({ at: '2026-10-23T10:00:00Z', ok: true }));
    }
    await kv.put('hbalert:tma:1:a', '🔴 db-backup-tma run failed');
    await runCron('*/5 * * * *');
    expect(telegram).toEqual([
      '[monitor] ⏰ db-backup has not reported for over 26h (never)',
      '[monitor] 🔴 db-backup-tma run failed',
    ]);
    expect(kv.store.has('hbstale:db-backup')).toBe(true);
    expect(kv.store.has('hbalert:tma:1:a')).toBe(false);

    vi.setSystemTime(new Date('2026-10-23T10:12:00Z'));
    await runCron('*/5 * * * *');
    expect(telegram.length).toBe(2);
  });
});

describe('with SENTRY_DSN set (real @sentry/cloudflare wrapper)', () => {
  it('still serves /status and the heartbeat route unchanged', async () => {
    const env = makeEnv({ SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1' });
    const status = (await (await call(request('/status'), env)).json()) as { results: unknown[] };
    expect(status.results.length).toBe(TARGETS.filter((t) => t.group === 'own').length);
    const res = await call(
      request('/heartbeat/db-backup', { method: 'POST', headers: bearer(HEARTBEAT_TOKEN), body: '{"ok":true}' }),
      env,
    );
    expect(await res.json()).toEqual({ recorded: true });
    expect(probed.filter((u) => u.includes('sentry.io'))).toEqual([]);
  });
});
