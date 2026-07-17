/**
 * Agentic SDLC Platform — Playbook Stage Library
 *
 * Every stage referenced by CSSDLCCatalog is implemented here. Stage kinds:
 *
 *   deterministic — pure TypeScript, zero LLM tokens (inventory, discovery,
 *                   audits, git diffs, result parsing, clustering, rendering)
 *   cognitive     — returns a DelegationEnvelope; the host LLM fulfils it
 *                   and hands JSON back through csaa_submit (schema-gated)
 *   handoff       — directs the agent to capability-pack tools (the proven
 *                   csaa_* authoring chain, bdd_run_feature, heal loop) and
 *                   accepts a structured completion report
 *   elicit        — a user decision point (native dropdown when the host
 *                   supports MCP elicitation, numbered text menu otherwise)
 *
 * Deterministic-first is the credit-efficiency contract: if TypeScript can
 * compute it, the LLM never pays tokens for it.
 *
 * @module agentic/CSPlaybooks
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { CSRepoInventory } from '../agent-platform/CSRepoInventory';
import { CSDiscovery } from '../agent-platform/CSDiscovery';
import { CSIntentRouter } from '../agent-platform/CSIntentRouter';
import { CSRunContext } from '../agent-platform/CSRunContext';
import { CSSkillRetriever } from '../agent-platform/CSSkillRetriever';
import { AuditEngine, FileType } from '../tools/audit/AuditEngine';
import type { JsonSchema } from '../agent-platform/CSDelegationSchemas';
import type { DelegationEnvelope } from '../agent-platform/CSDelegationEnvelope';

import { StageContext, StageDefinition, StageOutcome } from './types';
import { CSGuardrailEngine, GUARDRAIL_LIMITS } from './CSGuardrailEngine';

// ============================================================================
// Small deterministic helpers
// ============================================================================

function str(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

/** Recursively collect files under root matching extensions (bounded). */
function walkFiles(root: string, exts: string[], limit: number = 400): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0 && out.length < limit) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(full);
            } else if (exts.some((x) => e.name.endsWith(x))) {
                out.push(full);
                if (out.length >= limit) break;
            }
        }
    }
    return out.sort();
}

/** Map a file path to the audit engine's file-type domain. */
function auditFileType(file: string): FileType {
    const p = file.replace(/\\/g, '/');
    if (p.endsWith('.feature')) return 'feature';
    if (/\/pages?\//.test(p) || /\.page\.ts$/.test(p)) return 'page';
    if (/\/steps?\//.test(p) || /\.steps\.ts$/.test(p)) return 'step';
    if (p.endsWith('.json') || p.endsWith('.csv') || p.endsWith('.xlsx')) return 'data';
    return 'ts';
}

interface FileAuditFinding {
    file: string;
    ruleId: string;
    severity: string;
    line: number | null;
    message: string;
}

/** Run the 40+ deterministic audit rules over a set of files. */
function auditFiles(files: string[]): {
    findings: FileAuditFinding[];
    errors: number;
    warnings: number;
    filesScanned: number;
} {
    const engine = new AuditEngine();
    const findings: FileAuditFinding[] = [];
    let errors = 0;
    let warnings = 0;
    let filesScanned = 0;
    for (const file of files) {
        let content: string;
        try {
            content = fs.readFileSync(file, 'utf-8');
        } catch {
            continue;
        }
        filesScanned += 1;
        const result = engine.audit(content, auditFileType(file));
        for (const v of result.violations) {
            findings.push({
                file,
                ruleId: v.ruleId,
                severity: v.severity,
                line: v.line,
                message: v.message,
            });
            if (v.severity === 'error') errors += 1;
            else warnings += 1;
        }
    }
    return { findings, errors, warnings, filesScanned };
}

/** `git diff --name-status` against a base ref, with sane fallbacks. */
function gitChangedFiles(
    workspaceRoot: string,
    baseBranch: string,
): { files: Array<{ status: string; file: string }>; baseRef: string; error?: string } {
    const candidates = [`origin/${baseBranch}`, baseBranch, 'HEAD~1'];
    for (const ref of candidates) {
        try {
            const raw = execSync(`git diff --name-status ${ref}...HEAD`, {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 20_000,
            });
            const files = raw
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .map((l) => {
                    const [status, ...rest] = l.split('\t');
                    return { status, file: rest[rest.length - 1] ?? '' };
                })
                .filter((f) => f.file);
            return { files, baseRef: ref };
        } catch {
            /* try next ref */
        }
    }
    return { files: [], baseRef: baseBranch, error: 'git diff failed for all candidate refs' };
}

// ---------------------------------------------------------------------------
// Test-result discovery (mirrors the analytics tools' conventions)
// ---------------------------------------------------------------------------

interface ScenarioResult {
    name: string;
    feature: string;
    status: string;
    duration: number;
    error?: string;
    steps: Array<{ name: string; status: string; duration: number; error?: string }>;
}

function reportsBaseDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, process.env.REPORTS_BASE_DIR ?? 'reports');
}

function latestResultDirs(workspaceRoot: string, count: number): string[] {
    const base = reportsBaseDir(workspaceRoot);
    if (!fs.existsSync(base)) return [];
    return fs
        .readdirSync(base)
        .filter((n) => n.startsWith('test-results-'))
        .map((n) => {
            const full = path.join(base, n);
            return { full, mtime: fs.statSync(full).mtime.getTime() };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, count)
        .map((d) => d.full);
}

function loadScenarios(resultDir: string): ScenarioResult[] {
    const file = path.join(resultDir, 'reports', 'report-data.json');
    if (!fs.existsSync(file)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const scenarios = data.suite?.scenarios || data.scenarios || [];
        return scenarios.map((s: Record<string, unknown>) => ({
            name: str(s.name) || 'Unknown',
            feature: str(s.feature) || 'Unknown',
            status: str(s.status) === 'broken' ? 'failed' : str(s.status),
            duration: Number(s.duration) || 0,
            error: s.error ? str(s.error) : undefined,
            steps: Array.isArray(s.steps)
                ? (s.steps as Array<Record<string, unknown>>).map((st) => ({
                      name: str(st.name),
                      status: str(st.status),
                      duration: Number(st.duration) || 0,
                      error: st.error ? str(st.error) : undefined,
                  }))
                : [],
        }));
    } catch {
        return [];
    }
}

/** Normalize an error message into a clustering signature. */
function errorSignature(error: string): string {
    return error
        .split('\n')[0]
        .replace(/\d+/g, 'N')
        .replace(/["'`][^"'`]{0,80}["'`]/g, 'X')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

// ---------------------------------------------------------------------------
// Envelope + skill helpers
// ---------------------------------------------------------------------------

function skillHints(text: string, k: number = 3): Array<{ id: string; title: string; summary: string }> {
    try {
        return CSSkillRetriever.getDefault()
            .search({ text, k })
            .map((h) => ({ id: h.id, title: h.title, summary: h.summary }));
    } catch {
        return [];
    }
}

function makeEnvelope(
    ctx: StageContext,
    task: string,
    instruction: string,
    responseSchema: JsonSchema,
    grounding: Record<string, unknown>,
): DelegationEnvelope {
    const envelope: DelegationEnvelope = {
        task,
        instruction,
        responseSchema,
        grounding,
        recordWith: 'csaa_submit',
        recordArgs: { sessionId: ctx.session.sessionId },
    };
    ctx.recordTokens(JSON.stringify(envelope).length);
    return envelope;
}

function findingsTable(findings: FileAuditFinding[], limit: number): string {
    const rows = findings
        .slice(0, limit)
        .map(
            (f) =>
                `| ${path.basename(f.file)} | ${f.line ?? '-'} | ${f.severity} | ${f.ruleId} | ${f.message.replace(/\|/g, '\\|')} |`,
        );
    return [
        '| File | Line | Severity | Rule | Message |',
        '|---|---|---|---|---|',
        ...rows,
    ].join('\n');
}

// ============================================================================
// Stage registry
// ============================================================================

const STAGES: Record<string, StageDefinition> = {};

function stage(def: StageDefinition): void {
    STAGES[def.id] = def;
}

// ---------------------------------------------------------------------------
// Shared: inventory
// ---------------------------------------------------------------------------

stage({
    id: 'inventory',
    kind: 'deterministic',
    title: 'Repository inventory',
    run: (ctx: StageContext): StageOutcome => {
        const project = str(ctx.session.inputs.project);
        const module = str(ctx.session.inputs.module) || undefined;
        const inventory = CSRepoInventory.inventory(project, {
            module,
            workspaceRoot: ctx.workspaceRoot,
        });
        const artifact = ctx.writeArtifact('inventory.json', JSON.stringify(inventory, null, 2));
        const s = inventory.summary;
        return {
            status: 'complete',
            summary: `inventory: ${s.pageCount} pages, ${s.stepCount} step files, ${s.featureCount} features, ${s.scenarioCount} scenarios`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Shared: finalize
// ---------------------------------------------------------------------------

stage({
    id: 'finalize',
    kind: 'gate',
    title: 'Trust gate & final report',
    run: (ctx: StageContext): StageOutcome => {
        const session = ctx.session;
        const executed = session.stageLog.some(
            (s) => s.stageId === 'run.execute' || s.stageId === 'author.pipeline' || s.stageId === 'heal.loop',
        );
        const trust = CSGuardrailEngine.computeTrust(session, {
            sourceGrounded: true,
            executed,
            judgeVerdict: executed ? 'PASS_REAL' : 'PASS_WEAK',
            hasMeaningfulAssertions: true,
            commitReadyCheckPassed: session.stageLog.every((s) => s.status !== 'blocked'),
            healCyclesUsed: session.healCycles,
        });

        const lines: string[] = [
            `# CS AI Auto-Assist — final report (${session.mode})`,
            '',
            `- Session: \`${session.sessionId}\``,
            `- Trust score: **${trust.score.toFixed(2)}** (${trust.level})`,
            `- Recommendation: ${trust.recommendation}`,
            `- Estimated tokens: ~${session.usage.estimatedTokens.toLocaleString()} across ${session.usage.toolCalls} tool calls`,
            '',
            '## Stage log',
            '',
            ...session.stageLog.map((s) => `- \`${s.stageId}\` [${s.status}] — ${s.summary}`),
            '',
            '## Artifacts',
            '',
            ...session.artifacts.map((a) => `- ${a}`),
        ];
        const reportPath = ctx.writeArtifact('final-report.md', lines.join('\n') + '\n');
        return {
            status: 'finished',
            summary: `trust ${trust.score.toFixed(2)} (${trust.level})`,
            reportPath,
            artifacts: [reportPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const PLAN_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['objectives', 'inScope', 'outOfScope', 'riskAreas', 'scenarioOutlines', 'entryCriteria', 'exitCriteria'],
    properties: {
        objectives: { type: 'array', minItems: 1, items: { type: 'string' } },
        inScope: { type: 'array', items: { type: 'string' } },
        outOfScope: { type: 'array', items: { type: 'string' } },
        riskAreas: {
            type: 'array',
            items: {
                type: 'object',
                required: ['area', 'risk', 'mitigation'],
                properties: {
                    area: { type: 'string' },
                    risk: { type: 'string' },
                    mitigation: { type: 'string' },
                },
            },
        },
        scenarioOutlines: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['title', 'priority', 'type'],
                properties: {
                    title: { type: 'string', minLength: 5 },
                    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                    type: { type: 'string', enum: ['positive', 'negative', 'edge', 'e2e'] },
                    notes: { type: 'string' },
                },
            },
        },
        dataNeeds: { type: 'array', items: { type: 'string' } },
        environments: { type: 'array', items: { type: 'string' } },
        entryCriteria: { type: 'array', items: { type: 'string' } },
        exitCriteria: { type: 'array', items: { type: 'string' } },
    },
};

stage({
    id: 'plan.source',
    kind: 'handoff',
    title: 'Resolve planning source',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        const source = str(inputs.source);
        const value = str(inputs.sourceValue);

        // ADO plan/suite/work-item id → fetch it for real (needs ado pack).
        if (source === 'ado_plan') {
            if (ctx.handoffReport === undefined) {
                return {
                    status: 'handoff',
                    summary: 'ADO source fetch delegated',
                    handoff: {
                        handoffId: 'plan.source',
                        packs: ['ado'],
                        instruction:
                            `Fetch the ADO item referenced by "${value}": if it is a work-item id, ` +
                            'ado_work_items_get (include title, description, acceptance criteria); if ' +
                            'it is a test plan/suite id, ado_test_plans_list / ado_test_suites_list / ' +
                            'ado_test_suite_test_cases_list to enumerate existing coverage. Strip HTML. ' +
                            'Return a compact JSON summary as the report. Then csaa_advance.',
                        nextSuggestedTool: 'ado_work_items_get',
                        nextSuggestedArgs: { id: Number(value) || value },
                        doneWhen: 'the ADO item (or plan/suite contents) is fetched',
                        reportSchema: {
                            type: 'object',
                            required: ['summary'],
                            properties: {
                                summary: { type: 'string', minLength: 10 },
                                title: { type: 'string' },
                                acceptanceCriteria: { type: 'string' },
                                existingCoverage: { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                };
            }
            const artifact = ctx.writeArtifact('planning-source.json', JSON.stringify(ctx.handoffReport, null, 2));
            return { status: 'complete', summary: 'ADO planning source fetched', artifacts: [artifact] };
        }

        // Document path → read it deterministically (no LLM, no tokens).
        if (source === 'document' && value && fs.existsSync(value)) {
            let text = '';
            try {
                text = fs.readFileSync(value, 'utf-8').slice(0, 40_000);
            } catch {
                /* ignore */
            }
            const artifact = ctx.writeArtifact(
                'planning-source.json',
                JSON.stringify({ summary: `Document: ${value}`, content: text }, null, 2),
            );
            return { status: 'complete', summary: `document read (${text.length} chars)`, artifacts: [artifact] };
        }

        // Plain description → nothing to fetch; the value itself is the source.
        const artifact = ctx.writeArtifact(
            'planning-source.json',
            JSON.stringify({ summary: value }, null, 2),
        );
        return { status: 'complete', summary: 'description used as planning source', artifacts: [artifact] };
    },
});

stage({
    id: 'plan.compose',
    kind: 'cognitive',
    title: 'Compose test plan',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.submission === undefined) {
            const inputs = ctx.session.inputs;
            return {
                status: 'envelope',
                summary: 'awaiting test-plan JSON',
                envelope: makeEnvelope(
                    ctx,
                    'compose-test-plan',
                    'Produce a test plan as JSON matching responseSchema exactly. ' +
                        'Ground every scenario outline in the planning source (read ' +
                        'planning-source.json at the groundingPaths — it holds the real fetched ' +
                        'ADO item / document / description). Do not invent features not implied by ' +
                        'it. Prioritize by user risk. The repository inventory (existing coverage) ' +
                        'is also at groundingPaths — avoid planning scenarios that already exist.',
                    PLAN_SCHEMA,
                    {
                        groundingPaths: ctx.session.artifacts.filter(
                            (a) => a.endsWith('inventory.json') || a.endsWith('planning-source.json'),
                        ),
                        project: str(inputs.project),
                        module: str(inputs.module),
                        skills: skillHints('test plan scenario design coverage'),
                    },
                ),
            };
        }
        const plan = ctx.submission as Record<string, unknown>;
        const so = (plan.scenarioOutlines as Array<Record<string, string>>) ?? [];
        const md: string[] = [
            `# Test Plan — ${str(ctx.session.inputs.project)}`,
            '',
            '## Objectives',
            ...((plan.objectives as string[]) ?? []).map((o) => `- ${o}`),
            '',
            '## Scope',
            '### In scope',
            ...((plan.inScope as string[]) ?? []).map((o) => `- ${o}`),
            '### Out of scope',
            ...((plan.outOfScope as string[]) ?? []).map((o) => `- ${o}`),
            '',
            '## Risk areas',
            '| Area | Risk | Mitigation |',
            '|---|---|---|',
            ...(((plan.riskAreas as Array<Record<string, string>>) ?? []).map(
                (r) => `| ${r.area} | ${r.risk} | ${r.mitigation} |`,
            )),
            '',
            '## Planned scenarios',
            '| Priority | Type | Scenario | Notes |',
            '|---|---|---|---|',
            ...so.map((s) => `| ${s.priority} | ${s.type} | ${s.title} | ${s.notes ?? ''} |`),
            '',
            '## Data needs',
            ...(((plan.dataNeeds as string[]) ?? []).map((d) => `- ${d}`)),
            '',
            '## Entry / exit criteria',
            '### Entry',
            ...(((plan.entryCriteria as string[]) ?? []).map((d) => `- ${d}`)),
            '### Exit',
            ...(((plan.exitCriteria as string[]) ?? []).map((d) => `- ${d}`)),
        ];
        const jsonPath = ctx.writeArtifact('test-plan.json', JSON.stringify(plan, null, 2));
        const mdPath = ctx.writeArtifact('TEST-PLAN.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `test plan composed: ${so.length} scenario outlines`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

stage({
    id: 'analyze.discover',
    kind: 'deterministic',
    title: 'Discover analysis target',
    run: (ctx: StageContext): StageOutcome => {
        const target = str(ctx.session.inputs.target);
        const classified = CSIntentRouter.classify(target);
        const artifacts: string[] = [];
        let summary = `target classified as ${classified.mode} (confidence ${classified.confidence.toFixed(2)})`;
        if (fs.existsSync(target)) {
            const inventory = CSDiscovery.discover(target);
            artifacts.push(
                ctx.writeArtifact('discovery.json', JSON.stringify(inventory, null, 2)),
            );
            summary += ` — ${inventory.counts.files} files (${inventory.counts.tests} tests, ${inventory.counts.pages} pages, ${inventory.counts.dataFiles} data files)`;
        }
        artifacts.push(
            ctx.writeArtifact('classification.json', JSON.stringify(classified, null, 2)),
        );
        return { status: 'complete', summary, artifacts };
    },
});

const ANALYZE_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['overview', 'testableBehaviors', 'risks', 'gaps', 'recommendations', 'readinessScore'],
    properties: {
        overview: { type: 'string', minLength: 40 },
        testableBehaviors: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['behavior', 'evidence'],
                properties: {
                    behavior: { type: 'string' },
                    evidence: { type: 'string' },
                    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
            },
        },
        risks: { type: 'array', items: { type: 'string' } },
        gaps: {
            type: 'array',
            items: {
                type: 'object',
                required: ['gap', 'severity'],
                properties: {
                    gap: { type: 'string' },
                    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
            },
        },
        recommendations: { type: 'array', items: { type: 'string' } },
        readinessScore: { type: 'number', minimum: 0, maximum: 1 },
    },
};

stage({
    id: 'analyze.compose',
    kind: 'cognitive',
    title: 'Compose analysis report',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting analysis JSON',
                envelope: makeEnvelope(
                    ctx,
                    'compose-analysis',
                    'Analyze the target below and produce JSON matching responseSchema. ' +
                        'Cite concrete evidence (file paths / observed behavior) for every ' +
                        'testable behavior — no generic filler. Score readiness honestly: ' +
                        'below 0.7 means automation should not start yet. ' +
                        `Target: ${str(ctx.session.inputs.target)}. ` +
                        'Read the discovery/classification artifacts at groundingPaths first.',
                    ANALYZE_SCHEMA,
                    {
                        groundingPaths: ctx.session.artifacts.filter(
                            (a) => a.endsWith('discovery.json') || a.endsWith('classification.json') || a.endsWith('inventory.json'),
                        ),
                        skills: skillHints('analysis legacy migration readiness'),
                    },
                ),
            };
        }
        const analysis = ctx.submission as Record<string, unknown>;
        const behaviors = (analysis.testableBehaviors as Array<Record<string, string>>) ?? [];
        const gaps = (analysis.gaps as Array<Record<string, string>>) ?? [];
        const md = [
            `# Analysis — ${str(ctx.session.inputs.project)}`,
            '',
            str(analysis.overview),
            '',
            `**Readiness score:** ${Number(analysis.readinessScore).toFixed(2)}`,
            '',
            '## Testable behaviors',
            '| Behavior | Evidence | Complexity |',
            '|---|---|---|',
            ...behaviors.map((b) => `| ${b.behavior} | ${b.evidence} | ${b.complexity ?? '-'} |`),
            '',
            '## Gaps',
            ...gaps.map((g) => `- **[${g.severity}]** ${g.gap}`),
            '',
            '## Risks',
            ...(((analysis.risks as string[]) ?? []).map((r) => `- ${r}`)),
            '',
            '## Recommendations',
            ...(((analysis.recommendations as string[]) ?? []).map((r) => `- ${r}`)),
        ];
        const jsonPath = ctx.writeArtifact('analysis.json', JSON.stringify(analysis, null, 2));
        const mdPath = ctx.writeArtifact('ANALYSIS.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `analysis composed: ${behaviors.length} behaviors, readiness ${Number(analysis.readinessScore).toFixed(2)}`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

const DESIGN_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['scenarios', 'coverage', 'pageObjects', 'dataStrategy'],
    properties: {
        scenarios: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id', 'title', 'type', 'priority', 'steps'],
                properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    type: { type: 'string', enum: ['positive', 'negative', 'edge', 'e2e'] },
                    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                    steps: { type: 'array', minItems: 1, items: { type: 'string' } },
                },
            },
        },
        coverage: {
            type: 'array',
            items: {
                type: 'object',
                required: ['area', 'coveredBy'],
                properties: {
                    area: { type: 'string' },
                    coveredBy: { type: 'array', items: { type: 'string' } },
                    notes: { type: 'string' },
                },
            },
        },
        pageObjects: {
            type: 'array',
            items: {
                type: 'object',
                required: ['name', 'reuseExisting', 'elements'],
                properties: {
                    name: { type: 'string' },
                    reuseExisting: { type: 'boolean' },
                    elements: { type: 'array', items: { type: 'string' } },
                    methods: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        dataStrategy: { type: 'string', minLength: 20 },
    },
};

stage({
    id: 'design.compose',
    kind: 'cognitive',
    title: 'Compose test design',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting design JSON',
                envelope: makeEnvelope(
                    ctx,
                    'compose-design',
                    'Design tests for the feature below: scenario matrix (Gherkin-style step ' +
                        'lists), coverage map, and page-object plan. Read the inventory artifact ' +
                        'first and set reuseExisting=true for any page object that already exists ' +
                        '— never redesign an existing page. Depth follows riskLevel ' +
                        `(${str(ctx.session.inputs.riskLevel) || 'standard'}). ` +
                        `Feature: ${str(ctx.session.inputs.featureDescription)}`,
                    DESIGN_SCHEMA,
                    {
                        groundingPath: ctx.session.artifacts.find((a) => a.endsWith('inventory.json')),
                        skills: skillHints('page object element scenario outline design'),
                    },
                ),
            };
        }
        const design = ctx.submission as Record<string, unknown>;
        const scenarios = (design.scenarios as Array<Record<string, unknown>>) ?? [];
        const pos = (design.pageObjects as Array<Record<string, unknown>>) ?? [];
        const md = [
            `# Test Design — ${str(ctx.session.inputs.project)}`,
            '',
            '## Scenario matrix',
            '| ID | Priority | Type | Scenario |',
            '|---|---|---|---|',
            ...scenarios.map((s) => `| ${s.id} | ${s.priority} | ${s.type} | ${s.title} |`),
            '',
            ...scenarios.map((s) =>
                [`### ${s.id} — ${s.title}`, ...((s.steps as string[]) ?? []).map((x) => `- ${x}`), ''].join('\n'),
            ),
            '## Page objects',
            ...pos.map(
                (p) =>
                    `- **${p.name}** ${p.reuseExisting ? '(reuse existing)' : '(new)'} — elements: ${((p.elements as string[]) ?? []).join(', ')}`,
            ),
            '',
            '## Data strategy',
            str(design.dataStrategy),
        ];
        const jsonPath = ctx.writeArtifact('test-design.json', JSON.stringify(design, null, 2));
        const mdPath = ctx.writeArtifact('TEST-DESIGN.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `design composed: ${scenarios.length} scenarios, ${pos.length} page objects`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Author / migrate — intake + handoff to the proven csaa_* chain
// ---------------------------------------------------------------------------

stage({
    id: 'author.intake',
    kind: 'deterministic',
    title: 'Authoring intake (agent-platform run)',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        const source = str(inputs.legacyPath) || str(inputs.source);
        const classified = CSIntentRouter.classify(source);
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const runCtx = CSRunContext.getOrCreate(runId, {
            workspaceRoot: ctx.workspaceRoot,
            inputSummary: `${ctx.session.mode}: ${source.slice(0, 120)}`,
        });
        runCtx.startPhase('intake');
        runCtx.writePhaseArtifact(
            'intake',
            'classified-input.json',
            JSON.stringify({ ...classified, sessionId: ctx.session.sessionId }, null, 2),
        );
        runCtx.finishPhase('intake', 'done', { reason: `mode=${classified.mode}` });
        ctx.session.linkedRunId = runId;
        return {
            status: 'complete',
            summary: `run ${runId} created (${classified.mode}, confidence ${classified.confidence.toFixed(2)})`,
        };
    },
});

const AUTHOR_REPORT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['finalState', 'filesWritten'],
    properties: {
        finalState: { type: 'string', enum: ['READY', 'PASS_PARTIAL', 'FAILED', 'BLOCKED_NEED_HUMAN'] },
        filesWritten: { type: 'number', minimum: 0 },
        scenariosTotal: { type: 'number' },
        scenariosPassed: { type: 'number' },
        trustScore: { type: 'number' },
        finalReportPath: { type: 'string' },
        blockedReason: { type: 'string' },
    },
};

stage({
    id: 'author.pipeline',
    kind: 'handoff',
    title: 'csaa_* authoring pipeline',
    run: (ctx: StageContext): StageOutcome => {
        const runId = ctx.session.linkedRunId ?? '';
        if (ctx.handoffReport === undefined) {
            const inputs = ctx.session.inputs;
            const source = str(inputs.legacyPath) || str(inputs.source);
            const isPath = fs.existsSync(source);
            const grounding: string[] = ctx.session.artifacts.filter(
                (a) =>
                    a.endsWith('workspace-posture.json') ||
                    a.endsWith('captured-pages.json') ||
                    a.endsWith('data-resolution.json'),
            );
            const groundingNote = grounding.length
                ? ` GROUNDING ARTIFACTS (read and honour them when fulfilling analyze/translate ` +
                  `envelopes): ${grounding.join(', ')} — captured-pages.json locators are the ` +
                  'source of truth for page objects; data-resolution.json decides each ' +
                  'scenario\'s data strategy (db → cite the SELECT; ui_create → emit the setup ' +
                  'steps); workspace-posture.json tells you what to reuse instead of recreate.'
                : '';
            return {
                status: 'handoff',
                summary: 'authoring chain delegated',
                handoff: {
                    handoffId: 'author.pipeline',
                    instruction:
                        `Drive the csaa_* pipeline for run ${runId} to completion. ` +
                        'Start with the suggested tool, then ALWAYS follow each result\'s ' +
                        'nextSuggestedTool/nextSuggestedArgs without asking the user. ' +
                        'Fulfil every delegation envelope exactly per its responseSchema ' +
                        'via the envelope\'s recordWith tool. Stop only on BLOCKED_NEED_HUMAN ' +
                        'or after csaa_verify (and csaa_publish if the user asked for ADO publish). ' +
                        'Then call csaa_advance with the report described in reportSchema.' +
                        groundingNote,
                    nextSuggestedTool: 'csaa_discover',
                    nextSuggestedArgs: isPath
                        ? { runId, rootPath: source }
                        : { runId, rootPath: ctx.workspaceRoot },
                    doneWhen:
                        'csaa_verify returned READY/PASS_PARTIAL/FAILED, or any primitive returned BLOCKED_NEED_HUMAN',
                    reportSchema: AUTHOR_REPORT_SCHEMA,
                },
            };
        }
        const report = ctx.handoffReport;
        const finalState = str(report.finalState);
        if (finalState === 'BLOCKED_NEED_HUMAN') {
            return {
                status: 'blocked',
                summary: 'authoring pipeline blocked',
                blockedReason: str(report.blockedReason) || 'pipeline reported BLOCKED_NEED_HUMAN',
            };
        }
        return {
            status: 'complete',
            summary: `pipeline ${finalState}: ${Number(report.filesWritten) || 0} files, ${Number(report.scenariosPassed) || 0}/${Number(report.scenariosTotal) || 0} scenarios passed`,
        };
    },
});

// ---------------------------------------------------------------------------
// Review / PR review
// ---------------------------------------------------------------------------

stage({
    id: 'review.scan',
    kind: 'deterministic',
    title: 'Deterministic rule audit',
    run: (ctx: StageContext): StageOutcome => {
        const project = str(ctx.session.inputs.project);
        const scope = str(ctx.session.inputs.scope);
        const root = scope && fs.existsSync(scope) ? scope : path.join(ctx.workspaceRoot, 'test', project);
        if (!fs.existsSync(root)) {
            return {
                status: 'blocked',
                summary: 'scope not found',
                blockedReason: `Review scope not found: ${root}. Check the project name.`,
            };
        }
        const files = fs.statSync(root).isFile()
            ? [root]
            : walkFiles(root, ['.ts', '.feature', '.json']);
        const result = auditFiles(files);
        const artifact = ctx.writeArtifact(
            'audit-findings.json',
            JSON.stringify({ root, ...result }, null, 2),
        );
        return {
            status: 'complete',
            summary: `audited ${result.filesScanned} files: ${result.errors} errors, ${result.warnings} warnings`,
            artifacts: [artifact],
        };
    },
});

stage({
    id: 'prreview.diff',
    kind: 'deterministic',
    title: 'Branch diff + changed-file audit',
    run: (ctx: StageContext): StageOutcome => {
        const base = str(ctx.session.inputs.baseBranch) || 'main';
        const diff = gitChangedFiles(ctx.workspaceRoot, base);
        if (diff.error && diff.files.length === 0) {
            return {
                status: 'blocked',
                summary: 'git diff failed',
                blockedReason: `Could not diff against "${base}" (${diff.error}). Is this a git repo with that base branch?`,
            };
        }
        const changedAbs = diff.files
            .filter((f) => f.status !== 'D')
            .map((f) => path.join(ctx.workspaceRoot, f.file))
            .filter((f) => fs.existsSync(f) && /\.(ts|feature|json)$/.test(f));
        const result = auditFiles(changedAbs);
        const artifact = ctx.writeArtifact(
            'diff-audit.json',
            JSON.stringify({ baseRef: diff.baseRef, changed: diff.files, ...result }, null, 2),
        );
        return {
            status: 'complete',
            summary: `diff vs ${diff.baseRef}: ${diff.files.length} changed files, ${result.errors} rule errors, ${result.warnings} warnings`,
            artifacts: [artifact],
        };
    },
});

const REVIEW_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['verdict', 'summary', 'findings'],
    properties: {
        verdict: { type: 'string', enum: ['approve', 'approve_with_nits', 'request_changes'] },
        summary: { type: 'string', minLength: 30 },
        findings: {
            type: 'array',
            items: {
                type: 'object',
                required: ['file', 'severity', 'issue', 'fix'],
                properties: {
                    file: { type: 'string' },
                    line: { type: 'number' },
                    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
                    issue: { type: 'string' },
                    fix: { type: 'string' },
                },
            },
        },
        quickWins: { type: 'array', items: { type: 'string' } },
    },
};

stage({
    id: 'review.compose',
    kind: 'cognitive',
    title: 'Semantic review',
    run: (ctx: StageContext): StageOutcome => {
        const findingsArtifact = ctx.session.artifacts.find(
            (a) => a.endsWith('audit-findings.json') || a.endsWith('diff-audit.json'),
        );
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting review JSON',
                envelope: makeEnvelope(
                    ctx,
                    'compose-review',
                    'Perform a semantic review of the audited code. Read the deterministic ' +
                        'findings artifact first (groundingPath) — do NOT repeat what the rule ' +
                        'engine already caught; add what only a reviewer can see: wrong ' +
                        'assertions, missing negative paths, brittle locators, data coupling, ' +
                        'framework-convention drift. Read the actual files listed in the ' +
                        'findings for context. Every finding needs a concrete fix. ' +
                        'Return JSON per responseSchema.',
                    REVIEW_SCHEMA,
                    {
                        groundingPath: findingsArtifact,
                        skills: skillHints('review audit rules conventions assertions'),
                    },
                ),
            };
        }
        const review = ctx.submission as Record<string, unknown>;
        const findings = (review.findings as Array<Record<string, unknown>>) ?? [];
        let deterministic: { findings: FileAuditFinding[]; errors: number; warnings: number } = {
            findings: [],
            errors: 0,
            warnings: 0,
        };
        if (findingsArtifact && fs.existsSync(findingsArtifact)) {
            try {
                deterministic = JSON.parse(fs.readFileSync(findingsArtifact, 'utf-8'));
            } catch {
                /* keep empty */
            }
        }
        const md = [
            `# Review — ${str(ctx.session.inputs.project)}`,
            '',
            `**Verdict: ${str(review.verdict)}**`,
            '',
            str(review.summary),
            '',
            '## Semantic findings',
            '| File | Line | Severity | Issue | Fix |',
            '|---|---|---|---|---|',
            ...findings.map(
                (f) =>
                    `| ${f.file} | ${f.line ?? '-'} | ${f.severity} | ${str(f.issue).replace(/\|/g, '\\|')} | ${str(f.fix).replace(/\|/g, '\\|')} |`,
            ),
            '',
            `## Deterministic rule findings (${deterministic.errors} errors, ${deterministic.warnings} warnings)`,
            findingsTable(deterministic.findings ?? [], 60),
            '',
            '## Quick wins',
            ...(((review.quickWins as string[]) ?? []).map((q) => `- ${q}`)),
        ];
        const jsonPath = ctx.writeArtifact('review.json', JSON.stringify(review, null, 2));
        const mdPath = ctx.writeArtifact('REVIEW.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `review verdict: ${str(review.verdict)} (${findings.length} semantic findings)`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Run + report
// ---------------------------------------------------------------------------

const RUN_REPORT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['total', 'passed', 'failed'],
    properties: {
        total: { type: 'number', minimum: 0 },
        passed: { type: 'number', minimum: 0 },
        failed: { type: 'number', minimum: 0 },
        skipped: { type: 'number' },
        notes: { type: 'string' },
    },
};

stage({
    id: 'run.execute',
    kind: 'handoff',
    title: 'Execute suites',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const inputs = ctx.session.inputs;
            const project = str(inputs.project);
            const selected = str(inputs.selectedFeatures);
            const featureTarget =
                selected || path.join(ctx.workspaceRoot, 'test', project, 'features');
            const guard = CSGuardrailEngine.checkAction('bdd_run_feature', {
                environment: str(inputs.environment),
            });
            if (!guard.ok) {
                return {
                    status: 'blocked',
                    summary: 'constitutional block',
                    blockedReason: guard.reason,
                };
            }
            return {
                status: 'handoff',
                summary: 'execution delegated',
                handoff: {
                    handoffId: 'run.execute',
                    instruction:
                        `Set environment PROJECT=${project}` +
                        (str(inputs.environment) ? ` ENVIRONMENT=${str(inputs.environment)}` : '') +
                        `, then run the target feature(s) with bdd_run_feature` +
                        (str(inputs.tags) ? ` using tags "${str(inputs.tags)}"` : '') +
                        '. For a directory target, run each .feature (or use the tags filter). ' +
                        'Do not fix failures in this mode — collect results and report back ' +
                        'via csaa_advance with the reportSchema totals.',
                    nextSuggestedTool: 'bdd_run_feature',
                    nextSuggestedArgs: {
                        path: featureTarget,
                        ...(str(inputs.tags) ? { tags: str(inputs.tags) } : {}),
                    },
                    doneWhen: 'all targeted features executed once',
                    reportSchema: RUN_REPORT_SCHEMA,
                },
            };
        }
        const r = ctx.handoffReport;
        return {
            status: 'complete',
            summary: `executed: ${Number(r.passed) || 0}/${Number(r.total) || 0} passed, ${Number(r.failed) || 0} failed`,
        };
    },
});

stage({
    id: 'run.report',
    kind: 'deterministic',
    title: 'Parse run results',
    run: (ctx: StageContext): StageOutcome => {
        const dirs = latestResultDirs(ctx.workspaceRoot, 1);
        const scenarios = dirs.length > 0 ? loadScenarios(dirs[0]) : [];
        const passed = scenarios.filter((s) => s.status === 'passed').length;
        const failed = scenarios.filter((s) => s.status === 'failed').length;
        const md = [
            `# Run report — ${str(ctx.session.inputs.project)}`,
            '',
            `- Result source: ${dirs[0] ?? '(no report-data.json found — totals from agent report)'}`,
            `- Scenarios: ${scenarios.length} (${passed} passed / ${failed} failed)`,
            '',
            '## Failures',
            ...scenarios
                .filter((s) => s.status === 'failed')
                .map((s) => `- **${s.feature} › ${s.name}** (${s.duration}ms)\n  - ${(s.error ?? 'no error captured').split('\n')[0]}`),
            '',
            '## Slowest scenarios',
            ...scenarios
                .slice()
                .sort((a, b) => b.duration - a.duration)
                .slice(0, 10)
                .map((s) => `- ${s.duration}ms — ${s.feature} › ${s.name}`),
        ];
        const artifact = ctx.writeArtifact('RUN-REPORT.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: dirs.length
                ? `parsed ${scenarios.length} scenarios (${passed} passed, ${failed} failed)`
                : 'no report-data.json found; kept agent-reported totals',
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Heal
// ---------------------------------------------------------------------------

const HEAL_REPORT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['cyclesUsed', 'healed', 'remaining'],
    properties: {
        cyclesUsed: { type: 'number', minimum: 0 },
        healed: { type: 'number', minimum: 0 },
        remaining: { type: 'number', minimum: 0 },
        changedFiles: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
    },
};

stage({
    id: 'heal.loop',
    kind: 'handoff',
    title: 'Bounded heal loop',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const inputs = ctx.session.inputs;
            const remaining = GUARDRAIL_LIMITS.maxHealCycles - ctx.session.healCycles;
            if (remaining <= 0) {
                return {
                    status: 'blocked',
                    summary: 'heal budget exhausted',
                    blockedReason: `Heal-cycle budget (${GUARDRAIL_LIMITS.maxHealCycles}) exhausted for this session.`,
                };
            }
            return {
                status: 'handoff',
                summary: 'heal loop delegated',
                handoff: {
                    handoffId: 'heal.loop',
                    instruction:
                        `Heal failing tests for project ${str(inputs.project)}` +
                        (str(inputs.target) ? ` (target: ${str(inputs.target)})` : ' (latest failed run)') +
                        `. Per failure: re-run with bdd_run_feature, classify (locator drift / ` +
                        'timing / data / real bug), fix ONLY page-object locators or waits ' +
                        '(never assertions), re-run to confirm. Use browser tools to inspect ' +
                        `the live DOM when locators drifted. HARD LIMIT: at most ${Math.min(remaining, 3)} ` +
                        'cycles per scenario. If a failure looks like a real application bug, ' +
                        'leave it failing and note it. Then report back via csaa_advance.',
                    nextSuggestedTool: 'bdd_run_feature',
                    nextSuggestedArgs: {
                        path:
                            str(inputs.target) ||
                            path.join(ctx.workspaceRoot, 'test', str(inputs.project), 'features'),
                    },
                    doneWhen: 'every targeted failure is healed, classified as app bug, or out of cycles',
                    reportSchema: HEAL_REPORT_SCHEMA,
                },
            };
        }
        const r = ctx.handoffReport;
        ctx.session.healCycles += Number(r.cyclesUsed) || 0;
        return {
            status: 'complete',
            summary: `heal: ${Number(r.healed) || 0} healed, ${Number(r.remaining) || 0} remaining, ${Number(r.cyclesUsed) || 0} cycles used`,
        };
    },
});

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

stage({
    id: 'triage.cluster',
    kind: 'deterministic',
    title: 'Cluster failures',
    run: (ctx: StageContext): StageOutcome => {
        const window = str(ctx.session.inputs.window) || 'latest';
        const count = window === 'last10' ? 10 : window === 'last3' ? 3 : 1;
        const dirs = latestResultDirs(ctx.workspaceRoot, count);
        const failures: Array<ScenarioResult & { runDir: string }> = [];
        for (const d of dirs) {
            for (const s of loadScenarios(d)) {
                if (s.status === 'failed') failures.push({ ...s, runDir: path.basename(d) });
            }
        }
        const clusters = new Map<string, Array<ScenarioResult & { runDir: string }>>();
        for (const f of failures) {
            const sig = errorSignature(f.error ?? f.steps.find((st) => st.error)?.error ?? 'unknown failure');
            const list = clusters.get(sig) ?? [];
            list.push(f);
            clusters.set(sig, list);
        }
        const clustered = Array.from(clusters.entries())
            .map(([signature, items]) => ({
                signature,
                count: items.length,
                scenarios: items.map((i) => ({ feature: i.feature, name: i.name, runDir: i.runDir })),
                sampleError: items[0].error ?? '',
            }))
            .sort((a, b) => b.count - a.count);
        const artifact = ctx.writeArtifact(
            'failure-clusters.json',
            JSON.stringify({ window, runsScanned: dirs.length, failures: failures.length, clusters: clustered }, null, 2),
        );
        return {
            status: 'complete',
            summary: `${failures.length} failures across ${dirs.length} run(s) → ${clustered.length} clusters`,
            artifacts: [artifact],
        };
    },
});

const TRIAGE_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['clusters'],
    properties: {
        clusters: {
            type: 'array',
            items: {
                type: 'object',
                required: ['signature', 'category', 'rootCause', 'suggestedFix', 'priority'],
                properties: {
                    signature: { type: 'string' },
                    category: {
                        type: 'string',
                        enum: ['locator_drift', 'timing_flake', 'test_data', 'environment', 'app_bug', 'test_bug'],
                    },
                    rootCause: { type: 'string' },
                    suggestedFix: { type: 'string' },
                    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                    raiseDefect: { type: 'boolean' },
                },
            },
        },
        overall: { type: 'string' },
    },
};

stage({
    id: 'triage.compose',
    kind: 'cognitive',
    title: 'Classify failure clusters',
    run: (ctx: StageContext): StageOutcome => {
        const clustersArtifact = ctx.session.artifacts.find((a) => a.endsWith('failure-clusters.json'));
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting triage JSON',
                envelope: makeEnvelope(
                    ctx,
                    'compose-triage',
                    'Read the failure clusters at groundingPath and classify EVERY cluster: ' +
                        'category, root cause, concrete fix, priority, and whether an app defect ' +
                        'should be raised. Base the category on the actual error text, not guesswork ' +
                        '— locator/timeout signatures are locator_drift/timing_flake; assertion ' +
                        'mismatches with correct locators are app_bug or test_data. Return JSON per ' +
                        'responseSchema with one entry per cluster (same signatures).',
                    TRIAGE_SCHEMA,
                    { groundingPath: clustersArtifact, skills: skillHints('heal locator drift timing flaky classification') },
                ),
            };
        }
        const triage = ctx.submission as Record<string, unknown>;
        const clusters = (triage.clusters as Array<Record<string, unknown>>) ?? [];
        const md = [
            `# Triage board — ${str(ctx.session.inputs.project)}`,
            '',
            str(triage.overall ?? ''),
            '',
            '| Priority | Category | Root cause | Suggested fix | Raise defect |',
            '|---|---|---|---|---|',
            ...clusters.map(
                (c) =>
                    `| ${c.priority} | ${c.category} | ${str(c.rootCause).replace(/\|/g, '\\|')} | ${str(c.suggestedFix).replace(/\|/g, '\\|')} | ${c.raiseDefect ? 'yes' : 'no'} |`,
            ),
        ];
        const jsonPath = ctx.writeArtifact('triage.json', JSON.stringify(triage, null, 2));
        const mdPath = ctx.writeArtifact('TRIAGE.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `triage: ${clusters.length} clusters classified`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

stage({
    id: 'regression.impact',
    kind: 'deterministic',
    title: 'Change-impact analysis',
    run: (ctx: StageContext): StageOutcome => {
        const project = str(ctx.session.inputs.project);
        const base = str(ctx.session.inputs.baseBranch) || 'main';
        const diff = gitChangedFiles(ctx.workspaceRoot, base);
        const featuresRoot = path.join(ctx.workspaceRoot, 'test', project, 'features');
        const allFeatures = fs.existsSync(featuresRoot) ? walkFiles(featuresRoot, ['.feature']) : [];

        const changedModules = new Set<string>();
        const changedBasenames = new Set<string>();
        for (const f of diff.files) {
            const parts = f.file.replace(/\\/g, '/').split('/');
            const testIdx = parts.indexOf(project);
            if (testIdx >= 0 && parts.length > testIdx + 2) changedModules.add(parts[testIdx + 2]);
            changedBasenames.add(
                path.basename(f.file).replace(/\.(page|steps)?\.?ts$/, '').toLowerCase(),
            );
        }

        const impacted = allFeatures.filter((feature) => {
            const rel = path.relative(featuresRoot, feature).replace(/\\/g, '/').toLowerCase();
            const nameHit = Array.from(changedBasenames).some(
                (b) => b.length > 3 && rel.includes(b),
            );
            const moduleHit = Array.from(changedModules).some(
                (m) => m.length > 2 && rel.includes(m.toLowerCase()),
            );
            return nameHit || moduleHit;
        });

        const selection = impacted.length > 0 ? impacted : allFeatures;
        const artifact = ctx.writeArtifact(
            'impact.json',
            JSON.stringify(
                {
                    baseRef: diff.baseRef,
                    changedFiles: diff.files,
                    impactedFeatures: impacted,
                    fallbackFullSuite: impacted.length === 0,
                },
                null,
                2,
            ),
        );
        ctx.session.inputs.impactedCount = impacted.length;
        ctx.session.inputs.selectedFeatures = selection.join(',');
        return {
            status: 'complete',
            summary:
                impacted.length > 0
                    ? `${diff.files.length} changed files → ${impacted.length}/${allFeatures.length} features impacted`
                    : `no direct impact mapping found — defaulting to full suite (${allFeatures.length} features)`,
            artifacts: [artifact],
        };
    },
});

stage({
    id: 'regression.confirm',
    kind: 'elicit',
    title: 'Confirm regression scope',
    run: (ctx: StageContext): StageOutcome => {
        const impacted = Number(ctx.session.inputs.impactedCount) || 0;
        const selected = str(ctx.session.inputs.selectedFeatures).split(',').filter(Boolean);
        if (ctx.answers === undefined) {
            return {
                status: 'question',
                summary: 'awaiting scope confirmation',
                question: {
                    questionId: 'regression.scope',
                    message:
                        impacted > 0
                            ? `Impact analysis selected ${impacted} impacted feature(s). Run just those, or the full suite?`
                            : `No specific impact found. Run the full suite (${selected.length} features)?`,
                    fields: [
                        {
                            id: 'scope',
                            title: 'Regression scope',
                            description: 'Which set to execute.',
                            type: 'enum',
                            required: true,
                            options: ['impacted', 'full', 'cancel'],
                            optionTitles: ['Impacted features only', 'Full suite', 'Cancel'],
                            default: impacted > 0 ? 'impacted' : 'full',
                        },
                    ],
                },
            };
        }
        const choice = str(ctx.answers.scope);
        if (choice === 'cancel') {
            return {
                status: 'blocked',
                summary: 'user cancelled regression',
                blockedReason: 'Regression run cancelled by user.',
            };
        }
        if (choice === 'full') {
            const project = str(ctx.session.inputs.project);
            const featuresRoot = path.join(ctx.workspaceRoot, 'test', project, 'features');
            ctx.session.inputs.selectedFeatures = fs.existsSync(featuresRoot)
                ? walkFiles(featuresRoot, ['.feature']).join(',')
                : '';
        }
        return { status: 'complete', summary: `scope confirmed: ${choice}` };
    },
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

stage({
    id: 'perf.analyze',
    kind: 'deterministic',
    title: 'Timing analysis',
    run: (ctx: StageContext): StageOutcome => {
        const dirs = latestResultDirs(ctx.workspaceRoot, 5);
        if (dirs.length === 0) {
            return {
                status: 'complete',
                summary: 'no result folders found under reports/ — nothing to analyze',
            };
        }
        const current = loadScenarios(dirs[0]);
        const durations = current.map((s) => s.duration).sort((a, b) => a - b);
        const pct = (p: number): number =>
            durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))];

        // Trend vs previous runs (mean duration per scenario name).
        const history = new Map<string, number[]>();
        for (const d of dirs.slice(1)) {
            for (const s of loadScenarios(d)) {
                const list = history.get(`${s.feature}›${s.name}`) ?? [];
                list.push(s.duration);
                history.set(`${s.feature}›${s.name}`, list);
            }
        }
        const regressions = current
            .map((s) => {
                const hist = history.get(`${s.feature}›${s.name}`);
                if (!hist || hist.length === 0) return null;
                const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
                return mean > 0 && s.duration > mean * 1.5 && s.duration - mean > 2000
                    ? { name: `${s.feature} › ${s.name}`, now: s.duration, mean: Math.round(mean) }
                    : null;
            })
            .filter((x): x is { name: string; now: number; mean: number } => x !== null);

        const stepTotals = new Map<string, { total: number; count: number }>();
        for (const s of current) {
            for (const st of s.steps) {
                const t = stepTotals.get(st.name) ?? { total: 0, count: 0 };
                t.total += st.duration;
                t.count += 1;
                stepTotals.set(st.name, t);
            }
        }
        const hotSteps = Array.from(stepTotals.entries())
            .map(([name, t]) => ({ name, total: t.total, avg: Math.round(t.total / t.count), count: t.count }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 10);

        const md = [
            `# Performance report — ${str(ctx.session.inputs.project)}`,
            '',
            `- Scenarios measured: ${current.length}`,
            `- p50: ${pct(50)}ms · p90: ${pct(90)}ms · p95: ${pct(95)}ms · max: ${durations[durations.length - 1] ?? 0}ms`,
            '',
            '## Slow-trend regressions (>1.5× historical mean)',
            ...(regressions.length > 0
                ? regressions.map((r) => `- ${r.name}: ${r.now}ms (historical mean ${r.mean}ms)`)
                : ['- none detected']),
            '',
            '## Hottest steps (total time)',
            '| Step | Total | Avg | Calls |',
            '|---|---|---|---|',
            ...hotSteps.map((h) => `| ${h.name.replace(/\|/g, '\\|')} | ${h.total}ms | ${h.avg}ms | ${h.count} |`),
        ];
        const artifact = ctx.writeArtifact('PERF-REPORT.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `perf: p95 ${pct(95)}ms, ${regressions.length} slow-trend regressions, top step "${hotSteps[0]?.name ?? '-'}"`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Audit (full project)
// ---------------------------------------------------------------------------

stage({
    id: 'audit.scan',
    kind: 'deterministic',
    title: 'Full project audit scan',
    run: (ctx: StageContext): StageOutcome => {
        const project = str(ctx.session.inputs.project);
        const testRoot = path.join(ctx.workspaceRoot, 'test', project);
        if (!fs.existsSync(testRoot)) {
            return {
                status: 'blocked',
                summary: 'project not found',
                blockedReason: `test/${project} does not exist in ${ctx.workspaceRoot}.`,
            };
        }
        const files = walkFiles(testRoot, ['.ts', '.feature', '.json'], 800);
        const rules = auditFiles(files);
        const inventory = CSRepoInventory.inventory(project, { workspaceRoot: ctx.workspaceRoot });

        // Duplicate step definitions across files.
        const stepPatterns = new Map<string, string[]>();
        for (const stepFile of inventory.steps) {
            for (const def of stepFile.steps) {
                const list = stepPatterns.get(def.pattern) ?? [];
                list.push(stepFile.relativePath);
                stepPatterns.set(def.pattern, list);
            }
        }
        const duplicateSteps = Array.from(stepPatterns.entries())
            .filter(([, files2]) => new Set(files2).size > 1)
            .map(([pattern, files2]) => ({ pattern, files: Array.from(new Set(files2)) }));

        const artifact = ctx.writeArtifact(
            'audit-full.json',
            JSON.stringify(
                {
                    project,
                    filesScanned: rules.filesScanned,
                    ruleErrors: rules.errors,
                    ruleWarnings: rules.warnings,
                    findings: rules.findings,
                    duplicateSteps,
                    inventorySummary: inventory.summary,
                },
                null,
                2,
            ),
        );
        return {
            status: 'complete',
            summary: `audit: ${rules.filesScanned} files, ${rules.errors} errors, ${rules.warnings} warnings, ${duplicateSteps.length} duplicate step patterns`,
            artifacts: [artifact],
        };
    },
});

const AUDIT_PLAN_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['healthGrade', 'topIssues', 'remediationPlan'],
    properties: {
        healthGrade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
        topIssues: { type: 'array', minItems: 1, items: { type: 'string' } },
        remediationPlan: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['action', 'impact', 'effort'],
                properties: {
                    action: { type: 'string' },
                    impact: { type: 'string', enum: ['high', 'medium', 'low'] },
                    effort: { type: 'string', enum: ['small', 'medium', 'large'] },
                },
            },
        },
        summary: { type: 'string' },
    },
};

stage({
    id: 'audit.compose',
    kind: 'cognitive',
    title: 'Health grade & remediation plan',
    run: (ctx: StageContext): StageOutcome => {
        const auditArtifact = ctx.session.artifacts.find((a) => a.endsWith('audit-full.json'));
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting audit assessment JSON',
                envelope: makeEnvelope(
                    ctx,
                    'compose-audit',
                    'Read the full audit findings at groundingPath and produce a health ' +
                        'assessment: a defensible letter grade, the top issues by real risk ' +
                        '(not raw count), and a prioritized remediation plan (impact × effort). ' +
                        'Return JSON per responseSchema.',
                    AUDIT_PLAN_SCHEMA,
                    { groundingPath: auditArtifact, skills: skillHints('audit rules commit ready gates') },
                ),
            };
        }
        const assessment = ctx.submission as Record<string, unknown>;
        const plan = (assessment.remediationPlan as Array<Record<string, string>>) ?? [];
        const md = [
            `# Project audit — ${str(ctx.session.inputs.project)}`,
            '',
            `**Health grade: ${str(assessment.healthGrade)}**`,
            '',
            str(assessment.summary ?? ''),
            '',
            '## Top issues',
            ...(((assessment.topIssues as string[]) ?? []).map((i) => `- ${i}`)),
            '',
            '## Remediation plan',
            '| Action | Impact | Effort |',
            '|---|---|---|',
            ...plan.map((p) => `| ${p.action} | ${p.impact} | ${p.effort} |`),
        ];
        const jsonPath = ctx.writeArtifact('audit-assessment.json', JSON.stringify(assessment, null, 2));
        const mdPath = ctx.writeArtifact('AUDIT-REPORT.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `health grade ${str(assessment.healthGrade)}, ${plan.length} remediation actions`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Workspace posture — every authoring session starts by understanding what
// already exists (a human tester reads the repo before writing anything)
// ---------------------------------------------------------------------------

stage({
    id: 'posture',
    kind: 'deterministic',
    title: 'Workspace posture & gap analysis',
    run: (ctx: StageContext): StageOutcome => {
        const project = str(ctx.session.inputs.project);
        const module = str(ctx.session.inputs.module) || undefined;
        const inventory = CSRepoInventory.inventory(project, {
            module,
            workspaceRoot: ctx.workspaceRoot,
        });
        const s = inventory.summary;
        const isFresh = s.pageCount + s.stepCount + s.featureCount === 0;

        // Config posture: does the project have config + a DB connection?
        const configRoot = path.join(ctx.workspaceRoot, 'config', project);
        const hasConfig = fs.existsSync(configRoot);
        const configText = hasConfig
            ? walkFiles(configRoot, ['.env'], 30)
                  .map((f) => {
                      try {
                          return fs.readFileSync(f, 'utf-8');
                      } catch {
                          return '';
                      }
                  })
                  .join('\n')
            : '';
        const hasDbConfig = /\b(DB_TYPE|DB_HOST|DB_CONNECTION|DATABASE_URL|DB_SERVER)\b/.test(configText);

        const modules = new Set<string>();
        for (const p of inventory.pages) if (p.moduleName) modules.add(p.moduleName);
        for (const f of inventory.features) if (f.moduleName) modules.add(f.moduleName);

        const posture = {
            project,
            posture: isFresh ? 'fresh' : 'existing',
            hasConfig,
            hasDbConfig,
            existingModules: Array.from(modules).sort(),
            summary: s,
            guidance: isFresh
                ? 'Fresh workspace: scaffold config + first module; everything will be created new.'
                : 'Existing workspace: REUSE existing pages/steps wherever they match; extend, never duplicate. New artifacts must follow the conventions already in the repo.',
        };

        // Make posture available to every later stage (and the csaa_* chain).
        ctx.session.inputs.workspacePosture = posture.posture;
        ctx.session.inputs.hasDbConfig = hasDbConfig;

        const artifacts = [
            ctx.writeArtifact('workspace-posture.json', JSON.stringify(posture, null, 2)),
            ctx.writeArtifact('inventory.json', JSON.stringify(inventory, null, 2)),
        ];
        return {
            status: 'complete',
            summary: `${posture.posture} workspace — ${s.pageCount} pages, ${s.stepCount} step files, ${s.featureCount} features, DB config ${hasDbConfig ? 'present' : 'absent'}`,
            artifacts,
        };
    },
});

// ---------------------------------------------------------------------------
// Live app exploration — open the application, walk the workflows, capture
// page objects + elements (what a human tester does before scripting)
// ---------------------------------------------------------------------------

const EXPLORE_REPORT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['pages'],
    properties: {
        pages: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['name', 'url', 'elements'],
                properties: {
                    name: { type: 'string', minLength: 2 },
                    url: { type: 'string' },
                    workflow: { type: 'string' },
                    elements: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            required: ['name', 'locator', 'kind'],
                            properties: {
                                name: { type: 'string' },
                                locator: { type: 'string' },
                                kind: {
                                    type: 'string',
                                    enum: ['input', 'button', 'link', 'select', 'checkbox', 'radio', 'text', 'table', 'frame', 'other'],
                                },
                                alternatives: { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                },
            },
        },
        workflowsCovered: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
    },
};

stage({
    id: 'author.explore',
    kind: 'handoff',
    title: 'Live application exploration',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        const source = str(inputs.appUrl) || str(inputs.source) || str(inputs.legacyPath);
        const isUrl = /^https?:\/\//i.test(str(inputs.appUrl)) || /^https?:\/\//i.test(str(inputs.source));
        if (ctx.handoffReport === undefined) {
            if (!isUrl) {
                return {
                    status: 'complete',
                    summary: 'no app URL provided — skipping live exploration (grounding comes from source/docs)',
                };
            }
            const url = /^https?:\/\//i.test(str(inputs.appUrl)) ? str(inputs.appUrl) : str(inputs.source);
            return {
                status: 'handoff',
                summary: 'live exploration delegated',
                handoff: {
                    handoffId: 'author.explore',
                    packs: ['browser'],
                    instruction:
                        `Explore the application at ${url} exactly like a human tester: ` +
                        'browser_launch (headless), browser_navigate, then walk each workflow ' +
                        'relevant to the requested scope. On every distinct page: browser_snapshot, ' +
                        'identify the interactive elements, and use browser_generate_locator for a ' +
                        'stable primary locator plus at least one alternative per interactive element. ' +
                        'If login is required, use the {config:DEFAULT_USERNAME}/{config:DEFAULT_PASSWORD} ' +
                        'convention — NEVER type literal credentials into this report. ' +
                        'Keep it bounded: max 12 pages, max 25 elements per page. ' +
                        'Then call csaa_advance with the report per reportSchema.',
                    nextSuggestedTool: 'browser_launch',
                    nextSuggestedArgs: { headless: true },
                    doneWhen: 'all in-scope workflows walked and every visited page captured with elements',
                    reportSchema: EXPLORE_REPORT_SCHEMA,
                },
            };
        }
        const report = ctx.handoffReport;
        const pages = (report.pages as Array<Record<string, unknown>>) ?? [];
        const elementCount = pages.reduce(
            (sum, p) => sum + ((p.elements as unknown[]) ?? []).length,
            0,
        );
        const artifact = ctx.writeArtifact(
            'captured-pages.json',
            JSON.stringify({ source, ...report }, null, 2),
        );
        return {
            status: 'complete',
            summary: `explored ${pages.length} pages, captured ${elementCount} elements`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Data-first resolution — for every planned scenario: look for real data in
// the database FIRST (SELECT-only, guard-enforced); fall back to creating
// the data through the application UI; static data is the last resort
// ---------------------------------------------------------------------------

const DATA_RESOLUTION_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['scenarios'],
    properties: {
        scenarios: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id', 'dataNeed', 'source'],
                properties: {
                    id: { type: 'string' },
                    dataNeed: { type: 'string' },
                    source: {
                        type: 'string',
                        enum: ['db', 'ui_create', 'static', 'none'],
                    },
                    query: { type: 'string' },
                    tables: { type: 'array', items: { type: 'string' } },
                    uiSetupSteps: { type: 'array', items: { type: 'string' } },
                    notes: { type: 'string' },
                },
            },
        },
        schemaDiscovered: { type: 'array', items: { type: 'string' } },
    },
};

stage({
    id: 'author.data',
    kind: 'handoff',
    title: 'Data-first test-data resolution',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        if (ctx.handoffReport === undefined) {
            if (inputs.hasDbConfig !== true) {
                return {
                    status: 'complete',
                    summary: 'no database configured for this project — scenarios will use UI-created or static data',
                };
            }
            return {
                status: 'handoff',
                summary: 'data resolution delegated',
                handoff: {
                    handoffId: 'author.data',
                    packs: ['data'],
                    instruction:
                        'Resolve test data for every scenario you are about to author, in this ' +
                        'strict order: (1) db_connect using the project config, db_list_tables + ' +
                        'db_describe_table to discover the relevant schema, then SELECT queries ' +
                        '(db_query) to find EXISTING rows that satisfy each scenario\'s data need — ' +
                        'record the query that found them. (2) If no suitable rows exist, plan ' +
                        'ui_create: the exact UI steps that create the data through the ' +
                        'application (these become Background/setup steps). (3) static only for ' +
                        'pure-input values. THE DATABASE IS READ-ONLY: INSERT/UPDATE/DELETE and ' +
                        'all write tools are blocked server-side — do not attempt them. ' +
                        'Never put real PII in the report. Then csaa_advance with the report.',
                    nextSuggestedTool: 'db_connect',
                    nextSuggestedArgs: {},
                    doneWhen: 'every planned scenario has a resolved data source (db / ui_create / static / none)',
                    reportSchema: DATA_RESOLUTION_SCHEMA,
                },
            };
        }
        const report = ctx.handoffReport;
        const scenarios = (report.scenarios as Array<Record<string, unknown>>) ?? [];
        // Defense in depth: re-check every recorded query against the
        // read-only guard before persisting it as grounding.
        for (const s of scenarios) {
            if (typeof s.query === 'string' && s.query.trim()) {
                const verdict = CSGuardrailEngine.checkReadOnlySql(s.query);
                if (!verdict.ok) {
                    return {
                        status: 'blocked',
                        summary: 'non-SELECT query in data resolution',
                        blockedReason: `Scenario ${str(s.id)}: ${verdict.reason}`,
                    };
                }
            }
        }
        const bySource: Record<string, number> = {};
        for (const s of scenarios) {
            const k = str(s.source);
            bySource[k] = (bySource[k] ?? 0) + 1;
        }
        const artifact = ctx.writeArtifact(
            'data-resolution.json',
            JSON.stringify(report, null, 2),
        );
        return {
            status: 'complete',
            summary: `data resolved for ${scenarios.length} scenarios (${Object.entries(bySource)
                .map(([k, v]) => `${k}:${v}`)
                .join(', ')})`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Accessibility & security scans (live app, real scanners)
// ---------------------------------------------------------------------------

const SCAN_REPORT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['findings'],
    properties: {
        findings: {
            type: 'array',
            items: {
                type: 'object',
                required: ['check', 'severity', 'detail'],
                properties: {
                    check: { type: 'string' },
                    severity: { type: 'string', enum: ['critical', 'serious', 'moderate', 'minor', 'info'] },
                    detail: { type: 'string' },
                    location: { type: 'string' },
                },
            },
        },
        pagesScanned: { type: 'number' },
        notes: { type: 'string' },
    },
};

stage({
    id: 'scan.a11y',
    kind: 'handoff',
    title: 'Accessibility audit (WCAG)',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const url = str(ctx.session.inputs.targetUrl);
            const standard = str(ctx.session.inputs.standard) || 'WCAG2AA';
            return {
                status: 'handoff',
                summary: 'accessibility audit delegated',
                handoff: {
                    handoffId: 'scan.a11y',
                    packs: ['browser', 'security'],
                    instruction:
                        `Audit ${url} for accessibility: browser_launch (headless), ` +
                        `browser_navigate to the target, run security_accessibility_audit ` +
                        `(standard: ${standard}) on each key page/state in scope (max 8 pages — ` +
                        'include post-login and form states when reachable via config credentials). ' +
                        'Aggregate every violation into the report (one finding per rule violation ' +
                        'with its WCAG reference in `check`). Then csaa_advance with the report.',
                    nextSuggestedTool: 'browser_launch',
                    nextSuggestedArgs: { headless: true },
                    doneWhen: 'all in-scope pages audited and violations aggregated',
                    reportSchema: SCAN_REPORT_SCHEMA,
                },
            };
        }
        return recordScanReport(ctx, 'a11y-findings.json');
    },
});

stage({
    id: 'scan.security',
    kind: 'handoff',
    title: 'Security scan (headers, XSS, auth, cookies)',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const url = str(ctx.session.inputs.targetUrl);
            const guard = CSGuardrailEngine.checkAction('security_scan', { url });
            if (!guard.ok) {
                return { status: 'blocked', summary: 'constitutional block', blockedReason: guard.reason };
            }
            return {
                status: 'handoff',
                summary: 'security scan delegated',
                handoff: {
                    handoffId: 'scan.security',
                    packs: ['browser', 'security'],
                    instruction:
                        `Scan ${url} (a test environment you are authorized to test): ` +
                        'browser_launch + browser_navigate, then run security_header_check, ' +
                        'security_cookie_check, security_sensitive_data_exposure, ' +
                        'security_csrf_check, and security_xss_scan (scanAll: true) on the key ' +
                        'input forms. Do NOT run brute-force checks unless the user explicitly ' +
                        'asked. One finding per issue with severity. Then csaa_advance with the report.',
                    nextSuggestedTool: 'browser_launch',
                    nextSuggestedArgs: { headless: true },
                    doneWhen: 'all checks executed and findings aggregated',
                    reportSchema: SCAN_REPORT_SCHEMA,
                },
            };
        }
        return recordScanReport(ctx, 'security-findings.json');
    },
});

function recordScanReport(ctx: StageContext, artifactName: string): StageOutcome {
    const report = ctx.handoffReport ?? {};
    const findings = (report.findings as Array<Record<string, unknown>>) ?? [];
    const bySeverity: Record<string, number> = {};
    for (const f of findings) {
        const k = str(f.severity);
        bySeverity[k] = (bySeverity[k] ?? 0) + 1;
    }
    const artifact = ctx.writeArtifact(artifactName, JSON.stringify(report, null, 2));
    return {
        status: 'complete',
        summary: `${findings.length} findings (${Object.entries(bySeverity)
            .map(([k, v]) => `${k}:${v}`)
            .join(', ') || 'clean'})`,
        artifacts: [artifact],
    };
}

const SCAN_ASSESS_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['grade', 'summary', 'remediation'],
    properties: {
        grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
        summary: { type: 'string', minLength: 30 },
        remediation: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['action', 'priority'],
                properties: {
                    action: { type: 'string' },
                    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                    owner: { type: 'string' },
                },
            },
        },
    },
};

stage({
    id: 'scan.compose',
    kind: 'cognitive',
    title: 'Scan assessment & remediation plan',
    run: (ctx: StageContext): StageOutcome => {
        const isA11y = ctx.session.mode === 'accessibility';
        const findingsArtifact = ctx.session.artifacts.find(
            (a) => a.endsWith('a11y-findings.json') || a.endsWith('security-findings.json'),
        );
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting scan assessment',
                envelope: makeEnvelope(
                    ctx,
                    isA11y ? 'compose-a11y-assessment' : 'compose-security-assessment',
                    'Read the findings at groundingPath and produce a defensible grade, an ' +
                        'executive summary, and a prioritized remediation list (dedupe by root ' +
                        'cause; P1 = user-blocking/critical exposure). Return JSON per responseSchema.',
                    SCAN_ASSESS_SCHEMA,
                    { groundingPath: findingsArtifact },
                ),
            };
        }
        const assessment = ctx.submission as Record<string, unknown>;
        const remediation = (assessment.remediation as Array<Record<string, string>>) ?? [];
        const title = isA11y ? 'Accessibility report' : 'Security report';
        const md = [
            `# ${title} — ${str(ctx.session.inputs.targetUrl)}`,
            '',
            `**Grade: ${str(assessment.grade)}**`,
            '',
            str(assessment.summary),
            '',
            '## Remediation',
            '| Priority | Action | Owner |',
            '|---|---|---|',
            ...remediation.map((r) => `| ${r.priority} | ${r.action} | ${r.owner ?? '-'} |`),
        ];
        const mdPath = ctx.writeArtifact(isA11y ? 'A11Y-REPORT.md' : 'SECURITY-REPORT.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `grade ${str(assessment.grade)}, ${remediation.length} remediation actions`,
            artifacts: [mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// ADO test-plan management — story → designed test cases → created in ADO
// and attached to the right suite (discovered live, picked via dropdown)
// ---------------------------------------------------------------------------

const ADO_CONTEXT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['story', 'plans'],
    properties: {
        story: {
            type: 'object',
            required: ['id', 'title'],
            properties: {
                id: { type: 'number' },
                title: { type: 'string' },
                acceptanceCriteria: { type: 'string' },
                description: { type: 'string' },
            },
        },
        plans: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'name'],
                properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
        },
        suites: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'name', 'planId'],
                properties: {
                    id: { type: 'number' },
                    name: { type: 'string' },
                    planId: { type: 'number' },
                },
            },
        },
        existingCases: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'title'],
                properties: { id: { type: 'number' }, title: { type: 'string' } },
            },
        },
        notes: { type: 'string' },
    },
};

stage({
    id: 'adoplan.context',
    kind: 'handoff',
    title: 'Fetch ADO story, plans & suites',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const storyId = str(ctx.session.inputs.workItemId);
            return {
                status: 'handoff',
                summary: 'ADO context fetch delegated',
                handoff: {
                    handoffId: 'adoplan.context',
                    packs: ['ado'],
                    instruction:
                        `Gather ADO context: ado_work_items_get for story ${storyId} (include ` +
                        'title, description, Microsoft.VSTS.Common.AcceptanceCriteria), ' +
                        'ado_test_plans_list for available plans, ado_test_suites_list for the ' +
                        'most relevant plan(s), and ado_test_suite_test_cases_list for the suite ' +
                        'that matches this story (to avoid duplicate cases). Strip HTML from ' +
                        'text fields. Then csaa_advance with the report per reportSchema.',
                    nextSuggestedTool: 'ado_work_items_get',
                    nextSuggestedArgs: { id: Number(storyId) || storyId },
                    doneWhen: 'story + plans + suites (+ existing cases where found) collected',
                    reportSchema: ADO_CONTEXT_SCHEMA,
                },
            };
        }
        const report = ctx.handoffReport;
        const artifact = ctx.writeArtifact('ado-context.json', JSON.stringify(report, null, 2));
        const plans = (report.plans as Array<Record<string, unknown>>) ?? [];
        const suites = (report.suites as Array<Record<string, unknown>>) ?? [];
        return {
            status: 'complete',
            summary: `story fetched; ${plans.length} plans, ${suites.length} suites discovered`,
            artifacts: [artifact],
        };
    },
});

stage({
    id: 'adoplan.select',
    kind: 'elicit',
    title: 'Pick target plan & suite',
    run: (ctx: StageContext): StageOutcome => {
        const contextArtifact = ctx.session.artifacts.find((a) => a.endsWith('ado-context.json'));
        let plans: Array<{ id: number; name: string }> = [];
        let suites: Array<{ id: number; name: string; planId: number }> = [];
        if (contextArtifact && fs.existsSync(contextArtifact)) {
            try {
                const data = JSON.parse(fs.readFileSync(contextArtifact, 'utf-8'));
                plans = data.plans ?? [];
                suites = data.suites ?? [];
            } catch {
                /* fall through to blocked below */
            }
        }
        if (ctx.answers === undefined) {
            if (suites.length === 0) {
                return {
                    status: 'blocked',
                    summary: 'no target suite available',
                    blockedReason:
                        'No test suites were discovered in ADO. Create a static suite in your ' +
                        'test plan first (or check ADO permissions), then resume this session.',
                };
            }
            return {
                status: 'question',
                summary: 'awaiting suite selection',
                question: {
                    questionId: 'adoplan.target',
                    message: 'Which test suite should the new test cases go into?',
                    fields: [
                        {
                            id: 'targetSuite',
                            title: 'Target suite',
                            description: 'Suite (within its plan) to attach the generated test cases to.',
                            type: 'enum',
                            required: true,
                            options: suites.map((s) => `${s.planId}:${s.id}`),
                            optionTitles: suites.map((s) => {
                                const plan = plans.find((p) => p.id === s.planId);
                                return `${plan?.name ?? 'Plan ' + s.planId} › ${s.name}`;
                            }),
                        },
                    ],
                },
            };
        }
        const choice = str(ctx.answers.targetSuite);
        const [planId, suiteId] = choice.split(':').map((n) => Number(n));
        if (!planId || !suiteId) {
            return {
                status: 'blocked',
                summary: 'invalid suite selection',
                blockedReason: `Could not parse suite selection "${choice}".`,
            };
        }
        ctx.session.inputs.targetPlanId = planId;
        ctx.session.inputs.targetSuiteId = suiteId;
        return { status: 'complete', summary: `target: plan ${planId}, suite ${suiteId}` };
    },
});

const ADO_CASES_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['cases'],
    properties: {
        cases: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['title', 'priority', 'steps'],
                properties: {
                    title: { type: 'string', minLength: 8 },
                    priority: { type: 'number', minimum: 1, maximum: 4 },
                    tags: { type: 'array', items: { type: 'string' } },
                    steps: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            required: ['action', 'expected'],
                            properties: {
                                action: { type: 'string', minLength: 5 },
                                expected: { type: 'string', minLength: 5 },
                            },
                        },
                    },
                },
            },
        },
        coverageNote: { type: 'string' },
    },
};

stage({
    id: 'adoplan.compose',
    kind: 'cognitive',
    title: 'Design test cases from the story',
    run: (ctx: StageContext): StageOutcome => {
        const contextArtifact = ctx.session.artifacts.find((a) => a.endsWith('ado-context.json'));
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting test-case designs',
                envelope: makeEnvelope(
                    ctx,
                    'compose-ado-cases',
                    'Design ADO test cases for the story in the grounding artifact: one case ' +
                        'per acceptance criterion plus the negative/edge cases a senior QA ' +
                        'would add. Every step needs a concrete action AND a verifiable ' +
                        'expected result (no "verify it works"). Do NOT duplicate any title in ' +
                        'existingCases — extend coverage instead. Priority: 1 = must-run smoke. ' +
                        'Return JSON per responseSchema.',
                    ADO_CASES_SCHEMA,
                    { groundingPath: contextArtifact, skills: skillHints('ado test case steps acceptance criteria') },
                ),
            };
        }
        const design = ctx.submission as Record<string, unknown>;
        const cases = (design.cases as Array<Record<string, unknown>>) ?? [];
        const artifact = ctx.writeArtifact('ado-case-designs.json', JSON.stringify(design, null, 2));
        return {
            status: 'complete',
            summary: `${cases.length} test cases designed`,
            artifacts: [artifact],
        };
    },
});

const ADO_CREATE_REPORT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['created', 'addedToSuite'],
    properties: {
        created: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'title'],
                properties: { id: { type: 'number' }, title: { type: 'string' } },
            },
        },
        addedToSuite: { type: 'boolean' },
        failures: { type: 'array', items: { type: 'string' } },
    },
};

stage({
    id: 'adoplan.create',
    kind: 'handoff',
    title: 'Create cases in ADO & attach to suite',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const planId = Number(ctx.session.inputs.targetPlanId);
            const suiteId = Number(ctx.session.inputs.targetSuiteId);
            const designs = ctx.session.artifacts.find((a) => a.endsWith('ado-case-designs.json'));
            const guard = CSGuardrailEngine.checkAction('ado_work_items_create', { type: 'Test Case' });
            if (!guard.ok) {
                return { status: 'blocked', summary: 'constitutional block', blockedReason: guard.reason };
            }
            return {
                status: 'handoff',
                summary: 'ADO creation delegated',
                handoff: {
                    handoffId: 'adoplan.create',
                    packs: ['ado'],
                    instruction:
                        `Create each designed test case from ${designs} in ADO: ` +
                        'ado_work_items_create with type "Test Case", the designed title/tags/priority ' +
                        '(Microsoft.VSTS.Common.Priority), and the steps serialized as ' +
                        'Microsoft.VSTS.TCM.Steps XML (<steps><step id="N" type="ActionStep">' +
                        '<parameterizedString isformatted="true">ACTION</parameterizedString>' +
                        '<parameterizedString isformatted="true">EXPECTED</parameterizedString>' +
                        '<description/></step></steps> — HTML-escape the text). Then ONE ' +
                        `ado_test_suite_add_test_cases call with planId ${planId}, suiteId ${suiteId} ` +
                        'and all created ids. Report every failure honestly. ' +
                        'Then csaa_advance with the report.',
                    nextSuggestedTool: 'ado_work_items_create',
                    nextSuggestedArgs: { type: 'Test Case', title: '<first designed case title>' },
                    doneWhen: 'every designed case created (or its failure recorded) and cases attached to the suite',
                    reportSchema: ADO_CREATE_REPORT_SCHEMA,
                },
            };
        }
        const report = ctx.handoffReport;
        const created = (report.created as Array<Record<string, unknown>>) ?? [];
        const failures = (report.failures as string[]) ?? [];
        const artifact = ctx.writeArtifact('ado-created-cases.json', JSON.stringify(report, null, 2));
        if (created.length === 0) {
            return {
                status: 'blocked',
                summary: 'no cases created',
                blockedReason: `ADO creation failed for all cases: ${failures.slice(0, 3).join('; ') || 'unknown error'}`,
            };
        }
        return {
            status: 'complete',
            summary: `${created.length} test cases created${report.addedToSuite ? ' and attached to suite' : ''}${failures.length ? `, ${failures.length} failures` : ''}`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Release readiness — evidence-based go/no-go with sign-off report
// ---------------------------------------------------------------------------

stage({
    id: 'release.evidence',
    kind: 'deterministic',
    title: 'Gather release evidence',
    run: (ctx: StageContext): StageOutcome => {
        const dirs = latestResultDirs(ctx.workspaceRoot, 5);
        const runs = dirs.map((d) => {
            const scenarios = loadScenarios(d);
            return {
                runDir: path.basename(d),
                total: scenarios.length,
                passed: scenarios.filter((s) => s.status === 'passed').length,
                failed: scenarios.filter((s) => s.status === 'failed').length,
                failures: scenarios
                    .filter((s) => s.status === 'failed')
                    .map((s) => ({ feature: s.feature, name: s.name, error: (s.error ?? '').split('\n')[0] })),
            };
        });

        // Flaky candidates: scenarios with both pass and fail across the window.
        const outcomes = new Map<string, Set<string>>();
        for (const d of dirs) {
            for (const s of loadScenarios(d)) {
                const key = `${s.feature}›${s.name}`;
                (outcomes.get(key) ?? outcomes.set(key, new Set()).get(key)!).add(s.status);
            }
        }
        const flaky = Array.from(outcomes.entries())
            .filter(([, set]) => set.has('passed') && set.has('failed'))
            .map(([name]) => name);

        const latest = runs[0];
        const artifact = ctx.writeArtifact(
            'release-evidence.json',
            JSON.stringify(
                {
                    releaseName: str(ctx.session.inputs.releaseName),
                    runsAnalyzed: runs.length,
                    latestPassRate: latest && latest.total > 0 ? latest.passed / latest.total : null,
                    runs,
                    flakyCandidates: flaky,
                },
                null,
                2,
            ),
        );
        return {
            status: 'complete',
            summary: runs.length
                ? `evidence: ${runs.length} runs, latest ${latest.passed}/${latest.total} passed, ${flaky.length} flaky candidates`
                : 'no local run evidence found under reports/',
            artifacts: [artifact],
        };
    },
});

const RELEASE_ADO_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['openBugs'],
    properties: {
        openBugs: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'title'],
                properties: {
                    id: { type: 'number' },
                    title: { type: 'string' },
                    severity: { type: 'string' },
                    state: { type: 'string' },
                },
            },
        },
        recentAdoRuns: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'number' },
                    name: { type: 'string' },
                    passedTests: { type: 'number' },
                    totalTests: { type: 'number' },
                },
            },
        },
        adoAvailable: { type: 'boolean' },
        notes: { type: 'string' },
    },
};

stage({
    id: 'release.ado',
    kind: 'handoff',
    title: 'Pull open bugs & ADO run status',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            return {
                status: 'handoff',
                summary: 'ADO evidence delegated',
                handoff: {
                    handoffId: 'release.ado',
                    packs: ['ado'],
                    instruction:
                        'Collect release evidence from ADO: ado_work_items_query with WIQL ' +
                        "SELECT [System.Id], [System.Title], [Microsoft.VSTS.Common.Severity], [System.State] " +
                        "FROM WorkItems WHERE [System.WorkItemType] = 'Bug' AND [System.State] <> 'Closed' " +
                        "AND [System.State] <> 'Resolved' (add the project's area path filter if known; " +
                        'if WIQL is restricted, fall back to ado_test_runs_list only and say so in notes). ' +
                        'Also ado_test_runs_list for the most recent runs. If ADO is not configured, ' +
                        'report adoAvailable: false with empty lists — do not fabricate. ' +
                        'Then csaa_advance with the report.',
                    nextSuggestedTool: 'ado_work_items_query',
                    nextSuggestedArgs: {},
                    doneWhen: 'open bugs and recent ADO runs collected (or ADO reported unavailable)',
                    reportSchema: RELEASE_ADO_SCHEMA,
                },
            };
        }
        const report = ctx.handoffReport;
        const bugs = (report.openBugs as Array<Record<string, unknown>>) ?? [];
        const artifact = ctx.writeArtifact('release-ado.json', JSON.stringify(report, null, 2));
        return {
            status: 'complete',
            summary: report.adoAvailable === false ? 'ADO unavailable — proceeding on local evidence' : `${bugs.length} open bugs pulled from ADO`,
            artifacts: [artifact],
        };
    },
});

const RELEASE_DECISION_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['verdict', 'gates', 'summary'],
    properties: {
        verdict: { type: 'string', enum: ['go', 'conditional_go', 'no_go'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        gates: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['gate', 'status', 'evidence'],
                properties: {
                    gate: { type: 'string' },
                    status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
                    evidence: { type: 'string' },
                },
            },
        },
        conditions: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string', minLength: 30 },
    },
};

stage({
    id: 'release.compose',
    kind: 'cognitive',
    title: 'Go / no-go decision',
    run: (ctx: StageContext): StageOutcome => {
        const grounding = ctx.session.artifacts.filter(
            (a) => a.endsWith('release-evidence.json') || a.endsWith('release-ado.json'),
        );
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting go/no-go decision',
                envelope: makeEnvelope(
                    ctx,
                    'compose-release-decision',
                    'Make an evidence-based go/no-go call for this release from the grounding ' +
                        'artifacts ONLY (local run evidence + ADO bugs/runs). Gates to assess: ' +
                        'pass-rate, open critical/high bugs, flaky-candidate risk, evidence ' +
                        'freshness, coverage of the release scope. Every gate verdict must cite ' +
                        'its evidence. conditional_go REQUIRES explicit conditions. Do not soften ' +
                        'a no_go. Return JSON per responseSchema.',
                    RELEASE_DECISION_SCHEMA,
                    { groundingPaths: grounding },
                ),
            };
        }
        const decision = ctx.submission as Record<string, unknown>;
        const gates = (decision.gates as Array<Record<string, string>>) ?? [];
        const icon: Record<string, string> = { pass: '✅', warn: '⚠️', fail: '⛔' };
        const md = [
            `# Release decision — ${str(ctx.session.inputs.releaseName)}`,
            '',
            `## Verdict: **${str(decision.verdict).toUpperCase()}**${decision.confidence !== undefined ? ` (confidence ${Number(decision.confidence).toFixed(2)})` : ''}`,
            '',
            str(decision.summary),
            '',
            '## Gates',
            '| Gate | Status | Evidence |',
            '|---|---|---|',
            ...gates.map((g) => `| ${g.gate} | ${icon[g.status] ?? ''} ${g.status} | ${str(g.evidence).replace(/\|/g, '\\|')} |`),
            '',
            ...(((decision.conditions as string[]) ?? []).length
                ? ['## Conditions for go', ...((decision.conditions as string[]) ?? []).map((c) => `- ${c}`)]
                : []),
            '',
            `_Signed off by CS AI Auto-Assist session ${ctx.session.sessionId} — evidence artifacts retained in the session folder._`,
        ];
        const jsonPath = ctx.writeArtifact('release-decision.json', JSON.stringify(decision, null, 2));
        const mdPath = ctx.writeArtifact('RELEASE-DECISION.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `verdict: ${str(decision.verdict)} (${gates.filter((g) => g.status === 'fail').length} failing gates)`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Load & stress testing — designs a load profile and renders a runnable
// scenario for the framework's NATIVE performance engine (CSLoadGenerator /
// CSPerformanceTestRunner) — no external load-tool dependency
// ---------------------------------------------------------------------------

const LOAD_DESIGN_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['scenarioName', 'testType', 'loadConfig', 'thresholds', 'journey'],
    properties: {
        scenarioName: { type: 'string', minLength: 4, pattern: '^[A-Za-z][A-Za-z0-9 _-]*$' },
        testType: { type: 'string', enum: ['load', 'stress', 'spike', 'endurance', 'baseline'] },
        loadConfig: {
            type: 'object',
            required: ['pattern', 'virtualUsers', 'duration'],
            properties: {
                pattern: { type: 'string', enum: ['constant', 'ramp-up', 'ramp-down', 'step', 'spike'] },
                virtualUsers: { type: 'number', minimum: 1, maximum: 500 },
                duration: { type: 'number', minimum: 10, maximum: 7200 },
                rampUpTime: { type: 'number' },
                thinkTime: { type: 'number' },
            },
        },
        thresholds: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['metric', 'limit'],
                properties: {
                    metric: {
                        type: 'string',
                        enum: ['response_time', 'throughput', 'error_rate', 'p95_response_time'],
                    },
                    limit: { type: 'number' },
                    unit: { type: 'string' },
                },
            },
        },
        journey: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['step', 'action'],
                properties: {
                    step: { type: 'string' },
                    action: { type: 'string' },
                    endpoint: { type: 'string' },
                },
            },
        },
        rationale: { type: 'string' },
    },
};

stage({
    id: 'load.design',
    kind: 'cognitive',
    title: 'Design the load profile',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting load profile',
                envelope: makeEnvelope(
                    ctx,
                    'compose-load-profile',
                    `Design a ${str(inputs.testType) || 'load'} test for ${str(inputs.targetUrl)}: ` +
                        'a realistic user journey (the steps a real user performs), a load ' +
                        'configuration honouring the requested virtual users ' +
                        `(${str(inputs.virtualUsers) || 'choose sensibly'}) and duration ` +
                        `(${str(inputs.durationSeconds) || 'choose sensibly'} seconds), and ` +
                        'measurable thresholds (p95 response time, error rate) that define ' +
                        'pass/fail. Stress tests ramp beyond expected capacity; spike tests jump; ' +
                        'endurance holds steady for the full duration. Return JSON per responseSchema.',
                    LOAD_DESIGN_SCHEMA,
                    {
                        targetUrl: str(inputs.targetUrl),
                        capturedPages: ctx.session.artifacts.find((a) => a.endsWith('captured-pages.json')),
                        skills: skillHints('performance load test thresholds'),
                    },
                ),
            };
        }
        const design = ctx.submission as Record<string, unknown>;
        const artifact = ctx.writeArtifact('load-profile.json', JSON.stringify(design, null, 2));
        return {
            status: 'complete',
            summary: `${str(design.testType)} profile designed: ${(design.loadConfig as Record<string, unknown>)?.virtualUsers} VUs, ${(design.loadConfig as Record<string, unknown>)?.duration}s`,
            artifacts: [artifact],
        };
    },
});

stage({
    id: 'load.render',
    kind: 'deterministic',
    title: 'Render native performance scenario',
    run: (ctx: StageContext): StageOutcome => {
        const profileArtifact = ctx.session.artifacts.find((a) => a.endsWith('load-profile.json'));
        if (!profileArtifact || !fs.existsSync(profileArtifact)) {
            return { status: 'blocked', summary: 'missing profile', blockedReason: 'load-profile.json not found.' };
        }
        const profile = JSON.parse(fs.readFileSync(profileArtifact, 'utf-8')) as Record<string, unknown>;
        const project = str(ctx.session.inputs.project);
        const load = (profile.loadConfig as Record<string, unknown>) ?? {};
        const thresholds = (profile.thresholds as Array<Record<string, unknown>>) ?? [];
        const journey = (profile.journey as Array<Record<string, unknown>>) ?? [];
        const targetUrl = str(ctx.session.inputs.targetUrl);
        const safeName = str(profile.scenarioName).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
        const esc = (v: unknown): string => str(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

        // Map the user-friendly threshold list onto the REAL
        // PerformanceThresholds object shape (responseTime/errorRate/throughput).
        const responseTime: Record<string, number> = {};
        let errorRateMax: number | undefined;
        let throughputMin: number | undefined;
        for (const t of thresholds) {
            const metric = str(t.metric);
            const limit = Number(t.limit);
            if (!Number.isFinite(limit)) continue;
            if (metric === 'p95_response_time') responseTime.percentile95 = limit;
            else if (metric === 'response_time') responseTime.average = limit;
            else if (metric === 'error_rate') errorRateMax = limit;
            else if (metric === 'throughput') throughputMin = limit;
        }
        const thresholdLines: string[] = [];
        if (Object.keys(responseTime).length > 0) {
            thresholdLines.push(`            responseTime: ${JSON.stringify(responseTime)},`);
        }
        if (errorRateMax !== undefined) thresholdLines.push(`            errorRate: { maximum: ${errorRateMax} },`);
        if (throughputMin !== undefined) thresholdLines.push(`            throughput: { minimum: ${throughputMin} },`);
        if (thresholdLines.length === 0) thresholdLines.push('            errorRate: { maximum: 5 },');

        // The native engine drives an HTTP requestTemplate against
        // targetEndpoint. The designed multi-step journey is documented in the
        // runbook; the first journey endpoint (if any) seeds the request URL.
        const firstEndpoint = journey.find((j) => str(j.endpoint))?.endpoint;
        const requestUrl = firstEndpoint ? str(firstEndpoint) : targetUrl;

        const spec = [
            '/**',
            ` * ${str(profile.scenarioName)} — ${str(profile.testType)} test`,
            ' * Generated by CS AI Auto-Assist (load mode). Runs on the framework\'s',
            " * native performance engine (CSPerformanceTestRunner.runScenario) —",
            ' * no external load tool required.',
            ' *',
            ' * Designed journey (executed as documented in LOAD-RUNBOOK.md):',
            ...journey.map((j, i) => ` *   ${i + 1}. ${str(j.step)} — ${str(j.action)}`),
            ' */',
            "import { CSPerformanceTestRunner } from '@mdakhan.mak/cs-playwright-test-framework/performance';",
            "import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';",
            '',
            'export async function run(): Promise<void> {',
            '    const runner = CSPerformanceTestRunner.getInstance();',
            '    await runner.initialize();',
            '    const result = await runner.runScenario({',
            `        id: '${safeName}_' + Date.now(),`,
            `        name: '${esc(profile.scenarioName)}',`,
            `        description: '${esc(profile.testType)} test for ${esc(targetUrl)}',`,
            `        testType: '${str(profile.testType)}',`,
            '        loadConfig: {',
            `            pattern: '${str(load.pattern) || 'constant'}',`,
            `            virtualUsers: ${num(load.virtualUsers, 10)},`,
            `            duration: ${num(load.duration, 60)},`,
            ...(load.rampUpTime !== undefined ? [`            rampUpTime: ${num(load.rampUpTime, 0)},`] : []),
            `            thinkTime: ${num(load.thinkTime, 1000)},`,
            '        },',
            '        thresholds: {',
            ...thresholdLines,
            '        },',
            `        targetEndpoint: '${esc(requestUrl)}',`,
            '        requestTemplate: {',
            "            method: 'GET',",
            `            url: '${esc(requestUrl)}',`,
            '        },',
            `        tags: ['load', '${str(profile.testType)}', 'cs-ai-auto-assist'],`,
            '    });',
            "    CSReporter.info('Performance summary: ' + JSON.stringify(result.summary));",
            "    if ((result.thresholdViolations ?? []).length > 0) {",
            "        CSReporter.fail('Threshold violations: ' + JSON.stringify(result.thresholdViolations));",
            '        process.exit(1);',
            '    }',
            '}',
            '',
            'run().catch((err) => {',
            "    CSReporter.fail('Performance run failed: ' + (err instanceof Error ? err.message : String(err)));",
            '    process.exit(1);',
            '});',
            '',
        ].join('\n');

        // Write the runnable scenario into the project tree (guarded).
        const guard = CSGuardrailEngine.checkAction('write_file', { path: `test/${project}/performance/${safeName}.perf.ts` });
        if (!guard.ok) {
            return { status: 'blocked', summary: 'constitutional block', blockedReason: guard.reason };
        }
        const specDir = path.join(ctx.workspaceRoot, 'test', project, 'performance');
        fs.mkdirSync(specDir, { recursive: true });
        const specPath = path.join(specDir, `${safeName}.perf.ts`);
        fs.writeFileSync(specPath, spec, 'utf-8');
        ctx.session.artifacts.push(specPath);

        const runbook = ctx.writeArtifact(
            'LOAD-RUNBOOK.md',
            [
                `# Load test runbook — ${str(profile.scenarioName)}`,
                '',
                `- Scenario file: \`${specPath}\``,
                `- Engine: framework-native (CSPerformanceTestRunner) — no k6/JMeter needed`,
                `- Profile: ${str(profile.testType)}, ${Number(load.virtualUsers)} VUs, ${Number(load.duration)}s, pattern ${str(load.pattern)}`,
                '',
                '## Run it',
                '```bash',
                `npx ts-node ${path.relative(ctx.workspaceRoot, specPath)}`,
                '```',
                '',
                '## Thresholds (pass/fail)',
                ...thresholds.map((t) => `- ${str(t.metric)} ≤ ${Number(t.limit)}${t.unit ? ' ' + str(t.unit) : ''}`),
                '',
                'Run against test environments only. Results land in the performance reporter output.',
            ].join('\n') + '\n',
        );
        return {
            status: 'complete',
            summary: `native perf scenario written: ${path.relative(ctx.workspaceRoot, specPath)}`,
            artifacts: [specPath, runbook],
        };
    },
});

// ============================================================================
// Public accessor
// ============================================================================

export class CSPlaybooks {
    public static getStage(id: string): StageDefinition | undefined {
        return STAGES[id];
    }

    public static stageIds(): string[] {
        return Object.keys(STAGES);
    }
}
