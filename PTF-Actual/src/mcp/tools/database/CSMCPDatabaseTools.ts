/**
 * CS Playwright MCP Database Tools
 * Real database operations using CSDatabase, CSDatabaseManager, and CSDBUtils
 *
 * @module CSMCPDatabaseTools
 */

import {
    MCPToolDefinition,
    MCPToolResult,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';
import { CSDatabase } from '../../../database/client/CSDatabase';
import { CSDatabaseManager } from '../../../database/CSDatabaseManager';
import { CSDBUtils } from '../../../database/utils/CSDBUtils';
import { CSReporter } from '../../../reporter/CSReporter';
import { CSConfigurationManager } from '../../../core/CSConfigurationManager';

// ============================================================================
// Helper Functions
// ============================================================================

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

// ============================================================================
// Connection Management Tools
// ============================================================================

const dbConnectTool = defineTool()
    .name('db_connect')
    .description('Connect to a database using alias from configuration. Database config should be set via DB_{ALIAS}_* environment variables.')
    .category('database')
    .stringParam('alias', 'Database alias (e.g., APP_ORACLE, DEFAULT)', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        context.log('info', `Connecting to database: ${alias}`);

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = await dbManager.createConnection(alias);

            if (db.isConnected()) {
                CSReporter.pass(`Connected to database: ${alias}`);
                return createJsonResult({
                    success: true,
                    alias,
                    connected: true,
                    message: `Successfully connected to database: ${alias}`,
                });
            } else {
                return createErrorResult(`Failed to connect to database: ${alias}`);
            }
        } catch (error) {
            CSReporter.fail(`Database connection failed: ${(error as Error).message}`);
            return createErrorResult(`Connection failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbDisconnectTool = defineTool()
    .name('db_disconnect')
    .description('Disconnect from a database')
    .category('database')
    .stringParam('alias', 'Database alias to disconnect', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        context.log('info', `Disconnecting from database: ${alias}`);

        try {
            const dbManager = CSDatabaseManager.getInstance();
            await dbManager.closeConnection(alias);

            CSReporter.info(`Disconnected from database: ${alias}`);
            return createJsonResult({
                success: true,
                alias,
                connected: false,
                message: `Disconnected from database: ${alias}`,
            });
        } catch (error) {
            return createErrorResult(`Disconnect failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbConnectionStatusTool = defineTool()
    .name('db_connection_status')
    .description('Check connection status for a database alias')
    .category('database')
    .stringParam('alias', 'Database alias to check', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);
            const isConnected = db ? db.isConnected() : false;

            return createJsonResult({
                alias,
                connected: isConnected,
                status: isConnected ? 'connected' : 'disconnected',
            });
        } catch (error) {
            return createJsonResult({
                alias,
                connected: false,
                status: 'not_found',
                error: (error as Error).message,
            });
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Query Execution Tools
// ============================================================================

const dbQueryTool = defineTool()
    .name('db_query')
    .description('Execute a SQL query and return results. Use for SELECT statements.')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('sql', 'SQL query to execute', { required: true })
    .arrayParam('params', 'Query parameters for parameterized queries', 'string')
    .numberParam('limit', 'Maximum rows to return', { default: 100 })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const sql = params.sql as string;
        const queryParams = params.params as string[] || [];
        const limit = params.limit as number;

        context.log('info', `Executing query on ${alias}: ${sql.substring(0, 100)}...`);

        try {
            const result = await CSDBUtils.executeQuery(alias, sql, queryParams);
            const rows = result.rows || [];
            const limitedRows = rows.slice(0, limit);

            CSReporter.pass(`Query executed: ${result.rowCount} rows returned`);

            return createJsonResult({
                success: true,
                rowCount: result.rowCount,
                returnedRows: limitedRows.length,
                totalRows: rows.length,
                rows: limitedRows,
                columns: result.metadata?.columns || Object.keys(rows[0] || {}),
                truncated: rows.length > limit,
            });
        } catch (error) {
            CSReporter.fail(`Query failed: ${(error as Error).message}`);
            return createErrorResult(`Query execution failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbQueryNamedTool = defineTool()
    .name('db_query_named')
    .description('Execute a named query from configuration (DB_QUERY_{NAME} in config)')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('queryName', 'Named query key (without DB_QUERY_ prefix)', { required: true })
    .arrayParam('params', 'Query parameters', 'string')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const queryName = params.queryName as string;
        const queryParams = params.params as string[] || [];

        context.log('info', `Executing named query: ${queryName} on ${alias}`);

        try {
            const result = await CSDBUtils.executeNamedQuery(alias, queryName, queryParams);

            CSReporter.pass(`Named query '${queryName}' executed: ${result.rowCount} rows`);

            return createJsonResult({
                success: true,
                queryName,
                rowCount: result.rowCount,
                rows: result.rows || [],
            });
        } catch (error) {
            CSReporter.fail(`Named query failed: ${(error as Error).message}`);
            return createErrorResult(`Named query '${queryName}' failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbQuerySingleValueTool = defineTool()
    .name('db_query_single_value')
    .description('Execute a query and return a single value (first column of first row)')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('sql', 'SQL query', { required: true })
    .arrayParam('params', 'Query parameters', 'string')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const sql = params.sql as string;
        const queryParams = params.params as string[] || [];

        try {
            const value = await CSDBUtils.executeSingleValue(alias, sql, queryParams);

            return createJsonResult({
                success: true,
                value,
                type: typeof value,
            });
        } catch (error) {
            return createErrorResult(`Query failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbQuerySingleRowTool = defineTool()
    .name('db_query_single_row')
    .description('Execute a query and return a single row')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('sql', 'SQL query', { required: true })
    .arrayParam('params', 'Query parameters', 'string')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const sql = params.sql as string;
        const queryParams = params.params as string[] || [];

        try {
            const row = await CSDBUtils.executeSingleRow(alias, sql, queryParams);

            return createJsonResult({
                success: true,
                row,
                columns: row ? Object.keys(row) : [],
            });
        } catch (error) {
            return createErrorResult(`Query failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbExecuteTool = defineTool()
    .name('db_execute')
    .description('Execute a SQL statement (INSERT, UPDATE, DELETE). Returns affected row count.')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('sql', 'SQL statement to execute', { required: true })
    .arrayParam('params', 'Statement parameters', 'string')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const sql = params.sql as string;
        const stmtParams = params.params as string[] || [];

        context.log('info', `Executing statement on ${alias}`);

        try {
            const rowsAffected = await CSDBUtils.executeUpdate(alias, sql, stmtParams);

            CSReporter.pass(`Statement executed: ${rowsAffected} rows affected`);

            return createJsonResult({
                success: true,
                rowsAffected,
                message: `${rowsAffected} row(s) affected`,
            });
        } catch (error) {
            CSReporter.fail(`Statement failed: ${(error as Error).message}`);
            return createErrorResult(`Execution failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbExecuteStoredProcedureTool = defineTool()
    .name('db_execute_stored_procedure')
    .description('Execute a stored procedure')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('procedureName', 'Stored procedure name', { required: true })
    .arrayParam('params', 'Procedure parameters', 'string')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const procedureName = params.procedureName as string;
        const procParams = params.params as string[] || [];

        context.log('info', `Executing stored procedure: ${procedureName}`);

        try {
            const result = await CSDBUtils.executeStoredProcedure(alias, procedureName, procParams);

            CSReporter.pass(`Stored procedure '${procedureName}' executed`);

            return createJsonResult({
                success: true,
                procedureName,
                rowCount: result.rowCount,
                rows: result.rows || [],
            });
        } catch (error) {
            CSReporter.fail(`Stored procedure failed: ${(error as Error).message}`);
            return createErrorResult(`Stored procedure failed: ${(error as Error).message}`);
        }
    })
    .build();

// ============================================================================
// Transaction Management Tools
// ============================================================================

const dbBeginTransactionTool = defineTool()
    .name('db_begin_transaction')
    .description('Begin a database transaction')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('isolationLevel', 'Transaction isolation level', {
        enum: ['READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'],
    })
    .handler(async (params, context) => {
        const alias = params.alias as string;

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);
            await db.beginTransaction();

            CSReporter.info(`Transaction started on ${alias}`);

            return createJsonResult({
                success: true,
                alias,
                status: 'transaction_started',
                isolationLevel: params.isolationLevel || 'default',
            });
        } catch (error) {
            return createErrorResult(`Failed to begin transaction: ${(error as Error).message}`);
        }
    })
    .build();

const dbCommitTransactionTool = defineTool()
    .name('db_commit_transaction')
    .description('Commit the current transaction')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);
            await db.commitTransaction();

            CSReporter.pass(`Transaction committed on ${alias}`);

            return createJsonResult({
                success: true,
                alias,
                status: 'committed',
            });
        } catch (error) {
            return createErrorResult(`Commit failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbRollbackTransactionTool = defineTool()
    .name('db_rollback_transaction')
    .description('Rollback the current transaction')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('savepoint', 'Savepoint name to rollback to (optional)')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const savepoint = params.savepoint as string | undefined;

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);
            await db.rollbackTransaction(savepoint);

            CSReporter.info(`Transaction rolled back on ${alias}${savepoint ? ` to savepoint: ${savepoint}` : ''}`);

            return createJsonResult({
                success: true,
                alias,
                status: 'rolled_back',
                savepoint: savepoint || null,
            });
        } catch (error) {
            return createErrorResult(`Rollback failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbCreateSavepointTool = defineTool()
    .name('db_create_savepoint')
    .description('Create a savepoint within a transaction')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('name', 'Savepoint name', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const name = params.name as string;

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);
            await db.createSavepoint(name);

            return createJsonResult({
                success: true,
                alias,
                savepoint: name,
                status: 'created',
            });
        } catch (error) {
            return createErrorResult(`Savepoint creation failed: ${(error as Error).message}`);
        }
    })
    .build();

// ============================================================================
// Data Verification Tools
// ============================================================================

const dbVerifyRowExistsTool = defineTool()
    .name('db_verify_row_exists')
    .description('Verify that a row exists in a table matching given criteria')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('table', 'Table name', { required: true })
    .objectParam('criteria', 'Column-value pairs to match', undefined, { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const table = params.table as string;
        const criteria = params.criteria as Record<string, unknown>;

        const whereClauses = Object.keys(criteria).map((col, i) => `${col} = $${i + 1}`);
        const sql = `SELECT COUNT(*) as count FROM ${table} WHERE ${whereClauses.join(' AND ')}`;
        const values = Object.values(criteria);

        try {
            const result = await CSDBUtils.executeSingleValue<number>(alias, sql, values);
            const exists = result > 0;

            if (exists) {
                CSReporter.pass(`Row exists in ${table} matching criteria`);
            } else {
                CSReporter.fail(`Row not found in ${table} matching criteria`);
            }

            return createJsonResult({
                success: true,
                exists,
                table,
                criteria,
                matchCount: result,
            });
        } catch (error) {
            return createErrorResult(`Verification failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbVerifyRowCountTool = defineTool()
    .name('db_verify_row_count')
    .description('Verify row count in a table matches expected value')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('table', 'Table name', { required: true })
    .numberParam('expectedCount', 'Expected row count', { required: true })
    .stringParam('whereClause', 'Optional WHERE clause (without WHERE keyword)')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const table = params.table as string;
        const expectedCount = params.expectedCount as number;
        const whereClause = params.whereClause as string | undefined;

        let sql = `SELECT COUNT(*) as count FROM ${table}`;
        if (whereClause) {
            sql += ` WHERE ${whereClause}`;
        }

        try {
            const actualCount = await CSDBUtils.executeSingleValue<number>(alias, sql);
            const matches = actualCount === expectedCount;

            if (matches) {
                CSReporter.pass(`Row count matches: ${actualCount}`);
            } else {
                CSReporter.fail(`Row count mismatch: expected ${expectedCount}, got ${actualCount}`);
            }

            return createJsonResult({
                success: true,
                matches,
                expectedCount,
                actualCount,
                table,
                whereClause: whereClause || null,
            });
        } catch (error) {
            return createErrorResult(`Verification failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbVerifyValueTool = defineTool()
    .name('db_verify_value')
    .description('Verify a specific column value in the database')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('sql', 'SQL query that returns a single value', { required: true })
    .stringParam('expectedValue', 'Expected value', { required: true })
    .arrayParam('params', 'Query parameters', 'string')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const sql = params.sql as string;
        const expectedValue = params.expectedValue as string;
        const queryParams = params.params as string[] || [];

        try {
            const actualValue = await CSDBUtils.executeSingleValue(alias, sql, queryParams);
            const actualStr = String(actualValue);
            const matches = actualStr === expectedValue;

            if (matches) {
                CSReporter.pass(`Value matches: ${actualStr}`);
            } else {
                CSReporter.fail(`Value mismatch: expected '${expectedValue}', got '${actualStr}'`);
            }

            return createJsonResult({
                success: true,
                matches,
                expectedValue,
                actualValue: actualStr,
            });
        } catch (error) {
            return createErrorResult(`Verification failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbCompareDataTool = defineTool()
    .name('db_compare_data')
    .description('Compare data between two queries or tables')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('sourceQuery', 'Source SQL query', { required: true })
    .stringParam('targetQuery', 'Target SQL query', { required: true })
    .arrayParam('keyColumns', 'Columns to use as comparison keys', 'string', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const sourceQuery = params.sourceQuery as string;
        const targetQuery = params.targetQuery as string;
        const keyColumns = params.keyColumns as string[];

        try {
            const sourceResultSet = await CSDBUtils.executeQuery(alias, sourceQuery);
            const targetResultSet = await CSDBUtils.executeQuery(alias, targetQuery);
            const sourceResult = sourceResultSet.rows || [];
            const targetResult = targetResultSet.rows || [];

            // Create key maps for comparison
            const getKey = (row: Record<string, unknown>) =>
                keyColumns.map(col => String(row[col])).join('|');

            const sourceMap = new Map(sourceResult.map((row: Record<string, unknown>) => [getKey(row), row]));
            const targetMap = new Map(targetResult.map((row: Record<string, unknown>) => [getKey(row), row]));

            const onlyInSource: unknown[] = [];
            const onlyInTarget: unknown[] = [];
            const different: unknown[] = [];
            const matching: unknown[] = [];

            // Check source rows
            for (const [key, sourceRow] of sourceMap) {
                const targetRow = targetMap.get(key);
                if (!targetRow) {
                    onlyInSource.push(sourceRow);
                } else if (JSON.stringify(sourceRow) !== JSON.stringify(targetRow)) {
                    different.push({ source: sourceRow, target: targetRow });
                } else {
                    matching.push(sourceRow);
                }
            }

            // Check for rows only in target
            for (const [key, targetRow] of targetMap) {
                if (!sourceMap.has(key)) {
                    onlyInTarget.push(targetRow);
                }
            }

            const isEqual = onlyInSource.length === 0 && onlyInTarget.length === 0 && different.length === 0;

            return createJsonResult({
                success: true,
                isEqual,
                summary: {
                    sourceRowCount: sourceResult.length,
                    targetRowCount: targetResult.length,
                    matchingRows: matching.length,
                    onlyInSource: onlyInSource.length,
                    onlyInTarget: onlyInTarget.length,
                    differentRows: different.length,
                },
                details: {
                    onlyInSource: onlyInSource.slice(0, 10),
                    onlyInTarget: onlyInTarget.slice(0, 10),
                    different: different.slice(0, 10),
                },
            });
        } catch (error) {
            return createErrorResult(`Comparison failed: ${(error as Error).message}`);
        }
    })
    .build();

// ============================================================================
// Schema Information Tools
// ============================================================================

const dbListTablesTool = defineTool()
    .name('db_list_tables')
    .description('List all tables in the database')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('schema', 'Schema name (optional)')
    .stringParam('pattern', 'Table name pattern (optional, e.g., USER%)')
    .handler(async (params, context) => {
        const alias = params.alias as string;

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);
            const metadata = await db.getMetadata();

            // Get tables from metadata - handle different possible structures
            let tables: any[] = (metadata as any).tables || [];

            if (params.schema) {
                tables = tables.filter((t: { schema?: string }) =>
                    t.schema?.toLowerCase() === (params.schema as string).toLowerCase()
                );
            }

            if (params.pattern) {
                const pattern = new RegExp(
                    (params.pattern as string).replace(/%/g, '.*'),
                    'i'
                );
                tables = tables.filter((t: { name: string }) => pattern.test(t.name));
            }

            return createJsonResult({
                success: true,
                tableCount: tables.length,
                tables: tables.map((t: { name: string; schema?: string; type?: string }) => ({
                    name: t.name,
                    schema: t.schema,
                    type: t.type || 'TABLE',
                })),
            });
        } catch (error) {
            return createErrorResult(`Failed to list tables: ${(error as Error).message}`);
        }
    })
    .readOnly()
    .build();

const dbDescribeTableTool = defineTool()
    .name('db_describe_table')
    .description('Get table structure (columns, types, constraints)')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('table', 'Table name', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const table = params.table as string;

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);
            const tableInfo = await db.getTableInfo(table);

            return createJsonResult({
                success: true,
                table,
                columns: (tableInfo as any).columns || [],
                primaryKey: (tableInfo as any).primaryKey || null,
                foreignKeys: (tableInfo as any).foreignKeys || [],
                indexes: (tableInfo as any).indexes || [],
            });
        } catch (error) {
            return createErrorResult(`Failed to describe table: ${(error as Error).message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Bulk Operations Tools
// ============================================================================

const dbBulkInsertTool = defineTool()
    .name('db_bulk_insert')
    .description('Insert multiple rows into a table')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('table', 'Table name', { required: true })
    .arrayParam('data', 'Array of row objects to insert', 'object', { required: true })
    .numberParam('batchSize', 'Batch size for insertion', { default: 100 })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const table = params.table as string;
        const data = params.data as Record<string, unknown>[];
        const batchSize = params.batchSize as number;

        context.log('info', `Bulk inserting ${data.length} rows into ${table}`);

        try {
            const dbManager = CSDatabaseManager.getInstance();
            const db = dbManager.getConnection(alias);

            // Build INSERT queries for each row
            let insertedCount = 0;
            const columns = Object.keys(data[0] || {});

            for (let i = 0; i < data.length; i += batchSize) {
                const batch = data.slice(i, i + batchSize);

                for (const row of batch) {
                    const values = columns.map(col => row[col]);
                    const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
                    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

                    await db.query(sql, values);
                    insertedCount++;
                }
            }

            CSReporter.pass(`Bulk insert completed: ${insertedCount} rows inserted into ${table}`);

            return createJsonResult({
                success: true,
                table,
                requestedRows: data.length,
                insertedRows: insertedCount,
            });
        } catch (error) {
            CSReporter.fail(`Bulk insert failed: ${(error as Error).message}`);
            return createErrorResult(`Bulk insert failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbTruncateTableTool = defineTool()
    .name('db_truncate_table')
    .description('Truncate (delete all rows from) a table. Use with caution!')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('table', 'Table name to truncate', { required: true })
    .booleanParam('confirm', 'Confirm truncation (must be true)', { required: true })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const table = params.table as string;
        const confirm = params.confirm as boolean;

        if (!confirm) {
            return createErrorResult('Truncation not confirmed. Set confirm=true to proceed.');
        }

        context.log('info', `Truncating table: ${table}`);

        try {
            await CSDBUtils.executeUpdate(alias, `TRUNCATE TABLE ${table}`);

            CSReporter.warn(`Table truncated: ${table}`);

            return createJsonResult({
                success: true,
                table,
                status: 'truncated',
            });
        } catch (error) {
            return createErrorResult(`Truncate failed: ${(error as Error).message}`);
        }
    })
    .build();

// ============================================================================
// Data Export/Import Tools
// ============================================================================

const dbExportResultTool = defineTool()
    .name('db_export_result')
    .description('Export query results to a file')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('sql', 'SQL query to export', { required: true })
    .stringParam('filePath', 'Output file path', { required: true })
    .stringParam('format', 'Export format', {
        required: true,
        enum: ['csv', 'json', 'xml', 'excel'],
    })
    .arrayParam('params', 'Query parameters', 'string')
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const sql = params.sql as string;
        const filePath = params.filePath as string;
        const format = params.format as 'csv' | 'json' | 'xml' | 'excel';
        const queryParams = params.params as string[] || [];

        try {
            const result = await CSDBUtils.executeQuery(alias, sql, queryParams);
            const rows = result.rows || [];
            const fs = await import('fs');
            const path = await import('path');

            // Export based on format
            let content: string;
            switch (format) {
                case 'json':
                    content = JSON.stringify(rows, null, 2);
                    break;
                case 'csv':
                    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
                    const csvLines = [
                        columns.join(','),
                        ...rows.map((row: Record<string, unknown>) =>
                            columns.map(col => JSON.stringify(row[col] ?? '')).join(',')
                        )
                    ];
                    content = csvLines.join('\n');
                    break;
                default:
                    content = JSON.stringify(rows, null, 2);
            }

            const resolvedPath = path.resolve(context.server.workingDirectory, filePath);
            fs.writeFileSync(resolvedPath, content);

            CSReporter.pass(`Exported ${result.rowCount} rows to ${filePath}`);

            return createJsonResult({
                success: true,
                filePath: resolvedPath,
                format,
                rowCount: result.rowCount,
            });
        } catch (error) {
            return createErrorResult(`Export failed: ${(error as Error).message}`);
        }
    })
    .build();

const dbImportDataTool = defineTool()
    .name('db_import_data')
    .description('Import data from a file into a table')
    .category('database')
    .stringParam('alias', 'Database alias', { required: true })
    .stringParam('table', 'Target table name', { required: true })
    .stringParam('filePath', 'Input file path', { required: true })
    .stringParam('format', 'File format', {
        required: true,
        enum: ['csv', 'json', 'xml', 'excel'],
    })
    .handler(async (params, context) => {
        const alias = params.alias as string;
        const table = params.table as string;
        const filePath = params.filePath as string;
        const format = params.format as 'csv' | 'json' | 'xml' | 'excel';

        try {
            const fs = await import('fs');
            const path = await import('path');

            const resolvedPath = path.resolve(context.server.workingDirectory, filePath);
            const content = fs.readFileSync(resolvedPath, 'utf-8');

            let rows: Record<string, unknown>[] = [];

            // Parse based on format
            switch (format) {
                case 'json':
                    rows = JSON.parse(content);
                    break;
                case 'csv':
                    const lines = content.split('\n').filter(line => line.trim());
                    if (lines.length > 0) {
                        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
                        for (let i = 1; i < lines.length; i++) {
                            const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
                            const row: Record<string, unknown> = {};
                            headers.forEach((header, idx) => {
                                row[header] = values[idx];
                            });
                            rows.push(row);
                        }
                    }
                    break;
                default:
                    throw new Error(`Unsupported format for import: ${format}`);
            }

            // Insert rows using transaction
            const queries = rows.map(row => {
                const columns = Object.keys(row);
                const values = Object.values(row);
                const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
                return {
                    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
                    params: values,
                };
            });

            await CSDBUtils.executeTransaction(alias, queries);

            CSReporter.pass(`Imported ${rows.length} rows into ${table}`);

            return createJsonResult({
                success: true,
                table,
                filePath,
                format,
                importedRows: rows.length,
            });
        } catch (error) {
            return createErrorResult(`Import failed: ${(error as Error).message}`);
        }
    })
    .build();

// ============================================================================
// Export all database tools
// ============================================================================

export const databaseTools: MCPToolDefinition[] = [
    // Connection Management
    dbConnectTool,
    dbDisconnectTool,
    dbConnectionStatusTool,

    // Query Execution
    dbQueryTool,
    dbQueryNamedTool,
    dbQuerySingleValueTool,
    dbQuerySingleRowTool,
    dbExecuteTool,
    dbExecuteStoredProcedureTool,

    // Transaction Management
    dbBeginTransactionTool,
    dbCommitTransactionTool,
    dbRollbackTransactionTool,
    dbCreateSavepointTool,

    // Data Verification
    dbVerifyRowExistsTool,
    dbVerifyRowCountTool,
    dbVerifyValueTool,
    dbCompareDataTool,

    // Schema Information
    dbListTablesTool,
    dbDescribeTableTool,

    // Bulk Operations
    dbBulkInsertTool,
    dbTruncateTableTool,

    // Data Export/Import
    dbExportResultTool,
    dbImportDataTool,
];

/**
 * Register all database tools with the registry
 */
export function registerDatabaseTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(databaseTools);
}
