/**
 * CS Report Validation — test-data-first entry point.
 *
 * Instead of authoring a SimpleReportSpec + a separate test-data file, the
 * consumer writes ONE JSON per scenario whose top-level keys ARE the labels
 * as they appear in the PDF. Framework auto-extracts each label using the
 * existing AUTO cascade in `extractField` (inline → right → below for
 * colon-suffix labels; inline → below → right otherwise) and compares
 * extracted vs expected value.
 *
 * Reserved keys (prefix `_`) carry advanced hints:
 *   _presence  — string[] of substrings the PDF must contain anywhere
 *   _checks    — Phase 1-6 check blocks (same shape as SimpleReportSpec.checks)
 *   _tables    — Record<tableName, Row[]> (planned for v1.52.1; noop for now)
 *   _formatting — Record<label, SimpleFormattingRule> (planned; noop for now)
 *   _meta      — Reserved for future spec-override escape hatch
 *
 * Object-shape values (edge cases where AUTO cascade picks wrong):
 *   `"Mailing Address": { "expected": "ACME", "readFrom": "leftOf" }`
 *
 * Returns a `ValidationResult` shape compatible with the classic
 * SimpleReportSpec validator so the HTML reporter + BDD failure roll-up
 * paths reuse the existing plumbing.
 *
 * @module report-validation/CSReportSimpleValidatorFromData
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractPagesFromPdf } from './CSReportPdfExtractor';
import { detectPresence } from './CSReportSimplePresenceDetector';
import { extractField } from './CSReportSimpleFieldExtractor';
import type { PageContent, TextItem } from './CSReportPdfTypes';
import type { SimpleReportSpec, SimpleFieldSpec, SimpleReadFrom } from './CSReportSimpleSpec';
import {
    validatePdfAgainstSpec,
    type ValidationResult,
    type FieldFinding,
} from './CSReportSimpleValidator';

export interface ValidateFromDataOptions {
    pdfPath: string;
    dataPath: string;
    /** Override the auto-derived spec name (default: basename of dataPath). */
    specName?: string;
}

const RESERVED_PREFIX = '_';

/**
 * Read a test-data JSON file, synthesise a SimpleReportSpec on the fly, and
 * validate the PDF against it. This is the entry point behind the BDD step
 * `Then the PDF at {string} matches expected values from {string}`.
 */
export async function validatePdfFromDataFile(opts: ValidateFromDataOptions): Promise<ValidationResult> {
    if (!fs.existsSync(opts.pdfPath)) throw new Error(`PDF not found: ${opts.pdfPath}`);
    if (!fs.existsSync(opts.dataPath)) throw new Error(`Test-data JSON not found: ${opts.dataPath}`);

    const raw = JSON.parse(fs.readFileSync(opts.dataPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`Test-data JSON must be a top-level object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
    }
    const data = raw as Record<string, unknown>;
    const specName = opts.specName ?? path.basename(opts.dataPath, path.extname(opts.dataPath));

    const { spec, expectedValues } = synthesiseSpecFromData(specName, data);
    return validatePdfAgainstSpec({ pdfPath: opts.pdfPath, spec, expectedValues });
}

/**
 * Convert a test-data JSON payload into a `(spec, expectedValues)` pair the
 * classic validator can consume. Handles:
 *   - String values → labeled extractor via AUTO cascade
 *   - Object values with `expected + readFrom` → explicit readFrom mode
 *   - `_presence` array → presenceOfText fields
 *   - `_checks` block → passed through as spec.checks
 */
export function synthesiseSpecFromData(
    specName: string,
    data: Record<string, unknown>,
): { spec: SimpleReportSpec; expectedValues: Record<string, unknown> } {
    const fields: Record<string, SimpleFieldSpec> = {};
    const expectedValues: Record<string, unknown> = {};

    for (const [rawKey, rawValue] of Object.entries(data)) {
        if (rawKey.startsWith(RESERVED_PREFIX)) continue; // reserved — handled below
        const fieldKey = sanitiseFieldKey(rawKey);
        if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
            fields[fieldKey] = { label: rawKey, kind: guessKind(String(rawValue)) };
            expectedValues[fieldKey] = String(rawValue);
        } else if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
            const objVal = rawValue as { expected?: unknown; readFrom?: string; kind?: string; hint?: string };
            fields[fieldKey] = {
                label: rawKey,
                readFrom: (objVal.readFrom as SimpleReadFrom | undefined) ?? undefined,
                kind: (objVal.kind as SimpleFieldSpec['kind'] | undefined) ?? guessKind(String(objVal.expected ?? '')),
            };
            if (objVal.expected !== undefined) {
                expectedValues[fieldKey] = String(objVal.expected);
            }
        } else {
            // Skip null/array — reserved for future _tables etc.
        }
    }

    // `_presence`: substring markers.
    const presence = data['_presence'];
    if (Array.isArray(presence)) {
        for (const raw of presence) {
            if (typeof raw !== 'string' || !raw.trim()) continue;
            const key = sanitiseFieldKey('present_' + raw);
            fields[key] = { presenceOfText: raw };
            // Presence fields auto-assert against meansValue='present' when no expected supplied.
        }
    }

    // `_checks`: pass through unchanged.
    const checksBlock = data['_checks'];
    const spec: SimpleReportSpec = {
        name: specName,
        description: `Test-data-first spec synthesised from JSON at run time.`,
        fields,
        ...(checksBlock && typeof checksBlock === 'object' && !Array.isArray(checksBlock)
            ? { checks: checksBlock as SimpleReportSpec['checks'] }
            : {}),
    };

    return { spec, expectedValues };
}

/**
 * Read-only PDF extraction convenience — returns the raw text items per page.
 * Used by helper primitives like `cs_qa_report_infer_labels` that want to
 * examine the extracted content without running validation.
 */
export async function extractPdfTokensByPage(pdfPath: string): Promise<TextItem[][]> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    const pages: PageContent[] = await extractPagesFromPdf(pdfPath);
    return pages.map((p) => (p.textItems ?? []).filter((t) => t.str && t.str.trim().length > 0));
}

/**
 * List every plausible label detected in the PDF that the caller's test-data
 * JSON doesn't cover. Useful for "did I miss anything?" audits and for the
 * `/generate-pdf-tests` slash command that pre-populates JSON templates.
 *
 * Heuristic: any token that ends with `:` OR that appears to be a header
 * (all-caps, short) is treated as a candidate label. Presence-of-text
 * markers already in `_presence` are excluded.
 */
export async function inferLabels(
    pdfPath: string,
    knownLabels: string[] = [],
): Promise<Array<{ label: string; page: number; suggestedReadFrom: SimpleReadFrom }>> {
    const tokensByPage = await extractPdfTokensByPage(pdfPath);
    const known = new Set(knownLabels.map((l) => l.trim().toLowerCase()));
    const seenLabels = new Set<string>();
    const out: Array<{ label: string; page: number; suggestedReadFrom: SimpleReadFrom }> = [];

    for (let p = 0; p < tokensByPage.length; p++) {
        for (const tok of tokensByPage[p]) {
            const s = tok.str.trim();
            if (!s || s.length < 2 || s.length > 60) continue;
            // Candidate label: ends with `:` OR is title-case / all-caps text of 2-6 words
            const endsColon = s.endsWith(':');
            const looksLikeLabel = endsColon || /^[A-Z][A-Za-z0-9 &./#-]{1,40}$/.test(s);
            if (!looksLikeLabel) continue;
            const norm = s.toLowerCase();
            if (known.has(norm) || known.has(norm.replace(/:\s*$/, '')) || seenLabels.has(norm)) continue;
            seenLabels.add(norm);
            const suggestedReadFrom: SimpleReadFrom = endsColon ? 'right' : 'below';
            out.push({ label: s, page: p + 1, suggestedReadFrom });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sanitiseFieldKey(raw: string): string {
    // JSON keys can be anything; SimpleReportSpec's `fields` map keys become
    // identifiers used internally by the validator. Camelcase the raw label
    // into something identifier-safe while keeping it recognisable.
    return raw
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((word, i) => (i === 0 ? word.toLowerCase() : word[0]?.toUpperCase() + word.slice(1).toLowerCase()))
        .join('')
        .slice(0, 60) || 'field';
}

function guessKind(value: string): SimpleFieldSpec['kind'] {
    const s = value.trim();
    if (!s) return 'string';
    if (/^\(?\s*(USD\s*)?\$/.test(s)) return 'currency';
    if (/^\(?\s*-?\d[\d,]*\.\d+\)?$/.test(s)) return 'number';
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return 'date';
    return 'string';
}

// Re-export the underlying types so consumers can `import` the shape.
export type { ValidationResult, FieldFinding };
