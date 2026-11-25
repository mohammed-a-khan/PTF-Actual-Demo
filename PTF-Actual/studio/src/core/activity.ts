/**
 * Local activity log: what the user did in the Studio (commits, pushes, overrides, secret and
 * environment changes). Append-only JSON lines, one file per month, in the Studio's private data
 * directory. It NEVER records secret values — only names, files and keys — and every detail string
 * is checked against the stored secret values before it is written.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensurePrivateDir } from './paths';

export interface ActivityEntry {
    ts: string;
    action: string;
    repo: string;
    /** Short human summary, e.g. "Committed 3f2a1c9 with secret-scan override". */
    summary: string;
    /** Structured, non-secret details. */
    data?: Record<string, string | number | boolean | null>;
}

export class ActivityLog {
    private readonly dir: string;

    /** `secretValues` returns current stored values, used only to make sure none is ever logged. */
    constructor(home: string, private readonly secretValues: () => string[] = () => []) {
        this.dir = path.join(home, 'activity');
    }

    private fileFor(d: Date): string {
        return path.join(this.dir, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`);
    }

    record(entry: Omit<ActivityEntry, 'ts'>): ActivityEntry {
        const full: ActivityEntry = { ts: new Date().toISOString(), ...entry };
        let line = JSON.stringify(full);
        for (const v of this.secretValues()) {
            if (v && v.length >= 4 && line.includes(JSON.stringify(v).slice(1, -1))) {
                // Defence in depth: callers never pass values, but if one slips through it is dropped.
                line = JSON.stringify({ ...full, summary: `${entry.action} (details withheld: contained a secret value)`, data: undefined });
                break;
            }
        }
        ensurePrivateDir(this.dir);
        fs.appendFileSync(this.fileFor(new Date(full.ts)), line + '\n', { encoding: 'utf8', mode: 0o600 });
        return JSON.parse(line);
    }

    /** Most recent first. */
    recent(limit = 100, filter: { repo?: string } = {}): ActivityEntry[] {
        if (!fs.existsSync(this.dir)) return [];
        const files = fs.readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse();
        const out: ActivityEntry[] = [];
        for (const f of files) {
            const lines = fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n').filter(Boolean).reverse();
            for (const l of lines) {
                try {
                    const e = JSON.parse(l) as ActivityEntry;
                    if (filter.repo && e.repo !== filter.repo) continue;
                    out.push(e);
                    if (out.length >= limit) return out;
                } catch { /* skip a damaged line */ }
            }
        }
        return out;
    }
}
