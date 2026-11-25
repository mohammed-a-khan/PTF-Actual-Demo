/**
 * Syntax highlighting (in-house): a small line-based tokenizer per language. Multi-line state
 * (block comments, template strings, Gherkin doc strings) is carried from line to line.
 */
export type TokenType = 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'dec' | 'op' | 'tag' | 'key' | 'param' | 'var' | 'plain' | 'head' | 'table';
export interface Token { t: TokenType; s: string }
export type Lang = 'ts' | 'feature' | 'json' | 'env' | 'yaml' | 'md' | 'sql' | 'plain';

export function langOf(path: string): Lang {
    const p = path.toLowerCase();
    if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p)) return 'ts';
    if (p.endsWith('.feature')) return 'feature';
    if (/\.(json|jsonc)$/.test(p) || p.endsWith('.code-workspace')) return 'json';
    if (/(^|\/)\.env[^/]*$|\.(env|properties|ini|cfg|conf)$/.test(p)) return 'env';
    if (/\.ya?ml$/.test(p)) return 'yaml';
    if (/\.(md|markdown)$/.test(p)) return 'md';
    if (p.endsWith('.sql')) return 'sql';
    return 'plain';
}

const TS_KW = new Set('abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let module namespace never new null number object of private protected public readonly require return set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield'.split(' '));

type State = { block?: 'comment' | 'template' | 'doc'; /** The delimiter that opened a doc string / fence (only it closes it). */ fence?: string };

function tsLine(line: string, st: State): Token[] {
    const out: Token[] = [];
    let i = 0;
    const push = (t: TokenType, s: string) => { if (s) out.push({ t, s }); };
    if (st.block === 'comment') {
        const e = line.indexOf('*/');
        if (e < 0) return [{ t: 'com', s: line }];
        push('com', line.slice(0, e + 2)); i = e + 2; st.block = undefined;
    } else if (st.block === 'template') {
        const e = findTemplateEnd(line, 0);
        if (e < 0) return [{ t: 'str', s: line }];
        push('str', line.slice(0, e + 1)); i = e + 1; st.block = undefined;
    }
    while (i < line.length) {
        const c = line[i];
        const rest = line.slice(i);
        let m: RegExpExecArray | null;
        if (rest.startsWith('//')) { push('com', rest); break; }
        if (rest.startsWith('/*')) {
            const e = line.indexOf('*/', i + 2);
            if (e < 0) { push('com', rest); st.block = 'comment'; break; }
            push('com', line.slice(i, e + 2)); i = e + 2; continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
            push('str', line.slice(i, j + 1)); i = j + 1; continue;
        }
        if (c === '`') {
            const e = findTemplateEnd(line, i + 1);
            if (e < 0) { push('str', rest); st.block = 'template'; break; }
            push('str', line.slice(i, e + 1)); i = e + 1; continue;
        }
        if ((m = /^@[A-Za-z_$][\w$]*/.exec(rest))) { push('dec', m[0]); i += m[0].length; continue; }
        if ((m = /^(0x[\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?n?)/.exec(rest)) && !/[\w$]/.test(line[i - 1] ?? '')) { push('num', m[0]); i += m[0].length; continue; }
        if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
            const w = m[0];
            const after = line.slice(i + w.length);
            push(TS_KW.has(w) ? 'kw' : /^\s*\(/.test(after) ? 'fn' : /^[A-Z]/.test(w) ? 'type' : 'plain', w);
            i += w.length; continue;
        }
        if ((m = /^[=!<>]=?=?|^[+\-*/%&|^~?:]+|^=>/.exec(rest))) { push('op', m[0]); i += m[0].length; continue; }
        push('plain', c); i++;
    }
    return merge(out);
}

function findTemplateEnd(line: string, from: number): number {
    for (let j = from; j < line.length; j++) {
        if (line[j] === '\\') { j++; continue; }
        if (line[j] === '`') return j;
    }
    return -1;
}

function featureLine(line: string, st: State): Token[] {
    const t = line.trim();
    if (st.block === 'doc') { if (st.fence && t.startsWith(st.fence)) { st.block = undefined; st.fence = undefined; } return [{ t: 'str', s: line }]; }
    const open = /^("""|```)/.exec(t);
    if (open) { st.block = 'doc'; st.fence = open[1]; return [{ t: 'str', s: line }]; }
    if (t.startsWith('#')) return [{ t: 'com', s: line }];
    if (t.startsWith('@')) return line.split(/(\s+)/).map((s) => ({ t: s.startsWith('@') ? 'tag' : 'plain', s }));
    const out: Token[] = [];
    let m: RegExpExecArray | null;
    if ((m = /^(\s*)(Feature|Background|Scenario Outline|Scenario Template|Scenario|Example|Rule|Examples|Scenarios):(.*)$/.exec(line))) {
        return [{ t: 'plain', s: m[1] }, { t: 'head', s: m[2] + ':' }, { t: 'plain', s: m[3] }];
    }
    if (t.startsWith('|')) return line.split(/(\|)/).map((s) => ({ t: s === '|' ? 'table' : 'plain', s }));
    if ((m = /^(\s*)(Given|When|Then|And|But|\*)(\s.*)?$/.exec(line))) {
        out.push({ t: 'plain', s: m[1] }, { t: 'kw', s: m[2] });
        for (const part of (m[3] ?? '').split(/("[^"]*"|'[^']*'|<[^>]+>|\{(?:env|config|scenario|context|secret):[^}]+\})/)) {
            if (!part) continue;
            out.push({ t: /^["']/.test(part) ? 'str' : part.startsWith('<') ? 'param' : part.startsWith('{') ? 'var' : 'plain', s: part });
        }
        return out;
    }
    return [{ t: 'plain', s: line }];
}

function jsonLine(line: string): Token[] {
    const out: Token[] = [];
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|(\/\/.*$)/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        if (m.index > last) out.push({ t: 'plain', s: line.slice(last, m.index) });
        if (m[1]) { out.push({ t: m[2] ? 'key' : 'str', s: m[1] }); if (m[2]) out.push({ t: 'plain', s: m[2] }); }
        else if (m[3]) out.push({ t: 'num', s: m[3] });
        else if (m[4]) out.push({ t: 'kw', s: m[4] });
        else out.push({ t: 'com', s: m[5] });
        last = re.lastIndex;
    }
    if (last < line.length) out.push({ t: 'plain', s: line.slice(last) });
    return out;
}

function valueTokens(v: string): Token[] {
    return v.split(/(\{(?:env|config|[A-Z_][A-Z0-9_]*)[^}]*\}|\$\{[^}]+\}|ENCRYPTED:\S+|"[^"]*"|'[^']*')/).filter(Boolean)
        .map((s) => ({ t: /^(\{|\$\{)/.test(s) ? 'var' : s.startsWith('ENCRYPTED:') ? 'param' : /^["']/.test(s) ? 'str' : 'plain', s } as Token));
}

function envLine(line: string): Token[] {
    const t = line.trimStart();
    if (t.startsWith('#') || t.startsWith(';')) return [{ t: 'com', s: line }];
    const m = /^(\s*(?:export\s+)?)([\w.-]+)(\s*[=:]\s*)(.*)$/.exec(line);
    if (!m) return [{ t: 'plain', s: line }];
    return [{ t: 'plain', s: m[1] }, { t: 'key', s: m[2] }, { t: 'op', s: m[3] }, ...valueTokens(m[4])];
}

function yamlLine(line: string): Token[] {
    if (line.trimStart().startsWith('#')) return [{ t: 'com', s: line }];
    const m = /^(\s*-?\s*)([\w.$-]+)(\s*:)(.*)$/.exec(line);
    if (!m) return valueTokens(line);
    return [{ t: 'plain', s: m[1] }, { t: 'key', s: m[2] }, { t: 'op', s: m[3] }, ...valueTokens(m[4])];
}

function mdLine(line: string, st: State): Token[] {
    if (line.trimStart().startsWith('```')) { st.block = st.block === 'doc' ? undefined : 'doc'; return [{ t: 'str', s: line }]; }
    if (st.block === 'doc') return [{ t: 'str', s: line }];
    if (/^#{1,6}\s/.test(line)) return [{ t: 'head', s: line }];
    return line.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((s) => ({ t: s.startsWith('`') ? 'str' : s.startsWith('**') ? 'kw' : 'plain', s } as Token));
}

function merge(ts: Token[]): Token[] {
    const out: Token[] = [];
    for (const t of ts) { const l = out[out.length - 1]; if (l && l.t === t.t) l.s += t.s; else out.push({ ...t }); }
    return out;
}

const SQL_KW = new Set(('add all alter and any as asc begin between by case cast check column commit constraint create cross current_date current_timestamp database declare default delete desc distinct drop else end escape except exec execute exists fetch first for foreign from full function go grant group having if ilike in index inner insert intersect into is join key left like limit merge natural next not null nulls of offset on only or order outer over partition percent primary procedure references replace returning revoke right rollback row rows schema select set some table then to top transaction trigger truncate union unique update using values view when where while with within').split(' '));
const SQL_TYPES = new Set('bigint binary bit blob boolean char date datetime datetime2 datetimeoffset decimal double float int integer interval json jsonb money nchar ntext numeric nvarchar real serial smallint text time timestamp timestamptz tinyint uniqueidentifier uuid varbinary varchar xml'.split(' '));

/** SQL (all common dialects): keywords, types, strings, comments, numbers, parameters, quoted names. */
function sqlLine(line: string, st: State): Token[] {
    const out: Token[] = [];
    let i = 0;
    const push = (t: TokenType, s: string) => { if (s) out.push({ t, s }); };
    if (st.block === 'comment') {
        const e = line.indexOf('*/');
        if (e < 0) return [{ t: 'com', s: line }];
        push('com', line.slice(0, e + 2)); i = e + 2; st.block = undefined;
    }
    while (i < line.length) {
        const c = line[i], rest = line.slice(i);
        let m: RegExpExecArray | null;
        if (rest.startsWith('--')) { push('com', rest); break; }
        if (rest.startsWith('/*')) {
            const e = line.indexOf('*/', i + 2);
            if (e < 0) { push('com', rest); st.block = 'comment'; break; }
            push('com', line.slice(i, e + 2)); i = e + 2; continue;
        }
        if (c === "'" || ((c === 'N' || c === 'n' || c === 'E' || c === 'e') && line[i + 1] === "'")) {
            let j = i + (c === "'" ? 1 : 2);
            for (;;) { if (j >= line.length) break; if (line[j] === "'") { if (line[j + 1] === "'") { j += 2; continue; } break; } j++; }
            push('str', line.slice(i, j + 1)); i = j + 1; continue;
        }
        if (c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            const e = line.indexOf(close, i + 1);
            const end = e < 0 ? line.length : e + 1;
            push('var', line.slice(i, end)); i = end; continue;
        }
        if ((m = /^(\?|[@:$]\w+)/.exec(rest)) && !(c === ':' && line[i + 1] === ':')) { push('param', m[0]); i += m[0].length; continue; }
        if ((m = /^(0x[\da-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(rest)) && !/\w/.test(line[i - 1] ?? '')) { push('num', m[0]); i += m[0].length; continue; }
        if ((m = /^[A-Za-z_#][\w$#]*/.exec(rest))) {
            const w = m[0], lw = w.toLowerCase();
            push(SQL_KW.has(lw) ? 'kw' : SQL_TYPES.has(lw) ? 'type' : /^\s*\(/.test(line.slice(i + w.length)) ? 'fn' : 'plain', w);
            i += w.length; continue;
        }
        push(/[=<>!+\-*/%|&^~]/.test(c) ? 'op' : 'plain', c); i++;
    }
    return out;
}

function tokenizeLine(line: string, lang: Lang, st: State): Token[] {
    if (line.length > 5000) return [{ t: 'plain', s: line }];
    switch (lang) {
        case 'ts': return tsLine(line, st);
        case 'feature': return featureLine(line, st);
        case 'json': return jsonLine(line);
        case 'env': return envLine(line);
        case 'yaml': return yamlLine(line);
        case 'md': return mdLine(line, st);
        case 'sql': return sqlLine(line, st);
        default: return [{ t: 'plain', s: line }];
    }
}

const sameState = (a: State, b: State) => a.block === b.block && a.fence === b.fence;

/** Tokens for every line of a document (lines are separated by "\n" only). */
export function highlight(text: string, lang: Lang): Token[][] {
    return new Highlighter().update(text.split('\n'), lang);
}

/**
 * Incremental highlighting: tokens are cached per line together with the tokenizer state at the
 * start of that line. After an edit only the lines from the first changed one are re-tokenized,
 * and only until the state at a line start matches the cached state again (the rest is reused).
 */
export class Highlighter {
    private lang: Lang | null = null;
    private lines: string[] = [];
    private toks: Token[][] = [];
    /** starts[i] = state at the start of line i; starts[lines.length] = state at the end. */
    private starts: State[] = [{}];

    update(lines: string[], lang: Lang): Token[][] {
        if (lang !== this.lang) { this.lang = lang; this.lines = []; this.toks = []; this.starts = [{}]; }
        const old = this.lines, oldToks = this.toks, oldStarts = this.starts;
        const n = lines.length, oldN = old.length, lim = Math.min(n, oldN);
        let a = 0;
        while (a < lim && lines[a] === old[a]) a++;
        let b = 0;
        while (b < lim - a && lines[n - 1 - b] === old[oldN - 1 - b]) b++;
        if (a === n && n === oldN) return this.toks;
        const delta = n - oldN;
        const toks = oldToks.slice(0, a);
        const starts = oldStarts.slice(0, a);
        const st: State = { ...oldStarts[a] };
        let i = a;
        for (; i < n; i++) {
            if (i >= n - b && sameState(st, oldStarts[i - delta])) {
                for (let j = i; j < n; j++) { toks.push(oldToks[j - delta]); starts.push(oldStarts[j - delta]); }
                starts.push(oldStarts[oldN]);
                break;
            }
            starts.push({ ...st });
            toks.push(tokenizeLine(lines[i], lang, st));
        }
        if (i === n) starts.push({ ...st });
        this.lines = lines; this.toks = toks; this.starts = starts;
        return toks;
    }
}

/** Comment prefix for "toggle line comment". */
export const commentPrefix = (lang: Lang) => (lang === 'ts' || lang === 'json' ? '// ' : lang === 'sql' ? '-- ' : lang === 'md' || lang === 'plain' ? null : '# ');
