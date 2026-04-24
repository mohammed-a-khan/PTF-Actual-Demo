---
name: correction-memory-format
description: How to read and write the Healer's correction memory file — the system that makes the pipeline smarter over time.
---

# Correction memory

File: `.agent-runs/correction-patterns.md`

Content: a list of JSON blocks, each recording one verified fix pattern. Prepended with a heading. Appended to over time; never rewritten in place.

## Entry format

```
## <hash> — <failureClass>

```json
{
  "signature": "TimeoutError: locator did not match //button[@id=\"signin-btn\"]",
  "hash": "a3f7e12b4c5d8e9a",
  "failureClass": "LOW",
  "rootCause": "Element id changed from 'signin-btn' to testId 'loginSubmit'",
  "fixStrategy": "Updated @CSGetElement xpath primary to //button[@data-testid=\"loginSubmit\"]; retained old css form as last alternative",
  "verifiedGreen": true,
  "recordedAt": "2026-04-23T14:12:47.123Z",
  "examplePatch": "xpath: '//button[@id=\"signin-btn\"]' → xpath: '//button[@data-testid=\"loginSubmit\"]'"
}
```

## Required fields

| Field | Type | Purpose |
|---|---|---|
| `signature` | string | Human-readable failure signature; use the error message with noise (timestamps, numeric ids, full paths) stripped |
| `hash` | string | 16-char SHA-256 prefix of `signature` — enables cheap exact lookups |
| `failureClass` | `LOW`/`MEDIUM`/`HIGH` | From `classify_failure` — HIGH entries are informational only (not auto-healed) |
| `rootCause` | string | Why it failed — one sentence |
| `fixStrategy` | string | Concise description of what the fix changed |
| `verifiedGreen` | boolean | **Must be true** — only verified-green fixes are recorded |
| `recordedAt` | ISO timestamp | When the entry was added |
| `examplePatch` | string (optional) | Before/after or other recoverable fix sketch |

## Lookup semantics

The `correction_memory_query` tool returns:

- **Exact hit** — entry with matching `hash` or exact-equal `signature`
- **Partial hits** — entries whose `signature` is a substring of the query (or vice versa), ranked by length overlap

Agents use exact hits first; partial hits are suggestions the LLM evaluates.

## Write rules

- **Only record on verified-green.** The `correction_memory_record` tool refuses to write when `verifiedGreen: false`
- **One entry per unique fix**. Don't record near-duplicates; the query will find the original by substring match
- **Redact sensitive values** — never put real user emails, real passwords, real test-env hostnames in the signature or fix strategy
- **Append-only** — existing entries are never rewritten; if a pattern becomes obsolete, add a new entry referencing the old hash in `fixStrategy`

## Human pruning

Over many runs the memory file grows. A maintainer may occasionally:
- Delete entries older than N months
- Merge near-duplicate entries into a single canonical one
- Archive environment-specific entries to `.agent-runs/correction-patterns-archive.md`

No tool does this automatically — the Healer only appends.
