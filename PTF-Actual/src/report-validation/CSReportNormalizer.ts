/**
 * CS Report Validation — Value + Column Normalization
 *
 * Turns the raw text a report source produced (Excel cell, CSV field, DB
 * column, PDF text item) into a `CanonicalValue` the reconciler can
 * compare directly. Also folds column-name variants (Oracle UPPERCASE,
 * SSRS PascalCase, Crystal Title Case, PDF header text) onto their
 * canonical name via `spec.fieldMap`.
 *
 * DESIGN — WHY THIS LIVES SEPARATE FROM THE RECONCILER
 * -----------------------------------------------------
 * The reconciler compares canonical values by kind:
 *   number : math (respects tolerance)
 *   date   : ISO string equality
 *   string : trimmed, case-folded equality (respects fuzzy tolerance)
 *   null   : null-null equality; null-something is a mismatch
 *
 * All the "does '$1,234.50' equal 1234.5" / "is '(500)' really -500" /
 * "which of these three date formats is this" logic lives HERE, so the
 * reconciler stays pure math over pre-normalized values. That makes both
 * modules easy to test independently.
 *
 * @module report-validation/CSReportNormalizer
 */

import type { CanonicalValue } from './CSReportModel';

/** Values that all collapse to `{ kind: 'null' }`. Case-insensitive, trimmed. */
const NULL_TOKENS = new Set([
    '',
    '-',
    '—',
    '–',
    'n/a',
    'na',
    'null',
    'none',
    '(none)',
    'nil',
    '#n/a',
]);

/**
 * Regex that matches an accounting-negative in parentheses, e.g. `(1,234.50)` or `($500)`.
 * Captures the inner numeric text. Only fires when the string is FULLY wrapped in parens
 * so we don't mangle values like `Amount (USD): 500`.
 */
const ACCOUNTING_NEGATIVE_RE = /^\((.+)\)$/;

/** Trailing-minus accounting negative, e.g. `1234.50-`. */
const TRAILING_MINUS_RE = /^(.+?)-$/;

/**
 * Characters we strip from a numeric string before parsing:
 *   - currency symbols: $ £ € ¥ ₹ ¢ ₽ ₩
 *   - thousands separators: comma, apostrophe, non-breaking space, regular space
 *   - trailing percent (retained as a signal, but returned raw so caller can divide by 100 per spec)
 *
 * Regex kept purposely narrow — we don't strip letters, so a value like `100USD` will
 * refuse to parse (correctly, since it isn't a plain number).
 */
const CURRENCY_STRIP_RE = /[$£€¥₹¢₽₩,'\s ]/g;

/** Normalizer options — spec-driven so different reports can override defaults per field. */
export interface NormalizerOptions {
    /** Date formats to try in order. First one that fully parses wins. */
    dateFormats?: string[];
    /** When true, `12.5%` → number 12.5 (raw preserved as `"12.5%"`). Default true. */
    parsePercent?: boolean;
    /** When false, values matching NULL_TOKENS are kept as `string` instead of collapsing to `null`. Default true. */
    collapseNullTokens?: boolean;
}

const DEFAULT_OPTIONS: Required<NormalizerOptions> = {
    dateFormats: [],
    parsePercent: true,
    collapseNullTokens: true,
};

/**
 * Case-fold + trim + collapse-whitespace normalization for column names. Used to align
 * raw column names (Oracle `ACCT_NO`, SSRS `AccountNumber`, Crystal `Acct No`) onto a
 * common lookup key. Non-alphanumeric chars are dropped so `Acct No` and `AcctNo` and
 * `ACCT_NO` all fold to `acctno`.
 */
export function normalizeColumnName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Reverse a source column name to its canonical field via `spec.fieldMap`. Returns null
 * when no mapping exists (the source has a column the spec doesn't know about — the
 * caller decides whether to skip or raise).
 *
 * @param sourceName Column name as it appears in the source (any case, any separators).
 * @param source     Which source's names to look up — any label the spec's `fieldMap` uses.
 * @param fieldMap   The spec's field mapping.
 */
/**
 * The column name(s) a source declares for one canonical field, matched case-insensitively.
 *
 * A feature file writes the source as it reads — `Crystal`, `vendorA` — while the spec writes
 * whatever its author chose. Neither should have to know the other's casing.
 */
export function fieldNamesForSource(
    entry: Record<string, string | string[] | undefined> | undefined,
    source: string,
): string | string[] | undefined {
    if (!entry) return undefined;
    const direct = entry[source];
    if (direct !== undefined) return direct;
    const wanted = source.toLowerCase();
    for (const [key, value] of Object.entries(entry)) {
        if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
}

export function canonicalFieldFor(
    sourceName: string,
    source: string,
    fieldMap: Record<string, Record<string, string | string[] | undefined>>,
): string | null {
    const target = normalizeColumnName(sourceName);
    for (const [canonical, entry] of Object.entries(fieldMap)) {
        const raw = fieldNamesForSource(entry, source);
        if (raw === undefined) continue;
        const names = Array.isArray(raw) ? raw : [raw];
        if (names.some((n) => normalizeColumnName(n) === target)) return canonical;
    }
    return null;
}

/**
 * Main entry point: `normalizeValue(raw, opts)` → `CanonicalValue`. Applies (in order):
 *   1. null-token collapse (empty / dash / N/A / nil / …)
 *   2. accounting-negative parens or trailing minus
 *   3. currency & thousands-separator stripping → number parse
 *   4. date-format probing per `opts.dateFormats`
 *   5. percent handling (strip trailing `%`, parse rest as number)
 *   6. fallback: canonicalize whitespace/case, keep as string
 *
 * The RAW input is always preserved on the returned value so diff reporters can show
 * the user what they actually saw in the report.
 */
export function normalizeValue(raw: unknown, opts: NormalizerOptions = {}): CanonicalValue {
    const cfg = { ...DEFAULT_OPTIONS, ...opts };
    const rawStr = raw === null || raw === undefined ? '' : String(raw);
    const trimmed = rawStr.trim();

    // 1. Null equivalence.
    if (cfg.collapseNullTokens && NULL_TOKENS.has(trimmed.toLowerCase())) {
        return { kind: 'null', raw: rawStr };
    }
    if (trimmed.length === 0) {
        return { kind: 'null', raw: rawStr };
    }

    // 2. Accounting negatives: (1,234.50) → -1234.5, 1234.50- → -1234.5
    let sign = 1;
    let body = trimmed;
    const parenMatch = body.match(ACCOUNTING_NEGATIVE_RE);
    if (parenMatch) {
        sign = -1;
        body = parenMatch[1].trim();
    } else {
        const trailMinus = body.match(TRAILING_MINUS_RE);
        if (trailMinus && /\d/.test(trailMinus[1])) {
            sign = -1;
            body = trailMinus[1].trim();
        }
    }

    // 5. Percent — strip trailing % but remember we did.
    let hadPercent = false;
    if (cfg.parsePercent && body.endsWith('%')) {
        hadPercent = true;
        body = body.slice(0, -1).trim();
    }

    // 3. Numeric parse after currency + separator strip.
    const numericBody = body.replace(CURRENCY_STRIP_RE, '');
    if (numericBody.length > 0 && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(numericBody)) {
        const parsed = parseFloat(numericBody) * sign;
        if (Number.isFinite(parsed)) {
            // A percent-shaped value is still a number; per spec, callers decide whether to
            // treat 12.5 or 0.125 — we preserve the raw so both interpretations remain
            // accessible in the finding output.
            void hadPercent;
            return { kind: 'number', value: parsed, raw: rawStr };
        }
    }

    // 4. Date probing.
    if (cfg.dateFormats.length > 0) {
        for (const fmt of cfg.dateFormats) {
            const iso = parseDateWithFormat(trimmed, fmt);
            if (iso) return { kind: 'date', value: iso, raw: rawStr };
        }
    }

    // 6. Fallback string — canonical whitespace + case for later equality checks.
    const canonicalString = trimmed.replace(/\s+/g, ' ');
    return { kind: 'string', value: canonicalString, raw: rawStr };
}

/**
 * Try to parse `text` using the format string `fmt`. Returns an ISO date-only or
 * date-time string on success, null on any mismatch. Hand-rolled instead of pulling
 * luxon/date-fns because our tokens are limited and the framework's ethos is zero-
 * unnecessary-runtime-deps.
 *
 * Supported tokens:
 *   yyyy — 4-digit year        MM   — 2-digit month (01-12)
 *   MMM  — Jan|Feb|…|Dec       MMMM — January|February|…|December
 *   dd   — 2-digit day (01-31) d    — 1-2 digit day
 *   HH   — 2-digit hour 00-23  mm   — 2-digit minute
 *   ss   — 2-digit second
 * Anything else in the format is a literal char match (spaces, dashes, slashes, commas).
 */
export function parseDateWithFormat(text: string, fmt: string): string | null {
    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTHS_LONG = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ];

    let y = -1, mo = -1, d = -1, h = 0, mi = 0, se = 0;
    let ti = 0; // pointer into `text`
    let fi = 0; // pointer into `fmt`

    const readInt = (min: number, max: number): number | null => {
        let n = 0;
        let consumed = 0;
        while (ti < text.length && text[ti] >= '0' && text[ti] <= '9' && consumed < max) {
            n = n * 10 + (text.charCodeAt(ti) - 48);
            ti++;
            consumed++;
        }
        return consumed >= min ? n : null;
    };

    while (fi < fmt.length) {
        const tok = fmt.slice(fi);
        if (tok.startsWith('yyyy')) {
            const v = readInt(4, 4);
            if (v === null) return null;
            y = v;
            fi += 4;
        } else if (tok.startsWith('MMMM')) {
            const rest = text.slice(ti);
            const match = MONTHS_LONG.findIndex((m) => rest.toLowerCase().startsWith(m.toLowerCase()));
            if (match < 0) return null;
            mo = match + 1;
            ti += MONTHS_LONG[match].length;
            fi += 4;
        } else if (tok.startsWith('MMM')) {
            const rest = text.slice(ti);
            const match = MONTHS_SHORT.findIndex((m) => rest.toLowerCase().startsWith(m.toLowerCase()));
            if (match < 0) return null;
            mo = match + 1;
            ti += 3;
            fi += 3;
        } else if (tok.startsWith('MM')) {
            const v = readInt(2, 2);
            if (v === null || v < 1 || v > 12) return null;
            mo = v;
            fi += 2;
        } else if (tok.startsWith('dd')) {
            const v = readInt(2, 2);
            if (v === null || v < 1 || v > 31) return null;
            d = v;
            fi += 2;
        } else if (tok.startsWith('d')) {
            const v = readInt(1, 2);
            if (v === null || v < 1 || v > 31) return null;
            d = v;
            fi += 1;
        } else if (tok.startsWith('HH')) {
            const v = readInt(2, 2);
            if (v === null || v < 0 || v > 23) return null;
            h = v;
            fi += 2;
        } else if (tok.startsWith('mm')) {
            const v = readInt(2, 2);
            if (v === null || v < 0 || v > 59) return null;
            mi = v;
            fi += 2;
        } else if (tok.startsWith('ss')) {
            const v = readInt(2, 2);
            if (v === null || v < 0 || v > 59) return null;
            se = v;
            fi += 2;
        } else {
            // Literal-char match.
            if (text[ti] !== fmt[fi]) return null;
            ti++;
            fi++;
        }
    }
    // Reject trailing garbage in text.
    if (ti !== text.length) return null;
    if (y < 0 || mo < 1 || d < 1) return null;

    const yStr = String(y).padStart(4, '0');
    const moStr = String(mo).padStart(2, '0');
    const dStr = String(d).padStart(2, '0');
    const dateOnly = `${yStr}-${moStr}-${dStr}`;
    const hasTime = h !== 0 || mi !== 0 || se !== 0 || /HH|mm|ss/.test(fmt);
    if (!hasTime) return dateOnly;
    return `${dateOnly}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}`;
}

/**
 * Case-fold, trim, and collapse whitespace for text-value equality. Applied automatically
 * inside `normalizeValue` for string values; also exported so the reconciler can compare
 * two already-normalized `CanonicalValue.value` strings without re-canonicalizing.
 */
export function canonicalizeString(s: string): string {
    return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
