/**
 * Effective configuration for a project + environment, with provenance and problems.
 *
 * Interpolation follows the framework's rules for the parts that are fixed at load time
 * ({KEY}, {env:X}, {config:K}, {upper:}, {lower:}, {concat:}, {ternary:}, ${KEY:-default}).
 * Run-time placeholders (<random>, <uuid>, <date:…>, {context:…}, {{var}}, {currentRow} …) are
 * left as written and marked "resolved at run time".
 *
 * Values are never returned for secret-like keys or for values that came from the secret store —
 * only a mask — so this is safe to show in the UI and in logs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileLayerPaths, Layer, readFileLayer } from './layers';
import { encryptedKeyId } from '../core/encrypted';

export interface Definition {
    source: string;
    label: string;
    line?: number;
    /** Raw value as written (masked when sensitive). */
    raw: string;
}

export interface EffectiveEntry {
    key: string;
    /** Final value after interpolation (masked when sensitive). */
    value: string;
    sensitive: boolean;
    /** The definition that wins. */
    from: Definition;
    /** Earlier definitions it overrides (lowest priority first). */
    overrides: Definition[];
    runtimePlaceholders: boolean;
}

export type ProblemCode =
    | 'missing-env-reference'
    | 'legacy-encrypted-value'
    | 'literal-secret-in-config'
    | 'unresolved-reference'
    | 'missing-environment-file'
    | 'duplicate-key';

export interface Problem {
    code: ProblemCode;
    severity: 'error' | 'warning' | 'info';
    key?: string;
    source?: string;
    line?: number;
    message: string;
}

export interface ResolveInput {
    repoRoot: string;
    project: string;
    environment: string;
    /** Variables the run will have in its environment (NOT the whole OS env: pass what applies). */
    processEnv?: Record<string, string>;
    /** The full OS environment the run will inherit (used for interpolation, not listed). */
    osEnv?: Record<string, string>;
    /** Stored secrets that will be injected as environment variables (names → values). */
    secretEnv?: Record<string, string>;
    cliArgs?: Record<string, string>;
    /** Also return the real (unmasked) values. Server use only: never send them to the browser. */
    unmasked?: boolean;
}

export interface ResolveResult {
    project: string;
    environment: string;
    layers: Array<{ source: string; label: string; exists: boolean; keys: number }>;
    entries: EffectiveEntry[];
    problems: Problem[];
    /** Real values (only with `unmasked`). */
    values?: Record<string, string>;
}

const SENSITIVE_KEY = /(PASSWORD|PASSWD|PWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SIGNING_?KEY|_PAT|CREDENTIALS?)(_?\d+)?$/i;
const RUNTIME = /<(?:random|timestamp|uuid|date|generate)(?::[^>]+)?>|\{\{[^}]+\}\}|\{scenario:[^}]*\}/;

export function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY.test(key);
}

const MASK = '••••••';

export function resolveConfig(input: ResolveInput): ResolveResult {
    const { repoRoot, project, environment } = input;
    const fileLayers = fileLayerPaths(repoRoot, project, environment).map((l) => readFileLayer(repoRoot, l.source, l.label));
    const layers: Layer[] = [...fileLayers];
    const secretEnv = input.secretEnv ?? {};
    const processEnv = input.processEnv ?? {};
    layers.push({ source: '(environment variables)', kind: 'process-env', label: 'Environment variables', exists: true, values: { ...processEnv }, lines: {} });
    layers.push({ source: '(secret store)', kind: 'secret', label: 'Your secret store', exists: true, values: { ...secretEnv }, lines: {} });
    layers.push({ source: '(command line)', kind: 'cli', label: 'Command line', exists: true, values: { ...(input.cliArgs ?? {}) }, lines: {} });

    const problems: Problem[] = [];
    const defs = new Map<string, Array<Definition & { layer: Layer }>>();
    for (const layer of layers) {
        for (const [k, v] of Object.entries(layer.values)) {
            if (!defs.has(k)) defs.set(k, []);
            defs.get(k)!.push({ source: layer.source, label: layer.label, line: layer.lines[k], raw: v, layer });
        }
    }

    // The framework sets these after loading.
    const config = new Map<string, string>();
    for (const [k, list] of defs) config.set(k, list[list.length - 1].raw);
    config.set('PROJECT', project);
    config.set('ENVIRONMENT', environment);

    // Variables a run can see through {env:X}: the run's environment plus injected secrets.
    // What the test process will see: the whole OS environment plus injected secrets. The framework
    // copies ALL of process.env into its config (after the files), so {HOME}, ${BUILD_ID} etc. work.
    const runEnv: Record<string, string> = { ...(input.osEnv ?? {}), ...processEnv, ...secretEnv };
    for (const [k, v] of Object.entries(runEnv)) if (!defs.has(k)) config.set(k, v);
    const missingEnvRefs = new Map<string, Set<string>>(); // var -> keys referencing it
    const get = (k: string) => config.get(k);

    // Mirrors CSConfigurationManager.interpolateAdvanced / handleComplexVariable /
    // handleDynamicPlaceholder exactly (including its quirks: `||` treats '' as missing,
    // {ternary:C?a:b} only keeps the part before the second ':', unknown <name> becomes "name").
    const complex = (key: string, variable: string): string => {
        const parts = variable.split(':');
        switch (parts[0]) {
            case 'env':
                if (runEnv[parts[1]] === undefined) {
                    if (!missingEnvRefs.has(parts[1])) missingEnvRefs.set(parts[1], new Set());
                    missingEnvRefs.get(parts[1])!.add(key);
                }
                return runEnv[parts[1]] || '';
            case 'config': return get(parts[1]) || '';
            case 'context': return '';
            case 'ternary': {
                const [condition, values = ''] = (parts[1] ?? '').split('?');
                const [t, f] = values.split(':');
                return String(get(condition) ? t : f);
            }
            case 'concat': return (parts[1] ?? '').split('+').map((v) => get(v) || '').join('');
            case 'upper': return (get(parts[1]) || '').toUpperCase();
            case 'lower': return (get(parts[1]) || '').toLowerCase();
            case 'currentRow': case 'testData': return '';
            default: return `{${variable}}`;
        }
    };
    const dynamic = (p: string): string | null => {
        const [type, arg] = p.split(':');
        switch (type) {
            case 'random': case 'timestamp': case 'uuid': case 'date': case 'generate': return null; // differs every run: shown as written
            case 'env': return runEnv[arg] || '';
            default: return p;
        }
    };
    const interpolate = (key: string, s: string): string => {
        s = s.replace(/\{([^}]+)\}/g, (match, variable: string) => variable.includes(':') ? complex(key, variable) : (get(variable) || get(variable.toUpperCase()) || match));
        s = s.replace(/\$\{([^}]+)\}/g, (match, inner: string) => {
            const [name, def] = inner.split(':-');
            const v = get(name) || get(name.toUpperCase());
            if (v) return v;
            return runEnv[name] || def || match;
        });
        s = s.replace(/<([a-zA-Z][a-zA-Z0-9_]*(?::[^>]+)?)>/g, (match, p: string) => dynamic(p) || match);
        return s;
    };

    // The framework repeats interpolation up to 10 times until nothing changes.
    for (let i = 0, changed = true; changed && i < 10; i++) {
        changed = false;
        for (const [k, v] of config) {
            const next = interpolate(k, v);
            if (next !== v) { config.set(k, next); changed = true; }
        }
    }

    const secretNames = new Set(Object.keys(secretEnv));
    // Any value that ends up containing a secret value is masked, however it got there
    // ({A} → {env:SECRET}, ${SECRET}, {lower:A}, {concat:..}, …). Short values are ignored to
    // avoid masking ordinary words.
    const secretValues = Object.values(secretEnv).filter((v) => v.length >= 4);
    const containsSecret = (v: string) => secretValues.some((sv) => v.includes(sv) || v.toLowerCase().includes(sv.toLowerCase()));
    // Keys whose definitions (transitively) refer to a secret name are sensitive too.
    const refersTo = (raw: string, seen = new Set<string>()): boolean => {
        for (const m of raw.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) if (secretNames.has(m[1] ?? m[2])) return true;
        for (const m of raw.matchAll(/\{(?:(?:config|upper|lower):)?([A-Za-z_][\w.]*)\}|\{concat:([^}]+)\}|\{ternary:([^?}]+)/g)) {
            const names = m[2] ? m[2].split('+') : [m[1] ?? m[3]];
            for (const n of names) {
                if (!n || seen.has(n)) continue;
                seen.add(n);
                const d = defs.get(n);
                if (d && refersTo(d[d.length - 1].raw, seen)) return true;
            }
        }
        return false;
    };
    const entries: EffectiveEntry[] = [];
    for (const [key, list] of defs) {
        const winner = list[list.length - 1];
        const fromSecret = winner.layer.kind === 'secret';
        const rawRefsSecret = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
        let usesSecret = false;
        for (const m of winner.raw.matchAll(rawRefsSecret)) if (secretNames.has(m[1])) usesSecret = true;
        const value = config.get(key) ?? '';
        const sensitive = isSensitiveKey(key) || fromSecret || usesSecret || containsSecret(value) || refersTo(winner.raw);
        const show = (raw: string) => (sensitive && !/^\{env:[^}]+\}$/.test(raw) ? (raw ? MASK : '') : raw);
        entries.push({
            key,
            value: sensitive ? (value ? MASK : '') : value,
            sensitive,
            from: { source: winner.source, label: winner.label, line: winner.line, raw: show(winner.raw) },
            overrides: list.slice(0, -1).map((d) => ({ source: d.source, label: d.label, line: d.line, raw: show(d.raw) })),
            runtimePlaceholders: RUNTIME.test(value),
        });

        // Problems on the winning file definition.
        if (winner.layer.kind === 'file') {
            if (/^ENCRYPTED:/.test(winner.raw)) {
                // Encrypted with the team's own key (CS_ENCRYPTION_KEY, its id in the value): protected. Without: the built-in key.
                if (!encryptedKeyId(winner.raw)) problems.push({ code: 'legacy-encrypted-value', severity: 'warning', key, source: winner.source, line: winner.line,
                    message: `${key} uses an ENCRYPTED: value made with the framework's built-in key, which ships with the package, so it is not really protected. Move it to your secret store, or encrypt it again with the team's key (CS_ENCRYPTION_KEY).` });
            } else if (isSensitiveKey(key) && winner.raw && !/[{$]/.test(winner.raw) && !RUNTIME.test(winner.raw)) {
                problems.push({ code: 'literal-secret-in-config', severity: 'warning', key, source: winner.source, line: winner.line,
                    message: `${key} holds a literal value in ${winner.source}. Store it as a secret and write ${key}={env:NAME} instead.` });
            }
            if (/\{[A-Z_][A-Z0-9_]*\}/.test(value) && !RUNTIME.test(value)) {
                // Only UPPER_CASE names look like config keys; {testName}, {date} are templates other
                // modules fill in later (e.g. ADO run/bug title templates).
                const unresolved = [...value.matchAll(/\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]);
                if (unresolved.length) problems.push({ code: 'unresolved-reference', severity: 'warning', key, source: winner.source, line: winner.line,
                    message: `${key} refers to ${unresolved.map((n) => `{${n}}`).join(', ')}, which is not defined for ${project}/${environment}.` });
            }
        }
    }

    for (const [name, keys] of missingEnvRefs) {
        for (const key of keys) {
            const winner = defs.get(key)?.slice(-1)[0];
            problems.push({ code: 'missing-env-reference', severity: 'error', key, source: winner?.source, line: winner?.line,
                message: `${key} uses {env:${name}}, but there is no secret or environment variable named ${name} for ${environment}. The framework would use an empty value.` });
        }
    }

    // Duplicate keys inside one file: dotenv silently keeps the last one.
    for (const layer of fileLayers) {
        if (!layer.exists) continue;
        const seen = new Map<string, number>();
        const text = fs.readFileSync(path.join(repoRoot, layer.source), 'utf8');
        text.split(/\r?\n/).forEach((l, i) => {
            const m = /^\s*(?:export\s+)?([\w.-]+)\s*=/.exec(l);
            if (!m) return;
            if (seen.has(m[1])) problems.push({ code: 'duplicate-key', severity: 'info', key: m[1], source: layer.source, line: i + 1,
                message: `${m[1]} is defined more than once in ${layer.source} (line ${seen.get(m[1])} and ${i + 1}); the last one wins.` });
            seen.set(m[1], i + 1);
        });
    }

    const envFile = fileLayers.find((l) => l.source.endsWith(`/environments/${environment}.env`) && l.source.startsWith(`config/${project}/`));
    const commonEnvFile = fileLayers.find((l) => l.source === `config/common/environments/${environment}.env`);
    // Only a problem when the project HAS environment files but not this one (projects without an
    // environments/ folder legitimately run on defaults).
    const projectEnvDir = path.join(repoRoot, 'config', project, 'environments');
    const projectUsesEnvs = fs.existsSync(projectEnvDir) && fs.readdirSync(projectEnvDir).some((f) => f.endsWith('.env'));
    if (envFile && !envFile.exists && !(commonEnvFile && commonEnvFile.exists) && projectUsesEnvs) {
        problems.push({ code: 'missing-environment-file', severity: 'warning', source: envFile.source,
            message: `${project} has no "${environment}" environment (${envFile.source}). A run with ENVIRONMENT=${environment} would use only the shared settings.` });
    }

    entries.sort((a, b) => a.key.localeCompare(b.key));
    const order = { error: 0, warning: 1, info: 2 } as const;
    problems.sort((a, b) => order[a.severity] - order[b.severity] || (a.key ?? '').localeCompare(b.key ?? ''));
    return {
        project, environment,
        layers: layers.map((l) => ({ source: l.source, label: l.label, exists: l.exists, keys: Object.keys(l.values).length })),
        entries, problems,
        ...(input.unmasked ? { values: Object.fromEntries([...defs.keys()].map((k) => [k, config.get(k) ?? ''])) } : {}),
    };
}

/** Keys whose effective (masked) values differ between two environments. */
export function compareEnvironments(a: ResolveResult, b: ResolveResult): Array<{ key: string; a?: string; b?: string; aFrom?: string; bFrom?: string }> {
    const ma = new Map(a.entries.map((e) => [e.key, e]));
    const mb = new Map(b.entries.map((e) => [e.key, e]));
    const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort();
    const out = [];
    for (const k of keys) {
        const ea = ma.get(k);
        const eb = mb.get(k);
        if (ea && eb && ea.value === eb.value && ea.from.source === eb.from.source) continue;
        if (ea && eb && ea.value === eb.value && !ea.sensitive) continue;
        out.push({ key: k, a: ea?.value, b: eb?.value, aFrom: ea?.from.source, bFrom: eb?.from.source });
    }
    return out;
}

