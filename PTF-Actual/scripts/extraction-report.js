#!/usr/bin/env node
/**
 * Structural extraction report — everything needed to diagnose a mis-read table, with the
 * business data masked out.
 *
 *   node scripts/extraction-report.js <file.pdf>
 *
 * The specs folder is found automatically — beside the PDF, or in samples/specs, or in
 * config/report-specs. Override with --specs <dir>, pick one with --spec <reportType>, and
 * show real values instead of masked ones with --raw.
 *
 * WHY MASKING
 * -----------
 * Diagnosing a mis-read grid needs GEOMETRY and SHAPE — where the bands fell, which heading
 * landed on which band, whether a column holds numbers or text, how many rows survived. It does
 * not need the values. So every sample is masked: letters become A/a, digits become 9, and
 * punctuation, spacing and length are preserved. `Loan X Mark-It Partners` prints as
 * `Aaaa A Aaaa-Aa Aaaaaaaa` — enough to see that a text vendor name is sitting in a price
 * column, not enough to reproduce the report. Pass --raw to disable masking.
 *
 * WHAT TO LOOK FOR
 * ----------------
 *   - a band whose heading names one column and whose values are shaped like another's
 *   - a heading repeated across several bands, or several headings joined on one band
 *   - `mapsTo=null` on a band that clearly holds data
 *   - rows detected but not mapped
 *   - a numeric field whose values profile as text
 */
'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Locate the framework's report-validation module.
 *
 * This file is meant to be COPIED into a consuming project — a temp folder, a scripts folder,
 * anywhere — so it must not assume it is sitting inside the framework repo. Resolution is tried
 * in order: the package export, an installed copy in any node_modules above us, and finally a
 * dist/ folder above us (which is the case when it IS run from the framework repo).
 */
function loadReportValidation() {
    const attempts = [];
    const tryRequire = (id) => {
        try {
            return require(id);
        } catch (err) {
            attempts.push(`${id}  →  ${(err && err.code) || (err && err.message) || err}`);
            return null;
        }
    };

    if (process.env.REPORT_FRAMEWORK_DIR) {
        const forced = path.resolve(process.env.REPORT_FRAMEWORK_DIR, 'dist', 'report-validation', 'index.js');
        const mod = tryRequire(forced);
        if (mod) return { mod, from: forced };
    }

    const PKG = '@mdakhan.mak/cs-playwright-test-framework';
    for (const id of [`${PKG}/report-validation`, `${PKG}/dist/report-validation/index.js`]) {
        const mod = tryRequire(id);
        if (mod) return { mod, from: id };
    }

    // Walk up from both the working directory and this file, looking for an installed copy or a
    // built framework tree.
    const roots = [process.cwd(), __dirname];
    for (const start of roots) {
        let dir = path.resolve(start);
        for (let hop = 0; hop < 12; hop++) {
            for (const rel of [
                path.join('node_modules', PKG, 'dist', 'report-validation', 'index.js'),
                path.join('dist', 'report-validation', 'index.js'),
            ]) {
                const candidate = path.join(dir, rel);
                if (fs.existsSync(candidate)) {
                    const mod = tryRequire(candidate);
                    if (mod) return { mod, from: candidate };
                }
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }

    console.error('Could not load the report-validation module.\n');
    console.error('Tried:');
    for (const line of attempts) console.error('  ' + line);
    console.error('\nFix one of these:');
    console.error('  • run this from a project that has the framework installed, or');
    console.error('  • set REPORT_FRAMEWORK_DIR to the framework folder, e.g.');
    console.error('      set REPORT_FRAMEWORK_DIR=E:\\PTF-ADO   (PowerShell: $env:REPORT_FRAMEWORK_DIR="E:\\PTF-ADO")');
    console.error('    and make sure it has been built:  npx tsc');
    process.exit(2);
}

const loaded = loadReportValidation();
const RV = loaded.mod;
const ROOT = process.cwd();

const args = process.argv.slice(2);
const pdfPath = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined;
};
const RAW = !!flag('raw');
const SPEC_TYPE = flag('spec');

if (!pdfPath) {
    console.error('usage: node scripts/extraction-report.js <file.pdf>');
    console.error('       optional: --specs <dir>   --spec <reportType>   --raw');
    process.exit(2);
}

/**
 * Find the report specs without being told. Checked in order: an explicit --specs, the
 * REPORT_SPECS_DIR variable, a specs folder beside the PDF, then the two standard locations.
 * Running with no spec at all still reports geometry and headings — only the mapping section
 * needs one.
 */
function findSpecsDir() {
    const explicit = flag('specs');
    const cwd = process.cwd();
    const beside = path.dirname(path.resolve(pdfPath));
    // The working directory comes FIRST: this script ships inside the framework package, so
    // when it runs from a consuming project the specs it must find are that project's, not the
    // package's own samples.
    const candidates = [
        typeof explicit === 'string' ? path.resolve(cwd, explicit) : null,
        process.env.REPORT_SPECS_DIR ? path.resolve(cwd, process.env.REPORT_SPECS_DIR) : null,
        path.join(cwd, 'config', 'report-specs'),
        path.join(cwd, 'samples', 'specs'),
        path.join(cwd, 'specs'),
        path.join(beside, 'specs'),
        path.join(beside, '..', 'specs'),
        path.join(ROOT, 'samples', 'specs'),
        path.join(ROOT, 'config', 'report-specs'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        const abs = path.resolve(candidate);
        if (!fs.existsSync(abs)) continue;
        const hasSpec = fs.readdirSync(abs).some((n) => n.toLowerCase().endsWith('.json'));
        if (hasSpec) return abs;
    }
    return null;
}

/** Letters → A/a, digits → 9. Punctuation, spacing and length survive; content does not. */
function mask(text) {
    if (RAW) return text;
    return String(text).replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9');
}

/** Classify a cell so a column's CONTENT TYPE is visible without its values. */
function shapeOf(raw) {
    const s = String(raw ?? '').trim();
    if (s.length === 0) return 'empty';
    if (/^\(?[$£€¥]?[\d,]+(?:\.\d+)?\)?%?$/.test(s)) return 'number';
    if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(s)) return 'date';
    return 'text';
}

function profile(cells) {
    const counts = { number: 0, date: 0, text: 0, empty: 0 };
    for (const c of cells) counts[shapeOf(c)]++;
    return Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}:${n}`)
        .join(' ');
}

(async () => {
    const specs = [];
    let spec = null;
    const specsAbs = findSpecsDir();
    if (specsAbs) {
        const loader = new RV.CSReportSpecLoader(specsAbs);
        await loader.loadAll();
        specs.push(...loader.list());
        if (specs.length) spec = loader.get(SPEC_TYPE || specs[0]);
    }

    const regexes = spec
        ? (spec.requiredSections || []).flatMap((s) =>
              (s.matchers && s.matchers.length ? s.matchers : [`^${s.title}$`]).map((m) => new RegExp(m, 'i')),
          )
        : [];

    const pages = await RV.extractPagesFromPdf(path.resolve(process.cwd(), pdfPath));
    const analyzed = RV.analyzeReport(pages, { sectionHeaderRegexes: regexes });

    // Say WHICH extraction code is running, not just where it was loaded from. Every round of
    // "the output is identical" has come down to a build that did not contain the change, and a
    // path alone cannot tell you that.
    const hasNetwork = typeof RV.detectColumnsByAlignment === 'function';
    console.log(`file        : ${path.basename(pdfPath)}`);
    console.log(`framework   : ${loaded.from}`);
    console.log(`detector    : ${hasNetwork ? 'alignment-network' : 'DENSITY (pre-fix build — headings will smear)'}`);
    console.log(`pages       : ${analyzed.pageCount}`);
    console.log(`specs dir   : ${specsAbs || '(none found — pass --specs <dir> for the mapping section)'}${specs.length ? `  (${specs.join(', ')})` : ''}`);
    console.log(`spec        : ${spec ? spec.reportType : '(none — sections will not be scoped or mapped)'}`);
    console.log(`masking     : ${RAW ? 'OFF (--raw)' : 'ON — letters→A/a, digits→9'}`);

    const declared = spec ? new Set((spec.requiredSections || []).map((s) => s.id)) : null;

    for (const section of analyzed.mergedSections) {
        const canonicalId = spec ? RV.resolveCanonicalSectionId(section.title, spec) : section.title;
        const inScope = !declared || declared.has(canonicalId);
        if (!inScope && section.tableRows.length === 0) continue;

        const dataRows = section.tableRows.filter((r) => !r.isTotalRow && !r.isGroupHeader);
        console.log(`\n${'='.repeat(78)}`);
        console.log(`SECTION "${section.title}"  page ${section.startPage}`);
        console.log(`  canonical id : ${canonicalId}${inScope ? '' : '   [OUT OF SCOPE — spec does not declare it]'}`);
        console.log(`  rows         : ${dataRows.length} data, ${section.tableRows.length - dataRows.length} total/group`);
        console.log(`  bands        : ${section.columns.length}`);
        if (!inScope) continue;

        console.log(`  BAND  RANGE          HEADING                              MAPS TO              PROFILE`);
        section.columns.forEach((band, ci) => {
            const cells = dataRows.map((r) => r.cells[ci]);
            const prof = profile(cells);
            if (!band.header && prof === `empty:${cells.length}`) return;
            const mapsTo = spec ? RV.canonicalFieldFor(band.header || '', 'crystal', spec.fieldMap) : null;
            const range = `[${Math.round(band.start)},${Math.round(band.end)})`;
            console.log(
                `  ${String(ci).padStart(4)}  ${range.padEnd(14)} ${String(band.header ?? '(none)').slice(0, 36).padEnd(36)} ` +
                `${String(mapsTo ?? '-').padEnd(20)} ${prof}`,
            );
            const sample = cells.find((c) => c !== null && String(c).trim().length > 0);
            if (sample !== undefined) console.log(`        sample: ${JSON.stringify(mask(String(sample).slice(0, 44)))}`);
        });

        if (section.preambleText && section.preambleText.length) {
            console.log('  preamble:');
            for (const line of section.preambleText.slice(0, 6)) console.log(`    | ${mask(line.slice(0, 70))}`);
        }
    }
    // ---- what the mapper actually produced -------------------------------
    // Bands and headings say what was READ; this says what was KEPT. A section can look
    // perfect above and still map zero rows — a key column reading the wrong values is enough.
    if (!spec) return;
    for (const source of ['crystal', 'ssrs']) {
        let canonical;
        try {
            const service = new RV.CSReportValidationService({ specsDir: specsAbs });
            canonical = await service.ingestFile(path.resolve(process.cwd(), pdfPath), spec, source, { entity: 'DIAG' });
        } catch (err) {
            console.log(`\nMAPPING (${source}): failed — ${(err && err.message) || err}`);
            continue;
        }
        const perSection = {};
        for (const record of canonical.records) {
            perSection[record.sectionId] = (perSection[record.sectionId] || 0) + 1;
        }
        const coverage = canonical.meta.coverage || {};
        console.log(`\n${'='.repeat(78)}`);
        console.log(`MAPPING as source "${source}"`);
        console.log(`  records          : ${canonical.records.length}`);
        console.log(`  per section      : ${JSON.stringify(perSection)}`);
        console.log(`  mapped fields    : ${JSON.stringify(coverage.mappedFields || [])}`);
        console.log(`  UNMAPPED fields  : ${JSON.stringify(coverage.unmappedFields || [])}`);
        console.log(`  rows dropped     : ${JSON.stringify(coverage.skippedRowsBySection || {})}`);
        // Colliding keys vanish during matching, so surface them here rather than let the
        // comparison report them as missing data.
        const seen = new Map();
        for (const record of canonical.records) {
            const key = Object.keys(record.key).sort().map((k) => `${k}=${record.key[k]}`).join('|');
            const bucket = `${record.sectionId}::${key}`;
            seen.set(bucket, (seen.get(bucket) || 0) + 1);
        }
        const collisions = [...seen.values()].filter((n) => n > 1).length;
        console.log(`  key collisions   : ${collisions}`);
    }
})().catch((err) => {
    console.error('ERROR:', err && err.stack ? err.stack : err);
    process.exit(1);
});
