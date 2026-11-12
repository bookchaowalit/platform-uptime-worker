// SPEC-002: the public, customer-facing status page served at `/`.
// The page fetches the public `/status` JSON (edge-cached, own targets only) and groups the
// internal service names into the products a customer knows. The grouping rules live here once and
// are serialised into the page, so the browser and the unit tests use the same rules.

export interface PublicResult {
  name: string;
  status: string; // 'up' | 'down' | 'unknown'
  stale?: boolean;
  latency?: number;
  checkedAt?: string;
}

export type State = 'up' | 'degraded' | 'down';

export interface GroupDef {
  id: string;
  th: string;
  en: string;
  /** Regular expressions (source strings) matched against the target name, in order. */
  match: string[];
}

// Order is the display order. The first group whose pattern matches wins; `platform` is the fallback.
export const GROUPS: GroupDef[] = [
  { id: 'life', th: 'ชีวิตประจำวัน', en: 'Life OS',
    match: ['^(tasks|goals|habits|decisions|diary|health|time|learning|projects|roles-skills|operating)-api$', '^checkin-worker$', '^tracking\\.'] },
  { id: 'finance', th: 'การเงิน', en: 'Finance suite',
    match: ['^finance-', '^(transactions|budgets|cash-flow|reconciliations|business-assets|investments|liabilities|subscriptions|tax)-api$'] },
  { id: 'crm', th: 'CRM และงานขาย', en: 'CRM & sales',
    match: ['^crm-api', '^(offers|opportunities|radar)-api$', '^book-job-data-api$'] },
  { id: 'ai', th: 'AI', en: 'AI', match: ['^ai-', '^mcp-remote$', '^meeting-minutes'] },
  { id: 'data', th: 'ข้อมูลและความรู้', en: 'Data & knowledge',
    match: ['^(knowledge|intake|content|saas-catalog|integrations|data)-api$', '^jobs-worker$', '^meta-capture$'] },
  { id: 'platform', th: 'บริการกลาง', en: 'Platform services', match: [] },
  { id: 'web', th: 'เว็บไซต์', en: 'Websites', match: ['\\.com$', '^awesome-web$'] },
];

const COMPILED = GROUPS.map((g) => ({ id: g.id, res: g.match.map((m) => new RegExp(m)) }));

export function productFor(name: string): string {
  for (const g of COMPILED) if (g.res.some((re) => re.test(name))) return g.id;
  return 'platform';
}

export function resultState(r: PublicResult): State {
  if (r.status === 'down') return 'down';
  if (r.status !== 'up' || r.stale) return 'degraded';
  return 'up';
}

export function groupState(results: PublicResult[]): State {
  const states = results.map(resultState);
  if (states.includes('down')) return 'down';
  if (states.includes('degraded')) return 'degraded';
  return 'up';
}

export function groupResults(results: PublicResult[]): Array<GroupDef & { results: PublicResult[]; state: State }> {
  return GROUPS.map((g) => {
    const members = results.filter((r) => productFor(r.name) === g.id);
    return { ...g, results: members, state: groupState(members) };
  }).filter((g) => g.results.length > 0);
}

const VERDICT: Record<State, { th: string; en: string }> = {
  up: { th: 'ทุกระบบทำงานปกติ', en: 'All systems operational' },
  degraded: { th: 'บางระบบยังไม่มีข้อมูลล่าสุด หรือกำลังตรวจสอบ', en: 'Some systems have no recent data' },
  down: { th: 'มีบางระบบขัดข้อง', en: 'Some systems are down' },
};

export function overallVerdict(results: PublicResult[]): { state: State; th: string; en: string } {
  const state: State = results.length === 0 ? 'degraded' : groupState(results);
  return { state, ...VERDICT[state] };
}

// ------------------------------------------------------------------ page
// Browser copy of productFor/groupState/overallVerdict: same logic, fed by the serialised GROUPS.
const BROWSER_SCRIPT = `
const GROUPS = ${JSON.stringify(GROUPS)};
const VERDICT = ${JSON.stringify(VERDICT)};
const LABEL = { up: 'ปกติ · Up', degraded: 'ไม่มีข้อมูลล่าสุด · No recent data', down: 'ขัดข้อง · Down' };
const res = GROUPS.map(g => ({ id: g.id, res: g.match.map(m => new RegExp(m)) }));
const productFor = n => (res.find(g => g.res.some(r => r.test(n))) || { id: 'platform' }).id;
const st = r => r.status === 'down' ? 'down' : (r.status !== 'up' || r.stale) ? 'degraded' : 'up';
const worst = a => a.includes('down') ? 'down' : a.includes('degraded') ? 'degraded' : 'up';
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function render(data) {
  const results = Array.isArray(data.results) ? data.results : [];
  const overall = results.length ? worst(results.map(st)) : 'degraded';
  const v = document.getElementById('verdict');
  v.className = 'verdict ' + overall;
  v.textContent = VERDICT[overall].th + ' · ' + VERDICT[overall].en;
  const when = data.timestamp ? new Date(data.timestamp) : null;
  document.getElementById('updated').textContent = when
    ? 'อัปเดตล่าสุด ' + when.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const box = document.getElementById('groups');
  // Keep what the viewer opened, and their keyboard focus, across the 60 s refresh.
  const openGroups = new Set([...box.querySelectorAll('section[data-group] details[open]')].map(d => d.closest('section').dataset.group));
  const focusedGroup = box.contains(document.activeElement) ? document.activeElement.closest('section[data-group]')?.dataset.group : null;
  box.replaceChildren();
  for (const g of GROUPS) {
    const members = results.filter(r => productFor(r.name) === g.id);
    if (!members.length) continue;
    const gs = worst(members.map(st));
    const sec = el('section', 'group ' + gs);
    const h = el('h2', null, g.th);
    if (g.en !== g.th) h.append(el('span', 'en', g.en));
    const badge = el('span', 'badge ' + gs, LABEL[gs]);
    const head = el('div', 'group-head'); head.append(h, badge); sec.append(head);
    sec.dataset.group = g.id;
    const det = el('details'); det.open = openGroups.has(g.id);
    const sum = el('summary', null, 'บริการ ' + members.length + ' รายการ · ' + members.length + ' services'); det.append(sum);
    const ul = el('ul');
    for (const m of members) {
      const s = st(m);
      const li = el('li', 'svc ' + s);
      li.append(el('span', 'svc-name', m.name), el('span', 'svc-state', LABEL[s] + (m.latency != null && s === 'up' ? ' · ' + m.latency + ' ms' : '')));
      ul.append(li);
    }
    det.append(ul); sec.append(det); box.append(sec);
    if (focusedGroup === g.id) sum.focus({ preventScroll: true });
  }
}
function load() {
  fetch('/status', { headers: { accept: 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(render)
    .catch(() => { const v = document.getElementById('verdict'); v.className = 'verdict degraded'; v.textContent = 'โหลดสถานะไม่สำเร็จ ลองใหม่อีกครั้ง · Could not load status'; });
}
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
`;

const STYLE = `
:root { --bg:#ffffff; --fg:#1a1a1a; --muted:#4a4a4a; --card:#f6f7f9; --border:#d0d4da;
  --up:#1b6b34; --up-bg:#e6f4ea; --deg:#7a5200; --deg-bg:#fff4d6; --down:#a1141b; --down-bg:#fde8e8; --focus:#1a56db; }
@media (prefers-color-scheme: dark) { :root { --bg:#121417; --fg:#eceef1; --muted:#b8bec7; --card:#1c1f24; --border:#3a3f47;
  --up:#7fd99a; --up-bg:#15301f; --deg:#f2c766; --deg-bg:#33280e; --down:#ff9a9e; --down-bg:#3a1517; --focus:#8ab4ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.7 "Noto Sans Thai","Sarabun",system-ui,-apple-system,sans-serif; }
main { max-width:860px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:1.6rem; line-height:1.4; margin:0 0 4px; }
h2 { font-size:1.1rem; line-height:1.5; margin:0; }
.en { display:block; font-size:.85rem; font-weight:400; color:var(--muted); }
.sub, #updated { color:var(--muted); margin:0 0 16px; }
.verdict { padding:16px; border-radius:10px; border:2px solid var(--border); font-weight:600; margin:16px 0; }
.verdict.up { background:var(--up-bg); color:var(--up); border-color:var(--up); }
.verdict.degraded { background:var(--deg-bg); color:var(--deg); border-color:var(--deg); }
.verdict.down { background:var(--down-bg); color:var(--down); border-color:var(--down); }
.group { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 16px; margin:12px 0; }
.group-head { display:flex; flex-wrap:wrap; gap:8px; justify-content:space-between; align-items:center; }
.badge { font-size:.9rem; font-weight:600; padding:2px 10px; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
.badge.up, .svc.up .svc-state { color:var(--up); } .badge.degraded, .svc.degraded .svc-state { color:var(--deg); } .badge.down, .svc.down .svc-state { color:var(--down); }
details { margin-top:8px; } summary { cursor:pointer; color:var(--muted); min-height:24px; }
ul { list-style:none; padding:0; margin:8px 0 0; }
.svc { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px 12px; padding:6px 0; border-top:1px solid var(--border); }
.svc-name { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9rem; overflow-wrap:anywhere; }
a { color:var(--focus); } :focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
footer { color:var(--muted); font-size:.9rem; margin-top:32px; }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; scroll-behavior:auto !important; } }
`;

export const STATUS_PAGE = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>สถานะระบบ · bookchaowalit status</title>
  <meta name="description" content="สถานะการทำงานของบริการ bookchaowalit ทั้งหมด อัปเดตทุก 5 นาที">
  <meta name="color-scheme" content="light dark">
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>สถานะระบบ <span class="en">bookchaowalit status</span></h1>
    <p class="sub">ตรวจทุกบริการทุก 5 นาที (บริการที่หลับเมื่อไม่มีคนใช้ ตรวจทุกชั่วโมง)</p>
    <div id="verdict" class="verdict degraded" role="status" aria-live="polite">กำลังโหลดสถานะ… · Loading…</div>
    <p id="updated"></p>
    <noscript><p>หน้านี้ต้องใช้ JavaScript ดูข้อมูลดิบได้ที่ <a href="/status">/status</a> (JSON) · This page needs JavaScript; raw data at <a href="/status">/status</a>.</p></noscript>
    <div id="groups"></div>
    <footer>ข้อมูลดิบ <a href="/status">/status</a> · <a href="https://bookchaowalit.com">bookchaowalit.com</a></footer>
  </main>
  <script>${BROWSER_SCRIPT}</script>
</body>
</html>`;

export const STATUS_PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=60',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
