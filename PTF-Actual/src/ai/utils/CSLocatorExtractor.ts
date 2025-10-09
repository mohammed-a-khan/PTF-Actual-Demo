/**
 * Utility to extract locators from Playwright error messages
 */
export class CSLocatorExtractor {
    /**
     * Extract locator from Playwright error message
     * Examples:
     * - "Timeout 30000ms exceeded waiting for selector '#login-button'"
     * - "Element not found: button[name='submit']"
     * - "locator.click: Timeout 30000ms exceeded"
     */
    public static extractFromError(error: Error): string {
        const message = error.message || '';

        // Pattern 1: "selector 'LOCATOR'"  or "selector \"LOCATOR\""
        const selectorPattern = /selector\s+['"]([^'"]+)['"]/i;
        const selectorMatch = message.match(selectorPattern);
        if (selectorMatch) {
            return selectorMatch[1];
        }

        // Pattern 2: "locator('LOCATOR')" or "locator(\"LOCATOR\")"
        const locatorPattern = /locator\(['"]([^'"]+)['"]\)/i;
        const locatorMatch = message.match(locatorPattern);
        if (locatorMatch) {
            return locatorMatch[1];
        }

        // Pattern 3: CSS/XPath selectors in error messages
        const cssPattern = /(#[\w-]+|\.[\w-]+|\[[\w-]+=['"]?[\w-]+['"]?\]|[\w-]+\[[\w-]+\])/;
        const cssMatch = message.match(cssPattern);
        if (cssMatch) {
            return cssMatch[1];
        }

        // Pattern 4: XPath
        const xpathPattern = /(\/\/[\w\[\]@='"\s\/\*]+)/;
        const xpathMatch = message.match(xpathPattern);
        if (xpathMatch) {
            return xpathMatch[1];
        }

        // Pattern 5: text='' or text=""
        const textPattern = /text=['"]([^'"]+)['"]/i;
        const textMatch = message.match(textPattern);
        if (textMatch) {
            return `text="${textMatch[1]}"`;
        }

        // No locator found
        return '';
    }

    /**
     * Validate if extracted locator seems valid
     */
    public static isValidLocator(locator: string): boolean {
        if (!locator || locator.length === 0) {
            return false;
        }

        // Too short (likely noise)
        if (locator.length < 2) {
            return false;
        }

        // Too long (likely not a real locator)
        if (locator.length > 500) {
            return false;
        }

        return true;
    }

    /**
     * Extract and validate locator from error
     */
    public static extract(error: Error): string {
        const locator = this.extractFromError(error);
        return this.isValidLocator(locator) ? locator : '';
    }
}
