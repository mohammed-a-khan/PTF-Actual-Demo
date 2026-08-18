/**
 * Signature normalization helpers for flaky-test clustering and other
 * fingerprint-based dedupes.
 *
 * Rules that keep the signature stable across noise:
 *  - Strip absolute file paths down to basenames.
 *  - Drop line/column numbers (`:123:45` and `at file.js:456`).
 *  - Replace UUIDs, hex ids, and numeric identifiers that vary per run.
 *  - Collapse whitespace.
 *  - Normalize quoted string variance ("foo-uuid-1234" → "<STR>").
 *
 * Not exhaustive — the goal is: two runs of the SAME logical failure produce
 * IDENTICAL normalized signatures even when line numbers or object addresses
 * shift.
 */

import { createHash } from 'crypto';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ADDR_RE = /\b0x[0-9a-f]{4,}\b/gi;
const NUMBER_RE = /\b\d{2,}\b/g;                       // 2+ digit numbers → <N>
const LINE_COL_RE = /:\d+:\d+/g;
const AT_LINE_RE = /:\d+(?=[)\s]|$)/g;                 // trailing :123 in stack frames
const WIN_PATH_RE = /[a-zA-Z]:\\[^\s"')]+/g;
const UNIX_PATH_RE = /\/[A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs)/g;
const WS_RE = /\s+/g;

export interface NormalizedSignature {
    /** Full canonical signature line — used to compute the hash. */
    canonical: string;
    /** SHA-1 fingerprint of the canonical signature (stable across runs). */
    fingerprint: string;
    /** Human-readable pieces so callers can render the cluster header. */
    parts: {
        errorClass: string;
        topFrame: string;
        selector?: string;
        rawMessage?: string;
    };
}

export interface RawFailure {
    /** Class name / kind (TypeError, TimeoutError, AssertionError, PageError, etc.) */
    errorClass?: string;
    /** Free-form error message text. */
    message?: string;
    /** Stack trace text (optional). */
    stack?: string;
    /** Selector the failure touched — playwright/locator name / xpath / css. */
    selector?: string;
    /** Test id / scenario name (for grouping in the report; NOT part of the fingerprint). */
    testId?: string;
    /** Timestamp — for first/last seen — NOT part of the fingerprint. */
    ts?: string;
}

export function normalizeSelector(sel: string | undefined): string | undefined {
    if (!sel) return undefined;
    let out = sel.trim();
    // Ordinal-style suffixes like [3] used by axe-core for multiple hits — drop the index.
    out = out.replace(/\[\d+\]/g, '[N]');
    // Numeric ids in css / xpath.
    out = out.replace(/#\S*?(\d+)/g, (_m) => '#<N>');
    out = out.replace(UUID_RE, '<UUID>');
    out = out.replace(NUMBER_RE, '<N>');
    out = out.replace(WS_RE, ' ');
    return out;
}

export function extractTopFrame(stack: string | undefined): string {
    if (!stack) return '';
    for (const raw of stack.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.toLowerCase().startsWith('error') || line.toLowerCase().startsWith('typeerror') || line.toLowerCase().startsWith('assertionerror')) continue;
        if (line.startsWith('at ')) return line;
        // Some stacks are just "file.js:123:45 …"
        if (/\.(?:ts|tsx|js|jsx|mjs|cjs)/.test(line)) return line;
    }
    // Fallback: first line.
    const first = stack.split(/\r?\n/)[0] || '';
    return first.trim();
}

function stripPaths(text: string): string {
    return text
        .replace(WIN_PATH_RE, (m) => basename(m))
        .replace(UNIX_PATH_RE, (m) => basename(m));
}

function basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

export function normalizeSignature(failure: RawFailure): NormalizedSignature {
    const errorClass = String(failure.errorClass || 'Error').trim();
    const rawTop = extractTopFrame(failure.stack);
    let topFrame = stripPaths(rawTop);
    topFrame = topFrame.replace(LINE_COL_RE, ':<L>:<C>');
    topFrame = topFrame.replace(AT_LINE_RE, ':<L>');
    topFrame = topFrame.replace(HEX_ADDR_RE, '<HEX>');
    topFrame = topFrame.replace(UUID_RE, '<UUID>');
    topFrame = topFrame.replace(NUMBER_RE, '<N>');
    topFrame = topFrame.replace(WS_RE, ' ').trim();

    let rawMessage: string | undefined = failure.message ? String(failure.message).trim() : undefined;
    let normMessage = rawMessage || '';
    normMessage = stripPaths(normMessage);
    normMessage = normMessage.replace(LINE_COL_RE, ':<L>:<C>');
    normMessage = normMessage.replace(UUID_RE, '<UUID>');
    normMessage = normMessage.replace(HEX_ADDR_RE, '<HEX>');
    // Quoted string arguments: '<some-instance-id-42>' → '<STR>'
    normMessage = normMessage.replace(/"[^"\n]{0,120}"/g, '"<STR>"');
    normMessage = normMessage.replace(/'[^'\n]{0,120}'/g, "'<STR>'");
    normMessage = normMessage.replace(NUMBER_RE, '<N>');
    normMessage = normMessage.replace(WS_RE, ' ').trim();

    const selector = normalizeSelector(failure.selector);

    const canonical = [
        `errClass=${errorClass}`,
        `topFrame=${topFrame}`,
        selector ? `selector=${selector}` : '',
        `msg=${normMessage.slice(0, 240)}`,
    ].filter(Boolean).join('|');

    const fingerprint = createHash('sha1').update(canonical).digest('hex');
    return {
        canonical,
        fingerprint,
        parts: { errorClass, topFrame, selector, rawMessage },
    };
}
