import { describe, expect, it } from 'vitest';
import { GROUPS, groupResults, groupState, overallVerdict, productFor, STATUS_PAGE, type PublicResult } from '../src/status-page';
import { TARGETS } from '../src/targets';

// SPEC-002: the customer-facing status page.

const r = (name: string, status = 'up', stale = false): PublicResult => ({ name, status, stale });

describe('SPEC-002 status page', () => {
  it('AC-01 every public target lands in exactly one product group, in fixed order', () => {
    const results = TARGETS.filter((t) => t.group === 'own').map((t) => r(t.name));
    const groups = groupResults(results);
    expect(groups.map((g) => g.id)).toEqual(GROUPS.map((g) => g.id).filter((id) => groups.some((g) => g.id === id)));
    const placed = groups.flatMap((g) => g.results.map((x) => x.name));
    expect(placed.sort()).toEqual(results.map((x) => x.name).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('AC-01 maps known names to the product a customer knows; unknown names go to platform', () => {
    expect(productFor('habits-api')).toBe('life');
    expect(productFor('checkin-worker')).toBe('life');
    expect(productFor('cash-flow-api')).toBe('finance');
    expect(productFor('finance-suite-api')).toBe('finance');
    expect(productFor('crm-api (agency-crm)')).toBe('crm');
    expect(productFor('offers-api')).toBe('crm');
    expect(productFor('ai-gateway')).toBe('ai');
    expect(productFor('knowledge-api')).toBe('data');
    expect(productFor('meta-capture')).toBe('data');
    expect(productFor('meeting-minutes-api')).toBe('ai');
    expect(productFor('bookchaowalit.com')).toBe('web');
    expect(productFor('payment-api')).toBe('platform');
    expect(productFor('something-new')).toBe('platform');
  });

  it('AC-02 overall verdict: down beats degraded beats up', () => {
    expect(overallVerdict([r('a'), r('b')]).state).toBe('up');
    expect(overallVerdict([r('a'), r('b', 'unknown')]).state).toBe('degraded');
    expect(overallVerdict([r('a'), r('b', 'up', true)]).state).toBe('degraded');
    expect(overallVerdict([r('a', 'down'), r('b', 'unknown')]).state).toBe('down');
    const v = overallVerdict([r('a')]);
    expect(v.th).toMatch(/[฀-๿]/);
    expect(v.en.length).toBeGreaterThan(0);
  });

  it('AC-02 an empty result list is degraded, not up', () => {
    expect(overallVerdict([]).state).toBe('degraded');
  });

  it('AC-03 a group takes the state of its worst member', () => {
    expect(groupState([r('a'), r('b')])).toBe('up');
    expect(groupState([r('a'), r('b', 'up', true)])).toBe('degraded');
    expect(groupState([r('a', 'down'), r('b', 'up', true)])).toBe('down');
  });

  it('AC-04 page is Thai-first, works without JavaScript and is accessible', () => {
    expect(STATUS_PAGE).toContain('<html lang="th">');
    expect(STATUS_PAGE).toContain('<main');
    expect(STATUS_PAGE).toMatch(/<noscript>[\s\S]*href="\/status"[\s\S]*<\/noscript>/);
    expect(STATUS_PAGE).toContain('aria-live="polite"');
    expect(STATUS_PAGE).toContain('prefers-color-scheme: dark');
    expect(STATUS_PAGE).toContain('prefers-reduced-motion');
    expect(STATUS_PAGE).not.toMatch(/<script[^>]+src=/);
    expect(STATUS_PAGE).not.toMatch(/<link[^>]+stylesheet/);
    expect(STATUS_PAGE.length).toBeLessThan(20_000);
  });

  it('AC-04 the browser script uses the same grouping rules as the tests', () => {
    // The page inlines the serialised rules, so the page and the unit tests cannot drift apart.
    for (const g of GROUPS) expect(STATUS_PAGE).toContain(JSON.stringify(g.id));
  });
  it('the browser script keeps open details and focus across the 60 s refresh (Codex review)', () => {
    expect(STATUS_PAGE).toContain('data-group');
    expect(STATUS_PAGE).toMatch(/openGroups/);
    expect(STATUS_PAGE).toMatch(/activeElement/);
  });
});

