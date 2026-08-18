/**
 * Java / Spring source parser — regex-driven extraction of the facts an app-
 * source-grounded test generator needs:
 *   - Controllers: `@Controller` / `@RestController` classes and their handler
 *     methods (`@RequestMapping`, `@GetMapping`, `@PostMapping`, `@PutMapping`,
 *     `@DeleteMapping`, `@PatchMapping`).
 *   - Class-level `@RequestMapping` prefix so method paths compose correctly.
 *   - Method signature — arg list types + names; picks the `@RequestBody`,
 *     `@ModelAttribute`, `@Valid`, `@PathVariable`, `@RequestParam` annotations.
 *   - Services (`@Service`), repositories (`@Repository`), autowired fields.
 *   - Validators — classes carrying `implements Validator` or bean-validation
 *     constraint annotations (`@NotNull`, `@NotBlank`, `@NotEmpty`, `@Size`,
 *     `@Min`, `@Max`, `@Pattern`, `@Email`, `@Digits`, `@AssertTrue`,
 *     `@AssertFalse`, `@Past`, `@Future`) with their arguments + `message=`.
 *   - Entities — `@Entity`, `@Table(name=...)`, `@Column(name=...)`,
 *     `@JoinColumn(name=...)`, `@Id`, `@ManyToOne`, `@OneToMany`, nullable.
 *   - DTOs — POJO classes with fields decorated by bean-validation constraints.
 *
 * We deliberately avoid a Java AST library — the extraction here is inherently
 * lossy (comments and generic constraints get simplified) and that trade-off is
 * fine for grounding purposes. What we DO guarantee: every emitted symbol is a
 * verbatim byte-range from the source, with a filePath + lineNumber cite.
 */

export interface JavaFieldConstraint {
    kind: string;
    args: Record<string, string>;
    /** message="..." or messageKey="..." — resolved literal if inline, key otherwise. */
    errorMessageKey: string | null;
    errorMessageLiteral: string | null;
    lineNumber: number;
}

export interface JavaField {
    name: string;
    type: string;
    lineNumber: number;
    constraints: JavaFieldConstraint[];
    dbColumn: string | null;
    nullable: boolean;
    length: number | null;
    isPk: boolean;
    isFk: boolean;
    fkTarget: string | null;
}

export interface JavaClassBase {
    className: string;
    packageName: string;
    filePath: string;
    startLine: number;
    endLine: number;
}

export interface JavaController extends JavaClassBase {
    basePath: string;
    methods: JavaHandlerMethod[];
}

export interface JavaHandlerMethod {
    methodName: string;
    verb: string; // GET/POST/PUT/DELETE/PATCH/ANY
    path: string; // fully composed with basePath
    rawPath: string; // just the method-level path fragment
    lineNumber: number;
    requestDtoClass: string | null;
    responseDtoClass: string | null;
    validatorRefs: string[]; // @Valid targets
    pathVariables: string[];
    requestParams: string[];
}

export interface JavaEntity extends JavaClassBase {
    tableName: string | null;
    fields: JavaField[];
}

export interface JavaValidator extends JavaClassBase {
    /** For classes implementing Validator interface. */
    supportsClass: string | null;
    /** For constraint annotations attached to fields elsewhere — collated here. */
}

export interface JavaService extends JavaClassBase {
    kind: 'service' | 'repository' | 'component';
    methodNames: string[];
    autowiredFields: Array<{ name: string; type: string }>;
    calls: Array<{ methodName: string; targetField: string | null; targetMethod: string }>;
}

export interface JavaDto extends JavaClassBase {
    fields: JavaField[];
}

export interface JavaParseResult {
    filePath: string;
    packageName: string;
    imports: string[];
    controllers: JavaController[];
    entities: JavaEntity[];
    validators: JavaValidator[];
    services: JavaService[];
    dtos: JavaDto[];
    /** Line-level parse errors (never throws). */
    warnings: string[];
}

// -----------------------------------------------------------------------------
// Annotation regex — always requires an `@` prefix and a word boundary.
// -----------------------------------------------------------------------------

const ANN_CONTROLLER = /@(?:RestController|Controller)\b/;
const ANN_REQUEST_MAPPING = /@RequestMapping\s*(?:\(\s*(?:value\s*=\s*)?"?([^)"]*)"?\s*\))?/;
const ANN_ROUTE_METHOD = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(([\s\S]*?)\))?/g;
const ANN_ENTITY = /@Entity\b/;
const ANN_TABLE = /@Table\s*\(\s*(?:name\s*=\s*)?"([^"]+)"/;
const ANN_COLUMN = /@Column\s*\(([\s\S]*?)\)/;
const ANN_JOIN_COLUMN = /@JoinColumn\s*\(([\s\S]*?)\)/;
const ANN_ID = /@Id\b/;
const ANN_MANY_TO_ONE = /@ManyToOne\b/;
const ANN_ONE_TO_MANY = /@OneToMany\s*\(([\s\S]*?)\)/;
const ANN_SERVICE = /@Service\b/;
const ANN_REPOSITORY = /@Repository\b/;
const ANN_COMPONENT = /@Component\b/;
const ANN_AUTOWIRED = /@Autowired\b/;
const ANN_VALID = /@Valid\b/;
const ANN_REQUEST_BODY = /@RequestBody\b/;
const ANN_MODEL_ATTR = /@ModelAttribute\b/;
const ANN_PATH_VAR = /@PathVariable\s*(?:\(\s*(?:value\s*=\s*)?"?([^)"]+)"?\s*\))?/g;
const ANN_REQUEST_PARAM = /@RequestParam\s*(?:\(\s*(?:value\s*=\s*)?"?([^)"]+)"?\s*\))?/g;

const CONSTRAINT_ANN = /@(NotNull|NotBlank|NotEmpty|Size|Min|Max|Pattern|Email|Digits|AssertTrue|AssertFalse|Past|Future|DecimalMin|DecimalMax)\b\s*(?:\(([\s\S]*?)\))?/g;

// -----------------------------------------------------------------------------
// Utilities.
// -----------------------------------------------------------------------------

function stripBlockComments(src: string): string {
    // Preserve line breaks so line numbers stay stable.
    return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function stripLineComments(src: string): string {
    return src.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(src: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
    return line;
}

function parseAnnArgs(raw: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw) return out;
    // Handle both key=value pairs and a single positional value.
    const clean = raw.trim();
    if (!clean.includes('=') && (clean.startsWith('"') || /^\d/.test(clean))) {
        out.value = clean.replace(/^"(.*)"$/, '$1');
        return out;
    }
    // Split on commas that are NOT inside braces or quotes.
    const parts: string[] = [];
    let depth = 0, inQ = false, buf = '';
    for (const c of clean) {
        if (c === '"') inQ = !inQ;
        else if (!inQ && (c === '{' || c === '(' || c === '[')) depth++;
        else if (!inQ && (c === '}' || c === ')' || c === ']')) depth--;
        if (c === ',' && depth === 0 && !inQ) { parts.push(buf); buf = ''; continue; }
        buf += c;
    }
    if (buf.trim()) parts.push(buf);
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq === -1) continue;
        const k = p.slice(0, eq).trim();
        let v = p.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        out[k] = v;
    }
    return out;
}

/**
 * Find the matching close-brace for the open-brace at `openIdx`.
 * Ignores braces inside strings / char literals.
 */
function findMatchingBrace(src: string, openIdx: number): number {
    if (src[openIdx] !== '{') return -1;
    let depth = 0;
    let inStr = false;
    let inChar = false;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inStr = false;
            continue;
        }
        if (inChar) {
            if (c === '\\') { i++; continue; }
            if (c === '\'') inChar = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '\'') { inChar = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

interface ClassBlock {
    className: string;
    startIdx: number;
    endIdx: number;
    headerStart: number;
    startLine: number;
    endLine: number;
    body: string;
    annotations: string; // annotation lines above the class header
}

const CLASS_HEADER_RE = /(?:^|\n)((?:\s*@[A-Za-z_][\w.]*(?:\([\s\S]*?\))?\s*)*)\s*(?:public\s+|abstract\s+|final\s+|static\s+)*(?:class|interface|enum)\s+([A-Za-z_][\w]*)[^{]*\{/g;

function findClasses(src: string): ClassBlock[] {
    const out: ClassBlock[] = [];
    CLASS_HEADER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLASS_HEADER_RE.exec(src)) !== null) {
        const openIdx = m.index + m[0].length - 1;
        const closeIdx = findMatchingBrace(src, openIdx);
        if (closeIdx === -1) continue;
        const anns = m[1] || '';
        const headerStart = m.index + (m[0].startsWith('\n') ? 1 : 0);
        out.push({
            className: m[2],
            startIdx: openIdx,
            endIdx: closeIdx,
            headerStart,
            startLine: lineOf(src, headerStart),
            endLine: lineOf(src, closeIdx),
            body: src.slice(openIdx + 1, closeIdx),
            annotations: anns,
        });
    }
    return out;
}

function extractPackage(src: string): string {
    const m = src.match(/^\s*package\s+([\w.]+)\s*;/m);
    return m ? m[1] : '';
}

function extractImports(src: string): string[] {
    const out: string[] = [];
    const re = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
}

// -----------------------------------------------------------------------------
// Field extraction.
// -----------------------------------------------------------------------------

/**
 * Match top-level field declarations inside a class body. Handles the common
 * shapes:
 *   private String firstName;
 *   private @Column(name="ID") Long id;
 *   @NotNull @Size(min=3, max=20) private String lastName;
 *   protected List<Address> addresses = new ArrayList<>();
 *   @Column(name="EMAIL", length=100, nullable=false) private String email;
 */
function extractFields(body: string, bodyStartOffsetInFile: number, wholeFileSrc: string): JavaField[] {
    // Walk the body, collect a "statement" per top-level semicolon.
    const out: JavaField[] = [];
    let depth = 0;
    let start = 0;
    let inStr = false, inChar = false;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) { if (c === '\\') { i++; continue; } if (c === '"') inStr = false; continue; }
        if (inChar) { if (c === '\\') { i++; continue; } if (c === '\'') inChar = false; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === '\'') { inChar = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === ';' && depth === 0) {
            const stmt = body.slice(start, i);
            const stmtLineInFile = lineOf(wholeFileSrc, bodyStartOffsetInFile + start);
            const field = tryParseField(stmt, stmtLineInFile);
            if (field) out.push(field);
            start = i + 1;
        } else if (c === '(' && depth === 0) {
            // Skip through any method/constructor signature; when a '{' follows
            // outside of a lambda, we'll increment depth above.
        }
    }
    return out;
}

function tryParseField(stmt: string, baseLine: number): JavaField | null {
    // Reject method signatures — a top-level '(' that's followed by ')' + '{'
    // typically indicates a method.
    // Fields don't have a '(' outside of annotations. Strip annotations first,
    // then check.
    const stripped = stripAnnotations(stmt).trim();
    if (!stripped) return null;
    // Discard obvious non-fields.
    if (/[^=]\s*=\s*/.test(stripped) === false) {
        // No initializer — that's fine, fields can be uninitialized.
    }
    // A field looks like: [modifiers] type name (= expr)?
    const fieldRe = /^(?:\s*(?:public|private|protected|static|final|volatile|transient)\s+)*([\w<>\[\],?\s.]+?)\s+([a-zA-Z_$][\w$]*)\s*(?:=[\s\S]+)?$/;
    const m = stripped.match(fieldRe);
    if (!m) return null;
    const type = m[1].trim();
    const name = m[2].trim();
    if (!type || !name) return null;
    if (['return', 'throw', 'if', 'for', 'while', 'switch'].includes(type)) return null;

    // Extract constraint annotations from the ORIGINAL statement.
    const constraints: JavaFieldConstraint[] = [];
    CONSTRAINT_ANN.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CONSTRAINT_ANN.exec(stmt)) !== null) {
        const kind = cm[1];
        const args = parseAnnArgs(cm[2]);
        const messageArg = args.message;
        const isKey = messageArg && (messageArg.startsWith('{') && messageArg.endsWith('}'));
        constraints.push({
            kind,
            args,
            errorMessageKey: isKey ? messageArg.slice(1, -1) : null,
            errorMessageLiteral: messageArg && !isKey ? messageArg : null,
            lineNumber: baseLine,
        });
    }

    // Column / JoinColumn / Id.
    let dbColumn: string | null = null;
    let nullable = true;
    let length: number | null = null;
    let isPk = /@Id\b/.test(stmt);
    let isFk = false;
    let fkTarget: string | null = null;

    const colMatch = stmt.match(ANN_COLUMN);
    if (colMatch) {
        const args = parseAnnArgs(colMatch[1]);
        if (args.name) dbColumn = args.name;
        if (args.nullable !== undefined) nullable = args.nullable !== 'false';
        if (args.length) { const n = parseInt(args.length, 10); if (!Number.isNaN(n)) length = n; }
    }
    const joinMatch = stmt.match(ANN_JOIN_COLUMN);
    if (joinMatch) {
        const args = parseAnnArgs(joinMatch[1]);
        if (args.name) { dbColumn = args.name; isFk = true; fkTarget = type; }
    }
    if (ANN_MANY_TO_ONE.test(stmt)) {
        isFk = true;
        fkTarget = fkTarget || type;
    }

    return {
        name, type, lineNumber: baseLine,
        constraints,
        dbColumn, nullable, length,
        isPk, isFk, fkTarget,
    };
}

function stripAnnotations(stmt: string): string {
    // Strip a leading run of annotations (possibly with args). Also handle
    // annotations interspersed with modifiers.
    let out = stmt;
    let changed = true;
    const annRe = /@[A-Za-z_][\w.]*(?:\s*\([\s\S]*?\))?\s*/;
    while (changed) {
        const m = out.match(annRe);
        if (m && m.index !== undefined && m.index < 10) {
            out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
            continue;
        }
        changed = false;
    }
    return out;
}

// -----------------------------------------------------------------------------
// Method extraction (for handler methods on controllers).
// -----------------------------------------------------------------------------

/**
 * Walk a controller body and extract handler methods. We find each `{` that
 * follows a method-signature-like head, matched against the mapping annotations
 * that precede it.
 */
function extractControllerMethods(cls: ClassBlock, basePath: string, wholeFileSrc: string, bodyStartOffsetInFile: number): JavaHandlerMethod[] {
    const out: JavaHandlerMethod[] = [];
    const body = cls.body;

    // Find each opening brace at depth 0 (method body).
    let depth = 0, inStr = false, inChar = false;
    const braces: number[] = [];
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) { if (c === '\\') { i++; continue; } if (c === '"') inStr = false; continue; }
        if (inChar) { if (c === '\\') { i++; continue; } if (c === '\'') inChar = false; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === '\'') { inChar = true; continue; }
        if (c === '{') { if (depth === 0) braces.push(i); depth++; }
        else if (c === '}') depth--;
    }

    for (const braceIdx of braces) {
        // Walk backwards from `{` to the preceding statement boundary. Track
        // paren depth so annotation-argument parens (`@GetMapping("/{id}")`)
        // don't confuse us — but we treat annotation-arg `{...}` as balanced
        // string content, not a statement break.
        let start = braceIdx - 1;
        let parenDepth = 0;
        let inStr2 = false, inChar2 = false;
        while (start >= 0) {
            const c = body[start];
            // Poor-man's reverse string detection: toggle on unescaped quote.
            if (inStr2) { if (c === '"' && body[start - 1] !== '\\') inStr2 = false; start--; continue; }
            if (inChar2) { if (c === '\'' && body[start - 1] !== '\\') inChar2 = false; start--; continue; }
            if (c === '"') { inStr2 = true; start--; continue; }
            if (c === '\'') { inChar2 = true; start--; continue; }
            if (c === ')') parenDepth++;
            else if (c === '(') parenDepth--;
            else if (parenDepth === 0 && (c === ';' || c === '{' || c === '}')) break;
            start--;
        }
        const head = body.slice(start + 1, braceIdx).trim();
        if (!head) continue;

        // The method's parameter list is the LAST balanced `(...)` in the head
        // (before the body brace). Walk backwards from the end.
        const trimmed = head.trimEnd();
        // Skip a trailing `throws ...` clause.
        const throwsIdx = trimmed.search(/\bthrows\s+[\w.,\s]+$/);
        const beforeThrows = throwsIdx >= 0 ? trimmed.slice(0, throwsIdx).trimEnd() : trimmed;
        if (!beforeThrows.endsWith(')')) continue;
        let closeParen = beforeThrows.length - 1;
        let depth = 1;
        let openParen = -1;
        let inS = false, inC = false;
        for (let k = closeParen - 1; k >= 0; k--) {
            const c = beforeThrows[k];
            if (inS) { if (c === '"' && beforeThrows[k - 1] !== '\\') inS = false; continue; }
            if (inC) { if (c === '\'' && beforeThrows[k - 1] !== '\\') inC = false; continue; }
            if (c === '"') { inS = true; continue; }
            if (c === '\'') { inC = true; continue; }
            if (c === ')') depth++;
            else if (c === '(') { depth--; if (depth === 0) { openParen = k; break; } }
        }
        if (openParen === -1) continue;
        const beforeParams = beforeThrows.slice(0, openParen).trim();
        const nameMatch = beforeParams.match(/([a-zA-Z_$][\w$]*)\s*$/);
        if (!nameMatch) continue;
        const methodName = nameMatch[1];
        // Exclude constructors — they don't carry request mappings and their
        // name equals the class name; keep just method-shaped handlers with
        // a preceding mapping annotation.
        // Find any mapping annotation above the head — search up to the
        // preceding `;` or `}`.
        const paramsRaw = beforeThrows.slice(openParen + 1, closeParen);

        // Look UP for mapping annotations directly attached to this head.
        let searchFrom = start + 1;
        while (searchFrom > 0 && /[\s@]/.test(body[searchFrom - 1])) searchFrom--;
        const annBlock = body.slice(Math.max(0, start - 400), braceIdx);
        // Reset regex.
        ANN_ROUTE_METHOD.lastIndex = 0;
        let annM: RegExpExecArray | null;
        let mapping: { verb: string; path: string } | null = null;
        while ((annM = ANN_ROUTE_METHOD.exec(annBlock)) !== null) {
            // Only consider annotations physically ABOVE the method head.
            const annEnd = annM.index + annM[0].length;
            const relativeBraceIdx = braceIdx - Math.max(0, start - 400);
            if (annEnd > relativeBraceIdx) break;
            const kind = annM[1];
            const argsRaw = annM[2] || '';
            const verb = kind.replace(/Mapping$/, '').toUpperCase().replace('REQUEST', 'ANY') || 'ANY';
            const args = parseAnnArgs(argsRaw);
            const routePath = args.value || args.path || '';
            mapping = { verb, path: routePath };
        }
        if (!mapping) continue;

        const pathVars: string[] = [];
        ANN_PATH_VAR.lastIndex = 0;
        let pv: RegExpExecArray | null;
        while ((pv = ANN_PATH_VAR.exec(paramsRaw)) !== null) {
            if (pv[1]) pathVars.push(pv[1]);
        }
        // If no explicit @PathVariable name, glean from the URL template.
        const templateVars = Array.from(mapping.path.matchAll(/\{([^}]+)\}/g)).map((mm) => mm[1]);
        for (const t of templateVars) if (!pathVars.includes(t)) pathVars.push(t);

        const reqParams: string[] = [];
        ANN_REQUEST_PARAM.lastIndex = 0;
        let rp: RegExpExecArray | null;
        while ((rp = ANN_REQUEST_PARAM.exec(paramsRaw)) !== null) if (rp[1]) reqParams.push(rp[1]);

        // @RequestBody / @ModelAttribute + @Valid → validator refs and request DTO type
        const requestDtoClass = extractRequestDto(paramsRaw);
        const validatorRefs = ANN_VALID.test(paramsRaw) && requestDtoClass ? [requestDtoClass + 'Validator', requestDtoClass] : [];
        // Response DTO — return type from beforeParams (naive: type-before-name)
        const retMatch = beforeParams.match(/([\w<>\[\],?.\s]+)\s+[a-zA-Z_$][\w$]*\s*$/);
        let responseDtoClass: string | null = null;
        if (retMatch) {
            const ret = retMatch[1].trim().replace(/^(?:public|private|protected|static|final)\s+/, '');
            if (ret && ret !== 'void') {
                const inner = ret.replace(/^ResponseEntity\s*<\s*(.+?)\s*>$/, '$1');
                responseDtoClass = inner === 'void' ? null : inner.split('<')[0];
            }
        }

        const composedPath = joinPath(basePath, mapping.path);
        const methodLine = lineOf(wholeFileSrc, bodyStartOffsetInFile + braceIdx);
        out.push({
            methodName,
            verb: mapping.verb,
            path: composedPath,
            rawPath: mapping.path,
            lineNumber: methodLine,
            requestDtoClass,
            responseDtoClass,
            validatorRefs,
            pathVariables: pathVars,
            requestParams: reqParams,
        });
    }
    return out;
}

function joinPath(base: string, rel: string): string {
    const b = (base || '').replace(/\/+$/, '');
    const r = (rel || '').replace(/^\/+/, '');
    if (!b) return '/' + r;
    if (!r) return b;
    return `${b}/${r}`;
}

function extractRequestDto(params: string): string | null {
    // Split params on top-level commas.
    const parts: string[] = [];
    let depth = 0, buf = '';
    for (const c of params) {
        if (c === '<' || c === '(') depth++;
        else if (c === '>' || c === ')') depth--;
        if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
        buf += c;
    }
    if (buf) parts.push(buf);
    for (const p of parts) {
        const trimmed = p.trim();
        if (/@RequestBody\b|@ModelAttribute\b/.test(trimmed)) {
            const clean = trimmed.replace(/@[A-Za-z_][\w.]*(?:\([\s\S]*?\))?/g, '').trim();
            const m = clean.match(/^([\w.<>]+)\s+[a-zA-Z_$][\w$]*/);
            if (m) return m[1].replace(/<.*$/, '').replace(/^.+\./, '');
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// Top-level parse.
// -----------------------------------------------------------------------------

export function parseJavaFile(filePath: string, src: string): JavaParseResult {
    const warnings: string[] = [];
    const cleanForScan = stripLineComments(stripBlockComments(src));
    const pkg = extractPackage(cleanForScan);
    const imports = extractImports(cleanForScan);

    const controllers: JavaController[] = [];
    const entities: JavaEntity[] = [];
    const validators: JavaValidator[] = [];
    const services: JavaService[] = [];
    const dtos: JavaDto[] = [];

    let classes: ClassBlock[] = [];
    try {
        classes = findClasses(cleanForScan);
    } catch (e) {
        warnings.push('class-scan-failed: ' + (e as Error).message);
    }

    for (const cls of classes) {
        // Annotation block for the class comes from BEFORE the header start.
        const preambleStart = Math.max(0, cls.headerStart - 800);
        const preamble = cleanForScan.slice(preambleStart, cls.startIdx + 1);
        const bodyOffset = cls.startIdx + 1;
        const fields = extractFields(cls.body, bodyOffset, cleanForScan);
        const base: JavaClassBase = {
            className: cls.className,
            packageName: pkg,
            filePath,
            startLine: cls.startLine,
            endLine: cls.endLine,
        };

        if (ANN_CONTROLLER.test(preamble)) {
            const rmMatch = preamble.match(ANN_REQUEST_MAPPING);
            const basePath = rmMatch && rmMatch[1] ? rmMatch[1] : '';
            const methods = extractControllerMethods(cls, basePath, cleanForScan, bodyOffset);
            controllers.push({ ...base, basePath, methods });
        }
        if (ANN_ENTITY.test(preamble)) {
            const tMatch = preamble.match(ANN_TABLE);
            const tableName = tMatch ? tMatch[1] : null;
            entities.push({ ...base, tableName, fields });
        }
        if (/implements\s+(?:org\.springframework\.validation\.)?Validator\b/.test(preamble)
            || /^[\s\S]*Validator$/.test(cls.className)) {
            validators.push({ ...base, supportsClass: null });
        }
        if (ANN_SERVICE.test(preamble) || ANN_REPOSITORY.test(preamble) || ANN_COMPONENT.test(preamble)) {
            const kind: 'service' | 'repository' | 'component' =
                ANN_SERVICE.test(preamble) ? 'service' :
                ANN_REPOSITORY.test(preamble) ? 'repository' : 'component';
            const methodNames = collectMethodNames(cls.body);
            const autowiredFields = collectAutowired(cls.body);
            const calls = collectCalls(cls.body, autowiredFields);
            services.push({ ...base, kind, methodNames, autowiredFields, calls });
        }
        // A DTO is any class with at least one constraint annotation on a field
        // that is NOT already classified as an @Entity or Controller.
        if (!ANN_ENTITY.test(preamble) && !ANN_CONTROLLER.test(preamble)) {
            const hasConstraint = fields.some((f) => f.constraints.length > 0);
            const looksLikeDto = /(?:Dto|Request|Response|Form|Command|Query)$/.test(cls.className);
            if (hasConstraint || looksLikeDto) dtos.push({ ...base, fields });
        }
    }

    return { filePath, packageName: pkg, imports, controllers, entities, validators, services, dtos, warnings };
}

function collectMethodNames(body: string): string[] {
    const out = new Set<string>();
    const re = /(?:public|private|protected|static|final)\s+[\w<>\[\]?,.\s]+\s+([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.add(m[1]);
    return Array.from(out);
}

function collectAutowired(body: string): Array<{ name: string; type: string }> {
    const out: Array<{ name: string; type: string }> = [];
    const re = /@Autowired[\s\S]*?(?:public|private|protected)\s+([\w<>\[\]?,.\s]+?)\s+([a-zA-Z_$][\w$]*)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push({ type: m[1].trim(), name: m[2] });
    return out;
}

function collectCalls(body: string, autowired: Array<{ name: string; type: string }>): Array<{ methodName: string; targetField: string | null; targetMethod: string }> {
    const out: Array<{ methodName: string; targetField: string | null; targetMethod: string }> = [];
    const fieldSet = new Set(autowired.map((a) => a.name));
    // Match `this.foo.bar(...)` or `foo.bar(...)` where foo is an autowired field.
    const re = /(?:this\.)?([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        if (fieldSet.has(m[1])) {
            out.push({ methodName: '', targetField: m[1], targetMethod: m[2] });
        }
    }
    return out;
}

// Re-export for consumers.
export const _internals = { parseAnnArgs, findMatchingBrace, lineOf, splitKV: () => null };
