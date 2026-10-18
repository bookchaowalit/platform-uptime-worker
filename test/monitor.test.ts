import { describe, expect, it } from 'vitest';
import {
  applyResults,
  formatTransitions,
  staleHeartbeats,
  targetsForShard,
  type TargetState,
} from '../src/monitor';
import { HEARTBEATS, SHARDS, TARGETS } from '../src/targets';

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
      // checks + one Telegram message must stay below 50
      expect(targetsForShard(TARGETS, shard, SHARDS).length + 1).toBeLessThan(50);
    }
  });

  it('assigns every target to exactly one shard', () => {
    const total = Array.from({ length: SHARDS }, (_, s) => targetsForShard(TARGETS, s, SHARDS).length);
    expect(total.reduce((a, b) => a + b, 0)).toBe(TARGETS.length);
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

  it('flags a job that never reported', () => {
    expect(staleHeartbeats([spec], {}, at(0))).toEqual([spec]);
  });

  it('accepts a fresh report and flags an old one', () => {
    expect(staleHeartbeats([spec], { 'db-backup': { at: at(0).toISOString(), ok: true } }, at(60))).toEqual([]);
    expect(
      staleHeartbeats([spec], { 'db-backup': { at: at(0).toISOString(), ok: true } }, at(27 * 60)),
    ).toEqual([spec]);
  });

  it('does not repeat the stale alert within the reminder interval', () => {
    const record = { at: at(0).toISOString(), ok: true, staleAlertedAt: at(27 * 60).toISOString() };
    expect(staleHeartbeats([spec], { 'db-backup': record }, at(28 * 60))).toEqual([]);
    expect(staleHeartbeats([spec], { 'db-backup': record }, at(34 * 60))).toEqual([spec]);
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
