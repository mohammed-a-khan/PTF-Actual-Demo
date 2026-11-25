/**
 * Load-test results in plain language, for managers and business stakeholders as much as for engineers:
 *  - every number with what it means ("p95 2.1 s: 95 of every 100 requests finished within 2.1 seconds; one user
 *    in twenty waited longer") and a rating: against the team's own target when the scenario has one, otherwise
 *    against widely used guidance (response-time limits of interactive applications, Google's Core Web Vitals);
 *  - an overall status (green / amber / red) with the one-sentence answer ("Can the system serve 200 users?");
 *  - how the run behaved over time (stable, slowly degrading, unstable) and what that suggests;
 *  - risks and recommended next steps;
 *  - two runs of a scenario compared: what got better or worse, by how much, and whether it matters (changes
 *    within ±10% are treated as normal run-to-run variation).
 */
import type { RunResult } from './engine';
import type { LoadScenario, Sla } from './scenario';
import { runInsights } from './insights';
import { describePolicy, maxUsers } from './policy';
import { changeVerdict, labelOf, NOISE_MS, NOISE_PCT, sameNameLabels } from './labels';

export type Rating = 'good' | 'acceptable' | 'poor' | 'critical' | 'info';
export type Status = 'green' | 'amber' | 'red';
export interface ExplainedMetric { key: string; label: string; value: string; meaning: string; rating: Rating; basis: string }
export interface Explanation {
    status: Status; headline: string; answer: string;
    metrics: ExplainedMetric[];
    behaviour: { verdict: 'stable' | 'degrading' | 'unstable' | 'short'; text: string };
    risks: string[]; recommendations: string[];
    glossary: Array<{ term: string; text: string }>;
}

const sec = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
const pct = (v: number) => `${v < 0.1 && v > 0 ? v.toFixed(2) : v.toFixed(v < 10 ? 1 : 0)}%`;

/** Response-time guidance for interactive applications (when the team set no target of its own). */
function rateTime(ms: number, target?: number): { rating: Rating; basis: string } {
    if (target !== undefined) {
        const r: Rating = ms <= target * 0.8 ? 'good' : ms <= target ? 'acceptable' : ms <= target * 1.5 ? 'poor' : 'critical';
        return { rating: r, basis: `your target: ${sec(target)}` };
    }
    const r: Rating = ms <= 1000 ? 'good' : ms <= 3000 ? 'acceptable' : ms <= 10_000 ? 'poor' : 'critical';
    return { rating: r, basis: 'common guidance: under 1 s feels immediate, up to 3 s is tolerated, beyond 10 s users give up' };
}
function rateErrors(p: number, target?: number): { rating: Rating; basis: string } {
    if (target !== undefined) return { rating: p <= target * 0.5 ? 'good' : p <= target ? 'acceptable' : p <= target * 3 ? 'poor' : 'critical', basis: `your target: at most ${target}%` };
    return { rating: p <= 0.1 ? 'good' : p <= 1 ? 'acceptable' : p <= 5 ? 'poor' : 'critical', basis: 'common guidance: under 0.1% is healthy, above 1% users notice, above 5% the service is failing' };
}
const worst = (rs: Rating[]): Rating => (['critical', 'poor', 'acceptable', 'good'] as Rating[]).find((r) => rs.includes(r)) ?? 'info';

/** The target of a measure among the scenario's service levels for all requests. */
const targetOf = (slas: Sla[], k: 'p95' | 'p90' | 'p99' | 'avg' | 'errorRate' | 'throughput') => slas.find((s) => s.target === '*' && s[k] !== undefined)?.[k];

/** Least-squares slope of y over x. */
function slope(xs: number[], ys: number[]): number {
    const n = xs.length; if (n < 3) return 0;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return den ? num / den : 0;
}

export function explainRun(r: RunResult, d: Pick<LoadScenario, 'name' | 'policy' | 'slas'>): Explanation {
    const slas = d.slas ?? [];
    const users = maxUsers(d.policy);
    const t = r.total;
    const ins = runInsights(r);
    const m: ExplainedMetric[] = [];
    // A percentile without a target of its own follows the team's main response-time target (usually p95): the
    // median, average and p90 should be within it; the slowest 1% may take up to twice as long.
    const main = targetOf(slas, 'p95') ?? targetOf(slas, 'p90') ?? targetOf(slas, 'avg');
    const time = (key: 'avg' | 'p50' | 'p90' | 'p95' | 'p99', label: string, meaning: (v: string) => string) => {
        const own = key === 'p50' ? undefined : targetOf(slas, key);
        const derived = own === undefined && main !== undefined ? (key === 'p99' ? main * 2 : main) : undefined;
        const g = rateTime(t[key], own ?? derived);
        // Every request failed: its times are how fast it failed, not how fast the system answers.
        if (t.count > 0 && t.errors >= t.count) { m.push({ key, label, value: sec(t[key]), meaning: 'Every request failed, so this is how fast the requests failed, not how fast the system answers.', rating: 'info', basis: 'no successful request to measure' }); return; }
        if (own === undefined && derived !== undefined) g.basis = key === 'p99' ? `your response-time target of ${sec(main!)} (the slowest 1% allowed twice that, ${sec(derived)})` : `your response-time target of ${sec(main!)}`;
        m.push({ key, label, value: sec(t[key]), meaning: meaning(sec(t[key])), ...g });
    };
    m.push({ key: 'users', label: 'Simulated users', value: String(users), meaning: `Up to ${users} ${users === 1 ? 'person' : 'people'} using the system at the same time (${describePolicy(d.policy)}).`, rating: 'info', basis: 'the load applied' });
    m.push({ key: 'requests', label: 'Requests handled', value: t.count.toLocaleString('en'), meaning: t.errors >= t.count && t.count > 0 ? `${t.count.toLocaleString('en')} request${t.count === 1 ? ' was' : 's were'} sent in ${Math.round(r.elapsed)} s of testing, and every one failed.` : `The system answered ${t.count.toLocaleString('en')} request${t.count === 1 ? '' : 's'} in ${Math.round(r.elapsed)} s of testing${t.errors ? ` (${t.errors.toLocaleString('en')} with an error)` : ''}.`, rating: 'info', basis: 'volume of the test' });
    const thrTarget = targetOf(slas, 'throughput');
    m.push({ key: 'throughput', label: 'Throughput', value: `${t.throughput.toFixed(1)} requests/s`, meaning: `On average ${t.throughput.toFixed(1)} requests were completed every second${thrTarget !== undefined ? ` (target: at least ${thrTarget}/s)` : ''}. Throughput is the system's capacity actually delivered.`,
        rating: thrTarget !== undefined ? (t.throughput >= thrTarget ? 'good' : t.throughput >= thrTarget * 0.8 ? 'poor' : 'critical') : 'info', basis: thrTarget !== undefined ? `your target: ${thrTarget}/s` : 'compare it with the volume expected in production' });
    const eg = rateErrors(t.errorRate, targetOf(slas, 'errorRate'));
    m.push({ key: 'errorRate', label: 'Error rate', value: pct(t.errorRate), meaning: t.errors ? `${t.errors.toLocaleString('en')} of ${t.count.toLocaleString('en')} requests failed: ${t.errorRate >= 50 ? 'most user actions would have shown an error' : `about 1 in ${Math.max(2, Math.round(100 / Math.max(t.errorRate, 0.0001)))} user actions would have shown an error`}.` : 'No request failed.', ...eg });
    time('avg', 'Average response time', (v) => `A typical request took ${v}. The average hides the slow ones, so the percentiles below matter more.`);
    time('p50', 'Median (p50)', (v) => `Half of the requests finished within ${v}: what most users experienced.`);
    time('p90', '90th percentile (p90)', (v) => `90 of every 100 requests finished within ${v}; 1 user action in 10 was slower.`);
    time('p95', '95th percentile (p95)', (v) => `95 of every 100 requests finished within ${v}; 1 user action in 20 waited longer. This is the usual measure for service-level agreements.`);
    time('p99', '99th percentile (p99)', (v) => `99 of every 100 requests finished within ${v}; the slowest 1% (often your busiest or most important users) waited longer.`);
    m.push({ key: 'max', label: 'Slowest request', value: sec(t.max), meaning: `The single slowest request took ${sec(t.max)}. One outlier is normal; many near it are not.`, rating: 'info', basis: 'for information' });
    if (r.dropped !== undefined && r.due) {
        const dp = (100 * r.dropped) / r.due;
        m.push({ key: 'dropped', label: 'Arrivals not served', value: pct(dp), meaning: dp ? `${r.dropped} of ${r.due} planned user visits could not even start because every simulated user was busy: the system could not keep up with the arrival rate.` : 'Every planned user visit started on time.', rating: dp === 0 ? 'good' : dp < 1 ? 'acceptable' : dp < 5 ? 'poor' : 'critical', basis: 'the planned arrival rate' });
    }
    // Browser users: Google's Core Web Vitals thresholds.
    const vitals: Array<[RegExp, string, number, number, (v: number) => string, string]> = [
        [/^Web vitals › LCP/, 'Largest Contentful Paint', 2500, 4000, sec, 'when the main content of the page appeared'],
        [/^Web vitals › INP/, 'Interaction to Next Paint', 200, 500, sec, 'how quickly the page reacted to a click or key press'],
        [/^Web vitals › CLS/, 'Cumulative Layout Shift', 100, 250, (v) => (v / 1000).toFixed(2), 'how much the page jumped around while loading (×1000)'],
        [/^Web vitals › TTFB/, 'Time to First Byte', 800, 1800, sec, 'how long the server took to start answering'],
        [/^Web vitals › FCP/, 'First Contentful Paint', 1800, 3000, sec, 'when the first text or image appeared'],
    ];
    for (const [re, label, good, ok, fmt, what] of vitals) {
        const tx = r.transactions.filter((x) => re.test(x.name));
        if (!tx.length) continue;
        const v = Math.max(...tx.map((x) => x.p95));
        m.push({ key: label, label, value: fmt(v), meaning: `At the 95th percentile, ${what}: ${fmt(v)}.`, rating: v <= good ? 'good' : v <= ok ? 'acceptable' : 'poor', basis: `Google's Core Web Vitals: good ≤ ${fmt(good)}, needs improvement ≤ ${fmt(ok)}` });
    }
    // Behaviour over the steady part: response times flat, creeping up, or jumping around.
    const tl = r.timeline.filter((s) => s.requests > 0);
    const most = Math.max(0, ...tl.map((s) => s.users));
    const steady = tl.filter((s) => s.users >= most * 0.95);
    let behaviour: Explanation['behaviour'];
    if (steady.length < 20) behaviour = { verdict: 'short', text: 'The run was too short at full load to judge whether performance holds over time; run at least 10–15 minutes at the target load for that.' };
    else {
        const med = steady.map((s) => s.p95).sort((a, b) => a - b)[Math.floor(steady.length / 2)] || 1;
        const growth = (slope(steady.map((s) => s.t), steady.map((s) => s.p95)) * (steady[steady.length - 1].t - steady[0].t)) / med;
        const spread = steady.filter((s) => s.p95 > med * 2).length / steady.length;
        behaviour = growth > 0.3 ? { verdict: 'degrading', text: `At constant load, response times rose about ${Math.round(growth * 100)}% from the start to the end of the full-load period. Performance that worsens while the load stays the same usually points to resources running out (memory, connections, queues): a longer test is likely to get worse.` }
            : spread > 0.1 ? { verdict: 'unstable', text: `Response times were erratic at full load: in ${Math.round(spread * 100)}% of the seconds they were more than twice the usual. Users would experience the service as unreliable even when the averages look fine.` }
                : { verdict: 'stable', text: 'At full load, response times stayed level: the system coped with the load steadily for the length of the test.' };
    }
    // Status and the answer.
    const missed = r.slas.filter((s) => !s.pass);
    const ratings = m.filter((x) => x.rating !== 'info').map((x) => x.rating);
    const critical = ins.insights.some((i) => i.severity === 'critical');
    const status: Status = !r.passed || missed.length || r.stopReason === 'error-rate' || r.stopReason === 'alert' || worst(ratings) === 'critical' ? 'red'
        : worst(ratings) === 'poor' || critical || behaviour.verdict !== 'stable' || r.slas.some((s) => s.level === 'warning') || !!r.overload ? 'amber' : 'green';
    const what = `${users} simultaneous user${users === 1 ? '' : 's'}`;
    const answer = status === 'green' ? `Yes. The system handled ${what} within ${slas.length ? 'every agreed target' : 'commonly accepted response times'}, with ${pct(t.errorRate)} errors.`
        : status === 'amber' ? `Mostly, with concerns. The system handled ${what}${((x) => (x ? `, but ${x}` : ''))([worst(ratings) === 'poor' ? 'some response times or the error rate are in the poor range' : '', behaviour.verdict === 'short' ? (r.stopReason === 'stopped' ? 'the run was stopped before the end, too early to judge' : 'the run was too short at full load to judge whether performance holds') : behaviour.verdict !== 'stable' ? `performance was ${behaviour.verdict}` : '', r.slas.some((s) => s.level === 'warning') ? 'some targets were only just met' : '', r.overload ? 'the test equipment itself was overloaded, so the numbers are uncertain' : '', critical ? 'errors or anomalies need a look' : ''].filter(Boolean).join('; '))}.`
            : `No. ${missed.length ? `It missed ${missed.length} agreed target${missed.length === 1 ? '' : 's'} (${missed.slice(0, 3).map((s) => s.name).join(', ')})` : r.stopReason === 'error-rate' ? 'The test was stopped because too many requests failed' : r.stopReason === 'alert' ? 'The test was stopped by a critical alert' : 'Response times or errors are at unacceptable levels'} with ${what}.`;
    const headline = `${status === 'green' ? 'GREEN' : status === 'amber' ? 'AMBER' : 'RED'} — ${d.name}: ${status === 'green' ? 'ready for this load' : status === 'amber' ? 'acceptable with risks' : 'not ready for this load'}`;
    // Risks and recommendations.
    const risks: string[] = [];
    const recs: string[] = [];
    const short = (xs: string[]) => { const ds = xs.filter((x) => /[<>]/.test(x)); const list = ds.length ? ds : xs.slice(0, 1); const one = list.slice(0, 2).join('; '); return (list.length > 2 ? `${one}; …` : one).slice(0, 220); };
    for (const s of missed) { const t = short(s.details); risks.push(`Target missed: ${s.name} — ${t}${t.endsWith('…') ? '' : '.'}`); }
    for (const i of ins.insights.filter((x) => x.severity !== 'info').slice(0, 5)) risks.push(`${i.title}: ${i.detail}`);
    if (behaviour.verdict === 'degrading') recs.push('Run a longer test (an hour or more at the target load) and watch memory and connection pools on the servers.');
    if (eg.rating === 'poor' || eg.rating === 'critical') recs.push('Fix the most frequent errors first (see the error details): until then the response times are not representative.');
    if (worst(m.filter((x) => ['p95', 'p99'].includes(x.key)).map((x) => x.rating)) !== 'good') recs.push('Start with the slowest transactions (the table below): find where their time goes on the servers (database queries, external calls, locks).');
    if (ins.insights.some((i) => i.kind === 'capacity' && i.severity === 'warning')) recs.push('The system reached its limit during the test: before go-live, either scale it (more instances, larger database) or confirm that production traffic stays below that point.');
    if (r.overload) recs.push('Repeat the test with more load generators: this run\'s numbers include delays of the test equipment itself.');
    if (!slas.length) recs.push('Agree targets with the business (e.g. 95% of requests within 2 s, under 1% errors) so future runs are judged against them rather than general guidance.');
    if (!(r.monitors ?? []).some((x) => !x.generator && x.points.length)) recs.push('Add server monitors (CPU, memory, database) to the scenario so the cause of any slowdown can be seen next time.');
    if (status === 'green') recs.push('Keep this run as the baseline: later runs are compared with it automatically.');
    return {
        status, headline, answer, metrics: m, behaviour, risks: [...new Set(risks)].slice(0, 8), recommendations: [...new Set(recs)].slice(0, 6),
        glossary: [
            { term: 'Percentile (p90, p95, p99)', text: 'p95 = 2 s means 95 of every 100 requests finished within 2 seconds. Percentiles show what the slower users experience, which averages hide.' },
            { term: 'Throughput', text: 'Requests completed per second: the work the system actually delivered under the load.' },
            { term: 'Error rate', text: 'The share of requests that failed (server errors, timeouts, wrong answers).' },
            { term: 'Simulated users', text: 'Virtual people using the system at the same time, each following the recorded business steps with realistic pauses.' },
            { term: 'Steady part', text: 'The time at full load, after the ramp-up and before the ramp-down: the fairest picture of performance at the target load.' },
            { term: 'Baseline', text: 'An earlier, accepted run that new runs are compared with to catch regressions.' },
        ],
    };
}

export interface ComparedMetric { label: string; a: string; b: string; change: string; verdict: 'better' | 'worse' | 'same' | 'info'; meaning: string }
export interface Comparison {
    status: Status; headline: string; answer: string;
    metrics: ComparedMetric[];
    /** Paired by the request's id (two requests can have the same name); the error rates count in the verdict. */
    transactions: Array<{ id: string; name: string; /** The name, numbered in collection order when two requests share it ("New request (2)"). */ label: string; aP95: number; bP95: number; changePct: number; aErrorRate?: number; bErrorRate?: number; verdict: 'better' | 'worse' | 'same' | 'new' | 'gone' | 'failing'; why?: string }>;
    findings: string[]; notes: string[];
}

/** Run B against run A (A: the earlier / reference run). Changes within ±10% are run-to-run noise. */
export function compareRuns(a: RunResult, b: RunResult, names: { a: string; b: string }, defs?: { a?: Pick<LoadScenario, 'policy'>; b?: Pick<LoadScenario, 'policy'> }): Comparison {
    // One rule for every screen (Trends, a run against its baseline, Compare): see labels.ts changeVerdict.
    const NOISE = NOISE_PCT, MIN_MS = NOISE_MS;
    const ch = (x: number, y: number) => changeVerdict(x, y, 'rate').pct;
    const fmtC = (c: number) => { const r = Math.round(c); return r === 0 ? '0%' : `${r > 0 ? '+' : ''}${r}%`; };
    const metrics: ComparedMetric[] = [];
    const time = (k: 'avg' | 'p50' | 'p90' | 'p95' | 'p99', label: string) => {
        // The same rule as the transactions: a change counts from 10% and 20 ms (3.5 ms → 2.7 ms is noise).
        // Every time measure is judged alike; a large % of a few ms says so (it is "same" because of the ms).
        const { verdict: v, pct: c, diff: d } = changeVerdict(a.total[k], b.total[k], 'time');
        const small = Math.abs(d) < MIN_MS;
        const dMs = `${d >= 0 ? '+' : '−'}${Math.abs(d) < MIN_MS ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))} ms`;
        metrics.push({ label, a: sec(a.total[k]), b: sec(b.total[k]), change: fmtC(c), verdict: v,
            meaning: v === 'same' ? (small && Math.abs(c) >= NOISE ? `About the same: ${dMs} is under ${MIN_MS} ms (normal variation).` : `About the same: under ${NOISE}% (normal variation).`) : v === 'worse' ? `Users waited ${Math.abs(c).toFixed(0)}% longer.` : `Users waited ${Math.abs(c).toFixed(0)}% less.` });
    };
    const thr = changeVerdict(a.total.throughput, b.total.throughput, 'rate'), cThr = thr.pct;
    metrics.push({ label: 'Throughput', a: `${a.total.throughput.toFixed(1)}/s`, b: `${b.total.throughput.toFixed(1)}/s`, change: fmtC(cThr), verdict: thr.verdict, meaning: thr.verdict === 'same' ? 'Same amount of work delivered.' : cThr < 0 ? 'Less work delivered per second (if the load was the same, the system was slower to answer).' : 'More work delivered per second.' });
    const dErr = b.total.errorRate - a.total.errorRate;
    const errV = changeVerdict(a.total.errorRate, b.total.errorRate, 'errorRate').verdict;
    metrics.push({ label: 'Error rate', a: pct(a.total.errorRate), b: pct(b.total.errorRate), change: `${dErr >= 0 ? '+' : ''}${dErr.toFixed(2)} pts`, verdict: errV, meaning: errV === 'same' ? 'No meaningful change in failures.' : dErr > 0 ? 'More requests failed.' : 'Fewer requests failed.' });
    time('avg', 'Average response time'); time('p50', 'Median (p50)'); time('p90', '90th percentile (p90)'); time('p95', '95th percentile (p95)'); time('p99', '99th percentile (p99)');
    // Transactions by the request's id (not its name: two requests may share one), with their errors: a request
    // that failed more is worse whatever its times (a request failing every time answers fast).
    const txKey = (t: { id?: string; name: string }) => t.id || `name:${t.name}`;
    const keys2 = [...new Set([...a.transactions, ...b.transactions].map(txKey))];
    // Requests sharing a name: numbered in the order they ran (the collection's: each user goes through it in order).
    const labels = sameNameLabels([...b.transactions, ...a.transactions]);
    const ERR_PTS = 1;
    const txs: Comparison['transactions'] = keys2.map((k): Comparison['transactions'][number] => {
        const x = a.transactions.find((t) => txKey(t) === k), y = b.transactions.find((t) => txKey(t) === k);
        const id = (y ?? x)!.id ?? k, n = (y ?? x)!.name, label = labelOf(labels, (y ?? x)!);
        if (!x) return { id, name: n, label, aP95: 0, bP95: y!.p95, changePct: 0, bErrorRate: y!.errorRate, verdict: 'new' as const };
        if (!y) return { id, name: n, label, aP95: x.p95, bP95: 0, changePct: 0, aErrorRate: x.errorRate, verdict: 'gone' as const };
        const c = ch(x.p95, y.p95);
        const dE = (y.errorRate ?? 0) - (x.errorRate ?? 0);
        const timeV = changeVerdict(x.p95, y.p95, 'time').verdict;
        // Failing (most of its requests) in both runs: never "the same" as a request that works (its times are the errors').
        const failing = dE < ERR_PTS && dE > -ERR_PTS && y.errorRate >= 50;
        const verdict: 'same' | 'worse' | 'better' | 'failing' = dE >= ERR_PTS ? 'worse' : dE <= -ERR_PTS ? (timeV === 'worse' ? 'worse' : 'better') : failing ? 'failing' : timeV;
        const why = dE >= ERR_PTS || dE <= -ERR_PTS ? `errors ${pct(x.errorRate)} → ${pct(y.errorRate)}` : failing ? `fails in both runs: ${pct(y.errorRate)} errors` : undefined;
        return { id, name: n, label, aP95: x.p95, bP95: y.p95, changePct: Math.round(c), aErrorRate: x.errorRate, bErrorRate: y.errorRate, verdict, ...(why ? { why } : {}) };
    }).sort((p, q) => (q.verdict === 'worse' ? 1 : 0) - (p.verdict === 'worse' ? 1 : 0) || Math.abs(q.changePct) - Math.abs(p.changePct));
    const worse = txs.filter((t) => t.verdict === 'worse'), better = txs.filter((t) => t.verdict === 'better');
    const findings: string[] = [];
    for (const t of worse.slice(0, 5)) findings.push(t.why && (t.bErrorRate ?? 0) > (t.aErrorRate ?? 0) ? `${t.label} failed more: ${t.why}.` : `${t.label} got slower: 95% within ${sec(t.bP95)} instead of ${sec(t.aP95)} (${t.changePct > 0 ? '+' : ''}${t.changePct}%).`);
    for (const t of better.slice(0, 3)) findings.push(t.why ? `${t.label} failed less: ${t.why}.` : `${t.label} got faster: 95% within ${sec(t.bP95)} instead of ${sec(t.aP95)} (${t.changePct}%).`);
    for (const t of txs.filter((x) => x.verdict === 'failing').slice(0, 3)) findings.push(`${t.label} ${t.why}.`);
    for (const t of txs.filter((x) => x.verdict === 'new').slice(0, 3)) findings.push(`${t.label} is new in ${names.b}.`);
    for (const t of txs.filter((x) => x.verdict === 'gone').slice(0, 3)) findings.push(`${t.label} did not run in ${names.b}.`);
    const notes: string[] = [];
    const ua = defs?.a ? maxUsers(defs.a.policy) : undefined, ub = defs?.b ? maxUsers(defs.b.policy) : undefined;
    if (ua !== undefined && ub !== undefined && ua !== ub) notes.push(`The runs used different loads (${ua} vs ${ub} users): differences are partly due to that, not only to changes in the system.`);
    if (Math.abs(a.elapsed - b.elapsed) > Math.max(a.elapsed, b.elapsed) * 0.25) notes.push(`The runs lasted different times (${Math.round(a.elapsed)} s vs ${Math.round(b.elapsed)} s).`);
    if (b.overload || a.overload) notes.push('In at least one run the load generator was overloaded: treat small differences with caution.');
    notes.push('Changes within ±10%, or under 20 ms, are treated as normal run-to-run variation.');
    const p95 = metrics.find((x) => x.label.startsWith('95th'))!;
    const errM = metrics.find((x) => x.label === 'Error rate')!;
    const regress = p95.verdict === 'worse' || errM.verdict === 'worse' || worse.length > 0;
    const improve = !regress && (p95.verdict === 'better' || better.length > 0);
    const status: Status = !b.passed && a.passed ? 'red' : regress ? (Math.abs(ch(a.total.p95, b.total.p95)) > 25 || dErr > 1 || !b.passed ? 'red' : 'amber') : 'green';
    const headline = `${status.toUpperCase()} — ${names.b} ${regress ? 'is worse than' : improve ? 'is better than' : 'performs like'} ${names.a}`;
    const answer = regress ? `Performance regressed: ${[p95.verdict === 'worse' ? `the 95th percentile went from ${p95.a} to ${p95.b} (${p95.change})` : '', errM.verdict === 'worse' ? `errors went from ${errM.a} to ${errM.b}` : '', worse.length ? `${worse.length} transaction${worse.length === 1 ? '' : 's'} got slower` : ''].filter(Boolean).join('; ')}.${!b.passed && a.passed ? ' The new run fails its targets where the earlier one passed.' : ''}`
        : improve ? `Performance improved: the 95th percentile went from ${p95.a} to ${p95.b} (${p95.change}) with ${errM.b} errors.` : `No meaningful change: response times, throughput and errors are within normal variation of ${names.a}.`;
    return { status, headline, answer, metrics, transactions: txs, findings, notes };
}
