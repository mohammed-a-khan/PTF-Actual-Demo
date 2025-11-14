/**
 * Global Element Registry
 *
 * Detects duplicate elements across ALL pages and intelligently decides:
 * - Which elements should be in BasePage
 * - Which elements should be in shared components
 * - Which elements are page-specific
 *
 * Prevents code duplication and promotes reusability.
 */

import { GeneratedElement } from '../types';
import { CSReporter } from '../../reporter/CSReporter';

export interface ElementUsage {
    element: GeneratedElement;
    pages: Set<string>;
    usageCount: number;
    firstSeen: string; // Page name where first seen
    locatorVariations: string[]; // Different locators for same element
}

export interface SharedElement {
    canonicalName: string;
    locator: string;
    type: string;
    pages: string[];
    reason: string; // Why it's shared
}

export interface ElementPlacementStrategy {
    basePage: SharedElement[];
    sharedComponents: Map<string, SharedElement[]>; // Component name -> elements
    pageSpecific: Map<string, GeneratedElement[]>; // Page name -> elements
}

export class GlobalElementRegistry {
    private elements: Map<string, ElementUsage> = new Map();
    private readonly SHARED_THRESHOLD = 2; // Element used in 2+ pages = shared

    /**
     * Register an element from a page
     */
    public registerElement(element: GeneratedElement, pageName: string): void {
        const key = this.generateElementKey(element);

        if (this.elements.has(key)) {
            // Element already exists - update usage
            const usage = this.elements.get(key)!;
            usage.pages.add(pageName);
            usage.usageCount++;

            // Track locator variations
            if (!usage.locatorVariations.includes(element.locator)) {
                usage.locatorVariations.push(element.locator);
            }

            CSReporter.debug(`🔄 Duplicate element detected: ${element.name} (now used in ${usage.pages.size} pages)`);
        } else {
            // New element
            this.elements.set(key, {
                element,
                pages: new Set([pageName]),
                usageCount: 1,
                firstSeen: pageName,
                locatorVariations: [element.locator]
            });
        }
    }

    /**
     * Batch register elements from a page
     */
    public registerPageElements(elements: GeneratedElement[], pageName: string): void {
        CSReporter.debug(`📝 Registering ${elements.length} elements from ${pageName}`);

        for (const element of elements) {
            this.registerElement(element, pageName);
        }
    }

    /**
     * Check if element should be shared (SMART detection)
     */
    public shouldBeShared(element: GeneratedElement): boolean {
        // ✅ SMART RULE 1: Navigation links are ALWAYS shared (even if used once)
        if (this.isNavigationElement(element)) {
            return true;
        }

        // ✅ SMART RULE 2: Header/footer elements are always shared
        if (this.isHeaderFooterElement(element)) {
            return true;
        }

        // ✅ SMART RULE 3: Check usage count
        const key = this.generateElementKey(element);
        const usage = this.elements.get(key);

        return usage ? usage.pages.size >= this.SHARED_THRESHOLD : false;
    }

    /**
     * Detect if element is a navigation element
     */
    private isNavigationElement(element: GeneratedElement): boolean {
        const name = element.name.toLowerCase();
        const locator = element.locator.toLowerCase();

        // Navigation keywords
        const navKeywords = [
            'admin', 'dashboard', 'leave', 'time', 'recruitment', 'pim',
            'performance', 'report', 'menu', 'nav', 'sidebar', 'tab',
            'home', 'profile', 'settings', 'logout'
        ];

        // Check if it's a link role (strong indicator of navigation)
        const isLink = locator.includes('role=link') || name.endsWith('link');

        // Check if name contains navigation keywords
        const hasNavKeyword = navKeywords.some(kw => name.includes(kw) || locator.includes(kw));

        return isLink && hasNavKeyword;
    }

    /**
     * Detect if element is in header/footer
     */
    private isHeaderFooterElement(element: GeneratedElement): boolean {
        const locator = element.locator.toLowerCase();
        const name = element.name.toLowerCase();

        const headerFooterPatterns = [
            'header', 'footer', 'topnav', 'navbar', 'banner',
            'logo', 'brand', 'user-menu', 'profile-dropdown'
        ];

        return headerFooterPatterns.some(pattern =>
            locator.includes(pattern) || name.includes(pattern)
        );
    }

    /**
     * Get all shared elements
     */
    public getSharedElements(): SharedElement[] {
        const shared: SharedElement[] = [];

        for (const [key, usage] of this.elements) {
            if (usage.pages.size >= this.SHARED_THRESHOLD) {
                shared.push({
                    canonicalName: usage.element.name,
                    locator: this.selectBestLocator(usage),
                    type: usage.element.type,
                    pages: Array.from(usage.pages),
                    reason: this.determineSharedReason(usage)
                });
            }
        }

        CSReporter.info(`🔍 Found ${shared.length} shared elements across pages`);

        return shared;
    }

    /**
     * Get placement strategy for all elements
     */
    public getPlacementStrategy(allPages: Map<string, GeneratedElement[]>): ElementPlacementStrategy {
        CSReporter.info('🎯 Computing optimal element placement strategy...');

        const strategy: ElementPlacementStrategy = {
            basePage: [],
            sharedComponents: new Map(),
            pageSpecific: new Map()
        };

        // Categorize elements
        for (const [key, usage] of this.elements) {
            if (usage.pages.size >= this.SHARED_THRESHOLD) {
                // Shared element - decide placement
                const sharedElement: SharedElement = {
                    canonicalName: usage.element.name,
                    locator: this.selectBestLocator(usage),
                    type: usage.element.type,
                    pages: Array.from(usage.pages),
                    reason: this.determineSharedReason(usage)
                };

                if (this.shouldBeInBasePage(usage)) {
                    strategy.basePage.push(sharedElement);
                } else {
                    // Group into shared component
                    const componentName = this.determineComponentName(usage);
                    if (!strategy.sharedComponents.has(componentName)) {
                        strategy.sharedComponents.set(componentName, []);
                    }
                    strategy.sharedComponents.get(componentName)!.push(sharedElement);
                }
            } else {
                // Page-specific element
                const pageName = usage.firstSeen;
                if (!strategy.pageSpecific.has(pageName)) {
                    strategy.pageSpecific.set(pageName, []);
                }
                strategy.pageSpecific.get(pageName)!.push(usage.element);
            }
        }

        this.logPlacementSummary(strategy);

        return strategy;
    }

    /**
     * Generate unique key for element
     */
    private generateElementKey(element: GeneratedElement): string {
        // Normalize element name (remove suffixes like Field, Button, etc.)
        const normalizedName = element.name
            .replace(/Button$/, '')
            .replace(/Field$/, '')
            .replace(/Input$/, '')
            .replace(/Link$/, '')
            .replace(/Label$/, '')
            .toLowerCase();

        // Consider element type
        const type = element.type.toLowerCase();

        // Consider locator pattern (simplified)
        const locatorPattern = this.simplifyLocator(element.locator);

        return `${normalizedName}:${type}:${locatorPattern}`;
    }

    /**
     * Simplify locator to pattern
     */
    private simplifyLocator(locator: string): string {
        // Remove specific values, keep structure
        return locator
            .replace(/"[^"]*"/g, '""') // Remove string values
            .replace(/\d+/g, 'N') // Remove numbers
            .substring(0, 50); // Limit length
    }

    /**
     * Select best locator from variations
     */
    private selectBestLocator(usage: ElementUsage): string {
        // Prefer shortest, most stable locator
        const locators = usage.locatorVariations;

        // Score each locator
        const scored = locators.map(loc => ({
            locator: loc,
            score: this.scoreLocator(loc)
        }));

        // Sort by score (higher = better)
        scored.sort((a, b) => b.score - a.score);

        return scored[0].locator;
    }

    /**
     * Score locator for stability and maintainability
     */
    private scoreLocator(locator: string): number {
        let score = 0;

        // Prefer data-testid (most stable)
        if (locator.includes('data-testid') || locator.includes('testId')) {
            score += 100;
        }

        // Prefer role-based selectors
        if (locator.includes('getByRole') || locator.includes('role=')) {
            score += 80;
        }

        // Prefer label/text selectors
        if (locator.includes('getByLabel') || locator.includes('getByText')) {
            score += 60;
        }

        // Penalize xpath
        if (locator.includes('//') || locator.includes('xpath=')) {
            score -= 20;
        }

        // Penalize complex selectors
        score -= locator.length / 10;

        // Penalize index-based selectors
        if (locator.match(/\[\d+\]/) || locator.includes('nth(')) {
            score -= 30;
        }

        return score;
    }

    /**
     * Determine why element is shared
     */
    private determineSharedReason(usage: ElementUsage): string {
        const name = usage.element.name.toLowerCase();

        // Common UI elements
        if (name.includes('logo') || name.includes('header') || name.includes('footer')) {
            return 'Common layout element';
        }

        if (name.includes('menu') || name.includes('nav')) {
            return 'Navigation element';
        }

        if (name.includes('search') || name.includes('filter')) {
            return 'Common search/filter element';
        }

        if (name.includes('user') || name.includes('profile') || name.includes('account')) {
            return 'User-related element';
        }

        if (name.includes('button') || name.includes('link')) {
            return 'Common interactive element';
        }

        return `Used in ${usage.pages.size} pages`;
    }

    /**
     * Determine if element should be in BasePage
     */
    private shouldBeInBasePage(usage: ElementUsage): boolean {
        const name = usage.element.name.toLowerCase();

        // Very common elements go to BasePage
        const basePageElements = [
            'logo', 'header', 'footer', 'menu', 'nav',
            'search', 'user', 'profile', 'account', 'logout',
            'help', 'settings', 'notification'
        ];

        for (const keyword of basePageElements) {
            if (name.includes(keyword)) {
                return true;
            }
        }

        // Elements used in >50% of pages go to BasePage
        // This would require knowing total page count
        return usage.pages.size >= 3; // Heuristic: 3+ pages = BasePage
    }

    /**
     * Determine component name for grouped elements
     */
    private determineComponentName(usage: ElementUsage): string {
        const name = usage.element.name.toLowerCase();

        if (name.includes('search') || name.includes('filter')) {
            return 'SearchComponent';
        }

        if (name.includes('form') || name.includes('input')) {
            return 'FormComponent';
        }

        if (name.includes('table') || name.includes('grid') || name.includes('list')) {
            return 'DataComponent';
        }

        if (name.includes('modal') || name.includes('dialog') || name.includes('popup')) {
            return 'ModalComponent';
        }

        return 'SharedComponent';
    }

    /**
     * Log placement summary
     */
    private logPlacementSummary(strategy: ElementPlacementStrategy): void {
        CSReporter.info('\n📊 Element Placement Strategy:');
        CSReporter.info(`   BasePage: ${strategy.basePage.length} elements`);
        CSReporter.info(`   Shared Components: ${strategy.sharedComponents.size} components`);

        for (const [name, elements] of strategy.sharedComponents) {
            CSReporter.info(`      - ${name}: ${elements.length} elements`);
        }

        const totalPageSpecific = Array.from(strategy.pageSpecific.values())
            .reduce((sum, elements) => sum + elements.length, 0);

        CSReporter.info(`   Page-Specific: ${totalPageSpecific} elements across ${strategy.pageSpecific.size} pages`);
    }

    /**
     * Get element statistics
     */
    public getStatistics(): {
        total: number;
        shared: number;
        pageSpecific: number;
        averageUsage: number;
        mostUsedElement: { name: string; pages: number } | null;
    } {
        let totalShared = 0;
        let totalPageSpecific = 0;
        let totalUsage = 0;
        let mostUsed: { name: string; pages: number } | null = null;

        for (const usage of this.elements.values()) {
            totalUsage += usage.pages.size;

            if (usage.pages.size >= this.SHARED_THRESHOLD) {
                totalShared++;
            } else {
                totalPageSpecific++;
            }

            if (!mostUsed || usage.pages.size > mostUsed.pages) {
                mostUsed = {
                    name: usage.element.name,
                    pages: usage.pages.size
                };
            }
        }

        return {
            total: this.elements.size,
            shared: totalShared,
            pageSpecific: totalPageSpecific,
            averageUsage: this.elements.size > 0 ? totalUsage / this.elements.size : 0,
            mostUsedElement: mostUsed
        };
    }

    /**
     * Get elements by page
     */
    public getElementsByPage(pageName: string): GeneratedElement[] {
        const elements: GeneratedElement[] = [];

        for (const usage of this.elements.values()) {
            if (usage.pages.has(pageName)) {
                elements.push(usage.element);
            }
        }

        return elements;
    }

    /**
     * Check for duplicate elements with different names
     */
    public findDuplicatesWithDifferentNames(): Array<{
        elements: GeneratedElement[];
        locator: string;
        suggestion: string;
    }> {
        const byLocator = new Map<string, GeneratedElement[]>();

        // Group by locator
        for (const usage of this.elements.values()) {
            const simplified = this.simplifyLocator(usage.element.locator);

            if (!byLocator.has(simplified)) {
                byLocator.set(simplified, []);
            }

            byLocator.get(simplified)!.push(usage.element);
        }

        // Find groups with multiple names
        const duplicates: Array<{
            elements: GeneratedElement[];
            locator: string;
            suggestion: string;
        }> = [];

        for (const [locator, elements] of byLocator) {
            if (elements.length > 1) {
                // Multiple names for same locator
                const names = new Set(elements.map(e => e.name));

                if (names.size > 1) {
                    duplicates.push({
                        elements,
                        locator: elements[0].locator,
                        suggestion: `Consider using a single name: ${this.suggestCanonicalName(elements)}`
                    });
                }
            }
        }

        if (duplicates.length > 0) {
            CSReporter.warn(`⚠️ Found ${duplicates.length} elements with different names but same locator`);
        }

        return duplicates;
    }

    /**
     * Suggest canonical name for duplicate elements
     */
    private suggestCanonicalName(elements: GeneratedElement[]): string {
        // Use shortest, most descriptive name
        const names = elements.map(e => e.name);
        names.sort((a, b) => a.length - b.length);

        return names[0];
    }

    /**
     * Clear registry
     */
    public clear(): void {
        this.elements.clear();
        CSReporter.debug('🗑️ Element registry cleared');
    }

    /**
     * Export registry for persistence
     */
    public export(): Record<string, any> {
        const exported: Record<string, any> = {};

        for (const [key, usage] of this.elements) {
            exported[key] = {
                element: usage.element,
                pages: Array.from(usage.pages),
                usageCount: usage.usageCount,
                firstSeen: usage.firstSeen,
                locatorVariations: usage.locatorVariations
            };
        }

        return exported;
    }
}
