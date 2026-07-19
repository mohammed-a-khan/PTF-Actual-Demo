/**
 * Agentic SDLC Platform — Capability Packs (progressive tool disclosure)
 *
 * The agentic server starts with ~5 meta-tools. Everything else — the 240+
 * concrete tools — is grouped into named capability packs that are
 * registered ON DEMAND (and unregistered when no longer needed), followed
 * by a `notifications/tools/list_changed` so MCP hosts refresh their view.
 *
 * Two credit-efficiency wins:
 *   1. The host's tool context stays tiny (fewer schema tokens per request).
 *   2. Pack modules are `require()`d only at activation, so server startup
 *      never pays the module-load cost of packs that are never used.
 *
 * @module agentic/CSToolPacks
 */

import { CSMCPToolRegistry } from '../CSMCPToolRegistry';
import { MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { CSGuardrailEngine } from './CSGuardrailEngine';

// ============================================================================
// Pack definitions
// ============================================================================

export interface ToolPackInfo {
    name: string;
    summary: string;
    /** Loaded lazily — undefined until first activation. */
    toolCount?: number;
}

interface PackSpec {
    name: string;
    summary: string;
    /** Lazily resolve the pack's tool definitions. */
    load: () => MCPToolDefinition[];
    /** Tool names NEVER registered by this pack (hard capability removal). */
    exclude?: string[];
    /** Optional interceptor wrapped around every handler in the pack. */
    guard?: (
        toolName: string,
        params: Record<string, unknown>,
    ) => { ok: boolean; reason?: string };
}

/**
 * Database tools with write/DDL capability. The agentic platform's hard
 * rule is SELECT-only — these are not merely blocked, they are never
 * registered, so no model can even attempt them.
 */
const DB_WRITE_TOOLS = [
    'db_execute',
    'db_execute_stored_procedure',
    'db_begin_transaction',
    'db_commit_transaction',
    'db_rollback_transaction',
    'db_create_savepoint',
    'db_bulk_insert',
    'db_truncate_table',
    'db_import_data',
];

/* eslint-disable @typescript-eslint/no-var-requires */
const PACKS: PackSpec[] = [
    {
        name: 'authoring',
        summary: 'The 30 csaa_* pipeline primitives: discover, analyze, plan, translate, audit, write, preflight, execute, verify, publish + companions.',
        load: () => require('../agent-platform/CSPrimitiveTools').csaaPrimitiveTools,
    },
    {
        name: 'execution',
        summary: 'Run features/tests and drive the heal loop: bdd_*, test_*, csaa_run_scenario.',
        load: () => [
            ...require('../tools/bdd/CSMCPBDDTools').bddTools,
            ...require('../tools/testing/CSMCPTestingTools').testingTools,
            ...require('../tools/heal-loop/CSMCPHealLoopTools').healLoopTools,
        ],
    },
    {
        name: 'browser',
        summary: 'Full Playwright browser automation (navigate, click, snapshot, locators, tabs, network capture).',
        load: () => require('../tools/browser/CSMCPBrowserTools').browserTools,
    },
    {
        name: 'quality',
        summary: 'Deterministic quality gates: audit_content/audit_file, compile_check, commit_ready_check, correction memory, pipeline state.',
        load: () => [
            ...require('../tools/audit/CSMCPAuditTools').auditTools,
            ...require('../tools/pipeline/CSMCPPipelineTools').pipelineTools,
        ],
    },
    {
        name: 'data',
        summary:
            'READ-ONLY database access: connect, SELECT queries, schema discovery ' +
            '(db_list_tables/db_describe_table), row/value verification. Write and ' +
            'DDL tools are never registered, and every remaining handler is wrapped ' +
            'by a server-side SELECT-only SQL guard.',
        load: () => require('../tools/database/CSMCPDatabaseTools').databaseTools,
        exclude: DB_WRITE_TOOLS,
        guard: (_toolName, params) => CSGuardrailEngine.checkSqlParams(params),
    },
    {
        name: 'api',
        summary: 'REST/GraphQL/SOAP requests, interception, mocking and network rules.',
        load: () => require('../tools/network/CSMCPNetworkTools').networkTools,
    },
    {
        name: 'ado',
        summary: 'Azure DevOps: pipelines, builds, PRs (incl. changed-file diffs, iterations, threads), commits, work items, test plans/suites/cases, repo files, code/work-item search, wiki, projects/teams, test runs and publishing.',
        load: () => require('../tools/cicd/CSMCPAzureDevOpsTools').azureDevOpsTools,
    },
    {
        name: 'insights',
        summary: 'Analytics & intelligence: flakiness, trends, durations, impact analysis, UI drift, semantic equivalence.',
        load: () => [
            ...require('../tools/analytics/CSMCPAnalyticsTools').analyticsTools,
            ...require('../tools/intelligence/CSMCPIntelligenceTools').intelligenceTools,
            ...require('../tools/drift/CSMCPDriftTools').driftTools,
            ...require('../tools/equivalence/CSMCPEquivalenceTools').equivalenceTools,
        ],
    },
    {
        name: 'security',
        summary: 'Security & accessibility scans on live pages (XSS, SQLi, headers, a11y).',
        load: () => require('../tools/security/CSMCPSecurityTools').securityTools,
    },
    {
        name: 'generation',
        summary: 'Standalone generation & recording: page objects, tests, selectors, codegen sessions, app exploration.',
        load: () => [
            ...require('../tools/generation/CSMCPGenerationTools').generationTools,
            ...require('../tools/codegen/CSMCPCodegenTools').codegenTools,
            ...require('../tools/exploration/CSMCPExplorationTools').explorationTools,
        ],
    },
];
/* eslint-enable @typescript-eslint/no-var-requires */

// ============================================================================
// CSToolPacks
// ============================================================================

export class CSToolPacks {
    private readonly registry: CSMCPToolRegistry;
    private readonly notifyChanged: () => void;
    /** pack name → tool names currently registered for it */
    private readonly active: Map<string, string[]> = new Map();
    /**
     * pack name → the OWNERS holding it (session ids, or '__manual__' for
     * explicit csaa_toolpack activations). Owner-attributed instead of a
     * bare counter so (a) a resumed session re-taking its packs is idempotent
     * and (b) one session finishing can never yank tools out from under
     * another session that still holds the pack.
     */
    private readonly owners: Map<string, Set<string>> = new Map();

    /** Owner id used for explicit csaa_toolpack activations. */
    public static readonly MANUAL_OWNER = '__manual__';

    constructor(registry: CSMCPToolRegistry, notifyChanged: () => void) {
        this.registry = registry;
        this.notifyChanged = notifyChanged;
    }

    public static packNames(): string[] {
        return PACKS.map((p) => p.name);
    }

    public list(): Array<ToolPackInfo & { active: boolean }> {
        return PACKS.map((p) => ({
            name: p.name,
            summary: p.summary,
            toolCount: this.active.get(p.name)?.length,
            active: this.active.has(p.name),
        }));
    }

    /**
     * Activate a pack for an owner (idempotent per owner). Returns the tool
     * names now available. Tools already registered by another pack are
     * skipped. Calling again with the same owner is a no-op membership-wise —
     * safe for session resume/rehydration paths.
     */
    public activate(name: string, owner: string = CSToolPacks.MANUAL_OWNER): { activated: string[]; alreadyActive: boolean } {
        const spec = PACKS.find((p) => p.name === name);
        if (!spec) {
            throw new Error(
                `Unknown tool pack "${name}". Valid packs: ${PACKS.map((p) => p.name).join(', ')}`,
            );
        }

        const members = this.owners.get(name) ?? new Set<string>();
        members.add(owner);
        this.owners.set(name, members);

        if (this.active.has(name)) {
            return { activated: this.active.get(name)!, alreadyActive: true };
        }

        const definitions = spec.load();
        const registered: string[] = [];
        for (const def of definitions) {
            if (this.registry.hasTool(def.tool.name)) continue;
            if (spec.exclude?.includes(def.tool.name)) continue;
            this.registry.registerTool(spec.guard ? CSToolPacks.withGuard(def, spec.guard) : def);
            registered.push(def.tool.name);
        }
        this.active.set(name, registered);
        this.notifyChanged();
        return { activated: registered, alreadyActive: false };
    }

    /** Activate several packs for an owner; returns total tools newly exposed. */
    public activateAll(names: string[], owner: string = CSToolPacks.MANUAL_OWNER): number {
        let count = 0;
        for (const n of names) {
            count += this.activate(n, owner).activated.length;
        }
        return count;
    }

    /**
     * Release an owner's hold on a pack; unregisters its tools only when the
     * LAST owner lets go. Releasing an owner that never held the pack is a
     * safe no-op (it cannot decrement someone else's hold).
     */
    public release(name: string, owner: string = CSToolPacks.MANUAL_OWNER): boolean {
        const members = this.owners.get(name);
        if (!members || !members.has(owner)) return false;
        members.delete(owner);
        if (members.size > 0) return false;

        this.owners.delete(name);
        const tools = this.active.get(name);
        if (tools) {
            for (const t of tools) this.registry.unregisterTool(t);
            this.active.delete(name);
            this.notifyChanged();
        }
        return true;
    }

    public releaseAll(names: string[], owner: string = CSToolPacks.MANUAL_OWNER): void {
        for (const n of names) this.release(n, owner);
    }

    public isActive(name: string): boolean {
        return this.active.has(name);
    }

    /** The owners (session ids / '__manual__') currently holding a pack. */
    public holdersOf(name: string): string[] {
        return Array.from(this.owners.get(name) ?? []);
    }

    /** Wrap a tool definition so its handler runs the pack guard first. */
    private static withGuard(
        def: MCPToolDefinition,
        guard: NonNullable<PackSpec['guard']>,
    ): MCPToolDefinition {
        const original = def.handler;
        const guarded: MCPToolDefinition = {
            ...def,
            handler: async (params, context): Promise<MCPToolResult> => {
                const verdict = guard(def.tool.name, params);
                if (!verdict.ok) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `GUARDRAIL_BLOCKED: ${verdict.reason}`,
                            },
                        ],
                        isError: true,
                    };
                }
                return original(params, context);
            },
        };
        return guarded;
    }
}
