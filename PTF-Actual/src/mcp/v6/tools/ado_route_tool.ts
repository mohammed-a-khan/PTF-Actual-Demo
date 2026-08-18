/**
 * cs_qa_route — intent router for the CS Playwright Test Framework MCP surface.
 *
 * Users type natural-language asks ("generate a test for story 4712", "review
 * my PR", "why is my suite flaky?") and this tool decides which skill (or
 * skill chain) best serves the ask. It never invokes anything — it *recommends*
 * so the calling skill / slash-command can perform the invocation with full
 * user visibility.
 *
 * Scoring pipeline:
 *   1. Exact keyword match          weight 3.0 per matched intent phrase
 *   2. Regex match                  weight 2.5 (capture groups become args)
 *   3. Token-overlap (Jaccard)      weight 1.0-2.0 on unique tokens
 *   4. Context boost                per contextRules {if, boost}
 *   5. Learned successBoost         persisted in .cs-qa/route-learning.json
 *
 * Verbs (via z.union — default omits verb):
 *   default: {intent, ...}                 → route decision
 *   {verb:'list', category?}               → all routes grouped by category
 *   {verb:'learn', routeId, succeeded}     → bump successBoost
 *   {verb:'explain', routeId}              → full route entry
 *   {verb:'add-route', route}              → append to user's .cs-qa/routes.json
 *
 * Persistence:
 *   .cs-qa/routes.json           — user's custom routes (overrides embedded)
 *   .cs-qa/route-learning.json   — {routeId: successBoost} adjustments
 *   .cs-qa/route-history.jsonl   — append-only decision log
 *
 * On-prem safe. Zero network calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { LruCache } from './_helpers/ado_lru_cache';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RouteEntry {
    id: string;
    category: RouteCategory;
    intents: string[];
    regexes?: string[];
    chain?: string[];
    skill?: string;
    argsFromContext?: Record<string, string>;
    contextRules?: Array<{ if: string; boost: number }>;
    successBoost?: number;
    description: string;
}

type RouteCategory =
    | 'understand'
    | 'generate'
    | 'run'
    | 'audit'
    | 'heal'
    | 'govern'
    | 'analyze'
    | 'migrate'
    | 'bootstrap';

interface WorkspaceContext {
    gitBranch?: string;
    openPrId?: number;
    recentStoryId?: number;
    hasSourceModel?: boolean;
    hasDocsModel?: boolean;
}

interface ScoreBreakdown {
    routeId: string;
    keyword: number;
    regex: number;
    tokenOverlap: number;
    context: number;
    learned: number;
    total: number;
    matchedIntents: string[];
    matchedRegex: string | null;
    regexCaptures: string[];
    contextFlagsApplied: string[];
}

// ---------------------------------------------------------------------------
// Stopwords for token overlap
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'shall', 'to', 'of', 'in',
    'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
    'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'now', 'i', 'you', 'we', 'they',
    'them', 'us', 'me', 'my', 'your', 'our', 'their', 'this', 'that',
    'these', 'those', 'and', 'or', 'but', 'if', 'as', 'please',
]);

function tokenize(s: string): string[] {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function uniqTokens(s: string): Set<string> {
    return new Set(tokenize(s));
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Embedded default manifest — covers every skill under
// /mnt/e/mcp-test-repo/.github/prompts/*.prompt.md at time of writing.
// Any skill introduced later can still be routed via the user's own
// .cs-qa/routes.json (add-route verb) — no re-compile needed.
// ---------------------------------------------------------------------------

const EMBEDDED_ROUTES: RouteEntry[] = [
    // -------- generate --------
    {
        id: 'generate-test-from-story',
        category: 'generate',
        intents: ['generate test from story', 'create test from story', 'write test for story', 'story to test', 'make test from story', 'author scenario from story', 'automate story'],
        regexes: ['story\\s+#?(\\d+)', 'us[- ]?(\\d+)', '\\bwork\\s*item\\s+#?(\\d+)'],
        chain: ['/generate-verified'],
        argsFromContext: { storyId: 'regexCapture1|recentStoryId' },
        contextRules: [
            { if: 'hasSourceModel', boost: 1.5 },
            { if: 'hasDocsModel', boost: 0.5 },
        ],
        description: 'End-to-end grounded test generation from an ADO story.',
    },
    {
        id: 'generate-manual-tcs-from-story',
        category: 'generate',
        intents: [
            'generate test cases from story',
            'create test cases from story',
            'generate manual tests',
            'draft test cases',
            'read story and create tests',
            'analyze story and upload tests',
            'manual test cases from story',
            'generate manual test cases',
            'create manual tests from story',
        ],
        regexes: ['story\\s+#?(\\d+)', 'us[- ]?(\\d+)', '\\bwork\\s*item\\s+#?(\\d+)'],
        chain: ['/generate-manual-tcs-from-story'],
        argsFromContext: { storyId: 'regexCapture1|recentStoryId' },
        description: 'Read an ADO Story, propose manual test cases per acceptance criterion, then bulk-create them + add to a Test Plan/Suite. Two-round LLM-drafted flow with an explicit confirm gate before any ADO writes.',
    },
    {
        id: 'generate-from-requirements-doc',
        category: 'generate',
        intents: ['generate from requirements', 'brd to test', 'fsd to test', 'requirements doc to test', 'doc to test suite', 'parse requirement document'],
        regexes: ['(?:brd|fsd|requirements?)[\\s:]+(\\S+\\.(?:pdf|docx?|xlsx?|csv|txt|md))'],
        skill: '/generate-from-requirements',
        argsFromContext: { docPath: 'regexCapture1' },
        description: 'Parse BRD/FSD/PDF/Word/Excel/CSV/TXT and generate a test suite from it.',
    },
    {
        id: 'generate-from-test-plan',
        category: 'generate',
        intents: ['generate from test plan', 'ado test plan to tests', 'automate test plan', 'test plan to feature files'],
        regexes: ['test\\s*plan\\s+#?(\\d+)', 'plan\\s+id\\s+#?(\\d+)'],
        skill: '/generate-from-test-plan',
        argsFromContext: { testPlanId: 'regexCapture1' },
        description: 'Materialise ADO Test Plan test cases into Cucumber feature files + step-defs.',
    },
    {
        id: 'generate-soap',
        category: 'generate',
        intents: ['soap test', 'generate soap', 'wsdl to test', 'soap api test'],
        regexes: ['(\\S+\\.wsdl)'],
        skill: '/gen-soap-test',
        argsFromContext: { wsdlPath: 'regexCapture1' },
        description: 'Generate SOAP API test suite from a WSDL.',
    },
    {
        id: 'generate-graphql',
        category: 'generate',
        intents: ['graphql test', 'generate graphql', 'gql test', 'graphql schema to test'],
        regexes: ['(\\S+\\.(?:graphql|graphqls|gql))'],
        skill: '/gen-graphql-test',
        argsFromContext: { schemaPath: 'regexCapture1' },
        description: 'Generate GraphQL query/mutation tests from a schema file.',
    },
    {
        id: 'generate-perf',
        category: 'generate',
        intents: ['performance test', 'perf test', 'load test', 'generate perf', 'k6 test', 'stress test'],
        skill: '/gen-perf-test',
        description: 'Generate a K6 / performance test skeleton for a target endpoint.',
    },
    {
        id: 'generate-visual-regression',
        category: 'generate',
        intents: ['visual regression', 'screenshot test', 'visual comparison test'],
        skill: '/gen-visual-regression',
        description: 'Generate visual regression tests with baseline capture. Supports verbs (list-baselines / approve-baseline / delete-baseline / diff-report).',
    },
    {
        id: 'visual-baseline',
        category: 'audit',
        intents: [
            'list baselines',
            'approve baseline',
            'delete baseline',
            'visual diff',
            'visual baseline',
            'baseline snapshot',
            'refresh baseline',
            'pixelmatch diff',
        ],
        chain: ['/gen-visual-regression'],
        description: 'Manage visual regression baselines via verbs: list-baselines / approve-baseline / delete-baseline / diff-report. Approve and delete are two-phase confirmed.',
    },
    {
        id: 'gen-a11y-test',
        category: 'generate',
        intents: [
            'generate a11y test',
            'accessibility test',
            'wcag test',
            'axe test',
            'accessibility scaffold',
            'axe-core test',
            'a11y test scaffold',
        ],
        regexes: ['(https?://\\S+)'],
        chain: ['/gen-a11y-test'],
        argsFromContext: { targetUrl: 'regexCapture1' },
        description: 'Emit an axe-core accessibility test scaffold for a target URL. One .feature per viewport (desktop/tablet/mobile), one Scenario per WCAG rule family, tagged @a11y @wcag<level>. Optional ADO Test Case creation (two-phase confirm).',
    },
    {
        id: 'gen-security-test',
        category: 'generate',
        intents: [
            'generate security test',
            'owasp test',
            'xss test',
            'sql injection test',
            'security scaffold',
            'security test suite',
            'penetration test scaffold',
        ],
        regexes: ['(https?://\\S+)'],
        chain: ['/gen-security-test'],
        argsFromContext: { targetUrl: 'regexCapture1' },
        description: 'Emit an OWASP-graded security test scaffold for a target URL. Categories: sql-injection, xss, csrf, auth-bypass, sensitive-data-exposure, security-headers, session-fixation, clickjacking, idor, command-injection. Payload profiles: baseline (default) / aggressive / safe-list-only. Two-phase confirm on ADO writes.',
    },
    {
        id: 'check-existing-tests',
        category: 'audit',
        intents: [
            'check existing tests',
            'find tests for story',
            'does a test exist',
            'coverage lookup',
            'existing coverage',
            'is this story tested',
        ],
        regexes: ['story\\s+#?(\\d+)', 'us[- ]?(\\d+)', '\\bwork\\s*item\\s+#?(\\d+)'],
        chain: ['/check-existing-tests'],
        argsFromContext: { storyId: 'regexCapture1|recentStoryId' },
        description: 'Walk the test/ tree AND (when --include-ado is passed) query ADO for TCs linked to the story via TestedBy-Forward. When --include-ado + --cross-reference are both set, orphans on either side (ADO TCs without local scenarios, local scenarios without ADO TCs) are surfaced. Pass includeAdoTestCases:true and crossReference:true through to the underlying tool. Read-only.',
    },
    {
        id: 'import-openapi',
        category: 'generate',
        intents: ['import openapi', 'openapi to tests', 'swagger to tests', 'rest spec to tests'],
        regexes: ['(\\S+\\.(?:yaml|yml|json))'],
        skill: '/import-openapi',
        argsFromContext: { specPath: 'regexCapture1' },
        description: 'Import an OpenAPI / Swagger spec and materialise REST test skeletons.',
    },
    {
        id: 'gen-protocol-test',
        category: 'generate',
        intents: [
            'generate rest test',
            'api test',
            'openapi test',
            'contract test',
            'pact test',
            'websocket test',
            'ws test',
            'protocol test',
            'rest api test',
            'consumer contract',
            'consumer driven contract',
        ],
        regexes: [
            '\\brest\\s+(?:api\\s+)?test\\b',
            '\\bcontract\\s+test\\b',
            '\\bpact\\s+(?:consumer\\s+)?test\\b',
            '\\b(?:web\\s*socket|ws)\\s+test\\b',
            '\\bprotocol\\s+test\\b',
        ],
        skill: '/gen-protocol-test',
        description: 'Verb-driven multi-protocol API test generator: rest / soap / graphql / pact / websocket. One tool, one skill, five verbs.',
    },
    {
        id: 'ui-scaffold',
        category: 'generate',
        intents: ['ui scaffold', 'scaffold ui', 'scaffold page object', 'generate page object', 'page object scaffold'],
        regexes: ['(https?://\\S+)'],
        skill: '/ui-scaffold',
        argsFromContext: { url: 'regexCapture1' },
        description: 'Scaffold page objects + step defs by inspecting a live URL.',
    },
    {
        id: 'inspect-dom',
        category: 'generate',
        intents: ['inspect dom', 'snapshot dom', 'capture dom', 'grab selectors from page', 'dom to locators'],
        regexes: ['(https?://\\S+)'],
        skill: '/inspect-dom',
        argsFromContext: { url: 'regexCapture1' },
        description: 'Snapshot a live DOM and surface candidate stable locators.',
    },
    {
        id: 'automate-manual',
        category: 'generate',
        intents: ['automate manual test', 'automate manual case', 'convert manual test', 'manual to automated'],
        regexes: ['test\\s*case\\s+#?(\\d+)', 'tc[- ]?#?(\\d+)'],
        skill: '/automate-manual',
        argsFromContext: { testCaseId: 'regexCapture1' },
        description: 'Convert a manual ADO test case into an automated Cucumber scenario.',
    },
    {
        id: 'automate-suite',
        category: 'generate',
        intents: ['automate suite', 'automate test suite', 'convert whole suite', 'bulk automate manual'],
        regexes: ['suite\\s+#?(\\d+)'],
        skill: '/automate-suite',
        argsFromContext: { suiteId: 'regexCapture1' },
        description: 'Bulk convert every manual case in an ADO suite to automated scenarios.',
    },

    // -------- run --------
    {
        id: 'run-smoke',
        category: 'run',
        intents: ['smoke test', 'smoke run', 'quick check', 'sanity test', 'run smoke'],
        skill: '/smoke',
        description: 'Run the smoke tag subset against the workspace suite.',
    },
    {
        id: 'run-scope-regression',
        category: 'run',
        intents: ['regression scope', 'blast radius', 'impact analysis', 'what tests should i rerun', 'affected scenarios'],
        contextRules: [{ if: 'onFeatureBranch', boost: 1.5 }],
        skill: '/scope-regression',
        description: 'Compute the minimum re-run set for the change on the current branch.',
    },
    {
        id: 'run-selector-drift-monitor',
        category: 'run',
        intents: ['selector drift monitor', 'watch selectors', 'monitor locators', 'ongoing drift check'],
        skill: '/selector-drift-monitor',
        description: 'Continuously monitor locators for drift and record aging selectors.',
    },
    {
        id: 'run-analyze-perf',
        category: 'run',
        intents: ['analyze perf', 'analyze performance', 'perf report', 'performance results'],
        skill: '/analyze-perf',
        description: 'Analyse perf-test artifacts and summarise slow endpoints / regression vs baseline.',
    },

    // -------- audit --------
    {
        id: 'audit-pr',
        category: 'audit',
        intents: ['review pr', 'audit pr', 'review pull request', 'pr review', 'qa review pr', 'code review pr'],
        regexes: ['pr\\s+#?(\\d+)', 'pull\\s*request\\s+#?(\\d+)'],
        chain: ['/audit-pr'],
        argsFromContext: { prId: 'regexCapture1|openPrId' },
        contextRules: [
            { if: 'hasOpenPr', boost: 1.5 },
            { if: 'onFeatureBranch', boost: 0.5 },
        ],
        description: 'Seven-lens QA review of an ADO PR: AC coverage, quality, framework compliance, traceability.',
    },
    {
        id: 'audit-page-object',
        category: 'audit',
        intents: ['audit page object', 'review page object', 'page object health', 'po quality check'],
        regexes: ['(\\S+Page\\.ts)'],
        skill: '/audit-page-object',
        argsFromContext: { pagePath: 'regexCapture1' },
        description: 'Score a page object against framework conventions (decorators, waits, locator hygiene).',
    },
    {
        id: 'audit-automation-inventory',
        category: 'audit',
        intents: ['automation inventory', 'test inventory', 'catalog automated tests', 'what tests exist'],
        skill: '/automation-inventory',
        description: 'Enumerate every automated scenario + its ADO linkage across the workspace.',
    },
    {
        id: 'audit-coverage-heatmap',
        category: 'audit',
        intents: ['coverage heatmap', 'coverage map', 'test coverage visual', 'ado coverage matrix'],
        skill: '/coverage-heatmap',
        description: 'Emit an ADO-wide coverage heatmap (stories × suites × automation state).',
    },
    {
        id: 'audit-a11y-scan-dedup',
        category: 'audit',
        intents: ['accessibility scan', 'a11y scan', 'axe scan', 'a11y dedupe', 'accessibility dedup'],
        skill: '/a11y-scan-dedup',
        description: 'Run axe-core across the app and dedupe findings by fingerprint.',
    },
    {
        id: 'audit-flaky-cluster',
        category: 'audit',
        intents: ['flaky cluster', 'flaky tests', 'signature cluster', 'find flakes', 'why is my test flaky'],
        skill: '/flaky-signature-cluster',
        description: 'Cluster failing tests by signature and highlight likely flakes.',
    },
    {
        id: 'audit-dora-metrics',
        category: 'audit',
        intents: ['dora metrics', 'deployment frequency', 'lead time', 'change failure rate', 'mttr'],
        skill: '/dora-metrics',
        description: 'Compute DORA metrics from PR history + ADO release cadence.',
    },
    {
        id: 'audit-release-gate',
        category: 'audit',
        intents: ['release ready', 'release gate', 'ready to release', 'release check', 'go no-go'],
        chain: ['/release-gate'],
        contextRules: [{ if: 'hasOpenPr', boost: 0.5 }],
        description: 'Composite release-gate check across coverage, drift, flakes, governance.',
    },
    {
        id: 'audit-ctrf-export',
        category: 'audit',
        intents: ['ctrf export', 'export ctrf', 'common test report format', 'ci friendly test report'],
        skill: '/ctrf-export',
        description: 'Export the latest run artifacts as CTRF for CI dashboards.',
    },
    {
        id: 'audit-dashboard-push',
        category: 'audit',
        intents: ['dashboard push', 'push dashboard', 'update dashboard', 'refresh dashboard tiles'],
        skill: '/dashboard-push',
        description: 'Push the newest run summary into the QA dashboard.',
    },
    {
        id: 'audit-explore',
        category: 'audit',
        intents: ['explore the app', 'walk the app', 'exploratory session', 'exploratory testing'],
        regexes: ['(https?://\\S+)'],
        skill: '/explore',
        argsFromContext: { url: 'regexCapture1' },
        description: 'Guided exploratory testing session against a target URL.',
    },

    // -------- heal --------
    {
        id: 'heal-drift',
        category: 'heal',
        intents: ['heal drift', 'auto heal', 'fix drift', 'repair drift', 'reconcile drift', 'sync test with app'],
        chain: ['/detect-drift', '/auto-heal-drift'],
        description: 'Detect locator/AC drift then propose auto-heals.',
    },
    {
        id: 'heal-detect-only',
        category: 'heal',
        intents: ['detect drift', 'find drift', 'check for drift', 'locator drift check'],
        skill: '/detect-drift',
        description: 'Detect drift without applying any fixes.',
    },
    {
        id: 'heal-failing-tests',
        category: 'heal',
        intents: ['heal failures', 'fix failing tests', 'repair failing test', 'why did test fail', 'debug failing run'],
        skill: '/heal-failures',
        description: 'Observe→diagnose→fix loop against the latest failing scenarios.',
    },
    {
        id: 'heal-auto',
        category: 'heal',
        intents: ['auto heal', 'auto repair test', 'self heal test', 'automatic heal loop'],
        skill: '/auto-heal',
        description: 'Run the auto-heal loop (observe → propose → apply → verify).',
    },
    {
        id: 'heal-bridge',
        category: 'heal',
        intents: ['healer bridge', 'bridge healer', 'link healer', 'connect to external healer'],
        skill: '/healer-bridge',
        description: 'Bridge outputs to an external healer service.',
    },
    {
        id: 'heal-sync-locators',
        category: 'heal',
        intents: ['sync locators', 'update locators', 'refresh selectors', 'reconcile locators'],
        skill: '/sync-locators',
        description: 'Sync page-object locators with the live DOM.',
    },

    // -------- govern --------
    {
        id: 'gov-secret-scan',
        category: 'govern',
        intents: ['secret scan', 'scan for secrets', 'leaked secret', 'find credentials in repo', 'credential scan'],
        skill: '/gov-secret-scanner',
        description: 'Scan tracked files for embedded secrets / PATs / private keys.',
    },
    {
        id: 'gov-compliance-check',
        category: 'govern',
        intents: ['compliance check', 'governance compliance', 'audit compliance'],
        skill: '/gov-compliance-check',
        description: 'Run the composite compliance checklist against workspace + ADO.',
    },
    {
        id: 'gov-audit-trail',
        category: 'govern',
        intents: ['audit trail', 'ado audit trail', 'show audit log', 'audit history'],
        skill: '/gov-audit-trail',
        description: 'Render the append-only ADO audit trail for the workspace.',
    },
    {
        id: 'gov-attachment-audit',
        category: 'govern',
        intents: ['attachment audit', 'audit attachments', 'attachment inventory'],
        skill: '/gov-attachment-audit',
        description: 'Audit ADO work-item attachments for size / dupes / stale artifacts.',
    },
    {
        id: 'gov-scaffold-audit',
        category: 'govern',
        intents: ['scaffold audit', 'audit scaffolding', 'framework scaffold check'],
        skill: '/gov-scaffold-audit',
        description: 'Confirm every generated file was produced via the scaffolder (no hand-writing).',
    },
    {
        id: 'gov-code-mutation-audit',
        category: 'govern',
        intents: ['code mutation audit', 'mutation audit', 'audit generated code changes'],
        skill: '/gov-code-mutation-audit',
        description: 'Detect hand-patches to files marked generated.',
    },
    {
        id: 'gov-policy-guard',
        category: 'govern',
        intents: ['policy guard', 'ado policy guard', 'branch policy check'],
        skill: '/gov-ado-policy-guard',
        description: 'Verify ADO branch policies still match the framework baseline.',
    },
    {
        id: 'gov-pat-rotation-reminder',
        category: 'govern',
        intents: ['pat rotation', 'rotate pat', 'pat expiry check', 'pat rotation reminder'],
        skill: '/gov-pat-rotation-reminder',
        description: 'Warn on PATs approaching expiry.',
    },
    {
        id: 'gov-upgrade-governance',
        category: 'govern',
        intents: ['upgrade governance', 'governance upgrade', 'framework upgrade check'],
        skill: '/gov-upgrade-governance',
        description: 'Check framework version + governance rules for upgrade eligibility.',
    },
    {
        id: 'gov-env-health',
        category: 'govern',
        intents: ['env health', 'environment health', 'is prod up', 'check env', 'sit uat prod health'],
        skill: '/env-health',
        description: 'HTTP ping health checks across SIT / UAT / prod environments.',
    },

    // -------- understand --------
    {
        id: 'understand-app',
        category: 'understand',
        intents: ['understand app', 'ingest source', 'source ingest', 'index source code', 'learn the app', 'scan app source'],
        chain: ['/source-ingest', '/source-coverage'],
        description: 'Ingest app source into a model, then map current tests against it.',
    },
    {
        id: 'understand-source-ingest-only',
        category: 'understand',
        intents: ['source ingest only', 'just ingest source', 'source model'],
        skill: '/source-ingest',
        description: 'Ingest app source into the workspace model without coverage cross-ref.',
    },
    {
        id: 'understand-source-coverage',
        category: 'understand',
        intents: ['source coverage', 'source vs tests', 'coverage against source', 'app coverage'],
        skill: '/source-coverage',
        description: 'Cross-reference existing tests against the ingested source model.',
    },
    {
        id: 'understand-kg-build',
        category: 'understand',
        intents: ['knowledge graph build', 'kg build', 'build knowledge graph', 'construct kg'],
        skill: '/kg-build',
        description: 'Build the knowledge graph from ADO + source + tests.',
    },
    {
        id: 'understand-kg-query',
        category: 'understand',
        intents: ['knowledge graph query', 'kg query', 'query kg', 'ask knowledge graph'],
        skill: '/kg-query',
        description: 'Query the knowledge graph for cross-artifact answers.',
    },
    {
        id: 'understand-ground-story',
        category: 'understand',
        intents: ['ground story', 'grounded hints', 'story to real facts'],
        regexes: ['story\\s+#?(\\d+)', 'us[- ]?(\\d+)'],
        skill: '/ground-story',
        argsFromContext: { storyId: 'regexCapture1|recentStoryId' },
        description: 'Emit grounded hints (real DOM ids, real assertions) for a story.',
    },
    {
        id: 'understand-sprint',
        category: 'understand',
        intents: ['sprint context', 'current sprint', 'what is in sprint', 'sprint work items'],
        skill: '/ado-sprint',
        description: 'Load current-sprint context: iteration, capacity, in-flight work items.',
    },
    {
        id: 'understand-sprint-watch',
        category: 'understand',
        intents: ['sprint watch', 'watch sprint', 'monitor sprint', 'sprint changes'],
        skill: '/sprint-watch',
        description: 'Watch for changes to the active sprint and refresh local checkpoints.',
    },
    {
        id: 'understand-hello',
        category: 'understand',
        intents: ['hello', 'sanity check', 'is mcp alive', 'health check mcp', 'ping mcp'],
        skill: '/hello',
        description: 'Sanity-check the MCP interceptor is live.',
    },

    // -------- migrate --------
    {
        id: 'migrate-legacy',
        category: 'migrate',
        intents: ['migrate legacy', 'legacy migration', 'migrate old suite', 'port legacy tests', 'migrate to framework'],
        chain: ['/migrate-legacy'],
        description: 'Migrate a legacy Playwright / Selenium suite to the CS framework, preserving IDs.',
    },

    // -------- bootstrap --------
    {
        id: 'bootstrap-qa-agent',
        category: 'bootstrap',
        intents: ['qa agent', 'start qa agent', 'launch qa agent', 'begin qa session'],
        skill: '/qa-agent',
        description: 'Launch the QA agent for a browse-and-build story session.',
    },
    {
        id: 'bootstrap-config-resolve',
        category: 'bootstrap',
        intents: ['config resolve', 'ado config', 'show config', 'resolve ado config', 'where is my pat'],
        skill: '/ado-config-resolve',
        description: 'Show the ADO config cascade result and every layer that was considered.',
    },
    {
        id: 'bootstrap-service-hook-subscribe',
        category: 'bootstrap',
        intents: ['service hook subscribe', 'subscribe service hook', 'webhook subscribe', 'ado webhook'],
        skill: '/service-hook-subscribe',
        description: 'Subscribe an ADO service hook to feed live signals back into the workspace.',
    },
    {
        id: 'bootstrap-publish-feature',
        category: 'bootstrap',
        intents: ['publish feature', 'push feature to ado', 'publish scenarios', 'sync feature to test cases'],
        regexes: ['(\\S+\\.feature)'],
        skill: '/publish-feature',
        argsFromContext: { featurePath: 'regexCapture1' },
        description: 'Publish a feature file to ADO Test Cases (creates/patches TCs, keeps IDs stable).',
    },
    {
        id: 'bootstrap-publish-run',
        category: 'bootstrap',
        intents: ['publish run', 'push run results', 'publish results to ado', 'upload run to ado'],
        skill: '/publish-run',
        description: 'Publish latest run results back to ADO test runs.',
    },
    {
        id: 'bootstrap-push-pr',
        category: 'bootstrap',
        intents: ['push pr', 'create pull request', 'open pr', 'raise pr'],
        skill: '/push-pr',
        description: 'Push the current branch and open a pull request with the QA checklist.',
    },
    {
        id: 'bootstrap-build-delta',
        category: 'bootstrap',
        intents: ['build delta', 'ado build delta', 'build change delta', 'what changed in build'],
        skill: '/ado-build-delta',
        description: 'Compare two ADO builds and produce a change delta.',
    },
    {
        id: 'bootstrap-ado-trace',
        category: 'bootstrap',
        intents: ['ado trace', 'trace work item', 'traceability graph', 'ado traceability'],
        regexes: ['(?:work\\s*item|wi)\\s+#?(\\d+)'],
        skill: '/ado-trace',
        argsFromContext: { workItemId: 'regexCapture1' },
        description: 'Render the traceability chain (Epic → Feature → Story → TC → Automation) for a work item.',
    },
    {
        id: 'bootstrap-ado-attachment',
        category: 'bootstrap',
        intents: ['ado attachment', 'attach to work item', 'upload attachment', 'ado attach file'],
        skill: '/ado-attachment',
        description: 'Attach files to an ADO work item.',
    },
    {
        id: 'bootstrap-ado-test-points',
        category: 'bootstrap',
        intents: ['test points', 'ado test points', 'update test outcomes', 'test point bulk update'],
        skill: '/ado-test-points',
        description: 'Bulk-update ADO test-point outcomes from local run artifacts.',
    },
    {
        id: 'bootstrap-testcases-move',
        category: 'bootstrap',
        intents: ['move test cases', 'move testcases', 'ado move test', 'reorganise test cases'],
        skill: '/ado-move-testcases',
        description: 'Move ADO test cases between suites.',
    },
    {
        id: 'bootstrap-testcases-delete',
        category: 'bootstrap',
        intents: ['delete test cases', 'delete testcases', 'remove test cases', 'ado delete tc'],
        skill: '/ado-delete-testcases',
        description: 'Delete ADO test cases (with dry-run first).',
    },
    {
        id: 'bootstrap-suite-delete',
        category: 'bootstrap',
        intents: ['delete suite', 'remove suite', 'ado delete suite'],
        skill: '/ado-delete-suite',
        description: 'Delete an ADO test suite.',
    },
    {
        id: 'bootstrap-plan-delete',
        category: 'bootstrap',
        intents: ['delete plan', 'remove plan', 'ado delete plan'],
        skill: '/ado-delete-plan',
        description: 'Delete an ADO test plan.',
    },
    {
        id: 'bootstrap-remove-from-suite',
        category: 'bootstrap',
        intents: ['remove from suite', 'unlink from suite', 'detach test case from suite'],
        skill: '/ado-remove-from-suite',
        description: 'Remove ADO test cases from a suite without deleting them.',
    },
    {
        id: 'bootstrap-pr-approve',
        category: 'bootstrap',
        intents: ['approve pr', 'approve pull request', 'sign off pr'],
        regexes: ['pr\\s+#?(\\d+)'],
        skill: '/ado-pr-approve',
        argsFromContext: { prId: 'regexCapture1|openPrId' },
        description: 'Approve an ADO PR.',
    },
    {
        id: 'bootstrap-pr-complete',
        category: 'bootstrap',
        intents: ['complete pr', 'merge pr', 'finish pr'],
        regexes: ['pr\\s+#?(\\d+)'],
        skill: '/ado-pr-complete',
        argsFromContext: { prId: 'regexCapture1|openPrId' },
        description: 'Complete (merge) an ADO PR.',
    },
    {
        id: 'bootstrap-pr-auto-complete',
        category: 'bootstrap',
        intents: ['auto complete pr', 'set pr auto complete', 'auto merge pr'],
        regexes: ['pr\\s+#?(\\d+)'],
        skill: '/ado-pr-auto-complete',
        argsFromContext: { prId: 'regexCapture1|openPrId' },
        description: 'Enable auto-complete on an ADO PR when all policies pass.',
    },

    // -------- analyze --------
    {
        id: 'analyze-log-failures-as-bugs',
        category: 'analyze',
        intents: [
            'log bugs for failures',
            'log bugs for failed scenarios',
            'log bugs from report',
            'log bugs from last run',
            'log bugs from last execution',
            'raise bugs for failures',
            'raise bugs for failed scenarios',
            'report failures to ado',
            'report failures',
            'file bugs for failures',
            'file bugs from report',
            'file bugs for the last test run',
            'create bugs for all failures',
            'create defects for failures',
            'log defects for failures',
            'log all failures',
            'raise defect for failures',
        ],
        regexes: ['log\\s+(?:a\\s+)?bugs?\\s+(?:for|from)', 'raise\\s+(?:a\\s+)?bugs?\\s+(?:for|from)', 'file\\s+bugs?\\s+(?:for|from)', 'defect\\s+(?:for|from)\\s+(?:failed|failures)'],
        chain: ['/log-failures-as-bugs'],
        contextRules: [{ if: 'hasSourceModel', boost: 0.5 }],
        description: 'Read the latest test report, group failures by signature, and create ONE Bug/Defect per group (or one consolidated if user prefers). Bug for lower env, Defect for prod. Screenshots always. Full artifact zip only on explicit ask.',
    },
    {
        id: 'analyze-file-bug',
        category: 'analyze',
        intents: ['file single bug', 'log single bug', 'raise one bug', 'create one bug', 'open bug manually'],
        skill: '/file-bug',
        description: 'File a SINGLE ADO bug manually with a title + repro payload you provide. Use /log-bugs-from-failures instead when you want the tool to read the last test report and file bugs per failure group.',
    },
    {
        id: 'analyze-close-bug',
        category: 'analyze',
        intents: ['close bug', 'resolve bug', 'close defect'],
        regexes: ['bug\\s+#?(\\d+)'],
        skill: '/close-bug',
        argsFromContext: { bugId: 'regexCapture1' },
        description: 'Close an ADO bug with the correct resolution + evidence.',
    },
    {
        id: 'analyze-triage-bug',
        category: 'analyze',
        intents: ['triage bug', 'bug triage', 'classify bug', 'route bug'],
        regexes: ['bug\\s+#?(\\d+)'],
        skill: '/triage-bug',
        argsFromContext: { bugId: 'regexCapture1' },
        description: 'Triage an ADO bug against known signatures.',
    },
    {
        id: 'analyze-query-defects',
        category: 'analyze',
        intents: ['query defects', 'list defects', 'search bugs', 'find bugs'],
        skill: '/query-defects',
        description: 'Query defects with WIQL and render a short summary.',
    },
    {
        id: 'analyze-security-bug',
        category: 'analyze',
        intents: ['security bug', 'create security bug', 'log security defect'],
        skill: '/create-security-bug',
        description: 'File an ADO security bug with the correct classification + tags.',
    },
    // -------- sprint ops (single-tool, verb-dispatched) --------
    {
        id: 'sprint-ops-my-queue',
        category: 'analyze',
        intents: [
            "what's on my qa plate",
            'my qa queue',
            'sprint queue',
            'my stories',
            'my sprint stories',
            'show my qa work',
            'qa backlog for me',
            'what am i working on this sprint',
        ],
        chain: ['/sprint-ops'],
        description: 'List QA-scoped work items assigned to you (or another user) in the current iteration.',
    },
    {
        id: 'sprint-ops-claim-story',
        category: 'generate',
        intents: [
            'claim story',
            'pick up story',
            'start working on story',
            'assign story to me',
            'take ownership of story',
            'grab story for qa',
        ],
        regexes: ['story\\s+#?(\\d+)', 'us[- ]?(\\d+)', '\\bwork\\s*item\\s+#?(\\d+)'],
        chain: ['/sprint-ops'],
        argsFromContext: { storyId: 'regexCapture1|recentStoryId' },
        description: 'Assign a story to a QA owner, move it into Active, and post a claim comment.',
    },
    {
        id: 'sprint-ops-post-checkpoint',
        category: 'analyze',
        intents: [
            'post qa checkpoint',
            'sprint checkpoint',
            'update status',
            'update qa status',
            'log qa progress',
            'checkpoint story',
            'note progress on story',
        ],
        regexes: ['story\\s+#?(\\d+)', 'work\\s*item\\s+#?(\\d+)'],
        chain: ['/sprint-ops'],
        argsFromContext: { workItemId: 'regexCapture1|recentStoryId' },
        description: 'Append a structured phase-tagged QA status comment to a work item.',
    },
    {
        id: 'sprint-ops-summary',
        category: 'analyze',
        intents: [
            'sprint summary',
            'qa summary',
            'sprint rollup',
            'sprint qa rollup',
            'sprint metrics',
            'iteration summary',
            'how is the sprint going',
        ],
        chain: ['/sprint-ops'],
        description: 'Rollup story states, test-case counts, run pass/fail, cycle time, and blockers for the current iteration.',
    },
    {
        id: 'sprint-ops-link-work-items',
        category: 'generate',
        intents: [
            'link tests to story',
            'link test case to bug',
            'link work items',
            'connect work items',
            'add related link',
            'create typed link between work items',
            'link tc to story',
        ],
        regexes: ['story\\s+#?(\\d+)', '\\bwork\\s*item\\s+#?(\\d+)'],
        chain: ['/sprint-ops'],
        argsFromContext: { sourceId: 'regexCapture1|recentStoryId' },
        description: 'Bulk-create a typed link (tested-by, tests, parent-child, related, duplicate-of, predecessor, successor, affects, affected-by) from one source WI to many targets.',
    },
    {
        id: 'sprint-ops-find-tests-for-story',
        category: 'analyze',
        intents: [
            'find tests for story',
            'what tests cover story',
            'test coverage for story',
            'list tests linked to story',
            'show test cases for story',
            'which specs cover story',
        ],
        regexes: ['story\\s+#?(\\d+)', 'us[- ]?(\\d+)', '\\bwork\\s*item\\s+#?(\\d+)'],
        chain: ['/sprint-ops'],
        argsFromContext: { storyId: 'regexCapture1|recentStoryId' },
        description: 'Reverse lookup: enumerate ADO Test Cases (via TestedBy-Forward) AND local feature/spec files carrying the @LinkedStory:<id> or @story-<id> markers.',
    },

    // -------- wave 1 extension routes --------
    {
        id: 'project-profile',
        category: 'understand',
        intents: ['project profile', 'scan project', 'discover project', 'onboard project'],
        chain: ['/source-ingest'],
        description: 'Fast onboarding profile pass — detects framework, tech stack, folder layout, env files, package.json deps, test infra. Emits .cs-qa/source-model/project-profile.json. Passes output=project-profile through to the ingest tool.',
    },
    {
        id: 'endpoints-only',
        category: 'understand',
        intents: ['endpoints only', 'list endpoints', 'extract endpoints', 'api routes'],
        chain: ['/source-ingest'],
        description: 'Endpoints-only extraction pass — writes .cs-qa/source-model/endpoints.json. Passes output=endpoints-only.',
    },
    {
        id: 'db-schema-only',
        category: 'understand',
        intents: ['db schema only', 'extract db schema', 'entities only', 'jpa entities'],
        chain: ['/source-ingest'],
        description: 'DB-schema-only extraction pass — writes .cs-qa/source-model/db-schema.json. Passes output=db-schema-only.',
    },
    {
        id: 'coverage-by-endpoint',
        category: 'understand',
        intents: ['coverage by endpoint', 'endpoint coverage rollup', 'per-endpoint coverage'],
        chain: ['/source-coverage'],
        description: 'Per-endpoint coverage rollup (which features/step-defs touch each endpoint). Passes by=endpoint.',
    },
    {
        id: 'coverage-by-tc',
        category: 'understand',
        intents: ['coverage by tc', 'coverage by test case', 'per-tc coverage', 'test case coverage rollup'],
        chain: ['/source-coverage'],
        description: 'Per-ADO-TestCase coverage rollup. Passes by=tc.',
    },
    {
        id: 'coverage-by-ac',
        category: 'understand',
        intents: ['coverage by ac', 'per-ac coverage', 'ac coverage rollup', 'acceptance criterion coverage'],
        chain: ['/source-coverage'],
        description: 'Per-acceptance-criterion coverage rollup — needs AC checkpoints + @ac<n> tags. Passes by=ac.',
    },
    {
        id: 'coverage-by-story',
        category: 'understand',
        intents: ['coverage by story', 'per-story coverage', 'story coverage rollup', 'story to tcs to scenarios'],
        chain: ['/source-coverage'],
        description: 'Per-story rollup: story → TCs → scenarios. Passes by=story.',
    },
    {
        id: 'supply-chain',
        category: 'govern',
        intents: ['supply chain', 'scan dependencies', 'npm audit', 'check outdated', 'sast scan', 'dep audit', 'licence check'],
        chain: ['/gov-supply-chain'],
        description: 'Supply-chain governance scan — runs npm audit + npm outdated + optional license-checker (scanKind:deps) OR extends the secret rule pack with SAST-lite rules (scanKind:sast).',
    },
    {
        id: 'dashboard-aggregate',
        category: 'audit',
        intents: ['quality dashboard', 'quality rollup', 'quality snapshot', 'aggregate quality signals'],
        chain: ['/dashboard-push'],
        description: 'Aggregate coverage rollup + pass-rate trend + open-bug count into a single quality snapshot markdown at .cs-qa/dashboard/aggregate.md. Passes mode=aggregate.',
    },
    {
        id: 'release-report',
        category: 'audit',
        intents: ['release report', 'generate release report', 'sign off report', 'release evidence pack'],
        chain: ['/release-gate'],
        description: 'Generate an HTML+MD release report from release-gate signals. Written to .cs-qa/release-reports/. Passes verb=report.',
    },
    {
        id: 'release-sign-off',
        category: 'audit',
        intents: ['release sign off', 'sign off story', 'qa sign off', 'mark qa signed off'],
        chain: ['/release-gate'],
        description: 'Mark a Story as QA-signed-off in ADO (tag qa-signed-off, set ClosedReason, append history). Two-phase confirm. Passes verb=sign-off.',
    },
    {
        id: 'ado-repo-fs',
        category: 'bootstrap',
        intents: ['browse ado repo', 'read ado file', 'list ado repo', 'ado repo tree'],
        chain: ['/ado-repo-fs'],
        description: 'Browse an ADO Git repo (folder listing) or read a file without cloning. Uses the ADO Git items REST API.',
    },
    {
        id: 'ado-create-branch',
        category: 'bootstrap',
        intents: ['create ado branch', 'branch on ado', 'create feature branch', 'new branch on ado repo'],
        chain: ['/ado-create-branch'],
        description: 'Create a new branch on an ADO Git repo from an existing ref (default refs/heads/main). Two-phase confirm.',
    },
    {
        id: 'gen-test-data',
        category: 'generate',
        intents: ['generate test data', 'fake data', 'fixtures', 'seed data', 'faker fixtures', 'bulk test data'],
        chain: ['/gen-test-data'],
        description: 'Bulk deterministic fixture generator — emits JSON/CSV/YAML fixtures from an entities spec. Lazy-uses @faker-js/faker when installed; deterministic fallbacks otherwise.',
    },
];

// ---------------------------------------------------------------------------
// Workspace context detection
// ---------------------------------------------------------------------------

const CONTEXT_CACHE = new LruCache<string, WorkspaceContext>({ maxSize: 8, ttlMs: 30_000 });

function readWorkspaceContext(workspaceRoot: string): WorkspaceContext {
    const cached = CONTEXT_CACHE.get(workspaceRoot);
    if (cached) return cached;
    const ctx: WorkspaceContext = {};
    // git branch
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: workspaceRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
        }).trim();
        if (branch && branch !== 'HEAD') ctx.gitBranch = branch;
    } catch { /* not a repo */ }

    // open PR state
    const prStatePath = path.join(workspaceRoot, '.cs-qa', 'pr-state.json');
    if (fs.existsSync(prStatePath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(prStatePath, 'utf-8')) as Record<string, unknown>;
            const prId = Number(raw.openPrId ?? raw.prId ?? raw.id);
            if (Number.isFinite(prId) && prId > 0) ctx.openPrId = prId;
        } catch { /* malformed → skip */ }
    }

    // recent story from run-state directory (highest-mtime story-<id>-*.json)
    const runStateDir = path.join(workspaceRoot, '.cs-qa', 'run-state');
    if (fs.existsSync(runStateDir)) {
        try {
            const entries = fs.readdirSync(runStateDir)
                .filter((f) => /^story-\d+/.test(f))
                .map((f) => {
                    const abs = path.join(runStateDir, f);
                    let mtime = 0;
                    try { mtime = fs.statSync(abs).mtimeMs; } catch { /* ignore */ }
                    const idMatch = f.match(/^story-(\d+)/);
                    return { file: f, mtime, storyId: idMatch ? Number(idMatch[1]) : NaN };
                })
                .filter((e) => Number.isFinite(e.storyId))
                .sort((a, b) => b.mtime - a.mtime);
            if (entries.length > 0) ctx.recentStoryId = entries[0].storyId;
        } catch { /* skip */ }
    }

    ctx.hasSourceModel = fs.existsSync(path.join(workspaceRoot, '.cs-qa', 'source-model', 'model.json'));
    ctx.hasDocsModel = fs.existsSync(path.join(workspaceRoot, '.cs-qa', 'docs-model', 'model.json'));

    CONTEXT_CACHE.set(workspaceRoot, ctx);
    return ctx;
}

function evaluateContextFlag(flag: string, wc: WorkspaceContext): boolean {
    switch (flag) {
        case 'hasSourceModel': return wc.hasSourceModel === true;
        case 'hasDocsModel': return wc.hasDocsModel === true;
        case 'hasOpenPr': return typeof wc.openPrId === 'number' && wc.openPrId > 0;
        case 'onFeatureBranch': {
            if (!wc.gitBranch) return false;
            const b = wc.gitBranch.toLowerCase();
            return b.startsWith('feature/') || b.startsWith('feat/') || b.startsWith('story/');
        }
        case 'onMainBranch': {
            if (!wc.gitBranch) return false;
            return ['main', 'master', 'trunk'].includes(wc.gitBranch.toLowerCase());
        }
        case 'hasRecentStory': return typeof wc.recentStoryId === 'number' && wc.recentStoryId > 0;
        default: return false;
    }
}

// ---------------------------------------------------------------------------
// Manifest loading + user overrides
// ---------------------------------------------------------------------------

function loadManifest(workspaceRoot: string, manifestPath: string | undefined): { routes: RouteEntry[]; sourceLabel: string } {
    const relPath = manifestPath || '.cs-qa/routes.json';
    const abs = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
    if (fs.existsSync(abs)) {
        try {
            const raw = JSON.parse(fs.readFileSync(abs, 'utf-8')) as { routes?: RouteEntry[] } | RouteEntry[];
            const list: RouteEntry[] = Array.isArray(raw) ? raw : (raw.routes ?? []);
            const validated: RouteEntry[] = [];
            for (const r of list) {
                if (typeof r?.id === 'string' && typeof r.category === 'string' && Array.isArray(r.intents)) {
                    validated.push(r);
                }
            }
            if (validated.length > 0) {
                // Merge user routes on TOP of embedded (user wins on id collision).
                const embeddedById = new Map(EMBEDDED_ROUTES.map((r) => [r.id, r]));
                for (const r of validated) embeddedById.set(r.id, r);
                return { routes: Array.from(embeddedById.values()), sourceLabel: `user:${abs}+embedded` };
            }
        } catch { /* fall through to embedded */ }
    }
    return { routes: EMBEDDED_ROUTES.slice(), sourceLabel: 'embedded' };
}

// ---------------------------------------------------------------------------
// Learning store
// ---------------------------------------------------------------------------

function learningPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.cs-qa', 'route-learning.json');
}

function readLearning(workspaceRoot: string): Record<string, number> {
    const p = learningPath(workspaceRoot);
    if (!fs.existsSync(p)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, number>;
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        return out;
    } catch { return {}; }
}

function writeLearning(workspaceRoot: string, data: Record<string, number>): void {
    const p = learningPath(workspaceRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreRoute(route: RouteEntry, intent: string, intentTokens: Set<string>, wc: WorkspaceContext, learned: number): ScoreBreakdown {
    const lowered = intent.toLowerCase();
    const matchedIntents: string[] = [];
    let keyword = 0;
    for (const phrase of route.intents) {
        const p = phrase.toLowerCase();
        if (lowered.includes(p)) {
            matchedIntents.push(phrase);
            keyword += 3.0;
        }
    }

    let regex = 0;
    let matchedRegex: string | null = null;
    const regexCaptures: string[] = [];
    if (route.regexes && route.regexes.length > 0) {
        for (const src of route.regexes) {
            let re: RegExp;
            try { re = new RegExp(src, 'i'); } catch { continue; }
            const m = re.exec(intent);
            if (m) {
                matchedRegex = src;
                regex += 2.5;
                for (let i = 1; i < m.length; i++) if (m[i] !== undefined) regexCaptures.push(m[i]);
                break; // one regex hit is enough
            }
        }
    }

    // Token overlap — jaccard mapped into [1.0, 2.0].
    let tokenOverlap = 0;
    const routeTokens = new Set<string>();
    for (const t of tokenize(route.id.replace(/-/g, ' '))) routeTokens.add(t);
    for (const t of tokenize(route.description)) routeTokens.add(t);
    for (const phrase of route.intents) for (const t of tokenize(phrase)) routeTokens.add(t);
    const j = jaccard(intentTokens, routeTokens);
    if (j > 0) tokenOverlap = 1.0 + j * 1.0; // 1.0 → 2.0

    // Context boosts
    let context = 0;
    const contextFlagsApplied: string[] = [];
    if (route.contextRules) {
        for (const rule of route.contextRules) {
            if (evaluateContextFlag(rule.if, wc)) {
                context += rule.boost;
                contextFlagsApplied.push(rule.if);
            }
        }
    }

    const persisted = route.successBoost ?? 0;
    const learnedTotal = persisted + learned;

    const total = keyword + regex + tokenOverlap + context + learnedTotal;
    return {
        routeId: route.id,
        keyword,
        regex,
        tokenOverlap,
        context,
        learned: learnedTotal,
        total,
        matchedIntents,
        matchedRegex,
        regexCaptures,
        contextFlagsApplied,
    };
}

// ---------------------------------------------------------------------------
// Arg fill
// ---------------------------------------------------------------------------

function fillArgs(route: RouteEntry, breakdown: ScoreBreakdown, wc: WorkspaceContext): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    if (!route.argsFromContext) return out;
    for (const [argName, expr] of Object.entries(route.argsFromContext)) {
        const chain = expr.split('|').map((s) => s.trim()).filter(Boolean);
        for (const src of chain) {
            const val = resolveArgSource(src, breakdown, wc);
            if (val !== undefined && val !== null && String(val).length > 0) {
                out[argName] = val;
                break;
            }
        }
    }
    return out;
}

function resolveArgSource(src: string, breakdown: ScoreBreakdown, wc: WorkspaceContext): string | number | undefined {
    // regexCaptureN
    const capMatch = src.match(/^regexCapture(\d+)$/i);
    if (capMatch) {
        const idx = Number(capMatch[1]) - 1;
        if (idx >= 0 && idx < breakdown.regexCaptures.length) return breakdown.regexCaptures[idx];
        return undefined;
    }
    // wc fields
    if (src === 'recentStoryId' && wc.recentStoryId) return wc.recentStoryId;
    if (src === 'openPrId' && wc.openPrId) return wc.openPrId;
    if (src === 'gitBranch' && wc.gitBranch) return wc.gitBranch;
    // literal fallback
    if (src.startsWith('literal:')) return src.slice('literal:'.length);
    return undefined;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function appendHistory(workspaceRoot: string, entry: Record<string, unknown>): void {
    const p = path.join(workspaceRoot, '.cs-qa', 'route-history.jsonl');
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* history is best-effort */ }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const RouteEntryZ: z.ZodType<RouteEntry> = z.object({
    id: z.string().min(1),
    category: z.enum(['understand', 'generate', 'run', 'audit', 'heal', 'govern', 'analyze', 'migrate', 'bootstrap']),
    intents: z.array(z.string().min(1)).min(1),
    regexes: z.array(z.string()).optional(),
    chain: z.array(z.string().startsWith('/')).optional(),
    skill: z.string().startsWith('/').optional(),
    argsFromContext: z.record(z.string(), z.string()).optional(),
    contextRules: z.array(z.object({ if: z.string().min(1), boost: z.number() })).optional(),
    successBoost: z.number().optional(),
    description: z.string().min(1),
});

const RouteInputZ = z.object({
    intent: z.string().min(1),
    workspaceContext: z.object({
        gitBranch: z.string().optional(),
        openPrId: z.number().int().positive().optional(),
        recentStoryId: z.number().int().positive().optional(),
        hasSourceModel: z.boolean().optional(),
        hasDocsModel: z.boolean().optional(),
    }).optional(),
    manifestPath: z.string().optional(),
    minMatchScore: z.number().min(0).max(20).optional().default(0.4),
    dryRun: z.boolean().optional().default(false),
});

const ListInputZ = z.object({ verb: z.literal('list'), category: z.string().optional() });
const LearnInputZ = z.object({ verb: z.literal('learn'), routeId: z.string().min(1), succeeded: z.boolean() });
const ExplainInputZ = z.object({ verb: z.literal('explain'), routeId: z.string().min(1) });
const AddRouteInputZ = z.object({ verb: z.literal('add-route'), route: RouteEntryZ });

const InputSchema = z.union([ListInputZ, LearnInputZ, ExplainInputZ, AddRouteInputZ, RouteInputZ]);
type InputT = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.string(),
    action: z.enum(['single', 'chain', 'ambiguous', 'not-found', 'list', 'learn', 'explain', 'add-route']).optional(),
    chosenSkill: z.string().optional(),
    chosenChain: z.array(z.string()).optional(),
    args: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    alternatives: z.array(z.object({
        routeId: z.string(),
        score: z.number(),
        skill: z.string().optional(),
        chain: z.array(z.string()).optional(),
        description: z.string(),
    })).default([]),
    reasoning: z.array(z.string()).default([]),
    contextUsed: z.object({
        gitBranch: z.string().optional(),
        openPrId: z.number().optional(),
        recentStoryId: z.number().optional(),
        hasSourceModel: z.boolean().optional(),
        hasDocsModel: z.boolean().optional(),
    }).optional(),
    manifestSource: z.string().optional(),
    routes: z.array(z.object({
        id: z.string(),
        category: z.string(),
        skill: z.string().optional(),
        chain: z.array(z.string()).optional(),
        description: z.string(),
        intents: z.array(z.string()),
    })).optional(),
    byCategory: z.record(z.string(), z.array(z.string())).optional(),
    routeEntry: RouteEntryZ.optional(),
    successBoost: z.number().optional(),
    persistedTo: z.string().optional(),
    note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Verb handlers
// ---------------------------------------------------------------------------

function handleList(routes: RouteEntry[], categoryFilter: string | undefined): z.infer<typeof OutputSchema> {
    const filtered = categoryFilter ? routes.filter((r) => r.category === categoryFilter) : routes;
    const byCategory: Record<string, string[]> = {};
    for (const r of filtered) {
        (byCategory[r.category] ||= []).push(r.id);
    }
    return {
        ok: true,
        verb: 'list',
        action: 'list',
        alternatives: [],
        reasoning: [`Listed ${filtered.length} route(s)${categoryFilter ? ' in category ' + categoryFilter : ''}.`],
        routes: filtered.map((r) => ({
            id: r.id,
            category: r.category,
            skill: r.skill,
            chain: r.chain,
            description: r.description,
            intents: r.intents,
        })),
        byCategory,
        note: `${filtered.length} route(s) available.`,
    };
}

function handleExplain(routes: RouteEntry[], routeId: string): z.infer<typeof OutputSchema> {
    const entry = routes.find((r) => r.id === routeId);
    if (!entry) {
        return {
            ok: false,
            verb: 'explain',
            action: 'explain',
            alternatives: [],
            reasoning: [],
            note: `Route not found: ${routeId}`,
        };
    }
    return {
        ok: true,
        verb: 'explain',
        action: 'explain',
        alternatives: [],
        reasoning: [`Loaded route entry ${routeId} from manifest.`],
        routeEntry: entry,
        note: `Route ${routeId} explained.`,
    };
}

function handleLearn(workspaceRoot: string, routeId: string, succeeded: boolean, routes: RouteEntry[]): z.infer<typeof OutputSchema> {
    const routeExists = routes.some((r) => r.id === routeId);
    if (!routeExists) {
        return {
            ok: false, verb: 'learn', action: 'learn', alternatives: [], reasoning: [],
            note: `Route not found: ${routeId}. Nothing was learned.`,
        };
    }
    const store = readLearning(workspaceRoot);
    const prev = store[routeId] ?? 0;
    const delta = succeeded ? 0.25 : -0.15;
    // Clamp to [-2, 2] so learning can't drown out fresh signals.
    const next = Math.max(-2, Math.min(2, prev + delta));
    store[routeId] = Number(next.toFixed(4));
    writeLearning(workspaceRoot, store);
    return {
        ok: true,
        verb: 'learn',
        action: 'learn',
        alternatives: [],
        reasoning: [
            `Route ${routeId} recorded as ${succeeded ? 'succeeded' : 'failed'}.`,
            `successBoost: ${prev.toFixed(4)} → ${store[routeId].toFixed(4)} (delta ${delta > 0 ? '+' : ''}${delta}).`,
        ],
        successBoost: store[routeId],
        persistedTo: learningPath(workspaceRoot),
        note: `Learning updated for ${routeId}.`,
    };
}

function handleAddRoute(workspaceRoot: string, route: RouteEntry): z.infer<typeof OutputSchema> {
    const userPath = path.join(workspaceRoot, '.cs-qa', 'routes.json');
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    let existing: { routes: RouteEntry[] } = { routes: [] };
    if (fs.existsSync(userPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(userPath, 'utf-8')) as { routes?: RouteEntry[] } | RouteEntry[];
            const list = Array.isArray(raw) ? raw : (raw.routes ?? []);
            existing = { routes: list };
        } catch {
            existing = { routes: [] };
        }
    }
    const idx = existing.routes.findIndex((r) => r.id === route.id);
    if (idx >= 0) existing.routes[idx] = route;
    else existing.routes.push(route);
    fs.writeFileSync(userPath, JSON.stringify(existing, null, 2), 'utf-8');
    return {
        ok: true,
        verb: 'add-route',
        action: 'add-route',
        alternatives: [],
        reasoning: [`Route ${route.id} ${idx >= 0 ? 'updated in' : 'added to'} ${userPath}.`],
        persistedTo: userPath,
        routeEntry: route,
        note: `${idx >= 0 ? 'Updated' : 'Added'} route ${route.id}.`,
    };
}

// ---------------------------------------------------------------------------
// Route handler (default verb)
// ---------------------------------------------------------------------------

function pickAction(sorted: ScoreBreakdown[], minScore: number): 'single' | 'chain' | 'ambiguous' | 'not-found' {
    if (sorted.length === 0) return 'not-found';
    const top = sorted[0];
    if (top.total < minScore) return 'not-found';
    if (sorted.length >= 2) {
        const second = sorted[1];
        // ambiguous if second is within 15% of top AND second also crosses minScore
        if (second.total >= minScore && (top.total - second.total) / top.total < 0.15) return 'ambiguous';
    }
    return 'single'; // may be re-mapped to 'chain' by caller when route has chain
}

async function handleRoute(workspaceRoot: string, input: z.infer<typeof RouteInputZ>): Promise<z.infer<typeof OutputSchema>> {
    // Build workspace context (input overrides sniffed).
    const sniffed = readWorkspaceContext(workspaceRoot);
    const wc: WorkspaceContext = { ...sniffed, ...(input.workspaceContext || {}) };

    const { routes, sourceLabel } = loadManifest(workspaceRoot, input.manifestPath);
    const learningStore = readLearning(workspaceRoot);

    const intentTokens = uniqTokens(input.intent);
    const breakdowns = routes.map((r) => scoreRoute(r, input.intent, intentTokens, wc, learningStore[r.id] ?? 0));
    breakdowns.sort((a, b) => b.total - a.total);

    const decision = pickAction(breakdowns, input.minMatchScore);
    const reasoning: string[] = [];

    if (decision === 'not-found') {
        const suggestions = breakdowns.slice(0, 3).map((b) => {
            const route = routes.find((r) => r.id === b.routeId);
            return {
                routeId: b.routeId,
                score: Number(b.total.toFixed(3)),
                skill: route?.skill,
                chain: route?.chain,
                description: route?.description ?? '',
            };
        });
        reasoning.push(`No route scored >= ${input.minMatchScore}. Top score: ${breakdowns[0]?.total.toFixed(3) ?? 'n/a'}.`);
        reasoning.push('Suggested nearest routes are returned in alternatives.');
        if (!input.dryRun) {
            appendHistory(workspaceRoot, { ts: new Date().toISOString(), intent: input.intent, decision: 'not-found', topScore: breakdowns[0]?.total ?? 0 });
        }
        return {
            ok: true,
            verb: 'route',
            action: 'not-found',
            alternatives: suggestions,
            reasoning,
            contextUsed: wc,
            manifestSource: sourceLabel,
            note: 'No matching workflow. Try /cs-qa-ai-assist without args to see all skills.',
        };
    }

    if (decision === 'ambiguous') {
        const top3 = breakdowns.slice(0, 3).map((b) => {
            const route = routes.find((r) => r.id === b.routeId);
            return {
                routeId: b.routeId,
                score: Number(b.total.toFixed(3)),
                skill: route?.skill,
                chain: route?.chain,
                description: route?.description ?? '',
            };
        });
        reasoning.push(`Top two candidates tied within 15% (top ${breakdowns[0].total.toFixed(3)}, second ${breakdowns[1].total.toFixed(3)}).`);
        reasoning.push('Returning top 3 for user disambiguation.');
        if (!input.dryRun) {
            appendHistory(workspaceRoot, { ts: new Date().toISOString(), intent: input.intent, decision: 'ambiguous', top3: top3.map((x) => x.routeId) });
        }
        return {
            ok: true,
            verb: 'route',
            action: 'ambiguous',
            alternatives: top3,
            reasoning,
            contextUsed: wc,
            manifestSource: sourceLabel,
            note: 'Multiple close matches. Pick one from alternatives.',
        };
    }

    // Single winner.
    const winnerBreakdown = breakdowns[0];
    const winner = routes.find((r) => r.id === winnerBreakdown.routeId)!;
    const args = fillArgs(winner, winnerBreakdown, wc);

    reasoning.push(`Matched intents: [${winnerBreakdown.matchedIntents.join(', ') || '<none>'}]`);
    if (winnerBreakdown.matchedRegex) reasoning.push(`Regex hit: ${winnerBreakdown.matchedRegex} → captures [${winnerBreakdown.regexCaptures.join(', ')}]`);
    reasoning.push(`Score components — keyword:${winnerBreakdown.keyword.toFixed(2)} regex:${winnerBreakdown.regex.toFixed(2)} tokens:${winnerBreakdown.tokenOverlap.toFixed(2)} context:${winnerBreakdown.context.toFixed(2)} learned:${winnerBreakdown.learned.toFixed(2)} → total ${winnerBreakdown.total.toFixed(2)}`);
    if (winnerBreakdown.contextFlagsApplied.length > 0) reasoning.push(`Context flags applied: [${winnerBreakdown.contextFlagsApplied.join(', ')}]`);
    if (breakdowns[1]) reasoning.push(`Runner-up: ${breakdowns[1].routeId} at ${breakdowns[1].total.toFixed(3)} (gap ${(winnerBreakdown.total - breakdowns[1].total).toFixed(3)}).`);

    const alternatives = breakdowns.slice(1, 4).map((b) => {
        const r = routes.find((x) => x.id === b.routeId);
        return {
            routeId: b.routeId,
            score: Number(b.total.toFixed(3)),
            skill: r?.skill,
            chain: r?.chain,
            description: r?.description ?? '',
        };
    });

    const isChain = Array.isArray(winner.chain) && winner.chain.length > 0;
    const action = isChain ? 'chain' : 'single';

    if (!input.dryRun) {
        appendHistory(workspaceRoot, {
            ts: new Date().toISOString(),
            intent: input.intent,
            decision: action,
            chosen: winner.id,
            score: winnerBreakdown.total,
            args,
        });
    }

    const result: z.infer<typeof OutputSchema> = {
        ok: true,
        verb: 'route',
        action,
        alternatives,
        reasoning,
        contextUsed: wc,
        manifestSource: sourceLabel,
        args,
        note: `Selected ${winner.id} (${action}).`,
    };
    if (isChain) result.chosenChain = winner.chain;
    else if (winner.skill) result.chosenSkill = winner.skill;
    else {
        // Route has neither — fabricate a slash-command from the id.
        result.chosenSkill = '/' + winner.id;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_route',
    description: 'Intent router — takes a user natural-language ask and picks the best skill (or skill chain) from the manifest of registered CS-QA workflows. Verbs: default (route) returns {action, chosenSkill?, chosenChain?, args, alternatives, reasoning}; list returns all routes grouped by category; learn bumps a route\'s successBoost; explain returns a route\'s full manifest entry; add-route persists a custom route to .cs-qa/routes.json. Reads workspace context (git branch, open PR state, recent story, source-model presence) and applies contextRules boosts. All decisions are journalled to .cs-qa/route-history.jsonl unless dryRun.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_route', { workspaceRoot: ctx.workspaceRoot });
        const typed = input as InputT;

        // Verb dispatch — list, learn, explain, add-route.
        if ('verb' in typed && typed.verb === 'list') {
            const { routes } = loadManifest(ctx.workspaceRoot, undefined);
            log.info('list routes', { count: routes.length, category: typed.category });
            return handleList(routes, typed.category);
        }
        if ('verb' in typed && typed.verb === 'explain') {
            const { routes } = loadManifest(ctx.workspaceRoot, undefined);
            log.info('explain route', { routeId: typed.routeId });
            return handleExplain(routes, typed.routeId);
        }
        if ('verb' in typed && typed.verb === 'learn') {
            const { routes } = loadManifest(ctx.workspaceRoot, undefined);
            log.info('learn route', { routeId: typed.routeId, succeeded: typed.succeeded });
            return handleLearn(ctx.workspaceRoot, typed.routeId, typed.succeeded, routes);
        }
        if ('verb' in typed && typed.verb === 'add-route') {
            log.info('add route', { routeId: typed.route.id });
            return handleAddRoute(ctx.workspaceRoot, typed.route);
        }

        // Default: route.
        const routeInput = typed as z.infer<typeof RouteInputZ>;
        log.info('route intent', { intent: routeInput.intent, dryRun: routeInput.dryRun });
        return await handleRoute(ctx.workspaceRoot, routeInput);
    },
});

// Exposed for smoke tests + external inspection.
export const _embeddedRoutesForTests = EMBEDDED_ROUTES;
