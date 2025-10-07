// src/database/adapters/PostgreSQLAdapter.ts

import { 
  DatabaseConnection, 
  DatabaseConfig, 
  QueryResult, 
  QueryOptions, 
  PreparedStatement,
  TransactionOptions,
  DatabaseMetadata,
  TableInfo
} from '../types/database.types';
import { CSDatabaseAdapter } from './DatabaseAdapter';
import { CSReporter } from '../../reporter/CSReporter';

export class CSPostgreSQLAdapter extends CSDatabaseAdapter {
  private pg: any;
  private preparedStatements: Map<string, any> = new Map();
  private statementCounter: number = 0;

  constructor() {
    super();
  }

  private async loadDriver(): Promise<void> {
    if (!this.pg) {
      try {
        this.pg = await import('pg');
      } catch (error) {
        throw new Error('PostgreSQL driver (pg) not installed. Run: npm install pg');
      }
    }
  }

  async connect(config: DatabaseConfig): Promise<DatabaseConnection> {
    await this.loadDriver();
    this.config = config;

    try {
      const connectionConfig: any = {
        host: config.host,
        port: config.port || 5432,
        database: config.database,
        user: config.username,
        password: config.password,
        connectionTimeoutMillis: config.connectionTimeout || 30000,
        statement_timeout: config.queryTimeout || 30000,
        ssl: config.ssl ? {
          rejectUnauthorized: config.sslOptions?.rejectUnauthorized !== false,
          ca: config.sslOptions?.ca,
          cert: config.sslOptions?.cert,
          key: config.sslOptions?.key,
          ...config.sslOptions
        } : undefined,
        ...config.additionalOptions
      };

      if (config.additionalOptions?.['connectionString']) {
        return new this.pg.Pool({
          connectionString: config.additionalOptions['connectionString'],
          ssl: connectionConfig.ssl,
          max: config.connectionPoolSize || config.additionalOptions?.['poolSize'] || 10,
          min: config.additionalOptions?.['poolMin'] || 0,
          idleTimeoutMillis: config.additionalOptions?.['poolIdleTimeout'] || 30000
        });
      }

      const poolSize = config.connectionPoolSize || config.additionalOptions?.['poolSize'];
      if (poolSize && poolSize > 1) {
        return new this.pg.Pool({
          ...connectionConfig,
          max: poolSize,
          min: config.additionalOptions?.['poolMin'] || 0,
          idleTimeoutMillis: config.additionalOptions?.['poolIdleTimeout'] || 30000
        });
      } else {
        const client = new this.pg.Client(connectionConfig);
        await client.connect();
        return client;
      }
    } catch (error) {
      throw this.parseConnectionError(error);
    }
  }

  async disconnect(connection: DatabaseConnection): Promise<void> {
    try {
      const conn = connection as any;
      
      this.preparedStatements.clear();
      
      if (conn.end) {
        await conn.end();
      } else if (conn.release) {
        conn.release();
      }
    } catch (error) {
      CSReporter.error('PostgreSQL disconnect error: ' + (error as Error).message);
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
    
    
    try {
      const startTime = Date.now();
      
      if (options?.timeout) {
        await this.setStatementTimeout(conn, options.timeout);
      }

      const result = await conn.query(sql, params || []);
      const executionTime = Date.now() - startTime;

      if (options?.timeout) {
        await this.resetStatementTimeout(conn);
      }

      return {
        rows: result.rows || [],
        rowCount: result.rowCount || 0,
        affectedRows: result.rowCount || 0,
        fields: result.fields?.map((field: any) => ({
          name: field.name,
          dataType: field.dataTypeID,
          tableID: field.tableID,
          columnID: field.columnID,
          dataTypeSize: field.dataTypeSize,
          dataTypeModifier: field.dataTypeModifier,
          format: field.format
        })) || [],
        command: result.command,
        duration: executionTime
      };
    } catch (error: any) {
      throw this.parseQueryError(error, sql);
    }
  }

  async executeStoredProcedure(
    connection: DatabaseConnection,
    procedureName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<QueryResult> {
    const paramPlaceholders = params ? 
      params.map((_, i) => `$${i + 1}`).join(', ') : '';
    const sql = `SELECT * FROM ${this.escapeIdentifier(procedureName)}(${paramPlaceholders})`;
    
    return this.query(connection, sql, params, options);
  }

  async executeFunction(
    connection: DatabaseConnection,
    functionName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<any> {
    const paramPlaceholders = params ? 
      params.map((_, i) => `$${i + 1}`).join(', ') : '';
    const sql = `SELECT ${this.escapeIdentifier(functionName)}(${paramPlaceholders}) AS result`;
    
    const result = await this.query(connection, sql, params, options);
    return result.rows[0]?.result;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    options?: TransactionOptions
  ): Promise<void> {
    let sql = 'BEGIN';
    
    if (options?.isolationLevel) {
      sql += ` ISOLATION LEVEL ${this.getIsolationLevelSQL(options.isolationLevel)}`;
    }
    
    if ((options as any)?.readOnly) {
      sql += ' READ ONLY';
    }
    
    if ((options as any)?.deferrable) {
      sql += ' DEFERRABLE';
    }

    await this.query(connection, sql);
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await this.query(connection, 'COMMIT');
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await this.query(connection, 'ROLLBACK');
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
    const statementName = `stmt_${++this.statementCounter}`;
    
    await conn.query(`PREPARE ${statementName} AS ${sql}`);
    
    this.preparedStatements.set(statementName, {
      name: statementName,
      sql,
      connection: conn
    });

    return {
      execute: async (params?: any[]) => {
        const paramPlaceholders = params ? 
          params.map((_, i) => `$${i + 1}`).join(', ') : '';
        const executeSQL = `EXECUTE ${statementName}(${paramPlaceholders})`;
        
        return this.query(conn, executeSQL, params);
      },
      close: async () => {
        await conn.query(`DEALLOCATE ${statementName}`);
        this.preparedStatements.delete(statementName);
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
    await this.query(connection, 'SELECT 1');
  }

  async getMetadata(connection: DatabaseConnection): Promise<DatabaseMetadata> {
    const versionResult = await this.query(connection, 'SELECT version()');
    const dbNameResult = await this.query(connection, 'SELECT current_database()');
    
    const extensionsResult = await this.query(connection, `
      SELECT extname, extversion 
      FROM pg_extension
    `);

    return {
      databaseName: dbNameResult.rows[0].current_database,
      serverType: 'postgresql',
      version: versionResult.rows[0].version,
      capabilities: {
        transactions: true,
        preparedStatements: true,
        storedProcedures: true,
        bulkInsert: true,
        streaming: true,
        savepoints: true,
        schemas: true,
        json: true,
        arrays: true
      },
      currentUser: this.config?.username || 'unknown',
      currentSchema: 'public',
      schemas: extensionsResult.rows.map((r: any) => r.extname)
    };
  }

  async getTableInfo(connection: DatabaseConnection, tableName: string): Promise<TableInfo> {
    const parts = tableName.split('.');
    const schemaName = parts.length > 1 ? parts[0] : 'public';
    const actualTableName = parts.length > 1 ? parts[1] : tableName;

    const columnsResult = await this.query(connection, `
      SELECT 
        c.column_name as name,
        c.data_type as type,
        c.character_maximum_length as length,
        c.numeric_precision as precision,
        c.numeric_scale as scale,
        c.is_nullable as nullable,
        c.column_default as default_value,
        c.is_identity as is_identity,
        c.is_generated as is_generated,
        pgd.description as comment
      FROM information_schema.columns c
      LEFT JOIN pg_catalog.pg_description pgd 
        ON pgd.objoid = (
          SELECT oid FROM pg_catalog.pg_class 
          WHERE relname = $2 AND relnamespace = (
            SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1
          )
        ) AND pgd.objsubid = c.ordinal_position
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `, [schemaName, actualTableName]);

    const constraintsResult = await this.query(connection, `
      SELECT 
        conname as name,
        CASE contype
          WHEN 'p' THEN 'PRIMARY KEY'
          WHEN 'f' THEN 'FOREIGN KEY'
          WHEN 'u' THEN 'UNIQUE'
          WHEN 'c' THEN 'CHECK'
          WHEN 'x' THEN 'EXCLUDE'
        END as type,
        pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = (
        SELECT oid FROM pg_class 
        WHERE relname = $2 AND relnamespace = (
          SELECT oid FROM pg_namespace WHERE nspname = $1
        )
      )
    `, [schemaName, actualTableName]);

    const indexResult = await this.query(connection, `
      SELECT 
        i.relname as index_name,
        idx.indisunique as is_unique,
        idx.indisprimary as is_primary,
        array_agg(a.attname ORDER BY array_position(idx.indkey, a.attnum)) as columns,
        pg_get_indexdef(idx.indexrelid) as definition
      FROM pg_index idx
      JOIN pg_class i ON i.oid = idx.indexrelid
      JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = ANY(idx.indkey)
      WHERE idx.indrelid = (
        SELECT oid FROM pg_class 
        WHERE relname = $2 AND relnamespace = (
          SELECT oid FROM pg_namespace WHERE nspname = $1
        )
      )
      GROUP BY i.relname, idx.indisunique, idx.indisprimary, idx.indexrelid
    `, [schemaName, actualTableName]);

    const rowCountResult = await this.query(connection, 
      `SELECT reltuples::BIGINT as estimate FROM pg_class WHERE relname = $1`,
      [actualTableName]
    );

    return {
      name: `${schemaName}.${actualTableName}`,
      type: 'table' as const,
      columns: columnsResult.rows.map((col, index) => ({
        name: col.name,
        ordinalPosition: index + 1,
        dataType: col.type,
        nullable: col.nullable === 'YES',
        defaultValue: col.default_value,
        maxLength: col.length,
        precision: col.precision,
        scale: col.scale,
        isPrimaryKey: false,
        isUnique: false,
        isAutoIncrement: col.is_identity === 'YES',
        isGenerated: col.is_generated !== 'NEVER',
        comment: col.comment
      })),
      constraints: constraintsResult.rows.map((con: any) => ({
        name: con.name,
        table: `${schemaName}.${actualTableName}`,
        type: con.type.toLowerCase().replace(' ', '_') as any,
        columns: [],
        definition: con.definition
      })),
      indexes: indexResult.rows.map((idx: any) => ({
        name: idx.index_name,
        table: `${schemaName}.${actualTableName}`,
        unique: idx.is_unique,
        columns: idx.columns,
        type: 'btree' as const
      })),
      rowCount: parseInt(rowCountResult.rows[0]?.estimate || '0'),
      schema: schemaName || 'public'
    };
  }

  async bulkInsert(
    connection: DatabaseConnection,
    table: string,
    data: any[]
  ): Promise<number> {
    if (data.length === 0) return 0;

    const conn = connection as any;
    const columns = Object.keys(data[0]);
    const columnNames = columns.map(col => this.escapeIdentifier(col)).join(', ');
    
    const copyStream = conn.query(
      `COPY ${this.escapeIdentifier(table)} (${columnNames}) FROM STDIN WITH (FORMAT CSV, HEADER false)`
    );

    return new Promise((resolve, reject) => {
      let rowCount = 0;
      
      copyStream.on('error', reject);
      copyStream.on('end', () => resolve(rowCount));
      
      data.forEach(row => {
        const values = columns.map(col => {
          const value = row[col];
          if (value === null || value === undefined) return '\\N';
          if (typeof value === 'string') {
            return `"${value.replace(/"/g, '""')}"`;
          }
          if (value instanceof Date) {
            return value.toISOString();
          }
          return String(value);
        });
        
        copyStream.write(values.join(',') + '\n');
        rowCount++;
      });
      
      copyStream.end();
    });
  }

  override async *stream(
    connection: DatabaseConnection,
    sql: string,
    params?: any[]
  ): AsyncGenerator<any, void, unknown> {
    const conn = connection as any;
    const queryStream = new this.pg.QueryStream(sql, params || []);
    const stream = conn.query(queryStream);
    
    for await (const row of stream) {
      yield row;
    }
  }

  private async setStatementTimeout(connection: any, timeout: number): Promise<void> {
    await connection.query(`SET statement_timeout = ${timeout}`);
  }

  private async resetStatementTimeout(connection: any): Promise<void> {
    await connection.query('SET statement_timeout = DEFAULT');
  }

  private parseQueryError(error: any, sql: string): Error {
    const message = `PostgreSQL Error: ${error.message}\nSQL: ${sql.substring(0, 200)}${sql.length > 200 ? '...' : ''}`;
    const enhancedError = new Error(message);
    
    Object.assign(enhancedError, {
      code: error.code,
      severity: error.severity,
      detail: error.detail,
      hint: error.hint,
      position: error.position,
      internalPosition: error.internalPosition,
      internalQuery: error.internalQuery,
      where: error.where,
      schema: error.schema,
      table: error.table,
      column: error.column,
      dataType: error.dataType,
      constraint: error.constraint,
      file: error.file,
      line: error.line,
      routine: error.routine,
      originalError: error,
      sql
    });

    return enhancedError;
  }

  override escapeIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  override async setSessionParameter(
    connection: DatabaseConnection,
    parameter: string,
    value: any
  ): Promise<void> {
    const sql = `SET ${this.escapeIdentifier(parameter)} = $1`;
    await this.query(connection, sql, [value]);
  }

  override async getServerInfo(connection: DatabaseConnection): Promise<any> {
    const result = await this.query(connection, `
      SELECT 
        current_setting('server_version') as version,
        current_setting('server_encoding') as encoding,
        current_setting('TimeZone') as timezone,
        current_setting('max_connections') as max_connections,
        pg_database_size(current_database()) as database_size,
        pg_size_pretty(pg_database_size(current_database())) as database_size_pretty
    `);

    const stats = await this.query(connection, `
      SELECT 
        numbackends as active_connections,
        xact_commit as transactions_committed,
        xact_rollback as transactions_rolled_back,
        blks_read as blocks_read,
        blks_hit as blocks_hit,
        tup_returned as tuples_returned,
        tup_fetched as tuples_fetched,
        tup_inserted as tuples_inserted,
        tup_updated as tuples_updated,
        tup_deleted as tuples_deleted
      FROM pg_stat_database
      WHERE datname = current_database()
    `);

    return {
      type: 'PostgreSQL',
      ...result.rows[0],
      stats: stats.rows[0],
      connected: true
    };
  }

  override async cancelQuery(connection: DatabaseConnection): Promise<void> {
    const conn = connection as any;
    
    const pidResult = await this.query(conn, 'SELECT pg_backend_pid()');
    const pid = pidResult.rows[0].pg_backend_pid;
    
    const cancelClient = new this.pg.Client(this.config);
    await cancelClient.connect();
    
    try {
      await cancelClient.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
      await cancelClient.end();
    }
  }
}
