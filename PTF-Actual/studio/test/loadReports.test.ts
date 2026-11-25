/**
 * Reports of load runs: the HTML report from sections (alerts, warnings, the baseline gate), a project's own
 * template, a comparison of runs, PDF (Chromium) and Word (.docx, opened by LibreOffice when it is installed).
 * PDF and Word charts need Playwright: CS_FRAMEWORK_PROJECT (a project with it) and CS_BROWSER_EXECUTABLE.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LoadEngine, RunResult } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';
import { newRequest } from '../src/api/model';
import { loadReportHtml, reportSections } from '../src/load/report';
import { htmlToPdf, loadComparisonHtml, loadReportDocx } from '../src/load/reportDocs';
import type { LoadRunDetail } from '../src/load/runs';

const has = (cmd: string) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

async function twoRuns(): Promise<LoadRunDetail[]> {
    let slow = false, n = 0;
    const app = http.createServer((q, r) => { n++; setTimeout(() => { if (q.url === '/err' && n % 5 === 0) { r.writeHead(500); r.end('<oops & "x">'); } else r.end('ok'); }, slow ? 40 : 4); });
    const port = await new Promise<number>((res) => app.listen(0, '127.0.0.1', () => res((app.address() as net.AddressInfo).port)));
    try {
        const sc = { ...newScenario('Checkout <B&B>', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, policy: { type: 'constant' as const, users: 2, duration: 2 }, slaInterval: 1,
            slas: [{ target: '*', p95: 1000, warn: { p95: 20 } }, { target: 'pay', errorRate: 50, per: 'interval' as const }] };
        const run = async (): Promise<LoadRunDetail> => {
            const r: RunResult = await new LoadEngine({ scenario: sc, collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } },
                requests: [{ ...newRequest('Home', 'home'), url: '/', checks: [] }, { ...newRequest('Pay', 'pay'), url: '/err', checks: [] }], values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
            r.alerts.push({ t: 1.2, level: 'warning', source: 'monitor:CPU', message: 'CPU is at 75 %, over its warning level of 70 %' });
            return { id: `r${Math.random()}`, scenario: 'test/p/load/c.load.json', name: sc.name, project: 'p', env: 'qa', startedAt: r.startedAt, state: 'finished', maxUsers: 2, duration: 2, definition: sc, result: r };
        };
        const a = await run();
        slow = true;
        return [a, await run()];
    } finally { app.close(); }
}

test('reports: HTML sections and templates, comparison, PDF, Word', { timeout: 180_000 }, async (t) => {
    const [a, b] = await twoRuns();
    const html = loadReportHtml(b);
    assert.match(html, /<h1>Checkout &lt;B&amp;B&gt;<\/h1>/);
    assert.match(html, /<h2>Alerts<\/h2>.*CPU is at 75 %/s);
    assert.match(html, /class="warnrow".*<span class="warn">Warning<\/span>.*p95 [\d.]+ ms &gt; 20 ms \(warning\)/s);
    assert.match(html, /Pay \(every interval\)/);
    assert.ok(!html.includes('{{'), 'every placeholder filled');
    assert.ok(html.includes('&lt;oops &amp; &quot;x&quot;&gt;') || !html.includes('<oops'), 'response bodies escaped');
    // A project's template places the sections its own way; unknown placeholders are left empty.
    const own = loadReportHtml(b, '<html><body><header>ACME perf · {{ environment }}</header>{{kpis}}{{slas}}{{nope}}</body></html>');
    assert.match(own, /^<html><body><header>ACME perf · qa<\/header><div class="k">/);
    assert.ok(!own.includes('Transactions') && !own.includes('{{'));
    assert.ok(Object.keys(reportSections(b)).includes('transactionCharts'));
    // Comparison.
    const cmp = loadComparisonHtml([a, b]);
    assert.match(cmp, /2 runs compared/);
    assert.match(cmp, /<td class="v-worse">\+\d+% <small>▲ worse<\/small><\/td>/, 'the slower run is marked worse');
    assert.throws(() => loadComparisonHtml([a]), /two to four/);

    const root = process.env.CS_FRAMEWORK_PROJECT;
    if (!root || !process.env.CS_BROWSER_EXECUTABLE) { t.diagnostic('PDF / Word charts not checked: set CS_FRAMEWORK_PROJECT and CS_BROWSER_EXECUTABLE'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
    try {
        const pdf = await htmlToPdf(html, root);
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
        fs.writeFileSync(path.join(dir, 'r.pdf'), pdf);
        if (has('pdftotext')) {
            const text = execFileSync('pdftotext', ['-layout', path.join(dir, 'r.pdf'), '-'], { encoding: 'utf8' });
            assert.match(text, /Checkout <B&B>/);
            assert.match(text, /Alerts/);
            assert.match(text, /\b1 ?\/ ?\d/, 'page numbers in the footer');
        }
        const doc = await loadReportDocx(b, root);
        fs.writeFileSync(path.join(dir, 'r.docx'), doc);
        const list = execFileSync('unzip', ['-l', path.join(dir, 'r.docx')], { encoding: 'utf8' });
        assert.match(list, /word\/document\.xml/);
        assert.match(list, /word\/media\/chart1\.png/, 'charts as pictures');
        const { DOMParser } = await import('@xmldom/xmldom');
        for (const part of ['word/document.xml', 'word/styles.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels']) {
            const xml = execFileSync('unzip', ['-p', path.join(dir, 'r.docx'), part.replace(/[[\]]/g, '\\$&')], { encoding: 'utf8' });
            const errors: string[] = [];
            new DOMParser({ onError: (_l: string, m: string) => errors.push(m) } as never).parseFromString(xml, 'text/xml');
            assert.deepEqual(errors, [], part);
        }
        if (has('soffice')) {
            execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'r.docx')], { stdio: 'ignore', timeout: 120_000, env: { ...process.env, HOME: dir } });
            const text = execFileSync('pdftotext', ['-layout', path.join(dir, 'r.pdf'), '-'], { encoding: 'utf8' });
            assert.match(text, /Checkout <B&B>/);
            assert.match(text, /Service levels/);
            assert.match(text, /Transactions/);
            assert.match(text, /Pay/);
        } else t.diagnostic('LibreOffice not installed: the .docx was checked as XML only');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
