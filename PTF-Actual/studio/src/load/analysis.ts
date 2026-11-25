/**
 * Analysis of load runs:
 *  - statistics over a range of the run (e.g. without the ramp-up and ramp-down), exact: the intervals' histograms
 *    are added up;
 *  - the steady part of a run (the intervals while the planned users were all running);
 *  - how each monitor moved with the response times (Pearson correlation over the run);
 *  - up to four runs side by side on one time axis;
 *  - a regression gate against a baseline run of the same scenario (per transaction: p95, average, errors,
 *    throughput), which fails the run like a service level.
 */
import { Histogram, Interval, IntervalStats, statsOf } from './metrics';
import type { RunResult } from './engine';

export interface RangeTx extends IntervalStats { id: string; name: string; p50: number; max: number }
export interface RangeStats { from: number; to: number; seconds: number; intervals: number; total: RangeTx; tx: RangeTx[]; exact: boolean }

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Statistics of the intervals inside [from, to] seconds (exact when the intervals kept their histograms). */
export function rangeStats(intervals: Interval[], from: number, to: number, names: Record<string, string> = {}): RangeStats {
    const inside = intervals.filter((i) => i.t0 >= from && i.t1 <= to);
    const seconds = inside.reduce((n, i) => n + (i.t1 - i.t0), 0);
    const exact = inside.every((i) => i.h);
    const one = (id: string, name: string, get: (i: Interval) => { s?: IntervalStats; h?: import('./metrics').HistogramDump }): RangeTx => {
        const h = new Histogram();
        let errors = 0, count = 0, sum = 0, p90 = 0, p95 = 0, p99 = 0, max = 0;
        for (const i of inside) {
            const x = get(i);
            if (!x.s) continue;
            errors += x.s.errors; count += x.s.count; sum += x.s.avg * x.s.count;
            p90 = Math.max(p90, x.s.p90); p95 = Math.max(p95, x.s.p95); p99 = Math.max(p99, x.s.p99);
            if (x.h) { h.merge(Histogram.load(x.h)); max = Math.max(max, x.h.max); }
        }
        if (exact && h.count) { const s = statsOf(h, errors, seconds); return { id, name, ...s, p50: r1(h.percentile(50)), max: r1(h.max) }; }
        // Without histograms: counts and the average are exact, percentiles are the highest interval's.
        return { id, name, count, errors, errorRate: count ? (100 * errors) / count : 0, avg: count ? r1(sum / count) : 0, p50: 0, p90, p95, p99, max, throughput: seconds ? count / seconds : 0 };
    };
    const ids = [...new Set(inside.flatMap((i) => Object.keys(i.tx)))];
    return {
        from: inside[0]?.t0 ?? from, to: inside.at(-1)?.t1 ?? to, seconds, intervals: inside.length, exact,
        total: one('*', 'All requests', (i) => ({ s: i.total, h: i.h?.total })),
        tx: ids.map((id) => one(id, names[id] ?? id, (i) => ({ s: i.tx[id], h: i.h?.tx[id] }))),
    };
}

/** The steady part: from the first to the last second with at least 95% of the most users, snapped to whole intervals inside it. */
export function steadyRange(run: Pick<RunResult, 'timeline' | 'intervals'>): { from: number; to: number } | null {
    const tl = run.timeline ?? [];
    const most = Math.max(0, ...tl.map((s) => s.users));
    if (!most) return null;
    const full = tl.filter((s) => s.users >= most * 0.95);
    const a = full[0].t, b = full.at(-1)!.t + 1;
    const inside = (run.intervals ?? []).filter((i) => i.t0 >= a && i.t1 <= b);
    return inside.length ? { from: inside[0].t0, to: inside.at(-1)!.t1 } : { from: a, to: b };
}

export interface Correlation { monitor: string; unit: string; r: number; n: number; strength: 'strong' | 'moderate' | 'weak' | 'none' }

/** Pearson correlation of two series. */
export function pearson(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 3) return 0;
    const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n, my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Each monitor against the response time (p95 of the second of each sample): which ones moved with it. */
export function correlateMonitors(run: Pick<RunResult, 'timeline' | 'monitors'>): Correlation[] {
    const bySecond = new Map((run.timeline ?? []).filter((s) => s.requests > 0).map((s) => [s.t, s.p95]));
    return (run.monitors ?? []).filter((m) => m.points.length >= 3).map((m) => {
        const xs: number[] = [], ys: number[] = [];
        for (const p of m.points) { const rt = bySecond.get(Math.floor(p.t)) ?? bySecond.get(Math.floor(p.t) - 1); if (rt !== undefined) { xs.push(p.v); ys.push(rt); } }
        const r = Math.round(pearson(xs, ys) * 100) / 100;
        const a = Math.abs(r);
        return { monitor: m.name, unit: m.unit, r, n: xs.length, strength: xs.length < 3 ? 'none' as const : a >= 0.7 ? 'strong' as const : a >= 0.4 ? 'moderate' as const : a >= 0.2 ? 'weak' as const : 'none' as const };
    }).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

export type OverlayMetric = 'p95' | 'avg' | 'throughput' | 'errors' | 'users';
/** Runs on one time axis (seconds from their start): one series per run. */
export function overlay(runs: Array<{ id: string; label: string; result: Pick<RunResult, 'timeline'> }>, metric: OverlayMetric): Array<{ id: string; label: string; points: Array<{ t: number; v: number }> }> {
    return runs.slice(0, 4).map((r) => ({ id: r.id, label: r.label, points: (r.result.timeline ?? []).map((s) => ({ t: s.t, v: metric === 'throughput' ? s.requests : metric === 'errors' ? s.errors : metric === 'users' ? s.users : s[metric] })) }));
}

/** How much worse a run may be than its baseline (percent, error-rate points). */
export interface RegressionGate { p95Percent?: number; avgPercent?: number; errorRatePoints?: number; throughputPercent?: number; /** Compare the steady parts only (default true). */ steadyOnly?: boolean }

export function validGate(g: RegressionGate): string | null {
    for (const k of ['p95Percent', 'avgPercent', 'errorRatePoints', 'throughputPercent'] as const) if (g[k] !== undefined && !(typeof g[k] === 'number' && Number.isFinite(g[k]) && g[k]! >= 0 && g[k]! <= 1000)) return `the regression gate's ${k}`;
    if (!['p95Percent', 'avgPercent', 'errorRatePoints', 'throughputPercent'].some((k) => g[k as keyof RegressionGate] !== undefined)) return 'the regression gate needs at least one limit';
    return null;
}

export interface Regression { pass: boolean; details: string[]; rows: Array<{ id: string; name: string; base: RangeTx; now: RangeTx; problems: string[] }> }

/** A run against its baseline, transaction by transaction (and all requests together). */
export function regression(now: Pick<RunResult, 'timeline' | 'intervals' | 'transactions' | 'total'>, base: Pick<RunResult, 'timeline' | 'intervals' | 'transactions' | 'total'>, g: RegressionGate): Regression {
    const names = Object.fromEntries((now.transactions ?? []).map((t) => [t.id, t.name]));
    // The steady part from the intervals; a run without intervals (shorter than half an interval, or an older
    // result): its whole-run numbers.
    const whole = (r: typeof now): RangeStats => {
        const tx = (t: RunResult['transactions'][number]): RangeTx => ({ id: t.id, name: t.name, count: t.count, errors: t.errors, errorRate: t.errorRate, avg: t.avg, p50: t.p50, p90: t.p90, p95: t.p95, p99: t.p99, max: t.max, throughput: t.throughput });
        const tot = (r as RunResult).total;
        return { from: 0, to: 0, seconds: 0, intervals: 0, exact: true, total: { id: '*', name: 'All requests', count: tot.count, errors: tot.errors, errorRate: tot.errorRate, avg: tot.avg, p50: tot.p50, p90: tot.p90, p95: tot.p95, p99: tot.p99, max: tot.max, throughput: tot.throughput }, tx: (r.transactions ?? []).map(tx) };
    };
    const pick = (r: typeof now) => {
        const st = g.steadyOnly === false ? null : steadyRange(r);
        const x = rangeStats(r.intervals ?? [], st?.from ?? 0, st?.to ?? Infinity, names);
        return x.intervals ? x : whole(r);
    };
    const a = pick(now), b = pick(base);
    const rows: Regression['rows'] = [];
    const pct = (x: number, y: number) => (y > 0 ? (100 * (x - y)) / y : 0);
    for (const n of [a.total, ...a.tx]) {
        const o = n.id === '*' ? b.total : b.tx.find((x) => x.id === n.id);
        if (!o || !o.count || !n.count) continue;
        const problems: string[] = [];
        if (g.p95Percent !== undefined && pct(n.p95, o.p95) > g.p95Percent) problems.push(`p95 ${o.p95} → ${n.p95} ms (+${pct(n.p95, o.p95).toFixed(0)}% > ${g.p95Percent}%)`);
        if (g.avgPercent !== undefined && pct(n.avg, o.avg) > g.avgPercent) problems.push(`average ${o.avg} → ${n.avg} ms (+${pct(n.avg, o.avg).toFixed(0)}% > ${g.avgPercent}%)`);
        if (g.errorRatePoints !== undefined && n.errorRate - o.errorRate > g.errorRatePoints) problems.push(`errors ${o.errorRate.toFixed(2)}% → ${n.errorRate.toFixed(2)}% (+${(n.errorRate - o.errorRate).toFixed(2)} points > ${g.errorRatePoints})`);
        if (g.throughputPercent !== undefined && n.id === '*' && -pct(n.throughput, o.throughput) > g.throughputPercent) problems.push(`throughput ${o.throughput.toFixed(1)} → ${n.throughput.toFixed(1)}/s (${pct(n.throughput, o.throughput).toFixed(0)}% < -${g.throughputPercent}%)`);
        rows.push({ id: n.id, name: n.name, base: o, now: n, problems });
    }
    const bad = rows.filter((r) => r.problems.length);
    if (!rows.length) return { pass: false, rows, details: ['nothing to compare: the run and the baseline have no transaction in common'] };
    return { pass: !bad.length, rows, details: bad.length ? bad.slice(0, 8).map((r) => `${r.name}: ${r.problems.join('; ')}`) : [`no transaction is worse than the baseline beyond the gate (${rows.length} compared)`] };
}
