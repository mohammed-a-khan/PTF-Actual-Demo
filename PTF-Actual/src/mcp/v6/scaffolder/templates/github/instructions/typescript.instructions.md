---
applyTo: "**/*.ts"
---

# TypeScript hygiene

- `strict: true` respected — no implicit any, no `any` shortcuts, no
  `@ts-ignore` without a comment naming the specific issue.
- Prefer `readonly` where the value is never re-assigned.
- No `console.log` in shipped code — use `CSReporter.debug/info/pass/fail`.
- Async: always `await` — never `.then().catch()` chains, never floating promises.
- Error handling: throw typed errors (never swallow with empty `catch`). MCP
  primitives return structured error results; do not throw across the tool
  boundary.
- Import ordering: node built-ins, then framework re-exports (`@mdakhan.mak/...`),
  then relative imports. One blank line between groups.
- No default exports on class files. Default exports allowed on config /
  data helpers.
- Numeric literals: plain digits (`5000`, `100000`), not `5_000` underscores.
- Timezone default: `America/New_York`. Use `CSDateTimeUtility`, never `new Date()`
  directly for user-facing timestamps.
