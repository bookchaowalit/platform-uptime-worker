// SPEC-003: daily sweep of the static sites (src/static-sites.ts, generated from the solo-empire
// coverage registry). Runs on a GitHub-hosted runner (scripts/static-sweep.ts); not bundled into
// the Worker. No imports, so Node can run it straight from TypeScript.

const SITE_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const MAX_LISTED = 20;
const DEFAULT_HEARTBEAT = 'https://monitor.bookchaowalit.com/heartbeat/static-sweep';

export interface SweepEnv {
  HEARTBEAT_URL?: string;
  HEARTBEAT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface SiteResult {
  url: string;
  status: number; // 0 = network error or timeout
  up: boolean;
}

async function once(url: string, method: string, fetchFn: typeof fetch): Promise<number> {
  const res = await fetchFn(url, {
    method,
    redirect: 'follow',
    headers: { 'user-agent': 'bookchaowalit-static-sweep/1 (+https://monitor.bookchaowalit.com/)' },
    signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
  });
  // Release the body before the pool starts the next site: only the status matters here.
  await res.body?.cancel().catch(() => {});
  return res.status;
}

/** AC-01: HEAD, GET on 403/405/501, one retry on a network error; below 400 is up. */
export async function checkSite(url: string, fetchFn: typeof fetch): Promise<SiteResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let status = await once(url, 'HEAD', fetchFn);
      if (status === 403 || status === 405 || status === 501) status = await once(url, 'GET', fetchFn);
      return { url, status, up: status < 400 };
    } catch {
      // network error or timeout: retry once
    }
  }
  return { url, status: 0, up: false };
}

/** AC-05: run `fn` over `items` with at most `limit` in flight, keeping input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface SweepDeps {
  sites: string[];
  env: SweepEnv;
  fetch: typeof fetch;
  log: (line: string) => void;
}

/** One sweep. Returns the exit code: 0 all up and recorded, 1 otherwise. */
export async function runSweep({ sites, env, fetch: fetchFn, log }: SweepDeps): Promise<number> {
  const results = await pool(sites, CONCURRENCY, (u) => checkSite(u, fetchFn));
  const down = results.filter((r) => !r.up);
  log(`checked ${results.length} sites, ${down.length} down`);
  let code = 0;
  if (down.length) {
    code = 1;
    const lines = down.slice(0, MAX_LISTED).map((r) => `${r.status || 'ERR'} ${r.url}`);
    if (down.length > MAX_LISTED) lines.push(`+${down.length - MAX_LISTED} more`);
    const text = `[static-sweep] 🔴 ${down.length} of ${results.length} sites down:\n${lines.join('\n')}`;
    for (const l of lines) log(`down: ${l}`);
    const sent = await sendTelegram(env, text, fetchFn);
    log(sent ? 'telegram: sent' : 'telegram: NOT sent (failed or not configured)');
  }
  const token = env.HEARTBEAT_TOKEN?.trim();
  if (!token) {
    log('heartbeat: HEARTBEAT_TOKEN missing, not recorded');
    return 1;
  }
  try {
    const res = await fetchFn(env.HEARTBEAT_URL?.trim() || DEFAULT_HEARTBEAT, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(down.length ? { ok: false, failed: down.length, sites: results.length } : { ok: true, sites: results.length }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    log(res.ok ? 'heartbeat: recorded' : `heartbeat: HTTP ${res.status}, not recorded`);
    if (!res.ok) return 1;
  } catch (err) {
    log(`heartbeat: ${err instanceof Error ? err.name : 'unknown error'}, not recorded`);
    return 1;
  }
  return code;
}

async function sendTelegram(env: SweepEnv, text: string, fetchFn: typeof fetch): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // The error message can contain the request URL, which holds the bot token: never log it.
    return false;
  }
}
