// src/database/adapters/MySQLAdapter.ts

import { 
  DatabaseConnection, 
  DatabaseConfig, 
  QueryResult, 
  QueryOptions, 
  PreparedStatement,
  TransactionOptions,
  DatabaseMetadata,
  TableInfo,
  DatabaseCapabilities
} from '../types/database.types';
import { CSDatabaseAdapter } from './DatabaseAdapter';
import { CSReporter } from '../../reporter/CSReporter';

export class CSMySQLAdapter extends CSDatabaseAdapter {
  private mysql2: any;
  readonly capabilities: DatabaseCapabilities = {
    transactions: true,
    preparedStatements: true,
    storedProcedures: true,
    bulkInsert: true,
    streaming: true,
    savepoints: true,
    schemas: true,
    json: true,
    arrays: false
  };

  constructor() {
    super();
  }

  private async loadDriver(): Promise<void> {
    if (!this.mysql2) {
      try {
        this.mysql2 = await import('mysql2/promise');
      } catch (error) {
        throw new Error('MySQL driver (mysql2) not installed. Run: npm install mysql2');
      }
    }
  }

  async connect(config: DatabaseConfig): Promise<DatabaseConnection> {
    await this.loadDriver();
    this.config = config;

    try {
      const connectionConfig: any = {
        host: config.host,
        port: config.port || 3306,
        database: config.database,
        user: config.username,
        password: config.password,
        connectTimeout: config.connectionTimeout || 30000,
        ssl: config.ssl ? {
          rejectUnauthorized: config.sslOptions?.rejectUnauthorized !== false,
          ...config.sslOptions
        } : undefined,
        ...config.additionalOptions
      };

      if (config.additionalOptions?.['connectionString']) {
        const url = new URL(config.additionalOptions['connectionString']);
        connectionConfig.host = url.hostname;
        connectionConfig.port = parseInt(url.port) || 3306;
        connectionConfig.database = url.pathname.substring(1);
        connectionConfig.user = url.username;
        connectionConfig.password = url.password;
      }

      const poolSize = config.connectionPoolSize || config.additionalOptions?.['poolSize'];
      if (poolSize && poolSize > 1) {
        const pool = await this.mysql2.createPool({
          ...connectionConfig,
          connectionLimit: poolSize,
          queueLimit: config.additionalOptions?.['poolQueueLimit'] || 0,
          waitForConnections: true
        });
        
        const connection = await pool.getConnection();
        connection.release();
        
        return pool;
      } else {
        return await this.mysql2.createConnection(connectionConfig);
      }
    } catch (error) {
      throw this.parseConnectionError(error);
    }
  }

  async disconnect(connection: DatabaseConnection): Promise<void> {
    try {
      const conn = connection as any;
      
      if (conn.end) {
        await conn.end();
      } else if (conn.pool) {
        await conn.pool.end();
      }
    } catch (error) {
      CSReporter.error('MySQL disconnect error: ' + (error as Error).message);
      throw error;
    }
  }

  async query(
    connection: DatabaseConnection, 
    sql: string, 
    params?: any[], 
    options?: QueryOptions
  ): Promise<QueryResult> {
    const conn = connection as any;
    
    const isPool = conn.getConnection !== undefined;
    const queryConn = isPool ? await conn.getConnection() : conn;

    try {
      if (options?.timeout) {
        await queryConn.query(`SET SESSION max_execution_time=${options.timeout}`);
      }

      const startTime = Date.now();
      const [rows, fields] = await queryConn.execute(sql, params || []);
      const executionTime = Date.now() - startTime;

      let result: QueryResult;
      
      if (Array.isArray(rows)) {
        result = {
          rows: rows as any[],
          rowCount: rows.length,
          fields: this.parseFields(fields) || [],
          duration: executionTime,
          command: sql.trim().split(' ')[0]?.toUpperCase() || 'UNKNOWN'
        };
      } else {
        result = {
          rows: [],
          rowCount: (rows as any).affectedRows || 0,
          fields: [],
          duration: executionTime,
          affectedRows: (rows as any).affectedRows || 0,
          insertId: (rows as any).insertId,
          command: sql.trim().split(' ')[0]?.toUpperCase() || 'UNKNOWN'
        };
      }

      return result;
    } catch (error: any) {
      throw this.parseQueryError(error, sql);
    } finally {
      if (isPool) {
        queryConn.release();
      }
    }
  }

  async executeStoredProcedure(
    connection: DatabaseConnection,
    procedureName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<QueryResult> {
    const paramPlaceholders = params ? params.map(() => '?').join(', ') : '';
    const sql = `CALL ${this.escapeIdentifier(procedureName)}(${paramPlaceholders})`;
    
    const result = await this.query(connection, sql, params, options);
    
    if (Array.isArray(result) && result.length > 0) {
      return result[0];
    }
    
    return result;
  }

  async executeFunction(
    connection: DatabaseConnection,
    functionName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<any> {
    const paramPlaceholders = params ? params.map(() => '?').join(', ') : '';
    const sql = `SELECT ${this.escapeIdentifier(functionName)}(${paramPlaceholders}) AS result`;
    
    const result = await this.query(connection, sql, params, options);
    return result.rows[0]?.result;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    options?: TransactionOptions
  ): Promise<void> {
    const conn = connection as any;
    
    if (options?.isolationLevel) {
      const level = this.getIsolationLevelSQL(options.isolationLevel);
      await this.query(connection, `SET TRANSACTION ISOLATION LEVEL ${level}`);
    }

    if (conn.getConnection) {
      const txConn = await conn.getConnection();
      await txConn.beginTransaction();
      (connection as any)._transactionConnection = txConn;
    } else {
      await conn.beginTransaction();
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as any;
    const txConn = conn._transactionConnection || conn;
    
    await txConn.commit();
    
    if (conn._transactionConnection) {
      conn._transactionConnection.release();
      delete conn._transactionConnection;
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as any;
    const txConn = conn._transactionConnection || conn;
    
    await txConn.rollback();
    
    if (conn._transactionConnection) {
      conn._transactionConnection.release();
      delete conn._transactionConnection;
    }
  }

  async createSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.query(connection, `SAVEPOINT ${this.escapeIdentifier(name)}`);
  }

  async releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.query(connection, `RELEASE SAVEPOINT ${this.escapeIdentifier(name)}`);
  }

  async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.query(connection, `ROLLBACK TO SAVEPOINT ${this.escapeIdentifier(name)}`);
  }

  async prepare(connection: DatabaseConnection, sql: string): Promise<PreparedStatement> {
    const conn = connection as any;
    const isPool = conn.getConnection !== undefined;
    const prepareConn = isPool ? await conn.getConnection() : conn;
    
    const statement = await prepareConn.prepare(sql);
    
    return {
      execute: async (params?: any[]) => {
        const [rows] = await statement.execute(params || []);
        return {
          rows: Array.isArray(rows) ? rows : [],
          rowCount: Array.isArray(rows) ? rows.length : (rows as any).affectedRows || 0,
          affectedRows: (rows as any).affectedRows
        };
      },
      close: async () => {
        await statement.close();
        if (isPool) {
          prepareConn.release();
        }
      }
    } as PreparedStatement;
  }

  async executePrepared(
    statement: PreparedStatement,
    params?: any[]
  ): Promise<QueryResult> {
    return await (statement as any).execute(params);
  }

  async ping(connection: DatabaseConnection): Promise<void> {
    const conn = connection as any;
    
    if (conn.ping) {
      await conn.ping();
    } else {
      await this.query(connection, 'SELECT 1');
    }
  }

  async getMetadata(connection: DatabaseConnection): Promise<DatabaseMetadata> {
    const versionResult = await this.query(connection, 'SELECT VERSION() AS version');
    const dbNameResult = await this.query(connection, 'SELECT DATABASE() AS dbname');
    
    await this.query(connection, `
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = DATABASE() 
      AND table_type = 'BASE TABLE'
    `);

    return {
      databaseName: dbNameResult.rows[0].dbname,
      version: versionResult.rows[0].version,
      serverType: 'MySQL',
      capabilities: this.capabilities,
      characterSet: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      currentUser: this.config?.username || 'unknown',
      currentSchema: dbNameResult.rows[0].dbname
    };
  }

  async getTableInfo(connection: DatabaseConnection, tableName: string): Promise<TableInfo> {
    const columnsResult = await this.query(connection, `
      SELECT 
        COLUMN_NAME as name,
        DATA_TYPE as type,
        CHARACTER_MAXIMUM_LENGTH as length,
        NUMERIC_PRECISION as \`precision\`,
        NUMERIC_SCALE as scale,
        IS_NULLABLE as nullable,
        COLUMN_DEFAULT as defaultValue,
        EXTRA as extra
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
      AND table_name = ?
      ORDER BY ORDINAL_POSITION
    `, [tableName]);

    await this.query(connection, `
      SELECT 
        CONSTRAINT_NAME as name,
        CONSTRAINT_TYPE as type
      FROM information_schema.table_constraints
      WHERE table_schema = DATABASE()
      AND table_name = ?
    `, [tableName]);

    const indexResult = await this.query(connection, `
      SELECT 
        INDEX_NAME as indexName,
        NON_UNIQUE as nonUnique,
        COLUMN_NAME as columnName
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
      AND table_name = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `, [tableName]);

    const indexes = new Map<string, any>();
    indexResult.rows.forEach(row => {
      if (!indexes.has(row.indexName)) {
        indexes.set(row.indexName, {
          indexName: row.indexName,
          isUnique: !row.nonUnique,
          isPrimary: row.indexName === 'PRIMARY',
          columns: []
        });
      }
      indexes.get(row.indexName).columns.push(row.columnName);
    });

    const primaryKeyResult = await this.query(connection, `
      SELECT COLUMN_NAME 
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = ?
      AND CONSTRAINT_NAME = 'PRIMARY'
    `, [tableName]);
    
    const primaryKeyColumns = primaryKeyResult.rows.map(row => row.COLUMN_NAME);

    const tableInfo: TableInfo = {
      name: tableName,
      type: 'table' as const,
      columns: columnsResult.rows.map((col, index) => ({
        name: col.name,
        ordinalPosition: index + 1,
        dataType: col.type,
        nativeDataType: col.type,
        nullable: col.nullable === 'YES',
        defaultValue: col.defaultValue,
        maxLength: col.length,
        precision: col.precision,
        scale: col.scale,
        isPrimaryKey: primaryKeyColumns.includes(col.name),
        isUnique: indexes.has(col.name) && indexes.get(col.name).isUnique,
        isAutoIncrement: col.extra.includes('auto_increment')
      })),
      indexes: Array.from(indexes.values()).map(idx => ({
        name: idx.indexName,
        table: tableName,
        columns: idx.columns,
        unique: idx.isUnique,
        type: 'btree' as const
      })),
      rowCount: await this.getTableRowCount(connection, tableName)
    };
    
    if (primaryKeyColumns.length > 0) {
      tableInfo.primaryKey = {
        name: 'PRIMARY',
        columns: primaryKeyColumns
      };
    }
    
    return tableInfo;
  }

  async bulkInsert(
    connection: DatabaseConnection,
    table: string,
    data: any[]
  ): Promise<number> {
    if (data.length === 0) return 0;

    const columns = Object.keys(data[0]);
    const columnNames = columns.map(col => this.escapeIdentifier(col)).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    
    const values: any[] = [];
    const valuePlaceholders: string[] = [];
    
    data.forEach(row => {
      valuePlaceholders.push(`(${placeholders})`);
      columns.forEach(col => {
        values.push(row[col]);
      });
    });

    const sql = `INSERT INTO ${this.escapeIdentifier(table)} (${columnNames}) VALUES ${valuePlaceholders.join(', ')}`;
    
    const result = await this.query(connection, sql, values);
    return result.affectedRows || data.length;
  }

  private parseFields(fields: any[]): any {
    if (!fields) return undefined;
    
    return fields.map(field => ({
      name: field.name,
      type: this.mapFieldType(field.type),
      length: field.length,
      table: field.table,
      database: field.db
    }));
  }

  private mapFieldType(mysqlType: number): string {
    const types: Record<number, string> = {
      0: 'DECIMAL',
      1: 'TINY',
      2: 'SHORT',
      3: 'LONG',
      4: 'FLOAT',
      5: 'DOUBLE',
      6: 'NULL',
      7: 'TIMESTAMP',
      8: 'LONGLONG',
      9: 'INT24',
      10: 'DATE',
      11: 'TIME',
      12: 'DATETIME',
      13: 'YEAR',
      14: 'NEWDATE',
      15: 'VARCHAR',
      16: 'BIT',
      245: 'JSON',
      246: 'NEWDECIMAL',
      247: 'ENUM',
      248: 'SET',
      249: 'TINY_BLOB',
      250: 'MEDIUM_BLOB',
      251: 'LONG_BLOB',
      252: 'BLOB',
      253: 'VAR_STRING',
      254: 'STRING',
      255: 'GEOMETRY'
    };
    
    return types[mysqlType] || 'UNKNOWN';
  }

  private async getTableRowCount(connection: DatabaseConnection, tableName: string): Promise<number> {
    const result = await this.query(
      connection, 
      `SELECT COUNT(*) as count FROM ${this.escapeIdentifier(tableName)}`
    );
    return result.rows[0].count;
  }

  parseQueryError(error: any, sql?: string): Error {
    const message = `MySQL Error: ${error.message}\nSQL: ${sql ? sql.substring(0, 200) + (sql.length > 200 ? '...' : '') : 'No SQL provided'}`;
    const enhancedError = new Error(message);
    
    Object.assign(enhancedError, {
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      originalError: error,
      sql
    });

    return enhancedError;
  }

  override escapeIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  override async *stream(
    connection: DatabaseConnection,
    sql: string,
    params?: any[],
    _options?: QueryOptions
  ): AsyncGenerator<any, void, unknown> {
    const conn = connection as any;
    const isPool = conn.getConnection !== undefined;
    const streamConn = isPool ? await conn.getConnection() : conn;

    try {
      const stream = streamConn.execute(sql, params || []).stream();
      
      for await (const row of stream) {
        yield row;
      }
    } finally {
      if (isPool) {
        streamConn.release();
      }
    }
  }

  override async setSessionParameter(
    connection: DatabaseConnection,
    parameter: string,
    value: any
  ): Promise<void> {
    const sql = `SET SESSION ${this.escapeIdentifier(parameter)} = ?`;
    await this.query(connection, sql, [value]);
  }

  override async getServerInfo(connection: DatabaseConnection): Promise<any> {
    const variablesResult = await this.query(connection, `
      SELECT 
        @@version_comment as versionComment,
        @@version_compile_os as os,
        @@version_compile_machine as machine,
        @@max_connections as maxConnections,
        @@character_set_server as charset,
        @@collation_server as collation
    `);

    return {
      type: 'MySQL',
      ...variablesResult.rows[0],
      connected: true
    };
  }
}
