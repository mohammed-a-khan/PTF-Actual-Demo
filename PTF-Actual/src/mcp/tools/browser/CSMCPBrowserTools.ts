/**
 * PTF-ADO MCP Browser Tools
 * Browser automation tools with EXACT feature parity to official @playwright/mcp
 *
 * Key difference: Official @playwright/mcp uses internal Playwright APIs (aria-ref, _snapshotForAI)
 * This implementation uses public Playwright APIs with equivalent functionality.
 *
 * @module CSMCPBrowserTools
 */

import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
    MCPImageContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// Lazy load framework components
let CSBrowserManager: any = null;
let CSWebElement: any = null;
let CSReporter: any = null;
let CSConfigurationManager: any = null;

// ============================================================================
// Module-level State (Browser Persistence)
// ============================================================================

interface ModuleBrowserState {
    browser: any;
    context: any;
    page: any;
    manager: any;
    isLaunched: boolean;
}

let moduleBrowserState: ModuleBrowserState = {
    browser: null,
    context: null,
    page: null,
    manager: null,
    isLaunched: false,
};

// ============================================================================
// Element Reference Store (Replaces official @playwright/mcp's internal aria-ref)
// ============================================================================

interface ElementRefData {
    // Core identification
    ref: string;           // e.g., "e1", "e2", etc.
    role: string;          // ARIA role
    name: string;          // Accessible name

    // Locator strategies (multiple for robustness)
    roleLocator?: string;  // e.g., "getByRole('button', { name: 'Login' })"
    textLocator?: string;  // e.g., "getByText('Login')"
    labelLocator?: string; // e.g., "getByLabel('Username')"
    testIdLocator?: string; // e.g., "getByTestId('login-btn')"
    cssSelector?: string;  // Fallback CSS selector

    // Element state
    tagName: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    expanded?: boolean;
    pressed?: boolean;
    required?: boolean;

    // Visual info (for debugging)
    boundingBox?: { x: number; y: number; width: number; height: number };
}

// Global ref store - persists across tool calls within a session
const elementRefStore: Map<string, ElementRefData> = new Map();
let refCounter = 1;

/**
 * Reset the ref store (called on new snapshot)
 */
function resetRefStore(): void {
    elementRefStore.clear();
    refCounter = 1;
}

/**
 * Generate next ref ID
 */
function nextRef(): string {
    return `e${refCounter++}`;
}

/**
 * Store element reference data
 */
function storeElementRef(data: ElementRefData): void {
    elementRefStore.set(data.ref, data);
}

/**
 * Get locator for an element by ref
 * This is the key function that replaces the official aria-ref locator
 */
function getLocatorByRef(page: any, ref: string, elementDescription: string): any {
    const refData = elementRefStore.get(ref);

    if (!refData) {
        throw new Error(`Element ref '${ref}' not found in snapshot. Take a new browser_snapshot first.`);
    }

    // Try locators in order of reliability
    try {
        // 1. First try role + name (most reliable for accessibility)
        if (refData.role && refData.name && refData.role !== 'generic' && refData.role !== 'none') {
            const roleOptions: any = { name: refData.name };
            const locator = page.getByRole(refData.role, roleOptions);
            return locator.first();
        }

        // 2. Try testId if available
        if (refData.testIdLocator) {
            const testId = refData.testIdLocator.match(/getByTestId\('([^']+)'\)/)?.[1];
            if (testId) {
                return page.getByTestId(testId).first();
            }
        }

        // 3. Try label locator
        if (refData.labelLocator) {
            const label = refData.labelLocator.match(/getByLabel\('([^']+)'\)/)?.[1];
            if (label) {
                return page.getByLabel(label).first();
            }
        }

        // 4. Try text locator
        if (refData.textLocator && refData.name) {
            return page.getByText(refData.name, { exact: false }).first();
        }

        // 5. Fallback to CSS selector
        if (refData.cssSelector) {
            return page.locator(refData.cssSelector).first();
        }

        // 6. Last resort: role only
        if (refData.role && refData.role !== 'generic' && refData.role !== 'none') {
            return page.getByRole(refData.role).first();
        }

        throw new Error(`No valid locator found for ref '${ref}'`);
    } catch (error: any) {
        throw new Error(`Failed to locate element '${elementDescription}' [ref=${ref}]: ${error.message}`);
    }
}

// ============================================================================
// Framework Loading
// ============================================================================

function ensureFrameworkLoaded(): void {
    if (!CSBrowserManager) {
        CSBrowserManager = require('../../../browser/CSBrowserManager').CSBrowserManager;
    }
    if (!CSWebElement) {
        CSWebElement = require('../../../element/CSWebElement').CSWebElement;
    }
    if (!CSReporter) {
        CSReporter = require('../../../reporter/CSReporter').CSReporter;
    }
    if (!CSConfigurationManager) {
        CSConfigurationManager = require('../../../core/CSConfigurationManager').CSConfigurationManager;
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

function createImageResult(base64: string, mimeType: string = 'image/png'): MCPToolResult {
    return {
        content: [{
            type: 'image',
            data: base64,
            mimeType,
        } as MCPImageContent],
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

function getBrowserManager(): any {
    ensureFrameworkLoaded();
    return CSBrowserManager.getInstance();
}

/**
 * Get current page, auto-launching browser if needed
 */
async function getPageAsync(context: MCPToolContext): Promise<any> {
    // Check module-level state first
    if (moduleBrowserState.isLaunched && moduleBrowserState.page) {
        try {
            await (moduleBrowserState.page as any).evaluate(() => true);
            return moduleBrowserState.page;
        } catch (e) {
            console.log('[MCP] Page was closed, relaunching...');
            moduleBrowserState.isLaunched = false;
        }
    }

    // Check server context
    if (context.server.browser?.page) {
        try {
            await (context.server.browser.page as any).evaluate(() => true);
            return context.server.browser.page;
        } catch (e) {
            // Page was closed
        }
    }

    // Try CSBrowserManager
    try {
        const browserManager = getBrowserManager();
        const page = browserManager.getPage();
        if (page) {
            await page.evaluate(() => true);
            moduleBrowserState = {
                browser: browserManager.getBrowser(),
                context: browserManager.getContext(),
                page: page,
                manager: browserManager,
                isLaunched: true,
            };
            return page;
        }
    } catch (error) {
        // Browser not launched yet
    }

    // Auto-launch browser
    console.log('[MCP] Auto-launching browser...');
    const browserManager = getBrowserManager();
    await browserManager.launch('chrome');

    const page = browserManager.getPage();
    const browserContext = browserManager.getContext();
    const browser = browserManager.getBrowser();

    moduleBrowserState = {
        browser: browser,
        context: browserContext,
        page: page,
        manager: browserManager,
        isLaunched: true,
    };

    context.server.browser = {
        manager: browserManager,
        page: page,
        context: browserContext,
        browser: browser,
    };

    return page;
}

/**
 * Sync version for backwards compatibility
 */
function getPage(context: MCPToolContext): any {
    if (moduleBrowserState.isLaunched && moduleBrowserState.page) {
        return moduleBrowserState.page;
    }
    if (context.server.browser?.page) {
        return context.server.browser.page;
    }
    try {
        const browserManager = getBrowserManager();
        const page = browserManager.getPage();
        if (page) {
            moduleBrowserState = {
                browser: browserManager.getBrowser(),
                context: browserManager.getContext(),
                page: page,
                manager: browserManager,
                isLaunched: true,
            };
            return page;
        }
    } catch (error) {
        // Fall through
    }
    throw new Error('No browser page available. Use browser_launch or browser_navigate first.');
}

function createElement(selector: string, description?: string): any {
    ensureFrameworkLoaded();
    const isXPath = selector.startsWith('//') || selector.startsWith('(//');
    const options: any = { description: description || `Element: ${selector}` };
    if (isXPath) {
        options.xpath = selector;
    } else {
        options.css = selector;
    }
    return new CSWebElement(options);
}

// ============================================================================
// Accessibility Tree Processing (Replaces _snapshotForAI)
// ============================================================================

interface AccessibilityNode {
    role: string;
    name?: string;
    value?: string;
    checked?: boolean;
    pressed?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    required?: boolean;
    children?: AccessibilityNode[];
}

/**
 * Process accessibility tree and build ref store
 * This replaces the official _snapshotForAI internal API
 */
async function processAccessibilityTree(
    page: any,
    node: AccessibilityNode,
    parentPath: string = '',
    depth: number = 0
): Promise<string[]> {
    if (!node) return [];

    const lines: string[] = [];
    const indent = '  '.repeat(depth);

    // Skip generic/none roles unless they have meaningful content
    const isInteresting = node.role &&
        node.role !== 'none' &&
        node.role !== 'generic' &&
        node.role !== 'StaticText' &&
        node.role !== 'InlineTextBox';

    if (isInteresting) {
        const ref = nextRef();

        // Build the display line
        let line = `${indent}- ${node.role}`;
        if (node.name) {
            line += ` "${node.name}"`;
        }
        line += ` [ref=${ref}]`;

        // Add state indicators
        if (node.value !== undefined) line += ` value="${node.value}"`;
        if (node.checked !== undefined) line += ` checked=${node.checked}`;
        if (node.pressed !== undefined) line += ` pressed=${node.pressed}`;
        if (node.expanded !== undefined) line += ` expanded=${node.expanded}`;
        if (node.disabled) line += ` disabled`;
        if (node.required) line += ` required`;

        lines.push(line);

        // Store ref data with locator strategies
        const refData: ElementRefData = {
            ref,
            role: node.role,
            name: node.name || '',
            tagName: roleToTag(node.role),
            value: node.value,
            checked: node.checked,
            disabled: node.disabled,
            expanded: node.expanded,
            pressed: node.pressed,
            required: node.required,
        };

        // Build locator strategies
        if (node.role && node.name) {
            refData.roleLocator = `getByRole('${node.role}', { name: '${escapeString(node.name)}' })`;
        }
        if (node.name) {
            refData.textLocator = `getByText('${escapeString(node.name)}')`;
        }

        // Build CSS selector as fallback
        const tag = roleToTag(node.role);
        if (tag) {
            if (node.name) {
                // Try to build a specific CSS selector
                const escapedName = node.name.replace(/'/g, "\\'");
                refData.cssSelector = `${tag}:has-text("${escapedName}")`;
            } else {
                refData.cssSelector = tag;
            }
        }

        storeElementRef(refData);
    }

    // Process children
    if (node.children) {
        for (const child of node.children) {
            const childLines = await processAccessibilityTree(page, child, parentPath, depth + (isInteresting ? 1 : 0));
            lines.push(...childLines);
        }
    }

    return lines;
}

/**
 * Map ARIA role to HTML tag
 */
function roleToTag(role: string): string {
    const roleTagMap: Record<string, string> = {
        'button': 'button',
        'link': 'a',
        'textbox': 'input',
        'checkbox': 'input[type="checkbox"]',
        'radio': 'input[type="radio"]',
        'combobox': 'select',
        'listbox': 'select',
        'option': 'option',
        'heading': 'h1,h2,h3,h4,h5,h6',
        'img': 'img',
        'table': 'table',
        'row': 'tr',
        'cell': 'td',
        'columnheader': 'th',
        'list': 'ul,ol',
        'listitem': 'li',
        'navigation': 'nav',
        'main': 'main',
        'banner': 'header',
        'contentinfo': 'footer',
        'form': 'form',
        'search': 'input[type="search"]',
        'searchbox': 'input[type="search"]',
        'spinbutton': 'input[type="number"]',
        'slider': 'input[type="range"]',
        'progressbar': 'progress',
        'dialog': 'dialog',
        'alertdialog': 'dialog',
        'menu': 'menu',
        'menubar': 'nav',
        'menuitem': 'button',
        'tab': 'button[role="tab"]',
        'tablist': 'div[role="tablist"]',
        'tabpanel': 'div[role="tabpanel"]',
        'tree': 'ul[role="tree"]',
        'treeitem': 'li[role="treeitem"]',
        'grid': 'table',
        'gridcell': 'td',
        'article': 'article',
        'region': 'section',
        'group': 'div',
    };
    return roleTagMap[role] || 'div';
}

function escapeString(str: string): string {
    return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ============================================================================
// Browser Lifecycle Tools
// ============================================================================

const browserLaunch = defineTool()
    .name('browser_launch')
    .description('Launch a new browser instance')
    .category('browser')
    .stringParam('browserType', 'Browser type to launch', {
        enum: ['chrome', 'chromium', 'firefox', 'webkit', 'edge', 'safari'],
        default: 'chrome',
    })
    .booleanParam('headless', 'Run in headless mode')
    .objectParam('viewport', 'Viewport size', {
        width: { type: 'integer', description: 'Viewport width' },
        height: { type: 'integer', description: 'Viewport height' },
    })
    .stringParam('device', 'Device to emulate (e.g., "iPhone 15 Pro", "Pixel 7")')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const browserManager = getBrowserManager();
        const config = CSConfigurationManager.getInstance();

        context.log('info', 'Launching browser', params);
        CSReporter.info(`[MCP] Launching browser: ${params.browserType || 'chrome'}`);

        try {
            if (params.headless !== undefined) {
                process.env.HEADLESS = params.headless ? 'true' : 'false';
            }

            if (params.viewport) {
                const vp = params.viewport as { width?: number; height?: number };
                if (vp.width) process.env.BROWSER_VIEWPORT_WIDTH = String(vp.width);
                if (vp.height) process.env.BROWSER_VIEWPORT_HEIGHT = String(vp.height);
            }

            await browserManager.launch(params.browserType as string || 'chrome');

            context.server.browser = {
                manager: browserManager,
                page: browserManager.getPage(),
                context: browserManager.getContext(),
                browser: browserManager.getBrowser(),
            };

            // Update module state
            moduleBrowserState = {
                browser: browserManager.getBrowser(),
                context: browserManager.getContext(),
                page: browserManager.getPage(),
                manager: browserManager,
                isLaunched: true,
            };

            const page = browserManager.getPage();
            const currentUrl = page.url();

            CSReporter.pass(`[MCP] Browser launched successfully`);

            return createJsonResult({
                status: 'launched',
                browserType: browserManager.getCurrentBrowserType(),
                headless: config.getBoolean('HEADLESS', false),
                viewport: params.viewport || {
                    width: config.getNumber('BROWSER_VIEWPORT_WIDTH', 1920),
                    height: config.getNumber('BROWSER_VIEWPORT_HEIGHT', 1080),
                },
                url: currentUrl,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Browser launch failed: ${error.message}`);
            return createErrorResult(`Failed to launch browser: ${error.message}`);
        }
    })
    .build();

const browserClose = defineTool()
    .name('browser_close')
    .description('Close the current browser instance')
    .category('browser')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Closing browser');
        CSReporter.info('[MCP] Closing browser');

        try {
            const browserManager = getBrowserManager();
            await browserManager.closeAll();

            // Clear all state
            moduleBrowserState = {
                browser: null,
                context: null,
                page: null,
                manager: null,
                isLaunched: false,
            };

            if (context.server.browser) {
                context.server.browser = undefined;
            }

            // Clear ref store
            resetRefStore();

            CSReporter.pass('[MCP] Browser closed successfully');
            return createTextResult('Browser closed successfully');
        } catch (error: any) {
            CSReporter.warn(`[MCP] Error closing browser: ${error.message}`);
            return createErrorResult(`Failed to close browser: ${error.message}`);
        }
    })
    .destructive()
    .build();

const browserSwitchBrowser = defineTool()
    .name('browser_switch_browser')
    .description('Switch to a different browser type')
    .category('browser')
    .stringParam('browserType', 'Target browser type', {
        enum: ['chrome', 'chromium', 'firefox', 'webkit', 'edge', 'safari'],
        required: true,
    })
    .booleanParam('preserveUrl', 'Navigate to current URL after switch', { default: true })
    .booleanParam('clearState', 'Clear cookies/storage after switch', { default: false })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const browserManager = getBrowserManager();
        CSReporter.info(`[MCP] Switching browser to: ${params.browserType}`);

        try {
            await browserManager.switchBrowser(params.browserType as string, {
                preserveUrl: params.preserveUrl !== false,
                clearState: params.clearState === true,
            });

            context.server.browser = {
                manager: browserManager,
                page: browserManager.getPage(),
                context: browserManager.getContext(),
                browser: browserManager.getBrowser(),
            };

            moduleBrowserState = {
                browser: browserManager.getBrowser(),
                context: browserManager.getContext(),
                page: browserManager.getPage(),
                manager: browserManager,
                isLaunched: true,
            };

            // Clear ref store since page changed
            resetRefStore();

            CSReporter.pass(`[MCP] Switched to ${params.browserType}`);
            return createJsonResult({
                status: 'switched',
                browserType: browserManager.getCurrentBrowserType(),
                url: browserManager.getPage().url(),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Browser switch failed: ${error.message}`);
            return createErrorResult(`Failed to switch browser: ${error.message}`);
        }
    })
    .build();

const browserNewContext = defineTool()
    .name('browser_new_context')
    .description('Clear browser context and prepare for re-authentication')
    .category('browser')
    .stringParam('loginUrl', 'URL to navigate to after clearing')
    .booleanParam('skipNavigation', 'Skip navigation after clearing', { default: false })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const browserManager = getBrowserManager();
        CSReporter.info('[MCP] Clearing browser context');

        try {
            await browserManager.clearContextAndReauthenticate({
                loginUrl: params.loginUrl as string,
                skipNavigation: params.skipNavigation === true,
            });

            context.server.browser = {
                manager: browserManager,
                page: browserManager.getPage(),
                context: browserManager.getContext(),
                browser: browserManager.getBrowser(),
            };

            moduleBrowserState = {
                browser: browserManager.getBrowser(),
                context: browserManager.getContext(),
                page: browserManager.getPage(),
                manager: browserManager,
                isLaunched: true,
            };

            // Clear ref store since context changed
            resetRefStore();

            CSReporter.pass('[MCP] Context cleared successfully');
            return createJsonResult({
                status: 'context_cleared',
                url: browserManager.getPage().url(),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Context clear failed: ${error.message}`);
            return createErrorResult(`Failed to clear context: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Navigation Tools
// ============================================================================

const browserNavigate = defineTool()
    .name('browser_navigate')
    .description('Navigate to a URL')
    .category('browser')
    .stringParam('url', 'URL to navigate to', { required: true })
    .stringParam('waitUntil', 'When to consider navigation complete', {
        enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
        default: 'load',
    })
    .numberParam('timeout', 'Navigation timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const url = params.url as string;

        context.log('info', `Navigating to ${url}`);
        CSReporter.info(`[MCP] Navigating to: ${url}`);

        // Clear ref store since page is changing
        resetRefStore();

        try {
            await page.goto(url, {
                waitUntil: params.waitUntil || 'load',
                timeout: params.timeout || 30000,
            });

            const title = await page.title();
            const currentUrl = page.url();

            CSReporter.pass(`[MCP] Navigation complete: ${currentUrl}`);
            return createJsonResult({
                status: 'navigated',
                url: currentUrl,
                title,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Navigation failed: ${error.message}`);
            return createErrorResult(`Navigation failed: ${error.message}`);
        }
    })
    .build();

const browserBack = defineTool()
    .name('browser_back')
    .description('Navigate back in browser history (browser_navigate_back equivalent)')
    .category('browser')
    .handler(async (params, context) => {
        const page = getPage(context);
        resetRefStore();
        await page.goBack();
        return createJsonResult({
            status: 'navigated_back',
            url: page.url(),
        });
    })
    .build();

const browserForward = defineTool()
    .name('browser_forward')
    .description('Navigate forward in browser history')
    .category('browser')
    .handler(async (params, context) => {
        const page = getPage(context);
        resetRefStore();
        await page.goForward();
        return createJsonResult({
            status: 'navigated_forward',
            url: page.url(),
        });
    })
    .build();

const browserReload = defineTool()
    .name('browser_reload')
    .description('Reload the current page')
    .category('browser')
    .handler(async (params, context) => {
        const page = getPage(context);
        resetRefStore();
        await page.reload();
        return createJsonResult({
            status: 'reloaded',
            url: page.url(),
        });
    })
    .build();

// ============================================================================
// Snapshot Tool - Core functionality (Official MCP Parity)
// ============================================================================

const browserSnapshot = defineTool()
    .name('browser_snapshot')
    .description('Capture accessibility snapshot of the current page. Returns element refs like [ref=e1] for use with interaction tools. This is better than screenshot for understanding page structure.')
    .category('browser')
    .stringParam('filename', 'Optional file to save snapshot output')
    .handler(async (params, context) => {
        const page = await getPageAsync(context);

        context.log('info', 'Taking accessibility snapshot');

        try {
            // Reset ref store for new snapshot
            resetRefStore();

            // Wait for page to be ready before taking snapshot
            await page.waitForLoadState('domcontentloaded');

            // Get accessibility snapshot using modern Playwright API (locator.ariaSnapshot)
            const ariaSnapshot = await page.locator('body').ariaSnapshot();

            if (!ariaSnapshot || ariaSnapshot.trim() === '') {
                return createErrorResult('No accessibility tree available for this page');
            }

            // Parse ariaSnapshot and build ref store
            // Format: "- role \"name\" [attributes]" or "- role: text" with indentation for nesting
            const lines = ariaSnapshot.split('\n');
            const outputLines: string[] = [];

            for (const line of lines) {
                // Parse line: "- role \"name\"" or "  - role \"name\"" or "- role: text"
                const indentMatch = line.match(/^(\s*)-\s+/);
                if (!indentMatch) {
                    outputLines.push(line);
                    continue;
                }

                const indent = indentMatch[1];
                const content = line.substring(indentMatch[0].length);

                // Parse role and name
                // Patterns:
                //   role "name" [attrs]
                //   role: text
                //   role
                let role = '';
                let name = '';
                let rest = content;

                // Check for quoted name: role "name"
                const quotedMatch = content.match(/^(\w+)\s+"([^"]+)"(.*)$/);
                if (quotedMatch) {
                    role = quotedMatch[1];
                    name = quotedMatch[2];
                    rest = quotedMatch[3];
                } else {
                    // Check for colon format: role: text
                    const colonMatch = content.match(/^(\w+):\s*(.*)$/);
                    if (colonMatch) {
                        role = colonMatch[1];
                        name = colonMatch[2];
                        rest = '';
                    } else {
                        // Just role
                        const roleMatch = content.match(/^(\w+)(.*)$/);
                        if (roleMatch) {
                            role = roleMatch[1];
                            rest = roleMatch[2];
                        }
                    }
                }

                // Skip non-interactive elements
                const interactiveRoles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
                    'listbox', 'option', 'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox'];

                if (interactiveRoles.includes(role)) {
                    const ref = nextRef();

                    // Store ref data
                    const refData: ElementRefData = {
                        ref,
                        role,
                        name: name || '',
                        tagName: roleToTag(role),
                    };

                    if (role && name) {
                        refData.roleLocator = `getByRole('${role}', { name: '${escapeString(name)}' })`;
                    }
                    if (name) {
                        refData.textLocator = `getByText('${escapeString(name)}')`;
                    }

                    storeElementRef(refData);

                    // Add ref to output line
                    outputLines.push(`${indent}- ${role}${name ? ` "${name}"` : ''}${rest} [ref=${ref}]`);
                } else {
                    // Keep non-interactive elements in output but without ref
                    outputLines.push(line);
                }
            }

            const snapshotContent = outputLines.join('\n');

            // Save to file if requested
            if (params.filename) {
                const fs = require('fs');
                fs.writeFileSync(params.filename as string, snapshotContent);
            }

            // Get page info
            const url = page.url();
            const title = await page.title();

            return createJsonResult({
                content: snapshotContent,
                url,
                title,
                elementCount: elementRefStore.size,
                message: `Snapshot captured with ${elementRefStore.size} interactive elements. Use refs like [ref=e1] with interaction tools.`,
            });
        } catch (error: any) {
            return createErrorResult(`Snapshot failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Screenshot Tool (Official MCP Parity)
// ============================================================================

const browserScreenshot = defineTool()
    .name('browser_take_screenshot')
    .description('Take a screenshot of the current page or a specific element')
    .category('browser')
    .stringParam('type', 'Image format', { enum: ['png', 'jpeg'], default: 'png' })
    .stringParam('filename', 'Optional file path to save screenshot')
    .stringParam('element', 'Human-readable element description (for element screenshot)')
    .stringParam('ref', 'Exact target element reference from page snapshot')
    .booleanParam('fullPage', 'Capture full scrollable page', { default: false })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);

        context.log('info', 'Taking screenshot');
        CSReporter.info('[MCP] Taking screenshot');

        try {
            let buffer: Buffer;

            if (params.ref) {
                const locator = getLocatorByRef(page, params.ref as string, params.element as string || 'element');
                buffer = await locator.screenshot({
                    type: (params.type as 'png' | 'jpeg') || 'png',
                });
            } else {
                buffer = await page.screenshot({
                    fullPage: params.fullPage === true,
                    type: (params.type as 'png' | 'jpeg') || 'png',
                });
            }

            if (params.filename) {
                const fs = require('fs');
                fs.writeFileSync(params.filename as string, buffer);
            }

            const base64 = buffer.toString('base64');
            const mimeType = params.type === 'jpeg' ? 'image/jpeg' : 'image/png';

            CSReporter.pass('[MCP] Screenshot captured');
            return createImageResult(base64, mimeType);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Screenshot failed: ${error.message}`);
            return createErrorResult(`Screenshot failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Interaction Tools (Official MCP Parity - element + ref pattern)
// ============================================================================

const browserClick = defineTool()
    .name('browser_click')
    .description('Click on a web element. Requires element description and ref from browser_snapshot.')
    .category('browser')
    .stringParam('element', 'Human-readable element description (for audit/permission)', { required: true })
    .stringParam('ref', 'Element reference from page snapshot (e.g., "e1")', { required: true })
    .booleanParam('doubleClick', 'Perform double click', { default: false })
    .stringParam('button', 'Mouse button', { enum: ['left', 'right', 'middle'], default: 'left' })
    .stringParam('modifiers', 'Modifier keys (comma-separated: Alt,Control,Meta,Shift)')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const ref = params.ref as string;
        const elementDesc = params.element as string;

        context.log('info', `Clicking element: ${elementDesc} [ref=${ref}]`);
        CSReporter.info(`[MCP] Clicking: ${elementDesc}`);

        try {
            const locator = getLocatorByRef(page, ref, elementDesc);

            const modifiers: string[] = params.modifiers
                ? (params.modifiers as string).split(',').map((m: string) => m.trim())
                : [];

            if (params.doubleClick) {
                await locator.dblclick({
                    button: (params.button as 'left' | 'right' | 'middle') || 'left',
                    modifiers: modifiers as ('Alt' | 'Control' | 'Meta' | 'Shift')[],
                });
            } else {
                await locator.click({
                    button: (params.button as 'left' | 'right' | 'middle') || 'left',
                    modifiers: modifiers as ('Alt' | 'Control' | 'Meta' | 'Shift')[],
                });
            }

            CSReporter.pass(`[MCP] Clicked: ${elementDesc}`);
            return createTextResult(`Clicked "${elementDesc}" [ref=${ref}]`);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Click failed: ${error.message}`);
            return createErrorResult(`Click failed: ${error.message}`);
        }
    })
    .build();

const browserType = defineTool()
    .name('browser_type')
    .description('Type text into an input element. Requires element description and ref from browser_snapshot.')
    .category('browser')
    .stringParam('element', 'Human-readable element description (for audit/permission)', { required: true })
    .stringParam('ref', 'Element reference from page snapshot (e.g., "e1")', { required: true })
    .stringParam('text', 'Text to type', { required: true })
    .booleanParam('submit', 'Press Enter after typing', { default: false })
    .booleanParam('slowly', 'Type one character at a time with delays', { default: false })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const ref = params.ref as string;
        const elementDesc = params.element as string;
        const text = params.text as string;

        context.log('info', `Typing into element: ${elementDesc} [ref=${ref}]`);
        CSReporter.info(`[MCP] Typing into: ${elementDesc}`);

        try {
            const locator = getLocatorByRef(page, ref, elementDesc);

            if (params.slowly) {
                await locator.pressSequentially(text, { delay: 50 });
            } else {
                await locator.fill(text);
            }

            if (params.submit) {
                await locator.press('Enter');
            }

            CSReporter.pass(`[MCP] Typed into: ${elementDesc}`);
            return createTextResult(`Typed "${text}" into "${elementDesc}" [ref=${ref}]`);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Type failed: ${error.message}`);
            return createErrorResult(`Type failed: ${error.message}`);
        }
    })
    .build();

const browserSelectOption = defineTool()
    .name('browser_select_option')
    .description('Select option(s) in a dropdown. Requires element description and ref from browser_snapshot.')
    .category('browser')
    .stringParam('element', 'Human-readable element description', { required: true })
    .stringParam('ref', 'Element reference from page snapshot', { required: true })
    .stringParam('values', 'Value(s) to select (JSON array for multi-select, or single string)', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const ref = params.ref as string;
        const elementDesc = params.element as string;

        context.log('info', `Selecting option: ${elementDesc} [ref=${ref}]`);
        CSReporter.info(`[MCP] Selecting option: ${elementDesc}`);

        try {
            const locator = getLocatorByRef(page, ref, elementDesc);

            let values: string[];
            try {
                values = JSON.parse(params.values as string);
            } catch {
                values = [params.values as string];
            }

            const selected = await locator.selectOption(values);

            CSReporter.pass(`[MCP] Selected option: ${elementDesc}`);
            return createJsonResult({
                status: 'selected',
                element: elementDesc,
                ref: ref,
                selectedValues: selected,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Select failed: ${error.message}`);
            return createErrorResult(`Select failed: ${error.message}`);
        }
    })
    .build();

const browserHover = defineTool()
    .name('browser_hover')
    .description('Hover over an element. Requires element description and ref from browser_snapshot.')
    .category('browser')
    .stringParam('element', 'Human-readable element description', { required: true })
    .stringParam('ref', 'Element reference from page snapshot', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const ref = params.ref as string;
        const elementDesc = params.element as string;

        CSReporter.info(`[MCP] Hovering: ${elementDesc}`);

        try {
            const locator = getLocatorByRef(page, ref, elementDesc);
            await locator.hover();

            CSReporter.pass(`[MCP] Hovered: ${elementDesc}`);
            return createTextResult(`Hovered over "${elementDesc}" [ref=${ref}]`);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Hover failed: ${error.message}`);
            return createErrorResult(`Hover failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const browserPressKey = defineTool()
    .name('browser_press_key')
    .description('Press a key on the keyboard (e.g., "Enter", "Tab", "Escape", "Control+A")')
    .category('browser')
    .stringParam('key', 'Key to press', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const key = params.key as string;

        CSReporter.info(`[MCP] Pressing key: ${key}`);

        try {
            await page.keyboard.press(key);

            CSReporter.pass(`[MCP] Pressed key: ${key}`);
            return createTextResult(`Pressed key: ${key}`);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Press key failed: ${error.message}`);
            return createErrorResult(`Press key failed: ${error.message}`);
        }
    })
    .build();

const browserFileUpload = defineTool()
    .name('browser_file_upload')
    .description('Upload one or multiple files. Provide absolute file paths.')
    .category('browser')
    .stringParam('paths', 'File paths to upload (JSON array or single path)', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const pathsInput = params.paths as string;

        let filePaths: string[];
        try {
            filePaths = JSON.parse(pathsInput);
        } catch {
            filePaths = [pathsInput];
        }

        CSReporter.info(`[MCP] Uploading files: ${filePaths.join(', ')}`);

        try {
            // Wait for file chooser and set files
            const fileInput = page.locator('input[type="file"]').first();
            await fileInput.setInputFiles(filePaths);

            CSReporter.pass(`[MCP] Uploaded: ${filePaths.length} file(s)`);
            return createJsonResult({
                status: 'uploaded',
                files: filePaths,
                count: filePaths.length,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Upload failed: ${error.message}`);
            return createErrorResult(`Upload failed: ${error.message}`);
        }
    })
    .build();

const browserDrag = defineTool()
    .name('browser_drag')
    .description('Drag and drop between two elements. Requires refs from browser_snapshot.')
    .category('browser')
    .stringParam('startElement', 'Description of source element', { required: true })
    .stringParam('startRef', 'Source element ref from snapshot', { required: true })
    .stringParam('endElement', 'Description of target element', { required: true })
    .stringParam('endRef', 'Target element ref from snapshot', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);

        const startRef = params.startRef as string;
        const endRef = params.endRef as string;
        const startDesc = params.startElement as string;
        const endDesc = params.endElement as string;

        CSReporter.info(`[MCP] Drag from "${startDesc}" to "${endDesc}"`);

        try {
            const sourceLocator = getLocatorByRef(page, startRef, startDesc);
            const targetLocator = getLocatorByRef(page, endRef, endDesc);

            await sourceLocator.dragTo(targetLocator);

            CSReporter.pass(`[MCP] Drag complete`);
            return createTextResult(`Dragged from "${startDesc}" [ref=${startRef}] to "${endDesc}" [ref=${endRef}]`);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Drag failed: ${error.message}`);
            return createErrorResult(`Drag failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Verification Tools (Official MCP Parity)
// ============================================================================

const browserVerifyTextVisible = defineTool()
    .name('browser_verify_text_visible')
    .description('Verify that specific text is visible on the page')
    .category('browser')
    .stringParam('text', 'Text to verify is visible', { required: true })
    .handler(async (params, context) => {
        const page = await getPageAsync(context);
        const text = params.text as string;

        try {
            const locator = page.getByText(text);
            const isVisible = await locator.isVisible();

            if (isVisible) {
                CSReporter.pass(`[MCP] Text "${text}" is visible`);
            } else {
                CSReporter.fail(`[MCP] Text "${text}" is NOT visible`);
            }

            return createJsonResult({
                verified: isVisible,
                text,
            });
        } catch (error: any) {
            return createJsonResult({
                verified: false,
                text,
                error: error.message,
            });
        }
    })
    .readOnly()
    .build();

const browserVerifyElementVisible = defineTool()
    .name('browser_verify_element_visible')
    .description('Verify that an element with specific role and name is visible')
    .category('browser')
    .stringParam('role', 'ARIA role of the element', { required: true })
    .stringParam('accessibleName', 'Accessible name of the element', { required: true })
    .handler(async (params, context) => {
        const page = await getPageAsync(context);
        const role = params.role as string;
        const accessibleName = params.accessibleName as string;

        try {
            const locator = page.getByRole(role as any, { name: accessibleName });
            const isVisible = await locator.isVisible();

            if (isVisible) {
                CSReporter.pass(`[MCP] Element [role=${role}, name="${accessibleName}"] is visible`);
            } else {
                CSReporter.fail(`[MCP] Element [role=${role}, name="${accessibleName}"] is NOT visible`);
            }

            return createJsonResult({
                verified: isVisible,
                role,
                accessibleName,
            });
        } catch (error: any) {
            return createJsonResult({
                verified: false,
                role,
                accessibleName,
                error: error.message,
            });
        }
    })
    .readOnly()
    .build();

const browserVerifyText = defineTool()
    .name('browser_verify_text')
    .description('Verify that text exists on the page')
    .category('browser')
    .stringParam('text', 'Text to verify', { required: true })
    .stringParam('selector', 'Optional selector to search within')
    .booleanParam('exact', 'Require exact match', { default: false })
    .handler(async (params, context) => {
        const page = await getPageAsync(context);
        const text = params.text as string;

        try {
            let locator;
            if (params.selector) {
                locator = page.locator(params.selector as string).getByText(text, { exact: params.exact === true });
            } else {
                locator = page.getByText(text, { exact: params.exact === true });
            }

            const isVisible = await locator.isVisible();

            return createJsonResult({
                found: isVisible,
                text,
            });
        } catch (error: any) {
            return createJsonResult({
                found: false,
                text,
                error: error.message,
            });
        }
    })
    .readOnly()
    .build();

const browserVerifyElement = defineTool()
    .name('browser_verify_element')
    .description('Verify that an element exists and matches specified state')
    .category('browser')
    .stringParam('selector', 'CSS or XPath selector', { required: true })
    .booleanParam('visible', 'Check if element is visible')
    .booleanParam('enabled', 'Check if element is enabled')
    .booleanParam('checked', 'Check if element is checked')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const selector = params.selector as string;

        try {
            const locator = page.locator(selector);

            const result: Record<string, unknown> = {
                exists: true,
                selector,
            };

            result.count = await locator.count();

            if (params.visible !== undefined) {
                result.visible = await locator.first().isVisible();
                result.visibleMatch = result.visible === params.visible;
            }

            if (params.enabled !== undefined) {
                result.enabled = await locator.first().isEnabled();
                result.enabledMatch = result.enabled === params.enabled;
            }

            if (params.checked !== undefined) {
                result.checked = await locator.first().isChecked();
                result.checkedMatch = result.checked === params.checked;
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createJsonResult({
                exists: false,
                selector,
                error: error.message,
            });
        }
    })
    .readOnly()
    .build();

const browserGetAttribute = defineTool()
    .name('browser_get_attribute')
    .description('Get an attribute value from an element')
    .category('browser')
    .stringParam('selector', 'CSS or XPath selector', { required: true })
    .stringParam('attribute', 'Attribute name', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const selector = params.selector as string;
        const attribute = params.attribute as string;

        try {
            const value = await page.locator(selector).first().getAttribute(attribute);

            return createJsonResult({
                selector,
                attribute,
                value,
            });
        } catch (error: any) {
            return createErrorResult(`Get attribute failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const browserGetText = defineTool()
    .name('browser_get_text')
    .description('Get the text content of an element')
    .category('browser')
    .stringParam('selector', 'CSS or XPath selector', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const selector = params.selector as string;

        try {
            const text = await page.locator(selector).first().textContent();

            return createJsonResult({
                selector,
                text,
            });
        } catch (error: any) {
            return createErrorResult(`Get text failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const browserGetValue = defineTool()
    .name('browser_get_value')
    .description('Get the value of an input element')
    .category('browser')
    .stringParam('selector', 'CSS or XPath selector', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const selector = params.selector as string;

        try {
            const value = await page.locator(selector).first().inputValue();

            return createJsonResult({
                selector,
                value,
            });
        } catch (error: any) {
            return createErrorResult(`Get value failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Wait Tools (Official MCP Parity)
// ============================================================================

const browserWaitForElement = defineTool()
    .name('browser_wait_for_element')
    .description('Wait for an element to appear')
    .category('browser')
    .stringParam('selector', 'CSS or XPath selector', { required: true })
    .stringParam('state', 'State to wait for', {
        enum: ['attached', 'detached', 'visible', 'hidden'],
        default: 'visible',
    })
    .numberParam('timeout', 'Timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const selector = params.selector as string;
        const state = (params.state as string) || 'visible';
        const timeout = (params.timeout as number) || 30000;

        CSReporter.info(`[MCP] Waiting for element: ${selector} (${state})`);

        try {
            await page.locator(selector).first().waitFor({
                state: state as 'attached' | 'detached' | 'visible' | 'hidden',
                timeout,
            });

            CSReporter.pass(`[MCP] Element ${state}: ${selector}`);
            return createTextResult(`Element ${state}: ${selector}`);
        } catch (error: any) {
            CSReporter.fail(`[MCP] Wait failed: ${error.message}`);
            return createErrorResult(`Wait failed: ${error.message}`);
        }
    })
    .build();

const browserWaitForNavigation = defineTool()
    .name('browser_wait_for_navigation')
    .description('Wait for navigation to complete')
    .category('browser')
    .stringParam('url', 'URL pattern to wait for')
    .stringParam('waitUntil', 'When to consider complete', {
        enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
        default: 'load',
    })
    .numberParam('timeout', 'Timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        const page = getPage(context);

        try {
            if (params.url) {
                await page.waitForURL(params.url as string, {
                    waitUntil: params.waitUntil as 'load' | 'domcontentloaded' | 'networkidle' | 'commit',
                    timeout: (params.timeout as number) || 30000,
                });
            }

            return createJsonResult({
                status: 'navigation_complete',
                url: page.url(),
            });
        } catch (error: any) {
            return createErrorResult(`Wait for navigation failed: ${error.message}`);
        }
    })
    .build();

const browserWaitForLoadState = defineTool()
    .name('browser_wait_for_load_state')
    .description('Wait for page to reach a specific load state')
    .category('browser')
    .stringParam('state', 'Load state to wait for', {
        enum: ['load', 'domcontentloaded', 'networkidle'],
        default: 'load',
    })
    .numberParam('timeout', 'Timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        const page = getPage(context);

        try {
            await page.waitForLoadState(
                params.state as 'load' | 'domcontentloaded' | 'networkidle' || 'load',
                { timeout: (params.timeout as number) || 30000 }
            );

            return createTextResult(`Page reached ${params.state || 'load'} state`);
        } catch (error: any) {
            return createErrorResult(`Wait for load state failed: ${error.message}`);
        }
    })
    .build();

const browserWaitForSpinners = defineTool()
    .name('browser_wait_for_spinners')
    .description('Wait for loading spinners to disappear')
    .category('browser')
    .numberParam('timeout', 'Timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        CSReporter.info('[MCP] Waiting for spinners to disappear');

        try {
            const browserManager = getBrowserManager();
            await browserManager.waitForSpinnersToDisappear(params.timeout || 30000);

            CSReporter.pass('[MCP] Spinners disappeared');
            return createTextResult('Spinners disappeared');
        } catch (error: any) {
            CSReporter.warn(`[MCP] Spinner wait issue: ${error.message}`);
            return createTextResult('Spinner wait completed');
        }
    })
    .build();

const browserWaitFor = defineTool()
    .name('browser_wait_for')
    .description('Wait for text to appear/disappear, or wait for specified time. Use "time" (seconds), "text", or "textGone".')
    .category('browser')
    .numberParam('time', 'Wait time in seconds')
    .stringParam('text', 'Text to wait for to appear')
    .stringParam('textGone', 'Text to wait for to disappear')
    .numberParam('timeout', 'Max wait time in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const text = params.text as string;
        const textGone = params.textGone as string;
        const timeout = (params.timeout as number) || 30000;
        const time = params.time as number;

        try {
            if (time !== undefined && time > 0) {
                const waitMs = time * 1000;
                context.log('info', `Waiting for ${time} seconds`);
                await page.waitForTimeout(waitMs);
                return createTextResult(`Waited for ${time} seconds`);
            }

            if (text) {
                context.log('info', `Waiting for text "${text}" to appear`);
                await page.getByText(text).waitFor({ state: 'visible', timeout });
                CSReporter.pass(`[MCP] Text "${text}" appeared`);
                return createTextResult(`Text "${text}" appeared`);
            }

            if (textGone) {
                context.log('info', `Waiting for text "${textGone}" to disappear`);
                await page.getByText(textGone).waitFor({ state: 'hidden', timeout });
                CSReporter.pass(`[MCP] Text "${textGone}" disappeared`);
                return createTextResult(`Text "${textGone}" disappeared`);
            }

            return createErrorResult('One of "time", "text", or "textGone" is required');
        } catch (error: any) {
            return createErrorResult(`Wait failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Tab Management Tools
// ============================================================================

const browserTabNew = defineTool()
    .name('browser_tab_new')
    .description('Open a new tab')
    .category('browser')
    .stringParam('url', 'Optional URL to navigate to')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const browserManager = getBrowserManager();
        const browserContext = browserManager.getContext();

        CSReporter.info('[MCP] Opening new tab');

        try {
            const newPage = await browserContext.newPage();

            if (params.url) {
                await newPage.goto(params.url as string);
            }

            browserManager.setCurrentPage(newPage);

            context.server.browser = {
                ...context.server.browser,
                page: newPage,
            };

            moduleBrowserState.page = newPage;
            resetRefStore();

            CSReporter.pass(`[MCP] New tab opened: ${params.url || 'about:blank'}`);
            return createJsonResult({
                status: 'tab_opened',
                url: params.url || 'about:blank',
                tabCount: browserManager.getPageCount(),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] New tab failed: ${error.message}`);
            return createErrorResult(`Failed to open new tab: ${error.message}`);
        }
    })
    .build();

const browserTabClose = defineTool()
    .name('browser_tab_close')
    .description('Close the current tab')
    .category('browser')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const browserManager = getBrowserManager();
        const page = browserManager.getPage();

        CSReporter.info('[MCP] Closing current tab');

        try {
            await page.close();

            const pages = browserManager.getPages();
            if (pages.length > 0) {
                browserManager.setCurrentPage(pages[pages.length - 1]);
                context.server.browser = {
                    ...context.server.browser,
                    page: pages[pages.length - 1],
                };
                moduleBrowserState.page = pages[pages.length - 1];
            }

            resetRefStore();

            CSReporter.pass('[MCP] Tab closed');
            return createJsonResult({
                status: 'tab_closed',
                remainingTabs: browserManager.getPageCount(),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Tab close failed: ${error.message}`);
            return createErrorResult(`Failed to close tab: ${error.message}`);
        }
    })
    .destructive()
    .build();

const browserTabList = defineTool()
    .name('browser_tab_list')
    .description('List all open tabs')
    .category('browser')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const browserManager = getBrowserManager();
        const pages = browserManager.getPages();
        const currentIndex = browserManager.getCurrentPageIndex();

        const tabInfo = await Promise.all(
            pages.map(async (page: any, index: number) => {
                return {
                    index,
                    url: page.url(),
                    title: await page.title(),
                    isCurrent: index === currentIndex,
                };
            })
        );

        return createJsonResult({
            tabs: tabInfo,
            count: tabInfo.length,
            currentIndex,
        });
    })
    .readOnly()
    .build();

const browserTabSwitch = defineTool()
    .name('browser_tab_switch')
    .description('Switch to a specific tab by index')
    .category('browser')
    .numberParam('index', 'Tab index (0-based)', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const browserManager = getBrowserManager();
        const index = params.index as number;

        CSReporter.info(`[MCP] Switching to tab ${index}`);

        try {
            await browserManager.switchToPage(index);

            context.server.browser = {
                ...context.server.browser,
                page: browserManager.getPage(),
            };

            moduleBrowserState.page = browserManager.getPage();
            resetRefStore();

            CSReporter.pass(`[MCP] Switched to tab ${index}`);
            return createJsonResult({
                status: 'switched',
                index,
                url: browserManager.getPage().url(),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Tab switch failed: ${error.message}`);
            return createErrorResult(`Failed to switch tab: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// JavaScript Execution Tools (Official MCP Parity)
// ============================================================================

const browserEvaluate = defineTool()
    .name('browser_evaluate')
    .description('Execute JavaScript in page context, optionally on a specific element')
    .category('browser')
    .stringParam('function', 'JavaScript code to execute', { required: true })
    .stringParam('element', 'Element description (optional)')
    .stringParam('ref', 'Element ref from snapshot (optional)')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const code = params.function as string;

        context.log('info', 'Executing JavaScript');
        CSReporter.info('[MCP] Executing JavaScript');

        try {
            let result;

            if (params.ref) {
                const locator = getLocatorByRef(page, params.ref as string, params.element as string || 'element');
                result = await locator.evaluate((el: Element, fn: string) => {
                    return eval(`(${fn})(el)`);
                }, code);
            } else {
                result = await page.evaluate(code);
            }

            CSReporter.pass('[MCP] JavaScript executed');
            return createJsonResult({
                result: result !== undefined ? result : 'undefined',
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] JavaScript execution failed: ${error.message}`);
            return createErrorResult(`JavaScript execution failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Dialog Handling (Official MCP Parity)
// ============================================================================

const browserHandleDialog = defineTool()
    .name('browser_handle_dialog')
    .description('Handle JavaScript dialogs (alert, confirm, prompt)')
    .category('browser')
    .stringParam('action', 'How to handle dialog', {
        enum: ['accept', 'dismiss'],
        default: 'accept',
    })
    .stringParam('promptText', 'Text for prompt dialogs')
    .booleanParam('waitForDialog', 'Wait for dialog to appear', { default: false })
    .numberParam('timeout', 'Timeout when waiting', { default: 5000 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const action = (params.action as string) || 'accept';

        context.log('info', `Setting up dialog handler: ${action}`);
        CSReporter.info(`[MCP] Setting up dialog handler: ${action}`);

        try {
            if (params.waitForDialog) {
                const dialogPromise = page.waitForEvent('dialog', {
                    timeout: (params.timeout as number) || 5000,
                });

                const dialog = await dialogPromise;
                const dialogInfo = {
                    type: dialog.type(),
                    message: dialog.message(),
                    defaultValue: dialog.defaultValue(),
                };

                if (action === 'accept') {
                    await dialog.accept(params.promptText as string);
                } else {
                    await dialog.dismiss();
                }

                CSReporter.pass(`[MCP] Dialog handled: ${dialog.type()}`);
                return createJsonResult({
                    handled: true,
                    action,
                    dialog: dialogInfo,
                });
            } else {
                page.on('dialog', async (dialog: any) => {
                    if (action === 'accept') {
                        await dialog.accept(params.promptText as string);
                    } else {
                        await dialog.dismiss();
                    }
                });

                CSReporter.pass(`[MCP] Dialog handler configured: ${action}`);
                return createJsonResult({
                    configured: true,
                    action,
                    message: `Future dialogs will be ${action}ed`,
                });
            }
        } catch (error: any) {
            CSReporter.fail(`[MCP] Dialog handling failed: ${error.message}`);
            return createErrorResult(`Dialog handling failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Viewport Resize (Official MCP Parity)
// ============================================================================

const browserResize = defineTool()
    .name('browser_resize')
    .description('Resize the browser viewport or emulate a device')
    .category('browser')
    .numberParam('width', 'Viewport width in pixels')
    .numberParam('height', 'Viewport height in pixels')
    .stringParam('device', 'Device to emulate')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);

        context.log('info', 'Resizing viewport');
        CSReporter.info('[MCP] Resizing viewport');

        try {
            const devices: Record<string, { width: number; height: number; deviceScaleFactor: number; isMobile: boolean }> = {
                'iphone 13': { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
                'iphone 14': { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
                'iphone 15': { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true },
                'ipad': { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true },
                'ipad pro': { width: 1024, height: 1366, deviceScaleFactor: 2, isMobile: true },
                'pixel 5': { width: 393, height: 851, deviceScaleFactor: 2.75, isMobile: true },
                'pixel 7': { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true },
                'desktop': { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false },
                'laptop': { width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false },
            };

            let viewport: { width: number; height: number };

            if (params.device) {
                const deviceKey = (params.device as string).toLowerCase();
                const deviceConfig = devices[deviceKey];

                if (deviceConfig) {
                    viewport = { width: deviceConfig.width, height: deviceConfig.height };
                    await page.setViewportSize(viewport);

                    CSReporter.pass(`[MCP] Viewport set to ${params.device}`);
                    return createJsonResult({
                        device: params.device,
                        viewport,
                        deviceScaleFactor: deviceConfig.deviceScaleFactor,
                        isMobile: deviceConfig.isMobile,
                    });
                } else {
                    return createErrorResult(`Unknown device: ${params.device}`);
                }
            } else if (params.width && params.height) {
                viewport = {
                    width: params.width as number,
                    height: params.height as number,
                };
                await page.setViewportSize(viewport);

                CSReporter.pass(`[MCP] Viewport resized to ${viewport.width}x${viewport.height}`);
                return createJsonResult({ viewport });
            } else {
                const currentViewport = page.viewportSize();
                return createJsonResult({
                    currentViewport,
                    availableDevices: Object.keys(devices),
                });
            }
        } catch (error: any) {
            CSReporter.fail(`[MCP] Viewport resize failed: ${error.message}`);
            return createErrorResult(`Viewport resize failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Console Messages (Official MCP Parity)
// ============================================================================

const consoleMessages: Map<string, any[]> = new Map();

const browserConsoleMessages = defineTool()
    .name('browser_console_messages')
    .description('Get console messages from the page')
    .category('browser')
    .stringParam('action', 'Action', {
        enum: ['start', 'stop', 'get', 'clear'],
        default: 'get',
    })
    .stringParam('level', 'Filter by level', {
        enum: ['all', 'log', 'info', 'warning', 'error'],
        default: 'all',
    })
    .numberParam('limit', 'Max messages to return', { default: 100 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const pageId = page.url();
        const action = (params.action as string) || 'get';
        const level = (params.level as string) || 'all';
        const limit = (params.limit as number) || 100;

        try {
            switch (action) {
                case 'start':
                    consoleMessages.set(pageId, []);
                    page.on('console', (msg: any) => {
                        const messages = consoleMessages.get(pageId) || [];
                        messages.push({
                            type: msg.type(),
                            text: msg.text(),
                            location: msg.location(),
                            timestamp: new Date().toISOString(),
                        });
                        consoleMessages.set(pageId, messages);
                    });
                    return createJsonResult({ action: 'started' });

                case 'stop':
                    return createJsonResult({
                        action: 'stopped',
                        capturedCount: (consoleMessages.get(pageId) || []).length,
                    });

                case 'clear':
                    consoleMessages.set(pageId, []);
                    return createJsonResult({ action: 'cleared' });

                case 'get':
                default:
                    let messages = consoleMessages.get(pageId) || [];
                    if (level !== 'all') {
                        messages = messages.filter((m) => m.type === level);
                    }
                    return createJsonResult({
                        count: Math.min(messages.length, limit),
                        messages: messages.slice(-limit),
                    });
            }
        } catch (error: any) {
            return createErrorResult(`Console messages failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Network Requests (Official MCP Parity)
// ============================================================================

const networkRequests: Map<string, any[]> = new Map();

const browserNetworkRequests = defineTool()
    .name('browser_network_requests')
    .description('Get network requests since page load')
    .category('browser')
    .stringParam('action', 'Action', {
        enum: ['start', 'stop', 'get', 'clear'],
        default: 'get',
    })
    .stringParam('filter', 'Filter by type', {
        enum: ['all', 'xhr', 'fetch', 'document', 'stylesheet', 'script', 'image'],
        default: 'all',
    })
    .numberParam('limit', 'Max requests to return', { default: 100 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const pageId = page.url();
        const action = (params.action as string) || 'get';
        const filter = (params.filter as string) || 'all';
        const limit = (params.limit as number) || 100;

        try {
            switch (action) {
                case 'start':
                    networkRequests.set(pageId, []);
                    const requestTimes = new Map<string, number>();

                    page.on('request', (request: any) => {
                        const requests = networkRequests.get(pageId) || [];
                        requestTimes.set(request.url(), Date.now());
                        requests.push({
                            url: request.url(),
                            method: request.method(),
                            resourceType: request.resourceType(),
                            timestamp: Date.now(),
                        });
                        networkRequests.set(pageId, requests);
                    });

                    page.on('response', (response: any) => {
                        const requests = networkRequests.get(pageId) || [];
                        const startTime = requestTimes.get(response.url());
                        const req = requests.find((r: any) => r.url === response.url() && !r.status);
                        if (req) {
                            req.status = response.status();
                            req.duration = startTime ? Date.now() - startTime : undefined;
                        }
                    });

                    return createTextResult('Network request capture started');

                case 'stop':
                    return createTextResult('Network request capture stopped');

                case 'clear':
                    networkRequests.set(pageId, []);
                    return createTextResult('Network requests cleared');

                case 'get':
                default:
                    let requests = networkRequests.get(pageId) || [];
                    if (filter !== 'all') {
                        requests = requests.filter((r: any) => r.resourceType === filter);
                    }
                    return createJsonResult({
                        count: Math.min(requests.length, limit),
                        requests: requests.slice(-limit),
                    });
            }
        } catch (error: any) {
            return createErrorResult(`Network requests failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Run Code Tool (Official MCP Parity)
// ============================================================================

const browserRunCode = defineTool()
    .name('browser_run_code')
    .description('Execute Playwright code snippet with access to page object')
    .category('browser')
    .stringParam('code', 'Playwright code to execute', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const code = params.code as string;

        try {
            const asyncFunction = new Function('page', `
                return (async () => {
                    ${code}
                })();
            `);

            const result = await asyncFunction(page);

            CSReporter.pass(`[MCP] Code execution completed`);
            return createJsonResult({
                success: true,
                result: result !== undefined ? String(result) : 'Code executed successfully',
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Code execution failed: ${error.message}`);
            return createErrorResult(`Code execution failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Fill Form Tool (Official MCP Parity)
// ============================================================================

const browserFillForm = defineTool()
    .name('browser_fill_form')
    .description('Fill multiple form fields. Fields format: [{"element":"desc","ref":"e1","value":"text"}]')
    .category('browser')
    .stringParam('fields', 'JSON array of fields', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = await getPageAsync(context);
        const fieldsJson = params.fields as string;

        try {
            const fields = JSON.parse(fieldsJson) as Array<{ element: string; ref: string; value: string }>;
            const results: Array<{ element: string; ref: string; status: string }> = [];

            for (const field of fields) {
                const { element, ref, value } = field;

                try {
                    const locator = getLocatorByRef(page, ref, element);
                    await locator.fill(value);
                    results.push({ element, ref, status: 'filled' });
                } catch (error: any) {
                    results.push({ element, ref, status: `error: ${error.message}` });
                }
            }

            const successCount = results.filter((r) => r.status === 'filled').length;
            CSReporter.pass(`[MCP] Form filled: ${successCount}/${fields.length} fields`);

            return createJsonResult({
                success: successCount === fields.length,
                fieldsCount: fields.length,
                successCount,
                results,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Fill form failed: ${error.message}`);
            return createErrorResult(`Fill form failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Vision/Coordinate Tools (Official MCP Parity)
// ============================================================================

const browserMouseClickXY = defineTool()
    .name('browser_mouse_click_xy')
    .description('Click at specific x,y coordinates')
    .category('browser')
    .stringParam('element', 'Description of click target (for audit)', { required: true })
    .numberParam('x', 'X coordinate', { required: true })
    .numberParam('y', 'Y coordinate', { required: true })
    .stringParam('button', 'Mouse button', { enum: ['left', 'right', 'middle'], default: 'left' })
    .numberParam('clickCount', 'Click count', { default: 1 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const x = params.x as number;
        const y = params.y as number;

        try {
            await page.mouse.click(x, y, {
                button: (params.button as 'left' | 'right' | 'middle') || 'left',
                clickCount: (params.clickCount as number) || 1,
            });
            return createTextResult(`Clicked "${params.element}" at (${x}, ${y})`);
        } catch (error: any) {
            return createErrorResult(`Mouse click failed: ${error.message}`);
        }
    })
    .build();

const browserMouseMoveXY = defineTool()
    .name('browser_mouse_move_xy')
    .description('Move mouse to x,y coordinates')
    .category('browser')
    .stringParam('element', 'Description of target (optional)')
    .numberParam('x', 'X coordinate', { required: true })
    .numberParam('y', 'Y coordinate', { required: true })
    .numberParam('steps', 'Movement steps', { default: 1 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const x = params.x as number;
        const y = params.y as number;

        try {
            await page.mouse.move(x, y, { steps: (params.steps as number) || 1 });
            return createTextResult(`Mouse moved to (${x}, ${y})`);
        } catch (error: any) {
            return createErrorResult(`Mouse move failed: ${error.message}`);
        }
    })
    .build();

const browserMouseDragXY = defineTool()
    .name('browser_mouse_drag_xy')
    .description('Drag from one point to another')
    .category('browser')
    .stringParam('element', 'Description of drag operation', { required: true })
    .numberParam('startX', 'Start X', { required: true })
    .numberParam('startY', 'Start Y', { required: true })
    .numberParam('endX', 'End X', { required: true })
    .numberParam('endY', 'End Y', { required: true })
    .numberParam('steps', 'Drag steps', { default: 10 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);

        try {
            await page.mouse.move(params.startX as number, params.startY as number);
            await page.mouse.down();
            await page.mouse.move(params.endX as number, params.endY as number, { steps: (params.steps as number) || 10 });
            await page.mouse.up();
            return createTextResult(`Dragged "${params.element}"`);
        } catch (error: any) {
            return createErrorResult(`Mouse drag failed: ${error.message}`);
        }
    })
    .build();

const browserMouseDown = defineTool()
    .name('browser_mouse_down')
    .description('Press mouse button down')
    .category('browser')
    .stringParam('button', 'Button', { enum: ['left', 'right', 'middle'], default: 'left' })
    .handler(async (params, context) => {
        const page = getPage(context);
        await page.mouse.down({ button: (params.button as 'left' | 'right' | 'middle') || 'left' });
        return createTextResult('Mouse button pressed');
    })
    .build();

const browserMouseUp = defineTool()
    .name('browser_mouse_up')
    .description('Release mouse button')
    .category('browser')
    .stringParam('button', 'Button', { enum: ['left', 'right', 'middle'], default: 'left' })
    .handler(async (params, context) => {
        const page = getPage(context);
        await page.mouse.up({ button: (params.button as 'left' | 'right' | 'middle') || 'left' });
        return createTextResult('Mouse button released');
    })
    .build();

const browserMouseWheel = defineTool()
    .name('browser_mouse_wheel')
    .description('Scroll using mouse wheel')
    .category('browser')
    .numberParam('deltaX', 'Horizontal scroll', { default: 0 })
    .numberParam('deltaY', 'Vertical scroll', { required: true })
    .handler(async (params, context) => {
        const page = getPage(context);
        await page.mouse.wheel((params.deltaX as number) || 0, params.deltaY as number);
        return createTextResult(`Scrolled: deltaY=${params.deltaY}`);
    })
    .build();

// ============================================================================
// Testing Assertions (Official MCP Parity)
// ============================================================================

const browserGenerateLocator = defineTool()
    .name('browser_generate_locator')
    .description('Generate best locator strategy for an element')
    .category('browser')
    .stringParam('selector', 'Current selector', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const page = getPage(context);
        const selector = params.selector as string;

        try {
            const element = page.locator(selector).first();
            const info = await element.evaluate((el: Element) => {
                const htmlEl = el as HTMLElement;
                const inputEl = el as HTMLInputElement;
                return {
                    tagName: el.tagName.toLowerCase(),
                    id: htmlEl.id,
                    name: inputEl.name,
                    role: htmlEl.getAttribute('role'),
                    ariaLabel: htmlEl.getAttribute('aria-label'),
                    text: htmlEl.innerText?.trim().substring(0, 50),
                    placeholder: inputEl.placeholder,
                    testId: htmlEl.getAttribute('data-testid'),
                };
            });

            const locators: Array<{strategy: string, value: string, confidence: number}> = [];

            if (info.testId) {
                locators.push({ strategy: 'testId', value: `getByTestId('${info.testId}')`, confidence: 95 });
            }
            if (info.role && info.ariaLabel) {
                locators.push({ strategy: 'role+name', value: `getByRole('${info.role}', { name: '${info.ariaLabel}' })`, confidence: 90 });
            }
            if (info.ariaLabel) {
                locators.push({ strategy: 'label', value: `getByLabel('${info.ariaLabel}')`, confidence: 85 });
            }
            if (info.text) {
                locators.push({ strategy: 'text', value: `getByText('${info.text}')`, confidence: 75 });
            }
            if (info.id) {
                locators.push({ strategy: 'id', value: `locator('#${info.id}')`, confidence: 70 });
            }

            return createJsonResult({
                originalSelector: selector,
                elementInfo: info,
                recommendedLocators: locators,
                bestLocator: locators[0] || { strategy: 'css', value: `locator('${selector}')`, confidence: 50 },
            });
        } catch (error: any) {
            return createErrorResult(`Generate locator failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const browserVerifyListVisible = defineTool()
    .name('browser_verify_list_visible')
    .description('Verify list with specific items is visible')
    .category('browser')
    .stringParam('listSelector', 'List container selector', { required: true })
    .stringParam('expectedItems', 'JSON array of expected items', { required: true })
    .booleanParam('exactMatch', 'Require exact match', { default: false })
    .handler(async (params, context) => {
        const page = getPage(context);

        try {
            const expectedItems = JSON.parse(params.expectedItems as string);
            const list = page.locator(params.listSelector as string);
            const items = await list.locator('li, [role="listitem"], tr').allTextContents();

            const matchedItems: string[] = [];
            const missingItems: string[] = [];

            for (const expected of expectedItems) {
                if (items.some((item: string) => item.includes(expected))) {
                    matchedItems.push(expected);
                } else {
                    missingItems.push(expected);
                }
            }

            const passed = missingItems.length === 0;

            return createJsonResult({
                passed,
                matchedItems,
                missingItems,
                actualCount: items.length,
            });
        } catch (error: any) {
            return createErrorResult(`Verify list failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const browserVerifyValue = defineTool()
    .name('browser_verify_value')
    .description('Verify input element has expected value')
    .category('browser')
    .stringParam('selector', 'Input selector', { required: true })
    .stringParam('expected', 'Expected value', { required: true })
    .booleanParam('exactMatch', 'Exact match', { default: true })
    .handler(async (params, context) => {
        const page = getPage(context);

        try {
            const actual = await page.locator(params.selector as string).first().inputValue();
            const expected = params.expected as string;
            const passed = params.exactMatch !== false ? actual === expected : actual.includes(expected);

            return createJsonResult({
                passed,
                expected,
                actual,
            });
        } catch (error: any) {
            return createErrorResult(`Verify value failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// PDF Tool (Official MCP Parity)
// ============================================================================

const browserPdfSave = defineTool()
    .name('browser_pdf_save')
    .description('Save current page as PDF')
    .category('browser')
    .stringParam('path', 'Output PDF path', { required: true })
    .stringParam('format', 'Paper format', { enum: ['A4', 'Letter', 'Legal'], default: 'A4' })
    .booleanParam('landscape', 'Landscape orientation', { default: false })
    .booleanParam('printBackground', 'Print backgrounds', { default: true })
    .handler(async (params, context) => {
        const page = getPage(context);

        try {
            await page.pdf({
                path: params.path as string,
                format: (params.format as string) || 'A4',
                landscape: params.landscape as boolean,
                printBackground: params.printBackground !== false,
            });

            return createJsonResult({
                success: true,
                path: params.path,
            });
        } catch (error: any) {
            return createErrorResult(`PDF save failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Tracing Tools (Official MCP Parity)
// ============================================================================

const browserStartTracing = defineTool()
    .name('browser_start_tracing')
    .description('Start Playwright trace recording')
    .category('browser')
    .booleanParam('screenshots', 'Capture screenshots', { default: true })
    .booleanParam('snapshots', 'Capture DOM snapshots', { default: true })
    .stringParam('title', 'Trace title')
    .handler(async (params, context) => {
        const page = getPage(context);

        try {
            await page.context().tracing.start({
                screenshots: params.screenshots !== false,
                snapshots: params.snapshots !== false,
                title: params.title as string,
            });
            return createTextResult('Trace recording started');
        } catch (error: any) {
            return createErrorResult(`Start tracing failed: ${error.message}`);
        }
    })
    .build();

const browserStopTracing = defineTool()
    .name('browser_stop_tracing')
    .description('Stop trace recording and save to file')
    .category('browser')
    .stringParam('path', 'Output trace path', { required: true })
    .handler(async (params, context) => {
        const page = getPage(context);

        try {
            await page.context().tracing.stop({ path: params.path as string });
            return createJsonResult({
                success: true,
                path: params.path,
                viewCommand: `npx playwright show-trace ${params.path}`,
            });
        } catch (error: any) {
            return createErrorResult(`Stop tracing failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Browser Install Tool (Official MCP Parity)
// ============================================================================

const browserInstall = defineTool()
    .name('browser_install')
    .description('Install browser binaries for Playwright')
    .category('browser')
    .stringParam('browser', 'Browser to install', {
        enum: ['chromium', 'firefox', 'webkit', 'chrome', 'msedge'],
        default: 'chromium',
    })
    .handler(async (params, context) => {
        const browser = (params.browser as string) || 'chromium';

        try {
            const { execSync } = require('child_process');
            const output = execSync(`npx playwright install ${browser}`, { encoding: 'utf-8' });

            return createJsonResult({
                success: true,
                browser,
                output: output.substring(0, 500),
            });
        } catch (error: any) {
            return createErrorResult(`Browser install failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Export all browser tools
// ============================================================================

export const browserTools: MCPToolDefinition[] = [
    // Lifecycle
    browserLaunch,
    browserClose,
    browserSwitchBrowser,
    browserNewContext,

    // Navigation (Official MCP Parity)
    browserNavigate,
    browserBack,
    browserForward,
    browserReload,

    // Snapshot (Official MCP Parity)
    browserSnapshot,
    browserScreenshot,

    // Interaction (Official MCP Parity - element + ref pattern)
    browserClick,
    browserType,
    browserSelectOption,
    browserHover,
    browserPressKey,
    browserFileUpload,
    browserDrag,

    // Verification (Official MCP Parity)
    browserVerifyTextVisible,
    browserVerifyElementVisible,
    browserVerifyText,
    browserVerifyElement,
    browserGetAttribute,
    browserGetText,
    browserGetValue,

    // Wait (Official MCP Parity)
    browserWaitForElement,
    browserWaitForNavigation,
    browserWaitForLoadState,
    browserWaitForSpinners,
    browserWaitFor,

    // Tabs
    browserTabNew,
    browserTabClose,
    browserTabList,
    browserTabSwitch,

    // JavaScript (Official MCP Parity)
    browserEvaluate,

    // Dialog handling (Official MCP Parity)
    browserHandleDialog,

    // Viewport (Official MCP Parity)
    browserResize,

    // Console (Official MCP Parity)
    browserConsoleMessages,

    // Network (Official MCP Parity)
    browserNetworkRequests,

    // Run Code (Official MCP Parity)
    browserRunCode,

    // Multi-field Form (Official MCP Parity)
    browserFillForm,

    // Vision/Coordinate Tools (Official MCP Parity)
    browserMouseClickXY,
    browserMouseMoveXY,
    browserMouseDragXY,
    browserMouseDown,
    browserMouseUp,
    browserMouseWheel,

    // Testing Assertions (Official MCP Parity)
    browserGenerateLocator,
    browserVerifyListVisible,
    browserVerifyValue,

    // PDF (Official MCP Parity)
    browserPdfSave,

    // Tracing (Official MCP Parity)
    browserStartTracing,
    browserStopTracing,

    // Browser Install (Official MCP Parity)
    browserInstall,
];

/**
 * Register all browser tools with the registry
 */
export function registerBrowserTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(browserTools);
}
