/**
 * Feature Extractor - Extracts 64 dimensions of features from elements
 * Used for intelligent element matching, healing, and identification
 */

import { ElementHandle, Page } from 'playwright';
import {
    ElementFeatures,
    TextFeatures,
    VisualFeatures,
    StructuralFeatures,
    SemanticFeatures,
    ContextFeatures
} from '../types/AITypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSFeatureExtractor {
    private static instance: CSFeatureExtractor;
    private cache: Map<string, ElementFeatures> = new Map();

    private constructor() {
        CSReporter.debug('[CSFeatureExtractor] Initialized');
    }

    public static getInstance(): CSFeatureExtractor {
        if (!CSFeatureExtractor.instance) {
            CSFeatureExtractor.instance = new CSFeatureExtractor();
        }
        return CSFeatureExtractor.instance;
    }

    /**
     * Extract all 64 dimensions of features from an element
     */
    public async extractFeatures(element: ElementHandle, page?: Page): Promise<ElementFeatures> {
        try {
            const [text, visual, structural, semantic, context] = await Promise.all([
                this.extractTextFeatures(element),
                this.extractVisualFeatures(element, page),
                this.extractStructuralFeatures(element),
                this.extractSemanticFeatures(element),
                this.extractContextFeatures(element, page)
            ]);

            return {
                text,
                visual,
                structural,
                semantic,
                context,
                timestamp: Date.now()
            };
        } catch (error) {
            CSReporter.debug(`[FeatureExtractor] Error extracting features: ${error}`);
            throw error;
        }
    }

    /**
     * Extract Text Features (7 dimensions)
     */
    private async extractTextFeatures(element: ElementHandle): Promise<TextFeatures> {
        const features = await element.evaluate((el: any) => {
            return {
                content: el.textContent || '',
                visibleText: el.innerText || '',
                ariaLabel: el.getAttribute('aria-label') || undefined,
                title: el.getAttribute('title') || el.title || undefined,
                placeholder: el.getAttribute('placeholder') || undefined,
                value: el.value || undefined,
                alt: el.getAttribute('alt') || undefined
            };
        });

        return features;
    }

    /**
     * Extract Visual Features (15 dimensions)
     */
    private async extractVisualFeatures(element: ElementHandle, page?: Page): Promise<VisualFeatures> {
        const features = await element.evaluate((el: any) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            // Check if in viewport
            const inViewport = (
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );

            // Calculate visual weight (size * opacity * zIndex)
            const visualWeight = (rect.width * rect.height) * parseFloat(style.opacity) * (parseInt(style.zIndex) || 1);

            // Check for high contrast
            const backgroundColor = style.backgroundColor;
            const color = style.color;
            const hasHighContrast = backgroundColor !== color && backgroundColor !== 'transparent';

            // Check for animations
            const hasAnimation = style.animation !== 'none' || style.transition !== 'all 0s ease 0s';

            return {
                isVisible: style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0,
                boundingBox: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                },
                zIndex: parseInt(style.zIndex) || 0,
                opacity: parseFloat(style.opacity),
                backgroundColor: style.backgroundColor,
                color: style.color,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                hasHighContrast,
                hasAnimation,
                display: style.display,
                position: style.position,
                cursor: style.cursor,
                inViewport,
                visualWeight
            };
        });

        return features;
    }

    /**
     * Extract Structural Features (20 dimensions)
     */
    private async extractStructuralFeatures(element: ElementHandle): Promise<StructuralFeatures> {
        const features = await element.evaluate((el: any) => {
            // Get all attributes
            const attributes: Record<string, string> = {};
            for (const attr of el.attributes) {
                attributes[attr.name] = attr.value;
            }

            // Get path to element
            const path: string[] = [];
            let current = el;
            while (current && current.tagName) {
                path.unshift(current.tagName.toLowerCase());
                current = current.parentElement;
            }

            // Calculate depth
            const depth = path.length;

            // Check interactivity
            const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
            const isInteractive = interactiveTags.includes(el.tagName) ||
                el.hasAttribute('onclick') ||
                el.hasAttribute('role') && ['button', 'link'].includes(el.getAttribute('role'));

            // Get sibling info
            const siblings = el.parentElement ? Array.from(el.parentElement.children) : [];
            const siblingIndex = siblings.indexOf(el);

            return {
                tagName: el.tagName.toLowerCase(),
                attributes,
                classList: Array.from(el.classList) as string[],
                id: el.id || '',
                isInteractive,
                hasChildren: el.children.length > 0,
                childCount: el.children.length,
                depth,
                path,
                role: el.getAttribute('role') || null,
                formElement: ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName),
                inputType: el.type || undefined,
                href: el.href || undefined,
                src: el.src || undefined,
                disabled: el.disabled || undefined,
                readOnly: el.readOnly || undefined,
                checked: el.checked || undefined,
                selected: el.selected || undefined,
                siblingCount: siblings.length,
                siblingIndex
            };
        });

        return features;
    }

    /**
     * Extract Semantic Features (12 dimensions)
     */
    private async extractSemanticFeatures(element: ElementHandle): Promise<SemanticFeatures> {
        const features = await element.evaluate((el: any) => {
            // Get role (explicit or implicit)
            let role = el.getAttribute('role');
            if (!role) {
                // Implicit roles
                const tagRoleMap: Record<string, string> = {
                    'A': 'link',
                    'BUTTON': 'button',
                    'INPUT': el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox',
                    'SELECT': 'combobox',
                    'TEXTAREA': 'textbox',
                    'NAV': 'navigation',
                    'MAIN': 'main',
                    'HEADER': 'banner',
                    'FOOTER': 'contentinfo',
                    'ASIDE': 'complementary',
                    'TABLE': 'table',
                    'UL': 'list',
                    'OL': 'list',
                    'LI': 'listitem',
                    'H1': 'heading',
                    'H2': 'heading',
                    'H3': 'heading',
                    'H4': 'heading',
                    'H5': 'heading',
                    'H6': 'heading'
                };
                role = tagRoleMap[el.tagName] || 'generic';
            }

            // Check if landmark
            const landmarkRoles = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'region'];
            const isLandmark = landmarkRoles.includes(role);

            // Get heading level
            let headingLevel = 0;
            if (el.tagName.match(/^H[1-6]$/)) {
                headingLevel = parseInt(el.tagName.charAt(1));
            } else if (role === 'heading') {
                headingLevel = parseInt(el.getAttribute('aria-level') || '0');
            }

            // Check if list item
            const listItem = el.tagName === 'LI' || role === 'listitem';
            const listContainer = ['UL', 'OL'].includes(el.tagName) || role === 'list';

            // Check if table cell
            const tableCell = ['TD', 'TH'].includes(el.tagName) || role === 'cell' || role === 'gridcell';
            const tableRow = el.tagName === 'TR' || role === 'row';

            // Determine semantic type
            let semanticType = 'generic';
            if (isLandmark) semanticType = 'landmark';
            else if (headingLevel > 0) semanticType = 'heading';
            else if (listItem) semanticType = 'listitem';
            else if (tableCell) semanticType = 'tablecell';
            else if (['button', 'link'].includes(role)) semanticType = 'interactive';
            else if (['textbox', 'searchbox', 'combobox'].includes(role)) semanticType = 'input';

            return {
                role,
                ariaLabel: el.getAttribute('aria-label') || null,
                ariaDescribedBy: el.getAttribute('aria-describedby') || null,
                ariaLabelledBy: el.getAttribute('aria-labelledby') || null,
                isLandmark,
                headingLevel,
                listItem,
                listContainer,
                tableCell,
                tableRow,
                semanticType,
                isRequired: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || undefined
            };
        });

        return features;
    }

    /**
     * Extract Context Features (10 dimensions)
     */
    private async extractContextFeatures(element: ElementHandle, page?: Page): Promise<ContextFeatures> {
        const features = await element.evaluate((el: any) => {
            // Get parent info
            const parent = el.parentElement;
            const parentTag = parent ? parent.tagName.toLowerCase() : '';
            const parentText = parent ? parent.textContent?.slice(0, 100) || '' : '';

            // Get sibling texts
            const siblings = parent ? Array.from(parent.children) : [];
            const siblingTexts = siblings
                .filter((s: any) => s !== el)
                .map((s: any) => s.textContent?.slice(0, 50) || '')
                .filter(t => t.length > 0)
                .slice(0, 5);

            // Find nearby heading
            let nearbyHeading = '';
            let current: any = el;
            while (current && !nearbyHeading) {
                current = current.previousElementSibling;
                if (current && current.tagName && current.tagName.match(/^H[1-6]$/)) {
                    nearbyHeading = current.textContent || '';
                }
            }

            // Find associated label
            let labelText = '';
            if (el.id) {
                const label = document.querySelector(`label[for="${el.id}"]`);
                if (label) {
                    labelText = label.textContent || '';
                }
            }
            // Or wrapped label
            if (!labelText && parent && parent.tagName === 'LABEL') {
                labelText = parent.textContent || '';
            }

            // Find form ID
            let formId = '';
            let formParent: any = el;
            while (formParent && !formId) {
                if (formParent.tagName === 'FORM') {
                    formId = formParent.id || formParent.name || '';
                    break;
                }
                formParent = formParent.parentElement;
            }

            // Find table headers
            const tableHeaders: string[] = [];
            if (el.closest('table')) {
                const table = el.closest('table');
                const headers = table?.querySelectorAll('th');
                if (headers) {
                    headers.forEach((th: any) => {
                        tableHeaders.push(th.textContent || '');
                    });
                }
            }

            // Find nearest landmark
            let nearestLandmark: { role: string; id: string } | null = null;
            let landmarkParent: any = el;
            const landmarkRoles = ['banner', 'navigation', 'main', 'complementary', 'contentinfo'];
            while (landmarkParent) {
                const role = landmarkParent.getAttribute?.('role');
                if (role && landmarkRoles.includes(role)) {
                    nearestLandmark = {
                        role,
                        id: landmarkParent.id || ''
                    };
                    break;
                }
                landmarkParent = landmarkParent.parentElement;
            }

            // Get preceding and following text
            const precedingText = el.previousSibling?.textContent?.slice(0, 50) || '';
            const followingText = el.nextSibling?.textContent?.slice(0, 50) || '';

            return {
                parentTag,
                parentText,
                siblingTexts,
                nearbyHeading,
                labelText,
                formId,
                tableHeaders,
                nearestLandmark,
                precedingText,
                followingText
            };
        });

        return features;
    }

    /**
     * Compare two feature sets and return similarity score
     */
    public calculateSimilarity(features1: ElementFeatures, features2: ElementFeatures): number {
        let totalScore = 0;
        let totalWeight = 0;

        // Text similarity (weight: 0.3)
        const textScore = this.compareTextFeatures(features1.text, features2.text);
        totalScore += textScore * 0.3;
        totalWeight += 0.3;

        // Visual similarity (weight: 0.2)
        const visualScore = this.compareVisualFeatures(features1.visual, features2.visual);
        totalScore += visualScore * 0.2;
        totalWeight += 0.2;

        // Structural similarity (weight: 0.25)
        const structuralScore = this.compareStructuralFeatures(features1.structural, features2.structural);
        totalScore += structuralScore * 0.25;
        totalWeight += 0.25;

        // Semantic similarity (weight: 0.15)
        const semanticScore = this.compareSemanticFeatures(features1.semantic, features2.semantic);
        totalScore += semanticScore * 0.15;
        totalWeight += 0.15;

        // Context similarity (weight: 0.1)
        const contextScore = this.compareContextFeatures(features1.context, features2.context);
        totalScore += contextScore * 0.1;
        totalWeight += 0.1;

        return totalScore / totalWeight;
    }

    private compareTextFeatures(f1: TextFeatures, f2: TextFeatures): number {
        let matches = 0;
        let total = 0;

        if (f1.content && f2.content) {
            matches += this.stringSimilarity(f1.content, f2.content);
            total++;
        }
        if (f1.ariaLabel && f2.ariaLabel) {
            matches += this.stringSimilarity(f1.ariaLabel, f2.ariaLabel);
            total++;
        }

        return total > 0 ? matches / total : 0;
    }

    private compareVisualFeatures(f1: VisualFeatures, f2: VisualFeatures): number {
        let score = 0;

        if (f1.isVisible === f2.isVisible) score += 0.2;
        if (f1.fontSize === f2.fontSize) score += 0.2;
        if (f1.position === f2.position) score += 0.2;

        // Bounding box similarity
        if (f1.boundingBox && f2.boundingBox) {
            const widthDiff = Math.abs(f1.boundingBox.width - f2.boundingBox.width);
            const heightDiff = Math.abs(f1.boundingBox.height - f2.boundingBox.height);
            if (widthDiff < 50 && heightDiff < 50) score += 0.2;
        }

        return Math.min(score, 1.0);
    }

    private compareStructuralFeatures(f1: StructuralFeatures, f2: StructuralFeatures): number {
        let score = 0;

        if (f1.tagName === f2.tagName) score += 0.3;
        if (f1.role === f2.role) score += 0.2;
        if (f1.depth === f2.depth) score += 0.2;

        // Class overlap
        const classOverlap = f1.classList.filter(c => f2.classList.includes(c)).length;
        if (classOverlap > 0) score += 0.3 * (classOverlap / Math.max(f1.classList.length, f2.classList.length));

        return Math.min(score, 1.0);
    }

    private compareSemanticFeatures(f1: SemanticFeatures, f2: SemanticFeatures): number {
        let score = 0;

        if (f1.role === f2.role) score += 0.4;
        if (f1.semanticType === f2.semanticType) score += 0.3;
        if (f1.headingLevel === f2.headingLevel) score += 0.3;

        return Math.min(score, 1.0);
    }

    private compareContextFeatures(f1: ContextFeatures, f2: ContextFeatures): number {
        let score = 0;

        if (f1.parentTag === f2.parentTag) score += 0.3;
        if (f1.formId && f1.formId === f2.formId) score += 0.3;
        if (f1.nearbyHeading && f2.nearbyHeading) {
            score += 0.4 * this.stringSimilarity(f1.nearbyHeading, f2.nearbyHeading);
        }

        return Math.min(score, 1.0);
    }

    private stringSimilarity(s1: string, s2: string): number {
        if (s1 === s2) return 1.0;
        if (!s1 || !s2) return 0.0;

        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;

        if (longer.length === 0) return 1.0;

        return (longer.length - this.editDistance(longer, shorter)) / longer.length;
    }

    private editDistance(s1: string, s2: string): number {
        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();

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

    public clearCache(): void {
        this.cache.clear();
    }
}
