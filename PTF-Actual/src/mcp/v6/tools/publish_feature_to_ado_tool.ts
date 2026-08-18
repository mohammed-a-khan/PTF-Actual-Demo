/**
 * cs_qa_publish_feature_to_ado — restored composer.
 *
 * Publishes Gherkin `.feature` files as ADO Test Cases with human-quality
 * descriptions, populated preconditions, verb-inferred expected results,
 * placeholder substitution from data files, automation traceability fields,
 * suite creation/reuse, idempotent create-or-update, bulk-folder + tag-filter.
 *
 * Composition heuristics are lifted from src/mcp/_salvage/publish-feature/
 * composition.ts (git commit 19198b3) verbatim — the tuning of those
 * heuristics is more valuable than any "cleaner" rewrite.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import {
    syncFeatureAfterPublish,
    extractTestCaseIdsFromScenario,
    type ScenarioMapping,
    type SyncResult,
} from './sync_feature_tags';
import {
    resolvePlan,
    resolveUserStory,
    createCache,
    type ResolverCache,
} from './ado_name_resolver';

// =============================================================================
// ADO config loading — mirrors ado_read_tool / ado_write_tool.
// Extended to also surface `ado.defaults.{environment,appUrl,areaPath,iterationPath}`.
// =============================================================================

const PAT_PLACEHOLDERS = new Set([
    'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',
    'ENCRYPTED:paste-encrypted-pat-here',
    'YOUR_PAT_HERE',
    'REPLACE_ME',
]);

interface AdoCreds {
    orgUrl: string;
    project: string;
    pat: string;
}

interface AdoDefaults {
    environment?: string;
    appUrl?: string;
    areaPath?: string;
    iterationPath?: string;
}

function decryptIfNeeded(value: string, workspaceRoot: string): string | null {
    if (!value.startsWith('ENCRYPTED:')) return value;
    try {
        const cryptoUtilPath = path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSEncryptionUtil.js');
        if (!fs.existsSync(cryptoUtilPath)) return null;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CSEncryptionUtil } = require(cryptoUtilPath) as { CSEncryptionUtil: { getInstance(): { decrypt(v: string): string } } };
        return CSEncryptionUtil.getInstance().decrypt(value);
    } catch {
        return null;
    }
}

function loadAdo(workspaceRoot: string): { creds: AdoCreds; defaults: AdoDefaults } | null {
    const candidates = [
        path.join(workspaceRoot, 'cs-playwright-mcp.config.json'),
        path.join(workspaceRoot, 'cs-ai-auto-assist.config.json'),
        path.join(os.homedir(), '.cs-qa', 'ado-config.json'),
    ];
    let orgUrl = '';
    let project = '';
    let pat = '';
    const defaults: AdoDefaults = {};
    for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        try {
            const j = JSON.parse(fs.readFileSync(c, 'utf-8')) as Record<string, unknown>;
            const ado = (j.ado ?? j.azureDevOps ?? j) as Record<string, unknown>;
            const organization = (ado.organization ?? '') as string;
            const proj = (ado.project ?? '') as string;
            const baseUrl = ((ado.baseUrl ?? 'https://dev.azure.com') as string).replace(/\/$/, '');
            const rawToken = ((ado.personalAccessToken ?? ado.pat ?? ado.token ?? '') as string).trim();
            const localOrgUrl = (ado.orgUrl as string) || (organization ? `${baseUrl}/${organization}` : '');
            if (!orgUrl && localOrgUrl) orgUrl = localOrgUrl;
            if (!project && proj) project = proj;
            if (!pat && rawToken && !PAT_PLACEHOLDERS.has(rawToken)) {
                const decrypted = decryptIfNeeded(rawToken, workspaceRoot);
                if (decrypted) pat = decrypted;
            }
            const d = (ado.defaults ?? {}) as Record<string, unknown>;
            if (!defaults.environment && typeof d.environment === 'string' && d.environment) defaults.environment = d.environment;
            if (!defaults.appUrl && typeof d.appUrl === 'string' && d.appUrl) defaults.appUrl = d.appUrl;
            if (!defaults.areaPath && typeof d.areaPath === 'string' && d.areaPath) defaults.areaPath = d.areaPath;
            if (!defaults.iterationPath && typeof d.iterationPath === 'string' && d.iterationPath) defaults.iterationPath = d.iterationPath;
        } catch { /* ignore */ }
    }
    if (!orgUrl && process.env.ADO_ORG_URL) orgUrl = process.env.ADO_ORG_URL;
    if (!project && process.env.ADO_PROJECT) project = process.env.ADO_PROJECT;
    if (!pat) pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_EXT_PAT || process.env.AZURE_DEVOPS_TOKEN || process.env.AZURE_DEVOPS_PAT || process.env.ADO_PERSONAL_ACCESS_TOKEN || '';
    if (!orgUrl || !project || !pat) return null;
    return { creds: { orgUrl, project, pat }, defaults };
}

// =============================================================================
// ADO REST helpers.
// =============================================================================

type HttpMethod = 'GET' | 'POST' | 'PATCH';

async function adoRequest(cfg: AdoCreds, method: HttpMethod, urlPath: string, body?: unknown, contentType = 'application/json-patch+json'): Promise<unknown> {
    const auth = Buffer.from(`:${cfg.pat}`).toString('base64');
    const url = `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/${urlPath.replace(/^\//, '')}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': contentType } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ADO ${method} ${url} → ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    // Some 204 responses on relations updates return empty body.
    const t = await res.text();
    if (!t) return {};
    try { return JSON.parse(t); } catch { return { raw: t }; }
}

// =============================================================================
// Gherkin parser — exposes steps with keyword + text (composer needs both).
// =============================================================================

interface GherkinStep {
    keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
    text: string;
    line: number;
}

interface GherkinExamplesJson {
    source: string;
    filter?: string;
}

interface ParsedScenario {
    name: string;
    tags: string[];
    isOutline: boolean;
    steps: GherkinStep[];
    examples?: { json?: GherkinExamplesJson };
    line: number;
}

interface ParsedFeature {
    name: string;
    description: string;
    tags: string[];
    background?: { steps: GherkinStep[] };
    scenarios: ParsedScenario[];
    sourcePath?: string;
}

function parseFeature(content: string, sourcePath?: string): ParsedFeature {
    const lines = content.split('\n');
    const feature: ParsedFeature = { name: '', description: '', tags: [], scenarios: [], sourcePath };
    let featureDescLines: string[] = [];
    let pendingTags: string[] = [];
    let current: ParsedScenario | null = null;
    let inBackground = false;

    const flush = (): void => {
        if (current) feature.scenarios.push(current);
        current = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#')) continue;

        if (/^@\S/.test(trimmed)) {
            pendingTags.push(...trimmed.split(/\s+/).filter((t) => t.startsWith('@')));
            continue;
        }
        const fMatch = /^Feature\s*:\s*(.+)$/.exec(trimmed);
        if (fMatch) {
            feature.name = fMatch[1].trim();
            feature.tags = pendingTags.slice();
            pendingTags = [];
            continue;
        }
        if (/^Background\s*:/.test(trimmed)) {
            flush();
            inBackground = true;
            feature.background = { steps: [] };
            continue;
        }
        const scMatch = /^(Scenario Outline|Scenario)\s*:\s*(.+)$/.exec(trimmed);
        if (scMatch) {
            flush();
            inBackground = false;
            current = {
                name: scMatch[2].trim(),
                tags: pendingTags.slice(),
                isOutline: scMatch[1] === 'Scenario Outline',
                steps: [],
                line: i + 1,
            };
            pendingTags = [];
            continue;
        }
        const exMatch = /^Examples\s*:\s*(.+)$/.exec(trimmed);
        if (exMatch && current) {
            const rest = exMatch[1];
            const jsonSourceMatch = /"source"\s*:\s*"([^"]+)"/.exec(rest);
            const filterMatch = /"filter"\s*:\s*"([^"]+)"/.exec(rest);
            if (jsonSourceMatch) {
                current.examples = { json: { source: jsonSourceMatch[1], filter: filterMatch?.[1] } };
            }
            continue;
        }
        const stMatch = /^(Given|When|Then|And|But)\s+(.+)$/.exec(trimmed);
        if (stMatch) {
            const step: GherkinStep = { keyword: stMatch[1] as GherkinStep['keyword'], text: stMatch[2], line: i + 1 };
            if (inBackground && feature.background) feature.background.steps.push(step);
            else if (current) current.steps.push(step);
            continue;
        }
        // Anything else before the first scenario is feature description.
        if (feature.scenarios.length === 0 && !current && !inBackground && trimmed) {
            featureDescLines.push(trimmed);
        }
    }
    flush();
    feature.description = featureDescLines.join(' ');
    return feature;
}

// =============================================================================
// Data-row resolution — mirrors mcp-test-repo helpers/DataResolver.ts.
// Applied to the first matching row of the Examples JSON so <placeholders>
// in step text expand to concrete values (never leave __AUTO_ID:LAST__ literals).
// =============================================================================

// Session-stable seeds for __AUTO_NUMBER__ / __AUTO_ID:PREFIX__. Consumers'
// DataResolver keeps a per-process counter; a publish invocation is
// short-lived so we just generate fresh values per row read.
let AUTO_NUMBER_SEED = Date.now() % 100000;
function nextAutoNumber(): string {
    AUTO_NUMBER_SEED = (AUTO_NUMBER_SEED + 1) % 100000;
    return String(10000 + AUTO_NUMBER_SEED);
}

function generateId(prefix: string, length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return `${prefix}${out}`;
}

function todayInAmericasTz(): string {
    // Best-effort — publish output is documentary; exact TZ isn't security-critical here.
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
}

function addBusinessDays(baseIso: string, days: number): string {
    const d = new Date(baseIso);
    let added = 0;
    while (added < days) {
        d.setDate(d.getDate() + 1);
        const day = d.getDay();
        if (day !== 0 && day !== 6) added++;
    }
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
}

function resolveValue(value: string): string {
    if (value === '__AUTO_NUMBER__') return nextAutoNumber();
    const idMatch = /^__AUTO_ID:([A-Za-z0-9_-]+)__$/.exec(value);
    if (idMatch) return generateId(idMatch[1], 6);
    if (value === 'TODAY') return todayInAmericasTz();
    const todayPlus = /^TODAY\s*([+-])\s*(\d+)\s*B$/.exec(value);
    if (todayPlus) {
        const sign = todayPlus[1] === '-' ? -1 : 1;
        return addBusinessDays(new Date().toISOString(), sign * Number(todayPlus[2]));
    }
    return value;
}

function resolveRow(row: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) out[k] = resolveValue(String(v ?? ''));
    return out;
}

function loadFirstDataRow(workspaceRoot: string, examples: GherkinExamplesJson | undefined): Record<string, string> | undefined {
    if (!examples) return undefined;
    const abs = path.isAbsolute(examples.source) ? examples.source : path.resolve(workspaceRoot, examples.source);
    if (!fs.existsSync(abs)) return undefined;
    try {
        const rows = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Array<Record<string, string>>;
        let matched = rows;
        if (examples.filter) {
            const [k, v] = examples.filter.split('=');
            matched = rows.filter((r) => String(r[k]) === v);
        }
        if (matched.length === 0) return undefined;
        return resolveRow(matched[0]);
    } catch {
        return undefined;
    }
}

/**
 * Load ALL rows (post-filter) for the Test Data table rendering. Rows are
 * NOT resolved via resolveRow — placeholders like __AUTO_ID:PREFIX__ would
 * change per-invocation, ruining stable diffs on re-publish.
 */
function loadAllDataRows(workspaceRoot: string, examples: GherkinExamplesJson | undefined): Array<Record<string, string>> {
    if (!examples) return [];
    const abs = path.isAbsolute(examples.source) ? examples.source : path.resolve(workspaceRoot, examples.source);
    if (!fs.existsSync(abs)) return [];
    try {
        const rows = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Array<Record<string, string>>;
        let matched = rows;
        if (examples.filter) {
            const [k, v] = examples.filter.split('=');
            matched = rows.filter((r) => String(r[k]) === v);
        }
        return matched;
    } catch {
        return [];
    }
}

// =============================================================================
// Composer — heuristics preserved from _salvage/publish-feature/composition.ts.
// =============================================================================

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function collapseWhitespace(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function capitalize(s: string): string {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Filter tool-managed tags out of the set that becomes `System.Tags` on the
 * ADO test case. `@TestPlanId:<n>`, `@TestSuiteId:<n>`, `@TestCaseId:<n|{...}>`
 * are workspace-side mapping metadata (they live in the .feature file as a
 * source-of-truth for automation → ADO linkage). Copying them to `System.Tags`
 * pollutes the ADO tag cloud with numeric labels that mean nothing to a
 * manual tester reading the test case.
 *
 * Also strips the leading `@` since ADO tags don't carry the Gherkin prefix.
 */
function filterAdoTags(scenarioTags: string[]): string[] {
    const out: string[] = [];
    for (const raw of scenarioTags) {
        const t = raw.replace(/^@/, '').trim();
        if (!t) continue;
        // Case-insensitive prefix skip — matches both @TestCaseId:X and @testcaseid:x
        if (/^test(plan|suite|case)id\b/i.test(t)) continue;
        out.push(t);
    }
    return out;
}

function dedupe(arr: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of arr) if (!seen.has(s)) { seen.add(s); out.push(s); }
    return out;
}

function extractScenarioIdTag(scenario: ParsedScenario): string | undefined {
    for (const tag of scenario.tags) {
        const m = /^@TC:(\d+)$/i.exec(tag);
        if (m) return m[1];
    }
    return undefined;
}

function deriveModuleLabel(featureTags: string[]): string {
    for (const t of featureTags) {
        const m = /^@module:(.+)$/i.exec(t);
        if (m) return m[1].trim();
    }
    return '';
}

function inferModuleFromTags(featureTags: string[]): string | undefined {
    // Prefer the first lowercase alphanumeric tag as a module name proxy — users
    // typically tag features by lifecycle area (e.g. @regression, @smoke) and by
    // module (e.g. @login, @checkout). Test-type tags starting with a capital
    // (Given, When, Then are rejected upstream; here we skip capitalised tags too).
    // If the guess is wrong, users can override with an explicit `@module:<name>` tag.
    for (const t of featureTags) {
        const l = t.replace(/^@/, '');
        if (l.length > 0 && !/^[A-Z]/.test(l)) return l;
    }
    return undefined;
}

function deriveAreaPath(featureTags: string[]): string | undefined {
    for (const t of featureTags) {
        const m = /^@area:(.+)$/i.exec(t);
        if (m) return m[1].trim();
    }
    return undefined;
}

function derivePriority(scenarioTags: string[]): number {
    for (const t of scenarioTags) {
        const m = /^@P([1-3])$/i.exec(t);
        if (m) return parseInt(m[1], 10);
    }
    return 2;
}

function deriveCoverageKinds(scenarioTags: string[]): string[] {
    const kinds: string[] = [];
    const seen = new Set<string>();
    const push = (k: string): void => { if (!seen.has(k)) { seen.add(k); kinds.push(k); } };
    for (const t of scenarioTags) {
        const l = t.toLowerCase().replace(/^@/, '');
        if (l === 'role-gate' || l === 'role_gate') push('Role-based visibility');
        else if (l === 'crud') push('CRUD happy path');
        else if (l === 'db' || l === 'database') push('DB persistence verification');
        else if (l === 'negative') push('Negative / validation matrix');
        else if (l === 'validation') push('Field validation');
        else if (l === 'on-change' || l === 'onchange') push('On-change client-side behaviour');
        else if (l === 'send-notice') push('Notification / mailto composition');
        else if (l === 'sort') push('Sort ordering');
        else if (l === 'navigation') push('Cross-page navigation');
        else if (l === 'inactive-lookup') push('Inactive lookup display');
        else if (l === 'smoke') push('Smoke');
        else if (l === 'regression') push('Regression');
        else if (l === 'happy-path') push('Happy path');
        else if (l === 'persistence') push('Persistence verification');
        else if (l === 'search') push('Search behavior');
        else if (l === 'audit') push('Audit trail');
        else if (l === 'tab') push('Tab / sub-page availability');
    }
    return kinds;
}

function deriveScenarioIntent(scenarioName: string, kinds: string[]): string {
    const cleaned = scenarioName.replace(/^[A-Z0-9_]+\s*-\s*/, '').trim();
    if (kinds.length > 0) return `${cleaned}. Covers: ${kinds.join(', ')}.`;
    return cleaned || 'End-to-end validation of the referenced flow.';
}

function isDataPrepStep(text: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase();
    return (
        t.startsWith('given ') && (
            t.includes('data-prep') ||
            t.includes('test data') ||
            t.includes('seed the ') ||
            t.includes('insert into ')
        )
    );
}

function extractDataPrerequisites(feature: ParsedFeature, scenario: ParsedScenario): string[] {
    const items: string[] = [];
    const allSteps = [...(feature.background?.steps ?? []), ...scenario.steps];
    for (const s of allSteps) {
        const text = s.text.trim();
        const low = text.toLowerCase();
        const m = /^i\s+resolve\s+(?:a|an|the|fresh)?\s*(.+?)(?:$)/i.exec(text);
        if (m) {
            items.push(`Required record: <b>${escapeHtml(m[1].trim())}</b>. If missing, the step definition falls back to the real UI creation flow (Setup → Approval / seed script). Never stubbed.`);
            continue;
        }
        if (/\bflip\b/.test(low) && /\bin db\b/.test(low)) {
            items.push(`DB mutation setup: <code>${escapeHtml(text)}</code>. Executed via committed SQL UPDATE. A companion "restore" step must follow at end of scenario.`);
            continue;
        }
        if (/\bseed\b|\binsert\s+into\b/i.test(text)) {
            items.push(`Test data seed: <code>${escapeHtml(text)}</code>. Runs via committed SQL INSERT before UI actions begin.`);
        }
    }
    return items;
}

/**
 * Verb-based inference of a meaningful expected result when a `When`/`And`/`Given`
 * action isn't followed by an explicit `Then`. Never returns empty.
 */
function inferExpectedResult(actionText: string): string {
    const t = actionText.toLowerCase();

    if (/\blog(in|ged in)\b|\bsign in\b|\bauthenticate/.test(t)) return 'Authentication succeeds; the user lands on the target home/dashboard page and their identity is visible in the header.';
    if (/\blog(out|ged out)\b|\bsign out\b/.test(t)) return 'User session ends; the browser is redirected to the login page and the Login button is visible.';

    const resolveMatch = /\bresolve\s+(?:a|an|the|fresh)?\s*([^.]+?)(?:\s+for\s+([^.]+))?$/i.exec(t);
    if (/\bresolve\b/.test(t) && resolveMatch) {
        const criteria = resolveMatch[1].replace(/\s+/g, ' ').trim();
        return `A record matching "${criteria}" is located in the current environment. If none exists, the step definition MUST create one via the real UI flow (Setup → Approval / seed script). Its identifier is stored in the scenario context for use by subsequent steps. No stubs or in-memory fallbacks are permitted.`;
    }
    if (/\bflip\b/.test(t) && /\bin db\b|\bdatabase\b/.test(t)) return 'The specified lookup/config row is toggled in the database via a direct SQL UPDATE (committed transaction). The change is visible to the application on the next page load.';
    if (/\brestore\b/.test(t) && /\bin db\b|\bdatabase\b/.test(t)) return 'The previously-mutated database row is reverted to its original state. The environment is left in the same shape as before the scenario ran.';
    if (/\bseed\b|\binsert\s+into\b/.test(t)) return 'The required rows are inserted into the database via committed SQL. Downstream queries see the new records.';
    if (/\bremember\b/.test(t)) return 'The current value/count is captured into the scenario context for later comparison assertions.';
    if (/\bcapture\b/.test(t)) return 'The current UI/DOM state is captured into the scenario context for later assertions.';

    if (/\bnavigate to\b|\bopen\s+(the\s+)?(.*?)\s+(module|tab|page|form)\b/.test(t) || /\bgo to\b/.test(t)) return 'The target page/tab/module/form loads without error; its header and primary controls are visible.';
    if (/\bback to\b|\breturn to\b/.test(t)) return 'Browser navigates back to the referenced landing view; the previous page state is restored.';
    if (/\brefresh\b/.test(t)) return 'The page reloads and the previously-saved values remain visible, confirming server-side persistence.';
    if (/\bsearch\b/.test(t)) return 'A results grid is rendered; the query executes without error and matching rows are displayed.';
    if (/\binspect\b/.test(t)) return 'The referenced UI region is available and its labelled controls / headings are visible.';
    if (/\bcancel\b/.test(t)) return 'The current action is dismissed; any unsaved edits are discarded and the previous view is restored.';
    if (/\bsubmit\b/.test(t)) return 'The submit request is issued; the server responds and the UI transitions to the corresponding success/validation state.';

    if (/\bclick\s+(add|new)\b/.test(t)) return 'A new empty row/form appears at the bottom of the grid, ready for input. The Save button becomes enabled.';
    if (/\bclick\s+save\b/.test(t)) return 'The save request succeeds; a success toast is displayed and the record is persisted (verifiable via a follow-up DB read).';
    if (/\bclick\s+delete\b/.test(t) && /\bdismiss\b/.test(t)) return 'A confirmation dialog appears. Dismissing preserves the row — no DB write occurs.';
    if (/\bclick\s+delete\b/.test(t) && /\baccept\b/.test(t)) return 'A confirmation dialog appears. Accepting removes the row from the grid AND from the database.';
    if (/\bclick\s+delete\b|\bremove\b/.test(t)) return 'A confirmation dialog is shown; upon confirmation the row is removed from the grid and from the database.';
    if (/\bclick\s+cancel\b|\bdismiss\b/.test(t)) return 'The action is dismissed; the previous state is restored with no side effects.';
    if (/\bclick\s+back\b/.test(t)) return 'The user is navigated to the previous view.';
    if (/\bclick\b/.test(t)) return 'The button/link is triggered; the UI reflects the resulting state change.';

    if (/\bfill\b|\benter\b|\btype\b/.test(t)) return 'The value is accepted into the target field(s) and is visible in the DOM (a subsequent read via the same locator returns it).';
    if (/\bselect\b|\bchoose\b|\bpick\b/.test(t)) return 'The selection is applied and reflected in the corresponding form control.';
    if (/\bcheck\s+.*\bcomplete\b/.test(t)) return 'The status toggle enters the checked state; downstream form validation is triggered.';
    if (/\bcheck\b|\btoggle on\b/.test(t)) return 'The checkbox/toggle enters the checked state.';
    if (/\buncheck\b|\btoggle off\b|\bclear\b/.test(t)) return 'The checkbox/toggle enters the unchecked state.';
    if (/\bset\s+closed\b/.test(t)) return 'The Closed toggle is enabled; the on-change client script auto-fills the Closed Date with today.';
    if (/\bset\b/.test(t)) return 'The value is applied to the target control and any dependent client-side scripts are triggered.';

    if (/\bsend\b/.test(t) && /\bmailto\b/.test(t)) return 'The mailto: URL is opened; the composed subject/body/to fields match the deficiency template.';

    if (/\bwait\b|\bfor\b/.test(t) && /\bseconds?|\bms\b|\btimeout\b/.test(t)) return 'The specified wait elapses without a page or network error.';

    return 'The step completes without error and the application reaches the state expected by the following step.';
}

/** {key} + <key> substitution using the resolved data row. */
function interpolate(text: string, row: Record<string, string> | undefined): string {
    if (!row) return text;
    return text
        .replace(/\{([^{}]+)\}/g, (_m, k) => (row[k] !== undefined && row[k] !== null ? String(row[k]) : `{${k}}`))
        .replace(/<([^<>\s]+)>/g, (_m, k) => (row[k] !== undefined && row[k] !== null ? String(row[k]) : `<${k}>`));
}

interface AdoTestStep {
    action: string;
    expectedResult: string;
}

/**
 * Given/When → action rows. Then/And-after-Then → expected of the LAST action.
 * When no explicit Then follows an action, verb-inferred expected result fills in.
 * Cucumber semantic: `And` inherits the previous keyword.
 */
function pairActionsWithExpected(scenario: ParsedScenario, row: Record<string, string> | undefined): AdoTestStep[] {
    const steps: AdoTestStep[] = [];
    let lastNonAndKw: 'given' | 'when' | 'then' | null = null;
    let pendingAction: string | null = null;

    for (const s of scenario.steps) {
        const rawKw = s.keyword.toLowerCase();
        const text = interpolate(s.text, row);
        let sem: 'given' | 'when' | 'then';
        if (rawKw === 'and' || rawKw === 'but') sem = lastNonAndKw ?? 'when';
        else if (rawKw === 'given') sem = 'given';
        else if (rawKw === 'when') sem = 'when';
        else if (rawKw === 'then') sem = 'then';
        else sem = 'when';
        if (rawKw !== 'and' && rawKw !== 'but') lastNonAndKw = sem;

        const displayText = `${capitalize(rawKw)} ${text}`.trim();

        if (sem === 'then') {
            if (pendingAction !== null) {
                steps.push({ action: pendingAction, expectedResult: text });
                pendingAction = null;
            } else {
                steps.push({ action: 'Also verify', expectedResult: text });
            }
        } else {
            if (pendingAction !== null) {
                steps.push({ action: pendingAction, expectedResult: inferExpectedResult(pendingAction) });
            }
            pendingAction = displayText;
        }
    }
    if (pendingAction !== null) {
        steps.push({ action: pendingAction, expectedResult: inferExpectedResult(pendingAction) });
    }
    return steps;
}

// -----------------------------------------------------------------------------
// SQL query extraction. Optional — the tool works without a query catalog.
// Loads *-db-queries.env files from ${workspaceRoot}/config/**, then scans the
// feature's step-def + helper .ts files for query-name string literals.
// -----------------------------------------------------------------------------

interface ResolvedNamedQuery {
    name: string;
    sql: string;
    purpose?: string;
}

function loadNamedQueriesCatalog(workspaceRoot: string): Map<string, ResolvedNamedQuery> {
    const out = new Map<string, ResolvedNamedQuery>();
    const envFiles: string[] = [];
    const configDir = path.join(workspaceRoot, 'config');
    if (fs.existsSync(configDir)) {
        const walk = (d: string, depth: number): void => {
            if (depth < 0) return;
            let entries: fs.Dirent[]; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (e.name.startsWith('.') || e.name === 'node_modules') continue;
                const fp = path.join(d, e.name);
                if (e.isDirectory()) walk(fp, depth - 1);
                else if (fp.endsWith('.env')) {
                    const bn = e.name.toLowerCase();
                    if (bn.includes('queries') || bn.includes('query') || bn.includes('db-queries')) envFiles.push(fp);
                }
            }
        };
        walk(configDir, 5);
    }
    for (const fp of envFiles) {
        let content: string; try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
        // Simple KEY=VALUE parser; multi-line SQL values assumed single-line-here (env-file convention).
        for (const line of content.split(/\r?\n/)) {
            const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line.trim());
            if (!m) continue;
            const key = m[1];
            let val = m[2].trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (key.startsWith('DB_QUERY_') || key.endsWith('_QUERY') || val.toUpperCase().includes('SELECT ') || val.toUpperCase().includes('UPDATE ')) {
                out.set(key, { name: key, sql: val });
            }
        }
    }
    return out;
}

function extractQueriesUsedByFeature(featureAbsPath: string, workspaceRoot: string, catalog: Map<string, ResolvedNamedQuery>): ResolvedNamedQuery[] {
    if (catalog.size === 0) return [];
    const rel = path.relative(workspaceRoot, featureAbsPath);
    if (!rel || rel.startsWith('..')) return [];
    const parts = rel.split(/[\\/]/);
    const featIdx = parts.indexOf('features');
    if (featIdx < 0) return [];
    const testRoot = parts.slice(0, featIdx).join(path.sep);
    const subDir = parts.slice(featIdx + 1, -1).join(path.sep);
    const scanRoots = [
        path.join(workspaceRoot, testRoot, 'steps', subDir),
        path.join(workspaceRoot, testRoot, 'helpers', subDir),
        path.join(workspaceRoot, testRoot, 'pages', subDir),
        path.join(workspaceRoot, testRoot, 'helpers'),
        path.join(workspaceRoot, testRoot, 'pages'),
    ];
    const short = new Map<string, string>();
    for (const k of catalog.keys()) short.set(k.replace(/^DB_QUERY_/, ''), k);
    const found = new Set<string>();
    const visited = new Set<string>();
    const scan = (fp: string): void => {
        if (visited.has(fp)) return;
        visited.add(fp);
        let content: string; try { content = fs.readFileSync(fp, 'utf-8'); } catch { return; }
        const re = /['"`]([A-Z][A-Z0-9_]{4,})['"`]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            const lit = m[1];
            if (catalog.has(lit)) found.add(lit);
            else if (short.has(lit)) found.add(short.get(lit)!);
        }
    };
    for (const root of scanRoots) {
        if (!fs.existsSync(root)) continue;
        let entries: fs.Dirent[]; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) if (e.isFile() && e.name.endsWith('.ts')) scan(path.join(root, e.name));
    }
    return Array.from(found).sort().map((k) => catalog.get(k)!).filter(Boolean);
}

// -----------------------------------------------------------------------------
// Rich Description + Preconditions builders (HTML).
// -----------------------------------------------------------------------------

interface ComposeCtx {
    workspaceRoot: string;
    featurePath: string;
    defaults: AdoDefaults;
    namedQueries: ResolvedNamedQuery[];
}

/**
 * Render a `<h3>Test Data</h3>` HTML table when the scenario is a
 * Scenario Outline with 1+ matched rows. Returns '' when the table would add
 * no value (no rows, or 1 row with no `<placeholder>` in the steps).
 * Column headers = union of all row keys, preserving first-row insertion order.
 */
function buildTestDataTable(scenario: ParsedScenario, rows: Array<Record<string, string>>): string {
    if (!scenario.isOutline || rows.length === 0) return '';
    // For 1-row cases with no placeholders in steps, skip — table adds nothing.
    if (rows.length === 1) {
        const anyPlaceholder = scenario.steps.some((s) => /<[^<>\s]+>/.test(s.text));
        if (!anyPlaceholder) return '';
    }
    // Union of keys — first row order first, then any new keys from subsequent rows.
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
        for (const k of Object.keys(r)) {
            if (!seen.has(k)) { seen.add(k); cols.push(k); }
        }
    }
    if (cols.length === 0) return '';
    // ADO's rich-text renderer strips deprecated HTML attributes (border, cellpadding,
    // cellspacing) but honours inline `style`. Use style="border-collapse:collapse"
    // on the table + per-cell borders + padding for legibility.
    const tableStyle = 'border-collapse:collapse;border:1px solid #ccc;margin:6px 0';
    const thStyle = 'border:1px solid #ccc;padding:4px 8px;background:#f4f4f4;text-align:left;font-weight:bold';
    const tdStyle = 'border:1px solid #ccc;padding:4px 8px';
    const parts: string[] = [];
    parts.push('<h3>Test Data</h3>');
    parts.push(`<table style="${tableStyle}">`);
    parts.push('<tr>' + cols.map((c) => `<th style="${thStyle}">${escapeHtml(c)}</th>`).join('') + '</tr>');
    for (const r of rows) {
        parts.push('<tr>' + cols.map((c) => `<td style="${tdStyle}">${escapeHtml(String(r[c] ?? ''))}</td>`).join('') + '</tr>');
    }
    parts.push('</table>');
    return parts.join('\n');
}

function buildRichDescription(feature: ParsedFeature, scenario: ParsedScenario, row: Record<string, string> | undefined, ctx: ComposeCtx, priority: number, allRows: Array<Record<string, string>> = []): string {
    const module = deriveModuleLabel(feature.tags) || inferModuleFromTags(feature.tags) || '';
    const coverageKinds = deriveCoverageKinds(scenario.tags);
    const environment = ctx.defaults.environment || '';
    const appUrl = ctx.defaults.appUrl || '';
    const role = row && String(row['role'] || row['userRole'] || row['user_role'] || '') || '';
    const scenarioIntent = deriveScenarioIntent(scenario.name, coverageKinds);
    const featureDescClean = collapseWhitespace(feature.description);
    const tags = dedupe([...feature.tags, ...scenario.tags]);

    const parts: string[] = [];
    parts.push('<h2>Test Objective</h2>');
    parts.push(`<p>${escapeHtml(scenarioIntent)}</p>`);

    parts.push('<h2>Feature Context</h2>');
    parts.push('<p>');
    parts.push(`<b>Feature:</b> ${escapeHtml(feature.name || '(unnamed)')}<br/>`);
    if (module) parts.push(`<b>Module:</b> ${escapeHtml(module)}<br/>`);
    if (coverageKinds.length > 0) parts.push(`<b>Test Type:</b> ${escapeHtml(coverageKinds.join(', '))}<br/>`);
    parts.push(`<b>Priority:</b> P${priority}`);
    parts.push('</p>');
    if (featureDescClean) parts.push(`<p>${escapeHtml(featureDescClean)}</p>`);

    parts.push('<h2>Preconditions</h2>');
    const preItems: string[] = [];
    if (environment) preItems.push(`<li><b>Environment:</b> ${escapeHtml(environment)}</li>`);
    if (appUrl) preItems.push(`<li><b>Application URL:</b> ${escapeHtml(appUrl)}</li>`);
    if (role) preItems.push(`<li><b>Required Role:</b> ${escapeHtml(role)}</li>`);
    if (row && row['userName']) preItems.push(`<li><b>Test User:</b> ${escapeHtml(String(row['userName']))}</li>`);
    const dataSource = scenario.examples?.json?.source;
    const dataFilter = scenario.examples?.json?.filter;
    if (dataSource) preItems.push(`<li><b>Test Data Source:</b> <code>${escapeHtml(dataSource)}</code></li>`);
    if (dataFilter) preItems.push(`<li><b>Data Filter:</b> <code>${escapeHtml(dataFilter)}</code></li>`);
    const scenarioIdTag = extractScenarioIdTag(scenario);
    if (scenarioIdTag) preItems.push(`<li><b>Legacy Test Case ID:</b> ${escapeHtml(scenarioIdTag)}</li>`);
    if (preItems.length > 0) {
        parts.push('<ul>');
        parts.push(...preItems);
        parts.push('</ul>');
    } else {
        parts.push('<p>(No environment defaults configured — set <code>ado.defaults.environment</code> / <code>appUrl</code> in <code>cs-playwright-mcp.config.json</code> to populate this section.)</p>');
    }

    const dataPrereqs = extractDataPrerequisites(feature, scenario);
    if (dataPrereqs.length > 0) {
        parts.push('<h3>Data Prerequisites</h3>');
        parts.push('<ul>');
        for (const p of dataPrereqs) parts.push(`<li>${p}</li>`);
        parts.push('</ul>');
    }

    // Background steps used to be listed here, but they now appear as the FIRST
    // rows of the ADO Steps grid (see composeTestCase). Repeating them here was
    // redundant clutter. They're still summarized in the Preconditions field.

    if (ctx.namedQueries.length > 0) {
        parts.push('<h3>SQL Queries Used by This Scenario</h3>');
        parts.push('<p>These are the named database queries the step-definitions and helpers invoke while executing this scenario. Names are declared in the framework\'s <code>*-db-queries.env</code> files.</p>');
        for (const q of ctx.namedQueries) {
            parts.push(`<p><b>${escapeHtml(q.name)}</b>${q.purpose ? ' — ' + escapeHtml(q.purpose) : ''}</p>`);
            parts.push(`<pre>${escapeHtml(q.sql.trim())}</pre>`);
        }
    }

    // Test Data table — Scenario Outline with matched Examples rows.
    const testDataTable = buildTestDataTable(scenario, allRows);
    if (testDataTable) parts.push(testDataTable);

    if (tags.length > 0) {
        parts.push('<h3>Coverage Tags</h3>');
        parts.push(`<p>${tags.map((t) => `<code>${escapeHtml(t)}</code>`).join(' ')}</p>`);
    }

    parts.push('<h3>Automation Reference</h3>');
    parts.push(`<p><b>Feature file:</b> <code>${escapeHtml(ctx.featurePath)}</code><br/>`);
    parts.push(`<b>Scenario:</b> <code>${escapeHtml(scenario.name)}</code></p>`);

    return parts.join('\n');
}

function buildPreconditionsHtml(feature: ParsedFeature, scenario: ParsedScenario, row: Record<string, string> | undefined, ctx: ComposeCtx): string {
    const environment = ctx.defaults.environment || '';
    const appUrl = ctx.defaults.appUrl || '';
    const role = row && String(row['role'] || row['userRole'] || row['user_role'] || '') || '';

    const parts: string[] = [];
    parts.push('<p><b>Environment &amp; Access</b></p>');
    parts.push('<ul>');
    if (environment) parts.push(`<li>Environment: <code>${escapeHtml(environment)}</code></li>`);
    if (appUrl) parts.push(`<li>Application URL: <code>${escapeHtml(appUrl)}</code></li>`);
    if (role) parts.push(`<li>Required user role: <b>${escapeHtml(role)}</b></li>`);
    if (row && row['userName']) parts.push(`<li>Test user account: <code>${escapeHtml(String(row['userName']))}</code></li>`);
    if (parts[parts.length - 1] === '<ul>') { parts.pop(); parts.pop(); } else { parts.push('</ul>'); }

    const dataSource = scenario.examples?.json?.source;
    const dataFilter = scenario.examples?.json?.filter;
    if (dataSource || dataFilter) {
        parts.push('<p><b>Test Data</b></p>');
        parts.push('<ul>');
        if (dataSource) parts.push(`<li>Source file: <code>${escapeHtml(dataSource)}</code></li>`);
        if (dataFilter) parts.push(`<li>Filter: <code>${escapeHtml(dataFilter)}</code></li>`);
        parts.push('</ul>');
    }

    const dataPrereqs = extractDataPrerequisites(feature, scenario);
    if (dataPrereqs.length > 0) {
        parts.push('<p><b>Data Prerequisites</b></p>');
        parts.push('<ul>');
        for (const p of dataPrereqs) parts.push(`<li>${p}</li>`);
        parts.push('</ul>');
    }

    if (feature.background?.steps && feature.background.steps.length > 0) {
        parts.push('<p><b>Background steps executed before every scenario</b></p>');
        parts.push('<ol>');
        for (const s of feature.background.steps) {
            parts.push(`<li>${escapeHtml(`${s.keyword} ${interpolate(s.text, row)}`)}</li>`);
        }
        parts.push('</ol>');
    }

    if (scenario.steps[0] && isDataPrepStep(`${scenario.steps[0].keyword} ${scenario.steps[0].text}`)) {
        parts.push('<p><b>Scenario-specific data prep</b></p>');
        parts.push(`<pre>${escapeHtml(scenario.steps[0].text)}</pre>`);
    }

    if (ctx.namedQueries.length > 0) {
        parts.push('<p><b>SQL Queries used by this scenario</b> (from step-def + helper scan)</p>');
        for (const q of ctx.namedQueries) {
            parts.push(`<p><b>${escapeHtml(q.name)}</b>${q.purpose ? ' — ' + escapeHtml(q.purpose) : ''}</p>`);
            parts.push(`<pre>${escapeHtml(q.sql.trim())}</pre>`);
        }
    }

    return parts.join('\n');
}

// -----------------------------------------------------------------------------
// Steps XML builder + reader.
// -----------------------------------------------------------------------------

function escapeStepText(s: string): string {
    // Double-escape: HTML then XML — matches CSAdoAdapter's shape so text with < / > survives ADO's dual parse.
    const html = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildStepsXml(steps: AdoTestStep[]): string {
    if (steps.length === 0) return '';
    const stepEls = steps.map((s, i) => {
        const id = i + 2;
        return `<step id="${id}" type="ActionStep">` +
            `<parameterizedString isformatted="true">${escapeStepText(s.action)}</parameterizedString>` +
            `<parameterizedString isformatted="true">${escapeStepText(s.expectedResult)}</parameterizedString>` +
            `<description/></step>`;
    }).join('');
    return `<steps id="0" last="${steps.length + 1}">${stepEls}</steps>`;
}

// =============================================================================
// Composed test-case shape.
// =============================================================================

interface ComposedTestCase {
    title: string;
    description: string;
    preconditions: string;
    steps: AdoTestStep[];
    priority: number;
    areaPath?: string;
    iterationPath?: string;
    tags: string[];
    automationName: string;
    automationStorage: string;
    automationType: string;
    automationId?: string;
    scenario: ParsedScenario;
}

function composeTestCase(feature: ParsedFeature, scenario: ParsedScenario, row: Record<string, string> | undefined, ctx: ComposeCtx, allRows: Array<Record<string, string>> = []): ComposedTestCase {
    const rawTitle = scenario.name || 'Untitled scenario';
    const title = interpolate(rawTitle, row);
    const tags = dedupe([...feature.tags, ...scenario.tags]);
    const priority = derivePriority(scenario.tags);
    const areaPath = deriveAreaPath(feature.tags) || ctx.defaults.areaPath;
    const description = buildRichDescription(feature, scenario, row, ctx, priority, allRows);
    const preconditions = buildPreconditionsHtml(feature, scenario, row, ctx);
    // Background steps run before every scenario in Cucumber. A manual tester reading
    // the ADO Steps grid needs the full runnable script, not just the scenario body.
    // Prepend background — the composed steps read: setup → scenario When → scenario Then.
    const scenarioWithBackground: ParsedScenario = {
        ...scenario,
        steps: [...(feature.background?.steps ?? []), ...scenario.steps],
    };
    const steps = pairActionsWithExpected(scenarioWithBackground, row);
    const basename = path.basename(ctx.featurePath);
    const scenarioId = extractScenarioIdTag(scenario);
    return {
        title: `${feature.name} — ${title}`.slice(0, 250),
        description,
        preconditions,
        steps,
        priority,
        areaPath,
        iterationPath: ctx.defaults.iterationPath,
        tags,
        automationName: title,
        automationStorage: basename,
        automationType: 'Playwright',
        automationId: scenarioId ? `@TC:${scenarioId}` : (scenario.tags[0] ? scenario.tags[0].replace(/^@/, '') : undefined),
        scenario,
    };
}

// =============================================================================
// Suite management: locate root, reuse-or-create named sub-suite, add-tc.
// =============================================================================

interface AdoSuiteRef {
    id: number;
    name: string;
    parentSuiteId?: number;
}

async function getPlanRootSuite(cfg: AdoCreds, planId: number): Promise<AdoSuiteRef | null> {
    try {
        const plan = await adoRequest(cfg, 'GET', `_apis/testplan/plans/${planId}?api-version=7.0`) as { rootSuite?: { id: number; name?: string } };
        if (plan.rootSuite?.id) return { id: plan.rootSuite.id, name: plan.rootSuite.name || `Plan-${planId}-root` };
        return null;
    } catch {
        return null;
    }
}

async function listSuitesInPlan(cfg: AdoCreds, planId: number): Promise<AdoSuiteRef[]> {
    try {
        const r = await adoRequest(cfg, 'GET', `_apis/testplan/plans/${planId}/suites?api-version=7.0`) as { value?: Array<{ id: number; name?: string; parentSuite?: { id?: number } }> };
        return (r.value || []).map((s) => ({ id: s.id, name: s.name || '', parentSuiteId: s.parentSuite?.id }));
    } catch {
        return [];
    }
}

async function createSuite(cfg: AdoCreds, planId: number, parentSuiteId: number, name: string): Promise<AdoSuiteRef> {
    const body = { suiteType: 'StaticTestSuite', name, parentSuite: { id: parentSuiteId } };
    const r = await adoRequest(cfg, 'POST', `_apis/testplan/plans/${planId}/suites?api-version=7.0`, body, 'application/json') as { id: number; name?: string };
    return { id: r.id, name: r.name || name, parentSuiteId };
}

async function addTestCasesToSuite(cfg: AdoCreds, planId: number, suiteId: number, testCaseIds: number[]): Promise<void> {
    if (testCaseIds.length === 0) return;
    const body = testCaseIds.map((id) => ({ workItem: { id } }));
    await adoRequest(cfg, 'POST', `_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.0`, body, 'application/json');
}

// =============================================================================
// Idempotent lookup: suite-scoped first, then title WIQL project-wide.
// =============================================================================

interface ExistingTc {
    id: number;
    title: string;
    fields: Record<string, unknown>;
    relations?: Array<{ rel: string; url: string }>;
}

async function listTestCaseIdsInSuite(cfg: AdoCreds, planId: number, suiteId: number): Promise<number[]> {
    try {
        const r = await adoRequest(cfg, 'GET', `_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.0`) as { value?: Array<{ workItem?: { id?: number } }> };
        return (r.value || []).map((v) => Number(v.workItem?.id || 0)).filter((n) => n > 0);
    } catch {
        return [];
    }
}

async function findExistingByTitle(cfg: AdoCreds, title: string): Promise<ExistingTc | null> {
    // Try WIQL — permissive fuzzy match on exact title.
    try {
        const wiql = `SELECT [System.Id],[System.Title] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND [System.Title] = '${title.replace(/'/g, "''")}'`;
        const wiqlR = await adoRequest(cfg, 'POST', `_apis/wit/wiql?api-version=7.0`, { query: wiql }, 'application/json') as { workItems?: Array<{ id: number }> };
        const ids = (wiqlR.workItems || []).map((w) => w.id).slice(0, 5);
        if (ids.length === 0) return null;
        return readWorkItemFull(cfg, ids[0]);
    } catch {
        return null;
    }
}

async function readWorkItemFull(cfg: AdoCreds, id: number): Promise<ExistingTc | null> {
    try {
        const r = await adoRequest(cfg, 'GET', `_apis/wit/workitems/${id}?api-version=7.0&$expand=all`) as { id?: number; fields?: Record<string, unknown>; relations?: Array<{ rel: string; url: string }> };
        if (!r.id) return null;
        return { id: r.id, title: String(r.fields?.['System.Title'] || ''), fields: r.fields || {}, relations: r.relations };
    } catch {
        return null;
    }
}

async function findExistingBySuiteAndTitle(cfg: AdoCreds, planId: number, suiteId: number, title: string): Promise<ExistingTc | null> {
    const ids = await listTestCaseIdsInSuite(cfg, planId, suiteId);
    for (const id of ids) {
        const wi = await readWorkItemFull(cfg, id);
        if (wi && wi.title === title) return wi;
    }
    return findExistingByTitle(cfg, title);
}

// =============================================================================
// Diff — decides whether to PATCH (updated) or skip (unchanged).
// =============================================================================

function diffFields(existing: ExistingTc, composed: ComposedTestCase): string[] {
    const changes: string[] = [];
    const f = existing.fields;
    if (String(f['System.Title'] || '') !== composed.title) changes.push('title');
    if (String(f['System.Description'] || '') !== composed.description) changes.push('description');
    if (String(f['Microsoft.VSTS.TCM.SystemInfo'] || '') !== composed.preconditions) changes.push('preconditions');
    if (String(f['Microsoft.VSTS.TCM.Steps'] || '') !== buildStepsXml(composed.steps)) changes.push('steps');
    const curPri = Number(f['Microsoft.VSTS.Common.Priority'] || 2);
    if (curPri !== composed.priority) changes.push('priority');
    const curTags = String(f['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean).sort().join(',');
    const wantTags = filterAdoTags(composed.tags).slice().sort().join(',');
    if (curTags !== wantTags) changes.push('tags');
    if (String(f['Microsoft.VSTS.TCM.AutomatedTestName'] || '') !== composed.automationName) changes.push('automationName');
    if (String(f['Microsoft.VSTS.TCM.AutomatedTestStorage'] || '') !== composed.automationStorage) changes.push('automationStorage');
    if (String(f['Microsoft.VSTS.TCM.AutomatedTestType'] || '') !== composed.automationType) changes.push('automationType');
    if (composed.automationId && String(f['Microsoft.VSTS.TCM.AutomatedTestId'] || '') !== composed.automationId) changes.push('automationId');
    return changes;
}

// =============================================================================
// Build the JSON-patch payload used for both create + update.
// =============================================================================

function buildPatchOps(composed: ComposedTestCase, cfg: AdoCreds, parentUserStoryId?: number, forUpdate = false): Array<Record<string, unknown>> {
    const op = forUpdate ? 'replace' : 'add';
    const ops: Array<Record<string, unknown>> = [
        { op, path: '/fields/System.Title', value: composed.title },
        { op, path: '/fields/System.Description', value: composed.description },
        { op, path: '/fields/Microsoft.VSTS.TCM.SystemInfo', value: composed.preconditions },
        { op, path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(composed.steps) },
        { op, path: '/fields/Microsoft.VSTS.Common.Priority', value: composed.priority },
        { op, path: '/fields/Microsoft.VSTS.TCM.AutomationStatus', value: 'Automated' },
        { op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestName', value: composed.automationName },
        { op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestStorage', value: composed.automationStorage },
        { op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestType', value: composed.automationType },
    ];
    if (composed.automationId) ops.push({ op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestId', value: composed.automationId });
    if (composed.areaPath) ops.push({ op, path: '/fields/System.AreaPath', value: composed.areaPath });
    if (composed.iterationPath) ops.push({ op, path: '/fields/System.IterationPath', value: composed.iterationPath });
    const adoTags = filterAdoTags(composed.tags);
    if (adoTags.length > 0) ops.push({ op, path: '/fields/System.Tags', value: adoTags.join('; ') });
    if (parentUserStoryId && !forUpdate) {
        ops.push({
            op: 'add', path: '/relations/-',
            value: {
                rel: 'Microsoft.VSTS.Common.TestedBy-Reverse',
                url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${parentUserStoryId}`,
            },
        });
    }
    return ops;
}

async function ensureParentStoryLink(cfg: AdoCreds, existing: ExistingTc, parentUserStoryId: number): Promise<boolean> {
    // Idempotent — only add if not already linked.
    const wantedUrlSuffix = `/_apis/wit/workitems/${parentUserStoryId}`;
    const rels = existing.relations || [];
    const alreadyLinked = rels.some((r) => r.rel === 'Microsoft.VSTS.Common.TestedBy-Reverse' && r.url.endsWith(wantedUrlSuffix));
    if (alreadyLinked) return false;
    const patch = [{
        op: 'add', path: '/relations/-',
        value: {
            rel: 'Microsoft.VSTS.Common.TestedBy-Reverse',
            url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${parentUserStoryId}`,
        },
    }];
    await adoRequest(cfg, 'PATCH', `_apis/wit/workitems/${existing.id}?api-version=7.0`, patch);
    return true;
}

// =============================================================================
// Feature-file discovery for bulk mode.
// =============================================================================

function collectFeatureFiles(rootAbs: string): string[] {
    const out: string[] = [];
    const walk = (d: string, depth: number): void => {
        if (depth < 0) return;
        let entries: fs.Dirent[]; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(d, e.name);
            if (e.isDirectory()) walk(fp, depth - 1);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.feature')) out.push(fp);
        }
    };
    if (fs.existsSync(rootAbs)) {
        const st = fs.statSync(rootAbs);
        if (st.isDirectory()) walk(rootAbs, 10);
        else if (st.isFile() && rootAbs.toLowerCase().endsWith('.feature')) out.push(rootAbs);
    }
    return out.sort();
}

function filterScenariosByTag(scenarios: ParsedScenario[], tagFilter: string | undefined): ParsedScenario[] {
    if (!tagFilter) return scenarios;
    const target = tagFilter.startsWith('@') ? tagFilter : `@${tagFilter}`;
    return scenarios.filter((s) => s.tags.some((t) => t === target));
}

// =============================================================================
// Zod schemas.
// =============================================================================

const InputSchema = z.object({
    featurePath: z.string().min(1).optional().describe('Path to a single .feature file (relative to workspace or absolute). Mutually optional with featureFolder.'),
    featureFolder: z.string().min(1).optional().describe('Root folder to recursively publish every .feature file found under it. Overrides featurePath when both are set.'),
    planId: z.number().int().positive().optional().describe('ADO test plan ID. Alternative: planName.'),
    planName: z.string().min(1).optional().describe('Plan name — resolved to planId at run time. Mismatch with planId → warning, id wins. Ambiguous → tool stops with candidate list.'),
    suiteId: z.number().int().positive().optional().describe('Explicit suite ID. If omitted, a child suite named after the feature title is created under the plan root.'),
    suiteName: z.string().optional().describe('Override the auto-derived child-suite name (defaults to the feature title).'),
    reuseExistingSuiteWithSameName: z.boolean().default(true).describe('When creating a child suite, reuse an existing one with the same name if present.'),
    parentUserStoryId: z.number().int().positive().optional().describe('User story ID to link created test cases to via Microsoft.VSTS.Common.TestedBy-Reverse.'),
    parentUserStoryTitle: z.string().min(1).optional().describe('Story/PBI title — resolved to parentUserStoryId via WIQL. Ambiguous → tool stops with candidates.'),
    scenarioTagFilter: z.string().optional().describe('Publish only scenarios whose tags contain this literal (e.g. @ac1). Combined with any file/folder input.'),
    areaPath: z.string().optional().describe('Override AreaPath. Falls back to ado.defaults.areaPath, then project name.'),
    iterationPath: z.string().optional().describe('Override IterationPath. Falls back to ado.defaults.iterationPath, then project name.'),
    syncBackTags: z.boolean().default(true).describe('After ADO writes, sync `@TestPlanId`, `@TestSuiteId`, `@TestCaseId` tags back to the source `.feature` file. Non-fatal — a sync failure logs a warning but does not fail the ADO op.'),
    dryRun: z.boolean().default(false).describe('Preview payloads without any ADO write.'),
}).refine((v) => v.planId !== undefined || v.planName !== undefined, { message: 'planId or planName required' });
type Input = z.infer<typeof InputSchema>;

const CreatedRowSchema = z.object({ id: z.number(), title: z.string(), tags: z.array(z.string()), url: z.string().optional(), scenarioLine: z.number().optional() });
const UpdatedRowSchema = z.object({ id: z.number(), title: z.string(), tags: z.array(z.string()), driftFields: z.array(z.string()), url: z.string().optional(), scenarioLine: z.number().optional() });
const UnchangedRowSchema = z.object({ id: z.number(), title: z.string(), scenarioLine: z.number().optional() });
const NamedRowSchema = z.object({ title: z.string(), reason: z.string() });

const SyncBackSchema = z.object({
    fileChanged: z.boolean(),
    scenariosPatched: z.number(),
    hoisted: z.array(z.string()),
    demoted: z.array(z.string()),
    tagsAdded: z.number(),
    tagsRemoved: z.number(),
    driftWarnings: z.array(z.string()),
}).optional();

const PerFileSchema = z.object({
    featurePath: z.string(),
    featureTitle: z.string(),
    scenariosFound: z.number(),
    scenariosPublished: z.number(),
    suiteIdUsed: z.number().optional(),
    suiteCreated: z.boolean(),
    created: z.array(CreatedRowSchema),
    updated: z.array(UpdatedRowSchema),
    unchanged: z.array(UnchangedRowSchema),
    skipped: z.array(NamedRowSchema),
    failed: z.array(NamedRowSchema),
    addedToSuite: z.number(),
    warnings: z.array(z.string()).default([]),
    syncBack: SyncBackSchema,
});

const OutputSchema = z.object({
    dryRun: z.boolean(),
    planId: z.number().optional(),
    parentUserStoryId: z.number().optional(),
    scenarioTagFilter: z.string().optional(),
    files: z.array(PerFileSchema),
    // Populated when a *Name lookup was ambiguous. When ambiguous:true, NO files were processed —
    // the caller (skill) should present the candidates and re-run with an explicit id.
    ambiguous: z.boolean().optional(),
    ambiguousCandidates: z.array(z.object({ id: z.number(), name: z.string(), note: z.string().optional() })).optional(),
    notFound: z.array(z.string()).default([]),
    totals: z.object({
        featuresProcessed: z.number(),
        scenariosFound: z.number(),
        created: z.number(),
        updated: z.number(),
        unchanged: z.number(),
        skipped: z.number(),
        failed: z.number(),
        syncBackFilesChanged: z.number().default(0),
    }),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Per-file publish logic.
// =============================================================================

async function publishOneFile(args: {
    featureAbs: string;
    input: Input;
    cfg: AdoCreds;
    defaults: AdoDefaults;
    workspaceRoot: string;
    warnings: string[];
    queryCatalog: Map<string, ResolvedNamedQuery>;
    isDryRun: boolean;
}): Promise<z.infer<typeof PerFileSchema>> {
    const { featureAbs, input, cfg, defaults, workspaceRoot, warnings, queryCatalog, isDryRun } = args;
    // input.planId is guaranteed set by the caller (name resolution completed upstream).
    // A local narrows the type for TypeScript without repeated non-null assertions.
    const planId = input.planId as number;
    const featureRel = path.relative(workspaceRoot, featureAbs);
    const content = fs.readFileSync(featureAbs, 'utf-8');
    const feature = parseFeature(content, featureAbs);

    const filteredScenarios = filterScenariosByTag(feature.scenarios, input.scenarioTagFilter);

    const perFile: z.infer<typeof PerFileSchema> = {
        featurePath: featureRel,
        featureTitle: feature.name,
        scenariosFound: feature.scenarios.length,
        scenariosPublished: filteredScenarios.length,
        suiteCreated: false,
        created: [], updated: [], unchanged: [], skipped: [], failed: [], addedToSuite: 0,
        warnings: [],
    };

    if (filteredScenarios.length === 0) {
        if (input.scenarioTagFilter) {
            perFile.skipped.push({ title: `(entire file)`, reason: `No scenarios matching tag ${input.scenarioTagFilter}` });
        } else {
            perFile.skipped.push({ title: `(entire file)`, reason: 'No scenarios' });
        }
        return perFile;
    }

    // Extract queries used across the whole feature — displayed per-scenario in description.
    const queriesForFeature = extractQueriesUsedByFeature(featureAbs, workspaceRoot, queryCatalog);

    const ctx: ComposeCtx = {
        workspaceRoot,
        featurePath: featureRel,
        defaults: {
            environment: defaults.environment,
            appUrl: defaults.appUrl,
            areaPath: input.areaPath || defaults.areaPath,
            iterationPath: input.iterationPath || defaults.iterationPath,
        },
        namedQueries: queriesForFeature,
    };

    // Compose payloads with resolved data rows. Test Data table renders from
    // ALL matched rows (unresolved — placeholders stay literal for stable diffs).
    const composed = filteredScenarios.map((s) => {
        const row = loadFirstDataRow(workspaceRoot, s.examples?.json);
        const allRows = loadAllDataRows(workspaceRoot, s.examples?.json);
        return composeTestCase(feature, s, row, ctx, allRows);
    });

    if (isDryRun) {
        // In dry-run we still resolve suite name so preview shows it.
        const suiteName = input.suiteName || feature.name || path.basename(featureAbs, '.feature');
        perFile.suiteIdUsed = input.suiteId;
        perFile.suiteCreated = !input.suiteId;
        for (const c of composed) {
            perFile.created.push({ id: -1, title: c.title, tags: c.tags, scenarioLine: c.scenario.line });
        }
        // Attach suite-name-preview to note via warnings row (concise).
        warnings.push(`[dry-run] Would use suite: "${suiteName}"${input.suiteId ? ` (id ${input.suiteId})` : ' (auto-create under plan root)'}.`);
        return perFile;
    }

    // Resolve or create suite.
    let suiteIdUsed = input.suiteId;
    let suiteCreated = false;
    if (!suiteIdUsed) {
        const root = await getPlanRootSuite(cfg, planId);
        if (!root) {
            warnings.push(`Could not resolve root suite for plan ${planId} — test cases will not be added to any suite.`);
        } else {
            const desiredName = input.suiteName || feature.name || path.basename(featureAbs, '.feature');
            let existing: AdoSuiteRef | undefined;
            if (input.reuseExistingSuiteWithSameName) {
                const all = await listSuitesInPlan(cfg, planId);
                existing = all.find((s) => s.name === desiredName && s.parentSuiteId === root.id);
            }
            if (existing) {
                suiteIdUsed = existing.id;
            } else {
                try {
                    const created = await createSuite(cfg, planId, root.id, desiredName);
                    suiteIdUsed = created.id;
                    suiteCreated = true;
                } catch (e) {
                    warnings.push(`Failed to create suite "${desiredName}" under plan ${planId}: ${(e as Error).message}`);
                }
            }
        }
    }
    perFile.suiteIdUsed = suiteIdUsed;
    perFile.suiteCreated = suiteCreated;

    // Publish each composed test case (create or update).
    // A scenario carrying `@TestCaseId:<n>` or `@TestCaseId:{n1,n2,...}` in its
    // tag block skips title-match idempotency and PATCHes those specific IDs
    // directly. A single scenario with N pinned IDs pushes the SAME composed
    // content to every ID (many-to-one automation → many ADO cases).
    for (const c of composed) {
        try {
            const pinnedIds = extractTestCaseIdsFromScenario(c.scenario.tags);
            if (pinnedIds.length > 0) {
                for (const pinnedId of pinnedIds) {
                    const existing = await readWorkItemFull(cfg, pinnedId);
                    if (!existing) {
                        perFile.warnings.push(`Pinned @TestCaseId:${pinnedId} for scenario "${c.title}" not found in ADO (deleted?) — skipped.`);
                        continue;
                    }
                    const drift = diffFields(existing, c);
                    if (drift.length === 0) {
                        perFile.unchanged.push({ id: existing.id, title: c.title, scenarioLine: c.scenario.line });
                        if (input.parentUserStoryId) {
                            try { await ensureParentStoryLink(cfg, existing, input.parentUserStoryId); }
                            catch (e) { warnings.push(`Failed to update TestedBy link on #${existing.id}: ${(e as Error).message}`); }
                        }
                    } else {
                        const patch = buildPatchOps(c, cfg, input.parentUserStoryId, true);
                        await adoRequest(cfg, 'PATCH', `_apis/wit/workitems/${existing.id}?api-version=7.0`, patch);
                        if (input.parentUserStoryId) {
                            try { await ensureParentStoryLink(cfg, existing, input.parentUserStoryId); }
                            catch (e) { warnings.push(`Failed to add TestedBy link on #${existing.id}: ${(e as Error).message}`); }
                        }
                        perFile.updated.push({ id: existing.id, title: c.title, tags: c.tags, driftFields: drift, scenarioLine: c.scenario.line });
                    }
                }
                continue;
            }
            // Fall through: no pinned IDs → title-match idempotency.
            const existing = suiteIdUsed
                ? await findExistingBySuiteAndTitle(cfg, planId, suiteIdUsed, c.title)
                : await findExistingByTitle(cfg, c.title);
            if (existing) {
                const drift = diffFields(existing, c);
                if (drift.length === 0) {
                    perFile.unchanged.push({ id: existing.id, title: c.title, scenarioLine: c.scenario.line });
                    if (input.parentUserStoryId) {
                        try { await ensureParentStoryLink(cfg, existing, input.parentUserStoryId); }
                        catch (e) { warnings.push(`Failed to update TestedBy link on #${existing.id}: ${(e as Error).message}`); }
                    }
                } else {
                    const patch = buildPatchOps(c, cfg, input.parentUserStoryId, true);
                    await adoRequest(cfg, 'PATCH', `_apis/wit/workitems/${existing.id}?api-version=7.0`, patch);
                    if (input.parentUserStoryId) {
                        try { await ensureParentStoryLink(cfg, existing, input.parentUserStoryId); }
                        catch (e) { warnings.push(`Failed to add TestedBy link on #${existing.id}: ${(e as Error).message}`); }
                    }
                    perFile.updated.push({ id: existing.id, title: c.title, tags: c.tags, driftFields: drift, scenarioLine: c.scenario.line });
                }
            } else {
                const patch = buildPatchOps(c, cfg, input.parentUserStoryId, false);
                const r = await adoRequest(cfg, 'POST', `_apis/wit/workitems/$Test Case?api-version=7.0`, patch) as { id?: number; url?: string };
                if (typeof r.id === 'number') {
                    perFile.created.push({ id: r.id, title: c.title, tags: c.tags, url: r.url, scenarioLine: c.scenario.line });
                } else {
                    perFile.failed.push({ title: c.title, reason: 'ADO returned no id' });
                }
            }
        } catch (e) {
            perFile.failed.push({ title: c.title, reason: (e as Error).message.slice(0, 400) });
        }
    }

    // Add every test case the tool touched (created + updated) to the target suite.
    // Previously this only ran for created ones, which meant a rerun that title-matched
    // existing test cases at the plan root left the auto-created child suite EMPTY —
    // the tool would report "suite created: true, added-to-suite: 0" and the user
    // would rightly ask "then what did the suite creation accomplish?". ADO's
    // add-to-suite endpoint tolerates duplicate adds (409 or 200 no-op — we catch
    // and warn but don't fail the run for it).
    const toAdd: number[] = [
        ...perFile.created.map((c) => c.id),
        ...perFile.updated.map((c) => c.id),
    ];
    if (suiteIdUsed && toAdd.length > 0) {
        try {
            await addTestCasesToSuite(cfg, planId, suiteIdUsed, toAdd);
            perFile.addedToSuite = toAdd.length;
        } catch (e) {
            const errMsg = (e as Error).message;
            // 409 Conflict = already in suite. Not a failure — the user's intent is
            // satisfied (case is in the target suite). Count it as added.
            if (/409|Conflict|already.*(exists|added|in.*suite)/i.test(errMsg)) {
                perFile.addedToSuite = toAdd.length;
                warnings.push(`Some of ${toAdd.length} test case(s) were already in suite ${suiteIdUsed} — counted as added (no duplicate created).`);
            } else {
                warnings.push(`Could not add ${toAdd.length} test case(s) to suite ${suiteIdUsed}: ${errMsg.slice(0, 200)}. The test cases were created/updated — link them to the suite manually via ADO web.`);
            }
        }
    }

    // ------------------------------------------------------------------
    // Sync-back: write tool-managed tags back to the source .feature file.
    // Wrapped in try/catch — sync-back failure NEVER fails the ADO op.
    // ------------------------------------------------------------------
    if (input.syncBackTags) {
        try {
            const mappings: ScenarioMapping[] = buildMappingsForSyncBack(perFile, filteredScenarios, planId, suiteIdUsed);
            if (mappings.length > 0) {
                const syncRes = syncFeatureAfterPublish(featureAbs, mappings, workspaceRoot);
                perFile.syncBack = {
                    fileChanged: syncRes.fileChanged,
                    scenariosPatched: syncRes.scenariosPatched,
                    hoisted: syncRes.hoistedToFeatureLevel,
                    demoted: syncRes.demotedToScenarioLevel,
                    tagsAdded: syncRes.tagsAdded,
                    tagsRemoved: syncRes.tagsRemoved,
                    driftWarnings: syncRes.driftWarnings,
                };
                for (const dw of syncRes.driftWarnings) perFile.warnings.push(`sync-back drift: ${dw}`);
            }
        } catch (e) {
            perFile.warnings.push(`sync-back failed for ${featureRel}: ${(e as Error).message.slice(0, 300)}`);
        }
    }

    return perFile;
}

/**
 * Fold created/updated/unchanged rows back into ScenarioMapping[]. Handles
 * the many-to-one shape: one scenario line may hold multiple test-case rows
 * because a `@TestCaseId:{n1,n2,...}` pinned the scenario to multiple IDs.
 */
function buildMappingsForSyncBack(
    perFile: z.infer<typeof PerFileSchema>,
    filteredScenarios: ParsedScenario[],
    planId: number,
    suiteId?: number,
): ScenarioMapping[] {
    const byLine = new Map<number, ScenarioMapping>();
    const scenarioByLine = new Map<number, ParsedScenario>();
    for (const s of filteredScenarios) scenarioByLine.set(s.line, s);

    const record = (id: number, line: number | undefined, name: string): void => {
        if (line === undefined) return;
        const cur = byLine.get(line);
        if (cur) {
            if (!cur.testCaseIds.includes(id)) cur.testCaseIds.push(id);
        } else {
            byLine.set(line, {
                scenarioLine: line,
                scenarioName: name,
                testCaseIds: [id],
                testPlanId: planId,
                testSuiteId: suiteId,
            });
        }
    };
    for (const c of perFile.created) record(c.id, c.scenarioLine, c.title);
    for (const u of perFile.updated) record(u.id, u.scenarioLine, u.title);
    for (const u of perFile.unchanged) record(u.id, u.scenarioLine, u.title);
    return Array.from(byLine.values());
}

// =============================================================================
// Tool registration.
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_publish_feature_to_ado',
    description: 'Publish Gherkin .feature files as Azure DevOps Test Cases. Rich HTML description (Test Objective, Feature Context, Preconditions, Background Setup, SQL queries, Coverage Tags, Automation Reference), populated Preconditions field, verb-inferred expected results, <placeholder> substitution from Examples JSON (resolves __AUTO_ID:PREFIX__ / __AUTO_NUMBER__ / TODAY[+N B]), all four Automation fields, per-scenario steps as ADO ActionSteps. Suite handling: if planId is given without suiteId, auto-create (or reuse) a child suite named after the feature title. Idempotent: existing test cases with the same title are UPDATED (drift-detected) rather than duplicated. Bulk: pass featureFolder to publish every .feature recursively. Filter: pass scenarioTagFilter to publish only scenarios carrying a specific tag (e.g. @ac1). Set dryRun=true to preview.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const warnings: string[] = [];
        const workspaceRoot = ctx.workspaceRoot;

        // Resolve inputs — accept either featurePath or featureFolder (folder wins).
        if (!input.featurePath && !input.featureFolder) {
            return {
                dryRun: input.dryRun, planId: input.planId, files: [], warnings, notFound: [],
                totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, syncBackFilesChanged: 0 },
                note: 'Provide either featurePath (single file) or featureFolder (bulk).',
            };
        }

        // Collect feature file list.
        let features: string[] = [];
        if (input.featureFolder) {
            const abs = path.isAbsolute(input.featureFolder) ? input.featureFolder : path.resolve(workspaceRoot, input.featureFolder);
            if (!fs.existsSync(abs)) {
                return {
                    dryRun: input.dryRun, planId: input.planId, files: [], warnings, notFound: [],
                    totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, syncBackFilesChanged: 0 },
                    note: `featureFolder not found: ${abs}`,
                };
            }
            features = collectFeatureFiles(abs);
        }
        if (input.featurePath) {
            const abs = path.isAbsolute(input.featurePath) ? input.featurePath : path.resolve(workspaceRoot, input.featurePath);
            if (!fs.existsSync(abs)) {
                return {
                    dryRun: input.dryRun, planId: input.planId, files: [], warnings, notFound: [],
                    totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, syncBackFilesChanged: 0 },
                    note: `featurePath not found: ${abs}`,
                };
            }
            // Merge without duplicates.
            if (!features.includes(abs)) features.push(abs);
        }
        if (features.length === 0) {
            return {
                dryRun: input.dryRun, planId: input.planId, files: [], warnings, notFound: [],
                totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, syncBackFilesChanged: 0 },
                note: 'No .feature files discovered.',
            };
        }

        // Load ADO config unless dryRun.
        let cfg: AdoCreds | null = null;
        let defaults: AdoDefaults = {};
        if (!input.dryRun) {
            const loaded = loadAdo(workspaceRoot);
            if (!loaded) {
                return {
                    dryRun: false, planId: input.planId, files: [], warnings, notFound: [],
                    totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: features.length, syncBackFilesChanged: 0 },
                    note: 'ADO not configured. Set ado.personalAccessToken in cs-playwright-mcp.config.json (ENCRYPTED:… value) OR set ADO_PAT / AZURE_DEVOPS_EXT_PAT env var, OR create ~/.cs-qa/ado-config.json.',
                };
            }
            cfg = loaded.creds;
            defaults = loaded.defaults;
        } else {
            // dryRun: still read defaults so preview description has environment/appUrl.
            const loaded = loadAdo(workspaceRoot);
            if (loaded) defaults = loaded.defaults;
        }

        // Name resolution for planName + parentUserStoryTitle. Skip when no cfg (dryRun without config).
        let resolvedPlanId: number | undefined = input.planId;
        let resolvedParentUserStoryId: number | undefined = input.parentUserStoryId;
        const notFoundNames: string[] = [];
        if (cfg && (input.planName || input.parentUserStoryTitle)) {
            const cache: ResolverCache = createCache();
            if (input.planName || input.planId) {
                const p = await resolvePlan(cfg, { planId: input.planId, planName: input.planName }, cache);
                warnings.push(...p.warnings);
                if (p.ambiguous) {
                    return {
                        dryRun: input.dryRun, planId: input.planId, files: [], warnings, notFound: [],
                        ambiguous: true,
                        ambiguousCandidates: p.candidates,
                        totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, syncBackFilesChanged: 0 },
                        note: `Ambiguous planName "${input.planName}" — ${p.candidates?.length ?? 0} candidates. No writes performed. Pass an explicit planId to disambiguate.`,
                    };
                }
                if (p.resolved.length === 0) {
                    notFoundNames.push(...p.notFound);
                } else {
                    resolvedPlanId = p.resolved[0].id;
                }
            }
            if (input.parentUserStoryTitle || input.parentUserStoryId) {
                const us = await resolveUserStory(cfg, { userStoryId: input.parentUserStoryId, userStoryTitle: input.parentUserStoryTitle }, cache);
                warnings.push(...us.warnings);
                if (us.ambiguous) {
                    return {
                        dryRun: input.dryRun, planId: resolvedPlanId, files: [], warnings, notFound: [],
                        ambiguous: true,
                        ambiguousCandidates: us.candidates,
                        totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, syncBackFilesChanged: 0 },
                        note: `Ambiguous parentUserStoryTitle "${input.parentUserStoryTitle}" — ${us.candidates?.length ?? 0} candidates. No writes performed. Pass an explicit parentUserStoryId to disambiguate.`,
                    };
                }
                if (us.resolved.length === 0) {
                    notFoundNames.push(...us.notFound);
                } else {
                    resolvedParentUserStoryId = us.resolved[0].id;
                }
            }
        }
        if (resolvedPlanId === undefined) {
            return {
                dryRun: input.dryRun, planId: input.planId, files: [], warnings, notFound: notFoundNames,
                totals: { featuresProcessed: 0, scenariosFound: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: features.length, syncBackFilesChanged: 0 },
                note: `Plan not resolved. Pass planId or a planName that matches an existing plan. Not-found: ${notFoundNames.join(', ') || '(none)'}`,
            };
        }
        // Rewrite input so downstream code uses the resolved ids.
        const runInput: Input = { ...input, planId: resolvedPlanId, parentUserStoryId: resolvedParentUserStoryId };

        const queryCatalog = loadNamedQueriesCatalog(workspaceRoot);

        const filesOut: Array<z.infer<typeof PerFileSchema>> = [];
        let totScen = 0, totC = 0, totU = 0, totUn = 0, totSk = 0, totF = 0, totSyncChanged = 0;
        for (const featureAbs of features) {
            try {
                const perFile = await publishOneFile({
                    featureAbs, input: runInput, cfg: cfg!, defaults, workspaceRoot, warnings, queryCatalog, isDryRun: runInput.dryRun,
                });
                filesOut.push(perFile);
                totScen += perFile.scenariosFound;
                totC += perFile.created.length;
                totU += perFile.updated.length;
                totUn += perFile.unchanged.length;
                totSk += perFile.skipped.length;
                totF += perFile.failed.length;
                if (perFile.syncBack?.fileChanged) totSyncChanged++;
            } catch (e) {
                filesOut.push({
                    featurePath: path.relative(workspaceRoot, featureAbs), featureTitle: '',
                    scenariosFound: 0, scenariosPublished: 0, suiteCreated: false,
                    created: [], updated: [], unchanged: [], skipped: [],
                    failed: [{ title: '(file)', reason: (e as Error).message }], addedToSuite: 0,
                    warnings: [],
                });
                totF += 1;
            }
        }

        const note = runInput.dryRun
            ? `DRY RUN — parsed ${features.length} feature file(s), ${totScen} scenario(s). Nothing written to ADO.`
            : `Processed ${features.length} feature file(s), ${totScen} scenario(s) found. Created ${totC}, updated ${totU}, unchanged ${totUn}, failed ${totF}.${runInput.syncBackTags ? ` Sync-back updated ${totSyncChanged} feature file(s).` : ''}`;

        return {
            dryRun: runInput.dryRun,
            planId: runInput.planId,
            parentUserStoryId: runInput.parentUserStoryId,
            scenarioTagFilter: runInput.scenarioTagFilter,
            files: filesOut,
            notFound: notFoundNames,
            totals: { featuresProcessed: features.length, scenariosFound: totScen, created: totC, updated: totU, unchanged: totUn, skipped: totSk, failed: totF, syncBackFilesChanged: totSyncChanged },
            warnings,
            note,
        };
    },
});
