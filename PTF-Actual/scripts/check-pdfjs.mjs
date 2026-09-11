#!/usr/bin/env node
/**
 * Report which pdfjs-dist the PDF extractor will actually use.
 *
 * The extractor loads pdfjs through an ESM dynamic import. Node resolves ESM and CommonJS
 * separately, so a project holding two copies — one hoisted at the top level, one nested
 * under a dependency — can hand each path a DIFFERENT install. Checking the version with
 * `require('pdfjs-dist/package.json')`, or by reading package.json by hand, can therefore
 * report a version that is not the one parsing anything.
 *
 * Why it matters: a multi-word column heading that one pdfjs major returns as a single text
 * item can come back as several from another. The band header is then a fragment, it matches
 * no spec column, and every row in that section is discarded for want of a business key —
 * silently, and looking exactly like a report with no data in it.
 *
 * Run from the project whose tests are failing:
 *   node node_modules/@mdakhan.mak/cs-playwright-test-framework/scripts/check-pdfjs.mjs
 */
import { createRequire } from 'module';

const SUPPORTED_MAJOR = 4;
const require = createRequire(import.meta.url);

let esmVersion = null;
let esmError = null;
try {
    esmVersion = (await import('pdfjs-dist/legacy/build/pdf.mjs')).version ?? '(module exports no version)';
} catch (err) {
    esmError = err && err.message ? err.message : String(err);
}

let cjsVersion = null;
try {
    cjsVersion = require('pdfjs-dist/package.json').version;
} catch {
    cjsVersion = '(unresolvable via CommonJS)';
}

console.log('');
console.log('  pdfjs the extractor LOADS (ESM) :', esmError ? `FAILED — ${esmError}` : esmVersion);
console.log('  pdfjs package.json reports (CJS):', cjsVersion);
console.log('');

if (esmError) {
    console.log('  pdfjs could not be loaded at all. Install it:  npm install pdfjs-dist@4.10.38 --save-exact');
    process.exit(2);
}

const major = Number(String(esmVersion).split('.')[0]);
if (Number.isFinite(major) && major !== SUPPORTED_MAJOR) {
    console.log(`  PROBLEM: layout analysis is written and tested against ${SUPPORTED_MAJOR}.x.`);
    console.log('  Fix:  npm install pdfjs-dist@4.10.38 --save-exact');
    console.log('  Then re-run this check — it must report 4.x on the ESM line, which is the one that counts.');
    process.exit(1);
}
if (cjsVersion !== esmVersion) {
    console.log('  WARNING: the two resolution paths disagree — this project holds more than one');
    console.log('  copy of pdfjs. The ESM line is the one the extractor uses. Deduplicate with:');
    console.log('    npm ls pdfjs-dist        (shows every copy and who pulled it in)');
    console.log('    npm dedupe');
    process.exit(1);
}
console.log(`  OK — the extractor will use pdfjs ${esmVersion}.`);
