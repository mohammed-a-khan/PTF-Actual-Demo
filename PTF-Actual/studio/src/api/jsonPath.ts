/**
 * JSON paths the way the framework's API steps read them (its CSJsonPath engine, copied here as is), so
 * a check that passes in the Studio passes in the test run:
 *
 *   $.a.b   $['a b']   $.list[0]   $.list[-1]   $.list[1:3]   $.list[0,2]   $.list[*].id   $..id
 *   $.list[?(@.sku == 'B2')].qty   (filters: @.path, == != > < >= <=, =~ /regex/i, !, &&, ||)
 *
 * A path with [*], .., a filter, a slice or a list selects several values; a check of such a path
 * compares one match as that value (the framework's CSJSONPathValidator does the same).
 */

type Segment =
    | { kind: 'prop'; names: string[] }
    | { kind: 'index'; indexes: number[] }
    | { kind: 'all' }
    | { kind: 'slice'; start?: number; end?: number; step: number }
    | { kind: 'filter'; expr: string }
    | { kind: 'deep'; then: Segment };

export interface JsonPathResult {
    /** The selected values (in document order). */
    values: any[];
    /** The path can select several values ([*], .., filter, slice, list). */
    multi: boolean;
}

/** The framework's JSON path engine (CSJsonPath), the same code. */
export class JsonPath {
    /** The values a path selects. */
    static query(data: any, path: string): JsonPathResult {
        const segments = JsonPath.parse(path);
        let nodes: any[] = [data];
        for (const seg of segments) nodes = JsonPath.step(nodes, seg);
        return { values: nodes, multi: segments.some((s) => JsonPath.isMulti(s)) };
    }

    /**
     * The value of a path: for a single-value path the value (undefined when missing); for a multi-value
     * path the array of values (undefined when none).
     */
    static value(data: any, path: string): any {
        const r = JsonPath.query(data, path);
        if (r.multi) return r.values.length ? r.values : undefined;
        return r.values.length ? r.values[0] : undefined;
    }

    private static isMulti(s: Segment): boolean {
        return s.kind === 'all' || s.kind === 'slice' || s.kind === 'filter' || s.kind === 'deep'
            || (s.kind === 'prop' && s.names.length > 1) || (s.kind === 'index' && s.indexes.length > 1);
    }

    static parse(path: string): Segment[] {
        let p = String(path ?? '').trim();
        if (p.startsWith('$')) p = p.slice(1);
        else if (p && !p.startsWith('.') && !p.startsWith('[')) p = '.' + p; // "a.b" = "$.a.b"
        const out: Segment[] = [];
        let i = 0;
        const readName = (): string => {
            const m = /^[^.[\]\s]+/.exec(p.slice(i));
            if (!m) throw new Error(`Invalid JSON path "${path}" at position ${i + 1}`);
            i += m[0].length;
            return m[0];
        };
        const readBracket = (): Segment => {
            // p[i] === '['
            let depth = 0, q: string | null = null, j = i;
            for (; j < p.length; j++) {
                const c = p[j];
                if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
                if (c === "'" || c === '"') { q = c; continue; }
                if (c === '[' || c === '(') depth++;
                else if (c === ']' || c === ')') { depth--; if (depth === 0 && c === ']') break; }
            }
            if (j >= p.length) throw new Error(`Invalid JSON path "${path}": missing ]`);
            const body = p.slice(i + 1, j).trim();
            i = j + 1;
            if (body === '*') return { kind: 'all' };
            if (body.startsWith('?')) {
                let e = body.slice(1).trim();
                if (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1);
                return { kind: 'filter', expr: e };
            }
            if (/^-?\d*\s*:\s*-?\d*(\s*:\s*-?\d+)?$/.test(body)) {
                const [a, b, c] = body.split(':').map((x) => x.trim());
                return { kind: 'slice', start: a ? Number(a) : undefined, end: b ? Number(b) : undefined, step: c ? Number(c) : 1 };
            }
            const parts = JsonPath.splitTop(body, ',');
            if (parts.every((x) => /^-?\d+$/.test(x))) return { kind: 'index', indexes: parts.map(Number) };
            return { kind: 'prop', names: parts.map((x) => JsonPath.unquote(x)) };
        };
        while (i < p.length) {
            if (p.startsWith('..', i)) {
                i += 2;
                let then: Segment;
                if (p[i] === '[') then = readBracket();
                else if (p[i] === '*') { i++; then = { kind: 'all' }; }
                else then = { kind: 'prop', names: [readName()] };
                out.push({ kind: 'deep', then });
            } else if (p[i] === '.') {
                i++;
                if (p[i] === '*') { i++; out.push({ kind: 'all' }); }
                else if (p[i] === '[') out.push(readBracket());
                else out.push({ kind: 'prop', names: [readName()] });
            } else if (p[i] === '[') {
                out.push(readBracket());
            } else if (/\s/.test(p[i])) {
                i++;
            } else {
                throw new Error(`Invalid JSON path "${path}" at position ${i + 1}`);
            }
        }
        return out;
    }

    private static step(nodes: any[], seg: Segment): any[] {
        const out: any[] = [];
        for (const n of nodes) {
            if (n === null || n === undefined) continue;
            switch (seg.kind) {
                case 'prop':
                    for (const name of seg.names) {
                        if (typeof n === 'object' && Object.prototype.hasOwnProperty.call(n, name)) out.push(n[name]);
                        else if (Array.isArray(n) && name === 'length') out.push(n.length);
                    }
                    break;
                case 'index':
                    if (Array.isArray(n)) for (const ix of seg.indexes) { const k = ix < 0 ? n.length + ix : ix; if (k >= 0 && k < n.length) out.push(n[k]); }
                    break;
                case 'all':
                    if (Array.isArray(n)) out.push(...n);
                    else if (typeof n === 'object') out.push(...Object.values(n));
                    break;
                case 'slice':
                    if (Array.isArray(n)) {
                        const len = n.length, st = seg.step || 1;
                        const norm = (x: number | undefined, d: number) => (x === undefined ? d : x < 0 ? Math.max(0, len + x) : Math.min(x, len));
                        const a = norm(seg.start, st > 0 ? 0 : len - 1), b = norm(seg.end, st > 0 ? len : -1);
                        if (st > 0) for (let k = a; k < b; k += st) out.push(n[k]);
                        else for (let k = a; k > b; k += st) out.push(n[k]);
                    }
                    break;
                case 'filter': {
                    const items = Array.isArray(n) ? n : typeof n === 'object' ? Object.values(n) : [];
                    for (const it of items) if (JsonPath.test(seg.expr, it)) out.push(it);
                    break;
                }
                case 'deep': {
                    const all: any[] = [];
                    const walk = (x: any) => { if (x === null || typeof x !== 'object') return; all.push(x); for (const v of Array.isArray(x) ? x : Object.values(x)) walk(v); };
                    walk(n);
                    for (const x of all) out.push(...JsonPath.step([x], seg.then));
                    break;
                }
            }
        }
        return out;
    }

    // ---- filters ----

    private static test(expr: string, item: any): boolean {
        const or = JsonPath.splitTop(expr, '||');
        if (or.length > 1) return or.some((e) => JsonPath.test(e, item));
        const and = JsonPath.splitTop(expr, '&&');
        if (and.length > 1) return and.every((e) => JsonPath.test(e, item));
        let e = expr.trim();
        if (e.startsWith('(') && e.endsWith(')') && JsonPath.closes(e)) return JsonPath.test(e.slice(1, -1), item);
        if (e.startsWith('!')) return !JsonPath.test(e.slice(1), item);
        // The operator's place in the text with quoted parts blanked out; the operands from the real text.
        const m = /(==|!=|>=|<=|=~|>|<)/.exec(JsonPath.maskQuoted(e));
        if (!m) { const v = JsonPath.operand(e, item); return v !== undefined && v !== null && v !== false; }
        const op = m[1];
        const left = e.slice(0, m.index).trim();
        const right = e.slice(m.index + op.length).trim();
        const a = JsonPath.operand(left, item);
        if (op === '=~') {
            const rm = /^\/(.*)\/([a-z]*)$/.exec(right);
            const re = rm ? new RegExp(rm[1], rm[2]) : new RegExp(String(JsonPath.operand(right, item)));
            return a !== undefined && a !== null && re.test(String(a));
        }
        const b = JsonPath.operand(right, item);
        switch (op) {
            case '==': return JsonPath.same(a, b);
            case '!=': return !JsonPath.same(a, b);
            default: {
                if (a === undefined || a === null || b === undefined || b === null) return false;
                const na = Number(a), nb = Number(b);
                const num = typeof a !== 'boolean' && typeof b !== 'boolean' && String(a).trim() !== '' && String(b).trim() !== '' && !isNaN(na) && !isNaN(nb);
                const x: any = num ? na : String(a), y: any = num ? nb : String(b);
                return op === '>' ? x > y : op === '<' ? x < y : op === '>=' ? x >= y : x <= y;
            }
        }
    }

    /** == in a filter: numbers and numeric text compare as numbers ('5' == 5). */
    private static same(a: any, b: any): boolean {
        if (a === b) return true;
        if (a === undefined || b === undefined || a === null || b === null) return false;
        if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) return String(a).trim() !== '' && Number(a) === Number(b);
        if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
        return false;
    }

    private static operand(t: string, item: any): any {
        const s = t.trim();
        if (s === '@') return item;
        if (s.startsWith('@')) return JsonPath.value(item, '$' + s.slice(1));
        if (s.startsWith('$')) return undefined; // the document root is not available inside a filter
        if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return JsonPath.unquote(s);
        if (s === 'true') return true;
        if (s === 'false') return false;
        if (s === 'null') return null;
        if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
        return s;
    }

    private static unquote(s: string): string {
        const t = s.trim();
        if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1).replace(/\\(.)/g, '$1');
        return t;
    }

    /** Split at a separator outside quotes, brackets, parentheses and /regex/. */
    private static splitTop(s: string, sep: string): string[] {
        const out: string[] = [];
        let depth = 0, q: string | null = null, start = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
            if (c === "'" || c === '"') { q = c; continue; }
            if (c === '/' && /=~\s*$/.test(s.slice(0, i))) { q = '/'; continue; }
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            else if (depth === 0 && s.startsWith(sep, i)) { out.push(s.slice(start, i).trim()); i += sep.length - 1; start = i + 1; }
        }
        out.push(s.slice(start).trim());
        return out;
    }

    /** Quoted text and /regex/ replaced by spaces of the same length (to find operators outside them). */
    private static maskQuoted(s: string): string {
        let out = '', q: string | null = null;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (q) { out += ' '; if (c === '\\') { out += ' '; i++; continue; } if (c === q) q = null; continue; }
            if (c === "'" || c === '"') { q = c; out += ' '; continue; }
            if (c === '/' && /=~\s*$/.test(s.slice(0, i))) { q = '/'; out += ' '; continue; }
            out += c;
        }
        return out;
    }

    /** "(…)" whose first parenthesis closes at the end. */
    private static closes(s: string): boolean {
        let depth = 0;
        for (let i = 0; i < s.length; i++) {
            if (s[i] === '(') depth++;
            else if (s[i] === ')') { depth--; if (depth === 0 && i < s.length - 1) return false; }
        }
        return true;
    }
}

/** The value of a path: one value, or the list of values of a path that selects several (undefined when none). */
export function readPath(body: unknown, path: string): unknown {
    try { return JsonPath.value(body, path); } catch { return undefined; }
}

/** The value a check compares: one match of a path that selects several is that value. */
export function checkValue(body: unknown, path: string): unknown {
    try {
        const r = JsonPath.query(body, path);
        if (!r.multi) return r.values.length ? r.values[0] : undefined;
        return r.values.length === 1 ? r.values[0] : r.values.length ? r.values : undefined;
    } catch { return undefined; }
}

/** All the values a path selects (a list for a path that selects several; [] when none). */
export function allValues(body: unknown, path: string): unknown[] {
    try { return JsonPath.query(body, path).values; } catch { return []; }
}

/** Whether a path is valid (the framework reads it). */
export function supportedPath(path: string): boolean {
    try { JsonPath.parse(path); return /^\s*\$/.test(path); } catch { return false; }
}

/** The framework's equality (deepEquals): same value, or a string and a number with the same text. */
export function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if ((typeof a === 'string' && typeof b === 'number') || (typeof a === 'number' && typeof b === 'string')) return String(a) === String(b);
    if (typeof a !== typeof b) return false;
    if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return false;
}

/** An expected value typed as in the feature: JSON literals (42, true, null, "x"), else text. */
export function expectedValue(text: string): unknown {
    const t = text.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (/^".*"$/.test(t)) { try { return JSON.parse(t); } catch { /* text */ } }
    return text;
}
