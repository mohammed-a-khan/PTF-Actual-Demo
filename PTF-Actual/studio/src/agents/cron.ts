/** Five-field cron lines (minute hour day-of-month month day-of-week) for mission schedules. */
type CronField = Set<number>;
/** A five-field cron line (minute hour day-of-month month day-of-week), or null. */
export function parseCron(expr: string): CronField[] | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const out: CronField[] = [];
    for (let i = 0; i < 5; i++) {
        const [lo, hi] = ranges[i];
        const set = new Set<number>();
        for (const item of parts[i].split(',')) {
            const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
            if (!m) return null;
            const a = m[1] === '*' ? lo : Number(m[2]), b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : a);
            const step = m[4] ? Number(m[4]) : 1;
            if (a < lo || b > hi || a > b || step < 1) return null;
            for (let x = a; x <= b; x += step) set.add(i === 4 && x === 7 ? 0 : x);
        }
        out.push(set);
    }
    return out;
}
export function cronMatches(expr: string, d: Date): boolean {
    const f = parseCron(expr);
    if (!f) return false;
    const parts = expr.trim().split(/\s+/);
    const dom = f[2].has(d.getDate()), dow = f[4].has(d.getDay());
    const day = parts[2] !== '*' && parts[4] !== '*' ? dom || dow : dom && dow;
    return f[0].has(d.getMinutes()) && f[1].has(d.getHours()) && f[3].has(d.getMonth() + 1) && day;
}

