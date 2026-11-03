# 15 — CI/CD pipeline

workflow เดียว `.github/workflows/ci.yml` เรียก reusable workflows จาก `bookchaowalit/platform-ci-workflows` pinned SHA `87dc5e1c…` (v1.1.1) repo เป็น public จึงใช้ GitHub-hosted runner (`ubuntu-24.04` default ของ ci-node) ไม่มี deploy job

```mermaid
flowchart TD
    P["push to main"] --> CI
    PR["pull_request"] --> CI
    WD["workflow_dispatch"] --> CI
    CI["ci.yml (concurrency ci-ref, cancel in progress, contents read)"] --> N
    CI --> S
    subgraph N["job node: ci-node.yml @87dc5e1c"]
        N1["Checkout"] --> N2["Detect package manager (npm)"]
        N2 --> N3["Set up Node 22"]
        N3 --> N4["Install dependencies"]
        N4 --> N5["Typecheck (tsc --noEmit)"]
        N5 --> N6["Test (vitest run, require-tests true)"]
        N6 --> N7["Coverage gate 98%"]
        N7 --> N8["Build: npx wrangler deploy --dry-run --outdir dist"]
    end
    subgraph S["job security: security.yml @87dc5e1c"]
        S1["gitleaks"]
        S2["semgrep"]
        S3["osv-scanner"]
        S4["trivy-fs"]
    end
    N8 -.-> M["No CD: deploy is a manual wrangler deploy (ADR-0006)"]
```

Sources: `.github/workflows/ci.yml`, `package.json` (scripts), platform-ci-workflows `ci-node.yml` และ `security.yml` ที่ commit `87dc5e1c7e0416886a6371d5a101bb2ccba38edd`, `renovate.json`

หมายเหตุ:
- ci-node มี step Lint และ Start PostgreSQL ที่ข้ามเมื่อไม่มี lint script / `postgres: false` (default)
- Renovate (`renovate.json`): Monday ก่อน 09:00 Asia/Bangkok, group `platform-ci-workflows` และ `npm non-major`, lock file maintenance วันที่ 1 ของเดือน
- ผลจริง 90 วัน (`gh run list --created '>=2026-08-05'`): push 22 runs (21 success, 1 failure `27bf995` 2026-10-24), pull_request 21 (19 / 2), workflow_dispatch 1 (1 / 0)

## Open questions

- ควรมี deploy job (เช่น `wrangler deploy` หลัง CI เขียว) หรือคง manual ไว้
