import { describe, expect, it } from 'vitest';
import { heartbeatGraceHours, staleHeartbeats } from '../src/monitor';

// Review on 72553cb: skipping a heartbeat write must not shorten the window measured from the
// latest real report.
describe('heartbeat grace', () => {
  const spec = { job: 'job-capture', maxAgeHours: 13 };

  it('is half the window, at most one hour', () => {
    expect(heartbeatGraceHours(spec)).toBe(1);
    expect(heartbeatGraceHours({ job: 'x', maxAgeHours: 1 })).toBe(0.5);
  });

  it('a stored good record up to one grace older than the latest report never alerts early', () => {
    // latest real report 06:00 was skipped because the stored record says 05:01
    const records = { 'job-capture': { at: '2026-11-12T05:01:00Z', ok: true } };
    expect(staleHeartbeats([spec], records, {}, new Date('2026-11-12T18:59:00Z'))).toEqual([]); // < 13 h after 06:00
    expect(staleHeartbeats([spec], records, {}, new Date('2026-11-12T19:02:00Z'))).toEqual([spec]);
  });

  it('a failed record gets no grace (failed runs are always written)', () => {
    const records = { 'job-capture': { at: '2026-11-12T05:00:00Z', ok: false } };
    expect(staleHeartbeats([spec], records, {}, new Date('2026-11-12T18:01:00Z'))).toEqual([spec]);
  });
});
