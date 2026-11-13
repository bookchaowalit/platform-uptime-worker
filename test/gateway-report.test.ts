import { describe, expect, it } from 'vitest';
import { aggregate, format, maybeGatewayReport, routeOf } from '../src/gateway-report';

const row = (status: number, path: string, count = 1) => ({ count, dimensions: { edgeResponseStatus: status, clientRequestPath: path } });

function kv() {
  const store = new Map<string, string>();
  return { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); }, store } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('gateway report', () => {
  it('fits one Telegram message even with long route names and the cap note', () => {
    const many = Array.from({ length: 40 }, (_, n) => [row(401, `/v1/${'r'.repeat(58)}${String(n).padStart(2, '0')}/x`), row(403, `/v1/${'r'.repeat(58)}${String(n).padStart(2, '0')}/x`),
      row(429, `/v1/${'r'.repeat(58)}${String(n).padStart(2, '0')}/x`), row(503, `/v1/${'r'.repeat(58)}${String(n).padStart(2, '0')}/x`)]).flat();
    const { text } = format('2026-11-12', aggregate(many), true);
    expect(`[monitor] ${text}`.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('incomplete');
    expect(text).toMatch(/… \d+ more routes/);
  });

  it('reduces paths to their route and never keeps the tail', () => {
    expect(routeOf('/v1/crm-income/api/v1/crm/agency/workspace?x=secret')).toBe('crm-income');
    expect(routeOf('/v1/knowledge')).toBe('knowledge');
    expect(routeOf('/favicon.ico')).toBe('(other)');
  });

  it('counts status classes per route and lists only routes with errors', () => {
    const counts = aggregate([row(200, '/v1/habits/v1/habits', 10), row(401, '/v1/crm/x', 2), row(429, '/v1/crm/y'),
      row(504, '/v1/finance-api/v1/overview', 3), row(200, '/v1/crm/z', 5)]);
    expect(counts.get('crm')).toMatchObject({ total: 8, ok: 5, s401: 2, s429: 1 });
    const { text, alert } = format('2026-11-12', counts);
    expect(text).toContain('crm: 5/8 ok · 401×2 429×1');
    expect(text).toContain('finance-api: 0/3 ok · 5xx×3');
    expect(text).not.toContain('habits:');
    expect(alert).toBe(false); // 3 server errors stay under the alert floor
  });

  it('alerts on a real 5xx share', () => {
    const { text, alert } = format('d', aggregate([row(502, '/v1/tasks/x', 20), row(200, '/v1/tasks/y', 100)]));
    expect(alert).toBe(true);
    expect(text.startsWith('🔴 ALERT')).toBe(true);
  });

  it('runs once a day in the report hour, only when configured', async () => {
    const env = { MONITOR_KV: kv(), GATEWAY_REPORT_CF_TOKEN: 't', GATEWAY_REPORT_ZONE_ID: 'z' };
    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); return true; };
    const fetchImpl = (async () => Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [row(200, '/v1/habits/x', 4)] }] } } })) as typeof fetch;
    expect(await maybeGatewayReport(env, new Date('2026-11-12T05:00:00Z'), send, fetchImpl)).toBe('skipped');
    expect(await maybeGatewayReport({ MONITOR_KV: kv() }, new Date('2026-11-12T01:00:00Z'), send, fetchImpl)).toBe('not_configured');
    expect(await maybeGatewayReport(env, new Date('2026-11-12T01:00:00Z'), send, fetchImpl)).toBe('sent');
    expect(await maybeGatewayReport(env, new Date('2026-11-12T01:05:00Z'), send, fetchImpl)).toBe('skipped');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('gateway 2026-11-12 (24 h): 4 requests');
  });

  it('a failed analytics call is reported as failed and retried next tick', async () => {
    const env = { MONITOR_KV: kv(), GATEWAY_REPORT_CF_TOKEN: 't', GATEWAY_REPORT_ZONE_ID: 'z' };
    const down = (async () => new Response('no', { status: 500 })) as typeof fetch;
    expect(await maybeGatewayReport(env, new Date('2026-11-12T01:00:00Z'), async () => true, down)).toBe('failed');
    expect((env.MONITOR_KV as unknown as { store: Map<string, string> }).store.size).toBe(0);
  });

  it('flags a capped result and refuses a missing zone', async () => {
    const many = Array.from({ length: 10000 }, (_, i) => row(200, `/v1/r${i % 3}x/a`));
    const { text, alert } = format('d', aggregate(many), true);
    expect(text).toContain('incomplete');
    expect(alert).toBe(true);
    const env = { MONITOR_KV: kv(), GATEWAY_REPORT_CF_TOKEN: 't', GATEWAY_REPORT_ZONE_ID: 'z' };
    const noZone = (async () => Response.json({ data: { viewer: { zones: [] } } })) as typeof fetch;
    expect(await maybeGatewayReport(env, new Date('2026-11-12T01:00:00Z'), async () => true, noZone)).toBe('failed');
  });
});

