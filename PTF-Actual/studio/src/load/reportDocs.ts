/**
 * More report formats of load runs:
 *  - a comparison of 2 to 4 runs (the first is the reference): main numbers side by side with changes, each
 *    transaction's p95, response time and throughput over time on one chart;
 *  - PDF of any HTML report, printed by Chromium (the project's Playwright);
 *  - Word (.docx): the run's numbers as tables, its charts as pictures (drawn by Chromium when Playwright is there).
 */
import type { LoadRunDetail } from './runs';
import { REPORT_STYLE, svgChart } from './report';
import { describePolicy } from './policy';
import { Block, docx } from '../core/docx';
import { loadPlaywright } from './browserPath';
import { compareRuns, explainRun } from './explain';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLORS = ['#2563eb', '#d97706', '#16a34a', '#7c3aed'];
const mmss = (sec: number) => { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const when = (r: LoadRunDetail) => new Date(r.result?.startedAt ?? r.startedAt).toLocaleString();

/** Change from the reference, as text: +12% (worse is the caller's to judge). */
const change = (now: number, ref: number) => (ref ? `${now >= ref ? '+' : ''}${((100 * (now - ref)) / ref).toFixed(0)}%` : '');

const STATUS_COLOR: Record<string, string> = { green: '#1a7f37', amber: '#b45309', red: '#cf222e' };
const VERDICT: Record<string, string> = { better: 'better', worse: 'worse', same: '≈ same', info: '', new: 'new', gone: 'not run', failing: 'fails' };
/** The arrow follows the number (▲ went up, ▼ went down); the word says whether that is better or worse. */
export function verdictText(verdict: string, change: string): string {
    const word = VERDICT[verdict] ?? '';
    if (verdict !== 'better' && verdict !== 'worse') return word;
    const m = /([+\-−])\s*\d*\.?\d*[1-9]/.exec(change);
    const arrow = m ? (m[1] === '+' ? '▲ ' : '▼ ') : '';
    return `${arrow}${word}`;
}
/** Transactions of runs paired by their request's id (two requests may share a name); the label tells same names apart. */
function txRows(done: LoadRunDetail[]): Array<{ key: string; label: string; of: (r: LoadRunDetail) => NonNullable<LoadRunDetail['result']>['transactions'][number] | undefined }> {
    const key = (t: { id?: string; name: string }) => t.id || `name:${t.name}`;
    const seen = new Map<string, string>();
    for (const r of done) for (const t of r.result!.transactions) if (!seen.has(key(t))) seen.set(key(t), t.name);
    const count = new Map<string, number>();
    return [...seen].map(([k, name]) => {
        const n = (count.get(name) ?? 0) + 1; count.set(name, n);
        const same = [...seen.values()].filter((x) => x === name).length;
        return { key: k, label: same > 1 ? `${name} (${n})` : name, of: (r: LoadRunDetail) => r.result!.transactions.find((t) => key(t) === k) };
    });
}
const label = (r: LoadRunDetail, i: number) => `Run ${String.fromCharCode(65 + i)} (${when(r)})`;

/** 2–4 runs of a scenario compared: the first is the reference; each later run is judged against it in plain language. */
export function loadComparisonHtml(runs: LoadRunDetail[]): string {
    const done = runs.filter((r) => r.result).slice(0, 4);
    if (done.length < 2) throw new Error('Compare two to four finished runs.');
    const ref = done[0];
    const parts = done.slice(1).map((r, k) => ({ r, i: k + 1, c: compareRuns(ref.result!, r.result!, { a: label(ref, 0), b: label(r, k + 1) }, { a: ref.definition, b: r.definition }) }));
    const exec = parts.map(({ c }) => `<div class="status" style="border-color:${STATUS_COLOR[c.status]}"><div class="badge" style="background:${STATUS_COLOR[c.status]}">${c.status.toUpperCase()}</div><div><b>${esc(c.headline.replace(/^\w+ — /, ''))}</b><p>${esc(c.answer)}</p></div></div>`).join('');
    const vcell = (v: string, text: string) => `<td class="v-${v}">${esc(text)} <small>${verdictText(v, text)}</small></td>`;
    const metricTable = parts.map(({ c, i }) => `<h3>${esc(label(ref, 0))} → ${esc(label(done[i], i))}</h3><table class="explain"><tr><th>Measure</th><th>${esc(label(ref, 0))}</th><th>${esc(label(done[i], i))}</th><th>Change</th><th>What it means</th></tr>`
        + c.metrics.map((m) => `<tr><td>${esc(m.label)}</td><td>${esc(m.a)}</td><td><b>${esc(m.b)}</b></td>${vcell(m.verdict, m.change)}<td>${esc(m.meaning)}</td></tr>`).join('') + '</table>'
        + (c.findings.length ? `<ul>${c.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p>No transaction changed beyond normal variation.</p>')).join('');
    const tx = `<table><tr><th>Transaction (95% within)</th>${done.map((r, i) => `<th><span style="color:${COLORS[i]}">■</span> ${esc(label(r, i))}</th>`).join('')}</tr>${txRows(done).map(({ label: n, of }) => {
        const base = of(ref);
        return `<tr><td>${esc(n)}</td>${done.map((r, i) => { const t = of(r); if (!t) return '<td>—</td>'; if (t.errorRate >= 50) return vcell('failing', `${t.p95} ms (${Math.round(t.errorRate)}% errors)`); if (i === 0 || !base) return `<td>${t.p95} ms</td>`; const c = base.p95 ? Math.round((100 * (t.p95 - base.p95)) / base.p95) : 0; const v = Math.abs(c) < 10 || Math.abs(t.p95 - base.p95) < 20 ? 'same' : c > 0 ? 'worse' : 'better'; return vcell(v, `${t.p95} ms (${c >= 0 ? '+' : ''}${c}%)`); }).join('')}</tr>`;
    }).join('')}</table>`;
    const xs = [...new Set(done.flatMap((r) => r.result!.timeline.map((s) => s.t)))].sort((a, b) => a - b);
    const series = (get: (s: NonNullable<LoadRunDetail['result']>['timeline'][number]) => number) => done.map((r, i) => {
        const m = new Map(r.result!.timeline.map((s) => [s.t, get(s)]));
        return { name: label(r, i), color: COLORS[i], values: xs.map((x) => m.get(x) ?? 0) };
    });
    const notes = [...new Set(parts.flatMap((p) => p.c.notes))];
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(ref.name)} — comparison</title><style>${REPORT_STYLE}
.status{display:flex;gap:16px;align-items:center;border:2px solid;border-radius:8px;padding:12px 16px;margin:12px 0}.badge{color:#fff;font-weight:700;padding:10px 14px;border-radius:6px;font-size:18px}.status p{margin:4px 0 0}
table.explain td,table.explain th{text-align:left!important}td.v-worse,td.v-failing{color:#cf222e;font-weight:600}td.v-better{color:#1a7f37;font-weight:600}small{color:#6b7280;font-weight:400}</style></head><body>
<h1>${esc(ref.name)}: ${done.length} runs compared</h1>
<div class="m">${esc(ref.project)} · ${done.map((r, i) => `${esc(label(r, i))}: ${esc(r.env)}, ${esc(describePolicy(r.definition.policy))}`).join(' · ')}</div>
<h2>Verdict</h2>${exec}
<h2>Key measures</h2>${metricTable}
${notes.length ? `<p class="m">${notes.map(esc).join(' ')}</p>` : ''}
<h2>Over time</h2>
${svgChart('95% response time (ms), seconds from the start', xs, series((s) => s.p95))}
${svgChart('Requests per second', xs, series((s) => s.requests))}
${svgChart('Users', xs, series((s) => s.users))}
<h2>Every transaction</h2>${tx}
<p class="m">Run-to-run changes within ±10%, or under 20 ms, are normal variation and are shown as "same".</p>
</body></html>`;
}

/** The comparison as a Word document (charts as pictures when Chromium can draw them). */
export async function loadComparisonDocx(runs: LoadRunDetail[], projectRoot?: string): Promise<Buffer> {
    const done = runs.filter((r) => r.result).slice(0, 4);
    if (done.length < 2) throw new Error('Compare two to four finished runs.');
    const ref = done[0];
    const blocks: Block[] = [{ kind: 'heading', level: 1, text: `${ref.name}: ${done.length} runs compared` }, { kind: 'para', muted: true, runs: done.map((r, i) => `${label(r, i)}: ${r.env}, ${describePolicy(r.definition.policy)}`).join(' · ') }];
    for (let i = 1; i < done.length; i++) {
        const c = compareRuns(ref.result!, done[i].result!, { a: label(ref, 0), b: label(done[i], i) }, { a: ref.definition, b: done[i].definition });
        blocks.push({ kind: 'heading', level: 2, text: `${label(ref, 0)} → ${label(done[i], i)}` },
            { kind: 'para', runs: [{ text: `${c.status.toUpperCase()}  `, bold: true, color: STATUS_COLOR[c.status] }, { text: c.headline.replace(/^\w+ — /, ''), bold: true }] },
            { kind: 'para', runs: c.answer },
            { kind: 'table', header: ['Measure', label(ref, 0), label(done[i], i), 'Change', 'What it means'], widths: [2, 1.3, 1.3, 1.3, 4], rows: c.metrics.map((m) => [m.label, m.a, m.b, `${m.change} ${verdictText(m.verdict, m.change)}`.trim(), m.meaning]),
                shade: (k) => (c.metrics[k].verdict === 'worse' ? 'FFF5F5' : c.metrics[k].verdict === 'better' ? 'F0FFF4' : undefined) },
            ...c.findings.map((f) => ({ kind: 'para' as const, runs: `• ${f}` })),
            ...c.notes.map((n) => ({ kind: 'para' as const, muted: true, runs: n })));
    }
    const xs = [...new Set(done.flatMap((r) => r.result!.timeline.map((s) => s.t)))].sort((a, b) => a - b);
    const series = (get: (s: NonNullable<LoadRunDetail['result']>['timeline'][number]) => number) => done.map((r, i) => { const m = new Map(r.result!.timeline.map((s) => [s.t, get(s)])); return { name: label(r, i), color: COLORS[i], values: xs.map((x) => m.get(x) ?? 0) }; });
    const figs = [{ caption: '95% response time (ms)', svg: svgChart('95% response time (ms)', xs, series((s) => s.p95)) }, { caption: 'Requests per second', svg: svgChart('Requests per second', xs, series((s) => s.requests)) }];
    try { const pics = await chartsToPng(figs.map((f) => f.svg), projectRoot); blocks.push({ kind: 'heading', level: 2, text: 'Over time' }, ...pics.map((p, k) => ({ kind: 'image' as const, ...p, caption: figs[k].caption }))); }
    catch (e) { blocks.push({ kind: 'para', muted: true, runs: `Charts are in the HTML comparison (${(e as Error).message.split('\n')[0]}).` }); }
    blocks.push({ kind: 'heading', level: 2, text: 'Every transaction (95% within, ms)' }, { kind: 'table', header: ['Transaction', ...done.map((r, i) => label(r, i))], rows: txRows(done).map(({ label: n, of }) => [n, ...done.map((r) => String(of(r)?.p95 ?? '—'))]) },
        { kind: 'para', muted: true, runs: 'Run-to-run changes within ±10%, or under 20 ms, are normal variation.' });
    return docx(blocks, { title: `${ref.name} — comparison` });
}

/** Chromium of the project's Playwright (or the Studio's own); CS_BROWSER_EXECUTABLE points at an installed one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwBrowser = any;
async function chromium(projectRoot?: string): Promise<PwBrowser> {
    let pw: { chromium: { launch(o: object): Promise<PwBrowser> } } | undefined;
    try { pw = projectRoot ? loadPlaywright(projectRoot) : undefined; } catch { /* next */ }
    if (!pw) { try { pw = require('playwright'); } catch { throw new Error('PDF and Word charts need Playwright (npm install installs it with the framework).'); } }
    return pw!.chromium.launch({ headless: true, ...(process.env.CS_BROWSER_EXECUTABLE ? { executablePath: process.env.CS_BROWSER_EXECUTABLE } : {}) });
}

/** An HTML report printed to PDF (A4, backgrounds kept, details opened). */
export async function htmlToPdf(html: string, projectRoot?: string): Promise<Buffer> {
    const b = await chromium(projectRoot);
    try {
        const page = await b.newPage();
        await page.setContent(html.replace(/<details>/g, '<details open>'), { waitUntil: 'load' });
        return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
            displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' }));
    } finally { await b.close(); }
}

/** SVG charts (figure elements of svgChart) as PNG pictures, at twice the resolution. */
async function chartsToPng(figures: string[], projectRoot?: string): Promise<Array<{ png: Buffer; width: number; height: number }>> {
    if (!figures.length) return [];
    const b = await chromium(projectRoot);
    try {
        const page = await b.newPage({ deviceScaleFactor: 2 });
        const out: Array<{ png: Buffer; width: number; height: number }> = [];
        for (const f of figures) {
            await page.setContent(`<html><body style="margin:0;background:#fff;font-family:Arial,sans-serif"><style>figure{margin:0}figcaption{font-size:12px;font-weight:600}</style>${f}</body></html>`);
            const el = await page.$('svg');
            const box = await el!.boundingBox();
            out.push({ png: Buffer.from(await el!.screenshot()), width: Math.round(box!.width), height: Math.round(box!.height) });
        }
        return out;
    } finally { await b.close(); }
}

/** A run as a Word document. Charts are pictures when Chromium can draw them (else a note says where they are). */
export async function loadReportDocx(run: LoadRunDetail, projectRoot?: string): Promise<Buffer> {
    const r = run.result;
    if (!r) throw new Error('The run has no results.');
    const d = run.definition;
    const tl = r.timeline, x = tl.map((s) => s.t);
    const figs: Array<{ caption: string; svg: string }> = [
        { caption: 'Users and requests per second', svg: svgChart('Users and requests per second', x, [{ name: 'Users', color: '#7c3aed', values: tl.map((s) => s.users) }, { name: 'Requests per second', color: '#16a34a', values: tl.map((s) => s.requests), right: true }]) },
        { caption: 'Response time (ms)', svg: svgChart('Response time (ms)', x, [{ name: 'Average', color: '#2563eb', values: tl.map((s) => s.avg) }, { name: '95%', color: '#d97706', values: tl.map((s) => s.p95) }]) },
        ...(r.monitors ?? []).filter((m) => m.points.length > 1 && !m.generator).slice(0, 8).map((m) => ({ caption: `${m.name}${m.unit ? ` (${m.unit})` : ''}`, svg: svgChart(`${m.name}${m.unit ? ` (${m.unit})` : ''}`, m.points.map((p) => p.t), [{ name: m.name, color: '#7c3aed', values: m.points.map((p) => p.v) }], 860, 150) })),
    ];
    let pics: Array<{ png: Buffer; width: number; height: number }> = [];
    let chartNote = '';
    try { pics = await chartsToPng(figs.map((f) => f.svg), projectRoot); } catch (e) { chartNote = `Charts are in the HTML report (${(e as Error).message.split('\n')[0]}).`; }
    const pct = (v: number) => `${v.toFixed(2)}%`;
    const ex = explainRun(r, d);
    const RATING: Record<string, string> = { good: 'Good', acceptable: 'Acceptable', poor: 'Poor', critical: 'Not acceptable', info: '—' };
    const blocks: Block[] = [
        { kind: 'heading', level: 1, text: run.name },
        { kind: 'para', muted: true, runs: `${run.project} / ${run.env} · ${new Date(r.startedAt).toLocaleString()} – ${new Date(r.endedAt).toLocaleTimeString()} · ${describePolicy(d.policy)}` },
        { kind: 'para', runs: [{ text: `${ex.status.toUpperCase()}  `, bold: true, color: STATUS_COLOR[ex.status], size: 14 }, { text: ex.headline.replace(/^\w+ — /, ''), bold: true, size: 12 }] },
        { kind: 'para', runs: ex.answer },
        { kind: 'heading', level: 2, text: 'Executive summary' },
        { kind: 'table', header: ['Measure', 'Result', 'Rating', 'What it means'], widths: [2, 1.4, 1.2, 5], rows: ex.metrics.map((m) => [m.label, m.value, RATING[m.rating], `${m.meaning}${m.rating !== 'info' ? ` (Judged against ${m.basis}.)` : ''}`]),
            shade: (k) => ({ good: 'F0FFF4', acceptable: undefined, poor: 'FFFBEB', critical: 'FFF5F5', info: undefined } as Record<string, string | undefined>)[ex.metrics[k].rating] },
        { kind: 'heading', level: 3, text: `How it behaved over time: ${ex.behaviour.verdict}` }, { kind: 'para', runs: ex.behaviour.text },
        { kind: 'heading', level: 3, text: 'Risks and issues' }, ...(ex.risks.length ? ex.risks.map((t) => ({ kind: 'para' as const, runs: `• ${t}` })) : [{ kind: 'para' as const, runs: 'None found in this run.' }]),
        ...(ex.recommendations.length ? [{ kind: 'heading' as const, level: 3 as const, text: 'Recommended next steps' }, ...ex.recommendations.map((t, k) => ({ kind: 'para' as const, runs: `${k + 1}. ${t}` }))] : []),
        { kind: 'heading', level: 3, text: 'What the terms mean' }, ...ex.glossary.map((g) => ({ kind: 'para' as const, runs: [{ text: `${g.term}: `, bold: true }, { text: g.text }] })),
        { kind: 'pageBreak' },
        { kind: 'heading', level: 1, text: 'Technical details' },
        { kind: 'para', runs: [{ text: 'Result: ' }, { text: r.passed ? 'Passed' : `Failed${r.stopReason === 'error-rate' ? ' (stopped: too many errors)' : r.stopReason === 'alert' ? ' (stopped by a critical alert)' : ''}`, bold: true, color: r.passed ? '#1a7f37' : '#cf222e' }, ...(r.stopReason === 'stopped' ? [{ text: ` (stopped by hand after ${mmss(r.elapsed)} of ${mmss(run.definition.policy.duration)}: not the full test)`, color: '#9a6700' }] : [])] },
        ...(r.overload ? [{ kind: 'para' as const, runs: [{ text: r.overload, color: '#cf222e' }] }] : []),
        { kind: 'table', header: ['Requests', 'Errors', 'Average', '95%', '99%', 'Per second', 'Duration'], rows: [[String(r.total.count), pct(r.total.errorRate), `${r.total.avg} ms`, `${r.total.p95} ms`, `${r.total.p99} ms`, r.total.throughput.toFixed(1), mmss(r.elapsed)]] },
        ...pics.slice(0, 2).map((p, i) => ({ kind: 'image' as const, ...p, caption: figs[i].caption })),
        ...(chartNote ? [{ kind: 'para' as const, muted: true, runs: chartNote }] : []),
    ];
    if (r.slas.length) blocks.push({ kind: 'heading', level: 2, text: 'Service levels' }, { kind: 'table', header: ['Applies to', 'Result', 'Details'], widths: [2, 1, 4],
        rows: r.slas.map((s) => [`${s.name}${s.sla.per === 'interval' ? ' (every interval)' : ''}`, !s.pass ? 'Missed' : s.level === 'warning' ? 'Warning' : 'Met', s.details.join('; ')]),
        shade: (k) => (!r.slas[k].pass ? 'FFF5F5' : r.slas[k].level === 'warning' ? 'FFFBEB' : undefined) });
    if ((r.alerts ?? []).length) blocks.push({ kind: 'heading', level: 2, text: 'Alerts' }, { kind: 'table', header: ['At', 'Level', 'What'], widths: [1, 1, 6], rows: r.alerts.map((a) => [mmss(a.t), a.level, a.message]) });
    blocks.push({ kind: 'heading', level: 2, text: 'Transactions' }, { kind: 'table', header: ['Transaction', 'Count', 'Errors', 'Avg', '90%', '95%', '99%', 'Max', 'Per second'], widths: [3, 1, 1, 1, 1, 1, 1, 1, 1],
        rows: r.transactions.map((t) => [t.name, String(t.count), pct(t.errorRate), String(t.avg), String(t.p90), String(t.p95), String(t.p99), String(t.max), t.throughput.toFixed(2)]),
        shade: (k) => (r.transactions[k].errors ? 'FFF5F5' : undefined) }, { kind: 'para', muted: true, runs: 'Times in milliseconds.' });
    const errs = r.transactions.filter((t) => t.errors);
    if (errs.length) {
        blocks.push({ kind: 'heading', level: 2, text: 'Errors' });
        for (const t of errs) blocks.push({ kind: 'heading', level: 3, text: `${t.name} — ${t.errors} error${t.errors === 1 ? '' : 's'}` }, ...t.topErrors.map((e) => ({ kind: 'para' as const, runs: [{ text: `${e.count}× `, bold: true }, { text: e.message }] })));
    }
    if (pics.length > 2) { blocks.push({ kind: 'heading', level: 2, text: 'Monitoring' }); pics.slice(2).forEach((p, i) => blocks.push({ kind: 'image', ...p, caption: figs[i + 2].caption })); }
    blocks.push({ kind: 'para', muted: true, runs: `Think time ${d.thinkTime.min}–${d.thinkTime.max} ms${d.pacing ? `, pacing ${d.pacing} ms` : ''}, timeout ${d.timeout} ms. Secrets are masked in the error details.` });
    return docx(blocks, { title: `${run.name} — load test report` });
}
