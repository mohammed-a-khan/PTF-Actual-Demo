/**
 * CSElementFingerprint - Multi-Signal Element Fingerprinting with LCS Self-Healing
 *
 * Captures 30+ attributes per matched element and stores fingerprints
 * for cross-run self-healing. When primary locators fail, uses Weighted
 * Longest Common Subsequence (LCS) algorithm to find the closest match
 * in the current DOM.
 *
 * Weight hierarchy: text content (highest) > aria-label > id > name > class > position (lowest)
 *
 * Zero external dependencies — pure TypeScript + Playwright APIs.
 *
 * @module ai/step-engine
 */

import { Page, Frame, Locator } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';
import { MatchedElement } from './CSAIStepTypes';

/** Complete fingerprint of a matched element */
export interface ElementFingerprint {
    // Identity attributes
    id: string;
    name: string;
    className: string;
    tagName: string;

    // Accessible attributes
    ariaLabel: string;
    ariaRole: string;
    ariaDescribedBy: string;
    title: string;
    alt: string;
    placeholder: string;

    // Content
    textContent: string;
    innerText: string;
    value: string;

    // Semantic
    href: string;
    type: string;
    for: string;

    // Data attributes (first 10)
    dataAttributes: Record<string, string>;

    // DOM context
    parentTag: string;
    parentId: string;
    parentClass: string;
    siblingText: string;
    domPath: string;

    // Position & size
    x: number;
    y: number;
    width: number;
    height: number;

    // Metadata
    pageUrl: string;
    instruction: string;
    matchMethod: string;
    matchConfidence: number;
    capturedAt: number;
}

/** Stored fingerprint with lookup key */
export interface StoredFingerprint {
    key: string;
    fingerprint: ElementFingerprint;
    successCount: number;
    lastUsed: number;
}

/** Attribute weights for LCS scoring */
const ATTRIBUTE_WEIGHTS: Record<string, number> = {
    textContent: 1.0,
    innerText: 0.95,
    ariaLabel: 0.9,
    id: 0.85,
    name: 0.8,
    placeholder: 0.75,
    title: 0.7,
    alt: 0.7,
    ariaRole: 0.65,
    className: 0.5,
    tagName: 0.5,
    type: 0.45,
    href: 0.4,
    parentTag: 0.3,
    parentId: 0.3,
    domPath: 0.25,
    x: 0.1,
    y: 0.1,
    width: 0.1,
    height: 0.1
};

export class CSElementFingerprint {
    private static instance: CSElementFingerprint;

    private constructor() {}

    public static getInstance(): CSElementFingerprint {
        if (!CSElementFingerprint.instance) {
            CSElementFingerprint.instance = new CSElementFingerprint();
        }
        return CSElementFingerprint.instance;
    }

    /**
     * Capture a full fingerprint of a matched element.
     *
     * @param locator - Playwright Locator for the element
     * @param pageUrl - Current page URL
     * @param instruction - The instruction that led to this match
     * @param matchMethod - How the element was matched
     * @param matchConfidence - Confidence score of the match
     * @returns ElementFingerprint
     */
    public async capture(
        locator: Locator,
        pageUrl: string,
        instruction: string,
        matchMethod: string,
        matchConfidence: number
    ): Promise<ElementFingerprint | null> {
        try {
            const fp = await locator.evaluate((el: Element) => {
                const htmlEl = el as HTMLElement;
                const inputEl = el as HTMLInputElement;
                const rect = el.getBoundingClientRect();

                // Build DOM path
                const domPath: string[] = [];
                let current: Element | null = el;
                while (current && current !== document.documentElement) {
                    const tag = current.tagName.toLowerCase();
                    const id = current.id ? `#${current.id}` : '';
                    domPath.unshift(`${tag}${id}`);
                    current = current.parentElement;
                }

                // Collect data-* attributes (first 10)
                const dataAttributes: Record<string, string> = {};
                let dataCount = 0;
                for (const attr of Array.from(el.attributes)) {
                    if (attr.name.startsWith('data-') && dataCount < 10) {
                        dataAttributes[attr.name] = attr.value.substring(0, 100);
                        dataCount++;
                    }
                }

                // Get sibling text for context
                const parent = el.parentElement;
                let siblingText = '';
                if (parent) {
                    const siblings = Array.from(parent.children);
                    siblingText = siblings
                        .filter(s => s !== el)
                        .map(s => (s as HTMLElement).innerText?.substring(0, 50) || '')
                        .filter(t => t.length > 0)
                        .slice(0, 3)
                        .join(' | ');
                }

                return {
                    id: el.id || '',
                    name: el.getAttribute('name') || '',
                    className: el.className || '',
                    tagName: el.tagName.toLowerCase(),
                    ariaLabel: el.getAttribute('aria-label') || '',
                    ariaRole: el.getAttribute('role') || '',
                    ariaDescribedBy: el.getAttribute('aria-describedby') || '',
                    title: el.getAttribute('title') || '',
                    alt: el.getAttribute('alt') || '',
                    placeholder: el.getAttribute('placeholder') || '',
                    textContent: (htmlEl.textContent || '').trim().substring(0, 200),
                    innerText: (htmlEl.innerText || '').trim().substring(0, 200),
                    value: inputEl.value || '',
                    href: el.getAttribute('href') || '',
                    type: el.getAttribute('type') || '',
                    for: el.getAttribute('for') || '',
                    dataAttributes,
                    parentTag: parent?.tagName.toLowerCase() || '',
                    parentId: parent?.id || '',
                    parentClass: parent?.className || '',
                    siblingText,
                    domPath: domPath.join(' > '),
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                };
            });

            return {
                ...fp,
                pageUrl,
                instruction,
                matchMethod,
                matchConfidence,
                capturedAt: Date.now()
            };
        } catch (error: any) {
            CSReporter.debug(`CSElementFingerprint: Failed to capture fingerprint: ${error.message}`);
            return null;
        }
    }

    /**
     * Attempt self-healing by finding the best match in the current DOM
     * using Weighted LCS comparison against a stored fingerprint.
     *
     * @param page - Playwright Page or Frame
     * @param storedFingerprint - The fingerprint of the element we're looking for
     * @param minScore - Minimum LCS score to accept (default: 0.5)
     * @returns MatchedElement if a good match is found, null otherwise
     */
    public async selfHeal(
        page: Page | Frame,
        storedFingerprint: ElementFingerprint,
        minScore: number = 0.5
    ): Promise<MatchedElement | null> {
        try {
            // Collect candidate elements from the page
            const candidates = await this.collectCandidateFingerprints(page, storedFingerprint);

            if (candidates.length === 0) {
                CSReporter.debug('CSElementFingerprint: No candidate elements found for self-healing');
                return null;
            }

            // Score each candidate against the stored fingerprint
            let bestScore = 0;
            let bestIndex = -1;

            for (let i = 0; i < candidates.length; i++) {
                const score = this.computeWeightedLCS(storedFingerprint, candidates[i].fingerprint);
                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                }
            }

            if (bestIndex >= 0 && bestScore >= minScore) {
                const best = candidates[bestIndex];
                CSReporter.info(
                    `CSElementFingerprint: Self-healed element (score: ${bestScore.toFixed(2)}, ` +
                    `tag: ${best.fingerprint.tagName}, text: "${(best.fingerprint.textContent || '').substring(0, 30)}")`
                );

                return {
                    locator: best.locator,
                    confidence: bestScore * 0.8, // Slightly reduce confidence for healed matches
                    method: 'pattern-matcher',
                    description: `Self-healed via fingerprint (score: ${bestScore.toFixed(2)})`,
                    alternatives: []
                };
            }

            CSReporter.debug(`CSElementFingerprint: Best self-heal score ${bestScore.toFixed(2)} below threshold ${minScore}`);
            return null;
        } catch (error: any) {
            CSReporter.debug(`CSElementFingerprint: Self-healing failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Collect candidate element fingerprints from the page based on the stored fingerprint's tag.
     */
    private async collectCandidateFingerprints(
        page: Page | Frame,
        reference: ElementFingerprint
    ): Promise<{ locator: Locator; fingerprint: Partial<ElementFingerprint> }[]> {
        const candidates: { locator: Locator; fingerprint: Partial<ElementFingerprint> }[] = [];

        // Search for elements of the same tag type, or interactive elements
        const searchTags = [reference.tagName];
        if (!['input', 'button', 'a', 'select', 'textarea'].includes(reference.tagName)) {
            searchTags.push('*'); // Fallback to all elements
        }

        for (const tag of searchTags) {
            try {
                const locator = page.locator(tag === '*' ? 'input, button, a, select, textarea, [role]' : tag);
                const count = await locator.count();
                const limit = Math.min(count, 50); // Cap at 50 candidates for performance

                for (let i = 0; i < limit; i++) {
                    try {
                        const el = locator.nth(i);
                        const fp = await el.evaluate((el: Element) => {
                            const htmlEl = el as HTMLElement;
                            const inputEl = el as HTMLInputElement;
                            return {
                                id: el.id || '',
                                name: el.getAttribute('name') || '',
                                className: el.className || '',
                                tagName: el.tagName.toLowerCase(),
                                ariaLabel: el.getAttribute('aria-label') || '',
                                ariaRole: el.getAttribute('role') || '',
                                title: el.getAttribute('title') || '',
                                alt: el.getAttribute('alt') || '',
                                placeholder: el.getAttribute('placeholder') || '',
                                textContent: (htmlEl.textContent || '').trim().substring(0, 200),
                                innerText: (htmlEl.innerText || '').trim().substring(0, 200),
                                type: el.getAttribute('type') || '',
                                href: el.getAttribute('href') || '',
                                parentTag: el.parentElement?.tagName.toLowerCase() || ''
                            };
                        });

                        candidates.push({ locator: el, fingerprint: fp });
                    } catch {
                        // Element may have become stale
                    }
                }

                if (candidates.length >= 20) break; // Enough candidates
            } catch {
                // Selector failed
            }
        }

        return candidates;
    }

    /**
     * Compute Weighted LCS score between a stored fingerprint and a candidate.
     *
     * Uses weighted attribute comparison where each attribute contributes
     * proportionally to its reliability for element identification.
     */
    public computeWeightedLCS(
        stored: ElementFingerprint,
        candidate: Partial<ElementFingerprint>
    ): number {
        let totalWeight = 0;
        let matchScore = 0;

        for (const [attr, weight] of Object.entries(ATTRIBUTE_WEIGHTS)) {
            const storedVal = String((stored as any)[attr] || '').toLowerCase().trim();
            const candidateVal = String((candidate as any)[attr] || '').toLowerCase().trim();

            if (!storedVal && !candidateVal) continue; // Both empty — skip
            if (!storedVal || !candidateVal) {
                totalWeight += weight;
                continue; // One is empty — attribute missing, counts against score
            }

            totalWeight += weight;

            // For numeric position attributes, use proximity scoring
            if (['x', 'y', 'width', 'height'].includes(attr)) {
                const a = parseFloat(storedVal);
                const b = parseFloat(candidateVal);
                if (!isNaN(a) && !isNaN(b)) {
                    const diff = Math.abs(a - b);
                    const maxVal = Math.max(Math.abs(a), Math.abs(b), 1);
                    matchScore += weight * Math.max(0, 1 - diff / maxVal);
                }
                continue;
            }

            // For string attributes, use LCS ratio
            if (storedVal === candidateVal) {
                matchScore += weight;
            } else {
                const lcsLen = this.lcsLength(storedVal, candidateVal);
                const maxLen = Math.max(storedVal.length, candidateVal.length);
                const ratio = maxLen > 0 ? lcsLen / maxLen : 0;
                matchScore += weight * ratio;
            }
        }

        return totalWeight > 0 ? matchScore / totalWeight : 0;
    }

    /**
     * Compute Longest Common Subsequence length between two strings.
     * Uses space-optimized DP (two rows only).
     */
    private lcsLength(s1: string, s2: string): number {
        const m = s1.length;
        const n = s2.length;

        if (m === 0 || n === 0) return 0;

        let prev = new Array(n + 1).fill(0);
        let curr = new Array(n + 1).fill(0);

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (s1[i - 1] === s2[j - 1]) {
                    curr[j] = prev[j - 1] + 1;
                } else {
                    curr[j] = Math.max(prev[j], curr[j - 1]);
                }
            }
            [prev, curr] = [curr, prev];
            curr.fill(0);
        }

        return prev[n];
    }

    /**
     * Generate a cache key from a page URL and instruction.
     */
    public generateKey(pageUrl: string, instruction: string): string {
        // Normalize URL by removing query params and hash
        const url = pageUrl.split('?')[0].split('#')[0];
        // Normalize instruction
        const inst = instruction.toLowerCase().trim();
        return `${url}::${inst}`;
    }
}
