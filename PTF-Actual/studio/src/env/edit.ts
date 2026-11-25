/**
 * Safe edits to the framework's .env configuration files.
 *  - Keeps comments, blank lines, ordering and line endings; changes only the line it must.
 *  - Writes values so dotenv reads them back exactly (verified by re-parsing before saving).
 *  - Refuses to write a literal into a secret-like key (PASSWORD, TOKEN, ...): that belongs in the
 *    secret store, referenced as {env:NAME}. `storeSecret` does both in one step.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { UserError } from '../core/errors';
import { safeRepoPath, writeFileInRepo } from '../core/safePath';
import { isSensitiveKey } from './resolve';
import { CONFIG_DIR, discover } from './layers';
import { SecretStore } from '../secrets/store';
import { StaleSaveError } from '../core/version';

export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Serialise a value so that dotenv.parse returns it unchanged. */
export function formatValue(value: string): string {
    if (value === '') return '';
    const plain = /^[^\s#'"`\\]*$/.test(value) && !value.includes('\n');
    if (plain) return value;
    if (value.includes('\n') || value.includes('\r')) {
        // dotenv expands \n inside double quotes; it cannot represent a literal backslash-n then.
        if (value.includes('"') || value.includes('\\n')) throw new UserError('This multi-line value cannot be written to a .env file safely. Put it in a file and reference the path.');
        return `"${value.replace(/\r?\n/g, '\\n')}"`;
    }
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    if (!value.includes('`')) return `\`${value}\``;
    throw new UserError('The value contains every kind of quote; .env files cannot hold it.');
}

/** Repo-relative config path → absolute, refusing anything outside config/ or not a .env file. */
export function configFile(repoRoot: string, file: string): string {
    const norm = file.replace(/\\/g, '/');
    const abs = path.resolve(repoRoot, norm);
    const relToConfig = path.relative(path.join(repoRoot, CONFIG_DIR), abs);
    if (relToConfig.startsWith('..') || path.isAbsolute(relToConfig) || !abs.endsWith('.env')) {
        throw new UserError(`Only .env files under ${CONFIG_DIR}/ can be edited here: ${file}`);
    }
    // Also after following links, and never a link itself (a committed config/dev.env -> ~/.ssh/…).
    return safeRepoPath(repoRoot, norm, { write: true, label: file });
}

export interface EnvEntry { key: string; start: number; end: number }

/**
 * KEY=value entries with the lines each one covers (a quoted value can span several lines,
 * as dotenv allows). Lines inside a multi-line value are not entries.
 */
export function envEntries(lines: string[]): EnvEntry[] {
    const out: EnvEntry[] = [];
    const re = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/;
    for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        let end = i;
        const v = m[2];
        const q = v[0];
        if ((q === '"' || q === "'" || q === '`') && v.indexOf(q, 1) < 0) {
            let j = i + 1;
            while (j < lines.length && !lines[j].includes(q)) j++;
            if (j < lines.length) end = j; // unterminated: dotenv treats the line on its own
        }
        out.push({ key: m[1], start: i, end });
        i = end;
    }
    return out;
}

export interface SetOptions {
    /** Allow a literal value in a secret-like key (user confirmed it is not a secret). */
    allowLiteralSecret?: boolean;
}

/** Set KEY in a .env file (creates the file if needed). Returns the 1-based line written. */
export function setValue(repoRoot: string, file: string, key: string, value: string, opts: SetOptions = {}): number {
    if (!KEY_RE.test(key)) throw new UserError(`"${key}" is not a valid setting name.`);
    if (isSensitiveKey(key) && value && !opts.allowLiteralSecret && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
        throw new UserError(`${key} looks like a secret. Save it in your secret store instead (it will be written as ${key}={env:NAME}).`);
    }
    const abs = configFile(repoRoot, file);
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing === '' ? [] : existing.split(/\r?\n/);
    const hadFinalNewline = existing === '' || /\r?\n$/.test(existing);
    if (hadFinalNewline && lines.length && lines[lines.length - 1] === '') lines.pop();

    const lineFor = `${key}=${formatValue(value)}`;
    const keyRe = new RegExp(`^(\\s*)(export\\s+)?${key.replace(/[.-]/g, '\\$&')}\\s*=`);
    const entries = envEntries(lines).filter((e) => e.key === key);
    let idx = entries.length ? entries[entries.length - 1].start : -1; // dotenv: last wins

    if (idx >= 0) {
        const cur = lines[idx];
        const after = cur.slice(cur.indexOf('=') + 1).trimStart();
        const q = after[0];
        if ((q === '"' || q === "'" || q === '`') && after.indexOf(q, 1) < 0) {
            throw new UserError(`${key} in ${file} is a multi-line value. Edit it in the file editor.`);
        }
        const m = keyRe.exec(cur)!;
        // Keep an inline comment ("KEY=value  # why"): after the closing quote, or after the value.
        const tail = q === '"' || q === "'" || q === '`' ? after.slice(after.indexOf(q, 1) + 1) : after;
        const comment = /\s+#.*$/.exec(tail);
        lines[idx] = `${m[1]}${m[2] ?? ''}${lineFor}${comment ? comment[0] : ''}`;
    } else {
        lines.push(lineFor);
        idx = lines.length - 1;
    }
    const out = lines.join(eol) + eol;
    const parsed = dotenv.parse(out);
    if (parsed[key] !== value) throw new UserError(`Could not write ${key} so that it reads back unchanged. Edit it in the file editor.`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeFileInRepo(abs, out);
    return idx + 1;
}

/** KEY's value in a file as dotenv reads it (the last definition wins), or null when the file does not set it. */
export function currentValue(repoRoot: string, file: string, key: string): string | null {
    const abs = configFile(repoRoot, file);
    if (!fs.existsSync(abs)) return null;
    const v = dotenv.parse(fs.readFileSync(abs, 'utf8'))[key];
    return v === undefined ? null : v;
}

/**
 * A change from a screen that read KEY earlier: `was` is the value it was shown in this file (null: not set there).
 * When the file holds something else now (another tab, someone else), the change is refused (StaleSaveError, 409)
 * instead of silently replacing that. `was` absent (a script, an older screen) or force: no check.
 */
export function checkUnchanged(repoRoot: string, file: string, key: string, was: unknown, force?: unknown): void {
    if (force === true || was === undefined) return;
    if (was !== null && typeof was !== 'string') throw new UserError('"was" must be the value shown, or null.');
    if (currentValue(repoRoot, file, key) !== was) throw new StaleSaveError(`${key} in ${file} changed in another tab or by someone else: reload to see it.`);
}

/** Remove the definitions of KEY from a file. Returns how many lines were removed. */
export function removeKey(repoRoot: string, file: string, key: string): number {
    if (!KEY_RE.test(key)) throw new UserError(`"${key}" is not a valid setting name.`);
    const abs = configFile(repoRoot, file);
    if (!fs.existsSync(abs)) return 0;
    const text = fs.readFileSync(abs, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const drop = new Set<number>();
    for (const e of envEntries(lines)) if (e.key === key) for (let i = e.start; i <= e.end; i++) drop.add(i);
    if (!drop.size) return 0;
    const kept = lines.filter((_l, i) => !drop.has(i));
    writeFileInRepo(abs, kept.join(eol));
    if (key in dotenv.parse(kept.join(eol))) throw new UserError(`${key} is still defined in ${file}; edit it in the file editor.`);
    return drop.size;
}

/** Save a secret value in the store and point the config key at it. */
export function storeSecret(repoRoot: string, store: SecretStore, args: { file: string; key: string; secretName: string; value: string; project?: string; env?: string }): number {
    store.set({ name: args.secretName, project: args.project, env: args.env }, args.value);
    return setValue(repoRoot, args.file, args.key, `{env:${args.secretName}}`);
}

/**
 * Create config/<project>/environments/<newEnv>.env from an existing environment.
 * Secret-like values are NOT copied: they become {env:NAME} references the user fills in the store.
 */
export function createEnvironment(repoRoot: string, project: string, newEnv: string, copyFrom?: string): { file: string; secretKeys: string[] } {
    if (!ENV_NAME_RE.test(newEnv)) throw new UserError(`"${newEnv}" is not a valid environment name (letters, digits, - and _).`);
    const { projects } = discover(repoRoot);
    if (!projects.includes(project)) throw new UserError(`There is no project "${project}" under ${CONFIG_DIR}/.`);
    const file = `${CONFIG_DIR}/${project}/environments/${newEnv}.env`;
    const abs = configFile(repoRoot, file);
    // An environment that exists only in config/common can still get a project file: the project's
    // values then override the shared ones (the framework loads the project file last).
    if (fs.existsSync(abs)) throw new UserError(`Environment "${newEnv}" already exists for ${project}.`);
    const secretKeys: string[] = [];
    let body = `# ${project} — ${newEnv} environment\n`;
    if (copyFrom) {
        if (!ENV_NAME_RE.test(copyFrom)) throw new UserError(`"${copyFrom}" is not a valid environment name.`);
        // The project's own file for that environment, else the shared one in config/common.
        const src = [`${CONFIG_DIR}/${project}/environments/${copyFrom}.env`, `${CONFIG_DIR}/common/environments/${copyFrom}.env`]
            .map((f) => configFile(repoRoot, f)).find((f) => fs.existsSync(f));
        if (!src) throw new UserError(`There is no "${copyFrom}" environment file to copy (looked in ${project} and common).`);
        const lines = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n').split('\n');
        const out: string[] = [];
        let at = 0;
        for (const e of envEntries(lines)) {
            out.push(...lines.slice(at, e.start));
            at = e.end + 1;
            const m = /^(\s*(?:export\s+)?)([\w.-]+)(\s*=\s*)(.*)$/.exec(lines[e.start])!;
            const [, pre, key, eq, rest] = m;
            if (key === 'ENVIRONMENT') { out.push(`${pre}${key}${eq}${newEnv}`); continue; }
            const whole = lines.slice(e.start, e.end + 1).join('\n');
            if (isSensitiveKey(key) && !(e.start === e.end && /^\{env:[^}]+\}$/.test(rest.trim()))) {
                secretKeys.push(key);
                out.push(`${pre}${key}${eq}{env:${newEnv.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`);
                continue;
            }
            out.push(whole); // multi-line values are copied whole
        }
        out.push(...lines.slice(at));
        body = out.join('\n');
        body = `# Created from "${copyFrom}". Review URLs and other values for ${newEnv}.\n` + body;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeFileInRepo(abs, body.endsWith('\n') ? body : body + '\n', { exclusive: true });
    return { file, secretKeys };
}
