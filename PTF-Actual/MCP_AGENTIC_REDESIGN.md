# CS AI Auto-Assist v3 — Agentic MCP Redesign

**Status:** Implemented (this document describes the shipped architecture)
**Modules:** `src/mcp/agentic/` (new), `src/mcp/agents/cs-ai-auto-assist.md` (rewritten), `src/mcp/index.ts` + `src/mcp/cli.ts` (extended)

---

## 1. Why the redesign

| Problem in the old design | Consequence | v3 answer |
|---|---|---|
| 245+ tools registered eagerly at server start | Every Copilot request carried a huge tool context → wasted AI credits, degraded tool selection | **5 meta-tools at startup**; capability packs load **on demand** via `tools/list_changed` |
| Two competing orchestrators (v1 monolith prompt, v2 + six sub-agents) | Users had to pick agents, sub-agent handoffs burned extra requests/tokens | **One agent**: `cs-ai-auto-assist`. Orchestration moved out of the prompt into a deterministic TypeScript playbook engine |
| Users had to write the right prompt | Inconsistent results, trial-and-error burns credits | **Menu-driven**: MCP elicitation renders native dropdowns/forms in VS Code; numbered-menu fallback everywhere else. Users pick options, never write prompts |
| Guardrails existed but were orphaned (budget, constitutional safety, trust score, bounded heal) | No runaway protection; a single task could exhaust a credit allowance | All guardrails **wired live** in `CSGuardrailEngine` and enforced at every stage boundary |
| Only migration/authoring covered | Everything else needed ad-hoc prompting | **13 SDLC modes** covering plan → maintain, all driven by the same engine |

## 2. Architecture

```
GitHub Copilot (VS Code / JetBrains) — single custom agent: cs-ai-auto-assist
        │  (MCP stdio)
┌───────▼──────────────────────────────────────────────────────────┐
│ cs-playwright-mcp  (agentic profile — default)                   │
│                                                                  │
│  META-TOOLS (always loaded, ~5)                                  │
│   cs_ai_auto_assist   front door: menu → session → first step    │
│   csaa_advance        run playbook stages until next decision    │
│   csaa_submit         validated hand-back of LLM cognitive work  │
│   csaa_status         session snapshot / list / resume           │
│   csaa_toolpack       progressive disclosure: activate packs     │
│                                                                  │
│  ┌─ CSSDLCCatalog     13 modes, input fields, menu rendering     │
│  ├─ CSPlaybooks       per-mode stage graphs                      │
│  ├─ CSPlaybookEngine  deterministic | cognitive | handoff |      │
│  │                    elicit | gate stage executors              │
│  ├─ CSSessionStore    Agent-Processing/<ts>_<sid>/ session.json, │
│  │                    STATUS.md, timeline.jsonl, artifacts/      │
│  ├─ CSGuardrailEngine PII/secret intake gate, constitutional     │
│  │                    action checks, token/wall-clock/$ budget,  │
│  │                    schema gates, bounded loops, trust score   │
│  └─ CSToolPacks       lazy require() + register + list_changed   │
│                                                                  │
│  CAPABILITY PACKS (registered only when a mode needs them)       │
│   authoring(30 csaa_* primitives) execution(bdd+testing+heal)    │
│   browser(53) quality(audit+pipeline) data(db) api(network)      │
│   ado(cicd) insights(analytics+intel+drift+equiv) security       │
│   generation(gen+codegen+exploration)                            │
└──────────────────────────────────────────────────────────────────┘
```

### The four stage kinds

- **deterministic** — pure TypeScript, zero LLM tokens: repo inventory, legacy discovery, audit-rule scans, git-diff collection, result parsing, failure clustering, report rendering. `csaa_advance` chains consecutive deterministic stages inside **one** tool call.
- **cognitive** — the only place the LLM thinks. The engine returns a `DelegationEnvelope` (strict instruction + JSON response schema + grounding **paths**, not file bodies + BM25-retrieved skills). The agent fulfils it and calls `csaa_submit`, which validates against the schema before anything is persisted.
- **handoff** — directs the agent to a small set of pack tools (e.g. the proven `csaa_discover → … → csaa_publish` authoring chain, or `bdd_run_feature`), with explicit `nextSuggestedTool`/`nextSuggestedArgs` and a completion contract reported back to `csaa_advance`.
- **elicit / gate** — user decision points (native dropdown via MCP elicitation, text menu fallback) and guardrail checkpoints (budget, audit, constitutional, trust) with `pass | degrade | block` verdicts.

## 3. The 13 SDLC modes (one dropdown)

| # | Mode | What the user gets |
|---|------|--------------------|
| 1 | `plan` | Test strategy + plan document from ADO plan / document / description |
| 2 | `analyze` | Deep analysis of requirements, legacy code, or a live app |
| 3 | `design` | Scenario matrix, coverage map, page-object model design |
| 4 | `author` | New CS-framework tests end-to-end (features, steps, pages, data) |
| 5 | `migrate` | Legacy (Java/C#/…) → CS framework migration (the proven 9-phase chain) |
| 6 | `review` | Standards review of test code (40+ audit rules + semantic review) |
| 7 | `pr_review` | Branch/PR diff review with verdict + per-file findings |
| 8 | `run` | Execute suites by project/env/tags with parsed result report |
| 9 | `heal` | Bounded self-healing of failing tests (locator drift, timing) |
| 10 | `triage` | Failure clustering + root-cause classification + correction memory |
| 11 | `regression` | Change-impact analysis → targeted regression selection → run |
| 12 | `performance` | Perf-focused run configuration + timing analysis + hotspots |
| 13 | `audit` | Full project audit: rules, placeholders, orphans, health report |
| 14 | `accessibility` | WCAG audit of the live app (axe-based), graded remediation plan |
| 15 | `security` | Headers/cookies/XSS/CSRF/sensitive-data scan of an authorized test env |
| 16 | `ado_plan` | ADO story → designed test cases created in ADO (Steps XML) and attached to the suite the user picks from a live-discovered dropdown |
| 17 | `release` | Evidence-based go/no-go: local run evidence + flaky candidates + open ADO bugs → gated verdict + sign-off report |
| 18 | `load` | Load/stress/spike/endurance profile with thresholds, rendered as a runnable scenario for the framework's NATIVE performance engine (no k6/JMeter dependency) |

Every mode ends with: report artifact on disk, trust score with interpretation, `STATUS.md` trail, and token/credit usage summary.

### The human-tester doctrine (authoring & migration)

Authoring sessions behave like a competent human tester, enforced by stage order:

1. **`posture`** — read the workspace first: full inventory of existing pages/steps/features, fresh-vs-existing classification, existing modules, DB-config detection. Existing assets are *reused and extended*, never duplicated. Output: `workspace-posture.json`.
2. **`author.explore`** — when an app URL is provided, the agent opens the live application (browser pack loads only at this stage), walks the in-scope workflows, and captures every page's interactive elements with a stable primary locator + alternatives (`browser_generate_locator`). Output: `captured-pages.json` — the source of truth for generated page objects.
3. **`author.data`** — data-first resolution per scenario: connect to the project DB, discover the schema (`db_list_tables`/`db_describe_table`), find EXISTING rows with SELECT queries; if none exist, plan **UI-driven data creation** as setup steps; static literals last. Output: `data-resolution.json`.
4. **`author.pipeline`** — the audited 9-phase generation chain, now grounded in all three artifacts above.

### Database safety: SELECT-only, enforced in code

The platform's hard rule — an agentic session can **never** mutate a database:

- Write-capable DB tools (`db_execute`, `db_bulk_insert`, `db_truncate_table`, transactions, stored procedures, imports) are **excluded from registration** in the agentic data pack — no model can even attempt them.
- Every remaining DB tool handler is wrapped by a server-side interceptor that parses SQL-bearing params and rejects anything that isn't `SELECT`/`WITH…SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` — multi-statement batches, `SELECT INTO`, `FOR UPDATE`, and every write/DDL verb are blocked (comments and string literals are stripped first so nothing can hide).
- Queries recorded in data-resolution reports are re-validated before persisting (defense in depth).
- Missing test data is created **through the application UI**, exactly like a human tester.

### Stage-level pack activation

Capability packs now load at the *stage* that needs them, not just at session start (`HandoffDirective.packs`): the browser pack appears only when exploration actually runs, the data pack only at data resolution. Sessions record every activated pack and release them all at completion.

## 4. Credit efficiency (the billing model changed — this is designed for it)

GitHub Copilot now bills AI-credits on token usage. v3 attacks every token sink:

1. **Tool-context slimming**: 5 tool schemas at startup instead of 245+ (~95% smaller tool context on every request). Packs are activated per-mode and deactivated when the session closes.
2. **Deterministic-first**: anything computable in TypeScript never touches the LLM.
3. **Grounding by reference**: envelopes carry file *paths* + minimal excerpts + top-k skills, not whole files.
4. **One decision per round-trip**: `csaa_advance` auto-chains deterministic stages; the agent only wakes for cognition or user decisions.
5. **Output-cap discipline**: chunked `csaa_submit` (`part`/`final`) keeps every message under host caps — no aborted-and-retried generations.
6. **Hard budget**: per-session token/wall-clock/$ ceilings (`CSCostTelemetry`, now actually enforced). At 80% the user is warned; at 100% the session blocks and asks (dropdown) whether to extend.
7. **Resumability**: sessions persist to disk; conversation compaction or an IDE restart never loses paid-for work (`csaa_status action:"resume"`).
8. **Silence rule** in the agent definition: no filler narration between tool calls.

## 5. Guardrails (all live)

| Guardrail | Where enforced |
|---|---|
| PII / secret intake scan (`CSPiiSanitizer`) | `cs_ai_auto_assist` before a session is created; secrets are rejected, PII redacted |
| Constitutional safety (`CSConstitutionalSafety`) | Every handoff directive and every file-write stage (no prod deletes, no real PII in test data, …) |
| Budget (`CSCostTelemetry`) | Every meta-tool call estimates and records tokens; gates block at ceiling |
| Schema gate (`CSSchemaValidator`) | Every `csaa_submit` payload |
| Content gate (`CSContentValidator` + `AuditEngine`) | Review/audit stages and generated-artifact stages |
| Bounded loops | Max stages per session, max heal cycles, max submit retries (3) |
| Trust score (`CSTrustScore` — single unified model) | Final gate of every mode; interpretation bands drive the review recommendation |

## 6. Progressive tool disclosure protocol

1. Server starts with meta-tools only and advertises `tools: { listChanged: true }`.
2. `cs_ai_auto_assist` activates the packs its mode needs → `notifications/tools/list_changed` → the host refreshes its tool list.
3. `csaa_toolpack {action:"list"}` lets the agent discover packs by name/description without loading any schemas.
4. Closing/finishing a session deactivates its packs.

## 7. User experience contract

- **VS Code (elicitation supported):** the user invokes the agent → a native quick-pick shows the 13 modes → a native form collects the mode's inputs (enums render as dropdowns) → everything else is automatic until a decision or the final report.
- **JetBrains / other hosts:** the tool returns a numbered menu; the agent prints it verbatim; the user replies with a number/choice; the agent re-calls the front door with the selection. Same catalog, same inputs — no prompt writing either way.
- The only moments a user is interrupted: mode/input selection, credential needs, guardrail blocks, budget extension, and explicit decision gates (e.g. "run the 14 impacted tests?").

## 8. Back-compat & rollout

- `cs-playwright-mcp` (no flags) now starts the **agentic** profile (5 tools).
- `cs-playwright-mcp --profile=classic` (or `--tools=…`) preserves the previous eager-registration behavior; `createFullMCPServer()` is unchanged.
- `npx cs-playwright-mcp init-agents` now materializes **only** the single `cs-ai-auto-assist` agent (plus skills + `copilot-instructions.md` + `mcp.json`) for `--loop=vscode|jetbrains|claude|opencode`.
- The old `agent-platform` primitives are untouched — the authoring/migrate modes hand off to them; nothing regressed.

## 9. File map (new code)

```
src/mcp/agentic/
  types.ts               shared contracts (session, stage, directive, menu)
  CSSDLCCatalog.ts       13 modes + input fields + menu/elicitation source of truth
  CSToolPacks.ts         lazy pack registry (require-on-activate, list_changed)
  CSSessionStore.ts      persisted sessions, STATUS.md, timeline, artifacts
  CSGuardrailEngine.ts   PII, constitutional, budget, limits, trust — enforced
  CSPlaybooks.ts         per-mode stage graphs + deterministic executors
  CSPlaybookEngine.ts    stage stepper (auto-chain, envelopes, handoffs, gates)
  CSAgenticTools.ts      the 5 meta-tools incl. elicitation UX
  index.ts               registerAgenticTools() + createAgenticMCPServer glue
```
