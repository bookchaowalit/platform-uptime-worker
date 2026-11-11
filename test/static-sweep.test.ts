import { describe, expect, it } from 'vitest';
import { checkSite, runSweep, type SweepEnv } from '../src/static-sweep';
import { STATIC_SITES } from '../src/static-sites';
import { HEARTBEATS } from '../src/targets';

// SPEC-003: daily sweep of the static sites.

type Call = { url: string; method: string; body?: string };

function fakeFetch(answer: (url: string, method: string) => number | 'error', calls: Call[] = [], inflight = { now: 0, max: 0 }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    inflight.now++;
    inflight.max = Math.max(inflight.max, inflight.now);
    await new Promise((r) => setTimeout(r, 1));
    inflight.now--;
    const a = answer(url, method);
    if (a === 'error') throw new TypeError('fetch failed');
    return new Response(null, { status: a });
  }) as typeof fetch;
}

const env: SweepEnv = { HEARTBEAT_TOKEN: 'hb', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1' };

describe('SPEC-003 static sweep', () => {
  it('AC-01 HEAD below 400 is up; 405 falls back to GET; 404 is down', async () => {
    expect(await checkSite('https://a/', fakeFetch(() => 200))).toEqual({ url: 'https://a/', status: 200, up: true });
    const calls: Call[] = [];
    const r = await checkSite('https://b/', fakeFetch((_, m) => (m === 'HEAD' ? 405 : 200), calls));
    expect(r.up).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    expect((await checkSite('https://c/', fakeFetch(() => 404))).up).toBe(false);
  });

  it('AC-01 a network error is retried once, then reported as down', async () => {
    let n = 0;
    const flaky = fakeFetch(() => (n++ === 0 ? 'error' : 200));
    expect((await checkSite('https://d/', flaky)).up).toBe(true);
    const r = await checkSite('https://e/', fakeFetch(() => 'error'));
    expect(r).toMatchObject({ up: false, status: 0 });
  });

  it('AC-02 all up: heartbeat ok, no Telegram message, exit 0', async () => {
    const calls: Call[] = [];
    const code = await runSweep({ sites: ['https://a/', 'https://b/'], env, fetch: fakeFetch(() => 200, calls), log: () => {} });
    expect(code).toBe(0);
    expect(calls.some((c) => c.url.includes('api.telegram.org'))).toBe(false);
    const hb = calls.find((c) => c.url.endsWith('/heartbeat/static-sweep'))!;
    expect(JSON.parse(hb.body!)).toMatchObject({ ok: true, sites: 2 });
  });

  it('AC-03 some down: one Telegram message listing them, heartbeat not ok, exit 1', async () => {
    const calls: Call[] = [];
    const sites = Array.from({ length: 25 }, (_, i) => `https://s${i}/`);
    const code = await runSweep({ sites, env, fetch: fakeFetch((u) => (u.includes('api.telegram.org') || u.includes('heartbeat') ? 200 : 503), calls), log: () => {} });
    expect(code).toBe(1);
    const tg = calls.filter((c) => c.url.includes('api.telegram.org'));
    expect(tg).toHaveLength(1);
    const text = JSON.parse(tg[0].body!).text as string;
    expect(text).toContain('[static-sweep]');
    expect(text).toContain('25 of 25');
    expect(text).toContain('+5 more');
    const hb = calls.find((c) => c.url.endsWith('/heartbeat/static-sweep'))!;
    expect(JSON.parse(hb.body!)).toMatchObject({ ok: false, failed: 25 });
  });

  it('AC-04 the generated list is unique https URLs ending in a slash', () => {
    expect(STATIC_SITES.length).toBeGreaterThan(0);
    expect(new Set(STATIC_SITES).size).toBe(STATIC_SITES.length);
    for (const u of STATIC_SITES) expect(u).toMatch(/^https:\/\/[^/]+.*\/$/);
  });

  it('AC-05 never has more than 8 requests in flight', async () => {
    const inflight = { now: 0, max: 0 };
    const sites = Array.from({ length: 30 }, (_, i) => `https://p${i}/`);
    await runSweep({ sites, env: {}, fetch: fakeFetch(() => 200, [], inflight), log: () => {} });
    expect(inflight.max).toBeLessThanOrEqual(8);
  });

  it('AC-06 the Worker watches the sweep heartbeat with a 26 h window', () => {
    expect(HEARTBEATS.find((h) => h.job === 'static-sweep')?.maxAgeHours).toBe(26);
  });

  it('without a heartbeat token the run fails so the gap is visible', async () => {
    expect(await runSweep({ sites: ['https://a/'], env: {}, fetch: fakeFetch(() => 200), log: () => {} })).toBe(1);
  });
  it('a rejected or unreachable heartbeat fails the run', async () => {
    const rejected = fakeFetch((u) => (u.includes('heartbeat') ? 500 : 200));
    expect(await runSweep({ sites: ['https://a/'], env, fetch: rejected, log: () => {} })).toBe(1);
    const unreachable = fakeFetch((u) => (u.includes('heartbeat') ? 'error' : 200));
    expect(await runSweep({ sites: ['https://a/'], env, fetch: unreachable, log: () => {} })).toBe(1);
  });

  it('a failing Telegram call is logged, never thrown', async () => {
    const lines: string[] = [];
    const f = fakeFetch((u) => (u.includes('api.telegram.org') ? 'error' : u.includes('heartbeat') ? 200 : 500));
    expect(await runSweep({ sites: ['https://a/'], env, fetch: f, log: (l) => lines.push(l) })).toBe(1);
    expect(lines.some((l) => l.includes('NOT sent'))).toBe(true);
    expect(lines.join('\n')).not.toContain('tg');
  });
});

