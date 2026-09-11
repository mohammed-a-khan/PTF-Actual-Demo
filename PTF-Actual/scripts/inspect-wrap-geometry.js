#!/usr/bin/env node
/**
 * Dump the vertical geometry of a report section's first (name) column.
 *
 * Purpose: decide which row a WRAPPED cell fragment belongs to. When a long name wraps, its
 * fragments land on their own lines, and whether a fragment belongs to the row above or the
 * row below cannot be settled from two samples. This prints every line in the section with
 * its y, its font size, whether it carries values, and the runs in the name column — enough
 * to measure intra-cell line spacing against the row pitch across the whole section.
 *
 *   node scripts/inspect-wrap-geometry.js <file.pdf> [sectionRegex] [nameColumnMaxX]
 *
 * Defaults: sectionRegex "^Market Value Detail", nameColumnMaxX 250.
 *
 * Cell TEXT is truncated to 24 characters — enough to tell a head from a tail, not enough to
 * reproduce the report's contents.
 */
'use strict';

const path = require('path');
const RV = require(path.join(__dirname, '..', 'dist', 'report-validation', 'index.js'));

const pdfPath = process.argv[2];
const sectionRe = new RegExp(process.argv[3] || '^Market Value Detail', 'i');
const NAME_MAX_X = Number(process.argv[4] || 250);

if (!pdfPath) {
    console.error('usage: node scripts/inspect-wrap-geometry.js <file.pdf> [sectionRegex] [nameColumnMaxX]');
    process.exit(2);
}

const VALUE_RE = /^\(?[$£€¥]?[\d,]+(?:\.\d+)?\)?%?$|^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/;
const isValue = (s) => VALUE_RE.test(String(s).trim());
const round = (n) => Math.round(n * 10) / 10;

(async () => {
    const pages = await RV.extractPagesFromPdf(pdfPath);
    const segmented = RV.segmentPages(pages, { protectedPatterns: [sectionRe] });

    for (let p = 0; p < pages.length; p++) {
        const lines = RV.clusterLines(segmented[p].bodyItems).sort((a, b) => b.y - a.y);
        const onThisPage = lines.some((l) => sectionRe.test(l.items.map((i) => i.str).join(' ').trim()));
        if (!onThisPage) continue;

        console.log(`\n===== PAGE ${pages[p].pageNumber} =====`);
        const rows = [];
        for (const line of lines) {
            const inked = line.items.filter((i) => i.str.trim().length > 0);
            if (inked.length === 0) continue;
            const values = inked.filter((i) => isValue(i.str)).length;
            const nameRuns = inked
                .filter((i) => i.x < NAME_MAX_X)
                .map((i) => `x=${round(i.x)} w=${round(i.width)} fs=${round(i.fontSize)} ${JSON.stringify(i.str.trim().slice(0, 24))}`);
            rows.push({ y: round(line.y), items: inked.length, values, nameRuns });
        }

        // Row pitch: the spacing between lines that carry values, i.e. real data rows.
        const dataY = rows.filter((r) => r.values >= 2).map((r) => r.y);
        const pitches = [];
        for (let i = 1; i < dataY.length; i++) pitches.push(round(dataY[i - 1] - dataY[i]));
        const sorted = [...pitches].sort((a, b) => a - b);
        const medianPitch = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
        console.log(`data rows=${dataY.length}  median row pitch=${medianPitch}`);

        console.log('\n  y      gapAbove  items  values  nameColumnRuns');
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const gap = i === 0 ? '-' : String(round(rows[i - 1].y - r.y)).padStart(5);
            const kind = r.values >= 2 ? 'DATA' : (r.nameRuns.length ? 'frag' : '    ');
            console.log(
                `  ${String(r.y).padStart(6)}  ${String(gap).padStart(8)}  ${String(r.items).padStart(5)}  ${String(r.values).padStart(6)}  ${kind}  ${r.nameRuns.join('  |  ')}`,
            );
        }
    }
})().catch((err) => {
    console.error('ERROR:', err && err.stack ? err.stack : err);
    process.exit(1);
});
