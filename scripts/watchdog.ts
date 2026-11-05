// Entry point for the hourly watchdog workflow (.github/workflows/watchdog.yml, SPEC-001).
// Node 24 runs this TypeScript directly; the logic and its tests live in src/watchdog.ts.
import { runWatchdog } from '../src/watchdog.ts';

process.exitCode = await runWatchdog({ env: process.env, fetch, now: new Date(), log: console.log });
