/**
 * A small line chart (SVG, no library): one or two series on their own scales (left and right axes),
 * time on the x axis, hover read-out. Used for live load-test metrics and policy previews.
 */
import React from 'react';
import { timeTicks } from '../../../src/load/labels';

export interface Series { name: string; color: string; values: number[]; unit?: string; area?: boolean; right?: boolean; /** A count: the axis shows whole numbers only. */ integer?: boolean }

const nice = (max: number) => {
    if (max <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    for (const m of [1, 2, 2.5, 5, 10]) if (max <= m * p) return m * p;
    return 10 * p;
};
const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v >= 100 ? String(Math.round(v)) : v < 10 ? String(Math.round(v * 100) / 100) : String(Math.round(v * 10) / 10));
const mmss = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`);

const anchorOf = (t: number, x0: number, x1: number): 'start' | 'end' | 'middle' => (t <= x0 ? 'start' : t >= x1 ? 'end' : 'middle');
/** Width of an axis label (10 px monospace-ish text): a little generous, so near misses do not touch. */
const labelWidth = (text: string) => text.length * 6.4 + 4;
/**
 * The x-axis ticks: the most (up to 6, about one per 70 px) whose labels, at their anchors, leave a gap between them;
 * fewer when the labels are long (run numbers with a time), never fewer than the first and last.
 */
export function fittedTicks(x0: number, x1: number, iw: number, px: (t: number) => number, fx: (t: number) => string): number[] {
    const fits = (ticks: number[]) => {
        const boxes = ticks.map((t) => {
            const w = labelWidth(fx(t)), a = anchorOf(t, x0, x1), x = px(t);
            return a === 'start' ? [x, x + w] : a === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
        });
        return boxes.every((b, i) => i === 0 || b[0] >= boxes[i - 1][1] + 6);
    };
    for (let n = Math.max(2, Math.min(6, Math.floor(iw / 70))); n >= 2; n--) {
        const ticks = timeTicks(x0, x1, n).filter((t) => fx(t) !== '');
        if (fits(ticks)) return ticks;
    }
    // Even two do not fit: the first one alone (the hover read-out names every point).
    const all = timeTicks(x0, x1, 2).filter((t) => fx(t) !== '');
    return fits(all) ? all : all.slice(0, 1);
}

export function LineChart({ x, series, height = 160, xMax, title, xFormat, xMin = 0, yMax }: { x: number[]; series: Series[]; height?: number; xMax?: number; title?: string; xFormat?: (v: number) => string; xMin?: number; /** A fixed top for the left axis (100 for a percentage), so a steady 50 % is drawn half way up. */ yMax?: number }) {
    const box = React.useRef<HTMLDivElement>(null);
    const [w, setW] = React.useState(600);
    const [hover, setHover] = React.useState<number | null>(null);
    React.useEffect(() => {
        const el = box.current; if (!el) return;
        const ro = new ResizeObserver(() => setW(el.clientWidth || 600)); ro.observe(el); setW(el.clientWidth || 600);
        return () => ro.disconnect();
    }, []);
    const pad = { l: 40, r: series.some((s) => s.right) ? 40 : 10, t: title ? 22 : 8, b: 20 };
    const iw = Math.max(10, w - pad.l - pad.r), ih = height - pad.t - pad.b;
    const x1 = Math.max(xMax ?? 0, x.length ? x[x.length - 1] : 1, xMin + 1);
    const leftRaw = Math.max(0, ...series.filter((s) => !s.right).flatMap((s) => s.values).filter(Number.isFinite));
    const leftMax = yMax !== undefined && yMax >= leftRaw ? yMax : nice(leftRaw);
    // A count on the right axis: a top that is a multiple of 4, so the quarter ticks are whole numbers.
    const rightRaw = Math.max(0, ...series.filter((s) => s.right).flatMap((s) => s.values).filter(Number.isFinite));
    const rightMax = series.some((s) => s.right && s.integer) ? Math.max(4, Math.ceil(rightRaw / 4) * 4) : nice(rightRaw);
    const span = Math.max(1e-9, x1 - xMin);
    const px = (t: number) => pad.l + ((t - xMin) / span) * iw;
    const fx = xFormat ?? mmss;
    const py = (v: number, right?: boolean) => pad.t + ih - (v / (right ? rightMax : leftMax)) * ih;
    // A value that is not a number is a gap (e.g. a shorter run beside a longer one).
    /** The shaded area under a series: one shape per run of values (no shading across gaps). */
    const areaPath = (s: Series) => {
        let d = '', start = -1;
        const base = pad.t + ih;
        s.values.forEach((v, i) => {
            const ok = Number.isFinite(v);
            if (ok && start < 0) { start = i; d += `M${px(x[i]).toFixed(1)},${base}`; }
            if (ok) d += `L${px(x[i]).toFixed(1)},${py(v, s.right).toFixed(1)}`;
            if (start >= 0 && (!ok || i === s.values.length - 1)) { const last = ok ? i : i - 1; d += `L${px(x[last]).toFixed(1)},${base}Z`; start = -1; }
        });
        return d;
    };
    const path = (s: Series) => s.values.map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(s.values[i - 1]) ? 'L' : 'M'}${px(x[i]).toFixed(1)},${py(v, s.right).toFixed(1)}` : '')).join('');
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
        if (!x.length) return;
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const t = xMin + ((e.clientX - r.left - pad.l) / iw) * span;
        let best = 0; for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - t) < Math.abs(x[best] - t)) best = i;
        setHover(best);
    };
    return (
        <div ref={box} className="line-chart" style={{ position: 'relative', width: '100%' }}>
            <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={title ?? series.map((s) => s.name).join(', ')}>
                {title && <text x={pad.l} y={14} className="lc-title">{title}</text>}
                {ticks.map((k) => <g key={k}>
                    <line x1={pad.l} x2={pad.l + iw} y1={pad.t + ih * (1 - k)} y2={pad.t + ih * (1 - k)} className="lc-grid" />
                    <text x={pad.l - 4} y={pad.t + ih * (1 - k) + 3} textAnchor="end" className="lc-axis">{fmt(leftMax * k)}</text>
                    {series.some((s) => s.right) && <text x={pad.l + iw + 4} y={pad.t + ih * (1 - k) + 3} className="lc-axis">{fmt(rightMax * k)}</text>}
                </g>)}
                {/* Whole seconds (or run numbers), each label once: no second skipped by rounding, none shown twice. */}
                {/* As many as fit: labels never overlap ("#1 04:39 AM#3 04:43 AM"), however long they are. */}
                {fittedTicks(xMin, x1, iw, px, fx).map((t) => <text key={t} x={px(t)} y={height - 4} textAnchor={anchorOf(t, xMin, x1)} className="lc-axis">{fx(t)}</text>)}
                {series.map((s, i) => s.values.length > 1 && <g key={`${i}-${s.name}`}>
                    {s.area && <path d={areaPath(s)} fill={s.color} opacity={0.12} />}
                    <path d={path(s)} fill="none" stroke={s.color} strokeWidth={1.6} />
                </g>)}
                {hover !== null && <line x1={px(x[hover])} x2={px(x[hover])} y1={pad.t} y2={pad.t + ih} className="lc-hover" />}
            </svg>
            <div className="lc-legend">
                {series.map((s, i) => <span key={`${i}-${s.name}`}><i style={{ background: s.color }} />{s.name}{hover !== null && Number.isFinite(s.values[hover]) ? `: ${fmt(s.values[hover])}${s.unit ?? ''}` : ''}</span>)}
                {hover !== null && <span className="lc-at">{xFormat ? fx(x[hover]) : `at ${fx(x[hover])}`}</span>}
            </div>
        </div>
    );
}
