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
            if (roleResult && roleResult.confidence >= this.config.confidenceThreshold) {
                roleResult.alternatives = alternatives;
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Role search match in ${duration}ms (confidence: ${roleResult.confidence.toFixed(2)})`);
                return roleResult;
            }
            if (roleResult) {
                alternatives.push({
                    locator: roleResult.locator,
                    confidence: roleResult.confidence,
                    method: roleResult.method,
                    description: roleResult.description
                });
            }
        } catch (error: any) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: Role search strategy failed: ${error.message}`);
        }

        // If we have alternatives but none met threshold, return the best one
        // Assertions require full confidence threshold to prevent false positives (e.g., wrong element on 404 page)
        // Actions/queries use a relaxed threshold (75% of threshold) for better usability
        if (alternatives.length > 0) {
            alternatives.sort((a, b) => b.confidence - a.confidence);
            const best = alternatives[0];
            const isAssertion = intent.startsWith('verify-');
            const minAcceptable = isAssertion ? this.config.confidenceThreshold : this.config.confidenceThreshold * 0.75;
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
            CSReporter.debug(`CSAccessibilityTreeMatcher: Best alternative confidence ${best.confidence.toFixed(2)} is below minimum ${minAcceptable.toFixed(2)} (assertion=${isAssertion}) - rejecting`);
        }

        // Strategy 5: Search inside frames (handles legacy IE-era apps with iframes/framesets)
        try {
            const frameResult = await this.searchFrames(page, target, intent, searchText);
            if (frameResult) {
                frameResult.alternatives = alternatives;
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Frame search match in ${duration}ms (confidence: ${frameResult.confidence.toFixed(2)})`);
                return frameResult;
            }
        } catch (error: any) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: Frame search strategy failed: ${error.message}`);
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
        if (target.ordinal !== undefined && target.ordinal > 0) {
            // Filter to only high-confidence matches (within 80% of best score)
            const threshold = scores[0].total * 0.8;
            const topScores = scores.filter(s => s.total >= threshold);

            if (target.ordinal > topScores.length) {
                // Requested ordinal exceeds available matches — fail clearly instead of clamping
                CSReporter.debug(
                    `CSAccessibilityTreeMatcher: Ordinal ${target.ordinal} requested but only ${topScores.length} high-confidence matches found`
                );
                return null;
            }
            selectedScore = topScores[target.ordinal - 1];
        } else if (target.ordinal === -1) {
            // "last" ordinal
            const threshold = scores[0].total * 0.8;
            const topScores = scores.filter(s => s.total >= threshold);
            selectedScore = topScores[topScores.length - 1];
        } else {
            selectedScore = scores[0];
        }

        // Build a Playwright locator for the matched node
        const locator = await this.buildLocatorFromNode(page, selectedScore.node, searchText);
        if (!locator) return null;

        // Verify element exists
        const count = await locator.count().catch(() => 0);
        if (count === 0) return null;

        // Handle ordinal if locator matches multiple elements
        let finalLocator: Locator;
        let confidenceAdjustment = 0;
        if (count > 1 && target.ordinal !== undefined) {
            // User specified an ordinal — pick that one
            finalLocator = target.ordinal === -1 ? locator.last() : locator.nth(Math.max(0, (target.ordinal || 1) - 1));
        } else if (count === 1) {
            // Only one match — safe to use it
            finalLocator = locator.first();
        } else {
            // Multiple matches with NO ordinal specified
            // Try to disambiguate using relativeTo/position context before falling back to first()
            const disambiguated = await this.disambiguateByContext(locator, count, target, page);
            if (disambiguated) {
                finalLocator = disambiguated;
                confidenceAdjustment = -0.05; // Small penalty for disambiguation
            } else {
                // No disambiguation possible — use first() with confidence penalty
                finalLocator = locator.first();
                confidenceAdjustment = -0.15;
            }
            CSReporter.debug(`CSAccessibilityTreeMatcher: A11y tree matched ${count} elements for "${selectedScore.node.name}" — ${disambiguated ? 'disambiguated by context' : 'using first, reducing confidence'}`);
        }

        return {
            locator: finalLocator,
            // Store the broad (non-narrowed) locator for use by verify-count
            broadLocator: locator,
            confidence: Math.max(0.1, selectedScore.total + confidenceAdjustment),
            method: 'accessibility-tree' as MatchMethod,
            description: `${selectedScore.node.role}[name="${selectedScore.node.name}"]${count > 1 ? ` (${count} matches)` : ''}`,
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
        // Use a more robust approach: extract role first, then find quoted name
        const roleMatch = trimmed.match(/^-\s+(\w+)\s*/);
        if (!roleMatch) return null;

        const role = roleMatch[1];
        const afterRole = trimmed.substring(roleMatch[0].length);

        // Extract name from quotes (handle nested quotes by finding first and last quote)
        let name = '';
        let remaining = afterRole;
        if (remaining.startsWith('"')) {
            // Find the closing quote — handle nested quotes by looking for " followed by
            // end of string, or [ (properties), or : (children marker)
            const nameEndPatterns = [/"\s*\[/, /"\s*:?\s*$/, /"\s+/];
            let endIdx = -1;
            for (const pattern of nameEndPatterns) {
                const match = remaining.substring(1).search(pattern);
                if (match >= 0 && (endIdx === -1 || match < endIdx)) {
                    endIdx = match;
                }
            }
            if (endIdx >= 0) {
                name = remaining.substring(1, endIdx + 1);
                remaining = remaining.substring(endIdx + 2).trim();
            } else {
                // Fallback: take everything between first and last quote
                const lastQuote = remaining.lastIndexOf('"');
                if (lastQuote > 0) {
                    name = remaining.substring(1, lastQuote);
                    remaining = remaining.substring(lastQuote + 1).trim();
                }
            }
        }

        // Extract properties from [...]
        let properties: Record<string, string> = {};
        const propsMatch = remaining.match(/\[([^\]]*)\]/);
        if (propsMatch) {
            properties = this.parseProperties(propsMatch[1]);
        }

        // Clean up remaining colon
        remaining = remaining.replace(/\[([^\]]*)\]/, '').replace(/:?\s*$/, '').trim();

        // If no quoted name was found, use remaining text as name (for text nodes)
        if (!name && remaining) {
            name = remaining.replace(/^"|"$/g, '').replace(/:$/, '');
        }

        return {
            role,
            name,
            level,
            properties,
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
     * Build a Playwright locator from an accessibility node.
     * Tries exact matching first (fewer false positives), then falls back to inexact.
     * This prevents "Submit" from matching "Submit Form" and "Submit Application".
     */
    private async buildLocatorFromNode(page: Page, node: AccessibilityNode, searchText: string): Promise<Locator | null> {
        try {
            if (node.name) {
                // Try exact match first — avoids matching "Submit Form" when we want "Submit"
                const exactLocator = page.getByRole(node.role as any, { name: node.name, exact: true });
                const exactCount = await exactLocator.count().catch(() => 0);
                if (exactCount > 0) {
                    return exactLocator;
                }
                // Fall back to inexact if exact match found nothing
                // (handles slight whitespace/casing differences)
                return page.getByRole(node.role as any, { name: node.name, exact: false });
            }
            return page.getByRole(node.role as any);
        } catch {
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

        // For select/dropdown intents, prioritize getByLabel FIRST
        // This correctly disambiguates "Cycle Code" vs "Tranche ID" dropdowns
        // because label matching uses the associated <label> element
        const isSelectIntent = intent === 'select' ||
            (target.elementType && ['dropdown', 'select', 'combobox', 'listbox'].includes(target.elementType.toLowerCase()));

        if (isSelectIntent && searchText) {
            try {
                const labelLocator = page.getByLabel(searchText, { exact: false });
                const labelCount = await labelLocator.count();
                if (labelCount > 0) {
                    // Verify at least one labeled element is a select/combobox
                    for (let i = 0; i < Math.min(labelCount, 5); i++) {
                        const tagName = await labelLocator.nth(i).evaluate(el => el.tagName.toLowerCase()).catch(() => '');
                        const roleAttr = await labelLocator.nth(i).getAttribute('role').catch(() => null);
                        if (tagName === 'select' || roleAttr === 'combobox' || roleAttr === 'listbox') {
                            return {
                                locator: labelLocator.nth(i),
                                confidence: 0.85,
                                method: 'semantic-locator',
                                description: `getByLabel('${searchText}') -> <${tagName}>`,
                                alternatives: []
                            };
                        }
                    }
                    // Even if it's not a <select>, the labeled element is likely the right target
                    if (labelCount === 1) {
                        return {
                            locator: labelLocator.first(),
                            confidence: 0.75,
                            method: 'semantic-locator',
                            description: `getByLabel('${searchText}')`,
                            alternatives: []
                        };
                    }
                }
            } catch { /* continue to other strategies */ }
        }

        // Try getByRole with name for each expected role
        for (const role of expectedRoles) {
            try {
                const locator = page.getByRole(role as any, {
                    name: searchText || undefined,
                    exact: false
                });
                const count = await locator.count();
                if (count > 0) {
                    let finalLocator: Locator;
                    let confidenceAdj = 0;
                    if (count > 1 && target.ordinal === undefined) {
                        // Multiple matches, no ordinal — try disambiguation
                        const disambiguated = await this.disambiguateByContext(locator, count, target, page);
                        finalLocator = disambiguated || locator.first();
                        confidenceAdj = disambiguated ? -0.05 : -0.1;
                    } else {
                        finalLocator = this.selectByOrdinal(locator, count, target.ordinal);
                    }
                    return {
                        locator: finalLocator,
                        broadLocator: locator,
                        confidence: 0.75 + confidenceAdj,
                        method: 'semantic-locator',
                        description: `getByRole('${role}', { name: '${searchText}' })${count > 1 ? ` (${count} matches)` : ''}`,
                        alternatives: []
                    };
                }
            } catch {
                continue;
            }
        }

        // Try getByLabel (for non-select intents, or if select label match above didn't work)
        if (searchText) {
            try {
                const locator = page.getByLabel(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        broadLocator: locator,
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
                        broadLocator: locator,
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
                // Reduce confidence when many elements match (broad/generic text)
                // Single match = 0.6, multiple = progressively lower
                const baseConfidence = count === 1 ? 0.6 : Math.max(0.35, 0.6 - count * 0.05);
                return {
                    locator: this.selectByOrdinal(locator, count, target.ordinal),
                    broadLocator: locator,
                    confidence: baseConfidence,
                    method: 'text-search',
                    description: `getByText('${searchText}')${count > 1 ? ` (${count} matches)` : ''}`,
                    alternatives: []
                };
            }
        } catch { /* continue */ }

        // Try with individual descriptor words — lower confidence since these are partial matches
        for (const desc of target.descriptors) {
            if (desc.length < 3) continue;
            try {
                const locator = page.getByText(desc, { exact: false });
                const count = await locator.count();
                if (count > 0 && count <= 10) {
                    // Individual word matches are less reliable
                    const baseConfidence = count === 1 ? 0.45 : Math.max(0.25, 0.45 - count * 0.05);
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        broadLocator: locator,
                        confidence: baseConfidence,
                        method: 'text-search',
                        description: `getByText('${desc}')${count > 1 ? ` (${count} matches)` : ''}`,
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

        const searchText = this.buildSearchText(target);

        // When we have search text and multiple elements of the same role exist,
        // try getByLabel first — this disambiguates dropdowns like "Cycle Code" vs "Tranche ID"
        // by matching the associated <label> element
        if (searchText) {
            for (const role of expectedRoles) {
                try {
                    const labelLocator = page.getByLabel(searchText, { exact: false });
                    const labelCount = await labelLocator.count();
                    if (labelCount > 0) {
                        // Verify the labeled element matches the expected role
                        for (let i = 0; i < Math.min(labelCount, 5); i++) {
                            const roleAttr = await labelLocator.nth(i).getAttribute('role').catch(() => null);
                            const tagName = await labelLocator.nth(i).evaluate(el => el.tagName.toLowerCase()).catch(() => '');
                            // <select> has implicit combobox/listbox role
                            const matchesRole = roleAttr === role ||
                                (role === 'combobox' && (tagName === 'select' || tagName === 'input')) ||
                                (role === 'listbox' && tagName === 'select');
                            if (matchesRole) {
                                return {
                                    locator: labelLocator.nth(i),
                                    confidence: 0.65,
                                    method: 'role-search',
                                    description: `getByLabel('${searchText}') -> ${role}`,
                                    alternatives: []
                                };
                            }
                        }
                    }
                } catch { /* continue */ }
            }
        }

        // Try each role without name filtering
        for (const role of expectedRoles) {
            try {
                const locator = page.getByRole(role as any);
                const count = await locator.count();
                if (count > 0 && count <= 50) {
                    // Find the best match among results by checking text content
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

                        // Also try matching by accessible name (aria-label, aria-labelledby, associated label)
                        for (let i = 0; i < Math.min(count, 10); i++) {
                            const accName = await locator.nth(i).getAttribute('aria-label').catch(() => null)
                                || await locator.nth(i).getAttribute('name').catch(() => null)
                                || await locator.nth(i).getAttribute('id').catch(() => null) || '';
                            if (accName && this.jaroWinkler(searchText.toLowerCase(), accName.toLowerCase()) > 0.6) {
                                return {
                                    locator: locator.nth(i),
                                    confidence: 0.55,
                                    method: 'role-search',
                                    description: `getByRole('${role}').nth(${i}) - name match '${accName}'`,
                                    alternatives: []
                                };
                            }
                        }
                    }

                    // Only return generic first if there's a single element or explicit ordinal
                    // When multiple elements exist and no text/name matched, don't blindly pick first
                    if (count === 1 || target.ordinal !== undefined) {
                        return {
                            locator: this.selectByOrdinal(locator, count, target.ordinal),
                            confidence: count === 1 ? 0.45 : 0.4,
                            method: 'role-search',
                            description: `getByRole('${role}')${count > 1 ? `.nth(${target.ordinal || 0})` : ''}`,
                            alternatives: []
                        };
                    }

                    // Multiple elements, no ordinal, no text match — reject entirely
                    // Returning first() here is dangerous: it silently picks the wrong element
                    // Instead, return null so the caller can try other strategies or fail clearly
                    CSReporter.debug(`CSAccessibilityTreeMatcher: Role search found ${count} '${role}' elements but none matched '${searchText}' — rejecting ambiguous match`);
                    return null;
                }
            } catch { /* continue */ }
        }

        return null;
    }

    // ========================================================================
    // Strategy 5: Frame/Iframe Search (legacy IE apps)
    // ========================================================================

    /**
     * Search inside iframes for elements not found on the main page.
     * Legacy IE-era applications heavily use iframes/framesets to embed content.
     * Playwright's main page locators only search the top frame by default.
     *
     * Uses Frame API (getByText, getByRole) which is duck-type compatible with Page.
     */
    private async searchFrames(
        page: Page,
        target: ElementTarget,
        intent: StepIntent,
        searchText: string
    ): Promise<MatchedElement | null> {
        const frames = page.frames();
        if (frames.length <= 1) return null; // Only main frame, no iframes

        CSReporter.debug(`CSAccessibilityTreeMatcher: Searching ${frames.length - 1} iframe(s) for "${searchText}"`);

        const expectedRoles = this.getExpectedRoles(target.elementType, intent);

        for (const frame of frames) {
            if (frame === page.mainFrame()) continue;
            if (!frame.url() || frame.url() === 'about:blank') continue;

            try {
                // Try getByRole with name first (most precise)
                for (const role of expectedRoles) {
                    try {
                        const roleLocator = frame.getByRole(role as any, { name: searchText, exact: false });
                        const count = await roleLocator.count();
                        if (count > 0) {
                            CSReporter.debug(`CSAccessibilityTreeMatcher: Found in frame via getByRole('${role}', '${searchText}')`);
                            return {
                                locator: this.selectByOrdinal(roleLocator, count, target.ordinal),
                                broadLocator: roleLocator,
                                confidence: 0.75,
                                method: 'semantic-locator',
                                description: `frame[${frame.name() || 'iframe'}] > getByRole('${role}', '${searchText}')`,
                                alternatives: []
                            };
                        }
                    } catch { continue; }
                }

                // Try text search in frame
                if (searchText) {
                    try {
                        const textLocator = frame.getByText(searchText, { exact: false });
                        const count = await textLocator.count();
                        if (count > 0) {
                            const baseConfidence = count === 1 ? 0.65 : Math.max(0.4, 0.65 - count * 0.05);
                            CSReporter.debug(`CSAccessibilityTreeMatcher: Found in frame via getByText('${searchText}') — ${count} match(es)`);
                            return {
                                locator: this.selectByOrdinal(textLocator, count, target.ordinal),
                                broadLocator: textLocator,
                                confidence: baseConfidence,
                                method: 'text-search',
                                description: `frame[${frame.name() || 'iframe'}] > getByText('${searchText}')${count > 1 ? ` (${count} matches)` : ''}`,
                                alternatives: []
                            };
                        }
                    } catch { /* continue to next frame */ }
                }

                // Try getByLabel in frame (for input fields)
                if (searchText) {
                    try {
                        const labelLocator = frame.getByLabel(searchText, { exact: false });
                        const count = await labelLocator.count();
                        if (count > 0) {
                            return {
                                locator: this.selectByOrdinal(labelLocator, count, target.ordinal),
                                broadLocator: labelLocator,
                                confidence: 0.65,
                                method: 'semantic-locator',
                                description: `frame[${frame.name() || 'iframe'}] > getByLabel('${searchText}')`,
                                alternatives: []
                            };
                        }
                    } catch { /* continue */ }
                }

                // Try individual descriptor words in frame
                for (const desc of target.descriptors) {
                    if (desc.length < 3) continue;
                    try {
                        const descLocator = frame.getByText(desc, { exact: false });
                        const count = await descLocator.count();
                        if (count > 0 && count <= 10) {
                            return {
                                locator: this.selectByOrdinal(descLocator, count, target.ordinal),
                                broadLocator: descLocator,
                                confidence: count === 1 ? 0.5 : Math.max(0.3, 0.5 - count * 0.05),
                                method: 'text-search',
                                description: `frame[${frame.name() || 'iframe'}] > getByText('${desc}')`,
                                alternatives: []
                            };
                        }
                    } catch { /* continue */ }
                }
            } catch {
                // Frame may be detached or cross-origin — skip it
                continue;
            }
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
     * Disambiguate among multiple matched elements using context cues.
     * Uses position (top/bottom), relativeTo (near X), and parent section text
     * to pick the best element from a multi-match locator.
     *
     * @returns A narrowed locator if disambiguation succeeded, null otherwise
     */
    private async disambiguateByContext(
        locator: Locator,
        count: number,
        target: ElementTarget,
        page: Page
    ): Promise<Locator | null> {
        // Strategy A: Position cue (top/bottom/left/right)
        if (target.position) {
            try {
                const boxes: { idx: number; y: number; x: number }[] = [];
                for (let i = 0; i < Math.min(count, 10); i++) {
                    const box = await locator.nth(i).boundingBox({ timeout: 2000 }).catch(() => null);
                    if (box) {
                        boxes.push({ idx: i, y: box.y, x: box.x });
                    }
                }
                if (boxes.length >= 2) {
                    switch (target.position) {
                        case 'top':
                        case 'upper':
                            boxes.sort((a, b) => a.y - b.y);
                            return locator.nth(boxes[0].idx);
                        case 'bottom':
                        case 'lower':
                            boxes.sort((a, b) => b.y - a.y);
                            return locator.nth(boxes[0].idx);
                        case 'left':
                            boxes.sort((a, b) => a.x - b.x);
                            return locator.nth(boxes[0].idx);
                        case 'right':
                            boxes.sort((a, b) => b.x - a.x);
                            return locator.nth(boxes[0].idx);
                    }
                }
            } catch { /* continue to other strategies */ }
        }

        // Strategy B: relativeTo context (e.g., "near the Users table")
        if (target.relativeTo) {
            try {
                // Find the reference element
                const refLocator = page.getByText(target.relativeTo, { exact: false });
                const refCount = await refLocator.count();
                if (refCount > 0) {
                    const refBox = await refLocator.first().boundingBox({ timeout: 2000 }).catch(() => null);
                    if (refBox) {
                        // Score each candidate by proximity to the reference element
                        let bestIdx = 0;
                        let bestDist = Infinity;
                        for (let i = 0; i < Math.min(count, 10); i++) {
                            const box = await locator.nth(i).boundingBox({ timeout: 2000 }).catch(() => null);
                            if (box) {
                                const dist = Math.sqrt(
                                    Math.pow(box.x - refBox.x, 2) + Math.pow(box.y - refBox.y, 2)
                                );
                                if (dist < bestDist) {
                                    bestDist = dist;
                                    bestIdx = i;
                                }
                            }
                        }
                        if (bestDist < Infinity) {
                            CSReporter.debug(`CSAccessibilityTreeMatcher: Disambiguated by proximity to "${target.relativeTo}" — element ${bestIdx} (distance: ${bestDist.toFixed(0)}px)`);
                            return locator.nth(bestIdx);
                        }
                    }
                }
            } catch { /* continue */ }
        }

        // Strategy C: Section/parent text context
        // If descriptors contain section-like words that aren't part of the element name,
        // check each candidate's surrounding text for those keywords
        // (This handles cases like "Edit button in Users table" where "Users" disambiguates)
        if (target.descriptors.length > 1) {
            try {
                for (let i = 0; i < Math.min(count, 10); i++) {
                    const parentText = await locator.nth(i).evaluate(
                        (el: Element) => {
                            // Walk up DOM to find section/parent with meaningful text
                            let parent: Element | null = el.parentElement;
                            for (let depth = 0; parent && depth < 5; depth++) {
                                const tag = parent.tagName.toLowerCase();
                                if (['section', 'article', 'form', 'table', 'div', 'fieldset', 'nav', 'header', 'footer', 'aside'].includes(tag)) {
                                    // Get a meaningful label: aria-label, heading text, or first 200 chars
                                    const ariaLabel = parent.getAttribute('aria-label');
                                    if (ariaLabel) return ariaLabel;
                                    const heading = parent.querySelector('h1,h2,h3,h4,h5,h6,legend,caption');
                                    if (heading) return heading.textContent?.trim() || '';
                                    return (parent.textContent?.trim() || '').substring(0, 200);
                                }
                                parent = parent.parentElement;
                            }
                            return '';
                        }
                    ).catch(() => '');

                    if (parentText) {
                        const parentLower = parentText.toLowerCase();
                        // Check if any descriptor words match the parent context
                        const contextMatch = target.descriptors.some(d =>
                            d.length >= 3 && parentLower.includes(d.toLowerCase())
                        );
                        if (contextMatch) {
                            CSReporter.debug(`CSAccessibilityTreeMatcher: Disambiguated by parent context — element ${i} matches descriptors in section "${parentText.substring(0, 80)}"`);
                            return locator.nth(i);
                        }
                    }
                }
            } catch { /* continue */ }
        }

        return null;
    }

    /**
     * Select element by ordinal from a multi-element locator.
     * Throws clearly when ordinal exceeds available count.
     */
    private selectByOrdinal(locator: Locator, count: number, ordinal: number | undefined): Locator {
        if (ordinal === undefined || count <= 1) return locator.first();
        if (ordinal === -1) return locator.last();
        const idx = ordinal - 1;
        if (idx >= count) {
            // Fail clearly instead of silently clamping — clamping picks the wrong element
            throw new Error(`Ordinal ${ordinal} exceeds available match count ${count}`);
        }
        return locator.nth(Math.max(0, idx));
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

        // Winkler prefix bonus — only apply when strings are already similar (jaro >= 0.7)
        // to avoid inflating scores for dissimilar strings that share a prefix
        if (jaro < 0.7) return jaro;

        let prefixLength = 0;
        for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
            if (s1[i] === s2[i]) prefixLength++;
            else break;
        }

        return Math.min(jaro + prefixLength * 0.1 * (1 - jaro), 1.0);
    }

    /** Invalidate the snapshot cache */
    public invalidateCache(): void {
        this.snapshotCache = null;
    }
}
