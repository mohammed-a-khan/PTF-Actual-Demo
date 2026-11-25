/**
 * Scheduled load tests: a scenario run once at a time, every day, or on chosen weekdays (this computer's local
 * time), while the Studio is open. A schedule that finds its scenario still running, or too many tests running,
 * tries again each minute for up to 30 minutes, then records why it did not run. Kept in
 * <git dir>/cs-studio/load-schedules.json (this computer only; a pipeline schedule is the way for nightly runs
 * without a Studio).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface LoadSchedule {
    id: string;
    /** The scenario file (test/<project>/load/<name>.load.json) and environment. */
    file: string;
    env?: string;
    enabled: boolean;
    kind: 'once' | 'daily' | 'weekly';
    /** once: a date and time (ISO); daily / weekly: HH:MM local time. */
    at: string;
    /** weekly: 0 Sunday … 6 Saturday. */
    days?: number[];
    last?: { at: string; runId?: string; error?: string };
    /** When it is due next (or null: done). */
    next?: string | null;
}

export function validSchedule(s: Partial<LoadSchedule>): string | null {
    if (typeof s.file !== 'string' || !/^test\/[\w.-]+\/load\/[\w.-]+\.load\.json$/.test(s.file)) return 'the scenario';
    if (s.kind !== 'once' && s.kind !== 'daily' && s.kind !== 'weekly') return 'once, daily or weekly';
    if (s.kind === 'once' ? !(typeof s.at === 'string' && Number.isFinite(Date.parse(s.at))) : !(typeof s.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.at))) return s.kind === 'once' ? 'a date and time' : 'a time as HH:MM';
    if (s.kind === 'weekly' && !(Array.isArray(s.days) && s.days.length && s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) return 'the days of the week';
    return null;
}

/** When a schedule is due next after `from` (null: a one-off already past). */
export function nextRun(s: Pick<LoadSchedule, 'kind' | 'at' | 'days' | 'last'>, from: Date): Date | null {
    if (s.kind === 'once') { const t = new Date(s.at); return s.last ? null : t; }
    const [h, m] = s.at.split(':').map(Number);
    for (let k = 0; k < 8; k++) {
        const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + k, h, m, 0, 0);
        if (d.getTime() <= from.getTime()) continue;
        if (s.kind === 'weekly' && !s.days!.includes(d.getDay())) continue;
        return d;
    }
    return null;
}

export class LoadScheduler {
    private timer?: NodeJS.Timeout;
    /** Due but not started yet (busy): since when. */
    private readonly waiting = new Map<string, number>();
    constructor(private readonly file: string, private readonly start: (file: string, env?: string) => Promise<string>, private readonly now: () => Date = () => new Date()) {}

    private read(): LoadSchedule[] { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; } }
    private write(list: LoadSchedule[]) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(list, null, 2)); }

    list(): LoadSchedule[] {
        // `next` from the last run (or creation) on: a missed time while the Studio was closed is not run late.
        return this.read().map((s) => ({ ...s, next: s.enabled ? (s.next !== undefined ? s.next : nextRun(s, this.now())?.toISOString() ?? null) : null }));
    }

    save(x: Partial<LoadSchedule>): LoadSchedule {
        const e = validSchedule(x);
        if (e) throw new Error(`Not a valid schedule: ${e}.`);
        if (x.kind === 'once' && Date.parse(x.at!) < this.now().getTime() - 60_000) throw new Error('Not a valid schedule: the time has passed.');
        const list = this.read();
        const old = x.id ? list.find((s) => s.id === x.id) : undefined;
        const s: LoadSchedule = { id: old?.id ?? crypto.randomBytes(6).toString('hex'), file: x.file!, ...(x.env ? { env: x.env } : {}), enabled: x.enabled !== false, kind: x.kind!, at: x.kind === 'once' ? new Date(x.at!).toISOString() : x.at!, ...(x.kind === 'weekly' ? { days: [...new Set(x.days!)].sort() } : {}), ...(old?.last && old.kind === x.kind && old.at === x.at ? { last: old.last } : {}) };
        s.next = s.enabled ? nextRun(s, this.now())?.toISOString() ?? null : null;
        this.write(old ? list.map((y) => (y.id === s.id ? s : y)) : [...list, s]);
        return s;
    }

    remove(id: string): boolean { const list = this.read(); const next = list.filter((s) => s.id !== id); this.write(next); return next.length !== list.length; }

    /** Start what is due. */
    async tick(): Promise<void> {
        const now = this.now();
        const list = this.read();
        let changed = false;
        for (const s of list) {
            if (!s.enabled) continue;
            if (s.next === undefined) { s.next = nextRun(s, now)?.toISOString() ?? null; changed = true; }
            if (!s.next || Date.parse(s.next) > now.getTime()) continue;
            try {
                const runId = await this.start(s.file, s.env);
                s.last = { at: now.toISOString(), runId };
                this.waiting.delete(s.id);
            } catch (e) {
                const since = this.waiting.get(s.id) ?? now.getTime();
                this.waiting.set(s.id, since);
                if (now.getTime() - since < 30 * 60_000) continue; // busy: again at the next tick
                s.last = { at: now.toISOString(), error: (e as Error).message };
                this.waiting.delete(s.id);
            }
            s.next = nextRun(s, now)?.toISOString() ?? null;
            if (s.kind === 'once') s.enabled = false;
            changed = true;
        }
        if (changed) this.write(list);
    }

    begin(everyMs = 30_000): void { this.timer = setInterval(() => void this.tick().catch(() => undefined), everyMs); this.timer.unref(); }
    end(): void { if (this.timer) clearInterval(this.timer); }
}
