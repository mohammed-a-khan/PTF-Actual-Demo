---
name: app-url-exploration
description: Use when the user provides a live application URL (no source code, no ADO test cases, no requirements doc) and wants tests generated from a crawl. Documents the four entryFlow modes, the env-based credential pattern, and the storageState recording flow for SSO / multi-step / MFA logins.
---

# Pattern: app_url exploration mode

## When to use

The mode auto-detects from the input — any `https://...` or
`http://...` URL with no ID prefix routes to `app_url` mode. The
crawler walks the live app, identifies interactive elements, infers
features, and emits a generated test suite. Five things to
configure before the run:

1. The URL itself
2. The auth flow (`entryFlow`)
3. Credentials (only for `basic-login`)
4. A pre-recorded storage-state JSON (only for `sso-redirect` /
   `multi-step-login`)
5. Crawl bounds (`maxStates`, `maxDurationMinutes`, `strategy`)

## entryFlow values

| Value | When to use | What you must provide |
|---|---|---|
| `no-auth` | Public app, no login required | nothing |
| `basic-login` | App has a username + password form on landing | `APP_USERNAME` + `APP_PASSWORD` in env (encrypted) |
| `sso-redirect` | OAuth / SAML / Okta / ADFS — IdP-mediated flow | pre-recorded Playwright storage-state JSON |
| `multi-step-login` | MFA, captcha, multi-page wizards | pre-recorded Playwright storage-state JSON |

## Working examples

### `no-auth`

```
Explore https://demo.example.com and generate a smoke suite.
projectName: demo
```

The crawler starts at the URL, follows links, identifies forms and
buttons, generates one feature per discovered "page state".

### `basic-login`

env file (`config/myproject/environments/dev.env`):
```
APP_URL=https://app.example.com
APP_USERNAME=admin@example.com
APP_PASSWORD=ENCRYPTED:base64encryptedstring
```

Encrypt the password once via the framework CLI:
```bash
npx cs-playwright-framework encrypt-value --value "myActualPassword"
# Copy the ENCRYPTED:... output into the env file
```

Prompt:
```
Explore https://app.example.com/login and build login + dashboard smoke tests.
projectName: myproject
entryFlow: basic-login
```

The crawler:
1. Loads the URL
2. Detects the username + password fields (heuristic: `input[type=password]` plus the closest preceding text input)
3. Submits with the env credentials
4. Crawls everything reachable post-login

### `sso-redirect`

Record the storage state ONCE interactively, save it to disk, then
let the crawler reuse the saved cookies/tokens:

```bash
# One-time, interactive — opens a browser, you log in manually, save.
npx playwright codegen --save-storage=./.auth/myproject-sso.json https://app.example.com
# After login + landing on the post-SSO page, close the browser.
# The .auth/myproject-sso.json file now has the session cookies.
```

env file:
```
APP_URL=https://app.example.com
APP_STORAGE_STATE=./.auth/myproject-sso.json
```

Prompt:
```
Explore https://app.example.com and build the dashboard regression suite.
projectName: myproject
entryFlow: sso-redirect
```

The crawler injects the storage state before the first navigation —
the app sees the user as already-logged-in and goes straight to the
post-auth page.

### `multi-step-login`

Same pattern as SSO. MFA / captcha / multi-page wizards can't be
automated generically; record once, reuse the storage state.

## Crawl bounds (cost guards)

```
url: https://app.example.com
projectName: myproject
entryFlow: basic-login
maxDurationMinutes: 15
maxStates: 50
strategy: bfs
```

| Bound | Default | Tune up when... | Tune down when... |
|---|---|---|---|
| `maxDurationMinutes` | 15 | App is large + you want full coverage | You're iterating on a small flow |
| `maxStates` | 50 | App has 50+ distinct pages worth testing | You only need a smoke suite |
| `strategy` | `bfs` | (default) | Use `dfs` for deep journeys (checkout flow), `targeted` when you've supplied a specific entry path |

## After exploration

The crawler generates files at its own output directory (not the
framework's standard `test/<project>/` layout — the explorer owns
its own scratch space). The result includes:

- `featureFiles[]` — one `.feature` per discovered "feature" (login, dashboard, settings, etc.)
- `stepDefinitions[]` — `.steps.ts` files matched to features
- `pageObjects[]` — `.page.ts` files for each discovered page state
- `summary` — `statesDiscovered`, `apisDiscovered`, `coverageScore`, `crawlDurationMs`

The master tool then runs the same pre-gate audit + heal loop as
other modes. The `needsSourceValidation: true` flag in the result
warns the user: *the crawler can find elements but can't infer
business intent — review every scenario before merging.*

## Forbidden / unsupported

- **Form-mode elicitation of passwords** is forbidden by the MCP spec.
  Don't expect a password modal — credentials must come from
  `ENCRYPTED:` env values or `mcp.json` `inputs[]` (which use VS Code
  SecretStorage).
- **Captcha-protected apps** can't be auto-crawled. Either use
  `multi-step-login` with a pre-recorded session, or skip auth-bound
  pages entirely with `entryFlow: no-auth` and crawl only the public
  surface.
- **Bot-detection-protected apps** (some banking / finance fronts)
  may flag Playwright as automated. The framework supports stealth
  plugins via `CSBrowserManager` config — set `stealth: true` in
  `global.env`.

## Common gotchas

1. **Login form selectors changed** — if the crawler logs an "auth
   failure" diagnostic, the app's username/password field selectors
   moved. Fix: pre-record a storage state instead, or override the
   selector hints via `loginUrl` / `usernameSelector` /
   `passwordSelector` in tool answers.
2. **Storage state expires** — SSO sessions typically last 8h to 30d.
   When the `.auth/<project>.json` expires, re-record.
3. **Generated tests need review** — the crawler infers structure but
   not intent. A page might be called "dashboard" by the heuristic but
   actually be the user-profile page. Review every generated scenario.
4. **maxStates hit before completion** — log shows
   "exploration completed but produced no test files" → either the
   app's landing is a static page (try a deeper start URL) or the
   bound was too tight (raise `maxStates` to 100+).
5. **Encrypted password rotation** — when the password changes,
   re-encrypt with the CLI and replace the line in env. Don't paste
   plaintext into git.
