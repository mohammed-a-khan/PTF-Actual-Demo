// Lazy load Playwright for performance - saves 27s at startup
// These will be loaded when actually needed
let playwright: any = null;
type Browser = any;
type BrowserContext = any;
type Page = any;
type BrowserType = any;
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';
import * as path from 'path';
// Parallel resource manager removed - handled differently now

export interface BrowserState {
    cookies?: any[];
    localStorage?: any[];
    sessionStorage?: any[];
    url?: string;
}

export class CSBrowserManager {
    private static instance: CSBrowserManager;
    private static threadInstances: Map<number, CSBrowserManager> = new Map();
    private browser: any | null = null; // Browser from Playwright
    private context: any | null = null; // BrowserContext from Playwright
    private page: any | null = null; // Page from Playwright
    private browserPool: Map<string, any> = new Map(); // Map<string, Browser>
    private currentBrowserType: string = 'chrome';
    private browserState: BrowserState = {};
    private restartCount: number = 0;
    private isWorkerThread: boolean = false;
    private workerId: number = 0;
    private videosToDelete: string[] = [];
    private harsToDelete: string[] = [];
    private currentHarPath: string | null = null;
    private sessionArtifacts: { videos: string[], traces: string[], har: string[], screenshots: string[] } = {
        videos: [],
        traces: [],
        har: [],
        screenshots: []
    };
    private traceStarted: boolean = false;
    // Page change listeners - called when page changes (e.g., after browser switch)
    private pageChangeListeners: Array<(newPage: any) => void> = [];

    private constructor() {
        // Don't store config reference - get it fresh each time to avoid initialization order issues
        // Check if running in worker thread
        if (typeof process !== 'undefined' && process.env.WORKER_ID) {
            this.isWorkerThread = true;
            this.workerId = parseInt(process.env.WORKER_ID) || 0;
            CSReporter.debug(`BrowserManager initialized for worker ${this.workerId} (raw: ${process.env.WORKER_ID})`);
        }
    }

    public static getInstance(): CSBrowserManager {
        // For worker threads, create separate instances
        if (typeof process !== 'undefined' && process.env.WORKER_ID) {
            const workerId = parseInt(process.env.WORKER_ID);
            if (!CSBrowserManager.threadInstances.has(workerId)) {
                CSBrowserManager.threadInstances.set(workerId, new CSBrowserManager());
            }
            return CSBrowserManager.threadInstances.get(workerId)!;
        }

        // Use global singleton to handle cross-module resolution (e.g., globally
        // installed CLI + locally installed package resolve to different module files,
        // but should share the same browser manager instance)
        const globalKey = '__csBrowserManagerInstance';
        if ((global as any)[globalKey]) {
            CSBrowserManager.instance = (global as any)[globalKey];
            return CSBrowserManager.instance;
        }

        // For main thread, use singleton
        if (!CSBrowserManager.instance) {
            CSBrowserManager.instance = new CSBrowserManager();
            (global as any)[globalKey] = CSBrowserManager.instance;
        }
        return CSBrowserManager.instance;
    }
    
    // Get fresh config reference each time to avoid singleton initialization order issues
    private get config(): CSConfigurationManager {
        return CSConfigurationManager.getInstance();
    }

    /**
     * Ensure Playwright is loaded (lazy loading)
     */
    private ensurePlaywright(): any {
        if (!playwright) {
            // Lazy load playwright - this takes 27 seconds!
            playwright = require('@playwright/test');
        }
        return playwright;
    }

    public async launch(browserType?: string): Promise<void> {
        const startTime = Date.now();

        if (!browserType) {
            browserType = this.config.get('BROWSER', 'chrome');
        }

        this.currentBrowserType = browserType;

        try {
            // Close existing browser processes if configured — but ONLY on the first launch
            // when Playwright doesn't already own a browser. In browser reuse mode, the 2nd+
            // scenario calls launch() again but the browser from scenario 1 is still alive.
            // Killing it would destroy the Playwright-managed browser/context/page.
            if (this.config.getBoolean('BROWSER_CLOSE_EXISTING', false) && !this.browser && !this.context) {
                await this.closeExistingBrowserProcesses(browserType);
            }

            // Check for CDP connection mode (BROWSER_CDP_URL)
            // Connects to an already-running Edge/Chrome with remote debugging enabled.
            // This is the solution for enterprise VDIs with Conditional Access device compliance:
            // the running browser already satisfies CA policy, so Playwright can use it.
            const cdpUrl = this.config.get('BROWSER_CDP_URL');
            if (cdpUrl && !this.context) {
                CSReporter.info(`Connecting to existing browser via CDP: ${cdpUrl}`);
                await this.connectOverCDP(cdpUrl);
                const launchTime = Date.now() - startTime;
                CSReporter.info(`Browser ${browserType} (CDP) connected in ${launchTime}ms`);
                return;
            }

            // Resolve user data directory for persistent context mode
            // Priority: BROWSER_USER_DATA_DIR (explicit) > BROWSER_USE_EXISTING_PROFILE=true (auto-detect)
            let userDataDir: string | null = this.config.get('BROWSER_USER_DATA_DIR') || null;

            if (!userDataDir && this.config.getBoolean('BROWSER_USE_EXISTING_PROFILE', false)) {
                userDataDir = this.detectEdgeProfilePath(browserType);
                if (userDataDir) {
                    // Store the detected path in config so downstream code (SSO handler,
                    // getChromeArgs, etc.) that checks BROWSER_USER_DATA_DIR sees it.
                    // Without this, the SSO handler would use Mode A (fresh browser) instead
                    // of Mode B (persistent context) and skip the aggressive VDI cleanup.
                    this.config.set('BROWSER_USER_DATA_DIR', userDataDir);
                    CSReporter.info(`Auto-detected browser profile path: ${userDataDir}`);
                } else {
                    CSReporter.warn('BROWSER_USE_EXISTING_PROFILE=true but could not auto-detect profile path. Falling back to fresh browser.');
                }
            }

            // Check if persistent context mode is needed (BROWSER_USER_DATA_DIR)
            // Persistent context is required for scenarios where the browser profile state
            // matters (e.g., Conditional Access device compliance on enterprise VDIs)
            if (userDataDir && !this.context) {
                CSReporter.info(`Launching persistent context with user data dir: ${userDataDir}`);
                await this.launchPersistentContext(browserType, userDataDir);
                const launchTime = Date.now() - startTime;
                CSReporter.info(`Browser ${browserType} (persistent) launched in ${launchTime}ms`);
                return;
            }

            // Get browser instance based on reuse configuration
            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

            if (browserReuseEnabled && this.browser) {
                // Reuse existing browser
                CSReporter.debug('Reusing existing browser');
            } else {
                CSReporter.debug('Launching new browser');
                this.browser = await this.launchBrowser(browserType);

                if (browserReuseEnabled) {
                    this.browserPool.set(browserType, this.browser);
                }
            }

            // For new-per-scenario, we should NOT create a new context here
            // The context should be created fresh and closed properly with test status after each scenario
            if (!this.context) {
                CSReporter.debug('Creating new context (no existing context)');
                await this.createContext();
                await this.createPage();
            } else if (!this.page) {
                CSReporter.debug('Creating new page (context exists but no page)');
                await this.createPage();
            } else {
                CSReporter.debug('Context and page already exist');
            }

            const launchTime = Date.now() - startTime;
            if (launchTime > 3000) {
                CSReporter.warn(`Browser launch took ${launchTime}ms (target: <3000ms)`);
            }

            CSReporter.info(`Browser ${browserType} launched successfully in ${launchTime}ms`);
        } catch (error) {
            CSReporter.fail(`Failed to launch browser: ${error}`);
            throw error;
        }
    }

    /**
     * Launch browser with a persistent user data directory.
     * Uses Playwright's launchPersistentContext() which preserves the Edge/Chrome profile state
     * including device compliance tokens, signed-in browser profiles, and cached certificates.
     *
     * This is required for enterprise VDI scenarios where Conditional Access policies
     * check the browser profile's sign-in state (e.g., "Sign in with your work account").
     *
     * Config: BROWSER_USER_DATA_DIR=/path/to/edge/profile
     */
    private async launchPersistentContext(browserType: string, userDataDir: string): Promise<void> {
        const fs = require('fs');
        const resolvedDir = path.resolve(userDataDir);

        if (!fs.existsSync(resolvedDir)) {
            fs.mkdirSync(resolvedDir, { recursive: true });
            CSReporter.debug(`Created user data directory: ${resolvedDir}`);
        }

        const isHeadless = this.config.getBoolean('HEADLESS', false);
        const contextOptions: any = {
            headless: isHeadless,
            channel: browserType === 'edge' ? 'msedge' : undefined,
            timeout: this.config.getNumber('BROWSER_LAUNCH_TIMEOUT', 30000),
            slowMo: this.config.getNumber('BROWSER_SLOWMO', 0),
            viewport: isHeadless ? {
                width: this.config.getNumber('BROWSER_VIEWPORT_WIDTH', 1920),
                height: this.config.getNumber('BROWSER_VIEWPORT_HEIGHT', 1080)
            } : null,
            ignoreHTTPSErrors: this.config.getBoolean('BROWSER_IGNORE_HTTPS_ERRORS', true),
            locale: this.config.get('BROWSER_LOCALE', 'en-US'),
            acceptDownloads: true,
            args: isHeadless ? [] : [
                '--start-maximized',
                '--no-default-browser-check',
                '--disable-features=VizDisplayCompositor',
                '--force-device-scale-factor=1'
            ]
        };

        // Add Chrome/Edge args (auth flags, VDI fixes, etc.)
        if (browserType === 'chrome' || browserType === 'chromium' || browserType === 'edge') {
            const chromeArgs = this.getChromeArgs();
            contextOptions.args = [...(contextOptions.args || []), ...chromeArgs];
        }

        const pw = this.ensurePlaywright();
        // launchPersistentContext returns a BrowserContext directly (not a Browser)
        this.context = await pw.chromium.launchPersistentContext(resolvedDir, contextOptions);
        // The persistent context owns a browser internally
        this.browser = this.context.browser() || this.context;

        // Set default timeouts
        this.context.setDefaultTimeout(this.config.getNumber('BROWSER_ACTION_TIMEOUT', 10000));
        this.context.setDefaultNavigationTimeout(this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000));

        // Get or create a page — close any restored tabs from previous sessions
        const pages = this.context.pages();
        if (pages.length > 0) {
            this.page = pages[0];
            // Close all extra tabs that Edge restored from the previous session
            for (let i = 1; i < pages.length; i++) {
                try { await pages[i].close(); } catch {}
            }
            if (pages.length > 1) {
                CSReporter.debug(`[PersistentContext] Closed ${pages.length - 1} restored tab(s), keeping 1 clean tab`);
            }
        } else {
            this.page = await this.context.newPage();
        }

        // Navigate the main page to about:blank immediately to stop any restored page
        // from continuing to load (Edge crash recovery can trigger navigations on the first tab)
        try {
            await this.page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
        } catch { /* ignore — page may already be on about:blank */ }

        // Listen for new pages/tabs that Edge might open asynchronously (crash recovery,
        // startup pages, extension popups, etc.) and close them immediately
        this.context.on('page', async (newPage: any) => {
            // Only auto-close if this is NOT our active test page
            if (newPage !== this.page) {
                try {
                    const url = newPage.url();
                    CSReporter.debug(`[PersistentContext] Auto-closing unexpected new tab: ${url}`);
                    await newPage.close();
                } catch { /* page may already be closed */ }
            }
        });

        // Add console log listener
        if (this.config.getBoolean('CONSOLE_LOG_CAPTURE', true)) {
            this.page.on('console', (msg: any) => {
                const resultsManager = CSTestResultsManager.getInstance();
                resultsManager.addConsoleLog(msg.type(), msg.text(), new Date());
                CSReporter.debug(`Console [${msg.type()}]: ${msg.text()}`);
            });
        }

        this.page.on('pageerror', (error: any) => {
            CSReporter.warn(`Page error: ${error.message}`);
        });

        CSReporter.info(`Persistent context launched with Edge profile: ${resolvedDir}`);
    }

    /**
     * Connect to an already-running browser via Chrome DevTools Protocol (CDP).
     *
     * This is the recommended approach for enterprise VDIs with Conditional Access
     * device compliance policies. The workflow is:
     *   1. A helper script (or manual step) launches Edge with --remote-debugging-port=9222
     *      using the VDI user's signed-in Edge profile (satisfies device compliance)
     *   2. Playwright connects to that running browser via CDP
     *   3. The SSO handler then clears the session and logs in as the test user
     *   4. Conditional Access allows the test user because the BROWSER is compliant
     *
     * Config:
     *   BROWSER_CDP_URL=http://localhost:9222    (CDP endpoint of running browser)
     *
     * To launch Edge with CDP on Windows VDI:
     *   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
     *   Or: start msedge --remote-debugging-port=9222
     */
    private async connectOverCDP(cdpUrl: string): Promise<void> {
        const pw = this.ensurePlaywright();

        try {
            this.browser = await pw.chromium.connectOverCDP(cdpUrl, {
                timeout: this.config.getNumber('BROWSER_LAUNCH_TIMEOUT', 30000)
            });

            // Get existing contexts from the running browser
            const contexts = this.browser.contexts();
            if (contexts.length > 0) {
                this.context = contexts[0];
                CSReporter.debug(`CDP: Using existing context (${contexts.length} context(s) available)`);
            } else {
                // Create a new context if none exist
                this.context = await this.browser.newContext({
                    ignoreHTTPSErrors: this.config.getBoolean('BROWSER_IGNORE_HTTPS_ERRORS', true),
                    acceptDownloads: true,
                });
                CSReporter.debug('CDP: Created new context in connected browser');
            }

            // Set default timeouts
            this.context.setDefaultTimeout(this.config.getNumber('BROWSER_ACTION_TIMEOUT', 10000));
            this.context.setDefaultNavigationTimeout(this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000));

            // Get existing pages or create a new one
            const pages = this.context.pages();
            if (pages.length > 0) {
                // Use an existing page — navigate to about:blank to start clean
                this.page = pages[0];
                await this.page.goto('about:blank');
                CSReporter.debug(`CDP: Using existing page (${pages.length} page(s) in context)`);
            } else {
                this.page = await this.context.newPage();
                CSReporter.debug('CDP: Created new page in connected context');
            }

            // Add console log listener
            if (this.config.getBoolean('CONSOLE_LOG_CAPTURE', true)) {
                this.page.on('console', (msg: any) => {
                    const resultsManager = CSTestResultsManager.getInstance();
                    resultsManager.addConsoleLog(msg.type(), msg.text(), new Date());
                    CSReporter.debug(`Console [${msg.type()}]: ${msg.text()}`);
                });
            }

            this.page.on('pageerror', (error: any) => {
                CSReporter.warn(`Page error: ${error.message}`);
            });

            CSReporter.info(`Connected to browser via CDP at: ${cdpUrl}`);
        } catch (error: any) {
            throw new Error(
                `Failed to connect via CDP to ${cdpUrl}: ${error.message}\n\n` +
                'Make sure Edge is running with remote debugging enabled:\n' +
                '  start msedge --remote-debugging-port=9222\n\n' +
                'Or add to crm-dev.env:\n' +
                '  BROWSER_CDP_URL=http://localhost:9222'
            );
        }
    }

    private async launchBrowser(browserType: string): Promise<any> {
        const isHeadless = this.config.getBoolean('HEADLESS', false);
        
        const defaultArgs = isHeadless ? [] : [
            '--start-maximized',
            '--no-default-browser-check',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--force-device-scale-factor=1'
        ];

        // devtools launch option was removed in Playwright 1.58+
        // Use --auto-open-devtools-for-tabs browser arg instead
        if (this.config.getBoolean('BROWSER_DEVTOOLS', false)) {
            defaultArgs.push('--auto-open-devtools-for-tabs');
        }

        const browserOptions: any = {
            headless: isHeadless,
            timeout: this.config.getNumber('BROWSER_LAUNCH_TIMEOUT', 30000),
            slowMo: this.config.getNumber('BROWSER_SLOWMO', 0),
            args: defaultArgs
        };

        // Add proxy if configured
        const proxyEnabled = this.config.getBoolean('BROWSER_PROXY_ENABLED', false);
        if (proxyEnabled) {
            browserOptions.proxy = {
                server: this.config.get('BROWSER_PROXY_SERVER'),
                username: this.config.get('BROWSER_PROXY_USERNAME'),
                password: this.config.get('BROWSER_PROXY_PASSWORD'),
                bypass: this.config.get('BROWSER_PROXY_BYPASS')
            };
        }

        // Add browser-specific options
        if (browserType === 'chrome' || browserType === 'chromium') {
            // Merge args instead of overwriting
            const chromeArgs = this.getChromeArgs();
            browserOptions.args = [...(browserOptions.args || []), ...chromeArgs];
            const pw = this.ensurePlaywright();
            return await pw.chromium.launch(browserOptions);
        } else if (browserType === 'firefox') {
            const firefoxArgs = this.getFirefoxArgs();
            browserOptions.args = [...(browserOptions.args || []), ...firefoxArgs];
            const pw = this.ensurePlaywright();
            return await pw.firefox.launch(browserOptions);
        } else if (browserType === 'webkit' || browserType === 'safari') {
            const pw = this.ensurePlaywright();
            return await pw.webkit.launch(browserOptions);
        } else if (browserType === 'edge') {
            browserOptions.channel = 'msedge';
            // Edge is Chromium-based — apply the same Chrome args (auth flags, etc.)
            const chromeArgs = this.getChromeArgs();
            browserOptions.args = [...(browserOptions.args || []), ...chromeArgs];
            // IE Compatibility Mode — requires Enterprise Site List configured via Group Policy
            if (this.config.getBoolean('BROWSER_EDGE_IE_MODE', false)) {
                browserOptions.args.push('--internet-explorer-integration=iemode');
                browserOptions.args.push('--ie-mode-test');
                browserOptions.args.push('--no-first-run');
                if (!browserOptions.timeout || browserOptions.timeout < 60000) {
                    browserOptions.timeout = 60000;
                }
                CSReporter.info('Edge IE Compatibility Mode enabled');
            }
            const pw = this.ensurePlaywright();
            return await pw.chromium.launch(browserOptions);
        } else {
            throw new Error(`Unsupported browser type: ${browserType}`);
        }
    }

    private getChromeArgs(): string[] {
        const args = [];

        // Always maximize in non-headless mode
        const isHeadless = this.config.getBoolean('HEADLESS', false);
        if (!isHeadless) {
            args.push('--start-maximized');
        }

        if (this.config.getBoolean('BROWSER_INCOGNITO', false)) {
            args.push('--incognito');
        }

        if (this.config.getBoolean('BROWSER_DISABLE_GPU', false)) {
            args.push('--disable-gpu');
        }

        if (this.config.getBoolean('BROWSER_NO_SANDBOX', false)) {
            args.push('--no-sandbox');
        }

        // Ignore certificate errors (for self-signed certs or ERR_CERT_COMMON_NAME_INVALID)
        if (this.config.getBoolean('BROWSER_IGNORE_HTTPS_ERRORS', true)) {
            args.push('--ignore-certificate-errors');
            args.push('--ignore-ssl-errors');
            args.push('--allow-insecure-localhost');
        }

        // Disable Windows SSO auto-negotiation (Kerberos/NTLM) on VDI environments
        // This prevents the browser from auto-passing domain credentials to login.microsoftonline.com
        // which bypasses the username/password fields needed for test user authentication.
        // Set AUTH_SERVER_ALLOWLIST="_" to block all auto-auth, or specify allowed domains.
        // See: https://github.com/microsoft/playwright/issues/22060
        const authServerAllowlist = this.config.get('AUTH_SERVER_ALLOWLIST');
        if (authServerAllowlist) {
            args.push(`--auth-server-allowlist=${authServerAllowlist}`);
            args.push(`--auth-negotiate-delegate-allowlist=${authServerAllowlist}`);
            args.push('--disable-background-networking');
            // Edge-specific: disable built-in Windows SSO/PRT integration
            // Edge has deeper Windows identity integration than Chrome (WAM/PRT)
            // These flags disable Edge's implicit sign-in and account transfer features
            args.push('--disable-features=msImplicitSignin,msEdgeAutoSignIn,msPrimaryAccountMerge');
        }

        // When using a persistent user data directory (VDI profile), prevent Edge/Chrome from
        // restoring tabs from the previous session — we only want a clean tab for the test URL
        if (this.config.get('BROWSER_USER_DATA_DIR')) {
            args.push('--no-first-run');
            args.push('--no-default-browser-check');
            // Suppress crash recovery: prevents "Restore pages?" bubble and tab restoration
            args.push('--disable-session-crashed-bubble');
            args.push('--hide-crash-restore-bubble');
            // Disable background features that can open tabs or trigger navigations
            args.push('--disable-background-mode');
            args.push('--disable-backgrounding-occluded-windows');
            // Disable Edge startup boost (pre-launches Edge in background, can interfere)
            args.push('--disable-features=msStartupBoost,StartupBoostEnabled');
            // Disable component updates that can trigger background activity
            args.push('--disable-component-update');
        }

        // Add custom args
        const customArgs = this.config.getList('BROWSER_CHROME_ARGS');
        args.push(...customArgs);

        return args;
    }

    /**
     * Auto-detect the browser profile directory path for the current VDI user.
     *
     * Used when BROWSER_USE_EXISTING_PROFILE=true and no explicit BROWSER_USER_DATA_DIR is set.
     * Constructs the default profile path based on the current OS username and browser type.
     *
     * Windows paths:
     *   Edge:   C:\Users\{USERNAME}\AppData\Local\Microsoft\Edge\User Data
     *   Chrome: C:\Users\{USERNAME}\AppData\Local\Google\Chrome\User Data
     *
     * Linux/WSL paths:
     *   Edge:   /home/{USER}/.config/microsoft-edge
     *   Chrome: /home/{USER}/.config/google-chrome
     *
     * macOS paths:
     *   Edge:   /Users/{USER}/Library/Application Support/Microsoft Edge
     *   Chrome: /Users/{USER}/Library/Application Support/Google/Chrome
     *
     * @param browserType - Browser type (edge, chrome, chromium)
     * @returns Detected profile path, or null if detection fails
     */
    private detectEdgeProfilePath(browserType: string): string | null {
        const fs = require('fs');
        const os = require('os');

        // Get the current username
        const username = process.env.USERNAME || process.env.USER || os.userInfo().username;
        if (!username) {
            CSReporter.warn('Could not determine current username for profile path detection');
            return null;
        }

        const platform = os.platform();
        let profilePath: string | null = null;

        if (platform === 'win32') {
            // Windows
            if (browserType === 'edge') {
                profilePath = `C:\\Users\\${username}\\AppData\\Local\\Microsoft\\Edge\\User Data`;
            } else if (browserType === 'chrome' || browserType === 'chromium') {
                profilePath = `C:\\Users\\${username}\\AppData\\Local\\Google\\Chrome\\User Data`;
            }
        } else if (platform === 'linux') {
            // Linux / WSL
            // On WSL, Windows paths are accessible via /mnt/c/
            // Check if running on WSL by looking for WSL-specific indicators
            const isWSL = fs.existsSync('/proc/version') &&
                fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');

            if (isWSL) {
                // WSL: use the Windows path via /mnt/c/
                // Get Windows username from WSLENV or try common approaches
                const winUsername = process.env.LOGNAME || process.env.USER || username;
                if (browserType === 'edge') {
                    profilePath = `/mnt/c/Users/${winUsername}/AppData/Local/Microsoft/Edge/User Data`;
                } else if (browserType === 'chrome' || browserType === 'chromium') {
                    profilePath = `/mnt/c/Users/${winUsername}/AppData/Local/Google/Chrome/User Data`;
                }

                // If WSL path doesn't exist, the Windows username might differ from Linux username
                if (profilePath && !fs.existsSync(profilePath)) {
                    CSReporter.debug(`WSL path not found: ${profilePath}`);
                    // Try to get Windows username via cmd.exe
                    try {
                        const { execSync } = require('child_process');
                        const winUser = execSync('cmd.exe /c echo %USERNAME% 2>/dev/null', { encoding: 'utf8' }).trim();
                        if (winUser && winUser !== '%USERNAME%') {
                            if (browserType === 'edge') {
                                profilePath = `/mnt/c/Users/${winUser}/AppData/Local/Microsoft/Edge/User Data`;
                            } else {
                                profilePath = `/mnt/c/Users/${winUser}/AppData/Local/Google/Chrome/User Data`;
                            }
                            CSReporter.debug(`WSL Windows username detected: ${winUser}`);
                        }
                    } catch {
                        CSReporter.debug('Could not detect Windows username from WSL');
                    }
                }
            } else {
                // Native Linux
                const homeDir = os.homedir();
                if (browserType === 'edge') {
                    profilePath = path.join(homeDir, '.config', 'microsoft-edge');
                } else if (browserType === 'chrome' || browserType === 'chromium') {
                    profilePath = path.join(homeDir, '.config', 'google-chrome');
                }
            }
        } else if (platform === 'darwin') {
            // macOS
            const homeDir = os.homedir();
            if (browserType === 'edge') {
                profilePath = path.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge');
            } else if (browserType === 'chrome' || browserType === 'chromium') {
                profilePath = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
            }
        }

        if (!profilePath) {
            CSReporter.warn(`Profile path auto-detection not supported for browser: ${browserType} on platform: ${platform}`);
            return null;
        }

        // Verify the path exists
        if (fs.existsSync(profilePath)) {
            CSReporter.info(`Detected browser profile directory: ${profilePath}`);
            return profilePath;
        }

        CSReporter.warn(`Auto-detected profile path does not exist: ${profilePath}`);
        return null;
    }

    /**
     * Close existing browser processes before launching with persistent context.
     *
     * Required because Edge/Chrome lock the profile directory — Playwright cannot
     * use launchPersistentContext() if another browser instance is using the same profile.
     *
     * Behavior:
     *   - On Windows/WSL: Uses taskkill to close Edge/Chrome processes
     *   - On Linux: Uses pkill to close browser processes
     *   - On macOS: Uses pkill to close browser processes
     *   - Waits briefly after killing to allow file locks to release
     *
     * Config: BROWSER_CLOSE_EXISTING=true
     *
     * WARNING: This will close ALL instances of the browser type (Edge/Chrome).
     * The user should be aware that any open browser windows will be closed.
     */
    private async closeExistingBrowserProcesses(browserType: string): Promise<void> {
        const os = require('os');
        const { execSync } = require('child_process');
        const platform = os.platform();

        let processName: string;
        let killCommand: string;

        // Determine the process name based on browser type and OS
        if (browserType === 'edge') {
            if (platform === 'win32') {
                processName = 'msedge.exe';
                killCommand = `taskkill /f /im ${processName} /t 2>nul`;
            } else if (platform === 'linux') {
                // On WSL, Edge might be running as a Windows process
                const isWSL = require('fs').existsSync('/proc/version') &&
                    require('fs').readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
                if (isWSL) {
                    processName = 'msedge.exe';
                    killCommand = `taskkill.exe /f /im ${processName} /t 2>/dev/null || pkill -f microsoft-edge 2>/dev/null`;
                } else {
                    processName = 'microsoft-edge';
                    killCommand = `pkill -f ${processName} 2>/dev/null`;
                }
            } else if (platform === 'darwin') {
                processName = 'Microsoft Edge';
                killCommand = `pkill -f "Microsoft Edge" 2>/dev/null`;
            } else {
                CSReporter.debug(`Browser process close not supported on platform: ${platform}`);
                return;
            }
        } else if (browserType === 'chrome' || browserType === 'chromium') {
            if (platform === 'win32') {
                processName = 'chrome.exe';
                killCommand = `taskkill /f /im ${processName} /t 2>nul`;
            } else if (platform === 'linux') {
                const isWSL = require('fs').existsSync('/proc/version') &&
                    require('fs').readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
                if (isWSL) {
                    processName = 'chrome.exe';
                    killCommand = `taskkill.exe /f /im ${processName} /t 2>/dev/null || pkill -f google-chrome 2>/dev/null`;
                } else {
                    processName = 'google-chrome';
                    killCommand = `pkill -f ${processName} 2>/dev/null`;
                }
            } else if (platform === 'darwin') {
                processName = 'Google Chrome';
                killCommand = `pkill -f "Google Chrome" 2>/dev/null`;
            } else {
                CSReporter.debug(`Browser process close not supported on platform: ${platform}`);
                return;
            }
        } else {
            CSReporter.debug(`Browser close not supported for type: ${browserType}`);
            return;
        }

        try {
            CSReporter.info(`Closing existing ${browserType} browser processes...`);
            execSync(killCommand, { encoding: 'utf8', timeout: 10000 });
            // Wait for file locks to release after killing browser processes
            await new Promise(resolve => setTimeout(resolve, 2000));
            CSReporter.info(`Existing ${browserType} browser processes closed`);
        } catch (error: any) {
            // Exit code 128 (taskkill: no matching processes) or similar is expected
            // when no browser is running — this is not an error
            CSReporter.debug(`Browser close result: ${error.message || 'no matching processes'}`);
        }

        // After force-killing, Edge/Chrome interprets this as a crash and will try to
        // restore all previously open tabs on next launch. Clean up crash recovery data
        // from the profile directory to prevent this.
        const userDataDir = this.config.get('BROWSER_USER_DATA_DIR');
        if (userDataDir) {
            this.clearSessionRecoveryFiles(userDataDir);
        }
    }

    /**
     * Clear Edge/Chrome session recovery files from the profile directory.
     *
     * When a browser is force-killed (taskkill /f), it records a "crash" state.
     * On next launch, crash recovery restores all previously open tabs, which
     * interferes with test automation (extra tabs, background navigations, etc.).
     *
     * This method:
     *   1. Deletes session recovery files (Current Session, Current Tabs, etc.)
     *   2. Modifies the Preferences file to disable "Continue where you left off"
     *      and suppress the crash restore bubble
     *
     * Safe to call even if files don't exist (silently skips missing files).
     */
    private clearSessionRecoveryFiles(userDataDir: string): void {
        const fs = require('fs');
        const resolvedDir = path.resolve(userDataDir);

        // Session recovery files live inside the "Default" profile subfolder
        // (or whichever profile folder is active)
        const profileDirs = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'];

        for (const profileDir of profileDirs) {
            const profilePath = path.join(resolvedDir, profileDir);
            if (!fs.existsSync(profilePath)) continue;

            // 1. Delete session/tab recovery files
            const sessionFiles = [
                'Current Session',
                'Current Tabs',
                'Last Session',
                'Last Tabs',
                'Session Storage',
                'Sessions',
            ];

            for (const sessionFile of sessionFiles) {
                const filePath = path.join(profilePath, sessionFile);
                try {
                    if (fs.existsSync(filePath)) {
                        const stat = fs.statSync(filePath);
                        if (stat.isDirectory()) {
                            fs.rmSync(filePath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(filePath);
                        }
                        CSReporter.debug(`Deleted session recovery: ${filePath}`);
                    }
                } catch (e: any) {
                    CSReporter.debug(`Could not delete ${filePath}: ${e.message}`);
                }
            }

            // 2. Modify Preferences to prevent session restore and crash bubble
            const prefsPath = path.join(profilePath, 'Preferences');
            if (fs.existsSync(prefsPath)) {
                try {
                    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));

                    // Set startup to "Open the New Tab page" (value 5)
                    // instead of "Continue where you left off" (value 1)
                    if (!prefs.session) prefs.session = {};
                    prefs.session.restore_on_startup = 5;

                    // Clear the "exited cleanly" crash flag — tells Edge it was NOT a crash
                    if (!prefs.profile) prefs.profile = {};
                    prefs.profile.exit_type = 'Normal';
                    prefs.profile.exited_cleanly = true;

                    // Disable the "Restore pages?" crash bubble prompt
                    if (!prefs.sessions) prefs.sessions = {};
                    prefs.sessions.restore_on_startup = 5;

                    // Disable startup boost (pre-launches Edge in background)
                    if (!prefs.browser) prefs.browser = {};
                    prefs.browser.startup_boost_enabled = false;

                    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf8');
                    CSReporter.debug(`Updated Preferences: restore_on_startup=5, exit_type=Normal in ${profileDir}`);
                } catch (e: any) {
                    CSReporter.debug(`Could not update Preferences in ${profileDir}: ${e.message}`);
                }
            }

            // 3. Also update "Secure Preferences" exit_type if it exists
            // Edge uses this as a secondary crash detection mechanism
            const securePrefsPath = path.join(profilePath, 'Secure Preferences');
            if (fs.existsSync(securePrefsPath)) {
                try {
                    const secPrefs = JSON.parse(fs.readFileSync(securePrefsPath, 'utf8'));
                    if (secPrefs.profile) {
                        secPrefs.profile.exit_type = 'Normal';
                        secPrefs.profile.exited_cleanly = true;
                        fs.writeFileSync(securePrefsPath, JSON.stringify(secPrefs, null, 2), 'utf8');
                        CSReporter.debug(`Updated Secure Preferences: exit_type=Normal in ${profileDir}`);
                    }
                } catch (e: any) {
                    CSReporter.debug(`Could not update Secure Preferences in ${profileDir}: ${e.message}`);
                }
            }
        }

        // 4. Clean up top-level crash sentinel files
        const topLevelCrashFiles = [
            'BrowserMetrics-active.pma',
            'BrowserMetrics-spare.pma',
            'Crashpad',
        ];
        for (const crashFile of topLevelCrashFiles) {
            const filePath = path.join(resolvedDir, crashFile);
            try {
                if (fs.existsSync(filePath)) {
                    const stat = fs.statSync(filePath);
                    if (stat.isDirectory()) {
                        // Don't delete Crashpad dir, just its contents that trigger restore
                    } else {
                        fs.unlinkSync(filePath);
                        CSReporter.debug(`Deleted crash file: ${filePath}`);
                    }
                }
            } catch (e: any) {
                CSReporter.debug(`Could not delete ${filePath}: ${e.message}`);
            }
        }

        CSReporter.info('Session recovery files cleared — browser will start clean');
    }

    private getFirefoxArgs(): string[] {
        const args = [];
        
        if (this.config.getBoolean('BROWSER_PRIVATE', false)) {
            args.push('-private');
        }
        
        // Add custom args
        const customArgs = this.config.getList('BROWSER_FIREFOX_ARGS');
        args.push(...customArgs);
        
        return args;
    }

    private async createContext(): Promise<void> {
        if (!this.browser) {
            throw new Error('Browser not launched');
        }

        const isHeadless = this.config.getBoolean('HEADLESS', false);
        
        const contextOptions: any = {
            viewport: isHeadless ? {
                width: this.config.getNumber('BROWSER_VIEWPORT_WIDTH', 1920),
                height: this.config.getNumber('BROWSER_VIEWPORT_HEIGHT', 1080)
            } : null, // null viewport means use the window size (maximized)
            ignoreHTTPSErrors: this.config.getBoolean('BROWSER_IGNORE_HTTPS_ERRORS', true),
            locale: this.config.get('BROWSER_LOCALE', 'en-US'),
            timezoneId: this.config.get('BROWSER_TIMEZONE', 'America/New_York'),
            permissions: this.config.getList('BROWSER_PERMISSIONS'),
            geolocation: this.getGeolocation(),
            colorScheme: this.config.get('BROWSER_COLOR_SCHEME', 'light') as any,
            reducedMotion: this.config.get('BROWSER_REDUCED_MOTION', 'no-preference') as any,
            forcedColors: this.config.get('BROWSER_FORCED_COLORS', 'none') as any,
            acceptDownloads: true, // Always accept downloads - file handling is done via event listener
        };

        // Add recording options if enabled
        const videoMode = this.config.get('BROWSER_VIDEO', 'off');

        // Use parallel resource manager if in parallel mode, otherwise use test results manager
        const isParallel = this.config.getBoolean('USE_WORKER_THREADS', false) && this.isWorkerThread;
        let dirs: any;

        // Always use the main test results directory (same for parallel and sequential)
        // This ensures artifacts are saved in the correct location
        const resultsManager = CSTestResultsManager.getInstance();
        dirs = resultsManager.getDirectories();

        // Debug log artifact configuration
        // console.log(`[BrowserManager] Artifact configuration:`, {
        //     videoMode,
        //     harCaptureMode: this.config.get('HAR_CAPTURE_MODE', 'never'),
        //     traceCaptureMode: this.config.get('TRACE_CAPTURE_MODE', 'never'),
        //     harEnabled: this.config.getBoolean('BROWSER_HAR_ENABLED', false),
        //     traceEnabled: this.config.getBoolean('BROWSER_TRACE_ENABLED', false),
        //     workerId: this.workerId || 'main'
        // });

        CSReporter.debug(`Video mode configured: ${videoMode} (Worker: ${this.workerId || 'main'})`);
        if (videoMode !== 'off' && videoMode !== 'never') {
            contextOptions.recordVideo = {
                dir: dirs.videos,
                size: {
                    width: this.config.getNumber('BROWSER_VIDEO_WIDTH', 1280),
                    height: this.config.getNumber('BROWSER_VIDEO_HEIGHT', 720)
                }
            };
            CSReporter.info(`Video recording enabled: ${dirs.videos}`);
        }

        // Add HAR recording if enabled (simplified: only check HAR_CAPTURE_MODE)
        const harCaptureMode = this.config.get('HAR_CAPTURE_MODE', 'never').toLowerCase();
        // For backward compatibility, also check deprecated BROWSER_HAR_ENABLED flag
        const harEnabledFlag = this.config.getBoolean('BROWSER_HAR_ENABLED', false);
        const harEnabled = harCaptureMode !== 'never' || harEnabledFlag;
        CSReporter.debug(`HAR recording configured: ${harEnabled} (mode: ${harCaptureMode})`);

        if (harEnabled) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const uniqueId = this.isWorkerThread ? `w${this.workerId}` : 'main';
            this.currentHarPath = `${dirs.har}/network-${uniqueId}-${timestamp}.har`;
            contextOptions.recordHar = {
                path: this.currentHarPath,
                omitContent: this.config.getBoolean('BROWSER_HAR_OMIT_CONTENT', false)
            };
            CSReporter.info(`HAR recording enabled: ${this.currentHarPath}`);
        }

        // Add user agent if specified
        const userAgent = this.config.get('BROWSER_USER_AGENT');
        if (userAgent) {
            contextOptions.userAgent = userAgent;
        }

        // Add extra HTTP headers
        const extraHeaders = this.config.get('BROWSER_EXTRA_HEADERS');
        if (extraHeaders) {
            contextOptions.extraHTTPHeaders = JSON.parse(extraHeaders);
        }

        // Add offline mode if specified
        if (this.config.getBoolean('BROWSER_OFFLINE', false)) {
            contextOptions.offline = true;
        }

        // Add HTTP credentials if specified
        const httpUsername = this.config.get('BROWSER_HTTP_USERNAME');
        const httpPassword = this.config.get('BROWSER_HTTP_PASSWORD');
        if (httpUsername && httpPassword) {
            contextOptions.httpCredentials = {
                username: httpUsername,
                password: httpPassword
            };
        }

        // Load storageState from file if AUTH_STORAGE_STATE_PATH is configured
        // This is the primary mechanism for SSO session reuse (e.g., Microsoft Dynamics 365)
        const storageStatePath = this.config.get('AUTH_STORAGE_STATE_PATH');
        const storageStateReuse = this.config.getBoolean('AUTH_STORAGE_STATE_REUSE', true);
        if (storageStatePath && storageStateReuse) {
            const fs = require('fs');
            const resolvedPath = path.resolve(storageStatePath);
            if (fs.existsSync(resolvedPath)) {
                try {
                    contextOptions.storageState = resolvedPath;
                    CSReporter.info(`Loading stored session from: ${resolvedPath}`);
                } catch (error: any) {
                    CSReporter.warn(`Failed to load storageState from ${resolvedPath}: ${error.message}`);
                }
            } else {
                CSReporter.debug(`StorageState file not found (first run?): ${resolvedPath}`);
            }
        }
        // Fallback: Restore in-memory state if switching browsers (but only if not explicitly cleared)
        else if (this.browserState.cookies && !this.config.getBoolean('BROWSER_REUSE_CLEAR_STATE', false)) {
            contextOptions.storageState = {
                cookies: this.browserState.cookies,
                origins: []
            };
        }

        CSReporter.debug(`Creating browser context with options: recordVideo=${!!contextOptions.recordVideo}, recordHar=${!!contextOptions.recordHar}`);
        this.context = await this.browser.newContext(contextOptions);
        CSReporter.info('Browser context created successfully');
        
        // Start tracing if enabled
        const traceCaptureMode = this.config.get('TRACE_CAPTURE_MODE', 'never').toLowerCase();
        const traceEnabled = traceCaptureMode !== 'never' || this.config.getBoolean('BROWSER_TRACE_ENABLED', false);
        if (traceEnabled) {
            CSReporter.debug(`Starting trace recording (${traceCaptureMode})...`);
            await this.context.tracing.start({
                screenshots: true,
                snapshots: true,
                sources: true
            });
            this.traceStarted = true;
            CSReporter.info(`Trace recording started (${traceCaptureMode})`);
        }
        
        // Set default timeout for context
        this.context.setDefaultTimeout(this.config.getNumber('BROWSER_ACTION_TIMEOUT', 10000));
        this.context.setDefaultNavigationTimeout(this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000));
    }

    private async createPage(): Promise<void> {
        if (!this.context) {
            throw new Error('Context not created');
        }

        this.page = await this.context.newPage();
        
        // Set page-level configurations
        const autoWaitTimeout = this.config.getNumber('BROWSER_AUTO_WAIT_TIMEOUT', 5000);
        if (autoWaitTimeout > 0) {
            this.page.setDefaultTimeout(autoWaitTimeout);
        }

        // Add console log listener if enabled
        if (this.config.getBoolean('CONSOLE_LOG_CAPTURE', true)) {
            this.page.on('console', (msg: any) => {
                const resultsManager = CSTestResultsManager.getInstance();
                resultsManager.addConsoleLog(msg.type(), msg.text(), new Date());
                CSReporter.debug(`Console [${msg.type()}]: ${msg.text()}`);
            });
        }

        // Add page error listener
        this.page.on('pageerror', (error: any) => {
            CSReporter.warn(`Page error: ${error.message}`);
        });

        // Add request failed listener
        this.page.on('requestfailed', (request: any) => {
            CSReporter.debug(`Request failed: ${request.url()} - ${request.failure()?.errorText}`);
        });

        // Add crash detection
        this.page.on('crash', () => {
            CSReporter.error('Page crashed!');
            if (this.config.getBoolean('BROWSER_AUTO_RESTART_ON_CRASH', true)) {
                this.handleCrash();
            }
        });

        // Add download auto-save listener if enabled
        // This handles the Playwright behavior where downloads are saved with GUID names
        // by automatically saving files with their proper suggested filenames
        if (this.config.getBoolean('DOWNLOAD_AUTO_SAVE', true)) {
            this.setupDownloadListener();
        }
    }

    /**
     * Setup download event listener for auto-saving files with proper names
     * Handles browser-specific quirks:
     * - WebKit/Safari: Download event may not trigger (known issue)
     * - Firefox: Issues with Blob downloads
     * - Chromium/Edge: Works reliably
     */
    private setupDownloadListener(): void {
        if (!this.page) return;

        const resultsManager = CSTestResultsManager.getInstance();
        const dirs = resultsManager.getDirectories();
        const downloadDir = dirs.downloads;
        const browserType = this.currentBrowserType;
        const workerId = this.isWorkerThread ? this.workerId : 0;

        // Warn about WebKit limitations
        if (browserType === 'webkit' || browserType === 'safari') {
            CSReporter.warn('WebKit/Safari has known issues with download events - auto-save may not work reliably. See: https://github.com/microsoft/playwright/issues/15417');
        }

        this.page.on('download', async (download: any) => {
            try {
                const suggestedFilename = download.suggestedFilename();
                const url = download.url();

                CSReporter.info(`Download started: ${suggestedFilename} from ${url}`);

                // Create unique filename with worker ID prefix for parallel execution
                const timestamp = Date.now();
                const uniquePrefix = workerId > 0 ? `w${workerId}_` : '';
                const finalFilename = `${uniquePrefix}${suggestedFilename}`;
                const savePath = path.join(downloadDir, finalFilename);

                // Wait for download to complete and save with proper name
                await download.saveAs(savePath);

                // Track the download for test verification
                resultsManager.addDownloadedFile(savePath, finalFilename, suggestedFilename);

                CSReporter.pass(`Download saved: ${savePath}`);
            } catch (error: any) {
                // Don't fail the test if download handling fails
                // The download may still be available via Playwright's default handling
                CSReporter.warn(`Download auto-save failed: ${error.message}. File may still be available in temp location.`);
            }
        });

        CSReporter.debug(`Download auto-save listener configured for ${browserType} browser`);
    }

    private getGeolocation(): any {
        const lat = this.config.get('BROWSER_GEOLOCATION_LAT');
        const lon = this.config.get('BROWSER_GEOLOCATION_LON');
        
        if (lat && lon) {
            return {
                latitude: parseFloat(lat),
                longitude: parseFloat(lon)
            };
        }
        
        return undefined;
    }


    private async saveState(): Promise<void> {
        if (!this.page || !this.context) return;
        
        try {
            this.browserState.url = this.page.url();
            const storageState = await this.context.storageState();
            this.browserState.cookies = storageState.cookies;
            this.browserState.localStorage = storageState.origins
                .flatMap((origin: any) => origin.localStorage || []);
            // Session storage is not persisted in Playwright's storageState
            this.browserState.sessionStorage = [];
            
            CSReporter.debug('Browser state saved');
        } catch (error) {
            CSReporter.warn(`Failed to save browser state: ${error}`);
        }
    }

    /**
     * Save browser storageState (cookies + localStorage) to a JSON file
     * Used for SSO session persistence — login once, reuse across test runs
     *
     * @param filePath - Path to save the session file (default: AUTH_STORAGE_STATE_PATH config)
     * @returns The resolved file path where the session was saved
     */
    public async saveStorageState(filePath?: string): Promise<string> {
        if (!this.context) {
            throw new Error('No browser context available. Launch a browser first.');
        }

        const targetPath = filePath || this.config.get('AUTH_STORAGE_STATE_PATH');
        if (!targetPath) {
            throw new Error('No file path provided and AUTH_STORAGE_STATE_PATH not configured');
        }

        const resolvedPath = path.resolve(targetPath);
        const fs = require('fs');

        // Ensure directory exists
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        await this.context.storageState({ path: resolvedPath });
        CSReporter.info(`Browser session saved to: ${resolvedPath}`);
        return resolvedPath;
    }

    /**
     * Load a previously saved storageState file for the NEXT context creation
     * Call this before launch() or use AUTH_STORAGE_STATE_PATH config for automatic loading
     *
     * If a context is already open, this closes it and creates a new one with the loaded state.
     *
     * @param filePath - Path to the session file to load
     */
    public async loadStorageState(filePath?: string): Promise<void> {
        const targetPath = filePath || this.config.get('AUTH_STORAGE_STATE_PATH');
        if (!targetPath) {
            throw new Error('No file path provided and AUTH_STORAGE_STATE_PATH not configured');
        }

        const resolvedPath = path.resolve(targetPath);
        const fs = require('fs');

        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`StorageState file not found: ${resolvedPath}`);
        }

        // If we have an active context, inject state into it
        if (this.context && this.page) {
            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);
            const isPersistentContext = !!this.config.get('BROWSER_USER_DATA_DIR');

            if (browserReuseEnabled || isPersistentContext) {
                // NON-DESTRUCTIVE: Inject cookies/localStorage into the existing context
                // This is required for browser reuse mode and persistent context mode
                // where closing/recreating the context breaks trace recording and the
                // BDD runner's context lifecycle management.
                CSReporter.info(`Loading session from ${resolvedPath} — injecting into existing context`);

                const sessionData = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

                // Step 1: Inject cookies into the context
                if (sessionData.cookies && sessionData.cookies.length > 0) {
                    await this.context.addCookies(sessionData.cookies);
                    CSReporter.debug(`Injected ${sessionData.cookies.length} cookies into browser context`);
                }

                // Step 2: Inject localStorage for each origin
                // localStorage is same-origin: we MUST navigate to each origin before we can
                // set its localStorage. Without this, MSAL tokens are not restored and
                // Dynamics 365 shows "Sign in required" popup on every page load.
                if (sessionData.origins && sessionData.origins.length > 0) {
                    const navTimeout = this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000);
                    for (const origin of sessionData.origins) {
                        if (origin.localStorage && origin.localStorage.length > 0) {
                            try {
                                // Check if we're already on this origin
                                const currentUrl = this.page.url();
                                const currentOrigin = currentUrl !== 'about:blank' ? new URL(currentUrl).origin : '';

                                if (origin.origin !== currentOrigin) {
                                    // Navigate to the origin so localStorage is accessible
                                    CSReporter.debug(`Navigating to ${origin.origin} to inject localStorage...`);
                                    await this.page.goto(origin.origin, {
                                        waitUntil: 'domcontentloaded',
                                        timeout: navTimeout
                                    });
                                }

                                // Now inject localStorage items
                                await this.page.evaluate((items: { name: string; value: string }[]) => {
                                    for (const item of items) {
                                        try { localStorage.setItem(item.name, item.value); } catch {}
                                    }
                                }, origin.localStorage);
                                CSReporter.debug(`Injected ${origin.localStorage.length} localStorage items for ${origin.origin}`);
                            } catch (e: any) {
                                CSReporter.debug(`localStorage injection for ${origin.origin}: ${e.message}`);
                            }
                        }
                    }
                }

                CSReporter.info(`Browser session loaded (non-destructive) from: ${resolvedPath}`);
            } else {
                // DESTRUCTIVE: Close context and recreate with loaded state
                // Safe in non-reuse mode where context lifecycle is per-scenario
                CSReporter.info(`Loading session from ${resolvedPath} — recreating context`);

                await this.closePage();
                await this.closeContext();

                const originalPath = this.config.get('AUTH_STORAGE_STATE_PATH');
                this.config.set('AUTH_STORAGE_STATE_PATH', resolvedPath);
                this.config.set('AUTH_STORAGE_STATE_REUSE', 'true');

                await this.createContext();
                await this.createPage();

                if (originalPath) {
                    this.config.set('AUTH_STORAGE_STATE_PATH', originalPath);
                }

                this.notifyPageChange();
                CSReporter.info(`Browser session loaded from: ${resolvedPath}`);
            }
        } else {
            CSReporter.info(`StorageState file registered: ${resolvedPath} (will be loaded on next context creation)`);
        }
    }

    private async restoreState(): Promise<void> {
        if (!this.page || !this.browserState.url) return;
        
        try {
            await this.page.goto(this.browserState.url);
            CSReporter.debug('Browser state restored');
        } catch (error) {
            CSReporter.warn(`Failed to restore browser state: ${error}`);
        }
    }

    public async restartBrowser(): Promise<void> {
        CSReporter.info('Restarting browser');
        
        const currentType = this.currentBrowserType;
        
        // Save state before restart
        if (this.config.getBoolean('BROWSER_RESTART_MAINTAIN_STATE', true)) {
            await this.saveState();
        }
        
        // Close current browser
        await this.close();
        
        // Increment restart count
        this.restartCount++;
        
        // Launch browser again
        await this.launch(currentType);
        
        // Restore state after restart
        if (this.config.getBoolean('BROWSER_RESTART_MAINTAIN_STATE', true) && this.browserState.url) {
            await this.restoreState();
        }
        
        CSReporter.info(`Browser restarted successfully (restart count: ${this.restartCount})`);
    }

    private async handleCrash(): Promise<void> {
        const maxRestarts = this.config.getNumber('BROWSER_MAX_RESTART_ATTEMPTS', 3);
        
        if (this.restartCount >= maxRestarts) {
            CSReporter.error(`Maximum restart attempts (${maxRestarts}) reached`);
            throw new Error('Browser crash recovery failed');
        }
        
        CSReporter.warn(`Browser crashed. Attempting auto-restart (${this.restartCount + 1}/${maxRestarts})`);
        await this.restartBrowser();
    }

    public async closePage(): Promise<void> {
        if (this.page) {
            try {
                await this.page.close();
            } catch (error) {
                CSReporter.debug('Page already closed or error closing page');
            } finally {
                this.page = null;
            }
        }
    }

    public async closeContext(testStatus?: 'passed' | 'failed', skipTraceSave: boolean = false): Promise<void> {
        // Save trace before closing context if browser reuse is enabled
        // Skip trace save when called from closeAll() as traces are already saved per-scenario
        if (this.context && this.traceStarted && !skipTraceSave) {
            await this.saveTraceIfNeeded(testStatus);
        }

        if (this.context) {
            try {
                // Increase timeout to allow HAR saving to complete (HAR can be large)
                // HAR is automatically saved by Playwright when context closes
                await Promise.race([
                    this.context.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Context close timeout')), 15000)  // Increased from 5000ms to 15000ms
                    )
                ]);
            } catch (error) {
                CSReporter.warn('Context close timeout or error (HAR may not be saved): ' + error);
                // Force close the context if it's still open
                try {
                    if (this.context) {
                        await this.context.close();
                    }
                } catch (secondError) {
                    CSReporter.debug('Force close also failed: ' + secondError);
                }
            } finally {
                this.context = null;
            }
        }
    }

    public async saveTraceIfNeeded(testStatus?: 'passed' | 'failed'): Promise<void> {
        if (!this.context || !this.traceStarted) return;

        const traceCaptureMode = this.config.get('TRACE_CAPTURE_MODE', 'never').toLowerCase();
        const resultsManager = CSTestResultsManager.getInstance();
        const dirs = resultsManager.getDirectories();
        const fs = require('fs');

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const tracePath = `${dirs.traces}/trace-${timestamp}.zip`;
            await this.context.tracing.stop({ path: tracePath });
            this.traceStarted = false;

            // Determine if we should keep the trace
            const actualStatus = testStatus || 'passed'; // Default to 'passed' if undefined
            const shouldDeleteTrace = this.shouldDeleteArtifact(traceCaptureMode, actualStatus);
            CSReporter.debug(`Trace decision: mode=${traceCaptureMode}, status=${actualStatus}, shouldDelete=${shouldDeleteTrace}`);

            if (shouldDeleteTrace) {
                try {
                    fs.unlinkSync(tracePath);
                    CSReporter.debug(`Trace deleted (capture mode: ${traceCaptureMode}, test ${testStatus}): ${tracePath}`);
                } catch (error) {
                    CSReporter.debug(`Failed to delete trace: ${error}`);
                }
            } else {
                CSReporter.info(`Trace saved (capture mode: ${traceCaptureMode}, test ${testStatus}): ${tracePath}`);
            }

            // Don't restart trace here - it should be restarted in restartTraceForNextScenario()
            // This prevents timing issues where trace might be restarted too early
        } catch (error) {
            CSReporter.debug(`Failed to save/restart trace: ${error}`);
        }
    }

    public async restartTraceForNextScenario(): Promise<void> {
        if (!this.context || !this.config.getBoolean('BROWSER_REUSE_ENABLED', false)) {
            return;
        }

        try {
            // Only restart trace if it's enabled
            const traceEnabled = this.config.getBoolean('BROWSER_TRACE_ENABLED', false) ||
                                this.config.get('TRACE_CAPTURE_MODE', 'never') !== 'never';

            if (traceEnabled) {
                await this.context.tracing.start({
                    screenshots: true,
                    snapshots: true,
                    sources: true
                });
                this.traceStarted = true;
                CSReporter.debug('Trace recording restarted for next scenario');
            }
        } catch (error) {
            CSReporter.debug(`Failed to restart trace: ${error}`);
        }
    }


    public async closeBrowser(): Promise<void> {
        if (this.browser) {
            try {
                // Use a timeout to prevent hanging on browser.close()
                await Promise.race([
                    this.browser.close(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Browser close timeout')), 5000)
                    )
                ]);
            } catch (error) {
                CSReporter.debug('Browser close timeout or error: ' + error);
                // Force kill if close fails
                try {
                    const process = (this.browser as any).process();
                    if (process) {
                        process.kill('SIGKILL');
                    }
                } catch (killError) {
                    CSReporter.debug('Failed to force kill browser process');
                }
            } finally {
                this.browser = null;
            }
        }
    }

    private shouldDeleteArtifact(captureMode: string, testStatus?: 'passed' | 'failed'): boolean {
        // Determine if artifact should be deleted based on capture mode and test status
        switch(captureMode) {
            case 'always':
                return false; // Never delete - always keep artifacts
            case 'on-failure-only':
            case 'on-failure':
            case 'retain-on-failure':
                // Only keep if test failed (delete if passed or unknown)
                return testStatus === 'passed';
            case 'on-pass-only':
            case 'on-pass':
                // Only keep if test passed (delete if failed or unknown)
                return testStatus === 'failed';
            case 'never':
            case 'off':
                return true; // Always delete (shouldn't happen as we don't record)
            default:
                // Default to keeping artifacts if mode is unknown
                return false;
        }
    }

    public async close(testStatus?: 'passed' | 'failed'): Promise<void> {
        const resultsManager = CSTestResultsManager.getInstance();
        const dirs = resultsManager.getDirectories();
        const fs = require('fs');

        let videoPath: string | null = null;
        let tracePath: string | null = null;

        // Track artifacts for this session
        this.sessionArtifacts = {
            videos: [],
            traces: [],
            har: [],
            screenshots: []
        };

        // Handle trace recording
        const traceCaptureMode = this.config.get('TRACE_CAPTURE_MODE', 'never').toLowerCase();
        if (this.context && (this.traceStarted || this.config.getBoolean('BROWSER_TRACE_ENABLED', false))) {
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                tracePath = `${dirs.traces}/trace-${timestamp}.zip`;
                await this.context.tracing.stop({ path: tracePath });
                this.traceStarted = false;

                // Determine if we should keep the trace
                const shouldDeleteTrace = this.shouldDeleteArtifact(traceCaptureMode, testStatus);
                CSReporter.debug(`Trace decision: mode=${traceCaptureMode}, status=${testStatus}, shouldDelete=${shouldDeleteTrace}`);

                if (shouldDeleteTrace) {
                    try {
                        fs.unlinkSync(tracePath);
                        CSReporter.debug(`Trace deleted (capture mode: ${traceCaptureMode}, test ${testStatus}): ${tracePath}`);
                        tracePath = null;
                    } catch (error) {
                        CSReporter.debug(`Failed to delete trace: ${error}`);
                    }
                } else {
                    CSReporter.info(`Trace saved (capture mode: ${traceCaptureMode}, test ${testStatus}): ${tracePath}`);
                    this.sessionArtifacts.traces.push(tracePath);
                }
            } catch (error) {
                CSReporter.debug('Failed to save trace');
            }
        }

        // Handle video recording
        const videoCaptureMode = this.config.get('BROWSER_VIDEO', 'off').toLowerCase();
        if (videoCaptureMode !== 'never' && videoCaptureMode !== 'off' && this.page) {
            try {
                const video = this.page.video();
                if (video) {
                    videoPath = await video.path();
                    if (videoPath) {
                        const shouldDeleteVideo = this.shouldDeleteArtifact(videoCaptureMode, testStatus);
                        CSReporter.debug(`Video decision: mode=${videoCaptureMode}, status=${testStatus}, shouldDelete=${shouldDeleteVideo}, path=${videoPath}`);

                        if (shouldDeleteVideo) {
                            // Mark for deletion after context closes
                            this.videosToDelete.push(videoPath);
                            CSReporter.debug(`Video will be deleted (capture mode: ${videoCaptureMode}, test ${testStatus}): ${videoPath}`);
                        } else {
                            CSReporter.info(`Video saved (capture mode: ${videoCaptureMode}, test ${testStatus}): ${videoPath}`);
                            this.sessionArtifacts.videos.push(videoPath);
                        }
                    } else {
                        CSReporter.debug('Video path is null - video may not have been saved yet');
                    }
                } else {
                    CSReporter.debug('No video object available on page');
                }
            } catch (error: any) {
                CSReporter.debug(`Could not get video path: ${error.message}`);
            }
        } else {
            CSReporter.debug(`Video capture skipped - mode: ${videoCaptureMode}, has page: ${!!this.page}`);
        }

        // Handle HAR file
        const harCaptureMode = this.config.get('HAR_CAPTURE_MODE', 'never').toLowerCase();
        const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

        if (harCaptureMode !== 'never' && this.currentHarPath) {
            // With browser reuse, HAR accumulates across all scenarios
            // Don't mark for deletion until the context actually closes
            if (browserReuseEnabled) {
                CSReporter.debug(`HAR accumulating (browser reuse enabled): ${this.currentHarPath}`);
            } else {
                const shouldDeleteHar = this.shouldDeleteArtifact(harCaptureMode, testStatus);
                CSReporter.debug(`HAR decision: mode=${harCaptureMode}, status=${testStatus}, shouldDelete=${shouldDeleteHar}`);

                if (shouldDeleteHar) {
                    // Mark for deletion after context closes
                    this.harsToDelete.push(this.currentHarPath);
                    CSReporter.debug(`HAR will be deleted (capture mode: ${harCaptureMode}, test ${testStatus}): ${this.currentHarPath}`);
                } else {
                    CSReporter.info(`HAR saved (capture mode: ${harCaptureMode}, test ${testStatus}): ${this.currentHarPath}`);
                    this.sessionArtifacts.har.push(this.currentHarPath);
                }
            }
        }

        // Close page first
        await this.closePage();

        // Close context - this triggers video/HAR save automatically
        await this.closeContext();

        // Wait for video files to be released by Playwright
        // Playwright needs time to finalize video encoding after context closes
        if (this.videosToDelete.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Clean up artifacts that were marked for deletion after context is closed
        // Delete videos marked for deletion with retry logic
        for (const videoToDelete of this.videosToDelete) {
            let retries = 3;
            while (retries > 0) {
                try {
                    if (fs.existsSync(videoToDelete)) {
                        fs.unlinkSync(videoToDelete);
                        CSReporter.debug(`Video deleted: ${videoToDelete}`);
                        break;
                    }
                } catch (error: any) {
                    retries--;
                    if (retries > 0 && error.code === 'EBUSY') {
                        // File is still locked, wait a bit and retry
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        CSReporter.debug(`Failed to delete video: ${error}`);
                        break;
                    }
                }
            }
        }
        this.videosToDelete = [];

        // Delete HARs marked for deletion
        for (const harToDelete of this.harsToDelete) {
            try {
                if (fs.existsSync(harToDelete)) {
                    fs.unlinkSync(harToDelete);
                    CSReporter.debug(`HAR deleted: ${harToDelete}`);
                }
            } catch (error) {
                CSReporter.debug(`Failed to delete HAR: ${error}`);
            }
        }
        this.harsToDelete = [];

        // browserReuseEnabled already declared above, just reuse it
        if (!browserReuseEnabled) {
            // Reset HAR path and close browser when not reusing
            this.currentHarPath = null;
            await this.closeBrowser();
        }
        // Keep currentHarPath for browser reuse - HAR accumulates until context closes
    }

    public async closeAll(finalStatus?: 'passed' | 'failed'): Promise<void> {
        const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

        // Remember video capture mode and final status for later cleanup
        const videoCaptureMode = this.config.get('BROWSER_VIDEO', 'off').toLowerCase();

        const shouldDeleteVideo = browserReuseEnabled &&
                                  videoCaptureMode !== 'never' &&
                                  videoCaptureMode !== 'off' &&
                                  this.shouldDeleteArtifact(videoCaptureMode, finalStatus);

        CSReporter.debug(`closeAll: finalStatus=${finalStatus}, captureMode=${videoCaptureMode}, shouldDelete=${shouldDeleteVideo}`);

        // Get video path BEFORE closing the context (important for parallel execution)
        // Each worker should only manage its own video file
        let workerVideoPath: string | null = null;
        if (this.page && videoCaptureMode !== 'never' && videoCaptureMode !== 'off') {
            try {
                const video = this.page.video();
                if (video) {
                    workerVideoPath = await video.path();
                    CSReporter.debug(`Worker video path: ${workerVideoPath}`);
                }
            } catch (e: any) {
                CSReporter.debug(`Could not get video path before close: ${e.message}`);
            }
        }

        // Handle HAR file for browser reuse scenario
        // When browser reuse is enabled, HAR accumulates across all scenarios
        if (this.currentHarPath && browserReuseEnabled) {
            const harCaptureMode = this.config.get('HAR_CAPTURE_MODE', 'never').toLowerCase();

            // Determine final HAR status based on capture mode
            // For 'on-failure' mode, keep HAR if ANY test failed
            // For 'always' mode, always keep HAR
            const shouldKeepHar = harCaptureMode === 'always' ||
                                 (harCaptureMode === 'on-failure' && finalStatus === 'failed');

            if (shouldKeepHar) {
                CSReporter.info(`HAR will be saved: ${this.currentHarPath}`);
            } else {
                // Mark for deletion based on capture mode and test status
                this.harsToDelete.push(this.currentHarPath);
                const reason = harCaptureMode === 'never' ? 'capture mode is never' :
                              `tests ${finalStatus || 'passed'} with on-failure mode`;
                CSReporter.debug(`HAR marked for deletion (${reason}): ${this.currentHarPath}`);
            }
        }

        await this.closePage();
        // Skip trace save in closeContext as traces are already saved per-scenario
        await this.closeContext(undefined, true);

        // Wait for video/HAR files to be fully written by Playwright
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Delete ONLY this worker's video if needed (for browser reuse scenario)
        // Important: Only delete the specific video for this worker, not all videos in directory
        const fs = require('fs');
        if (shouldDeleteVideo && workerVideoPath) {
            let retries = 3;
            while (retries > 0) {
                try {
                    if (fs.existsSync(workerVideoPath)) {
                        fs.unlinkSync(workerVideoPath);
                        CSReporter.debug(`Video deleted (tests ${finalStatus}, capture mode: ${videoCaptureMode}): ${workerVideoPath}`);
                    }
                    break;
                } catch (error: any) {
                    retries--;
                    if (retries > 0 && error.code === 'EBUSY') {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        CSReporter.debug(`Failed to delete video ${workerVideoPath}: ${error.message}`);
                        break;
                    }
                }
            }
        } else if (workerVideoPath && !shouldDeleteVideo) {
            CSReporter.info(`Video retained (tests ${finalStatus}, capture mode: ${videoCaptureMode}): ${workerVideoPath}`);
        }

        // Delete videos that were marked for deletion from close() method (non-browser-reuse scenarios)
        for (const videoToDelete of this.videosToDelete) {
            let retries = 3;
            while (retries > 0) {
                try {
                    if (fs.existsSync(videoToDelete)) {
                        fs.unlinkSync(videoToDelete);
                        CSReporter.debug(`Video deleted: ${videoToDelete}`);
                        break;
                    }
                } catch (error: any) {
                    retries--;
                    if (retries > 0 && error.code === 'EBUSY') {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        CSReporter.debug(`Failed to delete video: ${error}`);
                        break;
                    }
                }
            }
        }
        this.videosToDelete = [];

        // Delete HARs marked for deletion AFTER context is closed
        for (const harToDelete of this.harsToDelete) {
            try {
                if (fs.existsSync(harToDelete)) {
                    fs.unlinkSync(harToDelete);
                    CSReporter.debug(`HAR deleted: ${harToDelete}`);
                }
            } catch (error) {
                CSReporter.debug(`Failed to delete HAR: ${error}`);
            }
        }
        this.harsToDelete = [];

        await this.closeBrowser();

        // Close all pooled browsers
        for (const [type, browser] of this.browserPool) {
            await browser.close();
        }
        this.browserPool.clear();
    }

    public getPage(): any {
        if (!this.page) {
            throw new Error('Page not initialized');
        }
        return this.page;
    }

    // =========================================================================
    // MULTI-TAB/WINDOW MANAGEMENT METHODS
    // =========================================================================

    /**
     * Get all pages/tabs in the current browser context
     * @returns Array of all Page objects
     */
    public getPages(): any[] {
        if (!this.context) {
            return [];
        }
        return this.context.pages();
    }

    /**
     * Get the number of open pages/tabs
     * @returns Number of open pages
     */
    public getPageCount(): number {
        return this.getPages().length;
    }

    /**
     * Set the current page reference and notify all listeners
     * This is the KEY method for multi-tab support - it updates which page is "active"
     * @param page - The Page object to set as current
     */
    public setCurrentPage(page: any): void {
        if (!page) {
            throw new Error('Cannot set null page as current');
        }
        this.page = page;
        this.notifyPageChange();
        try {
            CSReporter.info(`[BrowserManager] Switched to page: ${page.url()}`);
        } catch (e) {
            CSReporter.info('[BrowserManager] Switched to new page');
        }
    }

    /**
     * Switch to a specific page/tab by index
     * @param index - Page index (0 = first/main page)
     */
    public async switchToPage(index: number): Promise<void> {
        const pages = this.getPages();

        if (pages.length === 0) {
            throw new Error('No pages available in context');
        }

        if (index < 0 || index >= pages.length) {
            throw new Error(`Invalid page index: ${index}. Available pages: 0-${pages.length - 1}`);
        }

        const targetPage = pages[index];
        await targetPage.bringToFront();
        this.setCurrentPage(targetPage);
    }

    /**
     * Switch to the most recently opened page/tab (last in the list)
     */
    public async switchToLatestPage(): Promise<void> {
        const pages = this.getPages();
        if (pages.length <= 1) {
            CSReporter.warn('[BrowserManager] No additional pages to switch to');
            return;
        }
        await this.switchToPage(pages.length - 1);
    }

    /**
     * Switch back to the main/first page/tab
     */
    public async switchToMainPage(): Promise<void> {
        await this.switchToPage(0);
    }

    /**
     * Get the current page index among all open pages
     * @returns Index of current page, or -1 if not found
     */
    public getCurrentPageIndex(): number {
        const pages = this.getPages();
        return pages.findIndex(p => p === this.page);
    }

    /**
     * Register a listener to be notified when page changes (e.g., after browser switch)
     * Useful for page objects that need to update their page reference
     * @param listener - Callback function that receives the new page
     */
    public onPageChange(listener: (newPage: any) => void): void {
        this.pageChangeListeners.push(listener);
    }

    /**
     * Remove a page change listener
     */
    public offPageChange(listener: (newPage: any) => void): void {
        const index = this.pageChangeListeners.indexOf(listener);
        if (index > -1) {
            this.pageChangeListeners.splice(index, 1);
        }
    }

    /**
     * Notify all listeners that the page has changed
     */
    private notifyPageChange(): void {
        if (this.page && this.pageChangeListeners.length > 0) {
            CSReporter.debug(`[BrowserManager] Notifying ${this.pageChangeListeners.length} listener(s) of page change`);
            for (const listener of this.pageChangeListeners) {
                try {
                    listener(this.page);
                } catch (error: any) {
                    CSReporter.warn(`[BrowserManager] Page change listener error: ${error.message}`);
                }
            }
        }
    }

    public clearBrowserState(): void {
        this.browserState = {};
        CSReporter.debug('Browser state cleared - cookies will not be restored');
    }

    /**
     * Clear browser state WITHOUT recreating context
     * Used for browser reuse mode to maintain artifacts (video/HAR/trace)
     * Mirrors the between-scenarios cleanup behavior
     *
     * @param previousUrl - Optional URL to navigate to after clearing
     * @param preserveUrl - Whether to navigate to previousUrl (default: true)
     */
    private async clearStateWithoutRecreatingContext(
        previousUrl?: string | null,
        preserveUrl: boolean = true
    ): Promise<void> {
        if (!this.page || !this.context) {
            throw new Error('No page or context available for state clearing');
        }

        CSReporter.debug('Clearing state without recreating context...');

        // Step 1: Navigate to about:blank to leave current app
        try {
            await this.page.goto('about:blank', {
                waitUntil: 'domcontentloaded',
                timeout: 5000
            });
            CSReporter.debug('Navigated to about:blank');
        } catch (error: any) {
            CSReporter.warn(`Failed to navigate to about:blank: ${error.message}`);
        }

        // Step 2: Clear cookies at context level (no context recreation!)
        try {
            await this.context.clearCookies();
            CSReporter.debug('Cookies cleared');
        } catch (error: any) {
            CSReporter.warn(`Failed to clear cookies: ${error.message}`);
        }

        // Step 3: Clear permissions
        try {
            await this.context.clearPermissions();
            CSReporter.debug('Permissions cleared');
        } catch (error: any) {
            CSReporter.warn(`Failed to clear permissions: ${error.message}`);
        }

        // Step 4: Clear localStorage and sessionStorage
        try {
            await this.page.evaluate(() => {
                try {
                    localStorage.clear();
                    sessionStorage.clear();
                } catch (e) {
                    // Ignore errors on about:blank
                }
            });
            CSReporter.debug('localStorage and sessionStorage cleared');
        } catch (error: any) {
            CSReporter.warn(`Failed to clear storage: ${error.message}`);
        }

        // Step 5: Clear saved browser state
        this.clearBrowserState();

        // Step 6: Navigate to previous URL if requested
        if (preserveUrl && previousUrl && previousUrl !== 'about:blank') {
            try {
                CSReporter.debug(`Navigating to previous URL: ${previousUrl}`);
                await this.page.goto(previousUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
                });
                CSReporter.debug(`Successfully navigated to: ${previousUrl}`);
            } catch (error: any) {
                CSReporter.warn(`Failed to navigate to previous URL: ${error.message}`);
            }
        }

        CSReporter.debug('✓ State cleared without recreating context');
    }

    public getContext(): any {
        if (!this.context) {
            throw new Error('Context not initialized');
        }
        return this.context;
    }

    public getBrowser(): any {
        if (!this.browser) {
            throw new Error('Browser not initialized');
        }
        return this.browser;
    }

    public getCurrentBrowserType(): string {
        return this.currentBrowserType;
    }

    public getRestartCount(): number {
        return this.restartCount;
    }

    /**
     * Wait for loading spinners to disappear
     * Uses SPINNER_SELECTORS configuration to identify loading indicators
     */
    public async waitForSpinnersToDisappear(timeout: number = 30000): Promise<void> {
        const spinnerSelectors = this.config.get('SPINNER_SELECTORS', '.spinner;.loader;.loading;.progress');
        const selectors = spinnerSelectors.split(';').filter(s => s.trim());

        if (selectors.length === 0 || !this.page) {
            return;
        }

        CSReporter.debug(`Waiting for spinners to disappear: ${selectors.join(', ')}`);

        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector.trim(), {
                    state: 'hidden',
                    timeout: timeout
                });
                CSReporter.debug(`Spinner hidden: ${selector}`);
            } catch (error) {
                // Spinner might not exist on the page, which is fine
                CSReporter.debug(`Spinner selector not found or already hidden: ${selector}`);
            }
        }
    }

    /**
     * Navigate to URL and wait for spinners to disappear
     */
    public async navigateAndWaitReady(url: string, options?: any): Promise<void> {
        if (!this.page) {
            throw new Error('Page not initialized');
        }

        // Navigate to the URL
        await this.page.goto(url, options);

        // Wait for spinners to disappear if configured
        if (this.config.getBoolean('WAIT_FOR_SPINNERS', true)) {
            await this.waitForSpinnersToDisappear();
        }
    }

    /**
     * Get session artifacts (screenshots, videos, etc.)
     */
    public async getSessionArtifacts(): Promise<{ screenshots: string[], videos: string[], traces: string[], har: string[] }> {
        // Return the artifacts collected during this session
        // This includes files that were saved during close() operations
        const artifacts = {
            screenshots: [...this.sessionArtifacts.screenshots],
            videos: [...this.sessionArtifacts.videos],
            traces: [...this.sessionArtifacts.traces],
            har: [...this.sessionArtifacts.har]
        };

        // Also try to get current video path if still recording
        try {
            if (this.page && this.context) {
                const video = this.page.video();
                if (video) {
                    try {
                        const videoPath = await video.path();
                        if (videoPath && !artifacts.videos.includes(videoPath)) {
                            artifacts.videos.push(videoPath);
                        }
                    } catch (e) {
                        // Video might not be ready yet
                    }
                }
            }
        } catch (error: any) {
            CSReporter.debug(`Error getting current video path: ${error.message}`);
        }

        return artifacts;
    }

    /**
     * Switch to a different browser during test execution
     * Supports switching between chrome, edge, firefox, webkit, safari
     * Works with browser reuse: new browser type becomes the reused instance
     * Thread-safe: each parallel worker switches independently
     *
     * @param browserType - Target browser: 'chrome' | 'edge' | 'firefox' | 'webkit' | 'safari'
     * @param options - Optional configuration
     *   - preserveUrl: Navigate to current URL after switch (default: true)
     *   - clearState: Clear cookies/storage after switch (default: false)
     *
     * @example
     * // In step definition:
     * await browserManager.switchBrowser('edge');
     * await browserManager.switchBrowser('chrome', { clearState: true });
     */
    public async switchBrowser(
        browserType: string,
        options?: {
            preserveUrl?: boolean;
            clearState?: boolean;
        }
    ): Promise<void> {
        const { preserveUrl = true, clearState = false } = options || {};

        CSReporter.info(`Switching browser from ${this.currentBrowserType} to ${browserType}`);

        // Validate browser type
        const validBrowsers = ['chrome', 'chromium', 'edge', 'firefox', 'webkit', 'safari'];
        if (!validBrowsers.includes(browserType.toLowerCase())) {
            throw new Error(`Invalid browser type: ${browserType}. Valid options: ${validBrowsers.join(', ')}`);
        }

        // Save current state if needed
        const currentUrl = preserveUrl && this.page ? await this.page.url() : null;
        const shouldSaveState = !clearState && this.currentBrowserType !== browserType;

        if (shouldSaveState) {
            await this.saveState();
        }

        // If switching to same browser type
        if (this.currentBrowserType === browserType) {
            // If not clearing state, no action needed
            if (!clearState) {
                CSReporter.info(`Already using ${browserType}, no switch needed`);
                return;
            }

            // Clear state - behavior depends on BROWSER_REUSE_ENABLED
            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

            if (browserReuseEnabled) {
                // REUSE MODE: Clear state WITHOUT recreating context (like between-scenarios)
                CSReporter.info(`Switching to same browser (${browserType}) - clearing state (reuse mode)`);
                await this.clearStateWithoutRecreatingContext(currentUrl, preserveUrl);
            } else {
                // NON-REUSE MODE: Full restart (close and recreate)
                CSReporter.info(`Switching to same browser (${browserType}) - full restart (non-reuse mode)`);

                // Close current context and page (saves artifacts)
                if (this.page) {
                    await this.closePage();
                }

                if (this.context) {
                    await this.closeContext('passed');
                }

                // Close and relaunch browser for full restart
                if (this.browser) {
                    await this.closeBrowser();
                }

                await this.launch(browserType);

                // Navigate to previous URL if requested
                if (preserveUrl && currentUrl && this.page) {
                    try {
                        CSReporter.debug(`Navigating to previous URL: ${currentUrl}`);
                        await this.page.goto(currentUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
                        });
                    } catch (error: any) {
                        CSReporter.warn(`Failed to navigate to previous URL: ${error.message}`);
                    }
                }
            }

            // Notify listeners that page has changed
            this.notifyPageChange();

            CSReporter.info(`Successfully switched to ${browserType} browser (same type)`);
            return;
        }

        // Get current test status for artifact handling
        // Default to 'passed' for mid-test switches
        const testStatus: 'passed' | 'failed' = 'passed';

        // Close current context and page (saves artifacts)
        if (this.page) {
            await this.closePage();
        }

        if (this.context) {
            await this.closeContext(testStatus);
        }

        // If switching to different browser type, close current browser
        if (this.currentBrowserType !== browserType) {
            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

            if (this.browser) {
                await this.closeBrowser();
            }

            // Remove old browser from pool if reuse is enabled
            if (browserReuseEnabled && this.browserPool.has(this.currentBrowserType)) {
                this.browserPool.delete(this.currentBrowserType);
            }
        }

        // Launch new browser (or reuse if same type)
        await this.launch(browserType);

        // Navigate to previous URL if requested
        if (preserveUrl && currentUrl && this.page) {
            try {
                CSReporter.debug(`Navigating to previous URL: ${currentUrl}`);
                await this.page.goto(currentUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
                });
            } catch (error: any) {
                CSReporter.warn(`Failed to navigate to previous URL after browser switch: ${error.message}`);
            }
        }

        // Restore state if not clearing and switching browser types
        if (shouldSaveState && !clearState && this.browserState.url && this.page) {
            await this.restoreState();
        }

        // Notify listeners that page has changed (e.g., page objects need to update references)
        this.notifyPageChange();

        CSReporter.info(`Successfully switched to ${browserType} browser`);
    }

    /**
     * Clear browser context and prepare for re-authentication
     * Useful for scenarios requiring different user credentials (e.g., approver flow)
     * Clears: cookies, localStorage, sessionStorage, cache
     * Keeps: browser instance (for performance)
     * Works with browser reuse: context is refreshed but browser stays alive
     * Thread-safe: each parallel worker has independent context
     *
     * @param options - Optional configuration
     *   - loginUrl: URL to navigate to after clearing (default: BASE_URL from config)
     *   - skipNavigation: Don't navigate after clearing, just clear context (default: false)
     *   - waitForNavigation: Wait for navigation to complete (default: true)
     *
     * @example
     * // Scenario: Login as different user (navigates to BASE_URL)
     * await browserManager.clearContextAndReauthenticate();
     * // Now perform new login steps
     *
     * @example
     * // Clear and go to specific login page
     * await browserManager.clearContextAndReauthenticate({
     *   loginUrl: 'https://app.example.com/admin/login'
     * });
     *
     * @example
     * // Clear context only, no navigation (you'll navigate manually)
     * await browserManager.clearContextAndReauthenticate({
     *   skipNavigation: true
     * });
     */
    public async clearContextAndReauthenticate(options?: {
        loginUrl?: string;
        skipNavigation?: boolean;
        waitForNavigation?: boolean;
    }): Promise<void> {
        const {
            loginUrl,
            skipNavigation = false,
            waitForNavigation = true
        } = options || {};

        if (!this.browser) {
            throw new Error('No browser instance available. Call launch() first.');
        }

        CSReporter.info('Clearing browser context for re-authentication');

        // Check browser reuse setting
        const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

        if (browserReuseEnabled) {
            // REUSE MODE: Clear state WITHOUT recreating context (like between-scenarios cleanup)
            CSReporter.info('Browser reuse enabled - clearing state without recreating context');

            if (!this.page || !this.context) {
                throw new Error('No page or context available');
            }

            // Navigate to about:blank to leave current app
            CSReporter.debug('Navigating to about:blank...');
            await this.page.goto('about:blank', {
                waitUntil: 'domcontentloaded',
                timeout: 5000
            });

            // Clear cookies at context level (no context recreation!)
            CSReporter.debug('Clearing cookies...');
            await this.context.clearCookies();

            // Clear permissions
            CSReporter.debug('Clearing permissions...');
            await this.context.clearPermissions();

            // Clear localStorage and sessionStorage
            CSReporter.debug('Clearing localStorage and sessionStorage...');
            await this.page.evaluate(() => {
                try {
                    localStorage.clear();
                    sessionStorage.clear();
                } catch (e) {
                    // Ignore errors on about:blank
                }
            });

            // Clear saved browser state
            this.clearBrowserState();

            CSReporter.info('✓ Browser state cleared (context preserved)');

        } else {
            // NON-REUSE MODE: Recreate context for full clean state
            CSReporter.info('Browser reuse disabled - recreating context');

            // Close current page
            if (this.page) {
                await this.closePage();
            }

            // Close current context (saves artifacts)
            if (this.context) {
                await this.closeContext('passed');
            }

            // Create fresh context
            await this.createContext();

            // Create fresh page
            await this.createPage();

            // Notify listeners that page has changed (new page created)
            this.notifyPageChange();

            CSReporter.info('✓ Fresh context created');
        }

        // Navigate to login URL unless skipNavigation is true
        if (!skipNavigation && this.page) {
            const targetUrl = loginUrl || this.config.get('BASE_URL');

            if (!targetUrl) {
                CSReporter.warn('No login URL provided and BASE_URL not configured. Skipping navigation.');
                CSReporter.info('Context cleared successfully. Ready for re-authentication (no navigation).');
                return;
            }

            try {
                CSReporter.debug(`Navigating to login page: ${targetUrl}`);
                const navigationOptions: any = {
                    timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
                };

                if (waitForNavigation) {
                    navigationOptions.waitUntil = 'domcontentloaded';
                }

                await this.page.goto(targetUrl, navigationOptions);
                CSReporter.info(`Successfully navigated to login page: ${targetUrl}`);
            } catch (error: any) {
                CSReporter.warn(`Failed to navigate to login page: ${error.message}`);
                throw error;
            }
        } else {
            CSReporter.info('Context cleared successfully. Ready for re-authentication (navigation skipped).');
        }
    }
}