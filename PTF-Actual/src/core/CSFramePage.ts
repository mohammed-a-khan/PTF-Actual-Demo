/**
 * CSFramePage - Base class for page objects that represent iframe content
 *
 * Extends CSBasePage to provide automatic iframe context for all elements.
 * All @CSGetElement decorated elements in classes extending CSFramePage
 * will automatically be scoped to the specified iframe.
 *
 * @example
 * // Define an iframe page
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
     * Can be a string (auto-detects xpath/css) or FrameSelector object.
     *
     * @example
     * // String (auto-detected)
     * protected frame = '//iframe[@title="Editor"]';
     * protected frame = 'iframe#editor';
     * protected frame = '#myFrame';
     *
     * // Object (explicit)
     * protected frame = { xpath: '//iframe[@title="Editor"]' };
     * protected frame = { id: 'editor-frame' };
     * protected frame = { name: 'editorFrame' };
     * protected frame = { title: 'Document Editor' };
     * protected frame = { testId: 'editor-iframe' };
     * protected frame = { index: 0 };
     */
    protected abstract frame: string | FrameSelector;

    private _frameLocator: FrameLocator | null = null;

    constructor() {
        super();
    }

    /**
     * Get the resolved frame selector string
     */
    public getFrameSelector(): string {
        return this.resolveFrameSelector(this.frame);
    }

    /**
     * Get the Playwright FrameLocator for this iframe
     */
    public getFrameLocator(): FrameLocator {
        if (!this._frameLocator) {
            const selector = this.getFrameSelector();
            this._frameLocator = this.page.frameLocator(selector);
            CSReporter.debug(`Created FrameLocator for: ${selector}`);
        }
        return this._frameLocator;
    }

    /**
     * Wait for the iframe to be ready (present and loaded)
     * @param timeout - Maximum time to wait in milliseconds (default: 30000)
     */
    public async waitForFrameReady(timeout: number = 30000): Promise<void> {
        const selector = this.getFrameSelector();
        const iframeSelector = this.getIframeElementSelector();

        CSReporter.info(`Waiting for iframe to be ready: ${selector}`);

        try {
            // Wait for iframe element to be present
            await this.page.waitForSelector(iframeSelector, {
                state: 'attached',
                timeout
            });

            // Wait a bit for iframe content to load
            await this.page.waitForTimeout(500);

            CSReporter.pass(`Iframe is ready: ${selector}`);
        } catch (error: any) {
            CSReporter.fail(`Iframe not ready within ${timeout}ms: ${selector}`);
            throw new Error(`Iframe not ready: ${error.message}`);
        }
    }

    /**
     * Check if the iframe is currently visible and ready
     * @param timeout - Maximum time to check in milliseconds (default: 5000)
     */
    public async isFrameReady(timeout: number = 5000): Promise<boolean> {
        try {
            const iframeSelector = this.getIframeElementSelector();
            await this.page.waitForSelector(iframeSelector, {
                state: 'visible',
                timeout
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Wait for the iframe to be hidden/removed
     * @param timeout - Maximum time to wait in milliseconds (default: 10000)
     */
    public async waitForFrameHidden(timeout: number = 10000): Promise<void> {
        const iframeSelector = this.getIframeElementSelector();

        CSReporter.info(`Waiting for iframe to be hidden: ${iframeSelector}`);

        try {
            await this.page.waitForSelector(iframeSelector, {
                state: 'hidden',
                timeout
            });
            CSReporter.pass('Iframe is hidden');
        } catch (error: any) {
            CSReporter.fail(`Iframe still visible after ${timeout}ms`);
            throw new Error(`Iframe still visible: ${error.message}`);
        }
    }

    /**
     * Get the iframe element selector (for waiting/visibility checks)
     * This converts frameLocator selector to element selector
     */
    private getIframeElementSelector(): string {
        const selector = this.getFrameSelector();

        // Remove xpath= prefix if present
        if (selector.startsWith('xpath=')) {
            return selector;
        }

        // Return as-is for CSS selectors
        return selector;
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
