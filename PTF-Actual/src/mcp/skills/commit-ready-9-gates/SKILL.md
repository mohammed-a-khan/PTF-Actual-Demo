---
name: commit-ready-9-gates
description: The canonical 9-gate exit bar — every generated file must pass all nine before the pipeline advances to the per-file human-approval handoff.
---

# Commit-Ready Exit Bar — 9 Gates

A file reaches the "approve + migrate next" handoff only if every one of these gates passes. Miss any → escalation instead.

## The nine gates

| # | Gate | Check | Tool |
|---|---|---|---|
| 1 | Compile clean | `tsc --noEmit` produces zero errors for the generated file(s) | `cs-playwright-mcp/compile_check` |
| 2 | Audit clean | `audit_file` on every generated file returns zero `error`-severity violations | `cs-playwright-mcp/audit_file` |
| 3 | Tests green | Healer returned `SUCCESS`: every in-scope scenario green, baseline preserved, final full-suite re-run green | `cs-playwright-mcp/test_run` + Healer subagent |
| 4 | No placeholders | No `TODO`, `FIXME`, `PLACEHOLDER`, `REPLACE_WITH_`, `XXX`, `HACK` in any generated file | `grep_search` |
| 5 | No raw APIs | No `console.log`, `page.locator(`, `from '@playwright/test'` in any generated file | `grep_search` |
| 6 | SQL grounded | Every SQL string in a generated helper/step resolves to a registered entry in `config/<project>/common/<project>-db-queries.env` | verified by `db-migrator`; spot-check at gate |
| 7 | Imports resolve | Every `import` path in a generated file exists | `compile_check` catches this as a side-effect |
| 8 | Data matches | Every `scenarioId` in a generated feature file has a matching row in the corresponding `_scenarios.json`, and `runFlag` = `Yes` | `commit_ready_check` tool |
| 9 | No orphans | Every generated file the pipeline emitted is on disk and listed in the run summary; no files written then lost | `commit_ready_check` tool |

## How the check runs

At Stage 6 of the pipeline, the orchestrator calls:

```
cs-playwright-mcp/commit_ready_check --files=<list>
```

The tool returns:

```json
{
  "ready": true | false,
  "gates": [
    { "id": 1, "name": "compile", "pass": true, "details": null },
    { "id": 2, "name": "audit", "pass": false, "details": {
        "violations": [{"file":"...","rule":"CC003","line":42,"message":"console.log present"}]
      }
    },
    ...
  ]
}
```

If `ready: true` → orchestrator presents the three handoff buttons (approve + advance / rework / stop).

If `ready: false` → orchestrator writes an escalation report citing failing gates and halts with only the rework + stop buttons (no approve-and-advance option). The human must resolve before the pipeline continues.

## There is no partial-success

Gates are binary pass/fail. You do not get to advance with "8 of 9 green". The point of the bar is to guarantee that every approved file is truly commit-ready — no follow-up cleanup expected.
