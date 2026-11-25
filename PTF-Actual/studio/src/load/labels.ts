/**
 * Small rules shared by the server (reports, comparisons, JUnit) and the screens (Runs, Trends, Compare), so the
 * same thing is said the same way everywhere (no Node imports: the UI bundles this file):
 *  - requests / transactions that share a name are numbered in collection order: "New request (1)", "(2)";
 *  - one rule for "better / worse / ≈ same" between two numbers of two runs;
 *  - time-axis ticks at whole seconds, never the same label twice.
 */

/** "≈ same" below these: a change under 10%, or (times) under 20 ms however large the %. */
export const NOISE_PCT = 10;
export const NOISE_MS = 20;
export const NOISE_ERROR_PTS = 0.1;

/**
 * Labels of items that may share a name, by their id (or name when they have none): a name used once stays as it is;
 * a name used more than once gets "(1)", "(2)"… in the order given (`order`: ids in collection order; items not in it
 * follow in the order of the list).
 */
export function sameNameLabels(items: ReadonlyArray<{ id?: string; name: string }>, order?: ReadonlyArray<string>): Map<string, string> {
    const key = (t: { id?: string; name: string }) => t.id || `name:${t.name}`;
    const seen = new Set<string>();
    const uniq = items.filter((t) => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; });
    const pos = new Map((order ?? []).map((id, i) => [id, i]));
    const sorted = uniq.map((t, i) => ({ t, i, p: pos.get(key(t)) ?? pos.get(t.id ?? '') ?? Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.p - b.p || a.i - b.i).map((x) => x.t);
    const count = new Map<string, number>();
    for (const t of sorted) count.set(t.name, (count.get(t.name) ?? 0) + 1);
    const n = new Map<string, number>();
    const out = new Map<string, string>();
    for (const t of sorted) {
        if ((count.get(t.name) ?? 0) < 2) { out.set(key(t), t.name); continue; }
        const k = (n.get(t.name) ?? 0) + 1;
        n.set(t.name, k);
        out.set(key(t), `${t.name} (${k})`);
    }
    return out;
}
/** The label of one item from sameNameLabels (its name when it is not there). */
export const labelOf = (labels: Map<string, string>, t: { id?: string; name: string }): string => labels.get(t.id || `name:${t.name}`) ?? t.name;

export type ChangeKind = 'time' | 'rate' | 'errorRate';
export type ChangeVerdict = 'better' | 'worse' | 'same';
/**
 * Run B against run A (the reference) for one number: whether it got better, worse or stayed about the same.
 *  - time (ms, lower is better): the same under 10% or under 20 ms;
 *  - rate (requests/s, counts; higher is better): the same under 10%;
 *  - errorRate (%, lower is better): the same under 0.1 points.
 * `pct`: the change in % of A (errorRate: in points).
 */
export function changeVerdict(a: number, b: number, kind: ChangeKind): { verdict: ChangeVerdict; pct: number; diff: number } {
    const diff = b - a;
    if (kind === 'errorRate') return { verdict: Math.abs(diff) < NOISE_ERROR_PTS ? 'same' : diff > 0 ? 'worse' : 'better', pct: diff, diff };
    const pct = a ? (diff / a) * 100 : b ? 100 : 0;
    if (Math.abs(pct) < NOISE_PCT || (kind === 'time' && Math.abs(diff) < NOISE_MS)) return { verdict: 'same', pct, diff };
    const lowerBetter = kind === 'time';
    return { verdict: (diff < 0) === lowerBetter ? 'better' : 'worse', pct, diff };
}

/**
 * Ticks of a time axis from x0 to x1 (seconds): whole seconds, a round step (1, 2, 5, 10, 15, 30 s, 1, 2, 5, 10, 15,
 * 30 min, 1 h…), at most `max` of them, the start and (when not too close to the last tick) the end included.
 */
export function timeTicks(x0: number, x1: number, max = 5): number[] {
    const a = Math.ceil(x0), b = Math.floor(x1);
    if (b <= a) return [...new Set([Math.round(x0), Math.round(x1)])];
    const span = b - a;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    const step = steps.find((s) => span / s <= max - 1) ?? Math.ceil(span / (max - 1));
    const out: number[] = [];
    for (let t = a; t <= b; t += step) out.push(t);
    // The end: shown unless it is within half a step of the last tick.
    if (b - out[out.length - 1] >= step / 2 && out.length < max + 1) out.push(b);
    return out;
}
