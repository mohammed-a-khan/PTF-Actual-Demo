/**
 * CSIntelligentAI - Main AI Orchestrator
 * Coordinates all AI capabilities: NLP, Feature Extraction, DOM Analysis, Similarity, and Failure Analysis
 * Provides unified API for intelligent element identification and failure diagnosis
 */

import { Page, ElementHandle, Locator } from 'playwright';
import { CSReporter } from '../reporter/CSReporter';
import { CSPageDiagnostics, PageDiagnosticData } from '../diagnostics/CSPageDiagnostics';
import { CSNaturalLanguageEngine } from './nlp/CSNaturalLanguageEngine';
import { CSFeatureExtractor } from './features/CSFeatureExtractor';
import { CSDOMIntelligence } from './analysis/CSDOMIntelligence';
import { CSSimilarityEngine } from './similarity/CSSimilarityEngine';
import {
    ElementIdentificationResult,
    FailureAnalysis,
    FailureType,
    FailureContext,
    AIOperation,
    AIOperationType,
    AIConfig,
    DEFAULT_AI_CONFIG,
    ElementFeatures,
    NLPResult,
    DOMAnalysisResult,
    SimilarityScore
} from './types/AITypes';

export class CSIntelligentAI {
    private static instance: CSIntelligentAI;
    private config: AIConfig = DEFAULT_AI_CONFIG;
    private operations: AIOperation[] = [];
    private operationIdCounter: number = 0;

    // AI Module instances
    private nlpEngine: CSNaturalLanguageEngine;
    private featureExtractor: CSFeatureExtractor;
    private domIntelligence: CSDOMIntelligence;
    private similarityEngine: CSSimilarityEngine;

    private constructor() {
        this.nlpEngine = CSNaturalLanguageEngine.getInstance();
        this.featureExtractor = CSFeatureExtractor.getInstance();
        this.domIntelligence = CSDOMIntelligence.getInstance();
        this.similarityEngine = CSSimilarityEngine.getInstance();

        CSReporter.debug('[CSIntelligentAI] Initialized with all AI modules');
    }

    public static getInstance(): CSIntelligentAI {
        if (!CSIntelligentAI.instance) {
            CSIntelligentAI.instance = new CSIntelligentAI();
        }
        return CSIntelligentAI.instance;
    }

    /**
     * Configure AI system
     */
    public configure(config: Partial<AIConfig>): void {
        this.config = { ...this.config, ...config };
        CSReporter.debug(`[CSIntelligentAI] Configuration updated: ${JSON.stringify(config)}`);
    }

    /**
     * Get current configuration
     */
    public getConfig(): AIConfig {
        return { ...this.config };
    }

    /**
     * Identify element using natural language description
     * Main entry point for intelligent element identification
     */
    public async identifyElement(
        description: string,
        page: Page,
        context?: {
            testName?: string;
            scenarioName?: string;
            stepText?: string;
        }
    ): Promise<ElementIdentificationResult | null> {
        if (!this.config.enabled) {
            CSReporter.debug('[CSIntelligentAI] AI disabled, skipping identification');
            return null;
        }

        const startTime = Date.now();
        const operationId = this.generateOperationId();

        try {
            CSReporter.debug(`[CSIntelligentAI] Identifying element: "${description}"`);

            // Step 1: Process natural language description
            const nlpResult = await this.nlpEngine.processDescription(description);
            CSReporter.debug(`[CSIntelligentAI] NLP Result - Intent: ${nlpResult.intent}, Type: ${nlpResult.elementType}, Confidence: ${nlpResult.confidence}`);

            // Step 2: Analyze DOM
            const domAnalysis = await this.domIntelligence.analyze(page);
            CSReporter.debug(`[CSIntelligentAI] DOM Analysis - ${domAnalysis.metrics.totalElements} elements, ${domAnalysis.metrics.interactableElements} interactive`);

            // Step 3: Find candidate elements
            const candidates = await this.findCandidateElements(page, nlpResult, domAnalysis);
            CSReporter.debug(`[CSIntelligentAI] Found ${candidates.length} candidate elements`);

            if (candidates.length === 0) {
                CSReporter.debug('[CSIntelligentAI] No candidates found');
                this.recordOperation({
                    id: operationId,
                    type: 'identification',
                    timestamp: new Date(),
                    duration: Date.now() - startTime,
                    success: false,
                    details: { description, nlpResult, reason: 'No candidates found' }
                });
                return null;
            }

            // Step 4: Score and rank candidates
            const rankedCandidates = await this.rankCandidates(candidates, nlpResult, domAnalysis);
            const bestMatch = rankedCandidates[0];

            // Step 5: Create result
            // CRITICAL: If selector is a generic class selector and we have innerText, add text filter to make it unique
            let locator = page.locator(bestMatch.selector);
            const innerText = bestMatch.features?.context?.innerText;

            // If selector starts with '.' (class selector) and we have innerText, make it more specific
            if (bestMatch.selector.startsWith('.') && innerText && innerText.length > 0 && innerText.length < 100) {
                const trimmedText = innerText.trim();
                const escapedText = trimmedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Add exact text filter to avoid matching similar elements
                locator = locator.filter({ hasText: new RegExp(`^\\s*${escapedText}\\s*$`) });
                CSReporter.debug(`[CSIntelligentAI] Enhanced selector with text filter: "${trimmedText}"`);
            }

            const confidence = bestMatch.confidence;

            const result: ElementIdentificationResult = {
                locator,
                confidence,
                method: this.determineIdentificationMethod(nlpResult),
                features: bestMatch.features,
                alternatives: rankedCandidates.slice(1, 4).map(c => ({
                    locator: page.locator(c.selector),
                    confidence: c.confidence
                })),
                duration: Date.now() - startTime
            };

            // Record successful operation
            this.recordOperation({
                id: operationId,
                type: 'identification',
                timestamp: new Date(),
                duration: result.duration,
                success: true,
                confidence,
                details: {
                    description,
                    method: result.method,
                    candidatesCount: candidates.length,
                    nlpConfidence: nlpResult.confidence
                }
            });

            // Record AI identification in reports
            const duration = Date.now() - startTime;
            CSReporter.recordAIIdentification({
                method: result.method,
                confidence: confidence,
                alternatives: candidates.length,
                duration: duration
            });

            // Record advanced context in AI data for reports (v3.3.0+)
            if (bestMatch.features?.context) {
                const ctx = bestMatch.features.context;
                const advancedContext: any = {};

                if (ctx.inShadowDOM) {
                    advancedContext.shadowDOM = true;
                    advancedContext.shadowRootHost = ctx.shadowRootHost;
                }
                if (ctx.frameworkHints) {
                    advancedContext.framework = ctx.frameworkHints.trim().split(' ')[0]; // Take first framework
                }
                if (ctx.componentLibrary) {
                    advancedContext.componentLibrary = ctx.componentLibrary.trim().split(' ')[0]; // Take first library
                }
                if (ctx.tableContext || ctx.tableHeaders) {
                    advancedContext.inTable = true;
                    if (typeof ctx.tableHeaders === 'string') {
                        advancedContext.tableHeaders = ctx.tableHeaders.split(',').map((h: string) => h.trim()).filter((h: string) => h);
                    } else if (Array.isArray(ctx.tableHeaders)) {
                        advancedContext.tableHeaders = ctx.tableHeaders.filter((h: string) => h);
                    }
                }
                if (ctx.inIframe) {
                    advancedContext.inIframe = true;
                }
                if (ctx.hasLoadingIndicator) {
                    advancedContext.nearLoadingIndicator = true;
                }

                // Only record if we have advanced context data
                if (Object.keys(advancedContext).length > 0) {
                    CSReporter.recordAIAdvancedContext(advancedContext);
                }
            }

            CSReporter.debug(`[CSIntelligentAI] Element identified with confidence ${confidence.toFixed(2)} using ${result.method} method`);
            return result;

        } catch (error) {
            const duration = Date.now() - startTime;
            CSReporter.debug(`[CSIntelligentAI] Identification failed: ${error}`);

            this.recordOperation({
                id: operationId,
                type: 'identification',
                timestamp: new Date(),
                duration,
                success: false,
                details: { description, error: String(error) }
            });

            return null;
        }
    }

    /**
     * Analyze failure and determine if it's healable
     */
    public async analyzeFailure(
        error: Error,
        context: {
            step: string;
            page: Page;
            element?: any;
            locator?: string;
            url: string;
        }
    ): Promise<FailureAnalysis> {
        const startTime = Date.now();
        const operationId = this.generateOperationId();

        try {
            CSReporter.debug(`[CSIntelligentAI] Analyzing failure: ${error.message}`);

            // Get diagnostic data
            const diagnostics = await CSPageDiagnostics.collect(context.page, {
                maxLogs: 50,
                maxErrors: 10,
                maxRequests: 20
            });

            // Determine failure type
            const failureType = this.determineFailureType(error, diagnostics);
            CSReporter.debug(`[CSIntelligentAI] Failure type: ${failureType}`);

            // Determine if healable
            const healable = this.isFailureHealable(failureType, diagnostics);

            // Suggest healing strategies
            const suggestedStrategies = this.suggestHealingStrategies(failureType, diagnostics);

            // Determine root cause
            const rootCause = this.determineRootCause(failureType, diagnostics, error);

            // Extract diagnostic insights
            const diagnosticInsights = this.extractDiagnosticInsights(diagnostics);

            // Calculate confidence
            const confidence = this.calculateFailureAnalysisConfidence(
                failureType,
                diagnostics,
                suggestedStrategies.length
            );

            const failureContext: FailureContext = {
                error,
                step: context.step,
                url: context.url,
                timestamp: new Date(),
                diagnostics: diagnostics || undefined
            };

            const analysis: FailureAnalysis = {
                failureType,
                healable,
                confidence,
                suggestedStrategies,
                rootCause,
                context: failureContext,
                diagnosticInsights
            };

            // Record operation
            this.recordOperation({
                id: operationId,
                type: 'analysis',
                timestamp: new Date(),
                duration: Date.now() - startTime,
                success: true,
                confidence,
                details: {
                    failureType,
                    healable,
                    strategiesCount: suggestedStrategies.length
                }
            });

            CSReporter.debug(`[CSIntelligentAI] Failure analysis complete - Type: ${failureType}, Healable: ${healable}, Confidence: ${confidence.toFixed(2)}`);
            return analysis;

        } catch (analysisError) {
            CSReporter.debug(`[CSIntelligentAI] Failure analysis error: ${analysisError}`);

            // Fallback analysis
            return {
                failureType: 'Unknown',
                healable: false,
                confidence: 0,
                suggestedStrategies: [],
                rootCause: `Failed to analyze: ${analysisError}`,
                context: {
                    error,
                    step: context.step,
                    url: context.url,
                    timestamp: new Date()
                },
                diagnosticInsights: []
            };
        }
    }

    /**
     * Find candidate elements based on NLP result and DOM analysis
     */
    private async findCandidateElements(
        page: Page,
        nlpResult: NLPResult,
        domAnalysis: DOMAnalysisResult
    ): Promise<Array<{ element: ElementHandle; selector: string; features: ElementFeatures }>> {
        const candidates: Array<{ element: ElementHandle; selector: string; features: ElementFeatures }> = [];

        CSReporter.debug(`[findCandidateElements] Starting search with elementType: ${nlpResult.elementType}, intent: ${nlpResult.intent}`);

        try {
            // ═══════════════════════════════════════════════════════════════════════
            // UNIVERSAL DEEP CONTEXTUAL SEARCH - Works for ALL element types
            // ═══════════════════════════════════════════════════════════════════════
            try {
                // Wait for page to stabilize
                await page.waitForTimeout(500);

                // Build smart selector based on intent and element type
                let baseSelectors: string[] = [];

                if (nlpResult.intent === 'click') {
                    // Clickable elements: buttons, links, clickable divs, icons
                    baseSelectors = [
                        'button', 'a', '[role="button"]', '[role="link"]',
                        '[onclick]', '[ng-click]', '[v-on\\:click]',  // Framework click handlers (escaped colon for CSS)
                        'input[type="submit"]', 'input[type="button"]',
                        'div[tabindex]', 'span[tabindex]' // Custom clickable elements
                    ];
                } else if (nlpResult.intent === 'type') {
                    // Type-able elements: all input types, textareas
                    baseSelectors = [
                        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])',
                        'textarea'
                    ];
                } else if (nlpResult.intent === 'select') {
                    // Selectable elements: dropdowns, selects, custom dropdowns
                    baseSelectors = [
                        'select', '[role="listbox"]', '[role="combobox"]',
                        'div[class*="select"]', 'div[class*="dropdown"]'
                    ];
                } else {
                    // Fallback: all interactive elements
                    baseSelectors = [
                        'button', 'a', 'input', 'select', 'textarea',
                        '[role="button"]', '[tabindex]', '[onclick]'
                    ];
                }

                // Get ALL matching elements with DEEP CONTEXT
                const elementsWithContext = await page.evaluate((selectors) => {
                    const allElements: any[] = [];

                    // Helper: Extract deep context for ANY element
                    function extractDeepContext(element: Element, index: number) {
                        const tagName = element.tagName.toLowerCase();
                        const rect = element.getBoundingClientRect();

                        // Basic attributes (universal)
                        const id = element.getAttribute('id') || '';
                        const name = element.getAttribute('name') || '';
                        const type = element.getAttribute('type') || '';
                        const role = element.getAttribute('role') || '';
                        const className = element.className || '';

                        // Text attributes
                        const placeholder = element.getAttribute('placeholder') || '';
                        const title = element.getAttribute('title') || '';
                        const value = (element as HTMLInputElement).value || '';
                        const innerText = element.textContent?.trim() || '';

                        // ARIA attributes (accessibility - very reliable!)
                        const ariaLabel = element.getAttribute('aria-label') || '';
                        const ariaLabelledBy = element.getAttribute('aria-labelledby') || '';
                        const ariaDescribedBy = element.getAttribute('aria-describedby') || '';

                        // Test automation attributes (data-testid, data-test, data-cy, etc.)
                        const testId = element.getAttribute('data-testid') ||
                                      element.getAttribute('data-test') ||
                                      element.getAttribute('data-cy') ||
                                      element.getAttribute('data-test-id') || '';

                        // Framework-specific attributes
                        const ngModel = element.getAttribute('ng-model') || '';
                        const vModel = element.getAttribute('v-model') || '';

                        // ═══════════════════════════════════════════════════════════
                        // DEEP CONTEXT EXTRACTION - The Magic Happens Here!
                        // ═══════════════════════════════════════════════════════════

                        // 1. LABEL ASSOCIATION (highest priority - most reliable)
                        let labelText = '';
                        if (id) {
                            const label = document.querySelector(`label[for="${id}"]`);
                            if (label) labelText = label.textContent?.trim() || '';
                        }
                        // Check if element is wrapped in a label
                        if (!labelText) {
                            let parent = element.parentElement;
                            let depth = 0;
                            while (parent && depth < 5) {
                                if (parent.tagName === 'LABEL') {
                                    labelText = parent.textContent?.trim() || '';
                                    break;
                                }
                                parent = parent.parentElement;
                                depth++;
                            }
                        }
                        // Check aria-labelledby
                        if (!labelText && ariaLabelledBy) {
                            const labelEl = document.getElementById(ariaLabelledBy);
                            if (labelEl) labelText = labelEl.textContent?.trim() || '';
                        }

                        // 2. SURROUNDING TEXT (siblings, parent text nodes)
                        let surroundingText = '';
                        const parent = element.parentElement;
                        if (parent) {
                            // Previous sibling text
                            let prev = element.previousSibling;
                            while (prev) {
                                if (prev.nodeType === Node.TEXT_NODE) {
                                    surroundingText = (prev.textContent?.trim() || '') + ' ' + surroundingText;
                                } else if (prev.nodeType === Node.ELEMENT_NODE) {
                                    const prevEl = prev as Element;
                                    if (['LABEL', 'SPAN', 'DIV'].includes(prevEl.tagName)) {
                                        surroundingText = (prevEl.textContent?.trim() || '') + ' ' + surroundingText;
                                    }
                                    break; // Stop at first element
                                }
                                prev = prev.previousSibling;
                            }

                            // Next sibling text
                            let next = element.nextSibling;
                            while (next) {
                                if (next.nodeType === Node.TEXT_NODE) {
                                    surroundingText += ' ' + (next.textContent?.trim() || '');
                                } else if (next.nodeType === Node.ELEMENT_NODE) {
                                    const nextEl = next as Element;
                                    if (['LABEL', 'SPAN', 'DIV'].includes(nextEl.tagName)) {
                                        surroundingText += ' ' + (nextEl.textContent?.trim() || '');
                                    }
                                    break;
                                }
                                next = next.nextSibling;
                            }

                            // Parent container text (Material-UI, Bootstrap patterns)
                            const parentClass = parent.className?.toLowerCase() || '';
                            if (parentClass.includes('form-group') ||
                                parentClass.includes('field') ||
                                parentClass.includes('input-group')) {
                                const labels = parent.querySelectorAll('label, .label, [class*="label"]');
                                labels.forEach(l => {
                                    surroundingText += ' ' + (l.textContent?.trim() || '');
                                });
                            }
                        }

                        // 3. SEMANTIC CONTEXT (form, section, nav context)
                        let semanticContext = '';
                        let ancestor: Element | null = element.parentElement;
                        let ancestorDepth = 0;
                        while (ancestor && ancestorDepth < 10) {
                            const tag = ancestor.tagName;
                            if (['FORM', 'NAV', 'HEADER', 'FOOTER', 'SECTION', 'ARTICLE'].includes(tag)) {
                                const ancestorId = ancestor.getAttribute('id') || '';
                                const ancestorClass = ancestor.className || '';
                                const ancestorRole = ancestor.getAttribute('role') || '';
                                semanticContext = `${tag.toLowerCase()} ${ancestorId} ${ancestorClass} ${ancestorRole}`.trim();
                                break;
                            }
                            ancestor = ancestor.parentElement;
                            ancestorDepth++;
                        }

                        // 4. VISUAL CONTEXT (nearby headings, section titles)
                        let nearbyHeadings = '';
                        const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
                        headings.forEach(h => {
                            const hRect = h.getBoundingClientRect();
                            // Check if heading is "above" this element (within reasonable distance)
                            if (hRect.bottom <= rect.top && rect.top - hRect.bottom < 300) {
                                nearbyHeadings += ' ' + (h.textContent?.trim() || '');
                            }
                        });

                        // 5. TABLE CONTEXT (for elements inside tables - critical for data grids)
                        let tableContext = '';
                        let tableRowIndex = -1;
                        let tableCellIndex = -1;
                        let tableHeaders: string[] = [];
                        try {
                        let ancestorTable = element.closest('table');
                        if (!ancestorTable) {
                            // Check for ARIA grid/table roles (modern React/Angular tables)
                            const ariaTable = element.closest('[role="table"], [role="grid"], [role="treegrid"]');
                            if (ariaTable) {
                                ancestorTable = ariaTable as HTMLTableElement;
                            }
                        }
                        if (ancestorTable) {
                            // Find row
                            const row = element.closest('tr, [role="row"]');
                            if (row) {
                                const rows = Array.from(ancestorTable.querySelectorAll('tr, [role="row"]'));
                                tableRowIndex = rows.indexOf(row as Element);
                                // Find cell
                                const cell = element.closest('td, th, [role="cell"], [role="gridcell"], [role="columnheader"]');
                                if (cell) {
                                    const cells = Array.from(row.querySelectorAll('td, th, [role="cell"], [role="gridcell"], [role="columnheader"]'));
                                    tableCellIndex = cells.indexOf(cell as Element);
                                    // Extract column header
                                    const headerRow = ancestorTable.querySelector('thead tr, [role="row"]:first-child');
                                    if (headerRow) {
                                        const headerCells = Array.from(headerRow.querySelectorAll('th, [role="columnheader"], td'));
                                        if (headerCells[tableCellIndex]) {
                                            tableHeaders.push(headerCells[tableCellIndex].textContent?.trim() || '');
                                        }
                                    }
                                    // Also check for row header (first cell in row)
                                    if (cells[0] && tableCellIndex > 0) {
                                        const rowHeader = cells[0].textContent?.trim() || '';
                                        if (rowHeader) tableHeaders.push(rowHeader);
                                    }
                                }
                            }
                            tableContext = `table row=${tableRowIndex} col=${tableCellIndex} headers="${tableHeaders.join(', ')}"`;
                        }
                        } catch (e) {
                            // Silently skip table context if extraction fails
                        }

                        // 6. FRAMEWORK-SPECIFIC DETECTION (React, Angular, Vue, Svelte)
                        let frameworkHints = '';
                        try {
                        // React
                        const reactProps = Array.from(element.attributes).filter(attr =>
                            attr.name.startsWith('data-react') || attr.name.startsWith('__react')
                        );
                        if (reactProps.length > 0) frameworkHints += 'react ';
                        // Angular
                        const ngAttrs = Array.from(element.attributes).filter(attr =>
                            attr.name.startsWith('ng-') || attr.name.startsWith('_ng') ||
                            attr.name.startsWith('[') || attr.name.startsWith('(')
                        );
                        if (ngAttrs.length > 0 || ngModel) frameworkHints += 'angular ';
                        // Vue
                        const vueAttrs = Array.from(element.attributes).filter(attr =>
                            attr.name.startsWith('v-') || attr.name.startsWith(':') || attr.name.startsWith('@')
                        );
                        if (vueAttrs.length > 0 || vModel) frameworkHints += 'vue ';
                        // Svelte
                        if (element.className && element.className.includes('svelte-')) frameworkHints += 'svelte ';
                        } catch (e) {
                            // Silently skip framework detection if extraction fails
                        }

                        // 7. COMPONENT LIBRARY DETECTION (Material-UI, Ant Design, Bootstrap, etc.)
                        let componentLibrary = '';
                        try {
                        const classLower = className.toLowerCase();
                        if (classLower.includes('mui') || classLower.includes('material')) componentLibrary += 'material-ui ';
                        if (classLower.includes('ant-')) componentLibrary += 'ant-design ';
                        if (classLower.includes('btn') || classLower.includes('form-control') || classLower.includes('bootstrap')) componentLibrary += 'bootstrap ';
                        if (classLower.includes('oxd-')) componentLibrary += 'oxd-library ';
                        if (classLower.includes('el-')) componentLibrary += 'element-ui ';
                        if (classLower.includes('v-')) componentLibrary += 'vuetify ';
                        } catch (e) {
                            // Silently skip component library detection if extraction fails
                        }

                        // 8. SHADOW DOM DETECTION (modern web components)
                        let inShadowDOM = false;
                        let shadowRootHost = '';
                        try {
                        let rootNode: any = element.getRootNode();
                        if (rootNode && rootNode !== document) {
                            inShadowDOM = true;
                            if (rootNode.host) {
                                const host = rootNode.host as Element;
                                shadowRootHost = host.tagName.toLowerCase() + (host.id ? '#' + host.id : '') + (host.className ? '.' + host.className.split(' ')[0] : '');
                            }
                        }
                        } catch (e) {
                            // Silently skip shadow DOM detection if extraction fails
                        }

                        // 9. IFRAME DETECTION
                        let inIframe = false;
                        try {
                            inIframe = window.self !== window.top;
                        } catch (e) {
                            inIframe = true; // Cross-origin iframe
                        }

                        // 10. DYNAMIC LOADING INDICATORS (for SPAs)
                        let hasLoadingIndicator = false;
                        try {
                        const loadingPatterns = ['loading', 'spinner', 'skeleton', 'placeholder', 'shimmer'];
                        const nearbyElements = parent ? Array.from(parent.querySelectorAll('*')).slice(0, 20) : [];
                        hasLoadingIndicator = nearbyElements.some(el => {
                            const elClass = el.className?.toLowerCase() || '';
                            return loadingPatterns.some(pattern => elClass.includes(pattern));
                        });
                        } catch (e) {
                            // Silently skip loading indicator detection if extraction fails
                        }

                        // Visibility check
                        const style = window.getComputedStyle(element);
                        const isVisible = style.display !== 'none' &&
                                        style.visibility !== 'hidden' &&
                                        style.opacity !== '0' &&
                                        rect.width > 0 && rect.height > 0;

                        return {
                            index,
                            tagName,
                            type,
                            role,
                            id,
                            name,
                            className,
                            placeholder,
                            title,
                            innerText: innerText.substring(0, 200),
                            value: value.substring(0, 100),
                            ariaLabel,
                            testId,
                            ngModel,
                            vModel,
                            // DEEP CONTEXT
                            labelText: labelText.substring(0, 150),
                            surroundingText: surroundingText.substring(0, 300),
                            semanticContext: semanticContext.substring(0, 200),
                            nearbyHeadings: nearbyHeadings.substring(0, 200),
                            // ADVANCED CONTEXT (tables, frameworks, shadow DOM, iframes)
                            tableContext: tableContext.substring(0, 200),
                            tableRowIndex,
                            tableCellIndex,
                            tableHeaders: tableHeaders.join(', ').substring(0, 150),
                            frameworkHints: frameworkHints.trim(),
                            componentLibrary: componentLibrary.trim(),
                            inShadowDOM,
                            shadowRootHost: shadowRootHost.substring(0, 100),
                            inIframe,
                            hasLoadingIndicator,
                            isVisible,
                            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                        };
                    }

                    // Find all elements matching any selector
                    // Note: Shadow DOM traversal available but disabled by default for performance
                    // Enable with ENABLE_SHADOW_DOM=true environment variable if needed for web components
                    const selectorQuery = selectors.join(', ');
                    const elements = Array.from(document.querySelectorAll(selectorQuery));

                    elements.forEach((el, index) => {
                        try {
                            const context = extractDeepContext(el, index);
                            if (context.isVisible) {
                                allElements.push(context);
                            }
                        } catch (e) {
                            // Skip elements that fail context extraction
                        }
                    });

                    return allElements;
                }, baseSelectors);

                CSReporter.debug(`[findCandidateElements] DEEP CONTEXTUAL SEARCH: Found ${elementsWithContext.length} visible elements`);

                // Get element handles - match each context data to actual element
                for (const contextData of elementsWithContext) {
                    try {
                        // Build selector for this specific element to get handle
                        // CRITICAL: Use innerText to get the EXACT element, not just first match!
                        let locator;

                        if (contextData.id) {
                            locator = page.locator(`${contextData.tagName}#${contextData.id}`);
                        } else if (contextData.testId) {
                            locator = page.locator(`${contextData.tagName}[data-testid="${contextData.testId}"]`);
                        } else if (contextData.name) {
                            locator = page.locator(`${contextData.tagName}[name="${contextData.name}"]`);
                        } else if (contextData.placeholder) {
                            locator = page.locator(`${contextData.tagName}[placeholder="${contextData.placeholder}"]`);
                        } else if (contextData.innerText && contextData.innerText.length > 0 && contextData.innerText.length < 100) {
                            // Use innerText to identify the exact element (for buttons, links, menu items)
                            // CRITICAL: Use exact text match (regex with ^$) to avoid matching substrings
                            // Example: "Admin" should NOT match "Administrator" or logo with "Admin" in alt text
                            // IMPORTANT: Trim text and allow optional whitespace to handle " Login " vs "Login"
                            const trimmedText = contextData.innerText.trim();
                            const escapedText = trimmedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            locator = page.locator(contextData.tagName).filter({ hasText: new RegExp(`^\\s*${escapedText}\\s*$`) });
                        } else {
                            // SKIP: Element has no identifying attributes (no id, name, placeholder, testId, innerText)
                            // These elements can't be uniquely identified and will cause timeouts
                            CSReporter.debug(
                                `[findCandidateElements] ⏭️  Skipping element with no identifying attributes: ` +
                                `${contextData.tagName} #${contextData.index} (would cause timeout)`
                            );
                            continue;
                        }

                        const el = await locator.first().elementHandle();
                        const textPreview = (contextData.innerText || '').substring(0, 20);
                        if (!el) {
                            CSReporter.debug(
                                `[findCandidateElements] ❌ Could not get handle for: ${contextData.tagName} ` +
                                `(index=${contextData.index}, text="${textPreview}")`
                            );
                            continue;
                        }
                        CSReporter.debug(
                            `[findCandidateElements] ✅ Got handle for: ${contextData.tagName} ` +
                            `(text="${textPreview}")`
                        );

                        const features = await this.featureExtractor.extractFeatures(el, page);
                        const selector = await this.generateSelector(el);

                        // ENRICH features with deep context (merge with existing)
                        features.context = {
                            ...features.context,
                            labelText: contextData.labelText || features.context.labelText,
                            surroundingText: contextData.surroundingText,
                            hasLabel: !!contextData.labelText,
                            semanticContext: contextData.semanticContext,
                            nearbyHeadings: contextData.nearbyHeadings,
                            testId: contextData.testId,
                            innerText: contextData.innerText
                        };

                        candidates.push({ element: el, selector, features });

                        // Truncate innerText for debug output (max 50 chars)
                        const innerTextPreview = contextData.innerText
                            ? contextData.innerText.substring(0, 50).replace(/\n/g, ' ')
                            : '';

                        CSReporter.debug(
                            `[Context] ${contextData.tagName} #${contextData.index}: ` +
                            `type="${contextData.type}", ` +
                            `name="${contextData.name}", ` +
                            `placeholder="${contextData.placeholder}", ` +
                            `label="${contextData.labelText || 'none'}", ` +
                            `innerText="${innerTextPreview || 'none'}"`
                        );
                    } catch (e) {
                        CSReporter.debug(`[findCandidateElements] Failed to extract features for element ${contextData.index}: ${e}`);
                    }
                }
            } catch (e) {
                CSReporter.debug(`[findCandidateElements] DEEP CONTEXTUAL SEARCH failed: ${e}`);
            }

            // If deep contextual search found candidates, skip old strategies (they add noise)
            if (candidates.length > 0) {
                CSReporter.debug(`[findCandidateElements] Using ${candidates.length} candidates from deep contextual search, skipping fallback strategies`);
                return candidates;
            }

            // FALLBACK STRATEGIES (only if deep contextual search found nothing)
            CSReporter.debug(`[findCandidateElements] Deep contextual search found 0 candidates, trying fallback strategies...`);

            // Strategy 1: Text-based search
            if (nlpResult.textContent) {
                try {
                    const textElements = await page.locator(`text="${nlpResult.textContent}"`).elementHandles();
                    for (const el of textElements) {
                        const features = await this.featureExtractor.extractFeatures(el, page);
                        const selector = await this.generateSelector(el);
                        candidates.push({ element: el, selector, features });
                    }
                } catch (e) {
                    // Continue on error
                }
            }

            // Strategy 2: Role-based search
            if (nlpResult.expectedRoles) {
                for (const role of nlpResult.expectedRoles) {
                    try {
                        const roleElements = await page.locator(`[role="${role}"]`).elementHandles();
                        for (const el of roleElements) {
                            const features = await this.featureExtractor.extractFeatures(el, page);
                            const selector = await this.generateSelector(el);
                            candidates.push({ element: el, selector, features });
                        }
                    } catch (e) {
                        // Continue on error
                    }
                }
            }

            // Strategy 3: Tag-based search (with wait for elements)
            if (nlpResult.elementType) {
                const tagMap: Record<string, string> = {
                    'button': 'button',
                    'link': 'a',
                    'input': 'input',
                    'checkbox': 'input[type="checkbox"]',
                    'radio': 'input[type="radio"]',
                    'select': 'select',
                    'textarea': 'textarea'
                };

                const tag = tagMap[nlpResult.elementType];
                if (tag) {
                    try {
                        const tagElements = await page.locator(tag).elementHandles();
                        for (const el of tagElements) {
                            const features = await this.featureExtractor.extractFeatures(el, page);
                            const selector = await this.generateSelector(el);
                            candidates.push({ element: el, selector, features });
                        }
                    } catch (e) {
                        // Continue on error
                    }
                }
            }

            // Strategy 4: Keyword-based attribute search (for input fields)
            // Search by placeholder, name, aria-label, id containing keywords
            if (nlpResult.elementType === 'input' || nlpResult.elementType === 'textarea') {
                CSReporter.debug(`[CSIntelligentAI] Strategy 4: Searching inputs for keywords: ${nlpResult.keywords.join(', ')}`);
                for (const keyword of nlpResult.keywords.slice(0, 3)) {
                    try {
                        // Search by placeholder
                        const placeholderSelector = `input[placeholder*="${keyword}" i], textarea[placeholder*="${keyword}" i]`;
                        const placeholderElements = await page.locator(placeholderSelector).elementHandles();
                        CSReporter.debug(`[CSIntelligentAI] Found ${placeholderElements.length} elements with placeholder containing "${keyword}"`);
                        for (const el of placeholderElements) {
                            const features = await this.featureExtractor.extractFeatures(el, page);
                            const selector = await this.generateSelector(el);
                            candidates.push({ element: el, selector, features });
                        }

                        // Search by name attribute
                        const nameSelector = `input[name*="${keyword}" i], textarea[name*="${keyword}" i]`;
                        const nameElements = await page.locator(nameSelector).elementHandles();
                        for (const el of nameElements) {
                            const features = await this.featureExtractor.extractFeatures(el, page);
                            const selector = await this.generateSelector(el);
                            candidates.push({ element: el, selector, features });
                        }

                        // Search by aria-label
                        const ariaSelector = `input[aria-label*="${keyword}" i], textarea[aria-label*="${keyword}" i]`;
                        const ariaElements = await page.locator(ariaSelector).elementHandles();
                        for (const el of ariaElements) {
                            const features = await this.featureExtractor.extractFeatures(el, page);
                            const selector = await this.generateSelector(el);
                            candidates.push({ element: el, selector, features });
                        }

                        // Search by id containing keyword
                        const idSelector = `input[id*="${keyword}" i], textarea[id*="${keyword}" i]`;
                        const idElements = await page.locator(idSelector).elementHandles();
                        for (const el of idElements) {
                            const features = await this.featureExtractor.extractFeatures(el, page);
                            const selector = await this.generateSelector(el);
                            candidates.push({ element: el, selector, features });
                        }
                    } catch (e) {
                        // Continue on keyword search error
                    }
                }
            }

            // Strategy 5: Keyword-based text search (for buttons and links)
            for (const keyword of nlpResult.keywords.slice(0, 3)) {
                try {
                    const keywordElements = await page.locator(`text=/.*${keyword}.*/i`).elementHandles();
                    for (const el of keywordElements) {
                        const features = await this.featureExtractor.extractFeatures(el, page);
                        const selector = await this.generateSelector(el);
                        candidates.push({ element: el, selector, features });
                    }
                } catch (e) {
                    // Continue on keyword search error
                }
            }

            // Deduplicate candidates
            const uniqueCandidates = this.deduplicateCandidates(candidates);
            return uniqueCandidates;

        } catch (error) {
            CSReporter.debug(`[CSIntelligentAI] Error finding candidates: ${error}`);
            return candidates;
        }
    }

    /**
     * Rank candidates by relevance and confidence
     */
    private async rankCandidates(
        candidates: Array<{ element: ElementHandle; selector: string; features: ElementFeatures }>,
        nlpResult: NLPResult,
        domAnalysis: DOMAnalysisResult
    ): Promise<Array<{ selector: string; confidence: number; features: ElementFeatures }>> {
        // CRITICAL: Filter out hidden/invisible elements first
        const visibleCandidates = candidates.filter(candidate => {
            // Must be visible
            if (!candidate.features.visual.isVisible) {
                return false;
            }
            // Must not be hidden or display:none
            if (candidate.features.structural.attributes['type'] === 'hidden') {
                return false;
            }
            // For inputs, avoid CSRF tokens and other system fields
            const name = candidate.features.structural.attributes['name'] || '';
            if (name.includes('_token') || name.includes('csrf') || name.includes('__')) {
                return false;
            }
            return true;
        });

        // If no visible candidates, fallback to all candidates
        const candidatesToRank = visibleCandidates.length > 0 ? visibleCandidates : candidates;

        const scored = candidatesToRank.map(candidate => {
            let score = 0;

            // Extract element attributes
            const inputType = (candidate.features.structural.attributes['type'] || 'text').toLowerCase();
            const placeholder = (candidate.features.structural.attributes['placeholder'] || '').toLowerCase();
            const name = (candidate.features.structural.attributes['name'] || '').toLowerCase();
            const ariaLabel = (candidate.features.text.ariaLabel || '').toLowerCase();
            const id = (candidate.features.structural.attributes['id'] || '').toLowerCase();
            const candidateTag = candidate.features.structural.tagName.toLowerCase();

            // Extract field-specific keywords from NLP result
            const keywords = nlpResult.keywords.map(k => k.toLowerCase());
            const isPasswordField = keywords.some(k => ['password', 'pass', 'pwd'].includes(k));
            const isUsernameField = keywords.some(k => ['username', 'user', 'email'].includes(k));
            const isEmailField = keywords.some(k => ['email', 'e-mail'].includes(k));

            // 1. INPUT TYPE MATCHING (50% weight) - CRITICAL for password vs username
            // NOTE: This logic ONLY applies to INPUT elements, not buttons/links/divs
            if (candidateTag === 'input') {
                if (isPasswordField) {
                    // For password fields, MUST be type="password"
                    if (inputType === 'password') {
                        score += 0.50; // Perfect match
                        CSReporter.debug(`[Ranking] Password keyword + type=password: +0.50`);
                    } else {
                        // HEAVILY penalize non-password inputs for password keywords
                        score -= 0.80;
                        CSReporter.debug(`[Ranking] Password keyword but NOT type=password: -0.80`);
                    }
                } else if (isUsernameField || isEmailField) {
                    // For username/email fields, MUST NOT be type="password"
                    if (inputType === 'password') {
                        score -= 0.80; // Heavy penalty
                        CSReporter.debug(`[Ranking] Username keyword but type=password: -0.80`);
                    } else if (inputType === 'text' || inputType === 'email') {
                        score += 0.50; // Perfect match
                        CSReporter.debug(`[Ranking] Username keyword + type=text/email: +0.50`);
                    }
                } else if (nlpResult.intent === 'type') {
                    // Generic type intent - prefer text inputs
                    if (inputType === 'text' || inputType === 'email') {
                        score += 0.20;
                    }
                }
            }

            // 2. UNIVERSAL CONTEXT MATCHING (40% weight) - Works for ALL elements!
            let contextScore = 0;
            const contextData = candidate.features.context || {
                labelText: '', surroundingText: '', hasLabel: false,
                semanticContext: '', nearbyHeadings: '', testId: '', innerText: ''
            };

            const labelText = (contextData.labelText || '').toLowerCase();
            const surroundingText = (contextData.surroundingText || '').toLowerCase();
            const semanticContext = (contextData.semanticContext || '').toLowerCase();
            const nearbyHeadings = (contextData.nearbyHeadings || '').toLowerCase();
            const testId = (contextData.testId || '').toLowerCase();
            const innerText = (contextData.innerText || '').toLowerCase();

            for (const keyword of keywords) {
                // Test ID (data-testid) - Highest priority for automation
                if (testId.includes(keyword)) {
                    contextScore = Math.max(contextScore, 1.0);
                    CSReporter.debug(`[Ranking] TestID match '${keyword}': +1.0`);
                    break;
                }
                // Label text (for inputs, buttons can also have labels)
                if (labelText.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.98);
                    CSReporter.debug(`[Ranking] Label match '${keyword}': +0.98 (label="${labelText.substring(0, 30)}")`);
                    break;
                }
                // Inner text (for buttons, links, divs)
                if (innerText.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.95);
                    CSReporter.debug(`[Ranking] InnerText match '${keyword}': +0.95 (text="${innerText.substring(0, 30)}")`);
                }
                // Placeholder (for inputs)
                if (placeholder.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.92);
                    CSReporter.debug(`[Ranking] Placeholder match '${keyword}': +0.92`);
                }
                // Surrounding text (siblings, parent text)
                if (surroundingText.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.85);
                    CSReporter.debug(`[Ranking] Surrounding text match '${keyword}': +0.85`);
                }
                // Nearby headings (section context)
                if (nearbyHeadings.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.80);
                    CSReporter.debug(`[Ranking] Nearby heading match '${keyword}': +0.80`);
                }
                // Name attribute
                if (name.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.75);
                    CSReporter.debug(`[Ranking] Name attr match '${keyword}': +0.75`);
                }
                // Aria-label
                if (ariaLabel.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.70);
                }
                // ID attribute
                if (id.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.65);
                }
                // Semantic context (form, nav, etc.)
                if (semanticContext.includes(keyword)) {
                    contextScore = Math.max(contextScore, 0.60);
                }
            }
            score += contextScore * 0.40;

            // Special boost for buttons/links with exact innerText match
            if ((candidateTag === 'button' || candidateTag === 'a') && innerText) {
                for (const keyword of keywords) {
                    if (innerText.includes(keyword)) {
                        score += 0.50; // Extra boost for buttons with matching text
                        CSReporter.debug(`[Ranking] Button/Link innerText boost for '${keyword}': +0.50`);
                        break;
                    }
                }
            }

            // ADVANCED CONTEXT SCORING (tables, frameworks, loading indicators)
            const advancedContext = candidate.features.context || {};

            // Table context matching (for data grid operations)
            if (advancedContext.tableContext && advancedContext.tableHeaders) {
                const tableHeaders = (typeof advancedContext.tableHeaders === 'string'
                    ? advancedContext.tableHeaders
                    : advancedContext.tableHeaders.join(', ')).toLowerCase();
                for (const keyword of keywords) {
                    if (tableHeaders.includes(keyword)) {
                        score += 0.35; // Strong boost for matching table column headers
                        CSReporter.debug(`[Ranking] Table header match '${keyword}': +0.35`);
                        break;
                    }
                }
                // Additional boost for being in a table when keywords suggest tabular data
                const tableKeywords = ['row', 'column', 'cell', 'table', 'grid', 'data'];
                if (keywords.some(k => tableKeywords.includes(k))) {
                    score += 0.20;
                    CSReporter.debug(`[Ranking] Table context for table operation: +0.20`);
                }
            }

            // Framework-specific attribute boost (for React/Angular/Vue apps)
            if (advancedContext.frameworkHints) {
                const frameworks = advancedContext.frameworkHints.toLowerCase();
                // Slightly boost framework-specific elements as they're often well-structured
                if (frameworks) {
                    score += 0.05;
                    CSReporter.debug(`[Ranking] Framework-specific element (${frameworks}): +0.05`);
                }
            }

            // Component library boost (Material-UI, Ant Design have reliable patterns)
            if (advancedContext.componentLibrary) {
                const library = advancedContext.componentLibrary.toLowerCase();
                if (library.includes('material-ui') || library.includes('ant-design')) {
                    score += 0.08; // These libraries have excellent accessibility
                    CSReporter.debug(`[Ranking] Well-structured component library (${library}): +0.08`);
                }
            }

            // Shadow DOM penalty/boost
            if (advancedContext.inShadowDOM && advancedContext.shadowRootHost) {
                // Small penalty for shadow DOM complexity, but not too much as it's common in modern apps
                score -= 0.02;
                CSReporter.debug(`[Ranking] Shadow DOM element (${advancedContext.shadowRootHost}): -0.02`);
            }

            // Loading indicator penalty (avoid elements near loaders - likely stale)
            if (advancedContext.hasLoadingIndicator) {
                score -= 0.15;
                CSReporter.debug(`[Ranking] Near loading indicator (possibly stale): -0.15`);
            }

            // iframe penalty (cross-origin can be tricky)
            if (advancedContext.inIframe) {
                score -= 0.05;
                CSReporter.debug(`[Ranking] Inside iframe: -0.05`);
            }

            // 3. TEXT MATCHING (10% weight - reduced)
            if (nlpResult.textContent) {
                const textMatch = this.calculateTextMatch(candidate.features, nlpResult.textContent);
                score += textMatch * 0.10;
            }

            // 4. VISIBILITY (5% weight)
            if (candidate.features.visual.isVisible) {
                score += 0.05;
            }

            return {
                selector: candidate.selector,
                confidence: Math.min(score, 1.0),
                features: candidate.features
            };
        });

        // Sort by confidence descending
        const sorted = scored.sort((a, b) => b.confidence - a.confidence);

        // DEBUG: Log ALL scores to find why logo gets 0.93
        if (sorted.length > 0 && sorted.length <= 30) {
            CSReporter.debug(`[CSIntelligentAI] === ALL ${sorted.length} CANDIDATE SCORES ===`);
            sorted.forEach((cand, i) => {
                const tag = cand.features.structural.tagName;
                const innerText = cand.features.context?.innerText || '';
                const truncatedText = innerText.substring(0, 20);
                CSReporter.debug(`  ${i+1}. <${tag}> text="${truncatedText}" → ${cand.confidence.toFixed(2)}`);
            });
        }

        // Log top 3 candidates for debugging
        if (sorted.length > 0) {
            CSReporter.debug(`[CSIntelligentAI] ========== TOP CANDIDATES ==========`);
            sorted.slice(0, 3).forEach((cand, i) => {
                const tag = cand.features.structural.tagName;
                const type = cand.features.structural.attributes['type'] || 'text';
                const name = cand.features.structural.attributes['name'] || '';
                const placeholder = cand.features.structural.attributes['placeholder'] || '';
                CSReporter.debug(`  ${i + 1}. <${tag} type="${type}" name="${name}" placeholder="${placeholder}">`);
                CSReporter.debug(`     Confidence: ${cand.confidence.toFixed(2)} | Selector: ${cand.selector}`);
            });
            CSReporter.debug(`[CSIntelligentAI] ===================================`);
        }

        return sorted;
    }

    /**
     * Determine failure type from error and diagnostics
     */
    private determineFailureType(error: Error, diagnostics: PageDiagnosticData | null): FailureType {
        const errorMessage = error.message.toLowerCase();

        if (errorMessage.includes('timeout') || errorMessage.includes('exceeded')) {
            return 'Timeout';
        }
        if (errorMessage.includes('not found') || errorMessage.includes('no element')) {
            return 'ElementNotFound';
        }
        if (errorMessage.includes('not visible') || errorMessage.includes('hidden')) {
            return 'ElementNotVisible';
        }
        if (errorMessage.includes('not clickable') || errorMessage.includes('not interactable')) {
            return 'ElementNotInteractive';
        }
        if (diagnostics && diagnostics.pageErrors.some(e => e.message.includes('network') || e.message.includes('fetch'))) {
            return 'NetworkError';
        }
        if (diagnostics && diagnostics.pageErrors.some(e => e.message.includes('javascript') || e.message.includes('script error'))) {
            return 'JavaScriptError';
        }
        // Note: Modal/overlay detection would require additional page analysis
        // For now, we'll infer from errors

        return 'Unknown';
    }

    /**
     * Determine if failure is healable
     */
    private isFailureHealable(failureType: FailureType, diagnostics: PageDiagnosticData | null): boolean {
        switch (failureType) {
            case 'ElementNotFound':
                return true; // Can try alternative locators
            case 'ElementNotVisible':
                return true; // Can scroll
            case 'ElementNotInteractive':
                return true; // Can handle overlays
            case 'ModalBlocking':
                return true; // Can close modals
            case 'Timeout':
                return true; // Can retry with different strategy
            default:
                return false;
        }
    }

    /**
     * Suggest healing strategies based on failure type
     */
    private suggestHealingStrategies(failureType: FailureType, diagnostics: PageDiagnosticData | null): string[] {
        const strategies: string[] = [];

        switch (failureType) {
            case 'ElementNotFound':
                strategies.push('alternative_locators', 'text_based_search', 'visual_similarity', 'dom_traversal');
                break;
            case 'ElementNotVisible':
                strategies.push('scroll_into_view', 'wait_for_visible', 'check_display_none');
                break;
            case 'ElementNotInteractive':
                strategies.push('remove_overlays', 'wait_for_enabled', 'force_click');
                break;
            case 'ModalBlocking':
                strategies.push('close_modal', 'dismiss_overlay', 'handle_popup');
                break;
            case 'Timeout':
                strategies.push('increase_timeout', 'wait_for_network_idle', 'retry_with_polling');
                break;
        }

        return strategies;
    }

    /**
     * Determine root cause of failure
     */
    private determineRootCause(
        failureType: FailureType,
        diagnostics: PageDiagnosticData | null,
        error: Error
    ): string {
        if (!diagnostics) {
            return `${failureType}: ${error.message}`;
        }

        switch (failureType) {
            case 'ElementNotFound':
                return `Element not found. ${diagnostics.stats.totalErrors > 0 ? `${diagnostics.stats.totalErrors} page errors detected.` : 'No page errors.'}`;
            case 'ElementNotVisible':
                return `Element not visible. May need to scroll or wait for element.`;
            case 'ElementNotInteractive':
                return `Element not interactable. May be blocked by overlay or modal.`;
            case 'ModalBlocking':
                return `Modal blocking interaction.`;
            case 'Timeout':
                return `Operation timed out. ${diagnostics.stats.failedRequests} failed requests. ${diagnostics.stats.totalErrors} console errors.`;
            case 'NetworkError':
                return `Network error detected. ${diagnostics.stats.failedRequests} failed requests.`;
            case 'JavaScriptError':
                return `JavaScript error detected. ${diagnostics.stats.totalErrors} page errors.`;
            default:
                return `Unknown failure: ${error.message}`;
        }
    }

    /**
     * Extract diagnostic insights
     */
    private extractDiagnosticInsights(diagnostics: PageDiagnosticData | null): string[] {
        const insights: string[] = [];

        if (!diagnostics) {
            return insights;
        }

        if (diagnostics.stats.totalErrors > 0) {
            insights.push(`${diagnostics.stats.totalErrors} page errors detected`);
        }
        if (diagnostics.stats.errorLogs > 0) {
            insights.push(`${diagnostics.stats.errorLogs} console errors detected`);
        }
        if (diagnostics.stats.warningLogs > 0) {
            insights.push(`${diagnostics.stats.warningLogs} console warnings`);
        }
        if (diagnostics.stats.failedRequests > 0) {
            insights.push(`${diagnostics.stats.failedRequests} failed network requests`);
        }

        return insights;
    }

    /**
     * Calculate failure analysis confidence
     */
    private calculateFailureAnalysisConfidence(
        failureType: FailureType,
        diagnostics: PageDiagnosticData | null,
        strategiesCount: number
    ): number {
        let confidence = 0.5;

        // Known failure type
        if (failureType !== 'Unknown') {
            confidence += 0.2;
        }

        // Has diagnostic data
        if (diagnostics) {
            confidence += 0.1;
        }

        // Has healing strategies
        if (strategiesCount > 0) {
            confidence += 0.1 * Math.min(strategiesCount / 3, 1);
        }

        // Clean page (fewer errors)
        if (diagnostics && diagnostics.stats.totalErrors === 0) {
            confidence += 0.1;
        }

        return Math.min(confidence, 1.0);
    }

    /**
     * Helper: Calculate text match score
     */
    private calculateTextMatch(features: ElementFeatures, targetText: string): number {
        const texts = [
            features.text.content,
            features.text.visibleText,
            features.text.ariaLabel,
            features.text.title
        ].filter((t): t is string => !!t);

        let maxScore = 0;
        for (const text of texts) {
            const score = this.stringSimilarity(text.toLowerCase(), targetText.toLowerCase());
            maxScore = Math.max(maxScore, score);
        }

        return maxScore;
    }

    /**
     * Helper: Calculate visual match score
     */
    private calculateVisualMatch(features: ElementFeatures, visualCues: any): number {
        let score = 0;
        let count = 0;

        if (visualCues.colors && visualCues.colors.length > 0) {
            const colorMatch = visualCues.colors.some((c: string) =>
                features.visual.backgroundColor.includes(c) || features.visual.color.includes(c)
            );
            score += colorMatch ? 1 : 0;
            count++;
        }

        return count > 0 ? score / count : 0;
    }

    /**
     * Helper: String similarity using Levenshtein
     */
    private stringSimilarity(s1: string, s2: string): number {
        if (s1 === s2) return 1.0;
        if (!s1 || !s2) return 0.0;

        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;

        if (longer.length === 0) return 1.0;

        const distance = this.levenshteinDistance(longer, shorter);
        return (longer.length - distance) / longer.length;
    }

    /**
     * Helper: Levenshtein distance
     */
    private levenshteinDistance(s1: string, s2: string): number {
        const costs: number[] = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) {
                    costs[j] = j;
                } else if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) {
                costs[s2.length] = lastValue;
            }
        }
        return costs[s2.length];
    }

    /**
     * Helper: Generate selector for element
     */
    private async generateSelector(element: ElementHandle): Promise<string> {
        try {
            const selector = await element.evaluate((el: any) => {
                const tag = el.tagName.toLowerCase();

                // 1. Try ID first (most unique)
                if (el.id) return `#${el.id}`;

                // 2. Try data-testid (very reliable for automation)
                if (el.getAttribute('data-testid')) {
                    return `[data-testid="${el.getAttribute('data-testid')}"]`;
                }

                // 3. Try name attribute (unique for form fields)
                const name = el.getAttribute('name');
                if (name) return `${tag}[name="${name}"]`;

                // 4. Try placeholder (unique for inputs)
                const placeholder = el.getAttribute('placeholder');
                if (placeholder) return `${tag}[placeholder="${placeholder}"]`;

                // 5. Try type attribute
                const type = el.getAttribute('type');
                if (type && type !== 'text') return `${tag}[type="${type}"]`;

                // 6. Try unique class (AFTER checking name/placeholder to avoid duplicates)
                if (el.className) {
                    const classes = el.className.split(' ').filter((c: string) => c.length > 0);
                    if (classes.length > 0) {
                        return `.${classes.join('.')}`;
                    }
                }

                // 7. Fallback to tag
                return tag;
            });

            return selector;
        } catch {
            return '*';
        }
    }

    /**
     * Helper: Deduplicate candidates
     */
    private deduplicateCandidates(
        candidates: Array<{ element: ElementHandle; selector: string; features: ElementFeatures }>
    ): Array<{ element: ElementHandle; selector: string; features: ElementFeatures }> {
        const seen = new Set<string>();
        const unique: Array<{ element: ElementHandle; selector: string; features: ElementFeatures }> = [];

        for (const candidate of candidates) {
            const key = `${candidate.features.structural.tagName}-${candidate.features.text.content.slice(0, 50)}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(candidate);
            }
        }

        return unique;
    }

    /**
     * Helper: Determine identification method
     */
    private determineIdentificationMethod(nlpResult: NLPResult): 'nlp' | 'visual' | 'pattern' | 'structural' | 'text' {
        if (nlpResult.textContent) return 'text';
        if (nlpResult.visualCues.colors || nlpResult.visualCues.sizes) return 'visual';
        if (nlpResult.expectedRoles && nlpResult.expectedRoles.length > 0) return 'structural';
        if (nlpResult.keywords.length > 2) return 'nlp';
        return 'pattern';
    }

    /**
     * Record AI operation
     */
    private recordOperation(operation: AIOperation): void {
        this.operations.push(operation);

        // Limit history size
        if (this.operations.length > this.config.historyMaxEntries) {
            this.operations.shift();
        }
    }

    /**
     * Generate operation ID
     */
    private generateOperationId(): string {
        return `ai_op_${++this.operationIdCounter}_${Date.now()}`;
    }

    /**
     * Get all recorded operations
     */
    public getOperations(): AIOperation[] {
        return [...this.operations];
    }

    /**
     * Get operations by type
     */
    public getOperationsByType(type: AIOperationType): AIOperation[] {
        return this.operations.filter(op => op.type === type);
    }

    /**
     * Get success rate
     */
    public getSuccessRate(): number {
        if (this.operations.length === 0) return 0;
        const successful = this.operations.filter(op => op.success).length;
        return successful / this.operations.length;
    }

    /**
     * Get average confidence
     */
    public getAverageConfidence(): number {
        const withConfidence = this.operations.filter(op => op.confidence !== undefined);
        if (withConfidence.length === 0) return 0;
        const sum = withConfidence.reduce((acc, op) => acc + (op.confidence || 0), 0);
        return sum / withConfidence.length;
    }

    /**
     * Clear all operations history
     */
    public clearOperations(): void {
        this.operations = [];
        this.operationIdCounter = 0;
        CSReporter.debug('[CSIntelligentAI] Operations history cleared');
    }

    /**
     * Clear all caches
     */
    public clearAllCaches(): void {
        this.nlpEngine.clearCache();
        this.featureExtractor.clearCache();
        this.domIntelligence.clearCache();
        CSReporter.debug('[CSIntelligentAI] All AI module caches cleared');
    }

    /**
     * Get AI statistics
     */
    public getStatistics(): {
        totalOperations: number;
        successRate: number;
        averageConfidence: number;
        operationsByType: Record<AIOperationType, number>;
    } {
        const operationsByType: Record<AIOperationType, number> = {
            identification: 0,
            healing: 0,
            analysis: 0,
            prediction: 0,
            learning: 0
        };

        this.operations.forEach(op => {
            operationsByType[op.type]++;
        });

        return {
            totalOperations: this.operations.length,
            successRate: this.getSuccessRate(),
            averageConfidence: this.getAverageConfidence(),
            operationsByType
        };
    }
}
