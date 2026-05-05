/**
 * CSFrameResolver - Pure-static utility for resolving frame selectors.
 *
 * Centralises the logic that turns a {@link FrameInput} (a single string,
 * a {@link FrameSelector} object, or an outer-to-inner array of either) into
 * the canonical Playwright selector form (e.g. `xpath=//iframe[...]`,
 * `#myFrame`, `iframe[name="..."]`).
 *
 * Previously this logic was copy-pasted between {@link CSFramePage} and
 * {@link CSWebElement}. Both now delegate here.
 *
 * ## Parallel safety
 *
 * Every method on this class is `static`. There is no module-level mutable
 * state, no caches, no singletons. Two workers calling `resolveOne` in the
 * same Node process cannot interfere with each other — the inputs are
 * primitives or plain objects, the outputs are fresh strings. Safe by
 * construction for the framework's parallel-execution model.
 *
 * @module element/CSFrameResolver
 */

import { FrameSelector } from './CSWebElement';

/**
 * Accepted shapes for a frame specification:
 * - `string`: auto-detected as XPath (when starting with `/` or `//`) or CSS.
 * - `FrameSelector`: explicit object form (xpath, css, id, name, title,
 *   testId, src, or index).
 * - `Array<string | FrameSelector>`: nested iframes, outermost first. Each
 *   entry is resolved independently, so strategies may be freely mixed.
 */
export type FrameInput = string | FrameSelector | Array<string | FrameSelector>;

export class CSFrameResolver {
    /**
     * Resolve a single frame entry (string or {@link FrameSelector} object) to
     * its canonical Playwright selector form.
     *
     * @param frame - String selector or FrameSelector object.
     * @returns Canonical selector string usable with Playwright's
     *   `frameLocator()` / `locator()`.
     * @throws Error if a FrameSelector object specifies none of the
     *   supported keys.
     */
    public static resolveOne(frame: string | FrameSelector): string {
        // String input - auto-detect type
        if (typeof frame === 'string') {
            return CSFrameResolver.autoDetect(frame);
        }

        // Object input - explicit type (priority order matches legacy behavior)
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
     * Resolve a {@link FrameInput} (single value or array) to an outer-to-inner
     * ordered array of canonical Playwright selectors.
     *
     * @param frame - Frame input (single or array).
     * @returns Array of canonical selector strings, outermost first.
     */
    public static resolveChain(frame: FrameInput): string[] {
        const chain: Array<string | FrameSelector> = Array.isArray(frame) ? frame : [frame];
        return chain.map(f => CSFrameResolver.resolveOne(f));
    }

    /**
     * Build a Playwright FrameLocator chain from a {@link FrameInput}, anchored
     * on the given Page or FrameLocator. Returns the innermost FrameLocator
     * (or the original `root` if the chain is empty).
     *
     * @param root - Playwright Page or FrameLocator to start from.
     * @param frame - Frame input describing the chain to enter.
     * @returns The innermost FrameLocator, ready to scope element queries.
     */
    public static buildContext(root: any /* Page | FrameLocator */, frame: FrameInput): any {
        const selectors = CSFrameResolver.resolveChain(frame);
        let ctx: any = root;
        for (const sel of selectors) {
            ctx = ctx.frameLocator(sel);
        }
        return ctx;
    }

    /**
     * Auto-detect the canonical form of a string frame selector.
     *
     * - Strings starting with `/` or `//` are treated as XPath and prefixed
     *   with `xpath=`.
     * - Strings already prefixed with `xpath=` or `css=` pass through.
     * - Strings starting with `#` (CSS id) pass through.
     * - Everything else is assumed to be CSS and passes through.
     */
    private static autoDetect(selector: string): string {
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
}
