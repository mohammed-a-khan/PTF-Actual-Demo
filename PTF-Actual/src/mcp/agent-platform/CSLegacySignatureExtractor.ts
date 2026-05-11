/**
 * Deterministic legacy signature extractor.
 *
 * Parses Java/C# legacy test source to produce a "signature" — the count and
 * shape of leaf actions per @Test method, @FindBy fields per page class, and
 * leaf actions per helper method. The signature becomes the source of truth
 * downstream gates compare LLM output against:
 *
 *   semantic-verify(generated) := generated_actions ≥ threshold × legacy_actions
 *
 * This breaks the iteration loop where the LLM produces plausible-looking
 * but thin output that passes form-level gates. With the signature, the
 * record_analysis / record_translation gates have an objective floor: if
 * legacy @Test has 18 leaf actions, the analysis must record ≥ 13 (70%).
 *
 * Approach is regex-based, not full AST. Selenium tests follow a narrow set
 * of patterns (chained calls on page-object methods, @FindBy declarations,
 * helper-method invocations) that pattern-match cleanly. Undercount is safe
 * (lenient toward LLM); overcount risks false rejection so the regexes are
 * conservative.
 *
 * Aligned with: AlphaTrans (neuro-symbolic compositional translation),
 * UnitTenX (multi-agent legacy test generation with formal floor),
 * MatchFixAgent (control/data-flow signature comparison).
 *
 * @module agent-platform/CSLegacySignatureExtractor
 */

import * as fs from 'fs';
import * as path from 'path';

export interface LeafAction {
    /** Action kind — coarse-grained category. */
    kind: 'click' | 'fill' | 'select' | 'read' | 'assert' | 'navigate' | 'wait' | 'helper-invocation' | 'unknown';
    /** Source line number (1-indexed). */
    line: number;
    /** Raw source snippet, trimmed, max 200 chars. */
    snippet: string;
    /** Target identifier if recoverable (e.g. method/element name being acted on). */
    target?: string;
    /** Helper class name + method when kind === 'helper-invocation'. */
    helperClass?: string;
    helperMethod?: string;
}

export interface TestSignature {
    /** Test id from @MetaData testCaseId, or null if absent. */
    testCaseId: string | null;
    /** Java method name. */
    methodName: string;
    /** First line of the method body. */
    startLine: number;
    /** Last line (closing brace). */
    endLine: number;
    /** Ordered leaf actions inside the method body. */
    actions: LeafAction[];
    /** Class names referenced as page-object fields used inside the method. */
    pageClassesUsed: string[];
    /** Helper invocations discovered inside this method. */
    helperInvocations: Array<{ helperClass: string; helperMethod: string; line: number }>;
}

export interface PageFieldSignature {
    /** Field name as declared. */
    name: string;
    /** Locator strategy: id / xpath / css / name / linkText / partialLinkText / tagName / className. */
    strategy: string;
    /** Locator value. */
    value: string;
    /** Field type (WebElement / List<WebElement> / CSWebElement etc.) — informational. */
    typeName: string;
    /** Source line. */
    line: number;
}

export interface PageSignature {
    /** Class name. */
    className: string;
    /** Absolute path to the source file. */
    filePath: string;
    /** Declared fields (@FindBy + raw By.* + framework-specific decorators). */
    fields: PageFieldSignature[];
    /** Public methods declared on the page object (helpers/navigators). */
    methods: Array<{ name: string; line: number }>;
}

export interface HelperSignature {
    /** Helper class name (e.g. CTSGSupportMethods). */
    className: string;
    /** Helper method name (e.g. TS_4958). */
    methodName: string;
    /** Absolute path to the source file. */
    filePath: string;
    /** Method body start/end lines. */
    startLine: number;
    endLine: number;
    /** Leaf actions performed inside the helper method body. */
    actions: LeafAction[];
}

export interface FullSignature {
    /** Path of the entry test file. */
    entryFile: string;
    /** Per-@Test signatures. */
    tests: TestSignature[];
    /** Page-class signatures keyed by class name. */
    pages: Record<string, PageSignature>;
    /** Helper-method signatures keyed by `ClassName.methodName`. */
    helpers: Record<string, HelperSignature>;
    /** Files that were attempted but not found (informational, not fatal). */
    unresolvedReferences: string[];
}

// ----------------------------------------------------------------------------
// Regex catalogue — kept conservative on purpose. Each pattern matches a
// clear "leaf action" that maps to one Gherkin step in the translation.
// ----------------------------------------------------------------------------

const ACTION_PATTERNS: Array<{ kind: LeafAction['kind']; re: RegExp; targetIdx?: number }> = [
    // Selenium WebElement actions
    { kind: 'click', re: /\.(click|doubleClick|rightClick|tap)\s*\(\s*\)/, },
    { kind: 'fill', re: /\.(sendKeys|fill|type|setValue|enterText|setText)\s*\(/, },
    { kind: 'select', re: /\.(selectByVisibleText|selectByValue|selectByIndex|selectFromDropdown|select)\s*\(/, },
    { kind: 'read', re: /\.(getText|getAttribute|getValue|getCssValue|getTagName)\s*\(/, },
    { kind: 'navigate', re: /\.(get|navigate|navigateTo|goTo|open|visit)\s*\(\s*["']https?:/, },
    { kind: 'wait', re: /\b(waitFor|waitUntil|sleep|Thread\.sleep|WebDriverWait|FluentWait|until\s*\()/, },
    // Assertion / verification verbs
    { kind: 'assert', re: /\b(assert\w+|verify\w+|expect\w+|should\w*|Assert\.|Assertions\.|softAssert\.|assertThat)\s*\(/, },
    // .isDisplayed/.isEnabled used as a boolean assertion (typical pattern is
    // assert<Foo>(elem.isDisplayed()) but we also count bare .isDisplayed() as
    // a check — it's clearly inspecting state).
    { kind: 'assert', re: /\.(isDisplayed|isEnabled|isSelected|isPresent|exists|isVisible)\s*\(\s*\)/, },
];

// Helper invocation: ClassName.methodName(...) where ClassName matches a
// known helper suffix. This catches CTSGSupportMethods.TS_4958, FooHelper.bar,
// etc.
const HELPER_INVOCATION_RE = /\b([A-Z][A-Za-z0-9]*(?:SupportMethod|SupportMethods|Helper|Helpers|Util|Utils|Utility|Service|Factory|Manager|Provider))\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// Selenium @FindBy / @FindBys / @FindAll annotation extractor.
// Captures the strategy + value across the typical single-attribute form:
//   @FindBy(id = "foo")
//   @FindBy(xpath = "//*[@id='x']")
//   @FindBy(how = How.XPATH, using = "//div")
// And declarations like:
//   @FindBy(...)
//   public WebElement loginButton;
// CRITICAL: cannot use `[^)]+` for the inner — XPath values frequently contain
// `text()` etc. which would cause the regex to truncate at the wrong paren.
// We walk the source manually with a depth counter (extractFindByInner).
const FINDBY_ANNOTATION_RE = /@FindBy(?:s|All)?\s*\(/;
const FINDBY_HOW_USING_RE = /how\s*=\s*How\s*\.\s*(\w+)[^,)]*,\s*using\s*=\s*"([^"]*)"/i;
const FINDBY_SHORT_RE = /(id|name|css|xpath|linkText|partialLinkText|tagName|className)\s*=\s*"([^"]*)"/;

// Raw `By.xpath("...")` / `By.id(...)` declarations (no annotation).
const RAW_BY_RE = /\bBy\s*\.\s*(xpath|cssSelector|css|id|name|linkText|partialLinkText|tagName|className)\s*\(\s*"([^"]*)"/;

// @Test method extractor.
const TEST_ANNOTATION_RE = /^\s*@(?:Test|TestMethod|Fact|org\.testng\.annotations\.Test)\b/;
const METADATA_RE = /@MetaData\s*\(\s*"?\{([^}]*)\}"?\s*\)/;
const METHOD_DECL_RE = /^\s*(?:public|private|protected)?\s+(?:static\s+)?(?:async\s+)?(?:void|[\w<>,?\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:throws[^{]+)?\s*\{?\s*$/;

// Page-object field declaration:
//   public WebElement loginButton;
//   private List<WebElement> rows;
//   public CSWebElement saveButton;
const PAGE_FIELD_DECL_RE = /^\s*(?:public|private|protected)\s+(?:static\s+)?(WebElement|List<WebElement>|CSWebElement|CBWebElement|MobileElement|[A-Z][A-Za-z0-9_]*Element)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/;

// Public method on a page-object class:
//   public void clickSave() { ... }
//   public CSWebElement getButtonNewUser() { ... }
const PUBLIC_METHOD_RE = /^\s*public\s+(?:static\s+)?(?:async\s+)?(?:[\w<>,?\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export class CSLegacySignatureExtractor {
    /**
     * Build a full signature for an entry test file plus every page/helper it
     * references (resolved against an inventory).
     */
    static extract(
        entryFile: string,
        inventory: {
            pages: Array<{ className: string; relativePath?: string; path?: string }>;
            helpers: Array<{ className?: string; relativePath?: string; path?: string }>;
            workspaceRoot?: string;
        },
    ): FullSignature {
        const unresolvedReferences: string[] = [];
        const sig: FullSignature = {
            entryFile,
            tests: [],
            pages: {},
            helpers: {},
            unresolvedReferences,
        };

        if (!fs.existsSync(entryFile)) {
            unresolvedReferences.push(entryFile);
            return sig;
        }

        const entrySrc = fs.readFileSync(entryFile, 'utf-8');
        sig.tests = CSLegacySignatureExtractor.extractTestSignatures(entrySrc);

        // Collect referenced page classes + helper invocations across all tests.
        const pageClassesUsed = new Set<string>();
        const helperInvocations: Array<{ helperClass: string; helperMethod: string }> = [];
        for (const t of sig.tests) {
            for (const c of t.pageClassesUsed) pageClassesUsed.add(c);
            for (const h of t.helperInvocations) {
                helperInvocations.push({ helperClass: h.helperClass, helperMethod: h.helperMethod });
            }
        }
        // Also walk the file for `<Class> <var> =` and `var.<method>` patterns
        // where <Class> is a page-object name from the inventory.
        for (const p of inventory.pages) {
            const re = new RegExp(`\\b${escapeRegex(p.className)}\\b`);
            if (re.test(entrySrc)) pageClassesUsed.add(p.className);
        }

        // Resolve + parse each page class.
        for (const className of pageClassesUsed) {
            const filePath = resolveClassPath(className, inventory);
            if (!filePath) {
                unresolvedReferences.push(className);
                continue;
            }
            sig.pages[className] = CSLegacySignatureExtractor.extractPageSignature(filePath);
        }

        // Resolve + parse each helper invocation's class file, then extract
        // the specific method body's actions. Also walk the helper file
        // for transitive page-class references — page objects only used by
        // helpers (e.g. LoginPage used inside OrdersHelper.TS_5001) would
        // otherwise never appear in the analysis.
        const seenHelperKeys = new Set<string>();
        const helperPagesToInclude = new Set<string>();
        for (const h of helperInvocations) {
            const key = `${h.helperClass}.${h.helperMethod}`;
            if (seenHelperKeys.has(key)) continue;
            seenHelperKeys.add(key);
            const filePath = resolveClassPath(h.helperClass, inventory);
            if (!filePath) {
                unresolvedReferences.push(`${h.helperClass}.${h.helperMethod}`);
                continue;
            }
            const helperSig = CSLegacySignatureExtractor.extractHelperSignature(
                filePath, h.helperClass, h.helperMethod,
            );
            if (helperSig) sig.helpers[key] = helperSig;
            // Scan the helper file source for inventory page-class names.
            try {
                const helperSrc = fs.readFileSync(filePath, 'utf-8');
                for (const p of inventory.pages) {
                    if (!p.className) continue;
                    if (pageClassesUsed.has(p.className)) continue;
                    const re = new RegExp(`\\b${escapeRegex(p.className)}\\b`);
                    if (re.test(helperSrc)) {
                        helperPagesToInclude.add(p.className);
                    }
                }
            } catch { /* ignore — helper unreadable */ }
        }
        for (const className of helperPagesToInclude) {
            const filePath = resolveClassPath(className, inventory);
            if (!filePath) {
                unresolvedReferences.push(className);
                continue;
            }
            sig.pages[className] = CSLegacySignatureExtractor.extractPageSignature(filePath);
        }

        return sig;
    }

    /**
     * Parse a Java source string and return a TestSignature per @Test method.
     */
    static extractTestSignatures(src: string): TestSignature[] {
        const lines = src.split(/\r?\n/);
        const results: TestSignature[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (!TEST_ANNOTATION_RE.test(lines[i])) continue;
            // Look backward up to 6 lines for @MetaData to capture testCaseId.
            let testCaseId: string | null = null;
            for (let back = Math.max(0, i - 6); back < i; back++) {
                const m = lines[back].match(METADATA_RE);
                if (m) {
                    const idMatch = m[1].match(/'testCaseId'\s*:\s*'([^']+)'/) ??
                                    m[1].match(/"testCaseId"\s*:\s*"([^"]+)"/);
                    if (idMatch) testCaseId = idMatch[1];
                }
            }
            // Skip blank/annotation lines forward to find the method declaration.
            let j = i + 1;
            while (j < lines.length && (
                lines[j].trim().startsWith('@') || lines[j].trim() === ''
            )) j++;
            const declMatch = lines[j]?.match(METHOD_DECL_RE);
            if (!declMatch) continue;
            const methodName = declMatch[1];
            // Find the method body's opening brace (may be on same line or next).
            let braceLine = j;
            if (!lines[braceLine].includes('{')) {
                while (braceLine < lines.length && !lines[braceLine].includes('{')) braceLine++;
                if (braceLine >= lines.length) continue;
            }
            const startLine = braceLine + 1; // 1-indexed
            // Walk forward, brace counting, to find the matching close.
            let depth = 0;
            let endLine = startLine;
            const bodyLines: Array<{ text: string; line: number }> = [];
            const startedAt = braceLine;
            for (let k = braceLine; k < lines.length; k++) {
                for (const ch of lines[k]) {
                    if (ch === '{') depth++;
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) { endLine = k + 1; }
                    }
                }
                if (k > startedAt && depth === 0) break;
                if (k > startedAt) bodyLines.push({ text: lines[k], line: k + 1 });
            }
            const { actions, pageClassesUsed, helperInvocations } =
                CSLegacySignatureExtractor.classifyLines(bodyLines);
            results.push({
                testCaseId,
                methodName,
                startLine,
                endLine,
                actions,
                pageClassesUsed,
                helperInvocations,
            });
            // Skip ahead past this method.
            i = endLine;
        }
        return results;
    }

    /**
     * Walk a list of body lines and classify each into a LeafAction (or none).
     */
    private static classifyLines(
        bodyLines: Array<{ text: string; line: number }>,
    ): {
        actions: LeafAction[];
        pageClassesUsed: string[];
        helperInvocations: Array<{ helperClass: string; helperMethod: string; line: number }>;
    } {
        const actions: LeafAction[] = [];
        const pageClassesUsed = new Set<string>();
        const helperInvocations: Array<{ helperClass: string; helperMethod: string; line: number }> = [];

        for (const { text, line } of bodyLines) {
            const trimmed = text.trim();
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

            // Helper invocations: collect every match on the line.
            HELPER_INVOCATION_RE.lastIndex = 0;
            let helperHit = false;
            let m: RegExpExecArray | null;
            while ((m = HELPER_INVOCATION_RE.exec(text)) !== null) {
                helperHit = true;
                helperInvocations.push({
                    helperClass: m[1],
                    helperMethod: m[2],
                    line,
                });
                actions.push({
                    kind: 'helper-invocation',
                    line,
                    snippet: trimmed.slice(0, 200),
                    helperClass: m[1],
                    helperMethod: m[2],
                });
            }
            if (helperHit) continue; // Don't double-count a helper invocation as a leaf action.

            // Class-name references — pull anything that looks like a typed
            // declaration (`SomePage page = ...`) or a call site (`somePage.foo()`).
            const typeDecl = trimmed.match(/\b([A-Z][A-Za-z0-9]+Page|[A-Z][A-Za-z0-9]+Element|[A-Z][A-Za-z0-9]+Component)\b/);
            if (typeDecl) pageClassesUsed.add(typeDecl[1]);

            // Action verbs.
            for (const pat of ACTION_PATTERNS) {
                if (pat.re.test(text)) {
                    actions.push({
                        kind: pat.kind,
                        line,
                        snippet: trimmed.slice(0, 200),
                    });
                    break;
                }
            }
        }

        return {
            actions,
            pageClassesUsed: Array.from(pageClassesUsed),
            helperInvocations,
        };
    }

    /**
     * Parse a page-object Java class and return its field/method inventory.
     */
    static extractPageSignature(filePath: string): PageSignature {
        const src = fs.readFileSync(filePath, 'utf-8');
        const lines = src.split(/\r?\n/);
        const classNameMatch = src.match(/\bclass\s+([A-Z][A-Za-z0-9_]*)\b/);
        const className = classNameMatch?.[1] ?? path.basename(filePath, path.extname(filePath));

        const fields: PageFieldSignature[] = [];
        const methods: Array<{ name: string; line: number }> = [];

        // Pass 1: @FindBy + field-decl pairs. The annotation is on the line
        // BEFORE the field declaration. Walk both lines together.
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const annotMatch = line.match(FINDBY_ANNOTATION_RE);
            if (annotMatch) {
                // Extract the inner content with balanced-paren walking — the
                // simple `[^)]+` approach breaks on values like `text()`.
                const annotStart = (annotMatch.index ?? 0) + annotMatch[0].length;
                const inner = extractFindByInner(src, lines, i, annotStart);
                let strategy = '';
                let value = '';
                if (inner) {
                    const howUsing = inner.match(FINDBY_HOW_USING_RE);
                    if (howUsing) {
                        strategy = howUsing[1].toLowerCase();
                        value = howUsing[2];
                    } else {
                        const short = inner.match(FINDBY_SHORT_RE);
                        if (short) {
                            strategy = short[1].toLowerCase();
                            value = short[2];
                        }
                    }
                }
                // Look forward up to 4 lines for the field declaration that follows.
                for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
                    const decl = lines[j].match(PAGE_FIELD_DECL_RE);
                    if (decl) {
                        fields.push({
                            name: decl[2],
                            strategy: strategy || 'unknown',
                            value: value || '',
                            typeName: decl[1],
                            line: j + 1,
                        });
                        break;
                    }
                    // Stop if we hit another annotation or method.
                    if (/^\s*@/.test(lines[j]) || /\)\s*\{/.test(lines[j])) break;
                }
            }

            // Pass 2: raw By.* declarations (no annotation).
            const raw = line.match(RAW_BY_RE);
            if (raw && !annotMatch) {
                // Look for `final By <name> = By.xxx("...");` or similar.
                const namedBy = line.match(/\b(?:public|private|protected|final)?\s*(?:static\s+)?(?:final\s+)?By\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*By\s*\.\s*\w+\(/);
                if (namedBy) {
                    fields.push({
                        name: namedBy[1],
                        strategy: raw[1].toLowerCase(),
                        value: raw[2],
                        typeName: 'By',
                        line: i + 1,
                    });
                }
            }

            // Methods.
            const methodMatch = line.match(PUBLIC_METHOD_RE);
            if (methodMatch) {
                const name = methodMatch[1];
                // Skip constructors (name === className).
                if (name !== className) {
                    methods.push({ name, line: i + 1 });
                }
            }
        }

        return { className, filePath, fields, methods };
    }

    /**
     * Extract the body of a single helper method from a Java class file.
     */
    static extractHelperSignature(
        filePath: string,
        className: string,
        methodName: string,
    ): HelperSignature | null {
        const src = fs.readFileSync(filePath, 'utf-8');
        const lines = src.split(/\r?\n/);
        // Find a method declaration matching the methodName.
        const methodRe = new RegExp(
            `^\\s*(?:public|private|protected)\\s+(?:static\\s+)?(?:async\\s+)?` +
            `(?:[\\w<>,?\\s]+?)\\s+${escapeRegex(methodName)}\\s*\\(`,
        );
        let declLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (methodRe.test(lines[i])) {
                declLine = i;
                break;
            }
        }
        if (declLine === -1) return null;

        // Walk forward to opening brace.
        let braceLine = declLine;
        while (braceLine < lines.length && !lines[braceLine].includes('{')) braceLine++;
        if (braceLine >= lines.length) return null;
        const startLine = braceLine + 1;

        // Brace-count to find the close.
        let depth = 0;
        let endLine = startLine;
        const bodyLines: Array<{ text: string; line: number }> = [];
        const startedAt = braceLine;
        for (let k = braceLine; k < lines.length; k++) {
            for (const ch of lines[k]) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) endLine = k + 1;
                }
            }
            if (k > startedAt && depth === 0) break;
            if (k > startedAt) bodyLines.push({ text: lines[k], line: k + 1 });
        }
        const { actions } = CSLegacySignatureExtractor.classifyLines(bodyLines);
        return {
            className,
            methodName,
            filePath,
            startLine,
            endLine,
            actions,
        };
    }

    /**
     * Compute the "expected" action count for a single @Test, including the
     * transitive expansion of any helper invocations. Used by record_analysis
     * to set the floor for generated scenario step count.
     */
    static expectedActionCount(test: TestSignature, helpers: Record<string, HelperSignature>): number {
        let count = 0;
        for (const a of test.actions) {
            if (a.kind === 'helper-invocation' && a.helperClass && a.helperMethod) {
                const key = `${a.helperClass}.${a.helperMethod}`;
                const helper = helpers[key];
                if (helper) {
                    // Recursively count helper actions, but don't recurse into
                    // sub-helpers (one-level expansion is the framework contract).
                    count += helper.actions.filter((x) => x.kind !== 'helper-invocation').length;
                } else {
                    // Helper unresolved — count the invocation itself as 1
                    // action so the floor isn't unreasonably high.
                    count += 1;
                }
            } else {
                count += 1;
            }
        }
        return count;
    }
}

// ----------------------------------------------------------------------------
// Helpers (module-private)
// ----------------------------------------------------------------------------

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk the source after `@FindBy(` with a depth-aware counter to find the
 * matching close-paren. Returns the captured inner content (without
 * outer parens). Tolerates open/close parens inside double-quoted strings.
 */
function extractFindByInner(
    src: string,
    lines: string[],
    startLine: number,
    startColInLine: number,
): string | null {
    // Build the absolute offset from line/col.
    let offset = 0;
    for (let i = 0; i < startLine; i++) offset += lines[i].length + 1;
    offset += startColInLine;
    let depth = 1;
    let inString = false;
    let stringChar = '';
    let escape = false;
    const captured: string[] = [];
    for (let i = offset; i < src.length; i++) {
        const ch = src[i];
        if (escape) { captured.push(ch); escape = false; continue; }
        if (inString) {
            if (ch === '\\') { captured.push(ch); escape = true; continue; }
            if (ch === stringChar) { inString = false; captured.push(ch); continue; }
            captured.push(ch);
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = true; stringChar = ch; captured.push(ch); continue;
        }
        if (ch === '(') { depth++; captured.push(ch); continue; }
        if (ch === ')') {
            depth--;
            if (depth === 0) return captured.join('');
            captured.push(ch);
            continue;
        }
        captured.push(ch);
    }
    return null;
}

function resolveClassPath(
    className: string,
    inventory: {
        pages: Array<{ className: string; relativePath?: string; path?: string }>;
        helpers: Array<{ className?: string; relativePath?: string; path?: string }>;
        workspaceRoot?: string;
    },
): string | null {
    // Try inventory first.
    for (const entry of [...inventory.pages, ...inventory.helpers]) {
        if (entry.className === className) {
            const p = entry.path ?? entry.relativePath;
            if (!p) continue;
            if (path.isAbsolute(p) && fs.existsSync(p)) return p;
            if (inventory.workspaceRoot) {
                const abs = path.resolve(inventory.workspaceRoot, p);
                if (fs.existsSync(abs)) return abs;
            }
            // Fall back to relative path as-is.
            if (fs.existsSync(p)) return p;
        }
    }
    // Search workspaceRoot for ClassName.java.
    if (inventory.workspaceRoot && fs.existsSync(inventory.workspaceRoot)) {
        const found = findFileBfs(inventory.workspaceRoot, `${className}.java`, 8);
        if (found) return found;
    }
    return null;
}

function findFileBfs(root: string, name: string, maxDepth: number): string | null {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
        const { dir, depth } = queue.shift()!;
        if (depth > maxDepth) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isFile() && e.name === name) return p;
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist') {
                queue.push({ dir: p, depth: depth + 1 });
            }
        }
    }
    return null;
}
