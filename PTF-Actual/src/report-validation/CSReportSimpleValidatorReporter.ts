/**
 * HTML report renderer for the SimpleReportSpec validator.
 *
 * Takes a `ValidationResult` (from `validatePdfAgainstSpec`) and produces a
 * single-file, self-contained HTML page grouped by:
 *
 *   - **Summary chip strip** — quick pass/fail + per-phase counters
 *   - **Field findings** — extracted vs expected + per-field formatting drift
 *   - **Table findings** — row-level diff for each table
 *   - **Phase-1 findings** — metadata / links / header-footer / watermarks /
 *     layout / integrity / text-quality
 *   - **Phase-3 findings** — structural / interactive / attachments / table-depth
 *   - **Phase-4 findings** — images / contrast / chart regions / visual-regression
 *   - **Phase-5 findings** — security / barcodes
 *   - **Phase-6 findings** — version diff
 *
 * The HTML is inline-styled and JS-free so the file drops into email / ADO
 * comments / GitHub artifacts without extra hosting.
 *
 * @module report-validation/CSReportSimpleValidatorReporter
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ValidationResult } from './CSReportSimpleValidator';

export interface SimpleValidatorReporterOptions {
    /** Where to write the report file. */
    outputPath: string;
    /** Optional page title. Default: "PDF Validation Report — <spec.name>". */
    title?: string;
    /** If true, also write a machine-readable JSON copy next to the HTML. */
    writeJsonCopy?: boolean;
}

export interface SimpleValidatorReportWriteResult {
    htmlPath: string;
    jsonPath?: string;
    passed: boolean;
    findingCount: number;
}

export function writeSimpleValidatorHtmlReport(
    result: ValidationResult,
    opts: SimpleValidatorReporterOptions,
): SimpleValidatorReportWriteResult {
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    const title = opts.title ?? `PDF Validation Report — ${result.summary.specName}`;
    const html = renderReport(result, title);
    fs.writeFileSync(opts.outputPath, html, 'utf8');

    let jsonPath: string | undefined;
    if (opts.writeJsonCopy) {
        jsonPath = opts.outputPath.replace(/\.html?$/i, '.json');
        fs.writeFileSync(jsonPath, JSON.stringify(result, undefined, 2), 'utf8');
    }
    const findingCount = countAllFindings(result);
    return { htmlPath: opts.outputPath, jsonPath, passed: result.summary.passed, findingCount };
}

function countAllFindings(r: ValidationResult): number {
    return (
        r.fields.filter((f) => f.status !== 'match' && f.status !== 'informational').length +
        r.tables.filter((t) => t.status !== 'match').length +
        r.phase1.metadata.length +
        r.phase1.links.length +
        r.phase1.headerFooter.length +
        r.phase1.watermarks.length +
        r.phase1.layout.length +
        r.phase1.integrity.length +
        r.phase1.textQuality.length +
        r.phase3.structural.length +
        r.phase3.interactive.length +
        r.phase3.attachments.length +
        r.phase3.tableDepthFindings.length +
        r.phase4.images.length +
        r.phase4.contrast.length +
        r.phase4.chartRegions.length +
        r.phase4.visualRegression.length +
        r.phase5.security.length +
        r.phase5.barcodes.length +
        r.phase6.versionDiff.length
    );
}

function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderReport(r: ValidationResult, title: string): string {
    const passClass = r.summary.passed ? 'ok' : 'fail';
    const passLabel = r.summary.passed ? 'PASSED' : 'FAILED';
    const totalFindings = countAllFindings(r);
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
  --card: #f9fafb; --ok: #16a34a; --fail: #dc2626; --warn: #f59e0b;
  --code: #f3f4f6; --link: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0b1220; --fg: #e5e7eb; --muted: #9ca3af; --border: #1f2937;
    --card: #111827; --ok: #22c55e; --fail: #ef4444; --warn: #fbbf24;
    --code: #0f172a; --link: #60a5fa;
  }
}
:root[data-theme="dark"] {
  --bg: #0b1220; --fg: #e5e7eb; --muted: #9ca3af; --border: #1f2937;
  --card: #111827; --ok: #22c55e; --fail: #ef4444; --warn: #fbbf24;
  --code: #0f172a; --link: #60a5fa;
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
       margin: 0; background: var(--bg); color: var(--fg); line-height: 1.5; }
.container { max-width: 1100px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-weight: 600;
         font-size: 12px; letter-spacing: 0.05em; }
.badge.ok { background: var(--ok); color: white; }
.badge.fail { background: var(--fail); color: white; }
.badge.warn { background: var(--warn); color: white; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 20px; }
.chip { padding: 6px 12px; background: var(--card); border: 1px solid var(--border);
        border-radius: 6px; font-size: 12px; }
.chip strong { color: var(--fg); }
.chip.zero { color: var(--muted); }
.chip.hit { border-color: var(--fail); }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border);
         vertical-align: top; }
th { background: var(--card); font-weight: 600; }
td.mono, code { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 12px;
                background: var(--code); padding: 2px 4px; border-radius: 3px; }
.row-fail { background: rgba(220,38,38,0.05); }
.row-ok { }
.wrap-x { overflow-x: auto; }
details { border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin: 8px 0;
          background: var(--card); }
summary { cursor: pointer; font-weight: 600; }
.k { color: var(--muted); }
.warning-block { background: rgba(245,158,11,0.08); border-left: 3px solid var(--warn);
                 padding: 8px 12px; margin: 12px 0; border-radius: 3px; font-size: 13px; }
</style>
</head>
<body>
<div class="container">
  <h1>${esc(title)}</h1>
  <div class="meta">
    PDF: <code>${esc(r.summary.pdfPath)}</code><br>
    Spec: <code>${esc(r.summary.specName)}</code>
    &nbsp;·&nbsp; <span class="badge ${passClass}">${passLabel}</span>
    &nbsp;·&nbsp; ${totalFindings} finding${totalFindings === 1 ? '' : 's'}
  </div>

  ${renderChips(r)}
  ${renderWarnings(r)}
  ${renderFieldsSection(r)}
  ${renderTablesSection(r)}
  ${renderPhase1(r)}
  ${renderPhase3(r)}
  ${renderPhase4(r)}
  ${renderPhase5(r)}
  ${renderPhase6(r)}
</div>
</body>
</html>`;
}

function renderChips(r: ValidationResult): string {
    const s = r.summary;
    const chip = (label: string, n: number): string =>
        `<span class="chip ${n === 0 ? 'zero' : 'hit'}"><strong>${n}</strong> ${esc(label)}</span>`;
    return `<div class="chips">
    ${chip('field mismatches', s.fieldMismatches)}
    ${chip('missing fields', s.fieldMissing)}
    ${chip('table mismatches', s.tableMismatches)}
    ${chip('format drifts', s.formattingDriftCount)}
    ${chip('metadata', r.phase1.metadata.length)}
    ${chip('links', r.phase1.links.length)}
    ${chip('header/footer', r.phase1.headerFooter.length)}
    ${chip('watermarks', r.phase1.watermarks.length)}
    ${chip('layout', r.phase1.layout.length)}
    ${chip('integrity', r.phase1.integrity.length)}
    ${chip('text quality', r.phase1.textQuality.length)}
    ${chip('structural', r.phase3.structural.length)}
    ${chip('interactive', r.phase3.interactive.length)}
    ${chip('attachments', r.phase3.attachments.length)}
    ${chip('table depth', r.phase3.tableDepthFindings.length)}
    ${chip('images', r.phase4.images.length)}
    ${chip('contrast', r.phase4.contrast.length)}
    ${chip('chart regions', r.phase4.chartRegions.length)}
    ${chip('visual regression', r.phase4.visualRegression.length)}
    ${chip('security', r.phase5.security.length)}
    ${chip('barcodes', r.phase5.barcodes.length)}
    ${chip('version diff', r.phase6.versionDiff.length)}
  </div>`;
}

function renderWarnings(r: ValidationResult): string {
    if (!r.warnings.length) return '';
    return `<div class="warning-block">
    <strong>Warnings (${r.warnings.length}):</strong>
    <ul style="margin: 4px 0 0 16px; padding: 0;">
      ${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('\n      ')}
    </ul>
  </div>`;
}

function renderFieldsSection(r: ValidationResult): string {
    if (r.fields.length === 0) return '';
    const rows = r.fields
        .map((f) => {
            const bad = f.status !== 'match' && f.status !== 'informational';
            const formattingHtml =
                f.formattingFindings && f.formattingFindings.length > 0
                    ? `<br><small class="k">${f.formattingFindings
                          .map((ff) => `${esc(ff.kind)}: ${esc(ff.message)}`)
                          .join('; ')}</small>`
                    : '';
            return `<tr class="${bad ? 'row-fail' : 'row-ok'}">
    <td>${esc(f.name)}</td>
    <td>${esc(f.status)}</td>
    <td class="mono">${esc(f.extracted ?? '')}</td>
    <td class="mono">${esc(f.expected ?? '')}</td>
    <td>${esc(f.reason ?? '')}${formattingHtml}</td>
  </tr>`;
        })
        .join('\n');
    return `<h2>Fields (${r.fields.length})</h2>
  <div class="wrap-x"><table>
    <thead><tr><th>Name</th><th>Status</th><th>Extracted</th><th>Expected</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderTablesSection(r: ValidationResult): string {
    if (r.tables.length === 0) return '';
    return r.tables
        .map((t) => {
            const rows = t.rows
                .map((rf) => {
                    const bad = rf.status !== 'match';
                    const cellDiffs =
                        rf.cellDiffs && rf.cellDiffs.length > 0
                            ? `<ul style="margin:0;">${rf.cellDiffs
                                  .map(
                                      (c) =>
                                          `<li><code>${esc(c.column)}</code>: ${esc(c.extracted)} ≠ ${esc(c.expected)}</li>`,
                                  )
                                  .join('')}</ul>`
                            : '';
                    return `<tr class="${bad ? 'row-fail' : 'row-ok'}">
      <td>${esc(rf.rowKey)}</td>
      <td>${esc(rf.status)}</td>
      <td>${cellDiffs}</td>
    </tr>`;
                })
                .join('\n');
            return `<h2>Table: ${esc(t.name)} (${t.extractedRowCount} extracted / ${t.expectedRowCount} expected)</h2>
    <div class="wrap-x"><table>
      <thead><tr><th>Row key</th><th>Status</th><th>Cell diffs</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
        })
        .join('\n');
}

function renderFindingTable(sectionName: string, findings: Array<Record<string, unknown>>): string {
    if (findings.length === 0) return '';
    const cols = collectColumns(findings);
    return `<h2>${esc(sectionName)} (${findings.length})</h2>
  <div class="wrap-x"><table>
    <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${findings
        .map(
            (f) =>
                `<tr class="row-fail">${cols
                    .map((c) => `<td class="mono">${esc(f[c] ?? '')}</td>`)
                    .join('')}</tr>`,
        )
        .join('\n')}</tbody>
  </table></div>`;
}

function collectColumns(findings: Array<Record<string, unknown>>): string[] {
    const seen = new Set<string>();
    const order = ['kind', 'message', 'expected', 'actual', 'page', 'fieldName', 'filename', 'imageName', 'text'];
    for (const f of findings) for (const k of Object.keys(f)) seen.add(k);
    const cols = order.filter((c) => seen.has(c));
    // Append anything else the caller emitted at the end so nothing is hidden.
    for (const k of seen) if (!cols.includes(k)) cols.push(k);
    return cols;
}

function renderPhase1(r: ValidationResult): string {
    return [
        renderFindingTable('Phase 1 — Metadata', r.phase1.metadata as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 1 — Links', r.phase1.links as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 1 — Header/Footer', r.phase1.headerFooter as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 1 — Watermarks', r.phase1.watermarks as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 1 — Layout', r.phase1.layout as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 1 — Integrity', r.phase1.integrity as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 1 — Text quality', r.phase1.textQuality as unknown as Array<Record<string, unknown>>),
    ].join('\n');
}

function renderPhase3(r: ValidationResult): string {
    return [
        renderFindingTable('Phase 3 — Structural', r.phase3.structural as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 3 — Interactive', r.phase3.interactive as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 3 — Attachments', r.phase3.attachments as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 3 — Table depth', r.phase3.tableDepthFindings as unknown as Array<Record<string, unknown>>),
    ].join('\n');
}

function renderPhase4(r: ValidationResult): string {
    return [
        renderFindingTable('Phase 4 — Images', r.phase4.images as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 4 — Contrast (WCAG)', r.phase4.contrast as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 4 — Chart regions', r.phase4.chartRegions as unknown as Array<Record<string, unknown>>),
        renderFindingTable(
            'Phase 4 — Visual regression',
            r.phase4.visualRegression as unknown as Array<Record<string, unknown>>,
        ),
    ].join('\n');
}

function renderPhase5(r: ValidationResult): string {
    return [
        renderFindingTable('Phase 5 — Security', r.phase5.security as unknown as Array<Record<string, unknown>>),
        renderFindingTable('Phase 5 — Barcodes', r.phase5.barcodes as unknown as Array<Record<string, unknown>>),
    ].join('\n');
}

function renderPhase6(r: ValidationResult): string {
    return renderFindingTable(
        'Phase 6 — Version diff',
        r.phase6.versionDiff as unknown as Array<Record<string, unknown>>,
    );
}
