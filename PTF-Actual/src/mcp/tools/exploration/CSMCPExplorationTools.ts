/**
 * CS Playwright MCP Exploration Tools
 * AI-powered exploratory testing and automatic test generation
 *
 * @module CSMCPExplorationTools
 */

import * as path from 'path';
import * as fs from 'fs';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// Lazy load exploration components
let ApplicationExplorer: any = null;
let DOMDiscoveryEngine: any = null;
let StateTracker: any = null;
let ActionGenerator: any = null;
let TestSynthesizer: any = null;
let CSReporter: any = null;

// Store active exploration sessions
const explorationSessions: Map<string, {
    explorer: any;
    result?: any;
    status: 'running' | 'paused' | 'completed' | 'failed';
}> = new Map();

function ensureExplorationLoaded(): void {
    if (!ApplicationExplorer) {
        ApplicationExplorer = require('../../../codegen/explorer/ApplicationExplorer').ApplicationExplorer;
    }
    if (!DOMDiscoveryEngine) {
        DOMDiscoveryEngine = require('../../../codegen/explorer/DOMDiscoveryEngine').DOMDiscoveryEngine;
    }
    if (!StateTracker) {
        StateTracker = require('../../../codegen/explorer/StateTracker').StateTracker;
    }
    if (!ActionGenerator) {
        ActionGenerator = require('../../../codegen/explorer/ActionGenerator').ActionGenerator;
    }
    if (!TestSynthesizer) {
        TestSynthesizer = require('../../../codegen/explorer/TestSynthesizer').TestSynthesizer;
    }
    if (!CSReporter) {
        CSReporter = require('../../../reporter/CSReporter').CSReporter;
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

// ============================================================================
// Main Exploration Tool
// ============================================================================

const exploreApplicationTool = defineTool()
    .name('explore_application')
    .description('Automatically explore a web application and discover testable elements, states, and workflows. Generates comprehensive test suites from exploration.')
    .category('exploration')
    .stringParam('url', 'Application URL to explore', { required: true })
    .stringParam('username', 'Login username for authentication')
    .stringParam('password', 'Login password for authentication')
    .stringParam('loginUrl', 'Login page URL (if different from main URL)')
    .numberParam('maxDuration', 'Maximum exploration time in minutes', { default: 15 })
    .numberParam('maxStates', 'Maximum states to discover', { default: 50 })
    .stringParam('strategy', 'Exploration strategy', {
        enum: ['bfs', 'dfs', 'priority', 'random'],
        default: 'priority',
    })
    .booleanParam('generateTests', 'Generate test files from exploration', { default: true })
    .booleanParam('captureAPIs', 'Capture API calls during exploration', { default: true })
    .handler(async (params, context) => {
        ensureExplorationLoaded();

        const url = params.url as string;
        const sessionId = `exploration_${Date.now()}`;

        context.log('info', `Starting exploration of ${url}`);
        CSReporter.info(`[MCP] Starting application exploration: ${url}`);

        try {
            const explorer = new ApplicationExplorer();

            // Store session
            explorationSessions.set(sessionId, {
                explorer,
                status: 'running',
            });

            // Configure exploration
            const config = {
                url,
                credentials: params.username ? {
                    username: params.username as string,
                    password: params.password as string,
                    loginUrl: params.loginUrl as string,
                } : undefined,
                maxDuration: ((params.maxDuration as number) || 15) * 60 * 1000,
                maxStates: (params.maxStates as number) || 50,
                maxDepth: 10,
                maxActionsPerState: 5,
                strategy: (params.strategy as string) || 'priority',
                captureScreenshots: true,
                captureAPIs: params.captureAPIs !== false,
                captureConsole: true,
                generateAssertions: true,
                outputDir: context.server.workingDirectory,
            };

            // Run exploration
            const result = await explorer.explore(config, {
                onStateDiscovered: (state: any) => {
                    context.log('info', `Discovered state: ${state.pageType} - ${state.title}`);
                },
                onProgress: (progress: any) => {
                    context.log('info', `Progress: ${progress.statesExplored}/${progress.statesDiscovered} states, ${progress.actionsExecuted} actions`);
                },
                onError: (error: Error, ctx: string) => {
                    context.log('error', `Error in ${ctx}: ${error.message}`);
                },
            });

            // Update session
            explorationSessions.set(sessionId, {
                explorer,
                result,
                status: 'completed',
            });

            // Generate tests if requested
            let generatedFiles: string[] = [];
            if (params.generateTests !== false) {
                const synthesizer = new TestSynthesizer({
                    outputDir: path.join(context.server.workingDirectory, 'generated-tests'),
                    projectName: new URL(url).hostname,
                    generateBDD: true,
                    generateSpec: true,
                    generatePageObjects: true,
                    includeAPITests: params.captureAPIs !== false,
                });

                generatedFiles = await synthesizer.synthesize(result);
                result.generatedFiles = {
                    features: generatedFiles.filter(f => f.endsWith('.feature')),
                    pageObjects: generatedFiles.filter(f => f.includes('/pages/')),
                    stepDefinitions: generatedFiles.filter(f => f.includes('/steps/')),
                    specFiles: generatedFiles.filter(f => f.endsWith('.spec.ts')),
                };
            }

            CSReporter.pass(`[MCP] Exploration completed: ${result.coverage.statesDiscovered} states, ${result.coverage.elementsDiscovered} elements`);

            return createJsonResult({
                sessionId,
                status: 'completed',
                url,
                coverage: result.coverage,
                summary: {
                    statesDiscovered: result.states.length,
                    transitionsFound: result.transitions.length,
                    apisDiscovered: result.apis.length,
                    errorsEncountered: result.issues.errors.length,
                },
                generatedFiles: result.generatedFiles,
                duration: result.duration,
                states: result.states.map((s: any) => ({
                    id: s.id,
                    url: s.url,
                    pageType: s.pageType,
                    title: s.title,
                    elementsCount: s.interactiveElements.length,
                    formsCount: s.forms.length,
                })),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Exploration failed: ${error.message}`);

            explorationSessions.set(sessionId, {
                explorer: null,
                status: 'failed',
            });

            return createErrorResult(`Exploration failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Quick Page Exploration
// ============================================================================

const explorePageTool = defineTool()
    .name('explore_page')
    .description('Explore a single page deeply and discover all interactive elements')
    .category('exploration')
    .booleanParam('includeHidden', 'Include hidden elements', { default: false })
    .booleanParam('generatePageObject', 'Generate page object file', { default: true })
    .handler(async (params, context) => {
        ensureExplorationLoaded();

        context.log('info', 'Exploring current page');

        try {
            const page = (context.server as any).browser?.page;
            if (!page) {
                return createErrorResult('No browser page available. Use browser_launch first.');
            }

            const domEngine = new DOMDiscoveryEngine();
            domEngine.setPage(page);

            // Discover all elements
            const elements = await domEngine.discoverElements({
                includeHidden: params.includeHidden as boolean,
                maxElements: 300,
            });

            // Discover forms
            const forms = await domEngine.discoverForms();

            // Discover tables
            const tables = await domEngine.discoverTables();

            // Discover modals
            const modals = await domEngine.discoverModals();

            // Get page info
            const url = page.url();
            const title = await page.title();

            const result = {
                url,
                title,
                elements: {
                    total: elements.length,
                    byType: groupBy(elements, 'type'),
                    byPurpose: groupBy(elements, 'purpose'),
                },
                forms: forms.map((f: any) => ({
                    id: f.id,
                    type: f.formType,
                    fieldsCount: f.fields.length,
                    hasSubmit: !!f.submitButton,
                })),
                tables: tables.map((t: any) => ({
                    id: t.id,
                    headers: t.headers,
                    rowCount: t.rowCount,
                    hasActions: t.hasActions,
                    hasPagination: t.hasPagination,
                })),
                modals: modals.map((m: any) => ({
                    id: m.id,
                    title: m.title,
                    type: m.type,
                })),
                interactiveElements: elements.slice(0, 50).map((el: any) => ({
                    id: el.id,
                    type: el.type,
                    purpose: el.purpose,
                    text: el.text?.substring(0, 50),
                    locator: el.locators[0]?.value,
                })),
            };

            // Generate page object if requested
            if (params.generatePageObject) {
                const pageName = generatePageNameFromUrl(url);
                const pageObjectPath = path.join(
                    context.server.workingDirectory,
                    'generated-tests/pages',
                    `${pageName}.page.ts`
                );

                const synthesizer = new TestSynthesizer({
                    outputDir: path.join(context.server.workingDirectory, 'generated-tests'),
                    projectName: 'exploration',
                    generateBDD: false,
                    generateSpec: false,
                    generatePageObjects: true,
                    includeAPITests: false,
                });

                // Create minimal state for synthesis
                const state = {
                    id: 'current',
                    url,
                    title,
                    pageType: detectPageType(url, title, elements, forms),
                    interactiveElements: elements,
                    forms,
                    tables,
                    modals,
                };

                const files = await synthesizer.synthesize({
                    states: [state],
                    transitions: [],
                    apis: [],
                    coverage: { statesDiscovered: 1 },
                } as any);

                (result as any).generatedPageObject = files.find((f: string) => f.includes('/pages/'));
            }

            CSReporter.pass(`[MCP] Page explored: ${elements.length} elements found`);

            return createJsonResult(result);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Page exploration failed: ${error.message}`);
            return createErrorResult(`Page exploration failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Discover Elements Tool
// ============================================================================

const discoverElementsTool = defineTool()
    .name('discover_elements')
    .description('Discover all interactive elements on the current page with detailed analysis')
    .category('exploration')
    .stringParam('filter', 'Filter by element type', {
        enum: ['all', 'buttons', 'inputs', 'links', 'forms', 'tables'],
        default: 'all',
    })
    .booleanParam('generateLocators', 'Generate multiple locator strategies', { default: true })
    .handler(async (params, context) => {
        ensureExplorationLoaded();

        try {
            const page = (context.server as any).browser?.page;
            if (!page) {
                return createErrorResult('No browser page available. Use browser_launch first.');
            }

            const domEngine = new DOMDiscoveryEngine();
            domEngine.setPage(page);

            let elements = await domEngine.discoverElements({ maxElements: 200 });

            // Filter by type
            const filter = params.filter as string;
            if (filter !== 'all') {
                const typeMap: Record<string, string[]> = {
                    buttons: ['button'],
                    inputs: ['input', 'textarea', 'select'],
                    links: ['link'],
                    forms: ['form'],
                    tables: ['table'],
                };
                const targetTypes = typeMap[filter] || [];
                elements = elements.filter((el: any) => targetTypes.includes(el.type));
            }

            const result = {
                count: elements.length,
                elements: elements.map((el: any) => ({
                    id: el.id,
                    tagName: el.tagName,
                    type: el.type,
                    purpose: el.purpose,
                    fieldType: el.fieldType,
                    text: el.text?.substring(0, 100),
                    label: el.label,
                    placeholder: el.placeholder,
                    isVisible: el.isVisible,
                    isEnabled: el.isEnabled,
                    isRequired: el.isRequired,
                    locators: params.generateLocators ? el.locators : [el.locators[0]],
                    boundingBox: el.boundingBox,
                })),
            };

            CSReporter.pass(`[MCP] Discovered ${elements.length} elements`);

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Element discovery failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Generate Actions Tool
// ============================================================================

const generateActionsTool = defineTool()
    .name('generate_actions')
    .description('Generate candidate test actions for the current page')
    .category('exploration')
    .numberParam('maxActions', 'Maximum actions to generate', { default: 20 })
    .booleanParam('includeNegative', 'Include negative test cases', { default: false })
    .handler(async (params, context) => {
        ensureExplorationLoaded();

        try {
            const page = (context.server as any).browser?.page;
            if (!page) {
                return createErrorResult('No browser page available. Use browser_launch first.');
            }

            // Discover elements first
            const domEngine = new DOMDiscoveryEngine();
            domEngine.setPage(page);

            const elements = await domEngine.discoverElements({ maxElements: 100 });
            const forms = await domEngine.discoverForms();

            // Create state object
            const state = {
                id: 'current',
                url: page.url(),
                title: await page.title(),
                interactiveElements: elements,
                forms,
                tables: [],
                modals: [],
            };

            // Generate actions
            const actionGenerator = new ActionGenerator();
            let actions = actionGenerator.generateActions(state as any);

            // Filter negative tests if not requested
            if (!params.includeNegative) {
                actions = actions.filter((a: any) =>
                    !a.id.includes('invalid') && !a.id.includes('boundary')
                );
            }

            // Limit actions
            actions = actions.slice(0, params.maxActions as number);

            const result = {
                count: actions.length,
                actions: actions.map((a: any) => ({
                    id: a.id,
                    elementId: a.element.id,
                    elementType: a.element.type,
                    actionType: a.actionType,
                    value: a.value,
                    priority: a.priority,
                    riskLevel: a.riskLevel,
                    expectedOutcome: a.expectedOutcome,
                    locator: a.element.locators[0]?.value,
                })),
            };

            CSReporter.pass(`[MCP] Generated ${actions.length} candidate actions`);

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Action generation failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Discover APIs Tool
// ============================================================================

const discoverAPIsTool = defineTool()
    .name('discover_apis')
    .description('Discover backend API endpoints by monitoring network traffic')
    .category('exploration')
    .numberParam('duration', 'Monitoring duration in seconds', { default: 30 })
    .booleanParam('performActions', 'Perform actions to trigger API calls', { default: true })
    .handler(async (params, context) => {
        ensureExplorationLoaded();

        try {
            const page = (context.server as any).browser?.page;
            if (!page) {
                return createErrorResult('No browser page available. Use browser_launch first.');
            }

            context.log('info', 'Starting API discovery');
            CSReporter.info('[MCP] Starting API endpoint discovery');

            const capturedAPIs: any[] = [];
            const requestMap = new Map<string, { startTime: number }>();

            // Set up network capture
            page.on('request', (request: any) => {
                const url = request.url();
                if (isAPIRequest(url)) {
                    requestMap.set(url + request.method(), { startTime: Date.now() });
                }
            });

            page.on('response', async (response: any) => {
                const request = response.request();
                const key = request.url() + request.method();
                const requestInfo = requestMap.get(key);

                if (requestInfo && isAPIRequest(request.url())) {
                    try {
                        let responseBody: any;
                        try {
                            responseBody = await response.json();
                        } catch {
                            responseBody = null;
                        }

                        capturedAPIs.push({
                            method: request.method(),
                            url: request.url(),
                            status: response.status(),
                            duration: Date.now() - requestInfo.startTime,
                            hasBody: !!responseBody,
                            bodyKeys: responseBody ? Object.keys(responseBody).slice(0, 10) : [],
                        });
                    } catch { }
                }
            });

            // If performing actions, discover and click some elements
            if (params.performActions) {
                const domEngine = new DOMDiscoveryEngine();
                domEngine.setPage(page);
                const elements = await domEngine.discoverElements({ maxElements: 20 });

                // Click safe elements to trigger API calls
                const safeElements = elements.filter((el: any) =>
                    el.type === 'link' || (el.type === 'button' && el.riskLevel !== 'destructive')
                ).slice(0, 5);

                for (const el of safeElements) {
                    try {
                        const locator = el.locators[0]?.value;
                        if (locator) {
                            await page.locator(locator).first().click({ timeout: 3000 });
                            await page.waitForTimeout(1000);
                            await page.goBack().catch(() => { });
                        }
                    } catch { }
                }
            }

            // Wait for specified duration
            await page.waitForTimeout((params.duration as number) * 1000);

            // Group APIs by endpoint
            const uniqueAPIs = new Map<string, any>();
            for (const api of capturedAPIs) {
                const key = `${api.method}-${normalizeAPIUrl(api.url)}`;
                if (!uniqueAPIs.has(key)) {
                    uniqueAPIs.set(key, api);
                }
            }

            const result = {
                totalCaptured: capturedAPIs.length,
                uniqueEndpoints: uniqueAPIs.size,
                endpoints: Array.from(uniqueAPIs.values()).map(api => ({
                    method: api.method,
                    url: api.url,
                    pattern: normalizeAPIUrl(api.url),
                    status: api.status,
                    duration: api.duration,
                    responseKeys: api.bodyKeys,
                })),
            };

            CSReporter.pass(`[MCP] Discovered ${uniqueAPIs.size} unique API endpoints`);

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`API discovery failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Generate Tests from Exploration
// ============================================================================

const generateTestsTool = defineTool()
    .name('generate_tests_from_exploration')
    .description('Generate test files from a completed exploration session')
    .category('exploration')
    .stringParam('sessionId', 'Exploration session ID', { required: true })
    .stringParam('format', 'Test format to generate', {
        enum: ['bdd', 'spec', 'both'],
        default: 'both',
    })
    .booleanParam('includePageObjects', 'Generate page objects', { default: true })
    .booleanParam('includeAPITests', 'Generate API tests', { default: true })
    .handler(async (params, context) => {
        ensureExplorationLoaded();

        const sessionId = params.sessionId as string;
        const session = explorationSessions.get(sessionId);

        if (!session) {
            return createErrorResult(`Exploration session not found: ${sessionId}`);
        }

        if (!session.result) {
            return createErrorResult(`Exploration session has no results: ${sessionId}`);
        }

        try {
            context.log('info', `Generating tests from exploration ${sessionId}`);

            const synthesizer = new TestSynthesizer({
                outputDir: path.join(context.server.workingDirectory, 'generated-tests'),
                projectName: 'exploration',
                generateBDD: params.format === 'bdd' || params.format === 'both',
                generateSpec: params.format === 'spec' || params.format === 'both',
                generatePageObjects: params.includePageObjects as boolean,
                includeAPITests: params.includeAPITests as boolean,
            });

            const files = await synthesizer.synthesize(session.result);

            const result = {
                sessionId,
                generatedFiles: {
                    total: files.length,
                    features: files.filter((f: string) => f.endsWith('.feature')),
                    pageObjects: files.filter((f: string) => f.includes('/pages/')),
                    stepDefinitions: files.filter((f: string) => f.includes('/steps/')),
                    specFiles: files.filter((f: string) => f.endsWith('.spec.ts')),
                    apiTests: files.filter((f: string) => f.includes('/api/')),
                },
            };

            CSReporter.pass(`[MCP] Generated ${files.length} test files`);

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Test generation failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Get Exploration Status
// ============================================================================

const getExplorationStatusTool = defineTool()
    .name('get_exploration_status')
    .description('Get status of an exploration session')
    .category('exploration')
    .stringParam('sessionId', 'Exploration session ID', { required: true })
    .handler(async (params, context) => {
        const sessionId = params.sessionId as string;
        const session = explorationSessions.get(sessionId);

        if (!session) {
            return createErrorResult(`Exploration session not found: ${sessionId}`);
        }

        if (session.explorer && session.status === 'running') {
            const progress = session.explorer.getProgress();
            return createJsonResult({
                sessionId,
                status: session.status,
                progress,
            });
        }

        return createJsonResult({
            sessionId,
            status: session.status,
            hasResults: !!session.result,
        });
    })
    .build();

// ============================================================================
// Stop Exploration
// ============================================================================

const stopExplorationTool = defineTool()
    .name('stop_exploration')
    .description('Stop a running exploration session')
    .category('exploration')
    .stringParam('sessionId', 'Exploration session ID', { required: true })
    .handler(async (params, context) => {
        const sessionId = params.sessionId as string;
        const session = explorationSessions.get(sessionId);

        if (!session) {
            return createErrorResult(`Exploration session not found: ${sessionId}`);
        }

        if (session.explorer && session.status === 'running') {
            session.explorer.stop();
            session.status = 'completed';
            return createTextResult(`Exploration ${sessionId} stopped`);
        }

        return createTextResult(`Exploration ${sessionId} is not running`);
    })
    .build();

// ============================================================================
// Analyze Form Tool
// ============================================================================

const analyzeFormTool = defineTool()
    .name('analyze_form')
    .description('Analyze a form on the current page and generate test data')
    .category('exploration')
    .stringParam('formSelector', 'CSS selector for the form (optional, uses first form if not specified)')
    .handler(async (params, context) => {
        ensureExplorationLoaded();

        try {
            const page = (context.server as any).browser?.page;
            if (!page) {
                return createErrorResult('No browser page available. Use browser_launch first.');
            }

            const domEngine = new DOMDiscoveryEngine();
            domEngine.setPage(page);

            const forms = await domEngine.discoverForms();

            if (forms.length === 0) {
                return createErrorResult('No forms found on the page');
            }

            // Select form
            let form = forms[0];
            if (params.formSelector) {
                // Try to find matching form
                form = forms.find((f: any) =>
                    f.id === params.formSelector || f.name === params.formSelector
                ) || form;
            }

            // Generate test data for each field
            const actionGenerator = new ActionGenerator();
            const testData: Record<string, any> = {};

            for (const field of form.fields) {
                const fieldName = field.label || field.placeholder || field.fieldType || 'field';
                testData[fieldName] = {
                    validValue: actionGenerator.generateTestData(field.fieldType || 'text', field),
                    fieldType: field.fieldType,
                    isRequired: field.isRequired,
                    locator: field.locators[0]?.value,
                };
            }

            const result = {
                formId: form.id,
                formType: form.formType,
                action: form.action,
                method: form.method,
                fieldsCount: form.fields.length,
                fields: form.fields.map((f: any) => ({
                    type: f.type,
                    fieldType: f.fieldType,
                    label: f.label,
                    placeholder: f.placeholder,
                    isRequired: f.isRequired,
                    locator: f.locators[0]?.value,
                })),
                testData,
                hasSubmitButton: !!form.submitButton,
                submitButtonLocator: form.submitButton?.locators[0]?.value,
            };

            CSReporter.pass(`[MCP] Analyzed form with ${form.fields.length} fields`);

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Form analysis failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Helper Functions
// ============================================================================

function groupBy(items: any[], key: string): Record<string, number> {
    return items.reduce((acc, item) => {
        const value = item[key] || 'unknown';
        acc[value] = (acc[value] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);
}

function generatePageNameFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        if (pathParts.length > 0) {
            return pathParts[pathParts.length - 1]
                .replace(/[-_]/g, '')
                .replace(/\b\w/g, c => c.toUpperCase()) + 'Page';
        }
        return 'HomePage';
    } catch {
        return 'GeneratedPage';
    }
}

function detectPageType(url: string, title: string, elements: any[], forms: any[]): string {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/login')) return 'login';
    if (urlLower.includes('/register')) return 'register';
    if (urlLower.includes('/dashboard')) return 'dashboard';
    if (forms.some((f: any) => f.formType === 'login')) return 'login';
    if (forms.length > 0) return 'form';
    return 'unknown';
}

function isAPIRequest(url: string): boolean {
    const staticExtensions = ['.js', '.css', '.png', '.jpg', '.gif', '.svg', '.woff', '.ico'];
    if (staticExtensions.some(ext => url.includes(ext))) return false;

    const apiPatterns = ['/api/', '/graphql', '/rest/', '/v1/', '/v2/'];
    return apiPatterns.some(p => url.includes(p));
}

function normalizeAPIUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.pathname
            .replace(/\/\d+/g, '/{id}')
            .replace(/\/[a-f0-9]{24}/gi, '/{id}')
            .replace(/\/[a-f0-9-]{36}/gi, '/{uuid}');
    } catch {
        return url;
    }
}

// ============================================================================
// Export Tools
// ============================================================================

export const explorationTools: MCPToolDefinition[] = [
    exploreApplicationTool,
    explorePageTool,
    discoverElementsTool,
    generateActionsTool,
    discoverAPIsTool,
    generateTestsTool,
    getExplorationStatusTool,
    stopExplorationTool,
    analyzeFormTool,
];

/**
 * Register all exploration tools with the registry
 */
export function registerExplorationTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(explorationTools);
}
