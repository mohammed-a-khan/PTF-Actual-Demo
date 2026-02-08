/**
 * CSAccessibilityTreeMatcher - Element Matching via Accessibility Tree
 *
 * 4-strategy cascade for finding elements on the page:
 *   1. Accessibility Tree (primary) - ariaSnapshot() + weighted scoring
 *   2. Playwright Semantic Locators (fallback) - getByRole/getByText/getByLabel
 *   3. Text-based search (fallback) - text content matching
 *   4. Role-based search (last resort) - ARIA role + keyword matching
 *
 * Uses Jaro-Winkler similarity for fuzzy text matching.
 *
 * @module ai/step-engine
 */

import { Page, Locator } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';
import {
    ElementTarget,
    MatchedElement,
    AlternativeMatch,
    MatchMethod,
    AccessibilityNode,
    AccessibilityMatchScore,
    StepIntent,
    ELEMENT_TYPE_TO_ROLES,
    INTENT_TO_LIKELY_ROLES,
    CSAIStepConfig,
    DEFAULT_AI_STEP_CONFIG
} from './CSAIStepTypes';

export class CSAccessibilityTreeMatcher {
    private static instance: CSAccessibilityTreeMatcher;

    /** Cached accessibility snapshot */
    private snapshotCache: { snapshot: string; timestamp: number; url: string } | null = null;

    private config: CSAIStepConfig;

    private constructor(config?: Partial<CSAIStepConfig>) {
        this.config = { ...DEFAULT_AI_STEP_CONFIG, ...config };
    }

    /** Get singleton instance */
    public static getInstance(config?: Partial<CSAIStepConfig>): CSAccessibilityTreeMatcher {
        if (!CSAccessibilityTreeMatcher.instance) {
            CSAccessibilityTreeMatcher.instance = new CSAccessibilityTreeMatcher(config);
        }
        return CSAccessibilityTreeMatcher.instance;
    }

    /**
     * Find element matching the target description on the page
     * Uses 4-strategy cascade with confidence scoring
     *
     * @param page - Playwright page
     * @param target - Parsed element target
     * @param intent - Step intent (helps infer element roles)
     * @returns MatchedElement with locator and confidence, or null
     */
    public async findElement(
        page: Page,
        target: ElementTarget,
        intent: StepIntent
    ): Promise<MatchedElement | null> {
        const startTime = Date.now();
        const searchText = this.buildSearchText(target);

        if (!searchText && !target.elementType) {
            CSReporter.debug('CSAccessibilityTreeMatcher: No search text or element type - skipping element search');
            return null;
        }

        CSReporter.debug(`CSAccessibilityTreeMatcher: Searching for "${searchText}" (type: ${target.elementType || 'any'}, intent: ${intent})`);

        const alternatives: AlternativeMatch[] = [];

        // Strategy 1: Accessibility Tree
        try {
            const a11yResult = await this.matchViaAccessibilityTree(page, target, intent);
            if (a11yResult && a11yResult.confidence >= this.config.confidenceThreshold) {
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: A11y tree match in ${duration}ms (confidence: ${a11yResult.confidence.toFixed(2)})`);
                return a11yResult;
            }
            if (a11yResult) {
                alternatives.push({
                    locator: a11yResult.locator,
                    confidence: a11yResult.confidence,
                    method: a11yResult.method,
                    description: a11yResult.description
                });
            }
        } catch (error: any) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: A11y tree strategy failed: ${error.message}`);
        }

        // Strategy 2: Playwright Semantic Locators
        try {
            const semanticResult = await this.matchViaSemanticLocators(page, target, intent);
            if (semanticResult && semanticResult.confidence >= this.config.confidenceThreshold) {
                semanticResult.alternatives = alternatives;
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Semantic locator match in ${duration}ms (confidence: ${semanticResult.confidence.toFixed(2)})`);
                return semanticResult;
            }
            if (semanticResult) {
                alternatives.push({
                    locator: semanticResult.locator,
                    confidence: semanticResult.confidence,
                    method: semanticResult.method,
                    description: semanticResult.description
                });
            }
        } catch (error: any) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: Semantic locator strategy failed: ${error.message}`);
        }

        // Strategy 3: Text-based search
        try {
            const textResult = await this.matchViaTextSearch(page, target);
            if (textResult && textResult.confidence >= this.config.confidenceThreshold) {
                textResult.alternatives = alternatives;
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Text search match in ${duration}ms (confidence: ${textResult.confidence.toFixed(2)})`);
                return textResult;
            }
            if (textResult) {
                alternatives.push({
                    locator: textResult.locator,
                    confidence: textResult.confidence,
                    method: textResult.method,
                    description: textResult.description
                });
            }
        } catch (error: any) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: Text search strategy failed: ${error.message}`);
        }

        // Strategy 4: Role-based search
        try {
            const roleResult = await this.matchViaRoleSearch(page, target, intent);
            if (roleResult) {
                roleResult.alternatives = alternatives;
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Role search match in ${duration}ms (confidence: ${roleResult.confidence.toFixed(2)})`);
                return roleResult;
            }
        } catch (error: any) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: Role search strategy failed: ${error.message}`);
        }

        // If we have alternatives but none met threshold, return the best one
        // only if it's close enough (at least 50% of the threshold)
        if (alternatives.length > 0) {
            alternatives.sort((a, b) => b.confidence - a.confidence);
            const best = alternatives[0];
            const minAcceptable = this.config.confidenceThreshold * 0.5;
            if (best.confidence >= minAcceptable) {
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Using best alternative in ${duration}ms (confidence: ${best.confidence.toFixed(2)}, method: ${best.method})`);
                return {
                    locator: best.locator,
                    confidence: best.confidence,
                    method: best.method,
                    description: best.description,
                    alternatives: alternatives.slice(1)
                };
            }
            CSReporter.debug(`CSAccessibilityTreeMatcher: Best alternative confidence ${best.confidence.toFixed(2)} is below minimum ${minAcceptable.toFixed(2)} - rejecting`);
        }

        const duration = Date.now() - startTime;
        CSReporter.debug(`CSAccessibilityTreeMatcher: No element found in ${duration}ms for "${searchText}"`);
        return null;
    }

    // ========================================================================
    // Strategy 1: Accessibility Tree Matching
    // ========================================================================

    private async matchViaAccessibilityTree(
        page: Page,
        target: ElementTarget,
        intent: StepIntent
    ): Promise<MatchedElement | null> {
        // Get accessibility snapshot
        const snapshot = await this.getAccessibilitySnapshot(page);
        if (!snapshot) return null;

        // Parse snapshot into nodes
        const nodes = this.parseAccessibilitySnapshot(snapshot);
        if (nodes.length === 0) return null;

        // Get expected roles based on element type and intent
        const expectedRoles = this.getExpectedRoles(target.elementType, intent);

        // Score each node against the target
        const searchText = this.buildSearchText(target);
        const scores: AccessibilityMatchScore[] = [];

        for (const node of nodes) {
            const score = this.scoreAccessibilityNode(node, searchText, expectedRoles, target);
            if (score.total > 0.3) { // Minimum viable score
                scores.push(score);
            }
        }

        // Sort by score descending
        scores.sort((a, b) => b.total - a.total);

        if (scores.length === 0) return null;

        // Handle ordinal selection
        let selectedScore: AccessibilityMatchScore;
        if (target.ordinal !== undefined && target.ordinal > 0 && scores.length >= target.ordinal) {
            // Filter to only high-confidence matches (within 80% of best score)
            const threshold = scores[0].total * 0.8;
            const topScores = scores.filter(s => s.total >= threshold);
            const ordinalIdx = Math.min(target.ordinal - 1, topScores.length - 1);
            selectedScore = topScores[ordinalIdx];
        } else if (target.ordinal === -1) {
            // "last" ordinal
            const threshold = scores[0].total * 0.8;
            const topScores = scores.filter(s => s.total >= threshold);
            selectedScore = topScores[topScores.length - 1];
        } else {
            selectedScore = scores[0];
        }

        // Build a Playwright locator for the matched node
        const locator = this.buildLocatorFromNode(page, selectedScore.node, searchText);
        if (!locator) return null;

        // Verify element exists
        const count = await locator.count().catch(() => 0);
        if (count === 0) return null;

        // Handle ordinal if locator matches multiple elements
        const finalLocator = count > 1 && target.ordinal !== undefined ?
            (target.ordinal === -1 ? locator.last() : locator.nth(Math.max(0, (target.ordinal || 1) - 1))) :
            locator.first();

        return {
            locator: finalLocator,
            confidence: selectedScore.total,
            method: 'accessibility-tree' as MatchMethod,
            description: `${selectedScore.node.role}[name="${selectedScore.node.name}"]`,
            alternatives: []
        };
    }

    /**
     * Get accessibility snapshot with caching
     */
    private async getAccessibilitySnapshot(page: Page): Promise<string | null> {
        try {
            const url = page.url();
            const now = Date.now();

            // Check cache
            if (this.snapshotCache &&
                this.snapshotCache.url === url &&
                (now - this.snapshotCache.timestamp) < this.config.accessibilityTreeCacheTTL) {
                return this.snapshotCache.snapshot;
            }

            // Take new snapshot
            const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 });

            // Cache it
            this.snapshotCache = { snapshot, timestamp: now, url };
            return snapshot;
        } catch (error: any) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: ariaSnapshot failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Parse accessibility snapshot text into structured nodes
     * Snapshot format example:
     *   - heading "Dashboard" [level=1]
     *   - navigation "Main Menu":
     *     - link "Home"
     *     - link "Settings"
     *   - button "Submit"
     */
    public parseAccessibilitySnapshot(snapshot: string): AccessibilityNode[] {
        const lines = snapshot.split('\n').filter(l => l.trim());
        const nodes: AccessibilityNode[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const parsed = this.parseSnapshotLine(line, i);
            if (parsed) {
                nodes.push(parsed);
            }
        }

        return nodes;
    }

    /**
     * Parse a single snapshot line into an AccessibilityNode
     */
    private parseSnapshotLine(line: string, lineIndex: number): AccessibilityNode | null {
        // Match pattern: "- role "name" [properties]" or "- role "name":"
        const trimmed = line.trim();
        if (!trimmed.startsWith('-')) return null;

        // Calculate level from indentation
        const indent = line.search(/\S/);
        const level = Math.floor(indent / 2);

        // Parse: - role "name" [prop=value]
        const match = trimmed.match(/^-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+\[([^\]]*)\])?:?$/);
        if (!match) {
            // Try without quotes (for text nodes)
            const simpleMatch = trimmed.match(/^-\s+(\w+)(?:\s+(.+?))?(?:\s+\[([^\]]*)\])?:?$/);
            if (!simpleMatch) return null;

            return {
                role: simpleMatch[1],
                name: (simpleMatch[2] || '').replace(/^"|"$/g, '').replace(/:$/, ''),
                level,
                properties: this.parseProperties(simpleMatch[3]),
                children: [],
                rawLine: line,
                lineIndex
            };
        }

        return {
            role: match[1],
            name: match[2] || '',
            level,
            properties: this.parseProperties(match[3]),
            children: [],
            rawLine: line,
            lineIndex
        };
    }

    /**
     * Parse properties string like "level=1, checked=true"
     */
    private parseProperties(propsStr: string | undefined): Record<string, string> {
        const props: Record<string, string> = {};
        if (!propsStr) return props;

        const pairs = propsStr.split(',');
        for (const pair of pairs) {
            const [key, value] = pair.split('=').map(s => s.trim());
            if (key) {
                props[key] = value || 'true';
            }
        }
        return props;
    }

    /**
     * Score an accessibility node against the target
     * Weighted scoring: role 30%, name 40%, label 20%, position 10%
     */
    private scoreAccessibilityNode(
        node: AccessibilityNode,
        searchText: string,
        expectedRoles: string[],
        target: ElementTarget
    ): AccessibilityMatchScore {
        // Role match (30% weight)
        let roleMatch = 0;
        if (expectedRoles.length === 0) {
            // No specific role expected - give partial score to interactive roles
            const interactiveRoles = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'switch'];
            roleMatch = interactiveRoles.includes(node.role) ? 0.6 : 0.3;
        } else if (expectedRoles.includes(node.role)) {
            roleMatch = 1.0;
        } else {
            roleMatch = 0.1;
        }

        // Name match (40% weight) - fuzzy text matching
        let nameMatch = 0;
        if (searchText && node.name) {
            nameMatch = this.jaroWinkler(searchText.toLowerCase(), node.name.toLowerCase());

            // Bonus for exact containment
            if (node.name.toLowerCase().includes(searchText.toLowerCase()) ||
                searchText.toLowerCase().includes(node.name.toLowerCase())) {
                nameMatch = Math.max(nameMatch, 0.85);
            }

            // Bonus for exact match
            if (node.name.toLowerCase() === searchText.toLowerCase()) {
                nameMatch = 1.0;
            }
        } else if (!searchText && expectedRoles.length > 0) {
            // No text search, just role-based - give partial name score
            nameMatch = 0.5;
        }

        // Label match (20% weight) - check if descriptors match individually
        let labelMatch = 0;
        if (target.descriptors.length > 0 && node.name) {
            const nodeName = node.name.toLowerCase();
            let matched = 0;
            for (const desc of target.descriptors) {
                if (nodeName.includes(desc.toLowerCase())) {
                    matched++;
                }
            }
            labelMatch = target.descriptors.length > 0 ? matched / target.descriptors.length : 0;
        }

        // Position match (10% weight)
        let positionMatch = 0.5; // Default neutral score
        if (target.ordinal !== undefined) {
            positionMatch = 0.7; // Will be refined when selecting among candidates
        }

        // Calculate total
        const total = roleMatch * 0.3 + nameMatch * 0.4 + labelMatch * 0.2 + positionMatch * 0.1;

        return {
            node,
            total: Math.min(total, 1.0),
            breakdown: { roleMatch, nameMatch, labelMatch, positionMatch }
        };
    }

    /**
     * Build a Playwright locator from an accessibility node
     */
    private buildLocatorFromNode(page: Page, node: AccessibilityNode, searchText: string): Locator | null {
        try {
            // Try getByRole with name
            if (node.name) {
                return page.getByRole(node.role as any, { name: node.name, exact: false });
            }

            // Try getByRole without name
            return page.getByRole(node.role as any);
        } catch {
            // If role is not a valid Playwright role, try text-based locator
            if (searchText) {
                return page.getByText(searchText, { exact: false });
            }
            return null;
        }
    }

    // ========================================================================
    // Strategy 2: Playwright Semantic Locators
    // ========================================================================

    private async matchViaSemanticLocators(
        page: Page,
        target: ElementTarget,
        intent: StepIntent
    ): Promise<MatchedElement | null> {
        const searchText = this.buildSearchText(target);
        const expectedRoles = this.getExpectedRoles(target.elementType, intent);

        // Try getByRole with name for each expected role
        for (const role of expectedRoles) {
            try {
                const locator = page.getByRole(role as any, {
                    name: searchText || undefined,
                    exact: false
                });
                const count = await locator.count();
                if (count > 0) {
                    const finalLocator = this.selectByOrdinal(locator, count, target.ordinal);
                    return {
                        locator: finalLocator,
                        confidence: 0.75,
                        method: 'semantic-locator',
                        description: `getByRole('${role}', { name: '${searchText}' })`,
                        alternatives: []
                    };
                }
            } catch {
                continue;
            }
        }

        // Try getByLabel
        if (searchText) {
            try {
                const locator = page.getByLabel(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        confidence: 0.7,
                        method: 'semantic-locator',
                        description: `getByLabel('${searchText}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        // Try getByPlaceholder
        if (searchText) {
            try {
                const locator = page.getByPlaceholder(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        confidence: 0.65,
                        method: 'semantic-locator',
                        description: `getByPlaceholder('${searchText}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        return null;
    }

    // ========================================================================
    // Strategy 3: Text-based Search
    // ========================================================================

    private async matchViaTextSearch(
        page: Page,
        target: ElementTarget
    ): Promise<MatchedElement | null> {
        const searchText = this.buildSearchText(target);
        if (!searchText) return null;

        try {
            const locator = page.getByText(searchText, { exact: false });
            const count = await locator.count();
            if (count > 0) {
                return {
                    locator: this.selectByOrdinal(locator, count, target.ordinal),
                    confidence: 0.6,
                    method: 'text-search',
                    description: `getByText('${searchText}')`,
                    alternatives: []
                };
            }
        } catch { /* continue */ }

        // Try with individual descriptor words
        for (const desc of target.descriptors) {
            if (desc.length < 3) continue;
            try {
                const locator = page.getByText(desc, { exact: false });
                const count = await locator.count();
                if (count > 0 && count <= 10) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        confidence: 0.5,
                        method: 'text-search',
                        description: `getByText('${desc}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        return null;
    }

    // ========================================================================
    // Strategy 4: Role-based Search
    // ========================================================================

    private async matchViaRoleSearch(
        page: Page,
        target: ElementTarget,
        intent: StepIntent
    ): Promise<MatchedElement | null> {
        const expectedRoles = this.getExpectedRoles(target.elementType, intent);
        if (expectedRoles.length === 0) return null;

        // Try each role without name filtering
        for (const role of expectedRoles) {
            try {
                const locator = page.getByRole(role as any);
                const count = await locator.count();
                if (count > 0 && count <= 20) {
                    // Find the best match among results by checking text content
                    const searchText = this.buildSearchText(target);
                    if (searchText) {
                        for (let i = 0; i < Math.min(count, 10); i++) {
                            const text = await locator.nth(i).textContent().catch(() => '');
                            if (text && this.jaroWinkler(searchText.toLowerCase(), text.toLowerCase().trim()) > 0.7) {
                                return {
                                    locator: locator.nth(i),
                                    confidence: 0.55,
                                    method: 'role-search',
                                    description: `getByRole('${role}').nth(${i}) - text match`,
                                    alternatives: []
                                };
                            }
                        }
                    }

                    // If no text match, use ordinal or first
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        confidence: 0.4,
                        method: 'role-search',
                        description: `getByRole('${role}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        return null;
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Build a search text string from element target descriptors
     */
    private buildSearchText(target: ElementTarget): string {
        // Join descriptors into a search phrase
        return target.descriptors
            .filter(d => d.length > 0)
            .join(' ')
            .trim();
    }

    /**
     * Get expected ARIA roles for an element type and/or intent
     */
    private getExpectedRoles(elementType: string | undefined, intent: StepIntent): string[] {
        const roles: string[] = [];

        // From element type
        if (elementType) {
            const typeRoles = ELEMENT_TYPE_TO_ROLES[elementType.toLowerCase()];
            if (typeRoles) {
                roles.push(...typeRoles);
            }
        }

        // From intent (if no element type specified)
        if (roles.length === 0) {
            const intentRoles = INTENT_TO_LIKELY_ROLES[intent];
            if (intentRoles) {
                roles.push(...intentRoles);
            }
        }

        return [...new Set(roles)]; // Deduplicate
    }

    /**
     * Select element by ordinal from a multi-element locator
     */
    private selectByOrdinal(locator: Locator, count: number, ordinal: number | undefined): Locator {
        if (ordinal === undefined || count <= 1) return locator.first();
        if (ordinal === -1) return locator.last();
        return locator.nth(Math.min(Math.max(0, ordinal - 1), count - 1));
    }

    /**
     * Jaro-Winkler similarity (0-1) for fuzzy text matching
     * Lightweight implementation for accessibility tree scoring
     */
    private jaroWinkler(s1: string, s2: string): number {
        if (s1 === s2) return 1.0;
        if (!s1 || !s2) return 0.0;

        const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
        if (matchWindow < 0) return s1 === s2 ? 1.0 : 0.0;

        const s1Matches = new Array(s1.length).fill(false);
        const s2Matches = new Array(s2.length).fill(false);

        let matches = 0;
        let transpositions = 0;

        for (let i = 0; i < s1.length; i++) {
            const start = Math.max(0, i - matchWindow);
            const end = Math.min(i + matchWindow + 1, s2.length);

            for (let j = start; j < end; j++) {
                if (s2Matches[j] || s1[i] !== s2[j]) continue;
                s1Matches[i] = true;
                s2Matches[j] = true;
                matches++;
                break;
            }
        }

        if (matches === 0) return 0.0;

        let k = 0;
        for (let i = 0; i < s1.length; i++) {
            if (!s1Matches[i]) continue;
            while (!s2Matches[k]) k++;
            if (s1[i] !== s2[k]) transpositions++;
            k++;
        }

        const jaro = (matches / s1.length + matches / s2.length +
                     (matches - transpositions / 2) / matches) / 3;

        // Winkler prefix bonus
        let prefixLength = 0;
        for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
            if (s1[i] === s2[i]) prefixLength++;
            else break;
        }

        return jaro + prefixLength * 0.1 * (1 - jaro);
    }

    /** Invalidate the snapshot cache */
    public invalidateCache(): void {
        this.snapshotCache = null;
    }
}
