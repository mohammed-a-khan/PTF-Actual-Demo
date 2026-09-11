#!/usr/bin/env node
/**
 * Report Validation — PDF extraction inspector.
 *
 * Answers "what did extraction actually see in this PDF, and why did a field not map?"
 * without running a scenario. Prints, per detected section: the resolved canonical id, the
 * column bands and their headers, which headers map to canonical fields under a spec, which
 * declared fields did NOT map, and any totals found.
 *
 * A field that fails to map is invisible in normal output — the rows simply vanish, and if
 * the field is a key column EVERY row vanishes with it. This prints the mapping decision
 * itself, which is the thing you actually need to see.
 *
 * Usage:
 *   node scripts/inspect-report-pdf.js <file.pdf> [--source crystal|ssrs] [--spec <reportType>]
 *                                      [--specs-dir config/report-specs] [--all]
 *
 *   --all   include sections the spec does not declare (default: declared sections only,
 *           plus a one-line summary of the rest)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const showAll = argv.includes('--all');

if (!file) {
    console.error('usage: node scripts/inspect-report-pdf.js <file.pdf> [--source crystal|ssrs] [--spec <reportType>] [--specs-dir <dir>] [--all]');
    process.exit(2);
}
if (!fs.existsSync(file)) {
    console.error(`ERROR: no such file: ${file}`);
    process.exit(2);
}

const DIST = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(DIST, 'report-validation', 'index.js'))) {
    console.error('ERROR: dist/ missing — run `npm run build` first.');
    process.exit(2);
}
const RV = require(path.join(DIST, 'report-validation', 'index.js'));
const { extractPagesFromPdf, analyzeReport, canonicalFieldFor, resolveCanonicalSectionId, CSReportSpecLoader } = RV;

const source = opt('source', 'crystal');
const specsDir = opt('specs-dir', path.join('config', 'report-specs'));
const specType = opt('spec', null);

(async () => {
    let spec = null;
    if (specType) {
        const loader = new CSReportSpecLoader(specsDir);
        await loader.loadAll();
        if (!loader.has(specType)) {
            console.error(`ERROR: spec "${specType}" not found in ${specsDir}. Loaded: ${loader.list().join(', ')}`);
            process.exit(2);
        }
        spec = loader.get(specType);
    }

    // The spec's section matchers change what the analyzer sees — they protect section titles
    // from being stripped as page chrome. Inspecting without them would not reproduce a run.
    const regexes = [];
    for (const rs of (spec && spec.requiredSections) || []) {
        const patterns = rs.matchers && rs.matchers.length ? rs.matchers : [`^${rs.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`];
        for (const p of patterns) { try { regexes.push(new RegExp(p, 'i')); } catch { /* spec loader reports bad regexes */ } }
    }

    // pdfjs emits a font warning per page for PDFs that don't ship standard font data. It is
    // harmless and says nothing about extraction, but 55 copies of it bury the report this
    // tool exists to print. Silenced for the extraction call only.
    const realWarn = console.warn;
    console.warn = (...args) => {
        const first = args.length ? String(args[0]) : '';
        if (/standardFontDataUrl|UnknownErrorException/.test(first)) return;
        realWarn.apply(console, args);
    };
    let pages;
    try {
        pages = await extractPagesFromPdf(path.resolve(file));
    } finally {
        console.warn = realWarn;
    }
    const analyzed = analyzeReport(pages, regexes.length ? { sectionHeaderRegexes: regexes } : {});

    console.log(`\nFile      : ${file}`);
    console.log(`Pages     : ${analyzed.pageCount}`);
    console.log(`Sections  : ${analyzed.mergedSections.length}`);
    console.log(`Source    : ${source}`);
    console.log(`Spec      : ${spec ? `${spec.reportType} (${specsDir})` : '(none — headers shown unmapped)'}`);
    if (spec) console.log(`Key cols  : ${(spec.keyColumns || []).join(', ')}`);
    console.log('');

    const declared = new Set((spec && spec.requiredSections || []).map((r) => r.id));
    const mappedAnywhere = new Set();
    let shown = 0;
    const skipped = [];

    for (const section of analyzed.mergedSections) {
        const canonicalId = spec ? resolveCanonicalSectionId(section.title, spec) : section.title;
        const inScope = !spec || declared.size === 0 || declared.has(canonicalId);
        if (!inScope && !showAll) {
            skipped.push(`${section.title} (p${section.startPage}, ${section.tableRows.length} rows)`);
            continue;
        }
        shown++;

        const dataRows = section.tableRows.filter((r) => !r.isTotalRow && !r.isGroupHeader);
        console.log(`${'='.repeat(78)}`);
        console.log(`SECTION  ${JSON.stringify(section.title)}  page ${section.startPage}`);
        console.log(`  canonical id : ${canonicalId}${inScope ? '' : '   [NOT DECLARED BY THE SPEC — rows are not compared]'}`);
        console.log(`  rows         : ${dataRows.length} data, ${section.tableRows.length - dataRows.length} total/group`);
        console.log(`  bands        : ${section.columns.length}`);

        const rows = [];
        section.columns.forEach((band, ci) => {
            const header = band.header && band.header.trim() ? band.header.trim() : null;
            const carries = dataRows.some((r) => r.cells[ci] && String(r.cells[ci]).trim());
            const canonicalField = header && spec ? canonicalFieldFor(header, source, spec.fieldMap) : null;
            if (canonicalField) mappedAnywhere.add(canonicalField);
            if (!header && !carries) return; // pure spacer — noise
            const sample = (dataRows.find((r) => r.cells[ci] && String(r.cells[ci]).trim()) || { cells: [] }).cells[ci];
            rows.push({
                band: ci,
                header: header || '(no header)',
                data: carries ? 'yes' : 'no',
                maps: canonicalField || (spec ? '— UNMAPPED' : 'n/a'),
                sample: sample ? String(sample).slice(0, 28) : '',
            });
        });

        const w = (s, n) => String(s).padEnd(n).slice(0, n);
        console.log(`  ${w('BAND', 5)}${w('HEADER', 30)}${w('DATA', 6)}${w('MAPS TO', 24)}SAMPLE`);
        for (const r of rows) {
            const flag = r.data === 'yes' && r.maps.startsWith('—') ? ' <-- carries data but maps to nothing' : '';
            console.log(`  ${w(r.band, 5)}${w(r.header, 30)}${w(r.data, 6)}${w(r.maps, 24)}${r.sample}${flag}`);
        }
        if (section.preambleText && section.preambleText.length) {
            console.log('  calculation block:');
            for (const line of section.preambleText) console.log(`    | ${line}`);
        }
        console.log('');
    }

    if (skipped.length) {
        console.log(`${'='.repeat(78)}`);
        console.log(`${skipped.length} section(s) not declared by the spec (use --all to expand):`);
        for (const s of skipped.slice(0, 20)) console.log(`  - ${s}`);
        if (skipped.length > 20) console.log(`  … and ${skipped.length - 20} more`);
        console.log('');
    }

    if (spec) {
        const missing = Object.keys(spec.fieldMap || {})
            .filter((f) => spec.fieldMap[f][source])
            .filter((f) => !mappedAnywhere.has(f));
        console.log(`${'='.repeat(78)}`);
        if (missing.length === 0) {
            console.log(`ALL declared "${source}" fields mapped to a column.`);
        } else {
            console.log(`UNMAPPED — declared for "${source}" but no column matched:`);
            for (const f of missing) {
                const want = spec.fieldMap[f][source];
                const isKey = (spec.keyColumns || []).includes(f);
                console.log(`  ${f}  expects ${JSON.stringify(want)}${isKey ? '   *** KEY COLUMN — every row will be dropped ***' : ''}`);
            }
        }
        console.log('');
    }
    if (shown === 0) console.log('No declared section was found in this file. Check requiredSections[].matchers against the titles above (--all).');
})().catch((err) => {
    console.error('\nFAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
});
