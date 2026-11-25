/**
 * The Studio's health check ("doctor"): everything a test run needs on this computer and in this repository —
 * tools, the framework and its browsers, each environment's addresses and the configuration keys the tests use
 * but no file sets, the secret-scanning Git hooks, Azure DevOps — each with what to do when it is not right.
 */
import * as fs from 'fs';
import * as path from 'path';
import { frameworkPackage } from '../framework/package';

export type CheckLevel = 'ok' | 'warning' | 'error' | 'info';
export interface HealthCheck { id: string; group: string; title: string; level: CheckLevel; detail: string; fix?: { action: string; label: string } }

const SKIP = new Set(['node_modules', '.git', 'dist', 'reports', 'test-results', 'coverage']);
/** Configuration keys the tests refer to: {config:KEY}, config.get('KEY'), getString/getNumber/getBoolean('KEY'). */
export function usedConfigKeys(repoRoot: string, max = 4000): Map<string, string> {
    const out = new Map<string, string>(); // key → first file that uses it
    let files = 0;
    const walk = (dir: string, depth: number) => {
        if (depth > 10 || files > max) return;
        let es: fs.Dirent[] = [];
        try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
            if (!/\.(feature|ts|js)$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue;
            files++;
            let t = '';
            try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
            if (t.length > 2_000_000) continue;
            const rel = path.relative(repoRoot, p).split(path.sep).join('/');
            for (const m of t.matchAll(/\{config:([A-Z][A-Z0-9_]{1,80})\}/g)) if (!out.has(m[1])) out.set(m[1], rel);
            if (!/\.feature$/.test(e.name)) for (const m of t.matchAll(/\b(?:config|configManager|CSConfigurationManager\.getInstance\(\))\s*\.\s*(?:get|getString|getNumber|getBoolean|getArray|getRequired)\s*\(\s*['"`]([A-Z][A-Z0-9_]{1,80})['"`]/g)) if (!out.has(m[1])) out.set(m[1], rel);
        }
    };
    walk(repoRoot, 0);
    return out;
}

/** Keys used by the tests that the project/environment does not set (the framework's own defaults count as set). */
export function missingKeys(used: Map<string, string>, defined: Set<string>, frameworkDefaults: Set<string>): Array<{ key: string; file: string }> {
    return [...used].filter(([k]) => !defined.has(k) && !frameworkDefaults.has(k) && !process.env[k]).map(([key, file]) => ({ key, file })).sort((a, b) => a.key.localeCompare(b.key));
}

/** The keys of the installed framework's config/global.env (its defaults). */
export function frameworkDefaultKeys(repoRoot: string): Set<string> {
    const dir = frameworkPackage(repoRoot)?.dir;
    const keys = new Set<string>();
    if (!dir) return keys;
    for (const f of ['config/global.env', 'templates/config/global.env']) {
        try { for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line); if (m) keys.add(m[1]); } } catch { /* not there */ }
    }
    return keys;
}

/** Playwright's browsers as the repository's Playwright sees them (installed or not). */
export function playwrightBrowsers(repoRoot: string): { version?: string; chromium?: { path: string; installed: boolean } } | null {
    try {
        const pkgFile = require.resolve('playwright-core/package.json', { paths: [repoRoot] });
        const version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version as string;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pw = require(path.dirname(pkgFile)) as { chromium: { executablePath(): string } };
        const p = pw.chromium.executablePath();
        return { version, chromium: { path: p, installed: !!p && fs.existsSync(p) } };
    } catch { return null; }
}

/** Node.js is new enough for the framework (18+; 20+ recommended). */
export function nodeCheck(version = process.version): HealthCheck {
    const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
    return { id: 'node', group: 'This computer', title: `Node.js ${version}`, level: major >= 20 ? 'ok' : major >= 18 ? 'warning' : 'error',
        detail: major >= 20 ? 'Supported.' : major >= 18 ? 'Works; Node.js 20 or later is recommended.' : 'Too old: install Node.js 20 or later.' };
}
