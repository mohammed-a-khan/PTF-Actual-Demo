/**
 * cs_qa_gen_a11y_test — accessibility test scaffolder.
 *
 * Emits an axe-core-driven Playwright/BDD suite for a target URL. Per viewport
 * we get one .feature file with @a11y + @wcag<level> tags and one Scenario per
 * WCAG rule family. A generated `_a11y-helper.ts` wraps `@axe-core/playwright`
 * (imported lazily so the scaffold can compile even before the consumer runs
 * `npm i --save-dev @axe-core/playwright axe-core`).
 *
 * Non-negotiables enforced here:
 *  - All ADO HTTP via AdoHttpClient (Retry-After, PAT redaction).
 *  - All logging via createLogger (correlation-id + audit).
 *  - Two-phase confirmation on any ADO write (bulk TC creation).
 *  - On-prem safe — no `dev.azure.com` literals; ADO org comes from config
 *    resolver.
 *  - Zod discriminated where needed. Backward compat with a single verb
 *    (this is a new tool — default behavior is generate).
 *  - Generated .env.template always uses `ENCRYPTED:` placeholder.
 *  - Generated helper uses CSReporter, never console.log.
 *  - No project pollution — no consumer/customer product name references
 *    anywhere in generated artifacts (the @mdakhan.mak framework import is
 *    the only permitted vendor reference).
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

// =============================================================================
// Schemas
// =============================================================================

const ViewportSchema = z.object({
    name: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
});

const LoginFlowSchema = z.object({
    usernameSelector: z.string().min(1),
    passwordSelector: z.string().min(1),
    submitSelector: z.string().min(1),
    usernameEnvVar: z.string().min(1),
    passwordEnvVar: z.string().min(1),
    loginUrl: z.string().url().optional(),
    postLoginUrlContains: z.string().optional(),
}).optional();

const DEFAULT_VIEWPORTS: z.infer<typeof ViewportSchema>[] = [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'mobile', width: 375, height: 667 },
];

const WCAG_LEVEL_STANDARDS: Record<'A' | 'AA' | 'AAA', string[]> = {
    A: ['wcag2a'],
    AA: ['wcag2a', 'wcag2aa', 'wcag21aa'],
    AAA: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag2aaa', 'wcag21aaa'],
};

// Well-known WCAG rule families — used as Scenario headings so each Scenario
// probes ONE family of violations. Descriptions are short + consumer-safe.
const WCAG_RULE_FAMILIES: Array<{ family: string; tag: string; description: string }> = [
    { family: 'Color contrast', tag: 'color-contrast', description: 'Text and interactive elements meet contrast thresholds.' },
    { family: 'Keyboard navigation', tag: 'keyboard', description: 'Every interactive element is reachable and operable via keyboard.' },
    { family: 'ARIA roles and attributes', tag: 'aria', description: 'ARIA roles, states, and properties are valid and applied correctly.' },
    { family: 'Form labels', tag: 'label', description: 'Every form field has an accessible name (label/aria-label/aria-labelledby).' },
    { family: 'Landmark structure', tag: 'landmarks', description: 'Landmarks (header/main/nav/footer) are present, unique, and non-overlapping.' },
    { family: 'Heading order', tag: 'heading-order', description: 'Heading levels start at h1 and do not skip.' },
    { family: 'Image alternatives', tag: 'image-alt', description: 'Meaningful images carry alt text; decorative images are marked as such.' },
    { family: 'Focus visible', tag: 'focus-order-semantics', description: 'The focused element is visually indicated on every focus transition.' },
    { family: 'Language of page', tag: 'html-has-lang', description: 'The <html> element has a valid lang attribute.' },
    { family: 'Document title', tag: 'document-title', description: 'The document has a non-empty <title>.' },
];

const InputSchema = z.object({
    targetUrl: z.string().url(),
    viewports: z.array(ViewportSchema).optional().describe('Viewports to scan. Default: desktop 1920x1080, tablet 1024x768, mobile 375x667.'),
    wcagLevel: z.enum(['A', 'AA', 'AAA']).default('AA'),
    standards: z.array(z.string()).optional().describe('axe-core standards tags (wcag2a, wcag2aa, wcag21aa, best-practice). Defaults derived from wcagLevel.'),
    ignoreRules: z.array(z.string()).default([]).describe('axe rule IDs to skip (e.g. "color-contrast" if the design deliberately deviates).'),
    authTokenEnvVar: z.string().optional().describe('If set, the generated helper reads this env var and injects Authorization: Bearer <token>.'),
    loginFlow: LoginFlowSchema.describe('Optional login flow — same shape as verify_locators_live. The helper runs it once per test before axe.run().'),
    outputRoot: z.string().default('test/a11y'),
    createAdoTc: z.boolean().default(false),
    planId: z.number().int().positive().optional(),
    planName: z.string().optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().optional(),
    linkToStoryId: z.number().int().positive().optional(),
    dryRun: z.boolean().default(false),
    confirmed: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
});
type Input = z.infer<typeof InputSchema>;

const EmittedFeatureSchema = z.object({
    path: z.string(),
    viewport: z.string(),
    scenarios: z.array(z.string()),
});
const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.literal('gen-a11y-test'),
    targetUrl: z.string(),
    wcagLevel: z.enum(['A', 'AA', 'AAA']),
    standards: z.array(z.string()),
    viewportsGenerated: z.number(),
    featureFilesGenerated: z.array(EmittedFeatureSchema).default([]),
    stepDefFiles: z.array(z.string()).default([]),
    helperFile: z.string().optional(),
    readmeFile: z.string().optional(),
    envTemplateFile: z.string().optional(),
    tcsCreated: z.number().optional(),
    tcsSkipped: z.array(z.object({ scenario: z.string(), reason: z.string() })).optional(),
    requiresConfirmation: z.boolean().optional(),
    destructive: z.boolean().optional(),
    confirmationHint: z.string().optional(),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Helpers
// =============================================================================

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}
function pascal(s: string): string {
    return s.replace(/(?:^|[^a-zA-Z0-9])([a-zA-Z])/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
}
function jsStr(s: string): string { return JSON.stringify(s); }
function jsArr(a: string[]): string { return JSON.stringify(a); }

function resolveStandards(input: Input): string[] {
    if (input.standards && input.standards.length > 0) return input.standards;
    return WCAG_LEVEL_STANDARDS[input.wcagLevel];
}

function pageSlug(url: string): string {
    try {
        const u = new URL(url);
        return slugify(u.pathname === '/' ? u.hostname : u.pathname);
    } catch { return 'page'; }
}

function pageTitle(url: string): string {
    try {
        const u = new URL(url);
        const seg = u.pathname === '/' ? u.hostname : u.pathname.replace(/^\/+|\/+$/g, '').replace(/\/+/g, ' ');
        return seg.length > 0 ? seg : 'Homepage';
    } catch { return 'Page'; }
}

// =============================================================================
// Emitters
// =============================================================================

interface EmittedFeature { path: string; viewport: string; scenarios: string[] }

function emitFeatureForViewport(args: {
    outputRoot: string;
    targetUrl: string;
    viewport: z.infer<typeof ViewportSchema>;
    wcagLevel: 'A' | 'AA' | 'AAA';
    standards: string[];
    ignoreRules: string[];
}): EmittedFeature {
    const dir = path.join(args.outputRoot, 'features');
    fs.mkdirSync(dir, { recursive: true });
    const slug = pageSlug(args.targetUrl);
    const filePath = path.join(dir, `${slug}-a11y-${slugify(args.viewport.name)}.feature`);
    const title = pageTitle(args.targetUrl);
    const wcagTag = `@wcag${args.wcagLevel.toLowerCase()}`;
    const viewportTag = `@viewport-${slugify(args.viewport.name)}`;
    const standardsComment = args.standards.length > 0 ? `# Standards: ${args.standards.join(', ')}` : '';
    const ignoreComment = args.ignoreRules.length > 0 ? `# Ignored rules: ${args.ignoreRules.join(', ')}` : '';
    const lines: string[] = [];
    lines.push(`@a11y ${wcagTag} ${viewportTag} @auto-generated`);
    lines.push(`Feature: Accessibility — ${title} at ${args.viewport.name} (${args.viewport.width}x${args.viewport.height})`);
    if (standardsComment) lines.push(`  ${standardsComment}`);
    if (ignoreComment) lines.push(`  ${ignoreComment}`);
    lines.push('');
    const scenarios: string[] = [];
    for (const fam of WCAG_RULE_FAMILIES) {
        const scnName = `${fam.family} at ${args.viewport.name}`;
        scenarios.push(scnName);
        lines.push(`  @a11y-${fam.tag}`);
        lines.push(`  Scenario: ${scnName}`);
        lines.push(`    Given the accessibility scanner is loaded against ${args.targetUrl}`);
        lines.push(`    And the viewport is set to ${args.viewport.width}x${args.viewport.height}`);
        lines.push(`    When axe-core scans the page for "${fam.family}"`);
        lines.push(`    Then no ${args.wcagLevel} accessibility violations are reported`);
        lines.push('');
    }
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return { path: filePath, viewport: args.viewport.name, scenarios };
}

function emitStepDefs(args: {
    outputRoot: string;
    viewports: z.infer<typeof ViewportSchema>[];
    wcagLevel: 'A' | 'AA' | 'AAA';
    standards: string[];
    ignoreRules: string[];
    hasAuthToken: boolean;
    hasLoginFlow: boolean;
}): string {
    const stepsDir = path.join(args.outputRoot, 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    const filePath = path.join(stepsDir, 'A11ySteps.ts');
    const familyMapLines = WCAG_RULE_FAMILIES.map((f) => `    ${jsStr(f.family)}: ${jsStr(f.tag)},`).join('\n');
    const source = `import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import type { Page } from '@playwright/test';
import { runA11yScan, type A11yScanOptions } from '../_a11y-helper';

const FAMILY_TO_AXE_TAG: Record<string, string> = {
${familyMapLines}
};

const DEFAULT_STANDARDS: string[] = ${jsArr(args.standards)};
const IGNORE_RULES: string[] = ${jsArr(args.ignoreRules)};
const WCAG_LEVEL = ${jsStr(args.wcagLevel)};

interface A11yState {
    targetUrl?: string;
    viewport?: { width: number; height: number };
    family?: string;
    scanned?: boolean;
    violationCount?: number;
    critical?: number;
    serious?: number;
    moderate?: number;
    minor?: number;
    lastReport?: unknown;
}

const state: A11yState = {};

export class A11ySteps {
    @CSBDDStepDef('the accessibility scanner is loaded against (\\\\S+)')
    async scannerLoaded(url: string): Promise<void> {
        state.targetUrl = url;
        state.scanned = false;
        state.violationCount = undefined;
        CSReporter.info(\`Accessibility scanner target set: \${url}\`);
    }

    @CSBDDStepDef('the viewport is set to (\\\\d+)x(\\\\d+)')
    async setViewport(widthS: string, heightS: string): Promise<void> {
        state.viewport = { width: parseInt(widthS, 10), height: parseInt(heightS, 10) };
        CSReporter.info(\`Viewport set to \${state.viewport.width}x\${state.viewport.height}\`);
    }

    @CSBDDStepDef('axe-core scans the page for "([^"]+)"')
    async scanForFamily(family: string): Promise<void> {
        if (!state.targetUrl || !state.viewport) throw new Error('scanner or viewport not set');
        state.family = family;
        const axeTag = FAMILY_TO_AXE_TAG[family];
        const options: A11yScanOptions = {
            targetUrl: state.targetUrl,
            viewport: state.viewport,
            standards: DEFAULT_STANDARDS,
            includeRules: axeTag ? [axeTag] : undefined,
            ignoreRules: IGNORE_RULES,
        };
        const page = (this as unknown as { page?: Page }).page;
        if (!page) throw new Error('A11ySteps requires a Playwright Page — attach page to \`this\` via the framework hooks.');
        const report = await runA11yScan(page, options);
        state.lastReport = report;
        state.violationCount = report.violations.length;
        state.critical = report.violations.filter((v) => v.impact === 'critical').length;
        state.serious = report.violations.filter((v) => v.impact === 'serious').length;
        state.moderate = report.violations.filter((v) => v.impact === 'moderate').length;
        state.minor = report.violations.filter((v) => v.impact === 'minor').length;
        state.scanned = true;
        CSReporter.info(\`axe scan complete: \${state.violationCount} violation(s) (critical=\${state.critical}, serious=\${state.serious})\`);
    }

    @CSBDDStepDef('no (A|AA|AAA) accessibility violations are reported')
    async assertNoViolations(level: string): Promise<void> {
        if (!state.scanned) throw new Error('no scan captured');
        const total = state.violationCount ?? 0;
        if (level !== WCAG_LEVEL) {
            CSReporter.warn(\`step-declared level \${level} does not match configured WCAG_LEVEL \${WCAG_LEVEL} — asserting against configured level.\`);
        }
        if (total > 0) {
            const rep = state.lastReport as { violations: Array<{ id: string; impact?: string; help?: string; nodes?: unknown[] }> };
            const summary = rep.violations.slice(0, 5).map((v) => \`\${v.id} (impact=\${v.impact ?? 'unknown'}): \${v.help ?? ''}\`).join(' | ');
            throw new Error(\`\${WCAG_LEVEL} accessibility violations found: \${total}. First 5: \${summary}\`);
        }
    }
}
`;
    fs.writeFileSync(filePath, source, 'utf-8');
    return filePath;
}

function emitHelper(outputRoot: string, hasAuthToken: boolean, hasLoginFlow: boolean, loginFlow: z.infer<typeof LoginFlowSchema>, warnings: string[]): string {
    const filePath = path.join(outputRoot, '_a11y-helper.ts');
    if (fs.existsSync(filePath)) {
        warnings.push(`_a11y-helper.ts already exists at ${filePath} — kept as-is (generator does not clobber consumer edits).`);
        return filePath;
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    const authBlock = hasAuthToken
        ? `        const token = process.env['\${AUTH_TOKEN_ENV_VAR}'];
        if (token) await page.setExtraHTTPHeaders({ Authorization: 'Bearer ' + token });`
        : '';
    const loginBlock = hasLoginFlow && loginFlow
        ? `    if (LOGIN_FLOW) {
        const loginUrl = LOGIN_FLOW.loginUrl || options.targetUrl;
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
        const u = process.env[LOGIN_FLOW.usernameEnvVar] || '';
        const p = process.env[LOGIN_FLOW.passwordEnvVar] || '';
        if (!u || !p) throw new Error('Login credentials missing — set ' + LOGIN_FLOW.usernameEnvVar + ' + ' + LOGIN_FLOW.passwordEnvVar);
        await page.locator(LOGIN_FLOW.usernameSelector).fill(u);
        await page.locator(LOGIN_FLOW.passwordSelector).fill(p);
        await page.locator(LOGIN_FLOW.submitSelector).click();
        if (LOGIN_FLOW.postLoginUrlContains) {
            await page.waitForURL((url) => url.toString().includes(LOGIN_FLOW.postLoginUrlContains!), { timeout: 30000 });
        } else {
            await page.waitForLoadState('networkidle', { timeout: 30000 });
        }
        CSReporter.info('Login flow completed for accessibility scan');
    }`
        : '';
    const loginConst = hasLoginFlow && loginFlow
        ? `const LOGIN_FLOW = ${JSON.stringify(loginFlow, null, 4)};`
        : `const LOGIN_FLOW: null = null;`;
    const authConst = hasAuthToken
        ? `const AUTH_TOKEN_ENV_VAR = ${JSON.stringify('AUTH_TOKEN')};`
        : `// (no auth token env var configured)`;
    const source = `/* eslint-disable */
/**
 * Auto-generated by cs_qa_gen_a11y_test. Safe to edit; the generator will not
 * clobber this file if it already exists.
 *
 * Wraps @axe-core/playwright — imported lazily so the scaffold compiles even
 * before consumers install the axe deps. Install with:
 *   npm i --save-dev @axe-core/playwright axe-core
 */
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import type { Page } from '@playwright/test';

${authConst}
${loginConst}

export interface A11yScanOptions {
    targetUrl: string;
    viewport: { width: number; height: number };
    standards: string[];
    includeRules?: string[];
    ignoreRules?: string[];
}

export interface A11yViolationNode {
    html: string;
    target: string[];
    failureSummary?: string;
}
export interface A11yViolation {
    id: string;
    impact?: 'minor' | 'moderate' | 'serious' | 'critical';
    tags: string[];
    description: string;
    help: string;
    helpUrl: string;
    nodes: A11yViolationNode[];
}
export interface A11yScanReport {
    url: string;
    timestamp: string;
    violations: A11yViolation[];
    passes: number;
    inapplicable: number;
    incomplete: number;
}

async function loadAxeBuilder(): Promise<any> {
    try {
        const mod = await import('@axe-core/playwright');
        return (mod as any).default || (mod as any).AxeBuilder || mod;
    } catch (e) {
        throw new Error('Missing dependency @axe-core/playwright. Install with: npm i --save-dev @axe-core/playwright axe-core');
    }
}

export async function runA11yScan(page: Page, options: A11yScanOptions): Promise<A11yScanReport> {
    const AxeBuilder = await loadAxeBuilder();
    await page.setViewportSize(options.viewport);
${authBlock}
${loginBlock}
    if (!page.url().includes(options.targetUrl) && !options.targetUrl.startsWith('data:')) {
        await page.goto(options.targetUrl, { waitUntil: 'domcontentloaded' });
    }
    let builder = new AxeBuilder({ page });
    if (options.standards && options.standards.length > 0) builder = builder.withTags(options.standards);
    if (options.includeRules && options.includeRules.length > 0) builder = builder.withRules(options.includeRules);
    if (options.ignoreRules && options.ignoreRules.length > 0) builder = builder.disableRules(options.ignoreRules);
    CSReporter.info('Running axe scan with tags=' + JSON.stringify(options.standards) + ' includeRules=' + JSON.stringify(options.includeRules || []) + ' ignoreRules=' + JSON.stringify(options.ignoreRules || []));
    const results: any = await builder.analyze();
    const report: A11yScanReport = {
        url: results.url || options.targetUrl,
        timestamp: new Date().toISOString(),
        violations: (results.violations || []).map((v: any) => ({
            id: v.id,
            impact: v.impact,
            tags: v.tags || [],
            description: v.description || '',
            help: v.help || '',
            helpUrl: v.helpUrl || '',
            nodes: (v.nodes || []).map((n: any) => ({
                html: n.html || '',
                target: n.target || [],
                failureSummary: n.failureSummary,
            })),
        })),
        passes: (results.passes || []).length,
        inapplicable: (results.inapplicable || []).length,
        incomplete: (results.incomplete || []).length,
    };
    CSReporter.info('axe scan complete: ' + report.violations.length + ' violations, ' + report.passes + ' passes');
    return report;
}
`;
    fs.writeFileSync(filePath, source, 'utf-8');
    return filePath;
}

function emitReadme(outputRoot: string, targetUrl: string, viewports: z.infer<typeof ViewportSchema>[], wcagLevel: string, standards: string[]): string {
    const filePath = path.join(outputRoot, 'README.md');
    const viewportLines = viewports.map((v) => `- ${v.name} — ${v.width}x${v.height}`).join('\n');
    const contents = `# Accessibility Test Suite

Auto-generated by \`cs_qa_gen_a11y_test\`.

## Target
- URL: ${targetUrl}
- WCAG level: ${wcagLevel}
- axe-core standards: ${standards.join(', ')}

## Viewports
${viewportLines}

## Install
This scaffold expects axe-core + Playwright bindings. Install once:

\`\`\`bash
npm i --save-dev @axe-core/playwright axe-core
\`\`\`

## Run
\`\`\`bash
npx cs-playwright test --grep @a11y
\`\`\`

Filter by viewport:

\`\`\`bash
npx cs-playwright test --grep "@a11y and @viewport-desktop"
\`\`\`

## Credentials
Any credential or auth-token env vars declared for this suite are recorded in
\`.env.template\` with an \`ENCRYPTED:\` placeholder. Encrypt real values via the
framework CLI and paste the ciphertext after the prefix.

## Notes
- Each Scenario probes ONE WCAG rule family so failures land per-family.
- Ignored rules are declared in the generated steps file; extend by editing the
  IGNORE_RULES constant OR by re-running the generator with an expanded
  \`ignoreRules\` argument.
- Baseline suppressions belong in a companion file — this scaffold does NOT
  auto-suppress violations.
`;
    fs.writeFileSync(filePath, contents, 'utf-8');
    return filePath;
}

function emitEnvTemplate(outputRoot: string, hasAuthToken: boolean, loginFlow: z.infer<typeof LoginFlowSchema>): string {
    const filePath = path.join(outputRoot, '.env.template');
    let existing = '';
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
    const lines: string[] = [];
    const push = (k: string) => { if (!existing.includes(`${k}=`) && !lines.some((l) => l.startsWith(`${k}=`))) lines.push(`${k}=ENCRYPTED:`); };
    if (hasAuthToken) push('AUTH_TOKEN');
    if (loginFlow) {
        push(loginFlow.usernameEnvVar);
        push(loginFlow.passwordEnvVar);
    }
    if (existing.length === 0 && lines.length === 0) {
        lines.push('# Auto-generated by cs_qa_gen_a11y_test. Encrypt values via `cs-playwright-mcp encrypt <plain>` and paste after ENCRYPTED:.');
    }
    const finalText = existing + (lines.length > 0 ? (existing.length > 0 && !existing.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n' : '');
    fs.writeFileSync(filePath, finalText, 'utf-8');
    return filePath;
}

// =============================================================================
// ADO TC creation
// =============================================================================

function composeTcDescription(family: string, viewport: string, targetUrl: string, wcagLevel: string): string {
    const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div><h3>Accessibility Test</h3>
<p><strong>Target URL:</strong> <code>${esc(targetUrl)}</code></p>
<p><strong>WCAG level:</strong> ${esc(wcagLevel)}</p>
<p><strong>Viewport:</strong> ${esc(viewport)}</p>
<p><strong>Rule family:</strong> ${esc(family)}</p>
<p>Generated by <code>cs_qa_gen_a11y_test</code>. Powered by axe-core.</p></div>`;
}

function composeTcStepsXml(family: string, viewport: string, targetUrl: string, wcagLevel: string): string {
    const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const rows: string[] = [];
    let i = 1;
    const step = (id: number, type: string, action: string, expected: string): string =>
        `<step id="${id}" type="${type}"><parameterizedString isformatted="true">&lt;P&gt;${esc(action)}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc(expected)}&lt;/P&gt;</parameterizedString><description/></step>`;
    rows.push(step(i++, 'PreCondition', `Test environment reachable at ${targetUrl}. axe-core installed.`, 'Environment ready.'));
    rows.push(step(i++, 'ActionStep', `Set viewport to ${viewport} and load ${targetUrl}`, 'Page loaded.'));
    rows.push(step(i++, 'ActionStep', `Run axe-core scan restricted to family "${family}"`, `Zero WCAG ${wcagLevel} violations for "${family}".`));
    return `<steps id="0" last="${i - 1}">${rows.join('')}</steps>`;
}

// =============================================================================
// Registration
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_gen_a11y_test',
    description: 'Emit an axe-core accessibility test scaffold for a target URL. One .feature per viewport (defaults: desktop/tablet/mobile), one Scenario per WCAG rule family, tagged @a11y @wcag<level>. Generates a lazy-import axe helper, a step-defs class that uses CSReporter and the framework BDD decorators, a README with install hints, and .env.template with ENCRYPTED: placeholders for auth-token/login credentials. Optional ADO Test Case bulk creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`). On-prem safe.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, rawInput) => {
        // Defensive defaults — the primitive runner doesn't Zod-parse inputs.
        const input: Input = {
            ...rawInput,
            wcagLevel: rawInput.wcagLevel || 'AA',
            ignoreRules: rawInput.ignoreRules || [],
            outputRoot: rawInput.outputRoot || 'test/a11y',
            createAdoTc: rawInput.createAdoTc === true,
            dryRun: rawInput.dryRun === true,
            confirmed: rawInput.confirmed === true,
        };
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_a11y_test', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const viewports = input.viewports && input.viewports.length > 0 ? input.viewports : DEFAULT_VIEWPORTS;
        const standards = resolveStandards(input);
        const outputRoot = path.isAbsolute(input.outputRoot) ? input.outputRoot : path.join(ctx.workspaceRoot, input.outputRoot);

        log.info('cs_qa_gen_a11y_test start', {
            targetUrl: input.targetUrl,
            viewportCount: viewports.length,
            wcagLevel: input.wcagLevel,
            standards,
            createAdoTc: input.createAdoTc,
            dryRun: input.dryRun,
        });

        const featureFilesGenerated: EmittedFeature[] = [];
        const stepDefFiles: string[] = [];
        let helperFile: string | undefined;
        let readmeFile: string | undefined;
        let envTemplateFile: string | undefined;

        if (input.dryRun) {
            const slug = pageSlug(input.targetUrl);
            for (const vp of viewports) {
                const dryPath = path.join(outputRoot, 'features', `${slug}-a11y-${slugify(vp.name)}.feature`);
                featureFilesGenerated.push({ path: dryPath, viewport: vp.name, scenarios: WCAG_RULE_FAMILIES.map((f) => `${f.family} at ${vp.name}`) });
            }
            return {
                ok: true, verb: 'gen-a11y-test', targetUrl: input.targetUrl,
                wcagLevel: input.wcagLevel, standards,
                viewportsGenerated: viewports.length,
                featureFilesGenerated, stepDefFiles, warnings,
                note: `Dry-run: would write ${viewports.length} feature file(s), 1 step-defs file, helper, README, .env.template under ${outputRoot}.`,
            };
        }

        fs.mkdirSync(outputRoot, { recursive: true });
        for (const vp of viewports) {
            const emitted = emitFeatureForViewport({
                outputRoot, targetUrl: input.targetUrl, viewport: vp,
                wcagLevel: input.wcagLevel, standards, ignoreRules: input.ignoreRules,
            });
            featureFilesGenerated.push(emitted);
        }
        stepDefFiles.push(emitStepDefs({
            outputRoot, viewports, wcagLevel: input.wcagLevel, standards,
            ignoreRules: input.ignoreRules,
            hasAuthToken: !!input.authTokenEnvVar,
            hasLoginFlow: !!input.loginFlow,
        }));
        helperFile = emitHelper(outputRoot, !!input.authTokenEnvVar, !!input.loginFlow, input.loginFlow, warnings);
        readmeFile = emitReadme(outputRoot, input.targetUrl, viewports, input.wcagLevel, standards);
        envTemplateFile = emitEnvTemplate(outputRoot, !!input.authTokenEnvVar, input.loginFlow);

        log.info('a11y artefacts written', {
            features: featureFilesGenerated.length,
            stepDefs: stepDefFiles.length,
            helperFile,
            readmeFile,
            envTemplateFile,
        });

        if (!input.createAdoTc) {
            return {
                ok: true, verb: 'gen-a11y-test', targetUrl: input.targetUrl,
                wcagLevel: input.wcagLevel, standards,
                viewportsGenerated: viewports.length,
                featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
                warnings,
                note: `Generated ${featureFilesGenerated.length} feature file(s) for ${viewports.length} viewport(s). Install: npm i --save-dev @axe-core/playwright axe-core.`,
            };
        }

        // ADO TC creation.
        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            warnings.push(credsRes.diagnostic);
            return {
                ok: true, verb: 'gen-a11y-test', targetUrl: input.targetUrl,
                wcagLevel: input.wcagLevel, standards,
                viewportsGenerated: viewports.length,
                featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
                warnings, note: 'Scaffold generated; ADO writes skipped (creds missing).',
            };
        }
        const cfg: AdoCreds = credsRes.creds;
        const plannedTcCount = viewports.length * WCAG_RULE_FAMILIES.length;

        if (input.confirmed !== true) {
            return {
                ok: true, verb: 'gen-a11y-test', targetUrl: input.targetUrl,
                wcagLevel: input.wcagLevel, standards,
                viewportsGenerated: viewports.length,
                featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
                warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create ${plannedTcCount} ADO Test Case(s) (one per WCAG family per viewport) in project ${cfg.project}? No write performed. Retry the SAME call with confirmed:true.`,
                note: 'requires confirmation — retry with confirmed:true',
            };
        }

        const client = new AdoHttpClient(cfg);
        interface TcPayload { family: string; viewport: string; tag: string }
        const payloads: TcPayload[] = [];
        for (const vp of viewports) {
            for (const fam of WCAG_RULE_FAMILIES) {
                payloads.push({ family: fam.family, viewport: vp.name, tag: fam.tag });
            }
        }
        const bulk = await bulkExecute(payloads, {
            chunkSize: 1,
            concurrency: 4,
            workFn: async (batch) => {
                const p = batch[0];
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.Title', value: `A11y ${input.wcagLevel} — ${p.family} at ${p.viewport}` },
                    { op: 'add', path: '/fields/System.Description', value: composeTcDescription(p.family, p.viewport, input.targetUrl, input.wcagLevel) },
                    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: composeTcStepsXml(p.family, p.viewport, input.targetUrl, input.wcagLevel) },
                    { op: 'add', path: '/fields/System.Tags', value: `a11y; auto-generated; wcag-${input.wcagLevel.toLowerCase()}; viewport-${slugify(p.viewport)}; a11y-${p.tag}` },
                ];
                if (input.linkToStoryId) {
                    patch.push({
                        op: 'add', path: '/relations/-',
                        value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkToStoryId}` },
                    });
                }
                const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Test%20Case?api-version=7.0`, patch);
                return [{ tcId: Number(created.id || 0), scenario: `${p.family} at ${p.viewport}` }];
            },
            onChunkError: (err, chunk) => {
                log.warn('A11y TC creation failed', { scenario: `${chunk[0].family} at ${chunk[0].viewport}`, error: err.message });
            },
        });
        const tcsSkipped = bulk.failed.map((f) => ({ scenario: `${f.item.family} at ${f.item.viewport}`, reason: f.error.message }));

        return {
            ok: true, verb: 'gen-a11y-test', targetUrl: input.targetUrl,
            wcagLevel: input.wcagLevel, standards,
            viewportsGenerated: viewports.length,
            featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
            tcsCreated: bulk.ok.length, tcsSkipped, warnings,
            note: `Generated ${featureFilesGenerated.length} feature file(s) + ${bulk.ok.length} ADO TC(s).${tcsSkipped.length > 0 ? ` ${tcsSkipped.length} TC(s) skipped.` : ''}`,
        };
    },
});

// Explicit re-exports for smoke tests that want to unit-test individual helpers.
export const _internals = {
    WCAG_RULE_FAMILIES,
    WCAG_LEVEL_STANDARDS,
    slugify,
    pageSlug,
    resolveStandards,
};
