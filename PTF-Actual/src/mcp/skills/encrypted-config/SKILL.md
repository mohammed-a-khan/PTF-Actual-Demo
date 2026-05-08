---
name: encrypted-config
description: Use when generated test code reads any config value, especially secrets (DB passwords, ADO PAT, API tokens). Always go through CSValueResolver — supports ENCRYPTED: prefix and {input:...} placeholders. Never use raw process.env. Pairs with audit rule ENV100.
---

# Pattern: encrypted config + value resolution

## When to use

Any place a test reads a value from env / config — login URLs, base
URLs, DB passwords, API tokens, ADO PATs. The framework's
`CSValueResolver` provides a single resolution mechanism that:

1. Resolves `{config:KEY}` from env files (with the 8-level
   precedence: workspace > common > env-specific > etc.)
2. Auto-decrypts values prefixed with `ENCRYPTED:` via the bundled
   AES key
3. Resolves `{input:KEY}` from the MCP-server's prompt-string inputs
   (stored in VS Code SecretStorage)
4. Resolves nested placeholders recursively

## Working example

```typescript
import {
    CSBasePage, CSElement, CSGetElement, CSPage, CSReporter,
    CSValueResolver,
} from '@mdakhan.mak/cs-playwright-test-framework';

@CSPage('login')
export class LoginPage extends CSBasePage {
    @CSGetElement({ xpath: "//input[@id='username']", description: 'Username field' })
    private usernameField!: CSElement;

    @CSGetElement({ xpath: "//input[@id='password']", description: 'Password field' })
    private passwordField!: CSElement;

    @CSGetElement({ xpath: "//button[@type='submit']", description: 'Login button', selfHeal: true })
    private loginButton!: CSElement;

    /** Login using credentials stored in env (password is ENCRYPTED:). */
    public async loginAs(userKey: string): Promise<void> {
        // Resolves config keys per project + env hierarchy. Synchronous —
        // CSValueResolver.resolve() returns the resolved string directly.
        const username = CSValueResolver.resolve(`{config:${userKey}_USERNAME}`);
        const password = CSValueResolver.resolve(`{config:${userKey}_PASSWORD}`);

        await this.usernameField.fillWithTimeout(username, 5000);
        await this.passwordField.fillWithTimeout(password, 5000);
        await this.loginButton.clickWithTimeout(30000);

        CSReporter.info(`Logged in as ${userKey}`);
        // NOTE: never log the actual password; the framework auto-redacts
        // ENCRYPTED: values from CSReporter output.
    }

    /** Navigate to the app's base URL — typical Background step. */
    public async navigateToHome(): Promise<void> {
        const baseUrl = CSValueResolver.resolve('{config:APP_URL}');
        await this.navigate(baseUrl);
    }
}
```

## env file structure

**`config/myproject/environments/dev.env`:**
```
APP_URL=https://demo.example.com

# Plain config values
USER_ADMIN_USERNAME=admin@example.com

# Encrypted values — ENCRYPTED: prefix triggers auto-decrypt at resolve time
USER_ADMIN_PASSWORD=ENCRYPTED:base64encryptedstring
ADO_PAT=ENCRYPTED:base64encryptedpat

# DB credentials
APP_DB_HOST=db.dev.example.com
APP_DB_USER=app_test
APP_DB_PASSWORD=ENCRYPTED:base64encryptedstring
APP_DB_NAME=APPDB

# Named queries
DB_QUERY_GET_USER=SELECT * FROM users WHERE id = :id
```

## Encrypting a value (one-time, in shell)

```bash
# CSEncryptionUtil exposed via the framework CLI
npx cs-playwright-framework encrypt-value --value "myActualPassword"
# Output: ENCRYPTED:<base64-encoded-ciphertext>
```

Paste the output — including the `ENCRYPTED:` prefix — into the env file.

## Resolution precedence (when same key appears in multiple files)

1. `config/<project>/environments/<env>.env`  (highest priority)
2. `config/<project>/common/common.env`
3. `config/<project>/global.env`
4. `config/common/common.env`
5. `config/global.env`
6. Process env (`process.env`)
7. Defaults baked into framework
8. Tool-call `answers` parameter (lowest priority — fallback only)

## CSValueResolver cheat sheet

| Need | Call |
|---|---|
| Resolve `{config:KEY}` (sync) | `CSValueResolver.resolve('{config:APP_URL}', context?)` |
| Multi-placeholder string | `CSValueResolver.resolve('{config:HOST}:{config:PORT}/api')` |
| Resolve every value in an object | `CSValueResolver.resolveObject(obj, context?)` |
| Nested templates | Resolves recursively |
| Pass scenario state via context | `CSValueResolver.resolve(template, { getVariable: (k) => ctx.get(k) })` |

Plain env values without `ENCRYPTED:` prefix come back unchanged.
`ENCRYPTED:` values are auto-decrypted via the bundled key. Skip the
`{config:...}` wrapper if you want a literal string.

## Forbidden patterns (audit rule ENV100 fails the file)

```typescript
// ❌ NEVER
const url = process.env.APP_URL;
const pwd = process.env.USER_PASSWORD;
const token = process.env['ADO_PAT'];
process.env.APP_URL  // anywhere in test code
```

These bypass:
- ENCRYPTED: auto-decryption
- Project + env hierarchy
- Per-run overrides via tool answers
- Secret-redaction in CSReporter logs (you'd accidentally log raw passwords)

Audit rule `ENV100` blocks any `process.env.<KEY>` reference in test
code.

## Common gotchas

1. **`resolve` is synchronous** — no `await` needed. Returns the
   resolved string directly. Throws on truly missing keys when the
   template can't be substituted.
2. **Template precedence is left-to-right** — `'{config:A}/{config:B}'`
   resolves A first, then B.
3. **ENCRYPTED: values can't be edited in plain text.** To rotate,
   encrypt the new value with the CLI and replace the line.
4. **Secret redaction** — `CSReporter.info(\`pwd=${password}\`)` will
   log the encrypted form, not the decrypted one, IF you got the
   value through `CSValueResolver.resolve`. If you assigned the
   decrypted value to a local variable and logged THAT, the redaction
   is up to you. Best practice: never log credentials at all.
