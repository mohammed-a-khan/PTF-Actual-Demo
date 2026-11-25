/**
 * Where collections live: test/<project>/api/<name>.collection.json (in the repository, shared
 * through Git), and the feature made from one: <project's feature folder>/api/<name>.feature.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ApiCollection, slug, validCollection } from './model';

export const collectionDir = (root: string, project: string) => path.join(root, 'test', project, 'api');
export const collectionRel = (project: string, name: string) => `test/${project}/api/${slug(name)}.collection.json`;

export interface CollectionInfo { project: string; file: string; name: string; requests: number; changed: string }

export function listCollections(root: string, projects: string[]): CollectionInfo[] {
    const out: CollectionInfo[] = [];
    for (const project of projects) {
        const dir = collectionDir(root, project);
        let names: string[] = [];
        try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.collection.json')); } catch { continue; }
        for (const f of names) {
            const abs = path.join(dir, f);
            try {
                const c = validCollection(JSON.parse(fs.readFileSync(abs, 'utf8')));
                let n = 0;
                const walk = (xs: ApiCollection['items']) => { for (const x of xs) { if (x.kind === 'folder') walk(x.items); else n++; } };
                walk(c.items);
                out.push({ project, file: `test/${project}/api/${f}`, name: c.name, requests: n, changed: fs.statSync(abs).mtime.toISOString() });
            } catch { /* not ours / broken: skipped */ }
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readCollection(root: string, rel: string): ApiCollection {
    if (!/^test\/[A-Za-z0-9][\w.-]*\/api\/[\w.-]+\.collection\.json$/.test(rel)) throw new Error('Not a collection file.');
    return validCollection(JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')));
}

/** Write it (pretty, stable key order as built), creating the folder. Returns the path in the repository. */
export function writeCollection(root: string, project: string, c: ApiCollection, rel = collectionRel(project, c.name)): string {
    validCollection(c);
    if (!rel.startsWith(`test/${project}/api/`) || !/^[\w./-]+\.collection\.json$/.test(rel) || rel.includes('..')) throw new Error('Not a collection file.');
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(c, null, 2) + '\n');
    return rel;
}

/**
 * Saving over a file someone else changed meanwhile (another tab, a teammate's pull): the version read is sent back
 * with the save, and a different version on disk refuses it. The version is a hash of the file's bytes.
 */
export const CHANGED_ELSEWHERE = 'Changed in another tab or by someone else';
export function fileVersion(abs: string): string | null {
    try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 16); } catch { return null; }
}
/** What a save carries besides the item: `$studio: { base, force }` inside it (taken out before it is checked). */
export interface SaveMeta { base?: string; force?: boolean }
export function takeSaveMeta(x: unknown): { item: unknown; meta: SaveMeta } {
    if (!x || typeof x !== 'object' || Array.isArray(x) || !('$studio' in x)) return { item: x, meta: {} };
    const { $studio, ...item } = x as Record<string, unknown>;
    const m = ($studio && typeof $studio === 'object' ? $studio : {}) as Record<string, unknown>;
    return { item, meta: { ...(typeof m.base === 'string' && m.base ? { base: m.base.slice(0, 64) } : {}), ...(m.force === true ? { force: true } : {}) } };
}
/** The reason a save must not go ahead (the file is not the version that was read), or null. */
export function staleSave(abs: string, meta: SaveMeta): string | null {
    if (!meta.base || meta.force) return null;
    const now = fileVersion(abs);
    return now !== null && now !== meta.base ? CHANGED_ELSEWHERE : null;
}
