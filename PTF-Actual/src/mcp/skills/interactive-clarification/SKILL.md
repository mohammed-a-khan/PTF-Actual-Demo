---
name: interactive-clarification
description: Standardized 4-option elicitation pattern for handling gaps mid-migration. Every subagent uses this when it hits missing / ambiguous / undecidable input. Skip is always the default.
---

# Pattern: interactive clarification with skip-as-default

## When to use

Any time a subagent reaches a point where it needs user input to proceed AND cannot safely pick a default from context. Examples:

- Missing dependency file (`BaseTestCase.java` can't be resolved)
- Ambiguous data-file classification (Excel could be scenarios OR config)
- Live app unreachable (no URL configured)
- SQL table not in schema reference
- Element locator has 3 equally-plausible candidates
- Entry-point URL cannot be inferred
- Credential source unclear

**Never:**
- Silently pick a default and proceed
- Block the pipeline with a free-form question
- Fail hard and abandon the file

## The elicitation contract

Every gap invocation uses this exact shape. Fields `title`, `reason`, `options`, `default` are mandatory.

```yaml
title:   "Missing: <one-line what's missing>"
reason:  "<one-sentence why I'm asking>"
context: "<3-5 lines of surrounding context — what we know>"
options:
  - label: "Provide value"
    description: "I'll use what you give me"
  - label: "Show me suggestions"
    description: "I'll propose likely answers from context"
  - label: "Skip and mark TODO"         # always the default
    description: "Continue without this — log to dropped-scenarios report"
  - label: "Abort this file"
    description: "Stop migration of current file; preserve session state"
default: 3                                # Skip
```

Render order is always 1–4. User hits Enter to skip.

## What each option does

### Option 1 — Provide value

User types the answer. Validate before accepting:

| Gap type | Validation |
|---|---|
| File path | File exists and is readable |
| URL | Parseable; reachable (HEAD request, 5s timeout) — warn if unreachable but accept |
| Credential | Never store raw; convert to `{config:KEY}` placeholder |
| Integer | `Number.isInteger(parseInt(input))` |
| Boolean | Yes/No/True/False, case-insensitive |
| Selector | Non-empty string; warn if malformed xpath |

If validation fails: show error + re-elicit. Max 3 retries per gap. After 3 fails, auto-skip (option 3).

### Option 2 — Show me suggestions

Agent builds up to 3 ranked candidates from available context. Each suggestion includes `value`, `source`, and `confidence`:

```
Suggested values (best match first):

  [1] <value>
      Source: <where this came from>
      Confidence: high | medium | low

  [2] <value>
      Source: <where this came from>
      Confidence: medium

  [3] <fallback placeholder>
      Source: placeholder — safe default
      Confidence: low (always valid)

Enter number, type a custom value, or press Enter to skip.
```

Suggestion source rules:

| Gap type | Preferred sources (rank) |
|---|---|
| Missing dep file | basename matches in legacy source tree |
| Entry-point URL | BaseTestCase constants → properties files → testng.xml `<parameter>` |
| Login credentials | env files → placeholder `{config:APP_PASSWORD}` |
| Data-file classification | first-row signature + file extension + content shape |
| Element locator (ambiguous) | live-DOM candidates ranked by stability score |
| SQL table (not in schema) | fuzzy match against schema reference + "mark SCHEMA REFERENCE NEEDED" |
| Config value | search discovered config files → placeholder `{config:KEY}` |

If agent can't produce suggestions (no context to draw from), report that and fall through to 3-option form (Provide / Skip / Abort).

### Option 3 — Skip and mark TODO (default)

Log to the dropped-scenarios report under a **"Skipped during migration"** section:

```markdown
## Skipped during migration

| Stage | Gap | User choice | Impact if unresolved |
|---|---|---|---|
| 0.3 | `RiskHelper.java` not resolved | skip | Tests using RiskHelper will fail at runtime |
| 1 | Entry-point URL not detected | skip | Feature Background left as `{config:APP_URL}` — set before first run |
| 2 | `TestData_OLD.xlsx` classification ambiguous | skip | Not converted to scenarios — reviewer decides |
```

Pipeline continues. Generator / healer must substitute a safe placeholder (`{config:…}` / `// TODO: …` comment) wherever the skipped value would have gone.

### Option 4 — Abort this file

Halt the current file's migration immediately. Write `.agent-runs/aborted-<runId>-<file>.md` with:
- Stage at abort
- Gap that triggered the abort
- Accumulated state (partial IR, partial generation)
- Recommended actions before retrying (what user should prepare)

Orchestrator returns to file-selection prompt. Session state preserves completed files.

## Wording rules — make elicitations readable

- `title` starts with `Missing:`, `Ambiguous:`, `Unreachable:`, or `Conflict:` — user knows category at a glance
- `reason` is one sentence, present tense
- `context` shows *what we already know* so the user doesn't have to re-read the whole file
- Option labels are verbs: "Provide value", "Show suggestions" — not "Value" / "Suggestions"

## Three-option form (when suggestions unavailable)

If the agent has zero context to draw suggestions from, drop option 2:

```
[1] Provide value
[2] Skip and mark TODO (default)
[3] Abort this file
```

Renumbered — Skip stays at `default: 2`.

## Never ask for the same thing twice in one session

Session state (`.agent-runs/session-<runId>.json`) maintains a `resolvedGaps: { <gap-hash>: <user-answer> }` map. Before elicitating, hash `(stage + gap-type + specific-identifier)` and check. If already answered, reuse without asking.

## Logging every elicitation

Every elicitation — resolved or skipped — is appended to `.agent-runs/clarifications-<runId>.jsonl`:

```json
{"stage":"0.3","gapType":"missing-dep","identifier":"BaseTestCase.java","choice":"provide","value":"src/common/BaseTestCase.java","ts":"..."}
{"stage":"2","gapType":"ambiguous-classification","identifier":"TestData_OLD.xlsx","choice":"skip","ts":"..."}
```

The Stage 7 summary includes a clarifications count: "3 gaps asked — 2 resolved, 1 skipped."

## What subagents MUST do

1. Never proceed past a gap without either a resolved value (option 1/2) or a logged skip (option 3)
2. Reference this skill whenever a gap is hit: "Following the `interactive-clarification` pattern, I need: …"
3. Log every elicitation to the jsonl file, even the skipped ones
4. If option 3 (skip), install a safe placeholder (no silent `undefined` / empty-string)
5. If option 4 (abort), do not make partial writes — either complete the stage or roll back cleanly

## What subagents MUST NOT do

- Ask free-form questions outside this contract ("What should I do about X?")
- Block the pipeline waiting for user input with no default
- Pick a non-skip default without user choice
- Ask the same gap twice in one session
- Skip without logging to the dropped-scenarios report
