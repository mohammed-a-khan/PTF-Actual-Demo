/**
 * A distributed load test: the same scenario run in parts on several computers (for example parallel
 * jobs of a pipeline, `cs-test-studio load … --part 2/4`), each writing its results (--json). Merging
 * gives the results of the whole test:
 *  - counts, errors and throughput add up; percentiles come from the merged response-time histograms
 *    (exact to the histogram's 1%, not an average of averages);
 *  - the timelines are put together second by second from each part's start (start the parts together:
 *    `--start-at` makes them wait for the same moment); the per-second 95% is the highest of the parts;
 *  - service levels are checked again on the merged numbers; monitors keep one series per part.
 */
import { averageTimings, Histogram, HistogramDump, Interval, IntervalStats, Second, statsOf, TransactionStats, TxSecond, zeroTimings } from './metrics';
import { TIMING_PHASES } from '../api/send';
import type { RunResult } from './engine';
import type { LoadRunDetail } from './runs';
import { checkSlas } from './scenario';
import { monitorChecks, MonitorSeries } from './monitor';
import { maxUsers } from './policy';

const r1 = (x: number) => Math.round(x * 10) / 10;

export function mergeRuns(parts: LoadRunDetail[]): LoadRunDetail {
    if (parts.length < 2) throw new Error('Give the results of at least two parts.');
    const results = parts.map((p, i) => { if (!p.result) throw new Error(`Part ${i + 1} has no results.`); if (!p.result.histograms) throw new Error(`Part ${i + 1} has no histograms (written by an older Studio): run it again.`); return p.result; });
    const def = parts[0].definition;
    for (const p of parts) if (p.name !== parts[0].name || p.scenario !== parts[0].scenario) throw new Error(`The parts are not of the same scenario (${parts[0].name} and ${p.name}).`);
    const seen = new Set<string>();
    for (const r of results) {
        if (!r.part) continue;
        const k = `${r.part.index}/${r.part.of}`;
        if (seen.has(k)) throw new Error(`Part ${r.part.index + 1} of ${r.part.of} is given twice.`);
        seen.add(k);
    }

    const elapsed = Math.max(...results.map((r) => r.elapsed));
    const secs = Math.max(elapsed, 0.001);
    const all = new Histogram();
    for (const r of results) all.merge(Histogram.load(r.histograms.total));

    // Transactions: histograms merged; errors and their samples added up.
    const ids = [...new Set(results.flatMap((r) => r.transactions.map((t) => t.id)))];
    const transactions: TransactionStats[] = ids.map((id) => {
        const h = new Histogram();
        let errors = 0, name = id, phaseCount = 0;
        const phaseSum = zeroTimings();
        const msgs = new Map<string, { count: number; samples: TransactionStats['topErrors'][number]['samples'] }>();
        for (const r of results) {
            const t = r.transactions.find((x) => x.id === id);
            if (!t) continue;
            name = t.name; errors += t.errors;
            // Phase averages weighted by each part's number of exchanges.
            if (t.phases && t.phaseCount) { phaseCount += t.phaseCount; for (const k of TIMING_PHASES) phaseSum[k] += t.phases[k] * t.phaseCount; }
            if (r.histograms.tx[id]) h.merge(Histogram.load(r.histograms.tx[id]));
            for (const e of t.topErrors) { const m = msgs.get(e.message) ?? { count: 0, samples: [] }; m.count += e.count; m.samples = [...m.samples, ...e.samples].slice(0, 3); msgs.set(e.message, m); }
        }
        return {
            id, name, count: h.count, errors, errorRate: h.count ? (100 * errors) / h.count : 0,
            avg: r1(h.avg), min: r1(h.count ? h.min : 0), max: r1(h.max), p50: r1(h.percentile(50)), p90: r1(h.percentile(90)), p95: r1(h.percentile(95)), p99: r1(h.percentile(99)),
            throughput: h.count / secs,
            ...(phaseCount ? { phases: averageTimings(phaseSum, phaseCount), phaseCount } : {}),
            topErrors: [...msgs].sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([message, m]) => ({ message, count: m.count, samples: m.samples })),
        };
    });

    // Timelines, second by second.
    const byT = new Map<number, Second[]>();
    for (const r of results) for (const s of r.timeline) byT.set(s.t, [...(byT.get(s.t) ?? []), s]);
    const timeline: Second[] = [...byT].sort((a, b) => a[0] - b[0]).map(([t, l]) => {
        const requests = l.reduce((n, s) => n + s.requests, 0);
        return { t, users: l.reduce((n, s) => n + s.users, 0), requests, errors: l.reduce((n, s) => n + s.errors, 0), avg: requests ? r1(l.reduce((n, s) => n + s.avg * s.requests, 0) / requests) : 0, p95: Math.max(0, ...l.map((s) => s.p95)) };
    });
    const txTimeline: Record<string, TxSecond[]> = {};
    for (const id of ids) {
        const m = new Map<number, TxSecond[]>();
        for (const r of results) for (const s of r.txTimeline?.[id] ?? []) m.set(s.t, [...(m.get(s.t) ?? []), s]);
        txTimeline[id] = [...m].sort((a, b) => a[0] - b[0]).map(([t, l]) => { const n = l.reduce((a, s) => a + s.n, 0); return { t, n, e: l.reduce((a, s) => a + s.e, 0), avg: n ? r1(l.reduce((a, s) => a + s.avg * s.n, 0) / n) : 0, p95: Math.max(0, ...l.map((s) => s.p95)) }; });
    }
    const monitors: MonitorSeries[] = results.flatMap((r, i) => (r.monitors ?? []).map((s) => ({ ...s, name: `${s.name} (part ${(r.part?.index ?? i) + 1})` })));
    const errors = transactions.reduce((n, t) => n + t.errors, 0);
    const total = { count: all.count, errors, errorRate: all.count ? (100 * errors) / all.count : 0, avg: r1(all.avg), p50: r1(all.percentile(50)), p90: r1(all.percentile(90)), p95: r1(all.percentile(95)), p99: r1(all.percentile(99)), max: r1(all.max), throughput: all.count / secs };
    // Monitors: a maximum applies to every part's series (each computer must stay under it).
    const due = results.some((r) => r.due !== undefined) ? results.reduce((n, r) => n + (r.due ?? 0), 0) : undefined;
    const dropped = results.some((r) => r.dropped !== undefined) ? results.reduce((n, r) => n + (r.dropped ?? 0), 0) : undefined;
    // Intervals: the parts' intervals at the same time added up; exact from their histograms (older results without
    // them: response-time percentiles of an interval are the highest of the parts', a cautious bound).
    const byT0 = new Map<number, Interval[]>();
    for (const r of results) for (const i of r.intervals ?? []) byT0.set(i.t0, [...(byT0.get(i.t0) ?? []), i]);
    const sumStats = (xs: IntervalStats[], secs: number): IntervalStats => {
        const count = xs.reduce((n, x) => n + x.count, 0), errors = xs.reduce((n, x) => n + x.errors, 0);
        return { count, errors, errorRate: count ? (100 * errors) / count : 0, avg: count ? Math.round((10 * xs.reduce((n, x) => n + x.avg * x.count, 0)) / count) / 10 : 0,
            p90: Math.max(...xs.map((x) => x.p90)), p95: Math.max(...xs.map((x) => x.p95)), p99: Math.max(...xs.map((x) => x.p99)), throughput: secs > 0 ? count / secs : 0 };
    };
    const intervals: Interval[] = [...byT0.entries()].sort((a, b) => a[0] - b[0]).map(([t0, xs]) => {
        const t1 = Math.max(...xs.map((x) => x.t1));
        const ids = [...new Set(xs.flatMap((x) => Object.keys(x.tx)))];
        // With every part's histograms: exact (the histograms added up).
        if (xs.every((x) => x.h)) {
            const add = (ds: Array<HistogramDump | undefined>) => { const h = new Histogram(); for (const d of ds) if (d) h.merge(Histogram.load(d)); return h; };
            const errs = (get: (x: Interval) => IntervalStats | undefined) => xs.reduce((n, x) => n + (get(x)?.errors ?? 0), 0);
            const total = add(xs.map((x) => x.h!.total));
            const tx = Object.fromEntries(ids.map((id) => [id, add(xs.map((x) => x.h!.tx[id]))]));
            return { t0, t1, total: statsOf(total, errs((x) => x.total), t1 - t0), tx: Object.fromEntries(ids.map((id) => [id, statsOf(tx[id], errs((x) => x.tx[id]), t1 - t0)])),
                h: { total: total.dump(), tx: Object.fromEntries(ids.map((id) => [id, tx[id].dump()])) } };
        }
        return { t0, t1, total: sumStats(xs.map((x) => x.total), t1 - t0), tx: Object.fromEntries(ids.map((id) => [id, sumStats(xs.map((x) => x.tx[id]).filter(Boolean), t1 - t0)])) };
    });
    const slas = [...checkSlas(def.slas, transactions, total, { due, dropped, intervals }), ...monitorChecks(monitors)];
    const overload = results.map((r, i) => (r.overload ? `Part ${(r.part?.index ?? i) + 1}: ${r.overload}` : '')).filter(Boolean).join(' ');
    const alerts = results.flatMap((r, i) => (r.alerts ?? []).map((a) => ({ ...a, message: `Part ${(r.part?.index ?? i) + 1}: ${a.message}` }))).sort((a, b) => a.t - b.t);
    const stopReason: RunResult['stopReason'] = results.some((r) => r.stopReason === 'alert') ? 'alert' : results.some((r) => r.stopReason === 'error-rate') ? 'error-rate' : results.some((r) => r.stopReason === 'stopped') ? 'stopped' : results.some((r) => r.stopReason === 'data-used') ? 'data-used' : 'completed';
    const popNames = results[0].populations ?? [];
    const result: RunResult = {
        state: 'finished', elapsed, users: 0, requests: total.count, errors, iterations: results.reduce((n, r) => n + r.iterations, 0), ...(dropped !== undefined ? { dropped } : {}), ...(due !== undefined ? { due } : {}), ...(overload ? { overload } : {}),
        timeline, transactions, txTimeline, populations: popNames.map((p) => ({ ...p, users: 0 })), monitors, alerts, intervals, total,
        startedAt: results.map((r) => r.startedAt).sort()[0], endedAt: results.map((r) => r.endedAt).sort().at(-1)!,
        stopReason, slas, passed: stopReason !== 'error-rate' && stopReason !== 'alert' && slas.every((s) => s.pass),
        histograms: { total: all.dump(), tx: Object.fromEntries(ids.map((id) => { const h = new Histogram(); for (const r of results) if (r.histograms.tx[id]) h.merge(Histogram.load(r.histograms.tx[id])); return [id, h.dump()]; })) },
    };
    return {
        id: parts[0].id, scenario: parts[0].scenario, name: parts[0].name, project: parts[0].project, env: parts[0].env, startedAt: result.startedAt, state: 'finished',
        maxUsers: maxUsers(def.policy), duration: def.policy.duration, passed: result.passed, stopReason, definition: def, result,
        summary: { requests: total.count, errorRate: total.errorRate, avg: total.avg, p95: total.p95, throughput: total.throughput },
        message: `Merged from ${parts.length} parts.`,
    };
}
