import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

// Rejects anything that isn't a pure SELECT (or WITH-only CTE ending in SELECT).
function assertSelectOnly(sql: string): void {
    const cleaned = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (cleaned.length === 0) throw new Error('db_select: empty SQL');
    const banned = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE|CALL|EXEC|EXECUTE|REPLACE|LOCK|UNLOCK|COMMIT|ROLLBACK|SET\s+SESSION|SET\s+GLOBAL)\b/i;
    if (banned.test(cleaned)) {
        const m = banned.exec(cleaned);
        throw new Error(`db_select: banned keyword '${m ? m[0] : '?'}' — this tool is SELECT-only. Use a proper DB helper for mutations (framework has none exposed here — mutations must be requested manually).`);
    }
    const firstStmt = cleaned.split(';')[0].trim().toUpperCase();
    if (!firstStmt.startsWith('SELECT') && !firstStmt.startsWith('WITH')) {
        throw new Error(`db_select: statement must begin with SELECT or WITH (CTE). Got: '${firstStmt.slice(0, 40)}...'`);
    }
    if (cleaned.split(';').filter((s) => s.trim().length > 0).length > 1) {
        throw new Error('db_select: multiple statements not permitted. Send exactly one SELECT.');
    }
}

registerPrimitive({
    name: 'cs_qa_db_select',
    description: 'Run a SELECT query against a configured DB alias and return rows. Hard rule: SELECT only — INSERT/UPDATE/DELETE/DDL/DCL/CALL rejected. Use for test-data discovery, verifying app state, DB assertions in tests. Query text is validated BEFORE execution; parameters are bound.',
    inputSchema: z.object({
        alias: z.string().min(1).describe('DB alias configured in project env (e.g. APP_ORACLE, APP_MSSQL)'),
        sql: z.string().min(6),
        params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]),
        rowCap: z.number().int().positive().max(10_000).default(500),
    }),
    outputSchema: z.object({
        alias: z.string(),
        rowsReturned: z.number(),
        rowsCapped: z.boolean(),
        columns: z.array(z.string()),
        rows: z.array(z.record(z.string(), z.unknown())),
        durationMs: z.number(),
        note: z.string().optional(),
    }),
    run: async (_ctx, input) => {
        assertSelectOnly(input.sql);
        // Runtime dispatch: try framework's CSDBUtils if available in the workspace.
        // If not, return a schema-conformant "no-driver" response so the model
        // knows to configure the alias.
        const started = Date.now();
        try {
            const cwd = _ctx.workspaceRoot;
            const path = require('path');
            const csdbPath = path.resolve(cwd, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/database-utils/CSDBUtils.js');
            const { CSDBUtils } = require(csdbPath);
            const result = await CSDBUtils.executeQuery(input.alias, input.sql, input.params);
            const rows = (result?.rows ?? []).slice(0, input.rowCap);
            const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
            return {
                alias: input.alias, rowsReturned: rows.length,
                rowsCapped: (result?.rows?.length ?? 0) > input.rowCap,
                columns, rows,
                durationMs: Date.now() - started,
            };
        } catch (e) {
            return {
                alias: input.alias, rowsReturned: 0, rowsCapped: false,
                columns: [], rows: [], durationMs: Date.now() - started,
                note: `CSDBUtils not available or query failed: ${(e as Error).message}. Verify alias is defined in config/<project>/environments/<env>.env and driver installed.`,
            };
        }
    },
});
