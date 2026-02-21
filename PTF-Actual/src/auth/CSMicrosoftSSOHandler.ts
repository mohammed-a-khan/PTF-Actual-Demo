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
     * Core login flow — Adaptive for enterprise VDIs
     *
     * Supports two modes automatically:
     *
     * Mode A: Fresh browser (no persistent context)
     *   Navigate → Microsoft logout → OAuth interception → enter credentials → redirect back
     *
     * Mode B: Persistent context (BROWSER_USER_DATA_DIR set — VDI Edge profile)
     *   Clear cookies → Navigate to app → VDI auto-authenticates (Conditional Access OK) →
     *   app error page → set up OAuth interception (block autologon + rewrite redirect_uri) →
     *   click Sign Out → Microsoft login → enter test credentials → redirect back to app
     *
     * The method detects which page it lands on and handles it accordingly.
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
        const isPersistentContext = !!this.config.get('BROWSER_USER_DATA_DIR');
        CSReporter.info(`Starting Microsoft SSO login for: ${username}`);
        CSReporter.info(`Login URL: ${loginUrl}`);
        CSReporter.info(`Mode: ${isPersistentContext ? 'Persistent context (VDI profile)' : 'Fresh browser'}`);

        try {
            if (!isPersistentContext) {
                // === Mode A: Fresh browser — clear session + intercept OAuth ===
                CSReporter.info('Step 1: Clearing any existing Microsoft session...');
                await this.clearMicrosoftSession(page, timeout);

                CSReporter.info('Step 2: Setting up OAuth redirect interception...');
                await this.setupOAuthInterception(page, username, loginUrl);
            } else {
                // === Mode B: Persistent context (VDI Edge profile) ===
                //
                // Strategy: Clear ALL state and set up OAuth interception BEFORE navigating
                // to the app. This prevents VDI auto-authentication and goes directly to the
                // Microsoft login page, bypassing the error page → Sign Out flow entirely.
                //
                // Why skip the Sign Out flow?
                // The CRM Sign Out redirect chain embeds the sign-out page URL (notification.aspx)
                // as the return URL in the OAuth state. After form_post, CRM tries to redirect
                // to notification.aspx which fails or triggers another sign-out — creating a loop.
                // By navigating fresh (no CRM sign-out), the OAuth state has the correct return URL.

                // Phase 1: Clear ALL cookies (CRM + Microsoft) for a clean slate
                CSReporter.info('Step 0: Clearing all browsing state for clean login...');
                try {
                    await page.context().clearCookies();
                    CSReporter.debug('Cleared all cookies');
                } catch (e: any) {
                    CSReporter.debug(`Cookie clear: ${e.message}`);
                }

                // Phase 2: CDP — clear cache, storage, and service workers
                try {
                    const cdpSession = await page.context().newCDPSession(page);
                    await cdpSession.send('Network.clearBrowserCache');
                    // Clear all storage for the CRM origin (localStorage, indexedDB, service workers)
                    const crmOrigin = new URL(loginUrl).origin;
                    await cdpSession.send('Storage.clearDataForOrigin', {
                        origin: crmOrigin,
                        storageTypes: 'all'
                    });
                    await cdpSession.send('Storage.clearDataForOrigin', {
                        origin: 'https://login.microsoftonline.com',
                        storageTypes: 'all'
                    });
                    CSReporter.debug('CDP: Cleared cache, storage, and service workers');
                    await cdpSession.detach();
                } catch (e: any) {
                    CSReporter.debug(`CDP state clear: ${e.message}`);
                }

                // Phase 3: Microsoft logout — clear server-side session
                CSReporter.info('Step 1: Clearing Microsoft server-side session...');
                try {
                    await page.goto('https://login.microsoftonline.com/common/oauth2/logout', {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000
                    });
                    await page.waitForTimeout(2000);
                    CSReporter.debug('Microsoft server-side session cleared');
                } catch (e: any) {
                    CSReporter.debug(`Microsoft logout: ${e.message}`);
                }

                // Phase 4: Set up OAuth interception BEFORE navigating to CRM
                // By blocking autologon before the first CRM request, we prevent
                // VDI Kerberos/PRT auto-authentication and go directly to the login page.
                CSReporter.info('Step 2: Setting up OAuth interception...');
                await this.setupOAuthInterception(page, username, loginUrl);
            }

            // Navigate to the application URL
            CSReporter.info(`Step ${isPersistentContext ? '3' : '3'}: Navigating to application URL...`);
            await page.goto(loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: timeout
            });

            // Wait for all redirects to finish — CRM apps often chain multiple redirects
            // (app URL → OAuth → Microsoft login → back, or app URL → error page)
            await this.waitForNavigationToSettle(page, 5000);

            const landingState = await this.detectLandingPage(page);
            CSReporter.info(`Landing page detected: ${landingState}`);

            if (landingState === 'microsoftLogin') {
                // We're on the Microsoft login page — proceed with credentials
                CSReporter.info('On Microsoft login page — entering credentials...');

            } else if (landingState === 'appError' || landingState === 'accessRestriction') {
                // VDI user auto-authenticated despite OAuth interception (PRT bypassed autologon block).
                // Instead of clicking the app's Sign Out (which embeds notification.aspx as return URL
                // in the OAuth state, causing form_post → redirect to notification.aspx → 404 loop),
                // we: Microsoft logout → clear cookies → re-navigate to app with interception active.
                CSReporter.info('VDI user auto-authenticated — performing direct Microsoft logout...');
                if (!isPersistentContext) {
                    await this.setupOAuthInterception(page, username, loginUrl);
                }
                // Microsoft logout directly (skip CRM sign-out redirect chain)
                await page.goto('https://login.microsoftonline.com/common/oauth2/logout', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                await page.waitForTimeout(2000);
                // Clear all cookies again (remove VDI user's CRM session)
                try { await page.context().clearCookies(); } catch {}
                // Re-navigate to app — interception already active, autologon blocked
                CSReporter.info('Re-navigating to app with interception active...');
                await page.goto(loginUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: timeout
                });
                await this.waitForNavigationToSettle(page, 10000);
                const retryLanding = await this.detectLandingPage(page);
                CSReporter.info(`After logout + re-navigation: ${retryLanding}`);
                if (retryLanding === 'appLoaded') {
                    CSReporter.pass('App loaded after re-navigation!');
                    if (saveSessionPath) {
                        await this.browserManager.saveStorageState(saveSessionPath);
                    }
                    return;
                }
                // If still not on login page, continue — waitForMicrosoftLoginPage will handle it

            } else if (landingState === 'conditionalAccess') {
                // Conditional Access "Sign in with work account" / "can't get there from here"
                if (!isPersistentContext) {
                    await this.setupOAuthInterception(page, username, loginUrl);
                }
                CSReporter.info('Conditional Access block — clicking "Sign out and sign in with different account"...');
                await this.clickConditionalAccessSignOut(page, timeout);

            } else if (landingState === 'appLoaded') {
                // App loaded successfully — already authenticated as the right user!
                CSReporter.pass('App loaded — already authenticated!');
                if (saveSessionPath) {
                    await this.browserManager.saveStorageState(saveSessionPath);
                    CSReporter.pass(`Session saved to: ${saveSessionPath}`);
                }
                return;

            } else {
                // Unknown page — try waiting for Microsoft login
                CSReporter.warn(`Unknown landing page state, attempting to continue...`);
            }

            // Now we should be on the Microsoft login page
            CSReporter.info('Waiting for Microsoft login page...');
            await this.waitForMicrosoftLoginPage(page, timeout);

            // Enter email
            CSReporter.info('Entering email address...');
            await this.enterEmail(page, username, timeout);

            // Enter password
            CSReporter.info('Entering password...');
            await this.enterPassword(page, password, timeout);

            // Handle "Stay signed in?" prompt
            if (staySignedIn !== false) {
                CSReporter.info('Handling "Stay signed in?" prompt...');
                await this.handleStaySignedIn(page, staySignedIn, timeout);
            }

            // Wait for redirect back to the application
            CSReporter.info('Waiting for redirect back to application...');
            await this.waitForAppRedirect(page, loginUrl, timeout);

            // CRITICAL: Remove route interception BEFORE the app fully loads.
            // After the redirect back to the app, MSAL.js starts making token requests
            // (discovery, token exchange, silent authorize) to login.microsoftonline.com.
            // If our interception is still active, it strips headers and modifies URLs
            // that MSAL.js needs, causing token requests to fail with 400 errors.
            // This results in the "Sign in required" popup and corrupted token state.
            await this.removeOAuthInterception(page);

            // Wait for the application to fully load (spinners gone, key elements visible)
            CSReporter.info('Waiting for application to fully load...');
            await this.waitForAppReady(page, timeout);

            CSReporter.pass(`Microsoft SSO login successful for: ${username}`);

            // Save session if configured
            if (saveSessionPath) {
                CSReporter.info('Saving browser session...');
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
    /**
     * credentialsEntered flag — set to true after the test user enters email+password.
     * Used by OAuth interception to stop injecting prompt=login after credentials are in,
     * so that subsequent OAuth redirects (e.g., after 404 error recovery) can use
     * the test user's Microsoft session cookie instead of forcing a re-login.
     */
    private credentialsEntered: boolean = false;

    private async setupOAuthInterception(page: any, testUsername: string, mainAppUrl?: string): Promise<void> {
        // Reset flag
        this.credentialsEntered = false;

        const isPersistentContext = !!this.config.get('BROWSER_USER_DATA_DIR');

        // Layer 1: Block Azure AD Seamless SSO endpoint entirely
        // autologon.microsoftonline.com is where Kerberos/PRT-based silent auth happens.
        // By aborting these requests, we force Microsoft to show the interactive login page.
        this.autologonRouteHandler = async (route: any) => {
            CSReporter.debug(`Blocked Seamless SSO: ${route.request().url().substring(0, 80)}`);
            await route.abort('blockedbyclient');
        };
        await page.route(/autologon\.microsoftonline\.com/, this.autologonRouteHandler);

        // Layers 2 + 3 + 4: Intercept login.microsoftonline.com requests
        this.oauthRouteHandler = async (route: any) => {
            const url = route.request().url();
            CSReporter.debug(`[Route] login.msol: ${url.substring(0, 120)}`);
            const headers = { ...route.request().headers() };

            // Layer 2: Strip Windows SSO credentials
            // Authorization header carries Kerberos/NTLM negotiate tokens
            let headersModified = false;

            if (headers['authorization']) {
                delete headers['authorization'];
                headersModified = true;
            }

            // Strip PRT cookie ONLY for fresh browser (not persistent context).
            // Persistent context needs PRT on login.microsoftonline.com for
            // Conditional Access device compliance proof.
            if (!isPersistentContext && headers['cookie']) {
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
                CSReporter.debug(`Stripped SSO credentials from: ${url.substring(0, 80)}...`);
            }

            // Layer 3: Modify OAuth authorize URLs (login_hint + prompt).
            // Note: page.route() only fires for XHR/fetch requests and direct navigations,
            // not for 302 redirect targets. The authorize URL from CRM → Azure AD is a
            // redirect target and won't be intercepted here. But autologon blocking (Layer 1)
            // and header stripping (Layer 2) prevent VDI auto-auth on the login page itself.
            if (url.includes('/oauth2/authorize') || url.includes('/oauth2/v2.0/authorize')) {
                try {
                    let modifiedUrl = url;

                    // Layer 3a: Add or replace login_hint
                    const encodedHint = encodeURIComponent(testUsername);
                    if (modifiedUrl.includes('login_hint=')) {
                        modifiedUrl = modifiedUrl.replace(/login_hint=[^&]*/, `login_hint=${encodedHint}`);
                    } else {
                        modifiedUrl += `&login_hint=${encodedHint}`;
                    }

                    // Layer 3b: Add or replace prompt
                    if (!this.credentialsEntered) {
                        if (modifiedUrl.includes('prompt=')) {
                            modifiedUrl = modifiedUrl.replace(/prompt=[^&]*/, 'prompt=login');
                        } else {
                            modifiedUrl += '&prompt=login';
                        }
                        CSReporter.debug(`OAuth intercept: login_hint=${testUsername}, prompt=login`);
                    } else {
                        // Remove prompt param so Microsoft uses the existing session
                        modifiedUrl = modifiedUrl.replace(/[&?]prompt=[^&]*/, '');
                        CSReporter.debug(`OAuth intercept (post-login): login_hint=${testUsername}, no prompt`);
                    }

                    await route.continue({ url: modifiedUrl, headers });
                    return;
                } catch (err: any) {
                    CSReporter.debug(`OAuth URL modification failed: ${err.message}`);
                }
            }

            // For non-OAuth requests, continue with (possibly modified) headers
            await route.continue({ headers });
        };

        await page.route(/login\.microsoftonline\.com/, this.oauthRouteHandler);

        CSReporter.debug('OAuth interception active: autologon blocked + login_hint/prompt injected');
    }

    /**
     * Remove all route interception after login is complete
     */
    private async removeOAuthInterception(page: any): Promise<void> {
        try {
            if (this.autologonRouteHandler) {
                await page.unroute(/autologon\.microsoftonline\.com/, this.autologonRouteHandler);
                this.autologonRouteHandler = null;
            }
            if (this.oauthRouteHandler) {
                await page.unroute(/login\.microsoftonline\.com/, this.oauthRouteHandler);
                this.oauthRouteHandler = null;
            }
            CSReporter.debug('OAuth interception routes removed');
        } catch {
            // Ignore — page may already be closed
        }
    }

    /**
     * Wait for the Microsoft login page to appear
     * Handles various redirect patterns (ADFS, B2C, direct AAD)
     */
    /**
     * Wait for the page to stop navigating (all redirects complete).
     * Retries waitForLoadState until the page is stable.
     */
    private async waitForNavigationToSettle(page: any, maxWaitMs: number): Promise<void> {
        const startTime = Date.now();
        let lastUrl = '';
        while (Date.now() - startTime < maxWaitMs) {
            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 3000 });
                const currentUrl = page.url();
                // If URL hasn't changed in this iteration, page is stable
                if (currentUrl === lastUrl) {
                    CSReporter.debug(`Page settled at: ${currentUrl}`);
                    return;
                }
                lastUrl = currentUrl;
                await page.waitForTimeout(1000);
            } catch {
                // Navigation in progress — wait and retry
                await page.waitForTimeout(1000);
            }
        }
        CSReporter.debug(`Page settle timeout — proceeding with current URL: ${page.url()}`);
    }

    /**
     * Detect what page we landed on after navigating to the app URL.
     * Returns one of:
     *   - 'microsoftLogin'     — on login.microsoftonline.com (normal SSO redirect)
     *   - 'appError'           — app loaded but showing error (user not in security group)
     *   - 'accessRestriction'  — "can't get there from here" or compliance block
     *   - 'conditionalAccess'  — "Sign in with your work account" / "Switch Edge profile"
     *   - 'appLoaded'          — app loaded successfully (already authenticated)
     *   - 'unknown'            — unrecognized page
     */
    private async detectLandingPage(page: any): Promise<string> {
        // Retry up to 3 times — page.evaluate can fail if a navigation is still in progress
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await this._detectLandingPageOnce(page);
            } catch (error: any) {
                if (error.message.includes('context was destroyed') || error.message.includes('navigation')) {
                    CSReporter.debug(`Landing page detection attempt ${attempt + 1} failed (navigation in progress), retrying...`);
                    await page.waitForTimeout(2000);
                    try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* ignore */ }
                } else {
                    throw error;
                }
            }
        }
        return 'unknown';
    }

    private async _detectLandingPageOnce(page: any): Promise<string> {
        const url = page.url().toLowerCase();

        // Check URL first
        if (url.includes('login.microsoftonline.com') ||
            url.includes('login.microsoft.com') ||
            url.includes('login.live.com')) {
            return 'microsoftLogin';
        }

        // Check page content
        const pageState = await page.evaluate(() => {
            const bodyText = document.body?.innerText || '';
            const bodyLower = bodyText.toLowerCase();

            // Conditional Access: "Sign in with your work account" / "Switch Edge profile"
            if (bodyLower.includes('switch edge profile') ||
                bodyLower.includes('sign in with your work account') ||
                (bodyLower.includes("can't get there from here") && bodyLower.includes('compliance'))) {
                return 'conditionalAccess';
            }

            // App error: "not a member" / "need to be added to a security group"
            if (bodyLower.includes('security group') ||
                bodyLower.includes('notmemberoforg') ||
                bodyLower.includes('need to be added') ||
                bodyLower.includes('not a member')) {
                return 'appError';
            }

            // Access restriction: general block page
            if (bodyLower.includes('access restriction') ||
                (bodyLower.includes("can't get there") && bodyLower.includes('sign out'))) {
                return 'accessRestriction';
            }

            // Check if the app actually loaded (Dynamics 365 specific indicators)
            if (bodyLower.includes('dynamics 365') ||
                document.querySelector('#mainContent') ||
                document.querySelector('[data-id="mainContent"]') ||
                bodyLower.includes('power apps')) {
                return 'appLoaded';
            }

            // Check for a Sign Out link (generic app page with sign out option)
            const signOutLink = document.querySelector('a[href*="SignOut"], a[href*="signout"], a[href*="logout"]');
            if (signOutLink) {
                return 'appError';
            }

            return 'unknown';
        });

        return pageState;
    }

    /**
     * Click "Sign Out" on the application error/restriction page.
     * This is used when the persistent context (VDI profile) auto-authenticated
     * as the VDI user (wrong user) and we need to sign out to switch to the test user.
     *
     * Dynamics 365 error pages typically have:
     *   - A "Sign Out" link in the header
     *   - Text like "You (user@domain) need to be added to a security group"
     */
    private async clickAppSignOut(page: any, timeout: number): Promise<void> {
        try {
            // Dynamics 365 Sign Out links are often javascript: URLs like:
            //   javascript:var url='https://app.crm.dynamics.com/.../notification.aspx';SetSignOutCookie();window.top.location.href=url;
            // We can't use page.goto() for javascript: URLs — instead we click the link directly
            // and let the browser execute the JavaScript naturally.

            const signOutInfo = await page.evaluate(() => {
                // Try by href patterns
                const selectors = [
                    'a[href*="SignOut"]',
                    'a[href*="signout"]',
                    'a[href*="logout"]',
                    'a[href*="Logout"]',
                    'a[href*="notification.aspx"]',
                ];
                for (const selector of selectors) {
                    const link = document.querySelector(selector) as HTMLAnchorElement;
                    if (link) {
                        const href = link.getAttribute('href') || '';
                        return { href, isJavascript: href.startsWith('javascript:') };
                    }
                }

                // Try by text content
                const allLinks = Array.from(document.querySelectorAll('a'));
                for (const link of allLinks) {
                    const text = (link as HTMLElement).innerText?.toLowerCase() || '';
                    if (text.includes('sign out') || text.includes('signout') || text.includes('log out')) {
                        const href = link.getAttribute('href') || '';
                        return { href, isJavascript: href.startsWith('javascript:') };
                    }
                }

                return null;
            });

            if (signOutInfo) {
                CSReporter.debug(`Found Sign Out link: ${signOutInfo.href.substring(0, 100)}...`);

                if (signOutInfo.isJavascript) {
                    // For javascript: links, click the element and wait for navigation
                    CSReporter.debug('Sign Out is javascript: link — clicking and waiting for navigation...');
                    // Click the sign-out link — this triggers page navigation via JS
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
                        page.evaluate(() => {
                            const selectors = [
                                'a[href*="SignOut"]', 'a[href*="signout"]', 'a[href*="logout"]',
                                'a[href*="Logout"]', 'a[href*="notification.aspx"]',
                            ];
                            for (const sel of selectors) {
                                const el = document.querySelector(sel) as HTMLElement;
                                if (el) { el.click(); return; }
                            }
                            // Fallback: try by text
                            const allLinks = Array.from(document.querySelectorAll('a'));
                            for (const link of allLinks) {
                                const text = (link as HTMLElement).innerText?.toLowerCase() || '';
                                if (text.includes('sign out')) { (link as HTMLElement).click(); return; }
                            }
                        })
                    ]);
                    await this.waitForNavigationToSettle(page, 5000);
                } else {
                    // Regular URL — navigate directly
                    await page.goto(signOutInfo.href, {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000
                    });
                    await this.waitForNavigationToSettle(page, 5000);
                }
            } else {
                // If no Sign Out link found, navigate to Microsoft logout directly
                CSReporter.debug('No Sign Out link found — navigating to Microsoft logout');
                await page.goto('https://login.microsoftonline.com/common/oauth2/logout', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                await this.waitForNavigationToSettle(page, 3000);
            }
        } catch (error: any) {
            CSReporter.debug(`App sign-out attempt: ${error.message}`);
            // Fall back to Microsoft logout
            await page.goto('https://login.microsoftonline.com/common/oauth2/logout', {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await page.waitForTimeout(2000);
        }

        // After sign-out we may land on Microsoft "You signed out of your account" page.
        // This page has no login form — we need to check and handle it.
        await this.handlePostSignOutPage(page, timeout);
    }

    /**
     * After clicking Sign Out, the logout URL typically has post_logout_redirect_uri
     * which triggers an automatic redirect chain:
     *   Microsoft logout → post_logout_redirect_uri (app) → SSO redirect → Pick an account / login page
     *
     * We must NOT run page.evaluate() during this redirect chain — it will fail with
     * "Execution context was destroyed". Instead, we wait for the redirects to fully settle,
     * then check where we ended up. If we're still on a dead-end page, navigate to the app.
     */
    private async handlePostSignOutPage(page: any, timeout: number): Promise<void> {
        // The logout page often has post_logout_redirect_uri which triggers automatic redirects.
        // Give the redirect chain plenty of time to complete (up to 15s).
        CSReporter.debug(`Post-sign-out: waiting for redirect chain to complete...`);
        await this.waitForNavigationToSettle(page, 15000);

        const settledUrl = page.url().toLowerCase();
        CSReporter.debug(`Post-sign-out settled at: ${page.url()}`);

        // If we landed on the Microsoft login page or account picker — perfect, we're done
        if (settledUrl.includes('login.microsoftonline.com') && !settledUrl.includes('logout')) {
            CSReporter.debug('Post-sign-out: landed on Microsoft login page — ready for credentials');
            return;
        }

        // If we're still on a logout/signout confirmation page (no redirect happened),
        // navigate back to the app URL to trigger a fresh SSO redirect
        if (settledUrl.includes('logout') || settledUrl.includes('signout') || settledUrl.includes('signed+out')) {
            const loginUrl = this.config.get('SSO_LOGIN_URL') || this.config.get('BASE_URL');
            CSReporter.debug(`Post-sign-out: still on sign-out page — navigating to app: ${loginUrl}`);
            await page.goto(loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: timeout
            });
            await this.waitForNavigationToSettle(page, 10000);
        }

        // If we landed back on the app (already authenticated) — that's fine too
        // The main login() flow will handle detection via waitForMicrosoftLoginPage / enterEmail
    }

    /**
     * Handle the Conditional Access "Sign in with your work account" / "can't get there from here" page.
     * Click "Sign out and sign in with a different account" to reach the login page.
     */
    private async clickConditionalAccessSignOut(page: any, timeout: number): Promise<void> {
        try {
            const clicked = await page.evaluate(() => {
                const allLinks = Array.from(document.querySelectorAll('a'));
                for (const link of allLinks) {
                    const text = (link as HTMLElement).innerText?.toLowerCase() || '';
                    if (text.includes('sign out') || text.includes('different account') || text.includes('sign in with a different')) {
                        (link as HTMLElement).click();
                        return true;
                    }
                }
                return false;
            });

            if (clicked) {
                CSReporter.debug('Clicked "Sign out and sign in with a different account"');
                await page.waitForTimeout(3000);
            } else {
                // Fallback: navigate to Microsoft logout
                CSReporter.debug('No sign-out link found on CA page — navigating to Microsoft logout');
                await page.goto('https://login.microsoftonline.com/common/oauth2/logout', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                await page.waitForTimeout(2000);
            }
        } catch (error: any) {
            CSReporter.debug(`Conditional Access sign-out: ${error.message}`);
        }
    }

    private async waitForMicrosoftLoginPage(page: any, timeout: number): Promise<void> {
        try {
            // Wait for Microsoft login page: email input, password input, OR account picker
            await page.waitForFunction(
                () => {
                    const url = window.location.href.toLowerCase();
                    const isMicrosoftLogin =
                        url.includes('login.microsoftonline.com') ||
                        url.includes('login.microsoft.com') ||
                        url.includes('login.live.com') ||
                        url.includes('sts.windows.net') ||
                        url.includes('adfs');

                    // Check for email input, password input, or account picker
                    const emailInput =
                        document.querySelector('input[type="email"]') ||
                        document.querySelector('input[name="loginfmt"]') ||
                        document.querySelector('#i0116');
                    const passwordInput = document.querySelector('input[type="password"]');
                    const accountPicker =
                        document.querySelector('#otherTileText') ||
                        document.querySelector('[data-test-id="otherTile"]') ||
                        document.querySelector('.table[role="presentation"]');

                    return isMicrosoftLogin || emailInput || passwordInput || accountPicker;
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
     *   a) Show the email page (normal) → fill email, click Next
     *   b) Skip the email page and show password directly → return immediately
     *   c) Show "Pick an account" page → click "Use another account", then fill email
     */
    private async enterEmail(page: any, email: string, timeout: number): Promise<void> {
        // Wait for the page to fully settle — redirects may still be in progress
        await this.waitForNavigationToSettle(page, 5000);
        await page.waitForTimeout(1000);

        // Check what state the page is in — with retry for mid-navigation errors
        let pageState = 'unknown';
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                pageState = await page.evaluate(() => {
                    // Password field visible? (login_hint skipped email page)
                    const pwdInput = document.querySelector('input[type="password"]') as HTMLElement | null;
                    if (pwdInput && pwdInput.offsetParent !== null) return 'password';

                    // "Pick an account" page? (Microsoft shows previously used accounts)
                    // Multiple selectors for robustness
                    const otherTile = document.querySelector('#otherTileText') ||
                        document.querySelector('[data-test-id="otherTile"]');
                    if (otherTile) return 'pickAccount';

                    // Also check by text: look for "Use another account" text anywhere
                    const allDivs = Array.from(document.querySelectorAll('div, span, p'));
                    for (const el of allDivs) {
                        const text = (el as HTMLElement).innerText?.toLowerCase() || '';
                        if (text === 'use another account') return 'pickAccount';
                    }

                    // Email input visible? (standard login page)
                    const emailInput = document.querySelector('input[type="email"], input[name="loginfmt"], #i0116') as HTMLElement | null;
                    if (emailInput && emailInput.offsetParent !== null) return 'email';

                    // Email input exists but hidden? (might still be loading)
                    if (emailInput) return 'emailHidden';

                    return 'unknown';
                });
                break; // Success — exit retry loop
            } catch (error: any) {
                if (error.message.includes('context was destroyed') || error.message.includes('navigation')) {
                    CSReporter.debug(`enterEmail page state detection attempt ${attempt + 1} failed (navigation), retrying...`);
                    await page.waitForTimeout(2000);
                    try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch {}
                } else {
                    throw error;
                }
            }
        }

        CSReporter.debug(`Microsoft login page state: ${pageState}`);

        if (pageState === 'password') {
            CSReporter.debug('Email page skipped (login_hint accepted) — password page shown directly');
            return;
        }

        if (pageState === 'pickAccount') {
            CSReporter.debug('"Pick an account" page detected — clicking "Use another account"');
            // Try multiple approaches to click "Use another account"
            try {
                // Approach 1: Click by ID
                const otherTile = await page.$('#otherTileText');
                if (otherTile) {
                    await otherTile.click();
                } else {
                    // Approach 2: Click by data-test-id
                    const otherTile2 = await page.$('[data-test-id="otherTile"]');
                    if (otherTile2) {
                        await otherTile2.click();
                    } else {
                        // Approach 3: Find and click by text content
                        await page.evaluate(() => {
                            const allElements = Array.from(document.querySelectorAll('div, span, a, p'));
                            for (const el of allElements) {
                                const text = (el as HTMLElement).innerText?.trim().toLowerCase() || '';
                                if (text === 'use another account') {
                                    // Click the closest clickable parent (the tile row)
                                    const clickTarget = (el as HTMLElement).closest('[role="button"], [role="link"], a, div[tabindex]') || el;
                                    (clickTarget as HTMLElement).click();
                                    return;
                                }
                            }
                        });
                    }
                }
                CSReporter.debug('Clicked "Use another account"');
                await page.waitForTimeout(2000);
            } catch (clickError: any) {
                CSReporter.debug(`Click "Use another account" error: ${clickError.message}`);
                await page.waitForTimeout(2000);
            }
        }

        // Wait for the email input to be visible
        const emailSelector = 'input[type="email"], input[name="loginfmt"], #i0116';
        const emailInput = await page.waitForSelector(emailSelector, {
            state: 'visible',
            timeout: timeout
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

        // Wait for the page transition (password page or org redirect)
        await page.waitForTimeout(2000);
        CSReporter.debug('Email entered and Next clicked');
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

        // Mark credentials as entered — OAuth interception will stop injecting prompt=login
        // so subsequent OAuth redirects use the test user's session cookie
        this.credentialsEntered = true;

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
     * Check for Conditional Access "Sign in with your work account" interstitial.
     * This page appears on enterprise VDIs when the Conditional Access policy requires
     * a signed-in Edge browser profile (device compliance).
     *
     * If detected, throws a clear error with instructions instead of timing out.
     */
    private async checkForConditionalAccessBlock(page: any): Promise<void> {
        try {
            // Wait briefly — this page appears right after password entry
            await page.waitForTimeout(2000);

            // Check for the Conditional Access block page indicators
            const isBlocked = await page.evaluate(() => {
                const bodyText = document.body?.innerText || '';
                return (
                    bodyText.includes('Sign in with your work account') ||
                    bodyText.includes('Switch Edge profile') ||
                    bodyText.includes("can't get there from here") ||
                    bodyText.includes('management compliance policy') ||
                    bodyText.includes('meet') && bodyText.includes('compliance policy')
                );
            });

            if (isBlocked) {
                const currentUrl = page.url();
                CSReporter.warn('Conditional Access device compliance block detected!');
                throw new Error(
                    'Conditional Access policy is blocking access. The organization requires a signed-in Edge browser profile.\n\n' +
                    'Two solutions:\n' +
                    '  1. (Recommended) Ask your Azure AD admin to exclude the test service account from the device compliance Conditional Access policy.\n' +
                    '  2. (Alternative) Set BROWSER_USER_DATA_DIR in your env file to point to a pre-signed-in Edge profile directory.\n' +
                    '     Example: BROWSER_USER_DATA_DIR=C:\\Users\\YourName\\AppData\\Local\\Microsoft\\Edge\\User Data\\Profile 1\n\n' +
                    `Current URL: ${currentUrl}`
                );
            }
        } catch (error: any) {
            if (error.message.includes('Conditional Access')) {
                throw error; // Re-throw our own error
            }
            // Page check failed (e.g., navigated away already) — this is fine, continue
            CSReporter.debug('Conditional Access check: page is not blocked');
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
            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
            } catch {
                // domcontentloaded may not fire on error pages — that's OK
            }

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

        // After redirect, check if we landed on an error page (404, chrome-error://, etc.)
        // This happens when the OAuth redirect_uri points to an internal CRM server URL
        // (e.g., an internal CRM server hostname) that returns 404.
        // The session cookies are already set, so navigating to the original app URL will work.
        const currentUrl = page.url();
        const isErrorPage =
            currentUrl.startsWith('chrome-error://') ||
            currentUrl.startsWith('edge-error://') ||
            currentUrl.includes('ERR_') ||
            currentUrl === 'about:blank';

        // Also check if we're on a different CRM server (internal redirect) that gave a 404
        let isInternalServerError = false;
        if (!isErrorPage) {
            try {
                isInternalServerError = await page.evaluate(() => {
                    const bodyText = document.body?.innerText?.toLowerCase() || '';
                    const title = document.title?.toLowerCase() || '';
                    return bodyText.includes('page can\'t be found') ||
                        bodyText.includes('page not found') ||
                        bodyText.includes('http error 404') ||
                        bodyText.includes('http error 403') ||
                        title.includes('404') ||
                        title.includes('error');
                });
            } catch {
                // page.evaluate may fail on chrome-error:// pages
                isInternalServerError = false;
            }
        }

        if (isErrorPage || isInternalServerError) {
            // Post-login error page detected. This typically means the OAuth redirect_uri
            // went to an unreachable internal server. Navigate to the main app URL as recovery.
            CSReporter.warn(`Post-login error detected at: ${currentUrl}. Navigating to main app URL...`);
            await page.goto(originalUrl, {
                waitUntil: 'domcontentloaded',
                timeout: timeout
            });
            await this.waitForNavigationToSettle(page, 15000);

            const recoveryUrl = page.url().toLowerCase();
            CSReporter.debug(`After recovery navigation, now at: ${page.url()}`);

            // If recovery landed on the Microsoft login page (e.g., "Pick an account"),
            // the auth code was consumed by the 404. Try to reuse the test user's session
            // by clicking their account tile, or wait for auto-redirect.
            if (recoveryUrl.includes('login.microsoftonline.com')) {
                CSReporter.warn('Recovery landed on Microsoft login page — attempting to reuse test user session...');

                // Check if "Pick an account" is shown — click the test user's tile
                try {
                    const clickedAccount = await page.evaluate(() => {
                        // Look for account tiles (Microsoft's "Pick an account" page)
                        const tiles = Array.from(document.querySelectorAll('[data-test-id]'));
                        for (const tile of tiles) {
                            const testId = tile.getAttribute('data-test-id') || '';
                            // Click the first non-"other" tile (the test user's account)
                            if (testId && testId !== 'otherTile' && testId.includes('Tile')) {
                                (tile as HTMLElement).click();
                                return true;
                            }
                        }
                        // Fallback: look for any account tile by role
                        const listItems = Array.from(document.querySelectorAll('[role="listitem"], .table[role="presentation"] div[tabindex]'));
                        if (listItems.length > 0) {
                            (listItems[0] as HTMLElement).click();
                            return true;
                        }
                        return false;
                    });

                    if (clickedAccount) {
                        CSReporter.debug('Clicked test user account tile on "Pick an account" page');
                        // Wait for the re-authentication redirect to complete
                        try {
                            await page.waitForFunction(
                                (domain: string) => !window.location.href.toLowerCase().includes('login.microsoftonline.com') ||
                                    window.location.href.toLowerCase().includes(domain),
                                new URL(originalUrl).hostname.toLowerCase(),
                                { timeout: 30000 }
                            );
                            await this.waitForNavigationToSettle(page, 10000);
                            CSReporter.debug(`After account selection, now at: ${page.url()}`);
                        } catch {
                            CSReporter.warn('Account selection did not redirect to app within timeout');
                        }
                    } else {
                        CSReporter.warn('No account tile found — login page may require fresh credentials');
                    }
                } catch (e: any) {
                    CSReporter.debug(`Pick-an-account recovery failed: ${e.message}`);
                }
            }
        }
    }

    /**
     * Wait for the application to fully load after SSO login redirect.
     *
     * Dynamics 365 / Power Platform apps can take several seconds to initialize after redirect.
     * This method waits for:
     *   1. Block PowerApps web player resources (prevents infinite "Sign in required" popup)
     *   2. Network to settle (no pending requests)
     *   3. Loading spinners to disappear (uses framework's SPINNER_SELECTORS config)
     *   4. "Sign in required" popup dismissal — close/remove from DOM (NOT click "Sign in")
     *   5. SSO_APP_READY_SELECTOR — a configurable CSS selector or text that indicates the app is ready
     *      e.g., SSO_APP_READY_SELECTOR=text=SANDBOX  or  SSO_APP_READY_SELECTOR=#headerTitle
     *   6. SSO_APP_READY_TEXT — wait for specific text to appear on the page
     *      e.g., SSO_APP_READY_TEXT=SANDBOX
     */
    private async waitForAppReady(page: any, timeout: number): Promise<void> {
        // Step 1: Block ALL PowerApps domains and inject continuous popup auto-dismissal.
        // This MUST happen before network activity completes — the PowerApps component
        // tries to authenticate via sandboxed iframe and CRM's MSAL.js requests tokens
        // for PowerApps scopes. Both fail on VDI → infinite "Sign in required" popup.
        await this.suppressPowerAppsSignInPopups(page);

        // Step 2: Wait for networkidle (all XHR/fetch requests done)
        try {
            await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 30000) });
            CSReporter.debug('App page: networkidle reached');
        } catch {
            CSReporter.debug('App page: networkidle timeout — continuing (app may use long-polling)');
        }

        // Step 3: Wait for loading spinners to disappear (framework-level)
        try {
            await this.browserManager.waitForSpinnersToDisappear(Math.min(timeout, 15000));
        } catch {
            // Spinner wait is best-effort
        }

        // Step 4: Wait for app-ready selector if configured
        const readySelector = this.config.get('SSO_APP_READY_SELECTOR');
        if (readySelector) {
            try {
                CSReporter.debug(`Waiting for app-ready selector: ${readySelector}`);
                if (readySelector.startsWith('text=')) {
                    // Text-based selector: wait for text to appear
                    const textToFind = readySelector.substring(5);
                    await page.waitForFunction(
                        (text: string) => {
                            return document.body?.innerText?.includes(text) || false;
                        },
                        textToFind,
                        { timeout: Math.min(timeout, 30000) }
                    );
                } else {
                    // CSS selector
                    await page.waitForSelector(readySelector, {
                        state: 'visible',
                        timeout: Math.min(timeout, 30000)
                    });
                }
                CSReporter.debug(`App-ready selector found: ${readySelector}`);
            } catch (error: any) {
                CSReporter.warn(`App-ready selector "${readySelector}" not found within timeout — continuing`);
            }
        }

        // Step 6: Wait for app-ready text if configured
        const readyText = this.config.get('SSO_APP_READY_TEXT');
        if (readyText) {
            try {
                CSReporter.debug(`Waiting for app-ready text: "${readyText}"`);
                await page.waitForFunction(
                    (text: string) => {
                        return document.body?.innerText?.includes(text) || false;
                    },
                    readyText,
                    { timeout: Math.min(timeout, 30000) }
                );
                CSReporter.debug(`App-ready text found: "${readyText}"`);
            } catch (error: any) {
                CSReporter.warn(`App-ready text "${readyText}" not found within timeout — continuing`);
            }
        }

        CSReporter.info(`Application loaded at: ${page.url()}`);
    }

    /**
     * Suppress PowerApps-related "Sign in required" popups in Dynamics 365.
     *
     * Three-pronged approach:
     *
     * 1. BLOCK all *.powerapps.com domains via Playwright route interception.
     *    Not just the web player JS — ALL subdomains (content, service, api, etc.).
     *    This prevents PowerApps from loading, authenticating, OR making API calls.
     *
     * 2. INJECT a MutationObserver into the page that continuously monitors the DOM
     *    and auto-dismisses any "Sign in required" dialog the instant it appears.
     *    This handles timing — the popup can appear at ANY point during or after load.
     *    The observer also runs on a 3-second polling interval as backup.
     *
     * 3. BLOCK hidden iframe auth attempts by intercepting requests to
     *    login.microsoftonline.com that contain prompt=none and powerapps in the scope.
     *    These are MSAL.js silent token refresh attempts that fail and trigger the popup.
     *
     * Why this is needed:
     *   - CRM's MSAL.js requests tokens for PowerApps scopes from login.microsoftonline.com
     *   - The token request fails (400) because the test user / VDI environment can't get them
     *   - MSAL.js escalates from silent → interactive → shows "Sign in required" popup
     *   - Clicking "Sign in" retries the same failing flow → infinite loop
     *   - Even dismissing the popup doesn't stop MSAL.js from recreating it
     *
     * Safe to call multiple times — idempotent.
     * Safe to call on non-Dynamics 365 pages — no-ops.
     *
     * Can be called from page objects and step definitions via the public API.
     */
    private powerAppsRouteHandler: ((route: any) => Promise<void>) | null = null;
    private powerAppsAuthRouteHandler: ((route: any) => Promise<void>) | null = null;
    private popupDismissalInjected: boolean = false;

    public async suppressPowerAppsSignInPopups(page: any): Promise<void> {
        await this.blockPowerAppsResources(page);
        await this.injectSignInPopupAutoDismissal(page);
    }

    /**
     * One-shot dismiss of "Sign in required" popup.
     * For manual/step-definition use. The MutationObserver handles continuous dismissal.
     */
    public async handleSignInRequiredPopup(page: any, _timeout?: number): Promise<boolean> {
        try {
            return await page.evaluate(() => {
                return (window as any).__csSignInDismissFn ? (window as any).__csSignInDismissFn() : false;
            });
        } catch {
            return false;
        }
    }

    /**
     * Block ALL PowerApps-related domains via route interception.
     *
     * Blocks:
     *   - content.powerapps.com (web player JS, resources)
     *   - service.powerapps.com (PowerApps API)
     *   - api.powerapps.com (PowerApps API)
     *   - *.tip.powerapps.com (PowerApps TIP endpoints)
     *   - Any other *.powerapps.com subdomain
     *
     * Also blocks MSAL.js silent token requests (prompt=none hidden iframes) that
     * target PowerApps scopes — these are the requests whose 400 failure triggers
     * the interactive "Sign in required" popup.
     */
    private async blockPowerAppsResources(page: any): Promise<void> {
        // Block all *.powerapps.com subdomains
        if (!this.powerAppsRouteHandler) {
            try {
                this.powerAppsRouteHandler = async (route: any) => {
                    CSReporter.debug(`Blocked PowerApps: ${route.request().url().substring(0, 120)}`);
                    await route.abort('blockedbyclient');
                };
                await page.route(/\.powerapps\.com/, this.powerAppsRouteHandler);
                CSReporter.debug('PowerApps domain block active (*.powerapps.com)');
            } catch (error: any) {
                CSReporter.debug(`Could not set up PowerApps block: ${error.message}`);
            }
        }

        // Block MSAL.js silent token requests (hidden iframes) for PowerApps scopes.
        // These go to login.microsoftonline.com with prompt=none in the URL.
        // When they fail (400), MSAL.js escalates to interactive → popup.
        // We only block requests that contain "powerapps" in the URL (scope/resource param).
        if (!this.powerAppsAuthRouteHandler) {
            try {
                this.powerAppsAuthRouteHandler = async (route: any) => {
                    const url = route.request().url();
                    if (url.includes('prompt=none') && url.toLowerCase().includes('powerapps')) {
                        CSReporter.debug(`Blocked PowerApps silent auth: ${url.substring(0, 120)}`);
                        await route.abort('blockedbyclient');
                        return;
                    }
                    await route.continue();
                };
                await page.route(/login\.microsoftonline\.com.*oauth2/, this.powerAppsAuthRouteHandler);
                CSReporter.debug('PowerApps silent auth block active');
            } catch (error: any) {
                CSReporter.debug(`Could not set up PowerApps auth block: ${error.message}`);
            }
        }
    }

    /**
     * Inject a persistent MutationObserver + polling that automatically dismisses
     * "Sign in required" popups the instant they appear in the DOM.
     *
     * Unlike one-shot checks, this runs continuously in the browser context:
     *   - MutationObserver fires on every DOM change (catches popups as they're added)
     *   - setInterval polls every 3 seconds as backup (catches edge cases)
     *   - Runs for up to 2 minutes (40 polls × 3s), then stops polling (observer continues)
     *
     * The dismiss logic:
     *   1. Detects "sign in required" / "sign in to continue" text in the page
     *   2. Clicks close/cancel/dismiss/X buttons (NOT "Sign in")
     *   3. If no dismiss button found, removes dialog elements from the DOM
     *   4. Removes overlay/backdrop elements blocking interaction
     *
     * Idempotent — safe to call multiple times (checks __csPopupDismissalActive flag).
     */
    private async injectSignInPopupAutoDismissal(page: any): Promise<void> {
        if (this.popupDismissalInjected) return;

        try {
            await page.evaluate(() => {
                if ((window as any).__csPopupDismissalActive) return;
                (window as any).__csPopupDismissalActive = true;

                // ─── Core dismiss function ───
                const dismissSignInPopup = (): boolean => {
                    const bodyText = document.body?.innerText?.toLowerCase() || '';

                    const signInRequired =
                        (bodyText.includes('required') && bodyText.includes('sign in')) ||
                        (bodyText.includes('sign in') && bodyText.includes('features')) ||
                        bodyText.includes('sign in to continue') ||
                        bodyText.includes('session has expired') ||
                        bodyText.includes('your session has timed out');

                    if (!signInRequired) return false;

                    // Strategy 1: Click close/cancel/dismiss/X/ok buttons (NOT "Sign in")
                    const dismissBtnSelectors = ['button', 'a', '[role="button"]', 'span'];
                    for (const selector of dismissBtnSelectors) {
                        const elements = Array.from(document.querySelectorAll(selector));
                        for (const el of elements) {
                            const text = ((el as HTMLElement).innerText || '').trim().toLowerCase();
                            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                            const title = (el.getAttribute('title') || '').toLowerCase();

                            if (text === 'close' || text === 'cancel' || text === 'dismiss' ||
                                text === 'x' || text === 'ok' || text === 'not now' ||
                                ariaLabel === 'close' || ariaLabel.includes('dismiss') ||
                                title === 'close' || title.includes('dismiss')) {
                                (el as HTMLElement).click();
                                return true;
                            }
                        }
                    }

                    // Strategy 2: Remove dialog/modal elements containing sign-in text
                    const dialogSelectors = [
                        '[role="dialog"]', '[role="alertdialog"]',
                        '.ms-Dialog', '.ms-Modal',
                        '[class*="dialog"]', '[class*="Dialog"]',
                        '[class*="modal"]', '[class*="Modal"]',
                        '[class*="popup"]', '[class*="Popup"]',
                    ];
                    for (const sel of dialogSelectors) {
                        const dialogs = Array.from(document.querySelectorAll(sel));
                        for (const dialog of dialogs) {
                            const dt = ((dialog as HTMLElement).innerText || '').toLowerCase();
                            if (dt.includes('sign in') &&
                                (dt.includes('required') || dt.includes('features') ||
                                 dt.includes('continue') || dt.includes('session'))) {
                                (dialog as HTMLElement).remove();
                                return true;
                            }
                        }
                    }

                    // Strategy 3: Remove overlay/backdrop blocking interaction
                    const overlays = document.querySelectorAll(
                        '[class*="overlay"], [class*="Overlay"], [class*="backdrop"], .ms-Overlay'
                    );
                    let removedOverlay = false;
                    overlays.forEach(overlay => {
                        const style = window.getComputedStyle(overlay);
                        if (style.position === 'fixed' || style.position === 'absolute') {
                            (overlay as HTMLElement).remove();
                            removedOverlay = true;
                        }
                    });

                    return removedOverlay;
                };

                // Expose for manual one-shot calls from Playwright
                (window as any).__csSignInDismissFn = dismissSignInPopup;

                // ─── MutationObserver: fires on every DOM change ───
                if (document.body) {
                    const observer = new MutationObserver(() => {
                        try { dismissSignInPopup(); } catch { /* ignore */ }
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
                }

                // ─── Polling backup: every 3s for 2 minutes ───
                let pollCount = 0;
                const interval = setInterval(() => {
                    try { dismissSignInPopup(); } catch { /* ignore */ }
                    if (++pollCount >= 40) clearInterval(interval);
                }, 3000);
            });

            this.popupDismissalInjected = true;
            CSReporter.debug('Sign-in popup auto-dismissal active (MutationObserver + 3s polling)');
        } catch (error: any) {
            CSReporter.debug(`Could not inject popup auto-dismissal: ${error.message}`);
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
     *
     * When a valid session file exists:
     *   1. Injects saved cookies into the EXISTING browser context (non-destructive)
     *   2. Navigates to the app URL
     *   3. Injects saved localStorage for matching origins
     *   4. If the app redirects to the Microsoft login page (tokens expired), falls back to fresh login
     *
     * This handles the common case where BROWSER_REUSE_CLEAR_STATE=true wipes cookies
     * between scenarios — the session file is still valid on disk but the browser has no cookies.
     *
     * IMPORTANT: Does NOT call loadStorageState() (which closes/recreates the context) because
     * that conflicts with BROWSER_REUSE_ENABLED mode where the BDD runner manages the context
     * lifecycle and has active trace recording. Instead, injects cookies via context.addCookies().
     */
    public async ensureLoggedIn(options?: Partial<SSOLoginOptions>): Promise<void> {
        const maxSessionAge = this.config.getNumber('SSO_SESSION_MAX_AGE_HOURS', 12);

        if (this.isSessionValid(maxSessionAge)) {
            CSReporter.info('Valid session file found — restoring cookies and navigating to app');

            const sessionPath = this.config.get('AUTH_STORAGE_STATE_PATH');
            const loginUrl = options?.loginUrl || this.config.get('SSO_LOGIN_URL') || this.config.get('BASE_URL');
            const timeout = options?.timeout || this.config.getNumber('SSO_WAIT_TIMEOUT', 60000);

            try {
                // Read the saved session file
                const fs = require('fs');
                const resolvedPath = path.resolve(sessionPath);
                const sessionData = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

                const page = this.browserManager.getPage();
                const context = page.context();

                // Step 1: Inject saved cookies into the existing context
                // context.addCookies() is non-destructive — it adds cookies without closing/recreating
                if (sessionData.cookies && sessionData.cookies.length > 0) {
                    await context.addCookies(sessionData.cookies);
                    CSReporter.debug(`Injected ${sessionData.cookies.length} cookies into browser context`);
                }

                // Step 2: Navigate to the app URL
                if (loginUrl) {
                    CSReporter.info(`Navigating to app: ${loginUrl}`);
                    await page.goto(loginUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: timeout
                    });

                    // Step 3: Inject localStorage for matching origins (MSAL tokens, app state)
                    if (sessionData.origins && sessionData.origins.length > 0) {
                        const currentOrigin = new URL(page.url()).origin;
                        for (const origin of sessionData.origins) {
                            if (origin.origin === currentOrigin &&
                                origin.localStorage && origin.localStorage.length > 0) {
                                await page.evaluate((items: { name: string; value: string }[]) => {
                                    for (const item of items) {
                                        try { localStorage.setItem(item.name, item.value); } catch {}
                                    }
                                }, origin.localStorage);
                                CSReporter.debug(`Injected ${origin.localStorage.length} localStorage items for ${currentOrigin}`);
                                // Reload so the app picks up the injected localStorage (MSAL tokens etc.)
                                await page.reload({ waitUntil: 'domcontentloaded', timeout: timeout });
                            }
                        }
                    }

                    // Wait for redirects to complete
                    await this.waitForNavigationToSettle(page, 10000);

                    // Step 4: Check if we landed on the app or got redirected to login (expired tokens)
                    const currentUrl = page.url().toLowerCase();
                    if (currentUrl.includes('login.microsoftonline.com') ||
                        currentUrl.includes('login.microsoft.com') ||
                        currentUrl.includes('login.live.com')) {
                        // Session tokens expired — fall back to fresh login
                        CSReporter.info('Saved session expired (redirected to login) — performing fresh SSO login');
                        await this.loginWithConfigCredentials(options);
                        return;
                    }

                    // Step 5: Wait for app to be ready
                    await this.waitForAppReady(page, timeout);
                    CSReporter.pass('Session restored and app loaded successfully');
                    return;
                }
            } catch (error: any) {
                CSReporter.warn(`Session restore failed: ${error.message} — falling back to fresh login`);
            }
        }

        CSReporter.info('No valid session found — performing fresh SSO login');
        await this.loginWithConfigCredentials(options);
    }
}
