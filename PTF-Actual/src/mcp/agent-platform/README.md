# CS-AI-Auto-Assist — Agent Platform

The agent platform is the orchestration shell that turns the framework's
existing MCP tools into a self-driving test-authoring agent. Its single
public surface is the `cs_ai_auto_assist` MCP tool: one entry point that
classifies the user's intent, asks for missing inputs, hands the work to
the host LLM (Copilot in VS Code, Claude in terminal) via MCP sampling,
runs the generated tests through a mandatory execution gate, heals
failures with a bounded retry loop, and pushes results back to ADO when
configured.

## What the platform is (and isn't)

It **is** an orchestrator + safety harness. It owns:

- intent routing
- tier-based clarification
- input sanitisation (PII / secrets at trust boundaries)
- constitutional safety (forbidden-action allow-list)
- cost telemetry (token + wall-clock + $ caps)
- execution gate (`compile_check → bdd_run_feature → judge → commit_ready_check`)
- bounded heal loop (LLM-driven retry-with-fix, with verified-green memory)
- plan cache (replay verified-green output for unchanged inputs)
- trust scoring
- ADO bidirectional sync (read existing test cases, push run results back)

It **isn't** a parser, a generator, or a pipeline. The semantic translation
work — Java/C# → TS, requirements → Gherkin, source → tests — is delegated
to the host LLM through `CSCopilotDelegate`. The platform never re-implements
source-code understanding.

## Modes

The intent router classifies the user's input into one of these modes:

| Mode | Triggered by | What happens |
|---|---|---|
| `ado_test_case_id` | `TC#<n>` / pure digit / explicit override | Fetch the test case from ADO, parse its Microsoft.VSTS.TCM.Steps XML, generate the framework artefacts, optionally write the new id back to ADO |
| `ado_test_suite_id` | `TS#<n>` | List + batch-fetch every test case in the suite, then per-case generation |
| `ado_test_plan_id` | `TP#<n>` | Walk every suite under the plan, batch-fetch all test cases |
| `legacy_test_code` | path to a `.java` / `.cs` file detected as a Selenium / TestNG / NUnit / xUnit / MSTest test | Cheap structural extraction (test names, IDs, page-object class names), then Copilot translation, then heal loop |
| `document_path` | path to `.md` / `.txt` / `.adoc` / `.rst` | Heading extraction → Copilot generation → heal loop |
| `source_code_path` | path to an application source file | Same-dir sibling collection + symbol extraction → Copilot generation → heal loop |
| `natural_language_chat` | free-form description | Copilot drafts from clarification answers (`appUrl`, `expectedOutcome`, `roles`); flagged `needsSourceValidation: true` |
| `app_url` | a URL | Phase 3 (live browser exploration); not yet implemented |
| `unknown` | anything else | Falls through to clarification |

## End-to-end flow

```
cs_ai_auto_assist {input, mode?, answers?, budget?, publishResults?}
   │
   ├─ CSPiiSanitizer.sanitize(input, 'reject_secrets_only')
   │     reject only on real secrets (PATs, JWTs, API keys);
   │     test data (emails, account numbers, dates) flows through.
   │
   ├─ CSIntentRouter.classify(input) → mode + extractedFields
   │
   ├─ CSClarificationAgent.computeMissingFields(...)
   │     mode-specific Tier-1/2/3 questions, auto-resolved from
   │     CSConfigurationManager when keys exist (e.g. ADO_PAT).
   │
   ├─ CSCostTelemetry.checkBudget()
   │     hard caps on tokens / wall-clock / dollars.
   │
   ├─ dispatchMode(classified)
   │     → CSAdoModeHandler / CSLegacyModeHandler / CSDocumentModeHandler /
   │       CSSourceCodeModeHandler / CSChatModeHandler
   │
   │     each handler:
   │       1. CSMigrationCache.lookup() — replay if cache hit
   │       2. else: collect inputs → CSCopilotDelegate.delegate()
   │       3. write file map under outputRoot
   │       4. return GenerationResult
   │
   ├─ CSHealLoop.heal(featureFiles, …)
   │     gate.execute() once; on failure:
   │       classify_failure → correction_memory_query →
   │       sampling.createMessage (with memory grounding) →
   │       audit_content (pre-apply) → fs.writeFileSync →
   │       gate.execute() again. Bounded by maxAttemptsPerFailure (3)
   │       and maxGlobalAttempts (20). Records verified-green strategies
   │       to .agent-runs/correction-patterns.md on success.
   │
   ├─ CSMigrationCache.store(...)
   │     persist verified-green file map under .agent-runs/cache/<key>/
   │
   ├─ CSAdoCreateBackFlow.maybeCreateBack(...)
   │     when scenario lacks @TC_ tag AND createBackPlanId/SuiteId set,
   │     create a new ADO test case with serialised Steps XML and
   │     attach to the target suite, then inject @TC_<newId> into the
   │     feature file.
   │
   ├─ ADO publish (via framework's CSADOPublisher inside bdd_run_feature
   │     when ADO_INTEGRATION_ENABLED=true; surfaced as adoRun.webAccessUrl)
   │
   ├─ CSTrustScore.compute(...)
   │     weighted multi-factor score 0.0–1.0
   │
   └─ AgentRunResult { state, runId, mode, tokensTotal, costUsd,
                       testsGenerated, testsPassed, trustScoreAvg,
                       filesCreated, healLoop, createBack, adoRun,
                       cacheHit / cacheStored, blockedReason? }
```

## Files in this module

| File | Role |
|---|---|
| `CSAIAutoAssist.ts` | The master tool definition; orchestrates the full pipeline |
| `CSIntentRouter.ts` | Deterministic regex-first classification across 9 modes |
| `CSClarificationAgent.ts` | Tier 1/2/3 questions; auto-resolves ADO fields from config |
| `CSPiiSanitizer.ts` | PII + SECRET regex; supports redact / reject / reject_secrets_only |
| `CSConstitutionalSafety.ts` | 7 forbidden-action rules (NO_PROD_DELETE, NO_REAL_PII, …) |
| `CSCostTelemetry.ts` | Token + wall-clock + $ tracking with hard caps |
| `CSExecutionGate.ts` | `compile_check → bdd_run_feature → judge → commit_ready_check` |
| `CSResultJudge.ts` | PASS_REAL / PASS_WEAK / FAIL classification |
| `CSHealLoop.ts` | Bounded retry-with-fix wrapping the gate |
| `CSTrustScore.ts` | Weighted multi-factor scoring |
| `CSCopilotDelegate.ts` | Single primitive wrapping `context.sampling.createMessage` |
| `CSMigrationCache.ts` | Wraps the framework's `migration_cache_*` tools |
| `CSAdoModeHandler.ts` | ADO modes: REST cascade + batch fetch + parse |
| `CSAdoTestCaseParser.ts` | Steps XML round-trip (parse + serialize) |
| `CSAdoCreateBackFlow.ts` | Push generated scenarios back to ADO as new test cases |
| `CSLegacyModeHandler.ts` | `legacy_test_code`: cheap structural seed + Copilot |
| `CSDocumentModeHandler.ts` | `document_path`: heading extraction + Copilot |
| `CSSourceCodeModeHandler.ts` | `source_code_path`: sibling collection + Copilot |
| `CSChatModeHandler.ts` | `natural_language_chat`: free-text + Copilot |
| `CSGenerationOrchestrator.ts` | Phase 2A composer pipeline (used by ADO mode) |
| `CSStepToGherkinTranslator.ts` | ADO test step → Gherkin Given/When/Then |
| `CSPageObjectComposer.ts` / `CSStepDefComposer.ts` / `CSFeatureFileComposer.ts` / `CSFixtureComposer.ts` | Phase 2A artefact composers |
| `CSSourceGrounder.ts` | App source grounding for ADO mode |
| `types.ts` | Shared types (AgentRunMode, AgentRunResult, …) |
| `index.ts` | Barrel export for external consumers |

## Differentiation note

The framework also ships a multi-stage pipeline (`agents/cs-playwright.md` +
`analyzer` / `pipeline-generator` / `pipeline-healer` subagents) for
explicit per-file legacy migration. CS-AI-Auto-Assist is a **different
shape**: a single intent-driven entry point with one Copilot call per file,
backed by a heal loop, not a multi-stage subagent pipeline. The two
co-exist — the deterministic tools (`legacy_parse`, `legacy_transform`,
`migration_cache_*`, `correction_memory_*`) are shared infrastructure used
by both.

## See also

- `docs/agent-platform/architecture.md` — full system architecture
- `docs/agent-platform/security.md` — threat model + PIA + safety controls
- `docs/agent-platform/cost-model.md` — token/$ estimates + budget controls
- `docs/agent-platform/operations.md` — runbook + `.env` keys + troubleshooting
- `docs/agent-platform/architecture-review-checklist.md` — one-page approval summary
