/**
 * Dynamic values and payload template functions, as the framework fills them (so a request behaves the same in the
 * Studio and in a test run):
 *
 *  - In every value (URL, headers, bodies; the framework's CSConfigurationManager.interpolate):
 *      <uuid> <random> <timestamp> <date:YYYY-MM-DD HH:mm:ss> <generate:email|phone|username|password>
 *    Any other <word> (an XML tag, a data column) is left as written.
 *  - In payload template files (the framework's CSPayloadLoader + CSPlaceholderResolver), after ${x} → {{x}}:
 *      {{name}}, {{a.b[0].c}}, {{fn(arg, "text", 2)}}, {{value | uppercase | substring(0, 3)}}
 *    with the framework's functions: uuid, guid, shortId, now, timestamp, date(format), dateAdd, dateDiff,
 *    formatDate, parseDate, randomInt, random, base64, base64Decode, urlEncode, urlDecode, htmlEncode, htmlDecode,
 *    jsonEncode, jsonDecode, md5, sha1, sha256, sha512, hmac, uppercase, lowercase, capitalize, trim, substring,
 *    replace, split, join, length, add, subtract, multiply, divide, mod, round, floor, ceil, abs, min, max, first,
 *    last, slice, reverse, sort, unique, keys, values, entries, merge, pick, omit, if, switch, default, exists, type,
 *    isString/isNumber/isBoolean/isArray/isObject/isNull/isUndefined, faker.name/email/phone/address/company/
 *    lorem/number/boolean. A placeholder that cannot be filled is left as written.
 */
import * as crypto from 'crypto';

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
export const uuid = () => crypto.randomUUID();

/** <date:FORMAT> of the configuration (YYYY MM DD HH mm ss, first occurrence each). */
function configDate(d: Date, format: string) {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return format.replace('YYYY', String(d.getFullYear())).replace('MM', p(d.getMonth() + 1)).replace('DD', p(d.getDate()))
        .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())).replace('ss', p(d.getSeconds()));
}

/** The value of a <placeholder> (without the brackets), or undefined when it is not a dynamic value. */
export function dynamicValue(placeholder: string, env: Record<string, string | undefined> = {}): string | undefined {
    const [type, ...rest] = placeholder.split(':');
    const arg = rest.join(':');
    switch (type) {
        case 'random': return Math.random().toString(36).substring(7);
        case 'timestamp': return Date.now().toString();
        case 'uuid': return uuid();
        case 'date': return configDate(new Date(), arg || 'YYYY-MM-DD');
        case 'env': { const v = env[arg]; return v ? v : undefined; }
        case 'generate':
            switch (arg) {
                case 'email': return `test_${Date.now()}@example.com`;
                case 'phone': return `+1${Math.floor(Math.random() * 9000000000 + 1000000000)}`;
                case 'username': return `user_${Math.random().toString(36).substring(7)}`;
                case 'password': { const cs = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'; let s = ''; for (let i = 0; i < 12; i++) s += cs.charAt(Math.floor(Math.random() * cs.length)); return s; }
                default: return undefined;
            }
        default: return undefined;
    }
}

/** Fill the dynamic <placeholders> of a value (other <words> are left as written). */
export function fillDynamic(text: string, env: Record<string, string | undefined> = {}): string {
    return text.replace(/<([a-zA-Z][a-zA-Z0-9_]*(?::[^>]+)?)>/g, (m, p: string) => dynamicValue(p, env) ?? m);
}

// ---- Payload templates (CSPlaceholderResolver)

const UNITS: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
function resolverDate(d: Date, format?: string) {
    if (!format) return d.toISOString();
    const r: Record<string, string> = {
        YYYY: String(d.getFullYear()), MM: String(d.getMonth() + 1).padStart(2, '0'), DD: String(d.getDate()).padStart(2, '0'),
        HH: String(d.getHours()).padStart(2, '0'), mm: String(d.getMinutes()).padStart(2, '0'), ss: String(d.getSeconds()).padStart(2, '0'),
        SSS: String(d.getMilliseconds()).padStart(3, '0'),
    };
    let out = format;
    for (const [k, v] of Object.entries(r)) out = out.replace(new RegExp(k, 'g'), v);
    return out;
}
const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const DEC: Record<string, string> = Object.fromEntries(Object.entries(ENT).map(([k, v]) => [v, k]));

type Fn = (...a: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

export class TemplateResolver {
    private readonly fns = new Map<string, Fn>();
    constructor(private readonly vars: Map<string, unknown>, private readonly env: Record<string, string | undefined> = {}) {
        const f = this.fns;
        const S = String;
        f.set('uppercase', (s) => S(s).toUpperCase()); f.set('lowercase', (s) => S(s).toLowerCase());
        f.set('capitalize', (s) => S(s).charAt(0).toUpperCase() + S(s).slice(1)); f.set('trim', (s) => S(s).trim());
        f.set('substring', (s, a, b) => S(s).substring(a, b)); f.set('replace', (s, a, b) => S(s).replace(new RegExp(a, 'g'), b));
        f.set('split', (s, sep) => S(s).split(sep)); f.set('join', (a, sep = ',') => a.join(sep));
        f.set('length', (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0));
        f.set('add', (a, b) => Number(a) + Number(b)); f.set('subtract', (a, b) => Number(a) - Number(b));
        f.set('multiply', (a, b) => Number(a) * Number(b)); f.set('divide', (a, b) => Number(a) / Number(b)); f.set('mod', (a, b) => Number(a) % Number(b));
        f.set('round', (n, d = 0) => Math.round(Number(n) * 10 ** d) / 10 ** d); f.set('floor', (n) => Math.floor(Number(n)));
        f.set('ceil', (n) => Math.ceil(Number(n))); f.set('abs', (n) => Math.abs(Number(n)));
        f.set('min', (...a) => Math.min(...a.map(Number))); f.set('max', (...a) => Math.max(...a.map(Number)));
        f.set('random', (lo = 0, hi = 1) => Math.random() * (hi - lo) + lo); f.set('randomInt', (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo);
        f.set('now', () => Date.now()); f.set('timestamp', () => new Date().toISOString()); f.set('date', (fmt) => resolverDate(new Date(), fmt));
        f.set('dateAdd', (d, n, u) => { const x = new Date(d); if (UNITS[u]) x.setTime(x.getTime() + n * UNITS[u]); return x.toISOString(); });
        f.set('dateDiff', (a, b, u) => (UNITS[u] ? Math.floor((new Date(b).getTime() - new Date(a).getTime()) / UNITS[u]) : 0));
        f.set('formatDate', (d, fmt) => resolverDate(new Date(d), fmt)); f.set('parseDate', (d) => Date.parse(d));
        f.set('base64', (s) => Buffer.from(S(s)).toString('base64')); f.set('base64Decode', (s) => Buffer.from(S(s), 'base64').toString());
        f.set('urlEncode', (s) => encodeURIComponent(s)); f.set('urlDecode', (s) => decodeURIComponent(s));
        f.set('htmlEncode', (s) => S(s).replace(/[&<>"']/g, (c) => ENT[c])); f.set('htmlDecode', (s) => S(s).replace(/&[a-z]+;|&#\d+;/gi, (e) => DEC[e] || e));
        f.set('jsonEncode', (o) => JSON.stringify(o)); f.set('jsonDecode', (s) => JSON.parse(s));
        for (const h of ['md5', 'sha1', 'sha256', 'sha512']) f.set(h, (s) => crypto.createHash(h).update(S(s)).digest('hex'));
        f.set('hmac', (s, key, alg = 'sha256') => crypto.createHmac(alg, key).update(S(s)).digest('hex'));
        f.set('uuid', uuid); f.set('guid', uuid); f.set('shortId', () => Math.random().toString(36).substring(2, 15));
        f.set('first', (a) => a[0]); f.set('last', (a) => a[a.length - 1]); f.set('slice', (a, s, e) => a.slice(s, e));
        f.set('reverse', (a) => [...a].reverse()); f.set('sort', (a) => [...a].sort()); f.set('unique', (a) => [...new Set(a)]);
        f.set('keys', (o) => Object.keys(o)); f.set('values', (o) => Object.values(o)); f.set('entries', (o) => Object.entries(o));
        f.set('merge', (...o) => Object.assign({}, ...o));
        f.set('pick', (o, ...k) => Object.fromEntries(k.filter((x) => x in o).map((x) => [x, o[x]])));
        f.set('omit', (o, ...k) => { const r = { ...o }; for (const x of k) delete r[x]; return r; });
        f.set('if', (c, a, b) => (c ? a : b));
        f.set('switch', (v, ...c) => { for (let i = 0; i < c.length - 1; i += 2) if (v === c[i]) return c[i + 1]; return c.length % 2 === 1 ? c[c.length - 1] : undefined; });
        f.set('default', (v, d) => v ?? d); f.set('exists', (v) => v !== undefined && v !== null); f.set('type', (v) => typeof v);
        f.set('isString', (v) => typeof v === 'string'); f.set('isNumber', (v) => typeof v === 'number'); f.set('isBoolean', (v) => typeof v === 'boolean');
        f.set('isArray', (v) => Array.isArray(v)); f.set('isObject', (v) => typeof v === 'object' && v !== null && !Array.isArray(v));
        f.set('isNull', (v) => v === null); f.set('isUndefined', (v) => v === undefined);
        f.set('faker.name', () => `${pick(['John', 'Jane', 'Bob', 'Alice', 'Charlie', 'Emma', 'Oliver', 'Sophia'])} ${pick(['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'])}`);
        f.set('faker.email', () => `${Math.random().toString(36).substring(2, 10)}@${pick(['gmail.com', 'yahoo.com', 'outlook.com', 'example.com', 'test.com'])}`);
        f.set('faker.phone', () => `+1-${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 9000) + 1000}`);
        f.set('faker.address', () => `${Math.floor(Math.random() * 9999) + 1} ${pick(['Main St', 'Oak Ave', 'Elm St', 'Park Rd', 'First Ave'])}, ${pick(['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'])}`);
        f.set('faker.company', () => `${pick(['Tech', 'Global', 'Advanced', 'Dynamic', 'Smart'])} ${pick(['Solutions', 'Systems', 'Corp', 'Industries', 'Group'])}`);
        f.set('faker.lorem', (n = 10) => Array.from({ length: n }, () => pick(['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua'])).join(' '));
        f.set('faker.number', (lo = 0, hi = 100) => Math.floor(Math.random() * (hi - lo + 1)) + lo);
        f.set('faker.boolean', () => Math.random() > 0.5);
        f.set('filter', (a: unknown[], pred: string) => a.filter((item, index) => this.withItem(item, index, () => this.expr(pred, 0))));
        f.set('map', (a: unknown[], t: string) => a.map((item, index) => this.withItem(item, index, () => this.expr(t, 0))));
    }

    private withItem<T>(item: unknown, index: number, run: () => T): T {
        this.vars.set('item', item); this.vars.set('index', index);
        try { return run(); } finally { this.vars.delete('item'); this.vars.delete('index'); }
    }

    /** Fill the {{…}} placeholders of a template (after ${x} → {{x}}); unfilled ones are left as written. */
    resolve(template: string, depth = 0): string {
        if (depth > 10) throw new Error('Maximum placeholder resolution depth (10) exceeded');
        return template.replace(/\{\{([^}]+)\}\}/g, (m, e: string) => {
            try {
                const r = this.expr(e.trim(), depth + 1);
                return r === undefined ? m : typeof r === 'object' && r !== null ? JSON.stringify(r) : String(r);
            } catch { return m; }
        });
    }

    private expr(e: string, depth: number): unknown {
        if (e.includes('|')) {
            const parts = e.split('|').map((p) => p.trim());
            let r = this.expr(parts[0], depth);
            for (const t of parts.slice(1)) {
                if (t.includes('(')) {
                    const [name, args] = t.split('(');
                    r = this.call(name.trim(), [r, ...args.replace(')', '').split(',').map((a) => a.trim())]);
                } else { const fn = this.fns.get(t); if (fn) r = fn(r); }
            }
            return r;
        }
        if (e.includes('(')) {
            const m = /^([a-zA-Z_][\w.]*)\((.*)\)$/.exec(e);
            return m ? this.call(m[1], this.args(m[2], depth)) : undefined;
        }
        // env.NAME (also from ${config.NAME}): the environment's value, not a path into a variable named env.
        if (e.startsWith('env.') && !this.vars.has('env')) return this.variable(e);
        if (e.includes('.')) {
            const parts = e.split('.');
            let cur = this.variable(parts[0]);
            for (const p of parts.slice(1)) { if (cur === undefined || cur === null) return undefined; cur = (cur as Record<string, unknown>)[p]; }
            return cur;
        }
        if (e.includes('[')) {
            const m = /^([^[]+)\[([^\]]+)\](.*)$/.exec(e);
            if (!m) return undefined;
            let cur = this.variable(m[1]) as Record<string, unknown> | undefined;
            if (cur === undefined || cur === null) return undefined;
            cur = cur[/^\d+$/.test(m[2]) ? Number(m[2]) : String(this.variable(m[2]))] as Record<string, unknown>;
            return cur;
        }
        return this.variable(e);
    }

    private args(s: string, depth: number): unknown[] {
        if (!s.trim()) return [];
        const out: unknown[] = [];
        let cur = '', inStr = false, q = '', level = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if ((c === '"' || c === "'") && s[i - 1] !== '\\') { if (!inStr) { inStr = true; q = c; } else if (c === q) inStr = false; }
            if (!inStr) {
                if (c === '(') level++;
                if (c === ')') level--;
                if (c === ',' && level === 0) { out.push(this.arg(cur.trim(), depth)); cur = ''; continue; }
            }
            cur += c;
        }
        if (cur.trim()) out.push(this.arg(cur.trim(), depth));
        return out;
    }

    private arg(a: string, depth: number): unknown {
        if ((a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))) return a.slice(1, -1);
        if (/^-?\d+(\.\d+)?$/.test(a)) return parseFloat(a);
        if (a === 'true') return true;
        if (a === 'false') return false;
        if (a === 'null') return null;
        if (a === 'undefined') return undefined;
        if ((a.startsWith('[') && a.endsWith(']')) || (a.startsWith('{') && a.endsWith('}'))) return JSON.parse(a);
        return this.expr(a, depth);
    }

    private call(name: string, args: unknown[]): unknown {
        const fn = this.fns.get(name);
        if (!fn) throw new Error(`Function '${name}' not found`);
        return fn(...args);
    }

    private variable(name: string): unknown {
        if (this.vars.has(name)) {
            const v = this.vars.get(name);
            // Saved values are kept as text: a JSON object or list is read as one for a.b / a[0].
            if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { return JSON.parse(v); } catch { /* text */ } }
            return v;
        }
        if (name.startsWith('env.')) return this.env[name.substring(4)];
        return undefined;
    }
}

/** ${config.key} → {{env.key}}, ${response.x} → {{responses.last.body.x}}, ${testData.k} → {{k}}, ${x} → {{x}} (CSTemplateProcessor). */
export function normalizeSyntax(t: string): string {
    return t.replace(/\$\{config\.([^}]+)\}/g, '{{env.$1}}')
        .replace(/\$\{response\.([^}]+)\}/g, (_m, p: string) => `{{responses.last.body.${p}}}`)
        .replace(/\$\{testData\.([^}]+)\}/g, '{{$1}}')
        .replace(/\$\{([^}]+)\}/g, '{{$1}}');
}
