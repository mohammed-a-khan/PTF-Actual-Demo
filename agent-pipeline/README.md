# Agent Pipeline

A drop-in set of GitHub Copilot Agent Mode configuration files for
migrating legacy test suites (Java/Selenium/TestNG/QAF) into a
modern TypeScript test framework. Pure static configuration — no
custom MCP server, no build step, no Node dependencies to install.

Copilot does the work using its own built-in tools plus the
official Playwright MCP server.

## What's in here

```
agent-pipeline/
├── .github/
│   ├── copilot-instructions.md      Global rules Copilot reads
│   ├── instructions/                Folder-scoped rules
│   │   ├── source-legacy.instructions.md
│   │   └── target-generated.instructions.md
│   ├── agents/                      4 agent personas
│   │   ├── planner.md
│   │   ├── analyzer.md
│   │   ├── generator.md
│   │   └── healer.md
│   └── skills/                      19 progressive skill folders
│       ├── page-object-patterns/
│       ├── step-definition-patterns/
│       ├── feature-file-patterns/
│       ├── data-file-patterns/
│       ├── config-patterns/
│       ├── database-query-patterns/
│       ├── helper-patterns/
│       ├── file-download-upload-patterns/
│       ├── browser-navigation-patterns/
│       ├── assertion-patterns/
│       ├── api-testing-patterns/
│       ├── reporting-logging-patterns/
│       ├── authentication-session-patterns/
│       ├── multi-tab-window-patterns/
│       ├── network-mocking-patterns/
│       ├── legacy-source-parsing/
│       ├── locator-reconciliation/
│       ├── audit-rules-reference/
│       └── test-execution-protocol/
├── .vscode/
│   └── mcp.json                     Playwright MCP registration
└── README.md                        This file
```

Total: 26 files. All plain markdown except `.vscode/mcp.json`.

## Install into your test project

1. Copy `.github/` and `.vscode/mcp.json` into your test project's
   root:
   ```
   cp -r agent-pipeline/.github <your-project>/
   cp agent-pipeline/.vscode/mcp.json <your-project>/.vscode/mcp.json
   ```
   (If `<your-project>/.vscode/mcp.json` already exists, merge the
   `playwright` server entry into it instead of overwriting.)

2. Restart VSCode so Copilot picks up the new configuration.

That's it. No `npm install`, no build, no separate MCP server to
register.

## How to use it

1. Open your test project in VSCode.
2. Open Copilot Chat and switch to Agent Mode.
3. In the agent selector, choose `planner` (defined in
   `.github/agents/planner.md`).
4. Type a single sentence:
   ```
   migrate LegacyLoginTest.java
   ```

The planner will:
- Scope the legacy file and its dependencies
- Delegate analysis to the `analyzer` subagent (which reads the
  legacy Java text and reconciles locators against the live app
  via Playwright MCP when reachable)
- Delegate generation to the `generator` subagent (which writes
  target TypeScript files, runs `npx tsc --noEmit` to verify
  compile, and enforces the framework conventions documented in
  the skills)
- Delegate validation and healing to the `healer` subagent
  (which runs the generated tests via `npx eeeeeeeeee-playwright-test`,
  classifies failures, fixes what's safe, escalates what isn't)
- Write a run summary to `.agent-runs/run-summary-<run-id>.md`
  on success, or an escalation report on high-risk failure

The generated TypeScript / feature / JSON files land in the
project's `test/` and `config/` folders. Review them yourself
and take them through your normal commit + review workflow.
**The pipeline does not stage, commit, or push anything.**

## How it works without a custom MCP server

The agents use only:

- **Copilot's built-in tools** — `read_file`, `write_file`,
  `edit_file`, `file_search`, `grep_search`, `run_in_terminal`,
  `runSubagent`. These come with GitHub Copilot Agent Mode.
- **Playwright MCP** — the official Microsoft server registered
  in `.vscode/mcp.json`. Provides live-DOM inspection via
  `playwright_navigate`, `playwright_snapshot_accessibility`,
  etc.
- **Terminal commands** — for compile check (`npx tsc
  --noEmit`), test run (the project's own runner, e.g., `npx
  eeeeeeeeee-playwright-test`), file operations, etc.

For deterministic operations like compile check and test run,
the agents invoke the project's existing CLI tools via
`run_in_terminal`. For pattern references, they read the skill
files directly with `read_file`. No custom code required.

## Requirements in the consumer project

- GitHub Copilot with Agent Mode enabled
- A TypeScript test framework already installed (for the
  generator to produce code against)
- A test runner CLI the healer can invoke via
  `run_in_terminal` (e.g., `eeeeeeeeee-playwright-test`)
- Node.js 20+ (for running `tsc`, `npx`, and the framework
  runner)
- Optionally, the application under test reachable from the
  VDI for live-DOM reconciliation via Playwright MCP

## Skills — progressive loading

The 19 skill folders under `.github/skills/` are standalone
markdown files. Each has YAML frontmatter with a name and
description that Copilot reads to decide which skill to load for
a given task. The body of each skill documents the patterns
agents must follow — page object shape, step definition
conventions, data file rules, database query patterns, helper
class discipline, and so on.

Agents load skills on demand by calling `read_file` on the
specific skill file they need. The planner loads
`legacy-source-parsing/SKILL.md` and
`audit-rules-reference/SKILL.md`; the generator loads the
skills matching the target file types it's producing; the
healer loads `test-execution-protocol/SKILL.md` and
`locator-reconciliation/SKILL.md`.

Progressive loading keeps the context small — agents only read
the skills relevant to the current subtask.

## What makes this different from manual Copilot use

Static `copilot-instructions.md` files by themselves are a
one-shot context dump — they tell Copilot what good code looks
like but don't enforce anything or structure the workflow. This
template adds:

- **Multi-agent delegation via `runSubagent`** — each subagent
  runs in its own isolated context so a 2000-line generated
  file doesn't pollute the main conversation.
- **Layered instructions** — global rules in
  `copilot-instructions.md`, folder-scoped rules in
  `.github/instructions/`, on-demand skills in
  `.github/skills/`. Only what's relevant to the current
  subtask is loaded.
- **Workflow structure** — the planner has an explicit
  sequence (scope → analyze → generate → heal → resolve) so
  Copilot doesn't skip validation steps.
- **Self-healing loop** — the healer runs the tests, classifies
  failures, fixes them, and retries until green or until a
  high-risk issue demands human attention.
- **Optional episodic memory** — the healer appends verified
  fix patterns to `.agent-runs/correction-patterns.md` so future
  runs can reference prior solutions by scanning the file.

All of this is expressed as markdown. Copilot does all the
execution. There is no framework to install or maintain.
