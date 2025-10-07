// src/steps/database/ConnectionSteps.ts

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { DatabaseContext } from '../../database/context/DatabaseContext';
import { CSDatabase } from '../../database/client/CSDatabase';
import { CSReporter } from '../../reporter/CSReporter';
import { DatabaseConfig, DatabaseType } from '../../database/types/database.types';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSDatabaseManager } from '../../database/CSDatabaseManager';

export class ConnectionSteps {
    private databaseContext: DatabaseContext;
    private databaseManager: CSDatabaseManager;
    private databases: Map<string, CSDatabase> = new Map();
    private currentDatabaseAlias: string = 'default';
    private configManager: CSConfigurationManager;
    private contextVariables: Map<string, any> = new Map();

    constructor() {
        this.databaseContext = new DatabaseContext();
        this.databaseManager = CSDatabaseManager.getInstance();
        this.configManager = CSConfigurationManager.getInstance();
    }

    @CSBDDStepDef('user connects with connection string {string}')
    async connectWithConnectionString(connectionString: string): Promise<void> {
        CSReporter.info(`Connecting with connection string: ${this.sanitizeConnectionString(connectionString)}`);

        try {
            const interpolatedString = this.interpolateVariables(connectionString);
            const config = this.parseConnectionString(interpolatedString);

            const database = await CSDatabase.create(config, this.currentDatabaseAlias);
            await database.connect();

            const alias = this.generateAliasFromConfig(config);
            this.databases.set(alias, database);
            this.currentDatabaseAlias = alias;

            const connection = await database.getConnection();
            const adapter = database.getAdapter();
            this.databaseContext.setActiveConnection(alias, adapter, connection);

            CSReporter.info(`Connected to ${config.type} database at ${config.host}`);

        } catch (error) {
            CSReporter.error(`Failed to connect with connection string: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to connect with connection string: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user connects to database with options:')
    async connectWithOptions(dataTable: any): Promise<void> {
        CSReporter.info('Connecting to database with options');

        try {
            const options = this.parseDataTable(dataTable);
            const config = await this.buildDatabaseConfig(options);

            const database = await CSDatabase.create(config, config.database || 'default');
            await database.connect();

            const alias = options['alias'] || this.generateAliasFromConfig(config);
            this.databases.set(alias, database);
            this.currentDatabaseAlias = alias;

            const connection = await database.getConnection();
            const adapter = database.getAdapter();
            this.databaseContext.setActiveConnection(alias, adapter, connection);

            CSReporter.info(`Connected to ${config.type} database: ${alias}`);

        } catch (error) {
            CSReporter.error(`Failed to connect with options: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to connect with options: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user connects to {string} database')
    async connectToNamedDatabase(databaseAlias: string): Promise<void> {
        CSReporter.info(`Connecting to named database: ${databaseAlias}`);

        try {
            const database = await this.databaseManager.createConnection(databaseAlias);

            this.databases.set(databaseAlias, database);
            this.currentDatabaseAlias = databaseAlias;

            const connection = await database.getConnection();
            const adapter = database.getAdapter();
            this.databaseContext.setActiveConnection(databaseAlias, adapter, connection);

            CSReporter.info(`Connected to database: ${databaseAlias}`);

        } catch (error) {
            CSReporter.error(`Failed to connect to database '${databaseAlias}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to connect to database '${databaseAlias}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user switches to database {string}')
    async switchToDatabase(databaseAlias: string): Promise<void> {
        CSReporter.info(`Switching to database: ${databaseAlias}`);

        try {
            const database = this.databases.get(databaseAlias);
            if (!database) {
                throw new Error(`Database connection '${databaseAlias}' not found. Available connections: ${Array.from(this.databases.keys()).join(', ')}`);
            }

            this.currentDatabaseAlias = databaseAlias;

            const connection = await database.getConnection();
            this.databaseContext.switchConnection(databaseAlias, connection);

            CSReporter.info(`Switched to database: ${databaseAlias}`);

        } catch (error) {
            CSReporter.error(`Failed to switch to database '${databaseAlias}': ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    @CSBDDStepDef('user disconnects from database')
    async disconnectFromDatabase(): Promise<void> {
        CSReporter.info('Disconnecting from database');

        try {
            const database = this.databases.get(this.currentDatabaseAlias);
            if (database) {
                await database.disconnect();
                this.databases.delete(this.currentDatabaseAlias);
            }

            CSReporter.info('Disconnected from database');

        } catch (error) {
            CSReporter.error(`Failed to disconnect from database: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to disconnect from database: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user disconnects from all databases')
    async disconnectFromAllDatabases(): Promise<void> {
        CSReporter.info('Disconnecting from all databases');

        const errors: string[] = [];

        for (const [alias, database] of this.databases) {
            try {
                await database.disconnect();
                CSReporter.info(`Disconnected from database: ${alias}`);
            } catch (error) {
                errors.push(`${alias}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        this.databases.clear();

        if (errors.length > 0) {
            throw new Error(`Failed to disconnect from some databases:\n${errors.join('\n')}`);
        }
    }

    @CSBDDStepDef('user verifies database connection')
    async verifyConnection(): Promise<void> {
        CSReporter.info('Verifying database connection');

        try {
            const database = this.databases.get(this.currentDatabaseAlias);
            if (!database) {
                throw new Error('No active database connection');
            }

            const isConnected = await database.isConnected();
            if (!isConnected) {
                throw new Error('Database is not connected');
            }

            const testQuery = this.getTestQuery(database.getType());
            const result = await database.query(testQuery);

            CSReporter.info(`Database connection verified for: ${this.currentDatabaseAlias}`);

        } catch (error) {
            CSReporter.error(`Database connection verification failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Database connection verification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user sets database timeout to {int} seconds')
    async setDatabaseTimeout(timeoutSeconds: number): Promise<void> {
        CSReporter.info(`Setting database timeout to ${timeoutSeconds} seconds`);

        try {
            const database = this.databases.get(this.currentDatabaseAlias);
            if (!database) {
                throw new Error('No active database connection');
            }

            this.databaseContext.setQueryTimeout(timeoutSeconds * 1000);

            CSReporter.info(`Database timeout set to ${timeoutSeconds} seconds`);

        } catch (error) {
            CSReporter.error(`Failed to set database timeout: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to set database timeout: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private parseConnectionString(connectionString: string): DatabaseConfig {
        if (connectionString.startsWith('mongodb://') || connectionString.startsWith('mongodb+srv://')) {
            return this.parseMongoConnectionString(connectionString);
        } else if (connectionString.includes('Server=') || connectionString.includes('Data Source=')) {
            return this.parseSqlServerConnectionString(connectionString);
        } else if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) {
            return this.parsePostgresConnectionString(connectionString);
        } else if (connectionString.startsWith('mysql://')) {
            return this.parseMySqlConnectionString(connectionString);
        } else if (connectionString.startsWith('oracle://')) {
            return this.parseOracleConnectionString(connectionString);
        } else if (connectionString.startsWith('redis://')) {
            return this.parseRedisConnectionString(connectionString);
        }

        throw new Error(`Unsupported connection string format: ${connectionString}`);
    }

    private parseSqlServerConnectionString(connectionString: string): DatabaseConfig {
        const params = new Map<string, string>();

        connectionString.split(';').forEach(pair => {
            const [key, value] = pair.split('=').map(s => s.trim());
            if (key && value) {
                params.set(key.toLowerCase(), value);
            }
        });

        return {
            type: 'sqlserver',
            host: params.get('server') || params.get('data source') || 'localhost',
            port: parseInt(params.get('port') || '1433'),
            database: params.get('database') || params.get('initial catalog') || 'master',
            username: params.get('user id') || params.get('uid') || '',
            password: params.get('password') || params.get('pwd') || '',
            ssl: params.get('encrypt') === 'true',
            connectionTimeout: parseInt(params.get('connection timeout') || '30000'),
            queryTimeout: parseInt(params.get('request timeout') || '15000'),
            poolMax: 10,
            poolMin: 0,
            poolIdleTimeout: 30000,
            options: {
                trustServerCertificate: params.get('trustservercertificate') === 'true',
                integratedSecurity: params.get('integrated security') === 'true'
            }
        };
    }

    private parsePostgresConnectionString(connectionString: string): DatabaseConfig {
        const url = new URL(connectionString);
        const searchParams = new URLSearchParams(url.search);

        return {
            type: 'postgresql',
            host: url.hostname || 'localhost',
            port: parseInt(url.port || '5432'),
            database: url.pathname.substring(1) || 'postgres',
            username: url.username || '',
            password: url.password || '',
            ssl: searchParams.get('sslmode') !== 'disable',
            connectionTimeout: parseInt(searchParams.get('connect_timeout') || '30000'),
            queryTimeout: 15000,
            poolMax: 10,
            poolMin: 0,
            poolIdleTimeout: 30000,
            options: Object.fromEntries(searchParams)
        };
    }

    private parseMySqlConnectionString(connectionString: string): DatabaseConfig {
        const url = new URL(connectionString);
        const searchParams = new URLSearchParams(url.search);

        return {
            type: 'mysql',
            host: url.hostname || 'localhost',
            port: parseInt(url.port || '3306'),
            database: url.pathname.substring(1) || 'mysql',
            username: url.username || '',
            password: url.password || '',
            ssl: searchParams.get('ssl') === 'true',
            connectionTimeout: parseInt(searchParams.get('connectTimeout') || '30000'),
            queryTimeout: 15000,
            poolMax: 10,
            poolMin: 0,
            poolIdleTimeout: 30000,
            options: Object.fromEntries(searchParams)
        };
    }

    private parseMongoConnectionString(connectionString: string): DatabaseConfig {
        const url = new URL(connectionString);
        const searchParams = new URLSearchParams(url.search);

        return {
            type: 'mongodb',
            host: url.hostname || 'localhost',
            port: parseInt(url.port || '27017'),
            database: url.pathname.substring(1) || searchParams.get('authSource') || 'test',
            username: url.username || '',
            password: url.password || '',
            ssl: url.protocol === 'mongodb+srv:' || searchParams.get('ssl') === 'true',
            connectionTimeout: 30000,
            queryTimeout: 15000,
            poolMax: 10,
            poolMin: 0,
            poolIdleTimeout: 30000,
            connectionString: connectionString,
            options: Object.fromEntries(searchParams)
        };
    }

    private parseOracleConnectionString(connectionString: string): DatabaseConfig {
        const url = new URL(connectionString);
        const searchParams = new URLSearchParams(url.search);

        return {
            type: 'oracle',
            host: url.hostname || 'localhost',
            port: parseInt(url.port || '1521'),
            database: url.pathname.substring(1) || 'ORCL',
            username: url.username || '',
            password: url.password || '',
            ssl: searchParams.get('ssl') === 'true',
            connectionTimeout: parseInt(searchParams.get('connectTimeout') || '30000'),
            queryTimeout: 15000,
            poolMax: 10,
            poolMin: 0,
            poolIdleTimeout: 30000,
            options: Object.fromEntries(searchParams)
        };
    }

    private parseRedisConnectionString(connectionString: string): DatabaseConfig {
        const url = new URL(connectionString);
        const searchParams = new URLSearchParams(url.search);

        return {
            type: 'redis',
            host: url.hostname || 'localhost',
            port: parseInt(url.port || '6379'),
            database: url.pathname.substring(1) || '0',
            username: url.username || '',
            password: url.password || '',
            ssl: searchParams.get('ssl') === 'true',
            connectionTimeout: parseInt(searchParams.get('connectTimeout') || '30000'),
            queryTimeout: 15000,
            poolMax: 10,
            poolMin: 0,
            poolIdleTimeout: 30000,
            options: Object.fromEntries(searchParams)
        };
    }

    private async buildDatabaseConfig(options: Record<string, any>): Promise<DatabaseConfig> {
        const type = this.validateDatabaseType(options['type'] || options['database_type']);
        const host = options['host'] || options['server'] || 'localhost';
        const database = options['database'] || options['database_name'] || 'test';

        const config: DatabaseConfig = {
            type,
            host,
            database,
            port: parseInt(options['port'] || this.getDefaultPort(type)),
            username: options['username'] || options['user'] || '',
            password: options['password'] || '',
            ssl: options['ssl'] === 'true' || options['use_ssl'] === 'true',
            connectionTimeout: parseInt(options['timeout'] || options['connection_timeout'] || '30000'),
            queryTimeout: parseInt(options['query_timeout'] || '15000'),
            poolMax: parseInt(options['pool_max'] || '10'),
            poolMin: parseInt(options['pool_min'] || '0'),
            poolIdleTimeout: parseInt(options['pool_idle_timeout'] || '30000'),
            options: {}
        };

        Object.keys(options).forEach(key => {
            if (!['type', 'database_type', 'host', 'server', 'database', 'database_name',
                 'port', 'username', 'user', 'password', 'ssl', 'use_ssl', 'timeout',
                 'connection_timeout', 'query_timeout', 'pool_max', 'pool_min', 'pool_idle_timeout', 'alias'].includes(key)) {
                config.options![key] = options[key];
            }
        });

        return config;
    }

    private validateDatabaseType(type: string): DatabaseType {
        const validTypes: DatabaseType[] = ['sqlserver', 'mysql', 'postgresql', 'oracle', 'mongodb', 'redis'];
        const normalizedType = type.toLowerCase().replace(/\s+/g, '') as DatabaseType;

        if (normalizedType === 'sqlserver') {
            return 'sqlserver';
        }

        if (!validTypes.includes(normalizedType)) {
            throw new Error(`Invalid database type: ${type}. Valid types are: ${validTypes.join(', ')}`);
        }

        return normalizedType;
    }

    private getDefaultPort(type: DatabaseType): string {
        const defaultPorts: Record<DatabaseType, string> = {
            'sqlserver': '1433',
            'mysql': '3306',
            'postgresql': '5432',
            'oracle': '1521',
            'mongodb': '27017',
            'redis': '6379'
        };

        return defaultPorts[type] || '0';
    }

    private generateAliasFromConfig(config: DatabaseConfig): string {
        return `${config.type}_${config.host}_${config.database}`.replace(/[^a-zA-Z0-9_]/g, '_');
    }

    private sanitizeConnectionString(connectionString: string): string {
        return connectionString
            .replace(/password=([^;]+)/gi, 'password=***')
            .replace(/pwd=([^;]+)/gi, 'pwd=***')
            .replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
    }

    private getTestQuery(type: DatabaseType): string {
        const testQueries: Record<DatabaseType, string> = {
            'sqlserver': 'SELECT 1 AS test',
            'mysql': 'SELECT 1 AS test',
            'postgresql': 'SELECT 1 AS test',
            'oracle': 'SELECT 1 AS test FROM DUAL',
            'mongodb': '{ "ping": 1 }',
            'redis': 'PING'
        };

        return testQueries[type] || 'SELECT 1';
    }

    private parseDataTable(dataTable: any): Record<string, any> {
        const result: Record<string, any> = {};

        if (dataTable && dataTable.raw) {
            dataTable.raw()?.forEach((row: string[]) => {
                if (row.length >= 2 && row[0] && row[1]) {
                    const key = row[0].trim();
                    const value = this.interpolateVariables(row[1].trim());
                    result[key] = value;
                }
            });
        } else if (dataTable && dataTable.rowsHash) {
            const hash = dataTable.rowsHash();
            Object.keys(hash).forEach(key => {
                result[key] = this.interpolateVariables(hash[key]);
            });
        }

        return result;
    }

    private interpolateVariables(value: string): string {
        const configManager = CSConfigurationManager.getInstance();

        value = value.replace(/\${([^}]+)}/g, (match, varName) => {
            return process.env[varName] || match;
        });

        value = value.replace(/{{([^}]+)}}/g, (match, varName) => {
            const retrieved = this.contextVariables.get(varName);
            return retrieved !== undefined ? String(retrieved) : match;
        });

        value = value.replace(/%([^%]+)%/g, (match, varName) => {
            return this.configManager.get(varName, match) as string;
        });

        return value;
    }
}