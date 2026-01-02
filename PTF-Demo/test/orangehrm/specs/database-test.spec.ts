/**
 * Database Test - Spec Format
 * Basic database connection and query tests
 *
 * Uses:
 * - CSDatabaseManager from fixtures (db)
 * - CSExpect/CSAssert for assertions
 * - Framework database module (NOT raw database drivers)
 */

import { describe, test, afterEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

describe('Simple Database Tests', {
    tags: '@database @simple'
}, () => {

    // Track database connection for cleanup
    let currentDbName: string | null = null;

    // Cleanup: disconnect from database after each test
    afterEach(async ({ db, reporter }) => {
        if (currentDbName && db) {
            try {
                await db.disconnect(currentDbName);
                reporter.info(`Disconnected from ${currentDbName} database`);
                currentDbName = null;
            } catch (error) {
                reporter.warn(`Cleanup: Could not disconnect from database: ${error}`);
            }
        }
    });

    // MySQL Connection Test
    test('Simple MySQL Connection Test', {
        tags: '@mysql'
    }, async ({ db, reporter, expect }) => {
        // db is CSDatabaseManager from fixtures

        // Connect to database using framework's database manager
        currentDbName = 'PRACTICE_MYSQL';
        await db.connect(currentDbName);
        reporter.pass(`Connected to ${currentDbName} database`);

        // Validate connection using framework method
        const isConnected = await db.isConnected(currentDbName);
        expect.toEqual(isConnected, true);
        reporter.pass('Database connection validated');

        // Execute query using framework's query method
        const result = await db.query(currentDbName, 'SELECT COUNT(*) as count FROM employees');
        reporter.info(`Query result: ${JSON.stringify(result)}`);

        // Validate result using CSExpect
        expect.toBeGreaterThan(result.length, 0);
        reporter.pass('Query returned results');

        // Disconnect using framework method
        await db.disconnect(currentDbName);
        reporter.pass(`Disconnected from ${currentDbName} database`);
        currentDbName = null;
    });

    // Oracle Connection Test
    test('Simple Oracle Connection Test', {
        tags: '@oracle'
    }, async ({ db, reporter, expect }) => {
        // Connect to database
        currentDbName = 'PRACTICE_ORACLE';
        await db.connect(currentDbName);
        reporter.pass(`Connected to ${currentDbName} database`);

        // Validate connection
        const isConnected = await db.isConnected(currentDbName);
        expect.toEqual(isConnected, true);
        reporter.pass('Database connection validated');

        // Execute query
        const result = await db.query(currentDbName, 'SELECT COUNT(*) as count FROM employees');
        reporter.info(`Query result: ${JSON.stringify(result)}`);

        // Validate result
        expect.toBeGreaterThan(result.length, 0);
        reporter.pass('Query returned results');

        // Disconnect
        await db.disconnect(currentDbName);
        reporter.pass(`Disconnected from ${currentDbName} database`);
        currentDbName = null;
    });

    // SQL Server Connection Test
    test('Simple SQL Server Connection Test', {
        tags: '@sqlserver @mssql'
    }, async ({ db, reporter, expect }) => {
        // Connect to database
        currentDbName = 'PRACTICE_SQLSERVER';
        await db.connect(currentDbName);
        reporter.pass(`Connected to ${currentDbName} database`);

        // Validate connection
        const isConnected = await db.isConnected(currentDbName);
        expect.toEqual(isConnected, true);
        reporter.pass('Database connection validated');

        // Execute query
        const result = await db.query(currentDbName, 'SELECT COUNT(*) as count FROM employees');
        reporter.info(`Query result: ${JSON.stringify(result)}`);

        // Validate result
        expect.toBeGreaterThan(result.length, 0);
        reporter.pass('Query returned results');

        // Disconnect
        await db.disconnect(currentDbName);
        reporter.pass(`Disconnected from ${currentDbName} database`);
        currentDbName = null;
    });

    // PostgreSQL Connection Test
    test('Simple PostgreSQL Connection Test', {
        tags: '@postgresql @postgres'
    }, async ({ db, reporter, expect }) => {
        // Connect to database
        currentDbName = 'PRACTICE_POSTGRESQL';
        await db.connect(currentDbName);
        reporter.pass(`Connected to ${currentDbName} database`);

        // Validate connection
        const isConnected = await db.isConnected(currentDbName);
        expect.toEqual(isConnected, true);
        reporter.pass('Database connection validated');

        // Execute query
        const result = await db.query(currentDbName, 'SELECT COUNT(*) as count FROM employees');
        reporter.info(`Query result: ${JSON.stringify(result)}`);

        // Validate result
        expect.toBeGreaterThan(result.length, 0);
        reporter.pass('Query returned results');

        // Disconnect
        await db.disconnect(currentDbName);
        reporter.pass(`Disconnected from ${currentDbName} database`);
        currentDbName = null;
    });
});

// Advanced Database Tests
describe('Advanced Database Operations', {
    tags: '@database @advanced'
}, () => {

    test('Execute parameterized query', {
        tags: '@parameterized'
    }, async ({ db, reporter, expect }) => {
        // Connect using framework's database manager
        await db.connect('PRACTICE_MYSQL');

        // Execute parameterized query using framework method
        const result = await db.query(
            'PRACTICE_MYSQL',
            'SELECT * FROM employees WHERE department = ?',
            ['Engineering']
        );

        reporter.info(`Found ${result.length} employees in Engineering`);
        expect.toBeGreaterThanOrEqual(result.length, 0);
        reporter.pass('Parameterized query executed successfully');

        // Disconnect
        await db.disconnect('PRACTICE_MYSQL');
    });

    test('Transaction rollback on error', {
        tags: '@transaction @rollback'
    }, async ({ db, reporter, expect }) => {
        // Connect
        await db.connect('PRACTICE_MYSQL');

        try {
            // Start transaction using framework method
            await db.beginTransaction('PRACTICE_MYSQL');
            reporter.info('Transaction started');

            // Get initial count
            const beforeResult = await db.query('PRACTICE_MYSQL', 'SELECT COUNT(*) as count FROM test_table');
            const initialCount = beforeResult[0]?.count || 0;

            // Insert a record
            await db.query('PRACTICE_MYSQL', 'INSERT INTO test_table (name) VALUES (?)', ['Test Entry']);

            // Rollback using framework method
            await db.rollback('PRACTICE_MYSQL');
            reporter.info('Transaction rolled back');

            // Verify count unchanged
            const afterResult = await db.query('PRACTICE_MYSQL', 'SELECT COUNT(*) as count FROM test_table');
            const finalCount = afterResult[0]?.count || 0;

            expect.toEqual(finalCount, initialCount);
            reporter.pass('Rollback successful - count unchanged');

        } finally {
            await db.disconnect('PRACTICE_MYSQL');
        }
    });

    test('Validate query result against expected values', {
        tags: '@validation'
    }, async ({ db, reporter, expect }) => {
        // Connect
        await db.connect('PRACTICE_MYSQL');

        // Execute query
        const result = await db.query(
            'PRACTICE_MYSQL',
            'SELECT name, email FROM users WHERE id = ?',
            [1]
        );

        // Validate result using CSExpect
        expect.toBeGreaterThan(result.length, 0);

        const user = result[0];
        expect.toBeDefined(user.name);
        expect.toBeDefined(user.email);
        expect.toContain(user.email, '@');
        reporter.pass('Query result validated successfully');

        // Disconnect
        await db.disconnect('PRACTICE_MYSQL');
    });
});
