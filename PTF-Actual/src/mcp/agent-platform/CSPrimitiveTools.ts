/**
 * Agentic Test Platform — Primitive MCP Tools (Rebuild M11 wiring)
 *
 * Exposes the 9 phase primitives as MCP tools so the `cs-ai-auto-assist`
 * Copilot agent prompt can compose them in sequence:
 *
 *   csaa_discover → csaa_analyze → csaa_plan → csaa_translate
 *   → csaa_audit → csaa_write → csaa_execute → csaa_verify → csaa_publish
 *
 * Each tool:
 *   - resolves a `CSRunContext` via runId (created by `cs_ai_auto_assist`)
 *   - calls the underlying TS primitive class (CSDiscovery, CSLegacyAnalyzer, …)
 *   - persists artefacts to `Agent-Processing/<ts>_<runId>/<phase>/`
 *   - calls `CSStatusWriter.write(ctx)` so the user's open `STATUS.md`
 *     refreshes after every transition
 *   - returns a structured payload with `nextSuggestedTool` so the agent
 *     keeps composing without freelancing
 *
 * Privacy-by-design: this module contains zero customer / project /
 * company identifiers. Generic placeholders only.
 *
 * @module agent-platform/CSPrimitiveTools
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolContext,
    MCPToolDefinition,
    MCPToolResult,
} from '../types/CSMCPTypes';
import { defineTool, MCPToolBuilder } from '../CSMCPToolRegistry';
import { CSRunContext, RunPhase } from './CSRunContext';
import { CSStatusWriter } from './CSStatusWriter';
import { CSDiscovery, LegacyInventory } from './CSDiscovery';
import { CSLegacyDataReader } from './CSLegacyDataReader';
import {
    CSLegacySignatureExtractor,
    type FullSignature,
    type TestSignature,
    type PageSignature,
    type HelperSignature,
} from './CSLegacySignatureExtractor';
import {
    CSWorkQueue,
    type AnalyzeQueueItem,
    type AnalyzePageQueueItem,
    type TranslateQueueItem,
} from './CSWorkQueue';
import { CSSemanticReuse } from './CSSemanticReuse';
import { CSWriteWithAudit, AuditViolation } from './CSWriteWithAudit';
import { CSRepoInventory } from './CSRepoInventory';
import { CSAdoCreateBackFlow } from './CSAdoCreateBackFlow';
import {
    ANALYSIS_SCHEMA,
    TRANSLATION_SCHEMA,
    MANDATORY_ANALYZE_SKILLS,
    MANDATORY_TRANSLATE_SKILLS,
} from './CSDelegationSchemas';
import type { DelegationEnvelope } from './CSDelegationEnvelope';
import { CSSchemaValidator } from './CSSchemaValidator';
import { CSContentValidator, ContentViolation } from './CSContentValidator';
import { auditTools } from '../tools/audit/CSMCPAuditTools';
import { bddTools } from '../tools/bdd/CSMCPBDDTools';
import { generationTools } from '../tools/generation/CSMCPGenerationTools';
import {
    GeneratedFeatureSummary,
    GeneratedScenarioSummary,
    PipelineOutput,
} from './types';

// ============================================================================
// Helpers
// ============================================================================

function jsonResult(data: unknown, summary: string): MCPToolResult {
    const json = JSON.stringify(data, null, 2);
    return {
        content: [{ type: 'text', text: `${summary}\n\n${json}` }],
        structuredContent: data as Record<string, unknown>,
    };
}

function errorResult(reason: string, runId?: string): MCPToolResult {
    return jsonResult(
        { state: 'BLOCKED_NEED_INPUT', runId, blockedReason: reason, nextStepNeeded: false },
        reason,
    );
}

function getCtx(runId: string): CSRunContext | null {
    return CSRunContext.get(runId);
}

/**
 * Recursive BFS walk of `root` looking for a file whose basename matches
 * `targetBaseName` (case-insensitive) AND whose absolute path contains the
 * env name as a path segment (e.g. `.../sit/...`). Used by
 * csaa_resolve_data_file when the direct path doesn't exist but a similarly
 * named file lives under a per-env folder somewhere in the tree.
 *
 * Walks with Node fs.readdir (does NOT consult .gitignore), so it finds
 * files under legacy folders that VS Code Copilot's `search` would miss.
 */
function commonPrefixLen(a: string, b: string): number {
    let i = 0;
    const max = Math.min(a.length, b.length);
    while (i < max && a[i] === b[i]) i++;
    return i;
}

const SKIP_WALK_DIRS = new Set([
    'node_modules', 'dist', 'build', 'target', 'out', 'bin',
    '.git', '.gradle', '.idea', '.vscode', 'tmp', 'temp',
    'Agent-Processing',
]);

/**
 * Single-walk multi-target file finder. Walks `root` once and returns the
 * FIRST file whose basename matches any of `targetBasenames` (case-insensitive)
 * AND — when `envFilter` is set — whose path contains the env name as a
 * segment. Capped at `maxDepth` directories deep. Cheap because each
 * directory is read exactly once regardless of how many basenames we test.
 */
function findFileMultiExt(
    root: string,
    targetBasenames: string[],
    options: { envFilter?: string; maxDepth?: number } = {},
): string | null {
    const targetSet = new Set(targetBasenames.map((b) => b.toLowerCase()));
    const envLower = options.envFilter?.toLowerCase();
    const envSegment = envLower
        ? new RegExp(`(^|[\\\\/])${envLower}([\\\\/]|$)`, 'i')
        : null;
    const maxDepth = options.maxDepth ?? 12;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
        const { dir, depth } = queue.shift()!;
        if (depth > maxDepth) continue;
        let entries: import('fs').Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isFile() && targetSet.has(e.name.toLowerCase())) {
                if (!envSegment || envSegment.test(full)) return full;
            }
            if (e.isDirectory() && !e.name.startsWith('.') &&
                !SKIP_WALK_DIRS.has(e.name)) {
                queue.push({ dir: full, depth: depth + 1 });
            }
        }
    }
    return null;
}

/** Convenience wrapper for the single-basename single-walk case. */
function findFileWithEnvInPath(
    root: string,
    targetBaseName: string,
    env: string,
    maxDepth = 12,
): string | null {
    return findFileMultiExt(root, [targetBaseName], { envFilter: env, maxDepth });
}

/** Convenience wrapper for the single-basename single-walk case (no env). */
function findFileByBasename(
    root: string,
    targetBaseName: string,
    maxDepth = 12,
): string | null {
    return findFileMultiExt(root, [targetBaseName], { maxDepth });
}

function getStr(p: Record<string, unknown>, k: string): string | undefined {
    const v = p[k];
    return typeof v === 'string' ? v : undefined;
}

// ============================================================================
// csaa_discover — Phase 2: walk legacy project tree
// ============================================================================

const csaa_discover: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_discover')
    .title('CS-AI-Auto-Assist — Discover (Phase 2)')
    .description(
        'Walk the legacy project tree (or BDD .feature, ADO TC#, doc, source, URL) ' +
            'and produce a structured inventory: tests, pages, helpers, base classes, data ' +
            'files, properties files, runner configs. Persists `inventory.json` to ' +
            '`Agent-Processing/<run>/02-discover/` and updates STATUS.md.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID from cs_ai_auto_assist', { required: true })
    .stringParam('rootPath', 'Project root path or entry file path', { required: true })
    .stringParam('entryFile', 'Optional explicit entry file when rootPath is a directory')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}' — invoke cs_ai_auto_assist first`, runId);

        const rootPath = getStr(params, 'rootPath');
        if (!rootPath || !fs.existsSync(rootPath)) {
            return errorResult(`provide a valid rootPath — '${rootPath}' does not exist`, runId);
        }
        ctx.startPhase('discover');
        try {
            const inventory = CSDiscovery.discover(rootPath, {
                entryFile: getStr(params, 'entryFile'),
            });
            ctx.writePhaseArtifact(
                'discover',
                'inventory.json',
                JSON.stringify(inventory, null, 2),
            );

            // Build the deterministic legacy signature: per-@Test action
            // count, per-page-class @FindBy field count, per-helper-method
            // leaf-action count. This is the floor every downstream gate
            // compares the LLM output against. Java-only for now — Selenium
            // is the dominant legacy stack we migrate from.
            let signature: FullSignature | null = null;
            const entryForSignature = inventory.entryFile ?? inventory.tests[0];
            if (entryForSignature && /\.java$/i.test(entryForSignature) && fs.existsSync(entryForSignature)) {
                try {
                    signature = CSLegacySignatureExtractor.extract(entryForSignature, {
                        pages: (inventory.pages ?? []).map((p) => {
                            const className = path.basename(p as string, '.java');
                            return { className, path: p as string };
                        }),
                        helpers: (inventory.helpers ?? []).map((h) => {
                            const className = path.basename(h as string, '.java');
                            return { className, path: h as string };
                        }),
                        workspaceRoot: rootPath,
                    });
                    ctx.writePhaseArtifact(
                        'discover',
                        'signature.json',
                        JSON.stringify(signature, null, 2),
                    );

                    // v1.38 Phase 2 — seed the analyze queue. The
                    // iterator architecture turns each @Test method into
                    // a single queue item; downstream csaa_analyze /
                    // csaa_append_analysis_scenario tools pop items one
                    // at a time so the LLM is given the spec for
                    // exactly one scenario per turn. This is the only
                    // way to keep tool-response payloads small enough
                    // to never blow the LLM-host per-message output
                    // budget on multi-scenario migrations.
                    try {
                        // Local const so the callback closure sees a
                        // definitely-non-null value (the outer `let
                        // signature` could theoretically be reassigned).
                        const sig = signature;
                        const queue = CSWorkQueue.load(ctx);
                        const items: AnalyzeQueueItem[] = sig.tests.map((t) => ({
                            kind: 'analyze-scenario',
                            id: t.testCaseId
                                ? (t.testCaseId.startsWith('TC_') || t.testCaseId.startsWith('TS_')
                                    ? t.testCaseId
                                    : `TC_${t.testCaseId}`)
                                : `TC_${t.methodName}`,
                            methodName: t.methodName,
                            legacyFile: entryForSignature,
                            legacyLineRange: [t.startLine, t.endLine],
                            helpersToExpand: t.helperInvocations.map((h) => ({
                                helperClass: h.helperClass,
                                helperMethod: h.helperMethod,
                            })),
                            expectedActionCount: CSLegacySignatureExtractor.expectedActionCount(
                                t,
                                sig.helpers,
                            ),
                        }));
                        queue.seedAnalyze(items);

                        // v1.38.2 — also seed the per-page sub-queue. Each
                        // legacy page class becomes one work item so the
                        // LLM emits ONE analysis.pages[i] entry per turn
                        // via csaa_append_analysis_page. Without this, a
                        // 6-page Administration module's finalize call
                        // bundles ~15-25 KB of legacy-file: citations
                        // into a single message — instant length-limit.
                        const pageItems = Object.values(sig.pages)
                            .map((p) => ({
                                kind: 'analyze-page' as const,
                                className: p.className,
                                legacyFile: p.filePath,
                                // 80% floor mirrors the page-coverage gate;
                                // minimum 1 so an empty page still produces
                                // a queue item the LLM can declare role=
                                // reuse-existing for.
                                minFieldCount: Math.max(1, Math.ceil((p.fields?.length ?? 0) * 0.8)),
                            }));
                        queue.seedAnalyzePages(pageItems);
                    } catch (queueErr) {
                        // Queue seeding is best-effort. If it fails the
                        // pipeline still works (downstream tools fall
                        // back to the v1.37.4 hard-cap streaming flow).
                        ctx.writePhaseArtifact(
                            'discover',
                            'queue-seed-error.txt',
                            queueErr instanceof Error ? (queueErr.stack ?? queueErr.message) : String(queueErr),
                        );
                    }
                } catch (sigErr) {
                    // Signature extraction is best-effort. Don't fail the
                    // discover phase if a malformed source file blocks the
                    // parse — record the error and let downstream gates
                    // skip when signature.json is absent.
                    ctx.writePhaseArtifact(
                        'discover',
                        'signature-error.txt',
                        sigErr instanceof Error ? (sigErr.stack ?? sigErr.message) : String(sigErr),
                    );
                }
            }

            const md = renderInventoryMarkdown(inventory, signature);
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'discover', 'Legacy Project Inventory', md,
            );
            ctx.finishPhase('discover', 'done', { reportPath });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'discover',
                    counts: inventory.counts,
                    rootStyle: inventory.rootStyle,
                    language: inventory.language,
                    runFolder: ctx.runFolder,
                    reportPath,
                    signatureExtracted: signature !== null,
                    signatureSummary: signature ? {
                        tests: signature.tests.length,
                        pages: Object.keys(signature.pages).length,
                        helpers: Object.keys(signature.helpers).length,
                        unresolvedReferences: signature.unresolvedReferences.length,
                    } : undefined,
                    analyzeQueueSeeded: signature !== null && signature.tests.length > 0,
                    analyzeQueueLength: signature !== null ? signature.tests.length : 0,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_analyze',
                    nextSuggestedArgs: {
                        runId,
                        entryFile: inventory.entryFile ?? inventory.tests[0],
                    },
                },
                `Discover complete: ${inventory.counts.tests} tests / ${inventory.counts.pages} pages / ${inventory.counts.helpers} helpers / ${inventory.counts.dataFiles} data files. ${signature ? `Signature: ${signature.tests.length} @Test methods, ${Object.keys(signature.pages).length} page classes, ${Object.keys(signature.helpers).length} helper methods extracted.` : ''} Call csaa_analyze next.`,
            );
        } catch (err) {
            ctx.finishPhase('discover', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_discover failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

function renderInventoryMarkdown(inv: LegacyInventory, sig?: FullSignature | null): string {
    const sigSection = sig ? [
        ``,
        `## Legacy Signature (deterministic floor for verification gates)`,
        ``,
        `| @Test method | testCaseId | actions | helper invocations |`,
        `|---|---|---|---|`,
        ...sig.tests.map((t) => `| \`${t.methodName}\` | ${t.testCaseId ?? '—'} | ${t.actions.length} | ${t.helperInvocations.length} |`),
        ``,
        `### Page-class fields (legacy floor for generated @CSGetElement count)`,
        ``,
        `| Class | @FindBy fields | Methods |`,
        `|---|---|---|`,
        ...Object.values(sig.pages).map((p) => `| \`${p.className}\` | ${p.fields.length} | ${p.methods.length} |`),
        ``,
        ...(Object.keys(sig.helpers).length > 0 ? [
            `### Helper methods (each invocation in @Test must expand to ≥ N steps)`,
            ``,
            `| Helper | Actions |`,
            `|---|---|`,
            ...Object.entries(sig.helpers).map(([k, h]) => `| \`${k}\` | ${h.actions.length} |`),
            ``,
        ] : []),
        ...(sig.unresolvedReferences.length > 0 ? [
            `### Unresolved references (file/class not found in inventory)`,
            ``,
            ...sig.unresolvedReferences.slice(0, 20).map((r) => `- \`${r}\``),
            ``,
        ] : []),
    ].join('\n') : '';
    return originalRenderInventoryMarkdown(inv) + sigSection;
}

function originalRenderInventoryMarkdown(inv: LegacyInventory): string {
    return [
        `# Legacy Project Inventory`,
        ``,
        `**Root:** \`${inv.rootPath}\`  `,
        `**Style:** ${inv.rootStyle}  `,
        `**Language:** ${inv.language}`,
        ``,
        `## Counts`,
        ``,
        `| Kind | Count |`,
        `|---|---|`,
        `| Tests | ${inv.counts.tests} |`,
        `| Pages | ${inv.counts.pages} |`,
        `| Helpers | ${inv.counts.helpers} |`,
        `| Base classes | ${inv.counts.baseClasses} |`,
        `| Data files | ${inv.counts.dataFiles} |`,
        `| Properties files | ${inv.propertiesFiles.length} |`,
        `| Runner configs | ${inv.counts.runnerConfigs} |`,
        `| Feature files | ${inv.counts.features} |`,
        '',
    ].join('\n');
}

// ============================================================================
// csaa_analyze — Phase 3: delegate analysis to the host LLM
// ============================================================================
//
// Returns a delegation envelope. The host LLM (Copilot in agent mode,
// Claude Code, etc.) reads the envelope, runs the model with the
// instruction + grounding, produces JSON matching ANALYSIS_SCHEMA, then
// calls csaa_record_analysis with the produced payload.
//
// Why not parse the source ourselves: legacy test files use arbitrary
// helper-method delegation patterns. A regex/AST walker fails silently
// into placeholder content for any structure it doesn't recognise. The
// LLM can navigate any structure and is required to cite line numbers
// for every leaf call — anything it can't ground gets escalated as a
// gap, never as a stub.
// ============================================================================

// ============================================================================
// Iterator-mode envelope builders (v1.38)
// ============================================================================
// One scenario per turn: keeps tool-response payloads small and the LLM's
// per-message output cap unreachable. Built lazily from queue.peekNext() so
// each tool call carries the spec for exactly one piece of work.

interface AnalyzeIteratorCommonGrounding {
    runId: string;
    project: string;
    module?: string;
    entryFile: string;
    inventoryPath: string;
    skillsPath: string;
}

/**
 * Build the per-scenario envelope. Used by csaa_analyze when the queue has
 * items, and by csaa_append_analysis_scenario after a successful advance
 * to hand the LLM the spec for the NEXT scenario.
 */
function buildAnalyzeScenarioEnvelope(
    item: AnalyzeQueueItem,
    progress: { completed: number; total: number },
    common: AnalyzeIteratorCommonGrounding,
): DelegationEnvelope {
    const scenarioIdx = progress.completed + 1; // 1-indexed for display
    const helpersList = item.helpersToExpand.length > 0
        ? item.helpersToExpand.map((h) => `${h.helperClass}.${h.helperMethod}`).join(', ')
        : '(none)';
    return {
        task: 'produce-one-scenario',
        instruction: [
            `You are producing ONE scenario (${scenarioIdx}/${progress.total}). The framework owns the iteration — submit this one, the next item's spec will be in my reply. Do NOT try to produce more than one scenario per turn; the per-scenario submit tool rejects multi-scenario payloads.`,
            '',
            `Scenario id: ${item.id}`,
            `Legacy @Test method: ${item.methodName} (in ${item.legacyFile}, lines ${item.legacyLineRange[0]}–${item.legacyLineRange[1]})`,
            `Expected leaf-action count (signature floor, including helper expansion): ≥${Math.max(3, Math.round(item.expectedActionCount * 0.7))} steps`,
            `Helper invocations in this method that you MUST expand inline: ${helpersList}`,
            '',
            'Steps:',
            '  1. READ lines ' + item.legacyLineRange[0] + '–' + item.legacyLineRange[1] + ' of the legacy file via your `read` tool. Identify every leaf action (click / sendKeys / fill / select / getText / assert / verify).',
            '  2. For EACH helper invocation listed above, call `csaa_expand_helper(runId, helperClass, helperMethod)` to get the ordered leaf-action list inside that helper. Inline those actions as Gherkin steps in this scenario.',
            '  3. If the @Test uses @QAFDataProvider with a placeholder data file (e.g. `resources/${environment.name}/testdata/X.xls`), call `csaa_resolve_data_file(runId, annotationValue, environments)` then `csaa_read_legacy_data(filePath, sheet)` and place the actual row columns into `dataRow`. Do NOT use your built-in `search` tool — it misses gitignored legacy folders.',
            '  4. Build ONE scenario object matching the responseSchema (id, title, runFlag, tags, dataRow, steps[]).',
            '     - title: use legacyMethodName as-is OR add a disambiguator if another @Test shares the same title.',
            '     - steps[]: one entry per leaf action. legacyCite.lineNumber must be the actual line in the helper or @Test body.',
            '     - dataRow: actual columns from the legacy xls (loginKey, userId, expectedError, etc.). If 40%+ of values match their own keys (column-shift artifact), set dataRow:{} and reflect this via a follow-up gap during finalize.',
            '  5. Submit via `csaa_append_analysis_scenario(runId, scenario: { ... })`. My response will tell you what scenario to produce next, or to call csaa_finalize_analysis.',
            '',
            'STRICT RULES (gates will reject violations):',
            ' - Generated step count for this scenario ≥ 70% of the legacy floor above. Submitting fewer steps rejects with shortfall numbers.',
            ' - NEVER emit "Execute shared support flow X", "Run helper", "Invoke method" stubs — the helper has to be expanded.',
            ' - NEVER reference internal Java class names (e.g. TestDataRow, FooHelper) or helper ids in user-facing Gherkin step text.',
            ' - Source-ground every step: legacyCite { lineNumber, snippet } pointing at the file + line.',
            '',
            'SILENCE RULE: do NOT narrate file contents in your chat reply ("now writing scenario..."). Compose the tool call directly; the user reads STATUS.md for progress.',
        ].join('\n'),
        responseSchema: (ANALYSIS_SCHEMA as {
            properties?: { scenarios?: { items?: Record<string, unknown> } };
        }).properties?.scenarios?.items ?? {},
        grounding: {
            runId: common.runId,
            project: common.project,
            module: common.module,
            entryFile: common.entryFile,
            inventoryPath: common.inventoryPath,
            skillsPath: common.skillsPath,
            currentItem: {
                kind: item.kind,
                id: item.id,
                methodName: item.methodName,
                legacyFile: item.legacyFile,
                legacyLineRange: item.legacyLineRange,
                helpersToExpand: item.helpersToExpand,
                expectedActionCount: item.expectedActionCount,
                dataFileHint: item.dataFileHint,
            },
            queue: {
                current: scenarioIdx,
                total: progress.total,
                remaining: Math.max(0, progress.total - progress.completed - 1),
            },
        },
        recordWith: 'csaa_append_analysis_scenario',
        recordArgs: { runId: common.runId },
    };
}

/**
 * Per-page envelope (v1.38.2). Built after scenarios drain. Asks the LLM
 * to produce ONE analysis.pages[i] entry per turn — keeps each tool-call
 * payload to ~1-5 KB even when a page declares 30+ elements with
 * legacy-file:<path>:<line> citations.
 */
function buildAnalyzePageEnvelope(
    item: AnalyzePageQueueItem,
    progress: { completed: number; total: number },
    common: AnalyzeIteratorCommonGrounding,
): DelegationEnvelope {
    const pageIdx = progress.completed + 1;
    return {
        task: 'produce-one-analysis-page',
        instruction: [
            `Produce ONE analysis page (${pageIdx}/${progress.total}).`,
            '',
            `Legacy page class: ${item.className}`,
            `Legacy file: ${item.legacyFile}`,
            `Minimum elements[] count: ${item.minFieldCount} (80% floor of legacy @FindBy count)`,
            '',
            'Steps:',
            `  1. Call csaa_extract_page_fields(runId, pageClass: "${item.className}") to get the authoritative @FindBy list with line numbers.`,
            `  2. Decide role: "create-new" if this page must be regenerated under test/<project>/pages/<module>/, or "reuse-existing" if a matching CS Playwright page object already exists in the consumer repo (use csaa_query_existing_pages to check). Default: "create-new".`,
            `  3. Emit ONE element per legacy @FindBy. Each element needs: name (camelCase mirror of legacy field), primaryLocator { strategy:"xpath", value, source:"legacy-file:${item.legacyFile}:<line>" }, optional alternativeLocators[] for css/id variants.`,
            '',
            'Submit via `csaa_append_analysis_page(runId, page: { className, role, elements: [...] })`. My response will tell you the next page or the meta finalize envelope.',
            '',
            'SILENCE RULE: compose the tool call directly. Do NOT narrate locator strings or element lists in chat — that is the #1 cause of "response hit the length limit".',
        ].join('\n'),
        // Per-page schema — finalize re-validates the assembled pages[]
        // array under ANALYSIS_SCHEMA.
        responseSchema: {
            type: 'object',
            required: ['className', 'role', 'elements'],
            properties: {
                className: { type: 'string' },
                role: { type: 'string', enum: ['create-new', 'reuse-existing'] },
                reuseTargetPath: { type: 'string' },
                elements: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['name', 'primaryLocator'],
                        properties: {
                            name: { type: 'string' },
                            primaryLocator: {
                                type: 'object',
                                required: ['strategy', 'value', 'source'],
                                properties: {
                                    strategy: { type: 'string' },
                                    value: { type: 'string' },
                                    source: { type: 'string' },
                                },
                            },
                            alternativeLocators: { type: 'array' },
                        },
                    },
                },
            },
        },
        grounding: {
            runId: common.runId,
            project: common.project,
            module: common.module,
            entryFile: common.entryFile,
            inventoryPath: common.inventoryPath,
            skillsPath: common.skillsPath,
            currentItem: {
                kind: item.kind,
                className: item.className,
                legacyFile: item.legacyFile,
                minFieldCount: item.minFieldCount,
            },
            queue: {
                current: pageIdx,
                total: progress.total,
                remaining: Math.max(0, progress.total - progress.completed - 1),
                phase: 'analyzePages',
            },
        },
        recordWith: 'csaa_append_analysis_page',
        recordArgs: { runId: common.runId },
    };
}

/**
 * Built when the analyze queue is drained. Tells the LLM to produce the
 * non-scenario portion of the analysis (source / feature /
 * dependencyGraph / configFiles / loginContract / gaps / readinessScore)
 * and submit via csaa_finalize_analysis. Scenarios AND pages are already
 * in their scratch files — they must NOT be repeated in this payload.
 */
function buildAnalyzeFinalizeEnvelope(
    scenariosStaged: number,
    common: AnalyzeIteratorCommonGrounding,
): DelegationEnvelope {
    return {
        task: 'produce-analysis-meta',
        instruction: [
            `All ${scenariosStaged} scenario(s) are staged in 03-analyze/scratch-scenarios.json. Pages are staged in 03-analyze/scratch-pages.json (if any). Now produce the meta portion of the analysis and call csaa_finalize_analysis. This is the final step before the analyze phase closes.`,
            '',
            'Required fields (responseSchema below):',
            '  - source: { absolutePath, relativePath, sha256 } — the entry test file.',
            '  - feature: { name, slug, tags } — the Gherkin feature header.',
            '  - dependencyGraph: array of { path, kind } — entry + base class + every page object + every helper file you read. Floor is ≥3 entries.',
            '  - configFiles: array of { path, env?, keysExtracted, values } — at minimum the env.properties file (with web BASE_URL + credentials extracted into `values`). DB url goes into `values` separately under a `db.*`-prefixed key but NEVER as the web BASE_URL.',
            '  - loginContract: { detected, pattern, gherkinStep, loginPageFile?, url?, credentialFields? }',
            '  - gaps: array of { severity, detail, suggestedFuzzyMatch? } — any unresolved issues.',
            '  - readinessScore: number 0..1. Below 0.7 the run halts.',
            '',
            'Submit via `csaa_finalize_analysis(runId, payload: { source, feature, dependencyGraph, configFiles, loginContract, gaps, readinessScore })`. **Do NOT include `scenarios` or `pages` in this payload** — they come from their scratch files. finalize re-dispatches into csaa_record_analysis so every gate fires identically (schema + semantic + signature-coverage + readiness).',
            '',
            'SILENCE RULE: compose the tool call directly, do not narrate the payload contents in chat.',
        ].join('\n'),
        // Minimal subset schema — finalize re-validates via the full
        // ANALYSIS_SCHEMA after merging in scenarios + pages from scratch.
        // No `pages` here: it comes from the per-page scratch file so the
        // submission payload stays small enough to never blow the
        // per-message output cap.
        responseSchema: {
            type: 'object',
            required: ['source', 'feature', 'dependencyGraph', 'configFiles', 'loginContract', 'gaps', 'readinessScore'],
            properties: {
                source: { type: 'object' },
                feature: { type: 'object' },
                dependencyGraph: { type: 'array' },
                configFiles: { type: 'array' },
                loginContract: { type: 'object' },
                gaps: { type: 'array' },
                readinessScore: { type: 'number' },
            },
        },
        grounding: {
            runId: common.runId,
            project: common.project,
            module: common.module,
            entryFile: common.entryFile,
            inventoryPath: common.inventoryPath,
            skillsPath: common.skillsPath,
            scenariosStaged,
        },
        recordWith: 'csaa_finalize_analysis',
        recordArgs: { runId: common.runId },
    };
}

const csaa_analyze: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_analyze')
    .title('CS-AI-Auto-Assist — Analyze (Phase 3)')
    .description(
        'Returns a delegation envelope instructing the host LLM to analyze a legacy ' +
            'test file. The LLM produces a structured analysis (scenarios + steps + pages + ' +
            'login contract + gaps) citing line numbers for every leaf call. Companion tool: ' +
            'csaa_record_analysis.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID from cs_ai_auto_assist', { required: true })
    .stringParam('entryFile', 'Absolute path to entry test/feature file', { required: true })
    .stringParam('project', 'Target CS Playwright project name')
    .stringParam('module', 'Optional module sub-folder name')
    .stringParam('workspaceRoot', 'Workspace root for existing-pages lookup')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const entryFile = getStr(params, 'entryFile');
        if (!entryFile || !fs.existsSync(entryFile)) {
            return errorResult(`provide a valid entryFile — '${entryFile}' does not exist`, runId);
        }
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult(
                `no inventory found — call csaa_discover before csaa_analyze`,
                runId,
            );
        }

        // v1.38.3 — POST-FINALIZE SEAL (analyze side, symmetric to
        // translate). analysis-report.json existence means csaa_record_analysis
        // or csaa_finalize_analysis succeeded. Re-entering csaa_analyze after
        // that would fall through to the bulk envelope (queue is empty —
        // drained on success) and trigger the LLM to compose all scenarios in
        // a single message → length limit. Seal early.
        const analysisReportPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('analyze'),
            'analysis-report.json',
        );
        if (fs.existsSync(analysisReportPath)) {
            return jsonResult(
                {
                    state: 'ANALYZE_SEALED',
                    runId,
                    phase: 'analyze',
                    blockedReason: 'Analyze phase already finalized (analysis-report.json exists). DO NOT re-enter analyze. For corrections, edit analysis-report.json directly via csaa_write or start a NEW run via cs_ai_auto_assist. For low readiness, resolve gaps in the existing report and call csaa_plan to continue.',
                    analysisReportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_plan',
                    nextSuggestedArgs: { runId },
                },
                'Analyze sealed — analysis-report.json already exists. Use csaa_plan to continue or start a new run.',
            );
        }

        const inventory = JSON.parse(inventoryRaw) as LegacyInventory;

        // Project-name consistency gate.
        // csaa_classify extracts projectName from the user's intake prompt and
        // writes it to intake/classified.json. That is the source of truth.
        // If the caller (Copilot) drops the param or passes a different value
        // we must reject — silent fallback to "default" was the cause of the
        // config/<wrong>/ scaffold defect observed in production.
        const classifiedRaw = ctx.readPhaseArtifact('intake', 'classified.json');
        let classifiedProject: string | undefined;
        if (classifiedRaw) {
            try {
                const c = JSON.parse(classifiedRaw) as {
                    extractedFields?: { projectName?: string };
                };
                classifiedProject = c.extractedFields?.projectName;
            } catch { /* ignore */ }
        }
        const explicitProject = getStr(params, 'project');
        if (
            explicitProject &&
            explicitProject !== 'default' &&
            classifiedProject &&
            explicitProject.toLowerCase() !== classifiedProject.toLowerCase()
        ) {
            return errorResult(
                `project param mismatch — csaa_classify recorded projectName='${classifiedProject}' (in 01-intake/classified.json) but csaa_analyze was called with project='${explicitProject}'. Use a single project name across phase tools. Re-run csaa_classify with the desired project name, or call csaa_analyze with project='${classifiedProject}'.`,
                runId,
            );
        }
        const project = (
            explicitProject && explicitProject !== 'default'
                ? explicitProject
                : classifiedProject
        );
        if (!project || project === 'default') {
            return errorResult(
                `csaa_analyze requires a project name. classified.json does not contain extractedFields.projectName and the project param was ${explicitProject ? `'${explicitProject}' (rejected — 'default' is not a real project name)` : 'not supplied'}. Either re-run csaa_classify so it extracts projectName from the user intake, or call csaa_analyze with an explicit project='<name>'.`,
                runId,
            );
        }
        const module = getStr(params, 'module');
        const workspaceRoot = getStr(params, 'workspaceRoot');

        // Light validation only — don't read bytes into the envelope.
        // The host LLM reads via its built-in `read` tool to keep the tool
        // response small (VS Code Copilot truncates oversized responses to a
        // scratch file the agent can't fetch back).
        const stat = fs.statSync(entryFile);
        const MAX_BYTES = 512 * 1024;
        if (stat.size > MAX_BYTES) {
            return errorResult(
                `entryFile is ${stat.size} bytes (limit ${MAX_BYTES}); split into per-test runs`,
                runId,
            );
        }

        // Build a compact existing-pages index (paths + class names only).
        // Scope the inventory to the requested module so the analyzer LLM
        // only sees pages under `test/<project>/pages/<module>/` (plus the
        // shared `pages/common/` folder added by CSRepoInventory when a
        // module filter is set). Without this, the analyzer was being handed
        // every page in the repo and pulling unrelated pages into the BDD
        // grounding.
        let existingPagesIndex: Array<{ className: string; relativePath: string }> = [];
        if (workspaceRoot && fs.existsSync(workspaceRoot)) {
            try {
                const inv = CSRepoInventory.inventory(project, { workspaceRoot, module });
                existingPagesIndex = inv.pages.slice(0, 100).map((p) => ({
                    className: p.className,
                    relativePath: p.relativePath,
                }));
            } catch { /* non-fatal */ }
        }

        ctx.startPhase('analyze');

        // Compact list of legacy-file paths the LLM may want to read.
        const helperFiles = inventory.helpers.slice(0, 30);
        const dataFiles = inventory.dataFiles.slice(0, 30);
        const inventoryPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('discover'),
            'inventory.json',
        );

        // v1.38 Phase 3 — iterator mode. When the queue has items
        // (Java legacy that went through signature extraction during
        // discover), return a per-scenario envelope so the LLM receives
        // the spec for ONE scenario at a time. The bulk envelope below
        // remains for the backward-compat path (non-Java legacy where
        // signature extraction skipped, or runs that bypassed discover).
        const queue = CSWorkQueue.load(ctx);
        if (!queue.isEmpty('analyze')) {
            const item = queue.peekNext('analyze') as AnalyzeQueueItem;
            const common: AnalyzeIteratorCommonGrounding = {
                runId,
                project,
                module,
                entryFile,
                inventoryPath,
                skillsPath: '.github/skills/',
            };
            const iteratorEnvelope = buildAnalyzeScenarioEnvelope(
                item,
                { completed: queue.completed('analyze'), total: queue.total('analyze') },
                common,
            );

            // Persist intake + envelope same as legacy path so
            // downstream phases find the project/module + recover after
            // compaction.
            ctx.writePhaseArtifact(
                'analyze',
                'delegation-envelope.json',
                JSON.stringify(iteratorEnvelope, null, 2),
            );
            ctx.writePhaseArtifact(
                'intake',
                'run-params.json',
                JSON.stringify({ project, module, entryFile }, null, 2),
            );
            CSStatusWriter.write(ctx);

            return jsonResult(
                {
                    state: 'AWAITING_LLM_FULFILMENT',
                    runId,
                    phase: 'analyze',
                    delegation: iteratorEnvelope,
                    queue: {
                        current: queue.completed('analyze') + 1,
                        total: queue.total('analyze'),
                        progress: queue.progress('analyze'),
                    },
                    iteratorMode: true,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_analysis_scenario',
                    nextSuggestedArgs: { runId },
                },
                `Iterator mode: produce scenario ${queue.completed('analyze') + 1}/${queue.total('analyze')} (${item.id}). Submit via csaa_append_analysis_scenario.`,
            );
        }

        const envelope: DelegationEnvelope = {
            task: 'analyze-legacy-test-file',
            instruction: [
                'You are analyzing a legacy Selenium/TestNG (or NUnit/MSTest) test file. Your output drives downstream translation. Shallow analysis = garbage translation.',
                '',
                'STEP 0 — READ the framework SKILL files first. Use your `read` tool on `<workspaceRoot>/.github/skills/<name>/SKILL.md` for EVERY entry in `grounding.mandatorySkills`. These document the conventions the audit will enforce. Skipping this step is the #1 source of regenerations.',
                '',
                'STEP 0.5 — READ the legacy signature at `<runFolder>/02-discover/signature.json`. This is the deterministic floor: per-@Test action counts (including helper expansion), per-page-class @FindBy field counts. Your analysis MUST cover at least 70% of legacy actions per scenario AND 80% of legacy fields per create-new page object. Below those floors, csaa_record_analysis rejects with specific shortfall details — you cannot pass with thin output. Two deterministic tools are wired specifically for this:',
                '  • `csaa_expand_helper(runId, helperClass, helperMethod)` — returns the ordered leaf-action list for any helper method. CALL IT FOR EVERY helper invocation in the @Test body. Then emit one Gherkin step per returned action.',
                '  • `csaa_extract_page_fields(runId, pageClass)` — returns every @FindBy field on a legacy page class. CALL IT FOR EVERY page class referenced by the @Test methods. Your generated page-object analysis entry must list at least 80% of those fields.',
                'These two tools mean you do NOT have to manually count or guess — the framework gives you the authoritative legacy data and asserts you matched it.',
                '',
                'STEP 1 — recursive dependency closure. Use `read` on:',
                '  (a) `grounding.entryFile` — the test class itself',
                '  (b) the `extends X` base class file — find it under the discovered source tree (look in inventory.pages and inventory.helpers for path resolution); READ its full body, find @BeforeMethod / @BeforeClass / setUp logic',
                '  (c) EVERY same-project Java/C# import in the entry file → READ each one. Then recursively, EVERY import in those files (depth ≤ 3) — pages, helpers, support methods.',
                '  Record EVERY file you read in `dependencyGraph[]` with `path` + `kind` (base-class / page-object / helper / login-page).',
                '',
                'STEP 2 — locate the login flow. From the base class:',
                '  - Find the login helper invocation (e.g. `signIn`, `login`, `*LoginPage.*`).',
                '  - READ the login page class file fully — extract URL, credential locators, post-login validation locator.',
                '  - Fill `loginContract.loginPageFile` + `loginContract.url` + `loginContract.credentialFields[]` + `loginContract.gherkinStep`.',
                '',
                'STEP 3 — ingest config / properties. The legacy project usually has:',
                '  - `<root>/resources/application.properties` (global)',
                '  - `<root>/resources/<env>/env.properties` (env-specific URL + credentials)',
                '  - `<root>/resources/<env>/SQLQueries.properties` (DB queries)',
                '  READ each one. For EVERY file you read, push `{path, env, keysExtracted: [...], values: {key:value, ...}}` into `configFiles[]`. **The `values` object is critical** — it feeds straight into the generated `config/<project>/environments/<env>.env`.',
                '  **BASE_URL MUST BE THE WEB-APP URL, NEVER A DATABASE STRING.** Legacy env.properties files usually have BOTH:',
                '    - `env.baseurl=https://app.example.com` (web URL — this is what BASE_URL needs)',
                '    - `db.connection.url=jdbc:oracle:thin:@//host:1521/svc` (JDBC — this is for DB queries, NOT for the browser)',
                '  Extract BOTH into `values`, but the scaffold prefers keys matching `*baseurl|appurl|webappurl|portalurl|uiurl|siteurl` over any `db.*` / `database.*` / `jdbc.*` / `datasource.*` / `connection.*` keys. The scaffold rejects values whose scheme is `jdbc:`, `mongodb:`, `redis:`, `amqp:`, `kafka:`, `ldap:`, `file:`, `ftp:` — those will NEVER land in BASE_URL. Use the original key spelling from the properties file (e.g. `env.baseurl`).',
                '  Credentials: extract `username` / `user` / `defaultUsername` and `password` / `pwd` / `defaultPassword`. Without these, environments/<env>.env has blank creds and the run is unrunnable.',
                '  At minimum env.properties must be read; if you cannot find it, add a high-severity gap.',
                '',
                'STEP 4 — read the legacy test-data file.',
                '  **DO NOT use your built-in `search` / `file_search` tool to find xls/xlsx/csv files.** VS Code Copilot\'s search respects the workspace\'s `.gitignore` and `files.exclude` settings — legacy reference folders (legacy/, vendor/, third_party/, archive/) are often gitignored for read-only clones, so the search returns "no matches" for files that physically exist on disk. The framework gives you two deterministic alternatives that walk fs directly (no gitignore):',
                '  • The complete list of discovered data files is in `grounding.dataFiles[]` (absolute paths) — pass any of those directly to `csaa_read_legacy_data(filePath, sheet?)`.',
                '  • If the legacy `@QAFDataProvider(dataFile = "resources/${environment.name}/testdata/X.xls", ...)` uses placeholders, call `csaa_resolve_data_file(runId, annotationValue, environments?)` — it expands the placeholders against each env and returns absolute paths. Then read the resolved path with `csaa_read_legacy_data`.',
                '  For EVERY scenario in your analysis, look up the data row by scenarioId and put the ACTUAL row columns (e.g. userName, userId, expectedError) into `scenarios[].dataRow`. Empty dataRows when a data file exists = run rejected. If the resolver returns no matches across every env (foundCount=0), inspect `inventoryCandidates` — sometimes the on-disk basename differs slightly from the annotation. If still nothing, set `dataRow: {}` and add a high-severity gap; do NOT invent data.',
                '  **COLUMN-SHIFT GUARD.** If the returned row has values that equal their own keys (e.g. `{loginKey: "loginKey", userId: "userId"}` — the value IS the column header string), the xls reader picked up the HEADER row as data. This happens with merged cells, frozen panes, or shifted headers. Detect this: if ≥40% of values equal their keys, the row is corrupt. Options: (a) re-read with `csaa_read_legacy_data` using a different sheet name (the legacy file often has multiple sheets — try the sheet name from the @QAFDataProvider `sheetName` parameter), OR (b) set `dataRow: {}` for that scenario AND add a high-severity gap. Submitting header-shift rows as-is is automatically rejected.',
                '',
                'STEP 5 — for each legacy page-object Java class referenced by tests:',
                '  - READ the full *.java file from the inventory.pages list.',
                '  - Extract EVERY `@FindBy(...)` and `By.xpath(...)` / `By.id(...)` declaration. Use those exact strings.',
                '  - Set each `pages[].elements[].primaryLocator.source` to `legacy-file:<path>:<line>` (NEVER `inferred` unless you also add a high-severity gap explaining why).',
                '  - **OCR typo / fuzzy-match resolution.** If a referenced class name (e.g. `extends X`, `import com.example.X`, `xPage.method()` call site) is NOT present in inventory.pages or inventory.helpers, do a Levenshtein-distance check against the inventory before flagging as a gap. If the closest match has edit distance ≤ 2 OR character-set similarity ≥ 0.9, include the suggestion on the gap entry: `gaps.push({ severity: "high", detail: "<X> not found in inventory", suggestedFuzzyMatch: { from: "<X>", to: "<closestMatch>", editDistance: <n>, confidence: <0..1>, matchedInventoryPath: "<full path>" } })`. Common OCR typos: `SQL↔OQL`, `0↔O`, `1↔I`, `l↔I`, `rn↔m`. This lets the user approve the suggestion in a single round-trip instead of needing a full re-analyze.',
                '',
                'STEP 6 — for EVERY @Test method:',
                '  - Extract scenario id, title, runFlag from @MetaData / @Test annotations.',
                '  - For every Selenium action line (click, sendKeys, getText, waitFor, assert), produce ONE Gherkin step with `legacyCite` { lineNumber, snippet }.',
                '  - **HELPER-METHOD EXPANSION IS MANDATORY.** When the @Test body contains a helper call like `XHelper.populateForm(...)`, `XSupportMethod.someMethod(args)`, or `XUtil.runFlow(...)`, you MUST:',
                '      (a) read the helper class file fully (find it in inventory.helpers), add it to dependencyGraph[],',
                '      (b) for EACH leaf action inside the helper method (`field.sendKeys(...)`, `button.click()`, `assert*`), emit ONE Gherkin step in this scenario\'s steps[] with `legacyCite` pointing at the helper file + the specific line,',
                '      (c) DO NOT emit a single step like `"Execute shared support flow X"`, `"Run helper"`, `"Invoke method"`, `"Perform support routine"`, `"Call helper"`, `"Process via helper"`, etc. — every "delegate to helper" verb is rejected by the content gate. The helper has to be EXPANDED. If the helper does 12 actions, your scenario has 12 more steps in addition to the test\'s own actions.',
                '      (d) Test ids (e.g. TC_0001) NEVER appear in user-facing step text — only as `@TC_xxxx` tags or inside the data row.',
                '  - Disambiguate scenario titles: when two @Test methods have the same `testName` in @MetaData (common when one is SQL-flavor and another is Oracle-flavor), append a disambiguator to the title (e.g. `"New_On_Save_Rules (SQL)"` and `"New_On_Save_Rules (Oracle)"`). Two scenarios in the same feature with identical titles are rejected.',
                '  - Group locators by page; XPath primary, CSS alternatives.',
                '  - Reuse pages from `grounding.existingPagesIndex` when class name matches; set role=reuse-existing.',
                '',
                'STRICT RULES:',
                ' - NEVER invent a step / locator / URL / credential. Every claim must be grounded in a specific legacy file + line. If you can\'t ground it, add a `gaps[]` entry with severity=high.',
                ' - NEVER emit placeholder text like "TODO", "not implemented", "analyzer found no leaf calls", or "the operation should complete without errors".',
                ' - Self-assess readinessScore honestly. Below 0.7 the run halts.',
                '',
                'STEP 7 — submit the analysis. Two protocols, choose by scenario count:',
                '  (A) **≤3 scenarios with short step lists** → call `csaa_record_analysis(runId, payload)` ONCE with the full analysis JSON.',
                '  (B) **≥4 scenarios OR deep step lists** → STREAM to avoid blowing Copilot output-token caps. Loop: for EACH legacy @Test method call `csaa_append_analysis_scenario(runId, scenario)` with just that one scenario object (matches ANALYSIS_SCHEMA.scenarios[] — id/title/runFlag/steps/dataRow). Each call is small (~1–3 KB) so the message budget is never exceeded. When every scenario is appended, call `csaa_finalize_analysis(runId, payload)` with the REMAINING fields ONLY: source, feature, pages, dependencyGraph, configFiles, loginContract, gaps, readinessScore — DO NOT include scenarios in the finalize payload (they come from the scratch file). Finalize runs every gate from csaa_record_analysis and persists analysis-report.json. The scratch file survives conversation compaction — if Copilot summarizes, just continue appending or call finalize.',
                '',
                'RECOVERY — if your conversation got compacted between steps, re-read `<runFolder>/03-analyze/delegation-envelope.json` from disk to recover this full instruction + responseSchema. Then check `<runFolder>/03-analyze/scratch-scenarios.json` (if present) to see which scenarios were already submitted, and continue from there.',
            ].join('\n'),
            responseSchema: ANALYSIS_SCHEMA,
            grounding: {
                runId,
                project,
                module,
                entryFile,
                entryFileBytes: stat.size,
                inventoryPath,
                helperFiles,
                dataFiles,
                existingPagesIndex,
                skillsPath: '.github/skills/',
                mandatorySkills: [...MANDATORY_ANALYZE_SKILLS],
                frameworkConventions: [
                    '- BDD under test/<project>/features/<module>/*.feature',
                    '- Pages under test/<project>/pages/<module>/*.ts',
                    '- Steps under test/<project>/steps/<module>/*.steps.ts',
                    '- Data under test/<project>/data/<module>/*.json',
                    '- Locators: XPath primary, CSS alternatives via alternativeLocators[]',
                    '- All element interactions go through framework CSWebElement wrappers',
                ].join('\n'),
            },
            recordWith: 'csaa_record_analysis',
            recordArgs: { runId },
        };

        ctx.writePhaseArtifact(
            'analyze',
            'delegation-envelope.json',
            JSON.stringify(envelope, null, 2),
        );
        // Persist the user-supplied run params (project, module) at the
        // intake level so downstream phases — especially the config
        // scaffold in csaa_write — can route files to the right directory
        // without depending on whether the LLM happened to include them
        // in the recorded analysis JSON.
        ctx.writePhaseArtifact(
            'intake',
            'run-params.json',
            JSON.stringify({ project, module, entryFile }, null, 2),
        );
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'AWAITING_LLM_FULFILMENT',
                runId,
                phase: 'analyze',
                delegation: envelope,
                runFolder: ctx.runFolder,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_record_analysis',
                nextSuggestedArgs: { runId },
            },
            `Analyze delegation ready. Read entryFileContents, produce JSON matching responseSchema, then call csaa_record_analysis(runId, payload).`,
        );
    })
    .build();

// ============================================================================
// csaa_record_analysis — Phase 3 fulfilment partner
// ============================================================================

const csaa_record_analysis: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_record_analysis')
    .title('CS-AI-Auto-Assist — Record Analysis (Phase 3 fulfilment)')
    .description(
        'Companion to csaa_analyze. Accepts the LLM-produced analysis JSON, validates it ' +
            'against ANALYSIS_SCHEMA, persists analysis-report.json, and gates progression on ' +
            'readinessScore >= 0.7. Below threshold returns gap details for the user.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'payload',
        'REQUIRED. The LLM-produced analysis JSON object matching ANALYSIS_SCHEMA. Pass as `payload: { source: {...}, feature: {...}, scenarios: [...], pages: [...], loginContract: {...}, dependencyGraph: [...], configFiles: [...], readinessScore: <num>, gaps: [...] }`. This is the analysis you produced after reading the csaa_analyze envelope grounding.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const payload = params.payload;
        if (typeof payload !== 'object' || payload === null) {
            return errorResult(`payload must be an object`, runId);
        }

        // Gate 0: HARD payload size cap (symmetric with csaa_record_translation
        // in v1.37.3). The single-call analysis path is for tiny migrations
        // only. Real legacy files have 4+ @Test methods; trying to submit
        // the full analysis JSON in one tool call blows the LLM-host
        // per-message output budget (~32 KB at Sonnet 4.6 output limit)
        // mid-composition and the agent hits "Sorry, the response hit the
        // length limit" before the tool call lands.
        //
        // Force the streaming path: csaa_append_analysis_scenario per
        // scenario, then csaa_finalize_analysis. Finalize bypasses this
        // gate via _bypassSizeGate=true.
        const bypassSizeGate = params._bypassSizeGate === true;
        if (!bypassSizeGate) {
            const scenarios = (payload as { scenarios?: unknown }).scenarios;
            if (Array.isArray(scenarios)) {
                let totalBytes = 0;
                try { totalBytes = JSON.stringify(payload).length; } catch { /* ignore */ }
                const MAX_SCENARIOS_PER_CALL = 3;
                const MAX_BYTES_PER_CALL = 16 * 1024;
                if (scenarios.length > MAX_SCENARIOS_PER_CALL || totalBytes > MAX_BYTES_PER_CALL) {
                    return jsonResult(
                        {
                            state: 'AWAITING_LLM_RETRY',
                            runId,
                            phase: 'analyze',
                            payloadScenarios: scenarios.length,
                            payloadBytes: totalBytes,
                            maxScenarios: MAX_SCENARIOS_PER_CALL,
                            maxBytes: MAX_BYTES_PER_CALL,
                            nextStepNeeded: true,
                            nextSuggestedTool: 'csaa_append_analysis_scenario',
                            feedback:
                                `${SILENCE_PREFIX.join('\n')}\n` +
                                `csaa_record_analysis rejected: payload too large for single-call (${scenarios.length} scenarios, ${totalBytes} bytes — caps ${MAX_SCENARIOS_PER_CALL} scenarios / ${Math.round(MAX_BYTES_PER_CALL / 1024)} KB). Composing a 4+ scenario analysis in one JSON payload blows the LLM-host per-message output budget — you hit "response hit the length limit" mid-composition and the tool call never lands.\n\nUse the streaming protocol:\n  1. For EACH legacy @Test method, call csaa_append_analysis_scenario(runId, scenario: {...}). One scenario per call (~1-3 KB). Stages to 03-analyze/scratch-scenarios.json — survives compaction.\n  2. When every scenario is appended, call csaa_finalize_analysis(runId, payload: { source, feature, pages, dependencyGraph, configFiles, loginContract, gaps, readinessScore }) — DO NOT include scenarios in the finalize payload (they come from the scratch). Finalize runs every gate (semantic + signature-coverage + readiness) identically.\n\nDo NOT retry csaa_record_analysis with the same payload — same rejection. Streaming is mandatory above the cap.`,
                        },
                        `csaa_record_analysis rejected: ${scenarios.length} scenarios / ${totalBytes} bytes exceeds single-call cap. Use csaa_append_analysis_scenario + csaa_finalize_analysis.`,
                    );
                }
            }
        }

        const errors = CSSchemaValidator.validate(payload, ANALYSIS_SCHEMA);
        if (errors.length > 0) {
            const summary = errors.slice(0, 10).map((e) => `${e.path}: ${e.message}`).join('\n');
            ctx.writePhaseArtifact(
                'analyze',
                'validation-errors.json',
                JSON.stringify(errors, null, 2),
            );
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'analyze',
                    validationErrors: errors,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_record_analysis',
                    feedback: `Payload failed schema validation. Fix the errors below and re-call csaa_record_analysis with corrected JSON.\n\n${summary}`,
                },
                `Analysis payload failed schema validation (${errors.length} errors). Retry with corrected JSON.`,
            );
        }

        const analysis = payload as Record<string, unknown> & {
            scenarios: Array<{ id: string; dataRow?: Record<string, unknown> }>;
            pages: Array<{ elements?: Array<{ primaryLocator?: { source?: string } }>}>;
            dependencyGraph?: Array<{ path: string; kind: string }>;
            configFiles?: Array<{ path: string }>;
            readinessScore?: number;
            gaps?: Array<{ severity: string; detail: string }>;
        };

        // Cross-field semantic checks beyond the JSON schema:
        const semanticErrors: string[] = [];

        // 1. dependencyGraph must have ≥3 entries for a real migration
        //    (entry + base class + at least one page object).
        if (!Array.isArray(analysis.dependencyGraph) || analysis.dependencyGraph.length < 3) {
            semanticErrors.push(
                `dependencyGraph has ${analysis.dependencyGraph?.length ?? 0} entries (need ≥3). Did you actually walk the legacy import tree? READ the base class, every imported page, and every helper before re-submitting.`,
            );
        }

        // 2. configFiles must include at least one env-specific properties file.
        const hasEnvConfig = (analysis.configFiles ?? []).some((c) =>
            /env\.properties|envconfig|environment\.properties/i.test(c.path),
        );
        if (!hasEnvConfig) {
            semanticErrors.push(
                `configFiles[] is missing an env-specific properties file (e.g. resources/<env>/env.properties). READ it for URL + credentials before re-submitting.`,
            );
        }

        // 3. Locator source grounding — `inferred` only allowed if paired
        //    with a high-severity gap, never as the default.
        for (let pi = 0; pi < analysis.pages.length; pi++) {
            const page = analysis.pages[pi];
            const els = page.elements ?? [];
            for (let ei = 0; ei < els.length; ei++) {
                const src = els[ei].primaryLocator?.source;
                if (src === 'inferred') {
                    const hasGap = (analysis.gaps ?? []).some(
                        (g) => g.severity === 'high' && /locator|element|xpath/i.test(g.detail),
                    );
                    if (!hasGap) {
                        semanticErrors.push(
                            `pages[${pi}].elements[${ei}].primaryLocator.source is 'inferred' but no high-severity locator gap exists. Either ground it in a legacy file (source: 'legacy-file:<path>:<line>') or add a gaps[] entry explaining why grounding failed.`,
                        );
                    }
                }
            }
        }

        // 4. scenarios[].dataRow must be non-empty IF data files were
        //    discovered in step 4 (look at inventory).
        const inventoryRawForCheck = ctx.readPhaseArtifact('discover', 'inventory.json');
        const inventoryHasDataFiles = inventoryRawForCheck
            ? ((JSON.parse(inventoryRawForCheck) as { dataFiles?: string[] }).dataFiles?.length ?? 0) > 0
            : false;
        if (inventoryHasDataFiles) {
            const scenariosMissingData = analysis.scenarios.filter(
                (s) => !s.dataRow || Object.keys(s.dataRow).length === 0,
            );
            if (scenariosMissingData.length > 0) {
                semanticErrors.push(
                    `${scenariosMissingData.length} of ${analysis.scenarios.length} scenarios have empty dataRow{}, but the legacy project has data files. Use \`csaa_read_legacy_data\` on each data file and populate dataRow per scenarioId before re-submitting.`,
                );
            }
        }

        // 5. Reject "I admit I made this up" dataRow shapes. LLMs sometimes
        //    wrap fabricated rows in {originalKeyFound: false, sampleRow:
        //    {...}} or {synthesized: true, ...} to satisfy the schema while
        //    avoiding the work of reading the real xls. Treat these as
        //    high-severity gaps, not as valid data.
        const suspiciousMarkers = ['originalKeyFound', 'sampleRow', 'synthesized', 'hallucinated', 'placeholder', 'fabricated', 'guessed'];
        const suspiciousScenarios: Array<{ id: string; markers: string[] }> = [];
        for (const s of analysis.scenarios) {
            if (!s.dataRow) continue;
            const dr = s.dataRow as Record<string, unknown>;
            const hits = suspiciousMarkers.filter((m) => m in dr);
            // Also catch the case where the entire dataRow is a wrapper with
            // ONLY meta keys (originalKeyFound + sampleRow) instead of real columns.
            const realColumnCount = Object.keys(dr).filter(
                (k) => !suspiciousMarkers.includes(k),
            ).length;
            const hasFalseFlag = dr.originalKeyFound === false ||
                                 (dr as { synthesized?: boolean }).synthesized === true ||
                                 (dr as { hallucinated?: boolean }).hallucinated === true;
            if (hits.length > 0 && (hasFalseFlag || realColumnCount === 0)) {
                suspiciousScenarios.push({ id: s.id, markers: hits });
            }
        }
        if (suspiciousScenarios.length > 0) {
            const list = suspiciousScenarios.slice(0, 5).map(
                (s) => `  - scenario "${s.id}" dataRow contains [${s.markers.join(', ')}]`,
            ).join('\n');
            semanticErrors.push(
                `${suspiciousScenarios.length} scenario(s) have fabricated dataRow shapes (meta-fields like 'originalKeyFound:false' or 'sampleRow'):\n${list}\n\nThis pattern signals the LLM couldn't find the real row in the data file and invented one. Either:\n  a) Re-read the data file with csaa_read_legacy_data and use the ACTUAL row, OR\n  b) Add a high-severity gap describing the missing data row and leave dataRow as empty {}\n\nDo NOT wrap fake data in a 'sampleRow' envelope.`,
            );
        }

        // 6. `role: 'reuse-existing'` requires the existingFilePath to
        //    actually exist on disk. Without this check, the LLM marks
        //    pages as reuse-existing to skip emitting page-object files,
        //    even when nothing exists to reuse from.
        const consumerRoot = (() => {
            const rp = ctx.readPhaseArtifact('intake', 'run-params.json');
            if (!rp) return undefined;
            try {
                const r = JSON.parse(rp) as { entryFile?: string };
                if (!r.entryFile) return undefined;
                // Walk up from entryFile until we find a node_modules or .git folder.
                let dir = path.dirname(r.entryFile);
                for (let i = 0; i < 8; i++) {
                    if (fs.existsSync(path.join(dir, 'node_modules')) ||
                        fs.existsSync(path.join(dir, 'package.json'))) {
                        return dir;
                    }
                    const parent = path.dirname(dir);
                    if (parent === dir) break;
                    dir = parent;
                }
            } catch { /* ignore */ }
            return undefined;
        })();
        // Derive the project name for the test/<project>/pages/ check from
        // intake/run-params.json — same source the scaffold + write phases use.
        let projectForReuse: string | undefined;
        const rpForReuse = ctx.readPhaseArtifact('intake', 'run-params.json');
        if (rpForReuse) {
            try {
                const rp = JSON.parse(rpForReuse) as { project?: string };
                projectForReuse = rp.project;
            } catch { /* ignore */ }
        }
        const phantomReuseEntries: Array<{ index: number; className: string; path: string; reason: string }> = [];
        analysis.pages.forEach((p, i) => {
            const role = (p as { role?: string }).role;
            const existingFilePath = (p as { existingFilePath?: string }).existingFilePath;
            const className = (p as { className?: string }).className ?? `pages[${i}]`;
            if (role !== 'reuse-existing' && role !== 'extend-existing') return;
            if (!existingFilePath) {
                phantomReuseEntries.push({ index: i, className, path: '(no existingFilePath set)', reason: 'missing existingFilePath' });
                return;
            }
            // Reject pointers at legacy source folders or .java/.cs files —
            // 'reuse-existing' means an already-translated CS Playwright page
            // exists, NOT that the legacy file exists.
            const pathLower = existingFilePath.toLowerCase().replace(/\\/g, '/');
            if (pathLower.endsWith('.java') || pathLower.endsWith('.cs') || pathLower.endsWith('.cls')) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: 'points at legacy source file (.java/.cs); reuse-existing requires an already-translated .ts page',
                });
                return;
            }
            if (/(^|\/)legacy[^/]*\//i.test(pathLower) ||
                /(^|\/)src\/(main|test)\/java\//i.test(pathLower)) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: 'points inside a legacy source folder; reuse-existing requires the translated .ts under test/<project>/pages/',
                });
                return;
            }
            if (!pathLower.endsWith('.ts')) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: 'must point at a .ts file under test/<project>/pages/',
                });
                return;
            }
            // Path must live under test/<project>/pages/ (or the project tree).
            const expectedFragment = projectForReuse
                ? `test/${projectForReuse.toLowerCase()}/pages/`
                : '/pages/';
            if (!pathLower.includes(expectedFragment) && !pathLower.includes('/pages/')) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: `must live under ${expectedFragment}, not the path provided`,
                });
                return;
            }
            // Resolve against consumer root if relative.
            const abs = path.isAbsolute(existingFilePath)
                ? existingFilePath
                : (consumerRoot ? path.resolve(consumerRoot, existingFilePath) : existingFilePath);
            if (!fs.existsSync(abs)) {
                phantomReuseEntries.push({ index: i, className, path: existingFilePath, reason: 'file does not exist on disk' });
            }
        });
        if (phantomReuseEntries.length > 0) {
            const list = phantomReuseEntries.slice(0, 10).map(
                (e) => `  - pages[${e.index}] ("${e.className}") role=reuse-existing rejected: ${e.reason}. Path: ${e.path}`,
            ).join('\n');
            semanticErrors.push(
                `${phantomReuseEntries.length} page(s) marked 'reuse-existing' but the existingFilePath is invalid:\n${list}\n\n'reuse-existing' means "an already-translated CS Playwright page lives at this path, do not regenerate it" — the path MUST be an existing .ts file under test/<project>/pages/. Pointing at the legacy .java file (or any source-folder path) is wrong. If nothing translated exists yet, set role='create-new'.`,
            );
        }

        // 7. @Test count cross-check. The recorded scenarios should match
        //    the number of @Test (or [Test], [TestMethod]) annotations in
        //    the entry file. The LLM tends to silently drop scenarios it
        //    couldn't fully analyze.
        const runParamsRawForTestCount = ctx.readPhaseArtifact('intake', 'run-params.json');
        if (runParamsRawForTestCount) {
            try {
                const rp = JSON.parse(runParamsRawForTestCount) as { entryFile?: string };
                if (rp.entryFile && fs.existsSync(rp.entryFile)) {
                    const src = fs.readFileSync(rp.entryFile, 'utf-8');
                    // Match @Test (Java/TestNG/JUnit), [Test], [TestMethod] (C#/NUnit/MSTest).
                    // Strict: must be on its own line or preceded by whitespace, followed by either
                    // newline, opening paren, or the public/protected/private keyword.
                    const testAnnotPattern = /(^|\s)(@Test\b|\[Test\]|\[TestMethod\]|\[Fact\])/g;
                    const matches = src.match(testAnnotPattern) ?? [];
                    const declared = matches.length;
                    const captured = analysis.scenarios.length;
                    if (declared > captured && declared - captured >= 1) {
                        semanticErrors.push(
                            `Entry file declares ${declared} test method(s) (@Test / [Test] / [TestMethod] / [Fact] annotations) but analysis only captured ${captured} scenarios. ${declared - captured} test(s) were silently dropped — every legacy test must be represented as a scenario (or explicitly listed as a high-severity gap if it can't be analyzed).`,
                        );
                    }
                }
            } catch { /* non-fatal */ }
        }

        // 8. Column-shift detection in scenarios[].dataRow.
        //    The legacy xls extractor sometimes returns the HEADER row as
        //    data (e.g. {loginKey: "loginKey", userId: "userId"}). The
        //    LLM faithfully copies these strings instead of flagging them.
        //    Reject when ≥40% of values in a scenario's dataRow equal their
        //    own keys — that's a column-shift artifact, not real data.
        const headerShiftScenarios: Array<{ id: string; matchCount: number; total: number }> = [];
        for (const s of analysis.scenarios) {
            const dr = (s as { dataRow?: Record<string, unknown> }).dataRow;
            if (!dr || typeof dr !== 'object') continue;
            const entries = Object.entries(dr);
            const meta = new Set(['scenarioId', 'scenarioName', 'runFlag']);
            const real = entries.filter(([k]) => !meta.has(k));
            if (real.length < 3) continue;
            const headerMatches = real.filter(([k, v]) => typeof v === 'string' && v === k).length;
            if (headerMatches / real.length >= 0.4) {
                headerShiftScenarios.push({ id: s.id, matchCount: headerMatches, total: real.length });
            }
        }
        if (headerShiftScenarios.length > 0) {
            const list = headerShiftScenarios.slice(0, 5).map(
                (h) => `  - scenario "${h.id}" has ${h.matchCount}/${h.total} dataRow values equal to their own keys`,
            ).join('\n');
            semanticErrors.push(
                `${headerShiftScenarios.length} scenario(s) have column-shifted dataRow — the values are the COLUMN HEADER strings, not real data:\n${list}\n\nThis happens when the legacy xls has merged cells, a frozen pane, or the header row is at a different offset than xlsx assumed. Re-read the data file with csaa_read_legacy_data using a different row offset, OR for each affected scenario set dataRow to {} and add a high-severity gap describing the data extraction problem.`,
            );
        }

        // 9. Helper-method expansion. If a scenario step's legacyCite snippet
        //    invokes a helper class (anything ending in *SupportMethod /
        //    *Helper / *Util / *Service / *Factory) but the scenario has ≤2
        //    steps total (login + the helper invocation, with no expansion),
        //    the helper wasn't expanded. Helpers MUST be opened and their
        //    leaf actions inlined as Gherkin steps.
        // Method name can be either camelCase (foo) or PascalCase or
        // SHOUTING_SNAKE_CASE (legacy test-id style). Accept all three.
        const HELPER_CLASS_RE = /\b([A-Z][a-zA-Z0-9]*(?:SupportMethod|SupportMethods|Helper|Helpers|Util|Utils|Utility|Service|Factory|Manager|Provider))\b\s*\.\s*([A-Za-z_][a-zA-Z0-9_]*)\s*\(/;
        const unexpandedHelpers: Array<{ scenarioId: string; helperRef: string; stepCount: number }> = [];
        for (const s of analysis.scenarios) {
            const steps = (s as { steps?: Array<{ legacyCite?: { snippet?: string } }> }).steps ?? [];
            if (steps.length === 0) continue;
            const helperRefs = new Set<string>();
            for (const st of steps) {
                const snip = st.legacyCite?.snippet;
                if (!snip) continue;
                const m = snip.match(HELPER_CLASS_RE);
                if (m) helperRefs.add(m[1]);
            }
            if (helperRefs.size === 0) continue;
            // Tolerance: if scenario has at least (1 login step + 1 helper-ref + 3 real action steps)
            // we accept that helpers were partially expanded. Otherwise reject.
            const nonLoginSteps = steps.filter((st) => {
                const t = (st as { text?: string }).text ?? '';
                return !/^\s*(I\s+log\s+in|I\s+am\s+(?:logged\s+in|signed\s+in)|sign\s+in)/i.test(t);
            }).length;
            if (nonLoginSteps < 4) {
                unexpandedHelpers.push({
                    scenarioId: s.id,
                    helperRef: Array.from(helperRefs).join(', '),
                    stepCount: steps.length,
                });
            }
        }
        if (unexpandedHelpers.length > 0) {
            const list = unexpandedHelpers.slice(0, 5).map(
                (u) => `  - scenario "${u.scenarioId}" references helper(s) [${u.helperRef}] but has only ${u.stepCount} step(s)`,
            ).join('\n');
            semanticErrors.push(
                `${unexpandedHelpers.length} scenario(s) reference helper classes but the helper body was NOT expanded inline:\n${list}\n\nWhen a legacy test calls e.g. SomeHelper.someMethod(args), that helper does N internal actions (fill field A, fill field B, select option, click Save, ...). You MUST: (a) read the helper class file, (b) for each leaf action inside the helper method, emit ONE Gherkin step in this scenario's steps[] with legacyCite pointing at the helper file + line, (c) add the helper file to dependencyGraph. Do NOT emit a single "Execute shared support flow" / "Run helper" / "Invoke method" step — those stubs are rejected. If the helper file is genuinely unreadable, add a high-severity gap explaining why.`,
            );
        }

        // 10. Semantic verification against deterministic legacy signature.
        //     This is the gate that breaks the iteration loop. The LLM can
        //     no longer pass with thin output — every scenario's step count
        //     and every page class's presence are compared against the
        //     extracted signature.json. Threshold is 70% (lenient — the
        //     legacy extractor undercounts due to regex limits, and some
        //     legacy actions don't map 1:1 to Gherkin steps).
        const sigRawForCompare = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigRawForCompare) {
            try {
                const sig = JSON.parse(sigRawForCompare) as FullSignature;
                const COVERAGE_THRESHOLD = 0.70;

                // (a) Per-scenario step count vs legacy action count
                //     (including transitive helper expansion).
                const stepShortfall: Array<{
                    scenarioId: string;
                    legacyMethod: string;
                    legacyActions: number;
                    generatedSteps: number;
                    coverage: number;
                }> = [];
                for (const aScn of analysis.scenarios) {
                    // Match by testCaseId or by legacyMethodName.
                    const t = sig.tests.find((x) =>
                        (x.testCaseId && `TS_${x.testCaseId}` === aScn.id) ||
                        (x.testCaseId && x.testCaseId === aScn.id) ||
                        (x.testCaseId && aScn.id.endsWith(x.testCaseId)) ||
                        (x.methodName && (aScn as { legacyMethodName?: string }).legacyMethodName === x.methodName),
                    );
                    if (!t) continue;
                    const expected = CSLegacySignatureExtractor.expectedActionCount(t, sig.helpers);
                    if (expected < 3) continue; // skip trivially short legacy tests
                    const generated = ((aScn as { steps?: unknown[] }).steps ?? []).length;
                    const coverage = generated / expected;
                    if (coverage < COVERAGE_THRESHOLD) {
                        stepShortfall.push({
                            scenarioId: aScn.id,
                            legacyMethod: t.methodName,
                            legacyActions: expected,
                            generatedSteps: generated,
                            coverage,
                        });
                    }
                }
                if (stepShortfall.length > 0) {
                    const list = stepShortfall.slice(0, 6).map(
                        (s) => `  - scenario "${s.scenarioId}" (${s.legacyMethod}): ${s.generatedSteps}/${s.legacyActions} steps (${Math.round(s.coverage * 100)}% — floor 70%)`,
                    ).join('\n');
                    semanticErrors.push(
                        `${stepShortfall.length} scenario(s) have FAR fewer Gherkin steps than the legacy @Test does leaf actions (after helper expansion). The deterministic signature extractor counted the legacy floor:\n${list}\n\nThis is the #1 cause of "30% works" output. Fix by:\n  1. For each shortfall scenario, call csaa_expand_helper(runId, helperClass, helperMethod) for EVERY helper invocation in the legacy @Test body — it returns the ordered leaf actions inside the helper.\n  2. Emit ONE Gherkin step per returned action (cite the helper file + line in legacyCite).\n  3. Add all element interactions, validations, multi-step error paths the legacy test does.\n  4. Re-record analysis (or re-append affected scenarios via csaa_append_analysis_scenario).`,
                    );
                }

                // (b) Page-class coverage: every page class the entry file
                //     references must appear in analysis.pages[]. Missing
                //     pages = silent omission (e.g. UserSecurityPage skipped).
                const referencedPages = new Set<string>();
                for (const t of sig.tests) {
                    for (const c of t.pageClassesUsed) referencedPages.add(c);
                }
                for (const c of Object.keys(sig.pages)) referencedPages.add(c);
                const analysedPageClassNames = new Set(
                    (analysis.pages ?? []).map((p) => (p as { className: string }).className),
                );
                const missingPages: string[] = [];
                for (const c of referencedPages) {
                    // Tolerate suffix/case variation — the LLM sometimes
                    // renames a class like FooBarBazPage to FooBarBaz when
                    // emitting analysis entries. Check by stripping "Page"
                    // and lower-casing.
                    const normalised = (s: string) => s.toLowerCase().replace(/page$/i, '');
                    const target = normalised(c);
                    const hit = Array.from(analysedPageClassNames).some(
                        (a) => normalised(a) === target,
                    );
                    if (!hit) missingPages.push(c);
                }
                if (missingPages.length > 0) {
                    semanticErrors.push(
                        `Analysis omitted ${missingPages.length} page class(es) the legacy entry file references: ${missingPages.slice(0, 10).map((p) => `"${p}"`).join(', ')}${missingPages.length > 10 ? `, …${missingPages.length - 10} more` : ''}.\n\nEvery legacy page class used by the @Test methods must appear in analysis.pages[] — either as role=create-new (with elements pulled from the legacy file) or as role=reuse-existing (pointing at an already-translated .ts under test/<project>/pages/). For each missing class, call csaa_extract_page_fields(runId, pageClass) to get the authoritative field list, then add the page entry.`,
                    );
                }

                // (c) Per-page-object field-count floor for create-new pages.
                //     Each page declared in the analysis with role=create-new
                //     must have ≥80% of the legacy field count. The looser
                //     threshold acknowledges that some Java fields (labels,
                //     headers) translate to assertions not standalone elements.
                const fieldShortfall: Array<{
                    pageClass: string;
                    legacyFields: number;
                    generatedFields: number;
                    coverage: number;
                }> = [];
                for (const p of analysis.pages ?? []) {
                    const role = (p as { role?: string }).role;
                    if (role !== 'create-new') continue;
                    const className = (p as { className: string }).className;
                    // Match against signature.pages by class name (case-insensitive).
                    const sigPage = Object.values(sig.pages).find(
                        (sp) => sp.className.toLowerCase() === className.toLowerCase(),
                    );
                    if (!sigPage || sigPage.fields.length < 5) continue;
                    const elements = ((p as { elements?: unknown[] }).elements ?? []).length;
                    const coverage = elements / sigPage.fields.length;
                    if (coverage < 0.80) {
                        fieldShortfall.push({
                            pageClass: className,
                            legacyFields: sigPage.fields.length,
                            generatedFields: elements,
                            coverage,
                        });
                    }
                }
                if (fieldShortfall.length > 0) {
                    const list = fieldShortfall.slice(0, 6).map(
                        (f) => `  - page "${f.pageClass}": ${f.generatedFields}/${f.legacyFields} elements (${Math.round(f.coverage * 100)}% — floor 80%)`,
                    ).join('\n');
                    semanticErrors.push(
                        `${fieldShortfall.length} page object(s) have far fewer elements than the legacy class declares. Floor is 80% of legacy @FindBy count:\n${list}\n\nFor each shortfall page, call csaa_extract_page_fields(runId, pageClass) to get the authoritative @FindBy field list and emit a matching @CSGetElement for each one.`,
                    );
                }
            } catch { /* malformed signature — ignore, downstream still functional */ }
        }

        if (semanticErrors.length > 0) {
            ctx.writePhaseArtifact(
                'analyze',
                'semantic-errors.json',
                JSON.stringify(semanticErrors, null, 2),
            );
            // v1.38.5 — direct LLM to per-scenario replacement via append
            // (now supports overwrite when scratch exists) rather than to
            // a bulk record_analysis retry that risks the per-message cap.
            const scenarioScratchExists = ctx.readPhaseArtifact('analyze', 'scratch-scenarios.json') !== null;
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'analyze',
                    semanticErrors,
                    nextStepNeeded: true,
                    nextSuggestedTool: scenarioScratchExists ? 'csaa_append_analysis_scenario' : 'csaa_record_analysis',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `Analysis is shallow. ${semanticErrors.length} semantic error(s) found.\n\n` +
                        (scenarioScratchExists
                            ? `**DO NOT recompose all scenarios via csaa_record_analysis — that path hits the per-message length limit.**\n\nCorrection protocol:\n  1. Scratch at 03-analyze/scratch-scenarios.json holds all previously appended scenarios.\n  2. For each affected scenario, call csaa_append_analysis_scenario(runId, scenario) with corrected content — same id OVERWRITES the prior staged version (replacement mode).\n  3. When corrections are appended, call csaa_finalize_analysis(runId, payload) with the meta fields. Gates re-run on the full set.\n  4. DO NOT re-submit scenarios that already passed.\n`
                            : `**Use csaa_append_analysis_scenario instead — do NOT recompose the entire payload via csaa_record_analysis.**\n\nFor each legacy @Test, call csaa_append_analysis_scenario(runId, scenario) one at a time (~1-3 KB each). When all scenarios are staged, call csaa_finalize_analysis with the meta payload.\n`) +
                        `\nSpecific errors:\n${semanticErrors.map((e) => `  - ${e}`).join('\n')}`,
                },
                `Analysis rejected (${semanticErrors.length} semantic error(s)). Use csaa_append_analysis_scenario (replacement mode) — do NOT recompose bulk.`,
            );
        }

        ctx.writePhaseArtifact(
            'analyze',
            'analysis-report.json',
            JSON.stringify(analysis, null, 2),
        );

        const readinessScore = typeof analysis.readinessScore === 'number'
            ? analysis.readinessScore
            : 1.0;
        const highSeverityGaps = (analysis.gaps ?? []).filter((g) => g.severity === 'high').length;

        const md = renderAnalyzeMarkdown(analysis, readinessScore);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'analyze', 'Analysis Report', md,
        );

        // v1.38.3 — seed the translate queue BEFORE the readiness gate.
        // The translate queue items depend only on analysis.scenarios and
        // analysis.pages (which are present at this point regardless of
        // readiness score). Putting seeding before the gate guarantees the
        // iterator path is available even on BLOCKED_NEED_HUMAN — the user
        // may resolve gaps via fuzzy-match suggestions and proceed without
        // re-recording the full analysis.
        const seedResult = seedTranslateQueue(ctx, analysis as unknown as {
            scenarios: Array<{ id: string; steps?: Array<{ text?: string }> }>;
            pages: Array<{ className: string; role?: string }>;
        });
        // Surface seeding errors in the response (was silently swallowed
        // before — invisible failure dropped the LLM into the bulk path).

        // Gate: readinessScore < 0.7 OR ≥3 high-severity gaps → halt for user.
        if (readinessScore < 0.7 || highSeverityGaps >= 3) {
            ctx.finishPhase('analyze', 'blocked_user', {
                reason: `low readiness (${readinessScore.toFixed(2)}) or ${highSeverityGaps} high-severity gaps`,
                reportPath,
            });
            CSStatusWriter.write(ctx);

            // Surface fuzzy-match suggestions prominently so the user can
            // approve them in a single round-trip without a full re-analyze.
            const gapsWithSuggestions = (analysis.gaps ?? []).filter(
                (g) => typeof (g as { suggestedFuzzyMatch?: unknown }).suggestedFuzzyMatch === 'object',
            ) as Array<{
                detail: string;
                suggestedFuzzyMatch?: { from: string; to: string; confidence?: number; editDistance?: number };
            }>;
            const fuzzyLines = gapsWithSuggestions.map((g) =>
                `  • ${g.detail}\n    → Suggested: ${g.suggestedFuzzyMatch?.from} → ${g.suggestedFuzzyMatch?.to}` +
                (typeof g.suggestedFuzzyMatch?.confidence === 'number'
                    ? ` (confidence ${g.suggestedFuzzyMatch.confidence.toFixed(2)})`
                    : '') +
                (typeof g.suggestedFuzzyMatch?.editDistance === 'number'
                    ? `, edit distance ${g.suggestedFuzzyMatch.editDistance}`
                    : ''),
            );
            const fuzzyHint = fuzzyLines.length > 0
                ? `\n\nFuzzy-match suggestions (likely OCR typos — confirm or reject each):\n${fuzzyLines.join('\n')}\n\nTo accept all suggestions in one round-trip, reply: "Accept all fuzzy matches and re-record analysis." The LLM will rewrite the analysis with each from→to applied globally and clear the corresponding gaps[] entries.`
                : '';

            return jsonResult(
                {
                    state: 'BLOCKED_NEED_HUMAN',
                    runId,
                    phase: 'analyze',
                    readinessScore,
                    highSeverityGaps,
                    gaps: analysis.gaps ?? [],
                    fuzzyMatchSuggestions: gapsWithSuggestions.map((g) => g.suggestedFuzzyMatch),
                    runFolder: ctx.runFolder,
                    reportPath,
                    translateQueueSeeded: seedResult.seeded,
                    translateQueueLength: seedResult.length,
                    translateQueueSeedError: seedResult.error,
                    nextStepNeeded: true,
                    blockedReason: `Readiness ${readinessScore.toFixed(2)} below 0.7 threshold or ${highSeverityGaps} high-severity gaps. Resolve in source / provide missing files, then re-run csaa_analyze.${fuzzyHint}`,
                },
                `Analysis blocked: readiness ${readinessScore.toFixed(2)}, ${highSeverityGaps} high gaps${fuzzyLines.length ? ` (${fuzzyLines.length} with fuzzy suggestions)` : ''}.`,
            );
        }

        ctx.finishPhase('analyze', 'done', { reportPath });
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'analyze',
                scenarioCount: analysis.scenarios.length,
                pageCount: analysis.pages.length,
                readinessScore,
                gapCount: (analysis.gaps ?? []).length,
                runFolder: ctx.runFolder,
                reportPath,
                translateQueueSeeded: seedResult.seeded,
                translateQueueLength: seedResult.length,
                translateQueueSeedError: seedResult.error,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_plan',
                nextSuggestedArgs: { runId },
            },
            `Analysis recorded: ${analysis.scenarios.length} scenarios, ${analysis.pages.length} pages, readiness ${readinessScore.toFixed(2)}. Translate queue: ${seedResult.length} items${seedResult.error ? ` (SEEDING ERROR: ${seedResult.error})` : ''}. Call csaa_plan next.`,
        );
    })
    .build();

/**
 * Extracted helper (v1.38.3). Seeds the translate queue from a recorded
 * analysis. Returns the result inline so callers can surface seeding
 * failures in the tool response — earlier versions wrapped the body in a
 * silent try/catch and dropped errors to disk, which left the LLM with no
 * signal that the queue was empty (it would invisibly fall back to the
 * bulk envelope and hit the per-message length limit). Called from BOTH
 * the success and BLOCKED_NEED_HUMAN paths in csaa_record_analysis so the
 * iterator stays available even when readiness < 0.7.
 */
function seedTranslateQueue(
    ctx: CSRunContext,
    analysis: {
        scenarios: Array<{ id: string; steps?: Array<{ text?: string }> }>;
        pages: Array<{ className: string; role?: string }>;
    },
): { seeded: boolean; length: number; error?: string } {
    try {
        let project = 'default';
        let module = 'default';
        const rp = ctx.readPhaseArtifact('intake', 'run-params.json');
        if (rp) {
            try {
                const p = JSON.parse(rp) as { project?: string; module?: string };
                project = p.project ?? project;
                module = p.module ?? p.project ?? module;
            } catch { /* ignore */ }
        }
        const sigRaw = ctx.readPhaseArtifact('discover', 'signature.json');
        let sigPages: Record<string, { fields?: unknown[] }> = {};
        if (sigRaw) {
            try {
                const sig = JSON.parse(sigRaw) as { pages?: Record<string, { fields?: unknown[] }> };
                sigPages = sig.pages ?? {};
            } catch { /* ignore */ }
        }
        const items = buildTranslateQueueItems({ project, module, analysis, sigPages });
        const queue = CSWorkQueue.load(ctx);
        queue.seedTranslate(items);
        return { seeded: items.length > 0, length: items.length };
    } catch (qErr) {
        const msg = qErr instanceof Error ? qErr.message : String(qErr);
        ctx.writePhaseArtifact(
            'analyze',
            'translate-queue-seed-error.txt',
            qErr instanceof Error ? (qErr.stack ?? qErr.message) : String(qErr),
        );
        return { seeded: false, length: 0, error: msg };
    }
}

/**
 * Build the translate-queue items from a recorded analysis. Items shape:
 *   1× feature (lists every scenarioId so the feature file has one
 *      `Scenario:` block per legacy @Test)
 *   1× steps (collects unique step-def texts from analysis.scenarios.steps)
 *   N× page (one per analysis.pages[] with role === 'create-new'; reuse-existing
 *      pages are skipped — the consumer already has them)
 *   1× data (lists every scenarioId so the JSON has one row per scenario)
 */
/**
 * Categorise a Gherkin step text into one of three buckets — used by
 * the steps-file semantic naming logic. Single-pass, leading-verb match.
 */
function categoriseStepText(text: string): 'navigation' | 'actions' | 'validations' {
    const t = text.trim();
    // Strip leading Gherkin keyword if present (Given/When/Then/And/But).
    const body = t.replace(/^(?:Given|When|Then|And|But)\s+/i, '').toLowerCase();

    // Validation verbs first — they're the most distinctive.
    if (/^i\s+(see|verify|check|expect|confirm|assert|observe|notice|should|shouldn't|don't see|cannot see|am able to see|am unable to)/.test(body)) {
        return 'validations';
    }
    if (/^(the\s+)?(\w+\s+)?(is|should be|must be|are|appears|appear|displays|displayed|shown|visible|hidden|enabled|disabled|present|absent|matches|equals|contains)\b/.test(body)) {
        return 'validations';
    }
    // Navigation verbs.
    if (/^i\s+(navigate|open|go to|return to|switch to|sign in|sign out|log in|log out|click\s+(?:the\s+)?(?:menu|tab|link|breadcrumb|nav)|access|launch)/.test(body)) {
        return 'navigation';
    }
    // Everything else is an action (fill / select / save / submit / upload / etc.).
    return 'actions';
}

/**
 * Detect well-known common/shared-component page class names so they
 * route to `test/<project>/pages/common/` instead of being duplicated
 * under every module's `pages/<module>/` folder.
 */
function isCommonPageClass(className: string): boolean {
    const n = className.toLowerCase();
    // Exact-name commons (handles Login, Logout, Header, Footer, etc. as suffixes).
    const commonNames = [
        'login', 'logout', 'signin', 'signout', 'authentication', 'auth',
        'header', 'footer', 'navigation', 'navbar', 'sidebar', 'topbar', 'menu',
        'toast', 'modal', 'dialog', 'popup', 'notification', 'alert',
        'grid', 'table', 'form', 'datepicker', 'combobox', 'dropdown',
        'breadcrumb', 'pagination', 'spinner', 'loader', 'layout',
    ];
    // Match if className contains any of the common-name tokens as a word
    // (e.g. "LoginPage", "MainHeader", "OrderGrid", "ConfirmDialog").
    for (const token of commonNames) {
        // Word-boundary check on lowered className.
        const re = new RegExp(`(^|[a-z])${token}(page|component|widget|view|panel|$|[A-Z])`, 'i');
        if (re.test(className)) return true;
    }
    // Generic suffixes always-common.
    if (/(Component|Widget|Layout)s?$/i.test(className)) return true;
    if (/^(Common|Shared|Base|Global)/i.test(className)) return true;
    return false;
}

function buildTranslateQueueItems(opts: {
    project: string;
    module: string;
    analysis: {
        scenarios: Array<{ id: string; steps?: Array<{ text?: string }> }>;
        pages: Array<{ className: string; role?: string }>;
    };
    sigPages: Record<string, { fields?: unknown[] }>;
}): TranslateQueueItem[] {
    const { project, module, analysis, sigPages } = opts;
    const items: TranslateQueueItem[] = [];

    // v1.38.3 — defensive guards. Previous code threw `undefined.map()` if
    // analysis.scenarios or analysis.pages were undefined/null, and the
    // outer try/catch silently swallowed the exception → seedTranslate
    // never ran → csaa_translate fell back to the bulk envelope path
    // invisibly. Now produces a clear error the seeder surfaces in its
    // return value.
    if (!Array.isArray(analysis?.scenarios)) {
        throw new Error(
            `analysis.scenarios must be an array (got ${typeof analysis?.scenarios}). ` +
            `Cannot seed translate queue without scenario list.`,
        );
    }
    if (!Array.isArray(analysis?.pages)) {
        throw new Error(
            `analysis.pages must be an array (got ${typeof analysis?.pages}). ` +
            `Cannot seed translate queue without page list.`,
        );
    }

    const scenarioIds = analysis.scenarios.map((s) => s.id);
    const baseDir = (kind: 'features' | 'steps' | 'pages' | 'data') =>
        `test/${project}/${kind}/${module}`;

    // 1× feature
    items.push({
        kind: 'feature',
        relativePath: `${baseDir('features')}/${module}.feature`,
        scenarioIds,
    });

    // STEPS FILES — split when needed using SEMANTIC GROUPING.
    //
    // A single .steps.ts with 80-120 unique step-def patterns easily exceeds
    // 15-25 KB which itself approaches the per-message output cap. We split
    // when stepDefTexts.size > MAX_STEPS_PER_FILE.
    //
    // SEMANTIC NAMING: instead of mechanical -1/-2 suffixes, we categorise
    // each step-def into one of three buckets based on its leading verb:
    //   - navigation   (open / navigate / go to / click menu / select tab / sign in)
    //   - actions      (fill / type / enter / select / save / submit / upload / etc.)
    //   - validations  (see / verify / assert / check / expect / confirm / observe)
    // Files are named `<module>.actions.steps.ts`,
    // `<module>.validations.steps.ts`, etc. If a bucket exceeds the cap, it
    // sub-splits within its category (`<module>.actions-1.steps.ts`,
    // `<module>.actions-2.steps.ts`).
    const MAX_STEPS_PER_FILE = 80;
    const stepDefTexts = new Set<string>();
    for (const s of analysis.scenarios) {
        for (const st of s.steps ?? []) {
            if (typeof st.text === 'string' && st.text.trim()) {
                stepDefTexts.add(st.text.trim());
            }
        }
    }
    const allSteps = [...stepDefTexts];
    if (allSteps.length <= MAX_STEPS_PER_FILE) {
        items.push({
            kind: 'steps',
            relativePath: `${baseDir('steps')}/${module}.steps.ts`,
            stepDefTexts: allSteps,
        });
    } else {
        // Categorise by step verb.
        const buckets: Record<'navigation' | 'actions' | 'validations', string[]> = {
            navigation: [], actions: [], validations: [],
        };
        for (const step of allSteps) {
            buckets[categoriseStepText(step)].push(step);
        }
        // Each non-empty bucket emits one or more files (sub-split if oversize).
        for (const [category, steps] of Object.entries(buckets)) {
            if (steps.length === 0) continue;
            if (steps.length <= MAX_STEPS_PER_FILE) {
                items.push({
                    kind: 'steps',
                    relativePath: `${baseDir('steps')}/${module}.${category}.steps.ts`,
                    stepDefTexts: steps,
                });
            } else {
                const chunkCount = Math.ceil(steps.length / MAX_STEPS_PER_FILE);
                for (let i = 0; i < chunkCount; i++) {
                    const chunk = steps.slice(
                        i * MAX_STEPS_PER_FILE,
                        (i + 1) * MAX_STEPS_PER_FILE,
                    );
                    items.push({
                        kind: 'steps',
                        relativePath: `${baseDir('steps')}/${module}.${category}-${i + 1}.steps.ts`,
                        stepDefTexts: chunk,
                    });
                }
            }
        }
    }

    // N× page — one per create-new analysis page. COMMON-PAGE ROUTING:
    // pages whose class name matches a well-known shared-component pattern
    // (Login / Header / Footer / Nav / Menu / Modal / Dialog / Toast /
    // Grid / Table / Form / Component suffix etc.) route to
    // `test/<project>/pages/common/`. Module-specific pages stay under
    // `test/<project>/pages/<module>/`. Without this, common pages get
    // duplicated into every module folder.
    for (const p of analysis.pages) {
        if (p.role !== 'create-new') continue;
        const sig = sigPages[p.className];
        const legacyFieldCount = Array.isArray(sig?.fields) ? sig!.fields!.length : 0;
        // 80% floor from the page-coverage gate; minimum 1 so even an
        // empty signature page produces an item.
        const minFieldCount = Math.max(1, Math.ceil(legacyFieldCount * 0.8));
        const isCommon = isCommonPageClass(p.className);
        const pageDir = isCommon
            ? `test/${project}/pages/common`
            : `test/${project}/pages/${module}`;
        items.push({
            kind: 'page',
            relativePath: `${pageDir}/${p.className}.ts`,
            legacyClassName: p.className,
            minFieldCount,
        });
    }

    // 1× data
    items.push({
        kind: 'data',
        relativePath: `${baseDir('data')}/${module}-scenarios.json`,
        scenarioIds,
    });

    return items;
}

// ============================================================================
// csaa_append_analysis_scenario — chunked recording (one scenario at a time)
// ============================================================================
// VS Code Copilot's per-message output cap forces large analyses (>3 scenarios
// with deep step lists) to be streamed in chunks. Each append call carries
// one scenario payload (~1–3 KB) so individual tool turns never blow the
// output budget. Once all scenarios are staged, the caller invokes
// csaa_finalize_analysis with the rest of the analysis JSON; that tool
// reads the staged scenarios from the scratch file and re-dispatches into
// csaa_record_analysis so gate logic stays single-sourced.

const csaa_append_analysis_scenario: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_append_analysis_scenario')
    .title('CS-AI-Auto-Assist — Append one analysis scenario (chunked)')
    .description(
        'Streams ONE scenario into the analyze scratch file. Use this whenever the full ' +
            'analysis JSON would exceed Copilot per-message output limits (4+ scenarios with full ' +
            'step detail is a safe threshold). Validate the scenario subset against ' +
            'ANALYSIS_SCHEMA.scenarios[]. When every legacy @Test has been appended, call ' +
            'csaa_finalize_analysis with the remaining fields (source/feature/pages/dependencyGraph/' +
            'configFiles/loginContract/gaps/readinessScore — NO scenarios). The scratch file ' +
            'survives conversation compaction.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'scenario',
        'REQUIRED. One scenario object matching ANALYSIS_SCHEMA.scenarios[]. Required keys: id, title, runFlag, steps[]. Each step needs keyword/text/legacyCite. Include dataRow when a legacy data file exists.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const scenario = params.scenario;
        if (typeof scenario !== 'object' || scenario === null) {
            return errorResult(`scenario must be an object`, runId);
        }

        // Schema-validate the scenario subset.
        const scenarioSchema = (
            ANALYSIS_SCHEMA as {
                properties?: { scenarios?: { items?: Record<string, unknown> } };
            }
        ).properties?.scenarios?.items;
        if (scenarioSchema) {
            const errors = CSSchemaValidator.validate(scenario, scenarioSchema);
            if (errors.length > 0) {
                return jsonResult(
                    {
                        state: 'AWAITING_LLM_RETRY',
                        runId,
                        phase: 'analyze',
                        validationErrors: errors,
                        nextStepNeeded: true,
                        nextSuggestedTool: 'csaa_append_analysis_scenario',
                        feedback: `Scenario failed schema validation. Fix and re-call csaa_append_analysis_scenario:\n${errors.slice(0, 8).map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
                    },
                    `Scenario validation failed (${errors.length} error(s)).`,
                );
            }
        }

        const scratchRaw = ctx.readPhaseArtifact('analyze', 'scratch-scenarios.json');
        const list: unknown[] = scratchRaw ? JSON.parse(scratchRaw) : [];
        const id = (scenario as { id?: string }).id ?? `[${list.length}]`;

        // v1.38.5 — REPLACEMENT MODE. Pre-seal (no analysis-report.json),
        // duplicate ids are an EXPECTED retry path after semantic-gate
        // rejection (e.g. step-coverage shortfall on scenario X). The LLM
        // should be able to re-append scenario X with corrections without
        // having to discard the rest of the queue. The post-finalize seal
        // higher up catches post-seal corrections.
        const dupIdx = list.findIndex((s) => (s as { id?: string }).id === id);
        const isReplacement = dupIdx >= 0;
        if (isReplacement) {
            list[dupIdx] = scenario;
        } else {
            list.push(scenario);
        }
        ctx.writePhaseArtifact(
            'analyze',
            'scratch-scenarios.json',
            JSON.stringify(list, null, 2),
        );

        // v1.38 Phase 3 — advance the iterator queue (if seeded) and
        // return the NEXT item's envelope. The LLM never has to "decide"
        // what to produce next: this response either carries the spec
        // for scenario N+1 or the spec for the finalize meta call.
        // Fallback: queue not seeded (non-Java legacy or run that
        // bypassed signature extraction) → return the legacy
        // RUNNING shape so the LLM's recoveryHint guides them.
        const queue = CSWorkQueue.load(ctx);
        if (queue.total('analyze') > 0) {
            // Find this scenario's position in the queue. The id format
            // may be normalised by the queue seeder (TC_-prefixed) so
            // match permissively.
            const itemsBefore = queue.snapshot().analyze.items;
            const cur = queue.peekNext('analyze') as AnalyzeQueueItem | null;
            let advanced = false;
            if (cur && itemMatchesScenarioId(cur, id)) {
                queue.advance('analyze');
                advanced = true;
            }

            // Read intake/run-params.json + signature.json (best-effort) so
            // the next-item envelope carries the same common grounding.
            let project = 'default';
            let module: string | undefined;
            let entryFile = '';
            const rpRaw = ctx.readPhaseArtifact('intake', 'run-params.json');
            if (rpRaw) {
                try {
                    const rp = JSON.parse(rpRaw) as { project?: string; module?: string; entryFile?: string };
                    project = rp.project ?? project;
                    module = rp.module;
                    entryFile = rp.entryFile ?? '';
                } catch { /* ignore */ }
            }
            const inventoryPath = path.join(
                ctx.runFolder,
                CSRunContext.phaseFolder('discover'),
                'inventory.json',
            );
            const common: AnalyzeIteratorCommonGrounding = {
                runId,
                project,
                module,
                entryFile,
                inventoryPath,
                skillsPath: '.github/skills/',
            };

            const nextItem = queue.peekNext('analyze') as AnalyzeQueueItem | null;
            if (nextItem) {
                const env = buildAnalyzeScenarioEnvelope(
                    nextItem,
                    { completed: queue.completed('analyze'), total: queue.total('analyze') },
                    common,
                );
                ctx.writePhaseArtifact(
                    'analyze',
                    'delegation-envelope.json',
                    JSON.stringify(env, null, 2),
                );
                return jsonResult(
                    {
                        state: 'AWAITING_LLM_FULFILMENT',
                        runId,
                        phase: 'analyze',
                        scenariosCollected: list.length,
                        lastAppended: id,
                        delegation: env,
                        queue: {
                            current: queue.completed('analyze') + 1,
                            total: queue.total('analyze'),
                            progress: queue.progress('analyze'),
                        },
                        iteratorMode: true,
                        queueAdvanced: advanced,
                        nextStepNeeded: true,
                        nextSuggestedTool: 'csaa_append_analysis_scenario',
                        nextSuggestedArgs: { runId },
                    },
                    `Scenario "${id}" staged (${list.length}/${queue.total('analyze')}). Next: produce scenario ${queue.completed('analyze') + 1}/${queue.total('analyze')} (${nextItem.id}). Submit via csaa_append_analysis_scenario.`,
                );
            }
            // v1.38.2 — scenarios drained. If the pages sub-queue is non-
            // empty, transition to per-page envelopes BEFORE the meta
            // finalize. Each page goes via csaa_append_analysis_page so
            // the payload stays small even when the legacy module has
            // 6+ page classes with 30+ elements each.
            if (!queue.isEmpty('analyzePages')) {
                const firstPage = queue.peekNext('analyzePages') as AnalyzePageQueueItem;
                const pageEnv = buildAnalyzePageEnvelope(
                    firstPage,
                    { completed: queue.completed('analyzePages'), total: queue.total('analyzePages') },
                    common,
                );
                ctx.writePhaseArtifact(
                    'analyze',
                    'delegation-envelope.json',
                    JSON.stringify(pageEnv, null, 2),
                );
                void itemsBefore;
                return jsonResult(
                    {
                        state: 'AWAITING_LLM_FULFILMENT',
                        runId,
                        phase: 'analyze',
                        scenariosCollected: list.length,
                        lastAppended: id,
                        delegation: pageEnv,
                        queue: {
                            current: queue.completed('analyzePages') + 1,
                            total: queue.total('analyzePages'),
                            progress: queue.progress('analyzePages'),
                            phase: 'analyzePages',
                        },
                        iteratorMode: true,
                        queueAdvanced: advanced,
                        nextStepNeeded: true,
                        nextSuggestedTool: 'csaa_append_analysis_page',
                        nextSuggestedArgs: { runId },
                    },
                    `All ${list.length} scenario(s) staged. Next: produce analysis page 1/${queue.total('analyzePages')} (${firstPage.className}). Submit via csaa_append_analysis_page.`,
                );
            }
            // Queue drained AND no pages sub-queue — emit the meta finalize.
            const finalizeEnv = buildAnalyzeFinalizeEnvelope(list.length, common);
            ctx.writePhaseArtifact(
                'analyze',
                'delegation-envelope.json',
                JSON.stringify(finalizeEnv, null, 2),
            );
            // Suppress unused-var warning when fallback above doesn't fire.
            void itemsBefore;
            return jsonResult(
                {
                    state: 'AWAITING_LLM_FULFILMENT',
                    runId,
                    phase: 'analyze',
                    scenariosCollected: list.length,
                    lastAppended: id,
                    delegation: finalizeEnv,
                    queue: {
                        current: queue.total('analyze'),
                        total: queue.total('analyze'),
                        progress: queue.progress('analyze'),
                    },
                    iteratorMode: true,
                    queueAdvanced: advanced,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_finalize_analysis',
                    nextSuggestedArgs: { runId },
                },
                `All ${list.length} scenario(s) staged. Now produce the analysis meta payload and call csaa_finalize_analysis.`,
            );
        }

        // Backward compat: queue not seeded. Return the original
        // RUNNING shape so the legacy recoveryHint guides the LLM.
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'analyze',
                scenariosCollected: list.length,
                lastAppended: id,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_append_analysis_scenario',
                recoveryHint: 'If the conversation was compacted, your scenarios so far live at analyze/scratch-scenarios.json under the run folder. Continue with the next legacy @Test method, or call csaa_finalize_analysis when done.',
            },
            `Scenario "${id}" appended (${list.length} staged).`,
        );
    })
    .build();

/**
 * Match a queue item against a submitted scenario id. The queue seeder
 * normalises testCaseId via `TC_<id>` (or preserves `TS_<id>` from legacy
 * @MetaData) but the LLM may submit the bare id. Match permissively.
 */
function itemMatchesScenarioId(item: AnalyzeQueueItem, submittedId: string): boolean {
    if (item.id === submittedId) return true;
    if (item.id === `TC_${submittedId}`) return true;
    if (`TC_${item.id}` === submittedId) return true;
    if (item.id.replace(/^(TC|TS)_/, '') === submittedId.replace(/^(TC|TS)_/, '')) return true;
    return false;
}

// ============================================================================
// csaa_append_analysis_page — chunked recording (one page at a time)  v1.38.2
// ============================================================================
// Pages with many @CSGetElement entries + legacy-file:<path>:<line> citations
// blow VS Code Copilot's per-message output cap when bundled into a single
// csaa_finalize_analysis payload. This tool stages ONE page per call to
// scratch-pages.json — symmetric with csaa_append_analysis_scenario.

const csaa_append_analysis_page: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_append_analysis_page')
    .title('CS-AI-Auto-Assist — Append one analysis page (chunked)')
    .description(
        'Streams ONE analysis.pages[i] entry to the page scratch file. Use whenever the ' +
            'finalize-analysis payload would exceed Copilot per-message output limits ' +
            '(any page with 15+ elements + legacy-file: citations is a safe threshold). ' +
            'Validate against ANALYSIS_SCHEMA.pages[]. When every signature page class has ' +
            'been appended, the response carries the meta-finalize envelope; call ' +
            'csaa_finalize_analysis with the small remaining fields (source/feature/' +
            'dependencyGraph/configFiles/loginContract/gaps/readinessScore). Scratch survives ' +
            'conversation compaction.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID from cs_ai_auto_assist', { required: true })
    .objectParam(
        'page',
        'REQUIRED. One page object matching ANALYSIS_SCHEMA.pages[]: { className, role: "create-new"|"reuse-existing", reuseTargetPath?, elements: [{ name, primaryLocator: { strategy, value, source }, alternativeLocators? }, ...] }.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const page = params.page;
        if (typeof page !== 'object' || page === null) {
            return errorResult(`page must be an object`, runId);
        }
        const p = page as Record<string, unknown>;
        const className = typeof p.className === 'string' ? p.className : '';
        const role = typeof p.role === 'string' ? p.role : '';
        const elements = Array.isArray(p.elements) ? p.elements : null;
        if (!className) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    feedback: `page.className required. Use the legacy class name from the queue currentItem.`,
                },
                'page.className missing',
            );
        }
        if (role !== 'create-new' && role !== 'reuse-existing') {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    feedback: `page.role must be "create-new" or "reuse-existing" (got ${JSON.stringify(role)}).`,
                },
                'page.role invalid',
            );
        }
        if (!elements) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    feedback: `page.elements must be an array. For reuse-existing pages with no elements, pass [].`,
                },
                'page.elements missing',
            );
        }

        const scratchRaw = ctx.readPhaseArtifact('analyze', 'scratch-pages.json');
        const list: Record<string, unknown>[] = scratchRaw ? JSON.parse(scratchRaw) : [];
        // v1.38.5 — REPLACEMENT MODE for pages (symmetric to scenarios).
        // Allow overwriting prior staged page when analysis-report.json
        // doesn't exist yet (post-seal re-entry blocked higher up).
        const pageDupIdx = list.findIndex((x) => x.className === className);
        const pageIsReplacement = pageDupIdx >= 0;
        if (pageIsReplacement) {
            list[pageDupIdx] = { ...p };
        } else {
            list.push({ ...p });
        }
        ctx.writePhaseArtifact('analyze', 'scratch-pages.json', JSON.stringify(list, null, 2));

        // Advance the pages queue. Permissive match: case-insensitive
        // className stem comparison (LLM may submit the class with
        // different casing).
        const queue = CSWorkQueue.load(ctx);
        let advanced = false;
        if (queue.total('analyzePages') > 0) {
            const cur = queue.peekNext('analyzePages') as AnalyzePageQueueItem | null;
            if (cur && cur.className.toLowerCase() === className.toLowerCase()) {
                queue.advance('analyzePages');
                advanced = true;
            }
        }

        // Rebuild common grounding for the next envelope. We need entryFile
        // + inventory path + project info — pull from intake/run-params and
        // the prior analyze envelope.
        let project = 'default';
        let module: string | undefined;
        let entryFile = '';
        const rpRaw = ctx.readPhaseArtifact('intake', 'run-params.json');
        if (rpRaw) {
            try {
                const rp = JSON.parse(rpRaw) as { project?: string; module?: string; entryFile?: string };
                project = rp.project ?? project;
                module = rp.module;
                entryFile = rp.entryFile ?? '';
            } catch { /* ignore */ }
        }
        const prevEnvRaw = ctx.readPhaseArtifact('analyze', 'delegation-envelope.json');
        if (prevEnvRaw) {
            try {
                const prev = JSON.parse(prevEnvRaw) as { grounding?: { entryFile?: string; project?: string; module?: string } };
                if (prev.grounding?.entryFile && !entryFile) entryFile = prev.grounding.entryFile;
                if (prev.grounding?.project) project = prev.grounding.project;
                if (prev.grounding?.module) module = prev.grounding.module;
            } catch { /* ignore */ }
        }
        const inventoryPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('discover'),
            'inventory.json',
        );
        const common: AnalyzeIteratorCommonGrounding = {
            runId,
            project,
            module,
            entryFile,
            inventoryPath,
            skillsPath: '.github/skills/',
        };

        // Next page → emit per-page envelope. Last page drained → meta
        // finalize envelope.
        const nextPage = queue.peekNext('analyzePages') as AnalyzePageQueueItem | null;
        if (nextPage) {
            const env = buildAnalyzePageEnvelope(
                nextPage,
                { completed: queue.completed('analyzePages'), total: queue.total('analyzePages') },
                common,
            );
            ctx.writePhaseArtifact('analyze', 'delegation-envelope.json', JSON.stringify(env, null, 2));
            return jsonResult(
                {
                    state: 'AWAITING_LLM_FULFILMENT',
                    runId,
                    phase: 'analyze',
                    pagesCollected: list.length,
                    lastAppended: className,
                    delegation: env,
                    queue: {
                        current: queue.completed('analyzePages') + 1,
                        total: queue.total('analyzePages'),
                        progress: queue.progress('analyzePages'),
                        phase: 'analyzePages',
                    },
                    iteratorMode: true,
                    queueAdvanced: advanced,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_analysis_page',
                    nextSuggestedArgs: { runId },
                },
                `Page "${className}" staged (${list.length}/${queue.total('analyzePages')}). Next: produce analysis page ${queue.completed('analyzePages') + 1}/${queue.total('analyzePages')} (${nextPage.className}).`,
            );
        }
        // Pages queue drained — meta finalize envelope.
        const finalizeEnv = buildAnalyzeFinalizeEnvelope(
            // Pull staged scenarios count from scratch-scenarios.json if
            // present — used only for the instruction text.
            (() => {
                try {
                    const r = ctx.readPhaseArtifact('analyze', 'scratch-scenarios.json');
                    if (!r) return 0;
                    const arr = JSON.parse(r);
                    return Array.isArray(arr) ? arr.length : 0;
                } catch { return 0; }
            })(),
            common,
        );
        ctx.writePhaseArtifact('analyze', 'delegation-envelope.json', JSON.stringify(finalizeEnv, null, 2));
        return jsonResult(
            {
                state: 'AWAITING_LLM_FULFILMENT',
                runId,
                phase: 'analyze',
                pagesCollected: list.length,
                lastAppended: className,
                delegation: finalizeEnv,
                queue: {
                    current: queue.total('analyzePages'),
                    total: queue.total('analyzePages'),
                    progress: queue.progress('analyzePages'),
                    phase: 'analyzePages',
                },
                iteratorMode: true,
                queueAdvanced: advanced,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_finalize_analysis',
                nextSuggestedArgs: { runId },
            },
            `All ${list.length} page(s) staged. Now produce the meta payload and call csaa_finalize_analysis.`,
        );
    })
    .build();

// ============================================================================
// csaa_finalize_analysis — close-out of streamed analysis recording
// ============================================================================

const csaa_finalize_analysis: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_finalize_analysis')
    .title('CS-AI-Auto-Assist — Finalize streamed analysis (Phase 3 completion)')
    .description(
        'Companion to csaa_append_analysis_scenario. Pass the non-scenario portion of ' +
            'the analysis ({ source, feature, pages, dependencyGraph, configFiles, loginContract, ' +
            'gaps, readinessScore }) — scenarios come from the scratch file built up by ' +
            'csaa_append_analysis_scenario. Internally dispatches into csaa_record_analysis ' +
            'so every gate (semantic + readiness + locator-source + reuse-existing + count match + ' +
            'fabricated-row + fuzzy-match) fires exactly as if you had submitted one big payload.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'payload',
        'REQUIRED. The non-scenario portion of the analysis: { source, feature, pages, dependencyGraph, configFiles, loginContract, gaps, readinessScore }. Do NOT include `scenarios` — they are loaded from the scratch file.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>, toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const meta = params.payload;
        if (typeof meta !== 'object' || meta === null) {
            return errorResult(`payload must be an object`, runId);
        }

        // v1.38.5 — cap the meta payload size. After scenarios + pages
        // moved to scratch (v1.38.2), the meta should be ~1-3 KB. If it
        // exceeds 8 KB the LLM is doing something wrong (e.g. embedding
        // huge dependencyGraph or pasting all gaps with verbose suggestions).
        // Reject early so the LLM splits or trims before recomposing.
        const META_BYTE_CAP = 8 * 1024;
        const metaBytes = JSON.stringify(meta).length;
        if (metaBytes > META_BYTE_CAP) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'analyze',
                    metaBytes,
                    capBytes: META_BYTE_CAP,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_finalize_analysis',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `csaa_finalize_analysis meta payload is ${metaBytes} bytes — exceeds the ${Math.round(META_BYTE_CAP / 1024)} KB cap. ` +
                        `The meta should be ~1-3 KB (source + feature + dependencyGraph + configFiles + loginContract + gaps + readinessScore). ` +
                        `If it's larger, most likely cause:\n` +
                        `  - dependencyGraph has >50 entries (cap it at the most relevant ~10 files: entry + base classes + page objects directly used + helpers expanded)\n` +
                        `  - gaps[].suggestedFuzzyMatch has verbose alternatives[] arrays (keep top 3 candidates per gap)\n` +
                        `  - configFiles[].values is huge (only include keys actually referenced by the tests)\n` +
                        `Trim the payload and re-call. DO NOT split into multiple finalize calls — finalize is a single-call atomic close-out.`,
                },
                `Finalize meta payload too large (${metaBytes} > ${META_BYTE_CAP} bytes).`,
            );
        }

        const scratchRaw = ctx.readPhaseArtifact('analyze', 'scratch-scenarios.json');
        if (!scratchRaw) {
            return errorResult(
                `No scenarios staged. Call csaa_append_analysis_scenario at least once before csaa_finalize_analysis. (Do NOT try csaa_record_analysis with the full payload — for any non-trivial analysis it will be rejected by the single-call cap.)`,
                runId,
            );
        }
        let scenarios: unknown[];
        try {
            scenarios = JSON.parse(scratchRaw);
        } catch {
            return errorResult(
                `Scratch scenario file is corrupt at analyze/scratch-scenarios.json. Read the file, identify which scenario(s) are malformed, delete only the corrupt entries, and re-append them. Do NOT fall back to csaa_record_analysis with full payload — that path is capped for the same reason streaming exists.`,
                runId,
            );
        }
        if (!Array.isArray(scenarios) || scenarios.length === 0) {
            return errorResult(
                `Scratch scenario file is empty. Call csaa_append_analysis_scenario at least once first.`,
                runId,
            );
        }

        // If the caller redundantly passed scenarios, refuse — they would
        // shadow the scratch file and likely truncate the real list.
        if (Array.isArray((meta as { scenarios?: unknown[] }).scenarios)) {
            return errorResult(
                `csaa_finalize_analysis payload must NOT include 'scenarios' — they come from the scratch file. Remove the scenarios key and re-call. (Got ${(meta as { scenarios: unknown[] }).scenarios.length} scenarios in the payload alongside ${scenarios.length} in the scratch file.)`,
                runId,
            );
        }

        // v1.38.2 — pages may be streamed via csaa_append_analysis_page.
        // If scratch-pages.json exists, merge those in. If pages are ALSO
        // in the payload, refuse — same shadow-truncation risk as
        // scenarios above. If neither pages-scratch nor pages-in-payload,
        // the LLM must include pages directly (backward compat for runs
        // that bypassed the iterator-mode page streaming).
        const pagesScratchRaw = ctx.readPhaseArtifact('analyze', 'scratch-pages.json');
        let scratchPages: unknown[] | null = null;
        if (pagesScratchRaw) {
            try {
                const parsed = JSON.parse(pagesScratchRaw);
                if (Array.isArray(parsed) && parsed.length > 0) scratchPages = parsed;
            } catch {
                return errorResult(
                    `Scratch page file is corrupt at analyze/scratch-pages.json. Inspect the file, fix or delete malformed entries, then re-append via csaa_append_analysis_page.`,
                    runId,
                );
            }
        }
        const payloadPages = (meta as { pages?: unknown }).pages;
        if (scratchPages && Array.isArray(payloadPages) && payloadPages.length > 0) {
            return errorResult(
                `csaa_finalize_analysis payload must NOT include 'pages' when scratch-pages.json is populated — they come from the per-page scratch file. Remove the pages key and re-call. (Got ${payloadPages.length} pages in the payload alongside ${scratchPages.length} in the scratch file.)`,
                runId,
            );
        }

        const mergedMeta = scratchPages
            ? { ...(meta as Record<string, unknown>), pages: scratchPages }
            : (meta as Record<string, unknown>);
        const fullPayload = { ...mergedMeta, scenarios };

        // Re-dispatch through csaa_record_analysis so gate logic stays
        // single-sourced. On success it writes analysis-report.json and the
        // scratch file becomes obsolete — clean it up so a re-run doesn't
        // accidentally re-use it. `_bypassSizeGate` lets the accumulated
        // scratch (which can be 4+ scenarios) skip the per-call payload-size
        // cap on csaa_record_analysis that exists to force the streaming
        // path on direct callers.
        const res = await csaa_record_analysis.handler(
            { runId, payload: fullPayload, _bypassSizeGate: true },
            toolCtx,
        );
        const sc = res.structuredContent as { state?: string } | undefined;
        if (sc?.state === 'RUNNING' || sc?.state === 'BLOCKED_NEED_HUMAN') {
            // Validation passed (RUNNING) or the analysis was persisted but
            // halted on readiness (BLOCKED). Either way the scratch files
            // are no longer needed for retries.
            try {
                const phaseDir = path.join(ctx.runFolder, CSRunContext.phaseFolder('analyze'));
                for (const fn of ['scratch-scenarios.json', 'scratch-pages.json']) {
                    const p = path.join(phaseDir, fn);
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                }
            } catch { /* non-fatal */ }
        }
        return res;
    })
    .build();

function renderAnalyzeMarkdown(
    analysis: Record<string, unknown> & {
        scenarios: unknown[];
        pages: unknown[];
        readinessScore?: number;
        gaps?: Array<{ severity: string; detail: string }>;
    },
    readinessScore: number,
): string {
    const lines: string[] = [];
    lines.push('# Analysis Report');
    lines.push('');
    lines.push(`**Readiness:** ${readinessScore.toFixed(2)}  ·  **Scenarios:** ${analysis.scenarios.length}  ·  **Pages:** ${analysis.pages.length}`);
    lines.push('');
    if (analysis.gaps && analysis.gaps.length > 0) {
        lines.push('## Gaps');
        for (const g of analysis.gaps) {
            lines.push(`- **[${g.severity.toUpperCase()}]** ${g.detail}`);
        }
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_plan — Phase 4: render plan + gaps for human review
// ============================================================================

const csaa_plan: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_plan')
    .title('CS-AI-Auto-Assist — Plan (Phase 4)')
    .description(
        'Render the analysis report\'s output plan + auto-resolved gaps as a human-readable ' +
            'PLAN.md at the run root. Non-blocking — the pipeline proceeds. The user reads ' +
            'the plan asynchronously while phase 5 runs.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (!reportRaw) {
            return errorResult(`no analysis report — call csaa_analyze + csaa_record_analysis before csaa_plan`, runId);
        }
        const analysis = JSON.parse(reportRaw) as {
            source?: { relativePath?: string };
            feature?: { name?: string; slug?: string };
            scenarios: Array<{ id: string; title: string }>;
            pages: Array<{ className: string; role: string; existingFilePath?: string }>;
            loginContract?: { detected?: string; pattern?: string; gherkinStep?: string };
            gaps?: Array<{ severity: string; detail: string }>;
            readinessScore?: number;
        };

        ctx.startPhase('plan');
        const featureSlug = analysis.feature?.slug ?? 'feature';
        const lines: string[] = [];
        lines.push(`# Migration Plan — \`${runId}\``);
        lines.push('');
        lines.push(`**Feature:** \`${analysis.feature?.name ?? featureSlug}\`  `);
        lines.push(`**Source:** \`${analysis.source?.relativePath ?? '(unknown)'}\`  `);
        if (typeof analysis.readinessScore === 'number') {
            lines.push(`**Readiness:** ${analysis.readinessScore.toFixed(2)}`);
        }
        lines.push('');
        lines.push('## Scenarios');
        lines.push('');
        lines.push('| # | id | title |');
        lines.push('|---|---|---|');
        analysis.scenarios.forEach((s, i) => {
            lines.push(`| ${i + 1} | \`${s.id}\` | ${s.title} |`);
        });
        lines.push('');
        lines.push('## Pages');
        lines.push('');
        lines.push('| Role | Class | Existing file |');
        lines.push('|---|---|---|');
        for (const p of analysis.pages) {
            lines.push(`| ${p.role} | \`${p.className}\` | ${p.existingFilePath ? `\`${p.existingFilePath}\`` : '—'} |`);
        }
        lines.push('');
        if (analysis.loginContract && analysis.loginContract.detected !== 'no') {
            lines.push('## Login pattern');
            lines.push('');
            lines.push(`- **Detected:** ${analysis.loginContract.detected}`);
            lines.push(`- **Pattern:** ${analysis.loginContract.pattern ?? '(none)'}`);
            lines.push(`- **Step:** \`${analysis.loginContract.gherkinStep ?? '(none)'}\``);
            lines.push('');
        }
        if (analysis.gaps && analysis.gaps.length > 0) {
            lines.push('## Gaps');
            for (const g of analysis.gaps) {
                lines.push(`- **[${g.severity.toUpperCase()}]** ${g.detail}`);
            }
            lines.push('');
        }
        const planMd = lines.join('\n') + '\n';

        ctx.writePhaseArtifact('plan', 'plan.md', planMd);
        try {
            fs.writeFileSync(path.join(ctx.runFolder, 'PLAN.md'), planMd, 'utf-8');
        } catch { /* ignore */ }
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'plan', 'Migration Plan', planMd,
        );
        ctx.finishPhase('plan', 'done', { reportPath });
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'plan',
                scenarioCount: analysis.scenarios.length,
                pageCount: analysis.pages.length,
                runFolder: ctx.runFolder,
                planPath: path.join(ctx.runFolder, 'PLAN.md'),
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_translate',
                nextSuggestedArgs: { runId },
            },
            `Plan ready: ${analysis.scenarios.length} scenarios, ${analysis.pages.length} pages. PLAN.md at runFolder. Call csaa_translate next.`,
        );
    })
    .build();

// ============================================================================
// csaa_translate — Phase 5: delegate translation to the host LLM
// ============================================================================

// ============================================================================
// Translate-side iterator envelope builders (v1.38 Phase 5)
// ============================================================================
// Symmetric to buildAnalyzeScenarioEnvelope / buildAnalyzeFinalizeEnvelope.
// Per-file specs keep each tool-response payload small (~1-3 KB) so the
// LLM never holds the multi-file picture in its head.

interface TranslateIteratorCommonGrounding {
    runId: string;
    project: string;
    module?: string;
    frameworkPkg: string;
    analysisReportPath: string;
    skillsPath: string;
}

/**
 * Per-file responseSchema for the iterator submit — matches the
 * csaa_append_translation_file `file` param shape exactly.
 */
const PER_FILE_RESPONSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    required: ['relativePath', 'kind', 'content'],
    properties: {
        relativePath: { type: 'string' },
        kind: { type: 'string', enum: ['feature', 'steps', 'page', 'data'] },
        content: { type: 'string' },
        reuseDecision: { type: 'string' },
    },
};

/**
 * v1.38.3 — SILENCE_PREFIX. Universal warning prepended to every per-file
 * instruction. The previous version put SILENCE rules as a trailing
 * reminder; real runs showed the LLM still wrote "Producing the steps
 * file now:" in chat before composing the tool call — the narration plus
 * the file payload combined exceeded the per-message output cap. Putting
 * the rule at the TOP, with ⚠️ + banned-phrase examples, makes the LLM
 * read it before generating any text and prevents the narration entirely.
 */
const SILENCE_PREFIX: string[] = [
    '⚠️ SILENCE RULE (CRITICAL, READ FIRST):',
    '  - Do NOT narrate "Producing the X file now:" or any preamble in chat.',
    '  - Do NOT say "Composing", "Generating", "Writing", "Submitting", "Let me", "I will now".',
    '  - Do NOT show file contents in markdown code blocks before the tool call.',
    '  - Just compose the tool call DIRECTLY as your next action. Zero chat.',
    '  - The user reads STATUS.md and the persisted file artefacts — not your chat reply.',
    '  - Every line of chat narration counts against the per-message output cap that triggers',
    '    "Sorry, the response hit the length limit." A 5-line preamble + a 15 KB file payload',
    '    blows the cap. A direct tool call alone does not.',
    '',
];

function buildTranslateFileEnvelope(
    item: TranslateQueueItem,
    progress: { completed: number; total: number },
    common: TranslateIteratorCommonGrounding,
): DelegationEnvelope {
    const fileIdx = progress.completed + 1; // 1-indexed
    let instructionBody: string[];

    switch (item.kind) {
        case 'feature':
            instructionBody = [
                `Produce ONE file: the Gherkin feature (${fileIdx}/${progress.total}).`,
                '',
                `Target path: ${item.relativePath}`,
                `Scenarios to declare (${item.scenarioIds.length}): ${item.scenarioIds.join(', ')}`,
                '',
                'Requirements:',
                '  - One `Scenario:` block (or `Scenario Outline:` if every step references `<placeholder>`) per scenarioId above. Tag each with @<scenarioId>.',
                '  - Step text comes from analysis.scenarios[id].steps — read the analysis at grounding.analysisReportPath via your `read` tool. Step text MUST match exactly across the feature and the steps-defs you will emit next.',
                '  - NEVER reference Java class names or helper ids (e.g. SomeHelper, TC_xxx) in step text. Use plain English user actions.',
                '  - If you use Scenario Outline, Examples block MUST be the JSON envelope: `Examples: {"type":"json","source":"test/<project>/data/<module>/<module>-scenarios.json","path":"$","filter":"scenarioId=<id> AND runFlag=Yes"}`. Plain Gherkin tables are rejected.',
                '  - Two scenarios cannot share the same title — disambiguate where needed.',
                '',
                'Submit via `csaa_append_translation_file(runId, file: { relativePath, kind: "feature", content })`. My response will tell you which file to produce next.',
                '',
                'SILENCE RULE: compose the tool call directly. Do NOT narrate file content in chat — that burns the per-message output budget.',
            ];
            break;
        case 'steps':
            instructionBody = [
                `Produce ONE file: the step-defs (${fileIdx}/${progress.total}).`,
                '',
                `Target path: ${item.relativePath}`,
                `Required step-def patterns (${item.stepDefTexts.length}):`,
                ...item.stepDefTexts.slice(0, 50).map((t) => `  - "${t}"`),
                ...(item.stepDefTexts.length > 50
                    ? [`  …and ${item.stepDefTexts.length - 50} more (see analysis.scenarios[].steps[].text)`]
                    : []),
                '',
                'Requirements:',
                `  - Use framework imports: CSBDDStepDef / StepDefinitions / Page from "${common.frameworkPkg}/bdd", CSReporter from "${common.frameworkPkg}/reporting", CSBasePage / CSPage / CSGetElement from "${common.frameworkPkg}/core", CSWebElement from "${common.frameworkPkg}/element", CSValueResolver from "${common.frameworkPkg}/utilities", CSDBUtils from "${common.frameworkPkg}/database-utils".`,
                '  - One @CSBDDStepDef per step-def text above. The pattern in @CSBDDStepDef MUST match the feature step text exactly.',
                '  - Every step-def body MUST do at least one element interaction (this.somePage.someMethod() or this.someElement.click/fill/etc., or CSDBUtils call). Empty/stub bodies are rejected.',
                '  - Class properties decorated with @Page or @CSGetElement use the `!` non-null assertion.',
                '  - `@StepDefinitions` (no parens) on the class. `@CSBDDStepDef(...)` (with parens) on each method.',
                '  - Method signatures: `(message: string)` for {string}, `(value: number)` for {int}. NO `(ctx, ...)`.',
                '',
                'Submit via `csaa_append_translation_file(runId, file: { relativePath, kind: "steps", content })`.',
                '',
                'SILENCE RULE: compose the tool call directly, no chat narration of code.',
            ];
            break;
        case 'page':
            instructionBody = [
                `Produce ONE file: a page object (${fileIdx}/${progress.total}).`,
                '',
                `Target path: ${item.relativePath}`,
                `Legacy page class: ${item.legacyClassName}`,
                `Minimum @CSGetElement count: ${item.minFieldCount} (80% floor from legacy @FindBy count)`,
                '',
                'Steps:',
                `  1. Call csaa_extract_page_fields(runId, pageClass: "${item.legacyClassName}") to get the authoritative @FindBy list from the legacy file.`,
                '  2. Emit ONE @CSGetElement per legacy field. XPath primary, alternativeLocators[] for CSS variants if available.',
                '  3. Property name should mirror the legacy field name (camelCased if needed).',
                '  4. Class decorator: `@CSPage("<page-key>")`. Class extends `CSBasePage`.',
                '',
                'Requirements:',
                `  - Imports: CSBasePage / CSPage / CSGetElement from "${common.frameworkPkg}/core", CSWebElement from "${common.frameworkPkg}/element".`,
                `  - At least ${item.minFieldCount} @CSGetElement decorators — submitting fewer triggers the page-coverage rejection.`,
                '  - All element properties typed `CSWebElement` with `!` non-null assertion.',
                '',
                'Submit via `csaa_append_translation_file(runId, file: { relativePath, kind: "page", content })`.',
                '',
                'SILENCE RULE: compose the tool call directly. No narration of locator strings or imports.',
            ];
            break;
        case 'data':
            instructionBody = [
                `Produce ONE file: the data JSON (${fileIdx}/${progress.total}).`,
                '',
                `Target path: ${item.relativePath}`,
                `Scenario rows to include (${item.scenarioIds.length}): ${item.scenarioIds.join(', ')}`,
                '',
                'Requirements:',
                '  - JSON array of row objects. One row per scenarioId above.',
                '  - Each row MUST include: scenarioId, scenarioName, runFlag, plus EVERY column from analysis.scenarios[id].dataRow.',
                '  - If the analysis recorded an empty dataRow for a scenario (data file missing or column-shift), still emit the row with metadata fields only — but the data-coverage gate will flag it.',
                '  - Values from analysis.scenarios[id].dataRow are AUTHORITATIVE — copy verbatim, do not invent.',
                '',
                'Submit via `csaa_append_translation_file(runId, file: { relativePath, kind: "data", content })`. After this submit, the queue drains and my response will tell you to call csaa_finalize_translation.',
                '',
                'SILENCE RULE: compose the tool call directly.',
            ];
            break;
    }

    return {
        task: 'produce-one-file',
        instruction: [...SILENCE_PREFIX, ...instructionBody].join('\n'),
        responseSchema: PER_FILE_RESPONSE_SCHEMA,
        grounding: {
            runId: common.runId,
            project: common.project,
            module: common.module,
            frameworkPkg: common.frameworkPkg,
            analysisReportPath: common.analysisReportPath,
            skillsPath: common.skillsPath,
            currentItem: item,
            queue: {
                current: fileIdx,
                total: progress.total,
                remaining: Math.max(0, progress.total - progress.completed - 1),
            },
        },
        recordWith: 'csaa_append_translation_file',
        recordArgs: { runId: common.runId },
    };
}

function buildTranslateFinalizeEnvelope(
    filesStaged: number,
    common: TranslateIteratorCommonGrounding,
): DelegationEnvelope {
    return {
        task: 'finalize-translation',
        instruction: [
            `All ${filesStaged} file(s) are staged in 05-translate/scratch-files.json. Now call csaa_finalize_translation to run every content + signature + compile gate against the assembled file set.`,
            '',
            'Optional `notes` parameter — pass `{ items: ["<note>", ...] }` if you have any caveats the user should see, otherwise omit.',
            '',
            'Submit via `csaa_finalize_translation(runId, notes?)`. The tool re-dispatches through csaa_record_translation with the size-cap bypass flag set, so every gate fires identically (schema + content + page-coverage signature + step-coverage signature + compile_check).',
            '',
            'SILENCE RULE: compose the tool call directly.',
        ].join('\n'),
        responseSchema: {
            type: 'object',
            properties: {
                notes: { type: 'object' },
            },
        },
        grounding: {
            runId: common.runId,
            project: common.project,
            module: common.module,
            frameworkPkg: common.frameworkPkg,
            analysisReportPath: common.analysisReportPath,
            skillsPath: common.skillsPath,
            filesStaged,
        },
        recordWith: 'csaa_finalize_translation',
        recordArgs: { runId: common.runId },
    };
}

const csaa_translate: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_translate')
    .title('CS-AI-Auto-Assist — Translate (Phase 5)')
    .description(
        'Returns a delegation envelope instructing the host LLM to produce a translation ' +
            '(feature + steps + page objects + data) from the recorded analysis. The LLM emits ' +
            'a TRANSLATION_SCHEMA-conforming JSON and calls csaa_record_translation, which runs ' +
            'content gates (placeholder detection, dup imports, wrong subpaths, empty bodies) ' +
            'before persisting. Garbage NEVER lands on disk.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('project', 'Target project name', { required: true })
    .stringParam('module', 'Optional module name')
    .stringParam('frameworkPkg', 'Framework npm package (e.g. @your-scope/cs-playwright-test-framework). Defaults to whatever is in consumer package.json.')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const analysisReportPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('analyze'),
            'analysis-report.json',
        );
        if (!fs.existsSync(analysisReportPath)) {
            return errorResult(`no analysis report — call csaa_analyze + csaa_record_analysis first`, runId);
        }

        // v1.38.3 — POST-FINALIZE SEAL. If csaa_finalize_translation
        // already succeeded (content-map.json exists), csaa_translate
        // returns TRANSLATE_SEALED EARLY — before composing any bulk
        // envelope. Without this seal, a post-finalize re-call would
        // return the bulk envelope (queue is empty because it drained)
        // and the LLM would try to compose ALL files in one message →
        // length limit. The downstream seal on csaa_record_translation
        // catches the symptom but only after the LLM has already burned
        // its output budget composing. Seal must fire at the entry point.
        const contentMapPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('translate'),
            'content-map.json',
        );
        if (fs.existsSync(contentMapPath)) {
            return jsonResult(
                {
                    state: 'TRANSLATE_SEALED',
                    runId,
                    phase: 'translate',
                    blockedReason: 'Translate phase already finalized (content-map.json exists). DO NOT re-enter translate. For corrections, use csaa_audit (Phase 6) to identify violations, then csaa_write the corrected files individually; the heal loop will catch real-app issues. For full re-translate, start a NEW run via cs_ai_auto_assist.',
                    contentMapPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_audit',
                    nextSuggestedArgs: { runId },
                },
                'Translate sealed — content-map.json already exists. Use csaa_audit for corrections or start a new run.',
            );
        }

        const project = getStr(params, 'project') ?? 'default';
        const module = getStr(params, 'module');
        const frameworkPkg =
            getStr(params, 'frameworkPkg') ?? '@mdakhan.mak/cs-playwright-test-framework';

        ctx.startPhase('translate');

        // v1.38 Phase 5 — iterator mode. When the translate queue was
        // seeded by csaa_record_analysis success, return the per-file
        // envelope so the LLM produces ONE file per turn. The bulk
        // envelope below remains as the backward-compat fallback for
        // runs that bypassed signature+queue seeding.
        const tQueue = CSWorkQueue.load(ctx);
        if (!tQueue.isEmpty('translate')) {
            const tItem = tQueue.peekNext('translate') as TranslateQueueItem;
            const tCommon: TranslateIteratorCommonGrounding = {
                runId,
                project,
                module,
                frameworkPkg,
                analysisReportPath,
                skillsPath: '.github/skills/',
            };
            const tIterEnv = buildTranslateFileEnvelope(
                tItem,
                { completed: tQueue.completed('translate'), total: tQueue.total('translate') },
                tCommon,
            );
            ctx.writePhaseArtifact(
                'translate',
                'delegation-envelope.json',
                JSON.stringify(tIterEnv, null, 2),
            );
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'AWAITING_LLM_FULFILMENT',
                    runId,
                    phase: 'translate',
                    delegation: tIterEnv,
                    queue: {
                        current: tQueue.completed('translate') + 1,
                        total: tQueue.total('translate'),
                        progress: tQueue.progress('translate'),
                    },
                    iteratorMode: true,
                    runFolder: ctx.runFolder,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_translation_file',
                    nextSuggestedArgs: { runId },
                },
                `Iterator mode: produce file ${tQueue.completed('translate') + 1}/${tQueue.total('translate')} (${tItem.kind} → ${tItem.relativePath}). Submit via csaa_append_translation_file.`,
            );
        }

        const envelope: DelegationEnvelope = {
            task: 'translate-analysis-to-bdd',
            instruction: [
                'You are translating a recorded analysis into CS Playwright BDD files. Half-effort output gets rejected by content gates — bake the skills in from the start.',
                '',
                'STEP 0 — READ the skill files first. For EVERY entry in `grounding.mandatorySkills`, use `read` on `<workspaceRoot>/.github/skills/<name>/SKILL.md`. These are the framework conventions the audit enforces. Examples block format, page-object pattern, step-def signature variants, data-driven shape — all documented there.',
                '',
                'STEP 1 — read the analysis. Use `read` on `grounding.analysisReportPath`.',
                '',
                'STEP 2 — produce ALL of the following artefacts. Emitting fewer kinds is rejected by the file-kind coverage gate (see csaa_record_translation). A partial translation (e.g. only steps.ts) is never accepted.',
                '  - REQUIRED: 1 .feature file → `test/<project>/features/<module>/<slug>.feature` covering EVERY scenario from analysis.scenarios[]',
                '  - REQUIRED: 1 .steps.ts file → `test/<project>/steps/<module>/<slug>.steps.ts` with a @CSBDDStepDef whose pattern EXACTLY matches every Given/When/Then text in the feature (no extra words, no rephrasing)',
                '  - REQUIRED: 1 data JSON file → `test/<project>/data/<module>/<slug>-scenarios.json` — include EVERY column from `analysis.scenarios[i].dataRow`, not just metadata',
                '  - REQUIRED: 1 page object .ts file under `test/<project>/pages/<module>/` for EVERY analysis page with role=create-new (one file per page, named after the page class)',
                '  - Pages with role=reuse-existing → DO NOT emit (the consumer already has them).',
                '',
                'STRICT FEATURE-FILE RULES (per ff-scenario-outline skill):',
                ' - Use `Scenario Outline:` ONLY when the body references at least one `<placeholder>` from Examples. If no placeholders, use plain `Scenario:`.',
                ' - If you use Scenario Outline, the `Examples:` block MUST be the JSON envelope:',
                '     Examples: {"type":"json","source":"test/<project>/data/<module>/<slug>-scenarios.json","path":"$","filter":"scenarioId=<id> AND runFlag=Yes"}',
                '   NOT a Gherkin table. Plain `| scenarioId |` tables are rejected.',
                ' - Step text in features must NEVER contain code references like `ClassName.methodName`. Translate `CTSSupportMethod.TS_4963` to a human-readable step like `Given I am signed in as <user>`.',
                '',
                'STRICT IMPORT CONVENTIONS (rejected if violated):',
                `  - Framework package is "${frameworkPkg}" — use this exact prefix.`,
                '  - CSBDDStepDef, StepDefinitions, Page, CSBDDContext, CSScenarioContext → /bdd',
                '  - CSReporter → /reporting',
                '  - CSBasePage, CSPage, CSGetElement, CSConfigurationManager → /core',
                '  - CSWebElement, CSElementFactory → /element',
                '  - CSValueResolver → /utilities',
                '  - CSDBUtils → /database-utils',
                '',
                'STRICT STEP-DEFINITION RULES (rejected if violated):',
                ' - EVERY @CSBDDStepDef body MUST do at least one element interaction — call a method on `this.somePage` (click, fill, verify, etc.) OR use CSDBUtils/CSConfigurationManager. Bodies that only call `CSReporter.pass(...)` are stub-step-body violations.',
                ' - Locators on @CSGetElement MUST come from `analysis.pages[].elements[].primaryLocator.value` (the legacy file value). Do not invent XPaths.',
                ' - Class properties decorated with @Page or @CSGetElement MUST use the `!` non-null assertion (e.g. `myPage!: MyPage;`) to satisfy strict TypeScript.',
                ' - Decorator `@StepDefinitions` is used WITHOUT parens. `@CSBDDStepDef(...)` takes parens.',
                ' - Step-def method signatures: `(message: string)` for {string}, `(value: number)` for {int}. NEVER use `(ctx, ...)` — there is no ctx parameter.',
                '',
                'STRICT PAGE-OBJECT RULES:',
                ' - Use `@CSGetElement({...})` and access elements as PROPERTIES (no parens): `this.myButton.click()` NOT `this.getMyButton().click()`.',
                ' - Do not invent chained APIs like `.getRowByCellValue(...)` or `.getButton(...)` on CSWebElement — they do not exist. Use the framework methods documented in the skill files only.',
                '',
                'STRICT CONTENT RULES:',
                ' - Every scenario MUST have ≥1 When + ≥1 Then (not just Given).',
                ' - NEVER emit "TODO", "not implemented", "placeholder", or "the operation should complete without errors".',
                ' - No duplicate `import { X }` lines.',
                ' - No duplicate `@Page("key")` decorators.',
                '',
                'STEP 3 — submit the translation. **DEFAULT: STREAMING.** Use `csaa_append_translation_file` for EVERY file then `csaa_finalize_translation` to close out. This is the path for any real migration.',
                '  Why: `csaa_record_translation` enforces a HARD CAP (4 files OR 12 KB total content) on single-call submissions. Above that, it rejects with `state=AWAITING_LLM_RETRY` and forces you to retry via streaming. Even if you "think" your translation will fit (it won\'t — 5+ pages averaging 1-3 KB each easily blows it), composing the payload triggers "Sorry, the response hit the length limit" before the tool call lands. Skip the failed attempt; stream from the start.',
                '  Streaming loop (mandatory above the cap, recommended otherwise):',
                '    1. For EACH file in your translation, call `csaa_append_translation_file(runId, file: { relativePath, kind, content })`. One file per call (~1-5 KB). Order: feature first, then steps.ts, then one page object per analysis page with role=create-new, then data.json. Stages to `05-translate/scratch-files.json` — survives compaction.',
                '    2. When every file is appended, call `csaa_finalize_translation(runId, notes?)`. It re-dispatches through `csaa_record_translation` with the bypass flag set, so EVERY gate fires identically (schema + content + page-coverage signature + step-coverage signature + compile_check). No shortcut, no quality compromise.',
                '  Single-call path: only when total content < 12 KB AND files ≤ 4. Typically only "smoke fixture" sized inputs. Real migrations always need streaming.',
                '',
                '**CRITICAL — do NOT narrate file contents in chat.** Emitting "Now writing page object..." / "Adding element locators..." / "Defining the page class..." in your reply burns output tokens. Compose tool calls SILENTLY. The user reads STATUS.md for progress, not your narration. Inlining feature/steps/page content as visible markdown is the #1 cause of "response hit the length limit" on this phase.',
                '',
                'The record tool runs schema validation, content gates (placeholder / dup imports / wrong subpath / empty body / step-def coverage / stub bodies / Scenario Outline misuse / Examples envelope shape / helper-class leak / duplicate scenario title / orphan step def / duplicate step-def bodies / generic-placeholder step text / Java identifier leak), the page-coverage signature gate (generated @CSGetElement count vs legacy @FindBy count ≥ 80%), the step-coverage signature gate (Gherkin steps per scenario vs legacy actions ≥ 70%), and `tsc --noEmit` against the consumer\'s tsconfig. If ANY gate fails you receive the specific violations — fix and re-call up to 3 times.',
            ].join('\n'),
            responseSchema: TRANSLATION_SCHEMA,
            grounding: {
                runId,
                project,
                module,
                frameworkPkg,
                analysisReportPath,
                skillsPath: '.github/skills/',
                mandatorySkills: [...MANDATORY_TRANSLATE_SKILLS],
            },
            recordWith: 'csaa_record_translation',
            recordArgs: { runId },
        };

        ctx.writePhaseArtifact(
            'translate',
            'delegation-envelope.json',
            JSON.stringify(envelope, null, 2),
        );
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'AWAITING_LLM_FULFILMENT',
                runId,
                phase: 'translate',
                delegation: envelope,
                runFolder: ctx.runFolder,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_record_translation',
                nextSuggestedArgs: { runId },
            },
            `Translate delegation ready. Produce file map matching TRANSLATION_SCHEMA, then call csaa_record_translation(runId, payload).`,
        );
    })
    .build();

// ============================================================================
// csaa_record_translation — Phase 5 fulfilment partner
// ============================================================================

const csaa_record_translation: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_record_translation')
    .title('CS-AI-Auto-Assist — Record Translation (Phase 5 fulfilment)')
    .description(
        'Companion to csaa_translate. Accepts LLM-produced translation JSON, validates schema, ' +
            'runs content gates (placeholder detection, dup imports, wrong subpaths, empty bodies, ' +
            'step-def coverage), persists ONLY if all gates pass. Returns violations on failure ' +
            'so the agent can fix-and-retry.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('workspaceRoot', 'Consumer project root for compile_check; if omitted, compile gate is skipped')
    .objectParam(
        'payload',
        'REQUIRED. The LLM-produced translation JSON object matching TRANSLATION_SCHEMA. Pass as `payload: { files: [{ relativePath, kind, content, reuseDecision? }, ...], notes?: [...] }`. Each `files[]` entry is one generated artefact (.feature / .ts page / .ts steps / .json data). The content gates (placeholder detection, dup imports, wrong subpaths, empty bodies, step-def coverage, stub bodies, Scenario Outline misuse, Examples envelope shape) run on this payload before persistence.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        // v1.38.3 — POST-FINALIZE SEAL. content-map.json existence means
        // csaa_finalize_translation already ran successfully. Any direct
        // record_translation call after that is a post-finalize correction
        // attempt — refuse so the LLM doesn't compose a fresh bulk payload.
        const recordSealPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('translate'),
            'content-map.json',
        );
        if (fs.existsSync(recordSealPath) && params._bypassSizeGate !== true) {
            return jsonResult(
                {
                    state: 'TRANSLATE_SEALED',
                    runId,
                    phase: 'translate',
                    blockedReason: 'Translate phase already finalized (content-map.json exists). DO NOT recompose a full translation. For corrections, use csaa_audit (Phase 6).',
                    contentMapPath: recordSealPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_audit',
                    nextSuggestedArgs: { runId },
                },
                'Translate sealed — record_translation rejected after finalize.',
            );
        }

        const payload = params.payload;
        if (typeof payload !== 'object' || payload === null) {
            return errorResult(`payload must be an object`, runId);
        }

        // Gate 0: HARD payload size cap. The single-call path
        // (csaa_record_translation with all files in one payload) is a
        // convenience for tiny migrations only. Real test migrations have
        // 5-15 files (~30-50 KB total content), which blows the LLM-host's
        // per-message output cap mid-composition and the agent never even
        // emits the tool call — it hits "Sorry, the response hit the
        // length limit" while building the JSON in its head.
        //
        // Force the streaming path (csaa_append_translation_file +
        // csaa_finalize_translation) whenever the payload exceeds the cap.
        // Finalize bypasses this gate via _bypassSizeGate=true so the
        // accumulated scratch can re-dispatch through here without looping.
        const bypassSizeGate = params._bypassSizeGate === true;
        if (!bypassSizeGate) {
            const filesArr = (payload as { files?: unknown }).files;
            if (Array.isArray(filesArr)) {
                const totalBytes = filesArr.reduce<number>((sum, f) => {
                    const c = (f as { content?: unknown })?.content;
                    return sum + (typeof c === 'string' ? c.length : 0);
                }, 0);
                const MAX_FILES_PER_CALL = 4;
                const MAX_BYTES_PER_CALL = 12 * 1024;
                if (filesArr.length > MAX_FILES_PER_CALL || totalBytes > MAX_BYTES_PER_CALL) {
                    return jsonResult(
                        {
                            state: 'AWAITING_LLM_RETRY',
                            runId,
                            phase: 'translate',
                            payloadFiles: filesArr.length,
                            payloadBytes: totalBytes,
                            maxFiles: MAX_FILES_PER_CALL,
                            maxBytes: MAX_BYTES_PER_CALL,
                            nextStepNeeded: true,
                            nextSuggestedTool: 'csaa_append_translation_file',
                            feedback:
                                `${SILENCE_PREFIX.join('\n')}\n` +
                                `csaa_record_translation rejected: payload too large for single-call submission (${filesArr.length} files, ${totalBytes} bytes — caps ${MAX_FILES_PER_CALL} files / ${MAX_BYTES_PER_CALL} bytes). This cap exists because composing a 5-15 file translation in one JSON payload blows the LLM-host per-message output budget — you hit "response hit the length limit" mid-composition and the tool call never lands. \n\nUse the streaming protocol instead:\n  1. For EACH file in your translation, call csaa_append_translation_file(runId, file: { relativePath, kind, content }). One file per call (~1-5 KB each). Stages to 05-translate/scratch-files.json — survives compaction. Duplicate paths OVERWRITE the prior staged version (replacement mode).\n  2. When every file is appended, call csaa_finalize_translation(runId). It runs EVERY gate (schema + content + page-coverage signature + step-coverage signature + compile_check) identical to single-call. No shortcut, no quality compromise.\n\nDo NOT retry csaa_record_translation with the same payload — you'll get the same rejection. The streaming path is mandatory above the cap.`,
                        },
                        `csaa_record_translation rejected: ${filesArr.length} files / ${totalBytes} bytes exceeds single-call cap. Use csaa_append_translation_file + csaa_finalize_translation.`,
                    );
                }
            }
        }

        // Gate 1: schema validation
        const schemaErrors = CSSchemaValidator.validate(payload, TRANSLATION_SCHEMA);
        if (schemaErrors.length > 0) {
            const summary = schemaErrors.slice(0, 10).map((e) => `${e.path}: ${e.message}`).join('\n');
            ctx.writePhaseArtifact(
                'translate',
                'validation-errors.json',
                JSON.stringify(schemaErrors, null, 2),
            );
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    schemaErrors,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_record_translation',
                    feedback: `Translation payload failed schema validation. Fix and re-call.\n\n${summary}`,
                },
                `Schema validation failed (${schemaErrors.length} errors). Retry.`,
            );
        }

        const translation = payload as {
            files: Array<{
                relativePath: string;
                kind: 'feature' | 'page' | 'steps' | 'data';
                content: string;
                reuseDecision?: string;
            }>;
            notes?: string[];
        };

        // Gate 2: content quality
        const contentViolations = CSContentValidator.validateAll(
            translation.files.map((f) => ({
                relativePath: f.relativePath,
                kind: f.kind,
                content: f.content,
            })),
        );
        const errors = contentViolations.filter((v) => v.severity === 'error');
        if (errors.length > 0) {
            ctx.writePhaseArtifact(
                'translate',
                'content-violations.json',
                JSON.stringify(contentViolations, null, 2),
            );
            const grouped: Record<string, ContentViolation[]> = {};
            for (const v of contentViolations) {
                if (!grouped[v.relativePath]) grouped[v.relativePath] = [];
                grouped[v.relativePath].push(v);
            }
            const summaryLines: string[] = [];
            for (const [rel, list] of Object.entries(grouped)) {
                summaryLines.push(`\n${rel}:`);
                for (const v of list) {
                    summaryLines.push(`  [${v.severity}] ${v.ruleId}${v.line ? ` (line ${v.line})` : ''}: ${v.message}`);
                }
            }
            const affectedFiles = Object.keys(grouped).filter((rel) =>
                grouped[rel].some((v) => v.severity === 'error'),
            );
            // v1.38.6 — PRIMARY recommendation: csaa_patch_translation_file
            // (tiny find/replace payloads, ~50-500 bytes per fix). FALLBACK:
            // csaa_append_translation_file replacement mode for files that
            // need >50% rewrite. NEVER recompose full bulk via record_translation.
            const scratchExists = ctx.readPhaseArtifact('translate', 'scratch-files.json') !== null;
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    contentViolations,
                    errorCount: errors.length,
                    affectedFiles,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_patch_translation_file',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `Content gates rejected ${errors.length} error(s) across ${affectedFiles.length} file(s).\n\n` +
                        `**DO NOT recompose any file via csaa_record_translation or full csaa_append_translation_file — that hits the per-message length limit.**\n\n` +
                        `Correction protocol — PATCH-FIRST:\n` +
                        `  1. For EACH violation, identify the minimal find/replace pair (e.g. find: 'i.e. "username"', replace: 'i.e. <username>'). Typical fix is 20-100 bytes.\n` +
                        `  2. For each affected file, call csaa_patch_translation_file(runId, relativePath, patches: [{find, replace}, ...]).\n  3. Patches apply atomically to the staged scratch — server reports patchesApplied and the new content stays in scratch-files.json.\n` +
                        `  4. When patches are applied across all affected files, call csaa_finalize_translation(runId). Gates re-run on the patched scratch.\n` +
                        `  5. Files NOT in the affected list stay as-is — DO NOT touch them.\n` +
                        `\n**Patch payload is tiny (~100 bytes per fix). 8 fixes across 4 files = ~3 KB total LLM output across ~4 tool calls. Per-message cap is unreachable.**\n` +
                        `\nFallback ONLY if a file needs >50% rewrite: csaa_append_translation_file (replacement mode — same relativePath overwrites the staged version).\n` +
                        (scratchExists
                            ? `\nScratch state: 05-translate/scratch-files.json holds all previously staged files. Read it via your read tool if you need to see the exact text around a violation.\n`
                            : `\nNo scratch on disk yet (file was submitted via bulk path). Start fresh via csaa_append_translation_file then patch.\n`) +
                        `\nAffected files (need correction):\n  - ${affectedFiles.join('\n  - ')}\n` +
                        `\nViolation details:${summaryLines.join('\n')}`,
                },
                `Content gates failed: ${errors.length} error(s) across ${affectedFiles.length} file(s). Use csaa_patch_translation_file (PATCH-FIRST) — do NOT recompose bulk.`,
            );
        }

        // Gate 2.5: file-kind coverage. A real migration must emit at
        // minimum 1 feature + 1 steps + 1 data file when the analysis
        // recorded any scenarios, plus one page-object file per page
        // entry with role=create-new. Otherwise the LLM can submit only
        // a steps file and pass — exactly what happened in production
        // before this gate existed.
        const analysisForKinds = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (analysisForKinds) {
            try {
                const a = JSON.parse(analysisForKinds) as {
                    scenarios?: unknown[];
                    pages?: Array<{ className: string; role?: string }>;
                };
                const scenarios = Array.isArray(a.scenarios) ? a.scenarios.length : 0;
                const newPages = (a.pages ?? []).filter((p) => p.role === 'create-new').map((p) => p.className);
                if (scenarios > 0) {
                    const kinds = {
                        feature: translation.files.filter((f) => f.kind === 'feature').length,
                        steps: translation.files.filter((f) => f.kind === 'steps').length,
                        data: translation.files.filter((f) => f.kind === 'data').length,
                        page: translation.files.filter((f) => f.kind === 'page').length,
                    };
                    const missing: string[] = [];
                    if (kinds.feature === 0) missing.push('feature');
                    if (kinds.steps === 0) missing.push('steps');
                    if (kinds.data === 0) missing.push('data');
                    if (newPages.length > kinds.page) {
                        missing.push(`page (${newPages.length} create-new pages declared in analysis, ${kinds.page} emitted)`);
                    }
                    if (missing.length > 0) {
                        return jsonResult(
                            {
                                state: 'AWAITING_LLM_RETRY',
                                runId,
                                phase: 'translate',
                                missingKinds: missing,
                                expectedKinds: { feature: 1, steps: 1, data: 1, page: newPages.length },
                                actualKinds: kinds,
                                nextStepNeeded: true,
                                nextSuggestedTool: 'csaa_record_translation',
                                feedback: `Translation is incomplete. Analysis recorded ${scenarios} scenario(s) and ${newPages.length} new page(s), but translation is missing: ${missing.join(', ')}. Every migration MUST emit at minimum:\n  - 1 .feature file under test/<project>/features/<module>/\n  - 1 .steps.ts file under test/<project>/steps/<module>/\n  - 1 scenarios JSON file under test/<project>/data/<module>/\n  - One page-object .ts file per analysis page with role='create-new': ${newPages.join(', ') || '(none)'}\n\nRe-emit the full file set and re-call csaa_record_translation.`,
                            },
                            `File-kind coverage failed: missing ${missing.join(', ')}. Retry.`,
                        );
                    }
                }
            } catch { /* malformed analysis — schema gate caught upstream */ }
        }

        // Gate 2.6: anti-collapse — one Scenario Outline cannot represent N
        // analysis scenarios that have DIFFERENT leaf actions. The LLM tends
        // to wrap N legacy tests in a single Outline with placeholder steps
        // ("I perform the steps for <scenarioId>") to avoid writing real
        // scenarios. Detect: feature contains exactly one Scenario Outline
        // AND analysis recorded ≥2 scenarios AND their step lists differ.
        const analysisForCollapse = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (analysisForCollapse) {
            try {
                const a = JSON.parse(analysisForCollapse) as {
                    scenarios?: Array<{ id: string; steps?: Array<{ keyword?: string; text?: string }> }>;
                };
                const featureFile = translation.files.find((f) => f.kind === 'feature');
                if (featureFile && Array.isArray(a.scenarios) && a.scenarios.length >= 2) {
                    const featureText = featureFile.content;
                    const scenarioCount = (featureText.match(/^\s*Scenario\s*:/gm) ?? []).length;
                    const outlineCount = (featureText.match(/^\s*Scenario\s+Outline\s*:/gm) ?? []).length;
                    if (outlineCount >= 1 && scenarioCount === 0 && a.scenarios.length >= 2) {
                        // Build step-fingerprint per analysis scenario.
                        const fingerprints = new Set<string>();
                        for (const s of a.scenarios) {
                            const fp = (s.steps ?? [])
                                .map((st) => `${(st.keyword ?? '').trim()}|${(st.text ?? '').trim().toLowerCase()}`)
                                .join('||');
                            fingerprints.add(fp);
                        }
                        if (fingerprints.size >= 2) {
                            return jsonResult(
                                {
                                    state: 'AWAITING_LLM_RETRY',
                                    runId,
                                    phase: 'translate',
                                    nextStepNeeded: true,
                                    nextSuggestedTool: 'csaa_record_translation',
                                    feedback: `Anti-collapse gate failed. Your feature file has ${outlineCount} Scenario Outline(s) and 0 plain Scenarios, but the analysis recorded ${a.scenarios.length} distinct scenarios with ${fingerprints.size} different step lists. A Scenario Outline can only parameterize scenarios that share the SAME action sequence (e.g. same clicks, same assertions, varying only by data row values). Your analysis scenarios have different leaf actions — one performs "click Search", another "click New User", another "verify error message", etc. — so they cannot collapse into a single Outline. Emit one plain "Scenario:" block per analysis scenario, each with the actual step text from analysis.scenarios[].steps. If a true subset DOES share identical steps, you may use an Outline for that subset only, but not for all ${a.scenarios.length}.`,
                                },
                                `Anti-collapse failed: 1 Outline cannot represent ${a.scenarios.length} scenarios with ${fingerprints.size} different step lists. Retry.`,
                            );
                        }
                    }
                }
            } catch { /* malformed analysis — schema gate caught upstream */ }
        }

        // Gate 2.8: generated page-object field-count vs legacy signature.
        //            Counts @CSGetElement decorators in each generated page
        //            file and compares to the legacy floor (80%). Catches
        //            "thin page object" — the 4-field page when legacy has
        //            27 — that passes every form-level gate today.
        const sigForTranslate = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigForTranslate) {
            try {
                const sig = JSON.parse(sigForTranslate) as FullSignature;
                const pageFiles = translation.files.filter((f) => f.kind === 'page');
                const pageShortfall: Array<{
                    file: string;
                    pageClass: string;
                    legacyFields: number;
                    generatedFields: number;
                    coverage: number;
                }> = [];
                for (const pf of pageFiles) {
                    const fileName = path.basename(pf.relativePath, path.extname(pf.relativePath));
                    // Match against legacy page class names (case-insensitive,
                    // suffix-tolerant).
                    const normalised = (s: string) => s.toLowerCase().replace(/page$/i, '');
                    const target = normalised(fileName);
                    const sigPage = Object.values(sig.pages).find(
                        (sp) => normalised(sp.className) === target,
                    );
                    if (!sigPage || sigPage.fields.length < 5) continue;
                    const decorators = (pf.content.match(/@CSGetElement\s*\(/g) ?? []).length;
                    const coverage = decorators / sigPage.fields.length;
                    if (coverage < 0.80) {
                        pageShortfall.push({
                            file: pf.relativePath,
                            pageClass: sigPage.className,
                            legacyFields: sigPage.fields.length,
                            generatedFields: decorators,
                            coverage,
                        });
                    }
                }
                if (pageShortfall.length > 0) {
                    const list = pageShortfall.slice(0, 6).map(
                        (p) => `  - ${p.file} (matches legacy "${p.pageClass}"): ${p.generatedFields}/${p.legacyFields} @CSGetElement decorators (${Math.round(p.coverage * 100)}% — floor 80%)`,
                    ).join('\n');
                    return jsonResult(
                        {
                            state: 'AWAITING_LLM_RETRY',
                            runId,
                            phase: 'translate',
                            pageShortfall,
                            nextStepNeeded: true,
                            nextSuggestedTool: 'csaa_record_translation',
                            feedback: `Page-coverage gate failed. Generated page object(s) have FAR fewer @CSGetElement decorators than the legacy class has @FindBy fields:\n${list}\n\nFor EACH shortfall page, call csaa_extract_page_fields(runId, pageClass) to retrieve the authoritative field list, then emit a matching @CSGetElement for every one (XPath primary, alternativeLocators[] for CSS fallbacks). The legacy field count is the floor — you may add more, never fewer.`,
                        },
                        `Page-coverage gate: ${pageShortfall.length} page(s) below 80% legacy field count. Retry.`,
                    );
                }

                // Also gate per-scenario step coverage at translate time —
                // catches the case where analysis was sufficient but the
                // translator dropped steps when emitting the feature file.
                const featureFile = translation.files.find((f) => f.kind === 'feature');
                if (featureFile) {
                    // Count Gherkin steps per scenario tag.
                    const stepsPerScenario = new Map<string, number>();
                    let currentTag: string | null = null;
                    let currentSteps = 0;
                    for (const ln of featureFile.content.split(/\r?\n/)) {
                        const t = ln.trim();
                        const tagMatch = t.match(/^@(TS_\d+|tc_\d+|case[-_]?\w+)/i);
                        if (tagMatch) {
                            currentTag = tagMatch[1];
                            continue;
                        }
                        if (/^Scenario(\s+Outline)?\s*:/i.test(t)) {
                            if (currentTag) {
                                stepsPerScenario.set(currentTag, currentSteps);
                            }
                            currentSteps = 0;
                            continue;
                        }
                        if (/^(Given|When|Then|And|But)\b/i.test(t)) {
                            currentSteps++;
                        }
                    }
                    if (currentTag) stepsPerScenario.set(currentTag, currentSteps);

                    const scenarioShortfall: Array<{
                        scenarioTag: string;
                        legacyMethod: string;
                        legacyActions: number;
                        gherkinSteps: number;
                    }> = [];
                    for (const t of sig.tests) {
                        const tag = t.testCaseId ? `TS_${t.testCaseId}` : null;
                        if (!tag) continue;
                        const expected = CSLegacySignatureExtractor.expectedActionCount(t, sig.helpers);
                        if (expected < 3) continue;
                        const gherkin = stepsPerScenario.get(tag) ??
                                       stepsPerScenario.get(t.testCaseId ?? '') ?? 0;
                        if (gherkin > 0 && gherkin / expected < 0.70) {
                            scenarioShortfall.push({
                                scenarioTag: tag,
                                legacyMethod: t.methodName,
                                legacyActions: expected,
                                gherkinSteps: gherkin,
                            });
                        }
                    }
                    if (scenarioShortfall.length > 0) {
                        const list = scenarioShortfall.slice(0, 6).map(
                            (s) => `  - @${s.scenarioTag} (legacy ${s.legacyMethod}): ${s.gherkinSteps} Gherkin steps vs ${s.legacyActions} legacy actions (${Math.round(100 * s.gherkinSteps / s.legacyActions)}% — floor 70%)`,
                        ).join('\n');
                        return jsonResult(
                            {
                                state: 'AWAITING_LLM_RETRY',
                                runId,
                                phase: 'translate',
                                scenarioShortfall,
                                nextStepNeeded: true,
                                nextSuggestedTool: 'csaa_record_translation',
                                feedback: `Step-coverage gate failed at translate. Scenarios in the feature file have far fewer Gherkin steps than the legacy @Test has leaf actions (after helper expansion):\n${list}\n\nThe feature file dropped legacy actions during translation. Re-emit the feature file with one step per legacy leaf action — expand every helper invocation via csaa_expand_helper, then include each returned action as its own step.`,
                            },
                            `Step-coverage gate: ${scenarioShortfall.length} scenario(s) below 70% legacy action coverage. Retry.`,
                        );
                    }
                }
            } catch { /* malformed signature — gate skips */ }
        }

        // Gate 3: scenarios.json column coverage.
        // The recorded analysis has scenarios[].dataRow with real columns from
        // the legacy data file. The translation's *_scenarios.json must
        // include those columns — not just {scenarioId, scenarioName, runFlag}.
        const analysisRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (analysisRaw) {
            try {
                const analysis = JSON.parse(analysisRaw) as {
                    scenarios?: Array<{ id: string; dataRow?: Record<string, unknown> }>;
                };
                const dataFile = translation.files.find((f) => f.kind === 'data');
                if (dataFile && analysis.scenarios && analysis.scenarios.length > 0) {
                    let rows: Array<Record<string, unknown>>;
                    try {
                        rows = JSON.parse(dataFile.content);
                    } catch {
                        rows = [];
                    }
                    const missing: string[] = [];
                    for (const aScn of analysis.scenarios) {
                        const expected = Object.keys(aScn.dataRow ?? {}).filter(
                            (k) => !['scenarioId', 'scenarioName', 'runFlag'].includes(k),
                        );
                        if (expected.length === 0) continue;
                        const row = rows.find(
                            (r) => String(r.scenarioId ?? '') === String(aScn.id),
                        );
                        if (!row) {
                            missing.push(`scenarioId="${aScn.id}" row not found in data JSON`);
                            continue;
                        }
                        for (const col of expected) {
                            if (!(col in row)) {
                                missing.push(`scenarioId="${aScn.id}" missing column "${col}" (was in analysis dataRow)`);
                            }
                        }
                    }
                    if (missing.length > 0) {
                        return jsonResult(
                            {
                                state: 'AWAITING_LLM_RETRY',
                                runId,
                                phase: 'translate',
                                dataColumnMisses: missing,
                                nextStepNeeded: true,
                                nextSuggestedTool: 'csaa_record_translation',
                                feedback: `scenarios.json is missing legacy data columns. The analysis recorded real test data per scenario — your JSON must include those columns, not just metadata:\n${missing.slice(0, 10).map((m) => `  - ${m}`).join('\n')}${missing.length > 10 ? `\n  ...and ${missing.length - 10} more` : ''}\n\nRe-emit the data file with every column from analysis.scenarios[].dataRow.`,
                            },
                            `scenarios.json column gate: ${missing.length} miss(es). Retry.`,
                        );
                    }
                }
            } catch { /* malformed analysis JSON — schema gate would have caught upstream */ }
        }

        // Gate 4: compile_check via tsc --noEmit. Workspace can be passed
        // explicitly via the `workspaceRoot` param, or auto-derived from the
        // entry file path persisted in intake/run-params.json (walk up to the
        // nearest dir with package.json + node_modules). This makes the
        // compile gate default-on for real runs while smoke tests still
        // skip cleanly when there's no consumer setup to point at.
        let workspaceRoot = getStr(params, 'workspaceRoot');
        if (!workspaceRoot) {
            const rp = ctx.readPhaseArtifact('intake', 'run-params.json');
            if (rp) {
                try {
                    const parsed = JSON.parse(rp) as { entryFile?: string };
                    if (parsed.entryFile) {
                        let dir = path.dirname(parsed.entryFile);
                        for (let i = 0; i < 8; i++) {
                            if (fs.existsSync(path.join(dir, 'tsconfig.json')) &&
                                fs.existsSync(path.join(dir, 'node_modules'))) {
                                workspaceRoot = dir;
                                break;
                            }
                            const parent = path.dirname(dir);
                            if (parent === dir) break;
                            dir = parent;
                        }
                    }
                } catch { /* ignore */ }
            }
        }
        const sandboxRoot = path.join(ctx.runFolder, CSRunContext.phaseFolder('translate'), 'sandbox');
        if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, 'tsconfig.json')) &&
            fs.existsSync(path.join(workspaceRoot, 'node_modules'))) try {
            // Clean sandbox + write all generated files.
            if (fs.existsSync(sandboxRoot)) fs.rmSync(sandboxRoot, { recursive: true, force: true });
            fs.mkdirSync(sandboxRoot, { recursive: true });
            const consumerRoot = workspaceRoot;
            // Copy tsconfig.json from consumer if it exists; else minimal one.
            const consumerTsconfig = path.join(consumerRoot, 'tsconfig.json');
            const sandboxTsconfig = path.join(sandboxRoot, 'tsconfig.json');
            if (fs.existsSync(consumerTsconfig)) {
                const cfg = JSON.parse(fs.readFileSync(consumerTsconfig, 'utf-8'));
                cfg.include = translation.files.filter((f) => f.relativePath.endsWith('.ts')).map((f) => f.relativePath);
                cfg.compilerOptions = cfg.compilerOptions ?? {};
                cfg.compilerOptions.baseUrl = consumerRoot;
                cfg.compilerOptions.paths = cfg.compilerOptions.paths ?? {};
                cfg.compilerOptions.noEmit = true;
                fs.writeFileSync(sandboxTsconfig, JSON.stringify(cfg, null, 2));
            }
            for (const f of translation.files) {
                if (!f.relativePath.endsWith('.ts')) continue;
                const dest = path.join(sandboxRoot, f.relativePath);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, f.content);
            }
            const compileCheck = (auditTools as MCPToolDefinition[]).find((t) => t.tool.name === 'compile_check');
            if (compileCheck && fs.existsSync(sandboxTsconfig)) {
                const res = await compileCheck.handler({ cwd: sandboxRoot }, _toolCtx);
                const sc = res.structuredContent as { clean?: boolean; errors?: Array<{ file: string; line: number; code: string; message: string }> } | undefined;
                if (sc && sc.clean === false && Array.isArray(sc.errors) && sc.errors.length > 0) {
                    ctx.writePhaseArtifact(
                        'translate',
                        'compile-errors.json',
                        JSON.stringify(sc.errors, null, 2),
                    );
                    const summary = sc.errors.slice(0, 12)
                        .map((e) => `  ${e.file}:${e.line} ${e.code}: ${e.message}`)
                        .join('\n');
                    return jsonResult(
                        {
                            state: 'AWAITING_LLM_RETRY',
                            runId,
                            phase: 'translate',
                            compileErrors: sc.errors,
                            nextStepNeeded: true,
                            nextSuggestedTool: 'csaa_record_translation',
                            feedback: `compile_check (tsc --noEmit) reported ${sc.errors.length} error(s) against the consumer's tsconfig. Fix and re-call csaa_record_translation:\n${summary}${sc.errors.length > 12 ? `\n  ...and ${sc.errors.length - 12} more` : ''}`,
                        },
                        `compile_check failed: ${sc.errors.length} TS error(s). Retry.`,
                    );
                }
            }
        } catch (err) {
            // sandbox setup error — non-blocking warning only
            ctx.writePhaseArtifact(
                'translate',
                'compile-check-error.txt',
                err instanceof Error ? (err.stack ?? err.message) : String(err),
            );
        }

        // All gates green — persist content map + per-file artefacts.
        const files: Record<string, string> = {};
        const confidence: Record<string, number> = {};
        for (const f of translation.files) {
            files[f.relativePath] = f.content;
            confidence[f.relativePath] = 1.0; // schema-validated + gate-passed
        }
        ctx.writePhaseArtifact(
            'translate',
            'content-map.json',
            JSON.stringify({ files, confidence, notes: translation.notes ?? [] }, null, 2),
        );
        for (const f of translation.files) {
            const safeName = f.relativePath.replace(/[/\\]/g, '__');
            ctx.writePhaseArtifact('translate', path.join('files', safeName), f.content);
        }
        const md = renderTranslateMarkdown(translation);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'translate', 'Translator Output', md,
        );
        ctx.finishPhase('translate', 'done', { reportPath });
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'translate',
                fileCount: translation.files.length,
                allGatesPassed: true,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_audit',
                nextSuggestedArgs: { runId },
            },
            `Translation recorded: ${translation.files.length} file(s), all gates passed. Call csaa_audit next.`,
        );
    })
    .build();

function renderTranslateMarkdown(translation: {
    files: Array<{ relativePath: string; kind: string }>;
    notes?: string[];
}): string {
    const lines: string[] = [];
    lines.push('# Translator Output');
    lines.push('');
    lines.push(`Files: ${translation.files.length}`);
    lines.push('');
    lines.push('| Kind | File |');
    lines.push('|---|---|');
    for (const f of translation.files) {
        lines.push(`| ${f.kind} | \`${f.relativePath}\` |`);
    }
    if (translation.notes && translation.notes.length > 0) {
        lines.push('');
        lines.push('## Notes');
        for (const n of translation.notes) lines.push(`- ${n}`);
    }
    lines.push('');
    return lines.join('\n');
}

// ============================================================================
// csaa_append_translation_file — chunked translate recording (one file at a time)
// ============================================================================
// Symmetric to csaa_append_analysis_scenario. Large migrations (3+ page
// objects + feature + steps + data = 5+ files, often 30-50 KB total) blow
// the LLM-host per-message output cap when submitted as a single
// csaa_record_translation payload. This tool accepts ONE TranslationFile
// per call (~1-5 KB each), stages it to `05-translate/scratch-files.json`,
// and lets the LLM stream the full translation in N small turns. After
// every file is appended, csaa_finalize_translation re-dispatches through
// csaa_record_translation so every existing gate (placeholder, dup imports,
// wrong subpath, page-coverage signature, compile_check) still fires.
//
// The scratch file survives conversation compaction.

const csaa_append_translation_file: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_append_translation_file')
    .title('CS-AI-Auto-Assist — Append one translation file (chunked)')
    .description(
        'Streams ONE generated file (feature / steps / page / data) into the translate scratch. ' +
            'Use this whenever the full translation payload would exceed the LLM-host per-message ' +
            'output cap (3+ files OR ≥4 scenarios is a safe threshold). Each call carries one ' +
            '{ relativePath, kind, content } object — small enough to never blow the message budget. ' +
            'When every file has been appended, call csaa_finalize_translation to run gates and ' +
            'persist the content map. The scratch file survives conversation compaction.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'file',
        'REQUIRED. One translation file object: { relativePath, kind, content }. relativePath relative to consumer workspace (e.g. test/<project>/features/<module>/x.feature). kind is one of: "feature" | "steps" | "page" | "data". content is the full file body. Optional: reuseDecision for reuse-existing pages.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        // v1.38.3 — POST-FINALIZE SEAL. content-map.json existence means
        // finalize already ran — reject post-finalize appends so the LLM
        // can't accidentally start a fresh streaming round-trip after the
        // phase is sealed.
        const appendSealPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('translate'),
            'content-map.json',
        );
        if (fs.existsSync(appendSealPath)) {
            return jsonResult(
                {
                    state: 'TRANSLATE_SEALED',
                    runId,
                    phase: 'translate',
                    blockedReason: 'Translate phase already finalized (content-map.json exists). DO NOT append more files. For corrections, use csaa_audit + csaa_write on the specific file.',
                    contentMapPath: appendSealPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_audit',
                    nextSuggestedArgs: { runId },
                },
                'Translate sealed — append_translation_file rejected after finalize.',
            );
        }

        const file = params.file;
        if (typeof file !== 'object' || file === null) {
            return errorResult('file must be an object', runId);
        }
        const f = file as { relativePath?: unknown; kind?: unknown; content?: unknown };
        if (typeof f.relativePath !== 'string' || !f.relativePath) {
            return errorResult('file.relativePath required (string)', runId);
        }
        if (typeof f.kind !== 'string' || !['feature', 'steps', 'page', 'data'].includes(f.kind)) {
            return errorResult(`file.kind required, one of: feature | steps | page | data (got '${String(f.kind)}')`, runId);
        }
        if (typeof f.content !== 'string') {
            return errorResult('file.content required (string)', runId);
        }
        // v1.38.5 — lowered per-file size cap from 256 KB → 32 KB. A real
        // BDD file shouldn't approach 32 KB; if it does the LLM is
        // generating bloated content that risks the per-message output cap
        // on its own. Force a split (or a gap entry for genuinely-large
        // legacy content) early.
        const PER_FILE_BYTE_CAP = 32 * 1024;
        if (f.content.length > PER_FILE_BYTE_CAP) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    fileSize: f.content.length,
                    capBytes: PER_FILE_BYTE_CAP,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_translation_file',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `File "${f.relativePath}" is ${f.content.length} bytes — exceeds the ${Math.round(PER_FILE_BYTE_CAP / 1024)} KB per-file cap. ` +
                        `A single file that large risks the per-message output cap on its own (the file plus tool-call envelope plus chat narration easily crosses 32 KB). ` +
                        `Options:\n` +
                        `  - For steps files: split scenario step-defs into <module>-1.steps.ts, <module>-2.steps.ts, etc.\n` +
                        `  - For pages: split mega-pages into per-region helpers (rare; usually means analysis lumped two pages together).\n` +
                        `  - For data files: split scenarios by domain/grouping into <module>-<group>-scenarios.json.\n` +
                        `Then re-call csaa_append_translation_file with each smaller piece.`,
                },
                `File too large (${f.content.length} > ${PER_FILE_BYTE_CAP} bytes).`,
            );
        }

        const scratchRaw = ctx.readPhaseArtifact('translate', 'scratch-files.json');
        const list: Array<{ relativePath: string; kind: string; content: string; reuseDecision?: string }> =
            scratchRaw ? JSON.parse(scratchRaw) : [];

        // v1.38.5 — REPLACEMENT MODE. Pre-seal (no content-map.json),
        // duplicate paths are an EXPECTED retry path after content-gate
        // rejection. Overwrite the prior staged entry so the LLM can
        // submit a corrected version one file at a time. Post-seal is
        // caught earlier by the post-finalize seal check.
        const dupIdx = list.findIndex((x) => x.relativePath === f.relativePath);
        const isReplacement = dupIdx >= 0;
        const entry = {
            relativePath: f.relativePath,
            kind: f.kind as 'feature' | 'steps' | 'page' | 'data',
            content: f.content,
            ...(typeof (f as { reuseDecision?: unknown }).reuseDecision === 'string' ?
                { reuseDecision: (f as { reuseDecision: string }).reuseDecision } : {}),
        };
        if (isReplacement) {
            list[dupIdx] = entry;
        } else {
            list.push(entry);
        }
        ctx.writePhaseArtifact(
            'translate',
            'scratch-files.json',
            JSON.stringify(list, null, 2),
        );

        const kindCounts = list.reduce<Record<string, number>>((acc, x) => {
            acc[x.kind] = (acc[x.kind] ?? 0) + 1;
            return acc;
        }, {});

        // v1.38 Phase 5 — advance the iterator queue (if seeded) and
        // return the NEXT item's envelope. Symmetric to the analyze
        // iterator wiring in Phase 3.
        const tFileQueue = CSWorkQueue.load(ctx);
        if (tFileQueue.total('translate') > 0) {
            const curItem = tFileQueue.peekNext('translate') as TranslateQueueItem | null;
            let advanced = false;
            if (curItem && fileMatchesTranslateItem(curItem, f.relativePath, f.kind as TranslateQueueItem['kind'])) {
                tFileQueue.advance('translate');
                advanced = true;
            }

            // Look up project/module/frameworkPkg from prior delegation
            // grounding so the next envelope has the same common context.
            let project = 'default';
            let module: string | undefined;
            let frameworkPkg = '@mdakhan.mak/cs-playwright-test-framework';
            const rpRaw = ctx.readPhaseArtifact('intake', 'run-params.json');
            if (rpRaw) {
                try {
                    const rp = JSON.parse(rpRaw) as { project?: string; module?: string };
                    project = rp.project ?? project;
                    module = rp.module;
                } catch { /* ignore */ }
            }
            // Carry forward frameworkPkg from the prior envelope if present.
            const prevEnvRaw = ctx.readPhaseArtifact('translate', 'delegation-envelope.json');
            if (prevEnvRaw) {
                try {
                    const prev = JSON.parse(prevEnvRaw) as { grounding?: { frameworkPkg?: string } };
                    if (prev.grounding?.frameworkPkg) frameworkPkg = prev.grounding.frameworkPkg;
                } catch { /* ignore */ }
            }
            const tCommon: TranslateIteratorCommonGrounding = {
                runId,
                project,
                module,
                frameworkPkg,
                analysisReportPath: path.join(
                    ctx.runFolder,
                    CSRunContext.phaseFolder('analyze'),
                    'analysis-report.json',
                ),
                skillsPath: '.github/skills/',
            };

            const nextItem = tFileQueue.peekNext('translate') as TranslateQueueItem | null;
            if (nextItem) {
                const env = buildTranslateFileEnvelope(
                    nextItem,
                    { completed: tFileQueue.completed('translate'), total: tFileQueue.total('translate') },
                    tCommon,
                );
                ctx.writePhaseArtifact(
                    'translate',
                    'delegation-envelope.json',
                    JSON.stringify(env, null, 2),
                );
                return jsonResult(
                    {
                        state: 'AWAITING_LLM_FULFILMENT',
                        runId,
                        phase: 'translate',
                        filesCollected: list.length,
                        kindCounts,
                        lastAppended: f.relativePath,
                        replaced: isReplacement,
                        delegation: env,
                        queue: {
                            current: tFileQueue.completed('translate') + 1,
                            total: tFileQueue.total('translate'),
                            progress: tFileQueue.progress('translate'),
                        },
                        iteratorMode: true,
                        queueAdvanced: advanced,
                        nextStepNeeded: true,
                        nextSuggestedTool: 'csaa_append_translation_file',
                        nextSuggestedArgs: { runId },
                    },
                    `File "${f.relativePath}" staged (${list.length}/${tFileQueue.total('translate')}). Next: produce file ${tFileQueue.completed('translate') + 1}/${tFileQueue.total('translate')} (${nextItem.kind} → ${nextItem.relativePath}).`,
                );
            }
            // Queue drained — emit the finalize envelope.
            const finalizeEnv = buildTranslateFinalizeEnvelope(list.length, tCommon);
            ctx.writePhaseArtifact(
                'translate',
                'delegation-envelope.json',
                JSON.stringify(finalizeEnv, null, 2),
            );
            return jsonResult(
                {
                    state: 'AWAITING_LLM_FULFILMENT',
                    runId,
                    phase: 'translate',
                    filesCollected: list.length,
                    kindCounts,
                    lastAppended: f.relativePath,
                    replaced: isReplacement,
                    delegation: finalizeEnv,
                    queue: {
                        current: tFileQueue.total('translate'),
                        total: tFileQueue.total('translate'),
                        progress: tFileQueue.progress('translate'),
                    },
                    iteratorMode: true,
                    queueAdvanced: advanced,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_finalize_translation',
                    nextSuggestedArgs: { runId },
                },
                `All ${list.length} file(s) staged. Call csaa_finalize_translation to run gates + persist content map.`,
            );
        }

        // Backward compat — no queue seeded (e.g. record_analysis was
        // bypassed, or non-Java legacy). Return the legacy RUNNING
        // shape so the recoveryHint still guides the LLM.
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'translate',
                filesCollected: list.length,
                kindCounts,
                lastAppended: f.relativePath,
                replaced: isReplacement,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_append_translation_file',
                recoveryHint: 'If the conversation was compacted, your staged files live at translate/scratch-files.json under the run folder. Continue appending the remaining files (one feature + one steps + N pages + one data), then call csaa_finalize_translation.',
            },
            `File "${f.relativePath}" appended (${list.length} staged: ${Object.entries(kindCounts).map(([k, v]) => `${k}=${v}`).join(', ')}).`,
        );
    })
    .build();

/**
 * Match a submitted file against a queue item. The queue uses canonical
 * paths (`test/<project>/<kind-folder>/<module>/<base>`) but the LLM may
 * submit a slightly different basename casing (e.g. FooPage.ts vs fooPage.ts).
 * Match permissively on (a) kind + (b) basename stem (case-insensitive)
 * OR (a) kind + (b) exact path.
 */
function fileMatchesTranslateItem(
    item: TranslateQueueItem,
    submittedPath: string,
    submittedKind: TranslateQueueItem['kind'],
): boolean {
    if (item.kind !== submittedKind) return false;
    if (item.relativePath === submittedPath) return true;
    const stem = (p: string) =>
        path.basename(p).toLowerCase().replace(/\.[a-z0-9]+$/, '');
    return stem(item.relativePath) === stem(submittedPath);
}

// ============================================================================
// csaa_patch_translation_file — find/replace patches on a staged file (v1.38.6)
// ============================================================================
// After content-gate rejection, the LLM previously had to re-submit the
// FULL corrected file via csaa_append_translation_file. For files near the
// per-message output cap (steps with many step-defs, feature with many
// scenarios), composing the full content in chat tips over the cap even
// after replacement-mode. Patches let the LLM submit ONLY the corrections
// — typically 50-500 bytes per fix — so the entire correction round-trip
// is ~1-2 KB total across all patches. Length limit is structurally
// unreachable.
//
// Constraints:
//  - Each patch's `find` must match the staged content exactly (literal
//    string match, no regex), case-sensitive, whitespace-significant.
//  - Each `find` must be UNIQUE in the file — server rejects ambiguous
//    patches with a count of matches so the LLM extends the pattern with
//    more context.
//  - Patches apply in array order. Earlier patches modify the buffer that
//    later patches see; the LLM must order patches by file position to
//    avoid context drift.
//  - Total `patches` payload capped at 16 KB. Above that, use append-mode
//    full-file replacement instead.

const csaa_patch_translation_file: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_patch_translation_file')
    .title('CS-AI-Auto-Assist — Patch staged translation file')
    .description(
        'Apply find/replace patches to a staged translation file (in 05-translate/scratch-files.json). ' +
            'Use this INSTEAD of csaa_append_translation_file when correcting content-gate violations: ' +
            'patches are typically 50-500 bytes each (vs 1-15 KB for a full file rewrite). For a 16-file ' +
            'translation with 5 violations across 4 files, 8 small patches across 4 calls = ~2 KB total LLM ' +
            'output. The per-message length limit is structurally unreachable. Each patch is { find, replace } ' +
            'where `find` must match exactly (case-sensitive, whitespace-significant) and be unique within ' +
            'the file. Server rejects ambiguous patches with the match count so you can add disambiguating context.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('relativePath', 'Path of the staged file to patch (must match a prior csaa_append_translation_file submission).', { required: true })
    .arrayParam(
        'patches',
        'Array of { find: string, replace: string } patches. Applied in array order. Each find must literally match exactly once in the (current) file content. Use replace="" to delete the find pattern.',
        'object',
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        // Post-finalize seal — same as other translate tools.
        const sealPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('translate'),
            'content-map.json',
        );
        if (fs.existsSync(sealPath)) {
            return jsonResult(
                {
                    state: 'TRANSLATE_SEALED',
                    runId,
                    phase: 'translate',
                    blockedReason: 'Translate phase already finalized (content-map.json exists). Patches not accepted post-seal — use csaa_audit for corrections.',
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_audit',
                    nextSuggestedArgs: { runId },
                },
                'Translate sealed — patch rejected.',
            );
        }

        const relativePath = getStr(params, 'relativePath');
        if (!relativePath) return errorResult('relativePath required', runId);

        const patchesParam = params.patches;
        if (!Array.isArray(patchesParam) || patchesParam.length === 0) {
            return errorResult('patches required (non-empty array of { find, replace })', runId);
        }
        const patches = patchesParam as Array<{ find?: unknown; replace?: unknown }>;

        // Sanity cap on total patch payload size.
        const PATCH_BYTE_CAP = 16 * 1024;
        const patchBytes = JSON.stringify(patches).length;
        if (patchBytes > PATCH_BYTE_CAP) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    patchBytes,
                    capBytes: PATCH_BYTE_CAP,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_translation_file',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `Patch payload is ${patchBytes} bytes (>${Math.round(PATCH_BYTE_CAP / 1024)} KB cap). If the corrections are this large, the file structurally needs a full rewrite — use csaa_append_translation_file with the corrected content instead (replacement mode).`,
                },
                `Patch payload too large (${patchBytes} > ${PATCH_BYTE_CAP} bytes).`,
            );
        }

        // Load scratch.
        const scratchRaw = ctx.readPhaseArtifact('translate', 'scratch-files.json');
        if (!scratchRaw) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_translation_file',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `No staged files. Cannot patch a file that hasn't been appended yet. Call csaa_append_translation_file first with the initial content, then csaa_patch_translation_file for corrections.`,
                },
                'No scratch — append before patching.',
            );
        }
        let list: Array<{ relativePath: string; kind: string; content: string; reuseDecision?: string }>;
        try {
            list = JSON.parse(scratchRaw);
        } catch {
            return errorResult('scratch-files.json is corrupt — re-append or escalate', runId);
        }
        const idx = list.findIndex((f) => f.relativePath === relativePath);
        if (idx < 0) {
            const stagedNames = list.map((f) => f.relativePath);
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    stagedFiles: stagedNames,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_translation_file',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `File "${relativePath}" is not staged. Currently staged:\n  - ${stagedNames.join('\n  - ')}\n\nEither correct the relativePath OR append the file first via csaa_append_translation_file.`,
                },
                `File "${relativePath}" not in scratch.`,
            );
        }

        // Apply patches sequentially. Each must find a UNIQUE match in the
        // current buffer state.
        let content = list[idx].content;
        const applied: Array<{ patchIndex: number; findPreview: string; replacePreview: string; bytesDelta: number }> = [];
        const failures: Array<{ patchIndex: number; find: string; reason: string; matchCount?: number }> = [];

        for (let i = 0; i < patches.length; i++) {
            const p = patches[i];
            const find = typeof p.find === 'string' ? p.find : '';
            const replace = typeof p.replace === 'string' ? p.replace : '';
            if (!find) {
                failures.push({ patchIndex: i, find: '<empty>', reason: 'patch.find is required and must be non-empty' });
                continue;
            }
            // Count occurrences via split (handles overlapping correctly enough for literal patterns).
            const matchCount = content.split(find).length - 1;
            if (matchCount === 0) {
                failures.push({
                    patchIndex: i,
                    find: find.length > 80 ? find.slice(0, 80) + '…' : find,
                    reason: 'pattern not found in file (whitespace + quoting matter; copy exact text from your prior submission or the scratch via your read tool)',
                });
                continue;
            }
            if (matchCount > 1) {
                failures.push({
                    patchIndex: i,
                    find: find.length > 80 ? find.slice(0, 80) + '…' : find,
                    reason: `pattern matches ${matchCount} times — add disambiguating context (a unique line above or below) so the find anchors to one specific occurrence`,
                    matchCount,
                });
                continue;
            }
            const beforeBytes = content.length;
            content = content.replace(find, replace);
            applied.push({
                patchIndex: i,
                findPreview: find.length > 60 ? find.slice(0, 60) + '…' : find,
                replacePreview: replace.length > 60 ? replace.slice(0, 60) + '…' : replace,
                bytesDelta: content.length - beforeBytes,
            });
        }

        if (failures.length > 0) {
            // Don't persist partial application — all-or-nothing. Otherwise
            // a partial state would force the LLM to figure out which
            // patches landed.
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    relativePath,
                    appliedCount: applied.length,
                    failureCount: failures.length,
                    failures,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_patch_translation_file',
                    feedback:
                        `${SILENCE_PREFIX.join('\n')}\n` +
                        `Patches NOT applied (all-or-nothing). ${failures.length} of ${patches.length} patches failed:\n` +
                        failures.map((f) => `  - patch[${f.patchIndex}]: ${f.reason}\n    find: "${f.find}"`).join('\n') +
                        `\n\nFix the find patterns and re-call csaa_patch_translation_file with the corrected patches array. ` +
                        `Tip: if you don't remember the exact text in scratch, your read tool can fetch <runFolder>/05-translate/scratch-files.json and you can grep for context.`,
                },
                `${failures.length}/${patches.length} patches failed — none applied.`,
            );
        }

        // All patches applied — persist.
        list[idx].content = content;
        ctx.writePhaseArtifact(
            'translate',
            'scratch-files.json',
            JSON.stringify(list, null, 2),
        );

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'translate',
                relativePath,
                patchesApplied: applied.length,
                applied,
                newContentBytes: content.length,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_finalize_translation',
                nextSuggestedArgs: { runId },
            },
            `Patched ${relativePath}: ${applied.length} fix(es) applied. Call csaa_finalize_translation to re-run gates.`,
        );
    })
    .build();

// ============================================================================
// csaa_finalize_translation — close-out of streamed translation recording
// ============================================================================

const csaa_finalize_translation: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_finalize_translation')
    .title('CS-AI-Auto-Assist — Finalize streamed translation (Phase 5 completion)')
    .description(
        'Companion to csaa_append_translation_file. Reads every staged file from the scratch ' +
            'and re-dispatches into csaa_record_translation so the full gate pipeline runs ' +
            '(schema validation + content gates + file-kind coverage + anti-collapse + ' +
            'data column coverage + page-coverage signature gate + compile_check). ' +
            'Optional `notes[]` carries free-form translator notes.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'notes',
        'Optional translator notes array, e.g. { items: ["note 1", "note 2"] }. Pass undefined to omit.',
        undefined,
    )
    .handler(async (params: Record<string, unknown>, toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        // v1.38.3 — POST-FINALIZE SEAL. Reject double-finalize.
        const finalizeSealPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('translate'),
            'content-map.json',
        );
        if (fs.existsSync(finalizeSealPath)) {
            return jsonResult(
                {
                    state: 'TRANSLATE_SEALED',
                    runId,
                    phase: 'translate',
                    blockedReason: 'Translate phase already finalized once (content-map.json exists). Cannot double-finalize. For corrections, use csaa_audit (Phase 6).',
                    contentMapPath: finalizeSealPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_audit',
                    nextSuggestedArgs: { runId },
                },
                'Translate sealed — finalize_translation rejected (already finalized).',
            );
        }

        const scratchRaw = ctx.readPhaseArtifact('translate', 'scratch-files.json');
        if (!scratchRaw) {
            return errorResult(
                `No files staged. Call csaa_append_translation_file at least once before csaa_finalize_translation, OR use csaa_record_translation with a single full-payload call.`,
                runId,
            );
        }
        let files: Array<{ relativePath: string; kind: string; content: string; reuseDecision?: string }>;
        try {
            files = JSON.parse(scratchRaw);
        } catch {
            return errorResult(
                `Scratch translation file is corrupt at translate/scratch-files.json. Delete it and re-append, or call csaa_record_translation directly.`,
                runId,
            );
        }
        if (!Array.isArray(files) || files.length === 0) {
            return errorResult(
                `Scratch translation file is empty. Call csaa_append_translation_file at least once first.`,
                runId,
            );
        }

        const notesParam = params.notes;
        const notesList: string[] = [];
        if (notesParam && typeof notesParam === 'object') {
            const items = (notesParam as { items?: unknown }).items;
            if (Array.isArray(items)) {
                for (const it of items) if (typeof it === 'string') notesList.push(it);
            }
        }

        const fullPayload = {
            files,
            ...(notesList.length > 0 ? { notes: notesList } : {}),
        };

        // Re-dispatch through csaa_record_translation. Single source of truth
        // for every gate. `_bypassSizeGate` lets the accumulated scratch (which
        // can be 5-15+ files) skip the per-call payload-size cap that exists
        // to force the streaming path on direct callers.
        const res = await csaa_record_translation.handler(
            { runId, payload: fullPayload, _bypassSizeGate: true },
            toolCtx,
        );

        // Clean the scratch on success so a follow-up append doesn't re-use it.
        const sc = res.structuredContent as { state?: string } | undefined;
        if (sc?.state === 'RUNNING') {
            try {
                const scratchPath = path.join(
                    ctx.runFolder,
                    CSRunContext.phaseFolder('translate'),
                    'scratch-files.json',
                );
                if (fs.existsSync(scratchPath)) fs.unlinkSync(scratchPath);
            } catch { /* non-fatal */ }
        }
        return res;
    })
    .build();

// ============================================================================
// csaa_audit — Phase 6: audit_file across content map
// ============================================================================

const csaa_audit: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_audit')
    .title('CS-AI-Auto-Assist — Audit (Phase 6)')
    .description(
        'Run audit_file across every translated file. Aggregates violations grouped by file, ' +
            'persists `violations.json`. Non-blocking by default — pipeline advances and the ' +
            'verifier reflects audit issues in the trust score.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const cmRaw = ctx.readPhaseArtifact('translate', 'content-map.json');
        if (!cmRaw) {
            return errorResult(`no content map — call csaa_translate first`, runId);
        }
        const contentMap = JSON.parse(cmRaw) as {
            files: Record<string, string>;
            confidence: Record<string, number>;
            notes: string[];
        };

        ctx.startPhase('audit');
        const auditFile = (auditTools as MCPToolDefinition[]).find((t) => t.tool.name === 'audit_content');
        const allViolations: Record<string, AuditViolation[]> = {};
        let totalViolations = 0;

        // Pass 1: existing framework-rule audit (audit_content tool)
        if (auditFile) {
            for (const [rel, content] of Object.entries(contentMap.files)) {
                try {
                    const res = await auditFile.handler(
                        { content, filename: rel },
                        _toolCtx,
                    );
                    const sc = res.structuredContent as
                        | { violations?: Array<{ ruleId?: string; severity?: string; line?: number; message?: string }> }
                        | undefined;
                    const list = sc?.violations ?? [];
                    if (list.length > 0) {
                        allViolations[rel] = list.map((v) => ({
                            ruleId: v.ruleId ?? 'unknown',
                            severity: (v.severity ?? 'warning') as AuditViolation['severity'],
                            line: v.line,
                            message: v.message ?? '',
                        }));
                        totalViolations += list.length;
                    }
                } catch {
                    // audit_content failure is non-fatal — recorded as warning only.
                }
            }
        }

        // Pass 2: CSContentValidator — placeholder / dup / wrong-subpath / empty-body / step-def coverage.
        // This pass catches the failure classes that the audit_content rules don't cover.
        const validatorFiles: Array<{ relativePath: string; kind: 'feature' | 'page' | 'steps' | 'data'; content: string }> = [];
        for (const [rel, content] of Object.entries(contentMap.files)) {
            const kind: 'feature' | 'page' | 'steps' | 'data' =
                rel.endsWith('.feature') ? 'feature' :
                rel.includes('/pages/') ? 'page' :
                rel.endsWith('.steps.ts') ? 'steps' :
                rel.endsWith('.json') ? 'data' :
                'page';
            validatorFiles.push({ relativePath: rel, kind, content });
        }
        const contentViolations = CSContentValidator.validateAll(validatorFiles);
        for (const v of contentViolations) {
            if (!allViolations[v.relativePath]) allViolations[v.relativePath] = [];
            allViolations[v.relativePath].push({
                ruleId: v.ruleId,
                severity: v.severity === 'error' ? 'error' : 'warning',
                line: v.line,
                message: v.message,
            });
            totalViolations++;
        }

        const errorCount = Object.values(allViolations)
            .flat()
            .filter((v) => v.severity === 'error').length;
        const clean = totalViolations === 0;
        const hasErrors = errorCount > 0;

        ctx.writePhaseArtifact(
            'audit',
            'violations.json',
            JSON.stringify(allViolations, null, 2),
        );
        const md = renderAuditMarkdown(allViolations, Object.keys(contentMap.files).length);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'audit', 'Audit Report', md,
        );
        ctx.finishPhase('audit', clean ? 'done' : (hasErrors ? 'blocked_user' : 'auto_resolved'), { reportPath });
        CSStatusWriter.write(ctx);

        if (hasErrors) {
            return jsonResult(
                {
                    state: 'BLOCKED_NEED_HUMAN',
                    runId,
                    phase: 'audit',
                    violationCount: totalViolations,
                    errorCount,
                    filesWithViolations: Object.keys(allViolations).length,
                    clean: false,
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_translate',
                    nextSuggestedArgs: { runId },
                    blockedReason: `Audit gates blocked ${errorCount} error-level violation(s). Run csaa_translate again with the violation feedback so the LLM can fix them, OR resolve manually and re-run csaa_audit.`,
                },
                `Audit BLOCKED: ${errorCount} error(s) — re-run csaa_translate to fix or escalate.`,
            );
        }

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'audit',
                violationCount: totalViolations,
                filesWithViolations: Object.keys(allViolations).length,
                clean,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_write',
                nextSuggestedArgs: { runId },
            },
            clean
                ? `Audit clean. Call csaa_write next.`
                : `Audit found ${totalViolations} warning(s). Call csaa_write next; trust score will reflect.`,
        );
    })
    .build();

function renderAuditMarkdown(
    violations: Record<string, AuditViolation[]>,
    totalFiles: number,
): string {
    const lines: string[] = [];
    const fileCount = Object.keys(violations).length;
    lines.push('# Audit Report');
    lines.push('');
    lines.push(`Files audited: ${totalFiles}  ·  Files with violations: ${fileCount}`);
    lines.push('');
    if (fileCount === 0) {
        lines.push('_All files clean._');
        return lines.join('\n');
    }
    for (const [rel, list] of Object.entries(violations)) {
        lines.push(`## \`${rel}\``);
        for (const v of list) {
            lines.push(`- **[${v.severity}] ${v.ruleId}**${v.line ? ` (line ${v.line})` : ''}: ${v.message}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_write — Phase 7: atomic per-file writer
// ============================================================================

const csaa_write: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_write')
    .title('CS-AI-Auto-Assist — Write (Phase 7)')
    .description(
        'Atomically write every file in the translator\'s ContentMap to disk under ' +
            '`workspaceRoot`. Skip-existing protection unless overwriteExisting is true. ' +
            'Persists Fix Manifest with sha256 + bytes per file.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('workspaceRoot', 'Workspace root for output (default: runContext workspace)')
    .booleanParam('overwriteExisting', 'When true, overwrite files that already exist', { default: false })
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const cmRaw = ctx.readPhaseArtifact('translate', 'content-map.json');
        if (!cmRaw) {
            return errorResult(`no content map — call csaa_translate first`, runId);
        }
        const cm = JSON.parse(cmRaw) as {
            files: Record<string, string>;
            confidence: Record<string, number>;
            notes: string[];
        };

        const workspaceRoot = getStr(params, 'workspaceRoot') ?? path.dirname(path.dirname(ctx.runFolder));
        const overwriteExisting = params.overwriteExisting === true;

        ctx.startPhase('write');
        try {
            const result = await CSWriteWithAudit.write(
                { files: cm.files, confidence: cm.confidence, notes: cm.notes },
                { workspaceRoot, overwriteExisting },
            );

            // Framework config scaffold — generate the env files the runner
            // needs to actually start tests. Without these the framework has
            // no URL, no credentials, no DB queries.
            //   config/<project>/global.env
            //   config/<project>/common/common.env
            //   config/<project>/common/<project>-db-queries.env
            //   config/<project>/environments/<env>.env  (one per env)
            const configWritten = await scaffoldFrameworkConfig(
                ctx, workspaceRoot, _toolCtx,
            );

            ctx.writePhaseArtifact(
                'write',
                'written.json',
                JSON.stringify(
                    {
                        written: [...result.written, ...configWritten],
                        skippedExisting: result.skippedExisting,
                        manifest: result.manifest,
                        configScaffolded: configWritten,
                    },
                    null, 2,
                ),
            );
            const md = CSWriteWithAudit.renderManifest(result) +
                (configWritten.length > 0
                    ? `\n\n## Framework config scaffold\n\n${configWritten.map((p) => `- \`${p}\``).join('\n')}\n`
                    : '');
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'write', 'Fix Manifest', md,
            );
            ctx.finishPhase('write', 'done', { reportPath });
            CSStatusWriter.write(ctx);

            // v1.38.4 — credentials detection. Scan the written env files
            // for placeholder/empty USERNAME or PASSWORD lines. If any are
            // missing or stub-shaped, signal credentialsMissing=true so
            // the agent prompts the user + invokes csaa_configure_credentials
            // before csaa_execute (which would fail without real creds).
            let credentialsMissing = false;
            const credentialsHint: string[] = [];
            for (const p of configWritten) {
                if (!/\benvironments[\\\/].+\.env$/i.test(p)) continue;
                try {
                    const envBody = fs.readFileSync(p, 'utf-8');
                    const userLine = envBody.split(/\r?\n/).find((l) => /^(DEFAULT_)?USERNAME\s*=/i.test(l.trim()));
                    const passLine = envBody.split(/\r?\n/).find((l) => /^(DEFAULT_)?PASSWORD\s*=/i.test(l.trim()));
                    const userVal = userLine ? userLine.split('=').slice(1).join('=').trim() : '';
                    const passVal = passLine ? passLine.split('=').slice(1).join('=').trim() : '';
                    const userMissing = !userVal || /<paste-/i.test(userVal) || /\$\{.*\}/i.test(userVal);
                    const passMissing = !passVal || /<paste-/i.test(passVal) || /^ENCRYPTED:$/i.test(passVal) || /<.*encrypt.*>/i.test(passVal);
                    if (userMissing || passMissing) {
                        credentialsMissing = true;
                        credentialsHint.push(
                            `${path.basename(p)} → ${userMissing ? 'USERNAME missing' : ''}${userMissing && passMissing ? ' + ' : ''}${passMissing ? 'PASSWORD missing/placeholder' : ''}`,
                        );
                    }
                } catch { /* non-fatal */ }
            }
            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'write',
                    written: result.written.length,
                    skippedExisting: result.skippedExisting.length,
                    auditFailed: result.auditFailed.length,
                    runFolder: ctx.runFolder,
                    reportPath,
                    credentialsMissing,
                    credentialsHint: credentialsMissing
                        ? `Login credentials missing or placeholder in ${credentialsHint.join('; ')}. Ask the user for the username + password, then call csaa_configure_credentials(runId, username, password) BEFORE csaa_execute. The password is encrypted via CSEncryptionUtil before write — plaintext never persists.`
                        : undefined,
                    nextStepNeeded: true,
                    nextSuggestedTool: credentialsMissing ? 'csaa_configure_credentials' : 'csaa_execute',
                    nextSuggestedArgs: { runId },
                    filesWritten: result.written,
                },
                credentialsMissing
                    ? `Wrote ${result.written.length} file(s). CREDENTIALS MISSING — ask the user for username + password, then call csaa_configure_credentials.`
                    : `Wrote ${result.written.length} file(s); skipped ${result.skippedExisting.length} existing. Call csaa_execute next.`,
            );
        } catch (err) {
            ctx.finishPhase('write', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_write failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

// ============================================================================
// csaa_execute — Phase 8: run scenarios + heal
// ============================================================================

const csaa_execute: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_execute')
    .title('CS-AI-Auto-Assist — Execute + Heal (Phase 8)')
    .description(
        'Run every generated feature via bdd_run_feature. On failure, classify via ' +
            'CSHealClassifier (4-category baseline + visual-evidence reclassification). ' +
            'Up to 3 heal cycles per failure are reserved; the agent prompt drives the ' +
            'patch + re-run loop using apply_patch + csaa_execute re-invoke.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('appUrl', 'Live application URL the tests should run against')
    .stringParam('project', 'Project name')
    .stringParam('env', 'Environment (dev / sit / uat)', { default: 'dev' })
    .stringParam('tags', 'Optional Cucumber tag expression to filter scenarios')
    .stringParam('workspaceRoot', 'Consumer workspace root (defaults to cwd)')
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        if (!writtenRaw) {
            return errorResult(`no written artefacts — call csaa_write first`, runId);
        }
        const written = JSON.parse(writtenRaw) as { written: string[] };
        const features = written.written.filter((p) => p.endsWith('.feature'));
        if (features.length === 0) {
            ctx.startPhase('execute');
            ctx.finishPhase('execute', 'auto_resolved', {
                reason: 'no .feature files written; nothing to execute',
            });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING', runId, phase: 'execute',
                    scenariosPassed: 0, scenariosFailed: 0,
                    nextStepNeeded: true, nextSuggestedTool: 'csaa_verify',
                    nextSuggestedArgs: { runId },
                },
                `No feature files to execute. Call csaa_verify.`,
            );
        }

        // Resolve project + env: prefer explicit params, fall back to
        // intake/run-params.json (the canonical values from intake) so the
        // execute uses the same env the analysis was authored for.
        // Defaulting to 'dev' ignores the BASE_URL the consumer put in
        // sit.env / uat.env / etc.
        let project = getStr(params, 'project');
        let env = getStr(params, 'env');
        if (!project || !env) {
            const rp = ctx.readPhaseArtifact('intake', 'run-params.json');
            if (rp) {
                try {
                    const p = JSON.parse(rp) as { project?: string; environments?: string[] };
                    if (!project) project = p.project;
                    if (!env && Array.isArray(p.environments) && p.environments.length > 0) {
                        env = p.environments[0];
                    }
                } catch { /* ignore */ }
            }
        }
        if (!project) project = 'default';
        if (!env) env = 'sit';
        const tags = getStr(params, 'tags');

        // Auto-resolve appUrl from the env file's BASE_URL if not passed.
        // This is the fix for the "csaa_execute was called without a live
        // appUrl" error — the env scaffold already has BASE_URL set
        // correctly; csaa_execute should use it instead of demanding the
        // LLM pass it explicitly.
        let appUrl = getStr(params, 'appUrl');
        let appUrlSource = appUrl ? 'param' : 'unresolved';
        const workspaceRoot = getStr(params, 'workspaceRoot') ?? process.cwd();
        if (!appUrl) {
            const envFilePath = path.resolve(
                workspaceRoot,
                'config', project, 'environments', `${env}.env`,
            );
            if (fs.existsSync(envFilePath)) {
                try {
                    const envBody = fs.readFileSync(envFilePath, 'utf-8');
                    for (const line of envBody.split(/\r?\n/)) {
                        const t = line.trim();
                        if (!t || t.startsWith('#')) continue;
                        const m = t.match(/^BASE_URL\s*=\s*(.+)$/);
                        if (m) {
                            const val = m[1].trim().replace(/^["']|["']$/g, '');
                            if (val && /^https?:\/\//i.test(val) && !val.startsWith('<')) {
                                appUrl = val;
                                appUrlSource = `env-file:${path.relative(workspaceRoot, envFilePath)}`;
                                break;
                            }
                        }
                    }
                } catch { /* non-fatal — runner will read env file again at start */ }
            }
        }
        if (!appUrl) {
            return jsonResult(
                {
                    state: 'BLOCKED_NEED_HUMAN',
                    runId,
                    phase: 'execute',
                    project,
                    env,
                    blockedReason:
                        `No appUrl resolvable. Tried:\n` +
                        `  1. explicit appUrl param — not provided\n` +
                        `  2. config/${project}/environments/${env}.env → BASE_URL — not found OR placeholder OR invalid scheme\n\n` +
                        `Either pass appUrl explicitly, or populate BASE_URL in the env file (must be https?://...). ` +
                        `If your analysis populated configFiles[].values.baseUrl/appUrl, the scaffold should have written BASE_URL; check that the env file has a real URL not a placeholder.`,
                    nextStepNeeded: true,
                },
                `Cannot execute — no appUrl resolvable from param or ${env}.env BASE_URL.`,
            );
        }

        // CSConfigurationManager reads project/env from process.env. Set
        // them here so the runner picks up the right config folder.
        // Restore originals after.
        const prevProject = process.env.PROJECT;
        const prevEnv = process.env.ENVIRONMENT;
        if (project) process.env.PROJECT = project;
        if (env) process.env.ENVIRONMENT = env;

        ctx.startPhase('execute');
        const bddRun = (bddTools as MCPToolDefinition[]).find((t) => t.tool.name === 'bdd_run_feature');
        const perFeature: Array<{
            feature: string;
            passed: boolean;
            output: string;
            failureSnippet?: string;
        }> = [];

        let totalPassed = 0;
        let totalFailed = 0;

        if (!bddRun) {
            ctx.finishPhase('execute', 'auto_resolved', {
                reason: 'bdd_run_feature tool not registered; skipping execution',
            });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING', runId, phase: 'execute',
                    scenariosPassed: 0, scenariosFailed: 0,
                    nextStepNeeded: true, nextSuggestedTool: 'csaa_verify',
                    nextSuggestedArgs: { runId },
                    note: 'bdd_run_feature not available in this environment',
                },
                `Execute skipped (bdd_run_feature not available). Call csaa_verify.`,
            );
        }

        for (const feature of features) {
            const runDir = path.join(
                CSRunContext.phaseFolder('execute'),
                'runs',
                path.basename(feature, '.feature'),
            );
            try {
                // bdd_run_feature parameter is named `path` (see
                // CSMCPBDDTools.ts:222). Don't pass `featureFile` — the
                // tool silently drops it and crashes with "path argument
                // must be of type string. Received undefined".
                const result = await bddRun.handler(
                    {
                        path: feature,
                        ...(tags ? { tags } : {}),
                    },
                    _toolCtx,
                );
                const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? '';
                ctx.writePhaseArtifact('execute', path.join(runDir, 'output.log'), text);
                const passed = !result.isError && /(passed|0 fail|all scenarios passed)/i.test(text);
                if (passed) totalPassed++;
                else totalFailed++;
                const failureSnippet = passed ? undefined : text.slice(-2000);
                perFeature.push({ feature, passed, output: text.slice(0, 800), failureSnippet });
            } catch (err) {
                totalFailed++;
                perFeature.push({
                    feature,
                    passed: false,
                    output: err instanceof Error ? err.message : String(err),
                });
                ctx.writePhaseArtifact(
                    'execute',
                    path.join(runDir, 'output.log'),
                    err instanceof Error ? err.stack ?? err.message : String(err),
                );
            }
        }

        const md = renderExecuteMarkdown(perFeature);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'execute', 'Execution Report', md,
        );
        ctx.writePhaseArtifact(
            'execute',
            'summary.json',
            JSON.stringify(
                {
                    perFeature: perFeature.map((f) => ({
                        feature: f.feature,
                        passed: f.passed,
                        failureSnippet: f.failureSnippet,
                    })),
                    totalPassed,
                    totalFailed,
                },
                null, 2,
            ),
        );
        ctx.finishPhase(
            'execute',
            totalFailed === 0 ? 'done' : 'auto_resolved',
            { reportPath },
        );
        CSStatusWriter.write(ctx);

        // Restore env so we don't leak the per-run project/env into other tools.
        if (prevProject === undefined) delete process.env.PROJECT;
        else process.env.PROJECT = prevProject;
        if (prevEnv === undefined) delete process.env.ENVIRONMENT;
        else process.env.ENVIRONMENT = prevEnv;

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'execute',
                scenariosPassed: totalPassed,
                scenariosFailed: totalFailed,
                project,
                env,
                appUrl,
                appUrlSource,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_verify',
                nextSuggestedArgs: { runId },
            },
            `Execute (${project} / ${env} @ ${appUrl}): ${totalPassed} passed / ${totalFailed} failed across ${features.length} feature(s). Call csaa_verify.`,
        );
    })
    .build();

function renderExecuteMarkdown(
    perFeature: Array<{
        feature: string;
        passed: boolean;
        output: string;
        failureSnippet?: string;
    }>,
): string {
    const lines: string[] = [];
    lines.push('# Execution Report');
    lines.push('');
    for (const f of perFeature) {
        lines.push(`## \`${f.feature}\`  ${f.passed ? 'PASS' : 'FAIL'}`);
        if (f.failureSnippet) {
            lines.push('');
            lines.push('```');
            lines.push(f.failureSnippet);
            lines.push('```');
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_verify — Phase 9a: trust score + final report
// ============================================================================

const csaa_verify: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_verify')
    .title('CS-AI-Auto-Assist — Verify (Phase 9)')
    .description(
        'Compute the trust score from the run\'s artefacts (source-grounded, executed, ' +
            'audit-passed, heal-cycles) and write the final-report.md at the run folder root.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        ctx.startPhase('verify');
        const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        const violationsRaw = ctx.readPhaseArtifact('audit', 'violations.json');
        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        const summaryRaw = ctx.readPhaseArtifact('execute', 'summary.json');

        const analysis = reportRaw ? JSON.parse(reportRaw) as Record<string, unknown> : null;
        const violations = violationsRaw ? JSON.parse(violationsRaw) as Record<string, Array<{ severity?: string }>> : {};
        const written = writtenRaw ? JSON.parse(writtenRaw) as { written: string[] } : { written: [] };
        const summary = summaryRaw
            ? (JSON.parse(summaryRaw) as { totalPassed: number; totalFailed: number })
            : { totalPassed: 0, totalFailed: 0 };

        // Multiplicative trust: ANY factor being zero → trust = 0 → verdict = FAILED.
        // No more PASS_WEAK on garbage output.
        const errorCount = Object.values(violations)
            .flat()
            .filter((v) => v.severity === 'error').length;
        const totalScenarios = summary.totalPassed + summary.totalFailed;

        const factors = {
            sourceGrounded: analysis ? 1.0 : 0.0,
            auditClean: errorCount === 0 ? 1.0 : 0.0,
            executed: totalScenarios > 0 ? 1.0 : 0.5,
            passRate: totalScenarios > 0 ? summary.totalPassed / totalScenarios : 0.5,
            filesWritten: written.written.length > 0 ? 1.0 : 0.0,
        };
        const trust =
            factors.sourceGrounded *
            factors.auditClean *
            factors.executed *
            factors.passRate *
            factors.filesWritten;

        let verdict: 'PASS' | 'PASS_PARTIAL' | 'FAILED';
        if (trust >= 0.85) verdict = 'PASS';
        else if (trust >= 0.5) verdict = 'PASS_PARTIAL';
        else verdict = 'FAILED';

        const blockers: string[] = [];
        if (factors.sourceGrounded === 0) blockers.push('no recorded analysis (csaa_analyze never fulfilled)');
        if (factors.auditClean === 0) blockers.push(`${errorCount} audit error(s)`);
        if (factors.filesWritten === 0) blockers.push('zero files written');
        if (factors.executed === 0.5) blockers.push('execution did not run');
        if (totalScenarios > 0 && summary.totalFailed > 0) {
            blockers.push(`${summary.totalFailed} of ${totalScenarios} scenario(s) failed`);
        }

        ctx.writePhaseArtifact(
            'verify',
            'trust-score.json',
            JSON.stringify({ trust, factors, verdict, blockers, summary, errorCount }, null, 2),
        );
        ctx.complete();
        CSStatusWriter.write(ctx);
        const finalPath = CSStatusWriter.writeFinalReport(ctx, {
            filesWritten: written.written,
            trustScore: trust,
            warnings: blockers,
        });

        return jsonResult(
            {
                state: verdict === 'PASS' ? 'READY' : 'BLOCKED_NEED_HUMAN',
                runId,
                phase: 'verify',
                verdict,
                trustScore: trust,
                factors,
                blockers,
                scenariosPassed: summary.totalPassed,
                scenariosFailed: summary.totalFailed,
                errorCount,
                runFolder: ctx.runFolder,
                finalReportPath: finalPath,
                nextStepNeeded: false,
            },
            `Verify: ${verdict} (trust ${trust.toFixed(2)}). ${summary.totalPassed} pass / ${summary.totalFailed} fail / ${errorCount} audit errors. ${blockers.length ? 'Blockers: ' + blockers.join('; ') : 'No blockers.'}`,
        );
    })
    .build();

// ============================================================================
// csaa_publish — Phase 9b (optional): push run results back to ADO
// ============================================================================

const csaa_publish: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_publish')
    .title('CS-AI-Auto-Assist — Publish to ADO (optional)')
    .description(
        'Push generated test cases back to an ADO test plan + suite. Walks every generated ' +
            'feature\'s scenarios and creates one ADO Test Case per scenario without an existing ' +
            '@TC_<id> tag, then injects the new TC ids back into the .feature file.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('planId', 'ADO Test Plan ID', { required: true })
    .stringParam('suiteId', 'ADO Test Suite ID', { required: true })
    .stringParam('organization', 'ADO organization (or ADO_ORGANIZATION env)')
    .stringParam('project', 'ADO project (or ADO_PROJECT env)')
    .stringParam('pat', 'ADO PAT (or ADO_PAT env, supports ENCRYPTED:)')
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        if (!writtenRaw) {
            return errorResult(`no written artefacts — call csaa_write first`, runId);
        }
        const written = JSON.parse(writtenRaw) as { written: string[] };
        const featureFiles: GeneratedFeatureSummary[] = written.written
            .filter((p) => p.endsWith('.feature'))
            .map((p) => parseFeatureForSummary(p));

        const planId = Number(params.planId);
        const suiteId = Number(params.suiteId);
        const adoCommon = {
            organization: getStr(params, 'organization') ?? '',
            project: getStr(params, 'project') ?? '',
            pat: getStr(params, 'pat') ?? '',
        };
        const pipelineOutput: PipelineOutput = {
            runId, pipelineVersion: '1.34.0',
            filesCreated: written.written, featureFiles,
        };
        try {
            const result = await CSAdoCreateBackFlow.maybeCreateBack(
                pipelineOutput, planId, suiteId, adoCommon, _toolCtx,
            );
            return jsonResult(
                {
                    state: 'READY',
                    runId,
                    phase: 'publish',
                    createdTestCaseIds: result.createdTestCaseIds,
                    linked: result.linkedScenarios,
                    skipped: result.skipped,
                    updatedFiles: result.updatedFiles,
                    nextStepNeeded: false,
                },
                `Published ${result.createdTestCaseIds.length} test case(s) to plan ${planId} suite ${suiteId}.`,
            );
        } catch (err) {
            return errorResult(
                `csaa_publish failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

function parseFeatureForSummary(filePath: string): GeneratedFeatureSummary {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* ignore */ }
    const scenarios: GeneratedScenarioSummary[] = [];
    const lines = content.split(/\r?\n/);
    let pendingTags: string[] = [];
    for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('@')) {
            for (const t of trimmed.split(/\s+/)) {
                if (t.startsWith('@')) pendingTags.push(t);
            }
            continue;
        }
        const m = trimmed.match(/^Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*$/);
        if (m) {
            const title = m[1];
            const idTag = pendingTags.find((t) => /^@(?:TS_|tc_|TC_)/i.test(t)) ?? pendingTags[0] ?? title;
            const id = idTag.replace(/^@/, '');
            const tcMatch = pendingTags.find((t) => /^@TC_\d+$/.test(t));
            scenarios.push({
                id,
                title,
                tags: pendingTags.slice(),
                tcId: tcMatch ? Number(tcMatch.replace(/^@TC_/, '')) : undefined,
            });
            pendingTags = [];
        } else if (trimmed.length > 0 && !trimmed.startsWith('#')) {
            pendingTags = [];
        }
    }
    return { filePath, content, scenarios };
}

// ============================================================================
// Helper tools — query existing pages/steps + correction memory + DOM
// ============================================================================

const csaa_query_existing_pages: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_query_existing_pages')
    .title('CS-AI-Auto-Assist — Query Existing Pages')
    .description(
        'Scan `test/<project>/pages/` for existing CS Playwright page objects and rank them ' +
            'by semantic similarity to a candidate legacy page name. Used by translator to ' +
            'reuse rather than re-create.',
    )
    .category('multiagent')
    .stringParam('workspaceRoot', 'Workspace root', { required: true })
    .stringParam('project', 'Project name', { required: true })
    .stringParam('module', 'Optional module sub-folder')
    .stringParam('candidateClassName', 'Legacy page class name to match against', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const workspaceRoot = String(params.workspaceRoot ?? '');
        const project = String(params.project ?? '');
        const candidate = String(params.candidateClassName ?? '');
        const moduleFilter = getStr(params, 'module');
        if (!workspaceRoot || !project || !candidate) {
            return errorResult('workspaceRoot, project, candidateClassName all required');
        }
        // Scope the inventory to the requested module so we only compare
        // against pages already living under `test/<project>/pages/<module>/`
        // (plus the shared `pages/common/` folder). Without this filter,
        // every page in the repo was being scored, surfacing irrelevant
        // matches and inflating the BDD-author grounding context.
        const inv = CSRepoInventory.inventory(project, { workspaceRoot, module: moduleFilter });
        const decision = CSSemanticReuse.decidePage(
            { className: candidate, sourcePath: undefined, elements: [], publicMethods: [] },
            inv.pages,
        );
        return jsonResult(decision,
            `decidePage for ${candidate}: ${decision.decision} (top score ${decision.candidates[0]?.score?.toFixed(2) ?? '0'}).`,
        );
    })
    .build();

const csaa_read_legacy_data: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_read_legacy_data')
    .title('CS-AI-Auto-Assist — Read Legacy Data File')
    .description(
        'Read a legacy data file (.xlsx, .xls, .csv, .tsv, .json, .properties, .xml) into ' +
            'typed rows. Returns columns + first N rows (cap default 100) for analyzer use.',
    )
    .category('multiagent')
    .stringParam('filePath', 'Absolute path to the data file', { required: true })
    .stringParam('sheet', 'Optional sheet name (xlsx only)')
    .handler(async (params: Record<string, unknown>) => {
        const filePath = String(params.filePath ?? '');
        if (!filePath) return errorResult('filePath required');
        const result = CSLegacyDataReader.read(filePath, {
            sheet: getStr(params, 'sheet'),
        });
        return jsonResult(result,
            result.kind === 'rows'
                ? `Read ${result.rowCount} rows / ${result.columns.length} cols from ${result.format} file.`
                : `Could not read ${filePath}: ${result.reason}`,
        );
    })
    .build();

// ============================================================================
// csaa_resolve_data_file — deterministic data-file path resolver
// ============================================================================
// VS Code Copilot's built-in `search` tool respects `.gitignore` and
// `files.exclude`. If the consumer's legacy code folder is gitignored — which
// is common for read-only reference copies — then `search` returns no
// matches even for files that physically exist on disk. The LLM then
// concludes "the xls file isn't in the workspace" and either invents data
// rows or escalates as a gap, both of which produce a bad migration.
//
// This tool sidesteps `search` entirely: it walks the inventory + workspace
// with Node's fs (no gitignore), expands Java-style annotation patterns
// like `resources/${environment.name}/testdata/<file>.xls` against each
// declared env, and returns the absolute path(s) the data file actually
// lives at. The LLM then passes those paths to `csaa_read_legacy_data`.

const csaa_resolve_data_file: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_resolve_data_file')
    .title('CS-AI-Auto-Assist — Resolve legacy data file path')
    .description(
        'Resolves a Java-style data-file annotation (e.g. ' +
            '`resources/${environment.name}/testdata/TestData.xls`) to absolute paths on ' +
            'disk, one per requested environment. Walks the inventory + workspace with Node fs ' +
            '— does NOT respect .gitignore — so legacy folders that the LLM\'s built-in search ' +
            'tool cannot see are still found. Use this whenever the @QAFDataProvider / similar ' +
            'annotation references a data file and you need its actual path before calling ' +
            'csaa_read_legacy_data.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam(
        'annotationValue',
        'The dataFile annotation value as written in the legacy Java/C# (e.g. "resources/${environment.name}/testdata/TestData.xls"). ' +
            'Supports placeholders ${environment.name}, ${env}, ${envName}.',
        { required: true },
    )
    .stringParam(
        'environments',
        'Comma-separated env names to expand (e.g. "sit,uat,dev"). Defaults to the env list extracted by csaa_discover, or "sit" if absent.',
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const annotationValue = getStr(params, 'annotationValue');
        if (!annotationValue) return errorResult('annotationValue required', runId);

        // Load inventory to learn workspace root + known data file paths.
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult('no inventory — run csaa_discover before csaa_resolve_data_file', runId);
        }
        let inv: LegacyInventory;
        try { inv = JSON.parse(inventoryRaw); }
        catch { return errorResult('inventory.json is corrupt — re-run csaa_discover', runId); }

        // Determine env list.
        let envList: string[] = [];
        const envParam = getStr(params, 'environments');
        if (envParam) {
            envList = envParam.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
            // Look at directory names under resources/ in the inventory.
            const envSet = new Set<string>();
            for (const c of inv.propertiesFiles ?? []) {
                const m = (c as string).match(/[\/\\]resources[\/\\]([^\/\\]+)[\/\\]/i);
                if (m && m[1] !== 'sit' && m[1] !== 'dev' && m[1] !== 'uat' && m[1] !== 'qa' && m[1] !== 'prod') {
                    // ignore weird folders; below we add the common defaults
                }
                if (m) envSet.add(m[1]);
            }
            envList = envSet.size > 0 ? [...envSet] : ['sit'];
        }

        // Workspace root: the inventory's rootPath. v1.38.2 — single-walk
        // multi-extension matcher; was previously a quadratic per-env x
        // per-ext set of separate walks that hung on large repos. Now the
        // resolver does at most TWO tree walks per env (with-env-segment,
        // then basename-only) and each walk tests all alt-extension
        // basenames in one pass.
        const inferredRoot = inv.rootPath;
        if (!inferredRoot || !fs.existsSync(inferredRoot)) {
            return errorResult(`inventory rootPath '${inferredRoot}' missing on disk`, runId);
        }
        const workspaceRoot = inferredRoot;

        // Expand placeholders for each env, then resolve.
        const placeholderRe = /\$\{(?:environment\.name|env|envName)\}/gi;
        const resolved: Array<{
            env: string;
            relativePath: string;
            absolutePath: string;
            exists: boolean;
            fileSize?: number;
            resolutionStrategy?: string;
        }> = [];
        const baseName = path.basename(annotationValue);
        // Alt-basename set covering common extension swaps. Legacy code
        // often annotates one extension while the file on disk has another
        // (e.g. annotation says .xls, file is .xml).
        const baseStem = baseName.replace(/\.[a-z0-9]+$/i, '');
        const altExts = ['.xls', '.xlsx', '.xml', '.csv', '.tsv', '.json', '.yaml', '.yml'];
        const altBasenames = [
            baseName,
            ...altExts.map((e) => baseStem + e).filter((b) => b.toLowerCase() !== baseName.toLowerCase()),
        ];

        for (const env of envList) {
            const expanded = annotationValue.replace(placeholderRe, env);
            // 1. Direct join (cheap fs.existsSync) — try each alt-extension.
            let resolvedHere = false;
            for (const tryName of altBasenames) {
                const tryRel = expanded.replace(baseName, tryName);
                const direct = path.resolve(workspaceRoot, tryRel);
                if (fs.existsSync(direct)) {
                    resolved.push({
                        env,
                        relativePath: tryRel,
                        absolutePath: direct,
                        exists: true,
                        fileSize: fs.statSync(direct).size,
                        resolutionStrategy: tryName === baseName ? 'direct' : `direct-alt-ext(${tryName})`,
                    });
                    resolvedHere = true;
                    break;
                }
            }
            if (resolvedHere) continue;
            // 2. Single env-segment walk testing all alt-basenames in one pass.
            //    We do NOT fall back to a basename-only walk here — that
            //    would return a file from a DIFFERENT env's folder for a
            //    missing env (misleading). Callers can re-call without the
            //    `${environment.name}` placeholder if their project has a
            //    single shared data file.
            const found = findFileMultiExt(workspaceRoot, altBasenames, { envFilter: env });
            const strategy = 'bfs-env-segment';
            if (found) {
                resolved.push({
                    env,
                    relativePath: path.relative(workspaceRoot, found),
                    absolutePath: found,
                    exists: true,
                    fileSize: fs.statSync(found).size,
                    resolutionStrategy: `${strategy}(${path.basename(found)})`,
                });
            } else {
                resolved.push({
                    env,
                    relativePath: expanded,
                    absolutePath: path.resolve(workspaceRoot, expanded),
                    exists: false,
                });
            }
        }

        // Also check inventory.dataFiles for any match — sometimes the
        // annotation pattern differs from the actual on-disk name (e.g.
        // TestData.xls vs Test_Data.xls). Surface candidates.
        const inventoryCandidates: Array<{ path: string; basename: string }> = [];
        const targetStem = baseName.toLowerCase().replace(/\.[a-z0-9]+$/, '');
        for (const d of inv.dataFiles ?? []) {
            const p = String(d);
            const b = path.basename(p).toLowerCase();
            const bStem = b.replace(/\.[a-z0-9]+$/, '');
            // Exact match, OR either name contains the other's stem, OR
            // they share a long common prefix (≥5 chars or ≥60% of the
            // shorter). Catches OrdersDataFile.xls vs OrdersData.xls in
            // either direction.
            const prefixLen = commonPrefixLen(bStem, targetStem);
            const minLen = Math.min(bStem.length, targetStem.length);
            const enoughPrefix = prefixLen >= 5 || (minLen > 0 && prefixLen / minLen >= 0.6);
            if (b === baseName.toLowerCase() ||
                bStem.includes(targetStem) || targetStem.includes(bStem) ||
                enoughPrefix) {
                inventoryCandidates.push({ path: p, basename: path.basename(p) });
            }
        }

        const foundCount = resolved.filter((r) => r.exists).length;
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                annotationValue,
                workspaceRoot,
                requestedEnvs: envList,
                resolved,
                inventoryCandidates,
                foundCount,
                missingCount: resolved.length - foundCount,
            },
            foundCount > 0
                ? `Resolved ${foundCount}/${resolved.length} env(s) for "${baseName}". Pass any of the absolute paths to csaa_read_legacy_data.`
                : `No env resolved "${baseName}". Inventory has ${inventoryCandidates.length} similar file(s) — try those, or escalate as a high-severity gap.`,
        );
    })
    .build();

/**
 * Generate the framework config scaffold for the current run. Pulls
 * project name, environments, and DB aliases from the recorded analysis
 * and invokes the existing `generate_config_scaffold` +
 * `generate_db_queries_config` tools — writing:
 *   config/<project>/global.env
 *   config/<project>/common/common.env
 *   config/<project>/environments/<env>.env  (one per env)
 *   config/<project>/common/<project>-db-queries.env  (stub if no queries)
 *
 * Returns the list of absolute file paths created.
 */
async function scaffoldFrameworkConfig(
    ctx: CSRunContext,
    workspaceRoot: string,
    _toolCtx: MCPToolContext,
): Promise<string[]> {
    const written: string[] = [];
    const analysisRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
    if (!analysisRaw) return written;
    let analysis: Record<string, unknown> & {
        feature?: { slug?: string };
        configFiles?: Array<{ env?: string; values?: Record<string, string> }>;
    };
    try { analysis = JSON.parse(analysisRaw); } catch { return written; }

    // Priority order for project + module resolution:
    //   1. intake/run-params.json — user-supplied at csaa_analyze time (authoritative)
    //   2. plan/migration-plan.json — legacy artefact, may not exist
    //   3. analysis.feature.slug — last resort fallback
    // Without (1) the scaffold previously fell back to feature.slug, which
    // the LLM tends to set to the module name (e.g. the per-module name
    // instead of the project name), landing the config files under
    // config/<module>/ instead of config/<project>/.
    let project: string | undefined;
    let module: string | undefined;
    const runParamsRaw = ctx.readPhaseArtifact('intake', 'run-params.json');
    if (runParamsRaw) {
        try {
            const rp = JSON.parse(runParamsRaw) as { project?: string; module?: string };
            project = rp.project;
            module = rp.module;
        } catch { /* ignore */ }
    }
    if (!project) {
        const planRaw = ctx.readPhaseArtifact('plan', 'migration-plan.json');
        if (planRaw) {
            try {
                const plan = JSON.parse(planRaw) as { project?: string; module?: string };
                project = plan.project ?? project;
                module = module ?? plan.module;
            } catch { /* ignore */ }
        }
    }
    project = project ?? (analysis.feature?.slug ?? '').toLowerCase();
    if (!project || project === 'default') {
        // Defensive — the analyze gate should have caught this, but if
        // scaffold is reached with no real project name we refuse to
        // create config/default/ (a known-bad fallback path).
        ctx.writePhaseArtifact(
            'write',
            'config-scaffold-error.txt',
            `Refusing to scaffold config — project name resolved to '${project || '<empty>'}'. ` +
            'Re-run csaa_classify with the desired project name (e.g. project=<your-project>) ' +
            'so intake/run-params.json carries a real project value before csaa_write.',
        );
        return written;
    }
    module = module ?? project;

    // Derive env list + per-env URLs + per-env credentials from
    // analysis.configFiles[]. The LLM is instructed (STEP 3 of the analyze
    // envelope) to populate values: { url, username, password, ... } when it
    // parses each properties file. If populated, those real values land in
    // the generated environments/<env>.env files. Otherwise the scaffold
    // falls back to placeholder URLs and blank credential lines.
    const envs = new Set<string>();
    const envBaseUrls: Record<string, string> = {};
    const envCredentials: Record<string, { username?: string; password?: string }> = {};
    let fallbackBaseUrl: string | undefined;
    // Match values keys broadly: legacy properties files often use dotted
    // keys (env.baseurl, app.url, db.user) — we accept any key whose
    // lower-cased form matches one of the synonyms below.
    //
    // CRITICAL: BASE_URL must be the WEB APP URL, not a DB connection
    // string. Legacy env.properties files commonly carry both:
    //   env.baseurl = https://app.example.com
    //   db.connection.url = jdbc:oracle:thin:@//host:1521/service
    // The previous matcher accepted the FIRST key whose normalized form
    // ended in "url" — which happened to be the JDBC string for some
    // files, so BASE_URL landed at `jdbc:oracle:thin:@//...`. We now
    // prefer web-URL keys (web/app/ui/portal/base/host with `url`/`host`
    // suffix) AND reject non-http schemes outright.
    const pick = (
        values: Record<string, string>,
        synonyms: string[],
        forbidSchemes: string[] = [],
    ): string | undefined => {
        // Two-pass: first prefer keys whose normalized form is exactly a
        // synonym; fall back to suffix match. Within each pass, reject any
        // value whose scheme is in forbidSchemes.
        const passes: Array<(norm: string, syn: string) => boolean> = [
            (n, s) => n === s,
            (n, s) => n.endsWith(s),
        ];
        for (const test of passes) {
            for (const [k, val] of Object.entries(values)) {
                if (!val) continue;
                const norm = k.toLowerCase().replace(/[._-]/g, '');
                if (!synonyms.some((s) => test(norm, s))) continue;
                if (forbidSchemes.length > 0) {
                    const lower = val.toLowerCase().trim();
                    if (forbidSchemes.some((sch) => lower.startsWith(sch))) continue;
                }
                return val;
            }
        }
        return undefined;
    };
    // Web URL synonyms — DO NOT include bare `url` first because db.url /
    // dbconnectionurl will match it. Web-specific tokens come first.
    const URL_SYNONYMS = [
        'baseurl', 'appurl', 'webappurl', 'webhost', 'apphost',
        'portalurl', 'uiurl', 'siteurl', 'serviceurl',
        // bare 'url' / 'host' only matches if it's not a db.* key (the
        // dotted-key check above strips dots but db. prefix is captured by
        // the synonym not matching dbconnectionurl etc.)
        'url', 'host',
    ];
    const FORBIDDEN_URL_SCHEMES = ['jdbc:', 'mongodb:', 'redis:', 'amqp:', 'kafka:', 'ldap:', 'ldaps:', 'file:', 'ftp:'];
    for (const c of analysis.configFiles ?? []) {
        if (c.env) envs.add(c.env);
        const v = (c as { values?: Record<string, string> }).values;
        if (!v) continue;
        // Filter out db.* / database.* / jdbc.* keys before URL matching —
        // otherwise db.url etc. wins the suffix match.
        const webOnly: Record<string, string> = {};
        for (const [k, val] of Object.entries(v)) {
            if (/^(?:db|database|jdbc|datasource|connection)\b/i.test(k)) continue;
            webOnly[k] = val;
        }
        let url = pick(webOnly, URL_SYNONYMS, FORBIDDEN_URL_SCHEMES);
        // Additional sanity: require http(s) scheme. If the picked value is
        // somehow still non-http (e.g. a hostname without scheme), prepend
        // https://. If it's a known-bad scheme, discard.
        if (url) {
            const lower = url.toLowerCase().trim();
            if (FORBIDDEN_URL_SCHEMES.some((sch) => lower.startsWith(sch))) {
                url = undefined;
            } else if (!/^https?:\/\//i.test(url) && /^[a-z0-9.-]+(:\d+)?(\/|$)/i.test(url)) {
                // Hostname-only value → assume https.
                url = `https://${url.replace(/^\/+/, '')}`;
            } else if (!/^https?:\/\//i.test(url)) {
                url = undefined;
            }
        }
        const user = pick(v, ['username', 'user', 'defaultusername', 'loginusername', 'testusername', 'appuser']);
        const pwd = pick(v, ['password', 'pwd', 'pass', 'defaultpassword', 'loginpassword', 'testpassword', 'apppassword']);
        if (c.env) {
            if (url) envBaseUrls[c.env] = url;
            if (user || pwd) envCredentials[c.env] = { username: user, password: pwd };
        } else if (!fallbackBaseUrl && url) {
            fallbackBaseUrl = url;
        }
    }
    const environments = envs.size > 0 ? [...envs] : ['sit'];
    const baseUrl = fallbackBaseUrl;

    // Preserve + override process.cwd so the generation tools write into the
    // consumer's workspace, not the framework's own dir.
    const prevCwd = process.cwd();
    let scaffoldCwd: string | undefined;
    // Ensure context.log exists — generation tools call it unconditionally.
    const scaffoldCtx: MCPToolContext = {
        ..._toolCtx,
        log: ((_toolCtx as { log?: (...args: unknown[]) => void }).log ?? (() => { /* no-op */ })) as MCPToolContext['log'],
    } as MCPToolContext;
    try {
        if (workspaceRoot && fs.existsSync(workspaceRoot)) {
            try { process.chdir(workspaceRoot); scaffoldCwd = workspaceRoot; } catch { /* ignore */ }
        }

        const genScaffold = (generationTools as MCPToolDefinition[]).find(
            (t) => t.tool.name === 'generate_config_scaffold',
        );
        if (genScaffold) {
            try {
                const res = await genScaffold.handler(
                    {
                        project,
                        ...(module ? { module } : {}),
                        environments,
                        ...(baseUrl ? { baseUrl } : {}),
                        ...(Object.keys(envBaseUrls).length > 0 ? { envBaseUrls } : {}),
                        ...(Object.keys(envCredentials).length > 0 ? { envCredentials } : {}),
                        crossDomainEnabled: true,
                    },
                    scaffoldCtx,
                );
                const sc = res.structuredContent as
                    | { filesGenerated?: string[]; filesUpdated?: string[] }
                    | undefined;
                for (const p of sc?.filesGenerated ?? []) written.push(p);
                for (const p of sc?.filesUpdated ?? []) written.push(p);
            } catch (err) {
                ctx.writePhaseArtifact(
                    'write',
                    'config-scaffold-error.txt',
                    err instanceof Error ? (err.stack ?? err.message) : String(err),
                );
            }
        }

        const genDbQueries = (generationTools as MCPToolDefinition[]).find(
            (t) => t.tool.name === 'generate_db_queries_config',
        );
        if (genDbQueries) {
            try {
                // Empty queries[] → header-only stub the consumer can fill in.
                // If analysis later captures SQL, we'd pass real entries here.
                const res = await genDbQueries.handler(
                    {
                        project,
                        module,
                        queries: [],
                    },
                    scaffoldCtx,
                );
                const sc = res.structuredContent as
                    | { filePath?: string; filesGenerated?: string[]; filesUpdated?: string[] }
                    | undefined;
                if (sc?.filePath) written.push(sc.filePath);
                for (const p of sc?.filesGenerated ?? []) {
                    if (!written.includes(p)) written.push(p);
                }
                for (const p of sc?.filesUpdated ?? []) {
                    if (!written.includes(p)) written.push(p);
                }
            } catch (err) {
                ctx.writePhaseArtifact(
                    'write',
                    'db-queries-scaffold-error.txt',
                    err instanceof Error ? (err.stack ?? err.message) : String(err),
                );
            }
        }
    } finally {
        if (scaffoldCwd) {
            try { process.chdir(prevCwd); } catch { /* ignore */ }
        }
    }
    return written;
}

// ============================================================================
// csaa_read_config_file — deterministic config/properties reader (v1.38.4)
// ============================================================================
// VS Code Copilot's built-in `read` respects .gitignore — legacy reference
// folders (LegacySeleniumCodeForConversion/...) are typically gitignored,
// so the LLM cannot reach env.properties via its native tool. This walks
// Node fs directly, parses k=v pairs, classifies keys into urlKeys /
// credentialKeys / dbKeys, and auto-detects env from path. Result feeds
// directly into analysis.configFiles[].values which feeds the generated
// config/<project>/environments/<env>.env scaffold.

const csaa_read_config_file: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_read_config_file')
    .title('CS-AI-Auto-Assist — Read legacy config/properties file (bypasses gitignore)')
    .description(
        'Reads a legacy .properties / .env / .cfg / .ini / .yaml / .yml / .json config file ' +
            'from disk via Node fs (bypasses .gitignore — Copilot\'s built-in read does not work ' +
            'on legacy reference folders that are typically gitignored). Parses key=value pairs ' +
            '(.properties / .env / .cfg / .ini) or JSON (.yaml / .yml / .json), returns the full ' +
            'values object plus key classification (urlKeys: contain url/host, credentialKeys: ' +
            'contain user/password/secret, dbKeys: db.* prefix). Auto-detects env from the path ' +
            '(resources/<env>/env.properties pattern). Use the returned `values` object to ' +
            'populate analysis.configFiles[i].values — without it, the generated env scaffold has ' +
            'placeholder URLs and blank credentials.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('filePath', 'Absolute path to the config file. May come from inventory.propertiesFiles[] or via fuzzy-match.', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const filePath = getStr(params, 'filePath');
        if (!filePath) return errorResult('filePath required', runId);
        if (!fs.existsSync(filePath)) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    error: `config file '${filePath}' not found on disk`,
                    suggestion: 'Verify path. If unsure, check inventory.propertiesFiles[] in 02-discover/inventory.json or use csaa_resolve_data_file with the annotation value.',
                },
                `config file '${filePath}' not found`,
            );
        }
        let raw: string;
        try { raw = fs.readFileSync(filePath, 'utf-8'); }
        catch (err) {
            return errorResult(`failed to read '${filePath}': ${err instanceof Error ? err.message : String(err)}`, runId);
        }
        const ext = path.extname(filePath).toLowerCase();
        const values: Record<string, string> = {};
        if (ext === '.json') {
            try {
                const obj = JSON.parse(raw);
                if (typeof obj === 'object' && obj !== null) {
                    for (const [k, v] of Object.entries(obj)) {
                        values[k] = typeof v === 'string' ? v : JSON.stringify(v);
                    }
                }
            } catch (err) {
                return errorResult(`'${filePath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, runId);
            }
        } else if (ext === '.yaml' || ext === '.yml') {
            // Minimal flat YAML parser (k: v on each line). For deep YAML
            // the user can pass a pre-flattened JSON instead.
            for (const line of raw.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const m = trimmed.match(/^([^:]+):\s*(.*)$/);
                if (m) {
                    const k = m[1].trim();
                    let v = m[2].trim();
                    // strip surrounding quotes
                    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                        v = v.slice(1, -1);
                    }
                    values[k] = v;
                }
            }
        } else {
            // .properties / .env / .cfg / .ini — k=v pairs, # or ! comments.
            for (const line of raw.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const k = trimmed.slice(0, eqIdx).trim();
                    const v = trimmed.slice(eqIdx + 1).trim();
                    values[k] = v;
                }
            }
        }

        // Classify keys so the LLM knows which to lift into the analysis.
        const keys = Object.keys(values);
        const lower = (s: string): string => s.toLowerCase();
        const urlKeys = keys.filter((k) => /url|host|endpoint|baseuri|baseurl|appurl|loginurl/i.test(lower(k)) && !/db\.|database\.|jdbc/i.test(lower(k)));
        const credentialKeys = keys.filter((k) => /user|pass|secret|token|apikey|credential/i.test(lower(k)));
        const dbKeys = keys.filter((k) => /^db\.|^database\.|jdbc/i.test(lower(k)));
        const otherKeys = keys.filter((k) =>
            !urlKeys.includes(k) && !credentialKeys.includes(k) && !dbKeys.includes(k),
        );

        // Detect env from path: resources/<env>/env.properties etc.
        let detectedEnv: string | undefined;
        const envMatch = filePath.match(/[\\\/]resources?[\\\/]([^\\\/]+)[\\\/]/i);
        if (envMatch) detectedEnv = envMatch[1];

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                filePath,
                fileExt: ext,
                detectedEnv,
                keyCount: keys.length,
                keys,
                values,
                urlKeys,
                credentialKeys,
                dbKeys,
                otherKeys,
                hint: 'Populate analysis.configFiles[i] with { path: filePath, env: detectedEnv, keysExtracted: keys, values: values }. The `values` object is critical — without it, the generated env scaffold has placeholder URLs and blank credentials.',
            },
            `Read ${keys.length} key(s) from ${path.basename(filePath)} (env=${detectedEnv ?? 'unknown'}). urlKeys: ${urlKeys.length}, credentialKeys: ${credentialKeys.length}, dbKeys: ${dbKeys.length}.`,
        );
    })
    .build();

// ============================================================================
// csaa_configure_credentials — encrypted credential writer (v1.38.4)
// ============================================================================
// Phase 7.5 helper. When csaa_write reports credentialsMissing=true, the
// agent asks the user for the real username + password in chat, then
// invokes this tool. The password is encrypted via CSEncryptionUtil
// (AES-256-GCM, "ENCRYPTED:base64" format) before write — plaintext never
// persists to disk. The framework's runtime config layer decrypts at
// runtime when the test starts.

const csaa_configure_credentials: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_configure_credentials')
    .title('CS-AI-Auto-Assist — Configure encrypted credentials (Phase 7.5)')
    .description(
        'Writes USERNAME + ENCRYPTED:base64 PASSWORD to config/<project>/environments/<env>.env. ' +
            'The password is encrypted via CSEncryptionUtil (AES-256-GCM); plaintext never lands ' +
            'on disk. Use this after csaa_write returns credentialsMissing=true. Ask the user ' +
            'for the username + password in chat (the ONE exception to the no-user-interruption ' +
            'rule), then invoke this tool with their values. Existing USERNAME/PASSWORD lines ' +
            'are overwritten; other keys in the env file are preserved.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('username', 'Plaintext username. Stored as USERNAME=<value> in the env file.', { required: true })
    .stringParam('password', 'Plaintext password. Encrypted via CSEncryptionUtil before write — plaintext is NOT persisted.', { required: true })
    .stringParam('project', 'Target CS Playwright project name. Defaults to run-params.project.')
    .stringParam('environment', 'Target environment name (e.g. sit / dev / uat). Defaults to first env from the analysis configFiles.')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const username = getStr(params, 'username');
        const password = getStr(params, 'password');
        if (!username || !password) {
            return errorResult('username + password required (plaintext; password is encrypted before write)', runId);
        }

        // Resolve project + env.
        let project = getStr(params, 'project');
        const rpRaw = ctx.readPhaseArtifact('intake', 'run-params.json');
        if (!project && rpRaw) {
            try { project = (JSON.parse(rpRaw) as { project?: string }).project; } catch { /* ignore */ }
        }
        if (!project) return errorResult('project not provided and not found in run-params.json — pass it explicitly', runId);

        let environment = getStr(params, 'environment');
        if (!environment) {
            const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
            if (reportRaw) {
                try {
                    const r = JSON.parse(reportRaw) as { configFiles?: Array<{ env?: string }> };
                    environment = r.configFiles?.find((c) => typeof c.env === 'string')?.env;
                } catch { /* ignore */ }
            }
        }
        if (!environment) environment = 'sit';

        // Build target env file path. Mirrors scaffoldFrameworkConfig.
        const consumerRoot = process.cwd();
        const envFilePath = path.resolve(
            consumerRoot,
            'config', project, 'environments', `${environment}.env`,
        );

        // Encrypt password.
        let encrypted: string;
        try {
            const { CSEncryptionUtil } = await import('../../utils/CSEncryptionUtil');
            encrypted = CSEncryptionUtil.getInstance().encrypt(password);
        } catch (err) {
            return errorResult(`failed to encrypt password: ${err instanceof Error ? err.message : String(err)}`, runId);
        }

        // Read existing file (preserve other keys), update USERNAME/PASSWORD.
        let existing = '';
        if (fs.existsSync(envFilePath)) {
            try { existing = fs.readFileSync(envFilePath, 'utf-8'); } catch { /* ignore */ }
        }
        const lines = existing.split(/\r?\n/);
        const updated: string[] = [];
        let sawUser = false;
        let sawPass = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { updated.push(line); continue; }
            if (/^USERNAME\s*=/i.test(trimmed) || /^DEFAULT_USERNAME\s*=/i.test(trimmed)) {
                updated.push(`USERNAME=${username}`);
                sawUser = true;
            } else if (/^PASSWORD\s*=/i.test(trimmed) || /^DEFAULT_PASSWORD\s*=/i.test(trimmed)) {
                updated.push(`PASSWORD=${encrypted}`);
                sawPass = true;
            } else {
                updated.push(line);
            }
        }
        if (!sawUser) updated.push(`USERNAME=${username}`);
        if (!sawPass) updated.push(`PASSWORD=${encrypted}`);

        try {
            fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
            fs.writeFileSync(envFilePath, updated.join('\n').replace(/\n\n+$/, '\n'), 'utf-8');
        } catch (err) {
            return errorResult(`failed to write env file: ${err instanceof Error ? err.message : String(err)}`, runId);
        }

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                envFilePath,
                project,
                environment,
                passwordEncrypted: true,
                encryptionFormat: 'AES-256-GCM (CSEncryptionUtil); ENCRYPTED:base64 prefix',
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_execute',
                nextSuggestedArgs: { runId },
            },
            `Credentials written to ${path.relative(consumerRoot, envFilePath)}. Password encrypted via CSEncryptionUtil; plaintext NOT stored. Call csaa_execute next.`,
        );
    })
    .build();

// ============================================================================
// csaa_expand_helper — Deterministic helper-method body extraction
// ============================================================================
// The LLM calls this during analyze to get the authoritative leaf-action list
// inside a helper method (e.g. SomeHelper.someMethod). It MUST then emit
// one Gherkin step per returned action — no more "Execute shared support
// flow X" stubs.

const csaa_expand_helper: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_expand_helper')
    .title('CS-AI-Auto-Assist — Expand legacy helper method body')
    .description(
        'Returns the ordered leaf-action list for a single helper method in a legacy Java ' +
            'source file. The LLM MUST call this for every helper invocation it encounters ' +
            'in a @Test body (e.g. SomeHelper.someMethod(args)), then emit one Gherkin ' +
            'step per returned action. Resolves the helper file from the discover inventory ' +
            'or by searching the workspace.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('helperClass', 'Java class name (e.g. SomeSupportMethods)', { required: true })
    .stringParam('helperMethod', 'Method name (e.g. setupAndLogin)', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const helperClass = getStr(params, 'helperClass');
        const helperMethod = getStr(params, 'helperMethod');
        if (!helperClass || !helperMethod) {
            return errorResult('helperClass + helperMethod required', runId);
        }

        // Try the cached signature first.
        const sigRaw = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigRaw) {
            try {
                const sig = JSON.parse(sigRaw) as FullSignature;
                const cached = sig.helpers[`${helperClass}.${helperMethod}`];
                if (cached) {
                    return jsonResult(
                        {
                            state: 'RUNNING',
                            runId,
                            helperClass,
                            helperMethod,
                            filePath: cached.filePath,
                            actionCount: cached.actions.length,
                            actions: cached.actions,
                        },
                        `Expanded ${helperClass}.${helperMethod}: ${cached.actions.length} leaf action(s).`,
                    );
                }
            } catch { /* fall through */ }
        }

        // Cache miss → resolve and extract on the fly.
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult('no inventory — run csaa_discover first', runId);
        }
        const inv = JSON.parse(inventoryRaw) as LegacyInventory;
        const helpers = (inv.helpers ?? []).map((h) => ({
            className: path.basename(h as string, path.extname(h as string)),
            path: h as string,
        }));
        const pages = (inv.pages ?? []).map((p) => ({
            className: path.basename(p as string, path.extname(p as string)),
            path: p as string,
        }));
        // ALSO search every Java/C# source file in the inventory by basename
        // — the classifier may have tagged the file as 'unknown' (e.g. a
        // utility class whose filename doesn't end in Helper/Util/Utility/
        // Support and isn't under a helpers/utils/utilities/support/common
        // directory). Match by class name == file basename (case-sensitive).
        const sourceFiles = (inv.files ?? [])
            .filter((f) => typeof f === 'object' && f !== null && 'extension' in f &&
                ((f as { extension?: string }).extension === '.java' ||
                 (f as { extension?: string }).extension === '.cs'))
            .map((f) => ({
                className: path.basename((f as { path: string }).path, path.extname((f as { path: string }).path)),
                path: (f as { path: string }).path,
            }));
        const all = [...helpers, ...pages, ...sourceFiles];
        let found = all.find((x) => x.className === helperClass);
        // Final safety net: walk the project tree looking for
        // <helperClass>.java / .cs on disk. Catches files the classifier
        // mistagged as 'unknown' (file naming doesn't match the helper
        // heuristic) — a single BFS walk through the inventory root.
        if (!found && inv.rootPath) {
            const onDisk = findFileMultiExt(inv.rootPath, [
                `${helperClass}.java`, `${helperClass}.cs`,
            ]);
            if (onDisk) {
                found = { className: helperClass, path: onDisk };
            }
        }
        if (!found) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    error: `helper class '${helperClass}' not found in inventory (${inv.helpers?.length ?? 0} helpers + ${inv.pages?.length ?? 0} pages + ${sourceFiles.length} other source files scanned) nor on disk within 8 parent directories`,
                    suggestion: 'Verify the class name spelling exactly. If the file lives outside the project tree (e.g. a sibling utility module), call csaa_discover again with rootPath pointing at the common ancestor.',
                },
                `Helper class '${helperClass}' not in inventory.`,
            );
        }
        const hSig = CSLegacySignatureExtractor.extractHelperSignature(
            found.path, helperClass, helperMethod,
        );
        if (!hSig) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    error: `method '${helperMethod}' not found in ${found.path}`,
                    suggestion: 'Open the file and verify the exact method name (case-sensitive).',
                },
                `Method '${helperMethod}' not found in ${helperClass}.`,
            );
        }
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                helperClass,
                helperMethod,
                filePath: hSig.filePath,
                actionCount: hSig.actions.length,
                actions: hSig.actions,
            },
            `Expanded ${helperClass}.${helperMethod}: ${hSig.actions.length} leaf action(s).`,
        );
    })
    .build();

// ============================================================================
// csaa_extract_page_fields — Deterministic page-object field extraction
// ============================================================================
// The LLM calls this for each page-object class it intends to generate. Returns
// every @FindBy / By.* field declaration. The generated page object MUST have
// AT LEAST that many @CSGetElement fields — the page-coverage gate in
// csaa_record_translation enforces this floor.

const csaa_extract_page_fields: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_extract_page_fields')
    .title('CS-AI-Auto-Assist — Extract legacy page-object fields')
    .description(
        'Returns every @FindBy / @FindBys / By.* field on a legacy Java page-object class. ' +
            'The LLM MUST call this for every page class referenced by the @Test methods, then ' +
            'emit a generated page object with AT LEAST as many @CSGetElement fields covering ' +
            'the same locators. The page-coverage gate in csaa_record_translation rejects ' +
            'page objects below the legacy floor.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('pageClass', 'Java page-object class name', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const pageClass = getStr(params, 'pageClass');
        if (!pageClass) return errorResult('pageClass required', runId);

        // Try the cached signature first.
        const sigRaw = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigRaw) {
            try {
                const sig = JSON.parse(sigRaw) as FullSignature;
                const cached = sig.pages[pageClass];
                if (cached) {
                    return jsonResult(
                        {
                            state: 'RUNNING',
                            runId,
                            pageClass,
                            filePath: cached.filePath,
                            fieldCount: cached.fields.length,
                            methodCount: cached.methods.length,
                            fields: cached.fields,
                            methods: cached.methods,
                        },
                        `Extracted ${pageClass}: ${cached.fields.length} field(s), ${cached.methods.length} method(s).`,
                    );
                }
            } catch { /* fall through */ }
        }

        // Cache miss → resolve and extract.
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult('no inventory — run csaa_discover first', runId);
        }
        const inv = JSON.parse(inventoryRaw) as LegacyInventory;
        const candidates = (inv.pages ?? []).map((p) => ({
            className: path.basename(p as string, path.extname(p as string)),
            path: p as string,
        }));
        const found = candidates.find((x) => x.className === pageClass);
        if (!found) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    error: `page class '${pageClass}' not found in inventory (${candidates.length} pages scanned)`,
                    suggestion: 'Verify the class name. If you suspect OCR drift, check inventory.json for the closest match (e.g. SQL vs OQL).',
                },
                `Page class '${pageClass}' not in inventory.`,
            );
        }
        const pSig = CSLegacySignatureExtractor.extractPageSignature(found.path);
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                pageClass,
                filePath: pSig.filePath,
                fieldCount: pSig.fields.length,
                methodCount: pSig.methods.length,
                fields: pSig.fields,
                methods: pSig.methods,
            },
            `Extracted ${pageClass}: ${pSig.fields.length} field(s), ${pSig.methods.length} method(s).`,
        );
    })
    .build();

// ============================================================================
// Public registry
// ============================================================================

export const csaaPrimitiveTools: MCPToolDefinition[] = [
    csaa_discover,
    csaa_analyze,
    csaa_record_analysis,
    csaa_append_analysis_scenario,
    csaa_append_analysis_page,
    csaa_finalize_analysis,
    csaa_plan,
    csaa_translate,
    csaa_record_translation,
    csaa_append_translation_file,
    csaa_patch_translation_file,
    csaa_finalize_translation,
    csaa_audit,
    csaa_write,
    csaa_execute,
    csaa_verify,
    csaa_publish,
    csaa_query_existing_pages,
    csaa_read_legacy_data,
    csaa_read_config_file,
    csaa_configure_credentials,
    csaa_resolve_data_file,
    csaa_expand_helper,
    csaa_extract_page_fields,
];
