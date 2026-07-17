/**
 * Agentic SDLC Platform — Mode Catalog
 *
 * Single source of truth for the thirteen SDLC modes: their user-facing
 * titles, the inputs each mode collects, the capability packs each mode
 * activates, and the ordered stage graph the playbook engine runs.
 *
 * The same catalog drives BOTH rendering paths:
 *   - MCP elicitation (VS Code): mode list → native dropdown, input
 *     fields → native form (enum fields render as pick lists)
 *   - Text fallback (JetBrains & others): numbered menu the agent relays
 *
 * @module agentic/CSSDLCCatalog
 */

import { ModeDefinition, ModeInputField, SDLCMode, TextMenu } from './types';

// ============================================================================
// Shared field fragments
// ============================================================================

const PROJECT_FIELD: ModeInputField = {
    id: 'project',
    title: 'Project',
    description: 'Project key under test/<project> and config/<project> (kebab-case).',
    type: 'string',
    required: true,
    pattern: '^[a-z0-9][a-z0-9-]*$',
};

const ENVIRONMENT_FIELD: ModeInputField = {
    id: 'environment',
    title: 'Environment',
    description: 'Target environment (matches config/<project>/environments/<env>.env).',
    type: 'enum',
    required: false,
    options: ['dev', 'sit', 'uat', 'qa', 'staging', 'prod-readonly'],
    optionTitles: [
        'Development',
        'System Integration (SIT)',
        'User Acceptance (UAT)',
        'QA',
        'Staging',
        'Production (read-only checks)',
    ],
    default: 'dev',
};

const MODULE_FIELD: ModeInputField = {
    id: 'module',
    title: 'Module / feature area',
    description: 'Optional module folder inside the project (e.g. "login", "payments").',
    type: 'string',
    required: false,
};

// ============================================================================
// Mode definitions
// ============================================================================

export const MODE_DEFINITIONS: ModeDefinition[] = [
    {
        mode: 'plan',
        title: 'Plan — test strategy & plan',
        summary: 'Produce a test strategy and executable test plan from an ADO plan id, a document, or a description.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'source',
                title: 'Planning source',
                description: 'Where the requirements come from.',
                type: 'enum',
                required: true,
                options: ['ado_plan', 'document', 'description'],
                optionTitles: ['Azure DevOps plan/suite id', 'Requirement document path', 'Plain description'],
            },
            {
                id: 'sourceValue',
                title: 'Source value',
                description: 'The ADO id, document path, or one-paragraph description.',
                type: 'string',
                required: true,
            },
            MODULE_FIELD,
        ],
        toolPacks: [],
        stages: ['inventory', 'plan.source', 'plan.compose', 'finalize'],
    },
    {
        mode: 'analyze',
        title: 'Analyze — requirements / legacy / app analysis',
        summary: 'Deep structured analysis of requirements, legacy test code, or an application area before any work starts.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'target',
                title: 'Analysis target',
                description: 'Path to legacy code / document, an app URL, or a description of the area.',
                type: 'string',
                required: true,
            },
            MODULE_FIELD,
        ],
        toolPacks: [],
        stages: ['inventory', 'analyze.discover', 'analyze.compose', 'finalize'],
    },
    {
        mode: 'design',
        title: 'Design — scenarios, coverage & page-object model',
        summary: 'Design scenario matrix, coverage map, and page-object structure for a feature before implementation.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'featureDescription',
                title: 'Feature under design',
                description: 'What is being tested — a short description or a document/ADO reference.',
                type: 'string',
                required: true,
            },
            MODULE_FIELD,
            {
                id: 'riskLevel',
                title: 'Risk profile',
                description: 'Drives depth of negative/edge coverage in the design.',
                type: 'enum',
                required: false,
                options: ['standard', 'high', 'critical'],
                optionTitles: ['Standard', 'High risk', 'Business critical'],
                default: 'standard',
            },
        ],
        toolPacks: [],
        stages: ['inventory', 'design.compose', 'finalize'],
    },
    {
        mode: 'author',
        title: 'Implement — author new tests',
        summary: 'Generate complete CS-framework tests (features, steps, pages, data) from a description, document, ADO item, or app URL.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'source',
                title: 'What to automate',
                description: 'Description, document path, ADO test case id (TC12345), or app URL.',
                type: 'string',
                required: true,
            },
            MODULE_FIELD,
            ENVIRONMENT_FIELD,
            {
                id: 'appUrl',
                title: 'Application URL (optional)',
                description:
                    'Live app URL to explore before authoring — the agent walks the workflows and captures page objects/elements like a human tester.',
                type: 'string',
                required: false,
            },
        ],
        toolPacks: ['authoring', 'quality'],
        stages: ['posture', 'author.intake', 'author.explore', 'author.data', 'author.pipeline', 'finalize'],
    },
    {
        mode: 'migrate',
        title: 'Migrate — legacy tests → CS framework',
        summary: 'Migrate legacy Java/C#/other test code to the CS Playwright framework through the audited 9-phase pipeline.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'legacyPath',
                title: 'Legacy source path',
                description: 'File or folder of the legacy test project to migrate.',
                type: 'string',
                required: true,
            },
            MODULE_FIELD,
            ENVIRONMENT_FIELD,
            {
                id: 'appUrl',
                title: 'Application URL (optional)',
                description:
                    'Live app URL — lets the agent verify migrated locators against the real application while migrating.',
                type: 'string',
                required: false,
            },
        ],
        toolPacks: ['authoring', 'quality'],
        stages: ['posture', 'author.intake', 'author.explore', 'author.data', 'author.pipeline', 'finalize'],
    },
    {
        mode: 'review',
        title: 'Review — test-code standards review',
        summary: 'Audit test code against the 40+ framework rules plus a semantic quality review with concrete fixes.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'scope',
                title: 'Review scope',
                description: 'Folder or file to review. Defaults to the whole project test tree.',
                type: 'string',
                required: false,
            },
        ],
        toolPacks: [],
        stages: ['review.scan', 'review.compose', 'finalize'],
    },
    {
        mode: 'pr_review',
        title: 'PR review — branch diff review',
        summary: 'Review the current branch diff (vs a base branch): rule audit on changed files + semantic review + verdict.',
        inputs: [
            {
                id: 'baseBranch',
                title: 'Base branch',
                description: 'Branch to diff against.',
                type: 'string',
                required: false,
                default: 'main',
            },
            PROJECT_FIELD,
        ],
        toolPacks: [],
        stages: ['prreview.diff', 'review.compose', 'finalize'],
    },
    {
        mode: 'run',
        title: 'Run — execute test suites',
        summary: 'Execute feature suites for a project/environment/tag selection and return a parsed result report.',
        inputs: [
            PROJECT_FIELD,
            ENVIRONMENT_FIELD,
            {
                id: 'tags',
                title: 'Tag filter',
                description: 'Optional Gherkin tag expression (e.g. "@smoke and not @wip").',
                type: 'string',
                required: false,
            },
            {
                id: 'headless',
                title: 'Headless',
                description: 'Run browsers headless.',
                type: 'boolean',
                required: false,
                default: true,
            },
        ],
        toolPacks: ['execution'],
        stages: ['run.execute', 'run.report', 'finalize'],
    },
    {
        mode: 'heal',
        title: 'Maintain — heal failing tests',
        summary: 'Bounded self-healing of failing tests: locator drift, timing flake, selector repair — with cascade-revert safety.',
        inputs: [
            PROJECT_FIELD,
            ENVIRONMENT_FIELD,
            {
                id: 'target',
                title: 'Failing feature/scenario',
                description: 'Feature path or scenario name to heal. Empty = latest failed run.',
                type: 'string',
                required: false,
            },
        ],
        toolPacks: ['execution', 'browser', 'quality'],
        stages: ['heal.loop', 'finalize'],
    },
    {
        mode: 'triage',
        title: 'Triage — failure & bug triage',
        summary: 'Cluster recent failures by signature, classify root causes, record correction memory, output a triage board.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'window',
                title: 'How far back',
                description: 'Result window to triage.',
                type: 'enum',
                required: false,
                options: ['latest', 'last3', 'last10'],
                optionTitles: ['Latest run only', 'Last 3 runs', 'Last 10 runs'],
                default: 'latest',
            },
        ],
        toolPacks: [],
        stages: ['triage.cluster', 'triage.compose', 'finalize'],
    },
    {
        mode: 'regression',
        title: 'Regression — impact-based selection & run',
        summary: 'Analyze recent changes, select the impacted regression subset, confirm, and execute it.',
        inputs: [
            PROJECT_FIELD,
            ENVIRONMENT_FIELD,
            {
                id: 'baseBranch',
                title: 'Compare against',
                description: 'Base branch for change detection.',
                type: 'string',
                required: false,
                default: 'main',
            },
        ],
        toolPacks: ['execution'],
        stages: ['regression.impact', 'regression.confirm', 'run.execute', 'run.report', 'finalize'],
    },
    {
        mode: 'performance',
        title: 'Performance — timing analysis & perf run',
        summary: 'Run a perf-focused pass, extract step/scenario timings, find hotspots and slow-trend outliers.',
        inputs: [
            PROJECT_FIELD,
            ENVIRONMENT_FIELD,
            {
                id: 'tags',
                title: 'Tag filter',
                description: 'Optional tag expression to scope the perf pass.',
                type: 'string',
                required: false,
            },
        ],
        toolPacks: ['execution', 'insights'],
        stages: ['run.execute', 'perf.analyze', 'finalize'],
    },
    {
        mode: 'audit',
        title: 'Audit — full project health audit',
        summary: 'Whole-project audit: rule violations, placeholders, orphan steps, duplicate defs, data mismatches, health report.',
        inputs: [PROJECT_FIELD],
        toolPacks: [],
        stages: ['audit.scan', 'audit.compose', 'finalize'],
    },
    {
        mode: 'accessibility',
        title: 'Accessibility — WCAG audit of the live app',
        summary: 'Walk the application with axe-based audits (WCAG 2.x), aggregate violations, grade, and produce a remediation plan.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'targetUrl',
                title: 'Application URL',
                description: 'Entry URL of the environment to audit.',
                type: 'string',
                required: true,
                pattern: '^https?://.+',
            },
            {
                id: 'standard',
                title: 'Standard',
                description: 'Accessibility standard to audit against.',
                type: 'enum',
                required: false,
                options: ['WCAG2A', 'WCAG2AA', 'WCAG2AAA', 'Section508'],
                optionTitles: ['WCAG 2.0 A', 'WCAG 2.0 AA', 'WCAG 2.0 AAA', 'Section 508'],
                default: 'WCAG2AA',
            },
        ],
        toolPacks: [],
        stages: ['scan.a11y', 'scan.compose', 'finalize'],
    },
    {
        mode: 'security',
        title: 'Security — scan the live app (test env only)',
        summary: 'Headers, cookies, sensitive-data exposure, CSRF and XSS checks on an authorized test environment, with graded remediation plan.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'targetUrl',
                title: 'Application URL',
                description: 'Entry URL of the TEST environment you are authorized to scan.',
                type: 'string',
                required: true,
                pattern: '^https?://.+',
            },
        ],
        toolPacks: [],
        stages: ['scan.security', 'scan.compose', 'finalize'],
    },
    {
        mode: 'ado_plan',
        title: 'ADO test plan — story → test cases in Azure DevOps',
        summary: 'Fetch a story from ADO, design full-coverage test cases from its acceptance criteria, create them in ADO with proper Steps, and attach them to the suite you pick.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'workItemId',
                title: 'Story / requirement id',
                description: 'The ADO work item id of the user story or requirement to design test cases for.',
                type: 'string',
                required: true,
                pattern: '^[0-9]+$',
            },
        ],
        toolPacks: [],
        stages: ['adoplan.context', 'adoplan.select', 'adoplan.compose', 'adoplan.create', 'finalize'],
    },
    {
        mode: 'release',
        title: 'Release — evidence-based go/no-go',
        summary: 'Aggregate local run evidence, flaky candidates, and open ADO bugs into a gated go / conditional-go / no-go decision with a sign-off report.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'releaseName',
                title: 'Release name/version',
                description: 'What is being released (e.g. "3.2.0" or "sprint-42").',
                type: 'string',
                required: true,
            },
        ],
        toolPacks: [],
        stages: ['release.evidence', 'release.ado', 'release.compose', 'finalize'],
    },
    {
        mode: 'load',
        title: 'Load — load/stress test on the native perf engine',
        summary: 'Design a realistic load/stress/spike/endurance profile with thresholds and generate a runnable scenario for the framework\'s built-in performance engine — no k6 or JMeter needed.',
        inputs: [
            PROJECT_FIELD,
            {
                id: 'targetUrl',
                title: 'Target URL',
                description: 'Entry URL of the TEST environment to load-test.',
                type: 'string',
                required: true,
                pattern: '^https?://.+',
            },
            {
                id: 'testType',
                title: 'Test type',
                description: 'Shape of the load.',
                type: 'enum',
                required: false,
                options: ['load', 'stress', 'spike', 'endurance', 'baseline'],
                optionTitles: [
                    'Load (expected traffic)',
                    'Stress (beyond capacity)',
                    'Spike (sudden surge)',
                    'Endurance (sustained)',
                    'Baseline (single-user reference)',
                ],
                default: 'load',
            },
            {
                id: 'virtualUsers',
                title: 'Virtual users',
                description: 'Peak concurrent virtual users.',
                type: 'number',
                required: false,
                default: 25,
            },
            {
                id: 'durationSeconds',
                title: 'Duration (seconds)',
                description: 'Total test duration in seconds.',
                type: 'number',
                required: false,
                default: 300,
            },
        ],
        toolPacks: [],
        stages: ['load.design', 'load.render', 'finalize'],
    },
];

// ============================================================================
// CSSDLCCatalog
// ============================================================================

export class CSSDLCCatalog {
    public static list(): ModeDefinition[] {
        return MODE_DEFINITIONS;
    }

    public static get(mode: string): ModeDefinition | undefined {
        return MODE_DEFINITIONS.find((m) => m.mode === mode);
    }

    public static isMode(value: string): value is SDLCMode {
        return MODE_DEFINITIONS.some((m) => m.mode === value);
    }

    /** Numbered text menu of all modes — the no-elicitation fallback. */
    public static modeMenu(): TextMenu {
        return {
            title: 'CS AI Auto-Assist — what do you want to do?',
            prompt:
                'Reply with the number (or mode name). I will then ask only for the inputs that option needs.',
            options: MODE_DEFINITIONS.map((m, i) => ({
                n: i + 1,
                value: m.mode,
                label: m.title,
                hint: m.summary,
            })),
        };
    }

    /** Resolve a user's menu answer ("5", "migrate", "Migrate — …") to a mode. */
    public static resolveModeAnswer(answer: string): SDLCMode | undefined {
        const trimmed = (answer ?? '').trim().toLowerCase();
        if (!trimmed) return undefined;
        const byNumber = parseInt(trimmed, 10);
        if (!Number.isNaN(byNumber) && byNumber >= 1 && byNumber <= MODE_DEFINITIONS.length) {
            return MODE_DEFINITIONS[byNumber - 1].mode;
        }
        const exact = MODE_DEFINITIONS.find((m) => m.mode === trimmed);
        if (exact) return exact.mode;
        const byTitle = MODE_DEFINITIONS.find((m) => m.title.toLowerCase().startsWith(trimmed));
        return byTitle?.mode;
    }

    /**
     * Validate + coerce collected inputs for a mode. Returns the missing
     * required fields (for a follow-up question) and the normalized values.
     */
    public static validateInputs(
        mode: ModeDefinition,
        raw: Record<string, unknown>,
    ): {
        values: Record<string, string | number | boolean>;
        missing: ModeInputField[];
        errors: string[];
    } {
        const values: Record<string, string | number | boolean> = {};
        const missing: ModeInputField[] = [];
        const errors: string[] = [];

        for (const field of mode.inputs) {
            const provided = raw[field.id];
            if (provided === undefined || provided === null || provided === '') {
                if (field.default !== undefined) {
                    values[field.id] = field.default;
                } else if (field.required) {
                    missing.push(field);
                }
                continue;
            }
            switch (field.type) {
                case 'boolean': {
                    const b =
                        typeof provided === 'boolean'
                            ? provided
                            : ['true', 'yes', 'y', '1'].includes(String(provided).toLowerCase());
                    values[field.id] = b;
                    break;
                }
                case 'number': {
                    const n = typeof provided === 'number' ? provided : Number(provided);
                    if (Number.isNaN(n)) {
                        errors.push(`${field.id}: "${String(provided)}" is not a number`);
                    } else {
                        values[field.id] = n;
                    }
                    break;
                }
                case 'enum': {
                    const s = String(provided).trim();
                    const options = field.options ?? [];
                    const hit =
                        options.find((o) => o === s) ??
                        options.find((o) => o.toLowerCase() === s.toLowerCase());
                    if (hit) {
                        values[field.id] = hit;
                    } else {
                        errors.push(`${field.id}: "${s}" must be one of ${options.join(', ')}`);
                    }
                    break;
                }
                default: {
                    const s = String(provided).trim();
                    if (field.pattern && !new RegExp(field.pattern).test(s)) {
                        errors.push(`${field.id}: "${s}" does not match ${field.pattern}`);
                    } else {
                        values[field.id] = s;
                    }
                }
            }
        }

        return { values, missing, errors };
    }
}
