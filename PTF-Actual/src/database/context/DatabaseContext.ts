// src/database/context/DatabaseContext.ts

import { CSDatabaseAdapter } from '../adapters/DatabaseAdapter';
import { QueryResult, PreparedStatement, DatabaseConnection, QueryOptions } from '../types/database.types';
import { CSReporter } from '../../reporter/CSReporter';

export class DatabaseContext {
    private adapters: Map<string, CSDatabaseAdapter> = new Map();
    private activeAdapter: CSDatabaseAdapter | null = null;
    private activeConnection: DatabaseConnection | null = null;
    private activeConnectionName: string = '';
    private activeConnectionType: string = '';
    private queryHistory: QueryHistoryEntry[] = [];
    private transactionStack: TransactionInfo[] = [];
    private storedResults: Map<string, QueryResult> = new Map();
    private preparedStatements: Map<string, PreparedStatement> = new Map();
    private sessionVariables: Map<string, any> = new Map();
    private queryTimeout: number = 60000;
    private maxHistorySize: number = 1000;

    setActiveConnection(name: string, adapter: CSDatabaseAdapter, connection: DatabaseConnection): void {
        CSReporter.info(`Database connection operation - setActiveConnection, connectionName: ${name}`);

        this.adapters.set(name, adapter);
        this.activeAdapter = adapter;
        this.activeConnection = connection;
        this.activeConnectionName = name;
        this.activeConnectionType = connection.type;

        CSReporter.info(`Active database connection set to: ${name} (${connection.type})`);
    }

    getActiveAdapter(): CSDatabaseAdapter {
        if (!this.activeAdapter) {
            throw new Error('No active database connection. Use "user connects to database" step first.');
        }
        return this.activeAdapter;
    }

    getAdapter(name: string): CSDatabaseAdapter {
        const adapter = this.adapters.get(name);
        if (!adapter) {
            throw new Error(`Database connection '${name}' not found. Available connections: ${Array.from(this.adapters.keys()).join(', ')}`);
        }
        return adapter;
    }

    switchConnection(name: string, connection: DatabaseConnection): void {
        const adapter = this.getAdapter(name);
        this.activeAdapter = adapter;
        this.activeConnection = connection;
        this.activeConnectionName = name;
        this.activeConnectionType = connection.type;

        CSReporter.info(`Database connection operation - switchConnection, connectionName: ${name}`);
        CSReporter.info(`Switched to database connection: ${name}`);
    }

    async executeQuery(query: string, params?: any[]): Promise<QueryResult> {
        const adapter = this.getActiveAdapter();
        if (!this.activeConnection) {
            throw new Error('No active database connection');
        }
        const startTime = Date.now();
        
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`Query timeout after ${this.queryTimeout}ms`)), this.queryTimeout);
            });
            
            const options: QueryOptions = {
                timeout: this.queryTimeout
            };
            const queryPromise = adapter.query(this.activeConnection, query, params, options);
            
            const result = await Promise.race([queryPromise, timeoutPromise]) as QueryResult;
            
            const historyEntry: QueryHistoryEntry = {
                query,
                result,
                timestamp: new Date(),
                duration: Date.now() - startTime,
                connectionName: this.activeConnectionName,
                success: true
            };
            if (params) {
                historyEntry.params = params;
            }
            this.addToHistory(historyEntry);
            
            return result;
            
        } catch (error) {
            const historyEntry: QueryHistoryEntry = {
                query,
                result: null,
                timestamp: new Date(),
                duration: Date.now() - startTime,
                connectionName: this.activeConnectionName,
                success: false,
                error: (error as Error).message
            };
            if (params) {
                historyEntry.params = params;
            }
            this.addToHistory(historyEntry);
            
            throw error;
        }
    }

    storeResult(alias: string, result: QueryResult): void {
        this.storedResults.set(alias, result);
        CSReporter.info(`Database operation - storeResult, alias: ${alias}, rowCount: ${result.rowCount}`);
    }

    getStoredResult(alias: string): QueryResult {
        const result = this.storedResults.get(alias);
        if (!result) {
            throw new Error(`No stored result found with alias '${alias}'. Available aliases: ${Array.from(this.storedResults.keys()).join(', ')}`);
        }
        return result;
    }

    storePreparedStatement(name: string, statement: PreparedStatement): void {
        this.preparedStatements.set(name, statement);
        CSReporter.info(`Database operation - storePreparedStatement, name: ${name}`);
    }

    getPreparedStatement(name: string): PreparedStatement {
        const statement = this.preparedStatements.get(name);
        if (!statement) {
            throw new Error(`No prepared statement found with name '${name}'`);
        }
        return statement;
    }

    beginTransactionTracking(name?: string): void {
        const transactionInfo: TransactionInfo = {
            name: name || `transaction_${this.transactionStack.length + 1}`,
            startTime: new Date(),
            connectionName: this.activeConnectionName,
            queries: []
        };

        this.transactionStack.push(transactionInfo);
        CSReporter.info(`Database operation - beginTransactionTracking, transactionName: ${transactionInfo.name}, depth: ${this.transactionStack.length}`);
    }

    endTransactionTracking(committed: boolean): TransactionInfo | undefined {
        const transaction = this.transactionStack.pop();
        if (transaction) {
            transaction.endTime = new Date();
            transaction.committed = committed;
            transaction.duration = transaction.endTime.getTime() - transaction.startTime.getTime();

            CSReporter.info(`Database operation - endTransactionTracking, transactionName: ${transaction.name}, committed: ${committed}, duration: ${transaction.duration}, queryCount: ${transaction.queries.length}`);
        }
        return transaction;
    }

    addQueryToTransaction(query: string, params?: any[]): void {
        const currentTransaction = this.transactionStack[this.transactionStack.length - 1];
        if (currentTransaction) {
            const queryInfo: { query: string; params?: any[]; timestamp: Date } = {
                query,
                timestamp: new Date()
            };
            if (params) {
                queryInfo.params = params;
            }
            currentTransaction.queries.push(queryInfo);
        }
    }

    getTransactionDepth(): number {
        return this.transactionStack.length;
    }

    setSessionVariable(key: string, value: any): void {
        this.sessionVariables.set(key, value);
        CSReporter.info(`Database operation - setSessionVariable, key: ${key}, value: ${value}`);
    }

    getSessionVariable(key: string): any {
        return this.sessionVariables.get(key);
    }

    clearSessionVariables(): void {
        this.sessionVariables.clear();
        CSReporter.info('Database operation - clearSessionVariables');
    }

    setQueryTimeout(timeout: number): void {
        this.queryTimeout = timeout;
        CSReporter.info(`Database operation - setQueryTimeout, timeout: ${timeout}`);
    }

    async executeWithPlan(query: string, params?: any[]): Promise<QueryResult> {
        const adapter = this.getActiveAdapter();
        const startTime = Date.now();
        
        try {
            let executionPlan: string | undefined;
            let planQuery: string;
            
            switch (this.activeConnectionType.toLowerCase()) {
                case 'mysql':
                    planQuery = `EXPLAIN ${query}`;
                    break;
                case 'postgresql':
                    planQuery = `EXPLAIN ANALYZE ${query}`;
                    break;
                case 'sqlite':
                    planQuery = `EXPLAIN QUERY PLAN ${query}`;
                    break;
                case 'mssql':
                case 'sqlserver':
                    await adapter.query(this.activeConnection!, 'SET SHOWPLAN_TEXT ON');
                    planQuery = query;
                    break;
                case 'oracle':
                    planQuery = `EXPLAIN PLAN FOR ${query}`;
                    break;
                default:
                    planQuery = `EXPLAIN ${query}`;
            }
            
            try {
                const planResult = await adapter.query(this.activeConnection!, planQuery, params);
                
                if (this.activeConnectionType.toLowerCase() === 'oracle') {
                    const oraclePlan = await adapter.query(
                        this.activeConnection!,
                        'SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY())'
                    );
                    executionPlan = this.formatExecutionPlan(oraclePlan);
                } else if (this.activeConnectionType.toLowerCase() === 'mssql' || 
                           this.activeConnectionType.toLowerCase() === 'sqlserver') {
                    executionPlan = this.formatExecutionPlan(planResult);
                    await adapter.query(this.activeConnection!, 'SET SHOWPLAN_TEXT OFF');
                } else {
                    executionPlan = this.formatExecutionPlan(planResult);
                }
            } catch (planError) {
                CSReporter.warn(`Failed to get execution plan: ${(planError as Error).message}`);
            }
            
            const result = await adapter.query(this.activeConnection!, query, params);
            
            const historyEntry: QueryHistoryEntry = {
                query,
                result,
                timestamp: new Date(),
                duration: Date.now() - startTime,
                connectionName: this.activeConnectionName,
                success: true,
                ...(executionPlan ? { executionPlan } : {}),
                metadata: {
                    rowsExamined: result.rowCount,
                    ...(executionPlan ? { indexUsed: executionPlan.includes('INDEX') || executionPlan.includes('index') } : {})
                }
            };
            if (params) {
                historyEntry.params = params;
            }
            this.addToHistory(historyEntry);
            
            return result;
            
        } catch (error) {
            const historyEntry: QueryHistoryEntry = {
                query,
                result: null,
                timestamp: new Date(),
                duration: Date.now() - startTime,
                connectionName: this.activeConnectionName,
                success: false,
                error: (error as Error).message
            };
            if (params) {
                historyEntry.params = params;
            }
            this.addToHistory(historyEntry);
            
            throw error;
        }
    }

    getLastExecutionPlan(): string | undefined {
        const history = this.getQueryHistory();
        for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];
            if (entry?.executionPlan) {
                return entry.executionPlan;
            }
        }
        return undefined;
    }

    private formatExecutionPlan(result: QueryResult): string {
        if (!result || !result.rows || result.rows.length === 0) {
            return 'No execution plan available';
        }
        
        let plan = '';
        
        if (Array.isArray(result.rows)) {
            result.rows.forEach((row, index) => {
                if (typeof row === 'object') {
                    const planText = row['QUERY PLAN'] || row['QueryPlan'] || row['Plan'] || 
                                   row['EXPLAIN'] || row['Extra'] || row['StmtText'] ||
                                   row['PLAN_TABLE_OUTPUT'] || JSON.stringify(row, null, 2);
                    plan += `${index > 0 ? '\n' : ''}${planText}`;
                } else {
                    plan += `${index > 0 ? '\n' : ''}${row}`;
                }
            });
        }
        
        return plan || 'Execution plan format not recognized';
    }

    getQueryHistory(filter?: QueryHistoryFilter): QueryHistoryEntry[] {
        let history = [...this.queryHistory];
        
        if (filter) {
            if (filter.connectionName) {
                history = history.filter(h => h.connectionName === filter.connectionName);
            }
            if (filter.success !== undefined) {
                history = history.filter(h => h.success === filter.success);
            }
            if (filter.startTime) {
                history = history.filter(h => h.timestamp >= filter.startTime!);
            }
            if (filter.endTime) {
                history = history.filter(h => h.timestamp <= filter.endTime!);
            }
            if (filter.minDuration !== undefined) {
                history = history.filter(h => h.duration >= filter.minDuration!);
            }
            if (filter.maxDuration !== undefined) {
                history = history.filter(h => h.duration <= filter.maxDuration!);
            }
            if (filter.queryPattern) {
                const pattern = new RegExp(filter.queryPattern, 'i');
                history = history.filter(h => pattern.test(h.query));
            }
        }
        
        return history;
    }

    clearQueryHistory(): void {
        this.queryHistory = [];
        CSReporter.info('Database operation - clearQueryHistory');
    }

    getConnectionStatistics(): ConnectionStatistics {
        const stats: ConnectionStatistics = {
            activeConnections: this.adapters.size,
            totalQueries: this.queryHistory.length,
            successfulQueries: this.queryHistory.filter(h => h.success).length,
            failedQueries: this.queryHistory.filter(h => !h.success).length,
            averageQueryTime: this.calculateAverageQueryTime(),
            connectionDetails: {}
        };
        
        for (const [name, _adapter] of Array.from(this.adapters)) {
            const connectionQueries = this.queryHistory.filter(h => h.connectionName === name);
            const connectionType = name === this.activeConnectionName ? this.activeConnectionType : 'unknown';
            stats.connectionDetails[name] = {
                type: connectionType,
                queryCount: connectionQueries.length,
                successCount: connectionQueries.filter(h => h.success).length,
                failureCount: connectionQueries.filter(h => !h.success).length,
                averageTime: this.calculateAverageQueryTime(connectionQueries)
            };
        }
        
        return stats;
    }

    async closeAllConnections(): Promise<void> {
        CSReporter.info(`Database operation - closeAllConnections, connectionCount: ${this.adapters.size}`);

        const closePromises: Promise<void>[] = [];

        // Note: We need to maintain a map of connections to close them properly
        for (const [name, _adapter] of Array.from(this.adapters)) {
            CSReporter.info(`Closing database connection: ${name}`);
        }

        await Promise.all(closePromises);

        this.adapters.clear();
        this.activeAdapter = null;
        this.activeConnection = null;
        this.activeConnectionName = '';
        this.activeConnectionType = '';
        this.storedResults.clear();
        this.preparedStatements.clear();
        this.sessionVariables.clear();
        this.transactionStack = [];

        CSReporter.info('All database connections closed');
    }

    getContextState(): DatabaseContextState {
        return {
            activeConnection: this.activeConnectionName,
            connections: Array.from(this.adapters.keys()),
            storedResults: Array.from(this.storedResults.keys()),
            preparedStatements: Array.from(this.preparedStatements.keys()),
            sessionVariables: Object.fromEntries(this.sessionVariables),
            transactionDepth: this.transactionStack.length,
            queryHistorySize: this.queryHistory.length,
            queryTimeout: this.queryTimeout
        };
    }


    private addToHistory(entry: QueryHistoryEntry): void {
        this.queryHistory.push(entry);
        
        if (this.transactionStack.length > 0) {
            this.addQueryToTransaction(entry.query, entry.params);
        }
        
        if (this.queryHistory.length > this.maxHistorySize) {
            this.queryHistory.splice(0, this.queryHistory.length - this.maxHistorySize);
        }
    }

    private calculateAverageQueryTime(queries?: QueryHistoryEntry[]): number {
        const targetQueries = queries || this.queryHistory;
        const successfulQueries = targetQueries.filter(h => h.success);
        
        if (successfulQueries.length === 0) {
            return 0;
        }
        
        const totalTime = successfulQueries.reduce((sum, h) => sum + h.duration, 0);
        return Math.round(totalTime / successfulQueries.length);
    }
}


interface QueryHistoryEntry {
    query: string;
    params?: any[];
    result: QueryResult | null;
    timestamp: Date;
    duration: number;
    connectionName: string;
    success: boolean;
    error?: string;
    executionPlan?: string;
    metadata?: {
        rowsExamined?: number;
        indexUsed?: boolean;
        optimizations?: string[];
        [key: string]: any;
    };
}

interface QueryHistoryFilter {
    connectionName?: string;
    success?: boolean;
    startTime?: Date;
    endTime?: Date;
    minDuration?: number;
    maxDuration?: number;
    queryPattern?: string;
}

interface TransactionInfo {
    name: string;
    startTime: Date;
    endTime?: Date;
    duration?: number;
    connectionName: string;
    queries: Array<{
        query: string;
        params?: any[];
        timestamp: Date;
    }>;
    committed?: boolean;
}

interface ConnectionStatistics {
    activeConnections: number;
    totalQueries: number;
    successfulQueries: number;
    failedQueries: number;
    averageQueryTime: number;
    connectionDetails: Record<string, {
        type: string;
        queryCount: number;
        successCount: number;
        failureCount: number;
        averageTime: number;
    }>;
}

interface DatabaseContextState {
    activeConnection: string;
    connections: string[];
    storedResults: string[];
    preparedStatements: string[];
    sessionVariables: Record<string, any>;
    transactionDepth: number;
    queryHistorySize: number;
    queryTimeout: number;
}
