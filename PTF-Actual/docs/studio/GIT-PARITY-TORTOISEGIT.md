# Git features: parity with TortoiseGit

**Source:** the official manuals, read in full: 69 TortoiseGit pages (https://tortoisegit.org/docs/tortoisegit/) and 17 TortoiseGitMerge pages (https://tortoisegit.org/docs/tortoisegitmerge/).
**Rule:** keep the standard Git terms (branch, commit, push, pull, merge, stash, rebase, cherry-pick, reset, revert…) and add plain-language help next to them, as TortoiseGit does.
**Priority for a QA automation team:** M = must, S = should, N = nice to have.
**Status:** ✅ built and tested · 🔜 next · ⏳ planned

## 1. Merge and diff tool (TortoiseGitMerge)
| Feature | Git | P | Status |
|---|---|---|---|
| Three-pane conflict view: Theirs \| Mine above, Merged below, panes scroll together | `git mergetool` | M | ✅ |
| Use theirs / mine block (Ctrl+F9 / Ctrl+F10) | `checkout --theirs/--ours` per block | M | ✅ |
| Theirs before mine / mine before theirs (Ctrl+Shift+F9 / F10) | – | M | ✅ |
| Double-click a block to take that side | – | M | ✅ |
| Edit a block of the result directly | – | M | ✅ |
| Next / previous conflict (F8 / Shift+F8); jump to the next open conflict after each choice | – | M | ✅ |
| "N conflicts left" counter; Mark as resolved | `git add` | M | ✅ |
| Highlighting of the exact characters that differ within a line | – | M | ✅ (first and last differing characters; word-level 🔜) |
| Step-by-step view (one card per conflict) for non-technical users | – | S | ✅ |
| Whole file: keep current / take incoming (also for delete/modify conflicts) | `checkout --ours/--theirs` | M | ✅ |
| Two-pane side-by-side diff for normal changes (today: unified diff) | `git diff` | M | ✅ |
| Ignore whitespace / line endings / case | `-w`, `--ignore-cr-at-eol` | M | ✅ |
| Locator bar (mini-map of changes) | – | S | ⏳ |
| Collapse unchanged sections, go to line, find | – | S | ⏳ |
| Line icons: whitespace-only, moved lines | `--color-moved` | S | ⏳ |
| Image diff (side by side / overlay) — useful for visual test baselines | – | S | ⏳ |
| Apply / review patch files | `git apply` | N | ⏳ |

## 2. Commit
| Feature | Git | P | Status |
|---|---|---|---|
| Changed-file list with stage/unstage, new files included | `add`, `restore --staged` | M | ✅ |
| Secret scan before every commit, with fixes and a recorded override | – | M | ✅ (beyond TortoiseGit) |
| Ctrl+Enter to commit | – | M | ✅ |
| **Commit & push** in one click | `commit && push` | M | ✅ |
| **Amend last commit** (blocked once pushed, unless confirmed) | `commit --amend` | M | ✅ |
| Recent messages | – | M | ✅ |
| **Partial staging** — stage/unstage individual change blocks (hunks); line-level selection ⏳ | `add -p` | M | ✅ |
| Discard changes in a file (recoverable: copy kept before discarding) | `restore` | M | ✅ |
| Sign-off, message templates/snippets, minimum message length, line-width marker | `commit -s` | S | ⏳ |
| ADO work-item link in messages (`AB#123`) and clickable IDs in history | ADO convention | S | ⏳ |
| Commit on a new branch | `switch -c` | S | ⏳ |

## 3. History (Log dialog)
| Feature | Git | P | Status |
|---|---|---|---|
| Commit list (message, author, date, copy SHA) | `log` | M | ✅ |
| **Branch graph**; branch and tag labels (working-tree row ⏳) | `log --graph` | M | ✅ |
| Filter by text (message / author / path), jump to pasted SHA, all branches, first parent, no merges (date-range UI ⏳; API supports it) | `log` options | M | ✅ |
| Files changed in a commit, each with a diff | `show --name-status` | M | ✅ |
| Compare with previous / with working tree / two commits | `diff` | M | ✅ |
| From a commit: create branch, create tag, switch to it (detached-HEAD warning) | `branch`, `tag`, `switch` | M | ✅ |
| **Revert** a commit (new undo commit) | `revert` | M | ✅ |
| **Cherry-pick** commit(s) | `cherry-pick` | M | ✅ |
| **Reset** to a commit: soft / mixed / hard in plain language; hard needs confirmation and keeps a recovery point | `reset` | M | ✅ |
| Restore a file from a commit (copy of current kept) ✅; file-history view (filter by path ✅, dedicated view ⏳) | `restore --source`, `log -- f` | M | ✅ |
| Blame (who changed each line, coloured by age) | `blame` | S | ⏳ |
| Reflog: recover "lost" commits and branches | `reflog` | S | ⏳ |
| Statistics by author/date | `shortlog` | N | ⏳ |

## 4. Branches, sync, other operations
| Feature | Git | P | Status |
|---|---|---|---|
| Switch / create branch; checkout a remote branch with tracking | `switch`, `switch -c --track` | M | ✅ |
| Merge a branch into the current one; abort | `merge`, `merge --abort` | M | ✅ |
| Merge options: no fast-forward, squash, don't commit yet | `--no-ff`, `--squash`, `--no-commit` | M | ✅ |
| Fetch, pull (conflicts handled), push, publish branch; incoming/outgoing counts | `fetch`, `pull`, `push -u` | M | ✅ |
| Secret re-scan of everything a push sends | – | M | ✅ (beyond TortoiseGit) |
| Push options: **force-with-lease** (explained), include tags; fetch with prune/tags | `push --force-with-lease`, `fetch --prune` | M | ✅ |
| **Stash**: save (with message, include new files), list, apply, pop, drop | `stash` | M | ✅ |
| Delete / rename branch; delete remote branch; set upstream; tags list/create/delete/push | `branch -d/-m/-u`, `tag`, `push --delete` | M | ✅ |
| Compare two branches (files and diff) | `diff A...B` | M | ✅ |
| Interactive rebase (pick / squash / edit / skip, reorder) | `rebase -i` | S | ⏳ |
| Bisect (good / bad / skip), with the option to run a test at each step | `bisect` | S | ⏳ (a natural fit for a test studio) |
| Clean up untracked files, with a dry-run preview | `clean -n / -f` | S | ⏳ |
| .gitignore helper (by name, by extension, scope) | – | S | ✅ partial (secret-scan "never commit this file") / ⏳ general |
| Untrack but keep the file; rename/move | `rm --cached`, `mv` | S | ⏳ |
| Remotes management (add, URL, push URL, prune) | `remote` | S | ⏳ |
| Clone (URL, branch, shallow) | `clone` | M | ⏳ (Studio project open/clone) |
| Repository browser at any commit | `ls-tree`, `show rev:path` | S | ⏳ |
| Submodules, worktrees, LFS locks, patches by mail, archive, daemon, svn | – | N | ⏳ / not planned |

## 5. Settings
| Feature | P | Status |
|---|---|---|
| Git identity (name/email) with a clear prompt when missing | M | ✅ message / 🔜 settings screen |
| Credentials: uses Git Credential Manager; never prompts in the background | M | ✅ (`GIT_TERMINAL_PROMPT=0`) |
| Hooks: Studio secret hooks installed and existing hooks chained | S | ✅ |
| Team policy files in the repo (`.cs-studio/policy.json`, `pipeline.json`, allowlist) | S | ✅ |

## UX patterns we copy from TortoiseGit
- Every operation says what "mine" and "theirs" mean. In a rebase, "theirs" is the branch you rebase onto.
- Safety nets: dry-run before cleaning; recovery copies before discard and reset --hard; force-with-lease instead of force.
- Plain-language descriptions of the reset modes and of force push.
- The tracked branch is pre-selected for pull and push.
- Advanced options are hidden until asked for.
- A counter of remaining conflicts.
- Paste a commit SHA to jump to that commit.

## Added in this round (also beyond TortoiseGit)
- **In-progress operations:** cherry-pick and revert conflicts show a banner with Continue and Abort. Continue is checked by the secret scan like any commit. The commit button becomes "Continue cherry-pick".
- **Recovery points:** saved automatically before every reset, plus a snapshot of uncommitted work before a hard reset. Each can be restored from History → Recovery points, and a restore is itself undoable.
- **Discard and "restore this version"** keep a copy of your file in `.git/cs-studio/recovery/<time>/`.
- **Ref safety:** every branch, tag or commit name from the UI is validated, so it can never be passed to Git as an option.

**Verified:** 84 backend tests on real repositories (`test/git-advanced.test.ts`, `test/graph.test.ts` and others), plus two browser suites driving the real UI against a demo repo built from the framework's `config/`.
