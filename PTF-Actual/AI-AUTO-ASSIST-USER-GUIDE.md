# CS AI Auto-Assist — Complete User Guide

**One agent. The entire test SDLC. You pick options — you never write prompts.**

CS AI Auto-Assist is the single AI agent for the CS Playwright Test Framework. It covers
planning, analysis, design, test authoring, legacy migration, review, PR review, execution,
self-healing, failure triage, regression selection, performance analysis, project audits,
accessibility audits, security scans, ADO test-plan management, release go/no-go decisions,
and load testing — 18 capabilities behind one menu.

It works the way a good human tester works: it **reads your workspace before writing
anything**, it **opens the live application and captures page objects itself**, it **finds
test data in your database first** (strictly read-only) and falls back to creating data
through the UI, and it never merges anything past its own quality gates.

---

## 1. Requirements

| Requirement | Notes |
|---|---|
| GitHub Copilot | VS Code or a JetBrains IDE (IntelliJ, WebStorm, …), Copilot Chat with agent mode |
| Node.js ≥ 20 | for the MCP server |
| `@mdakhan.mak/cs-playwright-test-framework` | installed in the workspace (this package ships the agent + server) |
| Project layout | the standard `test/<project>/…` + `config/<project>/…` convention (a fresh repo is fine — the agent scaffolds) |

---

## 2. One-time setup (per repository)

From the repository root:

```bash
# VS Code users
npx cs-playwright-mcp init-agents --loop=vscode

# IntelliJ / JetBrains users
npx cs-playwright-mcp init-agents --loop=jetbrains
```

This generates:

| File | Purpose |
|---|---|
| `.github/agents/CS AI Auto-Assist.agent.md` | the single agent definition Copilot picks up |
| `.github/skills/…` | pattern skills the agent retrieves on demand |
| `.github/copilot-instructions.md` | always-on framework conventions |
| `.vscode/mcp.json` (or `./mcp.json` for JetBrains) | registers the `cs-playwright-mcp` server |

Then **reload your IDE**. In Copilot Chat, open the agent picker and select
**CS AI Auto-Assist**. That's it.

> Add `Agent-Processing/` to your `.gitignore` (the framework repo's is already updated) —
> that folder holds session state and reports, not source.

---

## 3. Using it (the whole workflow)

1. Select the **CS AI Auto-Assist** agent in Copilot Chat and say anything — "hi" is enough.
2. **Pick what you want to do**:
   - **VS Code** shows a native dropdown of the 18 modes, then a native form for that
     mode's inputs (dropdowns for choices, text boxes for values).
   - **JetBrains** shows a numbered menu; reply with the number, then answer the short
     input questions.
3. **Watch it work.** Open `Agent-Processing/<timestamp>_<session>/STATUS.md` in a side
   panel — it updates live with every stage, artifact, and budget figure.
4. The agent only interrupts you for genuine decisions: a dropdown choice (e.g. which ADO
   suite, run impacted tests or full suite), a credential need, a guardrail block, or a
   budget extension. Everything else is automatic.
5. Every mode ends with a **final report** (path surfaced in chat), a **trust score** with
   a review recommendation, and the full artifact trail in the session folder.

You can also skip the menu by being specific in your first message, e.g.
*"migrate ./legacy/LoginTest.java to project orangehrm"* — the agent maps it to the right
mode and inputs for you.

---

## 4. The 18 capabilities

### Build & author

| Mode | What it does | You provide | You get |
|---|---|---|---|
| **Plan** | Test strategy + executable test plan from an ADO plan id, requirement document, or plain description; grounded in your existing coverage so it never re-plans what exists | project, source, value | `TEST-PLAN.md` (objectives, scope, risks, prioritized scenario outlines, data needs, entry/exit) |
| **Analyze** | Deep structured analysis of requirements, legacy code, or an app area — testable behaviors with evidence, gaps, risks, readiness score | project, target | `ANALYSIS.md` + readiness verdict (< 0.7 = don't automate yet) |
| **Design** | Scenario matrix (positive/negative/edge/e2e with steps), coverage map, page-object plan that reuses what exists | project, feature description, risk level | `TEST-DESIGN.md` |
| **Implement (author)** | Complete test generation end-to-end: features, step definitions, page objects, data files — through the audited 9-phase pipeline with 40+ rule gates | project, what to automate, optional app URL | Runnable CS-framework tests, audited, executed, trust-scored |
| **Migrate** | Legacy Java/C#/other suites → CS framework, with line-cited grounding and semantic-equivalence checks | project, legacy path, optional app URL | Migrated runnable tests + migration report |

### Verify & maintain

| Mode | What it does | You provide | You get |
|---|---|---|---|
| **Review** | 40+ deterministic rule audit + semantic review (wrong assertions, brittle locators, missing negative paths) with concrete fixes | project, optional scope | `REVIEW.md` with verdict (approve / approve-with-nits / request-changes) |
| **PR review** | Same review discipline applied to your branch diff vs a base branch | base branch, project | Diff-scoped `REVIEW.md` |
| **Run** | Execute suites by project/environment/tags, parse the results | project, env, tags, headless | `RUN-REPORT.md` (failures with errors, slowest scenarios) |
| **Heal (maintain)** | Bounded self-healing of failures: locator drift and timing fixed in page objects only — never by weakening assertions; suspected app bugs stay failing | project, env, optional target | Healed tests + honest heal report (cycles capped at 20/session) |
| **Triage** | Clusters recent failures by error signature, classifies root causes (locator drift / timing / data / env / app bug / test bug), records correction memory | project, window | `TRIAGE.md` board with priorities and fixes |
| **Regression** | Git-diff impact analysis → selects the impacted feature subset → you confirm (impacted / full / cancel) → runs it | project, env, base branch | Impact report + targeted run results |
| **Audit** | Whole-project health: rule violations, duplicate step definitions, placeholders, inventory stats → graded A–F with a remediation plan | project | `AUDIT-REPORT.md` |

### Non-functional

| Mode | What it does | You provide | You get |
|---|---|---|---|
| **Performance** | Perf-focused run + timing analysis: p50/p90/p95, slow-trend regressions vs run history, hottest steps | project, env, tags | `PERF-REPORT.md` |
| **Load** | Designs a load/stress/spike/endurance/baseline profile (virtual users, ramp pattern, p95/error-rate thresholds) and renders a **runnable scenario for the framework's native performance engine** — no k6/JMeter needed | project, target URL, type, VUs, duration | `test/<project>/performance/<name>.perf.ts` + `LOAD-RUNBOOK.md` |
| **Accessibility** | Walks the live app with axe-based audits (WCAG 2.x / Section 508), aggregates violations | project, app URL, standard | `A11Y-REPORT.md` with grade + remediation plan |
| **Security** | Headers, cookies, sensitive-data exposure, CSRF, XSS checks on an **authorized test environment** | project, app URL | `SECURITY-REPORT.md` with grade + remediation plan |

### Manage & ship

| Mode | What it does | You provide | You get |
|---|---|---|---|
| **ADO test plan** | Fetches a story from Azure DevOps — reads its **full description, repro steps and comments**, not just acceptance criteria — designs full-coverage test cases, creates them in ADO with proper Steps XML, and attaches them to the suite **you pick from a live-discovered dropdown** | project, story id | Test cases live in your ADO suite + design artifact |
| **ADO automate** | Point at a **test plan id** → the agent lists the **suites** (you pick one) → lists that suite's **test cases** (you pick which to automate, or "all") → fetches their steps → explores the live app → generates automation for exactly those cases | project, plan id | Runnable CS-framework tests for the selected ADO cases |
| **Source** | No requirements, no ADO — just the **application's source code**: the agent reads the source, derives the real user workflows, opens the running app, walks them, and generates complete automation | project, source path | Full test suite derived from the app itself |
| **Defect** | Give a **bug id** (or description): the agent reads the defect + **reproduction steps** + comments, finds the existing test covering that area (or plans a new regression), grounds it in live exploration, fixes/authors it, tags it `@defect_<id>`, and runs it | project, defect id | A regression test that reproduces/guards the defect |
| **Release** | Evidence-based go/no-go: local run evidence + flaky-candidate detection + open ADO bugs → gated verdict where every gate cites its evidence; `conditional_go` requires explicit conditions | project, release name | `RELEASE-DECISION.md` sign-off report |

---

## 5. The human-tester doctrine (what makes authoring different)

When you run **Implement** or **Migrate**, the engine enforces the order a good human
tester follows:

1. **Read before write** — the `posture` stage inventories `test/<project>` first.
   Fresh repo → scaffold everything. Existing repo → **reuse and extend** existing pages
   and steps; duplication is a gate violation, not a style preference.
2. **Ask, then see the app before scripting it** — if you didn't give an app URL, the agent
   **asks for it** (and whether login is needed) first. Then it opens the application and
   **walks each workflow end-to-end like a manual test pass**, recording the *observed* steps
   and capturing every page's elements with a stable primary locator **plus alternatives**
   (feeding self-healing). The generated scenarios come from what it actually saw — it **never
   generates on assumptions**. If login is needed it signs in with your encrypted
   `{config:DEFAULT_USERNAME}`/`{config:DEFAULT_PASSWORD}` — never plaintext in chat.
3. **Data comes from reality** — for each scenario the agent connects to your project
   database, discovers the schema, and looks for **existing rows** with SELECT queries.
   Only when no suitable data exists does it plan **UI-driven data creation** as setup
   steps. Static literals are the last resort. Every choice is recorded in
   `data-resolution.json`.
4. **The database is read-only. Always.** This is enforced in code, not by prompt:
   write-capable DB tools are never registered in agent sessions, and every DB call is
   intercepted by a SQL parser that rejects anything but
   SELECT / WITH…SELECT / SHOW / DESCRIBE / EXPLAIN — including multi-statement batches,
   `SELECT INTO`, `FOR UPDATE`, and writes hidden in comments.

---

## 6. AI-credit efficiency (why a task won't drain your Copilot allowance)

GitHub Copilot now bills AI credits on token usage. The platform is engineered around that:

- **5 tools at startup, not 250.** Copilot's context carries only the five meta-tools.
  Capability packs (browser, database, ADO, execution, …) register **at the exact stage
  that needs them** and are released when the session ends.
- **Deterministic-first.** Inventories, audits, git diffs, result parsing, failure
  clustering, report rendering — all computed in TypeScript at **zero token cost**. The
  LLM is invoked only for genuinely cognitive work, through strict schema-validated
  envelopes.
- **One decision per round-trip.** Consecutive deterministic stages auto-chain inside a
  single tool call.
- **Hard budgets.** Every session has token / wall-clock / cost ceilings. At 80% you're
  warned in `STATUS.md`; at 100% the session **blocks and asks you** before spending more
  (`extend_budget` adds +50% per approval — it is never automatic).
- **Nothing is paid for twice.** Sessions persist to disk. An IDE restart or conversation
  compaction never loses work — resume picks up at the exact outstanding step.
- **Silence rule.** The agent doesn't narrate between tool calls; chat output is capped to
  the decisions and the final summary.

---

## 7. Guardrails (all enforced server-side)

| Guardrail | What it does |
|---|---|
| Secret/PII intake gate | Credentials pasted into inputs are rejected outright; PII is redacted. Credentials flow only through the encrypted config mechanism (`ENCRYPTED:` values). |
| Read-only SQL | See §5.4 — write tools unregistered + every query parsed. |
| Constitutional rules | No production deletes, no real PII in test data, no destructive ops — checked before handoffs and writes. |
| Schema gates | Every piece of LLM output is JSON-schema validated before it is persisted; 3 attempts, then the session blocks rather than accepting bad output. |
| Bounded loops | Max 200 engine steps/session, 20 heal cycles, 3 submit retries — runaway sessions are structurally impossible. |
| Honest reporting | Heal never weakens assertions; failed runs are reported failed; suspected app bugs stay failing and are flagged. |
| Trust score | Every session ends with a weighted trust score (grounding, execution, gates, heal penalty) and a concrete review recommendation. |

---

## 8. Sessions: status, resume, cancel

Everything lives in `Agent-Processing/<timestamp>_<sessionId>/`:

```
session.json     — full session state (the system of record)
STATUS.md        — live progress; keep it open in a side panel
timeline.jsonl   — append-only event log (every stage, gate, pack activation)
artifacts/       — every report, plan, design, capture, resolution produced
```

Useful commands (say them to the agent in plain words — it maps them):

| You say | What happens |
|---|---|
| "show my sessions" | lists recent sessions with state |
| "resume session `<id>`" (or just "continue") | re-emits the exact outstanding step — nothing is redone |
| "cancel the session" | closes it and releases its tool packs |
| "yes, extend the budget" | +50% ceilings after a budget block (only ever after asking you) |

---

## 8b. What each mode actually needs to run (honest dependency matrix)

Every mode runs a **config preflight** before spending any tokens: it tells you up front
what's missing (and blocks only when a hard dependency is absent, e.g. ADO credentials for
the ADO test-plan mode). Nothing fails silently three stages in.

| Mode | Needs nothing but the repo | Needs a live app URL + Playwright | Needs a runnable suite/app | Needs DB config (`DB_*`) | Needs ADO config (`ADO_ORGANIZATION`/`ADO_PROJECT`/`ADO_PAT`) | Needs a git repo |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| plan | ✅ | | | | ● (only if source = ADO) | |
| analyze | ✅ | | | | | |
| design | ✅ | | | | | |
| review · audit | ✅ | | | | | |
| triage · performance* | ✅ (reads existing reports) | | ● (performance re-runs) | | | |
| author · migrate | ✅ (works without) | ● (to capture page objects) | ● (to execute) | ● (data-first; falls back to UI) | | |
| pr_review · regression | | | ● (regression runs) | | | ✅ |
| run · heal | | | ✅ | | | |
| accessibility · security · load | | ✅ | | | | |
| ado_plan | | | | | ✅ | |
| release | ✅ (local evidence) | | | | ● (adds ADO bugs; skipped if absent) | |

✅ = required · ● = used when present, degrades gracefully otherwise.

**Azure DevOps behind a corporate proxy:** the ADO integration honors the framework's
`ADO_PROXY_*` settings (and standard `HTTPS_PROXY`), so ADO calls route through your
corporate proxy automatically — set `ADO_PROXY_ENABLED`, `ADO_PROXY_HOST`, `ADO_PROXY_PORT`
(and `ADO_PROXY_USERNAME`/`ADO_PROXY_PASSWORD` if required) in your config, exactly as you
already do for the framework's own ADO features.

**A note on honesty:** the deterministic stages (inventory, audits, git diffs, result
parsing, failure clustering, timing analysis, load-scenario generation, evidence
aggregation) run in the server and produce real, verifiable output. The judgement stages
(the plan, the review verdict, the go/no-go, the designed cases) are produced by the LLM
under strict JSON-schema validation and grounded in the fetched/real artifacts — their
quality tracks the Copilot model you run. Handoff stages call the framework's real tools
(ADO REST, database, Playwright, BDD runner, the native performance engine); they are as
real as those tools, which are genuine.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Agent not in the picker | Re-run `init-agents`, reload the IDE; check `.github/agents/` exists |
| "Tool not found" mid-session | The host missed a pack refresh — ask the agent to continue; it re-activates the pack (`csaa_toolpack`) |
| No dropdowns (numbered menu instead) | Your IDE doesn't support MCP elicitation (JetBrains today) — the flow is identical, just text-based |
| Session blocked on budget | That's the credit protection working; approve an extension or review scope |
| Blocked with a validation error | The agent hit a quality gate; `STATUS.md` + `timeline.jsonl` show exactly which gate and why |
| DB stage skipped | No `DB_*` keys found in `config/<project>` — configure the connection or let data fall back to UI creation |
| Want the old full tool surface | `cs-playwright-mcp --tools=…` still runs the classic profile |

---

## 10. Quick reference card

```
Start:            pick "CS AI Auto-Assist" in Copilot Chat → say hi → choose from 18 modes
Watch:            Agent-Processing/<run>/STATUS.md
Everything else:  the agent asks you only when a human decision is genuinely needed
Guarantees:       read-only DB · encrypted credentials · hard budgets · schema-gated output
                  · bounded healing · trust-scored results · resumable sessions
```
