# 18 — Git and release workflow

จาก `git log --first-parent origin/main` (2026-10-17 → 2026-11-03) และ `gh pr list --state all`: มีทั้ง PR (#1–#7), local merge ของ feature branch (`Merge branch 'feat/...'`, ตาม ops rule "merge locally") และ commit ตรงบน `main` (เช่น `cb1b8b6`, `a26e7dc`, `fe04d27`) `main` ไม่มี branch protection (`gh api repos/bookchaowalit/platform-uptime-worker/branches/main/protection` → 404)

```mermaid
gitGraph
    commit id: "6f91355 license"
    commit id: "1123f66 PR 1 squash"
    commit id: "f7a0ac8 PR 2 squash"
    commit id: "ee6c76d PR 3 squash"
    branch feat-job-capture-heartbeat
    commit id: "edd145b"
    checkout main
    merge feat-job-capture-heartbeat id: "28b5fd9"
    branch fix-td-004
    commit id: "042b9d3"
    checkout main
    merge fix-td-004 id: "2501cf4"
    commit id: "ba0085b Sentry"
    commit id: "27bf995 CI red"
    branch feat-sheet-summaries
    commit id: "2d46f84"
    checkout main
    merge feat-sheet-summaries id: "153e847 PR 4"
    branch feat-security-api
    commit id: "c2e6ad4"
    checkout main
    merge feat-security-api id: "e34475c PR 7"
    commit id: "cb1b8b6 direct"
    commit id: "a26e7dc direct"
    commit id: "fe04d27 direct"
```

ภาพนี้ย่อเฉพาะบาง commit; ลำดับและ SHA ตรงกับ `git log --first-parent`

```mermaid
flowchart LR
    A["Branch feat/* or fix/* (or commit on main)"] --> B["PR or local merge into main"]
    B --> C["push main: ci.yml runs"]
    B --> D["Operator runs wrangler deploy (not gated on CI)"]
    C --> E{"CI green?"}
    E -- no --> F["Fix on main"]
    D --> G["Worker live on workers.dev"]
```

Sources: `git log --first-parent origin/main`, `gh pr list --state all`, `gh run list`, `wrangler deployments list`, `.github/workflows/ci.yml`, `README.md` Deploy

## Open questions

- ควรเปิด branch protection / required checks บน `main` หรือไม่
- ไม่มี tag หรือ release; จะใช้ version อะไรอ้างอิง deployment
