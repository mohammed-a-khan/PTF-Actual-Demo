import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSValueResolver } from '../utils/CSValueResolver';

// Lazy load heavy libraries for performance
let XLSX: any = null;
const getXLSX = () => {
    if (!XLSX) {
        XLSX = require('xlsx');
    }
    return XLSX;
};

let csvParse: any = null;
const getCSVParse = () => {
    if (!csvParse) {
        csvParse = require('csv-parse/sync').parse;
    }
    return csvParse;
};

let xml2js: any = null;
const getParseXML = () => {
    if (!xml2js) {
        const { parseString } = require('xml2js');
        xml2js = promisify(parseString);
    }
    return xml2js;
};

export interface DataRow {
    [key: string]: any;
}

export interface DataProviderOptions {
    source: string;
    sheet?: string;
    filter?: (row: DataRow) => boolean;
    transform?: (row: DataRow) => DataRow;
    randomize?: boolean;
    limit?: number;
}

export class CSDataProvider {
    private static instance: CSDataProvider;
    private config: CSConfigurationManager;
    private cache: Map<string, DataRow[]> = new Map();
    private dynamicGenerators: Map<string, Function> = new Map();
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.registerDynamicGenerators();
    }
    
    public static getInstance(): CSDataProvider {
        if (!CSDataProvider.instance) {
            CSDataProvider.instance = new CSDataProvider();
        }
        return CSDataProvider.instance;
    }
    
    private registerDynamicGenerators(): void {
        // Register built-in dynamic data generators
        this.dynamicGenerators.set('random', () => Math.random().toString(36).substring(7));
        this.dynamicGenerators.set('timestamp', () => Date.now());
        this.dynamicGenerators.set('date', () => new Date().toISOString().split('T')[0]);
        this.dynamicGenerators.set('time', () => new Date().toISOString().split('T')[1]);
        this.dynamicGenerators.set('uuid', () => this.generateUUID());
        this.dynamicGenerators.set('email', () => `test_${Date.now()}@example.com`);
        this.dynamicGenerators.set('phone', () => this.generatePhone());
        this.dynamicGenerators.set('username', () => `user_${Math.random().toString(36).substring(7)}`);
        this.dynamicGenerators.set('password', () => this.generatePassword());
    }
    
    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    
    private generatePhone(): string {
        const areaCode = Math.floor(Math.random() * 900) + 100;
        const prefix = Math.floor(Math.random() * 900) + 100;
        const lineNumber = Math.floor(Math.random() * 9000) + 1000;
        return `${areaCode}-${prefix}-${lineNumber}`;
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
    
    // Overload to support backward compatibility with string filepath
    public async loadData(source: string): Promise<DataRow[]>;
    public async loadData(options: DataProviderOptions): Promise<DataRow[]>;
    public async loadData(sourceOrOptions: string | DataProviderOptions): Promise<DataRow[]> {
        // Convert string to options for backward compatibility
        const options: DataProviderOptions = typeof sourceOrOptions === 'string'
            ? { source: sourceOrOptions }
            : sourceOrOptions;

        const cacheKey = JSON.stringify(options);

        // Check cache
        if (this.cache.has(cacheKey)) {
            CSReporter.debug(`Loading data from cache: ${options.source}`);
            return this.cache.get(cacheKey)!;
        }

        let data: DataRow[] = [];

        // Determine source type and load data
        if (options.source.endsWith('.xlsx') || options.source.endsWith('.xls')) {
            data = await this.loadExcelData(options);
        } else if (options.source.endsWith('.csv')) {
            data = await this.loadCSVData(options);
        } else if (options.source.endsWith('.json')) {
            data = await this.loadJSONData(options);
        } else if (options.source.endsWith('.xml')) {
            data = await this.loadXMLData(options);
        } else if (options.source.startsWith('api:')) {
            data = await this.loadAPIData(options);
        } else if (options.source.startsWith('db:')) {
            data = await this.loadDatabaseData(options);
        } else if (options.source.startsWith('generate:')) {
            data = await this.generateData(options);
        } else {
            throw new Error(`Unsupported data source: ${options.source}`);
        }

        // Apply filter if provided
        if (options.filter) {
            data = data.filter(options.filter);
        }

        // Apply transformation if provided
        if (options.transform) {
            data = data.map(options.transform);
        }

        // Randomize if requested
        if (options.randomize) {
            data = this.shuffleArray(data);
        }

        // Apply limit if specified
        if (options.limit && options.limit > 0) {
            data = data.slice(0, options.limit);
        }
        
        // Process dynamic values
        data = this.processDynamicValues(data);
        
        // Cache the result
        this.cache.set(cacheKey, data);
        
        CSReporter.info(`Loaded ${data.length} rows from ${options.source}`);
        return data;
    }
    
    private async loadExcelData(options: DataProviderOptions): Promise<DataRow[]> {
        const filePath = this.resolveFilePath(options.source);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`Excel file not found: ${filePath}`);
        }
        
        const xlsx = getXLSX();
        const workbook = xlsx.readFile(filePath);
        const sheetName = options.sheet || workbook.SheetNames[0];
        
        if (!workbook.Sheets[sheetName]) {
            throw new Error(`Sheet '${sheetName}' not found in ${filePath}`);
        }
        
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet);
        
        // Process formulas if any
        data.forEach((row: any) => {
            Object.keys(row).forEach(key => {
                if (typeof row[key] === 'string' && row[key].startsWith('=')) {
                    // Simple formula evaluation (in production, use proper formula parser)
                    row[key] = this.evaluateFormula(row[key], row);
                }
            });
        });
        
        return data as DataRow[];
    }
    
    private async loadCSVData(options: DataProviderOptions): Promise<DataRow[]> {
        const filePath = this.resolveFilePath(options.source);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`CSV file not found: ${filePath}`);
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        const parse = getCSVParse();
        const data = parse(content, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });
        
        return data as DataRow[];
    }
    
    private async loadJSONData(options: DataProviderOptions): Promise<DataRow[]> {
        const filePath = this.resolveFilePath(options.source);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`JSON file not found: ${filePath}`);
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        
        // Handle both array and object formats
        if (Array.isArray(data)) {
            return data;
        } else if (typeof data === 'object') {
            // If object, look for a data property
            return data.data || data.rows || [data];
        }
        
        return [];
    }

    private async loadXMLData(options: DataProviderOptions): Promise<DataRow[]> {
        const filePath = this.resolveFilePath(options.source);

        if (!fs.existsSync(filePath)) {
            throw new Error(`XML file not found: ${filePath}`);
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const parseXML = getParseXML();
        const result: any = await parseXML(content);

        // Handle different XML structures
        let data: DataRow[] = [];

        // Look for common root elements (case-insensitive)
        const root = (result as any).root ||
                     (result as any).data ||
                     (result as any).testdata ||
                     (result as any).testData ||
                     result;

        // Find the array of items
        if (root.row) {
            data = Array.isArray(root.row) ? root.row : [root.row];
        } else if (root.item) {
            data = Array.isArray(root.item) ? root.item : [root.item];
        } else if (root.record) {
            data = Array.isArray(root.record) ? root.record : [root.record];
        } else if (root.user) {
            data = Array.isArray(root.user) ? root.user : [root.user];
        } else if (root.testCase) {
            data = Array.isArray(root.testCase) ? root.testCase : [root.testCase];
        } else {
            // Try to find any array property
            const arrays = Object.values(root).filter(v => Array.isArray(v));
            if (arrays.length > 0) {
                data = arrays[0] as DataRow[];
            } else {
                // If still no array found, convert object properties to array
                // This handles cases where data is stored as key-value pairs
                const keys = Object.keys(root);
                if (keys.length > 0 && typeof root[keys[0]] === 'object') {
                    data = keys.map(key => ({ id: key, ...root[key] }));
                }
            }
        }

        // Convert XML attributes to properties if needed
        data = data.map(row => {
            if (row.$ && typeof row.$ === 'object') {
                // Merge attributes with element content
                return { ...row.$, ...row };
            }
            return row;
        });

        return data;
    }

    private async loadAPIData(options: DataProviderOptions): Promise<DataRow[]> {
        const endpoint = options.source.substring(4); // Remove 'api:' prefix
        const baseUrl = this.config.get('API_BASE_URL');
        const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
        
        CSReporter.info(`Loading data from API: ${url}`);
        
        // Use fetch or axios to get data
        // This is a simplified implementation
        try {
            const response = await fetch(url);
            const data = await response.json();
            
            if (Array.isArray(data)) {
                return data;
            } else if (data.data) {
                return data.data;
            } else if (data.results) {
                return data.results;
            }
            
            return [data];
        } catch (error: any) {
            CSReporter.error(`Failed to load API data: ${error.message}`);
            return [];
        }
    }
    
    private async loadDatabaseData(options: DataProviderOptions): Promise<DataRow[]> {
        const query = options.source.substring(3); // Remove 'db:' prefix
        
        CSReporter.info(`Loading data from database: ${query}`);
        
        // This would connect to database and execute query
        // Placeholder implementation
        return [];
    }
    
    private async generateData(options: DataProviderOptions): Promise<DataRow[]> {
        const spec = options.source.substring(9); // Remove 'generate:' prefix
        const [count, template] = spec.split(':');
        const rowCount = parseInt(count) || 10;
        
        const data: DataRow[] = [];
        
        for (let i = 0; i < rowCount; i++) {
            const row: DataRow = {};
            
            if (template) {
                // Parse template and generate data
                const fields = template.split(',');
                fields.forEach(field => {
                    const [name, type] = field.split('=');
                    row[name] = this.generateFieldValue(type || 'string', i);
                });
            } else {
                // Default generation
                row.id = i + 1;
                row.name = `Item ${i + 1}`;
                row.value = Math.random() * 100;
                row.timestamp = new Date().toISOString();
            }
            
            data.push(row);
        }
        
        return data;
    }
    
    private generateFieldValue(type: string, index: number): any {
        switch (type) {
            case 'number':
                return Math.floor(Math.random() * 1000);
            case 'boolean':
                return Math.random() > 0.5;
            case 'date':
                return new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString();
            case 'email':
                return `user${index}@example.com`;
            case 'phone':
                return this.generatePhone();
            case 'uuid':
                return this.generateUUID();
            default:
                return `${type}_${index}`;
        }
    }
    
    private processDynamicValues(data: DataRow[]): DataRow[] {
        return data.map(row => {
            const processedRow: DataRow = {};

            Object.keys(row).forEach(key => {
                let value = row[key];

                // Process string values for decryption and dynamic placeholders
                if (typeof value === 'string') {
                    // AUTOMATIC DECRYPTION: Decrypt encrypted values first
                    // This ensures test data with encrypted passwords/tokens are automatically decrypted
                    value = CSValueResolver.resolve(value);

                    // Then process dynamic placeholders
                    // Replace <random> placeholder
                    value = value.replace(/<random>/g, () => this.dynamicGenerators.get('random')!());

                    // Replace <timestamp> placeholder
                    value = value.replace(/<timestamp>/g, () => this.dynamicGenerators.get('timestamp')!());

                    // Replace <uuid> placeholder
                    value = value.replace(/<uuid>/g, () => this.dynamicGenerators.get('uuid')!());

                    // Replace <config:KEY> placeholders
                    value = value.replace(/<config:([^>]+)>/g, (match: string, configKey: string) => {
                        return this.config.get(configKey, match);
                    });
                    
                    // Replace <generate:TYPE> placeholders
                    value = value.replace(/<generate:([^>]+)>/g, (match: string, type: string) => {
                        const generator = this.dynamicGenerators.get(type);
                        return generator ? generator() : match;
                    });
                    
                    // Replace <env:KEY> placeholders
                    value = value.replace(/<env:([^>]+)>/g, (match: string, envKey: string) => {
                        return process.env[envKey] || match;
                    });
                    
                    // Replace <date:FORMAT> placeholders
                    value = value.replace(/<date:([^>]+)>/g, (match: string, format: string) => {
                        return this.formatDate(new Date(), format);
                    });
                }
                
                processedRow[key] = value;
            });
            
            return processedRow;
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
    
    private evaluateFormula(formula: string, row: DataRow): any {
        // Simple formula evaluation
        // In production, use a proper formula parser
        
        if (formula.startsWith('=SUM(')) {
            const fields = formula.match(/=SUM\(([^)]+)\)/)?.[1]?.split(',') || [];
            return fields.reduce((sum, field) => sum + (parseFloat(row[field.trim()]) || 0), 0);
        }
        
        if (formula.startsWith('=CONCAT(')) {
            const fields = formula.match(/=CONCAT\(([^)]+)\)/)?.[1]?.split(',') || [];
            return fields.map(field => row[field.trim()] || '').join('');
        }
        
        if (formula.startsWith('=IF(')) {
            const parts = formula.match(/=IF\(([^,]+),([^,]+),([^)]+)\)/);
            if (parts) {
                const condition = parts[1].trim();
                const trueValue = parts[2].trim();
                const falseValue = parts[3].trim();
                
                // Simple condition evaluation
                const [field, operator, value] = condition.split(/([><=]+)/);
                const fieldValue = row[field.trim()];
                
                let result = false;
                switch (operator) {
                    case '>':
                        result = fieldValue > value;
                        break;
                    case '<':
                        result = fieldValue < value;
                        break;
                    case '=':
                    case '==':
                        result = fieldValue == value;
                        break;
                }
                
                return result ? trueValue : falseValue;
            }
        }
        
        return formula;
    }
    
    private resolveFilePath(source: string): string {
        if (path.isAbsolute(source)) {
            return source;
        }
        
        // Try relative to project root
        let filePath = path.join(process.cwd(), source);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
        
        // Try relative to test data directory
        filePath = path.join(process.cwd(), 'test', 'data', source);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
        
        // Try with project-specific path
        const project = this.config.get('PROJECT');
        filePath = path.join(process.cwd(), 'test', project, 'data', source);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
        
        return source;
    }
    
    private shuffleArray<T>(array: T[]): T[] {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }
    
    public registerGenerator(name: string, generator: Function): void {
        this.dynamicGenerators.set(name, generator);
        CSReporter.debug(`Registered dynamic generator: ${name}`);
    }
    
    public clearCache(): void {
        this.cache.clear();
        CSReporter.debug('Data provider cache cleared');
    }
    
    public getCacheSize(): number {
        return this.cache.size;
    }
}