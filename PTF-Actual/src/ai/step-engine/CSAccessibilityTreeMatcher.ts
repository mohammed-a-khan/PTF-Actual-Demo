/**
 * CSAccessibilityTreeMatcher - Element Matching via Accessibility Tree
 *
 * 5-strategy cascade for finding elements on the page:
 *   1. Accessibility Tree (primary) - ariaSnapshot() + weighted scoring
 *   2. Playwright Semantic Locators (fallback) - getByRole/getByLabel/getByPlaceholder/getByTitle/getByAltText/[name]
 *   3. Text-based search (fallback) - text content matching
 *   4. Role-based search (last resort) - ARIA role + keyword matching
 *   5. Frame/iframe search - searches inside all frames using strategies 1-4
 *
 * Uses Jaro-Winkler similarity for fuzzy text matching.
 *
 * @module ai/step-engine
 */

import { Page, Locator, Frame } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';
import { CSFuzzyMatcher } from './CSFuzzyMatcher';
import { CSElementCache } from './CSElementCache';
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

    /** Enhanced fuzzy matcher (N-gram + token matching) */
    private fuzzyMatcher: CSFuzzyMatcher;

    /** Element cache for adaptive confidence thresholds */
    private elementCache: CSElementCache;

    private constructor(config?: Partial<CSAIStepConfig>) {
        this.config = { ...DEFAULT_AI_STEP_CONFIG, ...config };
        this.fuzzyMatcher = CSFuzzyMatcher.getInstance();
        this.elementCache = CSElementCache.getInstance();
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
    /**
     * Find element matching the target description on the page or frame.
     * Accepts Page or Frame — Frame is used when AI steps target a switched frame
     * (JSP frameset/iframe support via 'switch-frame' intent).
     */
    public async findElement(
        page: Page | Frame,
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

        // Adaptive confidence threshold: use per-page learned threshold if available
        let confidenceThreshold = this.config.confidenceThreshold;
        try {
            const pageUrl = 'url' in page ? (page as Page).url().split('?')[0].split('#')[0] : '';
            if (pageUrl) {
                const recommended = this.elementCache.getRecommendedThreshold(pageUrl);
                if (recommended !== null) {
                    confidenceThreshold = recommended;
                    CSReporter.debug(`CSAccessibilityTreeMatcher: Using adaptive confidence threshold ${recommended.toFixed(2)} for ${pageUrl}`);
                }
            }
        } catch { /* use default threshold */ }

        // DOM context-aware disambiguation: if a modal/dialog is active, scope search to it first
        const activeContext = await this.detectActiveContext(page);
        if (activeContext) {
            CSReporter.debug(`CSAccessibilityTreeMatcher: Active context detected — scoping search to ${activeContext.type}`);
            const contextResult = await this.searchWithinContext(activeContext.locator, target, intent, searchText, confidenceThreshold);
            if (contextResult) {
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Found element in ${activeContext.type} context in ${duration}ms`);
                return contextResult;
            }
        }

        // Strategy 0: Direct Role Match — fastest and most reliable strategy.
        // When user explicitly specified an element type (e.g., "button", "link"),
        // use Playwright's getByRole() which leverages the browser's native
        // accessibility engine. This is the approach recommended by Playwright docs.
        // Bypasses ariaSnapshot fuzzy scoring entirely — no false positives.
        if (target.elementType && searchText) {
            const directResult = await this.matchViaDirectRole(page, target, searchText);
            if (directResult) {
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAccessibilityTreeMatcher: Direct role match in ${duration}ms (confidence: ${directResult.confidence.toFixed(2)})`);
                return directResult;
            }
        }

        const alternatives: AlternativeMatch[] = [];

        // Strategy 1: Accessibility Tree
        try {
            const a11yResult = await this.matchViaAccessibilityTree(page, target, intent);
            if (a11yResult && a11yResult.confidence >= confidenceThreshold) {
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
            if (semanticResult && semanticResult.confidence >= confidenceThreshold) {
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
            if (textResult && textResult.confidence >= confidenceThreshold) {
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
            if (roleResult && roleResult.confidence >= confidenceThreshold) {
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

        // If we have alternatives but none met threshold, return the best one.
        // Assertions require full confidence threshold to prevent false positives.
        // When element type is specified and Strategy 0 failed, require higher threshold
        // because alternatives are likely wrong elements (e.g., h1 with title="Log On"
        // when user asked for a button). Don't accept them — force a retry instead.
        if (alternatives.length > 0) {
            alternatives.sort((a, b) => b.confidence - a.confidence);
            const best = alternatives[0];
            const isAssertion = intent.startsWith('verify-');
            const minAcceptable = isAssertion ? confidenceThreshold :
                target.elementType ? confidenceThreshold * 0.90 :
                confidenceThreshold * 0.75;
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
        // Skip if already searching within a specific frame context (user switched to it)
        const isPage = 'frames' in page && typeof (page as any).frames === 'function' && !('parentFrame' in page && typeof (page as any).parentFrame === 'function');
        try {
            const frameResult = isPage ? await this.searchFrames(page as Page, target, intent, searchText) : null;
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
    // Strategy 0: Direct Role Match (Playwright-recommended approach)
    // ========================================================================

    /**
     * Direct role match — the fastest and most reliable strategy.
     * When user explicitly specified an element type (e.g., "button", "link", "input"),
     * uses a comprehensive 4-phase search:
     *
     * Phase 1: getByRole on current context (Playwright's #1 recommended approach)
     * Phase 2: CSS-based element discovery on current context
     *          (catches <input type="submit">, [role="button"], custom elements)
     * Phase 3: getByRole across ALL iframes (handles ADFS/SSO login pages)
     * Phase 4: CSS-based discovery across ALL iframes
     *
     * This ensures the element is found regardless of WHERE it is (main page vs
     * iframe) or HOW it's implemented (standard <button>, <input type="submit">,
     * <a>, <div role="button">, etc.)
     *
     * Benefits:
     * - No fuzzy scoring → no false positives (heading can never outscore button)
     * - Exact name matching → "Log On" finds button "Log On", not heading "Please log on"
     * - Frame-aware → finds buttons inside ADFS/SSO login iframes
     * - CSS fallback → catches non-standard elements that getByRole misses
     */
    private async matchViaDirectRole(
        page: Page | Frame,
        target: ElementTarget,
        searchText: string
    ): Promise<MatchedElement | null> {
        if (!target.elementType || !searchText) return null;

        const expectedRoles = this.getExpectedRoles(target.elementType, '' as StepIntent);
        if (expectedRoles.length === 0) return null;

        // Phase 1: getByRole on current context (main page or active frame)
        const roleResult = await this.tryDirectRoleOnContext(page, expectedRoles, searchText, target);
        if (roleResult) return roleResult;

        // Phase 2: CSS-based element discovery on current context
        // Handles <input type="submit" value="Log On">, <a>Log On</a>, etc.
        // where getByRole may fail due to missing/incomplete ARIA attributes
        const cssResult = await this.tryCSSElementDiscovery(page, expectedRoles, searchText, target);
        if (cssResult) return cssResult;

        // Phase 3 & 4: Search inside iframes
        // Microsoft ADFS/SSO, Dynamics 365, and legacy JSP apps commonly embed
        // login forms in iframes. Without this, the button is invisible to main-page locators.
        // Only search frames if we're on the main Page (not already inside a Frame)
        const isPage = 'frames' in page && typeof (page as any).frames === 'function'
            && !('parentFrame' in page && typeof (page as any).parentFrame === 'function');

        if (isPage) {
            const frames = (page as Page).frames();
            if (frames.length > 1) {
                CSReporter.debug(`CSAccessibilityTreeMatcher: Strategy 0 — searching ${frames.length - 1} iframe(s) for ${target.elementType} "${searchText}"`);

                for (const frame of frames) {
                    if (frame === (page as Page).mainFrame()) continue;
                    if (!frame.url() || frame.url() === 'about:blank') continue;

                    try {
                        // Phase 3: getByRole in frame
                        const frameRoleResult = await this.tryDirectRoleOnContext(frame, expectedRoles, searchText, target);
                        if (frameRoleResult) {
                            frameRoleResult.description = `frame[${frame.name() || 'iframe'}] > ${frameRoleResult.description}`;
                            CSReporter.debug(`CSAccessibilityTreeMatcher: Strategy 0 — found in iframe via getByRole`);
                            return frameRoleResult;
                        }

                        // Phase 4: CSS-based discovery in frame
                        const frameCSSResult = await this.tryCSSElementDiscovery(frame, expectedRoles, searchText, target);
                        if (frameCSSResult) {
                            frameCSSResult.description = `frame[${frame.name() || 'iframe'}] > ${frameCSSResult.description}`;
                            CSReporter.debug(`CSAccessibilityTreeMatcher: Strategy 0 — found in iframe via CSS`);
                            return frameCSSResult;
                        }
                    } catch {
                        // Frame may be detached or cross-origin — skip
                        continue;
                    }
                }
            }
        }

        // Also try getByLabel → filter by expected role (for labeled form controls)
        if (expectedRoles.some(r => ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'spinbutton'].includes(r))) {
            try {
                const labelLocator = page.getByLabel(searchText, { exact: false });
                const labelCount = await labelLocator.count();
                if (labelCount > 0 && labelCount <= 5) {
                    return {
                        locator: this.selectByOrdinal(labelLocator, labelCount, target.ordinal),
                        broadLocator: labelLocator,
                        confidence: labelCount === 1 ? 0.90 : 0.80,
                        method: 'semantic-locator' as MatchMethod,
                        description: `direct: getByLabel('${searchText}')${labelCount > 1 ? ` (${labelCount} matches)` : ''}`,
                        alternatives: []
                    };
                }
            } catch { /* continue to fallback strategies */ }
        }

        // Phase 5: Nuclear text search — last resort within Strategy 0.
        // Searches ALL contexts (main page + frames) for ANY visible element with
        // matching text, then walks up the DOM to find the nearest interactive
        // ancestor that matches the expected element type.
        // This catches cases where:
        // - Text is inside a <span> inside a <button> (getByRole fails, CSS :text-is fails)
        // - Button is rendered with non-standard markup but has text content
        // - The element's accessible name doesn't match its visible text
        const allContexts: (Page | Frame)[] = [page];
        if (isPage) {
            const childFrames = (page as Page).frames().filter(f =>
                f !== (page as Page).mainFrame() && f.url() && f.url() !== 'about:blank'
            );
            allContexts.push(...childFrames);
        }

        for (const ctx of allContexts) {
            try {
                const nuclearResult = await this.tryNuclearTextSearch(ctx, expectedRoles, searchText, target);
                if (nuclearResult) {
                    const isFrame = ctx !== page;
                    if (isFrame) {
                        nuclearResult.description = `frame > ${nuclearResult.description}`;
                    }
                    CSReporter.debug(`CSAccessibilityTreeMatcher: Strategy 0 — found via nuclear text search${isFrame ? ' (in iframe)' : ''}`);
                    return nuclearResult;
                }
            } catch { continue; }
        }

        return null;
    }

    /**
     * Nuclear text search — finds elements by visible text content and verifies
     * the element (or its nearest interactive ancestor) matches the expected type.
     *
     * Handles cases like:
     *   <div class="btn-wrapper"><span onclick="submit()">Log On</span></div>
     *   <a class="btn btn-primary" href="#">Log On</a> (styled as button)
     *   <label><input type="submit" value="Log On"></label> (labeled submit)
     */
    private async tryNuclearTextSearch(
        context: Page | Frame,
        expectedRoles: string[],
        searchText: string,
        target: ElementTarget
    ): Promise<MatchedElement | null> {
        // Try exact text match first
        const textLocator = context.getByText(searchText, { exact: true });
        const textCount = await textLocator.count();

        if (textCount === 0 || textCount > 20) return null;

        const buttonTypes = ['submit', 'button', 'reset', 'image'];

        for (let i = 0; i < Math.min(textCount, 8); i++) {
            const el = textLocator.nth(i);
            const isVisible = await el.isVisible({ timeout: 500 }).catch(() => false);
            if (!isVisible) continue;

            // Walk up DOM to find the nearest interactive ancestor matching expected type.
            // SMART: matches visual appearance, not just semantic HTML.
            // <a class="btn">Log On</a> is treated as a button because that's what the user SEES.
            const matchInfo = await el.evaluate((node: Element, args: { roles: string[]; btnTypes: string[] }) => {
                let current: Element | null = node;
                for (let depth = 0; current && depth < 6; depth++) {
                    const tag = current.tagName.toLowerCase();
                    const role = current.getAttribute('role');
                    const type = current.getAttribute('type');
                    const cls = (current.className || '').toString().toLowerCase();
                    const hasOnClick = current.hasAttribute('onclick') || current.hasAttribute('ng-click') || current.hasAttribute('data-action');
                    const hasButtonClass = cls.includes('btn') || cls.includes('button') || cls.includes('submit') || cls.includes('action');

                    // Button match
                    if (args.roles.includes('button')) {
                        // Standard button elements
                        if (tag === 'button' || (tag === 'input' && args.btnTypes.includes(type || ''))
                            || role === 'button' || (tag === 'summary')) {
                            return { depth, tag, role, cls, interactiveTag: tag };
                        }
                        // Smart match: <a>, <span>, <div> STYLED as button (CSS class contains btn/button/submit)
                        // Users see a button on screen — the HTML tag is irrelevant
                        if (['a', 'span', 'div', 'label', 'li', 'td'].includes(tag) && hasButtonClass) {
                            return { depth, tag, role: role || 'button-styled', cls, interactiveTag: tag };
                        }
                        // Elements with click handlers (onclick, ng-click, data-action)
                        if (hasOnClick && ['span', 'div', 'a', 'label', 'td'].includes(tag)) {
                            return { depth, tag, role: role || 'clickable', cls, interactiveTag: tag };
                        }
                    }

                    // Link match
                    if (args.roles.includes('link')) {
                        if (tag === 'a' || role === 'link') {
                            return { depth, tag, role, cls, interactiveTag: tag };
                        }
                    }

                    current = current.parentElement;
                }
                return null;
            }, { roles: expectedRoles, btnTypes: buttonTypes }).catch(() => null);

            if (matchInfo) {
                let locator: Locator;
                if (matchInfo.depth === 0) {
                    locator = el;
                } else {
                    // Navigate up to the ancestor using xpath
                    const xpathUp = Array(matchInfo.depth).fill('..').join('/');
                    locator = el.locator(`xpath=${xpathUp}`);
                    const ancestorCount = await locator.count().catch(() => 0);
                    if (ancestorCount === 0) continue;
                }

                // Verify the resolved locator is visible and enabled
                const isClickable = await locator.isVisible({ timeout: 500 }).catch(() => false);
                if (!isClickable) continue;

                // Higher confidence for direct match (depth=0), lower for ancestor walk
                const confidence = matchInfo.depth === 0 ? 0.88 : Math.max(0.75, 0.88 - matchInfo.depth * 0.03);

                return {
                    locator,
                    confidence,
                    method: 'semantic-locator' as MatchMethod,
                    description: `nuclear: text("${searchText}") -> <${matchInfo.interactiveTag}>${matchInfo.role ? `[role="${matchInfo.role}"]` : ''} (depth=${matchInfo.depth})`,
                    alternatives: []
                };
            }
        }

        return null;
    }

    /**
     * Try getByRole on a single context (Page or Frame).
     * Pass 1: exact name match. Pass 2: inexact match.
     * Includes a brief auto-wait for dynamically rendered elements (SPAs).
     */
    private async tryDirectRoleOnContext(
        context: Page | Frame,
        expectedRoles: string[],
        searchText: string,
        target: ElementTarget
    ): Promise<MatchedElement | null> {
        for (const role of expectedRoles) {
            try {
                // Pass 1: Exact name match (highest confidence, zero false positives)
                const exactLocator = context.getByRole(role as any, { name: searchText, exact: true });
                let exactCount = await exactLocator.count();

                // If not immediately present, wait briefly for dynamic rendering.
                // SPA/Dynamics 365 pages render buttons via JavaScript after initial load.
                if (exactCount === 0 && role === expectedRoles[0]) {
                    await exactLocator.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
                    exactCount = await exactLocator.count();
                }

                if (exactCount > 0) {
                    let finalLocator: Locator;
                    let confidence = 0.95;
                    if (exactCount > 1 && target.ordinal === undefined) {
                        const disambiguated = await this.disambiguateByContext(exactLocator, exactCount, target, context);
                        finalLocator = disambiguated || exactLocator.first();
                        confidence = disambiguated
                            ? Math.max(0.80, 0.95 - (exactCount - 1) * 0.03)
                            : Math.max(0.65, 0.95 - (exactCount - 1) * 0.05);
                    } else {
                        finalLocator = this.selectByOrdinal(exactLocator, exactCount, target.ordinal);
                    }
                    return {
                        locator: finalLocator,
                        broadLocator: exactLocator,
                        confidence,
                        method: 'accessibility-tree' as MatchMethod,
                        description: `direct: getByRole('${role}', { name: '${searchText}', exact })${exactCount > 1 ? ` (${exactCount} matches)` : ''}`,
                        alternatives: []
                    };
                }

                // Pass 2: Inexact name match (handles whitespace/casing variations)
                const inexactLocator = context.getByRole(role as any, { name: searchText, exact: false });
                const inexactCount = await inexactLocator.count();
                if (inexactCount > 0 && inexactCount <= 10) {
                    return {
                        locator: this.selectByOrdinal(inexactLocator, inexactCount, target.ordinal),
                        broadLocator: inexactLocator,
                        confidence: inexactCount === 1 ? 0.90 : Math.max(0.70, 0.90 - inexactCount * 0.05),
                        method: 'accessibility-tree' as MatchMethod,
                        description: `direct: getByRole('${role}', { name: '${searchText}' })${inexactCount > 1 ? ` (${inexactCount} matches)` : ''}`,
                        alternatives: []
                    };
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    /**
     * CSS-based element discovery — finds elements that getByRole misses.
     *
     * Why this is needed:
     * - <input type="submit" value="Log On"> — some browsers/pages don't expose
     *   correct accessible name, making getByRole fail
     * - Custom elements with onclick but no ARIA role
     * - Legacy JSP/ADFS pages with non-semantic HTML
     * - <a class="btn"> styled as buttons
     *
     * Builds CSS selectors based on the expected element type and text.
     * Verifies each match is visible before returning.
     */
    private async tryCSSElementDiscovery(
        context: Page | Frame,
        expectedRoles: string[],
        searchText: string,
        target: ElementTarget
    ): Promise<MatchedElement | null> {
        // Build CSS selectors based on expected roles
        const selectors: { css: string; confidence: number }[] = [];

        // Escape quotes in search text for CSS attribute selectors
        const escapedText = searchText.replace(/"/g, '\\"');

        if (expectedRoles.includes('button')) {
            selectors.push(
                // Standard <button> with matching text content
                { css: `button:text-is("${escapedText}")`, confidence: 0.92 },
                // <input type="submit"> with matching value (ADFS login pages)
                { css: `input[type="submit"][value="${escapedText}"]`, confidence: 0.92 },
                // <input type="button"> with matching value
                { css: `input[type="button"][value="${escapedText}"]`, confidence: 0.90 },
                // <input type="image"> with matching alt (image buttons in JSP apps)
                { css: `input[type="image"][alt="${escapedText}"]`, confidence: 0.85 },
                // Custom elements with role="button" and matching text
                { css: `[role="button"]:text-is("${escapedText}")`, confidence: 0.88 },
                // Broader text containment fallbacks (lower confidence)
                { css: `button:has-text("${escapedText}")`, confidence: 0.85 },
                { css: `[role="button"]:has-text("${escapedText}")`, confidence: 0.82 },
                // Case-insensitive value matching (handles "Log On" vs "Log on" vs "LOG ON")
                { css: `input[type="submit"][value="${escapedText}" i]`, confidence: 0.88 },
                { css: `input[type="button"][value="${escapedText}" i]`, confidence: 0.86 },
                // <a> STYLED as button — extremely common in enterprise/legacy apps.
                // User sees a button on screen; doesn't know it's <a class="btn">.
                // CSS class-based selectors (high confidence — class proves button intent)
                { css: `a[class*="btn"]:text-is("${escapedText}")`, confidence: 0.90 },
                { css: `a[class*="button"]:text-is("${escapedText}")`, confidence: 0.90 },
                { css: `a[class*="submit"]:text-is("${escapedText}")`, confidence: 0.88 },
                { css: `span[class*="btn"]:text-is("${escapedText}")`, confidence: 0.88 },
                { css: `div[class*="btn"]:text-is("${escapedText}")`, confidence: 0.86 },
                // Generic <a> text match (lower confidence — could be a nav link)
                { css: `a:text-is("${escapedText}")`, confidence: 0.78 },
                { css: `a[class*="btn"]:has-text("${escapedText}")`, confidence: 0.82 },
                { css: `a[class*="button"]:has-text("${escapedText}")`, confidence: 0.82 },
                { css: `a:has-text("${escapedText}")`, confidence: 0.72 },
            );
        }

        if (expectedRoles.includes('link')) {
            selectors.push(
                { css: `a:text-is("${escapedText}")`, confidence: 0.90 },
                { css: `[role="link"]:text-is("${escapedText}")`, confidence: 0.88 },
                { css: `a:has-text("${escapedText}")`, confidence: 0.82 },
            );
        }

        for (const { css, confidence: baseConfidence } of selectors) {
            try {
                const locator = context.locator(css);
                const count = await locator.count();
                if (count > 0 && count <= 10) {
                    // Verify at least one match is visible
                    let visibleIdx = -1;
                    for (let i = 0; i < Math.min(count, 5); i++) {
                        const isVisible = await locator.nth(i).isVisible({ timeout: 1000 }).catch(() => false);
                        if (isVisible) {
                            visibleIdx = i;
                            break;
                        }
                    }
                    if (visibleIdx < 0) continue; // No visible matches, try next selector

                    const finalCount = count === 1 ? 1 : count;
                    const confidence = finalCount === 1 ? baseConfidence : Math.max(0.70, baseConfidence - (finalCount - 1) * 0.05);
                    const finalLocator = target.ordinal !== undefined
                        ? this.selectByOrdinal(locator, count, target.ordinal)
                        : (count === 1 ? locator.first() : locator.nth(visibleIdx));

                    return {
                        locator: finalLocator,
                        broadLocator: locator,
                        confidence,
                        method: 'semantic-locator' as MatchMethod,
                        description: `direct-css: ${css}${count > 1 ? ` (${count} matches)` : ''}`,
                        alternatives: []
                    };
                }
            } catch {
                continue;
            }
        }

        return null;
    }

    // ========================================================================
    // Strategy 1: Accessibility Tree Matching
    // ========================================================================

    private async matchViaAccessibilityTree(
        page: Page | Frame,
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
            const score = this.scoreAccessibilityNode(node, searchText, expectedRoles, target, nodes);
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
    private async getAccessibilitySnapshot(page: Page | Frame): Promise<string | null> {
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
            const snapshot = await page.locator('body').ariaSnapshot({ timeout: 2000 });

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
        target: ElementTarget,
        allNodes?: AccessibilityNode[]
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

        // Name match (40% weight) - enhanced fuzzy text matching (N-gram + token + Jaro-Winkler)
        let nameMatch = 0;
        if (searchText && node.name) {
            // Use composite fuzzy matching for better accuracy
            const fuzzyResult = this.fuzzyMatcher.compare(searchText, node.name);
            nameMatch = fuzzyResult.score;

            // Bonus for containment — scaled by how much of the name is covered.
            // "Log On" in "Log On" = 100% coverage → 0.95 bonus
            // "Log On" in "Please log on" = 46% coverage → 0.65 bonus (partial match)
            // This prevents long element names from getting inflated scores.
            const searchLower = searchText.toLowerCase();
            const nameLower = node.name.toLowerCase();
            if (nameLower.includes(searchLower)) {
                const coverage = searchLower.length / nameLower.length;
                nameMatch = Math.max(nameMatch, 0.55 + coverage * 0.4);
            } else if (searchLower.includes(nameLower)) {
                const coverage = nameLower.length / searchLower.length;
                nameMatch = Math.max(nameMatch, 0.55 + coverage * 0.4);
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

        // Calculate total with optional landmark bonus
        let total = roleMatch * 0.3 + nameMatch * 0.4 + labelMatch * 0.2 + positionMatch * 0.1;

        // Apply landmark proximity bonus (enhanced a11y parsing)
        if (allNodes) {
            total += this.scoreLandmarkBonus(node, target.elementType as any || 'click', allNodes);
        }

        // CRITICAL: Hard penalty when user EXPLICITLY specified an element type
        // (e.g., "button", "link", "input") and this node is a wrong type.
        // Without this, a heading "Please log on" can outscore button "Log On"
        // because fuzzy name matching (0.85) overwhelms the weak role penalty (0.1).
        // A wrong-type match should NEVER meet the confidence threshold.
        if (target.elementType && expectedRoles.length > 0 && !expectedRoles.includes(node.role)) {
            total *= 0.3;
        }

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
    private async buildLocatorFromNode(page: Page | Frame, node: AccessibilityNode, searchText: string): Promise<Locator | null> {
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
        page: Page | Frame,
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

        // Try getByTitle — legacy/JSP apps often use title attribute for tooltips & element identity
        if (searchText) {
            try {
                const locator = page.getByTitle(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0) {
                    const selectedLocator = this.selectByOrdinal(locator, count, target.ordinal);
                    let confidence = 0.6;

                    // When user specified element type, verify the matched element
                    // ACTUALLY matches that type. Smart matching: an <a class="btn">
                    // IS a button (user sees it as a button on screen).
                    // But an <a class="nav-link"> is NOT a button — reject it.
                    if (target.elementType && expectedRoles.length > 0) {
                        const elInfo = await selectedLocator.evaluate(el => ({
                            tag: el.tagName.toLowerCase(),
                            role: el.getAttribute('role'),
                            type: el.getAttribute('type'),
                            className: el.className || ''
                        })).catch(() => ({ tag: '', role: null as string | null, type: null as string | null, className: '' }));

                        const matchesType = this.elementMatchesExpectedRoles(
                            elInfo.tag, elInfo.role, elInfo.type, expectedRoles, elInfo.className
                        );
                        if (!matchesType) {
                            // Element type mismatch — drop confidence far below threshold
                            confidence = 0.15;
                            CSReporter.debug(`CSAccessibilityTreeMatcher: getByTitle('${searchText}') found <${elInfo.tag} class="${elInfo.className}">${elInfo.role ? ` role="${elInfo.role}"` : ''} — doesn't match expected "${target.elementType}", rejecting`);
                        }
                    }

                    return {
                        locator: selectedLocator,
                        broadLocator: locator,
                        confidence,
                        method: 'semantic-locator',
                        description: `getByTitle('${searchText}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        // Try getByAltText — image buttons (<input type="image">) and images in JSP apps
        if (searchText) {
            try {
                const locator = page.getByAltText(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        broadLocator: locator,
                        confidence: 0.6,
                        method: 'semantic-locator',
                        description: `getByAltText('${searchText}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        // Try CSS [name="..."] — JSP/Struts/Spring MVC forms use name attributes instead of id/aria-label
        if (searchText) {
            try {
                // Escape CSS special chars in the search text for attribute selector
                const escapedText = searchText.replace(/["\\]/g, '\\$&');
                // Try exact name match first
                let locator = page.locator(`[name="${escapedText}"]`);
                let count = await locator.count();
                if (count === 0) {
                    // Try case-insensitive partial match via name*= (contains)
                    locator = page.locator(`[name*="${escapedText}" i]`);
                    count = await locator.count();
                }
                if (count > 0 && count <= 10) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        broadLocator: locator,
                        confidence: count === 1 ? 0.6 : Math.max(0.4, 0.6 - count * 0.05),
                        method: 'semantic-locator',
                        description: `[name="${escapedText}"]${count > 1 ? ` (${count} matches)` : ''}`,
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
        page: Page | Frame,
        target: ElementTarget
    ): Promise<MatchedElement | null> {
        const searchText = this.buildSearchText(target);
        if (!searchText) return null;

        // Try exact match first — higher confidence, fewer false positives
        // In heavily nested DOMs (legacy apps), inexact search matches ancestor elements too
        try {
            const exactLocator = page.getByText(searchText, { exact: true });
            const exactCount = await exactLocator.count();
            if (exactCount > 0) {
                const baseConfidence = exactCount === 1 ? 0.75 : Math.max(0.5, 0.75 - exactCount * 0.05);
                return {
                    locator: this.selectByOrdinal(exactLocator, exactCount, target.ordinal),
                    broadLocator: exactLocator,
                    confidence: baseConfidence,
                    method: 'text-search',
                    description: `getByText('${searchText}', exact)${exactCount > 1 ? ` (${exactCount} matches)` : ''}`,
                    alternatives: []
                };
            }
        } catch { /* continue */ }

        // Fall back to inexact match
        try {
            const locator = page.getByText(searchText, { exact: false });
            const count = await locator.count();
            if (count > 0) {
                // Reduce confidence when many elements match (broad/generic text)
                // Single match = 0.65, multiple = progressively lower
                const baseConfidence = count === 1 ? 0.65 : Math.max(0.4, 0.65 - count * 0.05);
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

        // Try with individual descriptor words — ONLY when multiple descriptors exist
        // and the full search text didn't match. Skip short words (< 4 chars) to avoid
        // matching partial/generic text (e.g., "Log" alone matching "Login", "Logout", etc.)
        if (target.descriptors.length > 1) {
            for (const desc of target.descriptors) {
                if (desc.length < 4) continue;
                try {
                    const locator = page.getByText(desc, { exact: false });
                    const count = await locator.count();
                    if (count > 0 && count <= 5) {
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
        }

        return null;
    }

    // ========================================================================
    // Strategy 4: Role-based Search
    // ========================================================================

    private async matchViaRoleSearch(
        page: Page | Frame,
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
                            if (text && this.fuzzyMatcher.compare(searchText, text.trim()).score > 0.7) {
                                return {
                                    locator: locator.nth(i),
                                    confidence: 0.55,
                                    method: 'role-search',
                                    description: `getByRole('${role}').nth(${i}) - text match`,
                                    alternatives: []
                                };
                            }
                        }

                        // Also try matching by accessible name, title, alt, name, id attributes
                        // Legacy JSP apps often lack aria-label but have title, alt, or name attributes
                        for (let i = 0; i < Math.min(count, 10); i++) {
                            const accName = await locator.nth(i).getAttribute('aria-label').catch(() => null)
                                || await locator.nth(i).getAttribute('title').catch(() => null)
                                || await locator.nth(i).getAttribute('alt').catch(() => null)
                                || await locator.nth(i).getAttribute('name').catch(() => null)
                                || await locator.nth(i).getAttribute('id').catch(() => null) || '';
                            if (accName && this.fuzzyMatcher.compare(searchText, accName).score > 0.6) {
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
                // Try getByRole with exact name first, then inexact (most precise)
                for (const role of expectedRoles) {
                    try {
                        // Exact match first
                        const exactLocator = frame.getByRole(role as any, { name: searchText, exact: true });
                        const exactCount = await exactLocator.count();
                        if (exactCount > 0) {
                            CSReporter.debug(`CSAccessibilityTreeMatcher: Found in frame via getByRole('${role}', '${searchText}', exact)`);
                            return {
                                locator: this.selectByOrdinal(exactLocator, exactCount, target.ordinal),
                                broadLocator: exactLocator,
                                confidence: 0.90,
                                method: 'semantic-locator',
                                description: `frame[${frame.name() || 'iframe'}] > getByRole('${role}', '${searchText}', exact)`,
                                alternatives: []
                            };
                        }
                        // Inexact fallback
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

                // Try getByTitle in frame (JSP apps with title attributes)
                if (searchText) {
                    try {
                        const titleLocator = frame.getByTitle(searchText, { exact: false });
                        const count = await titleLocator.count();
                        if (count > 0) {
                            return {
                                locator: this.selectByOrdinal(titleLocator, count, target.ordinal),
                                broadLocator: titleLocator,
                                confidence: 0.55,
                                method: 'semantic-locator',
                                description: `frame[${frame.name() || 'iframe'}] > getByTitle('${searchText}')`,
                                alternatives: []
                            };
                        }
                    } catch { /* continue */ }
                }

                // Try getByAltText in frame (image buttons in JSP apps)
                if (searchText) {
                    try {
                        const altLocator = frame.getByAltText(searchText, { exact: false });
                        const count = await altLocator.count();
                        if (count > 0) {
                            return {
                                locator: this.selectByOrdinal(altLocator, count, target.ordinal),
                                broadLocator: altLocator,
                                confidence: 0.55,
                                method: 'semantic-locator',
                                description: `frame[${frame.name() || 'iframe'}] > getByAltText('${searchText}')`,
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
     * Check if an HTML element (by tag, role, type, class attributes) matches the expected ARIA roles.
     * Used to reject getByTitle/getByText matches that are the wrong element type.
     *
     * SMART MATCHING: Users describe what they SEE on screen, not the DOM structure.
     * An <a class="btn btn-primary">Log On</a> LOOKS like a button to the user.
     * The engine must match visual appearance, not just semantic HTML.
     *
     * Examples:
     * - expectedRoles=['button'] + tag='button' → true
     * - expectedRoles=['button'] + tag='input', type='submit' → true
     * - expectedRoles=['button'] + tag='a', class='btn' → true (styled as button)
     * - expectedRoles=['button'] + tag='a', class='nav-link' → false (not a button)
     * - expectedRoles=['link'] + tag='a' → true
     */
    private elementMatchesExpectedRoles(
        tagName: string,
        roleAttr: string | null,
        typeAttr: string | null,
        expectedRoles: string[],
        className?: string
    ): boolean {
        // If element has an explicit ARIA role, check against expected roles
        if (roleAttr && expectedRoles.includes(roleAttr)) return true;

        // Map HTML elements to their implicit ARIA roles
        const buttonInputTypes = ['submit', 'button', 'reset', 'image'];
        const tag = tagName.toLowerCase();
        const cls = (className || '').toLowerCase();

        // Button-like CSS class patterns (enterprise apps heavily use these)
        const hasButtonClass = cls.includes('btn') || cls.includes('button')
            || cls.includes('submit') || cls.includes('action');

        for (const role of expectedRoles) {
            switch (role) {
                case 'button':
                    if (tag === 'button') return true;
                    if (tag === 'input' && buttonInputTypes.includes(typeAttr || '')) return true;
                    if (tag === 'summary') return true; // <summary> has implicit button role
                    // Smart match: <a>, <span>, <div> STYLED as button
                    // Users see a button on screen — they don't know/care about the HTML tag.
                    // Accept if the element has button-like CSS classes.
                    if (['a', 'span', 'div', 'label', 'li', 'td'].includes(tag) && hasButtonClass) return true;
                    break;
                case 'link':
                    if (tag === 'a') return true;
                    if (tag === 'area') return true;
                    break;
                case 'textbox':
                case 'searchbox':
                    if (tag === 'input' && (!typeAttr || ['text', 'search', 'email', 'tel', 'url', 'password'].includes(typeAttr))) return true;
                    if (tag === 'textarea') return true;
                    break;
                case 'combobox':
                case 'listbox':
                    if (tag === 'select') return true;
                    break;
                case 'checkbox':
                    if (tag === 'input' && typeAttr === 'checkbox') return true;
                    break;
                case 'radio':
                    if (tag === 'input' && typeAttr === 'radio') return true;
                    break;
                case 'tab':
                    // Tabs are typically custom elements with role="tab"
                    break;
                case 'heading':
                    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return true;
                    break;
            }
        }

        return false;
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
        page: Page | Frame
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

    // ========================================================================
    // DOM Context-Aware Disambiguation
    // ========================================================================

    /**
     * Detect active modal, dialog, or focused tab panel on the page.
     * Returns a scoped locator when an overlay or focused context is found.
     */
    private async detectActiveContext(
        page: Page | Frame
    ): Promise<{ type: string; locator: Locator } | null> {
        try {
            // Check for open dialogs (native <dialog> or role="dialog")
            const dialogSelectors = [
                'dialog[open]',
                '[role="dialog"]:not([aria-hidden="true"])',
                '[role="alertdialog"]:not([aria-hidden="true"])',
                '.modal.show', '.modal.in', '.modal[style*="display: block"]',
                '.MuiDialog-root', '.ant-modal-wrap:not([style*="display: none"])',
                // Dynamics 365 / Power Apps dialogs
                '[data-id="dialogWrapper"]', '.ms-Dialog-main'
            ];

            for (const selector of dialogSelectors) {
                try {
                    const dialogLocator = page.locator(selector);
                    const count = await dialogLocator.count();
                    if (count > 0) {
                        // Use the last (topmost) dialog if multiple
                        const activeDialog = count === 1 ? dialogLocator : dialogLocator.last();
                        // Verify it's visible
                        const isVisible = await activeDialog.isVisible({ timeout: 1000 }).catch(() => false);
                        if (isVisible) {
                            return { type: `dialog(${selector})`, locator: activeDialog };
                        }
                    }
                } catch { continue; }
            }

            // Check for active tab panels
            try {
                const activePanel = page.locator('[role="tabpanel"]:not([hidden]):not([aria-hidden="true"])');
                const panelCount = await activePanel.count();
                if (panelCount === 1) {
                    return { type: 'tabpanel', locator: activePanel };
                }
            } catch { /* continue */ }

        } catch {
            // Non-critical — fall through to full-page search
        }
        return null;
    }

    /**
     * Search for an element within a scoped context (modal/dialog/tab panel).
     * Uses semantic locator strategies scoped to the container.
     */
    private async searchWithinContext(
        contextLocator: Locator,
        target: ElementTarget,
        intent: StepIntent,
        searchText: string,
        confidenceThreshold: number
    ): Promise<MatchedElement | null> {
        const expectedRoles = this.getExpectedRoles(target.elementType, intent);

        // Try getByRole within context — exact match first for precision
        for (const role of expectedRoles) {
            try {
                // Exact match first (highest confidence, no false positives)
                if (searchText) {
                    const exactLocator = contextLocator.getByRole(role as any, {
                        name: searchText,
                        exact: true
                    });
                    const exactCount = await exactLocator.count();
                    if (exactCount > 0) {
                        return {
                            locator: this.selectByOrdinal(exactLocator, exactCount, target.ordinal),
                            broadLocator: exactLocator,
                            confidence: 0.95,
                            method: 'accessibility-tree' as MatchMethod,
                            description: `context: getByRole('${role}', { name: '${searchText}', exact })`,
                            alternatives: []
                        };
                    }
                }

                // Inexact fallback
                const locator = contextLocator.getByRole(role as any, {
                    name: searchText || undefined,
                    exact: false
                });
                const count = await locator.count();
                if (count > 0) {
                    const finalLocator = this.selectByOrdinal(locator, count, target.ordinal);
                    const confidence = 0.85;
                    if (confidence >= confidenceThreshold) {
                        return {
                            locator: finalLocator,
                            broadLocator: locator,
                            confidence,
                            method: 'accessibility-tree' as MatchMethod,
                            description: `context: getByRole('${role}', '${searchText}')`,
                            alternatives: []
                        };
                    }
                }
            } catch { continue; }
        }

        // Try getByLabel within context
        if (searchText) {
            try {
                const locator = contextLocator.getByLabel(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        broadLocator: locator,
                        confidence: 0.8,
                        method: 'semantic-locator' as MatchMethod,
                        description: `context-scoped getByLabel('${searchText}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        // Try getByText within context
        if (searchText) {
            try {
                const locator = contextLocator.getByText(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0 && count <= 10) {
                    const baseConfidence = count === 1 ? 0.75 : Math.max(0.5, 0.75 - count * 0.05);
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        broadLocator: locator,
                        confidence: baseConfidence,
                        method: 'text-search' as MatchMethod,
                        description: `context-scoped getByText('${searchText}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        // Try getByPlaceholder within context
        if (searchText) {
            try {
                const locator = contextLocator.getByPlaceholder(searchText, { exact: false });
                const count = await locator.count();
                if (count > 0) {
                    return {
                        locator: this.selectByOrdinal(locator, count, target.ordinal),
                        broadLocator: locator,
                        confidence: 0.7,
                        method: 'semantic-locator' as MatchMethod,
                        description: `context-scoped getByPlaceholder('${searchText}')`,
                        alternatives: []
                    };
                }
            } catch { /* continue */ }
        }

        return null;
    }

    // ========================================================================
    // Enhanced A11y: Landmark & ARIA Relationship Scoring
    // ========================================================================

    /**
     * Score bonus for landmark proximity in the accessibility tree.
     * Elements inside navigation, main, or form landmarks get scoring boost
     * based on the landmark type matching the intent.
     */
    private scoreLandmarkBonus(node: AccessibilityNode, intent: StepIntent, nodes: AccessibilityNode[]): number {
        // Find parent landmarks by looking at nodes with lower indentation level
        const nodeIdx = nodes.indexOf(node);
        if (nodeIdx <= 0) return 0;

        // Walk backwards to find enclosing landmark
        const landmarkRoles = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'form', 'search', 'region'];
        for (let i = nodeIdx - 1; i >= 0; i--) {
            if ((nodes[i].level ?? 0) < (node.level ?? 0) && landmarkRoles.includes(nodes[i].role)) {
                const landmark = nodes[i].role;
                // Navigation actions in a nav landmark get a boost
                if (landmark === 'navigation' && (intent === 'click' || intent === 'navigate')) return 0.05;
                // Form actions in a form landmark get a boost
                if (landmark === 'form' && ['fill', 'type', 'select', 'check', 'clear'].includes(intent)) return 0.05;
                // Search actions in a search landmark get a boost
                if (landmark === 'search' && (intent === 'fill' || intent === 'type')) return 0.05;
                // Main content is neutral (no bonus, no penalty)
                if (landmark === 'main') return 0.02;
                break;
            }
        }
        return 0;
    }

    /**
     * Update page statistics after element search (for adaptive confidence learning).
     */
    public updatePageStats(pageUrl: string, success: boolean, confidence: number = 0): void {
        try {
            const urlPattern = pageUrl.split('?')[0].split('#')[0];
            this.elementCache.updatePageStats(urlPattern, success, confidence);
        } catch { /* non-critical */ }
    }

    /** Invalidate the snapshot cache */
    public invalidateCache(): void {
        this.snapshotCache = null;
    }
}
