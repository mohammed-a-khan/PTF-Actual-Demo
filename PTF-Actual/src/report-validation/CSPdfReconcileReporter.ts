/**
 * HTML report writer for the v1.53 PDF-vs-PDF / PDF-vs-DB reconcilers.
 *
 * Renders a self-contained audit document with the same visual language as the
 * legacy CSReportDiffReporter output: verdict hero, "what was compared" tiles,
 * findings grouped by severity, and — crucially — a per-cell **comparison
 * ledger** built from `ReconcileResult.ledger` so a reviewer can read every
 * candidate/reference value that was joined and see the outcome at a glance.
 * Sections/columns discovered on the reference but not on the candidate live
 * in a collapsed `<details>` audit block so they don't visually dominate the
 * report when auto-mode skipped subset-view sections.
 *
 * @module report-validation/CSPdfReconcileReporter
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
    ReconcileFinding,
    ReconcileLedgerCell,
    ReconcileLedgerRow,
    ReconcileResult,
} from './CSPdfPairReconciler';
import { resolveReportValidationOutputDir } from './CSReportDiffReporter';

export interface ReconcileReporterOptions {
    /** Human-readable scenario label — appears in the report header. */
    label: string;
    /** Absolute or relative output path. When omitted, routed to the run's report-validation/. */
    outputPath?: string;
    /** Also emit `<file>.json` alongside the HTML with the full ReconcileResult. */
    writeJsonCopy?: boolean;
}

export interface ReconcileReporterResult {
    htmlPath: string;
    jsonPath?: string;
    byteCount: number;
}

export function writeReconcileHtmlReport(
    result: ReconcileResult,
    opts: ReconcileReporterOptions,
): ReconcileReporterResult {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = slugify(opts.label);
    const outputPath =
        opts.outputPath ??
        path.join(resolveReportValidationOutputDir(), `reconcile-${slug}-${stamp}.html`);
    const abs = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    const html = renderHtml(result, opts.label);
    fs.writeFileSync(abs, html, 'utf-8');

    let jsonPath: string | undefined;
    if (opts.writeJsonCopy) {
        jsonPath = abs.replace(/\.html$/, '.json');
        fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
    }
    return { htmlPath: abs, jsonPath, byteCount: Buffer.byteLength(html, 'utf-8') };
}

function renderHtml(result: ReconcileResult, label: string): string {
    const s = result.summary;
    const passed = result.passed;
    const status = passed ? 'status-pass' : 'status-fail';
    const gatingKinds = new Set([
        'CELL_MISMATCH',
        'ROW_MISSING_CANDIDATE',
        'ROW_MISSING_REFERENCE',
        'SECTION_MISSING_CANDIDATE',
        'SECTION_MISSING_REFERENCE',
        'COLUMN_MISSING_CANDIDATE',
        'COLUMN_MISSING_REFERENCE',
    ]);
    const failures = result.findings.filter((f) => gatingKinds.has(f.kind));
    const notes = result.findings.filter((f) => !gatingKinds.has(f.kind));

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Reconcile — ${esc(label)}</title>
<style>${CSS}</style>
</head>
<body data-status="${status}">
<div class="rv-wrap">

  ${renderHero(label, result)}

  ${renderTiles(result)}

  ${renderFindings('Failures', failures, true)}
  ${renderFindings('Notes', notes, false)}

  ${renderLedger(result.ledger, result)}

  ${renderUnmatched(result)}

  ${renderWarnings(result.warnings)}

</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHero(label: string, result: ReconcileResult): string {
    const s = result.summary;
    const passed = result.passed;
    const badge = passed ? 'PASSED' : 'FAILED';
    const badgeClass = passed ? 'status-pass' : 'status-fail';
    return `
  <div class="rv-header">
    <div class="rv-verdict">
      <div class="rv-verdict-rail"></div>
      <div class="rv-verdict-body">
        <p class="rv-eyebrow">PDF Reconciliation</p>
        <div class="rv-header-main">
          <h1>${esc(label)}</h1>
          <span class="rv-badge ${badgeClass}">${badge}</span>
        </div>
        <div class="rv-flow">
          <span class="rv-flow-node">${esc(path.basename(s.candidatePdf))}</span>
          <span class="rv-flow-arrow">→</span>
          <span class="rv-flow-node">${esc(path.basename(s.referencePdf))}</span>
        </div>
      </div>
    </div>
    <dl class="rv-meta">
      <div><dt>Candidate</dt><dd>${esc(s.candidatePdf)}</dd></div>
      <div><dt>Reference</dt><dd>${esc(s.referencePdf)}</dd></div>
      <div><dt>Generated</dt><dd>${esc(new Date().toISOString())}</dd></div>
    </dl>
  </div>`;
}

function renderTiles(result: ReconcileResult): string {
    const s = result.summary;
    const tile = (value: string | number, label: string, hint: string, bad = false) =>
        `<div class="rv-tile${bad ? ' rv-tile-bad' : ''}">
      <div class="rv-tile-value">${esc(String(value))}</div>
      <div class="rv-tile-label">${esc(label)}</div>
      <div class="rv-tile-hint">${esc(hint)}</div>
    </div>`;
    return `
  <h2>What was compared</h2>
  <div class="rv-tiles">
    ${tile(s.sectionsCompared, 'Sections', 'reconciled')}
    ${tile(s.rowsCompared, 'Rows', 'joined by key')}
    ${tile(s.columnsCompared, 'Columns', 'compared per row')}
    ${tile(s.cellsCompared, 'Cells', 'value-checked')}
    ${tile(s.cellMismatches, 'Cell mismatches', 'value differs', s.cellMismatches > 0)}
    ${tile(s.rowMissing, 'Rows missing', 'in one side', s.rowMissing > 0)}
    ${tile(s.columnMissing, 'Columns missing', 'in one side', s.columnMissing > 0)}
    ${tile(s.knownDifferencesMatched, 'Known diffs', 'allowlisted')}
  </div>`;
}

function renderFindings(title: string, findings: ReconcileFinding[], isFailure: boolean): string {
    if (findings.length === 0) {
        return `
  <div class="rv-group">
    <h3>${esc(title)} <span class="rv-count-inline">(0)</span></h3>
    <p class="rv-empty">No findings in this group.</p>
  </div>`;
    }
    const rows = findings
        .slice(0, 500)
        .map((f) => {
            const kindClass = isFailure ? 'rv-tag-fail' : 'rv-tag-note';
            return `<tr>
      <td><span class="rv-tag ${kindClass}">${esc(f.kind)}</span></td>
      <td>${esc(f.section ?? '')}</td>
      <td>${esc(f.column ?? '')}</td>
      <td class="rv-mono">${esc(f.key ?? '')}</td>
      <td class="rv-mono">${esc(f.candidateValue ?? '')}</td>
      <td class="rv-mono">${esc(f.referenceValue ?? '')}</td>
      <td>${f.delta !== undefined ? esc(String(f.delta)) : ''}</td>
      <td>${esc(f.reason ?? '')}</td>
    </tr>`;
        })
        .join('');
    const capNote =
        findings.length > 500
            ? `<p class="rv-cap-note">Showing first 500 of ${findings.length} — see .json for full list.</p>`
            : '';
    return `
  <div class="rv-group">
    <h3>${esc(title)} <span class="rv-count-inline">(${findings.length})</span></h3>
    ${capNote}
    <div class="rv-table-wrap"><table class="rv-scope-table">
      <thead><tr>
        <th>Kind</th><th>Section</th><th>Column</th><th>Row key</th>
        <th>Candidate</th><th>Reference</th><th>Δ</th><th>Reason</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function renderLedger(ledger: ReconcileLedgerRow[], result: ReconcileResult): string {
    if (!ledger || ledger.length === 0) {
        return `
  <h2>Comparison ledger</h2>
  <p class="rv-empty">No cells were joined — nothing to display.</p>`;
    }
    // Group rows by section for readability
    const bySection = new Map<string, ReconcileLedgerRow[]>();
    for (const r of ledger) {
        const list = bySection.get(r.section) ?? [];
        list.push(r);
        bySection.set(r.section, list);
    }
    let totalRows = 0;
    let failingRows = 0;
    for (const r of ledger) {
        totalRows++;
        if (rowStatus(r) === 'FAIL') failingRows++;
    }
    // "candidate" and "reference" side labels — basename of the PDF path (or "db" when the
    // reference is the DB helper adapter, which uses a `db://` synthetic path).
    const candLabel = shortSide(result.summary.candidatePdf);
    const refLabel = shortSide(result.summary.referencePdf);

    const sectionBlocks: string[] = [];
    for (const [section, rows] of bySection.entries()) {
        // Union of columns across rows preserves declaration order using the first row's ordering
        const colOrder: string[] = [];
        const seen = new Set<string>();
        for (const r of rows) {
            for (const c of r.cells) {
                if (!seen.has(c.column)) {
                    seen.add(c.column);
                    colOrder.push(c.column);
                }
            }
        }
        const capRows = rows.slice(0, 400);
        const rowHtml = capRows
            .map((r) => renderLedgerRowPair(r, colOrder, candLabel, refLabel))
            .join('');
        const capNote =
            rows.length > 400
                ? `<p class="rv-cap-note">Showing first 400 of ${rows.length} rows in this section — see .json for full list.</p>`
                : '';
        sectionBlocks.push(`
    <div class="rv-ledger-section">
      <h3>${esc(section)} <span class="rv-count-inline">(${rows.length} row${rows.length === 1 ? '' : 's'})</span></h3>
      ${capNote}
      <div class="rv-table-wrap"><table class="rv-scope-table rv-ledger-table">
        <thead><tr>
          <th class="rv-ledger-key">Row key</th>
          <th class="rv-ledger-side-header">Side</th>
          ${colOrder.map((c) => `<th>${esc(c)}</th>`).join('')}
          <th class="rv-ledger-status-header">Status</th>
        </tr></thead>
        <tbody>${rowHtml}</tbody>
      </table></div>
    </div>`);
    }
    return `
  <h2>Comparison ledger <span class="rv-count-inline">(${totalRows} row${totalRows === 1 ? '' : 's'} compared${failingRows ? `, ${failingRows} failing` : ''})</span></h2>
  ${sectionBlocks.join('\n')}`;
}

/**
 * Render one joined row-pair as two <tr>s — one for the candidate side, one
 * for the reference. Row-key and status cells span both rows via rowspan=2,
 * mirroring the legacy CSReportDiffReporter aesthetic where a reviewer can
 * read across the candidate row and reference row without decoding stacked
 * values inside a single cell.
 */
function renderLedgerRowPair(
    row: ReconcileLedgerRow,
    colOrder: string[],
    candLabel: string,
    refLabel: string,
): string {
    const cellByCol = new Map<string, ReconcileLedgerCell>();
    for (const c of row.cells) cellByCol.set(c.column, c);

    const status = rowStatus(row);
    const statusClass = status === 'PASS' ? 'rv-ledger-pass' : status === 'KNOWN' ? 'rv-ledger-known' : 'rv-ledger-fail';
    const statusLabel = status === 'KNOWN' ? 'KNOWN Δ' : status;

    // Format key as `col1=v1 | col2=v2`. Falls back to raw rowKey if keyPairs missing.
    const keyLabel = row.keyPairs && row.keyPairs.length
        ? row.keyPairs.map((p) => `${esc(p.column)}=${esc(p.value)}`).join(' | ')
        : esc(row.rowKey);

    const candCells = colOrder
        .map((col) => {
            const cell = cellByCol.get(col);
            if (!cell) return `<td class="rv-ledger-cell rv-outcome-none">—</td>`;
            return sideCell(cell, 'candidate');
        })
        .join('');
    const refCells = colOrder
        .map((col) => {
            const cell = cellByCol.get(col);
            if (!cell) return `<td class="rv-ledger-cell rv-outcome-none">—</td>`;
            return sideCell(cell, 'reference');
        })
        .join('');

    return `<tr class="rv-ledger-rowgroup" data-status="${status}">
      <td class="rv-ledger-key rv-mono" rowspan="2">${keyLabel}</td>
      <td class="rv-ledger-side">${esc(candLabel)}</td>
      ${candCells}
      <td class="rv-ledger-status ${statusClass}" rowspan="2">${statusLabel}</td>
    </tr>
    <tr class="rv-ledger-rowgroup rv-ledger-rowgroup-b" data-status="${status}">
      <td class="rv-ledger-side">${esc(refLabel)}</td>
      ${refCells}
    </tr>`;
}

/**
 * Render one cell for one side (candidate or reference), coloured by the
 * cell's outcome. Because a single ReconcileLedgerCell holds BOTH sides'
 * values, this helper picks the correct one to display and applies the
 * outcome CSS class so the same visual language (green/red/orange/purple)
 * carries across both sub-rows.
 */
function sideCell(cell: ReconcileLedgerCell, side: 'candidate' | 'reference'): string {
    const outcomeClass = `rv-outcome-${cell.outcome.toLowerCase().replace(/_/g, '-')}`;
    const value = side === 'candidate' ? cell.candidate : cell.reference;
    const missing =
        (side === 'candidate' && cell.outcome === 'MISSING_CANDIDATE') ||
        (side === 'reference' && cell.outcome === 'MISSING_REFERENCE');
    const display = missing ? '—' : esc(value ?? '');
    const title = cell.outcome === 'MISMATCH' && cell.delta !== undefined
        ? `MISMATCH Δ=${cell.delta}`
        : cell.outcome;
    return `<td class="rv-ledger-cell ${outcomeClass}" title="${title}">${display}</td>`;
}

function rowStatus(row: ReconcileLedgerRow): 'PASS' | 'FAIL' | 'KNOWN' {
    let hasKnown = false;
    for (const c of row.cells) {
        if (c.outcome === 'MISMATCH' || c.outcome === 'MISSING_CANDIDATE' || c.outcome === 'MISSING_REFERENCE') {
            return 'FAIL';
        }
        if (c.outcome === 'KNOWN_DIFFERENCE') hasKnown = true;
    }
    return hasKnown ? 'KNOWN' : 'PASS';
}

function shortSide(pdfPath: string): string {
    if (!pdfPath) return '';
    if (pdfPath.startsWith('db://')) return 'db';
    // Filename minus extension; keep it short for the side column.
    const base = path.basename(pdfPath).replace(/\.[^.]+$/, '');
    return base.length > 40 ? base.slice(0, 37) + '…' : base;
}

function worstOutcome(cells: ReconcileLedgerCell[]): string {
    const rank: Record<string, number> = {
        MATCH: 0,
        IGNORED: 0,
        KNOWN_DIFFERENCE: 1,
        MISMATCH: 3,
        MISSING_REFERENCE: 3,
        MISSING_CANDIDATE: 3,
    };
    let worst = 'MATCH';
    let worstRank = 0;
    for (const c of cells) {
        const r = rank[c.outcome] ?? 0;
        if (r > worstRank) {
            worstRank = r;
            worst = c.outcome;
        }
    }
    return worst;
}

function renderUnmatched(result: ReconcileResult): string {
    const u = result.unmatched;
    if (!u) return '';
    const blocks: string[] = [];
    if (u.sectionsInReferenceOnly?.length) {
        blocks.push(
            `<h4>Sections only on reference (${u.sectionsInReferenceOnly.length})</h4><ul>` +
                u.sectionsInReferenceOnly
                    .map(
                        (x) =>
                            `<li><code>${esc(x.name)}</code>${
                                x.nearestOnCandidate?.length
                                    ? ` — nearest on candidate: ${x.nearestOnCandidate
                                          .map((n) => `<code>${esc(n)}</code>`)
                                          .join(', ')}`
                                    : ''
                            }</li>`,
                    )
                    .join('') +
                '</ul>',
        );
    }
    if (u.sectionsInCandidateOnly?.length) {
        blocks.push(
            `<h4>Sections only on candidate (${u.sectionsInCandidateOnly.length})</h4><ul>` +
                u.sectionsInCandidateOnly.map((n) => `<li><code>${esc(n)}</code></li>`).join('') +
                '</ul>',
        );
    }
    if (u.columnsInReferenceOnly?.length) {
        blocks.push(
            `<h4>Columns only on reference (${u.columnsInReferenceOnly.length})</h4><ul>` +
                u.columnsInReferenceOnly
                    .map((x) => `<li><code>${esc(x.section)}::${esc(x.name)}</code></li>`)
                    .join('') +
                '</ul>',
        );
    }
    if (!blocks.length) return '';
    const total =
        (u.sectionsInReferenceOnly?.length ?? 0) +
        (u.sectionsInCandidateOnly?.length ?? 0) +
        (u.columnsInReferenceOnly?.length ?? 0);
    return `
  <details class="rv-details">
    <summary>Audit trail — items discovered on one side only (${total}) &nbsp; <span class="rv-hint">(non-gating; expected when one PDF is a subset view of the other)</span></summary>
    ${blocks.join('')}
  </details>`;
}

function renderWarnings(warnings: string[] | undefined): string {
    if (!warnings || !warnings.length) return '';
    return `
  <h2>Warnings <span class="rv-count-inline">(${warnings.length})</span></h2>
  <ul class="rv-warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------------------
// CSS (self-contained; matches the legacy diff-report aesthetic)
// ---------------------------------------------------------------------------

const CSS = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --bg: #f4f6f9; --panel: #ffffff; --panel-2: #eef1f6;
  --ink: #141821; --ink-2: #444d5e; --muted: #6b7482;
  --line: #dfe3ea; --line-2: #c8cfda;
  --pass: #0f7a4d; --pass-bg: #e6f4ec;
  --fail: #c0392b; --fail-bg: #fbeae8;
  --warn: #9a6600; --warn-bg: #fbf1de;
  --info: #24558f; --info-bg: #e6eef8;
  --known: #6a4bb0; --known-bg: #efe9f8;
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
    --known: #b294e0; --known-bg: #201730;
    --shadow: 0 1px 1px rgba(0,0,0,.4), 0 6px 20px -10px rgba(0,0,0,.7);
  }
}
body { margin: 0; padding: 28px 24px 56px; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 14px; line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
.rv-wrap { max-width: 1400px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0; font-weight: 650; letter-spacing: -.012em; }
h2 { font-size: 15px; margin: 28px 0 12px; color: var(--ink-2); font-weight: 600;
     letter-spacing: .02em; text-transform: uppercase; }
h3 { font-size: 15px; margin: 16px 0 8px; color: var(--ink); font-weight: 600; }
h4 { font-size: 13px; margin: 14px 0 6px; color: var(--ink-2); font-weight: 600; }
.rv-eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
.rv-header { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
.rv-verdict { display: flex; align-items: stretch; gap: 0; border-bottom: 1px solid var(--line); }
.rv-verdict-rail { width: 6px; flex: none; background: var(--muted); }
body[data-status="status-pass"] .rv-verdict-rail { background: var(--pass); }
body[data-status="status-fail"] .rv-verdict-rail { background: var(--fail); }
.rv-verdict-body { padding: 20px 24px; flex: 1; min-width: 0; }
.rv-header-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rv-badge { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 5px; font-weight: 700; font-size: 12px; letter-spacing: .07em; }
.status-pass { background: var(--pass-bg); color: var(--pass); box-shadow: inset 0 0 0 1px var(--pass); }
.status-fail { background: var(--fail-bg); color: var(--fail); box-shadow: inset 0 0 0 1px var(--fail); }
.rv-flow { margin-top: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); }
.rv-flow-node { padding: 5px 11px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--panel-2); }
.rv-flow-arrow { color: var(--muted); font-size: 15px; }
.rv-meta { margin: 0; padding: 14px 24px 16px; background: var(--panel-2);
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 28px; }
.rv-meta > div { display: flex; flex-direction: column; min-width: 0; }
.rv-meta dt { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
.rv-meta dd { margin: 3px 0 0; word-break: break-word; font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); }
.rv-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.rv-tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; box-shadow: var(--shadow); }
.rv-tile-bad { border-color: var(--fail); background: var(--fail-bg); }
.rv-tile-value { font-size: 24px; font-weight: 650; color: var(--ink); line-height: 1.1; }
.rv-tile-bad .rv-tile-value { color: var(--fail); }
.rv-tile-label { font-size: 12px; color: var(--muted); font-weight: 600; margin-top: 4px; text-transform: uppercase; letter-spacing: .06em; }
.rv-tile-hint { font-size: 12px; color: var(--muted); margin-top: 2px; }
.rv-group { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 18px; margin: 10px 0; box-shadow: var(--shadow); }
.rv-count-inline { color: var(--muted); font-weight: 500; font-size: 13px; }
.rv-empty { color: var(--muted); font-style: italic; margin: 4px 0 0; }
.rv-cap-note { color: var(--warn); font-size: 12px; margin: 4px 0 8px; }
.rv-table-wrap { overflow-x: auto; }
.rv-scope-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.rv-scope-table th, .rv-scope-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.rv-scope-table th { background: var(--panel-2); color: var(--ink-2); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; }
.rv-mono { font-family: var(--mono); font-size: 12px; word-break: break-word; }
.rv-tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .03em; }
.rv-tag-fail { background: var(--fail-bg); color: var(--fail); }
.rv-tag-note { background: var(--info-bg); color: var(--info); }
.rv-ledger-section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 18px; margin: 10px 0; box-shadow: var(--shadow); }
.rv-ledger-table { font-size: 12px; }
.rv-ledger-key { min-width: 220px; max-width: 320px; font-weight: 600; color: var(--ink); font-family: var(--mono); font-size: 11.5px; }
.rv-ledger-side { min-width: 70px; color: var(--muted); font-family: var(--mono); font-size: 11px; text-transform: lowercase; letter-spacing: .04em; }
.rv-ledger-side-header, .rv-ledger-status-header { min-width: 70px; }
.rv-ledger-cell { min-width: 100px; font-family: var(--mono); font-size: 11.5px; word-break: break-word; }
.rv-ledger-rowgroup-b td { border-bottom: 1px solid var(--line-2); }
.rv-ledger-status { text-align: center; font-weight: 700; font-size: 12px; letter-spacing: .06em; }
.rv-ledger-pass { background: var(--pass-bg); color: var(--pass); }
.rv-ledger-fail { background: var(--fail-bg); color: var(--fail); }
.rv-ledger-known { background: var(--known-bg); color: var(--known); }
.rv-outcome-match { background: var(--pass-bg); }
.rv-outcome-mismatch { background: var(--fail-bg); color: var(--fail); font-weight: 600; }
.rv-outcome-known-difference { background: var(--known-bg); color: var(--known); }
.rv-outcome-missing-candidate { background: var(--warn-bg); color: var(--warn); }
.rv-outcome-missing-reference { background: var(--warn-bg); color: var(--warn); }
.rv-outcome-ignored { background: var(--panel-2); color: var(--muted); }
.rv-outcome-none { background: var(--panel-2); color: var(--muted); text-align: center; }
tr.rv-ledger-rowgroup[data-status="FAIL"] td.rv-ledger-key { color: var(--fail); }
tr.rv-ledger-rowgroup[data-status="KNOWN"] td.rv-ledger-key { color: var(--known); }
.rv-details { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 16px 0; box-shadow: var(--shadow); }
.rv-details > summary { cursor: pointer; font-weight: 600; color: var(--ink-2); }
.rv-details ul { margin: 8px 0 0; padding-left: 20px; }
.rv-details code { background: var(--panel-2); padding: 1px 4px; border-radius: 3px; font-size: 11.5px; }
.rv-hint { color: var(--muted); font-weight: 400; font-size: 12.5px; }
.rv-warnings { margin: 0; padding-left: 20px; color: var(--ink-2); }
.rv-warnings li { margin: 4px 0; }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function esc(v: string | number | null | undefined): string {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
