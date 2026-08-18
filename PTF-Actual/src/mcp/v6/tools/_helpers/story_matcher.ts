/**
 * Token-overlap matching for grounding acceptance criteria (ACs) to source-code
 * facts. Not an ML embedding — just deterministic set overlap with a domain-
 * noun boost. Deliberate because:
 *   (a) Copilot is the LLM downstream; we don't need another one here.
 *   (b) Deterministic scoring is auditable — the user can trace WHY an AC
 *       matched a screen without running the tool again.
 *
 * Scoring
 * -------
 * Tokens = lowercased word-stems from the AC text (minus stopwords).
 * A candidate (endpoint path, screen name, DTO class) is tokenized the same way.
 * Jaccard = |A ∩ B| / |A ∪ B|.
 * Domain-noun boost: any token that appears in the DOMAIN_NOUNS set doubles its
 * contribution to |A ∩ B|.
 * Exact-verb match (create/save/delete/update/search/…) further boosts endpoint
 * matches whose verb agrees (POST↔create, DELETE↔delete, …).
 *
 * Confidence
 * ----------
 * high    → jaccard ≥ 0.35 or verb+noun both matched
 * medium  → jaccard ≥ 0.20
 * low     → jaccard ≥ 0.10
 * unmatched → below 0.10
 */

export interface Scored<T> {
    item: T;
    score: number;
    matchedTokens: string[];
    reason: string;
}

const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
    'at', 'by', 'for', 'with', 'as', 'if', 'then', 'and', 'or', 'but', 'not',
    'no', 'so', 'do', 'does', 'did', 'i', 'we', 'you', 'they', 'he', 'she',
    'it', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their',
    'user', 'users', 'given', 'when', 'should', 'must', 'able', 'can',
    'ac', 'have', 'has', 'had', 'from', 'into', 'up', 'down', 'out', 'over',
    'through', 'about', 'against', 'between', 'during', 'without', 'within',
    'form', 'page', 'button', 'link', 'field', 'label', 'text', 'value',
    'entry', 'row', 'column', 'system', 'application',
]);

const DOMAIN_NOUNS = new Set([
    // Generic business domain words the grounding layer treats as high-signal.
    'employee', 'employees', 'account', 'accounts', 'order', 'orders',
    'invoice', 'invoices', 'customer', 'customers', 'product', 'products',
    'deal', 'series', 'approval', 'authorization', 'authorisation',
    'user', 'role', 'permission', 'organization', 'organisation',
    'address', 'contact', 'department', 'position', 'title', 'salary',
    'attachment', 'document', 'file', 'upload', 'download',
    'search', 'filter', 'export', 'import', 'report', 'audit',
    'login', 'logout', 'password', 'credential',
]);

const VERB_TO_HTTP: Record<string, string[]> = {
    create: ['POST'],
    add: ['POST'],
    submit: ['POST'],
    register: ['POST'],
    save: ['POST', 'PUT'],
    update: ['PUT', 'PATCH', 'POST'],
    edit: ['PUT', 'PATCH', 'POST'],
    modify: ['PUT', 'PATCH'],
    delete: ['DELETE'],
    remove: ['DELETE'],
    view: ['GET'],
    read: ['GET'],
    get: ['GET'],
    list: ['GET'],
    search: ['GET'],
    fetch: ['GET'],
    approve: ['POST', 'PUT'],
    cancel: ['DELETE', 'POST'],
    reject: ['POST'],
    upload: ['POST'],
    download: ['GET'],
};

export function tokenize(text: string): string[] {
    if (!text) return [];
    const raw = text.toLowerCase().replace(/[^a-z0-9\s/]/g, ' ');
    const tokens = raw.split(/[\s/]+/).map((t) => t.trim()).filter(Boolean);
    return tokens.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Split camelCase / snake_case / paths into constituent tokens.
 */
export function splitIdentifier(id: string): string[] {
    if (!id) return [];
    const withSpaces = id
        .replace(/[/{}]+/g, ' ')
        .replace(/[_\-.]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return tokenize(withSpaces);
}

/**
 * Compute weighted jaccard where domain nouns count double in intersection.
 */
export function weightedScore(acTokens: string[], candTokens: string[]): { score: number; matched: string[] } {
    if (acTokens.length === 0 || candTokens.length === 0) return { score: 0, matched: [] };
    const acSet = new Set(acTokens);
    const candSet = new Set(candTokens);
    let intersect = 0;
    const matched: string[] = [];
    for (const t of acSet) {
        if (candSet.has(t)) {
            const w = DOMAIN_NOUNS.has(t) ? 2 : 1;
            intersect += w;
            matched.push(t);
        }
    }
    const unionSize = new Set([...acSet, ...candSet]).size;
    if (unionSize === 0) return { score: 0, matched };
    // Divide by (unionSize + domain-boost adjustment) so score stays in [0, ~1].
    const denominator = unionSize + matched.filter((m) => DOMAIN_NOUNS.has(m)).length;
    const score = intersect / denominator;
    return { score, matched };
}

export function classifyConfidence(score: number, verbMatched: boolean, hasDomainNoun: boolean): 'high' | 'medium' | 'low' | 'unmatched' {
    if (score >= 0.35 || (verbMatched && hasDomainNoun)) return 'high';
    if (score >= 0.20) return 'medium';
    if (score >= 0.10) return 'low';
    return 'unmatched';
}

/**
 * Given AC text, extract the intent verb (create/update/delete/…) if present.
 * Returns null when the AC has no clear action verb.
 */
export function extractIntentVerb(acText: string): string | null {
    const tokens = new Set(tokenize(acText));
    for (const v of Object.keys(VERB_TO_HTTP)) if (tokens.has(v)) return v;
    return null;
}

export function verbMatchesHttp(intent: string | null, httpVerb: string): boolean {
    if (!intent) return false;
    const options = VERB_TO_HTTP[intent];
    if (!options) return false;
    return options.includes(httpVerb.toUpperCase());
}

/**
 * Score a list of candidates and return them sorted descending, keeping only
 * those above threshold.
 */
export function scoreCandidates<T>(
    acTokens: string[],
    candidates: T[],
    candidateTokens: (item: T) => string[],
    reasonMaker: (item: T, matched: string[]) => string,
    threshold: number = 0.10,
): Scored<T>[] {
    const out: Scored<T>[] = [];
    for (const item of candidates) {
        const cToks = candidateTokens(item);
        const { score, matched } = weightedScore(acTokens, cToks);
        if (score >= threshold) {
            out.push({ item, score, matchedTokens: matched, reason: reasonMaker(item, matched) });
        }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
}

/**
 * Generate a plausible-invalid sample given a constraint kind + args.
 * The generator is deterministic — a test that says "this input is invalid
 * because it has 2 chars but min is 3" is a real check the generator can rely
 * on.
 */
export function suggestSample(
    type: string,
    constraints: Array<{ kind: string; args: Record<string, string> }>,
    variant: 'valid' | 'invalid',
): string {
    const lowerType = type.toLowerCase();
    // Aggregate constraints.
    let minLen = 0;
    let maxLen = Infinity;
    let pattern: string | null = null;
    let email = false;
    let notNull = false;
    for (const c of constraints) {
        if (c.kind === 'Size' || c.kind === 'StringLength') {
            const mn = c.args.min ?? c.args._0 ?? c.args.MinimumLength;
            const mx = c.args.max ?? c.args._1 ?? c.args._0;
            if (mn && !Number.isNaN(parseInt(mn, 10))) minLen = Math.max(minLen, parseInt(mn, 10));
            if (mx && !Number.isNaN(parseInt(mx, 10))) maxLen = Math.min(maxLen, parseInt(mx, 10));
        } else if (c.kind === 'MinLength') {
            const v = c.args._0; if (v) minLen = Math.max(minLen, parseInt(v, 10));
        } else if (c.kind === 'MaxLength') {
            const v = c.args._0; if (v) maxLen = Math.min(maxLen, parseInt(v, 10));
        } else if (c.kind === 'Pattern' || c.kind === 'RegularExpression') {
            pattern = c.args.regexp ?? c.args._0 ?? c.args.pattern ?? null;
        } else if (c.kind === 'Email' || c.kind === 'EmailAddress') {
            email = true;
        } else if (c.kind === 'NotNull' || c.kind === 'NotBlank' || c.kind === 'NotEmpty' || c.kind === 'Required') {
            notNull = true;
        }
    }
    if (variant === 'valid') {
        if (email) return 'user@example.test';
        if (pattern) return _samplePattern(pattern, true);
        if (lowerType.includes('int') || lowerType.includes('long') || lowerType.includes('number')) return '42';
        if (lowerType.includes('bool')) return 'true';
        const target = Math.min(Math.max(minLen, 5), Number.isFinite(maxLen) ? maxLen : 20);
        return 'a'.repeat(target);
    }
    // invalid — prefer a size/pattern/email violation over a bare-empty value
    // because "empty" often only violates @NotBlank/@NotEmpty (not @NotNull)
    // and gives a weaker signal downstream about which constraint fired.
    if (minLen > 1) return 'x'.repeat(Math.max(minLen - 1, 0)); // too short
    if (Number.isFinite(maxLen)) return 'x'.repeat(maxLen + 1); // too long
    if (email) return 'not-an-email';
    if (pattern) return _samplePattern(pattern, false);
    if (notNull) return '';
    return ''; // fall-back: empty
}

function _samplePattern(_regex: string, positive: boolean): string {
    // We deliberately don't try to invert arbitrary regex — return a value that
    // is either clearly alphanumeric (likely positive-matching for common
    // patterns) or clearly control characters (likely violating).
    return positive ? 'ValidPattern123' : '!!!';
}
