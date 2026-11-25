import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkFeature, checkSteps, compareModuleDir, detectFields, listPdfs, optionLines, pdfPathIn } from '../src/pdfcheck/pdfcheck';

/** A one-page PDF with Helvetica text lines at (x, y). */
function makePdf(lines: Array<[number, number, string]>): Buffer {
    const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const content = lines.map(([x, y, t]) => `BT /F1 10 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ];
    let out = '%PDF-1.4\n';
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

test('detectFields: label: value pairs, several in one cell, a label cell followed by its value', () => {
    const f = detectFields([
        { page: 1, cells: ['Invoice No: INV-7'] },
        { page: 1, cells: ['Customer: Dana Lee Date: 2026-03-04'] },
        { page: 1, cells: ['Total:', '$1,250.00'] },
        { page: 1, cells: ['A sentence without any label'] },
        { page: 2, cells: ['10:30 run time'] },
    ]);
    assert.deepEqual(f.map((x) => [x.label, x.value]), [['Invoice No', 'INV-7'], ['Customer', 'Dana Lee'], ['Date', '2026-03-04'], ['Total', '$1,250.00']]);
});

test('checkSteps / checkFeature: the framework steps for each source, records and options', () => {
    assert.deepEqual(checkSteps('out/a.pdf', { kind: 'file', file: 'test/p/data/a.json' }), ['Then the PDF "out/a.pdf" matches the data file "test/p/data/a.json"']);
    assert.deepEqual(checkSteps('a.pdf', { kind: 'file', file: 'p.xlsx', sheet: 'Q3' }, { key: 'Employee ID' }), ['Then the PDF "a.pdf" matches each record of the data file "p.xlsx" sheet "Q3" keyed by "Employee ID"']);
    assert.deepEqual(checkSteps('a.pdf', { kind: 'query', connection: 'SHOP', sql: 'SELECT "x"\n FROM t' }), ['Then the PDF "a.pdf" matches the query "SELECT \\"x\\" FROM t" on connection "SHOP"']);
    assert.deepEqual(checkSteps('a.pdf', { kind: 'pdf', file: 'b.pdf' }, { ignore: ['Run ID: \\w+'] }), ['Given PDF comparison options:', '  | ignore | Run ID: \\\\w+ |', 'And the PDF "a.pdf" matches the PDF "b.pdf"']);
    assert.deepEqual(checkSteps('a.pdf', { kind: 'values', rows: [['label', 'value'], ['Total', '1|2'], ['', '']] }), ['Then the PDF "a.pdf" shows:', '  | label | value |', '  | Total | 1\\|2  |']);
    assert.throws(() => checkSteps('a.pdf', { kind: 'values', rows: [] }), /at least one/);
    assert.deepEqual(optionLines({ keyColumns: ['Order No'], tolerance: 0.01, dayFirst: true, extraRows: true }), ['Given PDF comparison options:', '  | key columns | Order No |', '  | tolerance   | 0.01     |', '  | day first   | true     |', '  | extra rows  | fail     |']);
    const f = checkFeature('Invoice check', 'a.pdf', { kind: 'file', file: 'e.json' }, {}, ['smoke']);
    assert.match(f, /^@smoke\nFeature: Invoice check\n\n {2}Scenario: Invoice check\n {4}Then the PDF "a.pdf" matches the data file "e.json"\n$/);
});

test('listPdfs / pdfPathIn: PDFs of the repository only, newest first, node_modules and .git skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfl-'));
    try {
        for (const p of ['a/one.pdf', 'node_modules/x/two.pdf', '.git/three.pdf', 'b/c/four.PDF', 'notes.txt']) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), '%PDF-1.4'); }
        fs.utimesSync(path.join(dir, 'a/one.pdf'), new Date(2020, 0, 1), new Date(2020, 0, 1));
        assert.deepEqual(listPdfs(dir).map((f) => f.path), ['b/c/four.PDF', 'a/one.pdf']);
        assert.equal(pdfPathIn(dir, 'a/one.pdf'), path.join(dir, 'a/one.pdf'));
        assert.throws(() => pdfPathIn(dir, '../outside.pdf'), /inside the repository/);
        assert.throws(() => pdfPathIn(dir, 'notes.txt'), /Not a PDF/);
        assert.throws(() => pdfPathIn(dir, 'a/missing.pdf'), /Not found/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PDF check routes: list, inspect, compare (file, values, records, another PDF), report, feature preview', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfc-'));
    const dir = path.join(tmp, 'shop-tests');
    fs.mkdirSync(dir, { recursive: true });
    if (!compareModuleDir(dir)) { t.skip('the framework PDF comparison is not available (set CS_STUDIO_FRAMEWORK_DIR to a built framework)'); fs.rmSync(tmp, { recursive: true, force: true }); return; }
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const w = (p: string, d: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), d); };
        w('config/shop/common/common.env', 'PROJECT=shop\n');
        w('config/shop/environments/qa.env', 'BASE_URL=http://localhost\n');
        const invoice = (amountB: string) => makePdf([[72, 740, 'INVOICE'], [72, 715, 'Invoice No: INV-77'], [72, 700, 'Customer: Dana Lee'],
            [72, 670, 'Item'], [192, 670, 'Qty'], [312, 670, 'Amount'], [72, 655, 'A-1'], [192, 655, '2'], [312, 655, '1,250.00'], [72, 640, 'B-2'], [192, 640, '1'], [312, 640, amountB]]);
        w('out/invoice.pdf', invoice('99.50'));
        w('out/invoice-v2.pdf', invoice('98.50'));
        w('test/shop/data/expected.json', JSON.stringify({ 'Invoice No': 'INV-77', Customer: 'Dana Lee', Lines: [{ Item: 'A-1', Amount: 1250 }, { Item: 'B-2', Amount: '99.5' }] }));
        w('test/shop/data/lines.csv', 'Item,Qty,Amount\nA-1,2,1250\nB-2,1,99.50\n');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk' });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any, body: r.body, type: r.headers['content-type'] }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const list = await call('GET', '/api/pdf/list');
        assert.deepEqual(list.json.files.map((f: { path: string }) => f.path).sort(), ['out/invoice-v2.pdf', 'out/invoice.pdf']);
        assert.equal((await call('GET', '/api/pdf/file?path=out/invoice.pdf')).type, 'application/pdf');
        assert.equal((await call('GET', '/api/pdf/file?path=../x.pdf')).status, 400);
        const ins = await call('POST', '/api/pdf/inspect', { path: 'out/invoice.pdf' });
        assert.equal(ins.status, 200, JSON.stringify(ins.json));
        assert.equal(ins.json.pages, 1);
        assert.deepEqual(ins.json.fields.map((f: { label: string; value: string }) => [f.label, f.value]), [['Invoice No', 'INV-77'], ['Customer', 'Dana Lee']]);
        const base = { project: 'shop', env: 'qa', pdf: 'out/invoice.pdf' };
        const json = await call('POST', '/api/pdf/compare', { ...base, source: { kind: 'file', file: 'test/shop/data/expected.json' } });
        assert.equal(json.status, 200, JSON.stringify(json.json));
        assert.equal(json.json.passed, true, JSON.stringify(json.json.findings));
        assert.deepEqual(json.json.steps, ['Then the PDF "out/invoice.pdf" matches the data file "test/shop/data/expected.json"']);
        assert.match((await call('GET', `/api/pdf/report/${encodeURIComponent(json.json.reportId)}`)).body, /PDF comparison/);
        const values = await call('POST', '/api/pdf/compare', { ...base, source: { kind: 'values', rows: [['label', 'value'], ['Customer', 'Dana Lee'], ['Invoice No', 'INV-78']] } });
        assert.equal(values.json.passed, false);
        assert.deepEqual(values.json.findings.map((f: { kind: string; where: string }) => `${f.kind} ${f.where}`), ['FIELD_MISMATCH field "Invoice No"']);
        const two = await call('POST', '/api/pdf/compare', { ...base, pdf: 'out/invoice-v2.pdf', source: { kind: 'pdf', file: 'out/invoice.pdf' } });
        assert.equal(two.json.passed, false);
        assert.ok(two.json.findings.some((f: { expected?: string; actual?: string }) => /99\.50/.test(f.expected ?? '') && /98\.50/.test(f.actual ?? '')), JSON.stringify(two.json.findings));
        const recs = await call('POST', '/api/pdf/compare', { ...base, key: 'Invoice No', source: { kind: 'file', file: 'test/shop/data/expected.json' } });
        assert.equal(recs.status, 400, 'a JSON object with one list: the list is the records (lines here have no Invoice No)');
        const bad = await call('POST', '/api/pdf/compare', { ...base, source: { kind: 'ftp' } });
        assert.equal(bad.status, 400);
        const feat = await call('POST', '/api/pdf/feature', { ...base, name: 'Invoice matches expected', source: { kind: 'file', file: 'test/shop/data/expected.json' }, options: { dayFirst: true } });
        assert.equal(feat.status, 200, JSON.stringify(feat.json));
        assert.match(feat.json.file, /pdf\/invoice-matches-expected\.feature$/);
        assert.match(feat.json.text, /Given PDF comparison options:\n {6}\| day first \| true \|\n {4}And the PDF "out\/invoice\.pdf" matches the data file/);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
