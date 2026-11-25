import { TIMING_PHASES, type Timings } from '../api/send';

/** Milliseconds with one decimal (fast services answer in under a millisecond). */
const r1 = (x: number) => Math.round(x * 10) / 10;
/**
 * Response-time statistics for a load run.
 *  - Percentiles from a log-scaled histogram (about 1% precision, fixed memory however long the run).
 *  - A per-second timeline (users, requests, errors, response time) for the live chart.
 */
const RATIO = Math.log(1.01);
const bucketOf = (ms: number) => (ms <= 1 ? 0 : Math.ceil(Math.log(ms) / RATIO));
const valueOf = (b: number) => (b === 0 ? 1 : Math.exp(b * RATIO));

export class Histogram {
    private counts = new Map<number, number>();
    count = 0; sum = 0; min = Infinity; max = 0;
    add(ms: number) {
        const b = bucketOf(ms);
        this.counts.set(b, (this.counts.get(b) ?? 0) + 1);
        this.count++; this.sum += ms; if (ms < this.min) this.min = ms; if (ms > this.max) this.max = ms;
    }
    merge(h: Histogram) { for (const [b, c] of h.counts) this.counts.set(b, (this.counts.get(b) ?? 0) + c); this.count += h.count; this.sum += h.sum; this.min = Math.min(this.min, h.min); this.max = Math.max(this.max, h.max); }
    /** The value under which `p` percent of the samples fall (p in 0..100). */
    percentile(p: number): number {
        if (!this.count) return 0;
        const want = Math.max(1, Math.ceil((p / 100) * this.count));
        let seen = 0;
        for (const b of [...this.counts.keys()].sort((x, y) => x - y)) {
            seen += this.counts.get(b)!;
            if (seen >= want) return Math.min(this.max, Math.max(this.min, valueOf(b)));
        }
        return this.max;
    }
    get avg() { return this.count ? this.sum / this.count : 0; }
    /** As JSON (to merge the parts of a distributed run exactly). */
    dump(): HistogramDump { return { b: [...this.counts.entries()], count: this.count, sum: this.sum, min: this.count ? this.min : 0, max: this.max }; }
    static load(d: HistogramDump): Histogram {
        const h = new Histogram();
        for (const [b, c] of d.b) h.counts.set(b, c);
        h.count = d.count; h.sum = d.sum; h.min = d.count ? d.min : Infinity; h.max = d.max;
        return h;
    }
}
export interface HistogramDump { b: Array<[number, number]>; count: number; sum: number; min: number; max: number }

export interface TransactionStats {
    id: string; name: string;
    count: number; errors: number; errorRate: number;
    avg: number; min: number; max: number; p50: number; p90: number; p95: number; p99: number;
    /** Requests per second over the run. */
    throughput: number;
    /** Average time per phase of the HTTP exchanges (DNS, connect, TLS, send, wait for the first byte, download), and how many exchanges it is over. */
    phases?: Timings;
    phaseCount?: number;
    /** Most frequent error messages, with the first exchanges that failed that way. */
    topErrors: Array<{ message: string; count: number; samples: ErrorSample[] }>;
}

/** One failed exchange, kept to show what went wrong (secrets masked, bodies cut to a few KB). */
export interface ErrorSample {
    /** Seconds into the run. */
    t: number;
    user?: number;
    request?: { method: string; url: string; headers: Record<string, string>; body?: string };
    response?: { status: number; statusText?: string; timeMs: number; headers: Record<string, string>; body?: string };
    /** Browser users: the page the user was on. */
    page?: string;
}

/** One second of one transaction (only seconds where it ran). */
export interface TxSecond { t: number; n: number; e: number; avg: number; p95: number }

export interface Second { t: number; users: number; requests: number; errors: number; avg: number; p95: number }

/** Response times over a stretch of the run (an interval of the service levels). */
export interface IntervalStats { count: number; errors: number; errorRate: number; avg: number; p90: number; p95: number; p99: number; throughput: number }
/** One interval: from t0 to t1 (seconds), all requests and each transaction. */
export interface Interval { t0: number; t1: number; total: IntervalStats; tx: Record<string, IntervalStats>; /** The interval's response-time histograms (exact statistics over any range of intervals, and across load generators). */ h?: { total: HistogramDump; tx: Record<string, HistogramDump> } }

export function statsOf(h: Histogram, errors: number, seconds: number): IntervalStats {
    return { count: h.count, errors, errorRate: h.count ? (100 * errors) / h.count : 0, avg: r1(h.avg), p90: r1(h.percentile(90)), p95: r1(h.percentile(95)), p99: r1(h.percentile(99)), throughput: seconds > 0 ? h.count / seconds : 0 };
}

export class RunMetrics {
    readonly tx = new Map<string, { name: string; h: Histogram; errors: number; messages: Map<string, number>; samples: Map<string, ErrorSample[]>; timeline: TxSecond[]; phases?: { n: number; sum: Timings } }>();
    readonly all = new Histogram();
    errors = 0;
    iterations = 0;
    readonly timeline: Second[] = [];
    private cur: { t: number; users: number; h: Histogram; errors: number; tx: Map<string, { h: Histogram; errors: number }> } | null = null;
    /** Samples kept per transaction and error message. */
    static readonly SAMPLES = 3;
    /** Service-level intervals (closed ones), and the one in progress. */
    readonly intervals: Interval[] = [];
    private win: { t0: number; h: Histogram; errors: number; tx: Map<string, { h: Histogram; errors: number }> } | null = null;
    constructor(private readonly start: number, private readonly windowSec = 10, private readonly onInterval?: (i: Interval) => void) {}

    record(id: string, name: string, ms: number, error: string | null, now: number, users: number, sample?: Omit<ErrorSample, 't'>, timings?: Timings) {
        let x = this.tx.get(id);
        if (!x) { x = { name, h: new Histogram(), errors: 0, messages: new Map(), samples: new Map(), timeline: [] }; this.tx.set(id, x); }
        x.h.add(ms); this.all.add(ms);
        if (timings) {
            const p = x.phases ?? (x.phases = { n: 0, sum: zeroTimings() });
            p.n++;
            for (const k of TIMING_PHASES) p.sum[k] += timings[k];
        }
        if (error) {
            x.errors++; this.errors++;
            const m = error.slice(0, 200);
            x.messages.set(m, (x.messages.get(m) ?? 0) + 1);
            const list = x.samples.get(m) ?? [];
            if (list.length < RunMetrics.SAMPLES && x.samples.size < 50) { list.push({ t: Math.round((now - this.start) / 100) / 10, ...(sample ?? {}) }); x.samples.set(m, list); }
        }
        const s = this.second(now, users);
        s.h.add(ms); if (error) s.errors++;
        let st = s.tx.get(id);
        if (!st) { st = { h: new Histogram(), errors: 0 }; s.tx.set(id, st); }
        st.h.add(ms); if (error) st.errors++;
    }

    /** The current second (closing earlier ones, including seconds with no requests). */
    second(now: number, users: number) {
        const t = Math.floor((now - this.start) / 1000);
        while (!this.cur || this.cur.t < t) {
            if (this.cur) this.close();
            this.cur = { t: this.cur ? this.cur.t + 1 : Math.max(0, t), users, h: new Histogram(), errors: 0, tx: new Map() };
        }
        this.cur.users = users;
        return this.cur;
    }
    private close() {
        const c = this.cur!;
        // The second joins its interval; an interval ends at its last second.
        if (!this.win) this.win = { t0: c.t - (c.t % this.windowSec), h: new Histogram(), errors: 0, tx: new Map() };
        this.win.h.merge(c.h); this.win.errors += c.errors;
        for (const [id, st] of c.tx) { const w = this.win.tx.get(id) ?? { h: new Histogram(), errors: 0 }; w.h.merge(st.h); w.errors += st.errors; this.win.tx.set(id, w); }
        if ((c.t + 1) % this.windowSec === 0) this.closeWindow(c.t + 1);
        this.timeline.push({ t: c.t, users: c.users, requests: c.h.count, errors: c.errors, avg: r1(c.h.avg), p95: r1(c.h.percentile(95)) });
        for (const [id, st] of c.tx) this.tx.get(id)?.timeline.push({ t: c.t, n: st.h.count, e: st.errors, avg: r1(st.h.avg), p95: r1(st.h.percentile(95)) });
        this.cur = null;
    }
    private closeWindow(t1: number) {
        const w = this.win;
        this.win = null;
        if (!w || t1 <= w.t0) return;
        const secs = t1 - w.t0;
        const i: Interval = { t0: w.t0, t1, total: statsOf(w.h, w.errors, secs), tx: Object.fromEntries([...w.tx].map(([id, x]) => [id, statsOf(x.h, x.errors, secs)])),
            h: { total: w.h.dump(), tx: Object.fromEntries([...w.tx].map(([id, x]) => [id, x.h.dump()])) } };
        this.intervals.push(i);
        this.onInterval?.(i);
    }
    /** Close the second in progress (end of the run); a last partial interval counts when it is at least half an interval. */
    finish() {
        if (this.cur) this.close();
        if (this.win && this.timeline.length) { const end = this.timeline[this.timeline.length - 1].t + 1; if (end - this.win.t0 >= this.windowSec / 2) this.closeWindow(end); else this.win = null; }
    }

    transactions(seconds: number): TransactionStats[] {
        return [...this.tx.entries()].map(([id, x]) => ({
            id, name: x.name, count: x.h.count, errors: x.errors, errorRate: x.h.count ? (100 * x.errors) / x.h.count : 0,
            avg: r1(x.h.avg), min: r1(x.h.count ? x.h.min : 0), max: r1(x.h.max),
            p50: r1(x.h.percentile(50)), p90: r1(x.h.percentile(90)), p95: r1(x.h.percentile(95)), p99: r1(x.h.percentile(99)),
            throughput: seconds > 0 ? x.h.count / seconds : 0,
            ...(x.phases?.n ? { phases: averageTimings(x.phases.sum, x.phases.n), phaseCount: x.phases.n } : {}),
            topErrors: [...x.messages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([message, count]) => ({ message, count, samples: x.samples.get(message) ?? [] })),
        }));
    }

    histograms(): { total: HistogramDump; tx: Record<string, HistogramDump> } {
        return { total: this.all.dump(), tx: Object.fromEntries([...this.tx].map(([id, x]) => [id, x.h.dump()])) };
    }

    /** Per transaction: its seconds (the last `last` seconds, or all). */
    txTimeline(last?: number): Record<string, TxSecond[]> {
        const out: Record<string, TxSecond[]> = {};
        const from = last === undefined ? -1 : (this.timeline.length ? this.timeline[this.timeline.length - 1].t : 0) - last;
        for (const [id, x] of this.tx) out[id] = last === undefined ? x.timeline : x.timeline.filter((s) => s.t > from);
        return out;
    }
}

export const zeroTimings = (): Timings => Object.fromEntries(TIMING_PHASES.map((k) => [k, 0])) as unknown as Timings;
/** Sums over n exchanges → averages (milliseconds, two decimals). */
export function averageTimings(sum: Timings, n: number): Timings {
    return Object.fromEntries(TIMING_PHASES.map((k) => [k, n ? Math.round((100 * sum[k]) / n) / 100 : 0])) as unknown as Timings;
}
