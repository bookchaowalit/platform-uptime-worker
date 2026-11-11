// Entry point for the daily static sweep workflow (.github/workflows/static-sweep.yml, SPEC-003).
// Node 24 runs this TypeScript directly; the logic and its tests live in src/static-sweep.ts.
import { runSweep } from '../src/static-sweep.ts';
import { STATIC_SITES } from '../src/static-sites.ts';

process.exitCode = await runSweep({ sites: STATIC_SITES, env: process.env, fetch, log: console.log });
