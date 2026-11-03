# ADR-0002 — แบ่ง target เป็น 2 shards ด้วย hash ของชื่อ และให้แต่ละ shard เฝ้า shard ถัดไป (TD-004)

- Status: accepted (retro-documented)
- Date: 2026-11-03 (implemented 2026-10-22, merges `2501cf4`, `553e2a3`)

## Context
หนึ่ง invocation บน free plan มีได้ 50 subrequests (probe + Telegram) ทำให้ probe ทุก target ในรอบเดียวไม่ได้ เดิมแบ่ง shard ด้วย index ทำให้เพิ่ม target หนึ่งตัวแล้ว target อื่นย้าย shard ทั้งหมด (comment ใน `shardOfName`) และ cron ที่หยุดไปรายงานตัวเองไม่ได้

## Decision
- `SHARDS = 2`, cron `*/5 * * * *` = shard 0 และ `2-59/5 * * * *` = shard 1 (`SHARD_CRONS`)
- shard ของ target = 32-bit FNV-1a ของชื่อ mod 2 (`shardOfName`)
- แต่ละ shard เก็บ state ของตัวเองใน `state:<shard>` และ seed จากสำเนาใหม่สุดในทุก shard (`newestStates`, `handoverStates`); `/status` อ่านจาก shard เจ้าของเท่านั้น (`mergeShardStates`)
- แต่ละ shard ตรวจว่า target ของ shard ถัดไปยังถูก probe (`watchedShard`, `staleTargets`, 30 min / 2.5 h)

## Evidence
`src/monitor.ts`, `src/worker.ts` `runShard`, `test/monitor.test.ts` "shard assignment (TD-004)", "shard state hygiene (TD-004)", "staleTargets (TD-004)"; ณ `fe04d27` shard 0 มี 39 targets (15 awake), shard 1 มี 26 (10 awake)

## Consequences
- เพิ่ม/ลบ target ไม่ย้าย target อื่น
- shard ไม่สมดุล (39/26) เพราะ hash; ทดสอบ budget ด้วย `targets.test.ts` "keeps every shard under the free-plan subrequest budget"
- ถ้าทั้งสอง cron หยุดพร้อมกันยังเงียบ
