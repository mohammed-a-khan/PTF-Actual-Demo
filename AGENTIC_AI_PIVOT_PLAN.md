# Agentic AI Pivot Plan — Copilot + VS Code + ADO (no GitHub repos, no cloud)

**Date:** 2026-08-06
**Scope:** What to build next with agentic AI given the real constraints: GitHub Copilot license (Business/Enterprise), VS Code, Azure DevOps. No GitHub-hosted repos, no cloud subscriptions, no self-hosted LLMs.

---

## 1. Why the current MCP module burns credits without outcome

The `cs-ai-auto-assist` platform (`src/mcp/agent-platform`, `src/mcp/agentic` — ~71 TS files) is architected as an **orchestrator that re-implements the agent loop** and delegates all semantic work back to the host LLM through MCP sampling (`CSCopilotDelegate` → `sampling.createMessage`). That shape has three structural cost problems:

1. **Double-LLM hop.** Every user request costs: (a) the Copilot chat turn that decides to call `cs_ai_auto_assist`, plus (b) one or more sampling calls the server makes back into Copilot, plus (c) heal-loop retries — each a separately billed model call. The orchestration itself produces no value the user can see; it only multiplies calls.
2. **Re-implementing what the host now does natively.** Intent routing, clarification tiers, mode dispatch, plan/act separation, bounded retry — in 2026 these are *built into* Copilot agent mode (custom agents, subagents, handoffs, permission levels, Autopilot sessions). We pay tokens to run a hand-rolled version of features that are free in the harness.
3. **No visible artifact of "agentic-ness."** The output is the same generated test files a plain Copilot prompt could produce; the sophistication is buried in server logs. A manager sees credits consumed and files generated — the middle is invisible.

**What is genuinely valuable in the existing investment** (keep all of this):

| Asset | Why it's valuable |
|---|---|
| ~45 `SKILL.md` files under `src/mcp/skills/` | Distilled framework knowledge; maps 1:1 onto Copilot's native skills/instructions format |
| `CSExecutionGate` (compile → run → judge → commit-ready) | Deterministic verification — the thing LLMs can't fake |
| `CSCorrectionMemory` / verified-green patterns | Real learning loop; portable to any harness |
| ADO client + Steps-XML parser + create-back flow (`src/ado`, `CSAdoTestCaseParser`) | The hard deterministic ADO plumbing |
| Migration cache | Replay-instead-of-regenerate = direct credit savings |

**What to retire:** the orchestration shell — `CSIntentRouter`, `CSClarificationAgent`, mode handlers, `CSCopilotDelegate`, the 5-meta-tool agentic engine, playbook/session machinery. The host harness does all of it now, better, at zero token cost.

---

## 2. What the constraints actually allow (researched Aug 2026)

- **Copilot customization is now a full agent platform inside VS Code**: custom agents (`.github/agents/*.agent.md` — works in any workspace folder, *the repo does not need to be hosted on GitHub*), subagents that can invoke subagents, **handoffs** (chained Plan → Implement → Review workflows with pre-filled context), per-session permission levels, Autopilot autonomous sessions, `AGENTS.md`, instructions, prompt files, and skills — all managed via the chat customizations editor.
- **Billing changed June 1, 2026**: request-based billing was replaced by token-based **GitHub AI Credits**. Base models (GPT-5 mini, GPT-4.1, GPT-4o) are **included at no credit cost** on paid plans, and GPT-5.3-Codex runs at 0x. Frontier models (Claude, o-series, etc.) draw down credits by token. → The cost strategy is now *model routing*, not call counting: run high-volume mechanical loops on included models, reserve credit-consuming models for the few genuinely hard steps.
- **Microsoft ships an official Azure DevOps MCP server** (`microsoft/azure-devops-mcp`): local process, PAT auth, tools for work items, test plans, pipelines, repos, wikis. No cloud subscription needed — it's npm + your existing ADO PAT. This replaces most of our custom ADO tool surface for *reading*; our code remains valuable for the write-back paths it doesn't cover well (Steps XML round-trip, result publishing).
- **Copilot CLI is a portable headless agent** — it can run inside an Azure DevOps pipeline job on a self-hosted agent, which is how we get agentic behavior *outside* the IDE without any cloud service.
- **Not available to us:** Copilot cloud coding agent (requires GitHub-hosted repos), Azure AI services (no cloud), direct model API keys.

---

## 3. The pivot: "PTF Autonomous QE" — three layers

One product story: *an autonomous quality engineer that lives in ADO — it picks up a test case or a failing run, produces verified-green automation, and writes the evidence back to ADO with zero human steps in between.* Same vision as today's platform, but the agent loop runs in Copilot's harness (free) and our code contributes only what LLMs can't do: deterministic tools and verification.

### Layer 1 — Copilot-native agent team (weeks 1–2)

Convert the orchestration into declarative Copilot customizations checked into the ADO repo:

```
.github/
  agents/
    ptf-planner.agent.md      # classifies input (TC#/suite/legacy file/doc/NL), asks Tier-1 questions,
                              # produces a generation plan; handoff → ptf-generator
    ptf-generator.agent.md    # writes feature/PO/steps using skills; tools: filesystem + ptf-gate MCP;
                              # handoff → ptf-healer
    ptf-healer.agent.md       # runs execution gate, classifies failure, consults correction memory,
                              # bounded fix loop; handoff → ptf-publisher
    ptf-publisher.agent.md    # ADO create-back + result publish via ADO MCP + ptf tools
  skills/                     # migrated from src/mcp/skills (content is already written!)
  copilot-instructions.md     # framework conventions (from FRAMEWORK-USAGE-GUIDE)
AGENTS.md
```

- The mode table in `agent-platform/README.md` becomes the planner agent's prompt. Clarification tiers become the planner literally asking in chat. The heal loop becomes the healer agent's instructions + the gate tool.
- **Model routing per agent:** planner/publisher → included model (GPT-5 mini / GPT-4.1, zero credits); generator → GPT-5.3-Codex (0x) by default, frontier model only on demand; healer → included model (it mostly runs tools and applies small patches).
- Effort is low because the *content* (skills, prompts, mode logic) already exists — this is a format migration, not a rewrite.

### Layer 2 — Slim deterministic toolserver + official ADO MCP (weeks 2–3)

Strip the MCP server down from "orchestrator with 5 meta-tools" to a **thin tool provider with zero LLM calls**:

- Keep: `compile_check`, `bdd_run_feature`, `commit_ready_check`, `judge`, `correction_memory_query/record`, `migration_cache_*`, `ado_parse_steps_xml`, `ado_create_back`, `ado_publish_results`.
- Delete every code path that calls `sampling.createMessage`. The server never talks to a model again — the *agents* call the tools. Credit burn from the server drops to literally zero.
- Add `microsoft/azure-devops-mcp` alongside it in `.vscode/mcp.json` for work items, test plans, pipelines, wiki reads.

### Layer 3 — The headline demo: closed-loop pipeline healing (weeks 3–5)

This is the "advanced and cutting edge" piece a manager can watch:

1. Nightly ADO pipeline runs the PTF suite (already supported by the framework's ADO publisher).
2. On failure, a pipeline stage on a self-hosted agent invokes **Copilot CLI headless** with the `ptf-healer` agent definition: it pulls the failure evidence (traces, screenshots — the framework already collects these), classifies the failure (locator drift / timing / real regression), and either:
   - **heals**: commits the fix to a `heal/<runId>` branch in the ADO repo and opens an ADO pull request with the before/after evidence attached, or
   - **triages**: files an ADO bug work item with root-cause analysis linked to the test run.
3. Correction memory records every verified-green heal, so repeat failures get cheaper over time.
4. A small ADO dashboard widget (or wiki page the agent updates) shows: runs healed autonomously, credits spent, mean-time-to-green.

Demo script: break a locator in the app under test → pipeline goes red at night → by morning there's a green PR with a trace-backed explanation, and the ADO test case history shows the healed run. Nobody touched a keyboard.

**Stretch (only if Layers 1–3 land):** a tiny VS Code extension using the Language Model API (`vscode.lm`) — a `@ptf` chat participant with `LanguageModelTool`s. It rides the user's Copilot entitlement (no API keys, no cloud) and gives a branded UX; but custom agents likely make this unnecessary, so treat it as optional polish, not core.

---

## 4. Cost governance (the anti-"credit gulping" contract)

1. **No LLM calls from our own code.** All model calls happen in Copilot's harness where the user picks the model and sees the spend. (The one exception, Copilot CLI in the pipeline, is capped per-run.)
2. **Default to included/0x models** (GPT-5 mini, GPT-4.1, GPT-5.3-Codex); frontier models are opt-in per hand-off, never the default.
3. **Cache before generate**: migration cache replays verified-green output for unchanged inputs — keep and surface it ("cache hit: 0 credits").
4. **Report spend as a feature**: the run summary the publisher writes to ADO includes tokens/credits per run — turning cost from an invisible drain into a tracked KPI that trends *down* as correction memory grows.

## 5. Milestones

| Week | Deliverable | Success signal |
|---|---|---|
| 1–2 | Agent team + skills migration; sampling code deleted | TC# → verified-green tests entirely in Copilot chat, on included models |
| 2–3 | Slim toolserver + official ADO MCP wired in `.vscode/mcp.json` | Server makes zero model calls; ADO read/write works end-to-end |
| 3–4 | Pipeline healer stage (Copilot CLI, self-hosted agent) | Seeded locator break → autonomous green PR in ADO |
| 5 | Metrics page + manager demo | Heal rate, credit/run trend, MTTR shown from real nightly runs |

**Risks:** Copilot CLI needs github.com egress from the self-hosted agent (verify with network team — same endpoints VS Code Copilot already uses); org policy may pin which models are enabled (check the Copilot admin model policy before promising 0x models); ADO PAT scopes for work-item write + code write need approval.
