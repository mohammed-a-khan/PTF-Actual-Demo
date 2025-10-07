// src/database/CSDatabaseRunner.ts

import { CSDatabaseManager } from './CSDatabaseManager';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import path from 'path';

export class CSDatabaseRunner {
    private configManager: CSConfigurationManager;
    private databaseManager: CSDatabaseManager;

    constructor() {
        this.configManager = CSConfigurationManager.getInstance();
        this.databaseManager = CSDatabaseManager.getInstance();
    }

    async run(): Promise<void> {
        try {
            CSReporter.info('Starting database test runner');

            // Load database configuration
            await this.loadConfiguration();

            // Initialize database connections
            await this.initializeConnections();

            // Run database tests
            await this.runDatabaseTests();

            CSReporter.info('Database test runner completed successfully');
        } catch (error) {
            CSReporter.error(`Database test runner failed: ${(error as Error).message}`);
            throw error;
        } finally {
            // Clean up connections
            await this.cleanup();
        }
    }

    private async loadConfiguration(): Promise<void> {
        const configFile = this.configManager.get('DATABASE_CONFIG_FILE');
        if (configFile) {
            const configPath = path.resolve(process.cwd(), configFile);
            CSReporter.info(`Loading database configuration from: ${configPath}`);
            // Configuration loading logic would go here
        }
    }

    private async initializeConnections(): Promise<void> {
        const connections = this.configManager.get('DATABASE_CONNECTIONS', '').split(',').filter(Boolean);

        for (const connectionAlias of connections) {
            try {
                await this.databaseManager.createConnection(connectionAlias.trim());
                CSReporter.info(`Initialized database connection: ${connectionAlias}`);
            } catch (error) {
                CSReporter.error(`Failed to initialize connection ${connectionAlias}: ${(error as Error).message}`);
            }
        }
    }

    private async runDatabaseTests(): Promise<void> {
        // Database test execution logic
        CSReporter.info('Running database tests...');

        // This would integrate with the BDD runner or direct test execution
        // For now, just a placeholder
    }

    private async cleanup(): Promise<void> {
        try {
            await this.databaseManager.closeAllConnections();
            CSReporter.info('All database connections closed');
        } catch (error) {
            CSReporter.error(`Error during cleanup: ${(error as Error).message}`);
        }
    }
}