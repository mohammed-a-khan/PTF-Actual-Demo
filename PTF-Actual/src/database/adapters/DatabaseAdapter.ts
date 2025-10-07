// src/database/adapters/DatabaseAdapter.ts

import {
  DatabaseConnection,
  DatabaseConfig,
  QueryResult,
  QueryOptions,
  PreparedStatement,
  TransactionOptions,
  DatabaseMetadata,
  TableInfo,
  DatabaseError,
  DatabaseErrorCode
} from '../types/database.types';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

export abstract class CSDatabaseAdapter {
  protected config?: DatabaseConfig;
  protected configManager: CSConfigurationManager;
  protected eventHandlers: Map<string, Set<Function>> = new Map();

  constructor() {
    this.configManager = CSConfigurationManager.getInstance();
  }

  abstract connect(config: DatabaseConfig): Promise<DatabaseConnection>;

  abstract disconnect(connection: DatabaseConnection): Promise<void>;

  abstract query(
    connection: DatabaseConnection, 
    sql: string, 
    params?: any[], 
    options?: QueryOptions
  ): Promise<QueryResult>;

  abstract executeStoredProcedure(
    connection: DatabaseConnection,
    procedureName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<QueryResult>;

  abstract executeFunction(
    connection: DatabaseConnection,
    functionName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<any>;

  abstract beginTransaction(
    connection: DatabaseConnection,
    options?: TransactionOptions
  ): Promise<void>;

  abstract commitTransaction(connection: DatabaseConnection): Promise<void>;

  abstract rollbackTransaction(connection: DatabaseConnection): Promise<void>;

  abstract createSavepoint(connection: DatabaseConnection, name: string): Promise<void>;

  abstract releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void>;

  abstract rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void>;

  abstract prepare(connection: DatabaseConnection, sql: string): Promise<PreparedStatement>;

  abstract executePrepared(
    statement: PreparedStatement,
    params?: any[]
  ): Promise<QueryResult>;

  abstract ping(connection: DatabaseConnection): Promise<void>;

  abstract getMetadata(connection: DatabaseConnection): Promise<DatabaseMetadata>;

  abstract getTableInfo(connection: DatabaseConnection, tableName: string): Promise<TableInfo>;

  abstract bulkInsert(
    connection: DatabaseConnection,
    table: string,
    data: any[]
  ): Promise<number>;

  buildStoredProcedureCall(procedureName: string, params?: any[]): string {
    if (!params || params.length === 0) {
      return `CALL ${procedureName}()`;
    }
    
    const placeholders = params.map(() => '?').join(', ');
    return `CALL ${procedureName}(${placeholders})`;
  }

  async setSessionParameter(
    connection: DatabaseConnection,
    parameter: string,
    value: any
  ): Promise<void> {
    if (!connection.sessionOptions) {
      connection.sessionOptions = {};
    }
    
    switch (parameter.toLowerCase()) {
      case 'autocommit':
        connection.sessionOptions.autoCommit = Boolean(value);
        break;
      case 'readonly':
        connection.sessionOptions.readOnly = Boolean(value);
        break;
      case 'locktimeout':
        connection.sessionOptions.lockTimeout = Number(value);
        break;
      case 'statementtimeout':
        connection.sessionOptions.statementTimeout = Number(value);
        break;
      case 'timezone':
        connection.sessionOptions.timezone = String(value);
        break;
      default:
        throw new Error(`Session parameter '${parameter}' not supported by this database type`);
    }
  }

  async cancelQuery?(connection: DatabaseConnection): Promise<void>;

  stream?(
    connection: DatabaseConnection,
    sql: string,
    params?: any[],
    options?: QueryOptions
  ): AsyncGenerator<any, void, unknown>;

  escapeIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  escapeValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  formatDate(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }

  getIsolationLevelSQL(level?: string): string {
    switch (level?.toUpperCase()) {
      case 'READ_UNCOMMITTED':
        return 'READ UNCOMMITTED';
      case 'READ_COMMITTED':
        return 'READ COMMITTED';
      case 'REPEATABLE_READ':
        return 'REPEATABLE READ';
      case 'SERIALIZABLE':
        return 'SERIALIZABLE';
      default:
        return 'READ COMMITTED';
    }
  }

  parseConnectionError(error: any): DatabaseError {
    const message = error.message || 'Unknown database error';
    const enhancedError = new Error(message) as DatabaseError;
    
    let errorCode = DatabaseErrorCode.UNKNOWN_ERROR;
    
    if (error.code) {
      const code = String(error.code).toUpperCase();
      
      if (code.includes('CONN') || code.includes('NETWORK') || code === 'ECONNREFUSED') {
        errorCode = DatabaseErrorCode.CONNECTION_ERROR;
      } else if (code.includes('AUTH') || code === 'EAUTH' || code === '28P01') {
        errorCode = DatabaseErrorCode.AUTHENTICATION_ERROR;
      } else if (code.includes('TIMEOUT') || code === 'ETIMEDOUT') {
        errorCode = DatabaseErrorCode.TIMEOUT_ERROR;
      } else if (code === '23505' || code.includes('DUPLICATE')) {
        errorCode = DatabaseErrorCode.DUPLICATE_KEY;
      } else if (code === '23503' || code.includes('FOREIGN')) {
        errorCode = DatabaseErrorCode.FOREIGN_KEY_VIOLATION;
      } else if (code === '23502' || code.includes('NULL')) {
        errorCode = DatabaseErrorCode.NOT_NULL_VIOLATION;
      } else if (code === '42601' || code.includes('SYNTAX')) {
        errorCode = DatabaseErrorCode.QUERY_ERROR;
      } else if (code === '42501' || code.includes('PERMISSION')) {
        errorCode = DatabaseErrorCode.PERMISSION_DENIED;
      }
    }
    
    Object.assign(enhancedError, {
      code: errorCode,
      originalError: error,
      context: {
        sqlState: error.sqlState,
        nativeCode: error.code,
        severity: error.severity,
        detail: error.detail,
        hint: error.hint,
        position: error.position,
        file: error.file,
        line: error.line,
        routine: error.routine
      }
    });

    switch (errorCode) {
      case DatabaseErrorCode.CONNECTION_ERROR:
        enhancedError.solution = 'Check database host, port, and network connectivity';
        break;
      case DatabaseErrorCode.AUTHENTICATION_ERROR:
        enhancedError.solution = 'Verify username, password, and authentication method';
        break;
      case DatabaseErrorCode.TIMEOUT_ERROR:
        enhancedError.solution = 'Increase timeout settings or optimize query performance';
        break;
      case DatabaseErrorCode.DUPLICATE_KEY:
        enhancedError.solution = 'Ensure unique constraint values are not duplicated';
        break;
      case DatabaseErrorCode.FOREIGN_KEY_VIOLATION:
        enhancedError.solution = 'Verify referenced records exist before insertion/deletion';
        break;
      case DatabaseErrorCode.NOT_NULL_VIOLATION:
        enhancedError.solution = 'Provide values for all required fields';
        break;
      case DatabaseErrorCode.PERMISSION_DENIED:
        enhancedError.solution = 'Grant necessary permissions to the database user';
        break;
    }

    return enhancedError;
  }

  async getServerInfo(connection: DatabaseConnection): Promise<any> {
    const metadata = await this.getMetadata(connection);
    
    return {
      type: this.constructor.name.replace('Adapter', ''),
      connected: connection.connected,
      version: metadata.version,
      databaseName: metadata.databaseName,
      serverType: metadata.serverType,
      characterSet: metadata.characterSet,
      collation: metadata.collation,
      currentUser: metadata.currentUser,
      currentSchema: metadata.currentSchema,
      connectionId: connection.id,
      lastActivity: connection.lastActivity,
      inTransaction: connection.inTransaction
    };
  }

  protected emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(event, data);
        } catch (error) {
          CSReporter.error(`Error in database event handler for ${event}: ` + (error as Error).message);
        }
      });
    }
  }

  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: Function): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  protected validateConnection(connection: DatabaseConnection): void {
    if (!connection || !connection.connected) {
      throw this.parseConnectionError(new Error('Connection is not established'));
    }
  }

  protected async measureDuration<T>(
    operation: () => Promise<T>
  ): Promise<{ result: T; duration: number }> {
    const startTime = Date.now();
    const result = await operation();
    const duration = Date.now() - startTime;
    return { result, duration };
  }

  protected updateTransactionState(
    connection: DatabaseConnection,
    inTransaction: boolean,
    level: number = 0
  ): void {
    connection.inTransaction = inTransaction;
    connection.transactionLevel = level;
    if (!inTransaction) {
      connection.savepoints = [];
    }
  }

  protected formatQueryForLog(sql: string, params?: any[]): string {
    let formattedQuery = sql.trim();
    
    if (params && params.length > 0) {
      formattedQuery += '\n-- Parameters: ' + JSON.stringify(params);
    }
    
    return formattedQuery;
  }

  protected validateTableName(tableName: string): void {
    if (!tableName || typeof tableName !== 'string') {
      throw new Error('Invalid table name');
    }
    
    if (/[';\\]/.test(tableName)) {
      throw new Error('Invalid characters in table name');
    }
  }

  protected buildColumnList(columns: string[]): string {
    return columns.map(col => this.escapeIdentifier(col)).join(', ');
  }

  protected buildValuePlaceholders(count: number, startIndex: number = 1): string {
    const placeholders: string[] = [];
    for (let i = 0; i < count; i++) {
      placeholders.push(`$${startIndex + i}`);
    }
    return placeholders.join(', ');
  }
}
