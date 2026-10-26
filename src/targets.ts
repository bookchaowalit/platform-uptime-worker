// Everything the monitor checks. `group` decides visibility: only `own` targets appear on the
// public /status page; `client` targets are checked and alerted on but shown only with the token.
// Happy Teeth is deliberately absent (owner decision: that org's systems are not ours to touch).
// Keep each URL pointed at a cheap health endpoint, never at a page that does real work.

export interface Target {
  name: string;
  url: string;
  group: 'own' | 'client';
  /** Railway "sleep when idle" service: probed hourly so the monitor does not keep it awake. */
  sleeps?: boolean;
}

export interface HeartbeatSpec {
  job: string;
  maxAgeHours: number;
}

const railway = (host: string, path = '/health') => `https://${host}.up.railway.app${path}`;

// Services with Railway sleepApplication (serverless) in their .railway/railway.ts. Railway puts a
// service to sleep after about 10 minutes without traffic; a probe every 5 minutes would keep all
// of them awake (and billed) around the clock. They are probed once an hour instead: a check wakes
// the service, which then sleeps again.
const SLEEPS = new Set([
  'finance-accounts-api', 'transactions-api', 'budgets-api', 'cash-flow-api', 'reconciliations-api',
  'business-assets-api', 'investments-api', 'liabilities-api', 'subscriptions-api', 'tax-api',
  'goals-api', 'habits-api', 'decisions-api', 'diary-api', 'health-api', 'time-api',
  'roles-skills-api', 'operating-api', 'opportunities-api', 'learning-api', 'projects-api',
  'content-api', 'radar-api', 'accounts-api', 'accounts-metadata-api', 'automation-api',
  'intake-api', 'notifications-api', 'integrations-api', 'knowledge-api', 'saas-catalog-api',
]);

const ALL_TARGETS: Target[] = [
  // Platform
  { name: 'tasks-api', url: railway('tasks-api-production-4785'), group: 'own' },
  { name: 'identity-api', url: railway('identity-api-production-fad1'), group: 'own' },
  { name: 'ai-gateway', url: 'https://api.bookchaowalit.com/healthz', group: 'own' },
  { name: 'checkin-worker', url: 'https://solo-empire-checkin.bookchaowalit.workers.dev/health', group: 'own' },
  // Signed inbound webhooks (platform-webhooks-worker, Stripe receiver; live 2026-10-23).
  { name: 'hooks-worker', url: 'https://hooks.bookchaowalit.com/healthz', group: 'own' },
  // Remote MCP tool hub (platform-mcp-remote-worker).
  { name: 'mcp-remote', url: 'https://solo-empire-mcp-remote.bookchaowalit.workers.dev/healthz', group: 'own' },
  { name: 'accounts-api', url: railway('accounts-api-production-cfee'), group: 'own' },
  { name: 'accounts-metadata-api', url: railway('accounts-metadata-api-production'), group: 'own' },
  { name: 'automation-api', url: railway('automation-api-production-af8e'), group: 'own' },
  { name: 'intake-api', url: railway('intake-api-production'), group: 'own' },
  { name: 'notifications-api', url: railway('notifications-api-production-c9d8'), group: 'own' },
  { name: 'integrations-api', url: railway('solo-integrations-production'), group: 'own' },
  { name: 'saas-catalog-api', url: railway('solo-saas-catalog-production'), group: 'own' },
  { name: 'knowledge-api', url: railway('solo-knowledge-api-production'), group: 'own' },
  // empire-mcp is left out until it is deployed: the Railway service exists but has never
  // run (platform-empire docs/runbooks/remote-mcp.md), so its domain answers "Application not found".
  { name: 'ai-usage-display', url: railway('ai-usage-display-production'), group: 'own' },
  // Finance
  { name: 'finance-accounts-api', url: railway('finance-accounts-api-production'), group: 'own' },
  { name: 'transactions-api', url: railway('transactions-api-production-4078'), group: 'own' },
  { name: 'budgets-api', url: railway('budgets-api-production-690e'), group: 'own' },
  { name: 'cash-flow-api', url: railway('cash-flow-api-production'), group: 'own' },
  { name: 'reconciliations-api', url: railway('reconciliations-api-production'), group: 'own' },
  { name: 'business-assets-api', url: railway('business-assets-api-production'), group: 'own' },
  { name: 'investments-api', url: railway('investments-api-production'), group: 'own' },
  { name: 'liabilities-api', url: railway('liabilities-api-production'), group: 'own' },
  { name: 'subscriptions-api', url: railway('subscriptions-api-production-b1d4'), group: 'own' },
  { name: 'tax-api', url: railway('tax-api-production-57f6'), group: 'own' },
  // Life
  { name: 'goals-api', url: railway('goals-api-production-c16e'), group: 'own' },
  { name: 'habits-api', url: railway('habits-api-production-e516'), group: 'own' },
  { name: 'decisions-api', url: railway('decisions-api-production-1ef5'), group: 'own' },
  { name: 'diary-api', url: railway('diary-api-production-2db8'), group: 'own' },
  { name: 'health-api', url: railway('health-api-production-c72f'), group: 'own' },
  { name: 'time-api', url: railway('time-api-production-2050'), group: 'own' },
  { name: 'roles-skills-api', url: railway('roles-skills-api-production'), group: 'own' },
  { name: 'operating-api', url: railway('operating-api-production'), group: 'own' },
  { name: 'opportunities-api', url: railway('opportunities-api-production'), group: 'own' },
  { name: 'learning-api', url: railway('learning-api-production-3cee'), group: 'own' },
  { name: 'projects-api', url: railway('projects-api-production-f4eb'), group: 'own' },
  { name: 'content-api', url: railway('content-api-production-bca7'), group: 'own' },
  { name: 'radar-api', url: railway('radar-api-production-7fe7'), group: 'own' },
  // Ventures and tools
  { name: 'crm-api (income-pipeline)', url: railway('crm-api-production-19fd'), group: 'own' },
  { name: 'crm-api (agency-crm)', url: railway('crm-api-production-a7e0'), group: 'own' },
  { name: 'book-job-data-api', url: railway('book-job-data-api-production', '/healthz'), group: 'own' },
  { name: 'awesome-web', url: railway('awesome-web-production'), group: 'own' },
  { name: 'bookchaowalit.com', url: 'https://bookchaowalit.com', group: 'own' },
  { name: 'tracking.bookchaowalit.com', url: 'https://tracking.bookchaowalit.com', group: 'own' },
  // Clients (hosted by us)
  { name: 'ev3-api', url: railway('api-production-b904', '/healthz'), group: 'client' },
  { name: 'ev3-web', url: 'https://ev3-web.vercel.app', group: 'client' },
  { name: 'a2n-api', url: railway('a2n-api-production'), group: 'client' },
  { name: 'a2n-web', url: 'https://a2n-web.vercel.app', group: 'client' },
  { name: 'tma-api', url: railway('tma-api-production-6f7d', '/api/v1/health/ready'), group: 'client' },
  { name: 'tma-moldflow-web', url: 'https://tma-moldflow-web.vercel.app', group: 'client' },
  { name: 'scannpop-backend', url: railway('scannpop-backend-production'), group: 'client' },
  { name: 'scanpop.co', url: 'https://scanpop.co', group: 'client' },
  { name: 'raidenai-api (teeparinwat)', url: railway('raidenai-api-production'), group: 'client' },
  {
    name: 'teeparinwat-web',
    url: 'https://book-freelance-teeparinwat-frontend.vercel.app',
    group: 'client',
  },
];

export const TARGETS: Target[] = ALL_TARGETS.map((t) => (SLEEPS.has(t.name) ? { ...t, sleeps: true } : t));
export const SLEEPING_TARGET_NAMES = SLEEPS;

// Jobs that must report in. A job that misses its window raises an alert.
// `db-backup` covers the Neon databases (Railway project ops-backups); each Railway-hosted
// database is backed up by a cron service inside its own project (private network only).
export const HEARTBEATS: HeartbeatSpec[] = [
  'db-backup',
  'db-backup-ev3',
  'db-backup-a2n',
  'db-backup-tma',
  'db-backup-scannpop',
  'db-backup-teeparinwat',
].map((job) => ({ job, maxAgeHours: 26 } as HeartbeatSpec)).concat([
  // Weekly automation-token rotation (platform-empire token-rotate cron, Sundays). 8 days =
  // one missed run plus a day; tokens live 30 days and rotate 10 days early, so an alert comes
  // well before any token expires.
  { job: 'token-rotate', maxAgeHours: 8 * 24 },
  // Monthly restore drill (platform-db-backup scripts/restore-drill.sh). The alert after 35 days
  // doubles as the reminder that the next drill is due.
  { job: 'restore-drill', maxAgeHours: 35 * 24 },
  // Job discovery capture + R2 ingest (career-job-scraper scheduled-capture workflow, every 6 h).
  // 13 h = one missed or delayed GitHub schedule run plus an hour before the alert.
  { job: 'job-capture', maxAgeHours: 13 },
  // News capture + R2 replay (content-news-scraper Railway cron `news-capture`, every 2 h, D6).
  // 5 h = two missed runs plus an hour.
  { job: 'news-capture', maxAgeHours: 5 },
  // Evening check-in (life-checkin-worker SPEC-002): after the 21:30 prompt the Worker checks its
  // webhook and reports. 25 h = one daily run plus an hour; ok:false alerts at once.
  { job: 'checkin-daily', maxAgeHours: 25 },
  // Backlog sync (platform-empire Railway cron `backlog-sync`, hourly at :05, ADR-0006).
  // 3 h = two missed runs plus an hour.
  { job: 'backlog-sync', maxAgeHours: 3 },
  // Daily Thai digest of the Chief Findings sheet (data-lake-pipelines Railway cron
  // `sheet-summaries`, 12:00 UTC). 26 h = one daily run plus two hours; ok:false alerts at once.
  { job: 'sheet-summaries', maxAgeHours: 26 },
]);

// Two cron triggers split the targets (by a hash of the name, so adding a target never moves the
// others: TD-004) so each invocation stays well under the free plan's
// 50-subrequest limit (checks + one Telegram message).
export const SHARDS = 2;
