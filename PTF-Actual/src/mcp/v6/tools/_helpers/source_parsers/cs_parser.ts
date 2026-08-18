/**
 * C# / .NET source parser (best-effort regex extraction).
 *
 * Extracts what we need for grounding — controllers, actions, entities,
 * columns, DTOs, data-annotation validation constraints:
 *   - `[Route("api/...")]`, `[HttpGet]`, `[HttpPost]`, `[ApiController]`
 *   - `[Table("EMP")]`, `[Column("NAME", ...)]`, `[Key]`, `[ForeignKey(...)]`
 *   - Data annotations: `[Required]`, `[StringLength(n)]`, `[RegularExpression(...)]`,
 *     `[EmailAddress]`, `[Range(min,max)]`, `[MinLength(n)]`, `[MaxLength(n)]`
 *   - Public methods on controllers (ActionResult<T>, IActionResult)
 *
 * We deliberately do NOT try to run Roslyn or invoke `dotnet build` — we walk
 * bytes, extract what is present, and pass the fact set to the grounding pass.
 */

export interface CsColumn {
    name: string;
    dbColumn: string | null;
    type: string;
    nullable: boolean;
    length: number | null;
    isPk: boolean;
    isFk: boolean;
    fkTarget: string | null;
    lineNumber: number;
    constraints: Array<{ kind: string; args: Record<string, string>; errorMessageLiteral: string | null }>;
}

export interface CsEntity {
    className: string;
    tableName: string | null;
    filePath: string;
    lineNumber: number;
    columns: CsColumn[];
}

export interface CsAction {
    methodName: string;
    verb: string;
    path: string;
    lineNumber: number;
    requestDtoClass: string | null;
    responseDtoClass: string | null;
}

export interface CsController {
    className: string;
    basePath: string;
    filePath: string;
    lineNumber: number;
    actions: CsAction[];
}

export interface CsParseResult {
    filePath: string;
    controllers: CsController[];
    entities: CsEntity[];
    warnings: string[];
}

function lineOf(src: string, offset: number): number {
    let ln = 1;
    for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') ln++;
    return ln;
}

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function findMatchingBrace(src: string, openIdx: number): number {
    if (src[openIdx] !== '{') return -1;
    let depth = 0;
    let inStr = false, inChar = false, inVerb = false;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (inVerb) { if (c === '"' && src[i + 1] !== '"') inVerb = false; else if (c === '"') i++; continue; }
        if (inStr) { if (c === '\\') { i++; continue; } if (c === '"') inStr = false; continue; }
        if (inChar) { if (c === '\\') { i++; continue; } if (c === '\'') inChar = false; continue; }
        if (c === '@' && src[i + 1] === '"') { inVerb = true; i++; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === '\'') { inChar = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

const CLASS_RE = /(?:^|\n)((?:\s*\[[^\]]+\]\s*)*)\s*(?:public|internal|protected|private|static|abstract|sealed|partial\s+)+class\s+([A-Za-z_]\w*)[^{]*\{/g;

function parseAttrs(raw: string): Array<{ name: string; args: string }> {
    const out: Array<{ name: string; args: string }> = [];
    const re = /\[([A-Za-z_][\w.]*)\s*(?:\(([^\]]*)\))?\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) out.push({ name: m[1], args: m[2] || '' });
    return out;
}

function attrArgs(args: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!args) return out;
    // Split on commas that are outside of quotes and parens.
    const parts: string[] = [];
    let depth = 0, inQ = false, buf = '';
    for (const c of args) {
        if (c === '"') inQ = !inQ;
        else if (!inQ && (c === '(' || c === '[' || c === '{')) depth++;
        else if (!inQ && (c === ')' || c === ']' || c === '}')) depth--;
        if (c === ',' && depth === 0 && !inQ) { parts.push(buf); buf = ''; continue; }
        buf += c;
    }
    if (buf.trim()) parts.push(buf);
    let positional = 0;
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq === -1) {
            const v = p.trim().replace(/^"(.*)"$/, '$1');
            out[`_${positional++}`] = v;
        } else {
            const k = p.slice(0, eq).trim();
            let v = p.slice(eq + 1).trim();
            if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
            out[k] = v;
        }
    }
    return out;
}

export function parseCsFile(filePath: string, src: string): CsParseResult {
    const clean = stripComments(src);
    const controllers: CsController[] = [];
    const entities: CsEntity[] = [];
    const warnings: string[] = [];

    CLASS_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CLASS_RE.exec(clean)) !== null) {
        const anns = parseAttrs(cm[1]);
        const className = cm[2];
        const openIdx = cm.index + cm[0].length - 1;
        const closeIdx = findMatchingBrace(clean, openIdx);
        if (closeIdx === -1) { warnings.push(`unbalanced braces for class ${className}`); continue; }
        const body = clean.slice(openIdx + 1, closeIdx);
        const startLine = lineOf(clean, cm.index);

        const isController = anns.some((a) => a.name === 'ApiController') || /Controller$/.test(className) || anns.some((a) => a.name === 'Route');
        const isTable = anns.some((a) => a.name === 'Table');

        if (isController) {
            const routeAttr = anns.find((a) => a.name === 'Route');
            const basePath = routeAttr ? (attrArgs(routeAttr.args)._0 || '') : '';
            const actions: CsAction[] = [];
            // Public method with HTTP verb attribute.
            const methodRe = /((?:\s*\[[^\]]+\]\s*)*)\s*(?:public|internal)\s+(?:async\s+)?([\w<>?\[\],\s]+?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
            let mm: RegExpExecArray | null;
            while ((mm = methodRe.exec(body)) !== null) {
                const mAnns = parseAttrs(mm[1]);
                const verbAnn = mAnns.find((a) => /^Http(Get|Post|Put|Delete|Patch)$/.test(a.name));
                if (!verbAnn) continue;
                const verb = verbAnn.name.replace(/^Http/, '').toUpperCase();
                const rawSub = attrArgs(verbAnn.args)._0 || '';
                const methodPath = joinPath(basePath, rawSub);
                const line = lineOf(clean, openIdx + 1 + mm.index);
                const returnType = mm[2].trim();
                const responseDto = extractResponseDto(returnType);
                const requestDto = extractRequestDto(mm[4]);
                actions.push({
                    methodName: mm[3],
                    verb,
                    path: methodPath,
                    lineNumber: line,
                    requestDtoClass: requestDto,
                    responseDtoClass: responseDto,
                });
            }
            controllers.push({ className, basePath, filePath, lineNumber: startLine, actions });
        }

        if (isTable || /Entity|Model|Record$/.test(className)) {
            const tableAttr = anns.find((a) => a.name === 'Table');
            const tableName = tableAttr ? (attrArgs(tableAttr.args)._0 || null) : null;
            const columns = extractCsColumns(body, openIdx + 1, clean);
            entities.push({ className, tableName, filePath, lineNumber: startLine, columns });
        }
    }
    return { filePath, controllers, entities, warnings };
}

function extractCsColumns(body: string, bodyOffset: number, whole: string): CsColumn[] {
    const out: CsColumn[] = [];
    // Match property declarations: `public string Name { get; set; }`
    const re = /((?:\s*\[[^\]]+\]\s*)*)\s*public\s+([\w<>?\[\],\s.]+?)\s+([A-Za-z_]\w*)\s*\{\s*(?:get|set)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        const anns = parseAttrs(m[1]);
        const type = m[2].trim();
        const name = m[3];
        const line = lineOf(whole, bodyOffset + m.index);
        const colAnn = anns.find((a) => a.name === 'Column');
        const args = colAnn ? attrArgs(colAnn.args) : {};
        const dbColumn = colAnn ? (args._0 || args.Name || null) : null;
        const nullable = type.endsWith('?') || /Nullable</.test(type);
        const isPk = anns.some((a) => a.name === 'Key');
        const fkAnn = anns.find((a) => a.name === 'ForeignKey');
        const isFk = !!fkAnn;
        const fkTarget = fkAnn ? attrArgs(fkAnn.args)._0 || null : null;
        const constraints: CsColumn['constraints'] = [];
        for (const a of anns) {
            if (['Required', 'StringLength', 'MinLength', 'MaxLength', 'Range', 'EmailAddress', 'RegularExpression', 'Phone', 'Url', 'CreditCard'].includes(a.name)) {
                const c = attrArgs(a.args);
                constraints.push({ kind: a.name, args: c, errorMessageLiteral: c.ErrorMessage || null });
            }
        }
        let length: number | null = null;
        const slAnn = anns.find((a) => a.name === 'StringLength' || a.name === 'MaxLength');
        if (slAnn) {
            const v = attrArgs(slAnn.args)._0;
            if (v) { const n = parseInt(v, 10); if (!Number.isNaN(n)) length = n; }
        }
        out.push({
            name, dbColumn, type,
            nullable, length,
            isPk, isFk, fkTarget,
            lineNumber: line, constraints,
        });
    }
    return out;
}

function extractRequestDto(params: string): string | null {
    // Skip `[FromServices]` and pull the first parameter whose annotation is
    // FromBody / FromForm / (nothing).
    const parts = splitTop(params);
    for (const p of parts) {
        if (/\[From(?:Services|Query|Route)\]/.test(p)) continue;
        const clean = p.replace(/\[[^\]]+\]/g, '').trim();
        const m = clean.match(/^([\w<>?\[\].,\s]+?)\s+([A-Za-z_]\w*)$/);
        if (m) return m[1].trim().replace(/<.*/, '').replace(/\?$/, '').replace(/^.+\./, '');
    }
    return null;
}

function extractResponseDto(returnType: string): string | null {
    if (!returnType || returnType === 'void') return null;
    // Task<ActionResult<T>> → T
    let t = returnType;
    t = t.replace(/^Task\s*<\s*(.+)\s*>$/, '$1');
    t = t.replace(/^ActionResult\s*<\s*(.+)\s*>$/, '$1');
    t = t.replace(/^IActionResult$/, '');
    if (!t || t === 'IActionResult' || t === 'ActionResult') return null;
    return t.split('<')[0].replace(/\?$/, '');
}

function splitTop(params: string): string[] {
    const out: string[] = [];
    let depth = 0, buf = '', inQ = false;
    for (const c of params) {
        if (c === '"') inQ = !inQ;
        else if (!inQ && (c === '<' || c === '(' || c === '[')) depth++;
        else if (!inQ && (c === '>' || c === ')' || c === ']')) depth--;
        if (c === ',' && depth === 0 && !inQ) { out.push(buf); buf = ''; continue; }
        buf += c;
    }
    if (buf.trim()) out.push(buf);
    return out;
}

function joinPath(base: string, sub: string): string {
    const b = (base || '').replace(/\/+$/, '');
    const s = (sub || '').replace(/^\/+/, '');
    if (!b) return '/' + s;
    if (!s) return '/' + b.replace(/^\/+/, '');
    return `/${b.replace(/^\/+/, '')}/${s}`;
}
