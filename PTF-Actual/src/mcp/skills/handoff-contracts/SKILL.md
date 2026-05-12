---
name: handoff-contracts
description: 'Structured handoff blocks each cs-ai-auto-assist sub-agent must return. Use this when validating sub-agent output in the orchestrator, or when authoring a new sub-agent return block.'
---

# Handoff Contracts — sub-agent return shapes

Every sub-agent invoked by `cs-ai-auto-assist` (the orchestrator) returns a
**structured handoff block** at the end of its turn. The orchestrator
validates the block against its contract before advancing to the next phase.

This skill defines all six contracts. Sub-agents reference their contract
verbatim in their prompt. Orchestrator validates against its contract
verbatim during phase-gate decisions.

---

## Contract 1 — `scope-report` (from `cs-scope-mapper`)

Returned after Phase 1 (intake via `cs_ai_auto_assist`) + Phase 2
(`csaa_discover`).

```yaml
scope-report:
 runId: run_<timestamp>_<rand> # REQUIRED, starts with 'run_'
 mode: legacy_test_code | bdd_feature | ado_test_case_id | document_path | source_code_path | app_url | natural_language_chat
 classifiedProject: <string> # REQUIRED, kebab-case (e.g. "orders")
 classifiedModule: <string> # OPTIONAL, sub-folder name (kebab-case)
 inventoryCounts:
 tests: <number>
 pages: <number>
 helpers: <number>
 dataFiles: <number>
 signatureExtracted: <boolean>
 analyzeQueueLength: <number> # 0 if no signature; ≥1 if signature seeded a queue
 analyzePagesQueueLength: <number>
 runFolder: <absolute path> # REQUIRED, must exist on disk
 nextPhase: 'cs-bdd-author' # Always, unless mode requires user clarification first
```

Validation:
- `runId` matches `/^run_\d+_/`
- `mode` is one of the enum values
- `classifiedProject` is non-empty kebab-case
- `runFolder` resolves to an existing directory
- If `signatureExtracted: true` then `analyzeQueueLength >= 1`

---

## Contract 2 — `bdd-author-report` (from `cs-bdd-author`)

Returned after Phase 3 (`csaa_analyze` + iterator streaming +
`csaa_finalize_analysis`) + Phase 4 (`csaa_plan`).

```yaml
bdd-author-report:
 runId: <string>
 scenarioCount: <number> # REQUIRED, ≥1
 pageCount: <number> # REQUIRED, ≥0 (0 only if all pages reuse-existing)
 readinessScore: <number> # REQUIRED, 0.0–1.0
 highSeverityGaps: <number>
 translateQueueSeeded: <boolean>
 translateQueueLength: <number> # 1 feature + N steps + M pages + 1 data
 analysisReportPath: <absolute path> # REQUIRED, must exist
 planPath: <absolute path> # REQUIRED, must exist
 blockedReason: <string | null> # set ONLY if readinessScore < 0.7 OR highSeverityGaps ≥ 3
 fuzzyMatchSuggestions: [...] # set ONLY if blocked
 nextPhase: 'cs-artifact-synthesizer' | 'BLOCKED_NEED_HUMAN'
```

Validation:
- `analysisReportPath` and `planPath` exist on disk
- If `readinessScore < 0.7` OR `highSeverityGaps >= 3` then `nextPhase === 'BLOCKED_NEED_HUMAN'`
- If unblocked then `translateQueueSeeded === true` AND `translateQueueLength >= 3`

---

## Contract 3 — `artifact-report` (from `cs-artifact-synthesizer`)

Returned after Phase 5 (`csaa_translate` + iterator streaming + patches +
`csaa_finalize_translation`) + Phase 6 (`csaa_audit`).

```yaml
artifact-report:
 runId: <string>
 filesGenerated: <number> # REQUIRED, ≥3
 contentMapPath: <absolute path> # REQUIRED, must exist
 allGatesPassed: <boolean>
 auditViolations: <number> # MUST be 0 for unblocked progression
 patchCyclesUsed: <number> # 0 if no content-gate retries needed
 blockedReason: <string | null>
 nextPhase: 'cs-vault-writer' | 'BLOCKED_NEED_HUMAN'
```

Validation:
- `contentMapPath` exists and parses as JSON
- `auditViolations === 0` OR `nextPhase === 'BLOCKED_NEED_HUMAN'`
- `allGatesPassed === true` OR `nextPhase === 'BLOCKED_NEED_HUMAN'`

---

## Contract 4 — `vault-report` (from `cs-vault-writer`)

Returned after Phase 7 (`csaa_write`) + Phase 7.5 (`csaa_configure_credentials`
if needed).

```yaml
vault-report:
 runId: <string>
 filesWritten: <number> # REQUIRED, ≥3
 skippedExisting: <number>
 auditFailed: <number> # MUST be 0
 credentialsRequested: <boolean> # true ONLY if csaa_write reported credentialsMissing
 credentialsConfigured: <boolean> # true if csaa_configure_credentials was called successfully
 envFilePath: <absolute path | null> # set when credentials configured
 nextPhase: 'cs-resilience-engineer'
```

Validation:
- If `credentialsRequested === true` then `credentialsConfigured === true` OR escalation
- `auditFailed === 0`

---

## Contract 5 — `resilience-report` (from `cs-resilience-engineer`)

Returned after Phase 8 (`csaa_execute` + heal loop).

```yaml
resilience-report:
 runId: <string>
 runVerdict: 'passed' | 'passed_after_heal' | 'pass_weak' | 'failed_after_heal'
 scenariosTotal: <number>
 scenariosPassed: <number>
 scenariosFailed: <number>
 healCyclesUsed: <number> # total cycles across all scenarios
 perScenarioVerdicts:
 - id: <scenarioId>
 verdict: 'passed' | 'passed_after_heal' | 'failed_after_heal'
 cyclesUsed: <number>
 fixes: [<failureType>, ...] # e.g. ['locator-drift', 'timing-flaky']
 lastClassification: <failureType | null>
 correctionMemoryHits: <number>
 correctionMemoryMisses: <number>
 failureReportPath: <absolute path | null> # set when scenariosFailed > 0
 nextPhase: 'cs-trust-arbiter' # always; trust-arbiter computes degraded score on weak/failed
```

Validation:
- `scenariosTotal === scenariosPassed + scenariosFailed`
- `runVerdict` matches the scenario outcomes
- `healCyclesUsed ≤ 20` (global cap)

---

## Contract 6 — `trust-report` (from `cs-trust-arbiter`)

Returned after Phase 9 (`csaa_verify` + optional `csaa_publish`).

```yaml
trust-report:
 runId: <string>
 trustScore: <number> # 0.0–1.0, REQUIRED
 semanticEquivalence: <boolean> # legacy assertions ↔ generated assertions match
 finalReportPath: <absolute path> # REQUIRED, must exist
 factors:
 readinessScore: <number>
 auditViolations: <number>
 runVerdict: <string>
 semanticEquivalence: <boolean>
 healCyclesUsed: <number>
 published: <boolean> # true ONLY if user opted in at intake AND publish succeeded
 adoRunUrl: <string | null> # set when published
 createdTestCaseIds: [<string>, ...] # set when published
 finalStatus: 'READY' | 'PASS_WEAK' | 'FAILED'
```

Validation:
- `finalReportPath` exists on disk
- `trustScore` in [0.0, 1.0]
- `published === true` implies `adoRunUrl` is a valid URL

---

## How orchestrator uses these contracts

The orchestrator's prompt instructs it to:

1. Call each sub-agent via the `agent` tool.
2. Parse the returned block as YAML.
3. Validate against the matching contract (above).
4. If validation passes AND `nextPhase` is a sub-agent name → invoke that sub-agent.
5. If validation fails → escalate with the missing/invalid field.
6. If `nextPhase === 'BLOCKED_NEED_HUMAN'` → surface `blockedReason` to the user and halt.

## How sub-agents emit their handoff block

Each sub-agent ends its turn with a fenced YAML block prefixed by the
contract name. Example:

```yaml
scope-report:
 runId: run_1735632147382_xyz123
 mode: legacy_test_code
 classifiedProject: orders
 ...
 nextPhase: 'cs-bdd-author'
```

No prose after the block. The orchestrator reads the block, validates,
dispatches. The block is small (~200-500 bytes), so even after a
sub-agent runs a complex iterator loop internally, the orchestrator
only sees the summary.
