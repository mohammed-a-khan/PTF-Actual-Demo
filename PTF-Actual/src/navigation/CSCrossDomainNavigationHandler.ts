/**
 * Cross-Domain Navigation Handler
 * Handles authentication redirects and maintains page context during cross-domain navigation
 * Supports Netscaler, Citrix, SSO providers (Okta, ADFS), and other authentication systems
 */

// Lazy load Playwright for performance
// import { Page, Frame } from '@playwright/test';
type Page = any;
type Frame = any;

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export interface NavigationState {
    originalDomain: string;
    currentDomain: string;
    isNavigating: boolean;
    isAuthenticated: boolean;
    redirectCount: number;
}

export class CSCrossDomainNavigationHandler {
    private page: any; // Page from Playwright
    private config: CSConfigurationManager;
    private originalDomain: string = '';
    private targetDomain: string = '';
    private isNavigating: boolean = false;
    private navigationPromise: Promise<void> | null = null;
    private authProviders: string[] = [];
    private maxRedirectCount: number = 5;
    private navigationTimeout: number = 60000;
    private redirectCount: number = 0;

    private handlersSetup: boolean = false;

    constructor(page: Page) {
        this.page = page;
        this.config = CSConfigurationManager.getInstance();
        this.loadConfiguration();
        // Don't setup handlers immediately - wait to see if we actually need them
        // this.setupNavigationHandlers();
    }

    /**
     * Load configuration for cross-domain navigation
     */
    private loadConfiguration(): void {
        // Load auth providers from config
        const configuredProviders = this.config.get('CROSS_DOMAIN_AUTH_PROVIDERS', '');
        const defaultProviders = [
            'netscaler',
            'citrix',
            'auth',
            'login',
            'logon',
            'signin',
            'sso',
            'adfs',
            'okta',
            'ping',
            'azure',
            'keycloak',
            'onelogin',
            'saml',
            'oauth'
        ];

        // Combine default and configured providers
        if (configuredProviders) {
            const customProviders = configuredProviders.split(',').map(p => p.trim().toLowerCase());
            this.authProviders = [...new Set([...defaultProviders, ...customProviders])];
        } else {
            this.authProviders = defaultProviders;
        }

        // Load navigation timeout
        this.navigationTimeout = this.config.getNumber('CROSS_DOMAIN_NAVIGATION_TIMEOUT', 60000);

        // Load max redirect count
        this.maxRedirectCount = this.config.getNumber('CROSS_DOMAIN_MAX_REDIRECTS', 5);

        CSReporter.debug(`Cross-domain navigation configured with ${this.authProviders.length} auth providers`);
    }

    /**
     * Setup event handlers for navigation tracking (lazy - only when needed)
     */
    private setupNavigationHandlers(): void {
        if (this.handlersSetup) {
            return; // Already setup
        }

        this.handlersSetup = true;
        CSReporter.debug('Setting up cross-domain navigation handlers');
        // Track frame navigation events
        this.page.on('framenavigated', async (frame: Frame) => {
            if (frame === this.page.mainFrame()) {
                await this.handleFrameNavigation(frame);
            }
        });

        // Track page load events
        this.page.on('load', async () => {
            await this.handlePageLoad();
        });

        // Track response events for redirect detection
        this.page.on('response', async (response: any) => {
            if (response.status() >= 300 && response.status() < 400) {
                const currentUrl = response.url();
                const location = response.headers()['location'];

                // Only track actual cross-domain redirects (different domains)
                if (location) {
                    const currentDomain = this.extractDomain(currentUrl);
                    const redirectDomain = this.extractDomain(location);

                    // Only log if it's ACTUALLY a different domain
                    if (currentDomain && redirectDomain && currentDomain !== redirectDomain) {
                        this.redirectCount++;
                        CSReporter.debug(`Cross-domain redirect: ${currentDomain} -> ${redirectDomain}`);

                        if (this.redirectCount > this.maxRedirectCount) {
                            CSReporter.warn(`Max cross-domain redirect count (${this.maxRedirectCount}) exceeded`);
                            // Reset counter to prevent spam
                            this.redirectCount = 0;
                        }
                    }
                    // Don't log same-domain redirects - they're completely normal!
                }
            }
        });
    }

    /**
     * Handle frame navigation events
     */
    private async handleFrameNavigation(frame: Frame): Promise<void> {
        const currentUrl = frame.url();
        const currentDomain = this.extractDomain(currentUrl);

        // Skip if URL is blank or about:blank
        if (!currentUrl || currentUrl === 'about:blank') {
            return;
        }

        // Lazy setup handlers if we detect potential cross-domain navigation
        if (!this.handlersSetup && this.originalDomain && currentDomain !== this.originalDomain) {
            this.setupNavigationHandlers();
        }

        // Check if we've returned to original domain after authentication
        if (this.originalDomain &&
            currentDomain === this.originalDomain &&
            this.isNavigating) {
            CSReporter.info(`Returned to original domain: ${this.originalDomain}`);
            this.isNavigating = false;
            this.redirectCount = 0;
        }

        // Check if we've navigated to authentication page
        if (this.originalDomain &&
            currentDomain !== this.originalDomain &&
            !this.isNavigating) {

            if (this.isAuthenticationPage(currentUrl)) {
                CSReporter.info(`Authentication redirect detected: ${this.originalDomain} -> ${currentDomain}`);
                this.isNavigating = true;

                // Start waiting for return to original domain
                this.navigationPromise = this.waitForDomainReturn();
            } else {
                CSReporter.debug(`Cross-domain navigation detected: ${this.originalDomain} -> ${currentDomain}`);
                // This might be a legitimate cross-domain navigation, not authentication
                // Update the original domain if configured to do so
                if (this.config.getBoolean('CROSS_DOMAIN_UPDATE_ON_NAVIGATE', false)) {
                    this.originalDomain = currentDomain;
                    CSReporter.debug(`Updated original domain to: ${this.originalDomain}`);
                }
            }
        }
    }

    /**
     * Handle page load events
     */
    private async handlePageLoad(): Promise<void> {
        const currentDomain = this.extractDomain(this.page.url());

        // Check if we've returned to original domain
        if (this.originalDomain &&
            currentDomain === this.originalDomain &&
            this.isNavigating) {
            CSReporter.info('Page loaded on original domain after authentication');
            this.isNavigating = false;
            this.redirectCount = 0;
        }
    }

    /**
     * Check if URL is an authentication page
     */
    private isAuthenticationPage(url: string): boolean {
        const lowerUrl = url.toLowerCase();
        return this.authProviders.some(provider => lowerUrl.includes(provider));
    }

    /**
     * Extract domain from URL
     */
    private extractDomain(url: string): string {
        try {
            // Handle relative URLs by using the page's current origin
            if (url && !url.startsWith('http')) {
                const currentUrl = this.page.url();
                if (currentUrl && currentUrl !== 'about:blank') {
                    const baseUrl = new URL(currentUrl);
                    url = new URL(url, baseUrl.origin).href;
                }
            }
            const urlObj = new URL(url);
            return urlObj.hostname;
        } catch {
            return '';
        }
    }

    /**
     * Wait for return to original domain
     */
    private async waitForDomainReturn(): Promise<void> {
        const startTime = Date.now();

        while (Date.now() - startTime < this.navigationTimeout) {
            const currentDomain = this.extractDomain(this.page.url());

            if (currentDomain === this.originalDomain) {
                CSReporter.info('Successfully returned to original domain');

                // Wait for page to stabilize
                await this.waitForPageStability();
                return;
            }

            // Only log occasionally to avoid spam
            if (this.isAuthenticationPage(this.page.url()) && (Date.now() - startTime) % 5000 < 500) {
                CSReporter.debug('Still on authentication page, waiting...');
            }

            await this.page.waitForTimeout(500);
        }

        throw new Error(`Timeout waiting for return to original domain after ${this.navigationTimeout}ms`);
    }

    /**
     * Wait for page stability after navigation
     */
    private async waitForPageStability(): Promise<void> {
        try {
            // Skip if page is blank
            if (this.page.url() === 'about:blank') {
                await this.page.waitForNavigation({
                    waitUntil: 'domcontentloaded',
                    timeout: 10000
                }).catch(() => {
                    // Ignore navigation timeout on blank page
                });
            }

            // Wait for network to be idle or DOM to be loaded
            await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(async () => {
                // Fallback to domcontentloaded if networkidle times out
                CSReporter.debug('Network idle timeout, falling back to domcontentloaded');
                return this.page.waitForLoadState('domcontentloaded', { timeout: 10000 });
            });

            // Additional stability check using JavaScript
            try {
                await this.page.evaluate(() => {
                    return new Promise<void>((resolve) => {
                        if (document.readyState === 'complete') {
                            // Page is already loaded, wait a bit for dynamic content
                            setTimeout(resolve, 1000);
                        } else {
                            window.addEventListener('load', () => {
                                // Wait after load event for dynamic content
                                setTimeout(resolve, 1000);
                            });
                        }
                    });
                });
            } catch (error: any) {
                // Handle CSP restrictions
                if (error.message?.includes('unsafe-eval') || error.message?.includes('CSP')) {
                    CSReporter.debug('CSP restriction detected, using timeout-based wait');
                    await this.page.waitForTimeout(2000);
                } else {
                    throw error;
                }
            }

            CSReporter.debug('Page is stable after cross-domain navigation');
        } catch (error) {
            CSReporter.warn(`Page stability check failed: ${error}, continuing anyway`);
        }
    }

    /**
     * Handle cross-domain navigation completion
     */
    public async handleCrossDomainNavigation(): Promise<void> {
        if (this.navigationPromise) {
            CSReporter.info('Waiting for cross-domain navigation to complete...');
            await this.navigationPromise;
            this.navigationPromise = null;
        }
    }

    /**
     * Check if currently in cross-domain navigation
     */
    public isInCrossDomainNavigation(): boolean {
        return this.isNavigating;
    }

    /**
     * Set the original domain to track
     */
    public setOriginalDomain(url: string): void {
        this.originalDomain = this.extractDomain(url);
        CSReporter.debug(`Original domain set to: ${this.originalDomain}`);
    }

    /**
     * Check if handlers should be activated based on navigation
     */
    private shouldActivateHandlers(targetUrl: string): boolean {
        if (this.handlersSetup) return false; // Already setup

        const targetDomain = this.extractDomain(targetUrl);
        const currentDomain = this.extractDomain(this.page.url());

        // Only activate if we're navigating to a different domain OR
        // if the URL contains auth-related keywords
        return (targetDomain !== currentDomain) || this.isAuthenticationPage(targetUrl);
    }

    /**
     * Set the target domain for navigation
     */
    public setTargetDomain(url: string): void {
        this.targetDomain = this.extractDomain(url);
        CSReporter.debug(`Target domain set to: ${this.targetDomain}`);
    }

    /**
     * Force wait for navigation completion
     */
    public async forceWaitForNavigation(): Promise<void> {
        if (this.isNavigating) {
            await this.handleCrossDomainNavigation();
        }

        await this.waitForPageStability();
    }

    /**
     * Handle initial authentication redirect
     */
    public async handleInitialAuthRedirect(targetUrl: string): Promise<void> {
        const targetDomain = this.extractDomain(targetUrl);

        // Set both original and target domain
        this.originalDomain = targetDomain;
        this.targetDomain = targetDomain;
        CSReporter.info(`Navigating to: ${targetUrl}`);
        CSReporter.debug(`Target domain: ${targetDomain}`);

        // Wait for initial navigation
        let attempts = 0;
        while (this.page.url() === 'about:blank' && attempts < 20) {
            await this.page.waitForTimeout(100);
            attempts++;
        }

        const currentUrl = this.page.url();
        const currentDomain = this.extractDomain(currentUrl);
        CSReporter.debug(`Current URL after navigation: ${currentUrl}`);

        // Smart activation: only setup handlers if we detect cross-domain or auth redirect
        if (!this.handlersSetup && currentDomain !== targetDomain) {
            CSReporter.info('Cross-domain navigation detected, activating handlers');
            this.setupNavigationHandlers();
        }

        // Check if we're on authentication page
        if (currentUrl !== 'about:blank' && this.isAuthenticationPage(currentUrl)) {
            CSReporter.info(`Authentication page detected: ${currentUrl}`);
            this.isNavigating = true;

            // Wait for page to be ready for interaction
            try {
                await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 });
            } catch {
                // Ignore timeout, page might already be loaded
            }

            CSReporter.info('Authentication page is ready for user interaction');
            return;
        }

        // Wait to see if we get redirected to auth page
        const maxWaitTime = 10000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const currentUrl = this.page.url();

            if (currentUrl === 'about:blank') {
                await this.page.waitForTimeout(500);
                continue;
            }

            const currentDomain = this.extractDomain(currentUrl);

            // Check if we reached target domain without authentication
            if (currentDomain === this.targetDomain) {
                CSReporter.info('Reached target domain without authentication redirect');
                await this.waitForPageStability();
                return;
            }

            // Check if redirected to authentication page
            if (this.isAuthenticationPage(currentUrl)) {
                // Lazy activate handlers when auth detected
                if (!this.handlersSetup) {
                    CSReporter.info('Authentication page detected, activating handlers');
                    this.setupNavigationHandlers();
                }

                CSReporter.info(`Redirected to authentication page: ${currentUrl}`);
                this.isNavigating = true;

                try {
                    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 });
                } catch {
                    // Ignore timeout
                }

                CSReporter.info('Authentication page ready for interaction');
                return;
            }

            await this.page.waitForTimeout(500);
        }

        CSReporter.debug(`Navigation monitoring timeout. Current URL: ${this.page.url()}`);
    }

    /**
     * Get current navigation state
     */
    public getNavigationState(): NavigationState {
        return {
            originalDomain: this.originalDomain,
            currentDomain: this.extractDomain(this.page.url()),
            isNavigating: this.isNavigating,
            isAuthenticated: !this.isNavigating && this.originalDomain !== '',
            redirectCount: this.redirectCount
        };
    }

    /**
     * Reset navigation state
     */
    public reset(): void {
        this.originalDomain = '';
        this.targetDomain = '';
        this.isNavigating = false;
        this.navigationPromise = null;
        this.redirectCount = 0;
        // Don't reset handlersSetup - keep handlers if already setup
        CSReporter.debug('Cross-domain navigation handler reset');
    }

    /**
     * Check if handlers are currently active
     */
    public areHandlersActive(): boolean {
        return this.handlersSetup;
    }
}