/**
 * Where each secret is used, so a person can rotate one with confidence and remove the ones nothing reads:
 *  - the projects' configuration ({env:NAME}, per environment), feature files ({env:NAME}),
 *  - API collections and load scenarios ({env:NAME} / {secret:NAME}), tool servers ({secret:NAME});
 * and how old each value is (a reminder to rotate after ROTATE_DAYS).
 */
import * as fs from 'fs';
import * as path from 'path';
import { configReferences, featureReferences } from '../ado/pipelineSecrets';
import { discover } from '../env/layers';
import type { SecretMeta } from './store';

export const ROTATE_DAYS = 90;
export interface SecretUse { file: string; line?: number; key?: string; where: 'config' | 'feature' | 'api' | 'load' | 'tool-server' | 'data'; env?: string }
export interface SecretUsage { name: string; project?: string; env?: string; updatedAt: string; ageDays: number; rotate: boolean; uses: SecretUse[] }

const SKIP = new Set(['node_modules', '.git', 'dist', 'reports', 'test-results']);
function files(root: string, test: (name: string) => boolean, max = 2000): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 10 || out.length >= max) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (SKIP.has(e.name)) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { if (!e.name.startsWith('.') || e.name === '.cs-studio') walk(abs, depth + 1); }
            else if (test(e.name)) out.push(abs);
        }
    };
    walk(root, 0);
    return out;
}

/** Every reference to a name in the repository. */
export function secretReferences(repoRoot: string): Map<string, SecretUse[]> {
    const refs = new Map<string, SecretUse[]>();
    const add = (name: string, u: SecretUse) => { const l = refs.get(name) ?? []; if (!l.some((x) => x.file === u.file && x.line === u.line && x.env === u.env)) l.push(u); refs.set(name, l); };
    const { projects, environments } = discover(repoRoot);
    for (const p of projects) for (const env of environments[p] ?? []) {
        try { for (const r of configReferences(repoRoot, p, env)) for (const u of r.usedBy) add(r.name, { file: u.file, ...(u.line ? { line: u.line } : {}), ...(u.key ? { key: u.key } : {}), where: 'config', env }); } catch { /* a broken configuration */ }
    }
    for (const r of featureReferences(repoRoot)) for (const u of r.usedBy) add(r.name, { file: u.file, ...(u.line ? { line: u.line } : {}), where: 'feature' });
    const scan = (abs: string, where: SecretUse['where'], re: RegExp) => {
        let text = '';
        try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
        if (text.length > 5_000_000) return;
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        text.split('\n').forEach((l, i) => { for (const m of l.matchAll(re)) add(m[1], { file: rel, line: i + 1, where }); });
    };
    for (const f of files(repoRoot, (n) => n.endsWith('.collection.json'))) scan(f, 'api', /\{(?:env|secret):([A-Za-z_][A-Za-z0-9_]*)\}/g);
    for (const f of files(repoRoot, (n) => n.endsWith('.load.json'))) scan(f, 'load', /\{(?:env|secret):([A-Za-z_][A-Za-z0-9_]*)\}/g);
    // Test data and other files of the tests ({env:NAME} in .properties, data JSON/YAML/XML/CSV, payload templates).
    const testDir = path.join(repoRoot, 'test');
    if (fs.existsSync(testDir)) for (const f of files(testDir, (n) => /\.(properties|ya?ml|xml|csv|txt|env)$/i.test(n) || (n.endsWith('.json') && !n.endsWith('.collection.json') && !n.endsWith('.load.json'))))
        scan(f, 'data', /\{(?:env|secret):([A-Za-z_][A-Za-z0-9_]*)\}/g);
    const ts = path.join(repoRoot, '.cs-studio', 'mcp-servers.json');
    if (fs.existsSync(ts)) scan(ts, 'tool-server', /\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g);
    return refs;
}

/** The stored secrets with their uses and age. A secret stored for one environment counts the uses in that environment. */
export function secretUsage(repoRoot: string, secrets: SecretMeta[], now = Date.now()): { secrets: SecretUsage[]; missing: Array<{ name: string; uses: SecretUse[] }> } {
    const refs = secretReferences(repoRoot);
    const out = secrets.map((s) => {
        const uses = (refs.get(s.name) ?? []).filter((u) => !s.env || !u.env || u.env === s.env);
        const ageDays = Math.floor((now - Date.parse(s.updatedAt)) / 86_400_000);
        return { name: s.name, ...(s.project ? { project: s.project } : {}), ...(s.env ? { env: s.env } : {}), updatedAt: s.updatedAt, ageDays, rotate: ageDays >= ROTATE_DAYS, uses };
    });
    // Names the repository reads that no secret has (config values that are not secrets are left out: only {env:} uses count).
    const stored = new Set(secrets.map((s) => s.name));
    const missing = [...refs].filter(([n]) => !stored.has(n) && !process.env[n]).map(([name, uses]) => ({ name, uses })).sort((a, b) => a.name.localeCompare(b.name));
    return { secrets: out, missing };
}
