/**
 * cs_qa_bootstrap_check — verifies a consumer workspace has the substrate
 * needed for verified test generation. This is a pre-flight for the
 * /generate-verified skill; failing here means we refuse to generate tests
 * into a workspace that isn't scaffolded, because emitting into an unclean
 * workspace risks orphan files, wrong slug, missing framework typings, etc.
 *
 * Checks:
 *   - package.json exists AND declares @mdakhan.mak/cs-playwright-test-framework
 *   - test/ directory exists
 *   - .cs-qa/config/ OR cs-playwright-mcp.config.json present
 *   - Playwright config present (playwright.config.ts or .js)
 *   - Env template with BASE_URL / LOGIN_URL placeholders (or real values)
 *   - Recommended folder layout under test/<slug>/: features, pages, steps, data
 *   - Framework version pinned (not 'latest' / '*')
 *
 * When `fixMissing:true`, missing setup with an actionable auto-fix is
 * proposed for chain-invocation via `cs_qa_init_project`. We DO NOT invoke
 * init_project ourselves — the orchestrator skill does that after user
 * confirmation. We only return the shape of the recommended action.
 *
 * Read-only when fixMissing:false; only proposes actions otherwise.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive, getPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';

const InputSchema = z.object({
    workspaceRoot: z.string().min(1).optional().describe('Override workspace root. Defaults to ctx.workspaceRoot.'),
    fixMissing: z.boolean().default(false).describe('When true, chain-invokes cs_qa_init_project for missing errors that have a scaffold fix. Defaults to false — return the recommendedAction list without touching the file system.'),
});

const RecommendedActionSchema = z.object({
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    description: z.string(),
});

const MissingSetupSchema = z.object({
    item: z.string(),
    severity: z.enum(['error', 'warn']),
    why: z.string(),
    recommendedAction: RecommendedActionSchema,
});

const OutputSchema = z.object({
    ok: z.boolean(),
    isBootstrapped: z.boolean(),
    workspaceRoot: z.string(),
    missingSetup: z.array(MissingSetupSchema),
    frameworkVersion: z.string().optional(),
    detectedLayout: z.enum(['standard', 'custom', 'incomplete']),
    detectedSlug: z.string().optional(),
    autoFixInvoked: z.boolean(),
    autoFixResult: z.unknown().optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const FRAMEWORK_PKG = '@mdakhan.mak/cs-playwright-test-framework';

interface PkgJson {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
}

function readPackageJson(workspaceRoot: string): { pkg: PkgJson | null; raw: string; path: string } {
    const p = path.join(workspaceRoot, 'package.json');
    if (!fs.existsSync(p)) return { pkg: null, raw: '', path: p };
    try {
        const raw = fs.readFileSync(p, 'utf-8');
        const pkg = JSON.parse(raw) as PkgJson;
        return { pkg, raw, path: p };
    } catch {
        return { pkg: null, raw: '', path: p };
    }
}

function inferSlugFromPackage(pkg: PkgJson | null, workspaceRoot: string): string {
    if (pkg && pkg.name) {
        const clean = pkg.name.replace(/^@[^/]+\//, '').toLowerCase();
        const slug = clean.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (slug) return slug;
    }
    return path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'app';
}

function detectFrameworkDep(pkg: PkgJson | null): { present: boolean; version?: string; where?: 'dependencies' | 'devDependencies' } {
    if (!pkg) return { present: false };
    if (pkg.dependencies && pkg.dependencies[FRAMEWORK_PKG]) {
        return { present: true, version: pkg.dependencies[FRAMEWORK_PKG], where: 'dependencies' };
    }
    if (pkg.devDependencies && pkg.devDependencies[FRAMEWORK_PKG]) {
        return { present: true, version: pkg.devDependencies[FRAMEWORK_PKG], where: 'devDependencies' };
    }
    return { present: false };
}

function isPinnedVersion(spec: string | undefined): boolean {
    if (!spec) return false;
    const t = spec.trim();
    if (t === 'latest' || t === '*' || t === '') return false;
    return true;
}

function hasPlaywrightConfig(workspaceRoot: string): { present: boolean; path?: string } {
    const candidates = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];
    for (const c of candidates) {
        const p = path.join(workspaceRoot, c);
        if (fs.existsSync(p)) return { present: true, path: c };
    }
    return { present: false };
}

function hasConfigJson(workspaceRoot: string): { present: boolean; path?: string } {
    const candidates = [
        path.join(workspaceRoot, 'cs-playwright-mcp.config.json'),
        path.join(workspaceRoot, 'cs-ai-auto-assist.config.json'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return { present: true, path: path.relative(workspaceRoot, c) };
    }
    const csQaConfigDir = path.join(workspaceRoot, '.cs-qa', 'config');
    if (fs.existsSync(csQaConfigDir) && fs.statSync(csQaConfigDir).isDirectory()) {
        return { present: true, path: '.cs-qa/config' };
    }
    return { present: false };
}

function findEnvTemplate(workspaceRoot: string, slug: string): { present: boolean; hasBaseUrl: boolean; hasLoginUrl: boolean; path?: string } {
    const candidates = [
        path.join(workspaceRoot, 'config', slug, 'common', 'common.env'),
        path.join(workspaceRoot, 'config', slug, 'environments', 'dev.env'),
        path.join(workspaceRoot, 'config', slug, 'environments', 'sit.env'),
        path.join(workspaceRoot, 'config', slug, 'environments', 'uat.env'),
        path.join(workspaceRoot, '.env'),
        path.join(workspaceRoot, '.env.example'),
    ];
    let hasBase = false;
    let hasLogin = false;
    let firstMatch: string | undefined;
    for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        firstMatch = firstMatch || path.relative(workspaceRoot, c);
        try {
            const contents = fs.readFileSync(c, 'utf-8');
            if (/^\s*BASE_URL\s*=/m.test(contents)) hasBase = true;
            if (/^\s*LOGIN_URL\s*=/m.test(contents)) hasLogin = true;
        } catch { /* ignore */ }
    }
    return { present: !!firstMatch, hasBaseUrl: hasBase, hasLoginUrl: hasLogin, path: firstMatch };
}

interface LayoutCheck {
    layout: 'standard' | 'custom' | 'incomplete';
    missing: string[];
    present: string[];
}

function detectLayout(workspaceRoot: string, slug: string): LayoutCheck {
    const testRoot = path.join(workspaceRoot, 'test');
    if (!fs.existsSync(testRoot)) return { layout: 'incomplete', missing: ['test/'], present: [] };

    const preferredSubdirs = ['features', 'pages', 'steps', 'data'];
    const missing: string[] = [];
    const present: string[] = [];
    for (const sub of preferredSubdirs) {
        // Standard layout is test/<slug>/<sub>. Custom layout is test/<sub>.
        const slugPath = path.join(testRoot, slug, sub);
        const flatPath = path.join(testRoot, sub);
        if (fs.existsSync(slugPath)) present.push(`test/${slug}/${sub}`);
        else if (fs.existsSync(flatPath)) present.push(`test/${sub}`);
        else missing.push(`test/${slug}/${sub}`);
    }
    if (missing.length === 0) return { layout: 'standard', missing, present };
    if (present.length > 0) return { layout: 'custom', missing, present };
    return { layout: 'incomplete', missing, present };
}

function buildInitProjectArgs(workspaceRoot: string, slug: string): Record<string, unknown> {
    // Sensible defaults for cold-start bootstrap. The orchestrator can override
    // by asking the user for real values before invoking init_project.
    return {
        projectSlug: slug,
        baseUrls: { dev: `https://REPLACE_ME_DEV.example.com` },
        dbType: 'none',
        enableCrossProjectCommon: false,
        force: false,
    };
}

registerPrimitive<Input, Output>({
    name: 'cs_qa_bootstrap_check',
    description: 'Pre-flight for verified test generation. Verifies the workspace has package.json declaring @mdakhan.mak/cs-playwright-test-framework (with a pinned version), a test/ directory, a project config (.cs-qa/config or cs-playwright-mcp.config.json), a Playwright config, and an env template naming BASE_URL/LOGIN_URL. Returns isBootstrapped + missingSetup[] with severity + recommendedAction that names cs_qa_init_project + args for auto-fix. When fixMissing:true, chain-invokes cs_qa_init_project directly. Never overwrites existing files.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const workspaceRoot = input.workspaceRoot
            ? (path.isAbsolute(input.workspaceRoot) ? input.workspaceRoot : path.resolve(ctx.workspaceRoot, input.workspaceRoot))
            : ctx.workspaceRoot;
        const log = createLogger(ctx.invocationId, 'cs_qa_bootstrap_check', { workspaceRoot: ctx.workspaceRoot });
        log.info('bootstrap-check-start', { workspaceRoot, fixMissing: input.fixMissing });

        const warnings: string[] = [];
        const missingSetup: z.infer<typeof MissingSetupSchema>[] = [];

        // 1. package.json + framework dep.
        const { pkg } = readPackageJson(workspaceRoot);
        const slug = inferSlugFromPackage(pkg, workspaceRoot);
        if (!pkg) {
            missingSetup.push({
                item: 'package.json',
                severity: 'error',
                why: `No package.json found at ${workspaceRoot}. A consumer project must have package.json declaring ${FRAMEWORK_PKG}.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: `Bootstrap a fresh consumer project with slug '${slug}'.`,
                },
            });
        }

        const frameworkDep = detectFrameworkDep(pkg);
        if (pkg && !frameworkDep.present) {
            missingSetup.push({
                item: `dependency:${FRAMEWORK_PKG}`,
                severity: 'error',
                why: `package.json exists but does not declare ${FRAMEWORK_PKG} in dependencies or devDependencies. All CS Playwright generation depends on this package.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: `Re-scaffold to add ${FRAMEWORK_PKG} to dependencies.`,
                },
            });
        } else if (frameworkDep.present && !isPinnedVersion(frameworkDep.version)) {
            missingSetup.push({
                item: `dependency:${FRAMEWORK_PKG}:version-pin`,
                severity: 'warn',
                why: `${FRAMEWORK_PKG} is present but pinned to '${frameworkDep.version}'. 'latest' / '*' breaks reproducibility — CI runs may pick up a version with breaking changes silently.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: { ...buildInitProjectArgs(workspaceRoot, slug), force: false },
                    description: `Edit package.json manually to pin ${FRAMEWORK_PKG} to a specific version like ^1.49.0.`,
                },
            });
        }

        // 2. test/ directory.
        const testRoot = path.join(workspaceRoot, 'test');
        if (!fs.existsSync(testRoot)) {
            missingSetup.push({
                item: 'test/',
                severity: 'warn',
                why: `No test/ directory at workspace root. Generated artifacts default to test/<slug>/{features,pages,steps,data}.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: `Scaffold the test/ tree via cs_qa_init_project.`,
                },
            });
        }

        // 3. Config file.
        const cfgResult = hasConfigJson(workspaceRoot);
        if (!cfgResult.present) {
            missingSetup.push({
                item: 'cs-playwright-mcp.config.json',
                severity: 'error',
                why: `No project config (.cs-qa/config/ or cs-playwright-mcp.config.json) found. Framework runtime + MCP config both live here.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: `cs_qa_init_project writes cs-playwright-mcp.config.json alongside the rest of the scaffold.`,
                },
            });
        }

        // 4. Playwright config.
        const pwCfg = hasPlaywrightConfig(workspaceRoot);
        if (!pwCfg.present) {
            missingSetup.push({
                item: 'playwright.config.ts',
                severity: 'warn',
                why: 'No playwright.config.{ts,js,mjs,cjs} present. The framework can still run through its own runner but Playwright-native test discovery + IDE integration will not work.',
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: 'Scaffold a minimal playwright.config.ts.',
                },
            });
        }

        // 5. Env template — BASE_URL / LOGIN_URL.
        const env = findEnvTemplate(workspaceRoot, slug);
        if (!env.present) {
            missingSetup.push({
                item: `config/${slug}/environments/*.env`,
                severity: 'warn',
                why: `No env template found at config/${slug}/environments/ or workspace root .env. Verified generation needs BASE_URL to know which host to hit for live locator verification.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: `Scaffold config/${slug}/environments/dev.env with BASE_URL / LOGIN_URL placeholders.`,
                },
            });
        } else if (!env.hasBaseUrl) {
            missingSetup.push({
                item: 'BASE_URL',
                severity: 'warn',
                why: `Env file at ${env.path} does not declare BASE_URL. The orchestrator will require an explicit targetUrl on every /generate-verified call.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: `Re-invoke cs_qa_init_project OR add BASE_URL=... to the env file manually.`,
                },
            });
        }

        // 6. Recommended layout.
        const layout = detectLayout(workspaceRoot, slug);
        if (layout.layout === 'incomplete') {
            missingSetup.push({
                item: 'test/<slug>/{features,pages,steps,data}',
                severity: 'warn',
                why: `Standard layout is test/${slug}/{features,pages,steps,data}. Missing: ${layout.missing.join(', ')}.`,
                recommendedAction: {
                    tool: 'cs_qa_init_project',
                    args: buildInitProjectArgs(workspaceRoot, slug),
                    description: `Scaffold the missing folders.`,
                },
            });
        }

        // Aggregate: bootstrapped when there are no error-severity items.
        const errorItems = missingSetup.filter((m) => m.severity === 'error');
        const isBootstrapped = errorItems.length === 0;

        // Optionally chain-invoke init_project when auto-fix is requested.
        let autoFixInvoked = false;
        let autoFixResult: unknown = undefined;
        if (input.fixMissing && errorItems.length > 0) {
            const initTool = getPrimitive('cs_qa_init_project');
            if (initTool) {
                try {
                    const args = buildInitProjectArgs(workspaceRoot, slug);
                    // Delegate to init_project — the orchestrator has already
                    // confirmed the fix with the user before setting fixMissing.
                    autoFixResult = await initTool.run(ctx, args as unknown);
                    autoFixInvoked = true;
                    log.info('auto-fix-invoked', { tool: 'cs_qa_init_project', slug });
                } catch (e) {
                    warnings.push(`auto-fix failed: ${(e as Error).message}`);
                }
            } else {
                warnings.push('cs_qa_init_project primitive not registered — auto-fix skipped.');
            }
        }

        const note = isBootstrapped
            ? `Workspace is bootstrapped. Slug=${slug}. Framework=${frameworkDep.version || '(not detected)'}. Layout=${layout.layout}.${missingSetup.length > 0 ? ` ${missingSetup.length} warning(s) — non-blocking.` : ''}`
            : `Workspace is NOT bootstrapped. ${errorItems.length} error(s) blocking verified generation. Recommended action: run cs_qa_init_project with slug=${slug} (or pass fixMissing:true after user confirmation).`;

        log.info('bootstrap-check-done', {
            isBootstrapped,
            errorCount: errorItems.length,
            warnCount: missingSetup.length - errorItems.length,
            slug,
            frameworkVersion: frameworkDep.version,
            layout: layout.layout,
            autoFixInvoked,
        });

        return {
            ok: true,
            isBootstrapped,
            workspaceRoot,
            missingSetup,
            frameworkVersion: frameworkDep.version,
            detectedLayout: layout.layout,
            detectedSlug: slug,
            autoFixInvoked,
            autoFixResult,
            warnings,
            note,
        };
    },
});
