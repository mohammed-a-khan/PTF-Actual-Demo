import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
    { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'private-key-header', re: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----/ },
    { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    { name: 'password-assignment', re: /\bpassword\s*[:=]\s*["'][^"'\n]{6,}["']/i },
    { name: 'api-key-assignment', re: /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i },
];

// Scaffold-file paths that must be written via cs_qa_init_project, not directly.
// A direct write on a cold-start workspace almost always produces an incomplete file
// (missing 60+ required keys, plaintext credentials, no per-env split). Enforced at
// tool level as a hard rail; skill-level rule was insufficient in practice.
const SCAFFOLD_PATH_PATTERNS: RegExp[] = [
    /^package\.json$/,
    /^tsconfig\.json$/,
    /^cs-playwright-mcp\.config\.json$/,
    /^cucumber\.js$/,
    /^\.gitignore$/,
    /^config\/[^/]+\/common\/common\.env$/,
    /^config\/[^/]+\/environments\/[^/]+\.env$/,
    /^config\/[^/]+\/common\/[^/]+_queries\.env$/,
];

function isScaffoldPath(rel: string): boolean {
    const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    return SCAFFOLD_PATH_PATTERNS.some((re) => re.test(norm));
}

// Plaintext credential values in .env files — different from secret-scan because .env
// intentionally has "PASSWORD=..." lines; we accept only ENCRYPTED: / empty / obvious
// placeholders. Fires on any non-empty non-ENCRYPTED value under a credential-shaped key.
const ENV_CREDENTIAL_KEY_REGEX = /^\s*(?:[A-Z0-9_]*?)(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PAT|PASSPHRASE|CLIENT[_-]?SECRET|HMAC[_-]?SECRET)\s*=\s*(.+?)\s*$/i;
function scanEnvForPlaintextCredentials(content: string): Array<{ line: number; key: string; snippet: string }> {
    const hits: Array<{ line: number; key: string; snippet: string }> = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
        const m = ENV_CREDENTIAL_KEY_REGEX.exec(raw);
        if (!m) continue;
        const value = m[2].trim().replace(/^["']|["']$/g, '');
        if (!value) continue;
        if (value.startsWith('ENCRYPTED:')) continue;
        if (/^(paste[_-]?here|<[^>]+>|\$\{[^}]+\}|CHANGE[_-]?ME|TODO)/i.test(value)) continue;
        hits.push({ line: i + 1, key: m[1].toUpperCase(), snippet: value.length > 30 ? value.slice(0, 27) + '...' : value });
    }
    return hits;
}

function assertInsideWorkspace(workspaceRoot: string, rel: string): string {
    const normRel = rel === '' ? '.' : rel;
    const abs = path.resolve(workspaceRoot, normRel);
    const wsAbs = path.resolve(workspaceRoot);
    if (!abs.startsWith(wsAbs + path.sep) && abs !== wsAbs) {
        throw new Error(`path escape: '${rel}' resolves outside workspace root`);
    }
    if (abs.includes(`${path.sep}node_modules${path.sep}`) || abs.endsWith(`${path.sep}node_modules`)) {
        throw new Error(`path blocked: writes to node_modules are not permitted`);
    }
    return abs;
}

function scanForSecrets(content: string): Array<{ pattern: string; line: number }> {
    const hits: Array<{ pattern: string; line: number }> = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const p of SECRET_PATTERNS) {
            if (p.re.test(lines[i])) hits.push({ pattern: p.name, line: i + 1 });
        }
    }
    return hits;
}

registerPrimitive({
    name: 'cs_qa_fs',
    description: 'Read/write/list files under the workspace. Verbs: read, write, list, exists. Writes are secret-scanned and blocked from node_modules. Paths must be workspace-relative.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({ verb: z.literal('read'), path: z.string().min(1), maxBytes: z.number().int().positive().max(1_000_000).default(200_000) }),
        z.object({ verb: z.literal('write'), path: z.string().min(1), content: z.string(), force: z.boolean().default(false) }),
        z.object({
            verb: z.literal('list'),
            path: z.string().default('.'),
            recursive: z.boolean().default(false),
            depth: z.number().int().positive().max(10).optional(),
            globs: z.array(z.string()).optional(),
        }),
        z.object({ verb: z.literal('exists'), path: z.string().min(1) }),
    ]),
    outputSchema: z.union([
        z.object({ verb: z.literal('read'), path: z.string(), sizeBytes: z.number(), content: z.string(), truncated: z.boolean() }),
        z.object({ verb: z.literal('write'), path: z.string(), sizeBytes: z.number(), secretScanHits: z.array(z.object({ pattern: z.string(), line: z.number() })) }),
        z.object({ verb: z.literal('list'), path: z.string(), entries: z.array(z.object({ name: z.string(), isDir: z.boolean(), sizeBytes: z.number().optional() })) }),
        z.object({ verb: z.literal('exists'), path: z.string(), exists: z.boolean(), isDir: z.boolean().optional() }),
    ]),
    run: async (ctx, input) => {
        const abs = assertInsideWorkspace(ctx.workspaceRoot, input.path);
        if (input.verb === 'read') {
            const stat = fs.statSync(abs);
            const buf = fs.readFileSync(abs);
            const truncated = buf.length > input.maxBytes;
            return {
                verb: 'read' as const,
                path: input.path,
                sizeBytes: stat.size,
                content: truncated ? buf.slice(0, input.maxBytes).toString('utf-8') : buf.toString('utf-8'),
                truncated,
            };
        }
        if (input.verb === 'write') {
            // Hard rail: refuse scaffold-file writes unless force=true — direct writes bypass cs_qa_init_project's canonical templates
            if (isScaffoldPath(input.path) && !input.force) {
                throw new Error(`scaffold-file write blocked: '${input.path}' is a project scaffolding file (package.json / tsconfig / cs-playwright-mcp.config / .env / .gitignore / cucumber.js). Use cs_qa_init_project instead — it emits the full 60+ required keys, correct ENCRYPTED: placeholders, and reference-project-modeled structure in one call. If you truly need to write this file directly (edit an existing value only, not first-time scaffold), set force:true and take responsibility for preserving every required key.`);
            }
            // Plaintext-credential guard for .env writes — ALWAYS enforced regardless of force.
            // Different from secret-scan because .env intentionally has PASSWORD=... lines; we require
            // ENCRYPTED: prefix on credential-shaped values. force does NOT bypass this — plaintext
            // credentials leak to git and CI logs and there is never a valid reason to write them.
            if (/\.env$/i.test(input.path)) {
                const credHits = scanEnvForPlaintextCredentials(input.content);
                if (credHits.length > 0) {
                    throw new Error(`plaintext-credential write blocked (force does NOT bypass this): ${credHits.map((h) => `${h.key}=${h.snippet}@line ${h.line}`).join(', ')}. All credential-shaped keys (PASSWORD, TOKEN, SECRET, API_KEY, PAT, PASSPHRASE, HMAC_SECRET) MUST use 'ENCRYPTED:...' prefix — encrypt via 'npx cs-playwright-mcp encrypt <value>'. If you truly need a placeholder, use exact strings like 'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here', 'paste-here', '<encrypted-value>', 'CHANGE_ME', or 'TODO'.`);
                }
            }
            const hits = scanForSecrets(input.content);
            if (hits.length > 0) {
                throw new Error(`secret-scan blocked write: ${hits.map((h) => `${h.pattern}@${h.line}`).join(', ')}`);
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, input.content, 'utf-8');
            return {
                verb: 'write' as const,
                path: input.path,
                sizeBytes: Buffer.byteLength(input.content, 'utf-8'),
                secretScanHits: hits,
            };
        }
        if (input.verb === 'list') {
            const maxDepth = input.depth ?? (input.recursive ? 8 : 1);
            const collect = (dir: string, depth: number): Array<{ name: string; isDir: boolean; sizeBytes?: number }> => {
                const out: Array<{ name: string; isDir: boolean; sizeBytes?: number }> = [];
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (ent.name === 'node_modules' || ent.name.startsWith('.git')) continue;
                    const p = path.join(dir, ent.name);
                    const rel = path.relative(ctx.workspaceRoot, p).replace(/\\/g, '/');
                    if (ent.isDirectory()) {
                        out.push({ name: rel, isDir: true });
                        if (depth < maxDepth) out.push(...collect(p, depth + 1));
                    } else {
                        const s = fs.statSync(p);
                        out.push({ name: rel, isDir: false, sizeBytes: s.size });
                    }
                }
                return out;
            };
            const entries = collect(abs, 1);
            const filtered = input.globs && input.globs.length > 0
                ? entries.filter((e) => e.isDir || input.globs!.some((g) => matchesGlob(e.name, g)))
                : entries;
            return { verb: 'list' as const, path: input.path, entries: filtered.slice(0, 500) };
        }
        // exists
        const exists = fs.existsSync(abs);
        return {
            verb: 'exists' as const,
            path: input.path,
            exists,
            isDir: exists ? fs.statSync(abs).isDirectory() : undefined,
        };
    },
});

function matchesGlob(name: string, glob: string): boolean {
    const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$');
    return re.test(name);
}
