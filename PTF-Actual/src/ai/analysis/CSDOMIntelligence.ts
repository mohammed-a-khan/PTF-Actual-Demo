/**
 * DOM Intelligence - Deep DOM analysis and understanding
 * Provides comprehensive DOM structure analysis, form detection, table detection, and semantic mapping
 */

import { Page } from 'playwright';
import {
    DOMAnalysisResult,
    ElementInfo,
    FormInfo,
    TableInfo,
    NavigationInfo,
    DOMMetrics,
    SemanticMap
} from '../types/AITypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSDOMIntelligence {
    private static instance: CSDOMIntelligence;
    private cache: Map<string, DOMAnalysisResult> = new Map();
    private readonly cacheTimeout: number = 300000; // 5 minutes

    private constructor() {
        CSReporter.debug('[CSDOMIntelligence] Initialized');
    }

    public static getInstance(): CSDOMIntelligence {
        if (!CSDOMIntelligence.instance) {
            CSDOMIntelligence.instance = new CSDOMIntelligence();
        }
        return CSDOMIntelligence.instance;
    }

    /**
     * Analyze entire DOM structure
     */
    public async analyze(page: Page): Promise<DOMAnalysisResult> {
        const url = page.url();
        const cached = this.cache.get(url);

        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            CSReporter.debug(`[DOMIntelligence] Cache hit for: ${url}`);
            return cached;
        }

        // Wait for page to be fully loaded and interactive
        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        } catch (e) {
            CSReporter.debug(`[DOMIntelligence] Load state wait timed out, continuing...`);
        }

        const startTime = Date.now();
        CSReporter.debug(`[DOMIntelligence] Analyzing DOM for: ${url}`);

        const [hierarchy, forms, tables, navigation, metrics, semanticMap] = await Promise.all([
            this.analyzeHierarchy(page),
            this.analyzeForms(page),
            this.analyzeTables(page),
            this.analyzeNavigation(page),
            this.collectMetrics(page),
            this.buildSemanticMap(page)
        ]);

        const result: DOMAnalysisResult = {
            hierarchy,
            forms,
            tables,
            navigation,
            metrics,
            semanticMap,
            timestamp: Date.now()
        };

        // Only cache if we found interactive elements (avoid caching incomplete page loads)
        if (metrics.interactableElements > 0) {
            this.cache.set(url, result);
            setTimeout(() => this.cache.delete(url), this.cacheTimeout);
            CSReporter.debug(`[DOMIntelligence] Cached result (${metrics.interactableElements} interactive elements)`);
        } else {
            CSReporter.debug(`[DOMIntelligence] NOT caching - found 0 interactive elements (incomplete page?)`);
        }

        const duration = Date.now() - startTime;
        CSReporter.debug(`[DOMIntelligence] Analysis complete in ${duration}ms`);

        return result;
    }

    /**
     * Analyze DOM hierarchy
     */
    private async analyzeHierarchy(page: Page): Promise<ElementInfo> {
        return await page.evaluate(() => {
            function analyzeElement(el: Element, depth: number = 0, path: string[] = []): any {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();

                const isVisible = style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    parseFloat(style.opacity) > 0;

                const isInteractive = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ||
                    el.hasAttribute('onclick') ||
                    (el.getAttribute('role') && ['button', 'link'].includes(el.getAttribute('role')!));

                const newPath = [...path, el.tagName.toLowerCase()];

                const children: any[] = [];
                if (depth < 5) { // Limit depth to avoid too large structure
                    for (const child of Array.from(el.children)) {
                        children.push(analyzeElement(child, depth + 1, newPath));
                    }
                }

                return {
                    tagName: el.tagName.toLowerCase(),
                    id: el.id || '',
                    className: el.className || '',
                    text: el.textContent?.slice(0, 100) || '',
                    visible: isVisible,
                    interactive: isInteractive,
                    depth,
                    path: newPath,
                    children
                };
            }

            const body = document.body;
            return analyzeElement(body);
        });
    }

    /**
     * Analyze all forms in the page
     */
    private async analyzeForms(page: Page): Promise<FormInfo[]> {
        return await page.evaluate(() => {
            const forms = Array.from(document.querySelectorAll('form'));

            return forms.map(form => {
                const fields: any[] = [];

                // Find all input fields
                const inputs = form.querySelectorAll('input, select, textarea');
                inputs.forEach(input => {
                    const label = form.querySelector(`label[for="${input.id}"]`)?.textContent || '';

                    fields.push({
                        name: input.getAttribute('name') || '',
                        type: input.getAttribute('type') || input.tagName.toLowerCase(),
                        required: input.hasAttribute('required'),
                        label
                    });
                });

                return {
                    id: form.id || '',
                    name: form.getAttribute('name') || '',
                    action: form.action || '',
                    method: form.method || '',
                    fields
                };
            });
        });
    }

    /**
     * Analyze all tables in the page
     */
    private async analyzeTables(page: Page): Promise<TableInfo[]> {
        return await page.evaluate(() => {
            const tables = Array.from(document.querySelectorAll('table'));

            return tables.map(table => {
                const rows = table.querySelectorAll('tr').length;
                const headers: string[] = [];

                // Get headers
                const headerCells = table.querySelectorAll('th');
                headerCells.forEach(th => {
                    headers.push(th.textContent || '');
                });

                // Count columns from first row
                const firstRow = table.querySelector('tr');
                const columns = firstRow ? firstRow.querySelectorAll('td, th').length : 0;

                return {
                    id: table.id || '',
                    rows,
                    columns,
                    headers,
                    hasCaption: !!table.querySelector('caption')
                };
            });
        });
    }

    /**
     * Analyze navigation elements
     */
    private async analyzeNavigation(page: Page): Promise<NavigationInfo[]> {
        return await page.evaluate(() => {
            const navElements = Array.from(document.querySelectorAll('nav, [role="navigation"]'));

            return navElements.map(nav => {
                const links: any[] = [];

                // Find all links in navigation
                const anchors = nav.querySelectorAll('a');
                anchors.forEach(a => {
                    const isActive = a.classList.contains('active') ||
                        a.getAttribute('aria-current') === 'page';

                    links.push({
                        text: a.textContent || '',
                        href: a.href || '',
                        active: isActive
                    });
                });

                return {
                    id: nav.id || '',
                    role: nav.getAttribute('role') || 'navigation',
                    links
                };
            });
        });
    }

    /**
     * Collect DOM metrics
     */
    private async collectMetrics(page: Page): Promise<DOMMetrics> {
        return await page.evaluate(() => {
            const allElements = document.querySelectorAll('*');
            let visibleElements = 0;
            let interactableElements = 0;
            let maxDepth = 0;
            let totalDepth = 0;

            allElements.forEach(el => {
                const style = window.getComputedStyle(el);

                // Check visibility
                const isVisible = style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    parseFloat(style.opacity) > 0;

                if (isVisible) {
                    visibleElements++;
                }

                // Check interactability (ONLY count visible interactive elements)
                const isInteractive = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ||
                    el.hasAttribute('onclick');

                if (isInteractive && isVisible) {
                    // Also skip hidden input fields (type="hidden", name contains _token, csrf, etc.)
                    const inputType = el.getAttribute('type')?.toLowerCase();
                    const inputName = el.getAttribute('name')?.toLowerCase() || '';
                    const isHiddenInput = inputType === 'hidden' ||
                        inputName.includes('_token') ||
                        inputName.includes('csrf') ||
                        inputName.includes('__');

                    if (!isHiddenInput) {
                        interactableElements++;
                    }
                }

                // Calculate depth
                let depth = 0;
                let current: Element | null = el;
                while (current.parentElement) {
                    depth++;
                    current = current.parentElement;
                }
                maxDepth = Math.max(maxDepth, depth);
                totalDepth += depth;
            });

            return {
                totalElements: allElements.length,
                visibleElements,
                interactableElements,
                forms: document.querySelectorAll('form').length,
                tables: document.querySelectorAll('table').length,
                images: document.querySelectorAll('img').length,
                links: document.querySelectorAll('a').length,
                buttons: document.querySelectorAll('button').length,
                inputs: document.querySelectorAll('input').length,
                maxDepth,
                averageDepth: allElements.length > 0 ? totalDepth / allElements.length : 0
            };
        });
    }

    /**
     * Build semantic map of the page
     */
    private async buildSemanticMap(page: Page): Promise<SemanticMap> {
        return await page.evaluate(() => {
            // Find landmarks
            const landmarkRoles = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'region'];
            const landmarks: any[] = [];

            landmarkRoles.forEach(role => {
                const elements = document.querySelectorAll(`[role="${role}"]`);
                elements.forEach(el => {
                    landmarks.push({
                        role,
                        label: el.getAttribute('aria-label') || '',
                        selector: `[role="${role}"]${el.id ? `#${el.id}` : ''}`
                    });
                });
            });

            // Also check semantic HTML5 elements
            const semanticElements = document.querySelectorAll('header, nav, main, aside, footer');
            semanticElements.forEach(el => {
                const roleMap: Record<string, string> = {
                    'header': 'banner',
                    'nav': 'navigation',
                    'main': 'main',
                    'aside': 'complementary',
                    'footer': 'contentinfo'
                };

                landmarks.push({
                    role: roleMap[el.tagName.toLowerCase()],
                    label: el.getAttribute('aria-label') || '',
                    selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')
                });
            });

            // Find headings
            const headings: any[] = [];
            for (let level = 1; level <= 6; level++) {
                const headingElements = document.querySelectorAll(`h${level}`);
                headingElements.forEach(h => {
                    headings.push({
                        level,
                        text: h.textContent || '',
                        selector: `h${level}${h.id ? `#${h.id}` : ''}`
                    });
                });
            }

            // Find regions
            const regions: any[] = [];
            const regionElements = document.querySelectorAll('[role]');
            regionElements.forEach(el => {
                const role = el.getAttribute('role');
                if (role) {
                    regions.push({
                        role,
                        label: el.getAttribute('aria-label') || ''
                    });
                }
            });

            return {
                landmarks,
                headings,
                regions
            };
        });
    }

    /**
     * Find element by semantic description
     */
    public async findBySemantics(
        page: Page,
        semanticQuery: {
            landmark?: string;
            heading?: string;
            formContext?: boolean;
            tableContext?: boolean;
        }
    ): Promise<string | null> {
        const analysis = await this.analyze(page);

        // Search in landmarks
        if (semanticQuery.landmark) {
            const landmark = analysis.semanticMap.landmarks.find(
                l => l.role === semanticQuery.landmark || l.label.includes(semanticQuery.landmark!)
            );
            if (landmark) return landmark.selector;
        }

        // Search in headings
        if (semanticQuery.heading) {
            const heading = analysis.semanticMap.headings.find(
                h => h.text.toLowerCase().includes(semanticQuery.heading!.toLowerCase())
            );
            if (heading) return heading.selector;
        }

        return null;
    }

    /**
     * Get form by characteristics
     */
    public async getFormInfo(page: Page, formId?: string): Promise<FormInfo | null> {
        const analysis = await this.analyze(page);

        if (formId) {
            return analysis.forms.find(f => f.id === formId || f.name === formId) || null;
        }

        // Return first form if no ID specified
        return analysis.forms[0] || null;
    }

    /**
     * Clear cache
     */
    public clearCache(): void {
        this.cache.clear();
        CSReporter.debug('[DOMIntelligence] Cache cleared');
    }
}
