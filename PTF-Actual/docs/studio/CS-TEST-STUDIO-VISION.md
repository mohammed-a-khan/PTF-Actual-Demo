# CS Playwright Test Studio: Vision and Architecture

| | |
|---|---|
| **Status** | Draft for review |
| **Owner** | mohammed-a-khan |
| **Starting point** | `performance-testing-app` (PTF-ADO dump 2026-11-15), evaluated in `reports/perf-app-evaluation/` |
| **Decisions from the owner (2026-11-15)** | **Web app; no code editor required** · **Full access for everyone** · **All capabilities in v1** · **Runs locally on each user's machine (localhost); not hosted** (changed 2026-11-15) |
| **Builds on** | `docs/pdf-engine/DESIGN.md`, `docs/pdf-engine/VERIFICATION-DESIGN.md`, `docs/mcp/MCP-REBUILD-DESIGN.md`, `reports/Copilot chat in custom web UI.md` |

---

## 1. Vision

**One web application where anyone on the team can create, run, debug, analyse and report every kind of test the CS Playwright framework supports, without installing anything or opening a code editor.**

Users sign in with their company account and pick a test project. From there they can do all of the following in the browser:
- record a UI flow;
- edit the generated feature, page object, steps and test data;
- run it on their own machine against any environment (or push it to an ADO pipeline);
- watch it live;
- debug a failure step by step;
- validate API responses, database results and PDF reports;
- load-test the same flow;
- publish results and test cases to Azure DevOps;
- ask an assistant (local, with optional Copilot) for help.

Everything the Studio produces is plain framework code in the team's Git repository. The same tests therefore keep running in CI pipelines with `cs-playwright-test`, and engineers who prefer an IDE can keep using one.

### 1.1 Principles

1. **The framework is the engine; the Studio is the cockpit.** The Studio never re-implements what the framework already does. It drives these existing pieces:
   - the BDD runner;
   - the step catalogue (534 built-in steps);
   - the page registry;
   - config layering;
   - API, DB, report-validation, self-healing and ADO modules.

   This is the same no-duplication rule used for report validation and MCP.
2. **Git is the source of truth.** Test assets live in the project's ADO Git repo, not in a Studio database. The database holds only runs, results, users, audit records and caches.
3. **No editor needed, nothing hidden.** Each asset gets a friendly visual editor. Examples: a step grid for features, an element table for page objects, a spreadsheet for data, forms for config. A code view sits beside it, and both views edit the same file.
4. **Measurements must be trustworthy.** Fix the browser-run measurement first (evaluation §3). A studio that reports a broken page as "PASSED" fails at its core purpose.
5. **Local-first.** Each user runs the Studio on their own machine (`npx cs-test-studio`, localhost only). The team shares work through Git and Azure DevOps. Secrets stay encrypted in the user's profile, test runs are isolated in temp workspaces, and there is a local activity log, with team traceability in ADO.
6. **Everything real: no placeholders, stubs or demo implementations** (owner requirement, 2026-11-15). A capability counts as delivered only when it meets the Definition of Done (§1.2). A button that logs, a metric that is estimated, or a feature that returns sample data is a defect, not a partial delivery. This applies the evaluation's findings, such as `Math.random()` visual diffs and stubbed ADO uploads.
7. **Performance testing at full NeoLoad parity** (owner requirement). Capabilities are checked against a parity catalogue built from NeoLoad's documentation (`research_notes/Test automation studio landscape/neoload_parity_catalog.md`).
8. **Effortless for everyone, including non-technical users** (owner requirement). Every workflow must feel simple:
   - standard industry terms (e.g. Git's branch, commit, push, pull, merge), each with plain-language help next to it;
   - guided steps;
   - safe defaults;
   - visual previews before anything changes;
   - one-click undo;
   - no command-line knowledge needed.

   Power-user detail is always one click away ("Show details"), never in the way. Git is the reference example: standard Git terms, made easy (§2.1).
9. **Cost-aware AI.** The local deterministic assistant is the free default. Copilot is an optional per-user mode, using each person's own seat, under the cost rules in `MCP-REBUILD-DESIGN.md` §2.

### 1.2 Definition of Done (applies to every feature)

A feature is done only when all of the following are true:
1. **It works end to end against real systems.** That means a real browser, real HTTP servers, real databases (SQL Server, PostgreSQL, MySQL, Oracle in CI containers), real PDFs, and a real or high-fidelity ADO fake that follows Microsoft's REST contract. In-process mocks of our own code don't count.
2. **Its accuracy is proven where it measures anything.** Performance, timing and validation features are checked against targets with known behaviour, for example a server with a fixed 100 ms delay or a known error rate. Each check states its allowed tolerance and is part of the test suite. This is how the API engine was verified in the evaluation.
3. **It has no stubs or placeholders:**
   - no functions that only log;
   - no hard-coded or random results;
   - no "planned/no-op" options;
   - no settings that are saved but never used.

   CI fails on markers such as `TODO: implement`, `Math.random()` in result paths, and similar.
4. **It handles errors.** Failures are reported with clear messages, and nothing is skipped silently.
5. **It is reachable and usable from the UI and from the API.** It is documented, and it passes the security review (§4.1).
6. **The build is green.** The project compiles with `tsc`, `vite build` succeeds, all tests pass, and there are no new lint errors.

### 1.3 Dependency policy (owner decision, 2026-11-15)

**Only libraries the framework or the performance app already use are allowed. The approved additions are `@github/copilot-sdk` and `@github/copilot-language-server` (owner, 2026-11-15), plus the system `git` binary. Everything else is built in-house from scratch.** Build-time and developer-only tools are fine.

**Allowed at runtime.** These are already in the framework's or the perf app's `package.json` (PTF-ADO 1.54.0 dump):

| Layer | Allowed packages |
|---|---|
| Framework | `@playwright/test` (includes `playwright`), `@cucumber/cucumber` / `gherkin` / `messages`, `@modelcontextprotocol/sdk`, `zod`, `ws`, `mssql` (+ peers `pg`, `mysql2`, `msnodesqlv8`, `mongodb`, `redis`, `sharp`), `exceljs`, `xlsx`, `csv-parse`, `js-yaml`, `jszip`, `archiver`, `xml2js`, `mammoth`, `pdfjs-dist`, `glob`, `chokidar`, `commander`, `minimist`, `dotenv`, `chalk`, `ora`, `reflect-metadata`, `https-proxy-agent`, `socks-proxy-agent` |
| Studio server (from the perf backend) | `fastify` + `@fastify/{compress,cors,helmet,multipart,rate-limit,static,swagger,swagger-ui}`, `@sinclair/typebox`, `pino`, `date-fns`, `lodash`, `csv-parser`, `csv-writer`, `http-proxy-agent`, `prisma` / `@prisma/client` |
| Studio UI (from the perf frontend) | `react`, `react-dom`, `react-router-dom`, `antd`, `@ant-design/icons`, `recharts`, `zustand`, `dayjs`, `react-markdown`, `react-window`, `jspdf`, `jspdf-autotable` |
| Dev/build only (allowed) | `typescript`, `vite`, `vitest`, `eslint`, `tsx`, `esbuild`, `tailwindcss`, `supertest`, `ts-node` |

**Consequence: these are built in-house** instead of adopting the libraries the market research recommended:

| Capability | Research suggested (not allowed) | In-house design |
|---|---|---|
| Code editor | Monaco, CodeMirror | **CS Code Editor.** A React component over an editable surface. It provides: our own tokenizers/highlighters (TS, Gherkin, JSON, YAML, `.env`, SQL, XML); a virtualised line model for large files; multi-cursor; find/replace; folding; minimap; diff and 3-way merge views. |
| Language intelligence | language servers via monaco-languageclient | **Server-side language service using the TypeScript compiler API** (`typescript`). It covers completions, diagnostics, go-to-definition, references and rename, sent over `ws`. **Gherkin intelligence** comes from `@cucumber/gherkin` plus the framework's step catalogue: step completion, undefined/duplicate steps, go-to-step-definition. JSON/YAML validation uses our own schema checker. |
| Real-time co-editing | Yjs / y-monaco | **Not needed** in the local-first design. Team coordination happens through Git, with ADO-based awareness of other people's unmerged changes (§4). |
| Terminal | xterm.js | **Not offered** inside the Studio. Users already have their own terminal on their machine; the Studio runs tests only through validated framework commands. (This also matches the security model.) |
| Git | isomorphic-git, simple-git | **Our own Git service** that drives the `git` command-line binary through `child_process`. The `git` binary must be installed on the server. **Approved by the owner (2026-11-15).** The service covers status, diff, blame, log, branches, merge-conflict detection, and PRs via ADO REST. |
| PDF parsing | — | **Our own CS PDF Engine** (`docs/pdf-engine/DESIGN.md`), as the owner requested earlier. `pdfjs-dist` remains allowed as a comparison oracle during development. |
| Sign-in to ADO (Entra) | MSAL | **Our own Entra device-code / browser sign-in** for ADO REST, with token cache encrypted via OS protection (§4.1). There is no Studio login (local-first). |
| Remote browser streaming | — | Playwright CDP screencast plus input dispatch over `ws`. |
| Charts and diagrams | — | `recharts` (allowed), plus our own SVG components where it falls short (e.g. waterfall, flame and heat maps). |
| Job queue / scheduler | BullMQ, etc. | **Our own** queue on the Studio database, with leases, retries, priorities and cron-style schedules. |
| Secrets vault | — | **Our own** encrypted store (AES-256-GCM, with a key from an environment variable or the OS keychain). An optional Azure Key Vault adapter uses its REST API through Node `https`. |
| Load-test engine (NeoLoad parity) | k6/JMeter/Gatling | **Our own** engines: the existing API and browser engines, extended. This covers HTTP/1.1 (Node `http`/`https`), HTTP/2 (Node `http2`), WebSocket (`ws`, allowed), SOAP/REST/GraphQL, correlation, variables and distributed load generators over `ws`. |
| Copilot / AI | `@github/copilot-sdk` | **Approved by the owner (2026-11-15)** as the one added dependency. The Studio gets an in-app Copilot agent mode: each user signs in with their own seat, the Studio's tools are exposed to the agent, and actions need approval. The local rule-based assistant stays as the free fallback, and IDE users can still use Copilot via the MCP server. The enterprise "Copilot CLI" policy must be enabled (see the Copilot report's checklist). |

**Effect on effort.** Building the editor, language service, Entra sign-in, local queue and secret store in-house adds roughly **15–22 engineer-weeks** (my estimate) compared with adopting libraries. That is the price of not needing approvals. Everything still has to meet the Definition of Done (§1.2).

### 1.4 Why the Studio and not just VS Code: build with the answer in mind

The owner decided to answer this question publicly **after** the Studio is built. While building, every feature should strengthen the answer:
- **Everyone, not only coders.** Every workflow must be usable by manual and business testers (step grid, guided Git, visual data/config/environment editors).
- **Framework-aware everywhere.** Steps, page objects, data, config and environments are understood, not just edited as text.
- **Test workflows VS Code doesn't have:** run/debug/trace/heal, performance at NeoLoad parity, PDF/DB/API validation, two-way ADO Test Plans sync, pipeline generation, and the AI agent from work item to pipeline.
- **Grounded, verified AI:** Copilot inside the Studio is checked by the framework verifier.
- **No lock-in and no conflict with VS Code:** the same files in the same Git repository, plus the MCP server for VS Code users.

Pilot metrics are collected from S1 so the answer rests on evidence:
- time to automate a story;
- number of non-coders contributing;
- defects found;
- tools and licences replaced.

---

## 2. Who uses it, and how

The owner decided on full access for everyone. Every signed-in user can use every feature. The Studio still records who did what, and it asks for confirmation before destructive or external actions (push to Git, ADO writes, deleting runs).

| Journey | Steps in the Studio |
|---|---|
| **Create a UI test without code** | Projects → New feature → **Record**. A real browser opens on the user's machine (or embedded in the Studio tab), and they click through the app. The Studio produces steps, which the user reviews in the step grid. It reuses built-in steps where it can and adds page-object elements with ranked locators. The user adds assertions with the point-and-click picker, parameterises data in the data grid, then saves to a branch. |
| **Automate an ADO manual test case** | ADO → plan/suite → pick test case → **Automate**. Its steps become a draft feature, linked by `@TestCaseId`. The user records or maps each step, runs it, and publishes it back. |
| **Run and triage** | Select features/tags/environment → Run. A live step timeline shows the browser view, screenshots and console. On failure, the user opens **Debug**: replay the trace, inspect the DOM and network, see the healing suggestion and similar past fixes. They can fix the step and rerun only the failed scenarios. |
| **API test** | API workspace → request builder (method, URL, headers, auth, body, variables) → Send → add assertions from the response tree → **Save as scenario**. This generates framework API steps. |
| **DB validation** | DB workspace → pick connection alias (from config) → query or stored procedure with parameters → result grid → **Save as validation**. This generates DB steps, or the expected data for a PDF check. |
| **PDF/report validation** | Upload or fetch the PDF → **PDF viewer with the extracted model overlaid** (fields, tables, sections) → bind expected data (manual, file, or DB query/procedure) → Validate → findings highlighted on the page → **Save as scenario** (uses `verifyPdf` / the report-validation steps). |
| **Performance** | Pick a scenario → load profile → run on load agents → live monitor → results, baselines, SLOs, trends. This is the current app, with the measurement fixes. |
| **Report and publish** | Run history, framework HTML reports, trends, flaky tests and failure clusters → publish results to an ADO test run → file a bug with evidence, previewed before submission. |
| **Ask for help** | Assistant panel on every page. The local assistant answers from real data. "Ask Copilot" sends a question to the user's own Copilot seat, with Studio tools available. |

### 2.1 Git made easy: the reference for ease of use

**Goal:** everyone uses **real Git with its standard names**: branch, commit, push, pull, merge, pull request, conflict, history, revert. Each action is **so guided that a non-technical tester can do it confidently**. Nothing is renamed or hidden. People learn the same words they will see in ADO, an IDE or CI, and the Studio makes each one a single, safe click with a plain explanation beside it. Underneath, every action is real Git on the team's ADO repository (the system `git` binary plus ADO REST).

**Every Git action, with guidance built in:**

| Git action (standard name on the button) | Help shown next to it (one line, plus "Learn more") | How the Studio makes it easy |
|---|---|---|
| **Branch** (create / switch) | "A branch is your own copy of the tests to work on, without affecting anyone else." | One-click **New branch** with a suggested name (`feature/login-tests`), always based on the latest `main`. The current branch is always visible in the header. Uncommitted changes go with you safely when you switch, or you are asked first. |
| **Changes** (working changes) | "Edits you have made since your last commit." | A live list grouped by test asset (feature, page object, data, config), each with a visual diff. Draft edits are auto-saved on the server, so nothing is lost if the browser closes. |
| **Stage** (optional) | "Choose which changes go into the next commit." | Checkboxes per file or scenario. Everything is selected by default, so beginners can ignore it. |
| **Commit** | "Saves a snapshot of your selected changes with a message, on your branch." | A commit message is **suggested from the actual changes** (e.g. "Add 2 steps to *Checkout* scenario; update login locator") and can be edited. Before committing, quick checks run: syntax, undefined steps, and secrets. |
| **Push** | "Sends your commits to the shared ADO repository so others can see them." | One click. If the server has newer commits, the Studio offers to **Pull first** and explains why. Force-push is never offered. |
| **Pull** | "Brings the latest commits from the shared repository into your branch." | One click, merge-based by default. The Studio shows **what will come in** (who changed what) before applying it. |
| **Fetch / Sync** | "Checks for new commits on the server without changing your work." | Runs automatically in the background. A badge shows "3 new commits on `main`". **Sync** = pull + push in one guided step. |
| **Merge** | "Combines another branch's commits into yours." | Pick a branch, see a preview of the incoming changes and of any likely conflicts, then confirm. A restore point is created first. |
| **Pull request** (create / review / complete) | "Asks the team to review your branch and merge it into `main`." | A pull request is created in ADO with a generated title and description, linked work items and the latest test-run result. Reviewers, comments, approvals and policy status are shown in the Studio. **Complete** respects ADO branch policies. |
| **Conflict** (resolve) | "You and someone else changed the same part. Choose what to keep." | A guided resolver (below), with a progress bar ("2 of 3 conflicts resolved"). |
| **History / Log** | "Every commit on this branch: who, when, and what changed." | A readable timeline with visual diffs per commit, a filter by file, scenario or author, and a graph view. |
| **Blame** | "Who last changed each line or step, and in which commit." | Shown inline in the editors (step grid and code view). |
| **Revert / Restore** | "Undo a commit by adding a new one that reverses it, or bring back an older version of a file." | Previewed first, one click to apply. Discarded uncommitted changes are kept in a **30-day recovery bin**. |
| **Stash** | "Put unfinished changes aside temporarily." | Offered automatically when switching branches or pulling with uncommitted work, then re-applied with one click. |
| **Tag, cherry-pick, rebase** | Explained in plain words. | Available in an **Advanced** menu for experienced users, each with a preview and a restore point. Rebase is never forced on anyone. |

**Diffs that read like test changes.** Every diff uses the same view as the editor:
- **Feature files:** a step-grid diff. Added steps are green, removed steps red, and changed steps show old and new values inline. Tag and Examples-table changes appear as table diffs.
- **Page objects:** an element-table diff ("Login button: locator `#login` → `[data-testid=login]`").
- **Test data (Excel/CSV/JSON):** a spreadsheet diff with highlighted cells.
- **Config/environments:** a key/value diff; secret values are never shown.
- **Code:** a side-by-side or inline text diff in the CS Code Editor.

Users can switch to a plain line-by-line diff at any time.

**Conflicts: prevented, auto-resolved where safe, guided where not:**

1. **Prevent.**
   - Awareness from ADO shows who else has unmerged work on the same file ("Ravi has unmerged changes to *Checkout.feature* on branch `feature/checkout`, PR !418").
   - A warning appears before editing the same scenario.
   - A **Pull** is suggested as soon as `main` gets new commits.
2. **Smart merge by structure.** The Studio understands its file types, so it merges features by scenario and step, page objects by element, and data files by row and cell. Two people adding different scenarios or elements to the same file then **don't produce a conflict at all**. These are still ordinary Git merges and commits; only the conflict calculation is smarter.
3. **Guided resolution.** For each real conflict the Studio shows **Yours (your branch)**, **Theirs (`main`, Ravi, 2 hours ago)** and **Result**, with buttons **Accept yours / Accept theirs / Accept both / Edit**. These appear in the same visual editor (step grid, element table, data grid), with a 3-way text view always available. The user can **run the affected tests** before committing the merge. "Abort merge" is always one click away.
4. **Always reversible.** Every merge and pull creates a restore point, so "Undo merge" is one click.

**Built-in safety:**
- No force-push.
- `main` is protected by ADO branch policies.
- Every push and pull request shows pre-checks: does it compile, are any steps undefined, do the changed scenarios pass.
- Secrets are caught before they are committed: the secret scanner stops the commit, offers one-click fixes (move to the secret store and use a reference), and allows an override with a recorded reason (§2.6).

**Learning built in.** Each Git action has a "What does this do?" link with a short animation or diagram. Optional coach marks guide first-time users through branch → commit → push → pull request.

**Done means real (§1.2).** Each Git flow is acceptance-tested against a real repository with real concurrent edits:
- structure-aware merges;
- guided conflicts;
- revert and restore;
- stash;
- pull requests on ADO or the high-fidelity ADO fake.

The same approach (standard terms, plain help, previews, one-click undo, guided steps) applies across the Studio: running tests, the recorder, ADO publishing, performance profiles and PDF validation.

### 2.2 Test data: every capability the framework supports, usable from the UI

The Studio exposes **all** of today's test-data features, so nobody has to remember syntax. The **Test data workspace** has:

| Framework capability (today) | Studio UI |
|---|---|
| **Sources:** Excel `.xlsx`/`.xls` (sheets), CSV, JSON (with JSONPath `$.…`), XML (flattened), database (`db:` / connection alias + query or stored procedure), API (`api:` endpoint), generated rows (`generate:N:field=type,…`) | **Data source picker** with a live preview grid of the rows the framework will actually load. Each source has a form (file and sheet, JSONPath, DB alias + query/procedure + params, API endpoint + auth, generator fields). |
| **Filters** (`;` / `&` / `AND`, `\|` / `OR`, operators `= != <> > < >= <= ~ :`) | **Visual filter builder** (column, operator, value, AND/OR groups). It writes the exact filter string and shows how many rows match. |
| **Transform, randomize, limit**, Excel formulas (`=SUM`, `=CONCAT`, `=IF`) | Toggles and fields; formulas are evaluated in the preview. |
| **Dynamic placeholders:** `<random>`, `<timestamp>`, `<uuid>`, `<config:KEY>`, `<env:KEY>`, `<generate:type>`, `<date:FMT>` | **Insert-placeholder menu** in any cell. The preview shows a sample resolved value, and also shows that the value changes per run. |
| **Generators** (`CSDataGenerator`: person, address, company, product, credit card, email, phone, username, password, UUID, dates, numbers, text, URLs, files, templates `{{category.method}}`, bulk data, seed) | **Generate data** dialog: pick fields and generator types, row count and seed, then preview and save as CSV/Excel/JSON in the project. |
| **Encrypted values** (`ENCRYPTED:`) | **Secret cells**: the value is stored encrypted, shown masked, and only revealed to permitted users. Plain-text secrets are flagged before commit. |
| **Use in tests:** `Examples` tables, JSON `Examples` (`{"type":"excel","source":…}`), `@DataProvider(source=…, type=…, sheet=…, filter=…)` on scenarios/features, spec `dataSource`, iteration naming | **Bind data to a scenario** from the step grid: choose source + filter, and the Studio writes the correct tag or Examples form. The run view shows one row per iteration, with the data used. |
| **Step values:** `{config:K}`, `{env:K}`, `{scenario:x}`, `{context:var.field}`, `{{var}}`, `$var`, `<column>` | **Autocomplete** in the step grid and code editor, with hover showing the resolved value for the selected environment. |
| **File lookup** (cwd, `test/data`, `test/{project}/data`, `{env}` substitution) | The file picker only offers paths the framework will resolve, and shows which environment file wins. |
| **Editing data files** | Spreadsheet editor for Excel/CSV/JSON/XML. It keeps multiple sheets, types and formulas, and supports sort/filter, find/replace, bulk edit, import/export and cell-level Git diffs and merges (§2.1). |

**Done means real (§1.2).** For every source, filter and placeholder, the Studio's preview must return the same rows and values as the framework at run time. A golden test checks this for each one.

### 2.3 Advanced coding with GitHub Copilot inside the Studio (owner requirement)

Real automation is not only record-and-playback. Scripts contain custom logic: helpers, page-object methods, conditional flows, API/DB orchestration, data shaping, retries and custom assertions. **The Studio must be a full coding environment for this, with GitHub Copilot working the way it does in VS Code.**

**Coding features** (CS Code Editor + in-house TypeScript language service, §1.3):
- **Files:** a multi-file project explorer; tabs and split views; find/replace across files.
- **Code intelligence:** IntelliSense for the framework's API (`CSBasePage`, `CSWebElement`, `CSBDDStepDef`, the `CSDBUtils`/API clients, …). This covers completions, signature help, hover docs, go-to-definition, find references, rename/refactor across files, and live type errors and lint warnings.
- **Framework-aware help:** snippets and templates (page object, step class, hooks, custom helper, data-driven step), plus quick fixes (e.g. "create missing step definition", "add element to page object").
- **Debugging** with the Node inspector protocol (built into Node, no new library): breakpoints in step definitions and helpers, step over/into, variables, watch, call stack and a debug console. Playwright's browser view and trace are linked to the same paused step.
- **Gherkin ↔ code links:** run or debug a single scenario from the code; navigate between a Gherkin step and its definition.

**Copilot in the editor, with VS Code-style control:**

| Capability | Behaviour in the Studio |
|---|---|
| **Inline suggestions** (ghost text) | Suggestions appear as you type. Tab accepts, Esc dismisses, and you can accept word by word. They use the user's own Copilot seat. |
| **Chat** (side panel) | Ask questions about the project. The current file, selection, failing run and step catalogue are attached as context. |
| **Edit mode** | Describe a change, and Copilot proposes edits across one or more files. Each change shows as an **inline diff with per-change Keep / Undo**, plus **Keep all / Undo all** per file and for the whole request. |
| **Agent mode** | Copilot plans and performs multi-step work using Studio tools: read files, search, edit, run tests, read results, fix and rerun. Every tool call is visible. Write actions follow the approval rules, and **the Stop button cancels the action immediately**; edits made so far stay as reviewable changes. |
| **Checkpoints** | Each request creates a restore point, so you can roll back to before Copilot's changes in one click. |
| **Framework style** | Copilot gets the project's instructions (`.github/copilot-instructions.md`), the framework conventions and the step catalogue. Generated code is checked by the same verifier as the AI agent: it must compile, use no undefined steps, reuse existing steps and keep its assertions. Violations are shown before you keep the edit. |
| **Nothing silently committed** | Copilot's edits are ordinary working changes. They appear in Git → Changes (§2.1) and are only committed when the user commits them. |

**Dependencies.** Chat, edit and agent modes use `@github/copilot-sdk` (approved). **Inline ghost-text completions** use GitHub's `@github/copilot-language-server` (MIT, npm). **Approved by the owner (2026-11-15).** It runs once per user, on the user's machine, signed in with their own Copilot seat. Each user signs in with their own Copilot seat; the enterprise Copilot policies apply.

### 2.4 AI QA agent: from ADO work item to a pipeline running in ADO (owner requirement)

**Goal.** A user points the Studio at ADO work items, bugs and code. An AI agent then:
1. **understands** what needs testing;
2. **opens a real browser** and checks the functionality;
3. **writes real framework tests**: features, page objects, steps and data;
4. **verifies** them by running and healing;
5. **publishes** them to Git and ADO Test Plans;
6. **creates and runs the ADO pipeline** that executes them.

The user stays in control through simple approval points.

**Engine.** The agent runs on the Copilot SDK (approved, §1.3), using **each user's own Copilot seat**. It calls **Studio tools only**. Every tool is deterministic server code built on the framework and ADO kernel: no shell, and no direct file system outside the user's workspace. Guardrails are enforced in the server, so they hold even when actions are auto-approved (as in `MCP-REBUILD-DESIGN.md` §7). The same tools are exposed through the MCP server, so the flow can also be driven from Copilot in an IDE.

| Stage | What the agent does (real, with tools) | Tools / framework parts | User touchpoint |
|---|---|---|---|
| **1. Gather context** | Pulls the selected **user stories, acceptance criteria, bugs** (repro steps, attachments, comments), **linked test cases**, and **linked commits/PRs**. Reads the **relevant code from ADO Repos**: changed files and the diff, routes, UI components, API specs. Also checks for **existing automated tests** that already cover the item. | ADO kernel: work items, WIQL, test plans, Git REST for files, diffs and PR changes, code search. Framework catalogue and `ptf_catalog` coverage | Pick work items, or a query/sprint/area |
| **2. Plan** | Writes a short **test plan**: scenarios, positive and negative cases, data, environments. Duplicates of existing coverage are marked "already covered". Bugs get a **reproduction plan**. | Plan file in the workspace (`plans/<item>.md`) | **Approve plan** (edit if needed) |
| **3. Explore in a real browser** | Opens the app in a real browser on the user's machine (watchable live), signing in with the environment's test account from the secrets store. It follows the plan, observes behaviour, captures accessibility snapshots, screenshots and network calls, and picks stable locators. For bugs, it **tries to reproduce** and records evidence. | Remote browser session (Playwright, §4); locator ranking; network capture | Optionally watch live in the Studio |
| **4. Write the tests** | Creates or updates **features (Gherkin), page objects, step definitions and test data**. It **reuses the 534 built-in steps and existing project steps first**, adds new steps only where needed, and tags the work item (`@TestCaseId`, `@Bug-<id>`, `@Story-<id>`). | Framework codegen pipeline (upgraded); step catalogue; CS Code Editor files | Review the diff in the visual editors (§2.1) |
| **5. Verify and heal** | Runs the new tests locally (or on a remote agent). On failure it diagnoses (locator / timing / data / environment / **real app bug**), fixes and reruns, up to a capped number of attempts. It **never weakens assertions**, which the server checks. A genuine app defect is reported as a **bug finding**, not hidden. | Runner, `ptf_verify`, `ptf_diagnose`, healing engine, fix history | See the results; accept the fixes |
| **6. Publish** | **Commits and pushes** to a branch and opens an ADO **pull request** with a generated description, evidence and run results. It **creates or updates ADO test cases** from the scenarios (steps included), syncs `@TestCaseId`, places them in the right **suite**, links them to the story/bug, and (if asked) **files new bugs** for real defects with screenshots and trace. | Git service; ADO kernel plan → apply (previewed, no duplicates) | **Approve the ADO changes** (exact preview) |
| **7. Create and run the pipeline** | Generates `azure-pipelines.yml` (or adds a stage to an existing one) from the team's **existing `ADO-Pipeline-Templates/ado-playwright-shared` templates**, with the right project, environment, tags, browsers, parallelism and secrets via ADO variable groups. It **creates the pipeline definition** through the ADO Pipelines REST API, **queues a run**, follows it live, and **publishes results to the ADO Test Plan run** and the linked work items. | ADO Pipelines REST: create, run, logs, artifacts; framework ADO result publishing | **Approve the pipeline creation**; choose triggers (on PR / nightly / manual) |
| **8. Report back** | Posts a summary to the work item and the PR, and optionally Teams via Workflows. It records what was learned (selectors, flaky spots) for future runs. | ADO comments; fix history; Teams Workflows webhook | Read the summary |

**Ways to start it:**
- From an ADO work item in the Studio (**"Automate with AI"**).
- From a bug (**"Reproduce and add a regression test"**).
- From a sprint or query (**"Cover the sprint's stories"**). For this one, the agent processes the items one by one and shows a progress board.
- From an IDE through MCP.

**Safety and control:**
- **Approval points.** Writes to Git, ADO test cases, bugs and pipelines go through the plan → preview → approve gate. Nothing external changes without the user approving the exact preview.
- **Grounding and prompt-injection defence.** Content pulled from work items, code and web pages is treated as **untrusted data**: it can never trigger tools or URLs by itself.
- **Secrets.** Test-account passwords are injected only into the browser session and never reach the model.
- **Access.** The agent can only reach hosts on the admin-managed allowlist of environments (SSRF guard).
- **Cost limits.** Each task has a credit cap (`sessionLimits.maxAiCredits`). Routine steps use cheaper models. Deterministic work (running, verifying, publishing) costs no model tokens. The Studio shows credits used per task.

**Done means real (§1.2).** The full flow is acceptance-tested end to end:
- Story → plan → browser exploration → tests that pass against a real sample app.
- PR → ADO test cases with no duplicates on repeat → pipeline created and run → results in the Test Plan.

These tests run against a real ADO project, the owner's `myproject` sandbox plan if approved, and in CI against the high-fidelity ADO fake. AI output is judged by objective checks: tests compile, pass, reuse existing steps, and have no weakened assertions. A self-assessment by the AI doesn't count.

### 2.5 Environments: every angle (owner requirement)

"Environment" means four different things in this Studio, and all four are covered:
- **A.** The framework's test environments: dev, QA, UAT, prod and custom.
- **B.** The user's own machine setup.
- **C.** What exactly a single run uses.
- **D.** Environments in ADO pipelines.

Safety (E) and ease of use (F) apply to all four.

#### A. Test environments (framework config)

The framework's config layering stays the single source of truth (`CSConfigurationManager`). It loads these layers, later ones winning:

1. `config/global.env`
2. `config/common/*.env`
3. `config/common/environments/<env>.env`
4. `config/<project>/common/*.env`
5. `config/<project>/*.env`
6. `config/<project>/environments/<env>.env`
7. `process.env`
8. CLI arguments

Interpolation and `ENCRYPTED:` decryption are applied on top. The Studio makes all of this visible and safe:

| Capability | What the user gets |
|---|---|
| **Environment switcher** | Always visible in the header: `Project · Environment`. It drives runs, data previews, the API/DB workspaces, step-value hovers and the AI agent. |
| **Effective config view** | Every key with its **final value and where it came from**: which file and layer, or `process.env`, or the command line. Overridden values are shown greyed with the winner marked. This makes problems like "Windows `USERNAME` silently overrides `USERNAME` in the .env" visible (a known framework behaviour, flagged by the Studio). |
| **Create / clone / rename / delete environment** | A wizard copies an existing environment, asks only for the values that differ (base URL, DB host, API base, test accounts) and writes the right files in the right layer. |
| **Compare environments** | Side-by-side diff of QA vs UAT vs prod: keys missing in one, values that differ, and secrets compared by presence only. |
| **Required-keys check** | The Studio scans features, steps, page objects and data for keys used (`{config:K}`, `{env:K}`, `<config:K>`, `DB_<ALIAS>_*`, `ADO_*`, …). It lists **keys missing in the selected environment** before a run fails. |
| **Interpolation preview** | Shows the resolved value of `{KEY}`, `${VAR:-default}`, `{env:X}`, `<random>` and similar. The framework's interpolation defects found in review (`${KEY}` → `$value`, `{{config:K}}` → `{value}`, ternary false branch, `<word>` losing brackets) are **fixed in the framework first**, so the preview and real runs agree. |
| **Connection tests** | One click per environment checks: base URL reachable (status, TLS certificate and expiry), login with the test account works, each `DB_<ALIAS>` connects (SQL/Windows auth, `msnodesqlv8` ODBC driver present), API auth succeeds, and ADO is reachable. |
| **Environment health board** | The results of the connection tests over time, plus app version/build detected (from a configurable endpoint or page), so a failing run can be told apart from a broken environment. |
| **Secrets per environment** | Passwords, tokens and certificates are stored encrypted (DPAPI/keychain, §4.1) and referenced by name in config. Values are never written to Git. The old `ENCRYPTED:` values (hard-coded key) can be migrated with one click. |
| **Personal vs team values** | **Team values** live in the committed `.env` files. **Personal values** (the user's own test account, a local URL, a debug flag) go in a git-ignored local override layer. That layer is applied last before `process.env`, and the effective view always labels it. |
| **Test accounts by role** | A table per environment: role (buyer, admin, approver …), username, a secret reference, notes. Steps refer to the role. The AI agent signs in with the role's account without ever seeing the password. |
| **Environment-specific data** | `{env}` file substitution and per-environment data folders are shown in the data workspace (§2.2), with a warning when a data file is missing for the selected environment. |
| **Browser, proxy and network per environment** | Default browser/device, viewport, locale/time zone, proxy settings, client certificates, extra headers and network profile, editable as forms that write the existing config keys. |
| **Mocks and stubs** | Per-environment network mocks and route blocks using the framework's network interceptor, e.g. stubbing a third-party payment service in QA. They are clearly labelled in runs. |
| **Validation on save** | Unknown keys (likely typos), invalid values (URL, number, boolean), duplicate keys across layers and plain-text secrets are flagged before commit. |
| **History** | Every config change is an ordinary Git change with a readable diff (§2.1), so "who changed the QA DB host and when" is answered by History/Blame. |

#### B. The user's machine (onboarding and health)

| Capability | What the user gets |
|---|---|
| **First-run setup wizard** | Checks and guides, in plain language: <br>• Node version (the supported LTS) <br>• Git for Windows and Git Credential Manager <br>• Playwright browsers (download via the corporate proxy or an internal mirror) <br>• access to the Azure Artifacts feed (per-user credentials, **never** a committed `.npmrc` password) <br>• corporate proxy and root certificates (`NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`) <br>• ODBC Driver for SQL Server when Windows auth is used <br>• disk space <br>• ADO sign-in <br>• Copilot sign-in |
| **Projects** | Clone an ADO repo or open an existing local folder. Run `npm install` with progress and readable errors. Detect the framework version and check that it is compatible with this Studio version. |
| **Doctor page** | A permanent health check of all of the above with **Fix** buttons (install browsers, set the proxy, re-authenticate, repair dependencies). Results can be copied for support. |
| **Updates** | Notice of new Studio and framework versions, with release notes. Projects keep their pinned framework version until the user chooses to upgrade, using an upgrade assistant that runs the project's tests before and after. |
| **Resources** | Machine CPU/RAM shown in the Runs and Performance areas, with a warning before starting a load that the machine cannot generate reliably, pointing to remote load agents. |

#### C. What a run uses (reproducibility)

| Capability | What the user gets |
|---|---|
| **Run configurations** | Saved combinations of environment, tags/features, browser/device, workers, retries, data set, mocks and extra variables, like VS Code's `launch.json`. Stored in the project, so the team shares them. |
| **Per-run overrides** | Change any value for one run without editing files. Overrides are shown on the run. |
| **Run fingerprint** | Every run records: commit SHA and branch, uncommitted changes (yes/no + diff), framework, Studio, Node and browser versions, environment name, the **effective non-secret config** (secrets recorded only as "set/not set" plus a hash), data source and filter, and machine name. "It passed yesterday" questions can be answered precisely. |
| **Rerun exactly** | Rerun with the same fingerprint, or rerun on the current code against the same environment. |

#### D. Environments in ADO pipelines

| Capability | What the user gets |
|---|---|
| **Same environment names locally and in CI** | The generated pipeline (§2.4) uses the same environment name. Pipeline stages map to environments (QA stage → `qa`). |
| **Secrets in CI** | The Studio creates or updates an **ADO variable group** per environment, with **names only**; values are entered once by the user in ADO or linked to Azure Key Vault. Client certificates go to ADO **secure files**. The Studio checks that the variable group has every key the environment needs. |
| **Drift check** | Warns when the local environment and the pipeline's variable group disagree, e.g. a key added locally but not in CI. |
| **ADO environments and approvals** | Optional mapping to ADO Environments, so pipeline runs against UAT/prod can require approvals. |

#### E. Safety

- **Protected environments:**
  - Environments can be marked **protected**, prod by default.
  - Running against them needs an explicit confirmation.
  - Load and stress tests against protected environments are **blocked unless a policy allows them**.
  - The AI agent can only use environments on the allowed list.
- **No secrets in Git:** the commit check stops plain-text secrets in `.env`, data and code. It offers one-click fixes (replace the value with a secret reference) or an override with a recorded reason (§2.6).
- **Least exposure:** secrets are decrypted only inside the test process that needs them, and are redacted from logs, reports, screenshots of config pages and AI context.

#### F. Ease of use

- **Plain language, forms first:** "Base URL", "Database for orders", "Buyer test account", with the real key name (`BASE_URL`, `DB_ORDERS_HOST`, …) always shown next to it and a code view one click away.
- **Wizards:** "Add an environment", "Add a database connection", "Add a test account", "Set up CI for this environment".
- **Clear errors that link to the fix:** a run that fails because of configuration says so ("`DB_ORDERS_HOST` is missing in UAT") and links to the field to fill in.

**Done means real (§1.2).** For every environment, the effective-config view, the required-keys check and the connection tests must agree with what the framework actually does at run time. Golden tests cover every layer, override and interpolation form. Variable-group sync is tested against a real or high-fidelity ADO.

### 2.6 Secret management and pre-commit secret scanning (owner requirement)

**Goal:**
- Secrets (passwords, tokens, keys, certificates, connection strings) are easy to store and use, and never end up in Git by accident.
- Before every commit the Studio scans the changes.
- If it finds a secret, it **stops the commit** and helps the user fix it.
- The user can also **override the block and commit anyway**, with a reason that is recorded.

#### A. Secret store

| Capability | Design |
|---|---|
| **Where secrets live** | In the user's local Studio secret store, encrypted with the OS: **Windows DPAPI** (via built-in PowerShell), or the macOS/Linux keychain CLI, falling back to AES-256-GCM with a key in the user profile. Nothing is stored in plain text, and nothing goes into the repository. |
| **Scopes** | **Personal** (only this user, e.g. their own test account) or **project + environment** (e.g. `payments-web-tests / QA / DB_ORDERS_PASSWORD`). |
| **How tests use them** | Config, data and steps hold a **reference**, never the value. For example `DB_ORDERS_PASSWORD={env:QA_DB_ORDERS_PASSWORD}`. **No framework change is needed:** the framework already resolves `{env:NAME}` in config values and step text (verified in `CSConfigurationManager.interpolate`, lines 268–314, and `CSBDDRunner` line 2752). The Studio puts the value into that environment variable. Locally the Studio injects the value only into the test process. **In ADO pipelines the same name comes from the environment's variable group** (§2.5 D), so the same files work in both places. |
| **Optional team vault** | If the team has **Azure Key Vault**, secrets can be read from it with the user's own Entra sign-in (REST over Node `https`, in-house). Then team members don't each type them in. Without a vault, each user enters their values once, and the Studio lists the **missing secrets** for the selected environment. |
| **Managing secrets** | A Secrets page per environment shows: name, scope, set / not set, last updated and where it is used (files, lines, steps). Values are hidden. Reveal and copy are allowed only to the owner, after OS re-authentication where supported. Users can rename secrets (references are updated across the project), rotate (new value, with a reminder of where else it must change: the ADO variable group, other machines) and delete. |
| **Legacy values** | Existing `ENCRYPTED:` values use the framework's hard-coded key, so they are effectively plain text. The Studio finds them, migrates each to the store, and replaces it with an `{env:…}` reference in one guided step. |
| **Never leaked at run time** | Values are redacted from logs, reports, run fingerprints (hash only), screenshots of config pages, AI/Copilot context and error messages. Recorded passwords in scenarios are replaced with references automatically. This fixes the plain-text recorded passwords found in the evaluation. |

#### B. Secret scanner (built in-house, no third-party tool)

**What it detects:**
- **Known secret values.** Every value in the user's secret store is matched exactly against the changes (as a hash). This is the strongest check: it catches *your* real password even if it looks harmless.
- **Known token formats:**
  - Azure DevOps PATs;
  - GitHub tokens (`ghp_`, `gho_`, `ghu_`, `github_pat_`);
  - Azure storage and service-bus keys;
  - AWS access keys;
  - JWTs;
  - private keys (`-----BEGIN … PRIVATE KEY-----`);
  - `.npmrc` `_authToken` / `_password` (it would have caught the committed `.npmrc` password found in the review);
  - basic-auth credentials in URLs;
  - connection strings with `Password=` / `Pwd=`;
  - Slack/Teams webhook URLs.
- **Risky assignments.** High-entropy values assigned to names like `password`, `pwd`, `secret`, `token`, `apikey` or `client_secret`, in `.env`, code, JSON/YAML, Gherkin steps and data cells. Excel cells are read with `exceljs`, which is already allowed.
- **Risky files:**
  - certificates and key files (`.pfx`, `.p12`, `.pem`, `.key`);
  - HAR or trace files and `storageState` session files (they contain cookies and tokens);
  - a `.env` that should be git-ignored.

**When it runs:**
- **Before every commit in the Studio.** It scans only the staged changes, so it is fast (target under 1 s for typical commits).
- **Before every push.** It re-scans the commits being pushed, including commits made outside the Studio.
- **Optional Git hook.** The Studio can install a `pre-commit` hook (`npx cs-test-studio scan --staged`), so commits from VS Code or the command line are scanned the same way. The user sees the same choices in the terminal.
- **First open of a repository.** It does a one-time scan of the current files and history and reports secrets that are already committed, with rotation guidance (see D).

#### C. The block: stop, explain, help fix, or override

When the scanner finds something, **the commit does not happen**. The user sees a clear dialog:

> **Commit stopped: 2 possible secrets found**
> Committing these would make them visible to everyone with access to the repository, permanently, even if deleted later.

Each finding shows:
- file and line (or sheet/cell);
- type (e.g. "Azure DevOps personal access token");
- a **masked preview** (`ab••••••••yz`);
- confidence (High / Medium);
- the reason it was flagged.

Each finding offers **one-click actions:**

| Action | What it does |
|---|---|
| **Move to secret store and use a reference** (recommended) | Saves the value encrypted under a suggested name and environment, and replaces it in the file with `{env:NAME}`; in TypeScript/JavaScript the quoted literal becomes `(process.env.NAME ?? '')`. Re-stages the file. |
| **Remove it** | Deletes the value or line from the file. |
| **Unstage this file** / **Add to .gitignore** | For files that should never be committed (`.env.local`, `.pfx`, `storageState.json`). |
| **Not a secret** | Marks a false positive. A fingerprint (hash, never the value) is saved to the project's allowlist (`.cs-studio/secret-allowlist.json`), so it is not flagged again. The whole team benefits once it is committed. |

At the bottom of the dialog:

- **Fix all (recommended actions)**: applies the recommended fix to every finding, then shows the commit again.
- **Cancel commit.**
- **Override and commit anyway.** This needs:
  1. a short **reason** typed by the user (e.g. "test-only dummy key, not real");
  2. a final confirmation that names exactly what is being committed.

  The override is **recorded** in three places:
  - the local activity log (who, when, which file, which finding type, the reason; never the value);
  - a commit-message trailer (`Secret-Scan-Override: <reason>`), so the team sees it in ADO and in review;
  - optionally, a comment on the pull request when it is opened.

**Push re-check.** If an overridden commit is about to be pushed, the push dialog reminds the user once more ("This push contains a commit with a secret-scan override") with **Push anyway** / **Cancel**.

**Team policy.** By default **override is allowed** (owner decision). A project policy file (`.cs-studio/policy.json`) can change this per project, for example "no override for High-confidence findings" or "no override on `main`". The Studio always shows which policy applies.

#### D. If a secret has already been pushed

- The Studio says plainly: **deleting it now is not enough. Rotate the secret.**
- It shows a rotation checklist:
  1. revoke or regenerate the value in its system (e.g. the ADO PAT page);
  2. update the Studio secret store;
  3. update the ADO variable group;
  4. tell the team.
- It offers to replace the value with a reference in the current files.
- History rewriting is **never done automatically**, because it breaks other people's clones. Instructions are provided for an admin if the team decides to do it.

#### E. Done means real (§1.2)

- **Detection.** A test corpus of realistic but fake secrets, one per supported type and file format (including Excel cells and `.npmrc`), must all be detected.
- **False positives.** The false-positive rate is measured on the framework repositories and must be under an agreed threshold. The scanner must detect the real `.npmrc` credential found in the review.
- **Every action works end to end against a real Git repository:** each fix action, the override with its trailer, the push re-check, the hook from VS Code and the allowlist.
- **Secret values never appear** in the activity log, telemetry, reports or AI context. A test checks this by searching all outputs for planted values.

---

## 3. Capability map

| Area | v1 capability | Reuses |
|---|---|---|
| **Workspace** | Projects bound to ADO Git repos; branch per user/task; file tree; diff; commit and push; create PR; pull with conflict guidance | ADO REST (Git, PRs) through the shared ADO kernel |
| **Feature editor** | Gherkin step grid and code view; step autocomplete from the catalogue (built-in and project steps); undefined/duplicate step detection; Scenario Outline / Examples / `@DataProvider` editor; tags | `CSStepPatternScanner`, `CSStepValidator`, BDD parser |
| **Page objects and locators** | Element table (name, strategies, alternatives, `selfHeal`); live locator check against a page; locator quality score | `CSPageRegistry`, `CSLocatorLinter`, recorder selector ranking |
| **Step definitions** | Browse built-in steps with docs and examples; create custom steps from templates (code view) | step catalogue, codegen templates |
| **Test data** | Spreadsheet editor for Excel/CSV/JSON; data-source preview with filters; DB-backed data preview | `CSDataProvider` |
| **Config and environments** | Layered `.env` view (global → project → environment), showing where each effective value comes from; secrets entered as references, never as values | `CSConfigurationManager` |
| **Recorder** | Remote browser streamed to the user's tab; action capture; assertion picker; iframe/tab/dialog/upload support; output to framework BDD | current recorder and codegen pipeline, improved (per-page page objects, reusable parameterised steps) |
| **Runner** | Run by feature/scenario/tag/environment/browser; queue; parallel workers; rerun failed; schedules; live step timeline; video, trace, HAR, screenshots | `cs-playwright-test` CLI as local child processes; `report-data.json` |
| **Debugger** | Pause on failure or breakpoint; step over; inspect DOM, console and network; trace viewer; healing suggestions; "similar past fixes" | Playwright trace, `CSSelfHealingEngine`, episodic fix history (MCP design) |
| **API testing** | Request builder, collections, environments/variables, auth types, assertions, chaining, schema validation; save as API scenario | framework API module and API steps |
| **DB testing** | Query and stored-procedure runner with parameters; multi-result sets; save as DB steps | `CSDBUtils` (after the DB-layer fixes in `VERIFICATION-DESIGN.md` §5.2) |
| **PDF/report validation** | PDF viewer with model overlay; expected data from manual, file or DB; validate; PDF vs PDF compare; save as scenario | native PDF engine and report-validation extensions |
| **Performance** | UI and API load, patterns, live monitor, baselines, SLOs, trends | current perf engine, with the evaluation §3 fixes |
| **Reports and analytics** | Run history, framework HTML report embedded, trends, flaky detection, failure clusters, impact analysis | framework reporter, flaky/clustering/impact modules |
| **Azure DevOps** | Plans, suites, test cases (browse, automate, publish, `@TestCaseId` sync); publish run results; bugs with evidence; preview before writing | ADO kernel from `MCP-REBUILD-DESIGN.md` §5 (fixed: no duplicate creates) |
| **Assistant** | Local assistant on every page; Copilot from the IDE via the MCP server; in-Studio Copilot agent mode via `@github/copilot-sdk` (approved, §1.3); approvals for actions | `AssistantOrchestrator`, rebuilt MCP server |
| **Settings** | Projects (local clones), connections (ADO sign-in, DB aliases from config), secrets, remote load-generator agents, Copilot sign-in and credit caps, activity log, updates | new |

---

## 4. Architecture (local-first: each user runs the Studio on their own machine)

**Owner decision (2026-11-15): the Studio is not hosted.** Every user runs it on their own machine with `npx cs-test-studio`. The command starts a local server bound to `127.0.0.1` and opens the Studio in the user's browser, the way the current performance app's `cs-perf-app` works. The team shares work through **Git and Azure DevOps**, not through a shared server.

```
 User's machine (Windows / macOS / Linux)
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Browser tab  http://127.0.0.1:<port>/?t=<per-launch token>                                  │
 │   React SPA: Workspace · Editors (grid + code) · Git · Runs · Recorder/Debugger · API · DB ·│
 │              PDF · Performance · ADO · AI agent · Copilot · Settings                        │
 │        │ REST + SSE + WebSocket (loopback only, token-checked)                              │
 │        ▼                                                                                    │
 │ Studio server (Node, Fastify, one process, modular monolith)                                │
 │   workspace/git · catalog · language service · editors · recorder · runner · debug · api ·  │
 │   db · pdf · perf · reports · ado · assistant + Copilot SDK · local job queue · secrets     │
 │        │                    │                          │                                    │
 │        ▼                    ▼                          ▼                                    │
 │  Local Git clone(s)   Local store (runs, results,   Child processes: framework runner,      │
 │  of the ADO repos     history, baselines, cache)    Playwright browsers (headed or          │
 │  (`git` binary)       + artifact folders            headless), perf engines, debugger       │
 └───────────────┬──────────────────────────────────────────────────┬──────────────────────────┘
                 │ HTTPS as the user                                │ optional: remote load-generator
                 ▼                                                  ▼ agents for big load tests
        Azure DevOps (Repos, Test Plans, Pipelines, Boards)      `npx cs-test-studio agent` on other
        GitHub Copilot (user's own seat)                          machines / the QA Windows Server
```

**Key design choices:**

- **One local process.** The Studio server, the UI and all modules run in the user's own Node process. Test runs, browsers, performance engines and the debugger are child processes on the same machine. Nothing to deploy, nothing to operate.
- **Real local Git.** Each project is a normal Git clone on the user's disk, in a folder they choose. The Studio's Git service (§2.1) drives the `git` binary.
  - The same folder can be opened in VS Code at the same time; the Studio watches for file changes and refreshes.
  - Commit, push, pull and pull requests go to Azure DevOps as the user.
- **Storage is local and needs no database server.**
  - Run history, results, baselines, SLOs, caches and settings live in the user's Studio data folder (for example `%LOCALAPPDATA%\CsTestStudio` on Windows).
  - The store is built in-house. Node's built-in `node:sqlite` module is the preferred engine if it is stable enough in the supported Node version (to be verified in S0). Otherwise the store is append-only JSON-lines files with our own indexes.
  - Artifacts (videos, traces, HAR, screenshots, reports, PDFs) are kept as files, with a retention setting.
  - Team-visible results still go to **ADO Test Plans and Pipelines**.
- **Recorder and debugger use a real browser on the user's machine.** The browser can open as a normal headed window, which is simplest and most realistic. It can also be embedded in the Studio tab through CDP screencast. Apps that are only reachable from the user's network just work.
- **Running tests.**
  - A local job queue runs one or several jobs in parallel, within a configurable share of the machine's CPU and memory.
  - Each job gets its own temp workspace (a checkout of the selected commit, or the working copy). It is cleaned up afterwards.
  - The same project runs in ADO Pipelines unchanged, through the generated pipeline (§2.4).
- **Performance at scale.** One laptop is enough for functional and modest load tests. For NeoLoad-scale tests, the user starts optional **remote load-generator agents** (`npx cs-test-studio agent --token …`) on other machines; the QA team's Windows Server is the natural first one. These agents connect back over an authenticated `ws` channel. The local Studio stays the controller and dashboard.
- **Team coordination without a server.**
  - The Git panel shows **who else has unmerged work on the same file**. It reads this from ADO: open branches and pull requests touching that path, with author and time.
  - Merges are structure-aware and guided (§2.1).
  - Real-time co-editing is **not needed** in a local-first design and is dropped.
- **Distribution and updates.**
  - `cs-test-studio` ships in the framework monorepo and is published to the team's Azure Artifacts feed, like the framework.
  - The Studio shows when a newer version is available; updating is one command.
  - Projects pin the framework version they use.

### 4.1 Security model (local-first)

| Concern | Design |
|---|---|
| **Network exposure** | The server binds to `127.0.0.1` only; it never listens on the network. Each launch creates a random **session token**, which is passed to the browser on launch and required on every request and WebSocket. **Host and Origin checks** block other websites and DNS-rebinding attempts. There is no `Access-Control-Allow-Origin: *` (the current perf app's SSE route has it, and that is fixed). |
| **Sign-in** | No Studio login. The OS user is the user. The current "email must match OS username" screen is removed. |
| **Identity for ADO and Git** | The user's own credentials: **Git Credential Manager** (installed with Git for Windows) for Git operations, and **Microsoft Entra sign-in for ADO REST** (device-code or browser flow, implemented in-house). A PAT is supported as a fallback, stored securely (below). Everything in ADO is attributed to the real person. |
| **Secrets** | Stored encrypted in the user's profile. On Windows this uses **DPAPI** through built-in OS tooling (PowerShell `ConvertFrom-SecureString`, called from Node); on macOS and Linux it uses the OS keychain CLI where present, else AES-256-GCM with a key in the user profile. Values are injected only into the test processes that need them and are redacted from logs and reports. This also fixes the hard-coded `ENCRYPTED:` key and the plain-text recorded passwords. |
| **Test-target safety** | Running locally, a user can test anything their machine can reach, as with the framework today. The hardened SSRF guard stays available as an optional team policy for the AI agent (§2.4), so the agent only browses allow-listed environments. |
| **Remote load agents** | Authenticated with a one-time pairing token. Traffic is encrypted, and agents receive only the scenario and the secrets that test needs. |
| **Audit** | A local activity log (runs, pushes, ADO writes, AI actions). Team-level traceability lives in ADO: commits, PRs, test runs and work-item history. |
| **Copilot** | `@github/copilot-sdk` (approved, §1.3), signed in with the user's own GitHub account, with a per-request credit cap. This fits the "one seat, one user" rule exactly. The enterprise Copilot policies apply. |

---

## 5. What happens to the current performance app

| Current part | Fate |
|---|---|
| React/antd UI shell, theme, live monitor, run details, run config modal | **Kept** as the base of the Studio UI. The three run lists are merged into one Runs area |
| Recorder and codegen pipeline | **Kept and upgraded**: real local browser or embedded view, per-page page objects, reusable steps, passwords kept as secrets |
| Browser perf engine | **Kept, with the measurement fixes**: network-idle action timing, waits excluded from latency, page API errors counted, no silent retries, "actions/s" labelling |
| API load engine | **Kept** (it was accurate in testing). Supports several runs at once, optional remote load agents, and runs saved to history |
| Local assistant (`AssistantOrchestrator`, `AIDataAccess`) | **Kept**, extended with Studio tools and the optional Copilot mode |
| MCP server (`cs-perf-mcp`) | **Folded into** the rebuilt MCP server (`MCP-REBUILD-DESIGN.md`), which calls Studio APIs, so IDE users and Studio users see the same data |
| ADO bug service | **Replaced by** the shared, fixed ADO kernel |
| JSON-file persistence | **Replaced by** the local store (§4) plus artifact folders; existing data is migrated |
| Login (OS-username check) | **Removed**: local-first, the OS user is the user |
| Test Case Builder | **Merged into** "Automate an ADO test case" |
| The 16 cut lines in the dump | Fixed in the real repo before any work starts (step S0) |

---

## 6. Roadmap: "all capabilities in v1", delivered in increments

"All capabilities in v1" is the target scope. Building it in one go would mean many months with nothing usable. The plan below delivers v1 in increments, each usable on users' machines as soon as it lands. Estimates assume a team of about 3–4 engineers and are rough.

| Stage | Contents | Outcome | Est. |
|---|---|---|---|
| **S0 Foundations** | Fix the dump's compile errors; CI build gates; repo layout (`studio/` in the framework monorepo); local server skeleton (`npx cs-test-studio`, loopback + token security); local store and artifact folders; activity log; secret store (DPAPI/keychain); local job queue and runner; Entra sign-in for ADO | A user starts the Studio locally, opens a cloned project and runs a framework feature | 6–8 wk |
| **S1 Workspace and runner** | Projects bound to ADO repos, file tree, branches, diff/commit/push/PR; run by feature/tag/environment; live timeline; artifacts; rerun failed; schedules; embedded framework report | Teams can run and triage existing framework tests from the browser | 6–8 wk |
| **S2 No-code authoring** | Feature step grid with catalogue autocomplete; page-object element table; data grid; config/environment view; code view beside each | Testers can create and edit tests without an editor | 8–10 wk |
| **S3 Recorder and debugger** | Recorder with a real local browser (or embedded view); recording into the BDD assets; assertion picker; debugger with breakpoints, trace viewer and healing suggestions | Record → edit → run → debug, fully in the browser | 8–10 wk |
| **S4 API and DB** | API request builder and collections → API scenarios; DB query/procedure runner → DB steps (needs the DB-layer fixes) | API and DB tests built visually | 6–8 wk |
| **S5 PDF/report validation** | PDF viewer with model overlay; expected-data binding; PDF vs PDF; save as scenario | Depends on the native PDF engine and the report-validation extensions (separate plan, ≈ 25 wk engine + 9 wk extensions; can run in parallel from S0) | 4–6 wk (UI) |
| **S6 Performance** | Perf module moved into the Studio, with the measurement fixes; remote load-generator agents; baselines and SLO UI | Trustworthy load testing in the Studio | 4–6 wk |
| **S7 ADO and assistant** | Fixed ADO kernel (plans/suites/cases, automate test case, publish results, bugs with preview); local assistant on all pages; optional Copilot mode | End-to-end ADO traceability; AI help | 6–8 wk |
| **S7b AI QA agent and ADO pipelines** | §2.4 end to end: work item, bug and code context; plan; browser exploration; test authoring with step reuse; verify/heal with server guardrails; PR plus ADO test cases and bug filing; pipeline generation from `ado-playwright-shared` templates; pipeline create/run through REST; results to Test Plans; progress board for sprint-wide runs | Story to green pipeline in ADO, proven on a real sample app and real ADO project | 8–10 wk |
| **S8 Hardening and launch** | Performance and scale tests of the Studio itself, security review, admin console, docs, migration of perf-app data, pilot team | v1 GA | 4–6 wk |
| | | **v1 total** | **≈ 75–100 weeks of work if done one stage at a time** (stages S0–S8 incl. S7b ≈ 60–78 wk, plus in-house editor, language service, Entra sign-in, local queue and secret store ≈ 15–22 wk). Local-first removes server-only work: SSO, multi-tenant isolation, co-editing, server operations. **About 11–14 months on the calendar with 4–6 engineers working stages in parallel.** Two separate tracks run in parallel: the **PDF engine** (≈ 25 wk) and **NeoLoad-parity performance** (multi-quarter, from S0). All figures are estimates. |

The order puts the most-used capability (running existing tests) first, then authoring, then the specialist workspaces. Each stage ends with a review and a pilot on the pilot team's machines.

---

## 7. Decisions (owner: "go as per the recommendation", 2026-11-15)

These recommendations are now the baseline. Each can be revisited if company infrastructure requires it. The items marked **verify** depend on facts only your IT/admin can confirm, and the design keeps an alternative ready for each.

| # | Topic | Decision | Verify / fallback |
|---|---|---|---|
| 1 | Hosting | **Not hosted. Every user runs the Studio locally** (`npx cs-test-studio`, bound to 127.0.0.1, owner decision 2026-11-15). The QA team's **Windows Server** is used as an optional **remote load-generator agent** (and CI agent host if wanted) for large performance tests. | **Verify** minimum user machine spec (recommend 16 GB RAM, 4+ cores for browser tests); Windows 10/11 supported first. |
| 2 | Sign-in | **No Studio login.** The OS user is the user. ADO is accessed with the user's own Microsoft Entra sign-in (device-code or browser flow), with a PAT as fallback. | **Verify** that Entra sign-in to ADO works from user machines (it does in VS Code today). |
| 3 | Storage | **No database server.** A local store in the user profile (`node:sqlite` if stable in the supported Node version, else our own JSON-lines store), plus artifact folders. Team results go to ADO Test Plans. | — |
| 4 | ADO identity | **Each user's own identity** for commits, PRs, test cases, bugs and pipelines, through Git Credential Manager and Entra sign-in. | Respect ADO's 2026 rules: legacy ADO OAuth is retired, and Global PATs end on 27 Jan 2027. |
| 5 | Network | Each user machine reaches the test environments, ADO, the Azure Artifacts feed / npm, `github.com` and `*.githubcopilot.com`, as it already does for VS Code, Copilot and the framework. | Copilot features switch off cleanly if GitHub hosts are blocked. |
| 6 | Packaging | **`cs-test-studio`**, a package in the framework monorepo, published to the team's Azure Artifacts feed. Started with `npx cs-test-studio`; remote load agents start with `npx cs-test-studio agent`. Update notice in the Studio. | — |
| 7 | Pilot | **The owner's own team and project** pilot each stage from S1. | — |
| 8 | NeoLoad parity scope | **Web and API protocols in v1:** HTTP/1.1, HTTP/2, HTTPS with client certificates, WebSocket, SSE, REST, SOAP (WS-Security), GraphQL, real browsers (Chromium/Firefox/WebKit), plus **MCP-server load testing**. **SAP GUI, Citrix, Oracle Forms, mainframe/terminal and legacy RIA protocols are out of v1** and reconsidered after GA, based on demand. | — |
| 9 | Mobile | **v1: mobile-web** testing via device emulation (viewport, touch, user agent, network profiles). **Native apps on real devices are post-v1.** They need a device farm or emulators, which are infrastructure decisions. | — |
| 10 | Dependencies | §1.3: only libraries already in use, plus the approved `@github/copilot-sdk`, `@github/copilot-language-server` and the system `git` binary. | — |
