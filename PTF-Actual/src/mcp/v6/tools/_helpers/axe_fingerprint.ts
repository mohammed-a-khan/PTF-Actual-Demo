/**
 * Deterministic fingerprints for axe-core violations.
 *
 * Axe emits one violation object per rule; each violation carries a `nodes[]`
 * array — one entry per DOM node where the violation occurs. Same page reload
 * = same node list. Across runs / dynamic content, we want ONE issue per
 * (ruleId, normalized selector, tag+class shape). Node index, ephemeral
 * attribute values, whitespace and generated ids are stripped.
 *
 * Stability property (checked by smoke test): same violation on page reload
 * produces the same fingerprint.
 */

import { createHash } from 'crypto';

export interface AxeNode {
    target?: unknown;                       // ARRAY of selectors typically — one per DOM ancestor
    html?: string;                          // raw HTML snippet of the violating node
    failureSummary?: string;
    impact?: string;
    any?: unknown[];
    all?: unknown[];
    none?: unknown[];
    xpath?: unknown;
}

export interface AxeViolation {
    id: string;                              // rule id — e.g. "color-contrast"
    impact?: 'minor' | 'moderate' | 'serious' | 'critical';
    tags?: string[];
    description?: string;
    help?: string;
    helpUrl?: string;
    nodes?: AxeNode[];
}

export interface AxeNodeFingerprint {
    fingerprint: string;
    ruleId: string;
    impact: string;
    wcagLevel: 'A' | 'AA' | 'AAA' | 'best-practice' | 'unknown';
    normalizedTarget: string;
    tagShape: string;                        // e.g. "button.btn.btn-primary"
    help: string;
    helpUrl: string;
    firstHtml: string;
}

// Attributes whose values change per render or per user session and MUST be
// stripped before fingerprinting. Keys are matched case-insensitive.
const VOLATILE_ATTRS = new Set(['id', 'aria-labelledby', 'aria-describedby', 'data-testid', 'data-reactid', 'for']);

function normalizeSelector(sel: string): string {
    // 1) Drop nth-of-type / nth-child indexes.
    let out = sel.replace(/:nth-(?:of-type|child)\(\d+\)/g, ':nth(N)');
    // 2) Drop ordinal [i] indexes used by axe when many matches exist.
    out = out.replace(/\[\d+\]/g, '[N]');
    // 3) Trim generated id fragments: #foo-a1b2c3d4 → #foo-<HASH>
    out = out.replace(/#([A-Za-z_][\w-]*?)-[0-9a-f]{6,}/g, '#$1-<HASH>');
    // 4) Numeric attribute suffixes: data-v-123 → data-v-<N>
    out = out.replace(/(\W)([a-zA-Z_-]+)-\d{2,}/g, '$1$2-<N>');
    out = out.replace(/\s+/g, ' ').trim();
    return out;
}

function normalizeTargetArray(target: unknown): string {
    if (!target) return '';
    // Axe target is an array of selectors: each entry may itself be an array (shadow roots).
    // Flatten one level, then take the last (most specific).
    const flat: string[] = [];
    const walk = (v: unknown): void => {
        if (typeof v === 'string') flat.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
    };
    walk(target);
    if (flat.length === 0) return '';
    const last = flat[flat.length - 1];
    return normalizeSelector(last);
}

function extractTagShape(html: string | undefined): string {
    if (!html || typeof html !== 'string') return '';
    // Match the OPENING tag only: <tag attr="…" …>
    const m = html.match(/^\s*<([a-zA-Z][\w-]*)([^>]*)>/);
    if (!m) return '';
    const tag = m[1].toLowerCase();
    const attrText = m[2] || '';
    // Parse attrs — pick class (as sorted set) and role only.
    const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let match;
    let classAttr = '';
    let roleAttr = '';
    let typeAttr = '';
    while ((match = attrRe.exec(attrText)) !== null) {
        const name = match[1].toLowerCase();
        const val = match[3] ?? match[4] ?? match[5] ?? '';
        if (VOLATILE_ATTRS.has(name)) continue;
        if (name === 'class') classAttr = val.split(/\s+/).filter(Boolean).sort().join('.');
        else if (name === 'role') roleAttr = val.trim();
        else if (name === 'type') typeAttr = val.trim();
    }
    const parts = [tag];
    if (classAttr) parts.push('.' + classAttr);
    if (roleAttr) parts.push(`[role=${roleAttr}]`);
    if (typeAttr) parts.push(`[type=${typeAttr}]`);
    return parts.join('');
}

function pickWcagLevel(tags: string[] | undefined): AxeNodeFingerprint['wcagLevel'] {
    if (!tags || tags.length === 0) return 'unknown';
    const lower = tags.map((t) => String(t).toLowerCase());
    if (lower.includes('wcag2a') || lower.includes('wcag21a')) {
        if (lower.some((t) => t === 'wcag2aa' || t === 'wcag21aa')) return 'AA';
        return 'A';
    }
    if (lower.some((t) => t === 'wcag2aa' || t === 'wcag21aa')) return 'AA';
    if (lower.some((t) => t === 'wcag2aaa' || t === 'wcag21aaa')) return 'AAA';
    if (lower.includes('best-practice')) return 'best-practice';
    return 'unknown';
}

export function fingerprintNode(rule: AxeViolation, node: AxeNode): AxeNodeFingerprint {
    const normalizedTarget = normalizeTargetArray(node.target);
    const tagShape = extractTagShape(typeof node.html === 'string' ? node.html : '');
    const canonical = `rule=${rule.id}|target=${normalizedTarget}|shape=${tagShape}`;
    const fingerprint = createHash('sha1').update(canonical).digest('hex');
    return {
        fingerprint,
        ruleId: rule.id,
        impact: String(node.impact || rule.impact || 'unknown'),
        wcagLevel: pickWcagLevel(rule.tags),
        normalizedTarget,
        tagShape,
        help: String(rule.help || ''),
        helpUrl: String(rule.helpUrl || ''),
        firstHtml: typeof node.html === 'string' ? node.html.slice(0, 500) : '',
    };
}

export interface DedupedIssue extends AxeNodeFingerprint {
    occurrences: number;
    /** Distinct pages / URLs this fingerprint appeared on. */
    pages: string[];
}

export function dedupeViolations(violations: AxeViolation[], pageUrl?: string): DedupedIssue[] {
    const byPrint = new Map<string, DedupedIssue>();
    for (const v of violations) {
        for (const n of v.nodes || []) {
            const fp = fingerprintNode(v, n);
            const existing = byPrint.get(fp.fingerprint);
            if (existing) {
                existing.occurrences++;
                if (pageUrl && !existing.pages.includes(pageUrl)) existing.pages.push(pageUrl);
            } else {
                byPrint.set(fp.fingerprint, {
                    ...fp,
                    occurrences: 1,
                    pages: pageUrl ? [pageUrl] : [],
                });
            }
        }
    }
    return Array.from(byPrint.values());
}
