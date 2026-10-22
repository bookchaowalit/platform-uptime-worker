import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  MAX_PENDING_ALERTS,
  applyResults,
  chunkAlerts,
  isDue,
  isStale,
  formatTransitions,
  mapWithConcurrency,
  mergeShardStates,
  queueAlerts,
  newestStates,
  shardOfName,
  staleHeartbeats,
  staleTargets,
  targetsForShard,
  watchedShard,
  type TargetState,
} from '../src/monitor';
import { HEARTBEATS, SHARDS, SLEEPING_TARGET_NAMES, TARGETS } from '../src/targets';

const t0 = new Date('2026-10-18T00:00:00Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe('targets', () => {
  it('has unique names and https URLs', () => {
    const names = TARGETS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TARGETS) expect(t.url).toMatch(/^https:\/\//);
  });

  it('keeps every shard under the free-plan subrequest budget', () => {
    for (let shard = 0; shard < SHARDS; shard++) {
      // checks + up to five Telegram messages must stay below 50
      expect(targetsForShard(TARGETS, shard, SHARDS).length + 5).toBeLessThan(50);
    }
  });

  it('assigns every target to exactly one shard', () => {
    const total = Array.from({ length: SHARDS }, (_, s) => targetsForShard(TARGETS, s, SHARDS).length);
    expect(total.reduce((a, b) => a + b, 0)).toBe(TARGETS.length);
  });
});

describe('shard assignment (TD-004)', () => {
  const extra = { name: 'new-service', url: 'https://new.example', group: 'own' as const };

  it('keeps every existing target in its shard when a target is inserted', () => {
    // bc2bb44 inserted checkin-worker at index 3 and moved every later target to the other shard.
    const before = new Map(TARGETS.map((t) => [t.name, shardOfName(t.name, SHARDS)]));
    const inserted = [TARGETS[0], extra, ...TARGETS.slice(1)];
    for (let s = 0; s < SHARDS; s++) {
      for (const t of targetsForShard(inserted, s, SHARDS)) {
        if (t.name !== extra.name) expect(before.get(t.name)).toBe(s);
      }
    }
  });

  it('is a pure function of the name', () => {
    expect(shardOfName('diary-api', 2)).toBe(shardOfName('diary-api', 2));
    for (const t of TARGETS) expect(shardOfName(t.name, SHARDS)).toBeLessThan(SHARDS);
  });

  it('keeps the probes, messages and parked sends of every shard under 50 subrequests', () => {
    // probes + 5 queued messages + 3 parked heartbeat alerts
    for (let s = 0; s < SHARDS; s++) expect(targetsForShard(TARGETS, s, SHARDS).length + 5 + 3).toBeLessThan(50);
  });
});

describe('shard state hygiene (TD-004)', () => {
  const up = (checkedAt: Date): TargetState => ({
    status: 'up', consecutiveFailures: 0, since: t0.toISOString(), latency: 10, checkedAt: checkedAt.toISOString(),
  });
  const mine = TARGETS.find((t) => shardOfName(t.name, SHARDS) === 0)!;
  const theirs = TARGETS.find((t) => shardOfName(t.name, SHARDS) === 1)!;

  it('keeps only owned targets, dropping moved or removed ones', () => {
    const states = { [mine.name]: up(at(0)), [theirs.name]: up(at(0)), removed: up(at(0)) };
    expect(Object.keys(newestStates([states, {}], TARGETS, 0, SHARDS))).toEqual([mine.name]);
  });

  it('reads each target from its own shard, so a stale copy elsewhere cannot win', () => {
    // The incident: diary-api fresh in shard 0, a 2026-10-21 copy left in shard 1 shown on /status.
    const fresh = up(at(18 * 60));
    const stale = up(at(0));
    const merged = mergeShardStates([{ [mine.name]: fresh }, { [mine.name]: stale }], TARGETS, SHARDS);
    expect(merged[mine.name]).toEqual(fresh);
  });

  it('seeds each owned target from its newest copy in any shard', () => {
    // After the hash change diary-api moves to a shard whose own copy is the stale 2026-10-21 one.
    const stale = up(at(0));
    const fresh = up(at(18 * 60));
    const seeded = newestStates([{ [mine.name]: stale }, { [mine.name]: fresh, [theirs.name]: fresh }], TARGETS, 0, SHARDS);
    expect(seeded).toEqual({ [mine.name]: fresh });
  });

  it('keeps an ongoing outage across a shard move: no new down alert, recovery still reported', () => {
    const down: TargetState = {
      status: 'down', consecutiveFailures: 5, since: at(0).toISOString(), lastAlertAt: at(0).toISOString(), latency: 10000,
      error: 'timeout after 10s', checkedAt: at(60).toISOString(),
    };
    const seeded = newestStates([{}, { [mine.name]: down }], TARGETS, 0, SHARDS);
    const stillDown = applyResults(seeded, [{ name: mine.name, ok: false, latency: 10000, error: 'timeout after 10s' }], at(65));
    expect(stillDown.transitions).toEqual([]);
    expect(stillDown.state[mine.name].since).toBe(at(0).toISOString());
    const back = applyResults(stillDown.state, [{ name: mine.name, ok: true, latency: 20 }], at(70));
    expect(back.transitions.map((x) => x.kind)).toEqual(['recovered']);
  });
});

describe('staleTargets (TD-004)', () => {
  const awake = { name: 'awake', url: 'https://a', group: 'own' as const };
  const sleeper = { name: 'sleeper', url: 'https://s', group: 'own' as const, sleeps: true };
  const checked = (minutes: number): TargetState => ({
    status: 'up', consecutiveFailures: 0, since: t0.toISOString(), latency: 5, checkedAt: at(minutes).toISOString(),
  });

  it('marks an awake target stale after 30 minutes and a sleeping one after 2.5 hours', () => {
    expect(isStale(awake, checked(0), at(29))).toBe(false);
    expect(isStale(awake, checked(0), at(31))).toBe(true);
    expect(isStale(sleeper, checked(0), at(149))).toBe(false);
    expect(isStale(sleeper, checked(0), at(151))).toBe(true);
  });

  it('alerts once per stale window, then every reminder interval', () => {
    const first = staleTargets([awake], { awake: checked(0) }, {}, at(40));
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toContain('awake');
    const again = staleTargets([awake], { awake: checked(0) }, first.watch, at(60));
    expect(again.lines).toEqual([]);
    const reminder = staleTargets([awake], { awake: checked(0) }, first.watch, at(40 + 6 * 60));
    expect(reminder.lines).toHaveLength(1);
  });

  it('reports once when an alerted target is probed again and forgets it', () => {
    const alerted = staleTargets([awake], { awake: checked(0) }, {}, at(40));
    const back = staleTargets([awake], { awake: checked(45) }, alerted.watch, at(46));
    expect(back.lines).toHaveLength(1);
    expect(back.lines[0]).toContain('probed again');
    expect(back.watch).toEqual({});
  });

  it('gives a target with no state a full window before alerting', () => {
    const seen = staleTargets([awake], {}, {}, at(0));
    expect(seen.lines).toEqual([]);
    expect(staleTargets([awake], {}, seen.watch, at(20)).lines).toEqual([]);
    expect(staleTargets([awake], {}, seen.watch, at(31)).lines).toHaveLength(1);
  });

  it('gives every watched target a full window from the moment the watcher starts', () => {
    // After the sharding change a moved target may carry an old checkedAt from an earlier owner.
    const watchSince = at(600).toISOString();
    expect(staleTargets([sleeper], { sleeper: checked(0) }, {}, at(601), watchSince).lines).toEqual([]);
    expect(staleTargets([sleeper], { sleeper: checked(0) }, {}, at(600 + 151), watchSince).lines).toHaveLength(1);
  });

  it('has each shard watch the next one', () => {
    expect(watchedShard(0, 2)).toBe(1);
    expect(watchedShard(1, 2)).toBe(0);
    expect(watchedShard(0, 1)).toBe(0);
  });
});

describe('isDue', () => {
  it('probes sleeping services only in the first five minutes of the hour', () => {
    const sleeper = { name: 's', url: 'https://x', group: 'own' as const, sleeps: true };
    const awake = { name: 'a', url: 'https://y', group: 'own' as const };
    expect(isDue(sleeper, new Date('2026-10-18T07:02:00Z'))).toBe(true);
    expect(isDue(sleeper, new Date('2026-10-18T07:05:00Z'))).toBe(false);
    expect(isDue(awake, new Date('2026-10-18T07:37:00Z'))).toBe(true);
  });

  it('marks every listed sleeping service on an existing target', () => {
    const names = new Set(TARGETS.map((t) => t.name));
    for (const n of SLEEPING_TARGET_NAMES) expect(names.has(n)).toBe(true);
    expect(TARGETS.filter((t) => t.sleeps).length).toBe(SLEEPING_TARGET_NAMES.size);
  });
});

describe('applyResults', () => {
  it('needs two failures in a row before alerting', () => {
    const first = applyResults({}, [{ name: 'api', ok: false, latency: 5, error: 'HTTP 502' }], at(0));
    expect(first.transitions).toEqual([]);
    expect(first.state.api.status).toBe('up');

    const second = applyResults(first.state, [{ name: 'api', ok: false, latency: 5, error: 'HTTP 502' }], at(5));
    expect(second.transitions).toEqual([{ name: 'api', kind: 'down', error: 'HTTP 502' }]);
    expect(second.state.api.status).toBe('down');
  });

  it('does not alert again until the reminder interval', () => {
    let state: Record<string, TargetState> = {};
    for (const m of [0, 5]) state = applyResults(state, [{ name: 'api', ok: false, latency: 1 }], at(m)).state;
    const quiet = applyResults(state, [{ name: 'api', ok: false, latency: 1 }], at(60));
    expect(quiet.transitions).toEqual([]);
    const reminder = applyResults(quiet.state, [{ name: 'api', ok: false, latency: 1 }], at(5 + 6 * 60));
    expect(reminder.transitions.map((t) => t.kind)).toEqual(['reminder']);
  });

  it('reports recovery once', () => {
    let state: Record<string, TargetState> = {};
    for (const m of [0, 5]) state = applyResults(state, [{ name: 'api', ok: false, latency: 1 }], at(m)).state;
    const recovered = applyResults(state, [{ name: 'api', ok: true, latency: 1 }], at(30));
    expect(recovered.transitions.map((t) => t.kind)).toEqual(['recovered']);
    const steady = applyResults(recovered.state, [{ name: 'api', ok: true, latency: 1 }], at(35));
    expect(steady.transitions).toEqual([]);
  });

  it('forgets a single blip', () => {
    const blip = applyResults({}, [{ name: 'api', ok: false, latency: 1 }], at(0));
    const ok = applyResults(blip.state, [{ name: 'api', ok: true, latency: 1 }], at(5));
    expect(ok.transitions).toEqual([]);
    expect(ok.state.api.consecutiveFailures).toBe(0);
  });
});

describe('staleHeartbeats', () => {
  const spec = HEARTBEATS.find((h) => h.job === 'db-backup')!;
  const fresh = { 'db-backup': { at: at(0).toISOString(), ok: true } };

  it('flags a job that never reported', () => {
    expect(staleHeartbeats([spec], {}, {}, at(0))).toEqual([spec]);
  });

  it('accepts a fresh report and flags an old one', () => {
    expect(staleHeartbeats([spec], fresh, {}, at(60))).toEqual([]);
    expect(staleHeartbeats([spec], fresh, {}, at(27 * 60))).toEqual([spec]);
  });

  it('does not repeat the stale alert within the reminder interval', () => {
    const alerted = { 'db-backup': at(27 * 60).toISOString() };
    expect(staleHeartbeats([spec], fresh, alerted, at(28 * 60))).toEqual([]);
    expect(staleHeartbeats([spec], fresh, alerted, at(34 * 60))).toEqual([spec]);
  });

  it('treats an alert from before the latest report as a past window', () => {
    // Alerted at 27h, then the job reported at 30h and went quiet again: alert at 57h right away.
    const records = { 'db-backup': { at: at(30 * 60).toISOString(), ok: true } };
    const alerted = { 'db-backup': at(27 * 60).toISOString() };
    expect(staleHeartbeats([spec], records, alerted, at(57 * 60))).toEqual([spec]);
  });
});

describe('HEARTBEATS', () => {
  it('watches the 6-hourly job capture with room for one missed run', () => {
    expect(HEARTBEATS.find((h) => h.job === 'job-capture')?.maxAgeHours).toBe(13);
  });
});

describe('queueAlerts', () => {
  it('keeps undelivered alerts ahead of new ones and caps the queue', () => {
    expect(queueAlerts(['a'], ['b'])).toEqual(['a', 'b']);
    const many = Array.from({ length: MAX_PENDING_ALERTS + 5 }, (_, i) => `x${i}`);
    const queued = queueAlerts([], many);
    expect(queued).toHaveLength(MAX_PENDING_ALERTS);
    expect(queued.at(-1)).toBe(`x${MAX_PENDING_ALERTS + 4}`);
  });
});

describe('chunkAlerts', () => {
  it('splits on line boundaries under the limit and keeps every line', () => {
    const lines = Array.from({ length: 7 }, (_, i) => `${i}`.padEnd(800, 'x'));
    const chunks = chunkAlerts(lines);
    expect(chunks.flat()).toEqual(lines);
    for (const c of chunks) expect(c.join('\n').length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(chunks.length).toBe(2);
  });

  it('shortens a single oversized line instead of dropping it', () => {
    const [[line]] = chunkAlerts(['y'.repeat(MAX_MESSAGE_CHARS + 100)]);
    expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(line.endsWith('(truncated)')).toBe(true);
  });
});

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once and keeps order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });
});

describe('formatTransitions', () => {
  it('renders down, reminder and recovery lines', () => {
    const text = formatTransitions(
      [
        { name: 'a', kind: 'down', error: 'HTTP 500' },
        { name: 'b', kind: 'reminder', downSince: at(0).toISOString() },
        { name: 'c', kind: 'recovered', downSince: at(0).toISOString() },
      ],
      at(90),
    );
    expect(text).toBe('🔴 a (HTTP 500)\n⏰ still down: b for 1h 30m\n✅ c recovered (down 1h 30m)');
  });
});
