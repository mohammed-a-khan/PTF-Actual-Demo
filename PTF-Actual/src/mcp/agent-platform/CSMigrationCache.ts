/**
 * Agentic Test Platform — Migration Cache
 *
 * Thin wrapper around the framework's `migration_cache_lookup` /
 * `migration_cache_store` tools. The cache is keyed on
 * `sha256(sourceContent + projectName + pipelineVersion + extras)` and
 * stores the full output file map under `.agent-runs/cache/<key>/`.
 *
 * The cache is a *plan cache* in the agentic-AI sense: when the same input
 * is migrated again, we replay the stored file map verbatim and skip the
 * Copilot delegate call entirely. The downstream heal loop still runs to
 * verify the cached output still compiles + executes against the current
 * environment (handles framework upgrades, locator drift, etc.).
 *
 * Three integration points:
 *   - `CSLegacyModeHandler` (legacy_test_code) — keyed on the .java/.cs source
 *   - `CSDocumentModeHandler` (document_path) — keyed on the requirements doc
 *   - `CSSourceCodeModeHandler` (source_code_path) — keyed on the app source
 *
 * Skipped for ADO modes (cache key would need to track ADO test case
 * revision, not yet wired) and chat mode (each prompt is unique).
 *
 * @module agent-platform/CSMigrationCache
 */

import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { pipelineTools } from '../tools/pipeline/CSMCPPipelineTools';

// ============================================================================
// Public Types
// ============================================================================

export interface MigrationCacheLookupRequest {
    sourceFile: string;
    projectName: string;
    /** Stable across releases; use the framework version. */
    pipelineVersion: string;
    /**
     * Optional extra key material — include anything that should bust the
     * cache when changed (e.g., system-prompt version, env-spec hash).
     */
    extras?: string;
    /** Defaults to the MCP server's working directory. */
    cwd?: string;
}

export interface MigrationCacheLookupResult {
    hit: boolean;
    cacheKey: string;
    files?: Record<string, string>;
    cachedAt?: string;
}

export interface MigrationCacheStoreRequest {
    cacheKey: string;
    files: Record<string, string>;
    cwd?: string;
}

// ============================================================================
// CSMigrationCache
// ============================================================================

/**
 * Static facade. Two operations: `lookup` and `store`.
 */
export class CSMigrationCache {
    /**
     * Probe the cache for a previous run on this exact input. Always returns
     * a `cacheKey` (so the caller can pass it to `store` later) plus a
     * `hit` boolean. On miss the caller proceeds to delegate; on hit the
     * caller writes the cached file map and skips delegation.
     */
    public static async lookup(
        request: MigrationCacheLookupRequest,
        context: MCPToolContext,
    ): Promise<MigrationCacheLookupResult> {
        const params: Record<string, unknown> = {
            sourceFile: request.sourceFile,
            projectName: request.projectName,
            pipelineVersion: request.pipelineVersion,
        };
        if (request.extras) params.extras = request.extras;
        if (request.cwd) params.cwd = request.cwd;

        try {
            const result = await CSMigrationCache.invokeTool(
                'migration_cache_lookup',
                params,
                context,
            );
            if (result.isError) {
                context.log('debug', 'CSMigrationCache.lookup: tool error', {
                    detail: CSMigrationCache.firstText(result),
                });
                return { hit: false, cacheKey: '' };
            }
            // Pipeline tools return JSON via content[0].text, not always
            // via structuredContent. Read whichever is populated.
            const sc =
                (result.structuredContent as Record<string, unknown> | undefined) ||
                CSMigrationCache.parseTextJson(result);
            const hit = sc?.hit === true;
            const cacheKey = String(sc?.cacheKey ?? '');
            if (!hit) return { hit: false, cacheKey };
            const filesRaw = sc?.files as Record<string, unknown> | undefined;
            const files: Record<string, string> = {};
            if (filesRaw && typeof filesRaw === 'object') {
                for (const [k, v] of Object.entries(filesRaw)) {
                    if (typeof v === 'string') files[k] = v;
                }
            }
            const cachedAt = typeof sc?.cachedAt === 'string'
                ? sc.cachedAt
                : undefined;
            return { hit: true, cacheKey, files, cachedAt };
        } catch (err) {
            context.log('debug', 'CSMigrationCache.lookup: exception', {
                error: err instanceof Error ? err.message : String(err),
            });
            return { hit: false, cacheKey: '' };
        }
    }

    /**
     * Persist a verified-green file map under the supplied cache key.
     * Caller is responsible for ensuring the heal loop returned green
     * before calling — caching a broken output would poison future runs.
     */
    public static async store(
        request: MigrationCacheStoreRequest,
        context: MCPToolContext,
    ): Promise<boolean> {
        if (!request.cacheKey) return false;
        if (!request.files || Object.keys(request.files).length === 0) {
            return false;
        }
        const params: Record<string, unknown> = {
            cacheKey: request.cacheKey,
            filesJson: JSON.stringify(request.files),
        };
        if (request.cwd) params.cwd = request.cwd;
        try {
            const result = await CSMigrationCache.invokeTool(
                'migration_cache_store',
                params,
                context,
            );
            if (result.isError) {
                context.log('warning', 'CSMigrationCache.store: tool error', {
                    detail: CSMigrationCache.firstText(result),
                });
                return false;
            }
            const sc =
                (result.structuredContent as Record<string, unknown> | undefined) ||
                CSMigrationCache.parseTextJson(result);
            return sc?.stored === true;
        } catch (err) {
            context.log('warning', 'CSMigrationCache.store: exception', {
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private static async invokeTool(
        toolName: string,
        params: Record<string, unknown>,
        context: MCPToolContext,
    ): Promise<MCPToolResult> {
        const def = (pipelineTools as MCPToolDefinition[]).find(
            (d) => d.tool.name === toolName,
        );
        if (!def) {
            throw new Error(
                `CSMigrationCache: required tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }

    private static firstText(result: MCPToolResult): string {
        for (const c of result.content) {
            if (c.type === 'text') return c.text;
        }
        return '';
    }

    /**
     * Parse the tool's first text-content block as JSON. Falls back to
     * undefined when the block is missing or unparseable. Used when a tool
     * returns its payload via `content[0].text` instead of `structuredContent`.
     */
    private static parseTextJson(
        result: MCPToolResult,
    ): Record<string, unknown> | undefined {
        const text = CSMigrationCache.firstText(result);
        if (!text) return undefined;
        try {
            const parsed = JSON.parse(text);
            return typeof parsed === 'object' && parsed !== null
                ? (parsed as Record<string, unknown>)
                : undefined;
        } catch {
            return undefined;
        }
    }
}
