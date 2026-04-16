---
name: authentication-session-patterns
description: >
  Canonical patterns for authentication and session management
  in the target test framework. Covers first-time login flows,
  role-based login, session reuse via storageState, re-auth on
  expiry, multi-user scenarios, secret masking, cookie
  manipulation, and forbidden patterns. Load when generating,
  auditing, or healing any login, logout, or session code.
---

# Authentication and Session Patterns

## When this skill applies

Any generated code that logs a user into the application under
test, switches between user roles, reuses a saved session, or
manipulates cookies and storage for authentication purposes.

## First-time login flow

The standard pattern is a login method on a dedicated
`LoginPage` class:

```
@CSPage('login-page')
export class LoginPage extends CSBasePage {

    @CSGetElement({ xpath: "//input[@id='userName']",
        description: 'User name text box' })
    public textBoxUserName!: CSWebElement;

    @CSGetElement({ xpath: "//input[@id='password']",
        description: 'Password text box' })
    public textBoxPassword!: CSWebElement;

    @CSGetElement({ xpath: "//button[@id='loginBtn']",
        description: 'Login button' })
    public buttonLogin!: CSWebElement;

    protected initializeElements(): void {
        CSReporter.debug('LoginPage elements initialized');
    }

    public async navigate(): Promise<void> {
        const url = this.config.getString('LOGIN_URL');
        await this.browserManager.navigateAndWaitReady(url);
    }

    public async login(userName: string, password: string): Promise<void> {
        await this.textBoxUserName.fill(userName);
        await this.textBoxPassword.fill(password);
        await this.buttonLogin.click();
        await this.waitForPageLoad();
        CSReporter.info(`Submitted login for: ${userName}`);
    }
}
```

The step definition orchestrates the full flow:

```
@When('I login as {string}')
async loginAs(userName: string): Promise<void> {
    CSReporter.info(`Logging in as ${userName}`);
    await this.loginPage.navigate();
    const password = CSValueResolver.resolve(
        '{config:APP_PASSWORD}', this.context);
    await this.loginPage.login(userName, password);
    await this.homePage.verifyHeader();
    CSReporter.pass(`Logged in as ${userName}`);
}
```

Rules:
- The username is passed as a parameter (from the data file or
  step parameter)
- The password is read from config via `CSValueResolver`
- The password is NEVER hardcoded, NEVER passed in the step
  phrase, NEVER stored in the data file in plain text
- Login method returns void; verification of the post-login
  page is the step definition's responsibility

## Role-based login

For applications with multiple user roles (admin, regular user,
read-only, etc.), store credentials per role in config and
select by role name:

env file:
```
APP_USERNAME_ADMIN=admin@example.test
APP_PASSWORD_ADMIN=ENCRYPTED:<blob>
APP_USERNAME_USER=user@example.test
APP_PASSWORD_USER=ENCRYPTED:<blob>
APP_USERNAME_READONLY=readonly@example.test
APP_PASSWORD_READONLY=ENCRYPTED:<blob>
```

step definition:
```
@When('I login as {string}')
async loginAsRole(role: string): Promise<void> {
    const upper = role.toUpperCase();
    const userName = CSValueResolver.resolve(
        `{config:APP_USERNAME_${upper}}`, this.context);
    const password = CSValueResolver.resolve(
        `{config:APP_PASSWORD_${upper}}`, this.context);

    await this.loginPage.navigate();
    await this.loginPage.login(userName, password);
    await this.homePage.verifyHeader();
    CSReporter.pass(`Logged in as role: ${role}`);
}
```

Feature file:
```
When I login as "admin"
When I login as "user"
When I login as "readonly"
```

The role strings in the feature file are literal and
case-insensitive — the step definition normalises to uppercase
to match the config key convention.

## Session reuse via storage state

For scenarios that would otherwise re-login every time, save
the storage state after a successful login and reuse it:

```
// First-time setup: login once, save state
@CSBefore({ tags: ['@requires-authenticated-session'] })
async authenticateOnce(): Promise<void> {
    const sessionPath = path.join(
        this.config.getString('TEST_RESULTS_DIR'),
        'storage-state-admin.json'
    );

    if (fs.existsSync(sessionPath)) {
        // Reuse saved state
        await this.browserManager.loadStorageState(sessionPath);
        CSReporter.info('Loaded saved session state');
        return;
    }

    // Log in and save state
    await this.loginPage.navigate();
    const userName = CSValueResolver.resolve(
        '{config:APP_USERNAME_ADMIN}', this.context);
    const password = CSValueResolver.resolve(
        '{config:APP_PASSWORD_ADMIN}', this.context);
    await this.loginPage.login(userName, password);
    await this.homePage.verifyHeader();

    await this.browserManager.saveStorageState(sessionPath);
    CSReporter.info(`Saved session state to: ${sessionPath}`);
}
```

Rules:
- Save one state file per role (admin, user, readonly)
- State files live under the test results directory, NOT under
  version control
- State files are cleaned up between runs if the previous run
  was a different environment or test plan
- State contains cookies, local storage, session storage, and
  IndexedDB — enough for most web apps to skip the login page

### Re-auth on session expiry

Session state has a limited lifetime. The framework's
`clearContextAndReauthenticate` method wraps the re-auth flow:

```
await this.browserManager.clearContextAndReauthenticate({
    loginFn: async () => {
        await this.loginPage.navigate();
        await this.loginPage.login(userName, password);
    }
});
```

Use this when:
- A test hits a 401 or "session expired" response
- The stored state file is older than the session lifetime
- Tests run across a server restart

### Multi-user scenarios in one test

Some scenarios need two users (e.g., user A creates an order,
user B approves it). The cleanest approach is to use two
separate browser contexts:

```
// Context 1: user A creates the order
await this.browserManager.loadStorageState(userAStatePath);
await this.orderPage.createOrder(orderData);

// Switch to user B
await this.browserManager.clearContextAndReauthenticate({
    storageStatePath: userBStatePath
});
await this.orderApprovalPage.approveOrder(orderId);
```

For scenarios where both users are active simultaneously
(e.g., a chat test), use `switchBrowser` with a second
independent browser.

## Logout

Logout is rarely needed in tests — the framework closes the
browser context at the end of each scenario, which is
equivalent. Explicit logout is only needed when:
- Testing the logout flow itself
- Verifying that logout clears sensitive state
- A scenario requires mid-test logout followed by re-login

```
public async logout(): Promise<void> {
    await this.buttonUserMenu.click();
    await this.linkLogout.click();
    await this.loginPage.verifyHeader();
    CSReporter.info('Logged out');
}
```

Do NOT add a logout call to every test's after hook. The
framework's context cleanup is cheaper and more reliable.

## Cookie manipulation

Direct cookie manipulation is occasionally needed (to simulate
a specific auth state, bypass a consent banner, etc.). Access
the underlying Playwright context:

```
const context = this.browserManager.getContext();

// Read cookies
const cookies = await context.cookies();

// Set a cookie
await context.addCookies([{
    name: 'sessionId',
    value: sessionToken,
    domain: 'example.test',
    path: '/',
    httpOnly: true,
    secure: true,
}]);

// Clear cookies
await context.clearCookies();
```

Use sparingly. Cookie manipulation is brittle — the cookie
structure changes with the app, and stale expectations break
tests silently.

## Local and session storage

Similarly via the context:

```
await this.page.evaluate(() => {
    localStorage.setItem('consentGiven', 'true');
    sessionStorage.setItem('onboardingSeen', 'true');
});
```

Or via the storage state mechanism for persistent pre-seeding:

```
const state = await context.storageState();
// state.origins[0].localStorage carries the local storage items
```

## Secret masking

- Passwords resolved via `CSValueResolver.resolve('{config:APP_PASSWORD}')`
  are marked as secrets by the framework and masked in reports
- Session tokens, API keys, and certificates follow the same
  convention
- Never log a resolved secret via `CSReporter.info` with the
  raw value — the automatic masker catches most cases but
  explicit concatenation can defeat it
- When in doubt, log a placeholder: `CSReporter.info('Using
  admin credentials')` instead of `CSReporter.info('Using
  password: ' + password)`

See `reporting-logging-patterns` for full masking rules.

## Forbidden patterns

Never do any of these in auth code:

- Hardcode credentials in step definitions, page objects, or
  data files
- Pass passwords as step phrase parameters:
  `When I login as "alice" with password "secret123"`
- Store unencrypted passwords in env files
- Log raw passwords, tokens, or session cookies
- Use `page.evaluate(() => localStorage.setItem(...))` to fake
  auth state when the app expects a real session (use
  `loadStorageState` instead)
- Share storage state files across environments (env-specific
  session state)
- Commit storage state files to version control
- Catch a login failure and fall back to an anonymous session
  silently
- Call logout in an after hook when context cleanup would do
  the same thing
- Use `{config:APP_PASSWORD}` in the feature file directly —
  resolve in the step definition

## Self-check before returning auth code

- [ ] Credentials come from config via `CSValueResolver`
- [ ] Passwords are NEVER in data files, feature files, or step
      phrases
- [ ] Secrets are encrypted in env files
- [ ] Role-based login uses `APP_USERNAME_<ROLE>` / 
      `APP_PASSWORD_<ROLE>` convention
- [ ] Session reuse uses `saveStorageState` / `loadStorageState`
- [ ] Storage state files live under the results directory,
      not committed
- [ ] Re-auth uses `clearContextAndReauthenticate`
- [ ] Multi-user scenarios use separate contexts or
      storage-state switches
- [ ] Cookies and local storage manipulation has a clear reason
      (not just "faster setup")
- [ ] No hardcoded credentials anywhere
- [ ] No raw secret values logged

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
