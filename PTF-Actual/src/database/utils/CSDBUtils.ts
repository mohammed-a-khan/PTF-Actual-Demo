// src/database/utils/CSDBUtils.ts

/**
 * CSDBUtils - Simplified Database Utility Class
 *
 * Purpose: Provides static utility methods for easy database operations
 * without requiring users to manually manage database connections.
 *
 * Features:
 * - Auto-connection management
 * - Named query support from configuration
 * - Type-safe results
 * - Parameterized query support
 * - Simplified result extraction
 *
 * Usage Examples:
 *
 * ```typescript
 * // Execute query and get full result set
 * const result = await CSDBUtils.executeQuery('MY_DB', 'SELECT * FROM users WHERE id = ?', [123]);
 *
 * // Execute named query from config
 * const result = await CSDBUtils.executeNamedQuery('MY_DB', 'GET_USER_BY_ID', [123]);
 *
 * // Get single value
 * const count = await CSDBUtils.executeSingleValue<number>('MY_DB', 'SELECT COUNT(*) FROM users');
 *
 * // Get single row
 * const user = await CSDBUtils.executeSingleRow('MY_DB', 'SELECT * FROM users WHERE id = ?', [123]);
 *
 * // Check if record exists
 * const exists = await CSDBUtils.exists('MY_DB', 'SELECT 1 FROM users WHERE email = ?', ['test@example.com']);
 *
 * // Get count
 * const userCount = await CSDBUtils.count('MY_DB', 'SELECT COUNT(*) as count FROM users');
 * ```
 */

import { CSDatabaseManager } from '../CSDatabaseManager';
import { CSDatabase } from '../client/CSDatabase';
import { ResultSet } from '../types/database.types';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSReporter } from '../../reporter/CSReporter';

export class CSDBUtils {
    private static dbManager: CSDatabaseManager;
    private static config: CSConfigurationManager;
    private static connectionCache: Map<string, CSDatabase> = new Map();

    /**
     * Initialize the database manager and configuration
     * @private
     */
    private static initialize(): void {
        if (!this.dbManager) {
            this.dbManager = CSDatabaseManager.getInstance();
            this.config = CSConfigurationManager.getInstance();
        }
    }

    /**
     * Get or create a database connection
     * @param alias - Database connection alias
     * @returns Database instance
     * @private
     */
    private static async getConnection(alias: string): Promise<CSDatabase> {
        this.initialize();

        // Check if connection exists in manager
        try {
            return this.dbManager.getConnection(alias);
        } catch (error) {
            // Connection doesn't exist, create it
            CSReporter.debug(`Creating new database connection: ${alias}`);
            return await this.dbManager.createConnection(alias);
        }
    }

    /**
     * Resolve query - either use direct SQL or fetch named query from config
     * @param alias - Database alias
     * @param sqlOrQueryKey - SQL string or query key from config
     * @returns Resolved SQL string
     * @private
     */
    private static resolveQuery(alias: string, sqlOrQueryKey: string): string {
        CSReporter.debug(`[resolveQuery] CALLED with sqlOrQueryKey: ${sqlOrQueryKey.substring(0, 100)}`);

        // If it looks like a SQL query (starts with SQL keywords or contains spaces), return as-is
        const trimmed = sqlOrQueryKey.trim().toLowerCase();
        const startsWithSqlKeyword =
            trimmed.startsWith('select ') ||
            trimmed.startsWith('insert ') ||
            trimmed.startsWith('update ') ||
            trimmed.startsWith('delete ') ||
            trimmed.startsWith('with ') ||     // Common Table Expressions
            trimmed.startsWith('create ') ||
            trimmed.startsWith('alter ') ||
            trimmed.startsWith('drop ') ||
            trimmed.startsWith('truncate ') ||
            trimmed.startsWith('exec ') ||     // SQL Server stored procedures
            trimmed.startsWith('execute ') ||
            trimmed.startsWith('call ') ||     // MySQL/PostgreSQL stored procedures
            trimmed.startsWith('begin ');      // PL/SQL blocks

        if (startsWithSqlKeyword || sqlOrQueryKey.includes(' ')) {
            CSReporter.debug(`[resolveQuery] Detected as direct SQL, returning as-is`);
            return sqlOrQueryKey;
        }

        // Otherwise, try to fetch from config
        // Check if the query key already starts with DB_QUERY_ prefix (case-insensitive check)
        const hasPrefix = sqlOrQueryKey.toUpperCase().startsWith('DB_QUERY_');
        const queryKey = hasPrefix ? sqlOrQueryKey : `DB_QUERY_${sqlOrQueryKey}`;

        // Initialize config if not already done
        if (!this.config) {
            this.initialize();
        }

        const query = this.config.get(queryKey);

        // Get total config keys count for diagnostics
        const allKeys = Array.from(this.config.getAll().keys());
        const totalKeys = allKeys.length;
        const queryKeys = allKeys.filter(k => k.startsWith('DB_QUERY_'));

        CSReporter.debug(`[resolveQuery] Looking for query key: ${queryKey}`);
        CSReporter.debug(`[resolveQuery] Config instance exists: ${this.config ? 'YES' : 'NO'}`);
        CSReporter.debug(`[resolveQuery] Total config keys loaded: ${totalKeys}`);
        CSReporter.debug(`[resolveQuery] Total DB_QUERY_* keys: ${queryKeys.length}`);
        CSReporter.debug(`[resolveQuery] Query found: ${query ? 'YES' : 'NO'}`);

        if (query) {
            CSReporter.debug(`[resolveQuery] Query SQL (first 100 chars): ${query.substring(0, 100)}`);
        } else if (queryKeys.length > 0) {
            CSReporter.debug(`[resolveQuery] Available DB_QUERY_* keys: ${queryKeys.slice(0, 5).join(', ')}${queryKeys.length > 5 ? '...' : ''}`);
        }

        if (!query) {
            // If not found in config, assume it's a direct SQL (might be a short command)
            CSReporter.debug(`Query key '${queryKey}' not found in config, using as direct SQL`);
            return sqlOrQueryKey;
        }

        CSReporter.debug(`Resolved named query '${sqlOrQueryKey}' from config`);
        return query;
    }

    /**
     * Execute a SQL query and return the full result set
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key from config
     * @param params - Optional query parameters (for parameterized queries)
     * @returns Promise<ResultSet> - Complete result set with rows, metadata, etc.
     *
     * @example
     * ```typescript
     * // Direct SQL
     * const result = await CSDBUtils.executeQuery('MY_DB', 'SELECT * FROM users WHERE id = ?', [123]);
     * console.log(result.rows); // Array of row objects
     * console.log(result.rowCount); // Number of rows returned
     *
     * // Named query from config (DB_QUERY_GET_ALL_USERS)
     * const result = await CSDBUtils.executeQuery('MY_DB', 'GET_ALL_USERS');
     * ```
     */
    public static async executeQuery(alias: string, sql: string, params?: any[]): Promise<ResultSet> {
        try {
            CSReporter.debug(`CSDBUtils.executeQuery - Alias: ${alias}`);
            CSReporter.debug(`CSDBUtils.executeQuery - Input SQL/QueryKey: "${sql}"`);
            CSReporter.debug(`CSDBUtils.executeQuery - SQL length: ${sql.length}, Has spaces: ${sql.includes(' ')}`);

            const db = await this.getConnection(alias);
            CSReporter.debug(`CSDBUtils.executeQuery - Connection obtained, calling resolveQuery...`);

            const resolvedSql = this.resolveQuery(alias, sql);

            CSReporter.debug(`CSDBUtils.executeQuery - resolveQuery returned, length: ${resolvedSql.length}`);
            CSReporter.debug(`Executing query: ${resolvedSql.substring(0, 100)}${resolvedSql.length > 100 ? '...' : ''}`);
            if (params && params.length > 0) {
                CSReporter.debug(`Query parameters: ${JSON.stringify(params)}`);
            }

            const result = await db.query(resolvedSql, params);

            CSReporter.debug(`Query executed successfully. Rows returned: ${result.rowCount}`);

            return result;
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeQuery failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute a named query from configuration
     *
     * @param alias - Database connection alias
     * @param queryKey - Query key name from config (without DB_QUERY_ prefix)
     * @param params - Optional query parameters
     * @returns Promise<ResultSet> - Complete result set
     *
     * @example
     * ```typescript
     * // Config has: DB_QUERY_GET_USER_BY_ID=SELECT * FROM users WHERE id = ?
     * const result = await CSDBUtils.executeNamedQuery('MY_DB', 'GET_USER_BY_ID', [123]);
     * ```
     */
    public static async executeNamedQuery(alias: string, queryKey: string, params?: any[]): Promise<ResultSet> {
        CSReporter.debug(`CSDBUtils.executeNamedQuery - Query Key: ${queryKey}`);

        const fullKey = `DB_QUERY_${queryKey.toUpperCase()}`;
        const sql = this.config.get(fullKey);

        if (!sql) {
            throw new Error(`Named query '${queryKey}' not found in configuration (expected key: ${fullKey})`);
        }

        return await this.executeQuery(alias, sql, params);
    }

    /**
     * Execute a SQL query from a .sql file
     *
     * @param alias - Database connection alias
     * @param filePath - Path to the .sql file (relative to project root or absolute)
     * @param params - Optional query parameters (use ? placeholders in SQL file)
     * @returns Promise<ResultSet> - Complete result set
     *
     * @example
     * ```typescript
     * // Execute query from file without parameters
     * // File: queries/get-all-active-users.sql
     * // Content: SELECT * FROM Users WHERE Status = 'active'
     * const users = await CSDBUtils.executeFromFile('MY_DB', 'queries/get-all-active-users.sql');
     *
     * // Execute query from file with parameters
     * // File: queries/get-user-by-id.sql
     * // Content: SELECT * FROM Users WHERE Id = ?
     * const user = await CSDBUtils.executeFromFile('MY_DB', 'queries/get-user-by-id.sql', [123]);
     *
     * // Execute query with multiple parameters
     * // File: queries/get-orders-by-date-range.sql
     * // Content: SELECT * FROM Orders WHERE OrderDate >= ? AND OrderDate <= ? AND Status = ?
     * const orders = await CSDBUtils.executeFromFile('MY_DB', 'queries/get-orders-by-date-range.sql', ['2024-01-01', '2024-12-31', 'completed']);
     * ```
     */
    public static async executeFromFile(alias: string, filePath: string, params?: any[]): Promise<ResultSet> {
        try {
            CSReporter.debug(`CSDBUtils.executeFromFile - File: ${filePath}, Alias: ${alias}`);

            const fs = await import('fs/promises');
            const path = await import('path');

            // Resolve the file path relative to project root
            const resolvedPath = path.resolve(process.cwd(), filePath);

            // Check if file exists
            try {
                await fs.access(resolvedPath);
            } catch {
                throw new Error(`SQL file not found: ${resolvedPath}`);
            }

            // Read the SQL content from file
            const sqlContent = await fs.readFile(resolvedPath, 'utf-8');

            if (!sqlContent || sqlContent.trim().length === 0) {
                throw new Error(`SQL file is empty: ${filePath}`);
            }

            CSReporter.debug(`CSDBUtils.executeFromFile - SQL loaded (${sqlContent.length} chars)`);

            // Split SQL into individual statements (handles multiple statements separated by ;)
            const statements = this.splitSqlStatements(sqlContent);

            if (statements.length === 0) {
                throw new Error(`No valid SQL statements found in file: ${filePath}`);
            }

            CSReporter.debug(`CSDBUtils.executeFromFile - Found ${statements.length} statement(s)`);

            // If single statement, execute directly with params
            if (statements.length === 1) {
                return await this.executeQuery(alias, statements[0], params);
            }

            // Multiple statements: execute sequentially
            // - Non-SELECT statements (ALTER, SET, etc.) execute without params
            // - Last SELECT statement uses the provided params
            // - Return the result of the last SELECT (or last statement if no SELECT)
            let lastSelectResult: ResultSet | null = null;
            let lastResult: ResultSet | null = null;

            for (let i = 0; i < statements.length; i++) {
                const stmt = statements[i];
                const isLastStatement = i === statements.length - 1;
                const isSelectStatement = stmt.trim().toUpperCase().startsWith('SELECT');

                CSReporter.debug(`CSDBUtils.executeFromFile - Executing statement ${i + 1}/${statements.length}: ${stmt.substring(0, 50)}...`);

                // Apply params only to SELECT statements or the last statement
                const stmtParams = (isSelectStatement || isLastStatement) ? params : undefined;

                try {
                    const result = await this.executeQuery(alias, stmt, stmtParams);
                    lastResult = result;

                    if (isSelectStatement) {
                        lastSelectResult = result;
                    }

                    CSReporter.debug(`CSDBUtils.executeFromFile - Statement ${i + 1} executed successfully (${result.rowCount} rows)`);
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    CSReporter.error(`CSDBUtils.executeFromFile - Statement ${i + 1} failed: ${errorMsg}`);
                    throw new Error(`Failed executing statement ${i + 1} in ${filePath}: ${errorMsg}`);
                }
            }

            // Return last SELECT result, or last result if no SELECT was found
            return lastSelectResult || lastResult!;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            CSReporter.error(`CSDBUtils.executeFromFile failed: ${errorMessage}`);
            throw error;
        }
    }

    /**
     * Split SQL content into individual statements
     * Handles semicolons inside strings and comments
     *
     * @param sql - Raw SQL content from file
     * @returns Array of individual SQL statements
     * @private
     */
    private static splitSqlStatements(sql: string): string[] {
        const statements: string[] = [];
        let currentStatement = '';
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inLineComment = false;
        let inBlockComment = false;

        for (let i = 0; i < sql.length; i++) {
            const char = sql[i];
            const nextChar = sql[i + 1] || '';
            const prevChar = sql[i - 1] || '';

            // Handle line comments (--)
            if (!inSingleQuote && !inDoubleQuote && !inBlockComment && char === '-' && nextChar === '-') {
                inLineComment = true;
            }
            if (inLineComment && (char === '\n' || char === '\r')) {
                inLineComment = false;
            }

            // Handle block comments (/* */)
            if (!inSingleQuote && !inDoubleQuote && !inLineComment && char === '/' && nextChar === '*') {
                inBlockComment = true;
            }
            if (inBlockComment && char === '*' && nextChar === '/') {
                inBlockComment = false;
                currentStatement += '*/';
                i++; // Skip the '/'
                continue;
            }

            // Handle single quotes (skip escaped quotes '')
            if (!inDoubleQuote && !inLineComment && !inBlockComment && char === "'") {
                if (nextChar === "'") {
                    // Escaped quote, add both and skip next
                    currentStatement += "''";
                    i++;
                    continue;
                }
                inSingleQuote = !inSingleQuote;
            }

            // Handle double quotes
            if (!inSingleQuote && !inLineComment && !inBlockComment && char === '"') {
                inDoubleQuote = !inDoubleQuote;
            }

            // Check for statement separator (;) outside of quotes and comments
            if (char === ';' && !inSingleQuote && !inDoubleQuote && !inLineComment && !inBlockComment) {
                const trimmed = currentStatement.trim();
                if (trimmed.length > 0) {
                    statements.push(trimmed);
                }
                currentStatement = '';
                continue;
            }

            currentStatement += char;
        }

        // Add the last statement if it exists (handles files without trailing semicolon)
        const lastTrimmed = currentStatement.trim();
        if (lastTrimmed.length > 0) {
            statements.push(lastTrimmed);
        }

        return statements;
    }

    /**
     * Execute a SQL query from a .sql file and return a single value
     *
     * @template T - Type of the value to return
     * @param alias - Database connection alias
     * @param filePath - Path to the .sql file
     * @param params - Optional query parameters
     * @returns Promise<T> - Single value of type T
     *
     * @example
     * ```typescript
     * // File: queries/count-active-users.sql
     * // Content: SELECT COUNT(*) FROM Users WHERE Status = 'active'
     * const count = await CSDBUtils.executeFromFileSingleValue<number>('MY_DB', 'queries/count-active-users.sql');
     * ```
     */
    public static async executeFromFileSingleValue<T = any>(alias: string, filePath: string, params?: any[]): Promise<T> {
        const result = await this.executeFromFile(alias, filePath, params);

        if (result.rowCount === 0) {
            throw new Error(`Query from file '${filePath}' returned no rows`);
        }

        const firstRow = result.rows[0];
        const firstColumnKey = Object.keys(firstRow)[0];
        return firstRow[firstColumnKey] as T;
    }

    /**
     * Execute a SQL query from a .sql file and return a single row
     *
     * @param alias - Database connection alias
     * @param filePath - Path to the .sql file
     * @param params - Optional query parameters
     * @returns Promise<Record<string, any>> - Single row as object
     *
     * @example
     * ```typescript
     * // File: queries/get-user-by-email.sql
     * // Content: SELECT * FROM Users WHERE Email = ?
     * const user = await CSDBUtils.executeFromFileSingleRow('MY_DB', 'queries/get-user-by-email.sql', ['john@example.com']);
     * ```
     */
    public static async executeFromFileSingleRow(alias: string, filePath: string, params?: any[]): Promise<Record<string, any>> {
        const result = await this.executeFromFile(alias, filePath, params);

        if (result.rowCount === 0) {
            throw new Error(`Query from file '${filePath}' returned no rows`);
        }

        return result.rows[0];
    }

    /**
     * Execute a query and return a single value from the first row, first column
     *
     * @template T - Type of the value to return
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param params - Optional query parameters
     * @returns Promise<T> - Single value of type T
     *
     * @example
     * ```typescript
     * // Get count
     * const count = await CSDBUtils.executeSingleValue<number>('MY_DB', 'SELECT COUNT(*) FROM users');
     *
     * // Get single name
     * const name = await CSDBUtils.executeSingleValue<string>('MY_DB', 'SELECT name FROM users WHERE id = ?', [123]);
     *
     * // Get boolean
     * const isActive = await CSDBUtils.executeSingleValue<boolean>('MY_DB', 'SELECT active_flag FROM users WHERE id = ?', [123]);
     * ```
     */
    public static async executeSingleValue<T = any>(alias: string, sql: string, params?: any[]): Promise<T> {
        try {
            CSReporter.debug(`CSDBUtils.executeSingleValue - Alias: ${alias}`);

            const result = await this.executeQuery(alias, sql, params);

            if (result.rowCount === 0) {
                throw new Error('Query returned no rows');
            }

            const firstRow = result.rows[0];
            const firstColumnKey = Object.keys(firstRow)[0];
            const value = firstRow[firstColumnKey];

            CSReporter.debug(`Single value retrieved: ${value}`);

            return value as T;
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeSingleValue failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute a query and return a single row as an object
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param params - Optional query parameters
     * @returns Promise<Record<string, any>> - Single row object with column names as keys
     *
     * @example
     * ```typescript
     * const user = await CSDBUtils.executeSingleRow('MY_DB', 'SELECT * FROM users WHERE id = ?', [123]);
     * console.log(user.id);          // 123
     * console.log(user.name);        // "John Doe"
     * console.log(user.email);       // "john@example.com"
     * ```
     */
    public static async executeSingleRow(alias: string, sql: string, params?: any[]): Promise<Record<string, any>> {
        try {
            CSReporter.debug(`CSDBUtils.executeSingleRow - Alias: ${alias}`);

            const result = await this.executeQuery(alias, sql, params);

            if (result.rowCount === 0) {
                throw new Error('Query returned no rows');
            }

            const row = result.rows[0];
            CSReporter.debug(`Single row retrieved with ${Object.keys(row).length} columns`);

            return row;
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeSingleRow failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute a query and return a single row, or null if no rows found
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param params - Optional query parameters
     * @returns Promise<Record<string, any> | null> - Single row object or null
     *
     * @example
     * ```typescript
     * const user = await CSDBUtils.executeSingleRowOrNull('MY_DB', 'SELECT * FROM users WHERE id = ?', [999]);
     * if (user) {
     *     console.log(user.name);
     * } else {
     *     console.log('User not found');
     * }
     * ```
     */
    public static async executeSingleRowOrNull(alias: string, sql: string, params?: any[]): Promise<Record<string, any> | null> {
        try {
            return await this.executeSingleRow(alias, sql, params);
        } catch (error) {
            if ((error as Error).message.includes('no rows')) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Check if a record exists (returns true if query returns at least one row)
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param params - Optional query parameters
     * @returns Promise<boolean> - True if at least one row exists
     *
     * @example
     * ```typescript
     * const exists = await CSDBUtils.exists('MY_DB', 'SELECT 1 FROM users WHERE email = ?', ['test@example.com']);
     * if (exists) {
     *     console.log('Email already registered');
     * }
     * ```
     */
    public static async exists(alias: string, sql: string, params?: any[]): Promise<boolean> {
        try {
            CSReporter.debug(`CSDBUtils.exists - Alias: ${alias}`);

            const result = await this.executeQuery(alias, sql, params);
            const exists = result.rowCount > 0;

            CSReporter.debug(`Record exists: ${exists}`);

            return exists;
        } catch (error) {
            CSReporter.error(`CSDBUtils.exists failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Get count from a query (extracts first numeric column value)
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key (should return a count)
     * @param params - Optional query parameters
     * @returns Promise<number> - Count value
     *
     * @example
     * ```typescript
     * // Direct count
     * const count = await CSDBUtils.count('MY_DB', 'SELECT COUNT(*) FROM users');
     *
     * // Count with condition
     * const activeCount = await CSDBUtils.count('MY_DB', 'SELECT COUNT(*) FROM users WHERE active = ?', [true]);
     *
     * // Named query: DB_QUERY_COUNT_ACTIVE_USERS=SELECT COUNT(*) as total FROM users WHERE active='Y'
     * const count = await CSDBUtils.count('MY_DB', 'COUNT_ACTIVE_USERS');
     * ```
     */
    public static async count(alias: string, sql: string, params?: any[]): Promise<number> {
        try {
            CSReporter.debug(`CSDBUtils.count - Alias: ${alias}`);

            const value = await this.executeSingleValue<number>(alias, sql, params);
            const count = Number(value);

            if (isNaN(count)) {
                throw new Error(`Count query returned non-numeric value: ${value}`);
            }

            CSReporter.debug(`Count retrieved: ${count}`);

            return count;
        } catch (error) {
            CSReporter.error(`CSDBUtils.count failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute multiple queries in a transaction
     *
     * @param alias - Database connection alias
     * @param queries - Array of {sql, params} objects
     * @returns Promise<ResultSet[]> - Array of result sets
     *
     * @example
     * ```typescript
     * const results = await CSDBUtils.executeTransaction('MY_DB', [
     *     { sql: 'INSERT INTO users (name, email) VALUES (?, ?)', params: ['John', 'john@example.com'] },
     *     { sql: 'INSERT INTO audit_log (action, user_id) VALUES (?, ?)', params: ['USER_CREATED', 123] }
     * ]);
     * ```
     */
    public static async executeTransaction(
        alias: string,
        queries: Array<{ sql: string; params?: any[] }>
    ): Promise<ResultSet[]> {
        const db = await this.getConnection(alias);
        const results: ResultSet[] = [];

        try {
            CSReporter.debug(`CSDBUtils.executeTransaction - Starting transaction with ${queries.length} queries`);

            await db.beginTransaction();

            for (const query of queries) {
                const resolvedSql = this.resolveQuery(alias, query.sql);
                const result = await db.query(resolvedSql, query.params);
                results.push(result);
            }

            await db.commitTransaction();

            CSReporter.debug('Transaction committed successfully');

            return results;
        } catch (error) {
            CSReporter.error(`Transaction failed: ${(error as Error).message}`);
            await db.rollbackTransaction();
            CSReporter.debug('Transaction rolled back');
            throw error;
        }
    }

    /**
     * Execute a query and extract a specific column as an array
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param columnName - Name of the column to extract
     * @param params - Optional query parameters
     * @returns Promise<any[]> - Array of column values
     *
     * @example
     * ```typescript
     * // Get all user IDs
     * const userIds = await CSDBUtils.extractColumn('MY_DB', 'SELECT id FROM users', 'id');
     * // Returns: [1, 2, 3, 4, 5]
     *
     * // Get all email addresses
     * const emails = await CSDBUtils.extractColumn('MY_DB', 'SELECT email FROM users WHERE active = ?', 'email', [true]);
     * // Returns: ['user1@example.com', 'user2@example.com', ...]
     * ```
     */
    public static async extractColumn<T = any>(
        alias: string,
        sql: string,
        columnName: string,
        params?: any[]
    ): Promise<T[]> {
        try {
            CSReporter.debug(`CSDBUtils.extractColumn - Column: ${columnName}`);

            const result = await this.executeQuery(alias, sql, params);

            if (result.rowCount === 0) {
                CSReporter.debug('No rows returned, returning empty array');
                return [];
            }

            // Verify column exists in first row
            const firstRow = result.rows[0];
            if (!(columnName in firstRow)) {
                throw new Error(`Column '${columnName}' not found in result set. Available columns: ${Object.keys(firstRow).join(', ')}`);
            }

            const values = result.rows.map(row => row[columnName] as T);

            CSReporter.debug(`Extracted ${values.length} values from column '${columnName}'`);

            return values;
        } catch (error) {
            CSReporter.error(`CSDBUtils.extractColumn failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute INSERT/UPDATE/DELETE query and return affected row count
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param params - Optional query parameters
     * @returns Promise<number> - Number of affected rows
     *
     * @example
     * ```typescript
     * const affectedRows = await CSDBUtils.executeUpdate('MY_DB',
     *     'UPDATE users SET active = ? WHERE last_login < ?',
     *     [false, '2023-01-01']
     * );
     * console.log(`Deactivated ${affectedRows} users`);
     * ```
     */
    public static async executeUpdate(alias: string, sql: string, params?: any[]): Promise<number> {
        try {
            CSReporter.debug(`CSDBUtils.executeUpdate - Alias: ${alias}`);

            const result = await this.executeQuery(alias, sql, params);
            const affectedRows = result.affectedRows || 0;

            CSReporter.debug(`Rows affected: ${affectedRows}`);

            return affectedRows;
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeUpdate failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Close a specific database connection
     *
     * @param alias - Database connection alias
     *
     * @example
     * ```typescript
     * await CSDBUtils.closeConnection('MY_DB');
     * ```
     */
    public static async closeConnection(alias: string): Promise<void> {
        try {
            CSReporter.debug(`CSDBUtils.closeConnection - Alias: ${alias}`);
            await this.dbManager.closeConnection(alias);
            CSReporter.debug(`Connection '${alias}' closed successfully`);
        } catch (error) {
            CSReporter.error(`Failed to close connection '${alias}': ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Close all database connections
     *
     * @example
     * ```typescript
     * // At the end of test suite
     * await CSDBUtils.closeAllConnections();
     * ```
     */
    public static async closeAllConnections(): Promise<void> {
        try {
            CSReporter.debug('CSDBUtils.closeAllConnections - Closing all connections');
            await this.dbManager.closeAllConnections();
            CSReporter.debug('All connections closed successfully');
        } catch (error) {
            CSReporter.error(`Failed to close all connections: ${(error as Error).message}`);
            throw error;
        }
    }

    // ============================================================================
    // ADVANCED UTILITY METHODS
    // ============================================================================

    /**
     * Execute a stored procedure with parameters
     *
     * @param alias - Database connection alias
     * @param procedureName - Name of the stored procedure
     * @param params - Optional parameters for the stored procedure
     * @returns Promise<ResultSet> - Result set from stored procedure
     *
     * @example
     * ```typescript
     * // SQL Server
     * const result = await CSDBUtils.executeStoredProcedure('MY_DB', 'sp_GetUsersByRole', ['admin']);
     *
     * // Oracle
     * const result = await CSDBUtils.executeStoredProcedure('MY_DB', 'pkg_users.get_by_role', ['admin']);
     *
     * // Named stored procedure from config (DB_QUERY_SP_GET_USERS)
     * const result = await CSDBUtils.executeStoredProcedure('MY_DB', 'SP_GET_USERS', []);
     * ```
     */
    public static async executeStoredProcedure(
        alias: string,
        procedureName: string,
        params?: any[]
    ): Promise<ResultSet> {
        try {
            CSReporter.debug(`CSDBUtils.executeStoredProcedure - Procedure: ${procedureName}`);

            const db = await this.getConnection(alias);
            const resolvedProc = this.resolveQuery(alias, procedureName);

            // Build CALL or EXEC statement based on database type
            const dbType = db.getType();
            let sql: string;

            if (dbType === 'oracle') {
                // Oracle: CALL or BEGIN...END
                const paramPlaceholders = params && params.length > 0
                    ? params.map(() => '?').join(', ')
                    : '';
                sql = `BEGIN ${resolvedProc}(${paramPlaceholders}); END;`;
            } else if (dbType === 'sqlserver') {
                // SQL Server: EXEC
                const paramPlaceholders = params && params.length > 0
                    ? params.map(() => '?').join(', ')
                    : '';
                sql = `EXEC ${resolvedProc} ${paramPlaceholders}`;
            } else {
                // MySQL/PostgreSQL: CALL
                const paramPlaceholders = params && params.length > 0
                    ? params.map(() => '?').join(', ')
                    : '';
                sql = `CALL ${resolvedProc}(${paramPlaceholders})`;
            }

            CSReporter.debug(`Executing stored procedure: ${sql}`);
            const result = await db.query(sql, params);

            CSReporter.debug(`Stored procedure executed successfully. Rows returned: ${result.rowCount}`);
            return result;
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeStoredProcedure failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute a query and return first N rows
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param limit - Number of rows to return
     * @param params - Optional query parameters
     * @returns Promise<Record<string, any>[]> - Array of row objects (limited)
     *
     * @example
     * ```typescript
     * // Get first 10 users
     * const users = await CSDBUtils.executeQueryLimit('MY_DB', 'SELECT * FROM users ORDER BY id', 10);
     *
     * // Get top 5 active users
     * const activeUsers = await CSDBUtils.executeQueryLimit('MY_DB',
     *     'SELECT * FROM users WHERE active = ? ORDER BY created_at DESC',
     *     5,
     *     [true]
     * );
     * ```
     */
    public static async executeQueryLimit(
        alias: string,
        sql: string,
        limit: number,
        params?: any[]
    ): Promise<Record<string, any>[]> {
        try {
            CSReporter.debug(`CSDBUtils.executeQueryLimit - Limit: ${limit}`);

            const result = await this.executeQuery(alias, sql, params);
            const limitedRows = result.rows.slice(0, limit);

            CSReporter.debug(`Returned ${limitedRows.length} rows (limit: ${limit})`);
            return limitedRows;
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeQueryLimit failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute a query and return a single column as an array
     * (Automatically detects first column if column name not specified)
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param params - Optional query parameters
     * @param columnName - Optional column name (uses first column if not specified)
     * @returns Promise<T[]> - Array of column values
     *
     * @example
     * ```typescript
     * // Get all user IDs (using first column automatically)
     * const ids = await CSDBUtils.getColumnList<number>('MY_DB', 'SELECT id FROM users');
     *
     * // Get all emails from multi-column query
     * const emails = await CSDBUtils.getColumnList<string>(
     *     'MY_DB',
     *     'SELECT id, email, name FROM users WHERE active = ?',
     *     [true],
     *     'email'
     * );
     * ```
     */
    public static async getColumnList<T = any>(
        alias: string,
        sql: string,
        params?: any[],
        columnName?: string
    ): Promise<T[]> {
        try {
            const result = await this.executeQuery(alias, sql, params);

            if (result.rowCount === 0) {
                return [];
            }

            // Use specified column or first column
            const firstRow = result.rows[0];
            const targetColumn = columnName || Object.keys(firstRow)[0];

            if (!(targetColumn in firstRow)) {
                throw new Error(`Column '${targetColumn}' not found in result set. Available: ${Object.keys(firstRow).join(', ')}`);
            }

            const values = result.rows.map(row => row[targetColumn] as T);
            CSReporter.debug(`Extracted ${values.length} values from column '${targetColumn}'`);

            return values;
        } catch (error) {
            CSReporter.error(`CSDBUtils.getColumnList failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute a query and return a Map with specified key and value columns
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param keyColumn - Column name to use as map key
     * @param valueColumn - Column name to use as map value
     * @param params - Optional query parameters
     * @returns Promise<Map<K, V>> - Map of key-value pairs
     *
     * @example
     * ```typescript
     * // Create map of user ID to name
     * const userMap = await CSDBUtils.getMap<number, string>(
     *     'MY_DB',
     *     'SELECT id, name FROM users',
     *     'id',
     *     'name'
     * );
     * console.log(userMap.get(123)); // "John Doe"
     *
     * // Create map of email to user object
     * const emailMap = await CSDBUtils.getMap<string, any>(
     *     'MY_DB',
     *     'SELECT email, id, name, role FROM users WHERE active = ?',
     *     'email',
     *     '*',  // '*' means entire row object
     *     [true]
     * );
     * ```
     */
    public static async getMap<K = any, V = any>(
        alias: string,
        sql: string,
        keyColumn: string,
        valueColumn: string,
        params?: any[]
    ): Promise<Map<K, V>> {
        try {
            CSReporter.debug(`CSDBUtils.getMap - Key: ${keyColumn}, Value: ${valueColumn}`);

            const result = await this.executeQuery(alias, sql, params);
            const map = new Map<K, V>();

            if (result.rowCount === 0) {
                return map;
            }

            for (const row of result.rows) {
                if (!(keyColumn in row)) {
                    throw new Error(`Key column '${keyColumn}' not found in result set`);
                }

                const key = row[keyColumn] as K;

                // Special case: '*' means entire row object
                if (valueColumn === '*') {
                    map.set(key, row as V);
                } else {
                    if (!(valueColumn in row)) {
                        throw new Error(`Value column '${valueColumn}' not found in result set`);
                    }
                    map.set(key, row[valueColumn] as V);
                }
            }

            CSReporter.debug(`Created map with ${map.size} entries`);
            return map;
        } catch (error) {
            CSReporter.error(`CSDBUtils.getMap failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute query and return rows as a Map grouped by a specific column
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param groupByColumn - Column name to group by
     * @param params - Optional query parameters
     * @returns Promise<Map<K, Record<string, any>[]>> - Map with grouped rows
     *
     * @example
     * ```typescript
     * // Group users by role
     * const usersByRole = await CSDBUtils.getGroupedMap<string>(
     *     'MY_DB',
     *     'SELECT role, id, name, email FROM users',
     *     'role'
     * );
     * console.log(usersByRole.get('admin')); // Array of admin users
     * console.log(usersByRole.get('user'));  // Array of regular users
     * ```
     */
    public static async getGroupedMap<K = any>(
        alias: string,
        sql: string,
        groupByColumn: string,
        params?: any[]
    ): Promise<Map<K, Record<string, any>[]>> {
        try {
            CSReporter.debug(`CSDBUtils.getGroupedMap - Group By: ${groupByColumn}`);

            const result = await this.executeQuery(alias, sql, params);
            const groupedMap = new Map<K, Record<string, any>[]>();

            for (const row of result.rows) {
                if (!(groupByColumn in row)) {
                    throw new Error(`Group column '${groupByColumn}' not found in result set`);
                }

                const key = row[groupByColumn] as K;

                if (!groupedMap.has(key)) {
                    groupedMap.set(key, []);
                }

                groupedMap.get(key)!.push(row);
            }

            CSReporter.debug(`Created grouped map with ${groupedMap.size} groups`);
            return groupedMap;
        } catch (error) {
            CSReporter.error(`CSDBUtils.getGroupedMap failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute query and get single value, or return default value if no rows
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string or named query key
     * @param defaultValue - Default value to return if no rows found
     * @param params - Optional query parameters
     * @returns Promise<T> - Single value or default
     *
     * @example
     * ```typescript
     * // Get count with default
     * const count = await CSDBUtils.getSingleValueOrDefault<number>(
     *     'MY_DB',
     *     'SELECT COUNT(*) FROM users WHERE deleted = ?',
     *     0,  // default value
     *     [true]
     * );
     * ```
     */
    public static async getSingleValueOrDefault<T = any>(
        alias: string,
        sql: string,
        defaultValue: T,
        params?: any[]
    ): Promise<T> {
        try {
            return await this.executeSingleValue<T>(alias, sql, params);
        } catch (error) {
            if ((error as Error).message.includes('no rows')) {
                CSReporter.debug(`No rows returned, using default value: ${defaultValue}`);
                return defaultValue;
            }
            throw error;
        }
    }

    /**
     * Batch execute multiple queries (not in transaction - independent queries)
     *
     * @param alias - Database connection alias
     * @param queries - Array of {sql, params} objects
     * @returns Promise<ResultSet[]> - Array of result sets
     *
     * @example
     * ```typescript
     * const results = await CSDBUtils.batchExecute('MY_DB', [
     *     { sql: 'SELECT COUNT(*) FROM users' },
     *     { sql: 'SELECT COUNT(*) FROM orders' },
     *     { sql: 'SELECT COUNT(*) FROM products WHERE active = ?', params: [true] }
     * ]);
     * ```
     */
    public static async batchExecute(
        alias: string,
        queries: Array<{ sql: string; params?: any[] }>
    ): Promise<ResultSet[]> {
        try {
            CSReporter.debug(`CSDBUtils.batchExecute - Executing ${queries.length} queries`);

            const results: ResultSet[] = [];

            for (const query of queries) {
                const result = await this.executeQuery(alias, query.sql, query.params);
                results.push(result);
            }

            CSReporter.debug(`Batch execution completed: ${results.length} queries executed`);
            return results;
        } catch (error) {
            CSReporter.error(`CSDBUtils.batchExecute failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute query with pagination support
     *
     * @param alias - Database connection alias
     * @param sql - SQL query string (should have ORDER BY for consistent pagination)
     * @param page - Page number (1-based)
     * @param pageSize - Number of rows per page
     * @param params - Optional query parameters
     * @returns Promise<{rows: Record<string, any>[], total: number, page: number, pageSize: number, totalPages: number}>
     *
     * @example
     * ```typescript
     * // Get page 2 with 20 items per page
     * const result = await CSDBUtils.executePaginated(
     *     'MY_DB',
     *     'SELECT * FROM users ORDER BY created_at DESC',
     *     2,    // page
     *     20    // pageSize
     * );
     * console.log(result.rows);        // 20 rows for page 2
     * console.log(result.total);       // Total row count
     * console.log(result.totalPages);  // Total pages
     * ```
     */
    public static async executePaginated(
        alias: string,
        sql: string,
        page: number = 1,
        pageSize: number = 10,
        params?: any[]
    ): Promise<{
        rows: Record<string, any>[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
    }> {
        try {
            CSReporter.debug(`CSDBUtils.executePaginated - Page: ${page}, Size: ${pageSize}`);

            // Get total count first
            const countSql = `SELECT COUNT(*) as total FROM (${sql}) as temp_count`;
            const countResult = await this.executeQuery(alias, countSql, params);
            const total = Number(countResult.rows[0].total || countResult.rows[0].TOTAL);

            // Calculate offset
            const offset = (page - 1) * pageSize;

            // Get paginated data
            const db = await this.getConnection(alias);
            const dbType = db.getType();

            let paginatedSql: string;
            if (dbType === 'oracle') {
                // Oracle pagination
                paginatedSql = `SELECT * FROM (SELECT a.*, ROWNUM rnum FROM (${sql}) a WHERE ROWNUM <= ${offset + pageSize}) WHERE rnum > ${offset}`;
            } else if (dbType === 'sqlserver') {
                // SQL Server pagination (requires ORDER BY)
                paginatedSql = `${sql} OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
            } else {
                // MySQL/PostgreSQL pagination
                paginatedSql = `${sql} LIMIT ${pageSize} OFFSET ${offset}`;
            }

            const result = await this.executeQuery(alias, paginatedSql, params);
            const totalPages = Math.ceil(total / pageSize);

            CSReporter.debug(`Retrieved page ${page}/${totalPages} (${result.rowCount} rows)`);

            return {
                rows: result.rows,
                total,
                page,
                pageSize,
                totalPages
            };
        } catch (error) {
            CSReporter.error(`CSDBUtils.executePaginated failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute INSERT and return generated ID (auto-increment/sequence value)
     *
     * @param alias - Database connection alias
     * @param sql - INSERT SQL statement or named query key
     * @param params - Optional query parameters
     * @returns Promise<number> - Generated ID
     *
     * @example
     * ```typescript
     * const newId = await CSDBUtils.executeInsertAndGetId(
     *     'MY_DB',
     *     'INSERT INTO users (name, email) VALUES (?, ?)',
     *     ['John Doe', 'john@example.com']
     * );
     * console.log(`New user ID: ${newId}`);
     * ```
     */
    public static async executeInsertAndGetId(
        alias: string,
        sql: string,
        params?: any[]
    ): Promise<number> {
        try {
            CSReporter.debug(`CSDBUtils.executeInsertAndGetId`);

            const db = await this.getConnection(alias);
            const resolvedSql = this.resolveQuery(alias, sql);

            const result = await db.query(resolvedSql, params);

            // Try to get inserted ID from different result formats
            const insertId = (result as any).insertId || (result as any).lastInsertId || result.rows?.[0]?.id || result.rows?.[0]?.ID;

            if (insertId === undefined) {
                throw new Error('Could not retrieve generated ID from INSERT statement');
            }

            CSReporter.debug(`Insert successful, generated ID: ${insertId}`);
            return Number(insertId);
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeInsertAndGetId failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Execute UPSERT (INSERT or UPDATE if exists)
     *
     * @param alias - Database connection alias
     * @param tableName - Table name
     * @param data - Data object with column names as keys
     * @param conflictColumn - Column to check for conflicts (e.g., 'id' or 'email')
     * @returns Promise<number> - Affected rows
     *
     * @example
     * ```typescript
     * // Will INSERT if email doesn't exist, UPDATE if it does
     * const affected = await CSDBUtils.executeUpsert(
     *     'MY_DB',
     *     'users',
     *     { email: 'john@example.com', name: 'John Updated', age: 31 },
     *     'email'
     * );
     * ```
     */
    public static async executeUpsert(
        alias: string,
        tableName: string,
        data: Record<string, any>,
        conflictColumn: string
    ): Promise<number> {
        try {
            CSReporter.debug(`CSDBUtils.executeUpsert - Table: ${tableName}, Conflict: ${conflictColumn}`);

            const db = await this.getConnection(alias);
            const dbType = db.getType();

            const columns = Object.keys(data);
            const values = Object.values(data);
            const placeholders = columns.map(() => '?');

            let sql: string;

            if (dbType === 'mysql') {
                // MySQL/MariaDB UPSERT
                const updateSet = columns
                    .filter(col => col !== conflictColumn)
                    .map(col => `${col} = VALUES(${col})`)
                    .join(', ');
                sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON DUPLICATE KEY UPDATE ${updateSet}`;
            } else if (dbType === 'postgresql') {
                // PostgreSQL UPSERT
                const updateSet = columns
                    .filter(col => col !== conflictColumn)
                    .map((col, idx) => `${col} = $${idx + 1}`)
                    .join(', ');
                sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updateSet}`;
            } else if (dbType === 'sqlserver') {
                // SQL Server MERGE
                const updateSet = columns
                    .filter(col => col !== conflictColumn)
                    .map(col => `target.${col} = source.${col}`)
                    .join(', ');
                const insertCols = columns.join(', ');
                const insertVals = columns.map(col => `source.${col}`).join(', ');
                sql = `MERGE INTO ${tableName} AS target USING (SELECT ${placeholders.map((p, i) => `? AS ${columns[i]}`).join(', ')}) AS source ON target.${conflictColumn} = source.${conflictColumn} WHEN MATCHED THEN UPDATE SET ${updateSet} WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals});`;
            } else {
                throw new Error(`UPSERT not supported for database type: ${dbType}`);
            }

            const result = await db.query(sql, values);
            const affected = result.affectedRows || 0;

            CSReporter.debug(`Upsert completed: ${affected} rows affected`);
            return affected;
        } catch (error) {
            CSReporter.error(`CSDBUtils.executeUpsert failed: ${(error as Error).message}`);
            throw error;
        }
    }
}

export default CSDBUtils;
