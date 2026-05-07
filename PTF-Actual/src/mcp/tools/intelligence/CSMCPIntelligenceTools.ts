/**
 * CS-AI-Auto-Assist Intelligence Layer (Phase 7-lite).
 *
 *   - test_impact_analysis  Given a list of changed source files, return
 *                           the feature files most likely impacted, ranked
 *                           by overlap heuristics. Deterministic; no LLM.
 *   - adversarial_scenarios Generate edge-case scenarios from a base
 *                           feature file using a small built-in catalog
 *                           plus optional LLM augmentation.
 *
 * Both tools are read-only and produce structured JSON; downstream
 * consumers (a CI step, the master tool's TIA hook, etc.) decide what
 * to do with the output.
 *
 * @module CSMCPIntelligenceTools
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolDefinition, MCPToolResult } from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helpers
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: message }],
        isError: true,
    };
}

function readFileSafe(p: string): string | null {
    try {
        return fs.readFileSync(p, 'utf-8');
    } catch {
        return null;
    }
}

/**
 * Walk a directory recursively, collecting paths matching the predicate.
 * Stops at maxFiles to avoid pathological repos. Skips common excluded
 * directories.
 */
function walkFiles(
    root: string,
    predicate: (filePath: string) => boolean,
    maxFiles: number,
): string[] {
    const out: string[] = [];
    const stack: string[] = [root];
    const skip = new Set([
        'node_modules', 'dist', 'build', '.git', '.agent-runs',
        'coverage', 'test-results', 'playwright-report', 'reports',
    ]);
    while (stack.length > 0 && out.length < maxFiles) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(cur, e.name);
            if (e.isDirectory()) {
                if (!skip.has(e.name) && !e.name.startsWith('.')) stack.push(full);
            } else if (predicate(full)) {
                out.push(full);
                if (out.length >= maxFiles) break;
            }
        }
    }
    return out;
}

// ============================================================================
// Test Impact Analysis
// ============================================================================

interface TIAImpactedTest {
    featureFile: string;
    score: number;
    reasons: string[];
}

const STEM_RE = /[A-Za-z][A-Za-z0-9]{2,}/g;

/**
 * Extract candidate identifier stems from a list of changed file paths.
 * The basename without extension + camel-case word splits become signals
 * we look for inside feature files / step definitions.
 */
function extractStems(changedFiles: string[]): Set<string> {
    const out = new Set<string>();
    for (const f of changedFiles) {
        const base = path.basename(f).replace(/\.(java|cs|ts|tsx|js|py|rb|go|kt|scala)$/i, '');
        out.add(base);
        // Split camel-case / snake-case into words.
        for (const m of base.match(STEM_RE) ?? []) {
            if (m.length >= 4) out.add(m);
        }
    }
    return out;
}

const tiaTool = defineTool()
    .name('test_impact_analysis')
    .title('Test Impact Analysis')
    .description(
        'Given a list of changed source file paths, rank feature files by likely impact. ' +
        'Deterministic — no LLM. Score = sum of stem matches (basename + camel-case parts) ' +
        'across feature/scenario/step bodies. Use as a pre-filter for which tests to run on a PR.',
    )
    .outputSchema({
        type: 'object',
        properties: {
            scanned: { type: 'number' },
            impactedTests: { type: 'array', items: { type: 'object' } },
            stems: { type: 'array', items: { type: 'string' } },
        },
    })
    .category('multiagent')
    .arrayParam('changedFiles', 'Absolute or workspace-relative source paths that changed', 'string', { required: true })
    .stringParam('searchRoot', 'Workspace root to scan for feature / step files (default: cwd)')
    .numberParam('maxFiles', 'Max feature files to scan', { default: 500 })
    .numberParam('topN', 'Cap on returned impacted-test count', { default: 50 })
    .handler(async (params) => {
        const changed = (params.changedFiles as string[]) || [];
        if (changed.length === 0) {
            return createErrorResult('test_impact_analysis: changedFiles cannot be empty');
        }
        const root = (params.searchRoot as string | undefined) ?? process.cwd();
        const maxFiles = (params.maxFiles as number) || 500;
        const topN = (params.topN as number) || 50;

        const stems = extractStems(changed);
        if (stems.size === 0) {
            return createJsonResult({ scanned: 0, impactedTests: [], stems: [] });
        }

        const featureFiles = walkFiles(
            root,
            (p) => p.endsWith('.feature') || p.endsWith('.steps.ts') || p.endsWith('.spec.ts'),
            maxFiles,
        );

        const ranked: TIAImpactedTest[] = [];
        for (const f of featureFiles) {
            const content = readFileSafe(f);
            if (!content) continue;
            let score = 0;
            const matched: string[] = [];
            for (const stem of stems) {
                const re = new RegExp(`\\b${stem}\\b`, 'gi');
                const hits = (content.match(re) || []).length;
                if (hits > 0) {
                    score += hits;
                    matched.push(`${stem}×${hits}`);
                }
            }
            if (score > 0) {
                ranked.push({ featureFile: f, score, reasons: matched });
            }
        }

        ranked.sort((a, b) => b.score - a.score);
        return createJsonResult({
            scanned: featureFiles.length,
            impactedTests: ranked.slice(0, topN),
            stems: Array.from(stems),
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Adversarial Scenarios
// ============================================================================

/**
 * A small built-in catalog of edge-case mutations that apply to most
 * web-app scenarios. Each mutation is described in plain Gherkin so the
 * caller can paste them straight into a feature file or feed them as
 * grounding to a generation pass.
 *
 * The catalog is intentionally generic — no consumer-specific patterns.
 */
const ADVERSARIAL_CATALOG: Array<{ id: string; title: string; injection: string }> = [
    {
        id: 'empty_required_field',
        title: 'Empty required field',
        injection: 'When the user submits the form with the required field left blank',
    },
    {
        id: 'max_length_overflow',
        title: 'Max-length overflow',
        injection:
            'When the user enters a value longer than the documented maximum length',
    },
    {
        id: 'unicode_payload',
        title: 'Unicode + emoji payload',
        injection: 'When the user enters a value containing emoji (😀🎉) and right-to-left scripts',
    },
    {
        id: 'leading_trailing_whitespace',
        title: 'Leading/trailing whitespace',
        injection: 'When the user enters a value with leading and trailing whitespace',
    },
    {
        id: 'sql_injection_attempt',
        title: 'SQL injection attempt',
        injection: "When the user enters \"' OR 1=1; --\" in a free-text field",
    },
    {
        id: 'xss_attempt',
        title: 'XSS attempt',
        injection: 'When the user enters "<script>alert(1)</script>" in a free-text field',
    },
    {
        id: 'rapid_double_submit',
        title: 'Rapid double-submit',
        injection: 'When the user clicks the submit button twice in quick succession',
    },
    {
        id: 'navigate_back_after_submit',
        title: 'Browser back after submit',
        injection: 'When the user navigates back after a successful submit and tries to resubmit',
    },
    {
        id: 'session_expiry_mid_action',
        title: 'Session expiry mid-action',
        injection:
            'When the session expires after the form is filled but before submit',
    },
    {
        id: 'slow_network',
        title: 'Slow network response',
        injection: 'When the network response is delayed beyond the page timeout',
    },
    {
        id: 'concurrent_user_edit',
        title: 'Concurrent edit conflict',
        injection: 'When another user edits the same record between load and save',
    },
    {
        id: 'unauthorized_role',
        title: 'Unauthorised role attempt',
        injection: 'When a user without the required role attempts the action',
    },
];

const adversarialTool = defineTool()
    .name('adversarial_scenarios')
    .title('Adversarial Scenarios')
    .description(
        'Produce edge-case scenarios from a base scenario title. Returns Gherkin-shaped ' +
        'injections covering empty fields, overflow, Unicode, injection attempts, race ' +
        'conditions, session expiry, and unauthorised-role variants. ' +
        'Deterministic — no LLM. Use as grounding for a follow-up generation run.',
    )
    .outputSchema({
        type: 'object',
        properties: {
            base: { type: 'string' },
            scenarios: { type: 'array', items: { type: 'object' } },
        },
    })
    .category('multiagent')
    .stringParam('baseScenarioTitle', 'Title of the happy-path scenario to mutate', { required: true })
    .arrayParam('skip', 'Optional list of catalog ids to skip', 'string')
    .handler(async (params) => {
        const base = (params.baseScenarioTitle as string).trim();
        if (!base) {
            return createErrorResult('adversarial_scenarios: baseScenarioTitle cannot be empty');
        }
        const skip = new Set<string>((params.skip as string[]) || []);
        const scenarios = ADVERSARIAL_CATALOG.filter((c) => !skip.has(c.id)).map(
            (c) => ({
                id: c.id,
                title: `${base} — ${c.title}`,
                gherkinInjection: c.injection,
            }),
        );
        return createJsonResult({ base, scenarios });
    })
    .readOnly()
    .build();

// ============================================================================
// Export + registration
// ============================================================================

export const intelligenceTools: MCPToolDefinition[] = [tiaTool, adversarialTool];

export function registerIntelligenceTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(intelligenceTools);
}
