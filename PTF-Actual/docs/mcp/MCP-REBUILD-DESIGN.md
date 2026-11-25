# CS QA Agent Platform: MCP Rebuild Design

| | |
|---|---|
| **Status** | Draft for review |
| **Owner** | mohammed-a-khan |
| **Replaces** | `src/mcp/v6` (89 `cs_qa_*` tools, 32 scaffolded templates) |
| **Constraint** | The only LLM is **GitHub Copilot Enterprise** inside the editor: VS Code, Visual Studio, JetBrains, Eclipse, Xcode. There are no other API keys. |
| **Primary requirement** | Cost efficiency under token-based AI Credits billing, which applies to Enterprise since 2026-06-01 |
| **Research** | `reports/Copilot agentic MCP design.md` and `research_notes/Copilot agentic MCP design/*` |

---

> **Source of truth (verified 2026-11-12).** The framework's real repository is Azure DevOps `mdakhan/myproject/ptf-ado-repo` (`main`, v1.54.0, 1,307 files). The GitHub copy this design was first drafted from is a partial snapshot of it: 715 files, a stale `package.json` (1.10.17), no `src/mcp/v3`, `src/mcp/v4`, `src/mcp/_salvage`, `performance-testing-app` or `ADO-Pipeline-Templates`, and some newer report-validation work. The two copies are identical in most of the source files compared (e.g. `src/mcp/v6/server/index.ts`, `CSDBUtils.ts`, `CSHttpClient.ts`, `CSDatabase.ts`, `CSValueResolver.ts`). Work will be based on the ADO repo, with the GitHub-only changes merged in.

## 1. Summary

**Design rule: Copilot thinks, the server does.** Copilot spends tokens only on work that needs judgement: drafting test content, choosing a fix, deciding what to test. Every check, loop, lookup and side effect is deterministic server code that returns a short summary and a file handle. This is the cheapest arrangement under token billing, and also the most reliable.

| | Today (v6) | Rebuild (v7) |
|---|---|---|
| MCP tools | 89 | **8** (plus 1 optional) |
| Tool-definition tokens per round-trip | ≈ 48.8 k (measured) | **< 5 k** (CI budget gate) |
| Tool names referenced by templates that exist | 18 of 79 | **All** (CI check) |
| Always-on instruction tokens | ≈ 1.5 k, partly false | **≈ 1 k, all true** |
| Workflow guidance | 18 prompts + 4 skills (≈ 18 k tokens), mostly stale | **5 skills**, loaded only when used |
| ADO feature-to-test-case round trip | Good logic; duplicate-create, credential and forgeable-confirmation bugs | **Same logic kept as a library**, with the plumbing fixed and writes gated by plan/apply |
| Guardrails | Model-settable `confirmed: true`, unconfined shell | **Enforced in the server**, so they still hold when the editor auto-approves tool calls |
| Editors | Mainly VS Code | All five, with graceful degradation |

**No redundancy.** The server is a thin layer over capabilities the framework already has:

| Capability | Already in the framework |
|---|---|
| Test runner | `CSBDDRunner` |
| Step catalogue and validation | `CSStepPatternScanner`, `CSStepValidator` |
| Report validation | `src/report-validation`, now on our own PDF engine |
| Locator lint and self-healing | `CSLocatorLinter`, `CSSelfHealingEngine` |
| Agent-oriented CLI | `CSPlaywrightCLI` |

Nothing that Copilot already ships is rebuilt (file, shell, search, git, browser tools), and nothing `@playwright/mcp` already does is rebuilt either.

---

## 2. Cost model and budget

Facts from the research, as of November 2026:

- **What is billed.** Every chat or agent round-trip is billed in AI Credits (1 credit = $0.01). Each Enterprise seat includes 3,900 credits a month, pooled across the enterprise. Overage is on by default, and admins can set budgets per user, cost centre or org.
- **What each round-trip sends.** Each step re-sends the conversation history, **all tool definitions** and all tool outputs. Subagents cost tokens too.
- **Caching.** Cached input costs about 10% of normal input. The cache breaks when the model, reasoning effort, or enabled tools change in the middle of a session.
- **Model price spread.** About 100×: from $0.10 to $10 per million input tokens. Auto model selection gives 10% off.

Rules that follow from this. Each is enforced in CI or by the server:

| # | Rule | How it's enforced |
|---|---|---|
| C1 | Tool surface stays under 5 k tokens | CI measures `tools/list` JSON on every build and fails over budget |
| C2 | Tool list is **static and byte-stable**: no dynamic registration, no timestamps or counts in descriptions, deterministic order | CI snapshot test of `tools/list` |
| C3 | **One call = one pipeline.** Each action does a whole job: run, verify, diagnose, plan or apply | Design review; telemetry tracks calls per task |
| C4 | Results return at most ~2 k tokens by default (`format: "concise"`), with details written to `.cs-qa/runs/<runId>/…` and returned as a path | Server truncates and points to the file |
| C5 | No sampling. The server never triggers hidden model calls; sampling is deprecated in MCP 2026-07-28 and its billing is undocumented | Not implemented |
| C6 | Instructions are short and true; workflows live in **skills**, which load only when used | CI checks the token size of always-on files (≤ 1.2 k) |
| C7 | Cheap models do routine work. All Copilot models are enabled (confirmed by the owner), so the choice is driven by cost, not availability. **Worker agents** (author, healer, ADO publisher) list cheap models first, e.g. `[Claude Haiku 5.5, GPT-6 Luna, Auto]`. The **planner and reviewer** use `Auto`, which gets the 10% discount and selects the model itself, with a strong model as fallback. Model names are defined once, in `scaffolder/models.json`, and `init-agents` writes them into the agent files, so updating to new model names means editing one file | Agent frontmatter generated from `models.json`; reviewed in PRs |
| C8 | Subagents are used only to keep noisy context out of the main conversation (e.g. summarising 40 failure logs), never for role-play | Agent design |

**Worked example.** Take a 20-step agent turn on Sonnet 5.5 with a cache miss. Today it spends about **195 credits on tool definitions alone**. With v7 that drops to about **20 credits**, and to about 1 credit once the cache is warm or on a $0.10/M worker model.

---

## 3. Architecture

```
 Editor (any of 5) ── Copilot agent turn (the only LLM) ──────────────────────────────┐
   reads: copilot-instructions.md / AGENTS.md · *.instructions.md · skills · agents   │
   calls: built-in tools (read/edit/search/execute) · @playwright/mcp · ptf (ours)    │
                                                                                      ▼
 ┌────────────────────────────── cs-qa MCP server (stdio, stateless) ─────────────────────────┐
 │ Contract layer   8 static tools · text content + structuredContent · runId/planToken handles │
 │ Policy layer     workspace containment · secret scan · ADO policy guard · heal caps ·        │
 │                  assertion-weakening refusal · redacted audit · untrusted-data wrapping      │
 │ Services         Catalog+BM25 · Runner · Verifier · Diagnoser+episodic memory · Report ·     │
 │                  ADO kernel (plan/apply) · Scaffolder                                        │
 └───────────────┬──────────────────────────────────────────────────────────────────────────────┘
                 │ calls framework capabilities (no duplication)
 CSBDDRunner · CSStepPatternScanner/Validator · CSLocatorLinter · CSSelfHealingEngine ·
 report-validation (native PDF engine) · CSPlaywrightCLI · src/ado (converged ADO client) · CSConfigurationManager
```

### 3.1 Source layout

```
src/mcp/
  server/        bin.ts (entry; keeps the published `cs-playwright-mcp` → `dist/mcp/v6/server/bin.js` launch path), server.ts, contract.ts (zod → JSON schema, text+structured results)
  policy/        workspace.ts, secrets.ts, adoGuard.ts, healGuard.ts, audit.ts (redacted), untrusted.ts
  services/      catalog/ (index + BM25), runner/, verifier/, diagnoser/ (+ episodic memory), report/, ado/ (kernel), scaffold/
  tools/         ptf_catalog.ts, ptf_run.ts, ptf_verify.ts, ptf_diagnose.ts, ptf_report.ts, ado_query.ts, ado_plan.ts, ado_apply.ts, [ptf_scaffold.ts]
  scaffolder/    init-agents (writes the customization layer, §6), templates/, embedded-templates.ts (regenerated by the build)
  state/         run & plan stores under .cs-qa/ (one state directory, replacing three)
```

- **Dependencies.** No change: the ADO repo (the real source, v1.54.0) already declares `@modelcontextprotocol/sdk`, `zod` and `pdfjs-dist`, and its build already runs `embed-scaffolder-templates.js`. An earlier draft said these were missing; that was wrong, based on a stale `package.json` in the GitHub copy.
- **Build.** The build script is fixed to run `embed-scaffolder-templates.js`.

---

## 4. Tool contract (8 tools)

All tools share these conventions:

- an `action` enum, validated strictly on the server for each action;
- a `format` field, `concise` (default) or `detailed`;
- every result returns a **text** block (a summary plus a next-step hint) **and** `structuredContent`;
- large output is written to a file and only its path is returned;
- descriptions are at most 2 sentences.

| Tool | Actions | Replaces (v6) | Backed by | Annotations |
|---|---|---|---|---|
| `ptf_catalog` | `search` (BM25 over the 534 built-in steps, project steps, page objects and docs) · `step` (find a step by text) · `page` (elements and locators) · `config` (keys in effect) · `coverage` | ground_story, kg_build/query, check_existing_tests, automation_inventory, source_coverage, rag, docs_ingest | CSStepPatternScanner, CSPageRegistry, config manager, in-process BM25 index (cached on disk) | readOnly |
| `ptf_run` | `start` (features, tags, env, parallel → `runId`) · `status` · `results` (summary plus failure list) | heal_loop run part, bootstrap test runs | CSBDDRunner spawned as a child process; `report-data.json` | — |
| `ptf_verify` | `files` (compile, framework rules, locator lint, duplicate steps, undefined steps) · `diff` (assertion-weakening check on a change) | verify_generated, code_analyze, gov_code_mutation_audit, gov_scaffold_audit | tsc API, CSStepValidator, CSLocatorLinter, rule engine | readOnly |
| `ptf_diagnose` | `failure` (classify as locator / timing / data / env / app-bug, with evidence and a suggested skill) · `similar` (past fixes for the same signature) · `record` (store a root cause and fix result) | detect_drift, auto_heal_drift, healer_bridge, verify_locators_live, sync_locators, flaky_signature_cluster | signature normaliser, CSSelfHealingEngine and locator scoring, episodic JSONL with BM25 | `record` writes |
| `ptf_report` | `validate` · `compare` (PDF vs PDF) · `validate_db` (query or procedure) · `spec` (infer or edit) | the 10 `report_*` tools | `src/report-validation` (VERIFICATION-DESIGN.md) | readOnly except `spec` |
| `ado_query` | `item` · `plan` · `suite` · `points` · `runs` · `coverage` · `trace` · `sprint` · `defects` | ado_read, sprint_context, coverage_heatmap, trace, build_delta, dora, sprint_ops reads | ADO kernel (§5) | readOnly |
| `ado_plan` | `publish_feature` · `update_cases` · `place_in_suite` · `points` · `publish_results` · `file_bugs` · `manage` (move or remove) → returns a **preview** and a `planToken` | publish_feature_to_ado, ado_write, testcases_manage, test_points_bulk, publish_run_results, log_failures_as_bugs | ADO kernel, `sync_feature_tags` | readOnly (only builds the plan) |
| `ado_apply` | `apply(planToken)` runs exactly the previewed plan and returns created/updated IDs and the tag rewrites made | the confirmation halves of the above | ADO kernel | **destructive**; never auto-approved (§7) |
| `ptf_scaffold` *(optional)* | `page_object` · `feature` · `steps` · `api_test` · `test_data` from templates, written as files to review | ui_scaffold, gen_* generators, init_project | the existing generators and parsers, reused | writes (contained) |

**Moved out of the tool list:**

| Group | New home | Why |
|---|---|---|
| Governance reports, DORA, dashboards, PAT reminder, legacy migration | CLI subcommands (`cs-playwright-mcp gov …`, `… migrate …`) | They cost nothing until someone runs them |
| Workspace tools: fs, shell, search, git, memory, browse, inspect_dom, route | Dropped | Copilot's built-ins and `@playwright/mcp` already cover them |

**State is held in explicit handles.** Cross-call state lives in server-created `runId` and `planToken` values that the caller passes back. This matches the stateless 2026-07-28 MCP spec, and it still works on clients that speak older versions.

---

## 5. ADO kernel: reuse, fix the plumbing, converge

**Reused as-is.** This is the logic you rely on, moved into `services/ado/`:

| Library | What it does |
|---|---|
| Test-case composer (`publish_feature_to_ado_tool.ts:170-985`) | Builds test cases from Gherkin: priority and area from tags, HTML description, steps XML |
| `sync_feature_tags.ts` | Writes `@TestCaseId`, `@TestPlanId` and `@TestSuiteId` back into feature files |
| `ado_name_resolver.ts` | Resolves plan and suite names to IDs |
| Test points, trace and run-publishing logic | |
| `tc_steps_parser.ts`, `wiql_builder.ts` | Parse steps XML; build WIQL queries |

**Fixed.** These are the audit's priority bugs:

| # | Bug | Fix |
|---|---|---|
| A1 | POST/PATCH retried on timeout or 5xx, which **creates duplicate test cases** | Retry only GET and idempotent calls. For creates, re-read before retrying: look the case up by its deterministic key (feature path + scenario name, stored as a hidden tag) |
| A2 | Title lookups swallow errors and report "not found"; WIQL not scoped to the project; no paging | Errors propagate; every WIQL query is scoped to the project; `x-ms-continuationtoken` paging everywhere |
| A3 | The name resolver caches failed lookups | Cache successful lookups only |
| A4 | A PAT is accepted in 38 tool inputs and written to the audit log in plaintext | No credential is ever a tool input. Credentials come from framework config (`ADO_*`), environment, or the user's Git Credential Manager. The audit log records only argument hashes |
| A5 | `ENCRYPTED:` uses a hard-coded key | Fixed in `CSEncryptionUtil`: the key comes from an environment variable or the OS keychain, with migration of existing values |
| A6 | Feature-file writes are not atomic and can clobber an editor autosave | Write to a temp file, then rename. The write is guarded by the file hash recorded at plan time; if the file changed, the plan is invalid |
| A7 | Two ADO stacks (`src/ado/CSADOClient` and the MCP client) on API versions 7.0 and 7.1 | **One** ADO HTTP client and **one** config resolver, shared by the runner's result publishing and the MCP kernel |
| A8 | `dryRun` defaults to false; the permanent purge sits behind a model-settable boolean | Every write goes through plan/apply. Purge also needs the server-side opt-in `ADO_ALLOW_PURGE=true` |

---

## 6. Customization layer (written by `init-agents`)

| File | Purpose | Editors | Size budget |
|---|---|---|---|
| `.github/copilot-instructions.md` | Repo map; run, lint and test commands; the rules ("call `ptf_catalog` before writing a step", "ADO writes only through `ado_plan` → `ado_apply`", "never weaken an assertion to make a test pass"); a tool index | **All five** (Visual Studio needs a checkbox enabled) | ≤ 1.2 k tokens |
| `AGENTS.md` | Generated mirror of the above | VS Code, JetBrains, cloud agent | same |
| `.github/instructions/*.instructions.md` (6) | Path-scoped rules for `features`, `pages`, `steps`, `report-specs`, `sql`, `config` | VS Code, Visual Studio, JetBrains, Xcode (Eclipse applies them repo-wide) | ≤ 400 tokens each |
| `.github/skills/<name>/SKILL.md` (5) | `author-feature`, `heal-failing-test`, `publish-feature-to-ado`, `validate-report`, `triage-run`. Each is a procedure with a checklist: which tool actions to call, the stop conditions, and what to report | VS Code (default Copilot harness), Visual Studio 18.5+, JetBrains, Eclipse | Loaded only when used |
| `.github/agents/*.agent.md` (4) | `qa-planner` (read-only, strong model, writes `plans/<task>.md`), `qa-author`, `qa-healer`, `ado-publisher` (tools limited to `ado_*` and `read`). Portable fields only (`name`, `description`, `tools`, `model` list); handoffs are not relied on | All five (field support varies) | small |
| `.github/prompts/*.prompt.md` (5) | One-line shims that point to the matching skill, for Xcode (no skills support) and VS Code Local-harness users | Xcode, VS Code Local, Visual Studio, JetBrains, Eclipse | tiny |
| `.vscode/mcp.json` + root `.mcp.json` | Server config. **stdio, `servers` key, no `${input:}` prompts.** Pins `@playwright/mcp` to a fixed version | VS Code and Visual Studio read these. For JetBrains, Eclipse and Xcode, `init-agents --editor <x>` prints or writes the user-level config | — |
| `.vscode/settings.json` | `chat.tools.eligibleForAutoApproval: { "ado_apply": false }` | VS Code | — |

**How the agentic patterns map to this layer:**

| Pattern | Where it lives |
|---|---|
| Planning | `qa-planner` agent and `plans/` files |
| Reflection / verification | `ptf_verify` plus a rerun via `ptf_run` (free and deterministic) |
| Routing | `ptf_diagnose` names the skill to follow |
| Multi-agent | 4 role agents with least-privilege tool lists, and subagents only to isolate noisy context |
| Memory | Chat (short-term); `plans/` files and `runId` (working); instructions and skills (long-term); `ptf_diagnose record/similar` (episodic) |
| Retrieval | `ptf_catalog search` |
| Self-healing | `heal-failing-test` skill, with limits enforced by the server (§7) |
| Human in the loop | `ado_plan` → `ado_apply` with manual approval |

---

## 7. Guardrails (enforced by the server)

The editor can auto-approve tool calls: VS Code has "Allow all" and Autopilot modes, and tools marked read-only never prompt. So every hard rule is enforced **in the server**:

1. **Workspace containment.** Writes go only under the configured roots (`test/`, `config/`, `plans/`, `.cs-qa/`). Paths are resolved through `realpath`, so symlinks can't escape.
2. **No arbitrary shell.** `ptf_run` builds the runner command itself from validated arguments.
3. **Heal limits.** There is an attempt cap per `runId` (default 3). `ptf_verify diff` rejects any change that deletes or weakens an assertion. After the cap, the test is marked `@fixme` and a heal report is written.
4. **Plan tokens for ADO writes.** `ado_plan` stores the exact preview under a short-lived `planToken`, bound to a hash of the plan and of the source files. `ado_apply` executes that plan or fails. The token prevents stale, mismatched or fabricated writes, but it can't prove a human looked at the preview. Human review comes from client settings: `ado_apply` is marked destructive, is never auto-approvable in VS Code, and manual per-tool approval is recommended in the other IDEs. Elicitation is used as an extra confirmation only where the editor supports it (VS Code, JetBrains).
5. **Inline policy.** Secret scanning and the ADO policy guard run inside every write path. They are not optional tools.
6. **Untrusted content.** Page text, logs and ADO fields are returned wrapped as delimited untrusted data. Nothing in that content can make the server call a tool or a URL.
7. **Redacted audit log.** `.cs-qa/audit/<date>.jsonl` records the tool, action, argument hashes, outcome and duration. It never contains secrets.

---

## 8. Cross-editor compatibility rules

- Every result includes a text `content` block. Today's server returns only `structuredContent`, which non-VS Code IDEs don't document reading.
- **No workflow depends on** sampling, elicitation, roots, prompts or resources. They are extras where the editor supports them.
- **Workspace root** is resolved in this order: MCP roots if the client offers them, then `CS_QA_WORKSPACE_ROOT` or an argument, then the current directory walked up to `.git`. (Today `CS_QA_WORKSPACE_ROOT` is ignored.)
- **Credentials** come from framework config and environment variables, never from `${input:}`.
- **Enterprise registry.** For enterprises that allow only registry servers, `init-agents` documents publishing the server to the org MCP registry or adding it to `allowedMcpServers`.
- **Tool names in agent files** use Copilot's alias names (`read`, `edit`, `search`, `execute`, `todo`, `agent`) plus `cs-qa/*`. Never `runSubagent` or tool sets.

---

## 9. Evaluation and observability

- **Golden tasks.** A set of about 20 tasks in `test/mcp/golden/`, each with a sandbox project and a verifiable outcome. Examples:
  - author a feature with no duplicate steps;
  - heal a seeded locator break without touching assertions;
  - publish a feature to a sandbox ADO plan, then check IDs, tags and suite membership;
  - validate a report PDF against a stored procedure.
- **Deterministic scoring.** Tests pass; the code compiles; duplicate-step rate; false-heal rate; **duplicate ADO creates = 0**; calls per task; result bytes.
- **Telemetry.** One span per tool call (`runId`, action, latency, result bytes, outcome) written to `.cs-qa/telemetry/`. OpenTelemetry trace context is passed through `_meta` per MCP 2026-07-28.
- **Cost per task.** Read from VS Code's per-turn credit display and Cache Explorer when running the golden tasks. Rerun whenever instructions, models or tool schemas change.
- **CI gates.** Tool surface under 5 k tokens; `tools/list` snapshot stable; every tool name referenced in the templates exists; always-on instructions within budget.

### 9.1 Testing ADO without an ADO project

There is no ADO project to test against, so the ADO kernel is tested against **our own local ADO fake**: `test/mcp/ado-fake/`, built on Node's built-in `http` module.

- **Endpoints.** It implements only the Azure DevOps REST endpoints the kernel uses, following Microsoft's published REST API reference:
  - work items: create, update, get, WIQL;
  - test plans and suites, and suite test-case add;
  - test points;
  - test runs and results;
  - attachments.
- **State.** It keeps state in memory, so tests can assert exactly what was created.
- **Fault injection.** Tests can make it return timeouts *after* a create has been committed (the duplicate-create case), 5xx errors, 409 conflicts, 429 responses with `Retry-After`, and paging with `x-ms-continuationtoken`.
- **Golden tasks.** The ADO golden tasks (e.g. publish a feature twice → zero duplicates; tags written back correctly) run against the fake in CI. They cost nothing and are fully repeatable.
- **Optional live check later.** If a real project becomes available, the same test suite runs against it with `ADO_LIVE_TEST=true`. Note: creating test plans and suites in Azure DevOps needs the Azure Test Plans licence (or its trial), so a free organisation alone isn't enough for the live check.

---

## 10. Migration

- **Server identity.** The server name stays `cs-qa`, so existing `mcp.json` files keep connecting.
- **Old tool names. Decision: no aliases.** The owner asked for a deep analysis before choosing. These are the findings:
  1. **Callers.** The only things that call v6 tools by name are the scaffolded prompts and skills that `init-agents` copied into each project. Only 18 of the 89 tools are named in them: `ask_user`, `browse`, `capture_ui_values`, `db_select`, `fs`, `heal_loop`, `intent_brief`, `publish_feature_to_ado`, `rag`, and the 9 `report_*` tools. The other 61 names those files reference are already broken today. No framework code outside `src/mcp` calls any `cs_qa_*` tool.
  2. **Aliases that are listed would break the cost budget.** Copilot only calls tools that appear in `tools/list`. So an alias works only if it is listed, and the 18 listed aliases would add about **7.5 k tokens** to every round-trip. That alone exceeds the whole < 5 k v7 budget. It would also put two tools on screen for the same job, which lowers selection accuracy.
  3. **Aliases that aren't listed do nothing**, because no client ever calls an unlisted name.
  4. **Verified (2026-11-12, against the ADO repo `ptf-ado-repo` main, v1.54.0):** `cs-playwright-mcp` → `dist/mcp/v6/server/bin.js` is correct and the v6 server runs. Users do rely on it, and the ADO repo also ships `cs-playwright-mcp-v4`. This makes a careful migration more important, but it doesn't change the alias decision: listed aliases would still break the token budget (point 2). The opt-in `cs-qa-v6` entry below is what protects existing users.

  **Chosen approach:**
  - v7 ships as a **major version**. Consumers pin package versions, so nobody switches by accident.
  - `init-agents --upgrade` rewrites the old prompts and skills to the new skills.
  - At startup, the server checks the workspace's `.github/prompts` and `.github/skills` for v6 tool names. If it finds any, it adds a single line to the server `instructions`: "outdated QA templates found — run `npx cs-playwright-mcp init-agents --upgrade`". This costs nothing when there are no stale files.
  - The v6 server stays available for one major version as a separate, opt-in `cs-qa-v6` entry. Adding it to the tool list costs nothing unless a user configures it.
- **Templates.** `init-agents --upgrade` rewrites the customization layer. Files the user has edited are kept as `*.bak`, and a diff is shown.
- **Not affected.** The framework's runtime (BDD runner, steps, report validation) doesn't depend on the MCP module.

---

## 11. Milestones

| Milestone | Scope | Exit criteria | Est. |
|---|---|---|---|
| **A0 ADO kernel safety** | §5 A1–A8; one ADO client and one config resolver shared with `src/ado`; the PAT encryption fix; **a local ADO fake server** for tests (§9.1) | Against the fake: repeated publish of the same feature creates **zero duplicates**; retry-on-timeout, 5xx, 409 and paging scenarios pass; no secrets in logs | 2.5 wk |
| **A1 Server core** | Same launch path and package metadata as the ADO repo, contract layer (text + structured results), policy layer, single state directory, redacted audit, CI token budget and snapshot gates | Server starts in all 5 editors (smoke checklist); budget gate active | 1.5 wk |
| **A2 Tools** | The 8 tools on top of the existing framework services; BM25 catalog; episodic memory; plan/apply | Unit and integration tests per action; surface under 5 k tokens | 3 wk |
| **A3 Customization layer** | Instructions, 6 path rules, 5 skills, 4 agents, prompt shims, configs, `init-agents --upgrade` | All referenced tool names exist (CI); always-on budget met | 1.5 wk |
| **A4 Evaluation** | Golden tasks, scoring harness, telemetry, cost-per-task baseline | Baseline recorded; v7 beats v6 on success rate and credits per task | 1.5 wk |
| **A5 Migration and docs** | Legacy aliases for one release, user guide, admin guide (policies, registry, budgets) | Docs reviewed; v6 removed in the following major version | 1 wk |
| | | **Total** | **≈ 11 weeks** |

Order: A0 comes first, because the ADO features you depend on must be safe before an autonomous loop is allowed to drive them.

---

## 12. Decisions and remaining questions

| # | Question | Decision |
|---|---|---|
| 1 | Is your enterprise "registry only" for MCP servers? | **Resolved.** The current `cs-qa` server already works in the owner's company, so the policy allows it. v7 keeps the **same server name (`cs-qa`) and the same launch method** that works today, so no admin action is needed. If the launch command or package name ever changes, re-check with the admin first. |
| 2 | Is there a sandbox ADO project? | **None available.** Tests use our local ADO fake (§9.1). The live check is optional, for later. |
| 3 | Which models are enabled? | **All Copilot models.** Agent model lists are chosen for cost (C7). |
| 4 | Keep legacy tool aliases? | **No aliases**, after analysis (§10): major version, `init-agents --upgrade`, stale-template warning, opt-in `cs-qa-v6` for one major version. |

**Question 1 explained.** In GitHub's Enterprise settings an admin can choose which MCP servers Copilot may use. There are two settings:

- **"Allow all".** Users can add any MCP server, including ours, by putting it in `mcp.json`. Nothing extra is needed.
- **"Registry only".** Copilot connects only to servers listed in the company's approved catalogue (the "MCP registry") or in a managed settings file that IT controls. A server that isn't in that list is blocked. That would include ours, even though it runs locally on the developer's machine.

**How to find out:** ask your GitHub Enterprise admin which setting "MCP servers in Copilot" uses. Or simply try it: if Copilot shows `cs-qa` as blocked or "not allowed by policy", the setting is "Registry only". In that case the admin has to add `cs-qa` to the approved list once. The admin guide in milestone A5 will include those steps.
