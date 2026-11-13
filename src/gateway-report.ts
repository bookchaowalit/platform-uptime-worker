// Daily edge gateway report (platform-api-gateway SPEC-003 observability): requests per route over
// the last 24 h by status class, from Cloudflare's HTTP analytics of gateway.bookchaowalit.com, sent
// to Telegram once a day. A read-only Analytics token (GATEWAY_REPORT_CF_TOKEN, Infisical
// /cloudflare) is the only credential; paths are reduced to their route (/v1/<system>), so no path
// tail, query or token ever reaches the message.

export const GATEWAY_HOST = 'gateway.bookchaowalit.com';
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const ROUTE = /^\/v1\/([a-z][a-z0-9-]{1,62})(?:\/|$)/;
export const REPORT_HOUR_UTC = 1; // 08:00 Asia/Bangkok
// Its own cron (wrangler.toml), so the report never spends a probe shard's 50-subrequest budget.
export const REPORT_CRON = '*/10 1 * * *'; // every 10 min in the report hour: a failed run retries, KV keeps it daily
export const MAX_GROUPS = 10000;
/** Characters of route lines in one report; head, the cap note and the [monitor] prefix stay under 4 096. */
export const BODY_MAX = 3300;
const ALERT_5XX_SHARE = 0.02;
const ALERT_5XX_MIN = 5;

export interface ReportEnv {
  MONITOR_KV: KVNamespace;
  GATEWAY_REPORT_CF_TOKEN?: string;
  GATEWAY_REPORT_ZONE_ID?: string;
}

export interface RouteCounts { total: number; ok: number; s401: number; s403: number; s429: number; s4xx: number; s5xx: number }
type Row = { count: number; dimensions: { edgeResponseStatus: number; clientRequestPath: string } };

export function routeOf(path: string): string {
  const match = ROUTE.exec(path);
  return match ? match[1] : '(other)';
}

export function aggregate(rows: Row[]): Map<string, RouteCounts> {
  const out = new Map<string, RouteCounts>();
  for (const row of rows) {
    const route = routeOf(row.dimensions.clientRequestPath || '/');
    const c = out.get(route) ?? { total: 0, ok: 0, s401: 0, s403: 0, s429: 0, s4xx: 0, s5xx: 0 };
    const status = row.dimensions.edgeResponseStatus;
    c.total += row.count;
    if (status < 400) c.ok += row.count;
    else if (status === 401) c.s401 += row.count;
    else if (status === 403) c.s403 += row.count;
    else if (status === 429) c.s429 += row.count;
    else if (status < 500) c.s4xx += row.count;
    else c.s5xx += row.count;
    out.set(route, c);
  }
  return out;
}

export function format(day: string, counts: Map<string, RouteCounts>, truncated = false): { text: string; alert: boolean } {
  let total = 0, errors5 = 0;
  const lines: string[] = [];
  const routes = [...counts.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [route, c] of routes) {
    total += c.total; errors5 += c.s5xx;
    const bad = c.s401 + c.s403 + c.s429 + c.s4xx + c.s5xx;
    if (!bad) continue;
    const parts = [c.s401 && `401×${c.s401}`, c.s403 && `403×${c.s403}`, c.s429 && `429×${c.s429}`,
      c.s4xx && `4xx×${c.s4xx}`, c.s5xx && `5xx×${c.s5xx}`].filter(Boolean);
    lines.push(`${route}: ${c.ok}/${c.total} ok · ${parts.join(' ')}`);
  }
  const alert = errors5 >= ALERT_5XX_MIN && total > 0 && errors5 / total > ALERT_5XX_SHARE;
  const head = `${alert ? '🔴 ALERT ' : ''}gateway ${day} (24 h): ${total} requests, 5xx ${errors5}` +
    ` (${total ? ((errors5 / total) * 100).toFixed(1) : '0.0'}%), ${counts.size} routes`;
  const shown: string[] = [];
  let size = 0;
  for (const line of lines.slice(0, 30)) {  // also by length, so head and note always fit one message
    if (size + line.length + 1 > BODY_MAX) break;
    shown.push(line);
    size += line.length + 1;
  }
  if (shown.length < lines.length) shown.push(`… ${lines.length - shown.length} more routes`);
  const body = lines.length ? shown.join('\n') : 'every route answered without errors';
  // At the group cap the counts are a lower bound: say so instead of reporting a quiet day.
  const note = truncated ? `\n⚠ incomplete: ${MAX_GROUPS} analytics groups returned (cap), counts are a lower bound` : '';
  return { text: `${head}\n${body}${note}`, alert: alert || truncated };
}

export async function fetchRows(env: ReportEnv, since: Date, until: Date, fetchImpl: typeof fetch = fetch): Promise<Row[]> {
  const query = `query($z:String!,$s:Time!,$u:Time!){ viewer { zones(filter:{zoneTag:$z}) {
    httpRequestsAdaptiveGroups(limit:${MAX_GROUPS}, filter:{datetime_geq:$s, datetime_lt:$u, clientRequestHTTPHost:"${GATEWAY_HOST}"})
    { count dimensions { edgeResponseStatus clientRequestPath } } } } }`;
  const response = await fetchImpl(GRAPHQL, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${env.GATEWAY_REPORT_CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { z: env.GATEWAY_REPORT_ZONE_ID, s: since.toISOString(), u: until.toISOString() } }),
  });
  if (!response.ok) throw new Error(`analytics answered ${response.status}`);
  const data = (await response.json()) as { errors?: unknown[]; data?: { viewer: { zones: { httpRequestsAdaptiveGroups: Row[] }[] } } };
  if (data.errors?.length || !data.data) throw new Error('analytics query failed');
  const zone = data.data.viewer.zones[0];
  if (!zone) throw new Error('analytics zone not found'); // a wrong zone id or token scope, not "no traffic"
  return zone.httpRequestsAdaptiveGroups ?? [];
}

/** Sends the report at most once per UTC day, in the report hour; returns what happened. */
export async function maybeGatewayReport(env: ReportEnv, now: Date, send: (text: string) => Promise<boolean>,
  fetchImpl: typeof fetch = fetch): Promise<'skipped' | 'not_configured' | 'sent' | 'failed'> {
  if (now.getUTCHours() !== REPORT_HOUR_UTC) return 'skipped';
  if (!env.GATEWAY_REPORT_CF_TOKEN || !env.GATEWAY_REPORT_ZONE_ID) return 'not_configured';
  const day = now.toISOString().slice(0, 10);
  const key = `gwreport:${day}`;
  if (await env.MONITOR_KV.get(key)) return 'skipped';
  try {
    const rows = await fetchRows(env, new Date(now.getTime() - 24 * 3600_000), now, fetchImpl);
    const { text } = format(day, aggregate(rows), rows.length >= MAX_GROUPS);
    if (!(await send(text))) return 'failed';
    await env.MONITOR_KV.put(key, '1', { expirationTtl: 3 * 86400 });
    return 'sent';
  } catch (error) {
    console.error('gateway report failed', error instanceof Error ? error.message : error);
    return 'failed';
  }
}
