/**
 * cs_qa_log_failures_as_bugs — orchestrate ADO Bug/Defect creation from the
 * latest test report.
 *
 * Behaviour:
 *   1. Discover the most recent test report (or the one specified).
 *   2. Extract every failed scenario with: name, feature, tags, failing step,
 *      error class, error message, stack top-frame, screenshot(s).
 *   3. Group by NORMALIZED FAILURE SIGNATURE (errorClass + normalized step +
 *      normalized message). Same "root cause" ⇒ same group.
 *   4. Decision:
 *        - 1 group ⇒ auto-file 1 bug with N scenarios listed.
 *        - N groups + no explicit `bugCreationStrategy` ⇒ return
 *          `requiresChoice:true` with the group summary. Caller (Copilot)
 *          shows to the human, gets their pick, retries with
 *          `bugCreationStrategy: 'separate' | 'consolidated'`.
 *   5. Work-item type:
 *        - `workItemTypeStrategy:'auto'` (default) ⇒ env=prod ⇒ 'Defect',
 *          else 'Bug'.
 *        - 'always-bug' / 'always-defect' overrides.
 *        - `workItemTypeOverride` string forces any WI type name (for
 *          non-standard ADO process templates).
 *   6. Screenshots attached always. Full test-results ZIP attached ONLY when
 *      `attachFullArtifactZip:true` (explicit opt-in).
 *   7. Two-phase write gate: `confirmed:true` required for any actual
 *      ADO POST. Without it, tool runs a preview pass and returns
 *      `requiresConfirmation:true` with what would be created.
 *   8. Dedupe against existing OPEN bugs/defects tagged with the same
 *      signature (`auto-bug-sig-<hash8>`). Skipped items are reported.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';
import { getResolvedCreds } from './ado_config_tool';
import { selectFailures, type FailedScenario } from '../../../cli/CSFailureSelector';
import { normalizeSignature } from './_helpers/signature_normalizer';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
    reportFrom: z.string().optional().describe('Explicit report dir or report-data.json (else auto-discover latest).'),
    reportsBase: z.string().optional().describe('Reports base dir. Default: reports/'),
    environment: z.string().optional().describe('Env override. Else read from workspace config. Determines Bug vs Defect when workItemTypeStrategy is "auto".'),
    workItemTypeStrategy: z.enum(['auto', 'always-bug', 'always-defect']).default('auto'),
    workItemTypeOverride: z.string().optional().describe('Force a specific ADO WI type name (e.g. "Issue", "Incident") — overrides strategy.'),
    bugCreationStrategy: z.enum(['separate', 'consolidated']).optional().describe('When failures cluster into MULTIPLE distinct groups, choose whether to file N separate bugs (one per group) or 1 consolidated bug. Omit on first call — tool returns requiresChoice:true when a choice is needed. Then retry with the picked strategy.'),
    bugAreaPath: z.string().optional().describe('System.AreaPath for created WIs.'),
    bugIterationPath: z.string().optional().describe('System.IterationPath for created WIs.'),
    assignedTo: z.string().optional().describe('Assignee email/name for created WIs.'),
    severity: z.enum(['1 - Critical', '2 - High', '3 - Medium', '4 - Low']).default('3 - Medium'),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2),
    tags: z.array(z.string()).default([]).describe('Extra tags to add to every created WI (in addition to auto-generated signature + env tags).'),
    linkToStoryId: z.number().int().positive().optional().describe('Related-link every created WI to this story (System.LinkTypes.Related).'),
    attachScreenshots: z.boolean().default(true),
    systemInfoExtra: z.record(z.string(), z.string()).optional().describe('Extra key-value rows to append to Microsoft.VSTS.TCM.SystemInfo. Useful for project-specific fields the report does not carry (e.g. build number, deploy id, region, feature-flag state). Applied to every bug/defect created in this run.'),
    screenshotExtensions: z.array(z.string()).default(['.png', '.jpg', '.jpeg', '.webp']).describe('File extensions to treat as screenshot attachments when scanning step logs / step.screenshot fields.'),
    attachFullArtifactZip: z.boolean().default(false).describe('Zip the entire test-results dir and attach it. Off by default — must be explicitly enabled.'),
    dedupeAgainstExisting: z.boolean().default(true).describe('Before creating, query ADO for open bugs with the same signature tag. Skip if a match exists (reported).'),
    filters: z.object({
        features: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        testNames: z.array(z.string()).optional(),
    }).optional(),
    titlePrefix: z.string().optional().describe('Optional prefix to prepend to every created WI title.'),
    dryRun: z.boolean().default(false).describe('Do not call ADO at all — return the plan.'),
    confirmed: z.boolean().default(false).describe('Two-phase gate. Without confirmed:true, the tool returns requiresConfirmation:true with a preview of every WI that would be created. Retry with confirmed:true (and the same inputs) to actually create.'),
    orgUrl: z.string().optional(),
    project: z.string().optional(),
    pat: z.string().optional(),
});
type Input = z.infer<typeof InputSchema>;

const GroupPreviewSchema = z.object({
    signature: z.string(),
    signatureFingerprint: z.string(),
    scenarioCount: z.number(),
    sampleScenario: z.string(),
    sampleErrorMessage: z.string(),
    affectedScenarios: z.array(z.string()),
    affectedFeatures: z.array(z.string()),
    stepThatFailed: z.string(),
    errorClass: z.string(),
});

const CreatedWiSchema = z.object({
    id: z.number(),
    url: z.string(),
    title: z.string(),
    workItemType: z.string(),
    signatureFingerprint: z.string(),
    attachedScreenshotCount: z.number(),
    attachedZip: z.boolean(),
    linkedTestCaseIds: z.array(z.number()).default([]),
    linkedStoryIds: z.array(z.number()).default([]),
});

const SkippedWiSchema = z.object({
    signatureFingerprint: z.string(),
    existingBugId: z.number().optional(),
    reason: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.literal('log-failures-as-bugs'),
    reportUsed: z.string().nullable(),
    environment: z.string().nullable(),
    workItemType: z.string(),
    totalFailures: z.number(),
    distinctFailureGroups: z.number(),
    strategyChosen: z.string().nullable(),
    requiresChoice: z.boolean().optional(),
    choicePrompt: z.string().optional(),
    requiresConfirmation: z.boolean().optional(),
    confirmationHint: z.string().optional(),
    groups: z.array(GroupPreviewSchema),
    plannedWorkItems: z.array(z.object({
        title: z.string(),
        workItemType: z.string(),
        signatureFingerprints: z.array(z.string()),
        scenariosIncluded: z.array(z.string()),
        attachmentsPlanned: z.number(),
        linkedTestCaseIdsPlanned: z.array(z.number()).default([]),
        linkedStoryIdsPlanned: z.array(z.number()).default([]),
    })),
    created: z.array(CreatedWiSchema).optional(),
    skipped: z.array(SkippedWiSchema).optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Report enrichment — pull step-level error/screenshot detail
// ---------------------------------------------------------------------------

interface EnrichedFailure {
    scenario: FailedScenario;
    stepThatFailed: string;
    errorClass: string;
    errorMessage: string;
    stack: string;
    selector: string | undefined;
    screenshots: string[];
    signature: { canonical: string; fingerprint: string; parts: { errorClass: string; topFrame: string; selector?: string; rawMessage?: string } };
}

interface RawReportForEnrich {
    suite?: { scenarios?: RawScenarioForEnrich[] };
    scenarios?: RawScenarioForEnrich[];
}
interface RawScenarioForEnrich {
    name?: string;
    status?: string;
    feature?: string;
    steps?: Array<{ name?: string; status?: string; error?: { message?: string; class?: string; stack?: string } | string; screenshot?: string; logs?: Array<string | { level?: string; message?: string }> }>;
    tags?: string[];
}

function loadReportRaw(reportDataPath: string): RawReportForEnrich | null {
    try { return JSON.parse(fs.readFileSync(reportDataPath, 'utf-8')) as RawReportForEnrich; }
    catch { return null; }
}

function normalizeReportScenarios(raw: RawReportForEnrich): RawScenarioForEnrich[] {
    if (Array.isArray(raw.suite?.scenarios)) return raw.suite!.scenarios as RawScenarioForEnrich[];
    if (Array.isArray(raw.scenarios)) return raw.scenarios;
    return [];
}

function extractErrorClass(errorText: string): string {
    if (!errorText) return 'Error';
    // Explicit classes first — most reliable.
    const explicit = errorText.match(/^(?<cls>[A-Z][A-Za-z]+(?:Error|Exception|Failure|Timeout)):/);
    if (explicit && explicit.groups?.cls) return explicit.groups.cls;
    // Playwright: strict-mode violation is a very distinct symptom.
    if (/strict\s*mode\s*violation/i.test(errorText)) return 'StrictModeViolation';
    if (/locator\.\w+.*strict\s*mode/i.test(errorText)) return 'StrictModeViolation';
    // Element not found (multiple wording variants).
    if (/unable\s+to\s+locate\s+element|element\s+not\s+found|no\s+such\s+element|locator\s+resolved\s+to\s+0|waiting\s+for\s+locator|no\s+element\s+found/i.test(errorText)) return 'ElementNotFoundError';
    // Assertion families — cover CS framework's "Assert X Failed" wording.
    if (/assert(?:ion)?\s*(?:contains|equals|true|false|not\s*empty|greater|less|matches)?\s*failed/i.test(errorText)) return 'AssertionError';
    if (/expected\b.*(?:actual|but\s+(?:received|got|was))/i.test(errorText)) return 'AssertionError';
    // Timeouts (Playwright + generic).
    if (/timeout|timed\s+out|took\s+too\s+long|deadline\s+exceeded/i.test(errorText)) return 'TimeoutError';
    // Network.
    if (/network|econnrefused|econnreset|etimedout|enotfound|dns_probe|fetch.*failed|ssl.*error/i.test(errorText)) return 'NetworkError';
    // Navigation / page load.
    if (/navigation.*(fail|abort)|page\s+crashed|net::err_/i.test(errorText)) return 'NavigationError';
    // Auth.
    if (/401|403|unauthori[sz]ed|forbidden|permission\s+denied/i.test(errorText)) return 'AuthError';
    return 'Error';
}

function extractSelector(errorText: string): string | undefined {
    const xp = errorText.match(/xpath[=:]\s*['"]?([^'"\s]+)['"]?/i);
    if (xp) return `xpath=${xp[1]}`;
    // Playwright: `locator('<selector>')`
    const pw = errorText.match(/locator\(\s*['"]([^'"]+)['"]/);
    if (pw) return pw[1];
    const css = errorText.match(/(?:selector|locator)[:=]\s*['"]?([^'"\s]+)['"]?/i);
    if (css) return css[1];
    return undefined;
}

/**
 * Semantic normalization applied BEFORE signature hashing so different
 * scenarios that hit the same root cause (e.g. same ambiguous locator with
 * different rendered heading text) collapse into ONE bug group.
 */
function normalizeErrorForGrouping(text: string): string {
    if (!text) return '';
    let out = text;
    // Playwright strict-mode: everything after "resolved to N elements" is a
    // per-scenario dump of the matched elements. Truncate hard.
    out = out.replace(/resolved to \d+ elements?[\s\S]*$/i, 'resolved to <N> elements');
    // Same for other verbose element listings.
    out = out.replace(/found\s+\d+\s+matches?[\s\S]*$/gi, 'found <N> matches');
    out = out.replace(/matches\s+\d+\s+elements?[\s\S]*$/gi, 'matches <N> elements');
    // Any remaining HTML tag content — scenario-specific text inside <tag>...</tag>.
    out = out.replace(/<[a-zA-Z][^>]*>[\s\S]*?<\/[a-zA-Z]+>/g, '<TAG/>');
    out = out.replace(/<[a-zA-Z][^>]*>/g, '<TAG>');
    // Playwright's getByRole helper and its arguments are scenario-specific.
    out = out.replace(/getByRole\([^)]*\)/g, 'getByRole(...)');
    out = out.replace(/getByText\([^)]*\)/g, 'getByText(...)');
    out = out.replace(/getBy\w+\([^)]*\)/g, 'getBy(...)');
    // "aka …" hints Playwright appends after primary error line.
    out = out.replace(/\s+aka\s+[\s\S]*$/gm, '');
    // Line/column suffixes.
    out = out.replace(/at\s+line\s+\d+/gi, 'at line <L>');
    // Collapse whitespace.
    out = out.replace(/\s+/g, ' ').trim();
    return out;
}

function enrichFailures(reportDir: string, failures: FailedScenario[]): { enriched: EnrichedFailure[]; warnings: string[] } {
    const warnings: string[] = [];
    const enriched: EnrichedFailure[] = [];
    const raw = loadReportRaw(path.join(reportDir, 'report-data.json'));
    if (!raw) { warnings.push(`Could not re-read report at ${reportDir} for step enrichment.`); return { enriched: failures.map((f) => bareEnrich(f)), warnings }; }
    const rawScenarios = normalizeReportScenarios(raw);
    // Candidate screenshot roots — reports may live in <test-results-*>/reports
    // while screenshots live at <test-results-*>/screenshots (peer, not child).
    const testResultsDir = path.resolve(reportDir, '..');
    const screenshotRoots = [
        reportDir,
        path.join(reportDir, 'screenshots'),
        testResultsDir,
        path.join(testResultsDir, 'screenshots'),
    ];
    for (const f of failures) {
        // Match by scenario name only — feature field on the failure is now
        // a resolved file path (from CSFailureSelector), while the report
        // stores the human feature name. Name uniqueness within the report
        // is high enough that scenario-name is the reliable join key.
        const rs = rawScenarios.find((s) => (s.name || '').trim() === f.name.trim());
        if (!rs || !Array.isArray(rs.steps)) { enriched.push(bareEnrich(f)); continue; }
        const failedStep = rs.steps.find((s) => {
            const st = String(s.status || '').toLowerCase();
            return st === 'failed' || st === 'broken';
        }) ?? rs.steps[rs.steps.length - 1];
        const stepName = String(failedStep?.name || '<unknown step>');
        let errorText = '';
        let stack = '';
        let errorClassFromError: string | undefined;
        if (failedStep?.error) {
            if (typeof failedStep.error === 'string') {
                errorText = failedStep.error;
            } else {
                errorText = String(failedStep.error.message || '');
                stack = String(failedStep.error.stack || '');
                if (failedStep.error.class) errorClassFromError = String(failedStep.error.class);
            }
        }
        // Fallback — mine step logs for the assertion / failure message.
        if (!errorText && Array.isArray(failedStep?.logs)) {
            for (const l of failedStep.logs) {
                const s = typeof l === 'string' ? l : String(l.message || '');
                if (/assert.*fail|error|timeout|exception|expected.*(actual|but received)/i.test(s)) {
                    errorText = s.replace(/^\[\w+\]\s*[✓ℹ✗×]?\s*/, '').trim();
                    break;
                }
            }
        }
        const errorClass = errorClassFromError || extractErrorClass(errorText);
        const selector = extractSelector(errorText);

        // Collect screenshots — from step.screenshot AND from log lines like
        // "[info] ℹ … screenshot saved: <file>".
        const shotSet = new Set<string>();
        const addShot = (rel: string) => {
            const cleaned = String(rel).trim().replace(/^['"]|['"]$/g, '');
            if (!cleaned) return;
            if (path.isAbsolute(cleaned) && fs.existsSync(cleaned)) { shotSet.add(cleaned); return; }
            for (const root of screenshotRoots) {
                const cand = path.join(root, cleaned);
                if (fs.existsSync(cand)) { shotSet.add(cand); return; }
                // Try bare filename under root/screenshots
                const bare = path.join(root, path.basename(cleaned));
                if (fs.existsSync(bare)) { shotSet.add(bare); return; }
            }
        };
        for (const s of rs.steps) {
            if (s.screenshot && typeof s.screenshot === 'string') addShot(s.screenshot);
            if (Array.isArray(s.logs)) {
                for (const l of s.logs) {
                    const txt = typeof l === 'string' ? l : String(l.message || '');
                    // Match "screenshot saved: <path>" — extension-agnostic.
                    const m = txt.match(/(?:screenshot|snapshot|image)\s+(?:saved|written|captured|at)[:\s]+([^\s"']+\.(?:png|jpe?g|webp|gif|bmp))/i);
                    if (m) addShot(m[1]);
                }
            }
        }
        const screenshots = Array.from(shotSet);
        const groupingMessage = normalizeErrorForGrouping(errorText);
        const sig = normalizeSignature({ errorClass, message: groupingMessage, stack, selector, testId: f.name });
        enriched.push({ scenario: f, stepThatFailed: stepName, errorClass, errorMessage: errorText, stack, selector, screenshots, signature: sig });
    }
    return { enriched, warnings };
}

function bareEnrich(f: FailedScenario): EnrichedFailure {
    const sig = normalizeSignature({ errorClass: 'Error', message: '', stack: '', testId: f.name });
    return { scenario: f, stepThatFailed: '<unknown>', errorClass: 'Error', errorMessage: '', stack: '', selector: undefined, screenshots: [], signature: sig };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface FailureGroup {
    signatureFingerprint: string;
    canonicalSignature: string;
    errorClass: string;
    stepThatFailed: string;
    sampleErrorMessage: string;
    members: EnrichedFailure[];
}

function groupBySignature(enriched: EnrichedFailure[]): FailureGroup[] {
    const byHash = new Map<string, FailureGroup>();
    for (const e of enriched) {
        const key = e.signature.fingerprint;
        if (!byHash.has(key)) {
            byHash.set(key, {
                signatureFingerprint: key,
                canonicalSignature: e.signature.canonical,
                errorClass: e.errorClass,
                stepThatFailed: e.stepThatFailed,
                sampleErrorMessage: e.errorMessage.slice(0, 500),
                members: [],
            });
        }
        byHash.get(key)!.members.push(e);
    }
    return Array.from(byHash.values()).sort((a, b) => b.members.length - a.members.length);
}

// ---------------------------------------------------------------------------
// WI type resolution
// ---------------------------------------------------------------------------

function resolveEnvironment(input: Input, workspaceRoot: string, reportRaw?: unknown, reportDir?: string): string {
    if (input.environment) return input.environment;
    // 1. Report top-level or suite-level env
    if (reportRaw && typeof reportRaw === 'object') {
        const r = reportRaw as Record<string, unknown>;
        for (const k of ['environment', 'env', 'ENVIRONMENT', 'ENV']) {
            const v = r[k];
            if (typeof v === 'string' && v) return v;
        }
        for (const nested of ['suite', 'context', 'meta', 'testData']) {
            const inner = r[nested] as Record<string, unknown> | undefined;
            if (inner) {
                for (const k of ['environment', 'env', 'ENVIRONMENT', 'ENV']) {
                    const v = inner[k];
                    if (typeof v === 'string' && v) return v;
                }
            }
        }
    }
    // 2. cs-playwright-mcp.config.json — walks common nested locations.
    //    (ado.defaults.environment is the CS framework convention.)
    try {
        const cfgPath = path.join(workspaceRoot, 'cs-playwright-mcp.config.json');
        if (fs.existsSync(cfgPath)) {
            const j = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
            const candidates: unknown[] = [
                (j as { environment?: unknown }).environment,
                (j as { env?: unknown }).env,
                ((j as { defaults?: { environment?: unknown } }).defaults || {}).environment,
                (((j as { ado?: { defaults?: { environment?: unknown } } }).ado || {}).defaults || {}).environment,
                ((j as { ado?: { environment?: unknown } }).ado || {}).environment,
                ((j as { qa?: { environment?: unknown } }).qa || {}).environment,
            ];
            for (const c of candidates) if (typeof c === 'string' && c) return c;
        }
    } catch { /* ignore */ }
    // 3. Console-logs artefacts in the run dir — CS framework writes headers
    //    like `Environment: uat`. `console-logs` may be a FILE or a DIR.
    if (reportDir) {
        try {
            const testResultsDir = path.resolve(reportDir, '..');
            const logCandidates: string[] = [];
            for (const f of fs.readdirSync(testResultsDir, { withFileTypes: true })) {
                if (f.isFile() && /^console-logs.*\.(txt|log)$/i.test(f.name)) logCandidates.push(path.join(testResultsDir, f.name));
                else if (f.isDirectory() && /^console-logs/i.test(f.name)) {
                    for (const inner of fs.readdirSync(path.join(testResultsDir, f.name))) {
                        if (/\.(txt|log)$/i.test(inner)) logCandidates.push(path.join(testResultsDir, f.name, inner));
                    }
                }
            }
            for (const p of logCandidates.slice(0, 3)) {
                const head = fs.readFileSync(p, 'utf-8').slice(0, 16384);
                const m = head.match(/environment\s*[:=]\s*['"]?([a-z0-9_-]+)/i);
                if (m) return m[1].toLowerCase();
            }
        } catch { /* ignore */ }
    }
    // 4. Any *.env in workspace root + framework's config layout.
    const envFiles = [
        path.join(workspaceRoot, '.env'),
        path.join(workspaceRoot, 'config', 'global.env'),
        path.join(workspaceRoot, 'config', '.env'),
        path.join(workspaceRoot, 'config', 'common', 'common.env'),
    ];
    for (const p of envFiles) {
        try {
            if (!fs.existsSync(p)) continue;
            const txt = fs.readFileSync(p, 'utf-8');
            const m = txt.match(/^\s*(?:ENVIRONMENT|ENV|NODE_ENV|CS_ENV)\s*=\s*['"]?([a-z0-9_-]+)/mi);
            if (m) return m[1].toLowerCase();
        } catch { /* ignore */ }
    }
    // 5. Walk `config/<project>/environments/*.env` OR `config/<env>/*.env`.
    //    Only treat directory names as env when they match a known env pattern.
    const ENV_NAME_RE = /^(dev|development|sit|uat|preprod|pre-prod|stage|staging|qa|test|prod|production|e2e|local)$/i;
    try {
        const cfgDir = path.join(workspaceRoot, 'config');
        if (fs.existsSync(cfgDir)) {
            const walk = (dir: string, depth: number): string | null => {
                if (depth > 3) return null;
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
                for (const e of entries) {
                    if (e.isDirectory()) {
                        if (ENV_NAME_RE.test(e.name)) return e.name.toLowerCase();
                        const nested = walk(path.join(dir, e.name), depth + 1);
                        if (nested) return nested;
                    }
                }
                return null;
            };
            const guess = walk(cfgDir, 0);
            if (guess) return guess;
        }
    } catch { /* ignore */ }
    // 6. Process env fallback.
    if (process.env.ENVIRONMENT) return process.env.ENVIRONMENT;
    if (process.env.NODE_ENV && process.env.NODE_ENV !== 'production') return process.env.NODE_ENV;
    return 'unknown';
}

function resolveWorkItemType(input: Input, env: string): string {
    if (input.workItemTypeOverride) return input.workItemTypeOverride;
    if (input.workItemTypeStrategy === 'always-bug') return 'Bug';
    if (input.workItemTypeStrategy === 'always-defect') return 'Defect';
    // 'auto'
    return /^prod(uction)?$/i.test(env) ? 'Defect' : 'Bug';
}

// ---------------------------------------------------------------------------
// Description builders
// ---------------------------------------------------------------------------

function severityShortLabel(sev: string | undefined): string {
    if (!sev) return '';
    const m = sev.match(/^(\d)/);
    return m ? `S${m[1]}` : '';
}

function stripScenarioNoise(text: string): string {
    // Take the last quoted term (usually the specific subject e.g. `"Emergency Contacts"`),
    // OR fall back to the whole step trimmed. Keeps the title concrete.
    return text
        .replace(/^\s*(Given|When|Then|And|But)\s+/i, '')
        .replace(/^I\s+/i, '')
        .trim();
}

function buildTitle(group: FailureGroup, workItemType: string, env: string, prefix: string | undefined, severity: string | undefined): string {
    // Deliberate order: [ENV] [SEV] <errorClass> in <feature>: <failing-step>
    // — no duplicate env, no work-item-type in title (that's the record type).
    const pfx = prefix ? `${prefix.replace(/\s+$/, '')} ` : '';
    const envPart = env && env !== 'unknown' ? `[${env.toUpperCase()}] ` : '';
    const sevPart = severity ? `[${severityShortLabel(severity)}] ` : '';
    const feature = uniq(group.members.map((m) => path.basename(m.scenario.feature || '').replace(/\.feature$/i, '')).filter(Boolean))[0] || '';
    const featurePart = feature ? ` in ${feature}` : '';
    const step = group.stepThatFailed && group.stepThatFailed !== '<unknown step>' && group.stepThatFailed !== '<unknown>'
        ? stripScenarioNoise(group.stepThatFailed)
        : (group.members[0]?.scenario.name || 'unknown');
    const count = group.members.length;
    const scopeSuffix = count > 1 ? ` (${count} scenarios)` : '';
    return `${pfx}${envPart}${sevPart}${group.errorClass}${featurePart}: ${step.slice(0, 120)}${scopeSuffix}`.slice(0, 250);
}

function buildConsolidatedTitle(groups: FailureGroup[], workItemType: string, env: string, prefix: string | undefined, severity: string | undefined): string {
    const pfx = prefix ? `${prefix.replace(/\s+$/, '')} ` : '';
    const envPart = env && env !== 'unknown' ? `[${env.toUpperCase()}] ` : '';
    const sevPart = severity ? `[${severityShortLabel(severity)}] ` : '';
    const total = groups.reduce((s, g) => s + g.members.length, 0);
    const feature = uniq(groups.flatMap((g) => g.members).map((m) => path.basename(m.scenario.feature || '').replace(/\.feature$/i, '')).filter(Boolean))[0] || '';
    const featurePart = feature ? ` in ${feature}` : '';
    return `${pfx}${envPart}${sevPart}${total} scenarios fail across ${groups.length} root cause${groups.length === 1 ? '' : 's'}${featurePart}`.slice(0, 250);
}

function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }

function escapeHtml(s: string): string {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface RunContext {
    runTimestamp: string | null;
    baseUrl: string | null;
    browser: string | null;
    browserVersion: string | null;
    os: string | null;
    testUser: string | null;
    frameworkVersion: string | null;
    reportHtmlUrl: string | null;
    reproducibility: string | null;
}

function readFrameworkVersion(workspaceRoot: string): string | null {
    try {
        const p = path.join(workspaceRoot, 'node_modules', '@mdakhan.mak', 'cs-playwright-test-framework', 'package.json');
        if (fs.existsSync(p)) return String(JSON.parse(fs.readFileSync(p, 'utf-8')).version || '');
    } catch { /* ignore */ }
    return null;
}

function readEnvFile(workspaceRoot: string, env: string, key: string): string | null {
    const candidates = [
        path.join(workspaceRoot, 'config', env, 'environments'),
        path.join(workspaceRoot, 'config', 'environments'),
        path.join(workspaceRoot, 'config'),
    ];
    const rx = new RegExp('^\\s*' + key + '\\s*=\\s*(\\S.*)$', 'mi');
    for (const dir of candidates) {
        if (!fs.existsSync(dir)) continue;
        try {
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.env')) continue;
                const txt = fs.readFileSync(path.join(dir, f), 'utf-8');
                const m = rx.exec(txt);
                if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
            }
        } catch { /* ignore */ }
    }
    return null;
}

function runContextFrom(env: string, reportDir: string, workspaceRoot: string, reportRaw: unknown, failuresCount: number, totalCount: number): RunContext {
    const testResultsDir = path.resolve(reportDir, '..');
    const runMatch = path.basename(testResultsDir).match(/test-results-(.+)$/);
    let runTimestamp: string | null = runMatch ? runMatch[1] : null;
    let baseUrl: string | null = null;
    let browser: string | null = null;
    let browserVersion: string | null = null;
    let os: string | null = null;
    let testUser: string | null = null;
    if (reportRaw && typeof reportRaw === 'object') {
        const r = reportRaw as Record<string, unknown>;
        if (typeof r.baseUrl === 'string') baseUrl = r.baseUrl;
        if (typeof r.browser === 'string') browser = r.browser;
        if (typeof r.browserVersion === 'string') browserVersion = r.browserVersion;
        if (typeof r.os === 'string') os = r.os;
        if (typeof r.testUser === 'string') testUser = r.testUser;
        const suite = r.suite as Record<string, unknown> | undefined;
        if (suite) {
            if (!baseUrl && typeof suite.baseUrl === 'string') baseUrl = suite.baseUrl;
            if (!browser && typeof suite.browser === 'string') browser = suite.browser;
            if (!os && typeof suite.os === 'string') os = suite.os;
        }
        if (!runTimestamp && typeof r.generatedAt === 'string') runTimestamp = r.generatedAt;
    }
    if (!baseUrl) baseUrl = readEnvFile(workspaceRoot, env, 'BASE_URL') || readEnvFile(workspaceRoot, env, 'APP_URL') || readEnvFile(workspaceRoot, env, 'LOGIN_URL');
    if (!testUser) testUser = readEnvFile(workspaceRoot, env, 'TEST_USER') || readEnvFile(workspaceRoot, env, 'USERNAME');
    if (!browser) browser = readEnvFile(workspaceRoot, env, 'BROWSER');
    const reportHtmlPath = path.join(reportDir, 'index.html');
    const reportHtmlUrl = fs.existsSync(reportHtmlPath) ? reportHtmlPath : null;
    const frameworkVersion = readFrameworkVersion(workspaceRoot);
    const reproducibility = totalCount > 0
        ? (failuresCount === totalCount ? 'Always (100%)' : `${failuresCount} of ${totalCount} runs failed (${Math.round((failuresCount / totalCount) * 100)}%)`)
        : null;
    return { runTimestamp, baseUrl, browser, browserVersion, os, testUser, frameworkVersion, reportHtmlUrl, reproducibility };
}

/** Populate `Microsoft.VSTS.TCM.SystemInfo` — the field devs look at first
 * when diagnosing an env-related failure. ADO renders this field as HTML;
 * plain-text `\n` newlines are collapsed to spaces by the HTML whitespace
 * rules, so we emit a real HTML table for clean vertical layout. Only rows
 * we actually have are emitted; users can inject project-specific rows via
 * input.systemInfoExtra. */
function buildSystemInfoText(env: string, ctx: RunContext, reportPath: string, workItemType: string, extra?: Record<string, string>): string {
    const rows: Array<[string, string]> = [];
    rows.push(['Environment', env]);
    rows.push(['Work item type', workItemType]);
    if (ctx.baseUrl) rows.push(['App URL', ctx.baseUrl]);
    if (ctx.browser) rows.push(['Browser', ctx.browserVersion ? `${ctx.browser} ${ctx.browserVersion}` : ctx.browser]);
    if (ctx.os) rows.push(['OS', ctx.os]);
    if (ctx.testUser) rows.push(['Test user', ctx.testUser]);
    if (ctx.frameworkVersion) rows.push(['Test framework', ctx.frameworkVersion]);
    if (ctx.reproducibility) rows.push(['Reproducibility', ctx.reproducibility]);
    if (ctx.runTimestamp) rows.push(['Test run', ctx.runTimestamp]);
    rows.push(['Report (JSON)', reportPath]);
    if (ctx.reportHtmlUrl) rows.push(['Report (HTML)', ctx.reportHtmlUrl]);
    if (extra) for (const [k, v] of Object.entries(extra)) if (k && v) rows.push([k, v]);
    const trs = rows.map(([k, v]) => {
        // Auto-link URLs / file paths.
        let cell = escapeHtml(v);
        if (/^https?:\/\//i.test(v)) cell = `<a href="${cell}">${cell}</a>`;
        return `<tr><td style="padding:4px 12px;border:1px solid #ccc;background:#f6f8fa;vertical-align:top"><b>${escapeHtml(k)}</b></td><td style="padding:4px 12px;border:1px solid #ccc;vertical-align:top">${cell}</td></tr>`;
    }).join('');
    return `<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">${trs}</table>`;
}

/** Extract per-scenario STEP-LIKE items from the report. Handles multiple
 * report shapes (BDD steps[], spec-format tests[], flat action logs, or none)
 * so any test-runner output can populate repro steps. */
function extractScenarioSteps(scenarioName: string, reportDir: string): Array<{ name: string; status: string }> {
    const raw = loadReportRaw(path.join(reportDir, 'report-data.json'));
    if (!raw) return [];
    const scenarios = normalizeReportScenarios(raw);
    const rs = scenarios.find((s) => (s.name || '').trim() === scenarioName.trim()) as (RawScenarioForEnrich & { tests?: unknown[]; actions?: unknown[]; commands?: unknown[] }) | undefined;
    if (!rs) return [];
    // Prefer BDD steps[] (Gherkin flavor).
    const stepLike = Array.isArray(rs.steps) ? rs.steps
        : Array.isArray(rs.tests) ? rs.tests
        : Array.isArray(rs.actions) ? rs.actions
        : Array.isArray(rs.commands) ? rs.commands
        : [];
    if (stepLike.length === 0) return [];
    return stepLike.map((s) => {
        const item = s as { name?: string; title?: string; label?: string; text?: string; status?: string; state?: string; result?: string };
        return {
            name: String(item.name || item.title || item.label || item.text || '').trim(),
            status: String(item.status || item.state || item.result || '').toLowerCase(),
        };
    }).filter((s) => s.name);
}

/** Extract test-data values for a specific scenario from its `testData` block
 * in the report. Secrets already masked by the aggregator. */
function extractTestData(scenarioName: string, reportDir: string): Record<string, unknown> | null {
    const raw = loadReportRaw(path.join(reportDir, 'report-data.json'));
    if (!raw) return null;
    const scenarios = normalizeReportScenarios(raw);
    const rs = scenarios.find((s) => (s.name || '').trim() === scenarioName.trim()) as (RawScenarioForEnrich & { testData?: unknown }) | undefined;
    if (!rs || !rs.testData || typeof rs.testData !== 'object') return null;
    return rs.testData as Record<string, unknown>;
}

/** Framework-internal keys that noise up the Test Data table without helping
 * a dev diagnose a bug. Hidden by default. */
const HIDDEN_TESTDATA_KEYS = new Set([
    'usedColumns', 'totalColumns', 'iterationNumber', 'totalIterations',
    '_dataRow', '_rowIndex', '_source', '_meta', '_columns',
]);

function formatArrayInline(arr: unknown[]): string {
    if (arr.length === 0) return '[]';
    // If small + all scalars, join for readability.
    if (arr.length <= 6 && arr.every((x) => x === null || x === undefined || typeof x !== 'object')) {
        return arr.map((x) => String(x ?? '')).join(', ');
    }
    // If it's array of objects with same keys, indicate row count.
    return `[${arr.length} items]`;
}

/** Flatten a possibly-nested testData object to dot-path keys for a compact
 * table. Short scalar arrays are expanded inline. Framework-internal keys
 * are hidden. Test-data source metadata renders as one friendly row. */
function flattenTestData(input: unknown, prefix: string = '', out: Array<[string, string]> = []): Array<[string, string]> {
    if (input === null || input === undefined) return out;
    if (Array.isArray(input)) {
        out.push([prefix || '(array)', formatArrayInline(input)]);
        return out;
    }
    if (typeof input !== 'object') {
        out.push([prefix || '(value)', String(input)]);
        return out;
    }
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (HIDDEN_TESTDATA_KEYS.has(k)) continue;
        const key = prefix ? `${prefix}.${k}` : k;
        if (v === null || v === undefined) { out.push([key, '(null)']); continue; }
        if (Array.isArray(v)) out.push([key, formatArrayInline(v)]);
        else if (typeof v === 'object') flattenTestData(v, key, out);
        else out.push([key, String(v)]);
    }
    return out;
}

function testDataTable(data: Record<string, unknown> | null): string {
    if (!data) return '';
    // If the test data has the framework's row-shape (headers + values arrays),
    // render as a KEY=VALUE row instead of two arrays. Much more useful.
    const headers = (data as { headers?: unknown }).headers;
    const values = (data as { values?: unknown }).values;
    let entries: Array<[string, string]>;
    if (Array.isArray(headers) && Array.isArray(values) && headers.length === values.length) {
        entries = headers.map((h, i) => [String(h), String(values[i] ?? '')]);
        // Surface source metadata as one friendly footer row.
        const src = (data as { source?: { file?: string; filter?: string } }).source;
        if (src && (src.file || src.filter)) {
            entries.push(['(data source)', [src.file, src.filter].filter(Boolean).join(' · filter: ')]);
        }
    } else {
        entries = flattenTestData(data);
    }
    if (entries.length === 0) return '';
    const rows = entries.map(([k, v]) => {
        const truncated = v.length > 200 ? v.slice(0, 200) + '…' : v;
        return `<tr><td style="padding:4px 10px;border:1px solid #ccc;background:#f6f8fa"><b>${escapeHtml(k)}</b></td><td style="padding:4px 10px;border:1px solid #ccc"><code>${escapeHtml(truncated)}</code></td></tr>`;
    }).join('');
    return `<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px"><thead><tr><th style="padding:4px 10px;border:1px solid #ccc;background:#eaeef2">Field</th><th style="padding:4px 10px;border:1px solid #ccc;background:#eaeef2">Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Convert a step / test-description line into a readable repro instruction.
 * Handles: Gherkin (en/es/fr/de), Mocha/Jest describe-it, plain action logs.
 * If the input already reads as a plain user-action sentence, returns as-is. */
function stepToUserAction(stepName: string): string {
    let s = stepName.trim();
    // Gherkin keywords in multiple languages (Cucumber's most common set).
    const gherkinKeywords = /^(Given|When|Then|And|But|Etant donné|Quand|Alors|Dado|Cuando|Entonces|Angenommen|Wenn|Dann|Und|Aber|Dato che|Quando|Allora|Als|Dan|Maar)\s+/i;
    s = s.replace(gherkinKeywords, '');
    // First-person prefix ("I <verb>", "the user <verb>", "user <verb>").
    s = s.replace(/^(I|the user|user|we|they)\s+/i, '');
    // BDD assertion helpers → "verify"
    s = s.replace(/^(should|must|shall)\s+/i, 'verify ');
    // Capitalize first char.
    if (s.length > 0) s = s[0].toUpperCase() + s.slice(1);
    return s;
}

function buildStepsToReproduce(scenarioName: string, scenarioTags: string[], reportDir: string, testData: Record<string, unknown> | null, ctx: RunContext): string {
    const steps = extractScenarioSteps(scenarioName, reportDir);
    const lines: string[] = [];
    // Preconditions — only emit rows we actually have; scenario tags surface
    // role hints for any project convention (@admin, @role:xxx, @api, etc.)
    const preconditions: string[] = [];
    if (ctx.baseUrl) preconditions.push(`Application under test is reachable at <a href="${escapeHtml(ctx.baseUrl)}">${escapeHtml(ctx.baseUrl)}</a>`);
    if (ctx.testUser) preconditions.push(`Test user: <b>${escapeHtml(ctx.testUser)}</b>`);
    const roleHint = scenarioTags.map((t) => t.replace(/^@/, '')).find((t) => /^(role:|admin$|super\b|readonly$)/i.test(t));
    if (roleHint) preconditions.push(`Role / permission: <b>${escapeHtml(roleHint)}</b>`);
    const apiHint = scenarioTags.some((t) => /^@?(api|rest|graphql|soap)$/i.test(t));
    if (apiHint) preconditions.push(`Test category: API — no UI interaction required`);
    if (preconditions.length > 0) {
        lines.push('<b>Preconditions</b>');
        lines.push('<ul>');
        for (const p of preconditions) lines.push(`<li>${p}</li>`);
        lines.push('</ul>');
    }
    lines.push('<b>Steps</b>');
    lines.push('<ol>');
    if (steps.length === 0) {
        // No step-level breakdown available (spec-format without hooks, API-only
        // test, or older report). Fall back to a runnable command hint.
        lines.push(`<li>Reproduce scenario: <code>${escapeHtml(scenarioName)}</code></li>`);
    } else {
        for (const step of steps) {
            const action = stepToUserAction(step.name);
            if (!action) continue;
            const failed = step.status === 'failed' || step.status === 'broken';
            const marker = failed ? ' <b style="color:#c00">← FAILED HERE</b>' : '';
            lines.push(`<li>${escapeHtml(action)}${marker}</li>`);
        }
    }
    lines.push('</ol>');
    if (testData) {
        const t = testDataTable(testData);
        if (t) {
            lines.push('<b>Test data used</b>');
            lines.push(t);
        }
    }
    return lines.join('\n');
}

function buildDescriptionForGroup(group: FailureGroup, env: string, workItemType: string, ctx: RunContext, reportPath: string, reportDir: string): string {
    const lines: string[] = [];
    // 1. Summary — one paragraph the reviewer reads first
    lines.push(`<h3>Summary</h3>`);
    lines.push(`<p><b>${group.members.length}</b> scenario${group.members.length === 1 ? '' : 's'} in <code>${escapeHtml(path.basename(group.members[0].scenario.feature))}</code> fail with <b>${escapeHtml(group.errorClass)}</b> at step: <code>${escapeHtml(group.stepThatFailed)}</code>. Reproducible on <b>${escapeHtml(env.toUpperCase())}</b>. Reproducibility: ${escapeHtml(ctx.reproducibility || 'unknown')}.</p>`);

    // 2. Error text — the actual message
    lines.push(`<h3>Error</h3>`);
    lines.push(`<pre style="white-space:pre-wrap;background:#f6f8fa;padding:8px;border:1px solid #e1e4e8">${escapeHtml(group.sampleErrorMessage || '(no error text captured)')}</pre>`);

    // 3. Expected vs Actual — per scenario, not generic
    lines.push(`<h3>Expected vs Actual</h3>`);
    const rows: string[] = [];
    for (const m of group.members.slice(0, 5)) {
        rows.push(`<tr><td style="padding:4px 10px;border:1px solid #ccc;vertical-align:top">Scenario "${escapeHtml(m.scenario.name)}" completes; step "${escapeHtml(m.stepThatFailed)}" succeeds.</td><td style="padding:4px 10px;border:1px solid #ccc;vertical-align:top">${escapeHtml(m.errorMessage.slice(0, 400) || 'assertion failed')}</td></tr>`);
    }
    if (group.members.length > 5) rows.push(`<tr><td colspan="2" style="padding:4px 10px;border:1px solid #ccc"><i>… and ${group.members.length - 5} more scenario(s) with the same signature</i></td></tr>`);
    lines.push(`<table style="border-collapse:collapse"><thead><tr><th style="padding:4px 10px;border:1px solid #ccc">Expected</th><th style="padding:4px 10px;border:1px solid #ccc">Actual</th></tr></thead><tbody>${rows.join('')}</tbody></table>`);

    // 4. Affected scenarios — flat list
    lines.push(`<h3>Affected scenarios (${group.members.length})</h3><ul>`);
    for (const m of group.members) {
        lines.push(`<li><b>${escapeHtml(m.scenario.name)}</b><br/><small>tags: ${escapeHtml(m.scenario.tags.join(' '))}${m.screenshots.length > 0 ? ` · ${m.screenshots.length} screenshot${m.screenshots.length === 1 ? '' : 's'}` : ''}</small></li>`);
    }
    lines.push(`</ul>`);

    // 5. First scenario's test data (rep as example of the group)
    const firstData = extractTestData(group.members[0].scenario.name, reportDir);
    if (firstData) {
        const t = testDataTable(firstData);
        if (t) {
            lines.push(`<h3>Test data (example — first affected scenario)</h3>${t}`);
        }
    }

    // 6. Metadata
    lines.push(`<hr/><p><small>Failure signature: <code>${escapeHtml(group.signatureFingerprint)}</code> · Report: <code>${escapeHtml(reportPath)}</code></small></p>`);
    return lines.join('\n');
}

function buildReproStepsForGroup(group: FailureGroup, ctx: RunContext, reportDir: string): string {
    // Use the FIRST affected scenario as the canonical repro. Others in the
    // group have the same signature — the reader can generalize.
    const first = group.members[0];
    const data = extractTestData(first.scenario.name, reportDir);
    const scenarioRepro = buildStepsToReproduce(first.scenario.name, first.scenario.tags, reportDir, data, ctx);
    const lines: string[] = [];
    lines.push(`<p><b>Canonical scenario:</b> ${escapeHtml(first.scenario.name)}${group.members.length > 1 ? ` (${group.members.length - 1} other scenario(s) reproduce the same defect — see Description)` : ''}</p>`);
    lines.push(scenarioRepro);
    lines.push(`<hr/><p><b>Expected outcome:</b> the "${escapeHtml(first.stepThatFailed)}" step completes without error.</p>`);
    lines.push(`<p><b>Actual outcome:</b> <code>${escapeHtml((first.errorMessage || 'failure').slice(0, 300))}</code></p>`);
    return lines.join('\n');
}

function buildDescriptionForConsolidated(groups: FailureGroup[], env: string, workItemType: string, ctx: RunContext, reportPath: string, reportDir: string): string {
    const lines: string[] = [];
    const total = groups.reduce((s, g) => s + g.members.length, 0);
    lines.push(`<h3>Summary</h3><p><b>${total}</b> scenario${total === 1 ? '' : 's'} fail on <b>${escapeHtml(env.toUpperCase())}</b> across <b>${groups.length}</b> distinct root cause${groups.length === 1 ? '' : 's'}. Reproducibility: ${escapeHtml(ctx.reproducibility || 'unknown')}.</p>`);
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        lines.push(`<h3>Root cause ${i + 1} of ${groups.length}: ${escapeHtml(g.errorClass)} — ${g.members.length} scenario${g.members.length === 1 ? '' : 's'}</h3>`);
        lines.push(`<p><b>Failing step:</b> <code>${escapeHtml(g.stepThatFailed)}</code></p>`);
        lines.push(`<p><b>Error:</b></p><pre style="white-space:pre-wrap;background:#f6f8fa;padding:8px;border:1px solid #e1e4e8">${escapeHtml((g.sampleErrorMessage || '(no error text)').slice(0, 600))}</pre>`);
        lines.push(`<p><b>Expected:</b> step "${escapeHtml(g.stepThatFailed)}" succeeds for every affected scenario.<br/><b>Actual:</b> ${g.members.length} scenario(s) fail with the message above.</p>`);
        lines.push(`<b>Affected:</b><ul>`);
        for (const m of g.members) {
            lines.push(`<li><b>${escapeHtml(m.scenario.name)}</b>${m.scenario.tags.length > 0 ? ` <small>(${escapeHtml(m.scenario.tags.join(' '))})</small>` : ''}${m.screenshots.length > 0 ? ` · <small>${m.screenshots.length} screenshot${m.screenshots.length === 1 ? '' : 's'}</small>` : ''}</li>`);
        }
        lines.push(`</ul>`);
        lines.push(`<p><small>Signature: <code>${escapeHtml(g.signatureFingerprint)}</code></small></p>`);
    }
    lines.push(`<hr/><p><small>Report: <code>${escapeHtml(reportPath)}</code></small></p>`);
    return lines.join('\n');
}

function buildReproStepsForConsolidated(groups: FailureGroup[], ctx: RunContext, reportDir: string): string {
    const lines: string[] = [];
    lines.push(`<p>This bug consolidates <b>${groups.reduce((s, g) => s + g.members.length, 0)}</b> failed scenarios into <b>${groups.length}</b> distinct root causes. The canonical repro for each root cause is below.</p>`);
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const first = g.members[0];
        const data = extractTestData(first.scenario.name, reportDir);
        lines.push(`<h4>Root cause ${i + 1} of ${groups.length}: ${escapeHtml(g.errorClass)}</h4>`);
        lines.push(`<p>Canonical scenario: <b>${escapeHtml(first.scenario.name)}</b>${g.members.length > 1 ? ` (+${g.members.length - 1} more with same signature)` : ''}</p>`);
        lines.push(buildStepsToReproduce(first.scenario.name, first.scenario.tags, reportDir, data, ctx));
        lines.push(`<p><b>Expected outcome:</b> "${escapeHtml(g.stepThatFailed)}" completes without error.<br/><b>Actual outcome:</b> <code>${escapeHtml((g.sampleErrorMessage || 'failure').slice(0, 300))}</code></p>`);
        if (i < groups.length - 1) lines.push('<hr/>');
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ADO create + attach
// ---------------------------------------------------------------------------

interface CreateContext {
    cfg: AdoCreds;
    client: AdoHttpClient;
    workItemType: string;
    env: string;
    reportPath: string;
    tags: string[];
    signatureFingerprint: string;
    input: Input;
}

interface CreatedWi { id: number; url: string; }

/** Pull ADO work-item IDs from `@TestCaseId:<n>` and `@TestCaseId:{n1,n2,...}`
 * tags. Handles both single-id and braced-multi forms produced by the
 * framework's sync-back. */
function extractTagIds(tag: string, tagName: string): number[] {
    const t = tag.trim().replace(/^@/, '');
    const prefix = tagName.toLowerCase();
    if (!t.toLowerCase().startsWith(prefix + ':')) return [];
    const payload = t.slice(prefix.length + 1);
    const cleaned = payload.replace(/[{}\s]/g, '');
    if (!cleaned) return [];
    return cleaned.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
}

/** Read the CURRENT tags on a scenario from its feature file — the report's
 * frozen tag list can be stale if the feature file was re-synced after the
 * run. Walks upward from the `Scenario:` / `Scenario Outline:` line
 * collecting all leading @-tag lines, then merges in Feature-level tags. */
function currentFeatureTagsFor(scenarioName: string, featurePath: string, workspaceRoot: string): string[] {
    if (!featurePath) return [];
    const abs = path.isAbsolute(featurePath) ? featurePath : path.join(workspaceRoot, featurePath);
    if (!fs.existsSync(abs)) return [];
    let src: string;
    try { src = fs.readFileSync(abs, 'utf-8'); } catch { return []; }
    const lines = src.split(/\r?\n/);
    const featureTags: string[] = [];
    for (const l of lines) {
        const t = l.trim();
        if (t.startsWith('Feature:')) break;
        if (t.startsWith('@')) featureTags.push(...t.split(/\s+/).filter((s) => s.startsWith('@')));
    }
    const target = scenarioName.trim();
    const scnRe = /^\s*Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*$/;
    for (let i = 0; i < lines.length; i++) {
        const m = scnRe.exec(lines[i]);
        if (!m || m[1].trim() !== target) continue;
        const scenarioTags: string[] = [];
        for (let j = i - 1; j >= 0; j--) {
            const t = lines[j].trim();
            if (t === '') continue;
            if (t.startsWith('@')) scenarioTags.unshift(...t.split(/\s+/).filter((s) => s.startsWith('@')));
            else break;
        }
        return Array.from(new Set([...featureTags, ...scenarioTags]));
    }
    return featureTags;
}

function collectLinkedIds(members: EnrichedFailure[], tagName: string, workspaceRoot: string): number[] {
    const ids = new Set<number>();
    for (const m of members) {
        // Report tags first
        for (const t of m.scenario.tags) for (const id of extractTagIds(t, tagName)) ids.add(id);
        // Feature-file tags second — catches tags added AFTER the run
        const current = currentFeatureTagsFor(m.scenario.name, m.scenario.feature, workspaceRoot);
        for (const t of current) for (const id of extractTagIds(t, tagName)) ids.add(id);
    }
    return Array.from(ids).sort((a, b) => a - b);
}

async function createWorkItem(ctx: CreateContext, title: string, descriptionHtml: string, reproStepsHtml: string, systemInfoText: string, linkedTestCaseIds: number[], linkedStoryIds: number[]): Promise<CreatedWi> {
    const patch: Array<Record<string, unknown>> = [
        { op: 'add', path: '/fields/System.Title', value: title },
        { op: 'add', path: '/fields/System.Description', value: descriptionHtml },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: reproStepsHtml || descriptionHtml },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.SystemInfo', value: systemInfoText },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: ctx.input.severity },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: ctx.input.priority },
    ];
    if (ctx.input.bugAreaPath) patch.push({ op: 'add', path: '/fields/System.AreaPath', value: ctx.input.bugAreaPath });
    if (ctx.input.bugIterationPath) patch.push({ op: 'add', path: '/fields/System.IterationPath', value: ctx.input.bugIterationPath });
    if (ctx.input.assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: ctx.input.assignedTo });
    const allTags = Array.from(new Set([...ctx.tags, `env:${ctx.env}`, `auto-bug-sig-${ctx.signatureFingerprint.slice(0, 8)}`, 'auto-logged']));
    patch.push({ op: 'add', path: '/fields/System.Tags', value: allTags.join('; ') });
    const orgBase = ctx.cfg.orgUrl.replace(/\/$/, '');
    // Explicit story link from input.
    if (ctx.input.linkToStoryId) {
        patch.push({
            op: 'add', path: '/relations/-',
            value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${orgBase}/_apis/wit/workitems/${ctx.input.linkToStoryId}`, attributes: { comment: 'Explicit link from cs_qa_log_failures_as_bugs input' } },
        });
    }
    // Linked test cases mined from scenario tags — TestedBy-Reverse points from
    // the test case to the bug ("tested by" this test).
    for (const tcId of linkedTestCaseIds) {
        patch.push({
            op: 'add', path: '/relations/-',
            value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${orgBase}/_apis/wit/workitems/${tcId}`, attributes: { comment: 'Failed test case (from @TestCaseId tag)' } },
        });
    }
    // Linked stories mined from @LinkedStory tags.
    for (const storyId of linkedStoryIds) {
        if (ctx.input.linkToStoryId === storyId) continue;
        patch.push({
            op: 'add', path: '/relations/-',
            value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${orgBase}/_apis/wit/workitems/${storyId}`, attributes: { comment: 'Parent story (from @LinkedStory tag)' } },
        });
    }
    const created = await ctx.client.post<{ id: number; url: string }>(`_apis/wit/workitems/$${encodeURIComponent(ctx.workItemType)}?api-version=7.0`, patch);
    return { id: created.id, url: created.url };
}

async function uploadAttachment(cfg: AdoCreds, filePath: string, log: ReturnType<typeof createLogger>): Promise<{ id: string; url: string } | null> {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) { log.warn('attachment-empty', { file: filePath }); return null; }
        const name = path.basename(filePath);
        const url = `${cfg.orgUrl.replace(/\/$/, '')}/${encodeURIComponent(cfg.project)}/_apis/wit/attachments?fileName=${encodeURIComponent(name)}&api-version=7.0`;
        const body = fs.readFileSync(filePath);
        const res = await httpUploadBinary(url, cfg.pat, body);
        if (!res.ok) { log.warn('attachment-upload-failed', { file: filePath, status: res.status, error: res.body.slice(0, 200) }); return null; }
        const parsed = JSON.parse(res.body) as { id: string; url: string };
        return { id: parsed.id, url: parsed.url };
    } catch (e) {
        log.warn('attachment-exception', { file: filePath, error: (e as Error).message.slice(0, 200) });
        return null;
    }
}

function httpUploadBinary(urlString: string, pat: string, body: Buffer): Promise<{ ok: boolean; status: number; body: string }> {
    return new Promise((resolve) => {
        const u = new URL(urlString);
        const mod = u.protocol === 'http:' ? http : https;
        const req = mod.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': body.length,
                'Authorization': 'Basic ' + Buffer.from(':' + pat).toString('base64'),
                'Accept': 'application/json',
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', (e) => resolve({ ok: false, status: 0, body: e.message }));
        req.write(body); req.end();
    });
}

async function attachAndLink(cfg: AdoCreds, wi: CreatedWi, filePath: string, log: ReturnType<typeof createLogger>): Promise<boolean> {
    const att = await uploadAttachment(cfg, filePath, log);
    if (!att) return false;
    const client = new AdoHttpClient(cfg);
    try {
        // AdoHttpClient auto-picks json-patch+json for /wit/workitems paths.
        await client.patch(`_apis/wit/workitems/${wi.id}?api-version=7.0`, [
            { op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: att.url, attributes: { name: path.basename(filePath) } } },
        ]);
        return true;
    } catch (e) { log.warn('attachment-link-failed', { wi: wi.id, file: filePath, error: (e as Error).message.slice(0, 200) }); return false; }
}

function createZipOfDir(srcDir: string, outFile: string): { ok: boolean; error?: string } {
    if (process.platform === 'win32') {
        const res = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${outFile.replace(/'/g, "''")}' -Force`], { encoding: 'utf-8' });
        if (res.status !== 0) return { ok: false, error: res.stderr || res.stdout || 'PowerShell Compress-Archive failed' };
        return { ok: true };
    }
    const zipRes = spawnSync('zip', ['-r', outFile, '.'], { cwd: srcDir, encoding: 'utf-8' });
    if (zipRes.status === 0) return { ok: true };
    const tarRes = spawnSync('tar', ['-czf', outFile.replace(/\.zip$/, '.tar.gz'), '-C', srcDir, '.'], { encoding: 'utf-8' });
    if (tarRes.status === 0) return { ok: true };
    return { ok: false, error: `Neither zip nor tar succeeded. zip: ${zipRes.stderr || 'not found'}. tar: ${tarRes.stderr || 'not found'}.` };
}

// ---------------------------------------------------------------------------
// Dedupe query
// ---------------------------------------------------------------------------

async function findExistingBugBySignature(client: AdoHttpClient, sigTag: string, workItemType: string): Promise<number | null> {
    const q = wiql()
        .select(['[System.Id]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', workItemType)
        .and().tag(sigTag)
        .and().notEquals('[System.State]', 'Closed')
        .and().notEquals('[System.State]', 'Resolved')
        .and().notEquals('[System.State]', 'Done')
        .done()
        .build();
    try {
        const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.0`, { query: q });
        const ids = (res.workItems || []).map((w) => w.id);
        return ids.length > 0 ? ids[0] : null;
    } catch { return null; }
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

registerPrimitive<Input, Output>({
    name: 'cs_qa_log_failures_as_bugs',
    description:
        'Read the latest test-execution report, group failed scenarios by normalized failure signature (errorClass + step + normalized message), and create ADO work items — Bug for lower environments, Defect for prod (or override). Two-phase confirmation: call once with no `confirmed` to get a preview + requiresConfirmation:true. When failures cluster into MULTIPLE distinct groups, tool ALSO returns requiresChoice:true with each group summary — caller shows to the human, gets "separate" or "consolidated", retries with `bugCreationStrategy` set. Screenshots auto-attached always. Full test-results ZIP attached ONLY when `attachFullArtifactZip:true`. Dedupes against existing open bugs tagged with the same signature.',
    inputSchema: InputSchema as unknown as import('zod').ZodType<Input>,
    outputSchema: OutputSchema as unknown as import('zod').ZodType<Output>,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_log_failures_as_bugs', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // 1. Select failures
        const outcome = selectFailures({
            workspaceRoot: ctx.workspaceRoot,
            reportFrom: input.reportFrom,
            reportsBase: input.reportsBase,
            filters: input.filters,
        });

        if (outcome.kind !== 'ready') {
            return {
                ok: outcome.kind === 'no-failures',
                verb: 'log-failures-as-bugs',
                reportUsed: null,
                environment: null,
                workItemType: '',
                totalFailures: 0,
                distinctFailureGroups: 0,
                strategyChosen: null,
                groups: [],
                plannedWorkItems: [],
                warnings,
                note: outcome.summary,
            };
        }

        const reportPath = outcome.reports[0].reportDataPath;
        const reportDir = outcome.reports[0].reportDir;
        const rawReportForEnv = loadReportRaw(reportPath);
        const env = resolveEnvironment(input, ctx.workspaceRoot, rawReportForEnv, reportDir);
        const workItemType = resolveWorkItemType(input, env);

        // 2. Enrich + group
        const { enriched, warnings: enrichWarn } = enrichFailures(reportDir, outcome.failures);
        warnings.push(...enrichWarn);
        const groups = groupBySignature(enriched);

        const groupPreviews = groups.map((g) => ({
            signature: g.canonicalSignature.slice(0, 300),
            signatureFingerprint: g.signatureFingerprint,
            scenarioCount: g.members.length,
            sampleScenario: g.members[0].scenario.name,
            sampleErrorMessage: g.sampleErrorMessage,
            affectedScenarios: g.members.map((m) => m.scenario.name),
            affectedFeatures: Array.from(new Set(g.members.map((m) => m.scenario.feature))),
            stepThatFailed: g.stepThatFailed,
            errorClass: g.errorClass,
        }));

        // 3. Choice gate — N groups + no strategy picked
        const strategyNeeded = groups.length > 1 && !input.bugCreationStrategy;
        if (strategyNeeded) {
            const summary = groups.map((g, i) => `${i + 1}) ${g.errorClass} at "${g.stepThatFailed.slice(0, 80)}" — ${g.members.length} scenario(s)`).join('\n');
            return {
                ok: true,
                verb: 'log-failures-as-bugs',
                reportUsed: reportPath,
                environment: env,
                workItemType,
                totalFailures: enriched.length,
                distinctFailureGroups: groups.length,
                strategyChosen: null,
                requiresChoice: true,
                choicePrompt: `Failures clustered into ${groups.length} distinct root causes. Show this list to the human and ask them to pick:\n\n${summary}\n\nRETRY the same call with either bugCreationStrategy:"separate" (one ${workItemType} per group) OR bugCreationStrategy:"consolidated" (one ${workItemType} listing all groups).`,
                groups: groupPreviews,
                plannedWorkItems: [],
                warnings,
            };
        }

        const strategy = groups.length === 1 ? 'consolidated' : (input.bugCreationStrategy || 'consolidated');

        // 4. Build planned WIs
        const planned: Output['plannedWorkItems'] = [];
        if (strategy === 'separate') {
            for (const g of groups) {
                const title = buildTitle(g, workItemType, env, input.titlePrefix, input.severity);
                const scCount = g.members.length;
                let attachCount = 0;
                if (input.attachScreenshots) for (const m of g.members) attachCount += m.screenshots.length;
                if (input.attachFullArtifactZip) attachCount += 1;
                planned.push({
                    title,
                    workItemType,
                    signatureFingerprints: [g.signatureFingerprint],
                    scenariosIncluded: g.members.map((m) => m.scenario.name),
                    attachmentsPlanned: attachCount,
                    linkedTestCaseIdsPlanned: collectLinkedIds(g.members, 'TestCaseId', ctx.workspaceRoot),
                    linkedStoryIdsPlanned: collectLinkedIds(g.members, 'LinkedStory', ctx.workspaceRoot),
                });
                void scCount;
            }
        } else {
            const title = buildConsolidatedTitle(groups, workItemType, env, input.titlePrefix, input.severity);
            let attachCount = 0;
            if (input.attachScreenshots) for (const g of groups) for (const m of g.members) attachCount += m.screenshots.length;
            if (input.attachFullArtifactZip) attachCount += 1;
            planned.push({
                title,
                workItemType,
                signatureFingerprints: groups.map((g) => g.signatureFingerprint),
                scenariosIncluded: enriched.map((e) => e.scenario.name),
                attachmentsPlanned: attachCount,
                linkedTestCaseIdsPlanned: collectLinkedIds(enriched, 'TestCaseId', ctx.workspaceRoot),
                linkedStoryIdsPlanned: collectLinkedIds(enriched, 'LinkedStory', ctx.workspaceRoot),
            });
        }

        // 5. Preflight — confirmation gate
        if (!input.confirmed) {
            return {
                ok: true,
                verb: 'log-failures-as-bugs',
                reportUsed: reportPath,
                environment: env,
                workItemType,
                totalFailures: enriched.length,
                distinctFailureGroups: groups.length,
                strategyChosen: strategy,
                requiresConfirmation: true,
                confirmationHint: `This will CREATE ${planned.length} ${workItemType}(s) in ADO — with ${planned.reduce((s, p) => s + p.attachmentsPlanned, 0)} attachment(s). Show this preview to the human. When they explicitly agree, retry the SAME call with confirmed:true.`,
                groups: groupPreviews,
                plannedWorkItems: planned,
                warnings,
            };
        }

        if (input.dryRun) {
            return {
                ok: true,
                verb: 'log-failures-as-bugs',
                reportUsed: reportPath,
                environment: env,
                workItemType,
                totalFailures: enriched.length,
                distinctFailureGroups: groups.length,
                strategyChosen: strategy,
                groups: groupPreviews,
                plannedWorkItems: planned,
                created: [],
                skipped: [],
                warnings,
                note: 'dryRun:true — no ADO writes performed.',
            };
        }

        // 6. Real execution — need ADO creds
        const resolved = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
        if (!resolved.creds) {
            return {
                ok: false, verb: 'log-failures-as-bugs',
                reportUsed: reportPath, environment: env, workItemType,
                totalFailures: enriched.length, distinctFailureGroups: groups.length,
                strategyChosen: strategy, groups: groupPreviews, plannedWorkItems: planned,
                created: [], skipped: [], warnings,
                note: 'ADO creds unresolved — ' + resolved.diagnostic,
            };
        }
        const creds: AdoCreds = resolved.creds;
        const client = new AdoHttpClient(creds);
        const created: Output['created'] = [];
        const skipped: Output['skipped'] = [];

        // 7. Optional full-artifact ZIP — build once, reuse across all WIs
        let zipPath: string | null = null;
        if (input.attachFullArtifactZip) {
            const testResultsDir = path.resolve(reportDir, '..'); // reports/test-results-.../reports/.. == the test-results-* dir
            const outZip = path.join(testResultsDir, 'test-results-artifacts.zip');
            const zipRes = createZipOfDir(testResultsDir, outZip);
            if (zipRes.ok) { zipPath = fs.existsSync(outZip) ? outZip : outZip.replace(/\.zip$/, '.tar.gz'); }
            else { warnings.push(`ZIP archive creation failed: ${zipRes.error}. Full-artifact attachment SKIPPED.`); }
        }

        // 8. Create WIs
        const items: Array<{ group: FailureGroup | null; groups: FailureGroup[]; title: string; sigTag: string; members: EnrichedFailure[] }> = [];
        if (strategy === 'separate') {
            for (const g of groups) items.push({ group: g, groups: [g], title: buildTitle(g, workItemType, env, input.titlePrefix, input.severity), sigTag: `auto-bug-sig-${g.signatureFingerprint.slice(0, 8)}`, members: g.members });
        } else {
            const primaryFp = groups[0].signatureFingerprint;
            items.push({ group: null, groups, title: buildConsolidatedTitle(groups, workItemType, env, input.titlePrefix, input.severity), sigTag: `auto-bug-sig-${primaryFp.slice(0, 8)}`, members: enriched });
        }

        for (const item of items) {
            if (input.dedupeAgainstExisting) {
                const existing = await findExistingBugBySignature(client, item.sigTag, workItemType);
                if (existing !== null) {
                    skipped.push({ signatureFingerprint: (item.group?.signatureFingerprint) || item.groups.map((g) => g.signatureFingerprint).join(','), existingBugId: existing, reason: `Open ${workItemType} #${existing} already exists with tag ${item.sigTag}` });
                    continue;
                }
            }
            const rawReportForCtx = loadReportRaw(reportPath);
            const failuresCount = item.members.length;
            const totalCount = outcome.reports.reduce((s, r) => s + (r.totalScenarios || 0), 0);
            const runCtx = runContextFrom(env, reportDir, ctx.workspaceRoot, rawReportForCtx, failuresCount, totalCount);
            const desc = item.group
                ? buildDescriptionForGroup(item.group, env, workItemType, runCtx, reportPath, reportDir)
                : buildDescriptionForConsolidated(item.groups, env, workItemType, runCtx, reportPath, reportDir);
            const repro = item.group
                ? buildReproStepsForGroup(item.group, runCtx, reportDir)
                : buildReproStepsForConsolidated(item.groups, runCtx, reportDir);
            const systemInfo = buildSystemInfoText(env, runCtx, reportPath, workItemType, input.systemInfoExtra);
            const linkedTestCaseIds = collectLinkedIds(item.members, 'TestCaseId', ctx.workspaceRoot);
            const linkedStoryIds = collectLinkedIds(item.members, 'LinkedStory', ctx.workspaceRoot);
            const cctx: CreateContext = { cfg: creds, client, workItemType, env, reportPath, tags: input.tags, signatureFingerprint: (item.group?.signatureFingerprint) || item.groups[0].signatureFingerprint, input };
            let wi: CreatedWi;
            try {
                wi = await createWorkItem(cctx, item.title, desc, repro, systemInfo, linkedTestCaseIds, linkedStoryIds);
                log.info('wi-created', { id: wi.id, type: workItemType, title: item.title.slice(0, 80), linkedTestCases: linkedTestCaseIds.length, linkedStories: linkedStoryIds.length });
            } catch (e) {
                warnings.push(`Failed to create ${workItemType}: ${(e as Error).message.slice(0, 300)}`);
                continue;
            }
            let screenshotsAttached = 0;
            if (input.attachScreenshots) {
                const allShots = Array.from(new Set(item.members.flatMap((m) => m.screenshots)));
                for (const s of allShots) {
                    const ok = await attachAndLink(creds, wi, s, log);
                    if (ok) screenshotsAttached += 1;
                }
            }
            let attachedZip = false;
            if (zipPath) {
                const ok = await attachAndLink(creds, wi, zipPath, log);
                if (ok) attachedZip = true;
            }
            created.push({ id: wi.id, url: wi.url, title: item.title, workItemType, signatureFingerprint: cctx.signatureFingerprint, attachedScreenshotCount: screenshotsAttached, attachedZip, linkedTestCaseIds, linkedStoryIds });
        }

        return {
            ok: true,
            verb: 'log-failures-as-bugs',
            reportUsed: reportPath,
            environment: env,
            workItemType,
            totalFailures: enriched.length,
            distinctFailureGroups: groups.length,
            strategyChosen: strategy,
            groups: groupPreviews,
            plannedWorkItems: planned,
            created,
            skipped,
            warnings,
            note: `${created.length} ${workItemType}(s) created, ${skipped.length} deduped, ${warnings.length} warning(s).`,
        };
    },
});
