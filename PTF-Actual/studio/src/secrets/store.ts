/**
 * The user's secret store: named secrets (e.g. QA_PASSWORD, ADO_PAT) kept encrypted on this
 * machine, outside every repository. Tests and config refer to them by name ({env:NAME}, which the framework
 * already resolves);
 * the value is only decrypted when a run needs it.
 *
 * Scoping: a secret belongs to "all projects" or to one project, and optionally to one
 * environment (dev / qa / uat / ...). Lookup picks the most specific match:
 *   project+env → project → all+env → all
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensurePrivateDir, writeFileAtomic } from '../core/paths';
import { Protector } from './protector';
import { KnownSecret } from '../scanner/types';
import { UserError } from '../core/errors';

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Environment variables that change how programs run; a secret with this name would hijack the test process. */
const RESERVED_NAME = /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|WINDIR|COMSPEC|SHELL|USER|USERNAME|LANG|LC_ALL|TZ|CI|NODE_.*|NPM_.*|LD_.*|DYLD_.*|PLAYWRIGHT_.*|GIT_.*|SSL_.*|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|PROJECT|ENVIRONMENT|FORCE_COLOR|NO_COLOR|AUTO_OPEN_REPORT|CS_STUDIO_.*)$/;
export const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const MAX_VALUE_BYTES = 64 * 1024;

export interface SecretKey {
    name: string;
    /** Project id, or undefined for "all projects". */
    project?: string;
    /** Environment name, or undefined for "every environment". */
    env?: string;
}

export interface SecretMeta extends SecretKey {
    createdAt: string;
    updatedAt: string;
    /** Character count of the value (shown instead of the value). */
    length: number;
}

interface StoredSecret extends SecretMeta {
    sealed: string;
}

interface StoreFile {
    version: 1;
    protector: Protector['kind'];
    secrets: StoredSecret[];
}

/**
 * Scope for the Studio's own secrets (the network proxy password). No real project can have this id
 * (project ids start with a letter or digit), so these are never given to test runs and are not
 * listed with the user's secrets. They are still masked in output and caught by the commit scan.
 */
export const STUDIO_SCOPE = '@studio';

const same = (a: SecretKey, b: SecretKey) => a.name === b.name && (a.project ?? '') === (b.project ?? '') && (a.env ?? '') === (b.env ?? '');

export class SecretStore {
    private readonly file: string;
    /**
     * Decrypted values, kept in this process's memory only, so the Studio does not decrypt every
     * secret on every check (on Windows each DPAPI call starts PowerShell). Keyed by the sealed
     * text, so a changed value is decrypted again. Cleared on set/delete.
     */
    private readonly plain = new Map<string, string>();

    constructor(home: string, private readonly protector: Protector) {
        this.file = path.join(home, 'secrets', 'secrets.json');
    }

    get exists(): boolean {
        return fs.existsSync(this.file);
    }

    private load(): StoreFile {
        if (!fs.existsSync(this.file)) return { version: 1, protector: this.protector.kind, secrets: [] };
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreFile;
        if (data.version !== 1 || !Array.isArray(data.secrets)) throw new Error('The secret store file is not readable by this version.');
        if (data.protector !== this.protector.kind) {
            throw new Error(`The secret store was created with "${data.protector}" protection and cannot be opened with "${this.protector.kind}".`);
        }
        return data;
    }

    private save(data: StoreFile): void {
        ensurePrivateDir(path.dirname(this.file));
        writeFileAtomic(this.file, JSON.stringify(data, null, 2) + '\n');
    }

    static validate(key: SecretKey): void {
        if (!SECRET_NAME_RE.test(key.name)) throw new UserError('Secret names use capital letters, digits and _ and start with a letter (e.g. QA_PASSWORD).');
        if (RESERVED_NAME.test(key.name)) throw new UserError(`${key.name} is a name the operating system or Node.js uses; secrets are given to test runs as environment variables, so pick another name (e.g. QA_${key.name}).`);
        if (key.env !== undefined && !ENV_NAME_RE.test(key.env)) throw new UserError(`"${key.env}" is not a valid environment name.`);
        if (key.project !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key.project)) throw new UserError(`"${key.project}" is not a valid project id.`);
    }

    /** Store one of the Studio's own secrets (see STUDIO_SCOPE). */
    setStudio(name: string, value: string): void {
        if (!SECRET_NAME_RE.test(name)) throw new UserError('Invalid secret name.');
        this.write({ name, project: STUDIO_SCOPE }, value);
    }
    getStudio(name: string): string | undefined {
        const hit = this.load().secrets.find((s) => s.name === name && s.project === STUDIO_SCOPE);
        return hit ? this.open([hit.sealed])[0] : undefined;
    }
    hasStudio(name: string): boolean { return this.exists && this.load().secrets.some((s) => s.name === name && s.project === STUDIO_SCOPE); }
    deleteStudio(name: string): boolean { return this.delete({ name, project: STUDIO_SCOPE }); }

    set(key: SecretKey, value: string): SecretMeta {
        SecretStore.validate(key);
        return this.write(key, value);
    }

    private write(key: SecretKey, value: string): SecretMeta {
        const bytes = Buffer.from(value, 'utf8');
        if (bytes.length === 0) throw new UserError('The secret value is empty.');
        if (bytes.length > MAX_VALUE_BYTES) throw new UserError('The secret value is too large (64 KB max).');
        const data = this.load();
        const now = new Date().toISOString();
        const sealed = this.protector.protect(bytes);
        bytes.fill(0);
        const existing = data.secrets.find((s) => same(s, key));
        this.plain.clear();
        if (existing) {
            existing.sealed = sealed;
            existing.updatedAt = now;
            existing.length = value.length;
        } else {
            data.secrets.push({ name: key.name, project: key.project, env: key.env, createdAt: now, updatedAt: now, length: value.length, sealed });
        }
        this.save(data);
        return this.meta(data.secrets.find((s) => same(s, key))!);
    }

    delete(key: SecretKey): boolean {
        const data = this.load();
        const before = data.secrets.length;
        data.secrets = data.secrets.filter((s) => !same(s, key));
        if (data.secrets.length === before) return false;
        this.plain.clear();
        this.save(data);
        return true;
    }

    /** Names and metadata only — values never leave through this call. */
    list(filter: { project?: string } = {}): SecretMeta[] {
        return this.load().secrets
            .filter((s) => s.project !== STUDIO_SCOPE)
            .filter((s) => filter.project === undefined || s.project === undefined || s.project === filter.project)
            .map((s) => this.meta(s))
            .sort((a, b) => a.name.localeCompare(b.name) || (a.project ?? '').localeCompare(b.project ?? '') || (a.env ?? '').localeCompare(b.env ?? ''));
    }

    /** Most specific value for a name in a project/environment context. */
    resolve(name: string, ctx: { project?: string; env?: string } = {}): string | undefined {
        const secrets = this.load().secrets.filter((s) => s.name === name);
        const order: Array<(s: StoredSecret) => boolean> = [
            (s) => !!ctx.project && s.project === ctx.project && !!ctx.env && s.env === ctx.env,
            (s) => !!ctx.project && s.project === ctx.project && s.env === undefined,
            (s) => s.project === undefined && !!ctx.env && s.env === ctx.env,
            (s) => s.project === undefined && s.env === undefined,
        ];
        for (const match of order) {
            const hit = secrets.find(match);
            if (hit) return this.open([hit.sealed])[0];
        }
        return undefined;
    }

    /** Every stored value (all scopes) for the commit scanner's exact-match check. In memory only. */
    knownSecrets(): KnownSecret[] {
        if (!this.exists) return [];
        const all = this.load().secrets;
        const values = this.open(all.map((s) => s.sealed));
        return all.map((s, i) => ({ name: s.env ? `${s.name} (${s.env})` : s.name, value: values[i] }));
    }

    /** Decrypt (cached); several missing values are decrypted in one batch when the protector supports it. */
    private open(sealed: string[]): string[] {
        const missing = [...new Set(sealed.filter((x) => !this.plain.has(x)))];
        if (missing.length) {
            const bufs = this.protector.unprotectMany ? this.protector.unprotectMany(missing) : missing.map((x) => this.protector.unprotect(x));
            missing.forEach((x, i) => { this.plain.set(x, bufs[i].toString('utf8')); bufs[i].fill(0); });
        }
        return sealed.map((x) => this.plain.get(x)!);
    }

    private meta(s: StoredSecret): SecretMeta {
        return { name: s.name, project: s.project, env: s.env, createdAt: s.createdAt, updatedAt: s.updatedAt, length: s.length };
    }
}

/**
 * Stored secrets as environment variables for a test run in a project/environment. The framework
 * resolves `{env:NAME}` in configuration values and step text (CSConfigurationManager.interpolate),
 * so config can say `DB_PASSWORD={env:QA_DB_PASSWORD}` and the value is only ever in memory.
 */
export function secretsAsEnv(store: SecretStore, ctx: { project?: string; env?: string }): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of new Set(store.list({ project: ctx.project }).map((m) => m.name))) {
        const v = store.resolve(name, ctx);
        if (v !== undefined) out[name] = v;
    }
    return out;
}
