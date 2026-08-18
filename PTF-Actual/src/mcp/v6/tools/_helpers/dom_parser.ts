/**
 * dom_parser — extract interactive elements from an HTML string with a
 * stability-ranked locator set per element.
 *
 * Strategy:
 *  1. Try jsdom (lazy-loaded). If available we get real DOM traversal
 *     including <label for> resolution and nested container detection.
 *  2. Fall back to regex when jsdom isn't installed; the caller receives
 *     a warning so they know to install jsdom for higher fidelity.
 *
 * Stability score (0-10):
 *    data-testid → 10       (test-authored, most stable)
 *    kebab-case id, len>=4  → 8   (developer-authored, semantic)
 *    name           → 7
 *    aria-label     → 6
 *    label[for=id]  → 5
 *    placeholder    → 4
 *    role+text      → 3
 *    text (bare)    → 2
 *    css class     → 1
 *
 * IDs that look auto-generated (hash-like, contains digits+letters mixed,
 * short, or the framework signatures like `mat-input-<n>`, `radix-*`,
 * `mui-*`, `chakra-*`) are dropped so they don't get an inflated score.
 */

export interface CandidateLocator {
    /** The attribute that produced this locator, e.g. 'data-testid', 'id', 'aria-label', 'text', 'name', 'placeholder', 'label', 'role', 'css'. */
    kind: string;
    /** The raw value read from the DOM. */
    value: string;
    /** Suggested XPath expression using this attribute. */
    xpath: string;
    /** Suggested CSS selector using this attribute. */
    css: string;
    /** 0-10 stability score. */
    score: number;
}

export interface ExtractedElement {
    /** HTML tag (lowercased): input, button, a, select, textarea, or generic. */
    tag: string;
    /** For inputs: the value of the type= attribute (default: 'text'). */
    inputType?: string;
    /** Container region the element lives in: 'form', 'nav', 'main', 'dialog', 'header', 'footer', or 'body'. */
    containerRegion: string;
    /** Human-readable description used as the base for the property name. */
    description: string;
    /** All locators found for this element, ranked from most to least stable. */
    candidates: CandidateLocator[];
    /** The winning locator = candidates[0]. */
    primary: CandidateLocator;
    /** Up to N secondary locators from candidates[1..]. */
    alternatives: CandidateLocator[];
    /** Best score across all candidates. */
    stabilityScore: number;
}

export interface ParseResult {
    elements: ExtractedElement[];
    /** Distinct containerRegion values seen. */
    containers: string[];
    /** 'jsdom' when jsdom was loaded, 'regex' otherwise. */
    parseMethod: 'jsdom' | 'regex';
    warnings: string[];
}

// --- ID heuristics -------------------------------------------------------

const AUTO_ID_PATTERNS: RegExp[] = [
    /^mat-(input|autocomplete|slide-toggle|checkbox|radio|form-field)-\d+$/i,
    /^mat-\d+$/i,
    /^radix-\S+$/i,
    /^mui-\d+$/i,
    /^chakra-\S+$/i,
    /^headlessui-\S+$/i,
    /^:r[0-9a-z]+:$/i, // React useId
    /^ember\d+$/i,
    /^ext-\d+$/i,
    /^[a-f0-9]{8,}$/i,   // hex-only ≥ 8 chars
    /^\d+$/,             // purely numeric
];

function isKebabCase(s: string): boolean {
    return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(s);
}

function isProbablyAutoId(id: string): boolean {
    if (!id) return true;
    if (AUTO_ID_PATTERNS.some((p) => p.test(id))) return true;
    // very short or overwhelmingly digits
    if (id.length < 4) return true;
    const digits = id.replace(/\D/g, '').length;
    if (digits > id.length * 0.6) return true;
    return false;
}

// --- Scoring -------------------------------------------------------------

export function scoreForKind(kind: string, value: string): number {
    switch (kind) {
        case 'data-testid': return 10;
        case 'id':
            if (isProbablyAutoId(value)) return 0;
            return isKebabCase(value) ? 8 : 6;
        case 'name': return 7;
        case 'aria-label': return 6;
        case 'label': return 5;
        case 'placeholder': return 4;
        case 'role-text': return 3;
        case 'text': return 2;
        case 'css-class': return 1;
        default: return 0;
    }
}

// --- Description → property name -----------------------------------------

const RESERVED = new Set(['class', 'super', 'const', 'let', 'var', 'function', 'return', 'this', 'default', 'new']);

export function toCamelPropertyName(description: string, tag: string): string {
    const cleaned = description
        .replace(/[^a-zA-Z0-9\s_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return `${tag}Element`;
    const parts = cleaned.split(/[\s_-]+/).filter(Boolean);
    let name = parts[0].charAt(0).toLowerCase() + parts[0].slice(1);
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        name += p.charAt(0).toUpperCase() + p.slice(1);
    }
    // If we produced a bare reserved word, suffix with the tag.
    if (RESERVED.has(name) || name.length === 0) name = name + tag.charAt(0).toUpperCase() + tag.slice(1);
    if (/^[0-9]/.test(name)) name = 'f' + name;
    // cap length to keep property lines readable
    if (name.length > 60) name = name.slice(0, 60);
    return name;
}

// --- XPath / CSS builders -------------------------------------------------

function escXpathString(s: string): string {
    // XPath 1.0 has no escape for quotes — use concat() when both are present.
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    // Both quotes present — build a concat expression.
    const parts = s.split("'");
    const args: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        args.push(`'${parts[i]}'`);
        if (i < parts.length - 1) args.push('"\'"');
    }
    return `concat(${args.join(', ')})`;
}

function escCssAttrValue(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function locFor(kind: string, value: string, tag: string, extra?: { role?: string }): { xpath: string; css: string } {
    const vX = escXpathString(value);
    const vC = escCssAttrValue(value);
    switch (kind) {
        case 'data-testid':
            return { xpath: `//*[@data-testid=${vX}]`, css: `[data-testid="${vC}"]` };
        case 'id':
            return { xpath: `//*[@id=${vX}]`, css: `#${value.replace(/([^a-zA-Z0-9_\-])/g, '\\$1')}` };
        case 'name':
            return { xpath: `//${tag}[@name=${vX}]`, css: `${tag}[name="${vC}"]` };
        case 'aria-label':
            return { xpath: `//${tag}[@aria-label=${vX}]`, css: `${tag}[aria-label="${vC}"]` };
        case 'label':
            return { xpath: `//*[@id=(//label[normalize-space(.)=${vX}]/@for)]`, css: `label:has-text("${vC}") ~ ${tag}` };
        case 'placeholder':
            return { xpath: `//${tag}[@placeholder=${vX}]`, css: `${tag}[placeholder="${vC}"]` };
        case 'role-text': {
            const role = extra?.role || 'button';
            return { xpath: `//*[@role=${escXpathString(role)} and normalize-space(.)=${vX}]`, css: `[role="${role}"]:has-text("${vC}")` };
        }
        case 'text':
            return { xpath: `//${tag}[normalize-space(.)=${vX}]`, css: `${tag}:has-text("${vC}")` };
        case 'css-class':
            return { xpath: `//${tag}[contains(concat(' ',normalize-space(@class),' '), ${escXpathString(' ' + value + ' ')})]`, css: `${tag}.${value.replace(/\s+/g, '.')}` };
        default:
            return { xpath: `//${tag}`, css: tag };
    }
}

// --- Attribute extraction (shared jsdom + regex) --------------------------

interface RawElementAttrs {
    tag: string;
    inputType?: string;
    dataTestid?: string;
    id?: string;
    name?: string;
    ariaLabel?: string;
    placeholder?: string;
    role?: string;
    text?: string;
    labelText?: string;
    className?: string;
    containerRegion: string;
    /** If the element already has role="button", "link", etc. */
    detectedRole?: string;
}

function buildCandidatesFromRaw(r: RawElementAttrs): CandidateLocator[] {
    const c: CandidateLocator[] = [];
    const push = (kind: string, value: string, extra?: { role?: string }): void => {
        if (!value) return;
        const s = scoreForKind(kind, value);
        if (s <= 0) return;
        const { xpath, css } = locFor(kind, value, r.tag, extra);
        c.push({ kind, value, xpath, css, score: s });
    };
    push('data-testid', r.dataTestid ?? '');
    push('id', r.id ?? '');
    push('name', r.name ?? '');
    push('aria-label', r.ariaLabel ?? '');
    push('label', r.labelText ?? '');
    push('placeholder', r.placeholder ?? '');
    // Prefer role+text combo when both present (buttons / links)
    if (r.text && (r.detectedRole || r.tag === 'button' || r.tag === 'a')) {
        push('role-text', r.text.slice(0, 60), { role: r.detectedRole || (r.tag === 'a' ? 'link' : 'button') });
    }
    if (r.text) push('text', r.text.slice(0, 60));
    if (r.className) push('css-class', r.className.split(/\s+/).filter(Boolean).slice(0, 2).join(' '));
    // Rank
    c.sort((a, b) => b.score - a.score);
    return c;
}

function describeElement(r: RawElementAttrs): string {
    return (
        r.ariaLabel ||
        r.labelText ||
        r.placeholder ||
        r.text ||
        r.name ||
        r.id ||
        r.dataTestid ||
        `${r.tag}${r.inputType ? ' ' + r.inputType : ''}`
    ).trim();
}

// --- jsdom-backed parser -------------------------------------------------

interface JsdomModule { JSDOM: new (html: string, opts?: unknown) => { window: { document: unknown } } }

function tryLoadJsdom(): JsdomModule | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('jsdom') as JsdomModule;
    } catch {
        return null;
    }
}

const INTERACTIVE_SELECTORS = [
    'input', 'button', 'a[href]', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="menuitem"]', '[role="tab"]', '[role="option"]', '[role="switch"]', '[role="textbox"]', '[role="combobox"]',
];

function containerForNode(node: unknown, doc: unknown): string {
    // walk up until we find one of the known containers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let n: any = node;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ROOT: any = doc;
    while (n && n !== ROOT) {
        const tag = String(n.tagName || '').toLowerCase();
        if (tag === 'form') return 'form';
        if (tag === 'nav') return 'nav';
        if (tag === 'main') return 'main';
        if (tag === 'dialog') return 'dialog';
        if (tag === 'header') return 'header';
        if (tag === 'footer') return 'footer';
        if (tag === 'aside') return 'aside';
        const role = String(n.getAttribute?.('role') || '').toLowerCase();
        if (role === 'dialog' || role === 'form' || role === 'navigation' || role === 'main') return role === 'navigation' ? 'nav' : role;
        n = n.parentNode;
    }
    return 'body';
}

function parseWithJsdom(html: string, jsdom: JsdomModule): { elements: ExtractedElement[]; containers: Set<string>; warnings: string[] } {
    const warnings: string[] = [];
    const dom = new jsdom.JSDOM(html, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = (dom.window as unknown as { document: any }).document;
    const labelMap = new Map<string, string>(); // id -> label text
    const labels = doc.querySelectorAll('label[for]');
    for (const lbl of labels) {
        const forId = String(lbl.getAttribute('for') || '');
        if (!forId) continue;
        const text = String(lbl.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) labelMap.set(forId, text);
    }

    const nodes = doc.querySelectorAll(INTERACTIVE_SELECTORS.join(','));
    const elements: ExtractedElement[] = [];
    const containers = new Set<string>();
    const seenPrimary = new Set<string>();

    for (const node of nodes) {
        const tag = String(node.tagName || '').toLowerCase();
        // Skip hidden inputs and non-interactive input types
        if (tag === 'input') {
            const t = String(node.getAttribute('type') || 'text').toLowerCase();
            if (t === 'hidden') continue;
        }
        // Skip if aria-hidden=true or display:none via inline style
        if (String(node.getAttribute('aria-hidden') || '').toLowerCase() === 'true') continue;
        const style = String(node.getAttribute('style') || '');
        if (/display\s*:\s*none/i.test(style)) continue;

        const dataTestid = String(node.getAttribute('data-testid') || '') || undefined;
        const idAttr = String(node.getAttribute('id') || '') || undefined;
        const nameAttr = String(node.getAttribute('name') || '') || undefined;
        const ariaLabel = String(node.getAttribute('aria-label') || '') || undefined;
        const placeholder = String(node.getAttribute('placeholder') || '') || undefined;
        const detectedRole = String(node.getAttribute('role') || '') || undefined;
        const text = String(node.textContent || '').replace(/\s+/g, ' ').trim() || undefined;
        const className = String(node.getAttribute('class') || '') || undefined;
        const inputType = tag === 'input' ? String(node.getAttribute('type') || 'text').toLowerCase() : undefined;
        const labelText = idAttr ? labelMap.get(idAttr) : undefined;
        const containerRegion = containerForNode(node, doc);
        containers.add(containerRegion);

        const raw: RawElementAttrs = {
            tag, inputType, dataTestid, id: idAttr, name: nameAttr, ariaLabel, placeholder,
            role: detectedRole, text: text?.slice(0, 80), labelText, className,
            containerRegion, detectedRole,
        };
        const candidates = buildCandidatesFromRaw(raw);
        if (candidates.length === 0) continue;
        const primary = candidates[0];
        const dedupeKey = `${tag}|${primary.kind}|${primary.value}`;
        if (seenPrimary.has(dedupeKey)) continue;
        seenPrimary.add(dedupeKey);

        elements.push({
            tag,
            inputType,
            containerRegion,
            description: describeElement(raw),
            candidates,
            primary,
            alternatives: candidates.slice(1, 3),
            stabilityScore: primary.score,
        });
    }
    return { elements, containers, warnings };
}

// --- Regex fallback ------------------------------------------------------

function readAttr(attrs: string, name: string): string | undefined {
    const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const m = attrs.match(re);
    return m ? (m[1] ?? m[2]) : undefined;
}

function stripTags(s: string): string {
    return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseWithRegex(html: string): { elements: ExtractedElement[]; containers: Set<string>; warnings: string[] } {
    const warnings: string[] = ['jsdom not available — used regex fallback (label[for] and nested-container resolution are approximate).'];
    // Collect labels first
    const labelMap = new Map<string, string>();
    const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = labelRe.exec(html)) !== null) {
        const forId = readAttr(lm[1], 'for');
        const text = stripTags(lm[2]).slice(0, 120);
        if (forId && text) labelMap.set(forId, text);
    }

    // Approximate container by scanning open/close tags and pushing a stack.
    const containerStack: string[] = ['body'];
    const CONTAINER_TAGS = new Set(['form', 'nav', 'main', 'dialog', 'header', 'footer', 'aside']);
    const openCloseRe = /<(\/?)(form|nav|main|dialog|header|footer|aside|input|button|a|select|textarea)\b([^>]*)>/gi;

    const elements: ExtractedElement[] = [];
    const containers = new Set<string>();
    const seenPrimary = new Set<string>();

    let m: RegExpExecArray | null;
    while ((m = openCloseRe.exec(html)) !== null) {
        const isClose = m[1] === '/';
        const tag = m[2].toLowerCase();
        const attrs = m[3] || '';

        if (CONTAINER_TAGS.has(tag)) {
            if (isClose) {
                // pop matching container
                for (let i = containerStack.length - 1; i >= 0; i--) {
                    if (containerStack[i] === tag) { containerStack.splice(i, 1); break; }
                }
            } else {
                // Self-closing containers are extremely rare; treat as push.
                containerStack.push(tag);
            }
            continue;
        }
        if (isClose) continue; // element close tags don't produce a new element

        // input/button/a/select/textarea → element
        const inputType = tag === 'input' ? (readAttr(attrs, 'type') || 'text').toLowerCase() : undefined;
        if (tag === 'input' && inputType === 'hidden') continue;
        const dataTestid = readAttr(attrs, 'data-testid');
        const idAttr = readAttr(attrs, 'id');
        const nameAttr = readAttr(attrs, 'name');
        const ariaLabel = readAttr(attrs, 'aria-label');
        const placeholder = readAttr(attrs, 'placeholder');
        const detectedRole = readAttr(attrs, 'role');
        const className = readAttr(attrs, 'class');

        // Text content for anchors + buttons only (need close tag lookahead)
        let text: string | undefined;
        if (tag === 'a' || tag === 'button') {
            const closeRe = new RegExp(`<\\/${tag}\\s*>`, 'i');
            const rest = html.slice(openCloseRe.lastIndex);
            const closeMatch = closeRe.exec(rest);
            if (closeMatch) {
                text = stripTags(rest.slice(0, closeMatch.index)).slice(0, 80);
            }
        }

        const labelText = idAttr ? labelMap.get(idAttr) : undefined;
        const containerRegion = containerStack[containerStack.length - 1] === 'navigation' ? 'nav' : containerStack[containerStack.length - 1];
        containers.add(containerRegion);

        const raw: RawElementAttrs = {
            tag, inputType, dataTestid, id: idAttr, name: nameAttr, ariaLabel, placeholder,
            role: detectedRole, text, labelText, className, containerRegion, detectedRole,
        };
        const candidates = buildCandidatesFromRaw(raw);
        if (candidates.length === 0) continue;
        const primary = candidates[0];
        const dedupeKey = `${tag}|${primary.kind}|${primary.value}`;
        if (seenPrimary.has(dedupeKey)) continue;
        seenPrimary.add(dedupeKey);

        elements.push({
            tag, inputType, containerRegion,
            description: describeElement(raw),
            candidates,
            primary,
            alternatives: candidates.slice(1, 3),
            stabilityScore: primary.score,
        });
    }
    return { elements, containers, warnings };
}

export function parseInteractiveDom(html: string): ParseResult {
    if (!html || html.trim().length === 0) {
        return { elements: [], containers: [], parseMethod: 'regex', warnings: ['empty html'] };
    }
    const jsdom = tryLoadJsdom();
    if (jsdom) {
        try {
            const { elements, containers, warnings } = parseWithJsdom(html, jsdom);
            return { elements, containers: Array.from(containers).sort(), parseMethod: 'jsdom', warnings };
        } catch (e) {
            const warnings = [`jsdom parse failed: ${(e as Error).message} — falling back to regex.`];
            const regex = parseWithRegex(html);
            return { elements: regex.elements, containers: Array.from(regex.containers).sort(), parseMethod: 'regex', warnings: warnings.concat(regex.warnings) };
        }
    }
    const regex = parseWithRegex(html);
    return { elements: regex.elements, containers: Array.from(regex.containers).sort(), parseMethod: 'regex', warnings: regex.warnings };
}

export type ResolverConfidence = 'high' | 'medium' | 'low';
export interface ResolveResult { resolves: boolean; matchCount: number; method: 'jsdom' | 'unknown'; resolverConfidence: ResolverConfidence; warning?: string }

// Lazy-loaded reference to the optional `xpath` npm package. jsdom does not
// expose native `document.evaluate` at the time of writing — the `xpath` package
// evaluates XPath 1.0 against the jsdom document, restoring high-confidence
// resolution for arbitrary xpaths without pulling a mandatory dependency in.
type XPathPkg = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: (expr: string, doc: any) => unknown[];
};
let _xpathPkgMemo: XPathPkg | null | undefined;
function tryLoadXpathPackage(): XPathPkg | null {
    if (_xpathPkgMemo !== undefined) return _xpathPkgMemo;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _xpathPkgMemo = require('xpath') as XPathPkg;
    } catch {
        _xpathPkgMemo = null;
    }
    return _xpathPkgMemo;
}

/**
 * Given an xpath, resolve it against an HTML document. jsdom has no native
 * `document.evaluate`, so we try (in order):
 *   1. The optional `xpath` npm package — HIGH confidence when installed.
 *   2. jsdom's own XPathEvaluator when it happens to be exposed — HIGH confidence.
 *   3. A regex fallback that maps a small set of common xpath shapes to
 *      querySelector — MEDIUM confidence; misses complex xpaths (returned as
 *      resolves:false with resolverConfidence:'low').
 */
export function tryResolveLocator(html: string, xpath: string): ResolveResult {
    const jsdom = tryLoadJsdom();
    if (!jsdom) return { resolves: false, matchCount: 0, method: 'unknown', resolverConfidence: 'low', warning: 'jsdom-missing' };
    try {
        const dom = new jsdom.JSDOM(html);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc: any = (dom.window as unknown as { document: any }).document;
        // 1. xpath npm package (preferred).
        const xpathPkg = tryLoadXpathPackage();
        if (xpathPkg) {
            try {
                const nodes = xpathPkg.select(xpath, doc);
                const count = Array.isArray(nodes) ? nodes.length : 0;
                return { resolves: count > 0, matchCount: count, method: 'jsdom', resolverConfidence: 'high' };
            } catch (e) {
                // Fall through to the next strategy — an xpath the package rejects
                // may still be handled by the regex fallback (or genuinely be invalid).
                void e;
            }
        }
        // 2. jsdom native XPathEvaluator (rarely exposed but cheap to try).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const evaluator = (dom.window as any).XPathEvaluator ? new (dom.window as any).XPathEvaluator() : null;
        if (evaluator && typeof doc.evaluate === 'function') {
            try {
                const result = doc.evaluate(xpath, doc, null, 7, null);
                const count = Number(result.snapshotLength || 0);
                return { resolves: count > 0, matchCount: count, method: 'jsdom', resolverConfidence: 'high' };
            } catch {
                // Continue to regex fallback.
            }
        }
        // 3. Regex fallback — cover the shapes that show up in generated page objects.
        const regexResult = xpathToCssFallback(xpath);
        if (regexResult) {
            try {
                const nodes = doc.querySelectorAll(regexResult.selector);
                return {
                    resolves: nodes.length > 0, matchCount: nodes.length,
                    method: 'jsdom', resolverConfidence: 'medium',
                    warning: 'xpath-package-missing - using regex-to-css fallback',
                };
            } catch {
                // querySelector rejected — treat as unresolved, low confidence.
            }
        }
        return {
            resolves: false, matchCount: 0, method: 'jsdom',
            resolverConfidence: 'low',
            warning: xpathPkg ? undefined : 'xpath-package-missing - install the "xpath" npm package for high-confidence resolution of arbitrary xpaths',
        };
    } catch {
        return { resolves: false, matchCount: 0, method: 'unknown', resolverConfidence: 'low' };
    }
}

/**
 * Best-effort xpath → CSS translation for the small set of shapes that show up
 * in generated page objects. Returns null for anything unsupported so the caller
 * can flag the resolution as low-confidence rather than a false-negative.
 */
function xpathToCssFallback(xpath: string): { selector: string } | null {
    if (!xpath) return null;
    // //*[@id='x']
    let m = /^\/\/\*\[@id=['"]([^'"]+)['"]\]$/.exec(xpath);
    if (m) return { selector: `#${cssEscapeId(m[1])}` };
    // //tag[@attr='v']
    m = /^\/\/(\w+)\[@([\w-]+)=['"]([^'"]+)['"]\]$/.exec(xpath);
    if (m) return { selector: `${m[1]}[${m[2]}="${m[3].replace(/"/g, '\\"')}"]` };
    // //tag[contains(@attr, 'v')]
    m = /^\/\/(\w+)\[contains\(@([\w-]+),\s*['"]([^'"]+)['"]\)\]$/.exec(xpath);
    if (m) return { selector: `${m[1]}[${m[2]}*="${m[3].replace(/"/g, '\\"')}"]` };
    // //*[@id='...']//descendant::tag
    m = /^\/\/\*\[@id=['"]([^'"]+)['"]\]\/\/(?:descendant::)?(\w+)$/.exec(xpath);
    if (m) return { selector: `#${cssEscapeId(m[1])} ${m[2]}` };
    // //tag[normalize-space(text())='v']  → tag (structural only; :contains isn't standard CSS but jsdom accepts nothing text-based). Fall back to just tag[attr search on text isn't possible in querySelector, so degrade to plain tag].
    m = /^\/\/(\w+)\[normalize-space\((?:text\(\))?\)=['"]([^'"]+)['"]\]$/.exec(xpath);
    if (m) {
        // Cannot do text= via querySelector — return a shape that at least
        // verifies the tag is present so we don't false-negative a resolvable page.
        return { selector: m[1] };
    }
    // //tag  (bare)
    m = /^\/\/(\w+)$/.exec(xpath);
    if (m) return { selector: m[1] };
    return null;
}

function cssEscapeId(id: string): string {
    return id.replace(/([^a-zA-Z0-9_\-])/g, '\\$1');
}

/**
 * Given a CSS selector, resolve it against an HTML document via jsdom's native
 * querySelectorAll. CSS is supported first-class by jsdom, so this is always a
 * high-confidence check.
 */
export function tryResolveCss(html: string, cssSelector: string): ResolveResult {
    const jsdom = tryLoadJsdom();
    if (!jsdom) return { resolves: false, matchCount: 0, method: 'unknown', resolverConfidence: 'low', warning: 'jsdom-missing' };
    try {
        const dom = new jsdom.JSDOM(html);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc: any = (dom.window as unknown as { document: any }).document;
        try {
            const nodes = doc.querySelectorAll(cssSelector);
            return { resolves: nodes.length > 0, matchCount: nodes.length, method: 'jsdom', resolverConfidence: 'high' };
        } catch {
            return { resolves: false, matchCount: 0, method: 'jsdom', resolverConfidence: 'low', warning: 'invalid-css-selector' };
        }
    } catch {
        return { resolves: false, matchCount: 0, method: 'unknown', resolverConfidence: 'low' };
    }
}

/**
 * Classify a locator string into `xpath` or `css`. XPath starts with `/`,
 * everything else — `#id`, `.class`, `[data-testid=x]`, `>` combinators, and
 * plain tag names without a `/` — is treated as CSS.
 */
export function detectLocatorKind(locator: string): 'xpath' | 'css' {
    const s = (locator || '').trim();
    if (s.startsWith('/')) return 'xpath';
    return 'css';
}

/**
 * Uniform locator resolution — dispatches to `tryResolveLocator` for xpath,
 * `tryResolveCss` for CSS. Use this from callers that classify a mixed list
 * of primary + alternative locators.
 */
export function tryResolveAny(html: string, locator: string): ResolveResult {
    return detectLocatorKind(locator) === 'xpath'
        ? tryResolveLocator(html, locator)
        : tryResolveCss(html, locator);
}

/** Render a decorator block for one extracted element. Deterministic — same input → same output. */
export function buildDecoratorBlock(el: ExtractedElement, propertyName: string, opts?: { selfHeal?: boolean; indent?: string }): string {
    const indent = opts?.indent ?? '    ';
    const selfHeal = opts?.selfHeal !== false;
    const alt = el.alternatives.map((a) => `'${a.xpath.replace(/'/g, "\\'")}'`);
    const lines: string[] = [];
    lines.push(`${indent}@CSGetElement({`);
    lines.push(`${indent}    xpath: '${el.primary.xpath.replace(/'/g, "\\'")}',`);
    if (el.primary.css) lines.push(`${indent}    css: '${el.primary.css.replace(/'/g, "\\'")}',`);
    lines.push(`${indent}    description: '${el.description.replace(/'/g, "\\'").slice(0, 100)}',`);
    lines.push(`${indent}    waitForVisible: true,`);
    lines.push(`${indent}    selfHeal: ${selfHeal},`);
    lines.push(`${indent}    alternativeLocators: [${alt.join(', ')}],`);
    lines.push(`${indent}})`);
    lines.push(`${indent}public ${propertyName}!: CSWebElement;`);
    return lines.join('\n');
}
