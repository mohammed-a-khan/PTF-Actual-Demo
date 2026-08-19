/**
 * CS Report Validation — Layer 5: Diff reporter.
 *
 * Renders a self-contained HTML page from a `ReconciliationResult` (plus the
 * canonical reports it came from, plus an optional `SectionValidationResult`).
 * The page is portable — no external CSS/JS/fonts/CDN — so it survives zip-
 * and-mail workflows and CI artefact viewers with strict CSPs.
 *
 * OUTPUT SHAPE
 * ------------
 *   Header banner        — pass/fail badge, report type, entity, source A → B, timestamp.
 *   Summary tiles        — one per finding classification (total / mismatch / missing / …).
 *   Section-validator panel (when present) — pass/fail per required section, plus order issues.
 *   Findings table       — grouped into "failures" (mismatch/missing/extra) and "notes"
 *                          (format-only, within-tolerance, known-difference, restructure).
 *                          Rows expose section, key, field, both canonical values, delta,
 *                          reason. Tiny inline JS drives per-classification filter chips.
 *
 * EVERY value put on the page is HTML-escaped, including field names and reason strings —
 * data-driven reports can contain nasty raw text (a name cell containing `<script>`); the renderer
 * must never trust it.
 *
 * @module report-validation/CSReportDiffReporter
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
    CanonicalReport,
    CanonicalValue,
    Finding,
    ReconciliationCounts,
    ReconciliationResult,
} from './CSReportModel';
import type { ReportSpec } from './CSReportSpec';
import type { SectionValidationResult } from './CSReportValidationService';

/** Everything the reporter needs to render one diff. */
export interface DiffReportInput {
    /** Short label displayed in the header, e.g. `"SSRS vs Crystal"` or `"SSRS vs DB"`. */
    label: string;
    /** The active spec — used for report type, per-field tolerances, ignored-field markers. */
    spec: ReportSpec;
    /** Source A canonical (typically the reference: Crystal or DB). Optional — improves the row-context view. */
    a?: CanonicalReport;
    /** Source B canonical (typically the candidate: SSRS). Optional. */
    b?: CanonicalReport;
    /** The reconciliation output. */
    reconciliation: ReconciliationResult;
    /** Optional section validation output (from `CSReportValidationService.validateSections`). */
    sectionValidation?: SectionValidationResult;
    /** Report parameters (as-of date, currency, …). Rendered in the header banner. */
    params?: Record<string, string>;
    /** ISO-8601 timestamp shown in the footer. Defaults to render time. */
    generatedAt?: string;
}

/** Return value of `writeToFile` / `writeToRunReports`. */
export interface DiffReportWriteResult {
    filePath: string;
    fileName: string;
    byteCount: number;
}

export class CSReportDiffReporter {
    /**
     * Render one diff to an HTML string. Deterministic — same input in produces same
     * bytes out (aside from the `generatedAt` timestamp, which callers can pin via
     * `input.generatedAt` for byte-diff tests).
     */
    static render(input: DiffReportInput): string {
        return renderHtml(input);
    }

    /**
     * Render and write to `outputPath`. Creates parent directories as needed.
     * Returns the absolute path, filename, and byte count for logging.
     */
    static writeToFile(input: DiffReportInput, outputPath: string): DiffReportWriteResult {
        const html = renderHtml(input);
        const abs = path.resolve(outputPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, html, 'utf-8');
        return {
            filePath: abs,
            fileName: path.basename(abs),
            byteCount: Buffer.byteLength(html, 'utf-8'),
        };
    }

    /**
     * Render and write into the framework's current test-results `reports/` directory.
     * Filename is `report-validation-<slug>-<timestamp>.html`. Falls back to
     * `<cwd>/reports/report-validation/` when the framework isn't hosting the test.
     *
     * The framework's results manager is NOT imported at module load time — the
     * lookup is done lazily inside the method so unit tests can call `render` /
     * `writeToFile` without dragging the whole reporter singleton graph in.
     */
    static writeToRunReports(input: DiffReportInput): DiffReportWriteResult {
        const dir = resolveReportValidationOutputDir();
        const stamp = timestampSlug(input.generatedAt);
        const fileName = `report-validation-${slugify(input.label)}-${stamp}.html`;
        return CSReportDiffReporter.writeToFile(input, path.join(dir, fileName));
    }
}

// ---------------------------------------------------------------------------
// HTML rendering — kept module-local, hand-rolled string templates (no
// external template engine so the output is trivially auditable).
// ---------------------------------------------------------------------------

function renderHtml(input: DiffReportInput): string {
    const { spec, label, reconciliation, sectionValidation, a, b } = input;
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const params = input.params ?? deriveParamsFromCanonicals(a, b);
    const entity = a?.entity ?? b?.entity ?? '';
    const sourceA = describeSource(a);
    const sourceB = describeSource(b);
    const overallPassed = reconciliation.passed && (sectionValidation ? sectionValidation.passed : true);
    const statusBadge = overallPassed ? 'PASS' : 'FAIL';
    const statusClass = overallPassed ? 'status-pass' : 'status-fail';
    const title = `Report Validation — ${escapeHtml(spec.reportType)} — ${escapeHtml(label)}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${INLINE_STYLE}
</head>
<body data-status="${statusClass}">
<div class="rv-wrap">
<header class="rv-header">
  <div class="rv-verdict">
    <div class="rv-verdict-rail"></div>
    <div class="rv-verdict-body">
      <p class="rv-eyebrow">Report validation — migration parity</p>
      <div class="rv-header-main">
        <span class="rv-badge ${statusClass}">${statusBadge}</span>
        <h1>${escapeHtml(spec.reportType)}</h1>
        <span class="rv-label">${escapeHtml(label)}</span>
      </div>
      <div class="rv-flow">
        <span class="rv-flow-node">${escapeHtml(sourceA)}</span>
        <span class="rv-flow-arrow" aria-hidden="true">&rarr;</span>
        <span class="rv-flow-node">${escapeHtml(sourceB)}</span>
      </div>
    </div>
  </div>
  <dl class="rv-meta">
    ${entity ? `<div><dt>Entity</dt><dd>${escapeHtml(entity)}</dd></div>` : ''}
    <div><dt>Project</dt><dd>${escapeHtml(spec.project)}</dd></div>
    <div><dt>Source A</dt><dd>${escapeHtml(sourceA)}</dd></div>
    <div><dt>Source B</dt><dd>${escapeHtml(sourceB)}</dd></div>
    ${renderParamsBlock(params)}
    <div><dt>Generated</dt><dd>${escapeHtml(generatedAt)}</dd></div>
  </dl>
</header>

${renderScopePanel(spec, a, b)}

<section class="rv-summary">
  <h2>Differences found</h2>
  ${renderCountTiles(reconciliation.counts)}
</section>

${sectionValidation ? renderSectionPanel(sectionValidation) : ''}

<section class="rv-findings">
  <h2>Findings <span class="rv-count-inline">(${reconciliation.findings.length})</span></h2>
  ${renderFilterChips(reconciliation.counts)}
  ${renderFindingsGroup('Failures', FAILING_CLASSIFICATIONS, reconciliation.findings, spec, a, b)}
  ${renderFindingsGroup('Notes', NOTE_CLASSIFICATIONS, reconciliation.findings, spec, a, b)}
</section>

<footer class="rv-footer">
  <span>CS Playwright Test Framework — Report Validation Diff</span>
  <span>${escapeHtml(generatedAt)}</span>
</footer>
</div>
${INLINE_SCRIPT}
</body>
</html>
`;
}

/** Non-printable Unit Separator, matching the reconciler's composite-key encoding. */
const SCOPE_KEY_SEP = '\x1f';

function scopeKeyOf(record: { sectionId: string; key: Record<string, string> }, keyColumns: string[]): string {
    return [record.sectionId, ...keyColumns.map((k) => record.key?.[k] ?? '')].join(SCOPE_KEY_SEP);
}

/** One section's share of the comparison — what `computeComparisonScope` reports per section. */
export interface SectionComparisonScope {
    /** Canonical section id as it appears on the records. */
    sectionId: string;
    /** Spec title when the section is declared, otherwise the id. */
    title: string;
    /** Rows present on both sides under the same business key. */
    matched: number;
    /** Rows this section contributed on side A / side B. */
    rowsA: number;
    rowsB: number;
    /** Canonical fields that were actually compared on at least one matched row here. */
    fields: string[];
    /** Value comparisons the reconciler ran in this section. */
    comparisons: number;
    /** Calculation-block figures compared in this section (outside the row grid). */
    summaryFields: number;
}

/** Positive evidence of what a reconciliation actually looked at. See `renderScopePanel`. */
export interface ComparisonScope {
    sections: SectionComparisonScope[];
    matched: number;
    rowsA: number;
    rowsB: number;
    comparisons: number;
    /** Distinct canonical fields compared anywhere in the report. */
    fields: string[];
    /** Calculation-block figures compared across all sections. */
    summaryFields: number;
    /** True when nothing was compared — a zero-difference result would prove nothing. */
    vacuous: boolean;
}

/**
 * Reproduce the reconciler's walk WITHOUT comparing values, to count the work it did.
 *
 * Deliberately mirrors `CSReportReconciler` rather than approximating it: rows pair on the
 * composite (section + key columns) key, a field counts only when the spec declares it for
 * BOTH sources, and — as in the reconciler — a field where neither side carries a value is
 * skipped rather than counted. That last rule is what makes the number honest on a
 * multi-section report, where each section fills a different subset of the field map:
 * `rows × fieldMap.length` would claim comparisons that never happened.
 */
export function computeComparisonScope(spec: ReportSpec, a: CanonicalReport, b: CanonicalReport): ComparisonScope {
    const keyColumns = spec.keyColumns ?? [];
    const ignored = new Set(spec.ignoreFields ?? []);
    const keyed = new Set(keyColumns);
    const candidateFields = Object.keys(spec.fieldMap ?? {}).filter(
        (f) =>
            !ignored.has(f) &&
            !keyed.has(f) &&
            Boolean(spec.fieldMap[f]?.[a.source]) &&
            Boolean(spec.fieldMap[f]?.[b.source]),
    );

    const bByKey = new Map<string, CanonicalReport['records'][number]>();
    for (const r of b.records) bByKey.set(scopeKeyOf(r, keyColumns), r);

    const titleOf = new Map((spec.requiredSections ?? []).map((rs) => [rs.id, rs.title]));
    const perSection = new Map<string, SectionComparisonScope>();
    const sectionOf = (id: string): SectionComparisonScope => {
        let entry = perSection.get(id);
        if (!entry) {
            entry = { sectionId: id, title: titleOf.get(id) ?? id, matched: 0, rowsA: 0, rowsB: 0, fields: [], comparisons: 0, summaryFields: 0 };
            perSection.set(id, entry);
        }
        return entry;
    };

    for (const r of a.records) sectionOf(r.sectionId).rowsA++;
    for (const r of b.records) sectionOf(r.sectionId).rowsB++;

    const fieldsBySection = new Map<string, Set<string>>();
    for (const aRec of a.records) {
        const bRec = bByKey.get(scopeKeyOf(aRec, keyColumns));
        if (!bRec) continue;
        const entry = sectionOf(aRec.sectionId);
        entry.matched++;
        let fields = fieldsBySection.get(aRec.sectionId);
        if (!fields) {
            fields = new Set<string>();
            fieldsBySection.set(aRec.sectionId, fields);
        }
        for (const field of candidateFields) {
            if (aRec.fields[field] === undefined && bRec.fields[field] === undefined) continue;
            entry.comparisons++;
            fields.add(field);
        }
    }
    for (const [id, fields] of fieldsBySection) sectionOf(id).fields = [...fields];

    // Calculation-block figures are compared per SECTION, not per row, so they are counted
    // separately — folding them into `comparisons` would misreport them as row work.
    for (const required of spec.requiredSections ?? []) {
        const declared = required.summaryFields ?? [];
        if (declared.length === 0) continue;
        const aSection = a.sections.find((sec) => sec.id === required.id && sec.present && !sec.outOfScope);
        const bSection = b.sections.find((sec) => sec.id === required.id && sec.present && !sec.outOfScope);
        if (!aSection || !bSection) continue;
        const compared = declared.filter(
            (f) => aSection.summary?.[f.id] !== undefined || bSection.summary?.[f.id] !== undefined,
        ).length;
        if (compared > 0) sectionOf(required.id).summaryFields = compared;
    }

    const sections = [...perSection.values()]
        .filter((s) => s.matched > 0 || s.rowsA > 0 || s.rowsB > 0)
        .sort((x, y) => y.comparisons - x.comparisons || x.sectionId.localeCompare(y.sectionId));

    const allFields = new Set<string>();
    for (const sec of sections) for (const f of sec.fields) allFields.add(f);

    const matched = sections.reduce((n, s) => n + s.matched, 0);
    const comparisons = sections.reduce((n, s) => n + s.comparisons, 0);
    const summaryFields = sections.reduce((n, s) => n + s.summaryFields, 0);
    return {
        sections,
        matched,
        rowsA: a.records.length,
        rowsB: b.records.length,
        comparisons,
        fields: [...allFields],
        summaryFields,
        vacuous: comparisons === 0 && summaryFields === 0,
    };
}

/**
 * "What was actually compared" — the panel that makes a clean run legible.
 *
 * Every counter in the findings summary is a count of DIFFERENCES, so a passing run renders
 * as ten zeros: visually identical to a run that extracted nothing and compared nothing.
 * The coverage gate already makes that state fail rather than pass, but the report still has
 * to SHOW the work. This panel reports positive evidence — rows matched on the business key,
 * fields compared on them, and the resulting number of value comparisons — broken down per
 * section, so "both migrated sections were checked" is something a reader can verify rather
 * than take on trust.
 */
function renderScopePanel(spec: ReportSpec, a?: CanonicalReport, b?: CanonicalReport): string {
    if (!a || !b) return '';
    const scope = computeComparisonScope(spec, a, b);

    const tiles = [
        { label: 'Rows matched on key', value: String(scope.matched), hint: `${scope.rowsA} in A · ${scope.rowsB} in B` },
        { label: 'Sections compared', value: String(scope.sections.filter((s) => s.matched > 0).length), hint: scope.sections.filter((s) => s.matched > 0).map((s) => s.title).join(', ') || '—' },
        { label: 'Fields compared', value: String(scope.fields.length), hint: (spec.ignoreFields ?? []).length ? `${(spec.ignoreFields ?? []).length} ignored by spec` : 'none ignored' },
        { label: 'Value comparisons', value: String(scope.comparisons), hint: 'per matched row, per populated field' },
        { label: 'Calc figures', value: String(scope.summaryFields), hint: 'totals and ratios above the grids' },
    ];

    const cells = tiles
        .map(
            (t) => `<div class="rv-tile rv-tile-nonzero rv-tile-scope">
      <div class="rv-tile-value">${escapeHtml(t.value)}</div>
      <div class="rv-tile-label">${escapeHtml(t.label)}</div>
      <div class="rv-tile-hint">${escapeHtml(t.hint)}</div>
    </div>`,
        )
        .join('\n    ');

    const note = scope.vacuous
        ? `<p class="rv-scope-warn">Nothing was compared — a zero-difference result here proves nothing. Check the spec's key columns and section matchers against the source.</p>`
        : `<p class="rv-scope-note">${escapeHtml(String(scope.comparisons))} value comparisons ran across ${escapeHtml(String(scope.matched))} matched rows. The counters below are what disagreed.</p>`;

    const breakdown = scope.sections.length === 0 ? '' : `<div class="rv-table-wrap">
    <table class="rv-scope-table">
      <thead><tr><th>Section</th><th>Rows A</th><th>Rows B</th><th>Matched</th><th>Fields</th><th>Comparisons</th><th>Calc figures</th></tr></thead>
      <tbody>
        ${scope.sections
            .map(
                (sec) => `<tr${sec.matched === 0 ? ' class="rv-scope-empty"' : ''}>` +
                    `<td>${escapeHtml(sec.title)}</td>` +
                    `<td class="rv-num">${sec.rowsA}</td>` +
                    `<td class="rv-num">${sec.rowsB}</td>` +
                    `<td class="rv-num">${sec.matched}</td>` +
                    `<td class="rv-num">${sec.fields.length}</td>` +
                    `<td class="rv-num">${sec.comparisons}</td>` +
                    `<td class="rv-num">${sec.summaryFields}</td>` +
                    `</tr>`,
            )
            .join('\n        ')}
      </tbody>
    </table>
  </div>`;

    return `<section class="rv-sections rv-scope">
  <h2>What was compared</h2>
  <div class="rv-tiles">
    ${cells}
  </div>
  ${breakdown}
  ${note}
</section>`;
}

const FAILING_CLASSIFICATIONS = ['DATA_MISMATCH', 'MISSING', 'EXTRA', 'FOOTING_MISMATCH', 'CHECKSUM_DRIFT'] as const;
const NOTE_CLASSIFICATIONS = ['FORMAT_ONLY', 'WITHIN_TOLERANCE', 'KNOWN_DIFFERENCE', 'SECTION_RESTRUCTURE'] as const;

function renderCountTiles(counts: ReconciliationCounts): string {
    const tiles: Array<{ label: string; value: number; kind: string }> = [
        { label: 'Total findings', value: counts.total, kind: 'total' },
        { label: 'Data mismatch', value: counts.dataMismatch, kind: 'mismatch' },
        { label: 'Missing', value: counts.missing, kind: 'missing' },
        { label: 'Extra', value: counts.extra, kind: 'extra' },
        { label: 'Format only', value: counts.formatOnly, kind: 'format' },
        { label: 'Within tolerance', value: counts.withinTolerance, kind: 'tolerance' },
        { label: 'Known difference', value: counts.knownDifference, kind: 'known' },
        { label: 'Section restructure', value: counts.sectionRestructure, kind: 'restructure' },
        { label: 'Checksum drift', value: counts.checksumDrift, kind: 'checksum' },
        { label: 'Footing mismatch', value: counts.footingMismatch, kind: 'footing' },
    ];
    return `<div class="rv-tiles">${tiles
        .map(
            (t) =>
                `<div class="rv-tile rv-tile-${t.kind}${t.value > 0 ? ' rv-tile-nonzero' : ''}">` +
                `<div class="rv-tile-value">${t.value}</div>` +
                `<div class="rv-tile-label">${escapeHtml(t.label)}</div>` +
                `</div>`,
        )
        .join('')}</div>`;
}

function renderFilterChips(counts: ReconciliationCounts): string {
    const chips: Array<{ classification: string; label: string; count: number }> = [
        { classification: '*', label: 'All', count: counts.total },
        { classification: 'DATA_MISMATCH', label: 'Mismatch', count: counts.dataMismatch },
        { classification: 'MISSING', label: 'Missing', count: counts.missing },
        { classification: 'EXTRA', label: 'Extra', count: counts.extra },
        { classification: 'FORMAT_ONLY', label: 'Format only', count: counts.formatOnly },
        { classification: 'WITHIN_TOLERANCE', label: 'Within tol.', count: counts.withinTolerance },
        { classification: 'KNOWN_DIFFERENCE', label: 'Known', count: counts.knownDifference },
        { classification: 'SECTION_RESTRUCTURE', label: 'Restructure', count: counts.sectionRestructure },
        { classification: 'CHECKSUM_DRIFT', label: 'Checksum', count: counts.checksumDrift },
    ];
    return `<div class="rv-chips" role="tablist">${chips
        .map(
            (c, i) =>
                `<button type="button" class="rv-chip${i === 0 ? ' rv-chip-active' : ''}" ` +
                `data-classification="${escapeHtml(c.classification)}" role="tab">` +
                `${escapeHtml(c.label)} <span class="rv-chip-count">${c.count}</span></button>`,
        )
        .join('')}</div>`;
}

function renderFindingsGroup(
    heading: string,
    kinds: readonly string[],
    findings: Finding[],
    spec: ReportSpec,
    a?: CanonicalReport,
    b?: CanonicalReport,
): string {
    const group = findings.filter((f) => (kinds as readonly string[]).includes(f.classification));
    if (group.length === 0) {
        return `<div class="rv-group"><h3>${escapeHtml(heading)}</h3><p class="rv-empty">No findings in this group.</p></div>`;
    }
    return `<div class="rv-group"><h3>${escapeHtml(heading)} <span class="rv-count-inline">(${group.length})</span></h3>
<div class="rv-table-wrap">
<table class="rv-table">
  <thead>
    <tr>
      <th>Classification</th>
      <th>Section</th>
      <th>Key</th>
      <th>Field</th>
      <th>Source A</th>
      <th>Source B</th>
      <th>Delta / Reason</th>
    </tr>
  </thead>
  <tbody>
    ${group.map((f) => renderFindingRow(f, spec, a, b)).join('\n    ')}
  </tbody>
</table>
</div>
</div>`;
}

function renderFindingRow(
    finding: Finding,
    spec: ReportSpec,
    _a?: CanonicalReport,
    _b?: CanonicalReport,
): string {
    const keyStr = compositeKeyDisplay(finding.key);
    const deltaOrReason =
        finding.delta !== undefined ? formatDelta(finding.delta) : finding.reason ? escapeHtml(finding.reason) : '';
    const fieldName = finding.field ?? '';
    const tolerance = fieldName && spec.tolerances[fieldName] ? renderToleranceBadge(spec.tolerances[fieldName]) : '';
    return `<tr class="rv-row rv-row-${classToCss(finding.classification)}" data-classification="${escapeHtml(finding.classification)}" data-id="${escapeHtml(finding.id)}">
      <td><span class="rv-tag rv-tag-${classToCss(finding.classification)}">${escapeHtml(finding.classification)}</span></td>
      <td>${escapeHtml(finding.section)}</td>
      <td class="rv-mono">${escapeHtml(keyStr)}</td>
      <td>${escapeHtml(fieldName)}${tolerance}</td>
      <td class="rv-mono">${renderValueCell(finding.aValue)}</td>
      <td class="rv-mono">${renderValueCell(finding.bValue)}</td>
      <td>${deltaOrReason}</td>
    </tr>`;
}

function renderValueCell(v?: CanonicalValue): string {
    if (!v) return '<span class="rv-nil">—</span>';
    switch (v.kind) {
        case 'null':
            return `<span class="rv-nil" title="raw: ${escapeAttr(v.raw)}">null</span>`;
        case 'number': {
            const rawEsc = escapeHtml(v.raw);
            const normalized = String(v.value);
            return normalized === v.raw
                ? rawEsc
                : `${rawEsc} <span class="rv-norm">(${escapeHtml(normalized)})</span>`;
        }
        case 'date': {
            const rawEsc = escapeHtml(v.raw);
            return v.value === v.raw ? rawEsc : `${rawEsc} <span class="rv-norm">(${escapeHtml(v.value)})</span>`;
        }
        case 'string':
            return escapeHtml(v.raw);
    }
}

function renderToleranceBadge(
    t: { type: 'number'; epsilon?: number; relative?: number } | { type: 'string'; fuzzy?: number },
): string {
    if (t.type === 'number') {
        const parts: string[] = [];
        if (t.epsilon !== undefined) parts.push(`ε=${t.epsilon}`);
        if (t.relative !== undefined) parts.push(`rel=${t.relative}`);
        if (parts.length === 0) return '';
        return ` <span class="rv-badge-small" title="Tolerance">${escapeHtml(parts.join(' '))}</span>`;
    }
    if (t.fuzzy !== undefined) return ` <span class="rv-badge-small" title="Fuzzy string threshold">fuzzy≥${escapeHtml(String(t.fuzzy))}</span>`;
    return '';
}

function renderSectionPanel(sv: SectionValidationResult): string {
    const rowFor = (id: string, kind: 'present' | 'missing') =>
        `<tr class="rv-section-${kind}"><td>${escapeHtml(id)}</td><td>${kind === 'present' ? '✓ present' : '✗ missing'}</td></tr>`;
    const rows = [
        ...sv.presentSections.map((id) => rowFor(id, 'present')),
        ...sv.missingSections.map((id) => rowFor(id, 'missing')),
    ].join('\n');
    const orderIssues = sv.orderIssues.length
        ? `<ul class="rv-order-issues">${sv.orderIssues.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`
        : '';
    const badgeClass = sv.passed ? 'status-pass' : 'status-fail';
    return `<section class="rv-sections">
  <h2>Required sections <span class="rv-badge ${badgeClass}">${sv.passed ? 'OK' : 'ISSUES'}</span></h2>
  ${rows ? `<table class="rv-table rv-table-compact"><thead><tr><th>Section id</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="rv-empty">No required sections declared on the spec.</p>'}
  ${orderIssues}
</section>`;
}

function renderParamsBlock(params: Record<string, string> | undefined): string {
    if (!params) return '';
    const entries = Object.entries(params);
    if (entries.length === 0) return '';
    const dl = entries
        .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
        .join('');
    return `<div class="rv-params">${dl}</div>`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeSource(canonical?: CanonicalReport): string {
    if (!canonical) return '(not provided)';
    return `${canonical.source} (${canonical.format}) — ${canonical.records.length} record(s)`;
}

function deriveParamsFromCanonicals(a?: CanonicalReport, b?: CanonicalReport): Record<string, string> | undefined {
    // Prefer A's params (typically the reference). Fall through to B when A absent.
    if (a && a.params && Object.keys(a.params).length > 0) return a.params;
    if (b && b.params && Object.keys(b.params).length > 0) return b.params;
    return undefined;
}

function compositeKeyDisplay(key: Record<string, string>): string {
    const entries = Object.entries(key);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}=${v}`).join(' | ');
}

function formatDelta(delta: number): string {
    const sign = delta > 0 ? '+' : '';
    // Show up to 6 significant digits without scientific notation for typical report deltas.
    const magnitude = Math.abs(delta);
    let shown: string;
    if (magnitude === 0) shown = '0';
    else if (magnitude >= 1) shown = delta.toFixed(Math.min(6, Math.max(2, 4 - Math.floor(Math.log10(magnitude)))));
    else shown = delta.toPrecision(4);
    return `<span class="rv-delta">Δ ${escapeHtml(sign + shown)}</span>`;
}

function classToCss(classification: string): string {
    return classification.toLowerCase().replace(/_/g, '-');
}

function slugify(s: string): string {
    return (s || 'diff').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diff';
}

function timestampSlug(iso?: string): string {
    const src = iso ?? new Date().toISOString();
    return src.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

/**
 * Where this run's report-validation artefacts go — the diff report and, alongside it, the
 * canonical extraction dumps written by `CSReportCanonicalDumper`. Exported so both writers
 * land in one folder without either owning the convention.
 *
 * The framework's results manager is resolved lazily inside the function so unit tests can
 * render without dragging the reporter singleton graph in.
 */
export function resolveReportValidationOutputDir(): string {
    try {
        const { CSTestResultsManager } = require('../reporter/CSTestResultsManager');
        const dirs = CSTestResultsManager.getInstance().getDirectories();
        // `dirs.reportValidation` sits directly under the run directory, beside
        // screenshots/ and traces/. Joining onto `dirs.reports` instead — which is the
        // run's HTML-report folder — is what produced `.../reports/report-validation/`.
        if (dirs.reportValidation) return dirs.reportValidation;
        // Older results manager without the declared path: derive the sibling ourselves
        // rather than nesting under the HTML-report folder.
        if (dirs.base) return path.join(dirs.base, 'report-validation');
        return path.join(process.cwd(), 'reports', 'report-validation');
    } catch {
        // Framework harness not booted — fall back to a cwd-local convention.
        return path.join(process.cwd(), 'reports', 'report-validation');
    }
}

/**
 * HTML-escape for element text content. Also handles attribute-safe rendering — quotes are
 * escaped so the same helper works inside attribute values.
 */
function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Attribute-only escape (title="…"). Same behaviour as escapeHtml today; kept named for intent. */
function escapeAttr(s: string): string {
    return escapeHtml(s);
}

// ---------------------------------------------------------------------------
// Inline CSS + JS — kept as constants at file end to keep the render function
// readable. No external assets; no CDN; the page opens standalone via file://.
// ---------------------------------------------------------------------------

const INLINE_STYLE = `<style>
*, *::before, *::after { box-sizing: border-box; }

:root {
  --bg: #f4f6f9;
  --panel: #ffffff;
  --panel-2: #eef1f6;
  --ink: #141821;
  --ink-2: #444d5e;
  --muted: #6b7482;
  --line: #dfe3ea;
  --line-2: #c8cfda;

  --pass: #0f7a4d;  --pass-bg: #e6f4ec;
  --fail: #c0392b;  --fail-bg: #fbeae8;
  --warn: #9a6600;  --warn-bg: #fbf1de;
  --info: #24558f;  --info-bg: #e6eef8;

  --tag-mismatch: #c0392b; --tag-missing: #9a6600; --tag-extra: #6d3fa8;
  --tag-format: #24558f;   --tag-tol: #0d6b78;    --tag-known: #0f7a4d; --tag-restr: #6b7482;

  --shadow: 0 1px 1px rgba(20,24,33,.04), 0 4px 16px -8px rgba(20,24,33,.18);
  --radius: 10px;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116; --panel: #171b22; --panel-2: #1f242e;
    --ink: #e7eaf0; --ink-2: #b3bac7; --muted: #8b94a3;
    --line: #262c37; --line-2: #39414f;
    --pass: #4cbf87; --pass-bg: #12241b;
    --fail: #ef8378; --fail-bg: #2a1917;
    --warn: #d8a44f; --warn-bg: #2a2113;
    --info: #7aa9e8; --info-bg: #151f2c;
    --tag-mismatch: #ef8378; --tag-missing: #d8a44f; --tag-extra: #b294e0;
    --tag-format: #7aa9e8; --tag-tol: #52b6c4; --tag-known: #4cbf87; --tag-restr: #8b94a3;
    --shadow: 0 1px 1px rgba(0,0,0,.4), 0 6px 20px -10px rgba(0,0,0,.7);
  }
}

body {
  margin: 0; padding: 28px 24px 56px; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 14px; line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
.rv-wrap { max-width: 1240px; margin: 0 auto; }

/* ---------- verdict hero ---------- */
.rv-header {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); overflow: hidden;
}
.rv-verdict { display: flex; align-items: stretch; gap: 0; border-bottom: 1px solid var(--line); }
.rv-verdict-rail { width: 6px; flex: none; background: var(--muted); }
body[data-status="status-pass"] .rv-verdict-rail { background: var(--pass); }
body[data-status="status-fail"] .rv-verdict-rail { background: var(--fail); }
.rv-verdict-body { padding: 20px 24px; flex: 1; min-width: 0; }
.rv-header-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rv-header-main h1 {
  font-size: 21px; margin: 0; font-weight: 650; letter-spacing: -.012em;
}
.rv-label { color: var(--muted); font-weight: 500; font-size: 14px; }
.rv-eyebrow {
  font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 8px;
}
.rv-badge {
  display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 5px;
  font-weight: 700; font-size: 12px; letter-spacing: .07em;
}
.status-pass { background: var(--pass-bg); color: var(--pass); box-shadow: inset 0 0 0 1px var(--pass); }
.status-fail { background: var(--fail-bg); color: var(--fail); box-shadow: inset 0 0 0 1px var(--fail); }

.rv-flow {
  margin-top: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-family: var(--mono); font-size: 12.5px; color: var(--ink-2);
}
.rv-flow-node {
  padding: 5px 11px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--panel-2);
}
.rv-flow-arrow { color: var(--muted); font-size: 15px; }

.rv-meta {
  margin: 0; padding: 14px 24px 16px; background: var(--panel-2);
  display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px 28px;
}
.rv-meta > div { display: flex; flex-direction: column; min-width: 0; }
.rv-meta dt { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
.rv-meta dd { margin: 3px 0 0; word-break: break-word; font-size: 13px; }
.rv-params { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px 28px; }

/* ---------- panels ---------- */
.rv-summary, .rv-sections, .rv-findings {
  margin-top: 18px; background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px 22px; box-shadow: var(--shadow);
}
.rv-summary h2, .rv-sections h2, .rv-findings h2 {
  margin: 0 0 14px; font-size: 13px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2);
}
.rv-count-inline { color: var(--muted); font-weight: 500; letter-spacing: 0; text-transform: none; }

/* ---------- stat tiles ---------- */
.rv-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.rv-tile {
  border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px;
  background: var(--panel); opacity: .5; transition: opacity .15s ease;
}
.rv-tile-nonzero { opacity: 1; }
.rv-tile-value { font-size: 27px; font-weight: 680; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
.rv-tile-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; font-weight: 600; }
.rv-tile-hint { font-size: 11px; color: var(--muted); margin-top: 5px; word-break: break-word; font-family: var(--mono); }

.rv-tile-mismatch.rv-tile-nonzero { border-color: var(--tag-mismatch); background: var(--fail-bg); }
.rv-tile-mismatch.rv-tile-nonzero .rv-tile-value { color: var(--tag-mismatch); }
.rv-tile-missing.rv-tile-nonzero { border-color: var(--tag-missing); background: var(--warn-bg); }
.rv-tile-missing.rv-tile-nonzero .rv-tile-value { color: var(--tag-missing); }
.rv-tile-extra.rv-tile-nonzero { border-color: var(--tag-extra); }
.rv-tile-extra.rv-tile-nonzero .rv-tile-value { color: var(--tag-extra); }
.rv-tile-checksum.rv-tile-nonzero { border-color: var(--tag-mismatch); }
.rv-tile-checksum.rv-tile-nonzero .rv-tile-value { color: var(--tag-mismatch); }
.rv-tile-footing.rv-tile-nonzero { border-color: var(--tag-mismatch); }
.rv-tile-footing.rv-tile-nonzero .rv-tile-value { color: var(--tag-mismatch); }
.rv-tile-total.rv-tile-nonzero { border-color: var(--line-2); }

/* ---------- scope panel ---------- */
.rv-scope { border-left: 3px solid var(--info); }
.rv-scope .rv-tile-scope { border-color: var(--info); background: var(--info-bg); }
.rv-scope .rv-tile-scope .rv-tile-value { color: var(--info); }
.rv-scope-note { margin: 14px 0 0; color: var(--ink-2); font-size: 13px; }
.rv-scope-warn {
  margin: 14px 0 0; color: var(--fail); font-size: 13px; font-weight: 600;
  background: var(--fail-bg); border: 1px solid var(--fail); border-radius: 7px; padding: 10px 13px;
}
.rv-scope .rv-table-wrap { margin-top: 16px; }
.rv-scope-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rv-scope-table th, .rv-scope-table td {
  padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap;
}
.rv-scope-table th {
  position: sticky; top: 0; background: var(--panel); z-index: 1;
  font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 650;
}
.rv-scope-table td.rv-num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.rv-scope-table tbody tr:last-child td { border-bottom: 0; }
/* A section with rows on one side and none matched is the shape of a mapping bug — the
   comparison silently covered nothing there. Flag it rather than letting it read as a row
   of zeros among healthy ones. */
.rv-scope-empty td { color: var(--fail); background: var(--fail-bg); }

/* ---------- filter chips ---------- */
.rv-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.rv-chip {
  background: transparent; border: 1px solid var(--line-2); color: var(--ink-2);
  padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 550;
  cursor: pointer; font-family: inherit; transition: background .12s, color .12s, border-color .12s;
}
.rv-chip:hover { border-color: var(--ink-2); }
.rv-chip:focus-visible { outline: 2px solid var(--info); outline-offset: 2px; }
.rv-chip-active { background: var(--ink); color: var(--panel); border-color: var(--ink); }
.rv-chip-count { color: var(--muted); margin-left: 5px; font-variant-numeric: tabular-nums; }
.rv-chip-active .rv-chip-count { color: inherit; opacity: .75; }

/* ---------- groups + table ---------- */
.rv-group { margin-top: 16px; }
.rv-group h3 { margin: 0 0 10px; font-size: 13.5px; font-weight: 650; }
.rv-empty { color: var(--muted); font-style: italic; margin: 0; font-size: 13px; }

.rv-table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
.rv-table { border-collapse: collapse; width: 100%; font-size: 13px; min-width: 900px; }
.rv-table th {
  position: sticky; top: 0; z-index: 1;
  text-align: left; padding: 10px 13px; background: var(--panel-2);
  border-bottom: 1px solid var(--line-2); color: var(--muted);
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; font-weight: 650; white-space: nowrap;
}
.rv-table td { padding: 9px 13px; border-bottom: 1px solid var(--line); vertical-align: top; }
.rv-table tbody tr:last-child td { border-bottom: none; }
.rv-table tbody tr:nth-child(even) { background: rgba(127,127,127,.035); }
.rv-table-compact { min-width: 0; }
.rv-mono { font-family: var(--mono); font-size: 12px; }

.rv-tag {
  display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10.5px;
  font-weight: 700; letter-spacing: .04em; color: #fff; white-space: nowrap;
}
.rv-tag-data-mismatch { background: var(--tag-mismatch); }
.rv-tag-missing { background: var(--tag-missing); }
.rv-tag-extra { background: var(--tag-extra); }
.rv-tag-format-only { background: var(--tag-format); }
.rv-tag-within-tolerance { background: var(--tag-tol); }
.rv-tag-known-difference { background: var(--tag-known); }
.rv-tag-section-restructure { background: var(--tag-restr); }
.rv-tag-checksum-drift { background: var(--tag-mismatch); }
.rv-tag-footing-mismatch { background: var(--tag-mismatch); }
.rv-tag-coverage-gap { background: var(--tag-missing); }
@media (prefers-color-scheme: dark) { .rv-tag { color: #10131a; } }

.rv-badge-small {
  display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 4px;
  background: rgba(127,127,127,.16); color: var(--muted); font-size: 10.5px; font-family: var(--mono);
}
.rv-nil { color: var(--muted); font-style: italic; }
.rv-norm { color: var(--muted); font-size: 11px; }
.rv-delta { font-family: var(--mono); color: var(--warn); font-variant-numeric: tabular-nums; }
.rv-order-issues { margin: 8px 0 0; padding-left: 20px; color: var(--warn); }
.rv-section-missing td:first-child { color: var(--fail); font-weight: 600; }
.rv-footer {
  margin-top: 22px; color: var(--muted); font-size: 11.5px;
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  border-top: 1px solid var(--line); padding-top: 14px;
}
.rv-row.rv-hidden { display: none; }

@media (max-width: 640px) {
  body { padding: 16px 12px 40px; }
  .rv-verdict-body, .rv-meta { padding-left: 16px; padding-right: 16px; }
  .rv-summary, .rv-sections, .rv-findings { padding: 14px 16px; }
}
@media print {
  body { background: #fff; padding: 0; }
  .rv-chips { display: none; }
  .rv-summary, .rv-sections, .rv-findings, .rv-header { box-shadow: none; break-inside: avoid; }
}
</style>`;

const INLINE_SCRIPT = `<script>
(function() {
  var chips = document.querySelectorAll('.rv-chip');
  var rows = document.querySelectorAll('tr.rv-row');
  function applyFilter(cls) {
    for (var i = 0; i < rows.length; i++) {
      var rowCls = rows[i].getAttribute('data-classification');
      if (cls === '*' || rowCls === cls) rows[i].classList.remove('rv-hidden');
      else rows[i].classList.add('rv-hidden');
    }
  }
  for (var i = 0; i < chips.length; i++) {
    (function(chip) {
      chip.addEventListener('click', function() {
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove('rv-chip-active');
        chip.classList.add('rv-chip-active');
        applyFilter(chip.getAttribute('data-classification'));
      });
    })(chips[i]);
  }
})();
</script>`;
