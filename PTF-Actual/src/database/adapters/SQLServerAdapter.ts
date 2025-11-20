// src/database/adapters/SQLServerAdapter.ts

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
import * as mssql from 'mssql';

export class CSSQLServerAdapter extends CSDatabaseAdapter {
  private mssql!: typeof mssql;
  private connectionCounter: number = 0;

  constructor() {
    super();
  }

  private async loadDriver(): Promise<void> {
    if (!this.mssql) {
      try {
        const mssqlModule = await import('mssql');
        // Handle both ES modules and CommonJS modules
        this.mssql = (mssqlModule as any).default || mssqlModule;
      } catch (error) {
        throw new Error('SQL Server driver (mssql) not installed. Run: npm install mssql');
      }
    }
  }

  private wrapConnection(pool: any, config: DatabaseConfig): DatabaseConnection {
    return {
      id: `sqlserver-${++this.connectionCounter}`,
      type: 'sqlserver',
      instance: pool,
      config,
      connected: true,
      lastActivity: new Date(),
      inTransaction: false,
      transactionLevel: 0,
      savepoints: []
    };
  }

  private parseFields(recordset: any): Array<{ name: string; dataType: string }> {
    if (!recordset || !recordset.columns) return [];
    return Object.entries(recordset.columns).map(([name, info]: [string, any]) => ({
      name,
      dataType: this.mapSqlServerType(info.type)
    }));
  }

  private mapSqlServerType(type: any): string {
    if (!type || !type.name) return 'unknown';
    const typeName = type.name.toLowerCase();
    
    switch (typeName) {
      case 'int':
      case 'bigint':
      case 'smallint':
      case 'tinyint':
        return 'integer';
      case 'decimal':
      case 'numeric':
      case 'money':
      case 'smallmoney':
      case 'float':
      case 'real':
        return 'number';
      case 'bit':
        return 'boolean';
      case 'date':
      case 'datetime':
      case 'datetime2':
      case 'smalldatetime':
      case 'time':
        return 'date';
      case 'char':
      case 'varchar':
      case 'text':
      case 'nchar':
      case 'nvarchar':
      case 'ntext':
        return 'string';
      case 'binary':
      case 'varbinary':
      case 'image':
        return 'binary';
      case 'xml':
        return 'xml';
      case 'uniqueidentifier':
        return 'uuid';
      default:
        return typeName;
    }
  }

  async connect(config: DatabaseConfig): Promise<DatabaseConnection> {
    await this.loadDriver();
    this.config = config;

    try {
      // Check if Windows Authentication (Trusted Connection) is enabled
      const useTrustedConnection = config.additionalOptions?.['trustedConnection'] === true;

      // For Windows Authentication, use msnodesqlv8 driver DIRECTLY (not via mssql wrapper)
      if (useTrustedConnection && !config.username && !config.password) {
        CSReporter.info('[SQLServer] Using Windows Integrated Authentication with msnodesqlv8 driver');

        // Load msnodesqlv8 driver DIRECTLY for Windows Authentication
        // The mssql wrapper doesn't properly pass connection strings to msnodesqlv8
        let msnodesqlv8Direct;
        try {
          msnodesqlv8Direct = await import('msnodesqlv8');
          // Handle both ES modules and CommonJS modules
          const sql = (msnodesqlv8Direct as any).default || msnodesqlv8Direct;

          // Also load regular mssql for type compatibility
          await this.loadDriver();
        } catch (error) {
          throw new Error(
            'Windows Integrated Authentication requires msnodesqlv8 driver. ' +
            'Run: npm install msnodesqlv8'
          );
        }

        // Determine ODBC driver to use
        // Priority: ODBC Driver 17 > ODBC Driver 18 > SQL Server
        // Driver 17 is more commonly available on corporate VDIs
        const driver = config.additionalOptions?.['odbcDriver'] || 'ODBC Driver 17 for SQL Server';

        // Build connection string for Windows Authentication
        // CRITICAL: Trusted_Connection must be lowercase 'yes' - this is the ONLY recognized value
        const connString =
          `Driver={${driver}};` +
          `Server=${config.host}${config.port && config.port !== 1433 ? `,${config.port}` : ''};` +
          `Database=${config.database};` +
          `Trusted_Connection=yes;` +
          `Encrypt=${config.ssl !== false ? 'yes' : 'no'};` +
          `TrustServerCertificate=${config.additionalOptions?.['trustServerCertificate'] !== false ? 'yes' : 'no'};`;

        CSReporter.info(`[SQLServer] Connection String: Driver={${driver}};Server=${config.host};Database=${config.database};Trusted_Connection=yes`);

        // Use direct msnodesqlv8 with callback-based API and promisify it
        try {
          const sql = (msnodesqlv8Direct as any).default || msnodesqlv8Direct;

          // Create a connection using direct msnodesqlv8
          const connection: any = await new Promise((resolve, reject) => {
            sql.open(connString, (err: any, conn: any) => {
              if (err) {
                reject(err);
              } else {
                resolve(conn);
              }
            });
          });

          CSReporter.info('[SQLServer] Successfully connected using Windows Authentication (direct msnodesqlv8)');

          // Wrap the direct connection in our standard format
          return {
            id: `sqlserver-${++this.connectionCounter}`,
            type: 'sqlserver',
            instance: connection,
            config,
            connected: true,
            lastActivity: new Date(),
            inTransaction: false,
            transactionLevel: 0,
            savepoints: [],
            // Add metadata to identify this as a direct msnodesqlv8 connection
            _isDirect: true,
            _sql: sql
          } as DatabaseConnection;
        } catch (error: any) {
          // Log full error details for debugging - msnodesqlv8 errors have special structure
          CSReporter.error(`[SQLServer] ========== CONNECTION ERROR DEBUG ==========`);
          CSReporter.error(`[SQLServer] Error type: ${typeof error}`);
          CSReporter.error(`[SQLServer] Error constructor: ${error?.constructor?.name}`);
          CSReporter.error(`[SQLServer] Error.message: ${error?.message}`);
          CSReporter.error(`[SQLServer] Error.code: ${error?.code}`);
          CSReporter.error(`[SQLServer] Error.name: ${error?.name}`);
          CSReporter.error(`[SQLServer] Error.sqlstate: ${error?.sqlstate}`);
          CSReporter.error(`[SQLServer] Error.toString(): ${error?.toString()}`);

          // Try to get all enumerable properties
          if (error && typeof error === 'object') {
            const allKeys = Object.keys(error);
            CSReporter.error(`[SQLServer] Error keys: ${allKeys.join(', ')}`);
            allKeys.forEach(key => {
              try {
                CSReporter.error(`[SQLServer] Error.${key}: ${error[key]}`);
              } catch (e) {
                CSReporter.error(`[SQLServer] Error.${key}: <unable to stringify>`);
              }
            });
          }

          // Try JSON.stringify with replacer function
          try {
            const errorStr = JSON.stringify(error, Object.getOwnPropertyNames(error), 2);
            CSReporter.error(`[SQLServer] Full error (JSON): ${errorStr}`);
          } catch (e) {
            CSReporter.error(`[SQLServer] Cannot JSON.stringify error`);
          }

          CSReporter.error(`[SQLServer] ========== END ERROR DEBUG ==========`);

          // Check if this is a driver-related error (try alternatives)
          // Check both error.message and error.originalError
          const errorMessage = error.message || '';
          const originalErrorMessage = error.originalError?.message || '';

          const isDriverError =
            errorMessage.includes('system error 126') ||
            errorMessage.includes('Data source name not found') ||
            errorMessage.includes('IM002') ||  // ODBC error for driver not found
            originalErrorMessage.includes('system error 126') ||
            originalErrorMessage.includes('Data source name not found') ||
            originalErrorMessage.includes('IM002');

          if (isDriverError) {
            CSReporter.warn(`[SQLServer] Driver '${driver}' not available, trying alternatives...`);

            const alternativeDrivers = [
              'ODBC Driver 17 for SQL Server',
              'ODBC Driver 18 for SQL Server',
              'SQL Server',
              'ODBC Driver 13 for SQL Server',
              'SQL Server Native Client 11.0'
            ];

            for (const altDriver of alternativeDrivers) {
              if (altDriver === driver) continue; // Skip already tried driver

              try {
                CSReporter.info(`[SQLServer] Trying driver: ${altDriver}`);
                const altConnString = connString.replace(`Driver={${driver}}`, `Driver={${altDriver}}`);
                const pool = new this.mssql.ConnectionPool(altConnString);
                await pool.connect();
                CSReporter.info(`[SQLServer] Successfully connected using driver: ${altDriver}`);
                return this.wrapConnection(pool, config);
              } catch (altError: any) {
                CSReporter.debug(`[SQLServer] Driver '${altDriver}' failed: ${altError.message || altError.toString()}`);
              }
            }

            // If all drivers failed, throw helpful error
            throw new Error(
              'No compatible ODBC driver found for Windows Authentication. ' +
              'Please install "ODBC Driver 17 for SQL Server" or "ODBC Driver 18 for SQL Server". ' +
              'Download from: https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server'
            );
          }

          // Re-throw with better error message
          const errorMsg = error.message || error.toString() || JSON.stringify(error);
          throw new Error(`SQL Server connection failed: ${errorMsg}`);
        }
      }

      // For SQL Authentication or NTLM with credentials, use standard tedious driver
      const connectionConfig: any = {
        server: config.host,
        port: config.port || 1433,
        database: config.database,
        options: {
          encrypt: config.ssl !== false,
          trustServerCertificate: config.additionalOptions?.['trustServerCertificate'] !== false,
          connectTimeout: config.connectionTimeout || 30000,
          requestTimeout: config.queryTimeout || 30000,
          ...config.additionalOptions
        },
        pool: {
          max: config.connectionPoolSize || config.additionalOptions?.['poolSize'] || 10,
          min: config.additionalOptions?.['poolMin'] || 0,
          idleTimeoutMillis: config.additionalOptions?.['poolIdleTimeout'] || 30000
        }
      };

      // Configure authentication method
      if (useTrustedConnection && (config.username || config.password)) {
        // NTLM authentication with explicitly provided domain credentials
        const userParts = config.username ? config.username.split('\\') : ['', ''];
        const domain = userParts.length > 1 ? userParts[0] : '';
        const userName = userParts.length > 1 ? userParts[1] : (config.username || '');

        CSReporter.info(`[SQLServer] Using NTLM Auth with credentials: ${domain}\\${userName}`);

        connectionConfig.authentication = {
          type: 'ntlm',
          options: {
            domain: domain || '',
            userName: userName,
            password: config.password || ''
          }
        };
        // Remove trustedConnection from options as we're using authentication object
        delete connectionConfig.options.trustedConnection;
      } else {
        // SQL Authentication - use username and password
        CSReporter.info(`[SQLServer] Using SQL Authentication: ${config.username}`);
        connectionConfig.user = config.username;
        connectionConfig.password = config.password;
      }

      if (config.additionalOptions?.['connectionString']) {
        const pool = new this.mssql.ConnectionPool(config.additionalOptions['connectionString']);
        await pool.connect();
        return this.wrapConnection(pool, config);
      }

      const pool = new this.mssql.ConnectionPool(connectionConfig);
      await pool.connect();

      return this.wrapConnection(pool, config);
    } catch (error) {
      throw this.parseConnectionError(error);
    }
  }

  async disconnect(connection: DatabaseConnection): Promise<void> {
    try {
      const conn = connection.instance as any;

      // Check if this is a direct msnodesqlv8 connection
      if ((connection as any)._isDirect) {
        // Direct msnodesqlv8 uses close() method
        await new Promise<void>((resolve, reject) => {
          conn.close((err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } else {
        // Standard mssql pool
        await conn.close();
      }
    } catch (error) {
      CSReporter.error('SQL Server disconnect error: ' + (error as Error).message);
      throw error;
    }
  }

  async query(
    connection: DatabaseConnection,
    sql: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<QueryResult> {
    const conn = connection.instance as any;

    // Check if this is a direct msnodesqlv8 connection
    if ((connection as any)._isDirect) {
      // Use direct msnodesqlv8 query method
      return this.queryDirect(connection, sql, params, options);
    }

    // Use transaction request if transaction is active, otherwise use pool request
    const request = conn._transaction
      ? conn._transaction.request()
      : conn.request();

    if (options?.timeout) {
      request.timeout = options.timeout;
    }

    if (params && params.length > 0) {
      params.forEach((param, index) => {
        const paramName = `p${index}`;
        if (param === null || param === undefined) {
          request.input(paramName, this.mssql.NVarChar, null);
        } else if (typeof param === 'number') {
          if (Number.isInteger(param)) {
            request.input(paramName, this.mssql.Int, param);
          } else {
            request.input(paramName, this.mssql.Float, param);
          }
        } else if (typeof param === 'boolean') {
          request.input(paramName, this.mssql.Bit, param);
        } else if (param instanceof Date) {
          request.input(paramName, this.mssql.DateTime2, param);
        } else if (Buffer.isBuffer(param)) {
          request.input(paramName, this.mssql.VarBinary, param);
        } else {
          request.input(paramName, this.mssql.NVarChar, String(param));
        }
      });

      sql = sql.replace(/\?/g, (_match, offset, string) => {
        const index = string.substring(0, offset).split('?').length - 1;
        return `@p${index}`;
      });
    }

    try {
      const startTime = Date.now();
      const result = await request.query(sql);
      const executionTime = Date.now() - startTime;

      return {
        rows: result.recordset || [],
        rowCount: result.rowsAffected ? result.rowsAffected[0] : result.recordset?.length || 0,
        affectedRows: result.rowsAffected ? result.rowsAffected[0] : 0,
        fields: this.parseFields(result.recordset),
        duration: executionTime,
        command: sql ? (sql.split(' ')[0] || 'QUERY').toUpperCase() : 'QUERY'
      };
    } catch (error: any) {
      throw this.parseQueryError(error, sql);
    }
  }

  private async queryDirect(
    connection: DatabaseConnection,
    sql: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<QueryResult> {
    const conn = connection.instance as any;
    const startTime = Date.now();

    // Replace ? placeholders with actual parameters for msnodesqlv8
    let finalSql = sql;
    if (params && params.length > 0) {
      let paramIndex = 0;
      finalSql = sql.replace(/\?/g, () => {
        if (paramIndex >= params.length) {
          throw new Error(`Not enough parameters: expected at least ${paramIndex + 1}, got ${params.length}`);
        }
        const param = params[paramIndex++];

        // Convert parameter to SQL literal
        if (param === null || param === undefined) {
          return 'NULL';
        } else if (typeof param === 'number') {
          return String(param);
        } else if (typeof param === 'boolean') {
          return param ? '1' : '0';
        } else if (param instanceof Date) {
          return `'${param.toISOString()}'`;
        } else {
          // String: escape single quotes and wrap in quotes
          return `'${String(param).replace(/'/g, "''")}'`;
        }
      });

      CSReporter.debug(`[queryDirect] Original SQL: ${sql}`);
      CSReporter.debug(`[queryDirect] Final SQL with params: ${finalSql}`);
    }

    return new Promise((resolve, reject) => {
      conn.query(finalSql, (err: any, rows: any[]) => {
        if (err) {
          reject(this.parseQueryError(err, finalSql));
        } else {
          const executionTime = Date.now() - startTime;
          resolve({
            rows: rows || [],
            rowCount: rows?.length || 0,
            affectedRows: rows?.length || 0,
            fields: rows && rows.length > 0 ? Object.keys(rows[0]).map(name => ({ name, dataType: 'string' })) : [],
            duration: executionTime,
            command: sql ? (sql.trim().split(' ')[0] || 'QUERY').toUpperCase() : 'QUERY'
          });
        }
      });
    });
  }

  async executeStoredProcedure(
    connection: DatabaseConnection,
    procedureName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<QueryResult> {
    const pool = connection.instance as any;

    // Use transaction request if transaction is active, otherwise use pool request
    const request = pool._transaction
      ? pool._transaction.request()
      : pool.request();

    if (options?.timeout) {
      request.timeout = options.timeout;
    }

    // Add parameters to request
    if (params && params.length > 0) {
      params.forEach((param, index) => {
        if (param && typeof param === 'object' && param.name) {
          this.addParameter(request, param.name, param.value, param.output);
        } else {
          this.addParameter(request, `param${index}`, param);
        }
      });
    }

    // Build EXEC statement with parameter names
    const paramNames = Object.keys(request.parameters || {});
    const execStatement = paramNames.length > 0
      ? `EXEC ${procedureName} ${paramNames.map(p => '@' + p).join(', ')}`
      : `EXEC ${procedureName}`;

    try {
      const startTime = Date.now();
      const result = await request.query(execStatement);
      const executionTime = Date.now() - startTime;

      // Determine row count and rows to return
      let rowCount = 0;
      let rows = result.recordset || [];

      // Check for multiple recordsets (use the last one)
      if (result.recordsets && Array.isArray(result.recordsets) && result.recordsets.length > 0) {
        rows = result.recordsets[result.recordsets.length - 1] || [];
      }

      // Calculate row count from rowsAffected array
      if (result.rowsAffected && Array.isArray(result.rowsAffected)) {
        rowCount = result.rowsAffected.reduce((sum: number, count: number) => sum + (count || 0), 0);
      }

      // If no rows affected but we have a recordset, use recordset length
      if (rowCount === 0 && rows.length > 0) {
        rowCount = rows.length;
      }

      return {
        rows: rows,
        rowCount: rowCount,
        affectedRows: rowCount,
        output: result.output || {},
        returnValue: result.returnValue,
        duration: executionTime,
        fields: this.parseFields(rows),
        command: 'EXEC'
      };
    } catch (error: any) {
      throw this.parseQueryError(error, `EXEC ${procedureName}`);
    }
  }

  async executeFunction(
    connection: DatabaseConnection,
    functionName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<any> {
    const paramPlaceholders = params ? params.map((_, i) => `@p${i}`).join(', ') : '';
    const sql = `SELECT dbo.${functionName}(${paramPlaceholders}) AS result`;
    
    const result = await this.query(connection, sql, params, options);
    return result.rows[0]?.result;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    options?: TransactionOptions
  ): Promise<void> {
    const pool = connection.instance as any;
    const transaction = pool.transaction();

    if (options?.isolationLevel) {
      transaction.isolationLevel = this.getIsolationLevel(options.isolationLevel);
    }

    await transaction.begin();
    (connection.instance as any)._transaction = transaction;
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const transaction = (connection.instance as any)._transaction;
    if (!transaction) {
      throw new Error('No active transaction');
    }

    await transaction.commit();
    delete (connection.instance as any)._transaction;
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const transaction = (connection.instance as any)._transaction;
    if (!transaction) {
      throw new Error('No active transaction');
    }

    await transaction.rollback();
    delete (connection.instance as any)._transaction;
  }

  async createSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.query(connection, `SAVE TRANSACTION ${this.escapeIdentifier(name)}`);
  }

  override async releaseSavepoint(_connection: DatabaseConnection, _name: string): Promise<void> {
  }

  async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.query(connection, `ROLLBACK TRANSACTION ${this.escapeIdentifier(name)}`);
  }

  async prepare(connection: DatabaseConnection, sql: string): Promise<PreparedStatement> {
    const pool = connection.instance as any;
    const ps = new this.mssql.PreparedStatement(pool);
    
    const paramMatches = sql.match(/@\w+/g);
    if (paramMatches) {
      paramMatches.forEach(param => {
        ps.input(param.substring(1), this.mssql.NVarChar);
      });
    }

    await ps.prepare(sql);
    
    const preparedStatement: PreparedStatement = {
      id: `ps_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      query: sql,
      paramCount: paramMatches ? paramMatches.length : 0,
      execute: async (params?: any[]) => {
        const paramObject: any = {};
        if (params && paramMatches) {
          paramMatches.forEach((param, index) => {
            if (index < params.length) {
              paramObject[param.substring(1)] = params[index];
            }
          });
        }
        const result = await ps.execute(paramObject);
        return {
          rows: result.recordset || [],
          rowCount: result.rowsAffected?.[0] ?? result.recordset?.length ?? 0,
          affectedRows: result.rowsAffected?.[0] ?? 0,
          fields: this.parseFields(result.recordset),
          duration: 0,
          command: 'EXECUTE'
        };
      },
      close: async () => {
        await ps.unprepare();
      }
    };
    
    return preparedStatement;
  }

  async executePrepared(
    statement: PreparedStatement,
    params?: any[]
  ): Promise<QueryResult> {
    return statement.execute(params);
  }

  async ping(connection: DatabaseConnection): Promise<void> {
    await this.query(connection, 'SELECT 1');
  }

  async getMetadata(connection: DatabaseConnection): Promise<DatabaseMetadata> {
    const versionResult = await this.query(connection, 'SELECT @@VERSION AS version');
    const dbNameResult = await this.query(connection, 'SELECT DB_NAME() AS dbname');
    

    return {
      databaseName: dbNameResult.rows[0].dbname,
      version: versionResult.rows[0].version,
      serverType: 'sqlserver',
      capabilities: {
        transactions: true,
        preparedStatements: true,
        storedProcedures: true,
        bulkInsert: true,
        streaming: false,
        savepoints: true,
        schemas: true,
        json: true,
        arrays: false
      },
      characterSet: 'UTF-8',
      collation: 'SQL_Latin1_General_CP1_CI_AS',
      timezone: 'UTC',
      currentUser: this.config?.username || 'unknown',
      currentSchema: 'dbo'
    };
  }

  async getTableInfo(connection: DatabaseConnection, tableName: string): Promise<TableInfo> {
    const columnsResult = await this.query(connection, `
      SELECT 
        COLUMN_NAME as name,
        DATA_TYPE as type,
        CHARACTER_MAXIMUM_LENGTH as length,
        NUMERIC_PRECISION as precision,
        NUMERIC_SCALE as scale,
        IS_NULLABLE as nullable,
        COLUMN_DEFAULT as defaultValue
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @p0
      ORDER BY ORDINAL_POSITION
    `, [tableName]);

    const constraintsResult = await this.query(connection, `
      SELECT 
        CONSTRAINT_NAME as name,
        CONSTRAINT_TYPE as type
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_NAME = @p0
    `, [tableName]);

    const indexResult = await this.query(connection, `
      SELECT 
        i.name as indexName,
        i.type_desc as type,
        i.is_unique as isUnique,
        i.is_primary_key as isPrimary
      FROM sys.indexes i
      INNER JOIN sys.tables t ON i.object_id = t.object_id
      WHERE t.name = @p0 AND i.type > 0
    `, [tableName]);

    return {
      name: tableName,
      type: 'table' as const,
      columns: columnsResult.rows.map((col: any, index: number) => ({
        name: col.name,
        ordinalPosition: index + 1,
        dataType: col.type,
        nullable: col.nullable === 'YES',
        defaultValue: col.defaultValue,
        maxLength: col.length,
        precision: col.precision,
        scale: col.scale,
        isPrimaryKey: false,
        isUnique: false,
        isAutoIncrement: false
      })),
      constraints: constraintsResult.rows.map((con: any) => ({
        name: con.name,
        table: tableName,
        type: con.type.toLowerCase().replace(' ', '_') as any,
        columns: [],
        definition: con.type
      })),
      indexes: indexResult.rows.map((idx: any) => ({
        name: idx.indexName,
        table: tableName,
        unique: idx.isUnique,
        columns: [],
        type: idx.type as any
      })),
      rowCount: await this.getTableRowCount(connection, tableName),
      schema: 'dbo'
    };
  }

  async bulkInsert(
    connection: DatabaseConnection,
    table: string,
    data: any[]
  ): Promise<number> {
    if (data.length === 0) return 0;

    const pool = connection.instance as any;
    const tableObj = new this.mssql.Table(table);
    
    const columns = Object.keys(data[0]);
    
    columns.forEach(col => {
      const sampleValue = data[0][col];
      
      if (sampleValue === null || sampleValue === undefined) {
        tableObj.columns.add(col, this.mssql.NVarChar, { nullable: true });
      } else if (typeof sampleValue === 'number') {
        if (Number.isInteger(sampleValue)) {
          tableObj.columns.add(col, this.mssql.Int);
        } else {
          tableObj.columns.add(col, this.mssql.Float);
        }
      } else if (typeof sampleValue === 'boolean') {
        tableObj.columns.add(col, this.mssql.Bit);
      } else if (sampleValue instanceof Date) {
        tableObj.columns.add(col, this.mssql.DateTime2);
      } else {
        tableObj.columns.add(col, this.mssql.NVarChar);
      }
    });

    data.forEach(row => {
      const values = columns.map(col => row[col]);
      tableObj.rows.add(...values);
    });

    const request = pool.request();
    const result = await request.bulk(tableObj);
    
    return result.rowsAffected;
  }

  private getIsolationLevel(level: string): any {
    switch (level.toUpperCase()) {
      case 'READ_UNCOMMITTED':
        return this.mssql.ISOLATION_LEVEL.READ_UNCOMMITTED;
      case 'READ_COMMITTED':
        return this.mssql.ISOLATION_LEVEL.READ_COMMITTED;
      case 'REPEATABLE_READ':
        return this.mssql.ISOLATION_LEVEL.REPEATABLE_READ;
      case 'SERIALIZABLE':
        return this.mssql.ISOLATION_LEVEL.SERIALIZABLE;
      case 'SNAPSHOT':
        return this.mssql.ISOLATION_LEVEL.SNAPSHOT;
      default:
        return this.mssql.ISOLATION_LEVEL.READ_COMMITTED;
    }
  }

  private addParameter(request: any, name: string, value: any, output: boolean = false): void {
    // Strip @ prefix if present - mssql expects parameter names without @
    const cleanName = name.startsWith('@') ? name.substring(1) : name;
    const method = output ? 'output' : 'input';

    if (value === null || value === undefined) {
      request[method](cleanName, this.mssql.NVarChar, null);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        request[method](cleanName, this.mssql.Int, value);
      } else {
        request[method](cleanName, this.mssql.Float, value);
      }
    } else if (typeof value === 'boolean') {
      request[method](cleanName, this.mssql.Bit, value);
    } else if (value instanceof Date) {
      request[method](cleanName, this.mssql.DateTime2, value);
    } else if (Buffer.isBuffer(value)) {
      request[method](cleanName, this.mssql.VarBinary, value);
    } else {
      request[method](cleanName, this.mssql.NVarChar, String(value));
    }
  }

  private async getTableRowCount(connection: DatabaseConnection, tableName: string): Promise<number> {
    const result = await this.query(
      connection, 
      `SELECT COUNT(*) as count FROM ${this.escapeIdentifier(tableName)}`
    );
    return result.rows[0].count;
  }

  private parseQueryError(error: any, sql: string): Error {
    const message = `SQL Server Error: ${error.message}\nSQL: ${sql.substring(0, 200)}${sql.length > 200 ? '...' : ''}`;
    const enhancedError = new Error(message);
    
    Object.assign(enhancedError, {
      code: error.code,
      number: error.number,
      state: error.state,
      class: error.class,
      lineNumber: error.lineNumber,
      procedure: error.procName,
      originalError: error,
      sql
    });

    return enhancedError;
  }

  override escapeIdentifier(identifier: string): string {
    return `[${identifier.replace(/]/g, ']]')}]`;
  }
}
