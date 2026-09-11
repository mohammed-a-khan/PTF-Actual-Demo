/**
 * Auto-generate a starter SimpleReportSpec from a sample PDF.
 *
 * The single most-hated part of onboarding a report is authoring the spec
 * file. This runs the full extractor + layout analyzer over a sample PDF and
 * emits a spec JSON that already covers every labeled field, table, and fixed
 * template string the analyzer detected. Consumer REVIEWS and trims — no more
 * blank-page authoring.
 *
 * Design principles:
 *   - Produce over-inclusive output. A generated spec that covers 40 fields
 *     the consumer will trim to 12 is a better experience than one that
 *     covers 8 fields the consumer has to add 4 more to.
 *   - Every field carries a source-of-truth comment path so the reviewer can
 *     locate the physical evidence in the PDF (`generatedFrom` in the value
 *     itself is verbose in JSON; use a companion `.map.json` sidecar if we
 *     ever surface this).
 *   - The output is a valid `SimpleReportSpec` — round-trips through
 *     `loadSimpleReportSpec` without edits.
 *   - Zero dependencies beyond what the module already uses (pdfjs-dist + our
 *     own layout analyzer). No external services, no LLM calls.
 *
 * @module report-validation/CSReportSimpleSpecGenerator
 */

import * as path from 'path';
import { extractPagesFromPdf } from './CSReportPdfExtractor';
import { analyzeReport } from './CSReportPdfLayoutAnalyzer';
import type { AnalyzedReport, AnalyzedSection } from './CSReportPdfTypes';
import type {
    SimpleFieldKind,
    SimpleFieldSpec,
    SimpleReadFrom,
    SimpleReportSpec,
    SimpleReportSpecChecks,
    SimpleTableColumnSpec,
    SimpleTableSpec,
} from './CSReportSimpleSpec';

export interface GenerateSpecOptions {
    /** Absolute or repo-relative path to the sample PDF. */
    pdfPath: string;
    /**
     * Name for the generated spec (becomes `spec.name` + used when loaded).
     * Default: PDF filename minus extension, kebab-cased.
     */
    specName?: string;
    /**
     * Include `presenceOfText` markers for fixed template strings (title,
     * subtitle, "Please retain…" boilerplate, section headers). Default: true.
     */
    includeTemplateMarkers?: boolean;
    /**
     * Include header-metadata fields (Invoice Number / Date / Total shape).
     * Default: true.
     */
    includeLabeledFields?: boolean;
    /**
     * Include tabular section extraction. Default: true.
     */
    includeTables?: boolean;
    /**
     * Max number of `presenceOfText` markers to emit for a single spec. Above
     * this, the generator stops adding markers (avoids 200-field auto-emits).
     * Default: 30.
     */
    maxTemplateMarkers?: number;
    /**
     * Minimum row count for a section to be treated as a table rather than
     * emitted as individual fields. Default: 2.
     */
    minRowsForTable?: number;
}

export interface GenerateSpecResult {
    spec: SimpleReportSpec;
    /** JSON string of the spec, ready to write to disk. */
    json: string;
    /** Diagnostic summary — how many fields/tables/markers were emitted, and why. */
    summary: {
        pdfPath: string;
        pageCount: number;
        sectionsDetected: number;
        fieldsEmitted: number;
        tablesEmitted: number;
        presenceMarkersEmitted: number;
    };
    /** Human-readable note lines the caller can print to stdout after writing the file. */
    notes: string[];
}

/**
 * Main entry — generate a spec from a sample PDF.
 */
export async function generateSimpleReportSpec(opts: GenerateSpecOptions): Promise<GenerateSpecResult> {
    const pages = await extractPagesFromPdf(opts.pdfPath);
    const analyzed = analyzeReport(pages);
    return buildSpecFromAnalyzed({
        analyzed,
        pdfPath: opts.pdfPath,
        specName: opts.specName ?? deriveSpecName(opts.pdfPath),
        includeTemplateMarkers: opts.includeTemplateMarkers ?? true,
        includeLabeledFields: opts.includeLabeledFields ?? true,
        includeTables: opts.includeTables ?? true,
        maxTemplateMarkers: Math.max(1, opts.maxTemplateMarkers ?? 30),
        minRowsForTable: Math.max(1, opts.minRowsForTable ?? 2),
    });
}

/** Same as generateSimpleReportSpec but takes a pre-parsed AnalyzedReport (for testing). */
export function buildSpecFromAnalyzed(input: {
    analyzed: AnalyzedReport;
    pdfPath: string;
    specName: string;
    includeTemplateMarkers: boolean;
    includeLabeledFields: boolean;
    includeTables: boolean;
    maxTemplateMarkers: number;
    minRowsForTable: number;
}): GenerateSpecResult {
    const { analyzed, pdfPath, specName } = input;
    const fields: Record<string, SimpleFieldSpec> = {};
    const tables: Record<string, SimpleTableSpec> = {};
    const notes: string[] = [];

    let presenceCount = 0;
    const registeredLabels = new Set<string>();

    // Consolidated view: every section across all pages plus the merged-section list.
    // Merged sections are preferred (cross-page continuation resolved); anonymous or
    // page-only sections fill in gaps.
    const sectionsForAnalysis: AnalyzedSection[] = analyzed.mergedSections.length > 0
        ? analyzed.mergedSections
        : analyzed.pages.flatMap((p) => p.sections);

    // ---- Header/title/subtitle presence markers ---------------------------
    if (input.includeTemplateMarkers && presenceCount < input.maxTemplateMarkers) {
        const headerCandidates = collectHeaderText(analyzed);
        for (const text of headerCandidates) {
            if (presenceCount >= input.maxTemplateMarkers) break;
            const key = keyForPresence(text, registeredLabels);
            if (!key) continue;
            fields[key] = { presenceOfText: text };
            registeredLabels.add(key);
            presenceCount++;
        }
    }

    // ---- Labeled scalar fields (inline "Label: value" + below/right patterns) --
    if (input.includeLabeledFields) {
        for (const sec of sectionsForAnalysis) {
            emitInlineLabeledFields(sec, fields, registeredLabels);
            emitBelowLabeledFields(sec, fields, registeredLabels);
        }
    }

    // ---- Tables ----------------------------------------------------------
    if (input.includeTables) {
        for (const sec of sectionsForAnalysis) {
            if (sec.tableRows.length < input.minRowsForTable) continue;
            if (sec.columns.length === 0) continue;
            if (isAnonymous(sec.title)) continue;

            const tableKey = camelCase(sec.title);
            if (!tableKey || tables[tableKey]) continue;

            const columns: SimpleTableColumnSpec[] = sec.columns.map((col) => ({
                key: camelCase(col.header ?? '') || `col${sec.columns.indexOf(col) + 1}`,
                header: col.header && col.header.trim().length > 0 ? col.header.trim() : undefined,
            }));

            // Pick a `stopAt` — the first likely trailing "Total"/"Grand Total" phrase in the section.
            const stopAt = detectStopAtAnchor(sec);

            tables[tableKey] = {
                headerAnchor: sec.title.trim(),
                stopAt,
                columns,
                keyColumns: guessKeyColumns(columns),
            };
        }
    }

    // ---- Boilerplate presence (retain notice, envelope notice, etc.) -------
    if (input.includeTemplateMarkers && presenceCount < input.maxTemplateMarkers) {
        const boilerplate = collectBoilerplate(analyzed);
        for (const text of boilerplate) {
            if (presenceCount >= input.maxTemplateMarkers) break;
            const key = keyForPresence(text, registeredLabels);
            if (!key) continue;
            fields[key] = { presenceOfText: text };
            registeredLabels.add(key);
            presenceCount++;
        }
    }

    // ---- Draft-vs-billed state marker (very common pattern) ----------------
    if (input.includeTemplateMarkers) {
        const draftMarker = analyzed.pages.some((p) =>
            p.sections.some((s) =>
                s.tableRows.some((r) =>
                    r.cells.some((c) => c !== null && /^DRAFT[\s\-–_]|DO NOT PAY/i.test(c)),
                ),
            ),
        );
        if (!fields.docState) {
            // Semantics: presenceOfText found → meansValue; not found → elseValue.
            // We standardise on draft-detects-DRAFT so the marker discriminates
            // consistently across variants. The sample's actual state is captured
            // in the note so consumers know which value to pass in the expected
            // bag for a self-passing scenario.
            fields.docState = {
                presenceOfText: 'DRAFT',
                meansValue: 'draft',
                elseValue: 'final',
            };
            notes.push(
                draftMarker
                    ? 'Added docState presence marker (DRAFT→"draft" | else→"final"). Sample PDF appears to be a DRAFT — pass docState="draft" in your expected bag.'
                    : 'Added docState presence marker (DRAFT→"draft" | else→"final"). Sample PDF appears to be BILLED — pass docState="final" in your expected bag, or remove this field if you do not need state discrimination.',
            );
        }
    }

    // ---- Diagnostic notes for the reviewer ---------------------------------
    if (Object.keys(fields).length === 0) {
        notes.push('No fields detected. This may mean the PDF is image-only (needs OCR) or heavily custom.');
    }
    if (sectionsForAnalysis.length === 0) {
        notes.push('No sections detected. Try adding explicit section-title regexes and re-running.');
    }
    notes.push(
        'Every field is a STARTING POINT — trim what you do not care about, tighten `label` strings for uniqueness, override `readFrom` where auto-detection picked wrong.',
    );

    // Seed a starter `checks:` block based on what we saw in the sample PDF.
    // These are the "safe" checks that a fresh spec can carry without failing
    // out of the box — they represent facts the sample PDF already exhibits.
    // The consumer opts into stricter phase-3+ blocks (security, signatures,
    // barcodes, etc.) by editing the spec after generation.
    const starterChecks = buildStarterChecks(analyzed);

    const spec: SimpleReportSpec = {
        name: specName,
        description: `Auto-generated from ${path.basename(pdfPath)} — review and trim before use.`,
        fields,
        tables: Object.keys(tables).length > 0 ? tables : undefined,
        checks: Object.keys(starterChecks).length > 0 ? starterChecks : undefined,
    };

    const json = JSON.stringify(spec, undefined, 4) + '\n';

    return {
        spec,
        json,
        summary: {
            pdfPath,
            pageCount: analyzed.pageCount,
            sectionsDetected: sectionsForAnalysis.length,
            fieldsEmitted: Object.keys(fields).length,
            tablesEmitted: Object.keys(tables).length,
            presenceMarkersEmitted: presenceCount,
        },
        notes,
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function deriveSpecName(pdfPath: string): string {
    const base = path.basename(pdfPath, path.extname(pdfPath));
    return base
        .replace(/[_\s]+/g, '-')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9-]/g, '')
        .toLowerCase();
}

function camelCase(input: string): string {
    if (!input) return '';
    const words = input
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/);
    if (words.length === 0) return '';
    return words
        .map((w, i) => {
            const lower = w.toLowerCase();
            if (i === 0) return lower;
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join('')
        .replace(/^([0-9])/, '_$1');
}

function isAnonymous(title: string): boolean {
    return !title || title.trim() === '' || title === '(anonymous)';
}

function keyForPresence(text: string, taken: Set<string>): string | null {
    let key = camelCase(text);
    if (!key) return null;
    // Cap the key length so we don't emit `iAmALongLineOfBoilerplateAndSoOn` as a key.
    if (key.length > 40) key = key.slice(0, 40);
    if (taken.has(key)) {
        for (let i = 2; i <= 20; i++) {
            const alt = `${key}_${i}`;
            if (!taken.has(alt)) return alt;
        }
        return null;
    }
    return key;
}

/**
 * Collect header/title/subtitle text — items with a font notably larger than the page median.
 * De-duplicated across pages (title tends to repeat).
 */
function collectHeaderText(analyzed: AnalyzedReport): string[] {
    const out = new Set<string>();
    for (const p of analyzed.pages) {
        for (const s of p.sections) {
            if (s.title && !isAnonymous(s.title)) out.add(s.title.trim());
        }
        for (const h of p.header) {
            if (h && h.trim().length > 2) out.add(h.trim());
        }
    }
    // Cap so a huge multi-page doc doesn't emit hundreds of header markers.
    return Array.from(out).slice(0, 12);
}

/**
 * Boilerplate detection — any repeated (footer + free-text) phrase that appears on multiple pages
 * and is not a section title. Signals fixed template strings.
 */
function collectBoilerplate(analyzed: AnalyzedReport): string[] {
    const counts = new Map<string, number>();
    for (const p of analyzed.pages) {
        for (const f of p.footer) {
            if (f && f.trim().length > 4) counts.set(f.trim(), (counts.get(f.trim()) ?? 0) + 1);
        }
        for (const s of p.sections) {
            for (const ft of s.freeText ?? []) {
                if (ft && ft.trim().length > 8) counts.set(ft.trim(), (counts.get(ft.trim()) ?? 0) + 1);
            }
        }
    }
    const boilerplate: string[] = [];
    for (const [text, count] of counts) {
        // A phrase appearing on the majority of pages (or ≥2 pages for short docs) is boilerplate.
        const threshold = analyzed.pageCount >= 3 ? Math.ceil(analyzed.pageCount * 0.5) : 1;
        if (count >= threshold && text.length <= 120) boilerplate.push(text);
    }
    return boilerplate.slice(0, 10);
}

/**
 * Emit `{ label, readFrom: 'inline', inlineSeparator: ': ' }` for any row whose leftmost cell
 * has the shape `Label: value`.
 */
function emitInlineLabeledFields(
    sec: AnalyzedSection,
    fields: Record<string, SimpleFieldSpec>,
    taken: Set<string>,
): void {
    for (const row of sec.tableRows) {
        for (const cell of row.cells) {
            if (cell === null) continue;
            const raw = cell.trim();
            if (!raw) continue;
            const inlineMatch = raw.match(/^([A-Z][A-Za-z0-9 #\/&()-]{1,60}):\s+(.{1,200})$/);
            if (!inlineMatch) continue;
            const label = inlineMatch[1].trim();
            const key = camelCase(label);
            if (!key || taken.has(key)) continue;
            fields[key] = {
                label,
                readFrom: 'inline',
                inlineSeparator: ': ',
                kind: guessKindForRawValue(inlineMatch[2]),
            };
            taken.add(key);
        }
    }
}

/**
 * Emit `{ label, readFrom: 'below' | 'right' }` for cells that look like a header (all-caps or
 * title-case, no digits) with a value one row below or immediately to their right.
 *
 * Heuristic: for each `TableRow` that has ≤ 4 cells and each cell contains a label-shaped string,
 * treat as a metadata row. For each label, examine the next row's aligned cell — if value-shaped,
 * emit `below`; otherwise emit `right`.
 */
function emitBelowLabeledFields(
    sec: AnalyzedSection,
    fields: Record<string, SimpleFieldSpec>,
    taken: Set<string>,
): void {
    // Only for short-row grids (invoice-style metadata bands, NOT big data tables).
    const rows = sec.tableRows.filter((r) => !r.isGroupHeader);
    if (rows.length < 2) return;

    for (let i = 0; i < rows.length - 1; i++) {
        const labelRow = rows[i];
        const valueRow = rows[i + 1];
        // A metadata row has ≤5 cells with label-shaped strings.
        const labelIndices: number[] = [];
        for (let col = 0; col < labelRow.cells.length; col++) {
            const c = labelRow.cells[col];
            if (c !== null && isLabelShaped(c)) labelIndices.push(col);
        }
        if (labelIndices.length === 0 || labelIndices.length > 5) continue;

        for (const col of labelIndices) {
            const label = (labelRow.cells[col] ?? '').trim();
            const key = camelCase(label);
            if (!key || taken.has(key)) continue;
            const valueCell = valueRow.cells[col];
            const valueRaw = valueCell !== null && valueCell !== undefined ? valueCell.trim() : '';
            if (!valueRaw) continue;
            fields[key] = {
                label,
                readFrom: label.endsWith(':') ? 'right' : 'below',
                kind: guessKindForRawValue(valueRaw),
            };
            taken.add(key);
        }
    }
}

/** True when text reads like a label — TitleCase / ALL CAPS, no digits. */
function isLabelShaped(text: string): boolean {
    const t = text.trim();
    if (t.length === 0 || t.length > 60) return false;
    if (/\d/.test(t)) return false;
    // Reject value-shaped tokens (currencies, dates, percentages).
    if (/^\(?[$£€¥]?[\d,.]+\)?%?$/.test(t)) return false;
    // Accept: at least one uppercase letter, majority alpha.
    if (!/[A-Z]/.test(t)) return false;
    const alpha = t.replace(/[^A-Za-z]/g, '').length;
    return alpha / t.length >= 0.5;
}

function guessKindForRawValue(raw: string): SimpleFieldKind {
    const t = raw.trim();
    if (!t) return 'string';
    if (/^\(?\s*(USD\s*)?\$/.test(t)) return 'currency';
    if (/^\(?\s*-?\d[\d,]*\.\d+\)?$/.test(t)) return 'number';
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(t) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return 'date';
    return 'string';
}

function detectStopAtAnchor(sec: AnalyzedSection): string | undefined {
    for (const row of sec.tableRows) {
        for (const cell of row.cells) {
            if (cell === null) continue;
            const raw = cell.trim();
            if (/^(Total|Grand Total|Sub-total|Total for)\b/i.test(raw)) return raw.replace(/\s*:?\s*$/, '');
        }
    }
    return undefined;
}

function guessKeyColumns(columns: SimpleTableColumnSpec[]): string[] | undefined {
    // Heuristic: first non-empty-header column is the key candidate.
    const first = columns.find((c) => c.header && c.header.trim().length > 0);
    return first ? [first.key] : undefined;
}

/**
 * Seed a `checks:` block with only the checks that can be inferred directly
 * from the sample PDF. These are facts the sample already satisfies, so
 * they roundtrip green out of the box and become drift-detectors from that
 * point forward. Consumers opt into stricter checks (security / barcodes /
 * signatures / version-diff) by editing the emitted spec.
 */
function buildStarterChecks(analyzed: AnalyzedReport): SimpleReportSpecChecks {
    const checks: SimpleReportSpecChecks = {};

    // Page-count layout check — locks the page count observed at emit-time.
    // Consumers who expect variable-length reports should remove this after
    // review; keeping it is safe for fixed-page templates (invoices, receipts).
    if (analyzed.pageCount > 0) {
        checks.layout = { pageCount: analyzed.pageCount };
    }

    // Header/footer identical-across-pages check — only enabled when the
    // observed header/footer is actually identical across all pages. This
    // avoids emitting a spec that fails on the first run for reports with
    // legitimately-varying headers (e.g. deal name in header).
    if (analyzed.pageCount >= 2) {
        const firstHeader = analyzed.pages[0]?.header?.join('|') ?? '';
        const firstFooter = analyzed.pages[0]?.footer?.join('|') ?? '';
        const identicalHeader = analyzed.pages.every((p) => (p.header ?? []).join('|') === firstHeader);
        const identicalFooter = analyzed.pages.every((p) => (p.footer ?? []).join('|') === firstFooter);
        if (identicalHeader || identicalFooter) {
            checks.headerFooter = {
                identicalHeader: identicalHeader || undefined,
                identicalFooter: identicalFooter || undefined,
            };
        }
    }

    // Placeholder / encoding / PII scan — always safe: it flags leaks the
    // sample PDF didn't have. If the sample DOES have a leak (highly unlikely
    // in production template output), the generated spec will fail on
    // first run and the consumer will see it immediately — which is the
    // right behaviour. Defaults live inside the validator; empty rule = on.
    checks.textQuality = {};

    return checks;
}
