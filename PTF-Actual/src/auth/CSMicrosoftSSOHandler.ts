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
            // Step 1: Navigate to the app URL (triggers SSO redirect)
            CSReporter.info('Step 1: Navigating to application URL...');
            await page.goto(loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: timeout
            });

            // Step 2: Wait for Microsoft login page to appear
            // The page may redirect through multiple URLs before landing on login.microsoftonline.com
            CSReporter.info('Step 2: Waiting for Microsoft login page...');
            await this.waitForMicrosoftLoginPage(page, timeout);

            // Step 3: Enter email/username
            CSReporter.info('Step 3: Entering email address...');
            await this.enterEmail(page, username, timeout);

            // Step 4: Enter password
            CSReporter.info('Step 4: Entering password...');
            await this.enterPassword(page, password, timeout);

            // Step 5: Handle "Stay signed in?" prompt
            if (staySignedIn !== false) {
                CSReporter.info('Step 5: Handling "Stay signed in?" prompt...');
                await this.handleStaySignedIn(page, staySignedIn, timeout);
            }

            // Step 6: Wait for redirect back to the application
            CSReporter.info('Step 6: Waiting for redirect back to application...');
            await this.waitForAppRedirect(page, loginUrl, timeout);

            CSReporter.pass(`Microsoft SSO login successful for: ${username}`);

            // Step 7: Save session if configured
            if (saveSessionPath) {
                CSReporter.info('Step 7: Saving browser session...');
                await this.browserManager.saveStorageState(saveSessionPath);
                CSReporter.pass(`Session saved to: ${saveSessionPath}`);
            }

        } catch (error: any) {
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
     * Enter email address on the Microsoft login page
     */
    private async enterEmail(page: any, email: string, timeout: number): Promise<void> {
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

        // Wait for the page transition (password page or error)
        await page.waitForTimeout(1000);
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
