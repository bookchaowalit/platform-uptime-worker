import { describe, expect, it } from 'vitest';
import { shardOfName, targetsForShard } from '../src/monitor';
import { HEARTBEATS, SHARDS, SLEEPING_TARGET_NAMES, TARGETS, RAILWAY_CUSTOM_DOMAINS } from '../src/targets';

// Invariants of the monitored list in src/targets.ts. A bad edit there (duplicate name, http URL,
// a shard over the subrequest budget) would break live monitoring, so it fails here first.

describe('TARGETS', () => {
  it('has unique names and https URLs', () => {
    const names = TARGETS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TARGETS) expect(t.url).toMatch(/^https:\/\//);
  });

  it('has unique URLs, so no service is probed twice under two names', () => {
    const urls = TARGETS.map((t) => t.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('probes the webhook receiver and the remote MCP worker on their health routes', () => {
    expect(TARGETS.find((t) => t.name === 'hooks-worker')?.url).toBe('https://hooks.bookchaowalit.com/healthz');
    expect(TARGETS.find((t) => t.name === 'mcp-remote')?.url).toBe(
      'https://solo-empire-mcp-remote.bookchaowalit.workers.dev/healthz',
    );
  });

  it('uses only the own and client groups', () => {
    for (const t of TARGETS) expect(['own', 'client']).toContain(t.group);
    expect(TARGETS.some((t) => t.group === 'own')).toBe(true);
  });

  it('never monitors the Happy-Teeth org (owner decision)', () => {
    for (const t of TARGETS) {
      expect(`${t.name} ${t.url}`.toLowerCase()).not.toMatch(/happy[-_ ]?teeth/);
    }
  });

  it('points Railway services at a health endpoint, never a page that does real work', () => {
    for (const t of TARGETS.filter((t) => t.url.includes('.up.railway.app'))) {
      expect(new URL(t.url).pathname).toMatch(/health|ready/);
    }
  });

  it('marks every listed sleeping service on an existing target', () => {
    const names = new Set(TARGETS.map((t) => t.name));
    for (const n of SLEEPING_TARGET_NAMES) expect(names.has(n)).toBe(true);
    expect(TARGETS.filter((t) => t.sleeps).length).toBe(SLEEPING_TARGET_NAMES.size);
  });

  it('only marks Railway services as sleeping (Railway sleepApplication)', () => {
    for (const t of TARGETS.filter((t) => t.sleeps)) {
      const onRailway = t.url.includes('.up.railway.app') || RAILWAY_CUSTOM_DOMAINS.some((d) => t.url.includes(`//${d}/`));
      expect(onRailway, t.name).toBe(true);
    }
  });
});

describe('shards', () => {
  it('keeps every shard under the free-plan subrequest budget', () => {
    for (let shard = 0; shard < SHARDS; shard++) {
      // checks + up to five Telegram messages must stay below 50
      expect(targetsForShard(TARGETS, shard, SHARDS).length + 5).toBeLessThan(50);
    }
  });

  it('assigns every target to exactly one shard', () => {
    const seen = new Map<string, number>();
    for (let s = 0; s < SHARDS; s++) {
      for (const t of targetsForShard(TARGETS, s, SHARDS)) {
        expect(seen.has(t.name)).toBe(false);
        seen.set(t.name, s);
      }
    }
    expect(seen.size).toBe(TARGETS.length);
  });

  it('gives every shard some targets, so no cron runs empty', () => {
    for (let s = 0; s < SHARDS; s++) expect(targetsForShard(TARGETS, s, SHARDS).length).toBeGreaterThan(0);
  });

  it('hashes names deterministically into range (32-bit FNV-1a)', () => {
    // FNV-1a of the empty string is the offset basis 0x811c9dc5 = 2166136261.
    expect(shardOfName('', 2)).toBe(2166136261 % 2);
    expect(shardOfName('', 7)).toBe(2166136261 % 7);
    for (const t of TARGETS) {
      const s = shardOfName(t.name, SHARDS);
      expect(s).toBe(shardOfName(t.name, SHARDS));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(SHARDS);
    }
  });
});

describe('HEARTBEATS', () => {
  it('has unique job names that are safe in a URL path', () => {
    const jobs = HEARTBEATS.map((h) => h.job);
    expect(new Set(jobs).size).toBe(jobs.length);
    for (const job of jobs) expect(job).toMatch(/^[a-z0-9-]+$/);
  });

  it('gives every job a positive window', () => {
    for (const h of HEARTBEATS) expect(h.maxAgeHours).toBeGreaterThan(0);
  });

  it('watches the nightly database backups with a 26 hour window', () => {
    for (const job of ['db-backup', 'db-backup-ev3', 'db-backup-a2n', 'db-backup-tma', 'db-backup-scannpop', 'db-backup-teeparinwat']) {
      expect(HEARTBEATS.find((h) => h.job === job)?.maxAgeHours).toBe(26);
    }
  });

  it('watches the weekly token rotation and the monthly restore drill', () => {
    expect(HEARTBEATS.find((h) => h.job === 'token-rotate')?.maxAgeHours).toBe(8 * 24);
    expect(HEARTBEATS.find((h) => h.job === 'restore-drill')?.maxAgeHours).toBe(35 * 24);
  });

  it('watches the 6-hourly job capture with room for one missed run', () => {
    expect(HEARTBEATS.find((h) => h.job === 'job-capture')?.maxAgeHours).toBe(13);
  });

  it('watches the 2-hourly news capture (Railway cron, owner decision D6) with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'news-capture')?.maxAgeHours).toBe(5);
  });

  it('watches the daily check-in run (life-checkin-worker SPEC-002 AC-25)', () => {
    expect(HEARTBEATS.find((h) => h.job === 'checkin-daily')?.maxAgeHours).toBe(25);
  });

  it('watches the daily sheet summaries run (data-lake-pipelines Railway cron, 12:00 UTC)', () => {
    expect(HEARTBEATS.find((h) => h.job === 'sheet-summaries')?.maxAgeHours).toBe(26);
  });

  it('watches the daily registry export run (data-lake-pipelines Railway cron, 23:40 UTC)', () => {
    expect(HEARTBEATS.find((h) => h.job === 'registry-export')?.maxAgeHours).toBe(26);
  });

  it('watches the 3x-daily X lakehouse run (data-lake-pipelines Railway cron) with its longest gap plus an hour', () => {
    expect(HEARTBEATS.find((h) => h.job === 'x-lakehouse')?.maxAgeHours).toBe(11);
  });

  it('watches the 2-hourly jobs marts run (data-lake-pipelines jobs-marts workflow) with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'jobs-marts')?.maxAgeHours).toBe(5);
  });

  it('watches the 2-hourly news marts run (data-lake-pipelines news-marts workflow) with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'news-marts')?.maxAgeHours).toBe(5);
  });

  it('watches the hourly payment outbox relay (platform-payment payment-relay cron) with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'payment-relay')?.maxAgeHours).toBe(3);
  });

  it('watches the hourly job-radar cron (sales-crm, Railway) with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'job-radar')?.maxAgeHours).toBe(3);
  });

  it('watches the hourly intake outbox relay with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'intake-relay')?.maxAgeHours).toBe(3);
  });

  it('watches the daily vuln digest with room for one missed day', () => {
    expect(HEARTBEATS.find((h) => h.job === 'vuln-digest')?.maxAgeHours).toBe(30);
  });

  it('watches the hourly event notifier with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'event-notifier')?.maxAgeHours).toBe(3);
  });

  it('watches the hourly knowledge outbox relay with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'knowledge-relay')?.maxAgeHours).toBe(3);
  });

  it('watches the hourly event-plane sink (data-lake-pipelines event-sink workflow) with room for two missed runs', () => {
    expect(HEARTBEATS.find((h) => h.job === 'event-sink')?.maxAgeHours).toBe(3);
  });

  it('watches the 6-hourly security posture monitor (platform-posture-monitor workflow) with room for one missed run', () => {
    expect(HEARTBEATS.find((h) => h.job === 'posture-monitor')?.maxAgeHours).toBe(13);
  });
});

describe('Book Platform services (deployed 2026-10-29, security 2026-11-02)', () => {
  const hosts: Record<string, string> = {
    'communication-api': 'communication-api-production',
    'media-api': 'media-api-production-91a5',
    'data-api': 'data-api-production-bf8a',
    'workflow-api': 'workflow-api-production-63de',
    'commerce-api': 'commerce-api-production-9b24',
    'logistics-api': 'logistics-api-production-d3bb',
    'developer-api': 'developer-api-production-2fad',
    'security-api': 'security-api-production-f817',
    'payment-api': 'payment-api-production-3a91', // ready 2026-11-05 (Stripe test mode)
  };

  it('probes each one on /readyz, hourly because it sleeps when idle', () => {
    for (const [name, host] of Object.entries(hosts)) {
      expect(TARGETS.find((t) => t.name === name)?.url).toBe(`https://${host}.up.railway.app/readyz`);
      expect(SLEEPING_TARGET_NAMES).toContain(name);
    }
  });
});

describe('monitor watchdog heartbeat (SPEC-001)', () => {
  it('AC-07 watches the external watchdog with a 6 h window', () => {
    expect(HEARTBEATS.find((h) => h.job === 'monitor-watchdog')).toEqual({ job: 'monitor-watchdog', maxAgeHours: 6 });
  });
});
