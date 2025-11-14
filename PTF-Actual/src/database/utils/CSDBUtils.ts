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
        // If it looks like a SQL query (contains spaces or keywords), return as-is
        if (sqlOrQueryKey.toLowerCase().includes('select') ||
            sqlOrQueryKey.toLowerCase().includes('insert') ||
            sqlOrQueryKey.toLowerCase().includes('update') ||
            sqlOrQueryKey.toLowerCase().includes('delete') ||
            sqlOrQueryKey.includes(' ')) {
            return sqlOrQueryKey;
        }

        // Otherwise, try to fetch from config
        const queryKey = `DB_QUERY_${sqlOrQueryKey.toUpperCase()}`;
        const query = this.config.get(queryKey);

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

            const db = await this.getConnection(alias);
            const resolvedSql = this.resolveQuery(alias, sql);

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
}

export default CSDBUtils;
