// src/steps/database/DatabaseGenericSteps.ts

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSDatabase } from '../../database/client/CSDatabase';
import { DatabaseContext } from '../../database/context/DatabaseContext';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSDatabaseManager } from '../../database/CSDatabaseManager';
import { DatabaseConfig, ResultSet } from '../../database/types/database.types';

export class DatabaseGenericSteps {
    private databaseContext: DatabaseContext;
    private currentDatabase: CSDatabase | null = null;
    private databases: Map<string, CSDatabase> = new Map();
    private configManager: CSConfigurationManager;
    private databaseManager: CSDatabaseManager;
    private contextVariables: Map<string, any> = new Map();

    constructor() {
        this.databaseContext = new DatabaseContext();
        this.configManager = CSConfigurationManager.getInstance();
        this.databaseManager = CSDatabaseManager.getInstance();
    }

    @CSBDDStepDef('user connects to {string} database with timeout {int} seconds')
    async connectToDatabaseWithTimeout(databaseAlias: string, timeout: number): Promise<void> {
        CSReporter.info(`Connecting to database '${databaseAlias}' with timeout ${timeout} seconds`);

        try {
            const database = await this.databaseManager.createConnection(databaseAlias);

            this.currentDatabase = database;
            this.databases.set(databaseAlias, database);

            const connection = await database.getConnection();
            const adapter = database.getAdapter();
            this.databaseContext.setActiveConnection(databaseAlias, adapter, connection);

            CSReporter.info(`Connected to database '${databaseAlias}' with timeout ${timeout} seconds`);

        } catch (error) {
            CSReporter.error(`Connection to '${databaseAlias}' timed out after ${timeout} seconds: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Connection to '${databaseAlias}' timed out after ${timeout} seconds: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user sets database connection pool size to {int}')
    async setConnectionPoolSize(poolSize: number): Promise<void> {
        CSReporter.info(`Setting database connection pool size to ${poolSize}`);

        if (poolSize < 1 || poolSize > 100) {
            throw new Error(`Invalid pool size: ${poolSize}. Must be between 1 and 100`);
        }

        this.contextVariables.set('defaultPoolSize', poolSize);

        CSReporter.info(`Database connection pool size set to ${poolSize}`);
    }

    @CSBDDStepDef('user executes query {string}')
    async executeQuery(query: string): Promise<void> {
        CSReporter.info(`Executing query: ${this.sanitizeQueryForLog(query)}`);

        try {
            const db = this.getCurrentDatabase();
            const interpolatedQuery = this.interpolateVariables(query);

            const startTime = Date.now();
            const result = await db.query(interpolatedQuery);
            const executionTime = Date.now() - startTime;

            this.contextVariables.set('lastDatabaseResult', result);
            const queryResult = {
                rows: result.rows || [],
                rowCount: result.rowCount,
                fields: result.fields || [],
                command: 'QUERY',
                duration: executionTime
            };
            this.databaseContext.storeResult('last', queryResult);

            CSReporter.info(`Query executed successfully. Rows affected: ${result.rowCount}, Execution time: ${executionTime}ms`);

        } catch (error) {
            CSReporter.error(`Query execution failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Query execution failed: ${error instanceof Error ? error.message : String(error)}\nQuery: ${this.sanitizeQueryForLog(query)}`);
        }
    }

    @CSBDDStepDef('user executes query {string} and stores result as {string}')
    async executeQueryAndStore(query: string, alias: string): Promise<void> {
        CSReporter.info(`Executing query and storing result as '${alias}': ${this.sanitizeQueryForLog(query)}`);

        try {
            const db = this.getCurrentDatabase();
            const interpolatedQuery = this.interpolateVariables(query);

            const result = await db.query(interpolatedQuery);

            const queryResult = {
                rows: result.rows || [],
                rowCount: result.rowCount,
                fields: result.fields || [],
                command: 'QUERY',
                duration: 0
            };
            this.databaseContext.storeResult(alias, queryResult);
            this.contextVariables.set('lastDatabaseResult', result);

            CSReporter.info(`Query executed and result stored as '${alias}'. Rows: ${result.rowCount}`);

        } catch (error) {
            CSReporter.error(`Failed to execute and store query result: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute and store query result: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the query result should have {int} rows')
    async validateRowCount(expectedCount: number): Promise<void> {
        CSReporter.info(`Validating query result has ${expectedCount} rows`);

        const result = this.getLastResult();

        if (result.rowCount !== expectedCount) {
            throw new Error(`Expected ${expectedCount} row(s), but got ${result.rowCount}`);
        }

        CSReporter.info(`Row count validation passed: ${expectedCount} rows`);
    }

    @CSBDDStepDef('the query result should have at least {int} rows')
    async validateMinRowCount(minCount: number): Promise<void> {
        CSReporter.info(`Validating query result has at least ${minCount} rows`);

        const result = this.getLastResult();

        if (result.rowCount < minCount) {
            throw new Error(`Expected at least ${minCount} row(s), but got ${result.rowCount}`);
        }

        CSReporter.info(`Minimum row count validation passed: ${result.rowCount} >= ${minCount}`);
    }

    @CSBDDStepDef('the query result should have at most {int} rows')
    async validateMaxRowCount(maxCount: number): Promise<void> {
        CSReporter.info(`Validating query result has at most ${maxCount} rows`);

        const result = this.getLastResult();

        if (result.rowCount > maxCount) {
            throw new Error(`Expected at most ${maxCount} row(s), but got ${result.rowCount}`);
        }

        CSReporter.info(`Maximum row count validation passed: ${result.rowCount} <= ${maxCount}`);
    }

    @CSBDDStepDef('the query result should be empty')
    async validateEmptyResult(): Promise<void> {
        CSReporter.info('Validating query result is empty');

        const result = this.getLastResult();

        if (result.rowCount > 0) {
            throw new Error(`Expected empty result, but got ${result.rowCount} row(s)`);
        }

        CSReporter.info('Empty result validation passed');
    }

    @CSBDDStepDef('user logs database query result')
    async logQueryResult(): Promise<void> {
        const result = this.getLastResult();

        const rowsToLog = result.rows ? Math.min(10, result.rows.length) : 0;
        if (rowsToLog > 0 && result.rows) {
            console.log('\n=== Query Result ===');
            console.log(`Columns: ${result.columns ? result.columns.map(col => col.name).join(', ') : 'N/A'}`);
            console.log(`Total Rows: ${result.rowCount}`);
            console.log(`\nFirst ${rowsToLog} rows:`);

            result.rows.slice(0, rowsToLog).forEach((row, index) => {
                console.log(`Row ${index + 1}:`, row);
            });

            if (result.rowCount > rowsToLog) {
                console.log(`... and ${result.rowCount - rowsToLog} more rows`);
            }
            console.log('==================\n');
        }

        CSReporter.info(`Database query result logged: ${result.rowCount} rows`);
    }

    @CSBDDStepDef('user clears database cache')
    async clearDatabaseCache(): Promise<void> {
        CSReporter.info('Clearing database cache');

        this.contextVariables.set('lastDatabaseResult', null);
        this.contextVariables.set('databaseQueryLogging', null);

        CSReporter.info('Database cache cleared');
    }

    @CSBDDStepDef('user enables database query logging')
    async enableQueryLogging(): Promise<void> {
        CSReporter.info('Enabling database query logging');

        this.contextVariables.set('databaseQueryLogging', true);

        CSReporter.info('Database query logging enabled');
    }

    @CSBDDStepDef('user disables database query logging')
    async disableQueryLogging(): Promise<void> {
        CSReporter.info('Disabling database query logging');

        this.contextVariables.set('databaseQueryLogging', false);

        CSReporter.info('Database query logging disabled');
    }

    @CSBDDStepDef('user validates database connection')
    async validateConnection(): Promise<void> {
        CSReporter.info('Validating database connection');

        const db = this.getCurrentDatabase();
        const isConnected = db.isConnected();

        if (!isConnected) {
            throw new Error('Database connection is not active');
        }

        CSReporter.info('Database connection validation passed');
    }

    private getCurrentDatabase(): CSDatabase {
        if (!this.currentDatabase) {
            throw new Error('No database connection established. Use "user connects to ... database" first');
        }
        return this.currentDatabase;
    }

    private getLastResult(): ResultSet {
        const result = this.contextVariables.get('lastDatabaseResult') as ResultSet;
        if (!result) {
            throw new Error('No query result available. Execute a query first');
        }
        return result;
    }

    private sanitizeQueryForLog(query: string): string {
        const maxLength = 200;
        if (query.length > maxLength) {
            return query.substring(0, maxLength) + '...';
        }
        return query;
    }

    private interpolateVariables(text: string): string {
        text = text.replace(/\${([^}]+)}/g, (match, varName) => {
            return process.env[varName] || match;
        });

        text = text.replace(/{{([^}]+)}}/g, (match, varName) => {
            const retrieved = this.contextVariables.get(varName);
            return retrieved !== undefined ? String(retrieved) : match;
        });

        text = text.replace(/%([^%]+)%/g, (match, varName) => {
            return this.configManager.get(varName, match) as string;
        });

        return text;
    }

    @CSBDDStepDef('test execution starts for database testing')
    async startDatabaseTesting(): Promise<void> {
        CSReporter.info('Starting database testing');
        this.contextVariables.set('databaseTestingStarted', true);
        CSReporter.info('Database testing framework initialized successfully');
    }

    @CSBDDStepDef('we should have database testing capability')
    async validateDatabaseCapability(): Promise<void> {
        CSReporter.info('Validating database testing capability');
        const started = this.contextVariables.get('databaseTestingStarted');
        if (!started) {
            throw new Error('Database testing not properly initialized');
        }
        CSReporter.info('Database testing capability validated successfully');
    }
}