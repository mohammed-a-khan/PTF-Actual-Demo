import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

interface Finding {
    file: string;
    line: number;
    kind: string;
    severity: 'error' | 'warn' | 'info';
    subject: string;
    message: string;
    hint: string;
}

const RULES: Array<{
    kind: string;
    severity: 'error' | 'warn' | 'info';
    filePathRegex?: RegExp;
    re: RegExp;
    message: string;
    hint: string;
    subject: (m: RegExpExecArray) => string;
}> = [
    { kind: 'raw-playwright', severity: 'error', re: /\bpage\.(goto|locator|\$\$?|on\(['"]dialog|evaluate)\s*\(/, message: 'Raw Playwright API in generated code (banned)', hint: 'Use CS framework wrapper (CSBasePage.navigate / @CSGetElement / this.acceptNextDialog / page-object method).', subject: (m) => `page.${m[1]}` },
    { kind: 'xpath-in-steps', severity: 'error', filePathRegex: /[\\/]steps[\\/]/, re: /['"]\/\/[a-zA-Z*@]/, message: 'XPath literal in step file (banned — locators belong on page-objects)', hint: 'Move the xpath to a @CSGetElement field on the appropriate page-object.', subject: () => 'xpath literal' },
    { kind: 'page-access-in-steps', severity: 'error', filePathRegex: /[\\/]steps[\\/]/, re: /\bthis\.[a-zA-Z0-9_]+Page\.page\b/, message: '.page accessed from step file (page is protected on CSBasePage)', hint: 'Call a page-object method that internally uses this.page. Add the method to the page class if it does not exist.', subject: () => '.page in step' },
    { kind: 'factory-in-steps', severity: 'error', filePathRegex: /[\\/]steps[\\/]/, re: /CSElementFactory\./, message: 'CSElementFactory in step file (belongs on page-object)', hint: 'Create a method on the page-object that uses CSElementFactory internally; call it from the step.', subject: () => 'CSElementFactory in step' },
    { kind: 'reporter-getinstance', severity: 'error', re: /CSReporter\.getInstance\s*\(\s*\)/, message: 'CSReporter is STATIC — no getInstance()', hint: 'Use CSReporter.info() / CSReporter.pass() / CSReporter.fail() directly.', subject: () => 'CSReporter.getInstance()' },
    { kind: 'assert-no-getinstance', severity: 'error', re: /\bCSAssert\.(assertTrue|assertFalse|assertEqual|assertContains|assertVisible)\b/, message: 'CSAssert requires getInstance() — you called a method as if static', hint: 'Use CSAssert.getInstance().assertX(...).', subject: (m) => `CSAssert.${m[1]}` },
    { kind: 'csdb-wrong-import', severity: 'error', re: /from ['"]@mdakhan\.mak\/cs-playwright-test-framework\/database['"]/, message: 'CSDBUtils moved to /database-utils (lightweight)', hint: 'Import from @mdakhan.mak/cs-playwright-test-framework/database-utils.', subject: () => 'CSDBUtils import' },
    { kind: 'barrel-import', severity: 'warn', re: /from ['"]@mdakhan\.mak\/cs-playwright-test-framework['"]/, message: 'Barrel import loads the whole framework — use module-specific import', hint: 'Import from /core, /element, /bdd, /reporter, /assertions, /utilities, /database-utils, /api as needed.', subject: () => 'barrel import' },
    { kind: 'inline-comment', severity: 'warn', filePathRegex: /[\\/](pages|steps|features)[\\/]/, re: /^\s*\/\*\*/, message: 'JSDoc / block comment in generated code (per project convention: no comments)', hint: 'Remove the comment. Names document intent.', subject: () => 'block comment' },
    { kind: 'this-url-constructor', severity: 'error', re: /constructor\s*\([^)]*\)\s*{\s*(super\s*\(\s*\)\s*;\s*)?this\.url\s*=/, message: 'this.url = ... in constructor does NOT stick (framework injection bypasses it) → navigate() falls back to BASE_URL', hint: 'Override navigate(): `public async navigate(): Promise<void> { await super.navigate("...full url..."); }`', subject: () => 'constructor this.url' },
    { kind: 'hardcoded-url-in-navigate', severity: 'error', filePathRegex: /[\\/]pages[\\/]/, re: /super\.navigate\s*\(\s*["'`]https?:\/\/[^"'`)]+["'`]\s*\)/, message: 'Literal URL in super.navigate() — binds the test to one environment', hint: 'Resolve from config: `const base = this.config.get(\'BASE_URL\'); const path = this.config.get(\'<SCREEN>_PATH\', \'/default/path\'); await super.navigate(new URL(path, base).toString());`. Set BASE_URL per env in config/<slug>/environments/<env>.env.', subject: () => 'literal URL in navigate()' },
    { kind: 'hardcoded-url-in-page', severity: 'error', filePathRegex: /[\\/]pages[\\/]/, re: /=\s*["'`]https?:\/\/[^"'`]+["'`]/, message: 'Hardcoded URL string assigned in page-object (should be config-resolved)', hint: 'Read URL segments from this.config.get(\'KEY\'). Never assign literal URLs to page-object fields or use them in navigate()/goto()/waitForURL() calls.', subject: () => 'hardcoded URL literal' },
    { kind: 'factory-in-page-object', severity: 'warn', filePathRegex: /[\\/]pages[\\/]/, re: /CSElementFactory\.createByXPath\s*\(/, message: 'Page-object uses CSElementFactory.createByXPath — framework strongly prefers @CSGetElement decorator per field for self-healing and idiomatic use', hint: 'Replace each `this.foo = CSElementFactory.createByXPath(xpath, desc)` with a decorated class field: `@CSGetElement({ xpath, description, waitForVisible: true, selfHeal: true, alternativeLocators: [\'css:...\', \'text:...\'] }) public foo!: CSWebElement;`. Leave `initializeElements()` with only `CSReporter.debug(...)`. Exception: dynamic/parameterized xpath built at call time from a method arg (e.g. by-error-message lookups) — that legitimate use should be extracted to a helper method that names the pattern.', subject: () => 'CSElementFactory in page-object' },
    // Common framework-import mistakes — the module names have irregular pluralization
    { kind: 'wrong-import-reporter', severity: 'error', re: /from\s+['"]@mdakhan\.mak\/cs-playwright-test-framework\/reporter['"]/, message: 'Wrong import path: /reporter — module is /reporting (pluralized/gerund form)', hint: 'Change `from \'@mdakhan.mak/cs-playwright-test-framework/reporter\'` to `from \'@mdakhan.mak/cs-playwright-test-framework/reporting\'`.', subject: () => '/reporter → /reporting' },
    { kind: 'wrong-import-assertion', severity: 'error', re: /from\s+['"]@mdakhan\.mak\/cs-playwright-test-framework\/assertion['"]/, message: 'Wrong import path: /assertion — module is /assertions (plural)', hint: 'Change `from \'@mdakhan.mak/cs-playwright-test-framework/assertion\'` to `from \'@mdakhan.mak/cs-playwright-test-framework/assertions\'`.', subject: () => '/assertion → /assertions' },
    { kind: 'wrong-import-utility', severity: 'error', re: /from\s+['"]@mdakhan\.mak\/cs-playwright-test-framework\/utility['"]/, message: 'Wrong import path: /utility — module is /utilities (plural)', hint: 'Change `from \'@mdakhan.mak/cs-playwright-test-framework/utility\'` to `from \'@mdakhan.mak/cs-playwright-test-framework/utilities\'`.', subject: () => '/utility → /utilities' },
    // Fake assertion pattern — step body reads a value and calls CSReporter.pass()/info() unconditionally
    // instead of actually asserting. Detects: an @CSBDDStepDef step that contains CSReporter.pass/info
    // and has NO throw / CSAssert / assertX / expect anywhere in the same line-block. Line-level heuristic
    // catches the most common single-line fake asserts Copilot has been emitting.
    { kind: 'fake-reporter-pass-assertion', severity: 'error', filePathRegex: /[\\/]steps[\\/].*\.steps\.ts$/, re: /^\s*(?!.*(?:\bthrow\b|CSAssert|\.assertT|\.assertF|\.assertE|\.assertC|\.assertV|expect\()).*CSReporter\.(pass|info)\s*\(/, message: 'Step body calls CSReporter.pass()/info() with no accompanying assert or throw — this is a fake assertion that always passes regardless of app state', hint: 'Replace with `await CSAssert.getInstance().assertContains(actual, expected, msg)` (or assertTrue/assertEqual/etc.) — or plain `if (actual !== expected) throw new Error(...)`. CSReporter.pass() only LOGS success; it does not perform any check. Verify steps whose only work is reading a value and logging it are worthless.', subject: () => 'CSReporter.pass() without assertion' },
];

registerPrimitive({
    name: 'cs_qa_code_analyze',
    description: 'Static analysis for generated / hand-written test code. Runs 10+ CS-framework compliance rules: no raw Playwright, no XPath in steps, no .page access in steps, no CSElementFactory in steps, CSReporter static / CSAssert getInstance, correct imports, no barrel imports, no block comments in generated code, correct navigate() pattern, and more. Also detects duplicate @CSBDDStepDef descriptions or method names across the project.',
    inputSchema: z.object({
        root: z.string().default('test'),
        globs: z.array(z.string()).default(['**/*.ts', '**/*.tsx', '**/*.feature']),
        checkDuplicates: z.boolean().default(true),
        maxFindings: z.number().int().positive().max(500).default(200),
    }),
    outputSchema: z.object({
        filesScanned: z.number(),
        findings: z.array(z.object({
            file: z.string(), line: z.number(), kind: z.string(),
            severity: z.string(), subject: z.string(),
            message: z.string(), hint: z.string(),
        })),
        duplicateStepDefs: z.array(z.object({ descriptionOrMethod: z.string(), files: z.array(z.string()) })),
        summary: z.object({ errors: z.number(), warnings: z.number(), info: z.number() }),
    }),
    run: async (ctx, input) => {
        const findings: Finding[] = [];
        const rootAbs = path.resolve(ctx.workspaceRoot, input.root);
        const files = walkFiles(rootAbs, ctx.workspaceRoot, input.globs);

        for (const rel of files) {
            const abs = path.resolve(ctx.workspaceRoot, rel);
            let content: string;
            try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                for (const rule of RULES) {
                    if (rule.filePathRegex && !rule.filePathRegex.test(rel)) continue;
                    const m = rule.re.exec(lines[i]);
                    if (!m) continue;
                    findings.push({
                        file: rel, line: i + 1, kind: rule.kind, severity: rule.severity,
                        subject: rule.subject(m), message: rule.message, hint: rule.hint,
                    });
                    if (findings.length >= input.maxFindings) break;
                }
                if (findings.length >= input.maxFindings) break;
            }
            if (findings.length >= input.maxFindings) break;
        }

        const duplicateStepDefs: Array<{ descriptionOrMethod: string; files: string[] }> = [];
        if (input.checkDuplicates) {
            const descMap = new Map<string, Set<string>>();
            const methodMap = new Map<string, Set<string>>();
            for (const rel of files) {
                if (!/\.steps\.ts$/.test(rel)) continue;
                const abs = path.resolve(ctx.workspaceRoot, rel);
                let content: string;
                try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
                const descRe = /@CSBDDStepDef\(\s*['"`]([^'"`]+)['"`]/g;
                let m: RegExpExecArray | null;
                while ((m = descRe.exec(content))) {
                    const key = m[1];
                    if (!descMap.has(key)) descMap.set(key, new Set());
                    descMap.get(key)!.add(rel);
                }
                const methodRe = /async\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
                while ((m = methodRe.exec(content))) {
                    const key = m[1];
                    if (['constructor'].includes(key)) continue;
                    if (!methodMap.has(key)) methodMap.set(key, new Set());
                    methodMap.get(key)!.add(rel);
                }
            }
            for (const [desc, filesSet] of descMap.entries()) if (filesSet.size > 1) duplicateStepDefs.push({ descriptionOrMethod: `desc: ${desc}`, files: Array.from(filesSet) });
            for (const [method, filesSet] of methodMap.entries()) if (filesSet.size > 1) duplicateStepDefs.push({ descriptionOrMethod: `method: ${method}`, files: Array.from(filesSet) });
        }

        const summary = {
            errors: findings.filter((f) => f.severity === 'error').length,
            warnings: findings.filter((f) => f.severity === 'warn').length,
            info: findings.filter((f) => f.severity === 'info').length,
        };
        return { filesScanned: files.length, findings, duplicateStepDefs, summary };
    },
});

function walkFiles(rootAbs: string, workspaceRoot: string, globs: string[]): string[] {
    const out: string[] = [];
    const stack = [rootAbs];
    while (stack.length > 0) {
        const d = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            if (ent.name === 'node_modules' || ent.name.startsWith('.git') || ent.name === 'dist') continue;
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) stack.push(p);
            else {
                const rel = path.relative(workspaceRoot, p).replace(/\\/g, '/');
                if (globs.some((g) => matchGlob(rel, g))) out.push(rel);
            }
        }
    }
    return out;
}

function matchGlob(name: string, glob: string): boolean {
    const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$');
    return re.test(name);
}
