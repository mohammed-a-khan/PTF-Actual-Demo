/**
 * What a load run says, worked out from its numbers (no AI service needed; the Studio's assistant can take it
 * from there):
 *  - anomalies: response-time spikes and error bursts (robust z-score against the run's own median), throughput
 *    dropping while the users stay the same;
 *  - capacity: the point where more users stop bringing more throughput and response times climb (the knee);
 *  - likely causes: monitors that moved with the response times, where the time of an exchange goes (waiting for
 *    the server, connecting, TLS, DNS, download), what the errors are and when they started, the slowest
 *    transactions, an overloaded load generator;
 *  - a short narrative summary.
 */
import { labelOf, sameNameLabels } from './labels';
import type { RunResult } from './engine';
import { correlateMonitors } from './analysis';

export interface Insight { kind: 'anomaly' | 'capacity' | 'cause' | 'note'; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; at?: { from: number; to: number } }
export interface Insights { summary: string; insights: Insight[] }

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Stretches of seconds where `bad(i)` holds (at least `min` seconds; gaps of one second joined). */
function stretches(n: number, bad: (i: number) => boolean, min = 2): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let start = -1, gap = 0;
    for (let i = 0; i <= n; i++) {
        if (i < n && bad(i)) { if (start < 0) start = i; gap = 0; continue; }
        if (start >= 0 && i < n && gap === 0) { gap++; continue; }
        if (start >= 0) { const end = i - gap; if (end - start >= min) out.push([start, end]); start = -1; gap = 0; }
    }
    return out;
}

export function runInsights(r: Pick<RunResult, 'timeline' | 'transactions' | 'monitors' | 'total' | 'overload' | 'slas' | 'passed' | 'elapsed' | 'stopReason'>): Insights {
    const out: Insight[] = [];
    const txl = sameNameLabels(r.transactions ?? []);
    const nm = (t: { id: string; name: string }) => labelOf(txl, t);
    const tl = (r.timeline ?? []).filter((s) => s.requests > 0);
    // ---- Response-time spikes: p95 of a second far above the run's usual (median + 5 × MAD, and at least 1.5 ×).
    if (tl.length >= 10) {
        const p = tl.map((s) => s.p95), med = median(p), mad = median(p.map((x) => Math.abs(x - med))) || med * 0.05 || 1;
        const high = (i: number) => p[i] > med + 5 * mad && p[i] > med * 1.5;
        for (const [a, b] of stretches(tl.length, high).slice(0, 5)) {
            const peak = Math.max(...p.slice(a, b));
            out.push({ kind: 'anomaly', severity: peak > med * 3 ? 'critical' : 'warning', title: `Response times jumped at ${mmss(tl[a].t)}–${mmss(tl[b - 1].t + 1)}`, detail: `The 95% went up to ${Math.round(peak)} ms (usually about ${Math.round(med)} ms) for ${tl[b - 1].t + 1 - tl[a].t} s.`, at: { from: tl[a].t, to: tl[b - 1].t + 1 } });
        }
        // ---- Error bursts: seconds with errors well above the usual share.
        const rate = tl.map((s) => s.errors / s.requests), base = median(rate);
        for (const [a, b] of stretches(tl.length, (i) => rate[i] > Math.max(0.05, base * 3) && tl[i].errors >= 2).slice(0, 5)) {
            const n = tl.slice(a, b).reduce((k, s) => k + s.errors, 0);
            out.push({ kind: 'anomaly', severity: 'critical', title: `Errors burst at ${mmss(tl[a].t)}–${mmss(tl[b - 1].t + 1)}`, detail: `${n} errors in ${tl[b - 1].t + 1 - tl[a].t} s (${Math.round(100 * Math.max(...rate.slice(a, b)))}% of the requests at the worst second).`, at: { from: tl[a].t, to: tl[b - 1].t + 1 } });
        }
        // ---- Throughput dropping while the users stay: the system slowed down (or the generator could not keep up).
        const steady = (i: number) => i > 4 && tl[i].users === tl[i - 3]?.users && tl[i].users > 0;
        const rps = tl.map((s) => s.requests), rpsMed = median(rps.filter((_, i) => steady(i)));
        if (rpsMed > 0) for (const [a, b] of stretches(tl.length, (i) => steady(i) && rps[i] < rpsMed * 0.5, 3).slice(0, 3))
            out.push({ kind: 'anomaly', severity: 'warning', title: `Throughput fell at ${mmss(tl[a].t)}–${mmss(tl[b - 1].t + 1)}`, detail: `About ${Math.round(Math.min(...rps.slice(a, b)))} requests/s with the same users (usually ${Math.round(rpsMed)}/s): the system answered more slowly, or stalled.`, at: { from: tl[a].t, to: tl[b - 1].t + 1 } });
    }
    // ---- Capacity: as users grow, throughput stops growing and response times climb.
    const byUsers = new Map<number, { rps: number[]; p95: number[] }>();
    for (const s of tl) { const x = byUsers.get(s.users) ?? { rps: [], p95: [] }; x.rps.push(s.requests); x.p95.push(s.p95); byUsers.set(s.users, x); }
    const levels = [...byUsers.entries()].filter(([, x]) => x.rps.length >= 3).map(([u, x]) => ({ u, rps: median(x.rps), p95: median(x.p95) })).sort((a, b) => a.u - b.u);
    if (levels.length >= 4) {
        // The first step up in users where throughput grows by less than a fifth of what the extra users would
        // bring, while responses are already 1.5 × slower than at the start, and stays flat from there on.
        const flat = (i: number) => levels[i].rps < levels[i - 1].rps * (1 + 0.2 * (levels[i].u / levels[i - 1].u - 1));
        const knee = levels.findIndex((l, i) => i >= 2 && flat(i) && l.p95 > levels[0].p95 * 1.5 && levels.slice(i + 1).filter((_, k) => flat(i + 1 + k)).length >= (levels.length - i - 1) * 0.7);
        if (knee > 0) {
            const k = levels[knee - 1];
            out.push({ kind: 'capacity', severity: 'warning', title: `Capacity reached at about ${k.u} user${k.u === 1 ? '' : 's'}`, detail: `Up to ${k.u} user${k.u === 1 ? '' : 's'} the system served about ${Math.round(k.rps)} requests/s; beyond that throughput hardly grew (${Math.round(levels[knee].rps)}/s at ${levels[knee].u} users) while the 95% rose from ${Math.round(levels[0].p95)} to ${Math.round(levels[knee].p95)} ms.` });
        } else out.push({ kind: 'capacity', severity: 'info', title: 'Throughput kept up with the users', detail: `From ${levels[0].u} to ${levels[levels.length - 1].u} users the requests per second grew with them: no limit was reached in this run.` });
    }
    // ---- Causes: monitors that moved with the response times.
    // The servers' monitors (the load generator's own are about the test equipment, see overload).
    const own = new Set((r.monitors ?? []).filter((x) => x.generator).map((x) => x.name));
    for (const c of correlateMonitors(r).filter((x) => !own.has(x.monitor) && (x.strength === 'strong' || x.strength === 'moderate')).slice(0, 3))
        out.push({ kind: 'cause', severity: c.strength === 'strong' ? 'warning' : 'info', title: `${c.monitor} ${c.r > 0 ? 'rose' : 'fell'} with the response times`, detail: `Correlation ${c.r} over ${c.n} samples: ${c.r > 0 ? `look at what loads ${c.monitor} first` : `${c.monitor} dropping as responses slowed suggests a queue or a limit elsewhere`}.` });
    // ---- Where the time goes (HTTP phases).
    const ph = r.transactions.filter((t) => t.phases && t.phaseCount).map((t) => ({ t, p: t.phases! }));
    if (ph.length) {
        const sum = (k: keyof NonNullable<(typeof ph)[number]['p']>) => ph.reduce((n, x) => n + x.p[k] * (x.t.phaseCount ?? 0), 0);
        const n = ph.reduce((k, x) => k + (x.t.phaseCount ?? 0), 0);
        const parts = { wait: sum('wait'), connect: sum('connect') + sum('blocked'), tls: sum('tls'), dns: sum('dns'), download: sum('download'), send: sum('send') };
        const total = Object.values(parts).reduce((a, b) => a + b, 0);
        if (total > 0) {
            const [top, v] = Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
            const share = Math.round((100 * v) / total);
            const what: Record<string, string> = { wait: 'waiting for the server to answer (its processing time)', connect: 'opening connections or waiting for a free one', tls: 'TLS handshakes (connections not reused?)', dns: 'name lookups (DNS)', download: 'downloading the answers (size or bandwidth)', send: 'sending the requests (large bodies)' };
            out.push({ kind: 'cause', severity: top === 'wait' ? 'info' : 'warning', title: `${share}% of the time is ${what[top].split(' (')[0]}`, detail: `Over ${n} exchanges, an average of ${Math.round(v / n)} ms per exchange goes to ${what[top]}.` });
        }
    }
    // ---- Errors: the most frequent ones and when they started.
    const errs = r.transactions.flatMap((t) => t.topErrors.map((e) => ({ t, e }))).sort((a, b) => b.e.count - a.e.count).slice(0, 3);
    for (const { t, e } of errs) {
        const first = Math.min(...e.samples.map((s) => s.t));
        const status = /HTTP (\d{3})/.exec(e.message)?.[1] ?? (e.samples.find((s) => s.response)?.response?.status ? String(e.samples.find((s) => s.response)!.response!.status) : '');
        const hint = /^5\d\d$/.test(status) ? (status === '503' || status === '502' || status === '504' ? 'the server or a gateway in front of it was overloaded or unavailable' : 'the server failed while processing') : /^429$/.test(status) ? 'rate limiting: the system refused the extra load' : /^4\d\d$/.test(status) ? 'requests the server rejected (test data used twice, expired session, missing correlation)' : /timed? ?out|ETIMEDOUT/i.test(e.message) ? 'answers took longer than the timeout' : /ECONNRESET|ECONNREFUSED|socket hang up/i.test(e.message) ? 'connections refused or dropped (a limit on connections, or a restart)' : 'see the error samples';
        out.push({ kind: 'cause', severity: 'critical', title: `${e.count}× "${e.message.slice(0, 80)}" on ${nm(t)}`, detail: `${Number.isFinite(first) ? `First seen at ${mmss(first)}. ` : ''}Likely: ${hint}.` });
    }
    // ---- The slowest transactions (when one stands out).
    const busy = r.transactions.filter((t) => t.count >= 10).sort((a, b) => b.p95 - a.p95);
    if (busy.length >= 2 && busy[0].p95 > busy[1].p95 * 2) out.push({ kind: 'cause', severity: 'info', title: `${nm(busy[0])} is the slowest by far`, detail: `Its 95% is ${busy[0].p95} ms, more than twice the next one (${nm(busy[1])}, ${busy[1].p95} ms): start there.` });
    if (r.overload) out.push({ kind: 'note', severity: 'warning', title: 'The load generator was the bottleneck', detail: r.overload });

    // ---- The narrative.
    const missed = r.slas.filter((s) => !s.pass), warned = r.slas.filter((s) => s.pass && s.level === 'warning');
    const sentences = [
        `${r.passed ? 'The run passed' : 'The run failed'}: ${r.total.count.toLocaleString('en')} requests in ${Math.round(r.elapsed)} s (${r.total.throughput.toFixed(1)}/s), ${r.total.errorRate.toFixed(2)}% errors, 95% under ${r.total.p95} ms.`,
        missed.length ? `It missed ${missed.map((s) => `${s.name} (${s.details.filter((d) => /[<>]/.test(d)).join(', ') || s.details[0]})`).slice(0, 3).join('; ')}.` : warned.length ? `Every service level was met, ${warned.length} only with a warning.` : '',
        r.stopReason !== 'completed' ? `It ${r.stopReason === 'error-rate' ? 'was stopped early: too many errors' : r.stopReason === 'alert' ? 'was stopped by a critical alert' : r.stopReason === 'data-used' ? 'ended when the test data ran out' : 'was stopped before the end'}.` : '',
        ...out.filter((i) => i.severity !== 'info').slice(0, 3).map((i) => `${i.title}${i.title.endsWith('.') ? '' : '.'}`),
        out.some((i) => i.kind === 'cause' && i.severity !== 'critical' && /rose with/.test(i.title)) ? 'The monitors point at where to look first.' : '',
    ].filter(Boolean);
    return { summary: sentences.join(' '), insights: out };
}
