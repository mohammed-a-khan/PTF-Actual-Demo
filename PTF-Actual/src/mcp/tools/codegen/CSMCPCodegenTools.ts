/**
 * CS Playwright MCP Codegen Tools
 * Session-based code generation for recording browser interactions
 * and converting them to Playwright code or BDD/Gherkin format
 *
 * @module CSMCPCodegenTools
 */

import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';
import { CSReporter } from '../../../reporter/CSReporter';

// ============================================================================
// Types
// ============================================================================

interface RecordedAction {
    timestamp: number;
    type: 'navigate' | 'click' | 'fill' | 'type' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'upload' | 'dialog' | 'screenshot' | 'assertion';
    selector?: string;
    locator?: string;
    value?: string;
    url?: string;
    key?: string;
    description?: string;
    snapshot?: any;
}

interface CodegenSession {
    id: string;
    startTime: number;
    endTime?: number;
    baseUrl: string;
    actions: RecordedAction[];
    currentSnapshot?: any;
    options: {
        language: 'typescript' | 'javascript';
        testFramework: 'playwright' | 'bdd';
        generatePageObjects: boolean;
        generateAssertions: boolean;
    };
}

// ============================================================================
// Session Storage
// ============================================================================

const codegenSessions: Map<string, CodegenSession> = new Map();
let activeSessionId: string | null = null;

// ============================================================================
// Helper Functions
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

function generateSessionId(): string {
    return `codegen_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Generate best locator from accessibility snapshot element
 */
function generateLocator(element: any): string {
    if (!element) return '';

    // Priority order for locators (matching Playwright best practices)
    // 1. Role + name (most reliable)
    if (element.role && element.name) {
        const role = element.role.toLowerCase();
        const name = element.name.replace(/"/g, '\\"');
        return `getByRole('${role}', { name: '${name}' })`;
    }

    // 2. Label (for form fields)
    if (element.role === 'textbox' && element.name) {
        return `getByLabel('${element.name.replace(/"/g, '\\"')}')`;
    }

    // 3. Placeholder
    if (element.placeholder) {
        return `getByPlaceholder('${element.placeholder.replace(/"/g, '\\"')}')`;
    }

    // 4. Text content (for buttons, links)
    if (element.name && (element.role === 'button' || element.role === 'link')) {
        return `getByText('${element.name.replace(/"/g, '\\"')}')`;
    }

    // 5. Test ID if available
    if (element.testId) {
        return `getByTestId('${element.testId}')`;
    }

    // 6. Fallback to CSS selector if provided
    if (element.selector) {
        return `locator('${element.selector}')`;
    }

    return `locator('[role="${element.role}"]')`;
}

/**
 * Convert action to Playwright code
 */
function actionToPlaywright(action: RecordedAction, options: CodegenSession['options']): string {
    const locator = action.locator || (action.selector ? `locator('${action.selector}')` : '');

    switch (action.type) {
        case 'navigate':
            return `await page.goto('${action.url}');`;

        case 'click':
            return `await page.${locator}.click();`;

        case 'fill':
            return `await page.${locator}.fill('${action.value?.replace(/'/g, "\\'")}');`;

        case 'type':
            return `await page.${locator}.pressSequentially('${action.value?.replace(/'/g, "\\'")}');`;

        case 'select':
            return `await page.${locator}.selectOption('${action.value}');`;

        case 'check':
            return `await page.${locator}.check();`;

        case 'uncheck':
            return `await page.${locator}.uncheck();`;

        case 'press':
            return `await page.${locator}.press('${action.key}');`;

        case 'hover':
            return `await page.${locator}.hover();`;

        case 'upload':
            return `await page.${locator}.setInputFiles('${action.value}');`;

        case 'assertion':
            if (action.description?.includes('visible')) {
                return `await expect(page.${locator}).toBeVisible();`;
            } else if (action.description?.includes('text')) {
                return `await expect(page.${locator}).toHaveText('${action.value}');`;
            }
            return `// Assertion: ${action.description}`;

        case 'screenshot':
            return `await page.screenshot({ path: '${action.value || 'screenshot.png'}' });`;

        default:
            return `// Unknown action: ${action.type}`;
    }
}

/**
 * Convert action to Gherkin step
 */
function actionToGherkin(action: RecordedAction): string {
    switch (action.type) {
        case 'navigate':
            return `When I navigate to "${action.url}"`;

        case 'click':
            return `When I click on ${action.description || 'the element'}`;

        case 'fill':
            return `When I enter "${action.value}" in the ${action.description || 'field'}`;

        case 'type':
            return `When I type "${action.value}" in the ${action.description || 'field'}`;

        case 'select':
            return `When I select "${action.value}" from the ${action.description || 'dropdown'}`;

        case 'check':
            return `When I check the ${action.description || 'checkbox'}`;

        case 'uncheck':
            return `When I uncheck the ${action.description || 'checkbox'}`;

        case 'press':
            return `When I press the "${action.key}" key`;

        case 'hover':
            return `When I hover over ${action.description || 'the element'}`;

        case 'upload':
            return `When I upload "${action.value}" to the ${action.description || 'file input'}`;

        case 'assertion':
            if (action.description?.includes('visible')) {
                return `Then I should see ${action.description}`;
            }
            return `Then ${action.description}`;

        case 'screenshot':
            return `Then I take a screenshot`;

        default:
            return `# Unknown action: ${action.type}`;
    }
}

/**
 * Generate complete Playwright test code
 */
function generatePlaywrightCode(session: CodegenSession): string {
    const testName = `Test recorded at ${new Date(session.startTime).toISOString()}`;

    let code = `import { test, expect } from '@playwright/test';

test.describe('Recorded Test', () => {
    test('${testName}', async ({ page }) => {
`;

    for (const action of session.actions) {
        const line = actionToPlaywright(action, session.options);
        code += `        ${line}\n`;
    }

    code += `    });
});
`;

    return code;
}

/**
 * Generate BDD feature file
 */
function generateBDDFeature(session: CodegenSession): string {
    const featureName = 'Recorded User Journey';
    const scenarioName = `User journey recorded at ${new Date(session.startTime).toISOString()}`;

    let feature = `Feature: ${featureName}
    As a user
    I want to perform various actions
    So that I can complete my workflow

    Scenario: ${scenarioName}
`;

    // Group actions by type for better readability
    let isFirstAction = true;
    for (const action of session.actions) {
        const step = actionToGherkin(action);
        const keyword = isFirstAction ? 'Given' : (action.type === 'assertion' ? 'Then' : 'When');
        feature += `        ${isFirstAction ? keyword : (step.startsWith('Then') ? 'Then' : 'And')} ${step.replace(/^(Given|When|Then|And)\s+/i, '')}\n`;
        isFirstAction = false;
    }

    return feature;
}

/**
 * Generate step definitions for BDD
 */
function generateStepDefinitions(session: CodegenSession): string {
    const steps = new Set<string>();

    let code = `import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { getPage } from '../support/hooks';

`;

    for (const action of session.actions) {
        const step = actionToGherkin(action);
        const stepPattern = step
            .replace(/"[^"]*"/g, '"{string}"')
            .replace(/\d+/g, '{int}');

        // Avoid duplicate step definitions
        if (steps.has(stepPattern)) continue;
        steps.add(stepPattern);

        const playwrightCode = actionToPlaywright(action, session.options);

        code += `${step.startsWith('Then') ? 'Then' : 'When'}('${stepPattern.replace(/^(Given|When|Then|And)\s+/i, '')}', async function(`;

        // Add parameters
        const stringMatches = stepPattern.match(/\{string\}/g) || [];
        const intMatches = stepPattern.match(/\{int\}/g) || [];
        const params: string[] = [];
        stringMatches.forEach((_, i) => params.push(`value${i + 1}: string`));
        intMatches.forEach((_, i) => params.push(`num${i + 1}: number`));

        code += params.join(', ');
        code += `) {
    const page = getPage();
    ${playwrightCode.replace(/'[^']*'/g, (match, offset) => {
        const paramIndex = stepPattern.substring(0, offset).match(/\{(string|int)\}/g)?.length || 0;
        return params[paramIndex]?.split(':')[0] || match;
    })}
});

`;
    }

    return code;
}

/**
 * Generate page object
 */
function generatePageObject(session: CodegenSession, pageName: string = 'RecordedPage'): string {
    const elements = new Map<string, { locator: string; description: string }>();

    // Extract unique elements from actions
    for (const action of session.actions) {
        if (action.locator && action.description) {
            const name = action.description
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_|_$/g, '');
            if (name && !elements.has(name)) {
                elements.set(name, {
                    locator: action.locator,
                    description: action.description,
                });
            }
        }
    }

    let code = `import { Page, Locator } from '@playwright/test';

/**
 * ${pageName}
 * Auto-generated page object from recorded session
 */
export class ${pageName} {
    readonly page: Page;

`;

    // Add element properties
    for (const [name, element] of elements) {
        code += `    /** ${element.description} */
    readonly ${name}: Locator;
`;
    }

    code += `
    constructor(page: Page) {
        this.page = page;
`;

    // Initialize locators
    for (const [name, element] of elements) {
        code += `        this.${name} = page.${element.locator};
`;
    }

    code += `    }
`;

    // Add action methods based on recorded actions
    const methods = new Set<string>();
    for (const action of session.actions) {
        if (action.type === 'navigate') continue;

        const methodName = `${action.type}${action.description?.replace(/[^a-zA-Z0-9]/g, '') || 'Element'}`;
        if (methods.has(methodName)) continue;
        methods.add(methodName);

        code += `
    async ${methodName}(`;
        if (action.type === 'fill' || action.type === 'type') {
            code += `value: string`;
        } else if (action.type === 'select') {
            code += `option: string`;
        }
        code += `): Promise<void> {
        ${actionToPlaywright(action, session.options).replace('page.', 'this.page.')}
    }
`;
    }

    code += `}
`;

    return code;
}

// ============================================================================
// Codegen Start Tool
// ============================================================================

const codegenStart = defineTool()
    .name('codegen_start')
    .description('Start a new code generation recording session. All subsequent browser actions will be recorded.')
    .category('generation')
    .stringParam('baseUrl', 'Base URL for the application being tested')
    .stringParam('language', 'Output language', {
        enum: ['typescript', 'javascript'],
        default: 'typescript',
    })
    .stringParam('testFramework', 'Test framework for output', {
        enum: ['playwright', 'bdd'],
        default: 'playwright',
    })
    .booleanParam('generatePageObjects', 'Generate page objects from recorded elements', { default: true })
    .booleanParam('generateAssertions', 'Auto-generate assertions for state changes', { default: true })
    .handler(async (params, context) => {
        CSReporter.info('[MCP] Starting codegen session');

        // Check if there's already an active session
        if (activeSessionId) {
            const existingSession = codegenSessions.get(activeSessionId);
            if (existingSession && !existingSession.endTime) {
                return createErrorResult(`Session ${activeSessionId} is already active. End it first with codegen_end.`);
            }
        }

        // Create new session
        const sessionId = generateSessionId();
        const session: CodegenSession = {
            id: sessionId,
            startTime: Date.now(),
            baseUrl: (params.baseUrl as string) || '',
            actions: [],
            options: {
                language: (params.language as 'typescript' | 'javascript') || 'typescript',
                testFramework: (params.testFramework as 'playwright' | 'bdd') || 'playwright',
                generatePageObjects: params.generatePageObjects !== false,
                generateAssertions: params.generateAssertions !== false,
            },
        };

        codegenSessions.set(sessionId, session);
        activeSessionId = sessionId;

        CSReporter.pass(`[MCP] Codegen session started: ${sessionId}`);

        return createJsonResult({
            sessionId,
            status: 'recording',
            message: 'Codegen session started. Browser actions will now be recorded.',
            options: session.options,
            instructions: [
                'Use browser tools (click, fill, navigate, etc.) to record actions',
                'Use codegen_record_action to manually add actions',
                'Use codegen_end to stop recording and generate code',
            ],
        });
    })
    .build();

// ============================================================================
// Codegen Record Action Tool
// ============================================================================

const codegenRecordAction = defineTool()
    .name('codegen_record_action')
    .description('Manually record an action to the current codegen session')
    .category('generation')
    .stringParam('type', 'Action type', {
        required: true,
        enum: ['navigate', 'click', 'fill', 'type', 'select', 'check', 'uncheck', 'press', 'hover', 'upload', 'assertion', 'screenshot'],
    })
    .stringParam('selector', 'CSS selector for the element')
    .stringParam('locator', 'Playwright locator (e.g., getByRole, getByLabel)')
    .stringParam('value', 'Value for fill/type/select actions')
    .stringParam('url', 'URL for navigate action')
    .stringParam('key', 'Key for press action')
    .stringParam('description', 'Human-readable description of the action')
    .handler(async (params, context) => {
        if (!activeSessionId) {
            return createErrorResult('No active codegen session. Start one with codegen_start.');
        }

        const session = codegenSessions.get(activeSessionId);
        if (!session) {
            return createErrorResult('Session not found.');
        }

        const action: RecordedAction = {
            timestamp: Date.now(),
            type: params.type as RecordedAction['type'],
            selector: params.selector as string,
            locator: params.locator as string,
            value: params.value as string,
            url: params.url as string,
            key: params.key as string,
            description: params.description as string,
        };

        session.actions.push(action);

        CSReporter.info(`[MCP] Recorded action: ${action.type}`);

        return createJsonResult({
            recorded: true,
            actionIndex: session.actions.length - 1,
            action,
            totalActions: session.actions.length,
        });
    })
    .build();

// ============================================================================
// Codegen End Tool
// ============================================================================

const codegenEnd = defineTool()
    .name('codegen_end')
    .description('End the current codegen session and generate test code')
    .category('generation')
    .stringParam('sessionId', 'Session ID to end (uses active session if not specified)')
    .stringParam('outputFormat', 'Output format', {
        enum: ['playwright', 'bdd', 'both'],
        default: 'both',
    })
    .booleanParam('includePageObjects', 'Include page object generation', { default: true })
    .stringParam('pageName', 'Name for generated page object class', { default: 'RecordedPage' })
    .handler(async (params, context) => {
        const sessionId = (params.sessionId as string) || activeSessionId;

        if (!sessionId) {
            return createErrorResult('No session specified and no active session.');
        }

        const session = codegenSessions.get(sessionId);
        if (!session) {
            return createErrorResult(`Session ${sessionId} not found.`);
        }

        session.endTime = Date.now();

        if (sessionId === activeSessionId) {
            activeSessionId = null;
        }

        CSReporter.info(`[MCP] Ending codegen session: ${sessionId}`);

        const outputFormat = (params.outputFormat as string) || 'both';
        const includePageObjects = params.includePageObjects !== false;
        const pageName = (params.pageName as string) || 'RecordedPage';

        const result: any = {
            sessionId,
            status: 'completed',
            duration: session.endTime - session.startTime,
            actionsRecorded: session.actions.length,
            actions: session.actions,
            generatedCode: {},
        };

        // Generate Playwright code
        if (outputFormat === 'playwright' || outputFormat === 'both') {
            result.generatedCode.playwright = generatePlaywrightCode(session);
        }

        // Generate BDD/Gherkin
        if (outputFormat === 'bdd' || outputFormat === 'both') {
            result.generatedCode.feature = generateBDDFeature(session);
            result.generatedCode.stepDefinitions = generateStepDefinitions(session);
        }

        // Generate page objects
        if (includePageObjects) {
            result.generatedCode.pageObject = generatePageObject(session, pageName);
        }

        CSReporter.pass(`[MCP] Codegen session completed: ${session.actions.length} actions recorded`);

        return createJsonResult(result);
    })
    .build();

// ============================================================================
// Codegen Get Session Tool
// ============================================================================

const codegenGetSession = defineTool()
    .name('codegen_get_session')
    .description('Get information about a codegen session')
    .category('generation')
    .stringParam('sessionId', 'Session ID (uses active session if not specified)')
    .handler(async (params, context) => {
        const sessionId = (params.sessionId as string) || activeSessionId;

        if (!sessionId) {
            return createJsonResult({
                activeSession: null,
                totalSessions: codegenSessions.size,
                sessions: Array.from(codegenSessions.keys()),
            });
        }

        const session = codegenSessions.get(sessionId);
        if (!session) {
            return createErrorResult(`Session ${sessionId} not found.`);
        }

        return createJsonResult({
            sessionId: session.id,
            status: session.endTime ? 'completed' : 'recording',
            startTime: new Date(session.startTime).toISOString(),
            endTime: session.endTime ? new Date(session.endTime).toISOString() : null,
            duration: session.endTime
                ? session.endTime - session.startTime
                : Date.now() - session.startTime,
            baseUrl: session.baseUrl,
            actionsRecorded: session.actions.length,
            options: session.options,
            actions: session.actions,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Codegen to BDD Tool
// ============================================================================

const codegenToBDD = defineTool()
    .name('codegen_to_bdd')
    .description('Convert recorded actions or Playwright code to BDD/Gherkin format')
    .category('generation')
    .stringParam('sessionId', 'Session ID to convert')
    .stringParam('playwrightCode', 'Playwright code to convert (alternative to sessionId)')
    .stringParam('featureName', 'Name for the feature', { default: 'Converted Feature' })
    .stringParam('scenarioName', 'Name for the scenario', { default: 'Converted Scenario' })
    .handler(async (params, context) => {
        CSReporter.info('[MCP] Converting to BDD format');

        let actions: RecordedAction[] = [];

        // Get actions from session
        if (params.sessionId) {
            const session = codegenSessions.get(params.sessionId as string);
            if (session) {
                actions = session.actions;
            } else {
                return createErrorResult(`Session ${params.sessionId} not found.`);
            }
        }
        // Parse actions from Playwright code
        else if (params.playwrightCode) {
            const code = params.playwrightCode as string;
            const lines = code.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();

                // Parse page.goto
                const gotoMatch = trimmed.match(/page\.goto\(['"]([^'"]+)['"]\)/);
                if (gotoMatch) {
                    actions.push({ timestamp: Date.now(), type: 'navigate', url: gotoMatch[1] });
                    continue;
                }

                // Parse page.click
                const clickMatch = trimmed.match(/page\.(getBy\w+\([^)]+\)|locator\([^)]+\))\.click\(\)/);
                if (clickMatch) {
                    actions.push({ timestamp: Date.now(), type: 'click', locator: clickMatch[1], description: 'element' });
                    continue;
                }

                // Parse page.fill
                const fillMatch = trimmed.match(/page\.(getBy\w+\([^)]+\)|locator\([^)]+\))\.fill\(['"]([^'"]+)['"]\)/);
                if (fillMatch) {
                    actions.push({ timestamp: Date.now(), type: 'fill', locator: fillMatch[1], value: fillMatch[2], description: 'field' });
                    continue;
                }

                // Parse expect assertions
                const expectMatch = trimmed.match(/expect\(page\.(getBy\w+\([^)]+\)|locator\([^)]+\))\)\.(\w+)\(/);
                if (expectMatch) {
                    actions.push({ timestamp: Date.now(), type: 'assertion', locator: expectMatch[1], description: `${expectMatch[2]}` });
                    continue;
                }
            }
        } else {
            return createErrorResult('Provide either sessionId or playwrightCode to convert.');
        }

        if (actions.length === 0) {
            return createErrorResult('No actions found to convert.');
        }

        // Create a temporary session for conversion
        const tempSession: CodegenSession = {
            id: 'temp',
            startTime: Date.now(),
            baseUrl: '',
            actions,
            options: {
                language: 'typescript',
                testFramework: 'bdd',
                generatePageObjects: false,
                generateAssertions: false,
            },
        };

        const feature = generateBDDFeature(tempSession);
        const stepDefinitions = generateStepDefinitions(tempSession);

        CSReporter.pass(`[MCP] Converted ${actions.length} actions to BDD format`);

        return createJsonResult({
            actionsConverted: actions.length,
            feature,
            stepDefinitions,
        });
    })
    .build();

// ============================================================================
// Codegen Clear Sessions Tool
// ============================================================================

const codegenClearSessions = defineTool()
    .name('codegen_clear_sessions')
    .description('Clear all codegen sessions')
    .category('generation')
    .booleanParam('keepActive', 'Keep the active session', { default: false })
    .handler(async (params, context) => {
        const keepActive = params.keepActive as boolean;
        const sessionCount = codegenSessions.size;

        if (keepActive && activeSessionId) {
            const activeSession = codegenSessions.get(activeSessionId);
            codegenSessions.clear();
            if (activeSession) {
                codegenSessions.set(activeSessionId, activeSession);
            }
        } else {
            codegenSessions.clear();
            activeSessionId = null;
        }

        CSReporter.pass(`[MCP] Cleared ${keepActive ? sessionCount - 1 : sessionCount} codegen sessions`);

        return createJsonResult({
            cleared: keepActive ? sessionCount - 1 : sessionCount,
            remaining: codegenSessions.size,
            activeSession: activeSessionId,
        });
    })
    .build();

// ============================================================================
// Export all codegen tools
// ============================================================================

export const codegenTools: MCPToolDefinition[] = [
    codegenStart,
    codegenRecordAction,
    codegenEnd,
    codegenGetSession,
    codegenToBDD,
    codegenClearSessions,
];

/**
 * Register all codegen tools with the registry
 */
export function registerCodegenTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(codegenTools);
}

/**
 * Get the active codegen session ID
 */
export function getActiveCodegenSession(): string | null {
    return activeSessionId;
}

/**
 * Record an action to the active session (called by browser tools)
 */
export function recordActionToSession(action: RecordedAction): boolean {
    if (!activeSessionId) return false;

    const session = codegenSessions.get(activeSessionId);
    if (!session || session.endTime) return false;

    session.actions.push(action);
    return true;
}
