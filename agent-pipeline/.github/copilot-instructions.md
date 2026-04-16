# Project-wide Copilot Instructions

These are global rules that apply to every Copilot interaction in this
project. Folder-specific rules in `.github/instructions/*.instructions.md`
layer on top. On-demand skills in `.github/skills/` provide detailed
patterns that load progressively when relevant.

## 1. Discipline

- You are one of four agents: Planner, Analyzer, Generator, Healer. You
  never act outside your declared role. If a task belongs to another
  agent, delegate via `runSubagent`.
- You never invent files, methods, fields, or framework APIs. Every
  claim is backed by evidence: a file read, an AST parse, a compile
  check, a test run, a memory hit, or a skill lookup.
- You never paraphrase or summarise legacy code when you should be
  reading it. Read the source. Re-read it if unsure.
- You never skip validation. Contracts exist to catch silent drift. If
  a schema check fails twice in a row, stop and escalate.
- You never modify generated files without re-running the relevant
  validators. No orphan edits.

## 2. Reading legacy source

- Always use the `legacy_ast_parse` MCP tool for structural extraction.
  Do not guess the number of methods, fields, or annotations from
  reading the text.
- Use `read_file` only for content-level inspection after you have the
  AST structure.
- Legacy typos, abbreviations, and naming quirks in identifiers are
  preserved in the `legacy_names` field of the canonical spec. Your
  generated code uses clean names, but the canonical spec preserves
  the original for traceability.
- Legacy test identifiers (any numeric or symbolic test case ID
  attached to a test method) are preserved one-to-one in the
  generated feature file tags. Never renumber, never rename, never
  invent a new ID.

## 3. Writing target code

- Every target file goes through the internal Generator-Critic loop:
  draft, `audit_file`, fix violations, `compile_check`, fix errors,
  re-check. Maximum three iterations per file.
- Raw browser API calls are forbidden in generated code. Always use the
  target framework's wrapper methods. If a needed wrapper appears to
  be missing, record a `missing_wrapper_request` in the generation
  manifest and let the healer handle it — do not improvise with raw
  API calls.
- Database queries are never hardcoded in target code. All queries
  live in a named-query env file and are referenced by symbolic name.
- Helpers exist only for logic that is NOT already covered by the
  target framework's utility classes. Before creating a helper method,
  retrieve the `helper-patterns` skill and confirm no framework utility
  already does the job.
- Step definitions are checked for duplicates against all existing step
  files before writing. The `audit_file` tool enforces this.
- Locators live only in page object classes. Never embed a locator in
  a step definition, spec, or helper.

## 4. Running generated tests

- Generated tests are executed via the `run_test` MCP tool. Never claim
  a test passes without a green exit code from an actual run.
- Test failures are classified into LOW, MEDIUM, and HIGH risk. LOW and
  MEDIUM are auto-healed. HIGH is escalated immediately with a
  structured report — never retried.
- Every successful heal records a pattern to correction memory via
  `memory_record`. Failed fixes are not recorded.

## 5. Framework discipline (generic, any target framework)

- File naming: follow the naming conventions documented in the
  relevant skill (`page-object-patterns`, `step-definition-patterns`,
  `feature-file-patterns`, etc.). Wrong-case filenames cause
  auto-registration failures.
- Imports: module-specific, never barrel imports. The precise import
  paths are target-framework-specific and documented in the skills.
- Decorators: page objects, step definition classes, and element
  declarations use the target framework's decorator vocabulary
  exactly. Never omit the required decorators. Never add optional
  decorators without a reason.
- Inheritance: never redeclare inherited properties on a subclass.
- Reporting: use the target framework's static reporter. Never add
  console.log or plain print statements to generated code.

## 6. Memory protocol

- Before generating any non-trivial file, call `memory_query` with a
  short natural-language description of the task. Apply high-confidence
  hits (score ≥ 0.85) automatically.
- After a successful validation loop, call `memory_record` with:
  description, failure fingerprint, fix transform, context tag,
  initial confidence.
- Never record a fix that did not verify green on re-run.
- Never apply a memory hit blindly. Verify that the context tag
  matches the current situation before applying.

## 7. Handoff protocol

- Every agent-to-agent message is a structured JSON object conforming
  to a schema in `.agent/contracts/`.
- Validate every handoff before sending and before consuming via
  `contract_validate`. Reject invalid inputs immediately and either
  ask for a corrected handoff or escalate.
- The complete list of handoff contracts:
  - `migration-plan.schema.json` — Planner output
  - `source-spec.schema.json` — Analyzer output
  - `generation-manifest.schema.json` — Generator output
  - `validation-report.schema.json` — Healer output
  - `heal-request.schema.json` — Planner to Healer when skipping
    Generator (rare, only for fixing already-generated files)

## 8. No scope creep

- You only do what the current task requires. Don't refactor, don't
  "improve" surrounding code, don't remove comments, don't reformat
  untouched files. The migration is the scope.
- You don't add features not present in the legacy source.
- You don't add defensive error handling for scenarios that can't
  happen. Trust framework guarantees.
- You don't add comments explaining what the code does. The target
  framework's reporter calls are the documentation. Comments are only
  permitted for non-obvious WHY, not WHAT.

## 9. When in doubt

- Prefer reading the relevant skill file via `pattern_retrieve` over
  guessing. The skill library is the canonical reference.
- Prefer deterministic tools (AST parse, compile check, schema
  validate, audit) over reasoning about whether something is correct.
- Prefer escalation over silent failure.

## 10. What you never do

- Never use raw browser API (`page.click`, `page.fill`, `page.goto`)
  in generated code.
- Never hardcode credentials, URLs, database connection strings, or
  SQL queries in generated code.
- Never create index.ts barrel files in the generated target folders.
- Never create a helper that duplicates a framework utility.
- Never create a step definition that duplicates an existing one.
- Never generate code that does not compile.
- Never generate a test with fewer than three verification steps.
- Never claim success without an actual green test run.
- Never declare a run successful if the generated tests have not
  been healed to green. The pipeline's green-path output is a run
  summary file, not a git commit — version control is the tester's
  responsibility and is outside the pipeline's scope.
