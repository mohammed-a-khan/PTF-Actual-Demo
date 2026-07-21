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
import { CSCorrectionMemory } from './CSCorrectionMemory';

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
        const EXECUTING_STAGES = ['run.execute', 'author.pipeline', 'heal.loop', 'primpact.run', 'defect.resolve'];
        const executed = session.stageLog.some(
            (s) => EXECUTING_STAGES.includes(s.stageId) && s.status === 'complete',
        );
        // Grounded = the session actually captured/fetched real source
        // material (live exploration, a fetched requirement/PR/defect) —
        // derived from artifacts, not asserted.
        const GROUNDING_ARTIFACTS = [
            'captured-pages.json', 'planning-source.json', 'pr-changes.json',
            'defect.json', 'ado-context.json', 'ado-suite-cases.json',
            'derived-workflows.json', 'discovery.json', 'audit-findings.json',
            'diff-audit.json', 'failure-clusters.json', 'audit-full.json',
        ];
        const sourceGrounded = session.artifacts.some((a) =>
            GROUNDING_ARTIFACTS.some((g) => a.endsWith(g)),
        );
        const trust = CSGuardrailEngine.computeTrust(session, {
            sourceGrounded,
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
        // A missing/unreadable document BLOCKS — silently degrading to
        // "description" would plan against a filename instead of requirements.
        if (source === 'document') {
            if (!value || !fs.existsSync(value)) {
                return {
                    status: 'blocked',
                    summary: 'requirement document not found',
                    blockedReason: `Requirement document not found at "${value}". Check the path and start again (or use source "description").`,
                };
            }
            let text = '';
            try {
                text = fs.readFileSync(value, 'utf-8').slice(0, 40_000);
            } catch (e) {
                return {
                    status: 'blocked',
                    summary: 'requirement document unreadable',
                    blockedReason: `Could not read "${value}": ${e instanceof Error ? e.message : String(e)}`,
                };
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
    required: ['finalState', 'filesWritten', 'compileClean', 'auditClean'],
    properties: {
        finalState: { type: 'string', enum: ['READY', 'PASS_PARTIAL', 'FAILED', 'BLOCKED_NEED_HUMAN'] },
        filesWritten: { type: 'number', minimum: 0 },
        // Hard gates — the generated files MUST compile (tsc/compile_check =
        // zero errors) and pass audit_file before the pipeline is accepted.
        compileClean: { type: 'boolean' },
        auditClean: { type: 'boolean' },
        featureFiles: { type: 'array', items: { type: 'string' } },
        scenariosTotal: { type: 'number' },
        scenariosPassed: { type: 'number' },
        trustScore: { type: 'number' },
        finalReportPath: { type: 'string' },
        blockedReason: { type: 'string' },
        remainingErrors: { type: 'array', items: { type: 'string' } },
    },
};

stage({
    id: 'author.pipeline',
    kind: 'handoff',
    title: 'csaa_* authoring pipeline',
    run: (ctx: StageContext): StageOutcome => {
        // Modes that skip author.intake (ado_automate, source) reach here with
        // no linked run — create it lazily so csaa_discover never receives an
        // empty runId (which it hard-rejects).
        if (!ctx.session.linkedRunId) {
            const lazyId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            CSRunContext.getOrCreate(lazyId, {
                workspaceRoot: ctx.workspaceRoot,
                inputSummary: `${ctx.session.mode}: ${str(ctx.session.inputs.planId) || str(ctx.session.inputs.sourcePath) || 'session ' + ctx.session.sessionId}`,
            });
            ctx.session.linkedRunId = lazyId;
        }
        const runId = ctx.session.linkedRunId ?? '';
        if (ctx.handoffReport === undefined) {
            const inputs = ctx.session.inputs;
            const source = str(inputs.legacyPath) || str(inputs.source);
            const isPath = fs.existsSync(source);
            const grounding: string[] = ctx.session.artifacts.filter(
                (a) =>
                    a.endsWith('workspace-posture.json') ||
                    a.endsWith('captured-pages.json') ||
                    a.endsWith('data-resolution.json') ||
                    a.endsWith('scenario-plan.json') ||
                    a.endsWith('ado-suite-cases.json') ||
                    a.endsWith('derived-workflows.json'),
            );
            const groundingNote = grounding.length
                ? ` GROUNDING ARTIFACTS (read and honour them when fulfilling analyze/translate ` +
                  `envelopes): ${grounding.join(', ')} — captured-pages.json locators are the ` +
                  'source of truth for page objects; data-resolution.json decides each ' +
                  'scenario\'s data strategy (db → cite the SELECT; ui_create → emit the setup ' +
                  'steps); workspace-posture.json tells you what to reuse instead of recreate; ' +
                  'ado-suite-cases.json (when present) lists the EXACT test cases to automate — ' +
                  'no more, no fewer; derived-workflows.json (when present) is the authoritative ' +
                  'workflow list derived from the application source; scenario-plan.json (when ' +
                  'present) is the approved plan — generate exactly its scenarios, reusing existing ' +
                  'tests where reuseExisting=true, and cover every coverageGap.'
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
                        'via the envelope\'s recordWith tool. ' +
                        'REUSE, DO NOT DUPLICATE: scenario-plan.json marks each scenario\'s ' +
                        'targetFeatureFile / reuseExisting — when set, EXTEND that existing .feature ' +
                        'and reuse its existing page objects and step definitions; create a NEW ' +
                        'feature file ONLY for genuinely new areas. Do not create a parallel feature ' +
                        'that duplicates one already in the repo. ' +
                        'MANDATORY QUALITY GATES before you finish: run csaa_compile_check (or ' +
                        'compile_check) and FIX every error until it is clean; run csaa_audit / ' +
                        'audit_file on every generated file and FIX until zero error-severity ' +
                        'violations. Do NOT report finalState READY unless compileClean=true AND ' +
                        'auditClean=true. If you cannot make it clean, report the remaining errors ' +
                        'in remainingErrors and finalState FAILED (do not hide them). ' +
                        'Then call csaa_advance with the report (include featureFiles, compileClean, ' +
                        'auditClean).' +
                        groundingNote,
                    nextSuggestedTool: 'csaa_discover',
                    nextSuggestedArgs: isPath
                        ? { runId, rootPath: source }
                        : { runId, rootPath: ctx.workspaceRoot },
                    doneWhen:
                        'files generated AND compile_check is clean AND audit is clean (or the ' +
                        'unfixable errors are reported); or a primitive returned BLOCKED_NEED_HUMAN',
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
        // Compile/audit gate: generated code that does not compile or fails the
        // rule audit must be FIXED before the mode moves on — send it back
        // (bounded) instead of accepting broken files (the exact "it created
        // files with errors and stopped" problem).
        const fixRetries = Number(ctx.session.inputs.pipelineFixRetries) || 0;
        const clean = report.compileClean === true && report.auditClean === true;
        if (!clean && Number(report.filesWritten) > 0 && fixRetries < 2) {
            ctx.session.inputs.pipelineFixRetries = fixRetries + 1;
            const errs = (report.remainingErrors as string[]) ?? [];
            return {
                status: 'handoff',
                summary: `generated files not clean (compile=${report.compileClean}, audit=${report.auditClean}) — fixing`,
                handoff: {
                    handoffId: 'author.pipeline',
                    packs: ['authoring', 'quality'],
                    instruction:
                        `The generated files are not clean yet — compileClean=${report.compileClean}, ` +
                        `auditClean=${report.auditClean}. FIX them now: run compile_check, resolve EVERY ` +
                        `TypeScript/compile error, then audit_file on each file and resolve every ` +
                        `error-severity violation, editing the files with csaa_write. ` +
                        (errs.length ? `Known remaining errors: ${errs.slice(0, 10).join(' | ')}. ` : '') +
                        'Re-run until both are clean, then csaa_advance with compileClean=true, auditClean=true.',
                    nextSuggestedTool: 'csaa_compile_check',
                    nextSuggestedArgs: { runId },
                    doneWhen: 'compile_check clean AND audit clean',
                    reportSchema: AUTHOR_REPORT_SCHEMA,
                },
            };
        }
        ctx.session.inputs.pipelineCompileClean = report.compileClean === true;
        ctx.session.inputs.generatedFeatureFiles = ((report.featureFiles as string[]) ?? []).join(',');
        const artifact = ctx.writeArtifact('pipeline-report.json', JSON.stringify(report, null, 2));
        return {
            status: 'complete',
            summary: `pipeline ${finalState}: ${Number(report.filesWritten) || 0} files, compile=${report.compileClean ? 'clean' : 'DIRTY'}, audit=${report.auditClean ? 'clean' : 'DIRTY'}`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Author verify + heal — EXECUTE the generated tests, and for every failure
// diagnose + heal (locator/timing/workflow/data) against the live app, looping
// until green or the heal budget is spent. Also audits the generated page
// objects + steps against what the app actually does. This is what turns
// "generated files" into "passing, validated tests".
// ---------------------------------------------------------------------------

const AUTHOR_VERIFY_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['total', 'passed', 'failed'],
    properties: {
        total: { type: 'number', minimum: 0 },
        passed: { type: 'number', minimum: 0 },
        failed: { type: 'number', minimum: 0 },
        healed: { type: 'number', minimum: 0 },
        cyclesUsed: { type: 'number', minimum: 0 },
        pageObjectsAudited: { type: 'boolean' },
        stepsAudited: { type: 'boolean' },
        realAppBugs: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
    },
};

stage({
    id: 'author.verify',
    kind: 'handoff',
    title: 'Execute + heal generated tests to green',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        if (ctx.handoffReport === undefined) {
            const project = str(inputs.project);
            const remaining = GUARDRAIL_LIMITS.maxHealCycles - ctx.session.healCycles;
            if (remaining <= 0) {
                return { status: 'complete', summary: 'heal budget exhausted before verify — see report' };
            }
            const featureTarget =
                (str(inputs.generatedFeatureFiles).split(',').map((s) => s.trim()).filter(Boolean)[0]) ||
                path.join(ctx.workspaceRoot, 'test', project, 'features');
            const guard = CSGuardrailEngine.checkAction('bdd_run_feature', { environment: str(inputs.environment) });
            if (!guard.ok) {
                return { status: 'blocked', summary: 'constitutional block', blockedReason: guard.reason };
            }
            return {
                status: 'handoff',
                summary: 'verify + heal delegated',
                handoff: {
                    handoffId: 'author.verify',
                    packs: ['execution', 'exploration'],
                    instruction:
                        `Now EXECUTE the tests you just generated and make them PASS — do not stop at ` +
                        `"generated". Set PROJECT=${project}` +
                        (str(inputs.environment) ? ` ENVIRONMENT=${str(inputs.environment)}` : '') +
                        '. Run them with bdd_run_feature. For EACH failing scenario, DIAGNOSE the real ' +
                        'cause and HEAL the right layer (locator drift → fix the page-object locator against ' +
                        'the live DOM with browser_generate_locator; timing → waits; workflow changed → ' +
                        're-explore and fix steps+feature+pages; data → re-resolve DB-first then UI). While ' +
                        'you are in the app, AUDIT that the generated page objects and step definitions match ' +
                        'what the app actually does — correct any mismatch. Re-run after each fix. LOOP until ' +
                        `ALL scenarios pass or you hit the heal budget (${Math.min(remaining, GUARDRAIL_LIMITS.maxHealCycles)} cycles). ` +
                        'NEVER weaken or delete an assertion to force a pass — a genuine application defect ' +
                        'stays failing and goes in realAppBugs. Report totals + pageObjectsAudited + ' +
                        'stepsAudited via csaa_advance.' +
                        CSCorrectionMemory.hintBlock(
                            CSCorrectionMemory.lookup(
                                ctx.workspaceRoot,
                                latestResultDirs(ctx.workspaceRoot, 1)
                                    .flatMap((d) => loadScenarios(d))
                                    .filter((s) => s.status === 'failed')
                                    .map((s) => s.error ?? '')
                                    .filter(Boolean),
                                project,
                            ),
                        ),
                    nextSuggestedTool: 'bdd_run_feature',
                    nextSuggestedArgs: { path: featureTarget },
                    doneWhen: 'all generated scenarios pass, or the heal budget is exhausted with the failures classified',
                    reportSchema: AUTHOR_VERIFY_SCHEMA,
                },
            };
        }
        const r = ctx.handoffReport;
        ctx.session.healCycles += Math.min(Math.max(Number(r.cyclesUsed) || 0, 0), GUARDRAIL_LIMITS.maxHealCycles);
        const failed = Number(r.failed) || 0;
        const passed = Number(r.passed) || 0;
        const total = Number(r.total) || 0;
        ctx.session.inputs.verifyPassed = passed;
        ctx.session.inputs.verifyFailed = failed;
        const artifact = ctx.writeArtifact('verify-report.json', JSON.stringify(r, null, 2));
        const bugs = (r.realAppBugs as string[]) ?? [];
        return {
            status: 'complete',
            summary:
                `verify: ${passed}/${total} passed, ${failed} failed` +
                (Number(r.healed) ? `, ${Number(r.healed)} healed` : '') +
                (bugs.length ? `, ${bugs.length} suspected app bug(s)` : ''),
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Coverage audit — does the generated suite actually cover the requirement?
// Compares the requirement document + plan against the generated features.
// ---------------------------------------------------------------------------

const COVERAGE_AUDIT_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['coveragePercent', 'verdict'],
    properties: {
        coveragePercent: { type: 'number', minimum: 0, maximum: 100 },
        coveredRequirements: { type: 'array', items: { type: 'string' } },
        missingRequirements: { type: 'array', items: { type: 'string' } },
        verdict: { type: 'string', enum: ['complete', 'partial', 'insufficient'] },
        recommendation: { type: 'string' },
    },
};

stage({
    id: 'author.coverage_audit',
    kind: 'cognitive',
    title: 'Audit coverage against the requirement',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.submission === undefined) {
            const grounding = ctx.session.artifacts.filter(
                (a) =>
                    a.endsWith('requirement-source.json') ||
                    a.endsWith('scenario-plan.json') ||
                    a.endsWith('pipeline-report.json') ||
                    a.endsWith('verify-report.json'),
            );
            // Fresh inventory so the audit sees the ACTUAL generated features.
            const invPath = ctx.writeArtifact(
                'coverage-inventory.json',
                JSON.stringify(CSRepoInventory.inventory(str(ctx.session.inputs.project), { workspaceRoot: ctx.workspaceRoot }), null, 2),
            );
            return {
                status: 'envelope',
                summary: 'awaiting coverage audit',
                envelope: makeEnvelope(
                    ctx,
                    'audit-coverage',
                    'Audit whether the GENERATED suite actually covers the REQUIREMENT. Read the ' +
                        'requirement at requirement-source.json, the plan at scenario-plan.json, and the ' +
                        'current test inventory (the generated features/scenarios) at the inventory grounding ' +
                        'path. For every requirement/acceptance item, decide whether a generated scenario ' +
                        'covers it (coveredRequirements) or not (missingRequirements). Compute coveragePercent ' +
                        'and a verdict (complete ≥ ~95%, partial, insufficient). Be honest — do not claim ' +
                        'coverage that is not there. Return JSON per responseSchema.',
                    COVERAGE_AUDIT_SCHEMA,
                    { groundingPaths: [...grounding, invPath], skills: skillHints('coverage audit requirement traceability') },
                ),
            };
        }
        const a = ctx.submission as Record<string, unknown>;
        const missing = (a.missingRequirements as string[]) ?? [];
        const md = [
            `# Coverage audit — ${str(ctx.session.inputs.project)}`,
            '',
            `**Coverage:** ${Number(a.coveragePercent)}%  ·  **Verdict:** ${str(a.verdict)}`,
            '',
            '## Covered',
            ...(((a.coveredRequirements as string[]) ?? []).map((c) => `- ${c}`)),
            '',
            '## Missing (not yet covered)',
            ...(missing.length ? missing.map((c) => `- ${c}`) : ['- (none — full coverage)']),
            '',
            str(a.recommendation ?? ''),
        ];
        const jsonPath = ctx.writeArtifact('coverage-audit.json', JSON.stringify(a, null, 2));
        const mdPath = ctx.writeArtifact('COVERAGE-AUDIT.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `coverage ${Number(a.coveragePercent)}% (${str(a.verdict)}), ${missing.length} requirement(s) still uncovered`,
            artifacts: [jsonPath, mdPath],
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
            // selectedFeatures is a comma-joined list from impact/candidate
            // stages — bdd_run_feature takes ONE path per call, so suggest the
            // first and instruct an explicit per-file loop over the rest.
            const selectedList = str(inputs.selectedFeatures).split(',').map((s) => s.trim()).filter(Boolean);
            const featureTarget =
                selectedList[0] || path.join(ctx.workspaceRoot, 'test', project, 'features');
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
                        (inputs.headless !== undefined ? ` HEADLESS=${inputs.headless === true}` : '') +
                        `, then run the target feature(s) with bdd_run_feature` +
                        (str(inputs.tags) ? ` using tags "${str(inputs.tags)}"` : '') +
                        (selectedList.length > 1
                            ? `. Run EACH of these ${selectedList.length} feature files with ONE bdd_run_feature call per file:\n  - ${selectedList.join('\n  - ')}\n`
                            : '. For a directory target, run each .feature (or use the tags filter). ') +
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
        /**
         * Per-failure learning records — feed the platform's correction
         * memory so the NEXT session that hits the same error signature gets
         * the known fix as a hint instead of re-diagnosing from scratch.
         */
        resolutions: {
            type: 'array',
            items: {
                type: 'object',
                required: ['errorText', 'category', 'resolution'],
                properties: {
                    errorText: { type: 'string', minLength: 5 },
                    category: { type: 'string' },
                    resolution: { type: 'string', minLength: 10 },
                    files: { type: 'array', items: { type: 'string' } },
                },
            },
        },
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
                    packs: ['exploration'],
                    instruction:
                        `Heal failing tests for project ${str(inputs.project)}` +
                        (str(inputs.target) ? ` (target: ${str(inputs.target)})` : ' (latest failed run)') +
                        '. For EACH failure, first DIAGNOSE the real cause by re-running with ' +
                        'bdd_run_feature and inspecting the captured error + the live app with the ' +
                        'browser tools (browser_launch/navigate/snapshot). Classify into ONE of:\n' +
                        '  • locator_drift — element moved/renamed: fix the page-object locator ' +
                        '(add/repair alternativeLocators; use browser_generate_locator on the live DOM).\n' +
                        '  • timing_flake — element not ready: add/adjust explicit waits in the page ' +
                        'object (never blind sleeps).\n' +
                        '  • workflow_change — the APPLICATION FLOW changed (a step was added, removed, ' +
                        'reordered, a new dialog/redirect appeared): RE-EXPLORE the affected workflow ' +
                        'in the browser, then update the step definition sequence AND the .feature ' +
                        'steps AND any new/removed page objects to match the new flow. This is the ' +
                        'main thing older heals missed — do not just patch a locator when the flow ' +
                        'itself moved.\n' +
                        '  • data_issue — the test data no longer satisfies preconditions: re-resolve ' +
                        'it DB-first (SELECT only) then UI-create, exactly like authoring.\n' +
                        '  • env_config — wrong env/URL/credential/config: surface it, do not fake a fix.\n' +
                        '  • assertion_outdated — the expected value legitimately changed with the app: ' +
                        'update the assertion to the new correct expectation ONLY when the live app ' +
                        'confirms the new value is correct (cite it); otherwise treat as app_bug.\n' +
                        '  • real_app_bug — the app is genuinely wrong: leave the test failing, do NOT ' +
                        'weaken it, and record it for a defect.\n' +
                        'After each fix, re-run to confirm green. NEVER weaken or delete an assertion ' +
                        `just to pass. HARD LIMIT: at most ${Math.min(remaining, 3)} cycles per scenario. ` +
                        'Then report back via csaa_advance with per-failure category + what you changed — ' +
                        'include a `resolutions` entry per fixed failure (errorText, category, resolution, files) ' +
                        'so the platform remembers the fix for next time.' +
                        CSCorrectionMemory.hintBlock(
                            CSCorrectionMemory.lookup(
                                ctx.workspaceRoot,
                                latestResultDirs(ctx.workspaceRoot, 1)
                                    .flatMap((d) => loadScenarios(d))
                                    .filter((s) => s.status === 'failed')
                                    .map((s) => s.error ?? s.steps.find((st) => st.error)?.error ?? '')
                                    .filter(Boolean),
                                str(inputs.project),
                            ),
                        ),
                    nextSuggestedTool: 'bdd_run_feature',
                    nextSuggestedArgs: {
                        path:
                            str(inputs.target) ||
                            path.join(ctx.workspaceRoot, 'test', str(inputs.project), 'features'),
                    },
                    doneWhen: 'every targeted failure is healed (locator/timing/workflow/data), classified as app bug, or out of cycles',
                    reportSchema: HEAL_REPORT_SCHEMA,
                },
            };
        }
        const r = ctx.handoffReport;
        // Clamp: an agent reporting 0 must still consume budget; a huge value
        // must not poison the session counter past the cap.
        const remainingCycles = GUARDRAIL_LIMITS.maxHealCycles - ctx.session.healCycles;
        ctx.session.healCycles += Math.min(Math.max(Number(r.cyclesUsed) || 1, 1), Math.max(remainingCycles, 1));
        // Learning loop: every reported fix becomes correction memory — the
        // next session hitting the same signature gets it as a hint.
        const resolutions = (r.resolutions as Array<Record<string, unknown>>) ?? [];
        for (const res of resolutions) {
            CSCorrectionMemory.record(ctx.workspaceRoot, {
                errorText: str(res.errorText),
                category: str(res.category) || 'unknown',
                resolution: str(res.resolution),
                files: Array.isArray(res.files) ? (res.files as string[]) : [],
                project: str(ctx.session.inputs.project),
            });
        }
        return {
            status: 'complete',
            summary:
                `heal: ${Number(r.healed) || 0} healed, ${Number(r.remaining) || 0} remaining, ` +
                `${Number(r.cyclesUsed) || 0} cycles used` +
                (resolutions.length ? `, ${resolutions.length} fix(es) memorized` : ''),
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
                        enum: ['locator_drift', 'timing_flake', 'workflow_change', 'test_data', 'environment', 'assertion_outdated', 'app_bug', 'test_bug'],
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
        // Feed each classified cluster into correction memory — signatures are
        // already normalized, so future heal/triage sessions get the fix hint.
        for (const c of clusters) {
            if (str(c.signature) && str(c.suggestedFix)) {
                CSCorrectionMemory.record(ctx.workspaceRoot, {
                    errorText: str(c.signature),
                    category: str(c.category) || 'unknown',
                    resolution: str(c.suggestedFix),
                    files: [],
                    project: str(ctx.session.inputs.project),
                });
            }
        }
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
        /**
         * The actual end-to-end journeys walked, each as an ordered list of
         * observed steps. This is what makes generation grounded-not-assumed:
         * the .feature scenarios and step sequences are built from THESE
         * observed steps, not invented.
         */
        workflows: {
            type: 'array',
            items: {
                type: 'object',
                required: ['name', 'steps'],
                properties: {
                    name: { type: 'string' },
                    steps: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            required: ['action', 'observed'],
                            properties: {
                                action: { type: 'string' },      // what the tester did
                                target: { type: 'string' },      // element/page acted on
                                data: { type: 'string' },        // value entered (never a secret)
                                observed: { type: 'string' },    // what the app actually did next
                            },
                        },
                    },
                },
            },
        },
        notes: { type: 'string' },
    },
};

// ---------------------------------------------------------------------------
// Plan-before-explore — read the requirement (FDD/doc/description) AND the
// existing tests, do gap analysis, and produce the prioritized scenario plan
// that scopes the exploration and generation. Without this, exploration has
// nothing concrete to walk and stops after one page.
// ---------------------------------------------------------------------------

const AUTHOR_PLAN_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['scenarios', 'coverageGaps'],
    properties: {
        existingCoverage: { type: 'array', items: { type: 'string' } },
        coverageGaps: { type: 'array', items: { type: 'string' } },
        // The user roles/personas the requirement involves and which to test
        // with (read-only, super user, approver…). Drives data + login choice.
        userRoles: {
            type: 'array',
            items: {
                type: 'object',
                required: ['role'],
                properties: {
                    role: { type: 'string' },
                    permissions: { type: 'string' },
                    useForTest: { type: 'boolean' },
                },
            },
        },
        // Open questions the requirement leaves ambiguous (which user to use,
        // which data set, environment specifics). These are ASKED before
        // generation via author.clarify — no guessing.
        clarifications: { type: 'array', items: { type: 'string' } },
        scenarios: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id', 'title', 'workflow', 'priority'],
                properties: {
                    id: { type: 'string' },
                    title: { type: 'string', minLength: 5 },
                    // The ordered user journey a tester walks to verify it —
                    // this is what the explore stage actually performs.
                    workflow: { type: 'string', minLength: 10 },
                    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                    type: { type: 'string', enum: ['positive', 'negative', 'edge', 'e2e'] },
                    reuseExisting: { type: 'boolean' },
                    // When this scenario belongs in an EXISTING feature file,
                    // name it here so the pipeline EXTENDS it instead of
                    // creating a parallel duplicate feature.
                    targetFeatureFile: { type: 'string' },
                    role: { type: 'string' },
                    notes: { type: 'string' },
                },
            },
        },
    },
};

stage({
    id: 'author.plan',
    kind: 'cognitive',
    title: 'Requirement + gap analysis → scenario plan',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.submission === undefined) {
            const inputs = ctx.session.inputs;
            const source = str(inputs.source) || str(inputs.legacyPath);
            // Deterministically pre-read a requirement document when the source
            // is a file path (the FDD) — zero tokens, and it grounds the plan
            // in the real requirement instead of the model guessing.
            let requirementText = '';
            try {
                if (source && fs.existsSync(source) && fs.statSync(source).isFile()) {
                    requirementText = fs.readFileSync(source, 'utf-8').slice(0, 40_000);
                }
            } catch {
                /* ignore — fall back to source string as the requirement */
            }
            const reqArtifact = ctx.writeArtifact(
                'requirement-source.json',
                JSON.stringify(
                    {
                        source,
                        isDocument: requirementText.length > 0,
                        content: requirementText || `(no document read — requirement is: ${source})`,
                    },
                    null,
                    2,
                ),
            );
            const invPath =
                ctx.session.artifacts.find((a) => a.endsWith('inventory.json') || a.endsWith('workspace-posture.json')) ??
                ctx.writeArtifact(
                    'plan-inventory.json',
                    JSON.stringify(
                        CSRepoInventory.inventory(str(inputs.project), { workspaceRoot: ctx.workspaceRoot }),
                        null,
                        2,
                    ),
                );
            return {
                status: 'envelope',
                summary: 'awaiting scenario plan',
                envelope: makeEnvelope(
                    ctx,
                    'plan-scenarios',
                    'You are the test lead planning BEFORE any automation — exactly what a human tester ' +
                        'does first. Read the requirement at requirement-source.json (the FDD / document / ' +
                        'description) THOROUGHLY (all sections, not just headings) AND the existing test ' +
                        'inventory at the inventory grounding path (it lists existing .feature files, their ' +
                        'scenarios, step files and page objects). Then:\n' +
                        '1. GAP ANALYSIS — existingCoverage (what existing tests already cover) vs coverageGaps ' +
                        '(what the requirement needs that is NOT yet covered).\n' +
                        '2. REUSE, DO NOT DUPLICATE — for EACH scenario, if an existing .feature already covers ' +
                        'that area, set reuseExisting=true and set targetFeatureFile to that EXISTING file so the ' +
                        'pipeline EXTENDS it (adds scenarios / reuses its page objects + steps) instead of ' +
                        'creating a parallel duplicate feature. Only omit targetFeatureFile for genuinely new areas.\n' +
                        '3. USER ROLES — from the requirement, list the user roles/personas involved (e.g. ' +
                        'read-only user, super user, approver) in userRoles, marking which to use for the tests ' +
                        '(useForTest). Assign each scenario its role.\n' +
                        '4. CLARIFICATIONS — put any genuinely ambiguous decision the requirement does not settle ' +
                        '(which user account to test with, which data set, environment specifics) into ' +
                        'clarifications; these will be ASKED, not guessed.\n' +
                        'Each scenario needs a concrete `workflow` (the ordered journey a tester walks to verify ' +
                        'it). Ground everything in the requirement — do NOT invent scope it does not imply. ' +
                        'Return JSON per responseSchema.',
                    AUTHOR_PLAN_SCHEMA,
                    {
                        groundingPaths: [reqArtifact, invPath],
                        project: str(inputs.project),
                        skills: skillHints('test plan scenario coverage gap analysis'),
                    },
                ),
            };
        }
        const plan = ctx.submission as Record<string, unknown>;
        const scenarios = (plan.scenarios as Array<Record<string, unknown>>) ?? [];
        const gaps = (plan.coverageGaps as string[]) ?? [];
        // Explore scope = the workflows the tester must walk, priority order.
        const toWalk = scenarios.map((s) => `${str(s.title)} :: ${str(s.workflow)}`);
        ctx.session.inputs.exploreScope = toWalk.join(' | ');
        ctx.session.inputs.plannedScenarioCount = scenarios.length;
        ctx.session.inputs.exploreRetries = 0;
        // Stash the plan's clarifications for the author.clarify stage to ask.
        const clar = (plan.clarifications as string[]) ?? [];
        ctx.session.inputs.pendingClarifications = clar.filter(Boolean).join(' || ');
        const md = [
            `# Scenario plan — ${str(ctx.session.inputs.project)}`,
            '',
            '## Existing coverage',
            ...(((plan.existingCoverage as string[]) ?? ['(none found)']).map((c) => `- ${c}`)),
            '',
            '## Coverage gaps to implement',
            ...(gaps.length ? gaps.map((c) => `- ${c}`) : ['- (none — extending existing coverage)']),
            '',
            '## Planned scenarios',
            '| Priority | Type | Scenario | Reuse | Workflow to walk |',
            '|---|---|---|---|---|',
            ...scenarios.map(
                (s) =>
                    `| ${s.priority} | ${s.type ?? '-'} | ${str(s.title).replace(/\|/g, '\\|')} | ${s.reuseExisting ? 'yes' : 'no'} | ${str(s.workflow).replace(/\|/g, '\\|')} |`,
            ),
        ];
        const jsonPath = ctx.writeArtifact('scenario-plan.json', JSON.stringify(plan, null, 2));
        const mdPath = ctx.writeArtifact('SCENARIO-PLAN.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `planned ${scenarios.length} scenario(s), ${gaps.length} gap(s) to implement`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

// ---------------------------------------------------------------------------
// Clarify — ask the ambiguous decisions the plan surfaced (which user/role to
// test with, which data set) BEFORE generating. Never guess these.
// ---------------------------------------------------------------------------

stage({
    id: 'author.clarify',
    kind: 'elicit',
    title: 'Clarify ambiguous requirement decisions',
    run: (ctx: StageContext): StageOutcome => {
        const pending = str(ctx.session.inputs.pendingClarifications);
        const questions = pending.split('||').map((q) => q.trim()).filter(Boolean);
        if (questions.length === 0) {
            return { status: 'complete', summary: 'no clarifications needed' };
        }
        if (ctx.answers === undefined) {
            return {
                status: 'question',
                summary: `awaiting ${questions.length} clarification(s)`,
                question: {
                    questionId: 'author.clarify',
                    message:
                        'The requirement leaves a few things open. Please clarify so I test the RIGHT thing ' +
                        '(I will not guess):',
                    fields: questions.map((q, i) => ({
                        id: `clar_${i}`,
                        title: q.slice(0, 60),
                        description: q,
                        type: 'string',
                        required: false,
                    })) as never,
                },
            };
        }
        // Record the answers as grounding for the pipeline.
        const resolved = questions.map((q, i) => ({ question: q, answer: str(ctx.answers?.[`clar_${i}`]) }));
        const artifact = ctx.writeArtifact('clarifications.json', JSON.stringify({ resolved }, null, 2));
        ctx.session.inputs.pendingClarifications = '';
        return { status: 'complete', summary: `${resolved.filter((r) => r.answer).length}/${questions.length} clarified`, artifacts: [artifact] };
    },
});

stage({
    id: 'author.explore',
    kind: 'handoff',
    title: 'Live application exploration',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        const source = str(inputs.appUrl) || str(inputs.source) || str(inputs.legacyPath);
        const isUrl = /^https?:\/\//i.test(str(inputs.appUrl)) || /^https?:\/\//i.test(str(inputs.source));
        const resolvedUrl = str(inputs.appUrl) || (/^https?:\/\//i.test(str(inputs.source)) ? str(inputs.source) : '');
        if (ctx.handoffReport === undefined) {
            if (!resolvedUrl) {
                // app.context should have elicited a URL. If there genuinely is
                // none (pure doc/description source), note it — generation will
                // be grounded in the document, and the user is told locators are
                // best-effort until the app is available.
                return {
                    status: 'complete',
                    summary: 'no application URL available — proceeding from document/source grounding; live-verified locators unavailable',
                };
            }
            return {
                status: 'handoff',
                summary: 'live exploration delegated',
                handoff: {
                    handoffId: 'author.explore',
                    packs: ['exploration'],
                    instruction:
                        `Explore the application at ${resolvedUrl} exactly like a human tester doing a ` +
                        'manual test pass BEFORE writing any automation. browser_launch (headless), ' +
                        'browser_navigate, then WALK EACH in-scope workflow END TO END — actually ' +
                        'perform the steps (click, type, submit) and OBSERVE what the app does at ' +
                        'each step. Record every workflow as an ordered `steps` list (action + ' +
                        'target + observed result) in the report — these observed steps become the ' +
                        '.feature scenario steps, so DO NOT invent or assume any step you did not ' +
                        'actually perform and see. On every distinct page: browser_snapshot, identify ' +
                        'the interactive elements, and browser_generate_locator for a stable primary ' +
                        'locator PLUS at least one alternative each. ' +
                        (str(inputs.authRequired) === 'yes'
                            ? 'Login IS required: authenticate using the ' +
                              '{config:DEFAULT_USERNAME}/{config:DEFAULT_PASSWORD} convention to reach ' +
                              'the protected workflows. '
                            : '') +
                        'NEVER type or record literal credentials/secrets in the report — use the ' +
                        '{config:...} placeholders. Bound it: max 15 pages, max 25 elements/page. ' +
                        (str(inputs.exploreScope)
                            ? `IN-SCOPE WORKFLOWS from the plan — walk EVERY ONE of these end-to-end, ` +
                              `not just the first (read scenario-plan.json for full detail): ${str(inputs.exploreScope)}. ` +
                              'One workflow entry in your report per planned scenario. '
                            : '') +
                        'Do NOT report done after a single page — you must walk every planned workflow. ' +
                        'Then call csaa_advance with the report per reportSchema.',
                    nextSuggestedTool: 'browser_launch',
                    nextSuggestedArgs: { headless: true },
                    doneWhen: 'EVERY planned in-scope workflow walked end-to-end with its step sequence + every visited page captured',
                    reportSchema: EXPLORE_REPORT_SCHEMA,
                },
            };
        }
        const report = ctx.handoffReport;
        const pages = (report.pages as Array<Record<string, unknown>>) ?? [];
        const workflows = (report.workflows as Array<Record<string, unknown>>) ?? [];
        const elementCount = pages.reduce(
            (sum, p) => sum + ((p.elements as unknown[]) ?? []).length,
            0,
        );
        // Coverage gate: if a plan set N scenarios but the walk covered far
        // fewer (or only one page), send it BACK to finish — this is what stops
        // "navigated to one page, declared done". Bounded to avoid a loop.
        const planned = Number(inputs.plannedScenarioCount) || 0;
        const retries = Number(inputs.exploreRetries) || 0;
        const needed = Math.max(1, Math.ceil(planned * 0.6));
        if (planned > 0 && retries < 2 && (workflows.length < needed || pages.length <= 1)) {
            inputs.exploreRetries = retries + 1;
            return {
                status: 'handoff',
                summary: `exploration too shallow (${workflows.length}/${planned} workflows, ${pages.length} pages) — sending back`,
                handoff: {
                    handoffId: 'author.explore',
                    packs: ['exploration'],
                    instruction:
                        `Your exploration only covered ${workflows.length} of ${planned} planned workflows ` +
                        `(${pages.length} page(s)). That is not enough. Go BACK to the app at ${resolvedUrl} and ` +
                        'walk the REMAINING planned workflows END TO END (see scenario-plan.json for the full ' +
                        'list and each workflow\'s journey), capturing each page\'s elements + locators and the ' +
                        'ordered observed steps. Return the COMPLETE report (all planned workflows) via csaa_advance.',
                    nextSuggestedTool: 'browser_navigate',
                    nextSuggestedArgs: { url: resolvedUrl },
                    doneWhen: 'all planned workflows are covered in the report',
                    reportSchema: EXPLORE_REPORT_SCHEMA,
                },
            };
        }
        const artifact = ctx.writeArtifact(
            'captured-pages.json',
            JSON.stringify({ source, ...report }, null, 2),
        );
        return {
            status: 'complete',
            summary: `explored ${pages.length} pages, ${workflows.length} workflow(s), captured ${elementCount} elements`,
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
    required: ['story', 'plans', 'suites'],
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
                        `Gather FULL ADO context for story ${storyId}: ado_work_items_get and read ` +
                        'ALL of it — title, System.Description (the full description, not just a ' +
                        'summary), Microsoft.VSTS.Common.AcceptanceCriteria, ' +
                        'Microsoft.VSTS.TCM.ReproSteps if present, priority, tags, and area/iteration ' +
                        'path. Also pull its comments (ado_work_items_query or the work-item ' +
                        'comments tool) and linked/child items for extra requirements context — a ' +
                        'story\'s real behaviour often lives in the description and comments, not ' +
                        'only the acceptance criteria. Then ado_test_plans_list, ado_test_suites_list ' +
                        'for the relevant plan(s), and ado_test_suite_test_cases_list for the matching ' +
                        'suite (to avoid duplicate cases). Strip HTML. Then csaa_advance per reportSchema.',
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
                    'Design ADO test cases for the story in the grounding artifact. Derive cases ' +
                        'from the FULL story — acceptance criteria AND the behaviours described in ' +
                        'the description, repro steps and comments (not just the AC bullets) — plus ' +
                        'the negative/edge cases a senior QA would add. Every step needs a concrete ' +
                        'action AND a verifiable ' +
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

// ---------------------------------------------------------------------------
// App context — elicit the application URL (and whether login is needed)
// BEFORE exploration, so we never generate on assumptions about the app.
// ---------------------------------------------------------------------------

stage({
    id: 'app.context',
    kind: 'elicit',
    title: 'Application access',
    run: (ctx: StageContext): StageOutcome => {
        const inputs = ctx.session.inputs;
        const haveUrl =
            /^https?:\/\//i.test(str(inputs.appUrl)) ||
            /^https?:\/\//i.test(str(inputs.source)) ||
            /^https?:\/\//i.test(str(inputs.targetUrl));
        // If we already have a URL and auth is already answered, nothing to ask.
        if (haveUrl && inputs.authRequired !== undefined) {
            if (!inputs.appUrl && /^https?:\/\//i.test(str(inputs.source))) {
                ctx.session.inputs.appUrl = str(inputs.source);
            }
            return { status: 'complete', summary: 'app context already provided' };
        }
        if (ctx.answers === undefined) {
            const fields: Array<Record<string, unknown>> = [];
            if (!haveUrl) {
                fields.push({
                    id: 'appUrl',
                    title: 'Application URL',
                    description:
                        'The running application URL I should open and traverse to see the real ' +
                        'workflows before writing any tests. Leave blank only if there is no ' +
                        'running app (I will then work from the document/source instead).',
                    type: 'string',
                    required: false,
                });
            }
            fields.push({
                id: 'authRequired',
                title: 'Does reaching the workflows require login?',
                description:
                    'If yes, I use the encrypted {config:DEFAULT_USERNAME}/{config:DEFAULT_PASSWORD} ' +
                    'values from your project config to sign in — never plaintext credentials in chat. ' +
                    'Make sure those are set (npx cs-playwright-framework encrypt-value) before running.',
                type: 'enum',
                required: true,
                options: ['yes', 'no'],
                optionTitles: ['Yes — login needed', 'No — public/no auth'],
                default: 'no',
            });
            return {
                status: 'question',
                summary: 'awaiting app URL / auth',
                question: {
                    questionId: 'app.context',
                    message:
                        'To automate this the way a real tester would, I need to open the ' +
                        'application and walk the workflows myself first.',
                    fields: fields as never,
                },
            };
        }
        const a = ctx.answers;
        if (str(a.appUrl)) ctx.session.inputs.appUrl = str(a.appUrl);
        ctx.session.inputs.authRequired = str(a.authRequired) || 'no';
        return {
            status: 'complete',
            summary: `app context: url=${ctx.session.inputs.appUrl ? 'provided' : 'none'}, auth=${ctx.session.inputs.authRequired}`,
        };
    },
});

// ---------------------------------------------------------------------------
// Source-code automation — no requirements, no ADO: read the app's OWN source,
// derive the real workflows, then explore + author against them.
// ---------------------------------------------------------------------------

stage({
    id: 'source.analyze',
    kind: 'deterministic',
    title: 'Analyze application source',
    run: (ctx: StageContext): StageOutcome => {
        const srcPath = str(ctx.session.inputs.sourcePath) || str(ctx.session.inputs.source);
        if (!srcPath || !fs.existsSync(srcPath)) {
            return {
                status: 'blocked',
                summary: 'source path not found',
                blockedReason: `Application source path not found: "${srcPath}". Provide the path to the app's source code.`,
            };
        }
        const stat = fs.statSync(srcPath);
        const files = stat.isFile()
            ? [srcPath]
            : walkFiles(srcPath, ['.ts', '.tsx', '.js', '.jsx', '.vue', '.cs', '.java', '.py', '.html', '.cshtml', '.razor'], 1200);
        // Deterministic signal extraction: routes, components, forms, endpoints.
        const routes = new Set<string>();
        const forms = new Set<string>();
        const endpoints = new Set<string>();
        const components = new Set<string>();
        const routeRe = /(?:path|route|@RequestMapping|@GetMapping|@PostMapping|Route\()\s*[:(]?\s*['"`]([^'"`]{1,80})['"`]/g;
        const epRe = /(?:fetch|axios\.[a-z]+|http\.[a-z]+|HttpGet|HttpPost)\s*\(?\s*['"`]([/][^'"`]{1,80})['"`]/g;
        for (const f of files) {
            let c = '';
            try { c = fs.readFileSync(f, 'utf-8').slice(0, 20000); } catch { continue; }
            const base = path.basename(f);
            if (/\.(tsx|jsx|vue|razor|cshtml|component\.ts)$/.test(base) || /Component|Page|View/.test(base)) {
                components.add(base);
            }
            if (/<form|onSubmit|formGroup|ngSubmit|asp-action/.test(c)) forms.add(path.relative(srcPath, f));
            let m: RegExpExecArray | null;
            while ((m = routeRe.exec(c)) !== null) if (m[1].startsWith('/') || /^[a-z]/i.test(m[1])) routes.add(m[1]);
            while ((m = epRe.exec(c)) !== null) endpoints.add(m[1]);
        }
        const sourceMap = {
            sourcePath: srcPath,
            filesScanned: files.length,
            routes: Array.from(routes).slice(0, 100),
            forms: Array.from(forms).slice(0, 60),
            apiEndpoints: Array.from(endpoints).slice(0, 100),
            components: Array.from(components).slice(0, 120),
        };
        const artifact = ctx.writeArtifact('source-map.json', JSON.stringify(sourceMap, null, 2));
        return {
            status: 'complete',
            summary: `source analyzed: ${files.length} files, ${routes.size} routes, ${forms.size} forms, ${endpoints.size} endpoints`,
            artifacts: [artifact],
        };
    },
});

const SOURCE_WORKFLOWS_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['workflows'],
    properties: {
        workflows: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['name', 'entryRoute', 'priority', 'summary'],
                properties: {
                    name: { type: 'string', minLength: 4 },
                    entryRoute: { type: 'string' },
                    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                    summary: { type: 'string' },
                    happyPath: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        appType: { type: 'string' },
    },
};

stage({
    id: 'source.workflows',
    kind: 'cognitive',
    title: 'Derive workflows from source',
    run: (ctx: StageContext): StageOutcome => {
        const mapArtifact = ctx.session.artifacts.find((a) => a.endsWith('source-map.json'));
        if (ctx.submission === undefined) {
            return {
                status: 'envelope',
                summary: 'awaiting derived workflows',
                envelope: makeEnvelope(
                    ctx,
                    'derive-workflows-from-source',
                    'You are reverse-engineering the USER-FACING workflows of an application from ' +
                        'its own source code so they can be automated. Read the source-map at ' +
                        'groundingPath (routes, forms, components, endpoints) AND read the actual ' +
                        'source files it references for the important flows. Identify the real ' +
                        'end-user journeys (e.g. login, search, create-order, checkout), each with ' +
                        'its entry route and a happy-path outline. Prioritise by how central the ' +
                        'flow is to the app. These become the exploration targets and, after live ' +
                        'exploration, the automated scenarios. Return JSON per responseSchema.',
                    SOURCE_WORKFLOWS_SCHEMA,
                    { groundingPath: mapArtifact, skills: skillHints('workflow scenario page object design') },
                ),
            };
        }
        const derived = ctx.submission as Record<string, unknown>;
        const wfs = (derived.workflows as Array<Record<string, unknown>>) ?? [];
        // Seed the exploration scope from the derived workflows.
        ctx.session.inputs.exploreScope = wfs.map((w) => str(w.name)).join('; ');
        const artifact = ctx.writeArtifact('derived-workflows.json', JSON.stringify(derived, null, 2));
        return {
            status: 'complete',
            summary: `derived ${wfs.length} workflows from source`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// Defect-driven — read a defect + its repro, find the existing test, and
// either fix it to cover the defect or author a new regression test.
// ---------------------------------------------------------------------------

const DEFECT_FETCH_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['id', 'title', 'reproSteps'],
    properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        description: { type: 'string' },
        reproSteps: { type: 'array', items: { type: 'string' } },
        expected: { type: 'string' },
        actual: { type: 'string' },
        area: { type: 'string' },
        attachments: { type: 'array', items: { type: 'string' } },
        linkedTestCaseIds: { type: 'array', items: { type: 'number' } },
    },
};

stage({
    id: 'defect.fetch',
    kind: 'handoff',
    title: 'Fetch defect + reproduction',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const defectId = str(ctx.session.inputs.defectId);
            const guard = CSGuardrailEngine.preflight('ado_plan', { project: str(ctx.session.inputs.project) }, ctx.workspaceRoot);
            const blocker = guard.find((w) => w.startsWith('BLOCKER:'));
            if (blocker && /^[0-9]+$/.test(defectId)) {
                return { status: 'blocked', summary: 'ADO config needed', blockedReason: blocker.replace(/^BLOCKER:\s*/, '') };
            }
            return {
                status: 'handoff',
                summary: 'defect fetch delegated',
                handoff: {
                    handoffId: 'defect.fetch',
                    packs: ['ado'],
                    instruction:
                        `Fetch defect/bug ${defectId} from ADO: ado_work_items_get (title, ` +
                        'description, Microsoft.VSTS.TCM.ReproSteps, System.AreaPath, ' +
                        'Microsoft.VSTS.Common.Priority). Read the FULL description and repro steps ' +
                        '(strip HTML), not just the title. If the bug has linked test cases or ' +
                        'attachments (repro screenshots/logs), list them. Return JSON per ' +
                        'responseSchema. If the defect id is a plain description rather than an ADO ' +
                        'id, synthesize the same shape from that text.',
                    nextSuggestedTool: 'ado_work_items_get',
                    nextSuggestedArgs: { id: Number(defectId) || defectId },
                    doneWhen: 'defect details + reproduction steps collected',
                    reportSchema: DEFECT_FETCH_SCHEMA,
                },
            };
        }
        const artifact = ctx.writeArtifact('defect.json', JSON.stringify(ctx.handoffReport, null, 2));
        const steps = (ctx.handoffReport.reproSteps as string[]) ?? [];
        return { status: 'complete', summary: `defect fetched: ${steps.length} repro steps`, artifacts: [artifact] };
    },
});

const DEFECT_LOCATE_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['decision'],
    properties: {
        decision: { type: 'string', enum: ['fix_existing', 'author_new'] },
        existingTest: {
            type: 'object',
            properties: {
                featureFile: { type: 'string' },
                scenarioName: { type: 'string' },
                stepFiles: { type: 'array', items: { type: 'string' } },
                pageObjects: { type: 'array', items: { type: 'string' } },
            },
        },
        rationale: { type: 'string' },
        regressionScenario: { type: 'string' },
    },
};

stage({
    id: 'defect.locate',
    kind: 'cognitive',
    title: 'Locate existing test or decide new',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.submission === undefined) {
            const project = str(ctx.session.inputs.project);
            const inventory = CSRepoInventory.inventory(project, { workspaceRoot: ctx.workspaceRoot });
            const invPath = ctx.writeArtifact('defect-inventory.json', JSON.stringify(inventory, null, 2));
            const defectPath = ctx.session.artifacts.find((a) => a.endsWith('defect.json'));
            return {
                status: 'envelope',
                summary: 'awaiting locate decision',
                envelope: makeEnvelope(
                    ctx,
                    'locate-test-for-defect',
                    'Decide how to cover this defect with automation. Read the defect at the ' +
                        'defect.json grounding path and the existing test inventory at the inventory ' +
                        'grounding path. If an existing scenario already exercises the same workflow ' +
                        'the defect is in, choose fix_existing and identify its feature file, ' +
                        'scenario, step files and page objects (so the next stage repairs/extends it ' +
                        'to assert the fixed behaviour). If nothing covers it, choose author_new and ' +
                        'give a one-line regression scenario title that reproduces the defect. ' +
                        'Return JSON per responseSchema.',
                    DEFECT_LOCATE_SCHEMA,
                    { groundingPaths: [defectPath, invPath], skills: skillHints('scenario step page object regression') },
                ),
            };
        }
        const d = ctx.submission as Record<string, unknown>;
        ctx.session.inputs.defectDecision = str(d.decision);
        const artifact = ctx.writeArtifact('defect-plan.json', JSON.stringify(d, null, 2));
        return { status: 'complete', summary: `defect coverage: ${str(d.decision)}`, artifacts: [artifact] };
    },
});

stage({
    id: 'defect.resolve',
    kind: 'handoff',
    title: 'Fix or author regression test',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const decision = str(ctx.session.inputs.defectDecision) || 'author_new';
            const grounding = ctx.session.artifacts.filter(
                (a) => a.endsWith('defect.json') || a.endsWith('defect-plan.json') || a.endsWith('captured-pages.json'),
            );
            return {
                status: 'handoff',
                summary: 'defect resolution delegated',
                handoff: {
                    handoffId: 'defect.resolve',
                    packs: ['authoring', 'quality', 'execution'],
                    instruction:
                        (decision === 'fix_existing'
                            ? 'Repair/extend the existing test identified in defect-plan.json so it ' +
                              'now asserts the DEFECT IS FIXED (it should fail against the buggy ' +
                              'behaviour and pass once fixed). Update the page objects/steps as needed.'
                            : 'Author a NEW regression test that reproduces the defect from its repro ' +
                              'steps and asserts the correct expected behaviour, following the normal ' +
                              'csaa_* authoring chain grounded in the captured exploration.') +
                        ' Grounding artifacts: ' + grounding.join(', ') + '. ' +
                        'Then EXECUTE it with bdd_run_feature to confirm it behaves correctly, and ' +
                        'tag the scenario with @defect_<id>. Report via csaa_advance.',
                    nextSuggestedTool: decision === 'fix_existing' ? 'csaa_query_existing_pages' : 'csaa_discover',
                    nextSuggestedArgs: {},
                    doneWhen: 'the regression test exists, is tagged, and has been executed',
                    reportSchema: {
                        type: 'object',
                        required: ['outcome', 'testPath'],
                        properties: {
                            outcome: { type: 'string', enum: ['fixed', 'authored', 'blocked'] },
                            testPath: { type: 'string' },
                            executed: { type: 'boolean' },
                            passed: { type: 'boolean' },
                            notes: { type: 'string' },
                        },
                    },
                },
            };
        }
        const r = ctx.handoffReport;
        if (str(r.outcome) === 'blocked') {
            return { status: 'blocked', summary: 'defect resolution blocked', blockedReason: str(r.notes) || 'could not resolve defect' };
        }
        const artifact = ctx.writeArtifact('defect-resolution.json', JSON.stringify(r, null, 2));
        return {
            status: 'complete',
            summary: `defect ${str(r.outcome)}: ${str(r.testPath)}${r.executed ? (r.passed ? ' (passing)' : ' (still failing — likely real bug)') : ''}`,
            artifacts: [artifact],
        };
    },
});

// ---------------------------------------------------------------------------
// ADO automate — given a test PLAN, drill down: pick suite(s), pick the exact
// test cases to automate, fetch their steps, then author automation for them.
// ---------------------------------------------------------------------------

const ADO_SUITES_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['suites'],
    properties: {
        planName: { type: 'string' },
        suites: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'name'],
                properties: {
                    id: { type: 'number' },
                    name: { type: 'string' },
                    caseCount: { type: 'number' },
                },
            },
        },
    },
};

stage({
    id: 'adoauto.suites',
    kind: 'handoff',
    title: 'List suites in the plan',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const planId = str(ctx.session.inputs.planId);
            return {
                status: 'handoff',
                summary: 'ADO suites fetch delegated',
                handoff: {
                    handoffId: 'adoauto.suites',
                    packs: ['ado'],
                    instruction:
                        `List the test suites under ADO test plan ${planId}: ado_test_suites_list ` +
                        `(planId ${planId}). Include each suite's id, name, and test-case count. ` +
                        'Return JSON per responseSchema, then csaa_advance.',
                    nextSuggestedTool: 'ado_test_suites_list',
                    nextSuggestedArgs: { planId: Number(planId) || planId },
                    doneWhen: 'all suites under the plan listed',
                    reportSchema: ADO_SUITES_SCHEMA,
                },
            };
        }
        const artifact = ctx.writeArtifact('ado-suites.json', JSON.stringify(ctx.handoffReport, null, 2));
        const suites = (ctx.handoffReport.suites as unknown[]) ?? [];
        return { status: 'complete', summary: `${suites.length} suites in plan`, artifacts: [artifact] };
    },
});

stage({
    id: 'adoauto.pick_suite',
    kind: 'elicit',
    title: 'Pick suite to automate',
    run: (ctx: StageContext): StageOutcome => {
        const suitesArtifact = ctx.session.artifacts.find((a) => a.endsWith('ado-suites.json'));
        let suites: Array<{ id: number; name: string; caseCount?: number }> = [];
        if (suitesArtifact && fs.existsSync(suitesArtifact)) {
            try { suites = JSON.parse(fs.readFileSync(suitesArtifact, 'utf-8')).suites ?? []; } catch { /* */ }
        }
        if (ctx.answers === undefined) {
            if (suites.length === 0) {
                return { status: 'blocked', summary: 'no suites', blockedReason: 'No test suites found in that plan.' };
            }
            return {
                status: 'question',
                summary: 'awaiting suite pick',
                question: {
                    questionId: 'adoauto.suite',
                    message: 'Which test suite do you want to automate?',
                    fields: [{
                        id: 'suiteId',
                        title: 'Suite',
                        description: 'Suite whose test cases will be automated.',
                        type: 'enum',
                        required: true,
                        options: suites.map((s) => String(s.id)),
                        optionTitles: suites.map((s) => `${s.name}${s.caseCount ? ` (${s.caseCount} cases)` : ''}`),
                    }] as never,
                },
            };
        }
        ctx.session.inputs.suiteId = str(ctx.answers.suiteId);
        return { status: 'complete', summary: `suite ${str(ctx.answers.suiteId)} selected` };
    },
});

const ADO_CASES_LIST_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['cases'],
    properties: {
        cases: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'title'],
                properties: {
                    id: { type: 'number' },
                    title: { type: 'string' },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { action: { type: 'string' }, expected: { type: 'string' } },
                        },
                    },
                },
            },
        },
    },
};

stage({
    id: 'adoauto.cases',
    kind: 'handoff',
    title: 'List test cases in the suite',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const planId = str(ctx.session.inputs.planId);
            const suiteId = str(ctx.session.inputs.suiteId);
            return {
                status: 'handoff',
                summary: 'ADO cases fetch delegated',
                handoff: {
                    handoffId: 'adoauto.cases',
                    packs: ['ado'],
                    instruction:
                        `List the test cases in ADO plan ${planId} suite ${suiteId}: ` +
                        'ado_test_suite_test_cases_list, then for each case ado_work_items_get to ' +
                        'read its Microsoft.VSTS.TCM.Steps (parse the Steps XML into action/expected ' +
                        'pairs). Return JSON per responseSchema, then csaa_advance.',
                    nextSuggestedTool: 'ado_test_suite_test_cases_list',
                    nextSuggestedArgs: { planId: Number(planId) || planId, suiteId: Number(suiteId) || suiteId },
                    doneWhen: 'all cases in the suite listed with their steps',
                    reportSchema: ADO_CASES_LIST_SCHEMA,
                },
            };
        }
        const artifact = ctx.writeArtifact('ado-suite-cases.json', JSON.stringify(ctx.handoffReport, null, 2));
        const cases = (ctx.handoffReport.cases as unknown[]) ?? [];
        return { status: 'complete', summary: `${cases.length} cases in suite`, artifacts: [artifact] };
    },
});

stage({
    id: 'adoauto.pick_cases',
    kind: 'elicit',
    title: 'Pick test cases to automate',
    run: (ctx: StageContext): StageOutcome => {
        const casesArtifact = ctx.session.artifacts.find((a) => a.endsWith('ado-suite-cases.json'));
        let cases: Array<{ id: number; title: string }> = [];
        if (casesArtifact && fs.existsSync(casesArtifact)) {
            try { cases = JSON.parse(fs.readFileSync(casesArtifact, 'utf-8')).cases ?? []; } catch { /* */ }
        }
        if (ctx.answers === undefined) {
            if (cases.length === 0) {
                return { status: 'blocked', summary: 'no cases', blockedReason: 'No test cases found in that suite.' };
            }
            // Offer an "all" option plus each case; multi-select is not always
            // available in the text fallback, so accept a comma list too.
            return {
                status: 'question',
                summary: 'awaiting case pick',
                question: {
                    questionId: 'adoauto.cases',
                    message: `Which test cases should I automate? (${cases.length} available — choose "all" or list ids)`,
                    fields: [{
                        id: 'caseSelection',
                        title: 'Test cases',
                        description: 'Enter "all", or a comma-separated list of case ids (e.g. "1024,1025").',
                        type: 'string',
                        required: true,
                        default: 'all',
                    }] as never,
                },
            };
        }
        const sel = str(ctx.answers.caseSelection).trim().toLowerCase();
        const chosen = sel === 'all' || sel === ''
            ? cases.map((c) => c.id)
            : sel.split(/[,\s]+/).map((n) => Number(n)).filter((n) => cases.some((c) => c.id === n));
        ctx.session.inputs.selectedCaseIds = chosen.join(',');
        // Seed the authoring scope so explore + pipeline know what to build.
        ctx.session.inputs.exploreScope = cases
            .filter((c) => chosen.includes(c.id))
            .map((c) => c.title)
            .join('; ');
        return { status: 'complete', summary: `${chosen.length} test cases selected to automate` };
    },
});

// ---------------------------------------------------------------------------
// PR-impact — read a pull request (or commit), map its changed source files to
// the existing tests, classify each change as run-existing / needs-update /
// needs-new (the regression candidates), and optionally run the covered set.
// ---------------------------------------------------------------------------

const PRIMPACT_FETCH_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['changedPaths'],
    properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        sourceBranch: { type: 'string' },
        targetBranch: { type: 'string' },
        changedPaths: { type: 'array', items: { type: 'string' } },
        changes: {
            type: 'array',
            items: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string' },
                    changeType: { type: 'string' },
                },
            },
        },
        reviewNotes: { type: 'array', items: { type: 'string' } },
    },
};

stage({
    id: 'primpact.fetch',
    kind: 'handoff',
    title: 'Fetch PR / commit changed files',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.handoffReport === undefined) {
            const inputs = ctx.session.inputs;
            // Either/or contract: the catalog can't express "one of PR/commit
            // required", so enforce it here — ask instead of emitting a
            // handoff around an empty id (which would pressure fabrication).
            if (!str(inputs.pullRequestId) && !str(inputs.commitId)) {
                if (ctx.answers !== undefined) {
                    if (str(ctx.answers.pullRequestId)) inputs.pullRequestId = str(ctx.answers.pullRequestId);
                    if (str(ctx.answers.commitId)) inputs.commitId = str(ctx.answers.commitId);
                }
                if (!str(inputs.pullRequestId) && !str(inputs.commitId)) {
                    return {
                        status: 'question',
                        summary: 'need a PR or commit to analyse',
                        question: {
                            questionId: 'primpact.target',
                            message: 'Which change should I analyse for regression impact? Provide a pull request id OR a commit SHA.',
                            fields: [
                                { id: 'pullRequestId', title: 'Pull request id', description: 'The ADO pull request to analyse.', type: 'string', required: false, pattern: '^[0-9]+$' },
                                { id: 'commitId', title: 'Commit SHA', description: 'A single commit to analyse instead of a PR.', type: 'string', required: false },
                            ],
                        },
                    };
                }
            }
            const repo = str(inputs.repositoryId);
            const prId = str(inputs.pullRequestId);
            const commitId = str(inputs.commitId);
            // ADO must be configured to reach the PR/commit.
            const guard = CSGuardrailEngine.preflight('pr_impact', { project: str(inputs.project) }, ctx.workspaceRoot);
            const blocker = guard.find((w) => w.startsWith('BLOCKER:'));
            if (blocker) {
                return { status: 'blocked', summary: 'ADO config needed', blockedReason: blocker.replace(/^BLOCKER:\s*/, '') };
            }
            const usePr = prId !== '';
            return {
                status: 'handoff',
                summary: 'PR/commit fetch delegated',
                handoff: {
                    handoffId: 'primpact.fetch',
                    packs: ['ado'],
                    instruction: usePr
                        ? `Read pull request ${prId} in repository "${repo}". Call ado_pull_requests_get ` +
                          `(title, description, sourceRefName, targetRefName), then ` +
                          `ado_pull_request_get_changes to get the changed files (the changedPaths ` +
                          `array is the key output), and ado_pull_request_threads_list for any reviewer ` +
                          `notes that hint at risk. Return JSON per responseSchema — changedPaths MUST ` +
                          `be the real changed source paths from the PR.`
                        : `Get the changed files of commit ${commitId} in repository "${repo}" via ` +
                          `ado_commit_changes. Return JSON per responseSchema with changedPaths set to ` +
                          `the real changed source paths.`,
                    nextSuggestedTool: usePr ? 'ado_pull_request_get_changes' : 'ado_commit_changes',
                    nextSuggestedArgs: usePr
                        ? { repositoryId: repo, pullRequestId: Number(prId) || prId }
                        : { repositoryId: repo, commitId },
                    doneWhen: 'the changed source paths (and PR title/description) are collected',
                    reportSchema: PRIMPACT_FETCH_SCHEMA,
                },
            };
        }
        const r = ctx.handoffReport;
        const changed = (r.changedPaths as string[]) ?? [];
        if (changed.length === 0) {
            return {
                status: 'blocked',
                summary: 'no changed files',
                blockedReason: 'The PR/commit reported no changed files — nothing to analyse for regression impact.',
            };
        }
        ctx.session.inputs.changedPathCount = changed.length;
        const artifact = ctx.writeArtifact('pr-changes.json', JSON.stringify(r, null, 2));
        return { status: 'complete', summary: `fetched ${changed.length} changed file(s)`, artifacts: [artifact] };
    },
});

const PRIMPACT_MAP_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['candidates', 'summary'],
    properties: {
        candidates: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['changeArea', 'classification', 'reason'],
                properties: {
                    changeArea: { type: 'string' },
                    changedPaths: { type: 'array', items: { type: 'string' } },
                    classification: {
                        type: 'string',
                        enum: ['run_existing', 'needs_update', 'needs_new'],
                    },
                    existingTests: { type: 'array', items: { type: 'string' } },
                    reason: { type: 'string' },
                    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                },
            },
        },
        runSelection: {
            type: 'object',
            properties: {
                tags: { type: 'string' },
                featurePaths: { type: 'array', items: { type: 'string' } },
            },
        },
        summary: { type: 'string' },
    },
};

stage({
    id: 'primpact.map',
    kind: 'cognitive',
    title: 'Map changes to tests & classify regression candidates',
    run: (ctx: StageContext): StageOutcome => {
        if (ctx.submission === undefined) {
            const project = str(ctx.session.inputs.project);
            const inventory = CSRepoInventory.inventory(project, { workspaceRoot: ctx.workspaceRoot });
            const invPath = ctx.writeArtifact('pr-impact-inventory.json', JSON.stringify(inventory, null, 2));
            const changesPath = ctx.session.artifacts.find((a) => a.endsWith('pr-changes.json'));
            return {
                status: 'envelope',
                summary: 'awaiting regression-candidate mapping',
                envelope: makeEnvelope(
                    ctx,
                    'map-pr-impact',
                    'You are identifying the regression candidates for a code change. Read the ' +
                        'changed files at the pr-changes.json grounding path and the existing test ' +
                        'inventory (features/scenarios/pages/steps) at the inventory grounding path. ' +
                        'Group the changed source paths into meaningful change areas, and for EACH area ' +
                        'decide one of:\n' +
                        '  • run_existing — an existing scenario already covers this behaviour: list the ' +
                        'exact feature file(s)/scenario(s) in existingTests. These are what to execute.\n' +
                        '  • needs_update — a test exists but the change alters the flow/contract so the ' +
                        'test must be updated first: list the affected test(s) and say what changed.\n' +
                        '  • needs_new — no test covers this change: it is a coverage gap that needs a ' +
                        'new test authored.\n' +
                        'Base every mapping on the ACTUAL inventory — do not invent test paths. Set ' +
                        'runSelection.featurePaths to the real .feature paths of the run_existing set ' +
                        '(and/or a runSelection.tags expression). Assign a priority per candidate. ' +
                        'Return JSON per responseSchema.',
                    PRIMPACT_MAP_SCHEMA,
                    {
                        groundingPaths: [changesPath, invPath],
                        project,
                        skills: skillHints('regression impact analysis coverage mapping change'),
                    },
                ),
            };
        }
        const m = ctx.submission as Record<string, unknown>;
        const candidates = (m.candidates as Array<Record<string, unknown>>) ?? [];
        const byClass = (c: string) => candidates.filter((x) => str(x.classification) === c);
        const runExisting = byClass('run_existing');
        const needsUpdate = byClass('needs_update');
        const needsNew = byClass('needs_new');

        const runSel = (m.runSelection as Record<string, unknown>) ?? {};
        const featurePaths = ((runSel.featurePaths as string[]) ?? []).filter(Boolean);
        ctx.session.inputs.selectedFeatures = featurePaths.join(',');
        if (str(runSel.tags)) ctx.session.inputs.tags = str(runSel.tags);
        ctx.session.inputs.coveredCount = runExisting.length;
        ctx.session.inputs.updateCount = needsUpdate.length;
        ctx.session.inputs.newCount = needsNew.length;

        const row = (c: Record<string, unknown>) =>
            `| ${c.priority ?? '-'} | ${str(c.changeArea).replace(/\|/g, '\\|')} | ${((c.existingTests as string[]) ?? []).join('<br>').replace(/\|/g, '\\|') || '—'} | ${str(c.reason).replace(/\|/g, '\\|')} |`;
        const md = [
            `# Regression candidates — ${str(ctx.session.inputs.project)}`,
            '',
            str(m.summary ?? ''),
            '',
            `**Changed files:** ${Number(ctx.session.inputs.changedPathCount) || 0} · ` +
                `**Run existing:** ${runExisting.length} · **Needs update:** ${needsUpdate.length} · ` +
                `**Needs new:** ${needsNew.length}`,
            '',
            '## ✅ Run existing (regression set to execute)',
            '| Priority | Change area | Existing test(s) | Why |',
            '|---|---|---|---|',
            ...(runExisting.length ? runExisting.map(row) : ['| — | none | — | — |']),
            '',
            '## ✏️ Needs update (existing test must change first)',
            '| Priority | Change area | Existing test(s) | What changed |',
            '|---|---|---|---|',
            ...(needsUpdate.length ? needsUpdate.map(row) : ['| — | none | — | — |']),
            '',
            '## ➕ Needs new (coverage gap)',
            '| Priority | Change area | Existing test(s) | Why a new test |',
            '|---|---|---|---|',
            ...(needsNew.length ? needsNew.map(row) : ['| — | none | — | — |']),
        ];
        const jsonPath = ctx.writeArtifact('regression-candidates.json', JSON.stringify(m, null, 2));
        const mdPath = ctx.writeArtifact('REGRESSION-CANDIDATES.md', md.join('\n') + '\n');
        return {
            status: 'complete',
            summary: `regression candidates: ${runExisting.length} run / ${needsUpdate.length} update / ${needsNew.length} new`,
            artifacts: [jsonPath, mdPath],
        };
    },
});

stage({
    id: 'primpact.decide',
    kind: 'elicit',
    title: 'Run the covered regression set?',
    run: (ctx: StageContext): StageOutcome => {
        const covered = Number(ctx.session.inputs.coveredCount) || 0;
        const update = Number(ctx.session.inputs.updateCount) || 0;
        const gap = Number(ctx.session.inputs.newCount) || 0;
        if (ctx.answers === undefined) {
            return {
                status: 'question',
                summary: 'awaiting run decision',
                question: {
                    questionId: 'primpact.run',
                    message:
                        `Regression analysis: ${covered} covered test(s) to run, ${update} to update, ` +
                        `${gap} coverage gap(s) to author. ` +
                        (covered > 0
                            ? 'Run the covered regression set now, or stop with the plan only?'
                            : 'No existing tests directly cover these changes. Stop with the plan (there is nothing to run)?'),
                    fields: [
                        {
                            id: 'decision',
                            title: 'Next step',
                            description: 'Run the covered set now, or produce the plan only.',
                            type: 'enum',
                            required: true,
                            options: covered > 0 ? ['run_now', 'plan_only', 'cancel'] : ['plan_only', 'cancel'],
                            optionTitles:
                                covered > 0
                                    ? ['Run the covered tests now', 'Plan only (do not run)', 'Cancel']
                                    : ['Plan only (do not run)', 'Cancel'],
                            default: covered > 0 ? 'run_now' : 'plan_only',
                        },
                    ],
                },
            };
        }
        const decision = str(ctx.answers.decision) || 'plan_only';
        if (decision === 'cancel') {
            return { status: 'blocked', summary: 'user cancelled', blockedReason: 'PR-impact analysis cancelled by user.' };
        }
        ctx.session.inputs.primpactDecision = decision;
        return { status: 'complete', summary: `decision: ${decision}` };
    },
});

stage({
    id: 'primpact.run',
    kind: 'handoff',
    title: 'Execute covered regression set (optional)',
    run: (ctx: StageContext): StageOutcome => {
        const decision = str(ctx.session.inputs.primpactDecision) || 'plan_only';
        const selected = str(ctx.session.inputs.selectedFeatures);
        // Plan-only (or nothing covered): no execution, no tokens.
        if (decision !== 'run_now' || !selected) {
            return {
                status: 'complete',
                summary: decision === 'run_now' ? 'no covered features to run — plan delivered' : 'plan only — not executed',
            };
        }
        if (ctx.handoffReport === undefined) {
            const inputs = ctx.session.inputs;
            const project = str(inputs.project);
            const selectedList = selected.split(',').map((s) => s.trim()).filter(Boolean);
            const guard = CSGuardrailEngine.checkAction('bdd_run_feature', { environment: str(inputs.environment) });
            if (!guard.ok) {
                return { status: 'blocked', summary: 'constitutional block', blockedReason: guard.reason };
            }
            return {
                status: 'handoff',
                summary: 'covered regression execution delegated',
                handoff: {
                    handoffId: 'primpact.run',
                    packs: ['execution'],
                    instruction:
                        `Set environment PROJECT=${project}` +
                        (str(inputs.environment) ? ` ENVIRONMENT=${str(inputs.environment)}` : '') +
                        `, then execute ONLY the covered regression set` +
                        (str(inputs.tags) ? ` using tags "${str(inputs.tags)}"` : '') +
                        `. Run EACH of these ${selectedList.length} feature file(s) with ONE bdd_run_feature call per file:\n  - ${selectedList.join('\n  - ')}\n` +
                        'Do not fix failures here — collect results and report totals via ' +
                        'csaa_advance.',
                    nextSuggestedTool: 'bdd_run_feature',
                    nextSuggestedArgs: {
                        path: selectedList[0] ?? selected,
                        ...(str(inputs.tags) ? { tags: str(inputs.tags) } : {}),
                    },
                    doneWhen: 'the covered regression features executed once',
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
