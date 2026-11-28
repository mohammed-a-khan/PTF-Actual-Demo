/**
 * Each file as it was before a conversation's agent first changed it (its "baseline"), kept in the
 * Studio's home: the editor shows what the agent changed against it, and Keep / Undo work on it.
 *  - captured once per conversation and file, just before the first change goes through;
 *  - a file the agent created has the baseline null (it did not exist);
 *  - Keep moves the baseline forward (to the file now, or with one change taken in); Undo puts it back.
 * Large or binary files are not kept (they are reviewed in Source control).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export const BASELINE_MAX = 2 * 1024 * 1024;
const key = (rel: string) => createHash('sha1').update(rel).digest('hex').slice(0, 24);

export class Baselines {
    constructor(private readonly dir: string) {}

    private file(id: string, rel: string) { return path.join(this.dir, id.replace(/[^\w-]/g, '_'), `${key(rel)}.json`); }

    /** Keep the file as it is now, unless this conversation already has its baseline. */
    capture(id: string, root: string, rel: string): void {
        const f = this.file(id, rel);
        if (fs.existsSync(f)) return;
        let text: string | null = null;
        try {
            const abs = path.join(root, rel);
            const st = fs.statSync(abs);
            if (!st.isFile() || st.size > BASELINE_MAX) return;
            const buf = fs.readFileSync(abs);
            if (buf.includes(0)) return;
            text = buf.toString('utf8');
        } catch { text = null; }
        this.write(f, rel, text);
    }

    /** The baseline (null: the file did not exist); undefined when none is kept. */
    get(id: string, rel: string): { text: string | null } | undefined {
        try { const j = JSON.parse(fs.readFileSync(this.file(id, rel), 'utf8')) as { path: string; text: string | null }; return j.path === rel ? { text: j.text } : undefined; } catch { return undefined; }
    }

    set(id: string, rel: string, text: string | null): void { this.write(this.file(id, rel), rel, text); }
    drop(id: string, rel: string): void { try { fs.rmSync(this.file(id, rel), { force: true }); } catch { /* gone */ } }
    forget(id: string): void { try { fs.rmSync(path.join(this.dir, id.replace(/[^\w-]/g, '_')), { recursive: true, force: true }); } catch { /* gone */ } }

    private write(f: string, rel: string, text: string | null) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(`${f}.tmp`, JSON.stringify({ path: rel, text }));
        fs.renameSync(`${f}.tmp`, f);
    }
}
