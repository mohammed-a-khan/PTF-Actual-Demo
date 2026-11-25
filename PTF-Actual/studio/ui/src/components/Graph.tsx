import { GraphRow } from '../api';

export const LANE = 14;
export const ROW = 30;
const COLORS = ['#93186C', '#1677ff', '#52c41a', '#fa8c16', '#13c2c2', '#eb2f96', '#722ed1', '#a0d911'];
const color = (i: number) => COLORS[i % COLORS.length];
const x = (c: number) => c * LANE + LANE / 2;

/** One row of the commit graph: lines from above, through, and down to the parents. */
export function GraphCell({ row, width, isMerge, isHead }: { row: GraphRow; width: number; isMerge: boolean; isHead: boolean }) {
    const mid = ROW / 2;
    return (
        <svg width={Math.max(width, 1) * LANE} height={ROW} style={{ display: 'block', flex: 'none' }} aria-hidden>
            {row.passThrough.map((j) => <line key={'p' + j} x1={x(j)} y1={0} x2={x(j)} y2={ROW} stroke={color(j)} strokeWidth={2} />)}
            {row.into.map((j) => <path key={'i' + j} d={`M${x(j)},0 C${x(j)},${mid / 2} ${x(row.col)},${mid / 2} ${x(row.col)},${mid}`} stroke={color(j)} strokeWidth={2} fill="none" />)}
            {row.out.map((k) => <path key={'o' + k} d={`M${x(row.col)},${mid} C${x(row.col)},${mid + mid / 2} ${x(k)},${mid + mid / 2} ${x(k)},${ROW}`} stroke={color(k)} strokeWidth={2} fill="none" />)}
            {isMerge
                ? <rect x={x(row.col) - 5} y={mid - 5} width={10} height={10} fill="var(--graph-bg, #fff)" stroke={color(row.col)} strokeWidth={2.5} />
                : <circle cx={x(row.col)} cy={mid} r={isHead ? 6 : 5} fill={isHead ? color(row.col) : 'var(--graph-bg, #fff)'} stroke={color(row.col)} strokeWidth={2.5} />}
        </svg>
    );
}
