import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { CSEncryptionUtil } from '../utils/CSEncryptionUtil';
// Removed CSReporter import for performance - will use console.log instead

/**
 * CS Configuration Manager - 7-Level Hierarchy System
 * Priority Order (Highest to Lowest):
 * 1. Command line arguments (override everything)
 * 2. Environment variables (override config files)
 * 3. config/{project}/environments/{environment}.env
 * 4. config/{project}/common/common.env
 * 5. config/common/environments/{environment}.env
 * 6. config/common/common.env
 * 7. config/global.env (base defaults)
 */
export class CSConfigurationManager {
    private static instance: CSConfigurationManager;
    private config: Map<string, string> = new Map();
    private encryptionUtil: CSEncryptionUtil;
    private loadStartTime: number = Date.now();

    private constructor() {
        this.encryptionUtil = CSEncryptionUtil.getInstance();
    }

    public static getInstance(): CSConfigurationManager {
        if (!CSConfigurationManager.instance) {
            CSConfigurationManager.instance = new CSConfigurationManager();
        }
        return CSConfigurationManager.instance;
    }

    public async initialize(args: any = {}): Promise<void> {
        const startTime = Date.now();

        // Determine project and environment early
        const project = args.project || process.env.PROJECT || 'common';
        const environment = args.env || args.environment || process.env.ENVIRONMENT || 'dev';

        // 7-LEVEL CONFIGURATION HIERARCHY (loaded in reverse priority order)

        // Level 7 (Lowest Priority): Global defaults
        await this.loadConfig('config/global.env', 'Global defaults');

        // Level 6: Common configuration - load all .env files from common folder
        await this.loadConfig('config/common/common.env', 'Common config');
        await this.loadAllEnvFilesFromDirectory('config/common', 'Common configs');

        // Level 5: Common environment specific
        await this.loadConfig(`config/common/environments/${environment}.env`, 'Common environment');

        // Level 4: Project common configuration - load all .env files from project common folder
        await this.loadConfig(`config/${project}/common/common.env`, 'Project common');
        await this.loadAllEnvFilesFromDirectory(`config/${project}/common`, 'Project common configs');

        // Level 3: Project environment specific (Highest file priority)
        await this.loadConfig(`config/${project}/environments/${environment}.env`, 'Project environment');

        // Also load all .env files from project root directory
        await this.loadAllEnvFilesFromDirectory(`config/${project}`, 'Project configs', true);

        // Level 2: Environment variables (override all files)
        this.loadEnvironmentVariables();

        // Level 1 (Highest Priority): Command line arguments (override everything)
        this.loadCommandLineArgs(args);

        // Set computed values
        this.config.set('PROJECT', project);
        this.config.set('ENVIRONMENT', environment);

        // Perform advanced interpolation
        this.performAdvancedInterpolation();

        // Decrypt encrypted values
        this.decryptValues();

        const loadTime = Date.now() - startTime;
        if (loadTime > 100) {
            console.warn(`⚠️ Configuration loading took ${loadTime}ms (target: <100ms)`);
        }
    }

    private async loadConfig(filePath: string, description: string): Promise<void> {
        const fullPath = path.join(process.cwd(), filePath);

        // Only load .env files (no JSON support)
        if (fs.existsSync(fullPath)) {
            const config = dotenv.parse(fs.readFileSync(fullPath));
            Object.entries(config).forEach(([key, value]) => {
                this.config.set(key, value);
                // Set LOG_LEVEL to process.env so it's available immediately for CSReporter
                if (key === 'LOG_LEVEL') {
                    process.env.LOG_LEVEL = value;
                }
            });
            // Use console.log instead of CSReporter for performance
            if (process.env.DEBUG) {
                console.log(`[DEBUG] ✓ Loaded ENV ${description}: ${filePath}`);
            }
        }
    }

    private async loadAllEnvFilesFromDirectory(dirPath: string, description: string, excludeSubdirs: boolean = false): Promise<void> {
        const fullPath = path.join(process.cwd(), dirPath);

        if (!fs.existsSync(fullPath)) {
            return;
        }

        try {
            const files = fs.readdirSync(fullPath);
            const envFiles = files.filter(file => {
                const filePath = path.join(fullPath, file);
                const stat = fs.statSync(filePath);

                // Skip subdirectories if excludeSubdirs is true
                if (stat.isDirectory()) {
                    if (excludeSubdirs && (file === 'common' || file === 'environments')) {
                        return false;
                    }
                    return false;
                }

                // Load only .env files, but skip common.env as it's already loaded
                return file.endsWith('.env') && file !== 'common.env';
            });

            // Sort files for consistent loading order
            envFiles.sort();

            for (const file of envFiles) {
                await this.loadConfig(path.join(dirPath, file), `${description} - ${file}`);
            }
        } catch (error) {
            // Use console.log instead of CSReporter for performance
            if (process.env.DEBUG) {
                console.log(`[DEBUG] Could not load additional env files from ${dirPath}: ${error}`);
            }
        }
    }

    private loadEnvironmentVariables(): void {
        Object.entries(process.env).forEach(([key, value]) => {
            if (value !== undefined) {
                this.config.set(key, value);
            }
        });
    }

    private loadCommandLineArgs(args: any): void {
        Object.entries(args).forEach(([key, value]) => {
            if (value !== undefined) {
                // Convert CLI args to uppercase config keys
                const configKey = key.toUpperCase().replace(/-/g, '_');
                this.config.set(configKey, String(value));
                
                // Also set original case for compatibility
                this.config.set(key, String(value));
            }
        });
    }

    private performAdvancedInterpolation(): void {
        const maxIterations = 10;
        let iteration = 0;
        let hasChanges = true;
        
        while (hasChanges && iteration < maxIterations) {
            hasChanges = false;
            iteration++;
            
            this.config.forEach((value, key) => {
                const interpolated = this.interpolateAdvanced(value);
                if (interpolated !== value) {
                    this.config.set(key, interpolated);
                    hasChanges = true;
                }
            });
        }
    }

    private interpolateAdvanced(str: string): string {
        if (typeof str !== 'string') return str;
        
        // Handle {VARIABLE} syntax for config variables
        str = str.replace(/{([^}]+)}/g, (match, variable) => {
            // Handle nested/computed variables
            if (variable.includes(':')) {
                return this.handleComplexVariable(variable);
            }
            
            // Simple variable lookup
            return this.config.get(variable) || this.config.get(variable.toUpperCase()) || match;
        });
        
        // Handle ${ENV_VAR} syntax for environment variables and config references
        str = str.replace(/\${([^}]+)}/g, (match, envVar) => {
            const [varName, defaultValue] = envVar.split(':-');
            
            // First check if it's a config key
            const configValue = this.config.get(varName) || this.config.get(varName.toUpperCase());
            if (configValue) {
                return configValue;
            }
            
            // Then check environment variables
            return process.env[varName] || defaultValue || match;
        });
        
        // Handle <placeholder> syntax for dynamic values
        str = str.replace(/<([^>]+)>/g, (match, placeholder) => {
            return this.handleDynamicPlaceholder(placeholder) || match;
        });
        
        return str;
    }

    private handleComplexVariable(variable: string): string {
        const parts = variable.split(':');
        const type = parts[0];
        
        switch (type) {
            case 'env':
                // {env:VARIABLE_NAME}
                return process.env[parts[1]] || '';
                
            case 'config':
                // {config:KEY}
                return this.config.get(parts[1]) || '';
                
            case 'ternary':
                // {ternary:condition?true_value:false_value}
                const [condition, values] = parts[1].split('?');
                const [trueValue, falseValue] = values.split(':');
                return this.config.get(condition) ? trueValue : falseValue;
                
            case 'concat':
                // {concat:VAR1+VAR2+VAR3}
                return parts[1].split('+')
                    .map(v => this.config.get(v) || '')
                    .join('');
                    
            case 'upper':
                // {upper:variable}
                return (this.config.get(parts[1]) || '').toUpperCase();
                
            case 'lower':
                // {lower:variable}
                return (this.config.get(parts[1]) || '').toLowerCase();
                
            default:
                return `{${variable}}`;
        }
    }

    private handleDynamicPlaceholder(placeholder: string): string {
        const parts = placeholder.split(':');
        const type = parts[0];
        
        switch (type) {
            case 'random':
                return Math.random().toString(36).substring(7);
                
            case 'timestamp':
                return Date.now().toString();
                
            case 'uuid':
                return this.generateUUID();
                
            case 'date':
                // <date:YYYY-MM-DD>
                return this.formatDate(new Date(), parts[1] || 'YYYY-MM-DD');
                
            case 'env':
                // <env:VARIABLE>
                return process.env[parts[1]] || '';
                
            case 'generate':
                // <generate:TYPE>
                return this.generateValue(parts[1]);
                
            default:
                return placeholder;
        }
    }

    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    private formatDate(date: Date, format: string): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        
        return format
            .replace('YYYY', String(year))
            .replace('MM', month)
            .replace('DD', day)
            .replace('HH', hours)
            .replace('mm', minutes)
            .replace('ss', seconds);
    }

    private generateValue(type: string): string {
        switch (type) {
            case 'email':
                return `test_${Date.now()}@example.com`;
            case 'phone':
                return `+1${Math.floor(Math.random() * 9000000000 + 1000000000)}`;
            case 'username':
                return `user_${Math.random().toString(36).substring(7)}`;
            case 'password':
                return this.generatePassword();
            default:
                return '';
        }
    }

    private generatePassword(): string {
        const length = 12;
        const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        for (let i = 0; i < length; i++) {
            password += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return password;
    }

    private decryptValues(): void {
        this.config.forEach((value, key) => {
            if (typeof value === 'string' && value.startsWith('ENCRYPTED:')) {
                const decrypted = this.encryptionUtil.decrypt(value);
                if (decrypted) {
                    this.config.set(key, decrypted);
                    // Use console.log instead of CSReporter for performance
                    if (process.env.DEBUG) {
                        console.log(`[DEBUG] Decrypted ${key} successfully`);
                    }
                }
            }
        });
    }

    // Public API Methods
    public get(key: string, defaultValue: string = ''): string {
        return this.config.get(key) || this.config.get(key.toUpperCase()) || defaultValue;
    }

    public set(key: string, value: string): void {
        this.config.set(key, value);
        this.config.set(key.toUpperCase(), value);
    }

    public getNumber(key: string, defaultValue: number = 0): number {
        const value = this.get(key);
        return value ? parseInt(value, 10) : defaultValue;
    }

    public getBoolean(key: string, defaultValue: boolean = false): boolean {
        const value = this.get(key);
        if (!value) return defaultValue;
        return value.toLowerCase() === 'true' || value === '1' || value === 'yes';
    }

    public getArray(key: string, delimiter: string = ';'): string[] {
        const value = this.get(key);
        return value ? value.split(delimiter).map(s => s.trim()) : [];
    }
    
    public getList(key: string, delimiter: string = ';'): string[] {
        return this.getArray(key, delimiter);
    }

    public getJSON(key: string, defaultValue: any = {}): any {
        const value = this.get(key);
        if (!value) return defaultValue;
        try {
            return JSON.parse(value);
        } catch {
            return defaultValue;
        }
    }

    public has(key: string): boolean {
        return this.config.has(key) || this.config.has(key.toUpperCase());
    }

    public getAll(): Map<string, string> {
        return new Map(this.config);
    }

    public validate(schema: {
        required?: string[];
        types?: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'json'>;
        validators?: Record<string, (value: any) => boolean>;
    }): void {
        // Validate required fields
        if (schema.required) {
            for (const field of schema.required) {
                if (!this.has(field)) {
                    throw new Error(`Required configuration '${field}' is missing`);
                }
            }
        }

        // Validate types
        if (schema.types) {
            for (const [field, type] of Object.entries(schema.types)) {
                const value = this.get(field);
                if (value) {
                    switch (type) {
                        case 'number':
                            if (isNaN(parseInt(value, 10))) {
                                throw new Error(`Configuration '${field}' must be a number`);
                            }
                            break;
                        case 'boolean':
                            if (!['true', 'false', '1', '0', 'yes', 'no'].includes(value.toLowerCase())) {
                                throw new Error(`Configuration '${field}' must be a boolean`);
                            }
                            break;
                        case 'array':
                            // Arrays are always valid as strings that can be split
                            break;
                        case 'json':
                            try {
                                JSON.parse(value);
                            } catch {
                                throw new Error(`Configuration '${field}' must be valid JSON`);
                            }
                            break;
                    }
                }
            }
        }

        // Custom validators
        if (schema.validators) {
            for (const [field, validator] of Object.entries(schema.validators)) {
                const value = this.get(field);
                if (value && !validator(value)) {
                    throw new Error(`Configuration '${field}' failed validation`);
                }
            }
        }
    }

    // Encryption helper
    public encrypt(value: string): string {
        return this.encryptionUtil.encrypt(value);
    }

    // Debug helper
    public debug(): void {
        console.log('\n=== Configuration Debug ===');
        console.log('Total configs loaded:', this.config.size);
        console.log('\nKey configurations:');
        ['PROJECT', 'ENVIRONMENT', 'BASE_URL', 'BROWSER', 'HEADLESS', 'PARALLEL'].forEach(key => {
            console.log(`  ${key}: ${this.get(key) || '(not set)'}`);
        });
    }
}