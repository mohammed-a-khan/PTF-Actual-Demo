import { Page, Locator } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';

/**
 * Normalized locator result containing the improved locator, the strategy
 * that produced it, a human-readable description, and a quality rating.
 */
export interface NormalizedLocatorResult {
    locator: Locator;
    strategy: string;
    description: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
}

/**
 * Locator suggestion with the original selector, a recommended replacement,
 * and the reason for the recommendation.
 */
export interface LocatorSuggestion {
    original: string;
    suggested: string;
    reason: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
}

/**
 * CSLocatorNormalizer - Locator Normalization Utility
 *
 * Enhancement #4: Improves locator quality by converting raw CSS/XPath selectors
 * to best-practice Playwright locators (getByRole, getByTestId, getByLabel, etc.).
 *
 * Normalization strategy (in priority order):
 * 1. Native Playwright normalize() if available (v1.59+)
 * 2. data-testid attribute -> getByTestId()
 * 3. Accessible role + name -> getByRole()
 * 4. Input with associated label -> getByLabel()
 * 5. Placeholder text -> getByPlaceholder()
 * 6. Alt text (images) -> getByAltText()
 * 7. Title attribute -> getByTitle()
 * 8. Fallback: original page.locator(selector)
 *
 * Singleton pattern consistent with the framework.
 */
export class CSLocatorNormalizer {
    private static instance: CSLocatorNormalizer;

    private constructor() {
        // Singleton — no initialization needed
    }

    public static getInstance(): CSLocatorNormalizer {
        if (!CSLocatorNormalizer.instance) {
            CSLocatorNormalizer.instance = new CSLocatorNormalizer();
        }
        return CSLocatorNormalizer.instance;
    }

    // =========================================================================
    // PRIMARY API
    // =========================================================================

    /**
     * Takes a CSS or XPath selector and returns a normalized Playwright locator
     * that follows best practices. The method inspects the matched DOM element
     * and selects the highest-quality locator strategy available.
     *
     * @param page - Playwright Page instance
     * @param selector - CSS or XPath selector string
     * @returns NormalizedLocatorResult with locator, strategy, description, and quality
     */
    public async normalizeLocator(page: Page, selector: string): Promise<NormalizedLocatorResult> {
        CSReporter.debug(`Normalizing locator: ${selector}`);

        const originalLocator = page.locator(selector);

        // Attempt native Playwright normalize() (v1.59+)
        const nativeResult = await this.tryNativeNormalize(originalLocator);
        if (nativeResult) {
            const desc = await this.describeLocator(nativeResult);
            CSReporter.debug(`Used native normalize() for: ${selector}`);
            return {
                locator: nativeResult,
                strategy: 'native-normalize',
                description: desc,
                quality: 'excellent'
            };
        }

        // Inspect the element's attributes to determine the best locator strategy
        try {
            // Wait briefly for element to exist
            await originalLocator.first().waitFor({ state: 'attached', timeout: 5000 });
        } catch {
            // Element not found — return original with poor quality
            CSReporter.debug(`Element not found for selector: ${selector}, returning original`);
            return {
                locator: originalLocator,
                strategy: 'fallback-original',
                description: `locator('${selector}')`,
                quality: CSLocatorNormalizer.getLocatorQuality(selector)
            };
        }

        // Extract element attributes from the DOM
        const attrs = await originalLocator.first().evaluate((el: Element) => {
            const computedRole = el.getAttribute('role') || el.tagName.toLowerCase();
            const ariaLabel = el.getAttribute('aria-label') || '';
            const testId =
                el.getAttribute('data-testid') ||
                el.getAttribute('data-test-id') ||
                el.getAttribute('data-test') ||
                '';
            const placeholder = el.getAttribute('placeholder') || '';
            const alt = el.getAttribute('alt') || '';
            const title = el.getAttribute('title') || '';
            const name = el.getAttribute('name') || '';
            const type = el.getAttribute('type') || '';
            const tagName = el.tagName.toLowerCase();

            // Try to find an associated label for input elements
            let labelText = '';
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
                // Check for <label for="id">
                if (el.id) {
                    const labelEl = document.querySelector(`label[for="${el.id}"]`);
                    if (labelEl) {
                        labelText = (labelEl as HTMLElement).innerText?.trim() || '';
                    }
                }
                // Check for wrapping <label>
                if (!labelText) {
                    const parentLabel = el.closest('label');
                    if (parentLabel) {
                        // Get label text excluding the input element's own text
                        const clone = parentLabel.cloneNode(true) as HTMLElement;
                        const inputs = clone.querySelectorAll('input, select, textarea');
                        inputs.forEach(inp => inp.remove());
                        labelText = clone.innerText?.trim() || '';
                    }
                }
                // Check aria-labelledby
                if (!labelText) {
                    const labelledBy = el.getAttribute('aria-labelledby');
                    if (labelledBy) {
                        const labelEl = document.getElementById(labelledBy);
                        if (labelEl) {
                            labelText = labelEl.innerText?.trim() || '';
                        }
                    }
                }
            }

            // Get accessible name via innerText for buttons/links
            let accessibleName = ariaLabel;
            if (!accessibleName && (tagName === 'button' || tagName === 'a' || computedRole === 'button' || computedRole === 'link')) {
                accessibleName = (el as HTMLElement).innerText?.trim()?.substring(0, 100) || '';
            }

            // Map HTML tag to ARIA role
            let effectiveRole = computedRole;
            const tagToRole: Record<string, string> = {
                'button': 'button',
                'a': 'link',
                'input': type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' ? 'button' : 'textbox',
                'select': 'combobox',
                'textarea': 'textbox',
                'img': 'img',
                'h1': 'heading',
                'h2': 'heading',
                'h3': 'heading',
                'h4': 'heading',
                'h5': 'heading',
                'h6': 'heading',
                'nav': 'navigation',
                'main': 'main',
                'aside': 'complementary',
                'footer': 'contentinfo',
                'header': 'banner',
                'table': 'table',
                'tr': 'row',
                'td': 'cell',
                'th': 'columnheader',
                'ul': 'list',
                'ol': 'list',
                'li': 'listitem',
                'dialog': 'dialog'
            };
            if (!el.getAttribute('role') && tagToRole[tagName]) {
                effectiveRole = tagToRole[tagName];
            }

            return {
                tagName,
                effectiveRole,
                accessibleName,
                testId,
                labelText,
                placeholder,
                alt,
                title,
                name,
                type
            };
        });

        // Strategy 1: data-testid
        if (attrs.testId) {
            const locator = page.getByTestId(attrs.testId);
            const desc = `getByTestId('${attrs.testId}')`;
            CSReporter.debug(`Normalized '${selector}' -> ${desc}`);
            return { locator, strategy: 'data-testid', description: desc, quality: 'excellent' };
        }

        // Strategy 2: role + accessible name
        if (attrs.effectiveRole && attrs.accessibleName) {
            const role = attrs.effectiveRole as any;
            const locator = page.getByRole(role, { name: attrs.accessibleName });
            const desc = `getByRole('${role}', { name: '${attrs.accessibleName}' })`;
            CSReporter.debug(`Normalized '${selector}' -> ${desc}`);
            return { locator, strategy: 'role-name', description: desc, quality: 'excellent' };
        }

        // Strategy 3: label text (for form inputs)
        if (attrs.labelText) {
            const locator = page.getByLabel(attrs.labelText);
            const desc = `getByLabel('${attrs.labelText}')`;
            CSReporter.debug(`Normalized '${selector}' -> ${desc}`);
            return { locator, strategy: 'label', description: desc, quality: 'excellent' };
        }

        // Strategy 4: placeholder
        if (attrs.placeholder) {
            const locator = page.getByPlaceholder(attrs.placeholder);
            const desc = `getByPlaceholder('${attrs.placeholder}')`;
            CSReporter.debug(`Normalized '${selector}' -> ${desc}`);
            return { locator, strategy: 'placeholder', description: desc, quality: 'good' };
        }

        // Strategy 5: alt text (images)
        if (attrs.alt) {
            const locator = page.getByAltText(attrs.alt);
            const desc = `getByAltText('${attrs.alt}')`;
            CSReporter.debug(`Normalized '${selector}' -> ${desc}`);
            return { locator, strategy: 'alt-text', description: desc, quality: 'good' };
        }

        // Strategy 6: title attribute
        if (attrs.title) {
            const locator = page.getByTitle(attrs.title);
            const desc = `getByTitle('${attrs.title}')`;
            CSReporter.debug(`Normalized '${selector}' -> ${desc}`);
            return { locator, strategy: 'title', description: desc, quality: 'good' };
        }

        // Strategy 7: role only (no accessible name)
        if (attrs.effectiveRole && attrs.effectiveRole !== attrs.tagName) {
            const role = attrs.effectiveRole as any;
            const locator = page.getByRole(role);
            const desc = `getByRole('${role}')`;
            CSReporter.debug(`Normalized '${selector}' -> ${desc} (no accessible name)`);
            return { locator, strategy: 'role-only', description: desc, quality: 'fair' };
        }

        // Fallback: return original locator
        const quality = CSLocatorNormalizer.getLocatorQuality(selector);
        CSReporter.debug(`No normalization available for '${selector}', keeping original (quality: ${quality})`);
        return {
            locator: originalLocator,
            strategy: 'fallback-original',
            description: `locator('${selector}')`,
            quality
        };
    }

    /**
     * Returns a human-readable description of a locator using Playwright's
     * locator.describe() API (available since v1.58.2). Falls back gracefully
     * if the API is not available.
     *
     * @param locator - Playwright Locator instance
     * @returns Human-readable description string
     */
    public async describeLocator(locator: Locator): Promise<string> {
        try {
            // locator.description() returns the description set via describe(),
            // or null if none was set. Available since Playwright 1.58.2.
            if (typeof locator.description === 'function') {
                const desc = locator.description();
                if (desc) {
                    return desc;
                }
            }
        } catch {
            // description() not available in this Playwright version
        }

        // Fallback: toString() returns a human-readable representation
        // based on the locator's selector
        return locator.toString();
    }

    /**
     * Batch-normalize multiple selectors. Returns a Map from original selector
     * to normalized result.
     *
     * @param page - Playwright Page instance
     * @param selectors - Array of CSS/XPath selectors to normalize
     * @returns Map from original selector string to NormalizedLocatorResult
     */
    public async normalizePageLocators(
        page: Page,
        selectors: string[]
    ): Promise<Map<string, NormalizedLocatorResult>> {
        const results = new Map<string, NormalizedLocatorResult>();

        CSReporter.info(`Normalizing ${selectors.length} locator(s)`);

        for (const selector of selectors) {
            try {
                const result = await this.normalizeLocator(page, selector);
                results.set(selector, result);
            } catch (error: any) {
                CSReporter.warn(`Failed to normalize '${selector}': ${error.message}`);
                // Store fallback result
                results.set(selector, {
                    locator: page.locator(selector),
                    strategy: 'error-fallback',
                    description: `locator('${selector}')`,
                    quality: CSLocatorNormalizer.getLocatorQuality(selector)
                });
            }
        }

        // Log summary
        const qualityCounts = { excellent: 0, good: 0, fair: 0, poor: 0 };
        for (const result of results.values()) {
            qualityCounts[result.quality]++;
        }
        CSReporter.info(
            `Locator normalization complete: ${qualityCounts.excellent} excellent, ` +
            `${qualityCounts.good} good, ${qualityCounts.fair} fair, ${qualityCounts.poor} poor`
        );

        return results;
    }

    /**
     * Analyzes a selector and suggests a better alternative based on the
     * element's accessible attributes. Returns a LocatorSuggestion with the
     * recommended replacement and reasoning.
     *
     * @param page - Playwright Page instance
     * @param selector - CSS/XPath selector to analyze
     * @returns LocatorSuggestion with the recommended improvement
     */
    public async suggestBetterLocator(page: Page, selector: string): Promise<LocatorSuggestion> {
        const currentQuality = CSLocatorNormalizer.getLocatorQuality(selector);

        if (currentQuality === 'excellent') {
            return {
                original: selector,
                suggested: selector,
                reason: 'Selector already follows best practices.',
                quality: 'excellent'
            };
        }

        try {
            const normalized = await this.normalizeLocator(page, selector);

            if (normalized.strategy === 'fallback-original' || normalized.strategy === 'error-fallback') {
                // Could not find a better locator
                const reasons: string[] = [];
                if (selector.match(/\d{3,}/)) {
                    reasons.push('Selector appears to contain generated/dynamic IDs.');
                }
                if (selector.includes(':nth')) {
                    reasons.push('Selector uses positional indexing which is fragile.');
                }
                if (selector.split(' ').length > 3) {
                    reasons.push('Selector chain is too deep — consider adding data-testid to the target element.');
                }
                if (selector.startsWith('//') || selector.startsWith('xpath=')) {
                    reasons.push('XPath selectors are harder to maintain. Consider adding accessible attributes.');
                }

                return {
                    original: selector,
                    suggested: selector,
                    reason: reasons.length > 0
                        ? reasons.join(' ')
                        : 'No better locator strategy found. Consider adding data-testid or aria attributes to the element.',
                    quality: currentQuality
                };
            }

            // Found a better locator
            const reason = CSLocatorNormalizer.buildSuggestionReason(selector, normalized);

            return {
                original: selector,
                suggested: normalized.description,
                reason,
                quality: normalized.quality
            };
        } catch (error: any) {
            return {
                original: selector,
                suggested: selector,
                reason: `Unable to analyze element: ${error.message}`,
                quality: currentQuality
            };
        }
    }

    // =========================================================================
    // STATIC UTILITIES (no browser needed)
    // =========================================================================

    /**
     * Rates a selector's quality without requiring a browser or page instance.
     * This is a pure static analysis based on selector patterns.
     *
     * Rating criteria:
     * - Excellent: data-testid, getByRole, getByLabel patterns
     * - Good: Stable ID selectors (without generated numbers), [name="..."]
     * - Fair: Single class selectors, simple tag selectors
     * - Poor: nth-child, deep CSS chains (>3 levels), XPath with indexes
     *
     * @param selector - CSS, XPath, or Playwright selector string
     * @returns Quality rating
     */
    static getLocatorQuality(selector: string): 'excellent' | 'good' | 'fair' | 'poor' {
        // Excellent: test IDs and semantic locators
        if (
            selector.includes('data-testid') ||
            selector.includes('data-test-id') ||
            selector.includes('data-test') ||
            selector.startsWith('getByRole') ||
            selector.startsWith('getByLabel') ||
            selector.startsWith('getByTestId')
        ) {
            return 'excellent';
        }

        // Poor: positional selectors, deep chains, XPath indexes
        if (
            selector.includes(':nth-child') ||
            selector.includes(':nth-of-type') ||
            selector.includes('>>') ||
            selector.split(' ').length > 3 ||
            /\/\/.*\[\d+\]/.test(selector) ||  // XPath with numeric index
            /\.[\w-]+\s+\.[\w-]+\s+\.[\w-]+\s+\.[\w-]+/.test(selector)  // 4+ class chain
        ) {
            return 'poor';
        }

        // Good: stable ID selectors (no generated numbers), name attributes
        if (selector.match(/^#[a-zA-Z][\w-]*$/) && !selector.match(/\d{3,}/)) {
            return 'good';
        }
        if (selector.includes('[name=')) {
            return 'good';
        }
        if (selector.match(/^#[a-zA-Z]/)) {
            // ID with possible generated numbers
            return selector.match(/\d{3,}/) ? 'fair' : 'good';
        }

        // Fair: single class, simple tag
        if (selector.match(/^\.[a-zA-Z][\w-]*$/) && !selector.includes(' ')) {
            return 'fair';
        }
        if (selector.match(/^[a-zA-Z]+$/) && !selector.includes(' ')) {
            return 'fair'; // Simple tag name like 'button'
        }

        return 'fair';
    }

    // =========================================================================
    // PRIVATE METHODS
    // =========================================================================

    /**
     * Attempt to use Playwright's native locator.normalize() method, which is
     * available starting from Playwright v1.59. Returns null if the method
     * does not exist on the current Playwright version.
     */
    private async tryNativeNormalize(locator: Locator): Promise<Locator | null> {
        try {
            if (typeof (locator as any).normalize === 'function') {
                return await (locator as any).normalize();
            }
        } catch {
            // normalize() not available in this Playwright version
        }
        return null;
    }

    /**
     * Build a human-readable reason string explaining why the suggested
     * locator is better than the original selector.
     */
    private static buildSuggestionReason(
        original: string,
        normalized: NormalizedLocatorResult
    ): string {
        const strategyDescriptions: Record<string, string> = {
            'data-testid': `Selector '${original}' can be replaced with ${normalized.description} which uses a stable test ID attribute.`,
            'role-name': `Selector '${original}' can be replaced with ${normalized.description} which uses semantic role and accessible name. This is more resilient to DOM structure changes.`,
            'label': `Selector '${original}' can be replaced with ${normalized.description} which uses the associated label text. This mirrors how users identify form fields.`,
            'placeholder': `Selector '${original}' can be replaced with ${normalized.description} which uses placeholder text.`,
            'alt-text': `Selector '${original}' can be replaced with ${normalized.description} which uses the image alt text.`,
            'title': `Selector '${original}' can be replaced with ${normalized.description} which uses the title attribute.`,
            'role-only': `Selector '${original}' can be replaced with ${normalized.description}. Consider adding an aria-label to improve specificity.`,
            'native-normalize': `Selector '${original}' was normalized by Playwright's built-in normalize() method to ${normalized.description}.`
        };

        return strategyDescriptions[normalized.strategy] ||
            `Selector '${original}' can be replaced with ${normalized.description}.`;
    }

    /**
     * Reset the singleton instance (useful for testing).
     */
    public static resetInstance(): void {
        CSLocatorNormalizer.instance = undefined as any;
    }
}
