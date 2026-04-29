/**
 * PTF-ADO MCP Drift Tools
 *
 *   - detect_ui_drift     Given IR + live-DOM snapshots, report per-screen element drift.
 *
 * Workflow: the orchestrator captures browser_snapshot on each screen referenced
 * by the IR, then passes {irJson, snapshotsJson} to this tool. The tool is pure
 * analysis — no browser actions here — so it is fast, deterministic, and test-friendly.
 *
 * The matching algorithm tries (in priority order): id exact, data-testid exact,
 * name exact, accessible-name exact, xpath literal match, attribute-combo match.
 * Each match gets a confidence score; below threshold → reported as "missing."
 *
 * @module CSMCPDriftTools
 */

import { MCPToolDefinition, MCPToolResult } from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helpers
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function createErrorResult(message: string): MCPToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

// ============================================================================
// Shapes
// ============================================================================

/**
 * Flexible snapshot node — whatever shape browser_snapshot produces, the
 * orchestrator normalises into this before calling us. Any attribute may
 * be absent; matching is best-effort.
 */
interface SnapshotNode {
    role?: string;
    name?: string;
    id?: string;
    testid?: string;
    tag?: string;
    type?: string;
    placeholder?: string;
    label?: string;
    text?: string;
    attrs?: Record<string, string>;
    xpath?: string;
    ref?: string;
}

interface IRElement {
    field: string;
    locator_type: string;
    value: string;
    description?: string;
    screen_hint?: string;
}

interface IRPageObject {
    name: string;
    screen_hint?: string;
    elements: IRElement[];
}

interface IRInput {
    page_objects: IRPageObject[];
}

interface ElementVerdict {
    field: string;
    irLocator: { type: string; value: string };
    status: 'matched' | 'missing' | 'ambiguous';
    confidence: number; // 0..100
    matchedNode?: SnapshotNode;
    alternatives?: SnapshotNode[];
    note?: string;
}

interface ScreenVerdict {
    pageName: string;
    url?: string;
    expectedElements: number;
    matchedCount: number;
    missingCount: number;
    ambiguousCount: number;
    driftLevel: 'none' | 'low' | 'medium' | 'high';
    elementResults: ElementVerdict[];
}

// ============================================================================
// Matching algorithm
// ============================================================================

/**
 * Match an IR element against a snapshot's node list. Scoring:
 *   - exact id match               → 95
 *   - data-testid exact            → 90
 *   - xpath literal equality       → 85
 *   - name attr exact              → 80
 *   - accessible name exact        → 75
 *   - label / placeholder exact    → 70
 *   - xpath "contains" on attrs    → 60
 * Below 60 → missing. Multiple ≥60 → ambiguous.
 */
function matchElement(el: IRElement, nodes: SnapshotNode[]): ElementVerdict {
    const candidates: Array<{ node: SnapshotNode; score: number; why: string }> = [];

    const targetValue = el.value;
    const lt = el.locator_type;

    // id-based match
    if (lt === 'id' || /@id=/.test(targetValue)) {
        const idWanted = lt === 'id' ? targetValue : (targetValue.match(/@id=['"]?([\w-]+)['"]?/)?.[1] ?? '');
        if (idWanted) {
            for (const n of nodes) {
                if (n.id === idWanted) candidates.push({ node: n, score: 95, why: 'id exact' });
                else if (n.attrs?.id === idWanted) candidates.push({ node: n, score: 95, why: 'attrs.id exact' });
            }
        }
    }

    // testId-based match
    if (lt === 'testId' || /data-testid/.test(targetValue)) {
        const wanted = lt === 'testId' ? targetValue : (targetValue.match(/data-testid=['"]?([\w-]+)['"]?/)?.[1] ?? '');
        if (wanted) {
            for (const n of nodes) {
                if (n.testid === wanted || n.attrs?.['data-testid'] === wanted) {
                    candidates.push({ node: n, score: 90, why: 'testid exact' });
                }
            }
        }
    }

    // xpath literal equality
    if (lt === 'xpath') {
        for (const n of nodes) {
            if (n.xpath && n.xpath === targetValue) {
                candidates.push({ node: n, score: 85, why: 'xpath exact' });
            }
        }
    }

    // name attr match
    if (lt === 'name' || /@name=/.test(targetValue)) {
        const wanted = lt === 'name' ? targetValue : (targetValue.match(/@name=['"]?([\w-]+)['"]?/)?.[1] ?? '');
        if (wanted) {
            for (const n of nodes) {
                if (n.attrs?.name === wanted) candidates.push({ node: n, score: 80, why: 'name exact' });
            }
        }
    }

    // accessible-name / label / placeholder match — heuristic on element description
    const desc = (el.description ?? '').toLowerCase().trim();
    if (desc) {
        for (const n of nodes) {
            const nm = (n.name ?? '').toLowerCase().trim();
            const lb = (n.label ?? '').toLowerCase().trim();
            const ph = (n.placeholder ?? '').toLowerCase().trim();
            if (nm && nm === desc) candidates.push({ node: n, score: 75, why: 'accessible-name exact vs description' });
            else if (lb && lb === desc) candidates.push({ node: n, score: 72, why: 'label exact vs description' });
            else if (ph && ph === desc) candidates.push({ node: n, score: 70, why: 'placeholder exact vs description' });
        }
    }

    // xpath attribute-combo partial match — last-resort heuristic
    if (lt === 'xpath' && candidates.length === 0) {
        const attrMatches = targetValue.matchAll(/@(\w+)=['"]([^'"]+)['"]/g);
        const reqs = Array.from(attrMatches).map(m => ({ k: m[1], v: m[2] }));
        if (reqs.length > 0) {
            for (const n of nodes) {
                let hits = 0;
                for (const { k, v } of reqs) {
                    if (n.attrs?.[k] === v || (n as any)[k] === v) hits++;
                }
                if (hits === reqs.length) {
                    candidates.push({ node: n, score: 60, why: `xpath attr combo (${hits}/${reqs.length})` });
                }
            }
        }
    }

    if (candidates.length === 0) {
        return {
            field: el.field,
            irLocator: { type: el.locator_type, value: el.value },
            status: 'missing',
            confidence: 0,
            note: 'No node in live DOM matched this IR element',
        };
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];

    if (candidates.length > 1 && candidates[1].score >= top.score) {
        return {
            field: el.field,
            irLocator: { type: el.locator_type, value: el.value },
            status: 'ambiguous',
            confidence: top.score,
            matchedNode: top.node,
            alternatives: candidates.slice(1, 4).map(c => c.node),
            note: `${candidates.length} nodes matched equally — pick one or add a more specific locator`,
        };
    }

    return {
        field: el.field,
        irLocator: { type: el.locator_type, value: el.value },
        status: 'matched',
        confidence: top.score,
        matchedNode: top.node,
        note: top.why,
    };
}

function assessDrift(matched: number, missing: number, ambiguous: number, total: number): ScreenVerdict['driftLevel'] {
    if (total === 0) return 'none';
    const missRate = (missing + ambiguous * 0.5) / total;
    if (missRate === 0) return 'none';
    if (missRate < 0.15) return 'low';
    if (missRate < 0.5) return 'medium';
    return 'high';
}

// ============================================================================
// Tool
// ============================================================================

const detectUiDriftTool = defineTool()
    .name('detect_ui_drift')
    .title('Detect UI Drift')
    .description(
        'Compare IR page-object element definitions against live-DOM snapshots. Returns ' +
        'per-screen element match report (matched / missing / ambiguous) + overall drift ' +
        'level (none / low / medium / high). Orchestrator calls this after browser_snapshot ' +
        'to surface stale tests BEFORE migration — avoid porting a test for a UI that has evolved.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            perScreen: { type: 'array', items: { type: 'object' } },
            overallDrift: { type: 'string' },
            recommendation: { type: 'string' },
            summary: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('irJson', 'IR JSON with page_objects', { required: true })
    .stringParam('snapshotsJson', 'JSON object mapping pageName -> { url?, nodes: SnapshotNode[] }', { required: true })
    .handler(async (params) => {
        let ir: IRInput;
        let snapshots: Record<string, { url?: string; nodes: SnapshotNode[] }>;
        try {
            ir = JSON.parse(params.irJson as string);
            snapshots = JSON.parse(params.snapshotsJson as string);
        } catch (err: any) {
            return createErrorResult(`Invalid JSON input: ${err.message}`);
        }

        const perScreen: ScreenVerdict[] = [];

        for (const po of ir.page_objects) {
            const snapshot = snapshots[po.name] ?? snapshots[po.screen_hint ?? ''] ?? null;
            if (!snapshot) {
                perScreen.push({
                    pageName: po.name,
                    expectedElements: po.elements.length,
                    matchedCount: 0,
                    missingCount: po.elements.length,
                    ambiguousCount: 0,
                    driftLevel: 'high',
                    elementResults: po.elements.map(el => ({
                        field: el.field,
                        irLocator: { type: el.locator_type, value: el.value },
                        status: 'missing',
                        confidence: 0,
                        note: 'No snapshot provided for this screen',
                    })),
                });
                continue;
            }

            const results = po.elements.map(el => matchElement(el, snapshot.nodes));
            const matched = results.filter(r => r.status === 'matched').length;
            const ambiguous = results.filter(r => r.status === 'ambiguous').length;
            const missing = results.filter(r => r.status === 'missing').length;
            const total = po.elements.length;

            perScreen.push({
                pageName: po.name,
                url: snapshot.url,
                expectedElements: total,
                matchedCount: matched,
                missingCount: missing,
                ambiguousCount: ambiguous,
                driftLevel: assessDrift(matched, missing, ambiguous, total),
                elementResults: results,
            });
        }

        // Overall drift = worst per-screen verdict
        const levels = perScreen.map(s => s.driftLevel);
        const overallDrift: ScreenVerdict['driftLevel'] =
            levels.includes('high') ? 'high' :
            levels.includes('medium') ? 'medium' :
            levels.includes('low') ? 'low' : 'none';

        let recommendation: string;
        switch (overallDrift) {
            case 'none':   recommendation = 'migrate-as-is — live DOM matches legacy test expectations'; break;
            case 'low':    recommendation = 'migrate-as-is — minor drift within healer tolerance'; break;
            case 'medium': recommendation = 'update-expectations — review drifted elements before migration'; break;
            case 'high':   recommendation = 'mark-obsolete-or-update — legacy test appears stale; options: (a) migrate as-is expecting runtime failures, (b) update expectations to match live app, (c) skip'; break;
        }

        const totalExpected = perScreen.reduce((n, s) => n + s.expectedElements, 0);
        const totalMatched = perScreen.reduce((n, s) => n + s.matchedCount, 0);
        const summary = `${totalMatched}/${totalExpected} elements match live DOM across ${perScreen.length} screen(s). Drift level: ${overallDrift}.`;

        return createJsonResult({
            perScreen,
            overallDrift,
            recommendation,
            summary,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Export + registration
// ============================================================================

export const driftTools: MCPToolDefinition[] = [detectUiDriftTool];

export function registerDriftTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(driftTools);
}
