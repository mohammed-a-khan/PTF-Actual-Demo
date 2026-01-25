/**
 * Application Explorer
 * Main orchestrator for autonomous application exploration
 *
 * @module ApplicationExplorer
 */

import { chromium, Browser, Page, BrowserContext, Request, Response } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import {
    ExplorationConfig,
    ExplorationResult,
    ExplorationProgress,
    ApplicationState,
    StateTransition,
    CapturedAPI,
    CandidateAction,
    ExecutedAction,
    InteractiveElement,
} from './types';
import { DOMDiscoveryEngine } from './DOMDiscoveryEngine';
import { StateTracker } from './StateTracker';
import { ActionGenerator } from './ActionGenerator';

export interface ExplorationCallbacks {
    onStateDiscovered?: (state: ApplicationState) => void;
    onActionExecuted?: (action: ExecutedAction) => void;
    onAPICapture?: (api: CapturedAPI) => void;
    onProgress?: (progress: ExplorationProgress) => void;
    onError?: (error: Error, context: string) => void;
}

export class ApplicationExplorer {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    private stateTracker: StateTracker;
    private actionGenerator: ActionGenerator;
    private domEngine: DOMDiscoveryEngine;

    private config: ExplorationConfig | null = null;
    private callbacks: ExplorationCallbacks = {};

    private capturedAPIs: CapturedAPI[] = [];
    private executedActions: ExecutedAction[] = [];
    private errors: Array<{ message: string; state: string; action?: string }> = [];
    private consoleErrors: string[] = [];

    private isRunning: boolean = false;
    private isPaused: boolean = false;
    private startTime: Date | null = null;

    private actionQueue: CandidateAction[] = [];
    private exploredStates: Set<string> = new Set();

    constructor() {
        this.stateTracker = new StateTracker();
        this.actionGenerator = new ActionGenerator();
        this.domEngine = new DOMDiscoveryEngine();
    }

    /**
     * Start exploration with given configuration
     */
    async explore(
        config: ExplorationConfig,
        callbacks: ExplorationCallbacks = {}
    ): Promise<ExplorationResult> {
        this.config = config;
        this.callbacks = callbacks;
        this.isRunning = true;
        this.startTime = new Date();

        // Reset state
        this.stateTracker.clear();
        this.capturedAPIs = [];
        this.executedActions = [];
        this.errors = [];
        this.consoleErrors = [];
        this.actionQueue = [];
        this.exploredStates.clear();

        try {
            // Launch browser
            await this.launchBrowser();

            // Set up network interception
            if (config.captureAPIs) {
                await this.setupNetworkCapture();
            }

            // Set up console capture
            if (config.captureConsole) {
                await this.setupConsoleCapture();
            }

            // Handle authentication if credentials provided
            if (config.credentials) {
                await this.handleAuthentication(config.credentials);
            }

            // Navigate to starting URL
            await this.page!.goto(config.url, { waitUntil: 'networkidle', timeout: 30000 });

            // Start exploration loop
            await this.explorationLoop();

            // Generate results
            return this.generateResults();
        } catch (error) {
            this.errors.push({
                message: (error as Error).message,
                state: 'initialization',
            });
            this.callbacks.onError?.(error as Error, 'exploration');
            throw error;
        } finally {
            await this.cleanup();
        }
    }

    /**
     * Get current exploration progress
     */
    getProgress(): ExplorationProgress {
        const states = this.stateTracker.getStates();
        const totalElements = states.reduce((sum, s) => sum + s.interactiveElements.length, 0);
        const exploredElements = this.executedActions.length;

        return {
            status: this.isPaused ? 'paused' : this.isRunning ? 'running' : 'idle',
            statesDiscovered: states.length,
            statesExplored: this.exploredStates.size,
            actionsExecuted: this.executedActions.length,
            apisDiscovered: this.capturedAPIs.length,
            coveragePercentage: totalElements > 0 ? Math.round((exploredElements / totalElements) * 100) : 0,
            startTime: this.startTime || undefined,
            currentDuration: this.startTime ? Date.now() - this.startTime.getTime() : 0,
            currentState: this.stateTracker.getCurrentState()?.id,
            errors: this.errors.map(e => e.message),
        };
    }

    /**
     * Pause exploration
     */
    pause(): void {
        this.isPaused = true;
    }

    /**
     * Resume exploration
     */
    resume(): void {
        this.isPaused = false;
    }

    /**
     * Stop exploration
     */
    stop(): void {
        this.isRunning = false;
    }

    /**
     * Launch browser instance
     */
    private async launchBrowser(): Promise<void> {
        this.browser = await chromium.launch({
            headless: false, // Show browser for debugging
            args: ['--disable-blink-features=AutomationControlled'],
        });

        this.context = await this.browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        this.page = await this.context.newPage();
        this.domEngine.setPage(this.page);
    }

    /**
     * Set up network request/response capture
     */
    private async setupNetworkCapture(): Promise<void> {
        if (!this.page) return;

        const requestMap = new Map<string, { request: Request; startTime: number }>();

        this.page.on('request', (request: Request) => {
            const url = request.url();

            // Filter to API calls only
            if (this.isAPIRequest(url)) {
                requestMap.set(request.url() + request.method(), {
                    request,
                    startTime: Date.now(),
                });
            }
        });

        this.page.on('response', async (response: Response) => {
            const request = response.request();
            const key = request.url() + request.method();
            const requestInfo = requestMap.get(key);

            if (requestInfo && this.isAPIRequest(request.url())) {
                try {
                    let responseBody: unknown;
                    try {
                        responseBody = await response.json();
                    } catch {
                        try {
                            responseBody = await response.text();
                        } catch {
                            responseBody = null;
                        }
                    }

                    const captured: CapturedAPI = {
                        id: `api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        method: request.method(),
                        url: request.url(),
                        urlPattern: this.normalizeApiUrl(request.url()),
                        requestHeaders: request.headers(),
                        requestBody: request.postData() ? JSON.parse(request.postData()!) : undefined,
                        status: response.status(),
                        statusText: response.statusText(),
                        responseHeaders: response.headers(),
                        responseBody,
                        triggeredByElement: undefined,
                        triggeredByAction: undefined,
                        timestamp: new Date(),
                        duration: Date.now() - requestInfo.startTime,
                    };

                    // Classify the API
                    captured.operation = this.classifyAPIOperation(captured);
                    captured.resourceType = this.extractResourceType(captured.url);

                    this.capturedAPIs.push(captured);
                    this.callbacks.onAPICapture?.(captured);
                } catch (e) {
                    // Ignore capture errors
                }

                requestMap.delete(key);
            }
        });
    }

    /**
     * Set up console message capture
     */
    private async setupConsoleCapture(): Promise<void> {
        if (!this.page) return;

        this.page.on('console', (msg) => {
            if (msg.type() === 'error') {
                this.consoleErrors.push(msg.text());
            }
        });

        this.page.on('pageerror', (error) => {
            this.consoleErrors.push(error.message);
        });
    }

    /**
     * Handle authentication
     */
    private async handleAuthentication(credentials: NonNullable<ExplorationConfig['credentials']>): Promise<void> {
        if (!this.page) return;

        const loginUrl = credentials.loginUrl || this.config!.url;

        // Navigate to login page
        await this.page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });

        // Wait a bit for page to stabilize
        await this.page.waitForTimeout(1000);

        // Find username field
        const usernameSelector = credentials.usernameSelector ||
            'input[type="text"][name*="user"], input[type="email"], input[name*="login"], input[placeholder*="username" i], input[placeholder*="email" i], #username, #email';

        // Find password field
        const passwordSelector = credentials.passwordSelector ||
            'input[type="password"]';

        // Find submit button
        const submitSelector = credentials.submitSelector ||
            'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")';

        try {
            // Fill username
            const usernameField = await this.page.waitForSelector(usernameSelector, { timeout: 10000 });
            if (usernameField) {
                await usernameField.fill(credentials.username);
            }

            // Fill password
            const passwordField = await this.page.waitForSelector(passwordSelector, { timeout: 5000 });
            if (passwordField) {
                await passwordField.fill(credentials.password);
            }

            // Click submit
            const submitButton = await this.page.waitForSelector(submitSelector, { timeout: 5000 });
            if (submitButton) {
                await submitButton.click();
            }

            // Wait for navigation
            await this.page.waitForLoadState('networkidle', { timeout: 30000 });

            // Wait additional time for any redirects
            await this.page.waitForTimeout(2000);

        } catch (error) {
            this.errors.push({
                message: `Authentication failed: ${(error as Error).message}`,
                state: 'authentication',
            });
            throw error;
        }
    }

    /**
     * Main exploration loop
     */
    private async explorationLoop(): Promise<void> {
        const config = this.config!;
        const maxDuration = config.maxDuration;
        const maxStates = config.maxStates;

        while (this.isRunning) {
            // Check termination conditions
            if (this.isPaused) {
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }

            const elapsed = Date.now() - this.startTime!.getTime();
            if (elapsed >= maxDuration) {
                console.log('Exploration stopped: Max duration reached');
                break;
            }

            if (this.stateTracker.getStates().length >= maxStates) {
                console.log('Exploration stopped: Max states reached');
                break;
            }

            // Capture current state
            const currentState = await this.stateTracker.captureState(this.page!);
            this.callbacks.onStateDiscovered?.(currentState);

            // Report progress
            this.callbacks.onProgress?.(this.getProgress());

            // Check if state is fully explored
            if (this.exploredStates.has(currentState.id)) {
                // Try to find an unexplored state
                const unexploredState = this.findUnexploredState();
                if (!unexploredState) {
                    console.log('Exploration stopped: All states explored');
                    break;
                }

                // Navigate to unexplored state
                await this.navigateToState(unexploredState);
                continue;
            }

            // Generate candidate actions
            const actions = this.actionGenerator.generateActions(currentState);

            // Filter out already executed actions
            const newActions = actions.filter(a =>
                !this.executedActions.some(e =>
                    e.candidateAction.element.id === a.element.id &&
                    e.candidateAction.actionType === a.actionType
                )
            );

            if (newActions.length === 0) {
                this.exploredStates.add(currentState.id);
                continue;
            }

            // Execute actions based on strategy
            const actionsToExecute = this.selectActions(newActions, config.strategy);

            for (const action of actionsToExecute) {
                if (!this.isRunning || this.isPaused) break;

                const result = await this.executeAction(action, currentState.id);
                this.callbacks.onActionExecuted?.(result);

                // Small delay between actions
                await this.page!.waitForTimeout(500);
            }

            // Mark state as explored if we've done enough actions
            if (newActions.length <= config.maxActionsPerState) {
                this.exploredStates.add(currentState.id);
            }
        }

        this.isRunning = false;
    }

    /**
     * Select actions based on strategy
     */
    private selectActions(actions: CandidateAction[], strategy: string): CandidateAction[] {
        const maxActions = this.config!.maxActionsPerState;

        switch (strategy) {
            case 'bfs':
                // Take highest priority first
                return actions.slice(0, maxActions);

            case 'dfs':
                // Take first state-changing action
                const stateChanging = actions.filter(a => a.expectedStateChange);
                if (stateChanging.length > 0) {
                    return [stateChanging[0]];
                }
                return actions.slice(0, 1);

            case 'priority':
                // Sort by priority, take top N
                return actions.sort((a, b) => b.priority - a.priority).slice(0, maxActions);

            case 'random':
                // Random shuffle and take top N
                const shuffled = [...actions].sort(() => Math.random() - 0.5);
                return shuffled.slice(0, maxActions);

            default:
                return actions.slice(0, maxActions);
        }
    }

    /**
     * Execute a single action
     */
    private async executeAction(action: CandidateAction, fromStateId: string): Promise<ExecutedAction> {
        const startTime = new Date();
        const result: ExecutedAction = {
            candidateAction: action,
            success: false,
            apiCalls: [],
            startTime,
            endTime: new Date(),
            duration: 0,
        };

        try {
            // Get element locator
            const locator = this.getBestLocator(action.element);
            const element = this.page!.locator(locator);

            // Check if element exists
            const count = await element.count();
            if (count === 0) {
                result.error = `Element not found: ${locator}`;
                return result;
            }

            // Clear captured APIs for this action
            const apiStartIndex = this.capturedAPIs.length;

            // Execute action based on type
            switch (action.actionType) {
                case 'click':
                    await element.first().click({ timeout: 10000 });
                    break;

                case 'fill':
                    await element.first().fill(action.value || '', { timeout: 10000 });
                    break;

                case 'select':
                    if (action.value === '__FIRST_OPTION__') {
                        await element.first().selectOption({ index: 0 });
                    } else if (action.value === '__LAST_OPTION__') {
                        const options = await element.first().locator('option').all();
                        await element.first().selectOption({ index: options.length - 1 });
                    } else {
                        await element.first().selectOption(action.value || '');
                    }
                    break;

                case 'check':
                    await element.first().check({ timeout: 10000 });
                    break;

                case 'uncheck':
                    await element.first().uncheck({ timeout: 10000 });
                    break;

                case 'hover':
                    await element.first().hover({ timeout: 10000 });
                    break;

                case 'upload':
                    // Create a test file if needed
                    const testFilePath = path.join(this.config!.outputDir, 'test-upload.txt');
                    if (!fs.existsSync(testFilePath)) {
                        fs.writeFileSync(testFilePath, 'Test file content for upload');
                    }
                    await element.first().setInputFiles(testFilePath);
                    break;
            }

            // Wait for any navigation or network activity
            await this.page!.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
            await this.page!.waitForTimeout(500);

            // Capture new state
            const newState = await this.stateTracker.captureState(this.page!);

            // Record transition
            const apiCalls = this.capturedAPIs.slice(apiStartIndex);
            result.apiCalls = apiCalls;

            if (newState.id !== fromStateId) {
                this.stateTracker.recordTransition(
                    fromStateId,
                    newState.id,
                    {
                        type: action.actionType,
                        elementId: action.element.id,
                        locator,
                        value: action.value,
                    },
                    apiCalls,
                    Date.now() - startTime.getTime()
                );
                result.newStateId = newState.id;
            }

            result.success = true;
        } catch (error) {
            result.error = (error as Error).message;
            this.errors.push({
                message: result.error,
                state: fromStateId,
                action: action.id,
            });
        }

        result.endTime = new Date();
        result.duration = result.endTime.getTime() - result.startTime.getTime();
        this.executedActions.push(result);

        return result;
    }

    /**
     * Get best locator for element
     */
    private getBestLocator(element: InteractiveElement): string {
        // Prefer locators in order of confidence
        for (const locator of element.locators) {
            if (locator.confidence >= 70) {
                switch (locator.type) {
                    case 'testid':
                        return `[data-testid="${locator.value}"]`;
                    case 'id':
                        return locator.value;
                    case 'role':
                        return locator.value;
                    case 'label':
                        return `text=${locator.value.replace('label=', '')}`;
                    case 'placeholder':
                        return `[placeholder="${locator.value.replace('placeholder=', '')}"]`;
                    case 'text':
                        return locator.value;
                    case 'name':
                        return locator.value;
                    case 'css':
                        return locator.value;
                    case 'xpath':
                        return `xpath=${locator.value}`;
                }
            }
        }

        // Fallback to first available
        const first = element.locators[0];
        return first?.value || `${element.tagName}`;
    }

    /**
     * Find unexplored state
     */
    private findUnexploredState(): ApplicationState | null {
        const states = this.stateTracker.getStates();
        return states.find(s => !this.exploredStates.has(s.id)) || null;
    }

    /**
     * Navigate to a specific state
     */
    private async navigateToState(state: ApplicationState): Promise<void> {
        if (!this.page) return;

        try {
            await this.page.goto(state.url, { waitUntil: 'networkidle', timeout: 30000 });
        } catch (error) {
            this.errors.push({
                message: `Failed to navigate to state: ${(error as Error).message}`,
                state: state.id,
            });
        }
    }

    /**
     * Check if URL is an API request
     */
    private isAPIRequest(url: string): boolean {
        // Skip static resources
        const staticExtensions = ['.js', '.css', '.png', '.jpg', '.gif', '.svg', '.woff', '.ico'];
        if (staticExtensions.some(ext => url.includes(ext))) {
            return false;
        }

        // Check for API patterns
        const apiPatterns = ['/api/', '/graphql', '/rest/', '/v1/', '/v2/', '/v3/'];
        if (apiPatterns.some(p => url.includes(p))) {
            return true;
        }

        // Check config patterns
        if (this.config?.captureAPIs && this.config.includeUrlPatterns) {
            return this.config.includeUrlPatterns.some(p => p.test(url));
        }

        return false;
    }

    /**
     * Normalize API URL for pattern matching
     */
    private normalizeApiUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname
                .replace(/\/\d+/g, '/{id}')
                .replace(/\/[a-f0-9]{24}/gi, '/{id}')
                .replace(/\/[a-f0-9-]{36}/gi, '/{uuid}');

            return `${parsed.origin}${path}`;
        } catch {
            return url;
        }
    }

    /**
     * Classify API operation
     */
    private classifyAPIOperation(api: CapturedAPI): CapturedAPI['operation'] {
        const method = api.method.toUpperCase();

        switch (method) {
            case 'GET':
                return api.url.includes('search') || api.url.includes('query') ? 'search' : 'read';
            case 'POST':
                if (api.url.includes('login') || api.url.includes('auth')) return 'auth';
                if (api.url.includes('search') || api.url.includes('query')) return 'search';
                return 'create';
            case 'PUT':
            case 'PATCH':
                return 'update';
            case 'DELETE':
                return 'delete';
            default:
                return 'unknown';
        }
    }

    /**
     * Extract resource type from URL
     */
    private extractResourceType(url: string): string | undefined {
        const match = url.match(/\/api\/v?\d*\/(\w+)/);
        if (match) {
            return match[1].replace(/s$/, ''); // Remove plural 's'
        }
        return undefined;
    }

    /**
     * Generate exploration results
     */
    private generateResults(): ExplorationResult {
        const states = this.stateTracker.getStates();
        const transitions = this.stateTracker.getTransitions();

        const totalElements = states.reduce((sum, s) => sum + s.interactiveElements.length, 0);
        const executedElements = new Set(this.executedActions.map(a => a.candidateAction.element.id)).size;

        return {
            sessionId: `exploration_${this.startTime!.getTime()}`,
            config: this.config!,
            states,
            transitions,
            apis: this.capturedAPIs,
            coverage: {
                statesDiscovered: states.length,
                statesFullyExplored: this.exploredStates.size,
                elementsDiscovered: totalElements,
                elementsInteracted: executedElements,
                apisDiscovered: this.capturedAPIs.length,
                coveragePercentage: totalElements > 0 ? Math.round((executedElements / totalElements) * 100) : 0,
            },
            generatedFiles: {
                features: [],
                pageObjects: [],
                stepDefinitions: [],
                specFiles: [],
            },
            issues: {
                errors: this.errors,
                warnings: [],
                brokenLinks: [],
                consoleErrors: this.consoleErrors,
            },
            startTime: this.startTime!,
            endTime: new Date(),
            duration: Date.now() - this.startTime!.getTime(),
        };
    }

    /**
     * Cleanup resources
     */
    private async cleanup(): Promise<void> {
        this.isRunning = false;

        if (this.page) {
            await this.page.close().catch(() => { });
        }

        if (this.context) {
            await this.context.close().catch(() => { });
        }

        if (this.browser) {
            await this.browser.close().catch(() => { });
        }

        this.page = null;
        this.context = null;
        this.browser = null;
    }
}

export default ApplicationExplorer;
