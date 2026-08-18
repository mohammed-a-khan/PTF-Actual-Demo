/**
 * cs_qa_gov_secret_scanner — Scan file(s) or a directory tree for well-known
 * secret shapes. Patterns live in _helpers/secret_patterns.ts (AWS keys,
 * Azure SAS + storage connection, ADO PATs, GitHub PATs, Slack tokens,
 * Google API keys, JWT, Bearer, private-key blocks, password assignments).
 *
 * Modes:
 *   files                 → explicit file list
 *   dir                   → recursive walk (respects .gitignore-style
 *                           exclusions for node_modules, dist, coverage,
 *                           .git)
 *   staged (default)      → runs `git diff --cached --name-only` and scans
 *                           the staged versions of those files
 *
 * Returns findings[] + verdict pass/block. Any 'error'-severity hit blocks;
 * 'warn' hits do not block but are surfaced.
 *
 * Read-only — no elicitation. Nothing about a match is logged in the clear:
 * the matched value is redacted before any output surface (findings, notes,
 * audit log).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { scanTextForSecrets, SECRET_PATTERNS, SecretHit } from './_helpers/secret_patterns';

const InputSchema = z.object({
    mode: z.enum(['files', 'dir', 'staged']).default('staged'),
    files: z.array(z.string().min(1)).optional().describe('When mode=files, the file list to scan (absolute or workspace-relative).'),
    dir: z.string().min(1).optional().describe('When mode=dir, the root directory to scan (absolute or workspace-relative).'),
    includeExtensions: z.array(z.string().min(1)).optional().describe('When set, only files with these extensions (no dot) are scanned. Applies to dir/staged mode.'),
    maxFileBytes: z.number().int().positive().default(2 * 1024 * 1024).describe('Files larger than this are skipped with a warning (default 2 MB).'),
    failOnWarn: z.boolean().default(false).describe('When true, warn-severity hits count as failures too.'),
    scanKind: z.enum(['secrets', 'deps', 'sast']).default('secrets').describe('secrets = existing regex secret sniff (default; unchanged). deps = npm audit + npm outdated + optional license-checker on target dir → .cs-qa/gov/deps-report.json. sast = extends the regex pack with SAST-lite rules (innerHTML, document.write, dangerouslySetInnerHTML, sql-concat, hardcoded IPs, cleartext localhost creds, eval, Function ctor, path traversal, deserialization).'),
});

const HitSchema = z.object({
    file: z.string(),
    line: z.number(),
    column: z.number(),
    kind: z.string(),
    severity: z.enum(['error', 'warn']),
    description: z.string(),
    confidence: z.enum(['high', 'medium']),
    redactedMatch: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verdict: z.enum(['pass', 'block']),
    mode: z.string(),
    filesScanned: z.number(),
    filesSkipped: z.number(),
    findings: z.array(HitSchema),
    aggregate: z.object({
        byKind: z.record(z.string(), z.number()),
        bySeverity: z.record(z.string(), z.number()),
        byFile: z.record(z.string(), z.number()),
    }),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

function walkDir(root: string, exts: Set<string> | null): string[] {
    const out: string[] = [];
    function walk(p: string): void {
        let stat: fs.Stats;
        try { stat = fs.statSync(p); } catch { return; }
        if (stat.isFile()) {
            if (exts && exts.size > 0) {
                const ext = path.extname(p).replace(/^\./, '').toLowerCase();
                if (!exts.has(ext)) return;
            }
            out.push(p);
            return;
        }
        if (!stat.isDirectory()) return;
        const base = path.basename(p);
        if (base === 'node_modules' || base === 'dist' || base === 'coverage' || base === '.git' || base === '.cs-qa') return;
        let entries: string[] = [];
        try { entries = fs.readdirSync(p); } catch { return; }
        for (const e of entries) walk(path.join(p, e));
    }
    walk(root);
    return out;
}

function gitStagedFiles(workspaceRoot: string): { files: string[]; warning?: string } {
    const res = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: workspaceRoot, encoding: 'utf-8' });
    if (res.error) return { files: [], warning: `git diff failed: ${res.error.message}` };
    if (res.status !== 0) return { files: [], warning: `git diff exit ${res.status}: ${(res.stderr || '').slice(0, 200)}` };
    const files = (res.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    return { files };
}

/**
 * Read the STAGED blob for `relPath`. In staged mode we scan what the commit
 * would actually contain, not the working-tree file — a secret can be staged
 * and then deleted from the working tree, and only the staged read catches it.
 */
function readStagedBlob(workspaceRoot: string, relPath: string): { content?: string; warning?: string } {
    // `git show :path` reads the index (stage 0) blob. When the file is deleted
    // from the working tree the working-tree read fails but the staged blob is
    // still there — this is exactly the case we care about.
    const res = spawnSync('git', ['show', `:${relPath}`], { cwd: workspaceRoot, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
    if (res.error) return { warning: `git show :${relPath} failed: ${res.error.message}` };
    if (res.status !== 0) return { warning: `git show :${relPath} exit ${res.status}: ${(res.stderr || '').trim().slice(0, 200)}` };
    return { content: res.stdout || '' };
}

// SAST-lite rule pack — extends the secret-pattern pack when scanKind=sast.
// Each rule mirrors the SecretPattern shape used by scanTextForSecrets, but is
// tagged as a code-quality/security-hygiene finding (not a leaked-credential
// finding). Kept intentionally conservative to minimise false positives.
const SAST_PATTERNS: Array<{ kind: string; severity: 'error' | 'warn'; description: string; regex: RegExp; confidence: 'high' | 'medium' }> = [
    { kind: 'xss-innerhtml', severity: 'warn', description: 'assignment to Element.innerHTML — XSS vector when value is user-controlled', regex: /\.innerHTML\s*=\s*(?![`'"]<)/g, confidence: 'medium' },
    { kind: 'xss-document-write', severity: 'warn', description: 'document.write() call — XSS vector when input is not fully sanitized', regex: /\bdocument\.write\s*\(/g, confidence: 'medium' },
    { kind: 'xss-dangerously-set-html', severity: 'warn', description: 'React dangerouslySetInnerHTML — audit for XSS', regex: /\bdangerouslySetInnerHTML\s*[=:]/g, confidence: 'medium' },
    { kind: 'sql-concat', severity: 'error', description: 'SQL string concatenation — SQL injection vector', regex: /['"`]\s*SELECT\s[^'"`]+['"`]\s*\+\s*/gi, confidence: 'high' },
    { kind: 'hardcoded-ipv4', severity: 'warn', description: 'hardcoded IPv4 address', regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g, confidence: 'medium' },
    { kind: 'cleartext-localhost-creds', severity: 'warn', description: 'cleartext credentials in a localhost URL', regex: /https?:\/\/[^\/\s:@]+:[^\/\s@]+@(?:localhost|127\.0\.0\.1)/gi, confidence: 'high' },
    { kind: 'eval-use', severity: 'error', description: 'use of eval() — code injection risk', regex: /(?<![.\w])eval\s*\(/g, confidence: 'high' },
    { kind: 'function-ctor', severity: 'warn', description: 'new Function(...) — dynamic code compilation', regex: /new\s+Function\s*\(/g, confidence: 'high' },
    { kind: 'path-traversal-join', severity: 'warn', description: 'path.join with a ".." literal — potential path traversal', regex: /path\.join\s*\([^)]*['"`][^'"`]*\.\.[^'"`]*['"`]/g, confidence: 'medium' },
    { kind: 'unsafe-require', severity: 'error', description: 'require() with a template literal that interpolates a variable — remote code execution risk if user-controlled', regex: /require\s*\(\s*`[^`]*\$\{/g, confidence: 'high' },
    { kind: 'unsafe-deserialize', severity: 'warn', description: 'JSON.parse of an unbounded external input — audit for prototype pollution', regex: /JSON\.parse\s*\(\s*(?:req\.body|process\.argv|process\.env)/g, confidence: 'medium' },
];

interface SastHit {
    file: string;
    line: number;
    column: number;
    kind: string;
    severity: 'error' | 'warn';
    description: string;
    confidence: 'high' | 'medium';
    redactedMatch: string;
}

function scanTextForSast(file: string, content: string): SastHit[] {
    const out: SastHit[] = [];
    const lines = content.split(/\r?\n/);
    for (const rule of SAST_PATTERNS) {
        rule.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.regex.exec(content)) !== null) {
            const idx = m.index;
            let lineNum = 1, col = 1, acc = 0;
            for (let i = 0; i < lines.length; i++) {
                if (acc + lines[i].length >= idx) { lineNum = i + 1; col = idx - acc + 1; break; }
                acc += lines[i].length + 1;
            }
            const raw = m[0];
            const redacted = raw.length > 24 ? raw.slice(0, 12) + '…' + raw.slice(-6) : raw;
            out.push({ file, line: lineNum, column: col, kind: rule.kind, severity: rule.severity, description: rule.description, confidence: rule.confidence, redactedMatch: redacted });
            // Prevent zero-width loops on some patterns.
            if (rule.regex.lastIndex === m.index) rule.regex.lastIndex++;
        }
    }
    return out;
}

// deps scan — runs npm audit + npm outdated on target directory, aggregates.
// Lazy shell-out; never installs anything. Absent npm → warning + empty result.
interface DepsReport {
    generatedAt: string;
    dir: string;
    audit: { total: number; bySeverity: Record<string, number>; advisories: Array<{ name: string; severity: string; via: string; title: string; range?: string }>; note?: string };
    outdated: { total: number; packages: Array<{ name: string; current: string; wanted: string; latest: string; type?: string }>; note?: string };
    licenses: { total: number; unknownLicense: number; nonPermissive: number; packages: Array<{ name: string; version?: string; license?: string }>; note?: string };
}

function runDepsScan(dir: string): DepsReport {
    const report: DepsReport = {
        generatedAt: new Date().toISOString(),
        dir,
        audit: { total: 0, bySeverity: {}, advisories: [], note: undefined },
        outdated: { total: 0, packages: [], note: undefined },
        licenses: { total: 0, unknownLicense: 0, nonPermissive: 0, packages: [], note: undefined },
    };
    const runJson = (args: string[]): { ok: boolean; json?: unknown; note?: string } => {
        // npm audit exits non-zero when vulnerabilities exist — that is expected;
        // treat any parseable JSON stdout as success regardless of exit code.
        const r = spawnSync('npm', args, { cwd: dir, encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 120_000 });
        if (r.error) return { ok: false, note: `npm ${args.join(' ')} failed: ${r.error.message}` };
        const stdout = (r.stdout || '').trim();
        if (!stdout) return { ok: false, note: `npm ${args.join(' ')} produced no stdout${r.stderr ? ' — ' + (r.stderr || '').trim().slice(0, 200) : ''}` };
        try { return { ok: true, json: JSON.parse(stdout) }; }
        catch (e) { return { ok: false, note: `npm ${args.join(' ')} stdout unparseable: ${(e as Error).message}` }; }
    };
    // npm audit
    const audit = runJson(['audit', '--json']);
    if (!audit.ok || !audit.json) {
        report.audit.note = audit.note || 'audit failed';
    } else {
        const j = audit.json as { vulnerabilities?: Record<string, { severity?: string; via?: Array<unknown>; range?: string }>; metadata?: { vulnerabilities?: Record<string, number> } };
        const meta = j.metadata?.vulnerabilities || {};
        report.audit.bySeverity = { ...meta };
        report.audit.total = Object.values(meta).reduce((a: number, b: number) => a + b, 0);
        for (const [name, v] of Object.entries(j.vulnerabilities || {})) {
            const sev = String(v.severity || 'unknown');
            const via = Array.isArray(v.via) && v.via.length > 0
                ? (typeof v.via[0] === 'object' && v.via[0] ? String((v.via[0] as { source?: unknown; name?: unknown }).source ?? (v.via[0] as { name?: unknown }).name ?? '?') : String(v.via[0]))
                : '?';
            const title = Array.isArray(v.via) && v.via.length > 0 && typeof v.via[0] === 'object' && v.via[0]
                ? String((v.via[0] as { title?: unknown }).title ?? '(no title)')
                : '(no title)';
            report.audit.advisories.push({ name, severity: sev, via, title, range: v.range });
        }
    }
    // npm outdated
    const outdated = runJson(['outdated', '--json']);
    if (!outdated.ok || !outdated.json) {
        report.outdated.note = outdated.note || 'outdated failed';
    } else {
        const j = outdated.json as Record<string, { current?: string; wanted?: string; latest?: string; type?: string }>;
        for (const [name, meta] of Object.entries(j)) {
            report.outdated.packages.push({ name, current: meta.current || '', wanted: meta.wanted || '', latest: meta.latest || '', type: meta.type });
        }
        report.outdated.total = report.outdated.packages.length;
    }
    // license-checker — lazy, skip if not installed.
    const lc = spawnSync('npx', ['--no-install', 'license-checker', '--json'], { cwd: dir, encoding: 'utf-8', maxBuffer: 40 * 1024 * 1024, timeout: 120_000 });
    if (lc.error || lc.status !== 0 || !(lc.stdout || '').trim()) {
        report.licenses.note = 'license-checker not available (run `npm i -g license-checker` to enable). Skipped.';
    } else {
        try {
            const j = JSON.parse(lc.stdout) as Record<string, { licenses?: string }>;
            const permissive = new Set(['MIT', 'ISC', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Apache 2.0', 'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'Unlicense']);
            for (const [pkg, meta] of Object.entries(j)) {
                const [name, version] = pkg.includes('@') && pkg.lastIndexOf('@') > 0
                    ? [pkg.slice(0, pkg.lastIndexOf('@')), pkg.slice(pkg.lastIndexOf('@') + 1)]
                    : [pkg, undefined];
                const license = meta.licenses ? String(meta.licenses) : undefined;
                report.licenses.packages.push({ name, version, license });
                if (!license || license === 'UNKNOWN') report.licenses.unknownLicense++;
                else if (!permissive.has(license.replace(/[()]/g, '').split(/\s+or\s+/i)[0].trim())) report.licenses.nonPermissive++;
            }
            report.licenses.total = report.licenses.packages.length;
        } catch (e) {
            report.licenses.note = `license-checker output unparseable: ${(e as Error).message}`;
        }
    }
    return report;
}

registerPrimitive({
    name: 'cs_qa_gov_secret_scanner',
    description: 'Governance hook — scan for well-known secret shapes (AWS keys, Azure SAS, ADO PATs, GitHub PATs, Slack tokens, Google API keys, JWTs, Bearer headers, PEM private keys, password= assignments). Extended kinds: scanKind:"deps" runs npm audit + npm outdated + optional license-checker on the target dir; scanKind:"sast" extends the regex pack with SAST-lite rules (innerHTML/document.write/dangerouslySetInnerHTML, SQL-concat, eval, new Function, hardcoded IPs, cleartext localhost creds, path traversal, unsafe deserialization). Returns findings with file/line/kind and pass/block verdict. Matched values are redacted. Read-only. Example: {mode:"staged"} — default secrets scan. {mode:"dir", dir:".", scanKind:"deps"} — supply-chain audit.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_secret_scanner', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const exts = input.includeExtensions ? new Set(input.includeExtensions.map((e) => e.toLowerCase())) : null;

        // ---- scanKind: deps → supply-chain scan, shortcut before file walk. ----
        if (input.scanKind === 'deps') {
            const target = input.dir
                ? (path.isAbsolute(input.dir) ? input.dir : path.join(ctx.workspaceRoot, input.dir))
                : ctx.workspaceRoot;
            if (!fs.existsSync(path.join(target, 'package.json'))) {
                warnings.push(`No package.json at ${target} — nothing to audit.`);
                return {
                    ok: false, verdict: 'pass' as const, mode: input.mode, filesScanned: 0, filesSkipped: 0,
                    findings: [], aggregate: { byKind: {}, bySeverity: {}, byFile: {} },
                    warnings, note: 'deps scan skipped — no package.json',
                };
            }
            const deps = runDepsScan(target);
            const outPath = path.join(ctx.workspaceRoot, '.cs-qa', 'gov', 'deps-report.json');
            try {
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, JSON.stringify(deps, null, 2), 'utf-8');
            } catch (e) {
                warnings.push(`deps-report write failed: ${(e as Error).message}`);
            }
            // Convert every high/critical advisory into a finding row + verdict.
            const findings: SecretHit[] = [];
            for (const ad of deps.audit.advisories) {
                const sev: 'error' | 'warn' = (ad.severity === 'critical' || ad.severity === 'high') ? 'error' : 'warn';
                findings.push({
                    file: 'package.json',
                    line: 1, column: 1,
                    kind: `vuln-${ad.severity}`,
                    severity: sev,
                    description: `${ad.name}: ${ad.title} (via ${ad.via}${ad.range ? '; range ' + ad.range : ''})`,
                    confidence: 'high',
                    redactedMatch: ad.name,
                });
            }
            const byKind: Record<string, number> = {}; const bySeverity: Record<string, number> = {}; const byFile: Record<string, number> = {};
            for (const h of findings) {
                byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
                bySeverity[h.severity] = (bySeverity[h.severity] ?? 0) + 1;
                byFile[h.file] = (byFile[h.file] ?? 0) + 1;
            }
            const errors = bySeverity.error ?? 0;
            const verdict: 'pass' | 'block' = errors > 0 ? 'block' : 'pass';
            log.info('deps scan complete', { advisories: deps.audit.total, outdated: deps.outdated.total, licensesUnknown: deps.licenses.unknownLicense, verdict });
            return {
                ok: verdict === 'pass',
                verdict, mode: input.mode,
                filesScanned: 1, filesSkipped: 0,
                findings,
                aggregate: { byKind, bySeverity, byFile },
                warnings,
                note: `deps scan: ${deps.audit.total} vulnerabilit(y|ies), ${deps.outdated.total} outdated package(s), ${deps.licenses.unknownLicense} unknown/${deps.licenses.nonPermissive} non-permissive license(s). Report at ${outPath}.`,
            };
        }

        let filesToScan: string[] = [];
        if (input.mode === 'files') {
            if (!input.files || input.files.length === 0) {
                return {
                    ok: false,
                    verdict: 'block' as const,
                    mode: input.mode,
                    filesScanned: 0,
                    filesSkipped: 0,
                    findings: [],
                    aggregate: { byKind: {}, bySeverity: {}, byFile: {} },
                    warnings: ['mode=files requires input.files[] with at least one path.'],
                    note: 'No files provided.',
                };
            }
            filesToScan = input.files.map((f) => path.isAbsolute(f) ? f : path.join(ctx.workspaceRoot, f));
        } else if (input.mode === 'dir') {
            const root = input.dir
                ? (path.isAbsolute(input.dir) ? input.dir : path.join(ctx.workspaceRoot, input.dir))
                : ctx.workspaceRoot;
            if (!fs.existsSync(root)) {
                warnings.push(`dir does not exist: ${root}`);
            } else {
                filesToScan = walkDir(root, exts);
            }
        } else { // staged
            const { files, warning } = gitStagedFiles(ctx.workspaceRoot);
            if (warning) warnings.push(warning);
            filesToScan = files.filter((f) => {
                if (exts && exts.size > 0) {
                    const ext = path.extname(f).replace(/^\./, '').toLowerCase();
                    return exts.has(ext);
                }
                return true;
            });
        }

        const findings: SecretHit[] = [];
        let scanned = 0;
        let skipped = 0;
        for (const f of filesToScan) {
            // In staged mode, `f` is a workspace-relative path (from `git diff --name-only --cached`).
            // For files and dir modes, `f` is already an absolute path.
            const isStaged = input.mode === 'staged';
            const relForDisplay = isStaged ? f : f;
            let content = '';
            if (isStaged) {
                // Scan the STAGED blob, not the working-tree file — a secret staged
                // then deleted from the working tree would otherwise escape detection.
                const { content: staged, warning: stagedWarning } = readStagedBlob(ctx.workspaceRoot, f);
                if (staged !== undefined) {
                    if (staged.length > input.maxFileBytes) {
                        skipped++;
                        warnings.push(`Skipping staged ${f}: size ${staged.length} exceeds maxFileBytes ${input.maxFileBytes}.`);
                        continue;
                    }
                    content = staged;
                    scanned++;
                } else {
                    // Fall back to working-tree read (binary files, deleted files, etc.).
                    if (stagedWarning) warnings.push(`${stagedWarning} — falling back to working-tree read.`);
                    const absPath = path.join(ctx.workspaceRoot, f);
                    let stat: fs.Stats;
                    try { stat = fs.statSync(absPath); }
                    catch { skipped++; continue; }
                    if (!stat.isFile()) { skipped++; continue; }
                    if (stat.size > input.maxFileBytes) {
                        skipped++;
                        warnings.push(`Skipping ${absPath}: size ${stat.size} exceeds maxFileBytes ${input.maxFileBytes}.`);
                        continue;
                    }
                    try { content = fs.readFileSync(absPath, 'utf-8'); scanned++; }
                    catch (e) {
                        skipped++;
                        warnings.push(`Failed to read ${absPath}: ${(e as Error).message}`);
                        continue;
                    }
                }
            } else {
                let stat: fs.Stats;
                try { stat = fs.statSync(f); }
                catch { skipped++; continue; }
                if (!stat.isFile()) { skipped++; continue; }
                if (stat.size > input.maxFileBytes) {
                    skipped++;
                    warnings.push(`Skipping ${f}: size ${stat.size} exceeds maxFileBytes ${input.maxFileBytes}.`);
                    continue;
                }
                try { content = fs.readFileSync(f, 'utf-8'); scanned++; }
                catch (e) {
                    skipped++;
                    warnings.push(`Failed to read ${f}: ${(e as Error).message}`);
                    continue;
                }
            }
            const hits = scanTextForSecrets(relForDisplay, content, SECRET_PATTERNS);
            for (const h of hits) findings.push(h);
            if (input.scanKind === 'sast') {
                const sastHits = scanTextForSast(relForDisplay, content);
                for (const h of sastHits) findings.push(h as SecretHit);
            }
        }

        const byKind: Record<string, number> = {};
        const bySeverity: Record<string, number> = {};
        const byFile: Record<string, number> = {};
        for (const h of findings) {
            byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
            bySeverity[h.severity] = (bySeverity[h.severity] ?? 0) + 1;
            byFile[h.file] = (byFile[h.file] ?? 0) + 1;
        }
        const errors = bySeverity.error ?? 0;
        const warns = bySeverity.warn ?? 0;
        const verdict: 'pass' | 'block' = (errors > 0 || (input.failOnWarn && warns > 0)) ? 'block' : 'pass';
        log.info('secret scan complete', { mode: input.mode, scanned, skipped, findings: findings.length, errors, warns, verdict });
        return {
            ok: verdict === 'pass',
            verdict,
            mode: input.mode,
            filesScanned: scanned,
            filesSkipped: skipped,
            findings,
            aggregate: { byKind, bySeverity, byFile },
            warnings,
            note: verdict === 'pass'
                ? `${scanned} file(s) scanned; ${findings.length} finding(s) (all below block threshold).`
                : `${scanned} file(s) scanned; ${errors} error(s) + ${warns} warning(s) — block. Rotate any exposed credentials and remove from git history.`,
        };
    },
});
