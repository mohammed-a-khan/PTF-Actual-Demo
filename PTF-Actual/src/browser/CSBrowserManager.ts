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

        // For main thread, use singleton
        if (!CSBrowserManager.instance) {
            CSBrowserManager.instance = new CSBrowserManager();
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

    private async launchBrowser(browserType: string): Promise<any> {
        const isHeadless = this.config.getBoolean('HEADLESS', false);
        
        const browserOptions: any = {
            headless: isHeadless,
            timeout: this.config.getNumber('BROWSER_LAUNCH_TIMEOUT', 30000),
            slowMo: this.config.getNumber('BROWSER_SLOWMO', 0),
            devtools: this.config.getBoolean('BROWSER_DEVTOOLS', false),
            args: isHeadless ? [] : [
                '--start-maximized',
                '--no-default-browser-check',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--force-device-scale-factor=1'
            ]
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

        // Add custom args
        const customArgs = this.config.getList('BROWSER_CHROME_ARGS');
        args.push(...customArgs);

        return args;
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

        // Restore state if switching browsers (but only if not explicitly cleared)
        if (this.browserState.cookies && !this.config.getBoolean('BROWSER_REUSE_CLEAR_STATE', false)) {
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
        // Video files are only created after context closes, so we can't get the path yet
        const videoCaptureMode = this.config.get('BROWSER_VIDEO', 'off').toLowerCase();

        const shouldDeleteVideosAfterClose = browserReuseEnabled &&
                                            videoCaptureMode !== 'never' &&
                                            videoCaptureMode !== 'off' &&
                                            this.shouldDeleteArtifact(videoCaptureMode, finalStatus);

        if (shouldDeleteVideosAfterClose) {
            CSReporter.debug(`Videos will be deleted after context closes (browser reuse, capture mode: ${videoCaptureMode}, tests ${finalStatus})`);
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

        // Delete videos if needed (for browser reuse scenario)
        const fs = require('fs');
        const path = require('path');
        if (shouldDeleteVideosAfterClose) {
            try {
                // Get results manager singleton (may be different in worker context)
                const resultsManager = CSTestResultsManager.getInstance();
                const dirs = resultsManager.getDirectories();
                const videoDir = dirs.videos;

                if (fs.existsSync(videoDir)) {
                    const videoFiles = fs.readdirSync(videoDir).filter((file: string) =>
                        file.endsWith('.webm') || file.endsWith('.mp4')
                    );

                    for (const videoFile of videoFiles) {
                        const videoPath = path.join(videoDir, videoFile);
                        let retries = 3;
                        while (retries > 0) {
                            try {
                                fs.unlinkSync(videoPath);
                                CSReporter.debug(`Video deleted (browser reuse, all tests passed): ${videoFile}`);
                                break;
                            } catch (error: any) {
                                retries--;
                                if (retries > 0 && error.code === 'EBUSY') {
                                    await new Promise(resolve => setTimeout(resolve, 500));
                                } else {
                                    CSReporter.debug(`Failed to delete video ${videoFile}: ${error.message}`);
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (error: any) {
                CSReporter.debug(`Error cleaning up videos: ${error.message}`);
            }
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