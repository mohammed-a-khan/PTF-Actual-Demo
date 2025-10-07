// src/database/adapters/OracleAdapter.ts

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
import * as oracledb from 'oracledb';

export class CSOracleAdapter extends CSDatabaseAdapter {
  private oracledb!: typeof oracledb;
  private autoCommit: boolean = false;
  private connectionCounter: number = 0;

  constructor() {
    super();
  }

  private async loadDriver(): Promise<void> {
    if (!this.oracledb) {
      try {
        const oracleModule = await import('oracledb');
        this.oracledb = oracleModule;
        
        this.oracledb.outFormat = this.oracledb.OUT_FORMAT_OBJECT;
        this.oracledb.fetchAsString = [this.oracledb.CLOB];
        this.oracledb.autoCommit = false;
      } catch (error) {
        throw new Error('Oracle driver (oracledb) not installed. Run: npm install oracledb');
      }
    }
  }

  async connect(config: DatabaseConfig): Promise<DatabaseConnection> {
    await this.loadDriver();
    this.config = config;

    try {
      const connectionConfig: any = {
        user: config.username,
        password: config.password,
        connectString: config.additionalOptions?.['connectionString'] || `${config.host}:${config.port || 1521}/${config.database}`,
        poolMin: config.additionalOptions?.['poolMin'] || 0,
        poolMax: config.connectionPoolSize || config.additionalOptions?.['poolSize'] || 10,
        poolIncrement: 1,
        poolTimeout: config.additionalOptions?.['poolIdleTimeout'] ? config.additionalOptions['poolIdleTimeout'] / 1000 : 60,
        queueTimeout: config.connectionTimeout || 30000,
        ...config.additionalOptions
      };

      if (config.additionalOptions?.['walletDir']) {
        connectionConfig.walletLocation = config.additionalOptions['walletDir'];
        connectionConfig.walletPassword = config.additionalOptions['walletPassword'];
      }

      const poolSize = config.connectionPoolSize || config.additionalOptions?.['poolSize'];
      if (poolSize && poolSize > 1) {
        const pool = await this.oracledb.createPool(connectionConfig);
        return this.wrapConnection(pool, config, true);
      } else {
        const connection = await this.oracledb.getConnection(connectionConfig);
        return this.wrapConnection(connection, config, false);
      }
    } catch (error) {
      throw this.parseConnectionError(error);
    }
  }

  async disconnect(connection: DatabaseConnection): Promise<void> {
    try {
      const conn = connection as any;
      
      if (conn.close) {
        await conn.close();
      } else if (conn.terminate) {
        await conn.terminate();
      }
    } catch (error) {
      CSReporter.error('Oracle disconnect error: ' + (error as Error).message);
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
      let oracleSql = sql;
      let bindParams: any = {};
      
      if (params && params.length > 0) {
        let paramIndex = 0;
        oracleSql = sql.replace(/\?/g, () => {
          const bindName = `${++paramIndex}`;
          bindParams[bindName] = params[paramIndex - 1];
          return `:${bindName}`;
        });
      }

      const queryOptions: any = {
        autoCommit: this.autoCommit,
        outFormat: this.oracledb.OUT_FORMAT_OBJECT
      };

      if (options?.timeout) {
        queryOptions.timeout = options.timeout / 1000;
      }

      const startTime = Date.now();
      const result = await queryConn.execute(oracleSql, bindParams, queryOptions);
      const executionTime = Date.now() - startTime;

      let queryResult: QueryResult;
      
      if (result.rows !== undefined) {
        queryResult = {
          rows: result.rows || [],
          rowCount: result.rows ? result.rows.length : 0,
          fields: this.parseMetadata(result.metaData || []),
          duration: executionTime,
          command: sql.trim().split(' ')[0]?.toUpperCase() || 'UNKNOWN',
          metadata: result.metaData
        };
      } else {
        queryResult = {
          rows: [],
          rowCount: result.rowsAffected || 0,
          fields: [],
          duration: executionTime,
          affectedRows: result.rowsAffected || 0,
          command: sql.trim().split(' ')[0]?.toUpperCase() || 'UNKNOWN'
        };
      }

      if (result['implicitResults']) {
        queryResult['implicitResults'] = [];
        for (const resultSet of result['implicitResults']) {
          const rows = [];
          let row;
          while ((row = await resultSet.getRow())) {
            rows.push(row);
          }
          queryResult['implicitResults'].push(rows);
        }
      }

      return queryResult;
    } catch (error: any) {
      throw this.parseQueryError(error, sql);
    } finally {
      if (isPool) {
        await queryConn.close();
      }
    }
  }

  async executeStoredProcedure(
    connection: DatabaseConnection,
    procedureName: string,
    params?: any[]
  ): Promise<QueryResult> {
    const conn = connection as any;
    const isPool = conn.getConnection !== undefined;
    const procConn = isPool ? await conn.getConnection() : conn;

    try {
      const bindVars: any = {};
      const paramList: string[] = [];
      
      if (params && params.length > 0) {
        params.forEach((param, index) => {
          const bindName = `p${index + 1}`;
          
          if (param && typeof param === 'object' && param.dir) {
            bindVars[bindName] = {
              dir: this.getBindDirection(param.dir),
              type: param.type || this.oracledb.STRING,
              maxSize: param.maxSize || 4000,
              val: param.val
            };
          } else {
            bindVars[bindName] = param;
          }
          
          paramList.push(`:${bindName}`);
        });
      }

      const sql = `BEGIN ${procedureName}(${paramList.join(', ')}); END;`;
      
      const result = await procConn.execute(sql, bindVars, {
        autoCommit: this.autoCommit
      });

      const output: any = {};
      Object.keys(bindVars).forEach(key => {
        if (bindVars[key].dir && bindVars[key].dir !== this.oracledb.BIND_IN) {
          output[key] = result.outBinds[key];
        }
      });

      return {
        rows: [],
        rowCount: 0,
        fields: [],
        command: 'CALL',
        duration: 0,
        output
      };
    } finally {
      if (isPool) {
        await procConn.close();
      }
    }
  }

  async executeFunction(
    connection: DatabaseConnection,
    functionName: string,
    params?: any[],
    options?: QueryOptions
  ): Promise<any> {
    const bindVars: any = {
      result: { dir: this.oracledb.BIND_OUT, type: this.oracledb.STRING, maxSize: 4000 }
    };
    
    const paramList: string[] = [];
    if (params && params.length > 0) {
      params.forEach((param, index) => {
        const bindName = `p${index + 1}`;
        bindVars[bindName] = param;
        paramList.push(`:${bindName}`);
      });
    }

    const sql = `BEGIN :result := ${functionName}(${paramList.join(', ')}); END;`;
    const result = await this.query(connection, sql, bindVars, options);
    
    return result['output']?.result;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    options?: TransactionOptions
  ): Promise<void> {
    this.autoCommit = false;
    
    if (options?.isolationLevel) {
      const level = this.getOracleIsolationLevel(options.isolationLevel);
      await this.query(connection, `SET TRANSACTION ISOLATION LEVEL ${level}`);
    }

    if ((options as any)?.readOnly) {
      await this.query(connection, 'SET TRANSACTION READ ONLY');
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as any;
    
    if (conn.commit) {
      await conn.commit();
    } else {
      const commitConn = await conn.getConnection();
      try {
        await commitConn.commit();
      } finally {
        await commitConn.close();
      }
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as any;
    
    if (conn.rollback) {
      await conn.rollback();
    } else {
      const rollbackConn = await conn.getConnection();
      try {
        await rollbackConn.rollback();
      } finally {
        await rollbackConn.close();
      }
    }
  }

  async createSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.query(connection, `SAVEPOINT ${this.escapeIdentifier(name)}`);
  }

  async releaseSavepoint(_connection: DatabaseConnection, _name: string): Promise<void> {
  }

  async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await this.query(connection, `ROLLBACK TO ${this.escapeIdentifier(name)}`);
  }

  async prepare(connection: DatabaseConnection, sql: string): Promise<PreparedStatement> {
    const preparedSql = sql;
    const conn = connection;

    return {
      execute: async (params?: any[]) => {
        return this.query(conn, preparedSql, params);
      },
      close: async () => {
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
    await this.query(connection, 'SELECT 1 FROM DUAL');
  }

  async getMetadata(connection: DatabaseConnection): Promise<DatabaseMetadata> {
    const versionResult = await this.query(connection, `
      SELECT 
        BANNER as version
      FROM V$VERSION 
      WHERE BANNER LIKE 'Oracle%'
    `);

    const dbNameResult = await this.query(connection, `
      SELECT 
        SYS_CONTEXT('USERENV', 'DB_NAME') as dbname,
        SYS_CONTEXT('USERENV', 'INSTANCE_NAME') as instance
      FROM DUAL
    `);

    return {
      databaseName: dbNameResult.rows[0].DBNAME,
      serverType: 'oracle',
      version: versionResult.rows[0].VERSION,
      capabilities: {
        transactions: true,
        preparedStatements: true,
        storedProcedures: true,
        bulkInsert: true,
        streaming: true,
        savepoints: true,
        schemas: true,
        json: true,
        arrays: false
      },
      currentUser: this.config?.username || 'unknown',
      currentSchema: dbNameResult.rows[0].DBNAME
    };
  }

  async getTableInfo(connection: DatabaseConnection, tableName: string): Promise<TableInfo> {
    const upperTableName = tableName.toUpperCase();
    
    const columnsResult = await this.query(connection, `
      SELECT 
        COLUMN_NAME as name,
        DATA_TYPE as type,
        DATA_LENGTH as length,
        DATA_PRECISION as precision,
        DATA_SCALE as scale,
        NULLABLE as nullable,
        DATA_DEFAULT as default_value,
        COLUMN_ID as position
      FROM USER_TAB_COLUMNS
      WHERE TABLE_NAME = :1
      ORDER BY COLUMN_ID
    `, [upperTableName]);

    const constraintsResult = await this.query(connection, `
      SELECT 
        CONSTRAINT_NAME as name,
        CONSTRAINT_TYPE as type,
        SEARCH_CONDITION as condition,
        R_CONSTRAINT_NAME as r_constraint
      FROM USER_CONSTRAINTS
      WHERE TABLE_NAME = :1
    `, [upperTableName]);

    const indexResult = await this.query(connection, `
      SELECT 
        ui.INDEX_NAME as index_name,
        ui.UNIQUENESS as uniqueness,
        LISTAGG(uic.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY uic.COLUMN_POSITION) as columns
      FROM USER_INDEXES ui
      JOIN USER_IND_COLUMNS uic ON ui.INDEX_NAME = uic.INDEX_NAME
      WHERE ui.TABLE_NAME = :1
      GROUP BY ui.INDEX_NAME, ui.UNIQUENESS
    `, [upperTableName]);

    const rowCountResult = await this.query(connection, 
      `SELECT NUM_ROWS as count FROM USER_TABLES WHERE TABLE_NAME = :1`,
      [upperTableName]
    );

    return {
      name: upperTableName,
      type: 'table' as const,
      columns: columnsResult.rows.map(col => ({
        name: col.NAME,
        ordinalPosition: col.POSITION,
        dataType: col.TYPE,
        nullable: col.NULLABLE === 'Y',
        defaultValue: col.DEFAULT_VALUE,
        maxLength: col.LENGTH,
        precision: col.PRECISION,
        scale: col.SCALE,
        isPrimaryKey: false,
        isUnique: false,
        isAutoIncrement: false
      })),
      constraints: constraintsResult.rows.map(con => ({
        name: con.NAME,
        table: upperTableName,
        type: this.mapConstraintType(con.TYPE) as any,
        columns: [],
        definition: con.CONDITION
      })),
      indexes: indexResult.rows.map(idx => ({
        name: idx.INDEX_NAME,
        table: upperTableName,
        unique: idx.UNIQUENESS === 'UNIQUE',
        columns: idx.COLUMNS.split(', ')
      })),
      rowCount: parseInt(rowCountResult.rows[0]?.COUNT || '0')
    };
  }

  async bulkInsert(
    connection: DatabaseConnection,
    table: string,
    data: any[]
  ): Promise<number> {
    if (data.length === 0) return 0;

    const conn = connection as any;
    const isPool = conn.getConnection !== undefined;
    const insertConn = isPool ? await conn.getConnection() : conn;

    try {
      const columns = Object.keys(data[0]);
      const columnList = columns.map(col => this.escapeIdentifier(col)).join(', ');
      const bindList = columns.map((_, i) => `:${i + 1}`).join(', ');
      
      const sql = `INSERT INTO ${this.escapeIdentifier(table)} (${columnList}) VALUES (${bindList})`;
      
      const bindDefs: any = {};
      columns.forEach((col, index) => {
        const sampleValue = data[0][col];
        bindDefs[index + 1] = {
          type: this.getOracleType(sampleValue),
          maxSize: typeof sampleValue === 'string' ? 4000 : undefined
        };
      });

      const binds = data.map(row => {
        const bindRow: any = {};
        columns.forEach((col, index) => {
          bindRow[index + 1] = row[col];
        });
        return bindRow;
      });

      const result = await insertConn.executeMany(sql, binds, {
        autoCommit: true,
        bindDefs
      });

      return result.rowsAffected || data.length;
    } finally {
      if (isPool) {
        await insertConn.close();
      }
    }
  }

  private getOracleType(value: any): any {
    if (value === null || value === undefined) {
      return this.oracledb.STRING;
    } else if (typeof value === 'number') {
      return this.oracledb.NUMBER;
    } else if (typeof value === 'boolean') {
      return this.oracledb.NUMBER;
    } else if (value instanceof Date) {
      return this.oracledb.DATE;
    } else if (Buffer.isBuffer(value)) {
      return this.oracledb.BUFFER;
    } else {
      return this.oracledb.STRING;
    }
  }

  private getBindDirection(dir: string): any {
    switch (dir.toUpperCase()) {
      case 'IN':
        return this.oracledb.BIND_IN;
      case 'OUT':
        return this.oracledb.BIND_OUT;
      case 'INOUT':
        return this.oracledb.BIND_INOUT;
      default:
        return this.oracledb.BIND_IN;
    }
  }

  private getOracleIsolationLevel(level: string): string {
    switch (level.toUpperCase()) {
      case 'READ_COMMITTED':
        return 'READ COMMITTED';
      case 'SERIALIZABLE':
        return 'SERIALIZABLE';
      default:
        return 'READ COMMITTED';
    }
  }

  private mapConstraintType(type: string): string {
    switch (type) {
      case 'P': return 'primary';
      case 'U': return 'unique';
      case 'R': return 'foreign';
      case 'C': return 'check';
      default: return 'check';
    }
  }

  private parseQueryError(error: any, sql: string): Error {
    const message = `Oracle Error: ${error.message}\nSQL: ${sql.substring(0, 200)}${sql.length > 200 ? '...' : ''}`;
    const enhancedError = new Error(message);
    
    Object.assign(enhancedError, {
      errorNum: error.errorNum,
      offset: error.offset,
      originalError: error,
      sql
    });

    return enhancedError;
  }

  private parseMetadata(metaData: any[]): QueryResult['fields'] {
    return metaData.map(col => ({
      name: col.name,
      dataType: this.mapOracleType(col.dbType),
      nullable: col.nullable,
      length: col.maxSize,
      precision: col.precision,
      scale: col.scale
    }));
  }

  private mapOracleType(dbType: number): string {
    const typeMap: Record<number, string> = {
      2001: 'string',
      2002: 'number',
      2003: 'date',
      2004: 'blob',
      2005: 'clob',
      2006: 'binary',
      2007: 'rowid',
      2008: 'long',
      2009: 'long raw',
      2010: 'bfile',
      2011: 'timestamp',
      2012: 'timestamp with timezone',
      2013: 'timestamp with local timezone',
      2014: 'interval year to month',
      2015: 'interval day to second',
      2016: 'urowid',
      2017: 'char',
      2018: 'nchar',
      2019: 'nvarchar2',
      2020: 'nclob'
    };
    return typeMap[dbType] || 'unknown';
  }

  private wrapConnection(conn: any, config: DatabaseConfig, _isPool: boolean): DatabaseConnection {
    return {
      id: `oracle-${++this.connectionCounter}`,
      type: 'oracle',
      instance: conn,
      config,
      connected: true,
      lastActivity: new Date(),
      inTransaction: false,
      transactionLevel: 0,
      savepoints: []
    };
  }

  override escapeIdentifier(identifier: string): string {
    return `"${identifier.toUpperCase()}"`;
  }

  override async *stream(
    connection: DatabaseConnection,
    sql: string,
    params?: any[],
    options?: QueryOptions
  ): AsyncGenerator<any, void, unknown> {
    const conn = connection as any;
    const isPool = conn.getConnection !== undefined;
    const streamConn = isPool ? await conn.getConnection() : conn;

    try {
      const streamOptions: any = {};
      if ((options as any)?.prefetchRows) {
        streamOptions.prefetchRows = (options as any).prefetchRows;
      } else {
        streamOptions.prefetchRows = 100;
      }
      const stream = await streamConn.queryStream(sql, params || [], streamOptions);

      for await (const row of stream) {
        yield row;
      }
    } finally {
      if (isPool) {
        await streamConn.close();
      }
    }
  }

  override async setSessionParameter(
    connection: DatabaseConnection,
    parameter: string,
    value: any
  ): Promise<void> {
    const sql = `ALTER SESSION SET ${parameter} = :1`;
    await this.query(connection, sql, [value]);
  }
}
