/**
 * cs_qa_gen_visual_regression — verb-driven visual regression tool.
 *
 * Verbs (discriminated on `verb`):
 *   default / omitted / 'generate' — emit Playwright visual regression spec +
 *     baseline metadata + README + optional ADO Test Case + optional baseline
 *     management Task under the parent Story. (Backward compat: existing
 *     callers that omit `verb` get the original generate behavior.)
 *   'list-baselines'    — enumerate .png snapshots under test/visual/**\/__baselines__
 *                        OR playwright-snapshots/ dirs. Returns
 *                        {path, size, capturedAt, checksum}[].
 *   'approve-baseline'  — replace snapshotPath with newImagePath. Two-phase
 *                        confirmation. Audit entry emitted.
 *   'delete-baseline'   — remove snapshotPath. Two-phase confirmation.
 *   'diff-report'       — parse pixelmatch diff artifacts from the last run
 *                        (or lastRunDir) and return a per-test summary
 *                        {tests, changed, unchanged, newBaselines}[].
 *
 * The emitted spec uses Playwright's built-in `toHaveScreenshot()` matcher
 * (pixel diff with threshold) and mask/style overrides to hide dynamic
 * regions. Consumers of cs-playwright-test-framework can extend this via
 * CSScreenshotManager if the framework is installed; the fallback works with
 * vanilla @playwright/test alone so a scaffold without the framework still
 * runs.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

const ViewportSchema = z.object({
    name: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
});

const DEFAULT_VIEWPORTS = [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 375, height: 812 },
];

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

function escapeString(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function composeSpec(args: {
    targetUrl: string;
    viewports: z.infer<typeof ViewportSchema>[];
    selectorScopes?: string[];
    ignoreSelectors?: string[];
    slug: string;
}): string {
    const scopeBlock = args.selectorScopes && args.selectorScopes.length > 0
        ? args.selectorScopes.map((sel) => `        await expect(page.locator('${escapeString(sel)}')).toHaveScreenshot({
            maxDiffPixelRatio: 0.001,
            mask: MASK_LOCATORS,
        });`).join('\n')
        : `        await expect(page).toHaveScreenshot({
            fullPage: true,
            maxDiffPixelRatio: 0.001,
            mask: MASK_LOCATORS,
        });`;

    const maskArray = (args.ignoreSelectors || []).map((sel) => `page.locator('${escapeString(sel)}')`).join(', ');
    const viewportTests = args.viewports.map((vp) => `test('${escapeString(args.slug)} — ${escapeString(vp.name)} (${vp.width}x${vp.height})', async ({ page }) => {
    await page.setViewportSize({ width: ${vp.width}, height: ${vp.height} });
    await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
    const MASK_LOCATORS = [${maskArray}];
${scopeBlock}
});`).join('\n\n');

    return `// Auto-generated visual regression spec.
//
// Run: npx playwright test ${args.slug}.visual.ts
// Update baselines: npx playwright test ${args.slug}.visual.ts --update-snapshots
//
// Screenshots are stored under __screenshots__/ next to this spec; commit them
// to source control after review to lock the baseline.

import { test, expect } from '@playwright/test';

const TARGET_URL = '${escapeString(args.targetUrl)}';

${viewportTests}
`;
}

function composeBaselineMetadata(args: {
    targetUrl: string;
    viewports: z.infer<typeof ViewportSchema>[];
    selectorScopes?: string[];
    ignoreSelectors?: string[];
    slug: string;
}): string {
    return JSON.stringify({
        slug: args.slug,
        targetUrl: args.targetUrl,
        createdAt: new Date().toISOString(),
        diffThreshold: 0.001,
        viewports: args.viewports,
        selectorScopes: args.selectorScopes || null,
        ignoreSelectors: args.ignoreSelectors || null,
        instructions: [
            'Review generated screenshots in __screenshots__/ before committing.',
            'Update baselines with: npx playwright test <spec> --update-snapshots',
            'Add newly dynamic regions to ignoreSelectors and regenerate.',
        ],
    }, null, 2);
}

function composeReadme(args: { slug: string; targetUrl: string; specFile: string; viewports: z.infer<typeof ViewportSchema>[] }): string {
    const viewportLines = args.viewports.map((v) => `- **${v.name}** — ${v.width}×${v.height}`).join('\n');
    return `# Visual regression — ${args.slug}

Target URL: ${args.targetUrl}

## Viewports
${viewportLines}

## Run
\`\`\`bash
npx playwright test ${path.basename(args.specFile)}
\`\`\`

## Update baselines
\`\`\`bash
npx playwright test ${path.basename(args.specFile)} --update-snapshots
\`\`\`

## Baseline management
- After first run, review \`__screenshots__/\` and commit approved images.
- Diffs land in \`test-results/\` alongside the failure trace.
- To mask new dynamic regions, add selectors to the \`.baseline.json\` \`ignoreSelectors\` array and regenerate.
`;
}

function composePerScenarioSteps(viewports: z.infer<typeof ViewportSchema>[]): string {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const rows: string[] = [];
    let i = 1;
    rows.push(`<step id="${i++}" type="PreCondition"><parameterizedString isformatted="true">&lt;P&gt;${esc('Ensure baseline screenshots are committed and Playwright browsers are installed')}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc('Baselines available; browsers installed via npx playwright install')}&lt;/P&gt;</parameterizedString><description/></step>`);
    for (const vp of viewports) {
        rows.push(`<step id="${i++}" type="ActionStep"><parameterizedString isformatted="true">&lt;P&gt;${esc(`Capture screenshot at ${vp.name} (${vp.width}×${vp.height})`)}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc('Diff vs baseline is within threshold')}&lt;/P&gt;</parameterizedString><description/></step>`);
    }
    return `<steps id="0" last="${i - 1}">${rows.join('')}</steps>`;
}

// =============================================================================
// Baseline verb helpers
// =============================================================================

function checksum(file: string): string {
    try {
        const buf = fs.readFileSync(file);
        return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    } catch { return ''; }
}

function walk(dir: string, matcher: (p: string) => boolean, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, matcher, out);
        else if (e.isFile() && matcher(full)) out.push(full);
    }
    return out;
}

interface BaselineEntry { path: string; size: number; capturedAt: string; checksum: string }

function listBaselines(workspaceRoot: string, targetFilter?: string): BaselineEntry[] {
    const roots = [
        path.join(workspaceRoot, 'test', 'visual'),
        path.join(workspaceRoot, 'playwright-snapshots'),
        path.join(workspaceRoot, 'test'),
    ];
    const seen = new Set<string>();
    const entries: BaselineEntry[] = [];
    for (const r of roots) {
        if (!fs.existsSync(r)) continue;
        const files = walk(r, (p) => {
            if (!p.toLowerCase().endsWith('.png')) return false;
            const normalized = p.replace(/\\/g, '/');
            return (
                normalized.includes('/__baselines__/') ||
                normalized.includes('/__screenshots__/') ||
                normalized.includes('/playwright-snapshots/') ||
                normalized.includes('/baselines/')
            );
        });
        for (const f of files) {
            if (seen.has(f)) continue;
            seen.add(f);
            if (targetFilter && !f.toLowerCase().includes(targetFilter.toLowerCase())) continue;
            try {
                const st = fs.statSync(f);
                entries.push({
                    path: f,
                    size: st.size,
                    capturedAt: st.mtime.toISOString(),
                    checksum: checksum(f),
                });
            } catch { /* skip unreadable */ }
        }
    }
    return entries;
}

function auditBaselineAction(workspaceRoot: string, action: 'approve' | 'delete', payload: Record<string, unknown>): void {
    const dir = path.join(workspaceRoot, '.cs-qa', 'audit');
    try {
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            tool: 'cs_qa_gen_visual_regression',
            action: `baseline-${action}`,
            ...payload,
        });
        fs.appendFileSync(path.join(dir, 'baseline-actions.jsonl'), line + '\n', 'utf-8');
    } catch { /* best-effort */ }
}

interface DiffReportEntry { test: string; changed: boolean; unchanged: boolean; newBaseline: boolean; diffPath?: string; expectedPath?: string; actualPath?: string }

function findLastRunDir(workspaceRoot: string): string | null {
    const candidates = [
        path.join(workspaceRoot, 'test-results'),
        path.join(workspaceRoot, 'playwright-report'),
        path.join(workspaceRoot, 'reports'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function parseDiffReport(workspaceRoot: string, lastRunDir?: string): { tests: number; changed: number; unchanged: number; newBaselines: number; entries: DiffReportEntry[] } {
    const dir = lastRunDir
        ? (path.isAbsolute(lastRunDir) ? lastRunDir : path.join(workspaceRoot, lastRunDir))
        : findLastRunDir(workspaceRoot);
    if (!dir || !fs.existsSync(dir)) {
        return { tests: 0, changed: 0, unchanged: 0, newBaselines: 0, entries: [] };
    }
    // Playwright convention: test-results/<test-name>/<viewport>-<browser>-diff.png (or -actual.png / -expected.png).
    const diffFiles = walk(dir, (p) => /-(diff|actual|expected)\.png$/i.test(p));
    const grouped = new Map<string, { diff?: string; actual?: string; expected?: string }>();
    for (const f of diffFiles) {
        const base = f.replace(/-(diff|actual|expected)\.png$/i, '');
        const kind = /-diff\.png$/i.test(f) ? 'diff' : /-actual\.png$/i.test(f) ? 'actual' : 'expected';
        const g = grouped.get(base) || {};
        (g as Record<string, string>)[kind] = f;
        grouped.set(base, g);
    }
    // Also add any snapshot PNGs referenced by *-snapshots directories without a diff.
    const snapshotRoots = walk(dir, (p) => p.toLowerCase().endsWith('.png') && /-snapshots/.test(p.replace(/\\/g, '/')));
    for (const s of snapshotRoots) {
        const base = s.replace(/\.png$/i, '');
        if (!grouped.has(base) && !/-diff|-actual|-expected/.test(s)) {
            grouped.set(base, { expected: s });
        }
    }
    let changed = 0;
    let unchanged = 0;
    let newBaselines = 0;
    const entries: DiffReportEntry[] = [];
    for (const [base, g] of grouped.entries()) {
        const rel = path.relative(dir, base);
        const isChanged = !!g.diff;
        const hasExpectedAndActualOnly = !g.diff && !!g.actual && !!g.expected;
        const isNew = !g.diff && !!g.actual && !g.expected;
        if (isChanged) { changed++; } else if (hasExpectedAndActualOnly) { unchanged++; } else if (isNew) { newBaselines++; }
        else { unchanged++; }
        entries.push({
            test: rel,
            changed: isChanged,
            unchanged: hasExpectedAndActualOnly,
            newBaseline: isNew,
            diffPath: g.diff,
            actualPath: g.actual,
            expectedPath: g.expected,
        });
    }
    return { tests: entries.length, changed, unchanged, newBaselines, entries };
}

// =============================================================================
// Zod discriminated schema
// =============================================================================

const GenerateInput = z.object({
    verb: z.literal('generate').optional(),
    targetUrl: z.string().url(),
    viewports: z.array(ViewportSchema).optional(),
    selectorScopes: z.array(z.string()).optional(),
    ignoreSelectors: z.array(z.string()).optional(),
    outputRoot: z.string().optional(),
    slug: z.string().optional(),
    createAdoTc: z.boolean().default(false),
    createBaselineManagementTask: z.boolean().default(false),
    linkToStoryId: z.number().int().positive().optional(),
    dryRun: z.boolean().default(false),
    confirmed: z.boolean().optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
});
const ListBaselinesInput = z.object({
    verb: z.literal('list-baselines'),
    project: z.string().optional(),
    targetFilter: z.string().optional(),
});
const ApproveBaselineInput = z.object({
    verb: z.literal('approve-baseline'),
    snapshotPath: z.string().min(1),
    newImagePath: z.string().min(1),
    confirmed: z.boolean().default(false),
});
const DeleteBaselineInput = z.object({
    verb: z.literal('delete-baseline'),
    snapshotPath: z.string().min(1),
    confirmed: z.boolean().default(false),
});
const DiffReportInput = z.object({
    verb: z.literal('diff-report'),
    lastRunDir: z.string().optional(),
});
const InputSchema = z.union([
    GenerateInput,
    ListBaselinesInput,
    ApproveBaselineInput,
    DeleteBaselineInput,
    DiffReportInput,
]);
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.enum(['generate', 'list-baselines', 'approve-baseline', 'delete-baseline', 'diff-report']),
    specFile: z.string().optional(),
    baselineFile: z.string().optional(),
    readmeFile: z.string().optional(),
    tcId: z.number().optional(),
    taskId: z.number().optional(),
    baselines: z.array(z.object({
        path: z.string(), size: z.number(), capturedAt: z.string(), checksum: z.string(),
    })).optional(),
    approved: z.object({ snapshotPath: z.string(), previousChecksum: z.string(), newChecksum: z.string() }).optional(),
    deleted: z.object({ snapshotPath: z.string(), previousChecksum: z.string() }).optional(),
    diffReport: z.object({
        tests: z.number(),
        changed: z.number(),
        unchanged: z.number(),
        newBaselines: z.number(),
        entries: z.array(z.object({
            test: z.string(),
            changed: z.boolean(),
            unchanged: z.boolean(),
            newBaseline: z.boolean(),
            diffPath: z.string().optional(),
            actualPath: z.string().optional(),
            expectedPath: z.string().optional(),
        })),
    }).optional(),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
    requiresConfirmation: z.boolean().optional(),
    destructive: z.boolean().optional(),
    confirmationHint: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Register — verb dispatcher
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_gen_visual_regression',
    description: 'Verb-driven visual regression tool. Verbs: generate (default — emit Playwright spec + baseline metadata + README + optional ADO Test Case/Task; two-phase confirm on ADO writes), list-baselines (enumerate .png snapshots under test/visual/**\\/__baselines__ or playwright-snapshots/), approve-baseline (copy newImagePath over snapshotPath — two-phase confirm), delete-baseline (remove snapshotPath — two-phase confirm), diff-report (parse pixelmatch/Playwright diff artifacts from last run and return per-test summary). Backward compat: omitting verb runs generate. On-prem safe.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_visual_regression', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const verb: 'generate' | 'list-baselines' | 'approve-baseline' | 'delete-baseline' | 'diff-report' =
            (input as { verb?: string }).verb === 'list-baselines' ? 'list-baselines'
            : (input as { verb?: string }).verb === 'approve-baseline' ? 'approve-baseline'
            : (input as { verb?: string }).verb === 'delete-baseline' ? 'delete-baseline'
            : (input as { verb?: string }).verb === 'diff-report' ? 'diff-report'
            : 'generate';

        // ---- list-baselines ----
        if (verb === 'list-baselines') {
            const li = input as z.infer<typeof ListBaselinesInput>;
            const baselines = listBaselines(ctx.workspaceRoot, li.targetFilter);
            log.info('list-baselines', { count: baselines.length });
            return {
                ok: true, verb, baselines, warnings,
                note: `Found ${baselines.length} baseline snapshot(s)${li.targetFilter ? ` matching filter "${li.targetFilter}"` : ''}.`,
            };
        }

        // ---- approve-baseline ----
        if (verb === 'approve-baseline') {
            const ai = input as z.infer<typeof ApproveBaselineInput>;
            const snap = path.isAbsolute(ai.snapshotPath) ? ai.snapshotPath : path.join(ctx.workspaceRoot, ai.snapshotPath);
            const src = path.isAbsolute(ai.newImagePath) ? ai.newImagePath : path.join(ctx.workspaceRoot, ai.newImagePath);
            if (!fs.existsSync(src)) {
                return { ok: false, verb, warnings, note: `newImagePath not found: ${src}` };
            }
            const previousChecksum = fs.existsSync(snap) ? checksum(snap) : '';
            const newChecksum = checksum(src);
            if (ai.confirmed !== true) {
                return {
                    ok: true, verb, warnings,
                    requiresConfirmation: true,
                    destructive: true,
                    confirmationHint: `Approve baseline: replace ${snap} (checksum=${previousChecksum || 'none'}) with ${src} (checksum=${newChecksum}). No file written. Retry with confirmed:true to apply.`,
                    note: 'requires confirmation — retry with confirmed:true',
                };
            }
            fs.mkdirSync(path.dirname(snap), { recursive: true });
            fs.copyFileSync(src, snap);
            auditBaselineAction(ctx.workspaceRoot, 'approve', { snapshotPath: snap, source: src, previousChecksum, newChecksum });
            log.info('approve-baseline', { snap, previousChecksum, newChecksum });
            return {
                ok: true, verb, warnings,
                approved: { snapshotPath: snap, previousChecksum, newChecksum },
                note: `Baseline approved: ${snap}`,
            };
        }

        // ---- delete-baseline ----
        if (verb === 'delete-baseline') {
            const di = input as z.infer<typeof DeleteBaselineInput>;
            const snap = path.isAbsolute(di.snapshotPath) ? di.snapshotPath : path.join(ctx.workspaceRoot, di.snapshotPath);
            if (!fs.existsSync(snap)) {
                return { ok: false, verb, warnings, note: `snapshotPath not found: ${snap}` };
            }
            const previousChecksum = checksum(snap);
            if (di.confirmed !== true) {
                return {
                    ok: true, verb, warnings,
                    requiresConfirmation: true,
                    destructive: true,
                    confirmationHint: `Delete baseline ${snap} (checksum=${previousChecksum}). No file removed. Retry with confirmed:true to apply.`,
                    note: 'requires confirmation — retry with confirmed:true',
                };
            }
            fs.unlinkSync(snap);
            auditBaselineAction(ctx.workspaceRoot, 'delete', { snapshotPath: snap, previousChecksum });
            log.info('delete-baseline', { snap, previousChecksum });
            return {
                ok: true, verb, warnings,
                deleted: { snapshotPath: snap, previousChecksum },
                note: `Baseline deleted: ${snap}`,
            };
        }

        // ---- diff-report ----
        if (verb === 'diff-report') {
            const di = input as z.infer<typeof DiffReportInput>;
            const report = parseDiffReport(ctx.workspaceRoot, di.lastRunDir);
            log.info('diff-report', { tests: report.tests, changed: report.changed, unchanged: report.unchanged, newBaselines: report.newBaselines });
            return {
                ok: true, verb, warnings, diffReport: report,
                note: `Diff report: ${report.tests} test(s), ${report.changed} changed, ${report.unchanged} unchanged, ${report.newBaselines} new baseline(s).`,
            };
        }

        // ---- generate (default — backward compat) ----
        const genInput = input as z.infer<typeof GenerateInput>;
        const viewports = genInput.viewports && genInput.viewports.length > 0 ? genInput.viewports : DEFAULT_VIEWPORTS;
        const urlObj = new URL(genInput.targetUrl);
        const slug = genInput.slug || slugify(urlObj.pathname === '/' ? urlObj.hostname : urlObj.pathname);

        const outputRoot = genInput.outputRoot
            ? (path.isAbsolute(genInput.outputRoot) ? genInput.outputRoot : path.join(ctx.workspaceRoot, genInput.outputRoot))
            : path.join(ctx.workspaceRoot, 'test', 'visual');
        const visualDir = outputRoot;
        const baselineDir = path.join(visualDir, 'baselines');

        const specFile = path.join(visualDir, `${slug}.visual.ts`);
        const baselineFile = path.join(baselineDir, `${slug}.baseline.json`);
        const readmeFile = path.join(visualDir, `${slug}.visual.README.md`);

        if (genInput.dryRun) {
            return { ok: true, verb, specFile, baselineFile, readmeFile, warnings, note: `Dry-run: would write spec, baseline metadata, README for slug "${slug}" with ${viewports.length} viewports.` };
        }

        fs.mkdirSync(visualDir, { recursive: true });
        fs.mkdirSync(baselineDir, { recursive: true });

        const spec = composeSpec({
            targetUrl: genInput.targetUrl,
            viewports,
            selectorScopes: genInput.selectorScopes,
            ignoreSelectors: genInput.ignoreSelectors,
            slug,
        });
        const baseline = composeBaselineMetadata({
            targetUrl: genInput.targetUrl,
            viewports,
            selectorScopes: genInput.selectorScopes,
            ignoreSelectors: genInput.ignoreSelectors,
            slug,
        });
        const readme = composeReadme({ slug, targetUrl: genInput.targetUrl, specFile, viewports });

        fs.writeFileSync(specFile, spec, 'utf-8');
        fs.writeFileSync(baselineFile, baseline, 'utf-8');
        fs.writeFileSync(readmeFile, readme, 'utf-8');
        log.info('visual regression scaffold written', { specFile, viewports: viewports.length });

        if (!genInput.createAdoTc && !genInput.createBaselineManagementTask) {
            return { ok: true, verb, specFile, baselineFile, readmeFile, warnings, note: 'Visual regression scaffold generated. Pass createAdoTc:true for ADO integration.' };
        }

        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: genInput.orgUrl, project: genInput.project, personalAccessToken: genInput.pat,
        });
        if (!credsRes.creds) {
            warnings.push(credsRes.diagnostic);
            return { ok: true, verb, specFile, baselineFile, readmeFile, warnings, note: 'Scaffold generated; ADO writes skipped (creds missing).' };
        }
        const cfg: AdoCreds = credsRes.creds;

        if (genInput.confirmed !== true) {
            return {
                ok: true, verb, specFile, baselineFile, readmeFile, warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create ADO Test Case${genInput.createBaselineManagementTask ? ' + baseline management Task' : ''} for visual regression "${slug}" in project ${cfg.project}? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                note: 'requires confirmation — retry with confirmed:true',
            };
        }

        const client = new AdoHttpClient(cfg);
        let tcId: number | undefined;
        let taskId: number | undefined;

        if (genInput.createAdoTc) {
            const patch: Array<Record<string, unknown>> = [
                { op: 'add', path: '/fields/System.Title', value: `Visual Regression: ${slug}` },
                { op: 'add', path: '/fields/System.Description', value: composeTcDescription(genInput.targetUrl, viewports, specFile) },
                { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: composePerScenarioSteps(viewports) },
                { op: 'add', path: '/fields/System.Tags', value: 'visual-regression; playwright' },
            ];
            if (genInput.linkToStoryId) {
                patch.push({
                    op: 'add', path: '/relations/-',
                    value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${genInput.linkToStoryId}` },
                });
            }
            try {
                const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Test%20Case?api-version=7.0`, patch);
                tcId = Number(created.id || 0);
            } catch (e) {
                warnings.push(`ADO TC creation failed: ${(e as Error).message}`);
            }
        }

        if (genInput.createBaselineManagementTask && genInput.linkToStoryId) {
            const taskPatch: Array<Record<string, unknown>> = [
                { op: 'add', path: '/fields/System.Title', value: `Visual baseline upkeep: ${slug}` },
                { op: 'add', path: '/fields/System.Description', value: `<p>Review and refresh visual regression baselines for <code>${genInput.targetUrl}</code> after significant UI changes. Playwright spec: <code>${specFile}</code>. Baseline metadata: <code>${baselineFile}</code>.</p>` },
                { op: 'add', path: '/fields/System.Tags', value: 'visual-regression; baseline-upkeep' },
                {
                    op: 'add', path: '/relations/-',
                    value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${genInput.linkToStoryId}` },
                },
            ];
            try {
                const createdTask = await client.post<{ id?: number }>(`_apis/wit/workitems/$Task?api-version=7.0`, taskPatch);
                taskId = Number(createdTask.id || 0);
            } catch (e) {
                warnings.push(`Baseline management Task creation failed: ${(e as Error).message}`);
            }
        } else if (genInput.createBaselineManagementTask && !genInput.linkToStoryId) {
            warnings.push('createBaselineManagementTask requires linkToStoryId — Task not created.');
        }

        return {
            ok: true, verb, specFile, baselineFile, readmeFile, tcId, taskId, warnings,
            note: `Visual regression scaffold generated${tcId ? ` + ADO TC ${tcId}` : ''}${taskId ? ` + Task ${taskId}` : ''}.`,
        };
    },
});

function composeTcDescription(url: string, viewports: z.infer<typeof ViewportSchema>[], specFile: string): string {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = viewports.map((v) => `<tr><td>${esc(v.name)}</td><td>${v.width}×${v.height}</td></tr>`).join('');
    return `<div>
<h3>Visual Regression</h3>
<p>Target URL: <code>${esc(url)}</code></p>
<p>Playwright spec: <code>${esc(specFile)}</code></p>
<h3>Viewports</h3>
<table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody>${rows}</tbody></table>
<p>Update baselines via <code>npx playwright test &lt;spec&gt; --update-snapshots</code>.</p>
</div>`;
}
