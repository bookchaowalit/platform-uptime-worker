import { describe, expect, it } from 'vitest';
import { shardOfName, targetsForShard } from '../src/monitor';
import { HEARTBEATS, SHARDS, SLEEPING_TARGET_NAMES, TARGETS } from '../src/targets';

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
    for (const t of TARGETS.filter((t) => t.sleeps)) expect(t.url).toContain('.up.railway.app');
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
});
