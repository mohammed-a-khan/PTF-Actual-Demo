/**
 * Extract scalar field values from PDF token stream per a SimpleFieldSpec.
 *
 * Given the flat list of text tokens (from CSReportPdfExtractor) and one
 * field spec, returns the raw string value found in the PDF — or null when
 * the anchor is not found or no value token sits where the spec says to look.
 *
 * @module report-validation/CSReportSimpleFieldExtractor
 */

import type { TextItem } from './CSReportPdfTypes';
import type { SimpleFieldSpec, SimpleReadFrom } from './CSReportSimpleSpec';

const DEFAULT_X_TOLERANCE = 25;
const DEFAULT_Y_TOLERANCE = 4;
const DEFAULT_BELOW_MAX_DROP = 30;
const DEFAULT_INLINE_SEPARATOR = ': ';

export interface FieldExtractionResult {
    value: string | null;
    /** Reason extraction failed (populated only when value is null). */
    reason?: string;
    /** The anchor token found, when useful for diagnostics. */
    anchor?: { str: string; x: number; y: number; page: number };
}

/** Locate a field's value in the token stream, per the spec's rules. */
export function extractField(
    tokensByPage: TextItem[][],
    spec: SimpleFieldSpec,
): FieldExtractionResult {
    if (spec.presenceOfText) {
        // Presence-of-text is handled by CSReportSimplePresenceDetector, not here.
        return { value: null, reason: 'presence-only field — use presence detector' };
    }
    if (!spec.label) {
        return { value: null, reason: 'field spec has no label' };
    }
    const anchor = findAnchor(tokensByPage, spec.label);
    if (!anchor) {
        return { value: null, reason: `anchor "${spec.label}" not found in PDF` };
    }
    const pageTokens = tokensByPage[anchor.page];
    // Auto-detect readFrom when omitted. Heuristic:
    //   1. `inline` first — if the anchor token itself contains "<label><separator>",
    //      take everything after the separator (matches labels like "Order ID: 12345").
    //   2. If the label ends with `:` — try `right` (typical convention: `Total:  $10.00`).
    //   3. Otherwise — try `below` (labels sitting above stacked value tokens: `Order ID` / `12345`).
    //   4. Then the OPPOSITE of #2/#3 as a fallback.
    // Consumer overrides with explicit `readFrom` when auto picks wrong.
    let modes: SimpleReadFrom[];
    if (spec.readFrom) {
        modes = [spec.readFrom];
    } else {
        const colonSuffix = spec.label.trim().endsWith(':');
        modes = colonSuffix ? ['inline', 'right', 'below'] : ['inline', 'below', 'right'];
    }
    let value: string | null = null;
    let tried: string[] = [];
    for (const mode of modes) {
        tried.push(mode);
        let v: string | null = null;
        switch (mode) {
            case 'inline':
                v = readInline(anchor.token, spec.label, spec.inlineSeparator ?? DEFAULT_INLINE_SEPARATOR);
                break;
            case 'right':
                v = readRight(pageTokens, anchor.token, spec);
                break;
            case 'leftOf':
                v = readLeftOf(pageTokens, anchor.token, spec);
                break;
            case 'belowLine':
                v = readBelowLine(pageTokens, anchor.token, spec);
                break;
            case 'below':
                v = readBelow(pageTokens, anchor.token, spec);
                break;
        }
        if (v !== null && v.trim().length > 0) {
            value = v;
            break;
        }
    }
    const anchorMeta = { str: anchor.token.str, x: anchor.token.x, y: anchor.token.y, page: anchor.page };
    if (value === null) {
        return {
            value: null,
            reason: `no value token found ${tried.join('/')} anchor "${spec.label}" at (page ${anchor.page + 1}, x=${anchor.token.x}, y=${anchor.token.y})`,
            anchor: anchorMeta,
        };
    }
    return { value: value.trim(), anchor: anchorMeta };
}

/** Case-insensitive substring anchor match. First hit (top-left-most) wins. */
function findAnchor(
    tokensByPage: TextItem[][],
    label: string,
): { token: TextItem; page: number } | null {
    const needle = label.toLowerCase().trim();
    for (let p = 0; p < tokensByPage.length; p++) {
        const page = tokensByPage[p];
        const candidates = page.filter((t) => t.str.toLowerCase().includes(needle));
        if (candidates.length === 0) continue;
        // Prefer exact match, then top-left-most.
        candidates.sort((a, b) => {
            const aExact = a.str.trim().toLowerCase() === needle ? 0 : 1;
            const bExact = b.str.trim().toLowerCase() === needle ? 0 : 1;
            if (aExact !== bExact) return aExact - bExact;
            if (b.y !== a.y) return b.y - a.y; // higher y = higher on page = earlier
            return a.x - b.x;
        });
        return { token: candidates[0], page: p };
    }
    return null;
}

function readInline(anchorToken: TextItem, label: string, separator: string): string | null {
    const raw = anchorToken.str;
    // Case-insensitive find of the label followed by separator.
    const lowerRaw = raw.toLowerCase();
    const lowerLabel = label.toLowerCase();
    const idx = lowerRaw.indexOf(lowerLabel);
    if (idx < 0) return null;
    const after = raw.substring(idx + label.length);
    const sepIdx = after.indexOf(separator);
    if (sepIdx < 0) return null;
    const tail = after.substring(sepIdx + separator.length).trim();
    return tail.length > 0 ? tail : null;
}

const DEFAULT_RIGHT_MAX_INTER_TOKEN_GAP = 40;

const DEFAULT_LEFTOF_Y_TOLERANCE = 8; // cross-column reads see larger baseline offsets than same-column right/below

function readLeftOf(pageTokens: TextItem[], anchor: TextItem, spec: SimpleFieldSpec): string | null {
    const yTol = spec.yTolerance ?? DEFAULT_LEFTOF_Y_TOLERANCE;
    const candidates = pageTokens.filter(
        (t) => t !== anchor && Math.abs(t.y - anchor.y) <= yTol && t.x + t.width <= anchor.x,
    );
    if (candidates.length === 0) return null;
    // Take the contiguous group closest to the anchor from the left — stop at the first big gap.
    candidates.sort((a, b) => b.x - a.x); // rightmost first (nearest to anchor)
    const picked: TextItem[] = [candidates[0]];
    for (let i = 1; i < candidates.length; i++) {
        const prev = picked[picked.length - 1];
        const gap = prev.x - (candidates[i].x + candidates[i].width);
        if (gap > DEFAULT_RIGHT_MAX_INTER_TOKEN_GAP) break;
        picked.push(candidates[i]);
    }
    // Return in left-to-right reading order.
    picked.sort((a, b) => a.x - b.x);
    return picked.map((t) => t.str.trim()).filter((s) => s.length > 0).join(' ');
}

function readRight(pageTokens: TextItem[], anchor: TextItem, spec: SimpleFieldSpec): string | null {
    const yTol = spec.yTolerance ?? DEFAULT_Y_TOLERANCE;
    const maxSpan = spec.rightMaxSpan;
    const anchorRight = anchor.x + anchor.width;
    const candidates = pageTokens.filter(
        (t) =>
            t !== anchor &&
            Math.abs(t.y - anchor.y) <= yTol &&
            t.x >= anchorRight &&
            (maxSpan === undefined || t.x - anchorRight <= maxSpan),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.x - b.x);
    // Take the contiguous group closest to the anchor — stop at the first big horizontal gap.
    // This prevents "File Review" (fee label) from vacuuming the "1,000 @ $1.00" middle column
    // AND the "$1,000.00" amount column that sits far to the right.
    const picked: TextItem[] = [candidates[0]];
    for (let i = 1; i < candidates.length; i++) {
        const prev = picked[picked.length - 1];
        const gap = candidates[i].x - (prev.x + prev.width);
        if (gap > DEFAULT_RIGHT_MAX_INTER_TOKEN_GAP) break;
        picked.push(candidates[i]);
    }
    return picked.map((t) => t.str.trim()).filter((s) => s.length > 0).join(' ');
}

function readBelowLine(pageTokens: TextItem[], anchor: TextItem, spec: SimpleFieldSpec): string | null {
    // "Below line" = the N-th distinct row of tokens strictly below the anchor,
    // regardless of x-alignment. Used for values that sit under an anchor but on
    // a different x column — e.g. a subheading line under an "Account Number: X"
    // line whose value starts at the left margin.
    const rowYTol = spec.yTolerance ?? DEFAULT_Y_TOLERANCE;
    const offset = Math.max(1, spec.belowLineOffset ?? 1);
    const below = pageTokens.filter((t) => t !== anchor && t.y < anchor.y).sort((a, b) => b.y - a.y);
    if (below.length === 0) return null;
    const rows: TextItem[][] = [];
    for (const t of below) {
        const bucket = rows.find((r) => Math.abs(r[0].y - t.y) <= rowYTol);
        if (bucket) bucket.push(t);
        else rows.push([t]);
    }
    if (rows.length < offset) return null;
    const row = rows[offset - 1].slice().sort((a, b) => a.x - b.x);
    return row.map((t) => t.str.trim()).filter((s) => s.length > 0).join(' ');
}

function readBelow(pageTokens: TextItem[], anchor: TextItem, spec: SimpleFieldSpec): string | null {
    const xTol = spec.xTolerance ?? DEFAULT_X_TOLERANCE;
    const maxDrop = spec.belowMaxDrop ?? DEFAULT_BELOW_MAX_DROP;
    // "Below" in PDF space means smaller y. Consider tokens whose x-range overlaps the anchor's,
    // whose y < anchor.y, and drop is within maxDrop.
    const anchorLeft = anchor.x;
    const anchorRight = anchor.x + anchor.width;
    const candidates = pageTokens.filter((t) => {
        if (t === anchor) return false;
        if (t.y >= anchor.y) return false;
        if (anchor.y - t.y > maxDrop) return false;
        const tRight = t.x + t.width;
        // horizontal overlap or near-alignment
        const overlaps = t.x <= anchorRight + xTol && tRight >= anchorLeft - xTol;
        return overlaps;
    });
    if (candidates.length === 0) return null;
    // Pick the highest-y (closest below the anchor) row, then join tokens on that row.
    candidates.sort((a, b) => b.y - a.y);
    const topY = candidates[0].y;
    const sameRow = candidates.filter((t) => Math.abs(t.y - topY) <= (spec.yTolerance ?? DEFAULT_Y_TOLERANCE));
    sameRow.sort((a, b) => a.x - b.x);
    return sameRow.map((t) => t.str.trim()).filter((s) => s.length > 0).join(' ');
}
