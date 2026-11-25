/**
 * Reports of a finished load run, to share outside the Studio:
 *  - HTML: one self-contained file (charts drawn as SVG, no scripts), summary, service levels, user
 *    paths, transactions, errors with the exchanges that failed.
 *  - Excel: the same numbers as sheets (summary, transactions, service levels, errors, timelines).
 */
import type { LoadRunDetail } from './runs';
import type { Second, TransactionStats, TxSecond } from './metrics';
import { Cell, Sheet, xlsx } from '../core/xlsx';
import { describePolicy } from './policy';
import { describeSource } from '../data/source';
import { runInsights } from './insights';
import { explainRun } from './explain';
import { labelOf, sameNameLabels, timeTicks } from './labels';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ms = (v: number) => `${v} ms`;
const pct = (v: number) => `${v.toFixed(2)}%`;
const mmss = (sec: number) => { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** An SVG line chart (one or two series; the second on its own right-hand scale). */
export function svgChart(title: string, x: number[], series: Array<{ name: string; color: string; values: number[]; right?: boolean }>, w = 860, h = 200): string {
    const pad = { l: 46, r: series.some((s) => s.right) ? 46 : 12, t: 26, b: 22 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const nice = (m: number) => { if (m <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(m))); for (const k of [1, 2, 2.5, 5, 10]) if (m <= k * p) return k * p; return 10 * p; };
    const lmax = nice(Math.max(0, ...series.filter((s) => !s.right).flatMap((s) => s.values).filter(Number.isFinite)));
    const rmax = nice(Math.max(0, ...series.filter((s) => s.right).flatMap((s) => s.values).filter(Number.isFinite)));
    const x0 = x[0] ?? 0, x1 = Math.max(x0 + 1, x[x.length - 1] ?? 1);
    const px = (t: number) => pad.l + ((t - x0) / (x1 - x0)) * iw;
    const py = (v: number, right?: boolean) => pad.t + ih - (v / (right ? rmax : lmax)) * ih;
    const f = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v < 10 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10));
    const grid = [0, 0.25, 0.5, 0.75, 1].map((k) => `<line x1="${pad.l}" x2="${pad.l + iw}" y1="${(pad.t + ih * (1 - k)).toFixed(1)}" y2="${(pad.t + ih * (1 - k)).toFixed(1)}" stroke="#e5e7eb"/>`
        + `<text x="${pad.l - 4}" y="${(pad.t + ih * (1 - k) + 3).toFixed(1)}" text-anchor="end">${f(lmax * k)}</text>`
        + (series.some((s) => s.right) ? `<text x="${pad.l + iw + 4}" y="${(pad.t + ih * (1 - k) + 3).toFixed(1)}">${f(rmax * k)}</text>` : '')).join('')
        // Whole seconds on the time axis, each label once (0:00, 0:01, 0:02… never "0:02" twice or a second skipped by rounding).
        + timeTicks(x0, x1).map((t) => `<text x="${px(t).toFixed(1)}" y="${h - 5}" text-anchor="${t <= x0 ? 'start' : t >= x1 ? 'end' : 'middle'}">${mmss(t)}</text>`).join('');
    // A value that is not a number: no measurement in that second (a transaction that did not run). The line joins the
    // seconds that have one, each marked with a dot when there are gaps (so a line between them is not read as data).
    const lines = series.map((s) => {
        const pts = s.values.map((v, i) => [x[i], v] as const).filter(([, v]) => Number.isFinite(v));
        if (!pts.length) return '';
        const gaps = pts.length < s.values.length;
        const path = pts.length > 1 ? `<path d="${pts.map(([t, v], i) => `${i ? 'L' : 'M'}${px(t).toFixed(1)},${py(v, s.right).toFixed(1)}`).join('')}" fill="none" stroke="${s.color}" stroke-width="1.6"${gaps ? ' stroke-dasharray="4 3"' : ''}/>` : '';
        const dots = gaps || pts.length === 1 ? pts.map(([t, v]) => `<circle cx="${px(t).toFixed(1)}" cy="${py(v, s.right).toFixed(1)}" r="2.5" fill="${s.color}"/>`).join('') : '';
        return path + dots;
    }).join('');
    const legend = series.map((s, i) => `<g transform="translate(${pad.l + 8 + i * 170},12)"><rect width="10" height="3" y="-3" fill="${s.color}"/><text x="14" y="0">${esc(s.name)}</text></g>`).join('');
    return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(title)}" font-size="10" fill="#6b7280">${grid}${lines}${legend}</svg></figure>`;
}

const RATING_LABEL: Record<string, string> = { good: 'Good', acceptable: 'Acceptable', poor: 'Poor', critical: 'Not acceptable', info: '—' };
const STATUS_COLOR: Record<string, string> = { green: '#1a7f37', amber: '#b45309', red: '#cf222e' };

/** The executive summary of a run: status, the plain answer, every number explained and rated, risks, next steps. */
export function executiveHtml(run: LoadRunDetail): string {
    const r = run.result!;
    const x = explainRun(r, run.definition);
    return `<section class="exec"><div class="status" style="border-color:${STATUS_COLOR[x.status]}"><div class="badge" style="background:${STATUS_COLOR[x.status]}">${x.status.toUpperCase()}</div>`
        + `<div><b>${esc(x.headline.replace(/^\w+ — /, ''))}</b><p>${esc(x.answer)}</p></div></div>`
        + `<h2>Executive summary</h2><table class="explain"><tr><th>Measure</th><th>Result</th><th>Rating</th><th>What it means</th></tr>`
        + x.metrics.map((m) => `<tr><td>${esc(m.label)}</td><td><b>${esc(m.value)}</b></td><td><span class="r-${m.rating}">${RATING_LABEL[m.rating]}</span></td><td>${esc(m.meaning)}${m.rating !== 'info' ? `<br><small>Judged against ${esc(m.basis)}.</small>` : ''}</td></tr>`).join('') + '</table>'
        + `<h3>How it behaved over time: ${esc(x.behaviour.verdict)}</h3><p>${esc(x.behaviour.text)}</p>`
        + (x.risks.length ? `<h3>Risks and issues</h3><ul>${x.risks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<h3>Risks and issues</h3><p>None found in this run.</p>')
        + (x.recommendations.length ? `<h3>Recommended next steps</h3><ol>${x.recommendations.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : '')
        + `<details class="gloss"><summary>What the terms mean</summary><dl>${x.glossary.map((g) => `<dt>${esc(g.term)}</dt><dd>${esc(g.text)}</dd>`).join('')}</dl></details></section>`;
}

/** The parts of a run's report as HTML, by name (what a report template places with {{name}}). */
export function reportSections(run: LoadRunDetail): Record<string, string> {
    const r = run.result;
    if (!r) throw new Error('The run has no results.');
    const d = run.definition;
    const tl: Second[] = r.timeline;
    const x = tl.map((s) => s.t);
    // Two requests with the same name are numbered in the order they ran (the collection's): "New request (1)", "(2)".
    const labels = sameNameLabels(r.transactions);
    const nm = (t: { id: string; name: string }) => esc(labelOf(labels, t));
    const kpi = (v: string, l: string) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    const verdict = (r.passed ? '<span class="ok">Passed</span>' : `<span class="bad">Failed${r.stopReason === 'error-rate' ? ' (stopped: too many errors)' : r.stopReason === 'alert' ? ' (stopped by a critical alert)' : ''}</span>`) + (r.stopReason === 'data-used' ? ' <span>(ended when every data row had been used once)</span>' : '') + (r.stopReason === 'stopped' ? ` <span class="warn">(stopped by hand after ${esc(mmss(r.elapsed))} of ${esc(mmss(d.policy.duration))}: not the full test)</span>` : '');
    const slas = r.slas.length ? `<h2>Service levels</h2><table><tr><th>Applies to</th><th>Result</th><th>Details</th></tr>${r.slas.map((s) => `<tr class="${s.pass ? (s.level === 'warning' ? 'warnrow' : '') : 'badrow'}"><td>${esc(s.name)}${s.sla.per === 'interval' ? ' (every interval)' : ''}</td><td>${!s.pass ? '<span class="bad">Missed</span>' : s.level === 'warning' ? '<span class="warn">Warning</span>' : '<span class="ok">Met</span>'}</td><td>${esc(s.details.join('; '))}</td></tr>`).join('')}</table>` : '';
    const alerts = (r.alerts ?? []).length ? `<h2>Alerts</h2><table><tr><th>At</th><th>Level</th><th>What</th></tr>${r.alerts.map((a) => `<tr class="${a.level === 'critical' ? 'badrow' : a.level === 'warning' ? 'warnrow' : ''}"><td>${mmss(a.t)}</td><td>${a.level}</td><td>${esc(a.message)}</td></tr>`).join('')}</table>` : '';
    const pops = (r.populations ?? []).length > 1 ? `<h2>User paths</h2><table><tr><th>User path</th><th>Share of users</th></tr>${r.populations.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.share}%</td></tr>`).join('')}</table>` : '';
    const tx = `<h2>Transactions</h2><table><tr><th>Transaction</th><th>Count</th><th>Errors</th><th>Avg</th><th>Min</th><th>50%</th><th>90%</th><th>95%</th><th>99%</th><th>Max</th><th>Per second</th></tr>${r.transactions.map((t) => `<tr class="${t.errors ? 'badrow' : ''}"><td>${nm(t)}</td><td>${t.count}</td><td>${t.errors} (${pct(t.errorRate)})</td><td>${t.avg}</td><td>${t.min}</td><td>${t.p50}</td><td>${t.p90}</td><td>${t.p95}</td><td>${t.p99}</td><td>${t.max}</td><td>${t.throughput.toFixed(2)}</td></tr>`).join('')}</table><p class="m">Times in milliseconds.</p>`;
    // Where the time goes: the average exchange per phase.
    const PH: Array<[keyof NonNullable<TransactionStats['phases']>, string]> = [['blocked', 'Waiting for a connection'], ['dns', 'DNS'], ['connect', 'Connect'], ['tls', 'TLS'], ['send', 'Send'], ['wait', 'Waiting for the server'], ['download', 'Download']];
    const withPhases = r.transactions.filter((t) => t.phases);
    // Every transaction has its row (one that never got an answer says so, rather than looking merged into another).
    const phases = withPhases.length ? `<h2>Where the time goes</h2><table><tr><th>Transaction</th>${PH.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr>${r.transactions.map((t) => (t.phases ? `<tr><td>${nm(t)}</td>${PH.map(([k]) => `<td>${t.phases![k]}</td>`).join('')}</tr>` : `<tr><td>${nm(t)}</td><td colspan="${PH.length}" class="m">No HTTP exchange completed (every request failed before an answer).</td></tr>`)).join('')}</table><p class="m">Average milliseconds per HTTP exchange; a kept-alive connection has no DNS, connect or TLS time.</p>` : '';
    const overload = r.overload ? `<p class="bad">${esc(r.overload)}</p>` : '';
    const sample = (s: NonNullable<LoadRunDetail['result']>['transactions'][number]['topErrors'][number]['samples'][number]) => `<details><summary>At ${mmss(s.t)}${s.user !== undefined ? `, user ${s.user + 1}` : ''}${s.response ? ` — HTTP ${s.response.status}` : ''}${s.page ? ` — on ${esc(s.page)}` : ''}</summary>`
        + (s.request ? `<pre>${esc(`${s.request.method} ${s.request.url}\n${Object.entries(s.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}${s.request.body ? `\n\n${s.request.body}` : ''}`)}</pre>` : '')
        + (s.response ? `<pre>${esc(`HTTP ${s.response.status} ${s.response.statusText ?? ''} (${s.response.timeMs} ms)\n${Object.entries(s.response.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}${s.response.body ? `\n\n${s.response.body}` : ''}`)}</pre>` : '') + '</details>';
    const errs = r.transactions.filter((t) => t.errors);
    const errors = errs.length ? `<h2>Errors</h2>${errs.map((t) => `<h3>${nm(t)} — ${t.errors} error${t.errors === 1 ? '' : 's'}</h3>${t.topErrors.map((e) => `<div class="err"><b>${e.count}×</b> ${esc(e.message)}${e.samples.map(sample).join('')}</div>`).join('')}`).join('')}` : '';
    // Per transaction over the whole run: its seconds without requests are 0 per second (so the line averages to the
    // table's "Per second"), and gaps in its times.
    const txCharts = r.transactions.filter((t) => (r.txTimeline?.[t.id] ?? []).length > 1).slice(0, 30).map((t) => {
        const by = new Map((r.txTimeline[t.id] as TxSecond[]).map((p) => [p.t, p]));
        const xs = x.length ? x : [...by.keys()];
        const at = (k: 'avg' | 'p95') => xs.map((sec) => by.get(sec)?.[k] ?? NaN);
        return svgChart(`${labelOf(labels, t)}: response time (ms) and requests per second (on average ${t.throughput.toFixed(2)} per second)`, xs, [{ name: 'Average', color: '#2563eb', values: at('avg') }, { name: '95%', color: '#d97706', values: at('p95') }, { name: 'Per second', color: '#16a34a', values: xs.map((sec) => by.get(sec)?.n ?? 0), right: true }], 860, 170);
    }).join('');
    const monitors = `${(r.monitors ?? []).some((m) => m.points.length > 1) ? `<h2>Monitoring</h2>${(r.monitors ?? []).filter((m) => m.points.length > 1).map((m) => svgChart(`${m.name}${m.unit ? ` (${m.unit})` : ''}${m.max !== undefined ? ` — maximum ${m.max}` : ''}`, m.points.map((p) => p.t), [{ name: m.name, color: m.generator ? '#6b7280' : '#7c3aed', values: m.points.map((p) => p.v) }], 860, 150)).join('')}` : ''}${(r.monitors ?? []).filter((m) => m.error).map((m) => `<p class="m">Monitor ${esc(m.name)}: ${esc(m.error)}</p>`).join('')}`;
    return {
        title: esc(run.name), name: esc(run.name), project: esc(run.project), environment: esc(run.env),
        started: esc(new Date(r.startedAt).toLocaleString()), ended: esc(new Date(r.endedAt).toLocaleString()), policy: esc(describePolicy(d.policy)),
        verdict, overload,
        meta: `<div class="m">${esc(run.project)} / ${esc(run.env)} · ${esc(new Date(r.startedAt).toLocaleString())} – ${esc(new Date(r.endedAt).toLocaleTimeString())} · ${esc(describePolicy(d.policy))} · ${verdict}</div>${overload}`,
        kpis: `<div class="k">${kpi(String(r.total.count), 'Requests')}${kpi(pct(r.total.errorRate), 'Errors')}${kpi(ms(r.total.avg), 'Average')}${kpi(ms(r.total.p95), '95%')}${kpi(ms(r.total.p99), '99%')}${kpi(r.total.throughput.toFixed(1), 'Per second')}${kpi(String(r.iterations), 'Iterations')}${r.dropped !== undefined ? kpi(String(r.dropped), 'Dropped') : ''}${kpi(mmss(r.elapsed), 'Duration')}</div>`,
        charts: [svgChart('Users and requests per second', x, [{ name: 'Users', color: '#7c3aed', values: tl.map((s) => s.users) }, { name: 'Requests per second', color: '#16a34a', values: tl.map((s) => s.requests), right: true }]),
            svgChart('Response time (ms)', x, [{ name: 'Average', color: '#2563eb', values: tl.map((s) => s.avg) }, { name: '95%', color: '#d97706', values: tl.map((s) => s.p95) }]),
            svgChart('Errors per second', x, [{ name: 'Errors', color: '#cf222e', values: tl.map((s) => s.errors) }])].join('\n'),
        executive: executiveHtml(run), technical: '<h2 class="tech">Technical details</h2>',
        slas, alerts, populations: pops, transactions: tx, phases, errors, monitors,
        insights: (() => { const x = runInsights(r); return `<h2>What the run says</h2><p>${esc(x.summary)}</p>${x.insights.length ? `<ul>${x.insights.map((i) => `<li class="${i.severity === 'critical' ? 'bad' : i.severity === 'warning' ? 'warn' : ''}"><b>${esc(i.title)}</b> — <span style="font-weight:400;color:#1f2328">${esc(i.detail)}</span></li>`).join('')}</ul>` : ''}`; })(),
        transactionCharts: txCharts ? `<h2>Per transaction</h2>${txCharts}` : '',
        settings: `<p class="m">Think time ${d.thinkTime.min}–${d.thinkTime.max} ms${d.pacing ? `, pacing ${d.pacing} ms` : ''}, timeout ${d.timeout} ms${d.data ? `, data ${esc(d.data.file ?? (d.data.source ? describeSource(d.data.source) : ''))} (${esc(d.data.mode)})` : ''}. Secrets are masked in the error details.</p>`,
        style: REPORT_STYLE,
    };
}

export const REPORT_STYLE = `body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:28px auto;max-width:980px;color:#1f2328;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}h3{font-size:13px;margin:14px 0 6px}
.m{color:#6b7280;font-size:13px}.k{display:flex;flex-wrap:wrap;gap:26px;margin:16px 0}.k b{display:block;font-size:20px}.k span{font-size:11px;color:#6b7280;text-transform:uppercase}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border-bottom:1px solid #e5e7eb;padding:5px 7px;text-align:left;vertical-align:top}th{background:#f6f8fa}td:not(:first-child),th:not(:first-child){text-align:right}
.badrow td{background:#fff5f5}.warnrow td{background:#fffbeb}.ok{color:#1a7f37;font-weight:600}.bad{color:#cf222e;font-weight:600}.warn{color:#b45309;font-weight:600}
figure{margin:10px 0}figcaption{font-size:12px;font-weight:600;margin-bottom:2px}.err{margin:6px 0 10px;font-size:13px}
details{margin:4px 0 0 18px}summary{cursor:pointer;color:#6b7280;font-size:12px}pre{background:#f6f8fa;padding:8px;font-size:11.5px;white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto}
.exec .status{display:flex;gap:16px;align-items:center;border:2px solid;border-radius:8px;padding:12px 16px;margin:16px 0}.exec .badge{color:#fff;font-weight:700;padding:10px 14px;border-radius:6px;font-size:18px}.exec .status p{margin:4px 0 0}
table.explain td:not(:first-child),table.explain th:not(:first-child){text-align:left}table.explain td:nth-child(2){white-space:nowrap}small{color:#6b7280}
.r-good{color:#1a7f37;font-weight:600}.r-acceptable{color:#2563eb;font-weight:600}.r-poor{color:#b45309;font-weight:600}.r-critical{color:#cf222e;font-weight:700}
h2.tech{margin-top:40px;font-size:18px;border-bottom:2px solid #1f2328}dl dt{font-weight:600;margin-top:6px}dl dd{margin:0 0 0 14px;font-size:13px}
@media print{.tech{break-before:page}details{display:block}pre{max-height:none}h2{break-after:avoid}figure,tr{break-inside:avoid}}`;

/** The default report: every section in order. A project's template (test/<project>/load/report-template.html) places them its own way. */
export const DEFAULT_REPORT_TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{{title}} — load test report</title><style>{{style}}</style></head><body>
<h1>{{name}}</h1>
{{meta}}
{{executive}}
{{technical}}
{{kpis}}
{{charts}}
{{insights}}
{{slas}}{{alerts}}{{populations}}{{transactions}}{{phases}}{{errors}}
{{monitors}}
{{transactionCharts}}
{{settings}}
</body></html>`;

/** The sections a template can use. */
export const REPORT_SECTIONS = ['title', 'name', 'project', 'environment', 'started', 'ended', 'policy', 'verdict', 'overload', 'meta', 'executive', 'technical', 'kpis', 'charts', 'insights', 'slas', 'alerts', 'populations', 'transactions', 'phases', 'errors', 'monitors', 'transactionCharts', 'settings', 'style'];

/** A run's HTML report: the default layout, or a template of the project's ({{section}} placeholders; unknown ones are left empty). */
export function loadReportHtml(run: LoadRunDetail, template?: string): string {
    const parts = reportSections(run);
    return (template ?? DEFAULT_REPORT_TEMPLATE).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => parts[k] ?? '');
}

export function loadReportXlsx(run: LoadRunDetail): Buffer {
    const r = run.result;
    if (!r) throw new Error('The run has no results.');
    const d = run.definition;
    const summary: Cell[][] = [
        ['Scenario', run.name], ['Project', run.project], ['Environment', run.env],
        ['Started', new Date(r.startedAt).toISOString()], ['Ended', new Date(r.endedAt).toISOString()], ['Duration (s)', r.elapsed],
        ['Load policy', describePolicy(d.policy)], ['Test data', d.data ? `${d.data.source ? describeSource(d.data.source) : d.data.file ?? ''} (${d.data.mode})` : 'none'], ['Result', r.passed ? 'Passed' : 'Failed'], ['Stop reason', r.stopReason],
        ['Requests', r.total.count], ['Errors', r.total.errors], ['Error rate (%)', Number(r.total.errorRate.toFixed(3))],
        ['Average (ms)', r.total.avg], ['50% (ms)', r.total.p50], ['90% (ms)', r.total.p90], ['95% (ms)', r.total.p95], ['99% (ms)', r.total.p99], ['Max (ms)', r.total.max],
        ['Requests per second', Number(r.total.throughput.toFixed(3))], ['Iterations', r.iterations], ...(r.dropped !== undefined ? [['Dropped iterations (all users busy)', r.dropped] as [string, number]] : []), ...(r.due !== undefined ? [['Iterations due (arrival rate)', r.due] as [string, number]] : []), ...(r.overload ? [['Load generator', r.overload] as [string, string]] : []),
        ...(r.populations ?? []).filter(() => (r.populations ?? []).length > 1).map((p): Cell[] => [`User path: ${p.name} (%)`, p.share]),
    ];
    const labels = sameNameLabels(r.transactions);
    const name = new Map(r.transactions.map((t) => [t.id, labelOf(labels, t)]));
    const sheets: Sheet[] = [
        { name: 'Summary', columns: ['Item', 'Value'], rows: summary, widths: [28, 50] },
        { name: 'Transactions', columns: ['Transaction', 'Count', 'Errors', 'Error rate (%)', 'Average (ms)', 'Min (ms)', '50% (ms)', '90% (ms)', '95% (ms)', '99% (ms)', 'Max (ms)', 'Per second'],
            rows: r.transactions.map((t) => [name.get(t.id) ?? t.name, t.count, t.errors, Number(t.errorRate.toFixed(3)), t.avg, t.min, t.p50, t.p90, t.p95, t.p99, t.max, Number(t.throughput.toFixed(3))]) },
        { name: 'Where the time goes', columns: ['Transaction', 'Exchanges', 'Waiting for a connection (ms)', 'DNS (ms)', 'Connect (ms)', 'TLS (ms)', 'Send (ms)', 'Waiting for the server (ms)', 'Download (ms)'],
            rows: r.transactions.filter((t) => t.phases).map((t) => [name.get(t.id) ?? t.name, t.phaseCount ?? t.count, t.phases!.blocked, t.phases!.dns, t.phases!.connect, t.phases!.tls, t.phases!.send, t.phases!.wait, t.phases!.download]) },
        { name: 'Service levels', columns: ['Applies to', 'Result', 'Details'], rows: r.slas.map((s) => [s.name, s.pass ? 'Met' : 'Missed', s.details.join('; ')]) },
        { name: 'Errors', columns: ['Transaction', 'Count', 'Message', 'First seen (s)', 'Request', 'Response status', 'Response body (start)', 'Page'],
            rows: r.transactions.flatMap((t) => t.topErrors.map((e): Cell[] => { const s = e.samples[0]; return [name.get(t.id) ?? t.name, e.count, e.message, s?.t, s?.request ? `${s.request.method} ${s.request.url}` : '', s?.response?.status, s?.response?.body?.slice(0, 1000) ?? '', s?.page ?? '']; })) },
        { name: 'Monitors', columns: ['Monitor', 'Second', 'Value', 'Unit', 'Maximum'], rows: (r.monitors ?? []).flatMap((m) => m.points.map((p): Cell[] => [m.name, p.t, p.v, m.unit, m.max])) },
        { name: 'Timeline', columns: ['Second', 'Users', 'Requests', 'Errors', 'Average (ms)', '95% (ms)'], rows: r.timeline.map((s) => [s.t, s.users, s.requests, s.errors, s.avg, s.p95]) },
        { name: 'Transaction timeline', columns: ['Transaction', 'Second', 'Requests', 'Errors', 'Average (ms)', '95% (ms)'],
            rows: Object.entries(r.txTimeline ?? {}).flatMap(([id, list]) => list.map((s): Cell[] => [name.get(id) ?? id, s.t, s.n, s.e, s.avg, s.p95])).slice(0, 1_000_000) },
    ];
    return xlsx(sheets);
}
