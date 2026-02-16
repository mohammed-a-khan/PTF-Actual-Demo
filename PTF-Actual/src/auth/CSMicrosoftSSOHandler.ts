/**
 * CSMicrosoftSSOHandler - Automates Microsoft Azure AD / Entra ID SSO Login Flow
 *
 * Handles the multi-step Microsoft login redirect chain:
 *   App URL → login.microsoftonline.com → email → password → "Stay signed in?" → redirect back
 *
 * Designed for:
 *   - Microsoft Dynamics 365 CRM
 *   - Power Platform apps
 *   - Any Azure AD-protected web application
 *
 * Prerequisites:
 *   - Test user with 2FA/MFA disabled (or excluded via Conditional Access policy)
 *   - AUTH_SERVER_ALLOWLIST="_" in config (to prevent VDI Kerberos auto-negotiation)
 *
 * Configuration:
 *   SSO_USERNAME          - Microsoft account email
 *   SSO_PASSWORD          - Microsoft account password
 *   SSO_LOGIN_URL         - App URL that triggers SSO redirect (default: BASE_URL)
 *   SSO_WAIT_TIMEOUT      - Timeout for login flow completion (default: 60000ms)
 *   SSO_STAY_SIGNED_IN    - Click "Yes" on "Stay signed in?" prompt (default: true)
 *   AUTH_STORAGE_STATE_PATH - Path to save session after login (optional)
 */

import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSBrowserManager } from '../browser/CSBrowserManager';
import * as path from 'path';

export interface SSOLoginOptions {
    /** Microsoft account email (overrides SSO_USERNAME config) */
    username?: string;
    /** Microsoft account password (overrides SSO_PASSWORD config) */
    password?: string;
    /** URL that triggers SSO redirect (overrides SSO_LOGIN_URL / BASE_URL config) */
    loginUrl?: string;
    /** Save session to this file after successful login */
    saveSessionPath?: string;
    /** Timeout for the entire login flow in ms (default: 60000) */
    timeout?: number;
    /** Click "Yes" on "Stay signed in?" prompt (default: true) */
    staySignedIn?: boolean;
}

export class CSMicrosoftSSOHandler {
    private config: CSConfigurationManager;
    private browserManager: CSBrowserManager;

    constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.browserManager = CSBrowserManager.getInstance();
    }

    /**
     * Perform Microsoft SSO login using credentials from config
     * Reads SSO_USERNAME and SSO_PASSWORD from configuration hierarchy
     */
    public async loginWithConfigCredentials(options?: Partial<SSOLoginOptions>): Promise<void> {
        const username = options?.username || this.config.get('SSO_USERNAME');
        const password = options?.password || this.config.get('SSO_PASSWORD');

        if (!username) {
            throw new Error('SSO_USERNAME not configured. Set it in your env file or pass it as an option.');
        }
        if (!password) {
            throw new Error('SSO_PASSWORD not configured. Set it in your env file or pass it as an option.');
        }

        await this.login({
            username,
            password,
            loginUrl: options?.loginUrl,
            saveSessionPath: options?.saveSessionPath,
            timeout: options?.timeout,
            staySignedIn: options?.staySignedIn,
        });
    }

    /**
     * Perform Microsoft SSO login as a named user
     * Looks up credentials from config using pattern: SSO_{NAME}_USERNAME, SSO_{NAME}_PASSWORD
     * Falls back to SSO_USERNAME/SSO_PASSWORD if named credentials not found
     */
    public async loginAsUser(userNameOrAlias: string, options?: Partial<SSOLoginOptions>): Promise<void> {
        // Try named credentials first (e.g., SSO_ADMIN_USERNAME, SSO_ADMIN_PASSWORD)
        const nameKey = userNameOrAlias.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        let username = this.config.get(`SSO_${nameKey}_USERNAME`);
        let password = this.config.get(`SSO_${nameKey}_PASSWORD`);

        // If not found by alias, treat the input as the actual username
        if (!username) {
            username = userNameOrAlias;
            password = password || this.config.get('SSO_PASSWORD');
        }

        if (!password) {
            throw new Error(
                `No password found for user "${userNameOrAlias}". ` +
                `Configure SSO_${nameKey}_PASSWORD or SSO_PASSWORD in your env file.`
            );
        }

        await this.login({
            username,
            password,
            loginUrl: options?.loginUrl,
            saveSessionPath: options?.saveSessionPath,
            timeout: options?.timeout,
            staySignedIn: options?.staySignedIn,
        });
    }

    /**
     * Core login flow: Navigate → detect Microsoft login → fill credentials → wait for redirect
     *
     * VDI/Domain-Joined Fix:
     *   On enterprise VDIs, Windows Integrated Authentication (Kerberos/NTLM) and Azure AD
     *   Seamless SSO automatically pass the logged-in Windows user's credentials, bypassing
     *   the email/password fields entirely. To force login as the TEST user instead:
     *   1. Sign out of any existing Microsoft session first
     *   2. Intercept OAuth redirects to inject login_hint=<test_user> and prompt=login
     *   3. This forces Microsoft to show the login form for the specified test user
     */
    public async login(options: SSOLoginOptions): Promise<void> {
        const { username, password, staySignedIn = true } = options;
        const loginUrl = options.loginUrl || this.config.get('SSO_LOGIN_URL') || this.config.get('BASE_URL');
        const timeout = options.timeout || this.config.getNumber('SSO_WAIT_TIMEOUT', 60000);
        const saveSessionPath = options.saveSessionPath || this.config.get('AUTH_STORAGE_STATE_PATH');

        if (!username || !password) {
            throw new Error('Username and password are required for SSO login');
        }

        if (!loginUrl) {
            throw new Error('No login URL available. Configure SSO_LOGIN_URL or BASE_URL.');
        }

        const page = this.browserManager.getPage();
        CSReporter.info(`Starting Microsoft SSO login for: ${username}`);
        CSReporter.info(`Login URL: ${loginUrl}`);

        try {
            // Step 1: Sign out any existing Microsoft session (VDI fix)
            // On domain-joined machines, the browser may auto-authenticate as the Windows user.
            // Signing out first ensures we get a clean login page for the test user.
            CSReporter.info('Step 1: Clearing any existing Microsoft session...');
            await this.clearMicrosoftSession(page, timeout);

            // Step 2: Set up route interception to inject login_hint into OAuth redirects
            // This forces Microsoft to show the login page for our test user, not the VDI user.
            CSReporter.info('Step 2: Setting up OAuth redirect interception...');
            await this.setupOAuthInterception(page, username);

            // Step 3: Navigate to the app URL (triggers SSO redirect)
            CSReporter.info('Step 3: Navigating to application URL...');
            await page.goto(loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: timeout
            });

            // Step 4: Wait for Microsoft login page to appear
            CSReporter.info('Step 4: Waiting for Microsoft login page...');
            await this.waitForMicrosoftLoginPage(page, timeout);

            // Step 5: Enter email/username (or skip if login_hint pre-filled it)
            CSReporter.info('Step 5: Entering email address...');
            await this.enterEmail(page, username, timeout);

            // Step 6: Enter password
            CSReporter.info('Step 6: Entering password...');
            await this.enterPassword(page, password, timeout);

            // Step 7: Handle "Stay signed in?" prompt
            if (staySignedIn !== false) {
                CSReporter.info('Step 7: Handling "Stay signed in?" prompt...');
                await this.handleStaySignedIn(page, staySignedIn, timeout);
            }

            // Step 8: Wait for redirect back to the application
            CSReporter.info('Step 8: Waiting for redirect back to application...');
            await this.waitForAppRedirect(page, loginUrl, timeout);

            // Remove route interception (cleanup)
            await this.removeOAuthInterception(page);

            CSReporter.pass(`Microsoft SSO login successful for: ${username}`);

            // Step 9: Save session if configured
            if (saveSessionPath) {
                CSReporter.info('Step 9: Saving browser session...');
                await this.browserManager.saveStorageState(saveSessionPath);
                CSReporter.pass(`Session saved to: ${saveSessionPath}`);
            }

        } catch (error: any) {
            // Remove route interception on failure too
            try { await this.removeOAuthInterception(page); } catch { /* ignore */ }

            // Capture screenshot on failure for debugging
            try {
                const screenshotPath = path.join(
                    process.cwd(),
                    `sso-login-failure-${Date.now()}.png`
                );
                await page.screenshot({ path: screenshotPath, fullPage: true });
                CSReporter.warn(`SSO login failure screenshot saved: ${screenshotPath}`);
            } catch (screenshotError) {
                // Ignore screenshot errors
            }

            CSReporter.fail(`Microsoft SSO login failed: ${error.message}`);
            throw new Error(`Microsoft SSO login failed for ${username}: ${error.message}`);
        }
    }

    /**
     * Route handler references — stored so we can remove them after login
     */
    private oauthRouteHandler: ((route: any) => Promise<void>) | null = null;
    private autologonRouteHandler: ((route: any) => Promise<void>) | null = null;

    /**
     * Clear any existing Microsoft session by navigating to the Microsoft sign-out endpoint.
     * This is critical on VDI/domain-joined machines where Windows Integrated Auth (Kerberos)
     * auto-passes the logged-in Windows user's credentials, bypassing the test user login.
     */
    private async clearMicrosoftSession(page: any, timeout: number): Promise<void> {
        try {
            // Navigate to Microsoft sign-out endpoint
            // This clears Microsoft session cookies so the next login starts fresh
            await page.goto('https://login.microsoftonline.com/common/oauth2/logout', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            // Brief wait for sign-out to complete
            await page.waitForTimeout(1500);

            // Also clear all cookies in the current context to remove any cached auth
            const context = page.context();
            await context.clearCookies();
            CSReporter.debug('Microsoft session cleared and cookies purged');
        } catch (error: any) {
            // Sign-out failure is non-fatal — continue with the login flow
            CSReporter.debug(`Microsoft session clear attempt: ${error.message} (non-fatal)`);
        }
    }

    /**
     * Set up Playwright route interception for VDI/domain-joined machine SSO bypass.
     *
     * Problem: On enterprise VDIs (especially with Edge), multiple SSO mechanisms auto-authenticate:
     *   1. Azure AD Seamless SSO — sends Kerberos ticket to autologon.microsoftonline.com
     *   2. Primary Refresh Token (PRT) — Edge sends x-ms-RefreshTokenCredential cookie
     *   3. Windows Negotiate Auth — browser sends Authorization: Negotiate header
     *
     * Solution (3 layers):
     *   Layer 1: BLOCK autologon.microsoftonline.com entirely (prevents Seamless SSO)
     *   Layer 2: STRIP auth headers & PRT cookies from login.microsoftonline.com requests
     *   Layer 3: INJECT login_hint + prompt=login into OAuth authorize URLs
     */
    private async setupOAuthInterception(page: any, testUsername: string): Promise<void> {
        // Layer 1: Block Azure AD Seamless SSO endpoint entirely
        // autologon.microsoftonline.com is where Kerberos/PRT-based silent auth happens.
        // By aborting these requests, we force Microsoft to show the interactive login page.
        this.autologonRouteHandler = async (route: any) => {
            CSReporter.debug(`Blocked Seamless SSO request: ${route.request().url()}`);
            await route.abort('blockedbyclient');
        };
        await page.route('**/*autologon.microsoftonline.com/**', this.autologonRouteHandler);

        // Layer 2 + 3: Intercept login.microsoftonline.com requests
        this.oauthRouteHandler = async (route: any) => {
            const url = route.request().url();
            const headers = { ...route.request().headers() };

            // Layer 2: Strip Windows SSO credentials from ALL Microsoft login requests
            // - Authorization header carries Kerberos/NTLM negotiate tokens
            // - x-ms-RefreshTokenCredential cookie carries the PRT (Edge-specific)
            let headersModified = false;

            if (headers['authorization']) {
                delete headers['authorization'];
                headersModified = true;
            }

            // Strip PRT cookie from the cookie header
            if (headers['cookie']) {
                const originalCookie = headers['cookie'];
                const filteredCookies = originalCookie
                    .split(';')
                    .map((c: string) => c.trim())
                    .filter((c: string) =>
                        !c.startsWith('x-ms-RefreshTokenCredential') &&
                        !c.startsWith('x-ms-DeviceCredential')
                    )
                    .join('; ');
                if (filteredCookies !== originalCookie) {
                    headers['cookie'] = filteredCookies;
                    headersModified = true;
                }
            }

            if (headersModified) {
                CSReporter.debug(`Stripped Windows SSO credentials from: ${url.substring(0, 80)}...`);
            }

            // Layer 3: Inject login_hint + prompt=login into OAuth authorize URLs
            if (url.includes('/oauth2/authorize') || url.includes('/oauth2/v2.0/authorize')) {
                try {
                    const urlObj = new URL(url);
                    urlObj.searchParams.set('login_hint', testUsername);
                    urlObj.searchParams.set('prompt', 'login');
                    const modifiedUrl = urlObj.toString();
                    CSReporter.debug(`OAuth intercept: login_hint=${testUsername}, prompt=login`);
                    await route.continue({ url: modifiedUrl, headers });
                    return;
                } catch (err: any) {
                    CSReporter.debug(`OAuth URL modification failed: ${err.message}`);
                }
            }

            // For non-OAuth requests to login.microsoftonline.com, still strip headers
            await route.continue({ headers });
        };

        await page.route('**/*login.microsoftonline.com/**', this.oauthRouteHandler);
        CSReporter.debug('VDI SSO bypass active: autologon blocked + headers stripped + OAuth params injected');
    }

    /**
     * Remove all route interception after login is complete
     */
    private async removeOAuthInterception(page: any): Promise<void> {
        try {
            if (this.autologonRouteHandler) {
                await page.unroute('**/*autologon.microsoftonline.com/**', this.autologonRouteHandler);
                this.autologonRouteHandler = null;
            }
            if (this.oauthRouteHandler) {
                await page.unroute('**/*login.microsoftonline.com/**', this.oauthRouteHandler);
                this.oauthRouteHandler = null;
            }
            CSReporter.debug('VDI SSO bypass routes removed');
        } catch {
            // Ignore — page may already be closed
        }
    }

    /**
     * Wait for the Microsoft login page to appear
     * Handles various redirect patterns (ADFS, B2C, direct AAD)
     */
    private async waitForMicrosoftLoginPage(page: any, timeout: number): Promise<void> {
        try {
            // Wait for either the email input field or the URL to contain Microsoft login domains
            await page.waitForFunction(
                () => {
                    const url = window.location.href.toLowerCase();
                    const isMicrosoftLogin =
                        url.includes('login.microsoftonline.com') ||
                        url.includes('login.microsoft.com') ||
                        url.includes('login.live.com') ||
                        url.includes('sts.windows.net') ||
                        url.includes('adfs');

                    // Also check if the email input field is present
                    const emailInput =
                        document.querySelector('input[type="email"]') ||
                        document.querySelector('input[name="loginfmt"]') ||
                        document.querySelector('#i0116');

                    return isMicrosoftLogin || emailInput;
                },
                { timeout: timeout }
            );
            CSReporter.debug(`Microsoft login page detected at: ${page.url()}`);
        } catch (error) {
            // Check if we're already on the app (SSO was auto-completed via cached session)
            const currentUrl = page.url().toLowerCase();
            if (!currentUrl.includes('login.microsoftonline.com') &&
                !currentUrl.includes('login.microsoft.com') &&
                !currentUrl.includes('login.live.com')) {
                CSReporter.info('App loaded without SSO redirect — session may already be active');
                return;
            }
            throw new Error(`Microsoft login page did not appear within ${timeout}ms. Current URL: ${page.url()}`);
        }
    }

    /**
     * Enter email address on the Microsoft login page.
     *
     * When login_hint is injected via OAuth interception, Microsoft may:
     *   a) Pre-fill the email and still show the email page → we click Next
     *   b) Skip the email page entirely and show the password page directly
     *   c) Show "Pick an account" page → we click "Use another account" or select the right one
     *
     * This method handles all three cases gracefully.
     */
    private async enterEmail(page: any, email: string, timeout: number): Promise<void> {
        // Race: wait for either the email input OR the password input to become visible.
        // With login_hint + prompt=login, Microsoft may skip straight to password.
        try {
            const result = await Promise.race([
                page.waitForSelector('input[type="email"]:visible, input[name="loginfmt"]:visible, #i0116:visible', { timeout: 15000 })
                    .then((el: any) => ({ type: 'email', element: el })),
                page.waitForSelector('input[type="password"]:visible, input[name="passwd"]:visible, #i0118:visible, #passwordInput:visible', { timeout: 15000 })
                    .then((el: any) => ({ type: 'password', element: el })),
                page.waitForSelector('#otherTileText, text="Use another account"', { timeout: 15000 })
                    .then((el: any) => ({ type: 'pickAccount', element: el })),
            ]);

            if (result.type === 'password') {
                // login_hint worked — Microsoft skipped email and went straight to password
                CSReporter.debug('Email page skipped (login_hint accepted) — password page shown directly');
                return;
            }

            if (result.type === 'pickAccount') {
                // "Pick an account" page — click "Use another account"
                CSReporter.debug('"Pick an account" page detected — clicking "Use another account"');
                await result.element.click();
                await page.waitForTimeout(1000);
                // Now wait for the email input
                await page.waitForSelector('input[type="email"]:visible, input[name="loginfmt"]:visible, #i0116:visible', { timeout: 10000 });
            }

            // Email input is visible — fill it
            const emailSelector = 'input[type="email"], input[name="loginfmt"], #i0116';
            const emailInput = await page.waitForSelector(emailSelector, {
                state: 'visible',
                timeout: 10000
            });

            if (!emailInput) {
                throw new Error('Email input field not found on Microsoft login page');
            }

            // Clear any pre-filled value and type the email
            await emailInput.fill('');
            await emailInput.fill(email);

            // Click "Next" button
            const nextButton = await page.waitForSelector(
                'input[type="submit"][value="Next"], #idSIButton9, button[type="submit"]',
                { state: 'visible', timeout: 10000 }
            );
            await nextButton.click();

            // Wait for the page transition (password page or error)
            await page.waitForTimeout(1000);
            CSReporter.debug('Email entered and Next clicked');
        } catch (error: any) {
            // Check if we ended up on the password page despite the race timeout
            try {
                const passwordVisible = await page.isVisible('input[type="password"], input[name="passwd"], #i0118, #passwordInput');
                if (passwordVisible) {
                    CSReporter.debug('Password page detected after email step — continuing');
                    return;
                }
            } catch { /* ignore */ }

            throw new Error(`Email entry failed: ${error.message}`);
        }
    }

    /**
     * Enter password on the Microsoft login page
     */
    private async enterPassword(page: any, password: string, timeout: number): Promise<void> {
        // Wait for the password input to be visible
        // Microsoft may show different password fields depending on the auth flow
        const passwordSelector = 'input[type="password"], input[name="passwd"], #i0118, #passwordInput';
        const passwordInput = await page.waitForSelector(passwordSelector, {
            state: 'visible',
            timeout: timeout
        });

        if (!passwordInput) {
            throw new Error('Password input field not found on Microsoft login page');
        }

        // Fill in the password
        await passwordInput.fill(password);

        // Click "Sign in" button
        const signInButton = await page.waitForSelector(
            'input[type="submit"][value="Sign in"], #idSIButton9, button[type="submit"], #submitButton',
            { state: 'visible', timeout: 10000 }
        );
        await signInButton.click();

        // Wait for the page transition
        await page.waitForTimeout(2000);
        CSReporter.debug('Password entered and Sign in clicked');

        // Check for error messages
        try {
            const errorElement = await page.waitForSelector(
                '#passwordError, #usernameError, .alert-error, #errorText',
                { state: 'visible', timeout: 3000 }
            );
            if (errorElement) {
                const errorText = await errorElement.textContent();
                throw new Error(`Microsoft login error: ${errorText?.trim()}`);
            }
        } catch (error: any) {
            // No error message found — login is proceeding (timeout is expected)
            if (!error.message.includes('Microsoft login error')) {
                CSReporter.debug('No login error detected — proceeding');
            } else {
                throw error;
            }
        }
    }

    /**
     * Handle the "Stay signed in?" prompt
     * Microsoft shows this after successful authentication
     */
    private async handleStaySignedIn(page: any, clickYes: boolean, timeout: number): Promise<void> {
        try {
            // Wait for the "Stay signed in?" prompt (may not appear in all flows)
            const staySignedInText = await page.waitForSelector(
                '#KmsIText, text="Stay signed in?", text="Remain signed in?", #lightbox',
                { state: 'visible', timeout: 10000 }
            );

            if (staySignedInText) {
                if (clickYes) {
                    // Click "Yes" to stay signed in (creates persistent cookies)
                    const yesButton = await page.waitForSelector(
                        '#idSIButton9, #idBtn_Back, input[type="submit"][value="Yes"], button:has-text("Yes")',
                        { state: 'visible', timeout: 5000 }
                    );

                    if (yesButton) {
                        // Check "Don't show this again" checkbox if available
                        try {
                            const dontShowCheckbox = await page.$('#KmsiCheckboxField');
                            if (dontShowCheckbox) {
                                await dontShowCheckbox.check();
                            }
                        } catch {
                            // Checkbox not present — ignore
                        }

                        await yesButton.click();
                        CSReporter.debug('"Stay signed in?" — clicked Yes');
                    }
                } else {
                    // Click "No"
                    const noButton = await page.waitForSelector(
                        '#idBtn_Back, input[type="button"][value="No"], button:has-text("No")',
                        { state: 'visible', timeout: 5000 }
                    );
                    if (noButton) {
                        await noButton.click();
                        CSReporter.debug('"Stay signed in?" — clicked No');
                    }
                }
            }
        } catch (error) {
            // "Stay signed in?" prompt may not appear — this is OK
            CSReporter.debug('"Stay signed in?" prompt not detected — continuing');
        }
    }

    /**
     * Wait for redirect back to the application after login
     */
    private async waitForAppRedirect(page: any, originalUrl: string, timeout: number): Promise<void> {
        try {
            // Extract the app domain from the original URL
            const appDomain = new URL(originalUrl).hostname;

            await page.waitForFunction(
                (domain: string) => {
                    const url = window.location.href.toLowerCase();
                    // No longer on Microsoft login pages
                    const notOnLogin =
                        !url.includes('login.microsoftonline.com') &&
                        !url.includes('login.microsoft.com') &&
                        !url.includes('login.live.com') &&
                        !url.includes('sts.windows.net');
                    // On the app domain or any non-Microsoft page
                    const onApp = url.includes(domain.toLowerCase()) || notOnLogin;
                    return onApp;
                },
                appDomain,
                { timeout: timeout }
            );

            // Additional wait for the app to fully load
            await page.waitForLoadState('domcontentloaded', { timeout: timeout });

            CSReporter.debug(`Redirected back to application: ${page.url()}`);
        } catch (error) {
            const currentUrl = page.url();
            // If we're on the app URL already, consider it successful
            if (!currentUrl.includes('login.microsoftonline.com') &&
                !currentUrl.includes('login.microsoft.com')) {
                CSReporter.debug(`Already on application page: ${currentUrl}`);
                return;
            }
            throw new Error(`App redirect did not complete within ${timeout}ms. Current URL: ${currentUrl}`);
        }
    }

    /**
     * Check if the current page requires Microsoft SSO login
     * Useful for conditional login logic
     */
    public async isOnMicrosoftLoginPage(): Promise<boolean> {
        try {
            const page = this.browserManager.getPage();
            const url = page.url().toLowerCase();
            return (
                url.includes('login.microsoftonline.com') ||
                url.includes('login.microsoft.com') ||
                url.includes('login.live.com') ||
                url.includes('sts.windows.net')
            );
        } catch {
            return false;
        }
    }

    /**
     * Check if a saved session file exists and is recent enough to reuse
     * @param maxAgeHours - Maximum age of the session file in hours (default: 12)
     */
    public isSessionValid(maxAgeHours: number = 12): boolean {
        const sessionPath = this.config.get('AUTH_STORAGE_STATE_PATH');
        if (!sessionPath) return false;

        const fs = require('fs');
        const resolvedPath = path.resolve(sessionPath);

        if (!fs.existsSync(resolvedPath)) return false;

        try {
            const stats = fs.statSync(resolvedPath);
            const fileAgeHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
            const isValid = fileAgeHours < maxAgeHours;
            CSReporter.debug(`Session file age: ${fileAgeHours.toFixed(1)}h, max: ${maxAgeHours}h, valid: ${isValid}`);
            return isValid;
        } catch {
            return false;
        }
    }

    /**
     * Smart login: Use saved session if valid, otherwise perform fresh login
     * This is the recommended method for test suites
     */
    public async ensureLoggedIn(options?: Partial<SSOLoginOptions>): Promise<void> {
        const maxSessionAge = this.config.getNumber('SSO_SESSION_MAX_AGE_HOURS', 12);

        if (this.isSessionValid(maxSessionAge)) {
            CSReporter.info('Using existing saved session (still valid)');
            // Session will be loaded automatically via AUTH_STORAGE_STATE_PATH in createContext
            return;
        }

        CSReporter.info('No valid session found — performing fresh SSO login');
        await this.loginWithConfigCredentials(options);
    }
}
