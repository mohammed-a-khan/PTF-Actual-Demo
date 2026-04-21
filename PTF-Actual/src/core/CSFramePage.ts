/**
 * CSFramePage - Base class for page objects that represent iframe content
 *
 * Extends CSBasePage to provide automatic iframe context for all elements.
 * All @CSGetElement decorated elements in classes extending CSFramePage
 * will automatically be scoped to the specified iframe.
 *
 * @example
 * // Single iframe
 * @CSPage('payment-iframe')
 * export class PaymentIframePage extends CSFramePage {
 *     // Frame selector - defined once, all elements inherit
 *     protected frame = '//iframe[@title="Payment Gateway"]';
 *     // OR: protected frame = { id: 'payment-frame' };
 *     // OR: protected frame = { title: 'Payment Gateway' };
 *
 *     @CSGetElement({
 *         xpath: '//input[@name="cardNumber"]',
 *         description: 'Card Number Input'
 *     })
 *     public cardNumberInput!: CSWebElement;
 *
 *     @CSGetElement({
 *         xpath: '//button[@type="submit"]',
 *         description: 'Submit Button'
 *     })
 *     public submitBtn!: CSWebElement;
 * }
 *
 * @example
 * // Nested iframes (outer -> inner). Strategies may be freely mixed.
 * @CSPage('deep-editor')
 * export class DeepEditorPage extends CSFramePage {
 *     protected frame = [
 *         { id: 'appShell' },
 *         { name: 'workspaceFrame' },
 *         { title: 'Document Editor' }
 *     ];
 *
 *     @CSGetElement({ xpath: '//textarea[@id="body"]', description: 'Body' })
 *     public body!: CSWebElement;
 * }
 *
 * // Usage
 * const paymentFrame = new PaymentIframePage(page);
 * await paymentFrame.waitForFrameReady();
 * await paymentFrame.cardNumberInput.fillWithTimeout('4111111111111111', 5000);
 *
 * @module core/CSFramePage
 */

import { CSBasePage } from './CSBasePage';
import { CSReporter } from '../reporter/CSReporter';

// Lazy load types
type Page = any;
type FrameLocator = any;

/**
 * Frame selector options
 */
export interface FrameSelector {
    /** XPath selector for iframe */
    xpath?: string;
    /** CSS selector for iframe */
    css?: string;
    /** ID of the iframe (resolves to #id) */
    id?: string;
    /** Name attribute of the iframe */
    name?: string;
    /** Title attribute of the iframe */
    title?: string;
    /** Test ID for the iframe (uses data-testid) */
    testId?: string;
    /** Partial src URL match */
    src?: string;
    /** Index of iframe on page (0-based) */
    index?: number;
}

/**
 * Base class for iframe page objects
 */
export abstract class CSFramePage extends CSBasePage {
    /**
     * Frame selector - must be defined by subclass.
     * - Single iframe: string (auto-detects xpath/css) or FrameSelector object.
     * - Nested iframes: array of strings / FrameSelector objects, outermost
     *   first. Every entry is resolved independently, so strategies may be
     *   freely mixed.
     *
     * @example
     * // Single iframe
     * protected frame = '//iframe[@title="Editor"]';
     * protected frame = { id: 'editor-frame' };
     *
     * // Nested iframes (outer -> inner)
     * protected frame = ['#appShell', '//iframe[@title="Editor"]'];
     * protected frame = [
     *     { id: 'appShell' },
     *     { name: 'workspaceFrame' },
     *     { title: 'Document Editor' },
     *     { index: 0 }
     * ];
     */
    protected abstract frame: string | FrameSelector | Array<string | FrameSelector>;

    private _frameLocator: FrameLocator | null = null;

    constructor() {
        super();
    }

    /**
     * Get the frame chain as an array of resolved selector strings
     * (outermost first).
     */
    public getFrameSelectors(): string[] {
        const chain: Array<string | FrameSelector> = Array.isArray(this.frame)
            ? this.frame
            : [this.frame];
        return chain.map(f => this.resolveFrameSelector(f));
    }

    /**
     * Get the resolved frame selector string. For nested frames returns the
     * chain joined with ' >> ' (display only — use {@link getFrameSelectors}
     * for programmatic access to each level).
     */
    public getFrameSelector(): string {
        return this.getFrameSelectors().join(' >> ');
    }

    /**
     * Get the Playwright FrameLocator for this iframe (or the innermost
     * FrameLocator for a nested chain).
     */
    public getFrameLocator(): FrameLocator {
        if (!this._frameLocator) {
            const selectors = this.getFrameSelectors();
            let ctx: any = this.page;
            for (const sel of selectors) {
                ctx = ctx.frameLocator(sel);
            }
            this._frameLocator = ctx;
            CSReporter.debug(
                selectors.length === 1
                    ? `Created FrameLocator for: ${selectors[0]}`
                    : `Created nested FrameLocator chain (${selectors.length}): ${selectors.join(' >> ')}`
            );
        }
        return this._frameLocator;
    }

    /**
     * Wait for the iframe (or every iframe in a nested chain) to be ready,
     * walking outer -> inner. Each level has the full `timeout` budget.
     * @param timeout - Maximum time to wait per level in milliseconds
     *   (default: 30000)
     */
    public async waitForFrameReady(timeout: number = 30000): Promise<void> {
        const selectors = this.getFrameSelectors();
        CSReporter.info(
            selectors.length === 1
                ? `Waiting for iframe to be ready: ${selectors[0]}`
                : `Waiting for nested iframe chain (${selectors.length}): ${selectors.join(' >> ')}`
        );

        let ctx: any = this.page;
        for (let i = 0; i < selectors.length; i++) {
            const sel = selectors[i];
            try {
                if (i === 0) {
                    await this.page.waitForSelector(sel, { state: 'attached', timeout });
                } else {
                    await ctx.locator(sel).first().waitFor({ state: 'attached', timeout });
                }
            } catch (error: any) {
                CSReporter.fail(
                    `Iframe level ${i + 1}/${selectors.length} not ready within ${timeout}ms: ${sel}`
                );
                throw new Error(
                    `Iframe not ready at level ${i + 1}/${selectors.length} (${sel}): ${error.message}`
                );
            }
            ctx = ctx.frameLocator(sel);
        }

        // Small settle for content to render inside the innermost frame
        await this.page.waitForTimeout(500);

        CSReporter.pass(
            selectors.length === 1
                ? `Iframe is ready: ${selectors[0]}`
                : `All ${selectors.length} iframe(s) ready: ${selectors.join(' >> ')}`
        );
    }

    /**
     * Check if the iframe (or every iframe in a nested chain) is currently
     * present. Returns false on any level's timeout.
     * @param timeout - Maximum time to check per level in milliseconds
     *   (default: 5000)
     */
    public async isFrameReady(timeout: number = 5000): Promise<boolean> {
        const selectors = this.getFrameSelectors();
        let ctx: any = this.page;
        try {
            for (let i = 0; i < selectors.length; i++) {
                const sel = selectors[i];
                if (i === 0) {
                    await this.page.waitForSelector(sel, { state: 'visible', timeout });
                } else {
                    await ctx.locator(sel).first().waitFor({ state: 'visible', timeout });
                }
                ctx = ctx.frameLocator(sel);
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Wait for the outermost iframe to be hidden/removed. For a nested chain,
     * if the outer iframe goes away, the inner frames are unreachable too, so
     * checking only the outer is both correct and faster.
     * @param timeout - Maximum time to wait in milliseconds (default: 10000)
     */
    public async waitForFrameHidden(timeout: number = 10000): Promise<void> {
        const outer = this.getFrameSelectors()[0];
        CSReporter.info(`Waiting for iframe to be hidden: ${outer}`);

        try {
            await this.page.waitForSelector(outer, { state: 'hidden', timeout });
            CSReporter.pass('Iframe is hidden');
        } catch (error: any) {
            CSReporter.fail(`Iframe still visible after ${timeout}ms`);
            throw new Error(`Iframe still visible: ${error.message}`);
        }
    }

    /**
     * Resolve frame selector from string or FrameSelector object
     */
    private resolveFrameSelector(frame: string | FrameSelector): string {
        // String input - auto-detect type
        if (typeof frame === 'string') {
            return this.autoDetectFrameSelector(frame);
        }

        // Object input - explicit type
        if (frame.xpath) {
            return `xpath=${frame.xpath}`;
        }
        if (frame.css) {
            return frame.css;
        }
        if (frame.id) {
            return `#${frame.id}`;
        }
        if (frame.name) {
            return `iframe[name="${frame.name}"]`;
        }
        if (frame.title) {
            return `iframe[title="${frame.title}"]`;
        }
        if (frame.testId) {
            return `[data-testid="${frame.testId}"]`;
        }
        if (frame.src) {
            return `iframe[src*="${frame.src}"]`;
        }
        if (frame.index !== undefined) {
            return `iframe >> nth=${frame.index}`;
        }

        throw new Error('Invalid frame selector: must specify xpath, css, id, name, title, testId, src, or index');
    }

    /**
     * Auto-detect frame selector type from string
     */
    private autoDetectFrameSelector(selector: string): string {
        // XPath detection
        if (selector.startsWith('//') || selector.startsWith('/')) {
            return `xpath=${selector}`;
        }
        // Already has xpath= or css= prefix
        if (selector.startsWith('xpath=') || selector.startsWith('css=')) {
            return selector;
        }
        // CSS ID selector
        if (selector.startsWith('#')) {
            return selector;
        }
        // Assume CSS for everything else
        return selector;
    }

    /**
     * Override initializeElements to inject frame context into all elements
     */
    protected initializeElements(): void {
        // Inject frame context into elements after they are initialized by decorators
        // Note: Decorator-based elements are initialized lazily via getter,
        // so we defer frame injection to when elements are accessed
        CSReporter.debug(`${this.constructor.name} initialized with frame: ${JSON.stringify(this.frame)}`);
    }

    /**
     * Clear cached frame locator (useful after page navigation)
     */
    public clearFrameCache(): void {
        this._frameLocator = null;
        CSReporter.debug('Frame locator cache cleared');
    }
}
