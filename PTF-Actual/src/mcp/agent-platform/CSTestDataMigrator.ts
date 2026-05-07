/**
 * Agentic Test Platform — Test Data Migrator
 *
 * Detects external test-data references in legacy source code (QAF
 * `@QAFDataProvider`, TestNG `@DataProvider` with `dataFile`, parameter
 * tables in `suite.xml`, …), resolves the referenced files relative to
 * the source location, and pre-parses them via the framework's
 * `data_parse` MCP tool.
 *
 * Result is a structured `MigratedTestData` payload that
 * `CSLegacyModeHandler` adds to the Copilot delegate's grounding so the
 * LLM can write the new `<feature>-data.json` fixture with **real**
 * values instead of inventing placeholders.
 *
 * Privacy-by-design: parsed rows pass through `CSPiiSanitizer.redact`
 * before going over the wire to the LLM — same boundary policy as the
 * rest of the delegate's grounding.
 *
 * @module agent-platform/CSTestDataMigrator
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { parseTools } from '../tools/parsers/CSMCPParseTools';

// ============================================================================
// Public Types
// ============================================================================

export interface DataReference {
    /** Original raw file path string from the annotation. */
    rawPath: string;
    /** Resolved absolute path on disk; null when we couldn't find the file. */
    resolvedPath: string | null;
    /** Sheet name for spreadsheet inputs (`sheetName=` attribute). */
    sheetName?: string;
    /** Row key the test wants from that sheet (`key=` attribute). */
    rowKey?: string;
    /** Source — which annotation pattern matched. */
    source: 'qaf' | 'testng' | 'inline';
}

export interface MigratedTestData {
    references: DataReference[];
    /** Aggregated rows across every successfully resolved reference. */
    rows: Array<Record<string, unknown>>;
    /** Per-reference parse status for the audit trail. */
    notes: string[];
}

// ============================================================================
// CSTestDataMigrator
// ============================================================================

export class CSTestDataMigrator {
    /** Default env folder name when source has `${environment.name}` placeholders. */
    private static readonly DEFAULT_ENV_NAME = 'dev';
    /** Directory walks bounded so we don't traverse the whole disk. */
    private static readonly MAX_PARENT_DIRS_TO_WALK = 6;

    /**
     * Scan a Java source body for data-provider annotations.
     */
    public static extractReferences(content: string): DataReference[] {
        const refs: DataReference[] = [];

        // QAF: @QAFDataProvider(dataFile = "...", sheetName = "...", key = "...")
        // Multi-line tolerant.
        const qafRe =
            /@QAFDataProvider\s*\(\s*([\s\S]*?)\)/g;
        let m: RegExpExecArray | null;
        while ((m = qafRe.exec(content)) !== null) {
            const block = m[1];
            const dataFile = CSTestDataMigrator.readQuoted(block, 'dataFile');
            const sheetName = CSTestDataMigrator.readQuoted(block, 'sheetName');
            const rowKey = CSTestDataMigrator.readQuoted(block, 'key');
            if (dataFile) {
                refs.push({
                    rawPath: dataFile,
                    resolvedPath: null,
                    sheetName: sheetName || undefined,
                    rowKey: rowKey || undefined,
                    source: 'qaf',
                });
            }
        }

        // TestNG: @DataProvider followed by a method that opens a file. We
        // just look for string literals ending in supported data extensions.
        // Same pattern legacy_parse uses for inline refs.
        const inlineRe =
            /"([\w./\\\-:${}]+\.(xlsx|xls|csv|tsv|json|yaml|yml|xml|properties))"/g;
        let im: RegExpExecArray | null;
        while ((im = inlineRe.exec(content)) !== null) {
            const fp = im[1];
            // Skip if already captured by QAF block.
            if (refs.some((r) => r.rawPath === fp)) continue;
            refs.push({
                rawPath: fp,
                resolvedPath: null,
                source: 'inline',
            });
        }

        return refs;
    }

    /**
     * Read a `name = "value"` pair from inside an annotation argument list.
     * Tolerates whitespace, optional quotes around the value, and string
     * concatenation (single +-joined literal segment).
     */
    private static readQuoted(block: string, name: string): string | null {
        const re = new RegExp(
            `\\b${name}\\s*=\\s*"([^"]*)"`,
            'i',
        );
        const m = block.match(re);
        return m ? m[1] : null;
    }

    /**
     * Resolve every reference's `resolvedPath`. Walks up from the source
     * file's directory looking for a parent that contains the referenced
     * relative path. Substitutes `${environment.name}` and `${env}`
     * placeholders with `DEFAULT_ENV_NAME`.
     */
    public static resolvePaths(
        refs: DataReference[],
        sourceFileAbs: string,
    ): DataReference[] {
        const sourceDir = path.dirname(sourceFileAbs);
        for (const ref of refs) {
            const cleaned = CSTestDataMigrator.substituteEnvPlaceholders(ref.rawPath);
            // Try absolute-as-given first.
            if (path.isAbsolute(cleaned) && fs.existsSync(cleaned)) {
                ref.resolvedPath = cleaned;
                continue;
            }
            // Walk up from the source file looking for the relative path.
            let cur = sourceDir;
            for (let i = 0; i < CSTestDataMigrator.MAX_PARENT_DIRS_TO_WALK; i++) {
                const candidate = path.resolve(cur, cleaned);
                if (fs.existsSync(candidate)) {
                    ref.resolvedPath = candidate;
                    break;
                }
                const parent = path.dirname(cur);
                if (parent === cur) break;
                cur = parent;
            }
        }
        return refs;
    }

    private static substituteEnvPlaceholders(p: string): string {
        return p
            .replace(/\$\{\s*environment\.name\s*\}/gi, CSTestDataMigrator.DEFAULT_ENV_NAME)
            .replace(/\$\{\s*env\s*\}/gi, CSTestDataMigrator.DEFAULT_ENV_NAME);
    }

    /**
     * Drive `data_parse` for each resolved reference and collect the rows.
     * When a `rowKey` is set, filter to matching rows only.
     */
    public static async parseAll(
        refs: DataReference[],
        context: MCPToolContext,
    ): Promise<MigratedTestData> {
        const rows: Array<Record<string, unknown>> = [];
        const notes: string[] = [];

        for (const ref of refs) {
            if (!ref.resolvedPath) {
                notes.push(
                    `Unresolved data reference: ${ref.rawPath} (source=${ref.source})`,
                );
                continue;
            }

            const params: Record<string, unknown> = { source: ref.resolvedPath };
            if (ref.sheetName) params.sheet = ref.sheetName;

            let result: MCPToolResult;
            try {
                result = await CSTestDataMigrator.invokeTool(
                    'data_parse',
                    params,
                    context,
                );
            } catch (err) {
                notes.push(
                    `data_parse threw on ${ref.resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
                );
                continue;
            }
            if (result.isError) {
                notes.push(
                    `data_parse failed on ${ref.resolvedPath}: ${CSTestDataMigrator.firstText(result).slice(0, 200)}`,
                );
                continue;
            }

            const parsed = CSTestDataMigrator.parseDataResult(result);
            if (!parsed) {
                notes.push(
                    `data_parse returned no scenarios for ${ref.resolvedPath}`,
                );
                continue;
            }

            // Apply row-key filter when specified. The spreadsheet may use a
            // dedicated key column ("scenarioId", "TestCaseId", etc.) — we
            // search across the canonical scenarioId field plus any column
            // whose value matches.
            const filtered = ref.rowKey
                ? parsed.filter((r) => CSTestDataMigrator.rowMatchesKey(r, ref.rowKey!))
                : parsed;

            if (ref.rowKey && filtered.length === 0) {
                notes.push(
                    `Row key '${ref.rowKey}' not found in ${ref.resolvedPath} (sheet=${ref.sheetName ?? '<default>'})`,
                );
                continue;
            }

            rows.push(...filtered);
            notes.push(
                `Parsed ${filtered.length} row(s) from ${ref.resolvedPath}` +
                    (ref.sheetName ? ` [${ref.sheetName}]` : '') +
                    (ref.rowKey ? ` filtered by key=${ref.rowKey}` : ''),
            );
        }

        return { references: refs, rows, notes };
    }

    /**
     * Convenience: scan + resolve + parse in one call. Returns the empty
     * result on any irrecoverable error so callers can pass the result to
     * grounding without conditional logic.
     */
    public static async migrate(
        sourceFileAbs: string,
        sourceContent: string,
        context: MCPToolContext,
    ): Promise<MigratedTestData> {
        const refs = CSTestDataMigrator.resolvePaths(
            CSTestDataMigrator.extractReferences(sourceContent),
            sourceFileAbs,
        );
        if (refs.length === 0) {
            return { references: [], rows: [], notes: [] };
        }
        return CSTestDataMigrator.parseAll(refs, context);
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private static rowMatchesKey(
        row: Record<string, unknown>,
        key: string,
    ): boolean {
        const wanted = key.trim().toLowerCase();
        const candidates = [
            row.scenarioId,
            row.scenario_id,
            row.testCaseId,
            row.test_case_id,
            row.tcId,
            row.tc_id,
            row.id,
            row.key,
            row.rowKey,
        ];
        for (const v of candidates) {
            if (typeof v === 'string' && v.trim().toLowerCase() === wanted) {
                return true;
            }
        }
        // Fall back: any string value matches.
        for (const v of Object.values(row)) {
            if (typeof v === 'string' && v.trim().toLowerCase() === wanted) {
                return true;
            }
        }
        return false;
    }

    private static parseDataResult(
        result: MCPToolResult,
    ): Array<Record<string, unknown>> | null {
        const sc = result.structuredContent as Record<string, unknown> | undefined;
        const fromSc = sc?.scenarios as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(fromSc)) return fromSc;
        const text = CSTestDataMigrator.firstText(result);
        if (!text) return null;
        try {
            const obj = JSON.parse(text) as Record<string, unknown>;
            const scenarios = obj.scenarios as
                | Array<Record<string, unknown>>
                | undefined;
            return Array.isArray(scenarios) ? scenarios : null;
        } catch {
            return null;
        }
    }

    private static firstText(result: MCPToolResult): string {
        for (const c of result.content) {
            if (c.type === 'text') return c.text;
        }
        return '';
    }

    private static async invokeTool(
        toolName: string,
        params: Record<string, unknown>,
        context: MCPToolContext,
    ): Promise<MCPToolResult> {
        const def = (parseTools as MCPToolDefinition[]).find(
            (d) => d.tool.name === toolName,
        );
        if (!def) {
            throw new Error(
                `CSTestDataMigrator: required tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }
}
