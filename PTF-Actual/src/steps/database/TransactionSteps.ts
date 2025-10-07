// src/steps/database/TransactionSteps.ts

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { DatabaseContext } from '../../database/context/DatabaseContext';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { Transaction } from '../../database/types/database.types';

export class TransactionSteps {
    private databaseContext: DatabaseContext = new DatabaseContext();
    private configManager: CSConfigurationManager;
    private contextVariables: Map<string, any> = new Map();
    private activeTransaction: Transaction | null = null;
    private transactionStartTime: Date | null = null;
    private savepoints: string[] = [];

    constructor() {
        this.configManager = CSConfigurationManager.getInstance();
    }

    @CSBDDStepDef('user begins database transaction')
    async beginTransaction(): Promise<void> {
        CSReporter.info('Beginning database transaction');

        try {
            if (this.activeTransaction) {
                throw new Error('A transaction is already active. Commit or rollback before starting a new one');
            }

            const adapter = this.databaseContext.getActiveAdapter();
            const connection = this.getActiveConnection();
            await adapter.beginTransaction(connection);

            this.activeTransaction = {
                id: `txn_${Date.now()}`,
                startTime: new Date(),
                connection,
                status: 'active',
                savepoints: []
            };
            this.transactionStartTime = new Date();

            CSReporter.info(`Database transaction started with ID: ${this.activeTransaction.id}`);

        } catch (error) {
            CSReporter.error(`Failed to begin transaction: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to begin transaction: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user begins database transaction with isolation level {string}')
    async beginTransactionWithIsolation(isolationLevel: string): Promise<void> {
        CSReporter.info(`Beginning database transaction with isolation level: ${isolationLevel}`);

        try {
            if (this.activeTransaction) {
                throw new Error('A transaction is already active');
            }

            const validLevels = ['READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'];
            const upperLevel = isolationLevel.toUpperCase().replace(/ /g, '_');

            if (!validLevels.includes(upperLevel)) {
                throw new Error(
                    `Invalid isolation level: ${isolationLevel}. ` +
                    `Valid levels: ${validLevels.join(', ')}`
                );
            }

            const adapter = this.databaseContext.getActiveAdapter();
            const connection = this.getActiveConnection();

            const options = {
                isolationLevel: upperLevel as any
            };

            await adapter.beginTransaction(connection, options);

            this.activeTransaction = {
                id: `txn_${Date.now()}`,
                isolationLevel: upperLevel,
                startTime: new Date(),
                connection,
                status: 'active',
                savepoints: []
            };
            this.transactionStartTime = new Date();

            CSReporter.info(`Database transaction started with ID: ${this.activeTransaction.id}, Isolation: ${upperLevel}`);

        } catch (error) {
            CSReporter.error(`Failed to begin transaction with isolation level: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to begin transaction with isolation level: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user commits database transaction')
    async commitTransaction(): Promise<void> {
        CSReporter.info('Committing database transaction');

        try {
            const transaction = this.getActiveTransaction();
            const startTime = this.transactionStartTime;

            const adapter = this.databaseContext.getActiveAdapter();
            await adapter.commitTransaction(transaction.connection);

            const duration = startTime ? Date.now() - startTime.getTime() : 0;

            this.activeTransaction = null;
            this.transactionStartTime = null;
            this.savepoints = [];

            this.contextVariables.set('lastTransactionHistory', {
                id: transaction.id,
                type: 'commit',
                duration,
                timestamp: new Date()
            });

            CSReporter.info(`Database transaction committed successfully. ID: ${transaction.id}, Duration: ${duration}ms`);

        } catch (error) {
            CSReporter.error(`Failed to commit transaction: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to commit transaction: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user rolls back database transaction')
    async rollbackTransaction(): Promise<void> {
        CSReporter.info('Rolling back database transaction');

        try {
            const transaction = this.getActiveTransaction();
            const startTime = this.transactionStartTime;

            const adapter = this.databaseContext.getActiveAdapter();
            await adapter.rollbackTransaction(transaction.connection);

            const duration = startTime ? Date.now() - startTime.getTime() : 0;

            this.activeTransaction = null;
            this.transactionStartTime = null;
            this.savepoints = [];

            this.contextVariables.set('lastTransactionHistory', {
                id: transaction.id,
                type: 'rollback',
                duration,
                timestamp: new Date()
            });

            CSReporter.info(`Database transaction rolled back successfully. ID: ${transaction.id}, Duration: ${duration}ms`);

        } catch (error) {
            CSReporter.error(`Failed to rollback transaction: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to rollback transaction: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user creates savepoint {string}')
    async createSavepoint(savepointName: string): Promise<void> {
        CSReporter.info(`Creating savepoint: ${savepointName}`);

        try {
            const transaction = this.getActiveTransaction();

            const adapter = this.databaseContext.getActiveAdapter();
            await adapter.createSavepoint(transaction.connection, savepointName);

            this.savepoints.push(savepointName);
            if (transaction.savepoints) {
                transaction.savepoints.push(savepointName);
            }

            CSReporter.info(`Savepoint '${savepointName}' created successfully in transaction ${transaction.id}`);

        } catch (error) {
            CSReporter.error(`Failed to create savepoint '${savepointName}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to create savepoint '${savepointName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user rolls back to savepoint {string}')
    async rollbackToSavepoint(savepointName: string): Promise<void> {
        CSReporter.info(`Rolling back to savepoint: ${savepointName}`);

        try {
            const transaction = this.getActiveTransaction();

            if (!this.savepoints.includes(savepointName)) {
                throw new Error(`Savepoint '${savepointName}' does not exist`);
            }

            const adapter = this.databaseContext.getActiveAdapter();
            await adapter.rollbackToSavepoint(transaction.connection, savepointName);

            const index = this.savepoints.indexOf(savepointName);
            this.savepoints = this.savepoints.slice(0, index + 1);

            CSReporter.info(`Rolled back to savepoint '${savepointName}' in transaction ${transaction.id}`);

        } catch (error) {
            CSReporter.error(`Failed to rollback to savepoint '${savepointName}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to rollback to savepoint '${savepointName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user releases savepoint {string}')
    async releaseSavepoint(savepointName: string): Promise<void> {
        CSReporter.info(`Releasing savepoint: ${savepointName}`);

        try {
            const transaction = this.getActiveTransaction();

            if (!this.savepoints.includes(savepointName)) {
                throw new Error(`Savepoint '${savepointName}' does not exist`);
            }

            const adapter = this.databaseContext.getActiveAdapter();
            await adapter.releaseSavepoint(transaction.connection, savepointName);

            const index = this.savepoints.indexOf(savepointName);
            if (index > -1) {
                this.savepoints.splice(index, 1);
            }

            CSReporter.info(`Savepoint '${savepointName}' released successfully in transaction ${transaction.id}`);

        } catch (error) {
            CSReporter.error(`Failed to release savepoint '${savepointName}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to release savepoint '${savepointName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('database should have active transaction')
    async validateActiveTransaction(): Promise<void> {
        CSReporter.info('Validating active transaction exists');

        if (!this.activeTransaction) {
            throw new Error('No active transaction found');
        }

        CSReporter.info(`Active transaction validation passed: ${this.activeTransaction.id} (${this.activeTransaction.isolationLevel || 'default isolation'})`);
    }

    @CSBDDStepDef('database should not have active transaction')
    async validateNoActiveTransaction(): Promise<void> {
        CSReporter.info('Validating no active transaction exists');

        if (this.activeTransaction) {
            throw new Error(`Found active transaction: ${this.activeTransaction.id}`);
        }

        CSReporter.info('No active transaction validation passed');
    }

    @CSBDDStepDef('user executes query {string} within transaction')
    async executeQueryInTransaction(query: string): Promise<void> {
        CSReporter.info(`Executing query within transaction: ${this.sanitizeQueryForLog(query)}`);

        try {
            const transaction = this.getActiveTransaction();
            const interpolatedQuery = this.interpolateVariables(query);

            const adapter = this.databaseContext.getActiveAdapter();
            const startTime = Date.now();

            const result = await adapter.query(transaction.connection, interpolatedQuery);
            const executionTime = Date.now() - startTime;

            this.databaseContext.storeResult('last', result);
            this.contextVariables.set('lastQueryExecution', {
                query: interpolatedQuery,
                executionTime,
                rowCount: result.rowCount,
                timestamp: new Date(),
                transactionId: transaction.id
            });

            CSReporter.info(`Query executed within transaction ${transaction.id}. Rows: ${result.rowCount}, Time: ${executionTime}ms`);

        } catch (error) {
            CSReporter.error(`Failed to execute query in transaction: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute query in transaction: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user sets transaction timeout to {int} seconds')
    async setTransactionTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Setting transaction timeout to ${timeout} seconds`);

        try {
            const transaction = this.getActiveTransaction();

            transaction.timeout = timeout * 1000;

            CSReporter.info(`Transaction timeout set to ${timeout} seconds for transaction ${transaction.id}`);

        } catch (error) {
            CSReporter.error(`Failed to set transaction timeout: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to set transaction timeout: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private getActiveConnection(): any {
        const connectionField = 'activeConnection';
        const connection = (this.databaseContext as any)[connectionField];
        if (!connection) {
            throw new Error('No database connection established. Use "user connects to ... database" first');
        }
        return connection;
    }

    private getActiveTransaction(): Transaction {
        if (!this.activeTransaction) {
            throw new Error('No active transaction. Use "user begins database transaction" first');
        }
        return this.activeTransaction;
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
}