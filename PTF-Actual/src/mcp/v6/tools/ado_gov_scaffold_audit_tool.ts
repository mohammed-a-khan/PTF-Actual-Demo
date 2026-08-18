/**
 * cs_qa_gov_scaffold_audit — Pre-flight check run before cs_qa_ui_scaffold
 * (or any generator) writes files into the workspace. Verifies:
 *
 *   - No existing files being clobbered without explicit overwrite=true
 *   - No hardcoded credentials/URLs in target output paths (checks siblings
 *     that would import the scaffold — page-objects, config .env, feature
 *     files) using the same secret patterns as cs_qa_gov_secret_scanner
 *   - Framework compliance in the target directory tree:
 *       * no raw page.locator / page.click / page.on('dialog') in generated
 *         page/step files
 *       * no CSElementFactory in step files
 *       * no xpath literals in step files
 *       * decorator naming rule — @CSPage(slug) must match the folder slug
 *         (uses inferSlug from workspace package.json name)
 *   - Optional: report any files under targetPaths that ALREADY match the
 *     "generated" file naming pattern but are not decorated properly
 *
 * Returns block/proceed verdict + reasons. Read-only — no elicitation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { scanTextForSecrets, SECRET_PATTERNS } from './_helpers/secret_patterns';

const InputSchema = z.object({
    targetPaths: z.array(z.string().min(1)).min(1).describe('Workspace-relative or absolute file paths the caller intends to write. May be existing or new.'),
    overwrite: z.boolean().default(false).describe('When true, existing target files are allowed to be clobbered.'),
    slug: z.string().min(1).optional().describe('Project slug used to validate @CSPage(slug) matches. When omitted, inferred from workspace package.json name.'),
    scanScope: z.enum(['targets-only', 'target-and-siblings']).default('target-and-siblings').describe('When target-and-siblings, ALSO scans immediate siblings for secrets/compliance so a to-be-generated file cannot land next to a leaking one.'),
});

const FindingSchema = z.object({
    kind: z.enum(['file-conflict', 'secret-leak', 'raw-playwright', 'xpath-in-steps', 'factory-in-steps', 'raw-dialog-handler', 'wrong-decorator-slug', 'sibling-secret']),
    severity: z.enum(['block', 'warn']),
    file: z.string(),
    line: z.number().optional(),
    detail: z.string(),
    hint: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verdict: z.enum(['proceed', 'block']),
    targetsScanned: z.number(),
    siblingsScanned: z.number(),
    findings: z.array(FindingSchema),
    slug: z.string(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

function inferSlugFromWorkspace(workspaceRoot: string): string {
    try {
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
            if (pkg.name) {
                const clean = pkg.name.replace(/^@[^/]+\//, '').toLowerCase();
                if (clean) return clean.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'app';
            }
        }
    } catch { /* fall through */ }
    return path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'app';
}

const RAW_PW_RE = /\bpage\.(goto|locator|\$\$?|evaluate)\s*\(/;
const RAW_DIALOG_RE = /\bpage\.on\s*\(\s*['"]dialog['"]/;
const XPATH_LITERAL_RE = /['"]\/\/[a-zA-Z*@]/;
const FACTORY_RE = /CSElementFactory\.(createByXPath|createByCss|createByText)/;
const CS_PAGE_DECORATOR_RE = /@CSPage\s*\(\s*['"]([a-z0-9-]+)['"]\s*\)/;
const HARDCODED_URL_ASSIGNMENT_RE = /=\s*["'`]https?:\/\/[^"'`]+["'`]/;

function toAbsolute(workspaceRoot: string, p: string): string {
    return path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
}

function siblingsOf(filePath: string): string[] {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) return [];
    try {
        return fs.readdirSync(dir)
            .map((e) => path.join(dir, e))
            .filter((p) => {
                try { return fs.statSync(p).isFile(); }
                catch { return false; }
            });
    } catch { return []; }
}

function isStepsFile(p: string): boolean {
    return /[\\/]steps[\\/].*\.steps?\.ts$/i.test(p) || /Steps\.ts$/i.test(p);
}
function isPageFile(p: string): boolean {
    return /[\\/]pages?[\\/].*Page\.ts$/i.test(p) || /Page\.ts$/i.test(p);
}

registerPrimitive({
    name: 'cs_qa_gov_scaffold_audit',
    description: 'Governance hook — run BEFORE cs_qa_ui_scaffold (or any generator) writes files. Verifies: no clobber without overwrite=true, no hardcoded credentials/URLs in target paths, framework compliance in target dir (no raw page.locator/click/on(dialog) in steps or pages; no CSElementFactory or xpath literals in steps), @CSPage decorator slug matches project slug. Read-only. Returns verdict: proceed | block. Inputs: {targetPaths[], overwrite?, slug?, scanScope?}. Example: {targetPaths:["test/orders/pages/story-42/OrdersPage.ts"], overwrite:false, scanScope:"target-and-siblings"}.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_scaffold_audit', { workspaceRoot: ctx.workspaceRoot });
        const findings: Array<z.infer<typeof FindingSchema>> = [];
        const slug = input.slug ?? inferSlugFromWorkspace(ctx.workspaceRoot);
        const warnings: string[] = [];
        const targetsAbs = input.targetPaths.map((p) => toAbsolute(ctx.workspaceRoot, p));

        // 1. Clobber check.
        for (const t of targetsAbs) {
            if (fs.existsSync(t) && fs.statSync(t).isFile() && !input.overwrite) {
                findings.push({
                    kind: 'file-conflict',
                    severity: 'block',
                    file: t,
                    detail: 'Target file already exists and overwrite=false',
                    hint: 'Re-invoke with overwrite:true if the caller intends to replace it, or pick a distinct output path.',
                });
            }
        }

        // 2. Secret + framework compliance scan.
        const scanned = new Set<string>();
        const scanQueue: string[] = [];
        for (const t of targetsAbs) {
            if (fs.existsSync(t) && fs.statSync(t).isFile()) scanQueue.push(t);
        }
        if (input.scanScope === 'target-and-siblings') {
            for (const t of targetsAbs) {
                for (const s of siblingsOf(t)) scanQueue.push(s);
            }
        }
        let targetsScanned = 0;
        let siblingsScanned = 0;
        for (const p of scanQueue) {
            if (scanned.has(p)) continue;
            scanned.add(p);
            const isTarget = targetsAbs.includes(p);
            if (isTarget) targetsScanned++;
            else siblingsScanned++;
            let content = '';
            try { content = fs.readFileSync(p, 'utf-8'); }
            catch { continue; }
            // Secret scan.
            const secrets = scanTextForSecrets(p, content, SECRET_PATTERNS);
            for (const h of secrets) {
                findings.push({
                    kind: isTarget ? 'secret-leak' : 'sibling-secret',
                    severity: h.severity === 'error' ? 'block' : 'warn',
                    file: p,
                    line: h.line,
                    detail: `${h.description} — matched "${h.redactedMatch}" (${h.kind})`,
                    hint: 'Move the secret to encrypted config (~/.cs-qa/ado-config.json for PATs; environment .env for non-secret values). NEVER commit raw tokens.',
                });
            }
            // Hardcoded URL check for page-objects only.
            if (isPageFile(p)) {
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (HARDCODED_URL_ASSIGNMENT_RE.test(lines[i])) {
                        findings.push({
                            kind: 'secret-leak',
                            severity: 'warn',
                            file: p,
                            line: i + 1,
                            detail: `Hardcoded URL literal — binds page-object to one environment`,
                            hint: `Read from this.config.get('BASE_URL') + this.config.get('<SCREEN>_PATH'). Set per env under config/${slug}/environments/<env>.env.`,
                        });
                    }
                }
            }
            // Framework compliance.
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i];
                if (RAW_PW_RE.test(ln)) {
                    findings.push({
                        kind: 'raw-playwright',
                        severity: 'block',
                        file: p, line: i + 1,
                        detail: 'Raw Playwright API in generated code',
                        hint: 'Use CS framework wrapper (CSBasePage.navigate, @CSGetElement, page-object method). If the wrapper does not exist, add it to the framework — do NOT hand-patch here.',
                    });
                }
                if (RAW_DIALOG_RE.test(ln)) {
                    findings.push({
                        kind: 'raw-dialog-handler',
                        severity: 'block',
                        file: p, line: i + 1,
                        detail: 'Raw page.on("dialog") handler — should use this.acceptNextDialog()',
                        hint: 'Call this.acceptNextDialog() (or the framework equivalent) from the page-object; step files must never touch page.on().',
                    });
                }
                if (isStepsFile(p)) {
                    if (XPATH_LITERAL_RE.test(ln)) {
                        findings.push({
                            kind: 'xpath-in-steps',
                            severity: 'block',
                            file: p, line: i + 1,
                            detail: 'xpath literal in step file (belongs on the page-object)',
                            hint: 'Move the xpath into a @CSGetElement field on the appropriate page-object and expose a semantic method.',
                        });
                    }
                    if (FACTORY_RE.test(ln)) {
                        findings.push({
                            kind: 'factory-in-steps',
                            severity: 'block',
                            file: p, line: i + 1,
                            detail: 'CSElementFactory in step file',
                            hint: 'Add a method on the page-object that uses CSElementFactory internally; call that method from the step.',
                        });
                    }
                }
            }
            // Decorator slug check.
            const decMatch = CS_PAGE_DECORATOR_RE.exec(content);
            if (decMatch && decMatch[1] !== slug) {
                findings.push({
                    kind: 'wrong-decorator-slug',
                    severity: 'warn',
                    file: p,
                    detail: `@CSPage('${decMatch[1]}') does not match project slug '${slug}'`,
                    hint: `Change decorator to @CSPage('${slug}') — decorator slug identifies the consumer project and is used by @CSGetElement self-heal storage.`,
                });
            }
        }

        const blocks = findings.filter((f) => f.severity === 'block').length;
        const verdict: 'proceed' | 'block' = blocks > 0 ? 'block' : 'proceed';
        log.info('scaffold audit complete', { verdict, findings: findings.length, blocks });
        return {
            ok: verdict === 'proceed',
            verdict,
            targetsScanned, siblingsScanned,
            findings,
            slug,
            warnings,
            note: verdict === 'proceed'
                ? `Scaffold safe to proceed — ${findings.length} advisory finding(s), 0 block-severity.`
                : `Scaffold BLOCKED — ${blocks} block-severity finding(s). Resolve before invoking cs_qa_ui_scaffold.`,
        };
    },
});
