/**
 * TypeScript / JavaScript / React / Angular parser. Uses the TypeScript
 * compiler API to build a real AST and then walks it — no regex-only heuristics
 * for TS/TSX because JSX attribute values escape too easily.
 *
 * We extract:
 *   - React function components + their JSX form-family elements
 *   - Angular components + template forms (inline `template:` string only —
 *     external HTML templates go through the Thymeleaf/JSP parsers separately)
 *   - Angular routes (`Routes` array literal with `path`+`component`)
 *   - React Router routes (`<Route path=... element=... />`)
 *   - `data-testid` attributes for downstream locator suggestion.
 *
 * If the `typescript` module is unavailable at runtime, we degrade gracefully
 * by returning an empty result with a warning.
 */

// The TypeScript compiler API ships with the repo's own deps (tsc is used
// throughout the build), so this import is safe. We type against the module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tsMod: any = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    tsMod = require('typescript');
} catch {
    tsMod = null;
}

export interface TsScreen {
    componentName: string;
    filePath: string;
    lineNumber: number;
    kind: 'react' | 'angular';
    fields: Array<{
        id: string | null;
        name: string | null;
        testId: string | null;
        tag: string;
        type: string | null;
        formControlName: string | null;
        placeholder: string | null;
        lineNumber: number;
    }>;
    buttons: Array<{ id: string | null; testId: string | null; text: string | null; lineNumber: number }>;
}

export interface TsRoute {
    path: string;
    componentClass: string;
    filePath: string;
    lineNumber: number;
}

export interface TsParseResult {
    filePath: string;
    screens: TsScreen[];
    routes: TsRoute[];
    warnings: string[];
}

export function parseTsFile(filePath: string, src: string): TsParseResult {
    const warnings: string[] = [];
    if (!tsMod) return { filePath, screens: [], routes: [], warnings: ['typescript-module-unavailable'] };
    const ts = tsMod;
    let sf: any;
    try {
        sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    } catch (e) {
        return { filePath, screens: [], routes: [], warnings: ['ts-parse-failed: ' + (e as Error).message] };
    }

    const screens: TsScreen[] = [];
    const routes: TsRoute[] = [];

    // -------------------------------------------------------------------------
    // React function components (either `export function Foo(...)` or
    // `const Foo = () => (<...>)`).
    // -------------------------------------------------------------------------
    function componentNameFromNode(node: any): string | null {
        if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
        if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && /^[A-Z]/.test(decl.name.text)) return decl.name.text;
            }
        }
        return null;
    }

    function walkJsx(node: any, buckets: TsScreen): void {
        if (!node) return;
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tagName = node.tagName && node.tagName.getText ? node.tagName.getText(sf) : String(node.tagName?.text || '');
            const tagLower = tagName.toLowerCase();
            const attrs: Record<string, string | null> = {};
            for (const a of node.attributes.properties as any[]) {
                if (!a.name) continue;
                const key = a.name.escapedText || a.name.getText(sf);
                let val: string | null = null;
                if (a.initializer) {
                    if (ts.isStringLiteral(a.initializer)) val = a.initializer.text;
                    else if (a.initializer.expression && ts.isStringLiteral(a.initializer.expression)) val = a.initializer.expression.text;
                    else val = a.initializer.getText(sf);
                } else {
                    val = 'true';
                }
                attrs[String(key)] = val;
            }
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const lineNumber = pos.line + 1;
            if (['input', 'select', 'textarea'].includes(tagLower)) {
                buckets.fields.push({
                    id: attrs['id'] ?? null,
                    name: attrs['name'] ?? null,
                    testId: attrs['data-testid'] ?? null,
                    tag: tagLower,
                    type: attrs['type'] ?? (tagLower === 'select' ? 'select' : 'text'),
                    formControlName: attrs['formControlName'] ?? null,
                    placeholder: attrs['placeholder'] ?? null,
                    lineNumber,
                });
            } else if (tagLower === 'button') {
                buckets.buttons.push({
                    id: attrs['id'] ?? null,
                    testId: attrs['data-testid'] ?? null,
                    text: attrs['children'] ?? null,
                    lineNumber,
                });
            } else if (tagLower === 'route') {
                // React Router v6 style.
                const rp = attrs['path'];
                const elm = attrs['element'];
                if (rp) {
                    routes.push({
                        path: rp,
                        componentClass: elm ? elm.replace(/^<|\s*\/?>$/g, '').split(/\s/)[0] : '(unknown)',
                        filePath,
                        lineNumber,
                    });
                }
            }
        }
        ts.forEachChild(node, (child: any) => walkJsx(child, buckets));
    }

    // -------------------------------------------------------------------------
    // Angular: `@Component({ selector: ..., template: '...html...' })`
    // -------------------------------------------------------------------------
    function angularComponent(node: any): { componentName: string; template: string; line: number } | null {
        if (!ts.isClassDeclaration(node) || !node.name) return null;
        for (const d of node.decorators || node.modifiers || []) {
            if (d.expression && ts.isCallExpression(d.expression)) {
                const callee = d.expression.expression && d.expression.expression.getText ? d.expression.expression.getText(sf) : '';
                if (callee === 'Component' && d.expression.arguments.length > 0) {
                    const arg = d.expression.arguments[0];
                    if (ts.isObjectLiteralExpression(arg)) {
                        let template = '';
                        for (const prop of arg.properties as any[]) {
                            if (!prop.name) continue;
                            const pn = prop.name.text || prop.name.getText(sf);
                            if (pn === 'template' && prop.initializer && ts.isStringLiteralLike(prop.initializer)) template = prop.initializer.text;
                        }
                        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                        return { componentName: node.name.text, template, line: pos.line + 1 };
                    }
                }
            }
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Angular routes: variable assigned to `Routes = [{ path: ..., component: ... }, ...]`
    // -------------------------------------------------------------------------
    function extractAngularRoutes(node: any): void {
        if (!ts.isVariableStatement(node)) return;
        for (const decl of node.declarationList.declarations) {
            if (!decl.initializer || !ts.isArrayLiteralExpression(decl.initializer)) continue;
            for (const el of decl.initializer.elements) {
                if (!ts.isObjectLiteralExpression(el)) continue;
                let p: string | null = null, comp: string | null = null;
                for (const prop of el.properties as any[]) {
                    if (!prop.name) continue;
                    const pn = prop.name.text || prop.name.getText(sf);
                    if (pn === 'path' && ts.isStringLiteralLike(prop.initializer)) p = prop.initializer.text;
                    if (pn === 'component' && prop.initializer) comp = prop.initializer.getText(sf);
                }
                if (p !== null && comp) {
                    const pos = sf.getLineAndCharacterOfPosition(el.getStart(sf));
                    routes.push({ path: p, componentClass: comp, filePath, lineNumber: pos.line + 1 });
                }
            }
        }
    }

    ts.forEachChild(sf, function walk(node: any) {
        // React function/const components
        const compName = componentNameFromNode(node);
        if (compName && /^[A-Z]/.test(compName)) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const bucket: TsScreen = {
                componentName: compName, filePath, lineNumber: pos.line + 1, kind: 'react',
                fields: [], buttons: [],
            };
            walkJsx(node, bucket);
            if (bucket.fields.length > 0 || bucket.buttons.length > 0) screens.push(bucket);
        }
        // Angular component
        const ang = angularComponent(node);
        if (ang) {
            // Parse the inline template using the same JSX walker after crude
            // conversion of `[formControlName]="foo"` → `formControlName="foo"`.
            const tplForRegex = ang.template.replace(/\[([a-zA-Z][\w-]*)\]="([^"]+)"/g, '$1="$2"');
            const bucket: TsScreen = {
                componentName: ang.componentName, filePath, lineNumber: ang.line, kind: 'angular',
                fields: [], buttons: [],
            };
            // Simple regex extraction for the inline template.
            const inputRe = /<(input|select|textarea)\b([^>]*)\/?>(?:<\/\1>)?/gi;
            let im: RegExpExecArray | null;
            while ((im = inputRe.exec(tplForRegex)) !== null) {
                const a = parseAttrsRegex(im[2]);
                bucket.fields.push({
                    id: a.id ?? null,
                    name: a.name ?? null,
                    testId: a['data-testid'] ?? null,
                    tag: im[1].toLowerCase(),
                    type: a.type ?? null,
                    formControlName: a.formControlName ?? null,
                    placeholder: a.placeholder ?? null,
                    lineNumber: ang.line,
                });
            }
            const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
            let bm: RegExpExecArray | null;
            while ((bm = btnRe.exec(tplForRegex)) !== null) {
                const a = parseAttrsRegex(bm[1]);
                bucket.buttons.push({
                    id: a.id ?? null,
                    testId: a['data-testid'] ?? null,
                    text: bm[2].replace(/<[^>]+>/g, '').trim(),
                    lineNumber: ang.line,
                });
            }
            if (bucket.fields.length > 0 || bucket.buttons.length > 0) screens.push(bucket);
        }
        // Angular routes.
        extractAngularRoutes(node);
        ts.forEachChild(node, walk);
    });

    return { filePath, screens, routes, warnings };
}

function parseAttrsRegex(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([a-zA-Z_:][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag)) !== null) out[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    return out;
}
