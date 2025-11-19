// src/database/CSDatabaseManager.ts

import { CSDatabase } from './client/CSDatabase';
import { DatabaseConfig } from './types/database.types';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

export class CSDatabaseManager {
    private static instance: CSDatabaseManager;
    private databases: Map<string, CSDatabase> = new Map();
    private configManager: CSConfigurationManager;

    private constructor() {
        this.configManager = CSConfigurationManager.getInstance();
    }

    static getInstance(): CSDatabaseManager {
        if (!CSDatabaseManager.instance) {
            CSDatabaseManager.instance = new CSDatabaseManager();
        }
        return CSDatabaseManager.instance;
    }

    async createConnection(alias: string, config?: DatabaseConfig): Promise<CSDatabase> {
        try {
            const database = await CSDatabase.create(config || this.getDefaultConfig(alias), alias);
            this.databases.set(alias, database);
            CSReporter.info(`Database connection created: ${alias}`);
            return database;
        } catch (error) {
            CSReporter.error(`Failed to create database connection ${alias}: ${(error as Error).message}`);
            throw error;
        }
    }

    getConnection(alias: string): CSDatabase {
        const database = this.databases.get(alias);
        if (!database) {
            throw new Error(`Database connection '${alias}' not found`);
        }
        return database;
    }

    async closeConnection(alias: string): Promise<void> {
        const database = this.databases.get(alias);
        if (database) {
            await database.disconnect();
            this.databases.delete(alias);
            CSReporter.info(`Database connection closed: ${alias}`);
        }
    }

    async closeAllConnections(): Promise<void> {
        const aliases = Array.from(this.databases.keys());
        for (const alias of aliases) {
            await this.closeConnection(alias);
        }
    }

    async beginTransaction(alias?: string): Promise<void> {
        const database = alias ? this.getConnection(alias) : this.getDefaultConnection();
        await database.beginTransaction();
    }

    async rollbackTransaction(alias?: string): Promise<void> {
        const database = alias ? this.getConnection(alias) : this.getDefaultConnection();
        await database.rollbackTransaction();
    }

    private getDefaultConnection(): CSDatabase {
        if (this.databases.size === 0) {
            throw new Error('No database connections available');
        }
        return Array.from(this.databases.values())[0];
    }

    private getDefaultConfig(alias: string): DatabaseConfig {
        const upperAlias = alias.toUpperCase();

        // Check if Windows Authentication is enabled
        const trustedConnection = this.configManager.get(`DB_${upperAlias}_TRUSTED_CONNECTION`);
        const useTrustedConnection = String(trustedConnection) === 'true';

        const config: DatabaseConfig = {
            type: this.configManager.get(`DB_${upperAlias}_TYPE`, 'sqlserver') as any,
            host: this.configManager.get(`DB_${upperAlias}_HOST`) || (() => { throw new Error(`Required configuration DB_${upperAlias}_HOST is missing`); })(),
            port: this.configManager.getNumber(`DB_${upperAlias}_PORT`),
            database: this.configManager.get(`DB_${upperAlias}_DATABASE`) || (() => { throw new Error(`Required configuration DB_${upperAlias}_DATABASE is missing`); })(),
            connectionTimeout: this.configManager.getNumber(`DB_${upperAlias}_CONNECTION_TIMEOUT`, 60000),
            queryTimeout: this.configManager.getNumber(`DB_${upperAlias}_REQUEST_TIMEOUT`, 15000),
            poolMax: this.configManager.getNumber(`DB_${upperAlias}_POOL_MAX`, 10),
            poolMin: this.configManager.getNumber(`DB_${upperAlias}_POOL_MIN`, 0),
            poolIdleTimeout: this.configManager.getNumber(`DB_${upperAlias}_POOL_IDLE_TIMEOUT`, 30000)
        };

        // Username and password are only required when NOT using Windows Authentication
        if (!useTrustedConnection) {
            config.username = this.configManager.get(`DB_${upperAlias}_USERNAME`) || (() => { throw new Error(`Required configuration DB_${upperAlias}_USERNAME is missing`); })();
            config.password = this.configManager.get(`DB_${upperAlias}_PASSWORD`) || (() => { throw new Error(`Required configuration DB_${upperAlias}_PASSWORD is missing`); })();
        } else {
            // For Windows Authentication, username and password should be undefined or empty
            config.username = this.configManager.get(`DB_${upperAlias}_USERNAME`) || '';
            config.password = this.configManager.get(`DB_${upperAlias}_PASSWORD`) || '';
        }

        // Add SQL Server-specific options if present
        const additionalOptions: Record<string, any> = {};
        const encrypt = this.configManager.get(`DB_${upperAlias}_ENCRYPT`);
        const trustServerCert = this.configManager.get(`DB_${upperAlias}_TRUST_SERVER_CERTIFICATE`);

        if (encrypt !== undefined) {
            additionalOptions.encrypt = String(encrypt) === 'true';
        }
        if (trustServerCert !== undefined) {
            additionalOptions.trustServerCertificate = String(trustServerCert) === 'true';
        }
        if (useTrustedConnection) {
            additionalOptions.trustedConnection = true;
        }

        if (Object.keys(additionalOptions).length > 0) {
            config.additionalOptions = additionalOptions;
        }

        return config;
    }
}