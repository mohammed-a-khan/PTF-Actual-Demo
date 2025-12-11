import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSValueResolver } from '../utils/CSValueResolver';

// Lazy load utility classes for performance
let ExcelUtility: any = null;
const getExcelUtility = () => {
    if (!ExcelUtility) {
        ExcelUtility = require('../utils/CSExcelUtility').CSExcelUtility;
    }
    return ExcelUtility;
};

let CsvUtility: any = null;
const getCsvUtility = () => {
    if (!CsvUtility) {
        CsvUtility = require('../utils/CSCsvUtility').CSCsvUtility;
    }
    return CsvUtility;
};

let JsonUtility: any = null;
const getJsonUtility = () => {
    if (!JsonUtility) {
        JsonUtility = require('../utils/CSJsonUtility').CSJsonUtility;
    }
    return JsonUtility;
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
    filter?: (row: DataRow) => boolean | string;  // Function or string filter
    filterExpression?: string;  // Original filter expression string for cache key
    transform?: (row: DataRow) => DataRow;
    randomize?: boolean;
    limit?: number;
    // Database-specific options
    type?: 'excel' | 'csv' | 'json' | 'xml' | 'database' | 'api' | 'generate';
    dbname?: string;           // Database connection name (e.g., "PRACTICE_ORACLE")
    connection?: string;       // Alias for dbname
    query?: string;            // SQL query or named query reference
    delimiter?: string;        // CSV delimiter
    path?: string;             // JSON path
    xpath?: string;            // XML xpath
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

        // Build cache key - use filterExpression (original string) for unique cache entries
        // JSON.stringify omits functions and closure-based functions have identical .toString()
        let cacheKey: string;
        if (options.filterExpression) {
            // Use the original filter expression string for cache key uniqueness
            // This ensures "scenarioId=EXT02" and "scenarioId=EXT04" get different cache entries
            const optionsForKey = { ...options, filter: options.filterExpression };
            cacheKey = JSON.stringify(optionsForKey);
            CSReporter.debug(`Cache key with filter expression: ${options.filterExpression}`);
        } else if (typeof options.filter === 'function') {
            // Fallback: use function toString (may not be unique for closure-based functions)
            const filterKey = options.filter.toString();
            const optionsForKey = { ...options, filter: filterKey };
            cacheKey = JSON.stringify(optionsForKey);
            CSReporter.debug(`Cache key with filter function (fallback)`);
        } else {
            cacheKey = JSON.stringify(options);
        }

        // Check cache
        if (this.cache.has(cacheKey)) {
            CSReporter.debug(`Loading data from cache: ${options.source}`);
            return this.cache.get(cacheKey)!;
        }

        let data: DataRow[] = [];

        // Determine source type and load data
        if (options.type === 'database' || options.source === 'database' || options.source.startsWith('db:')) {
            data = await this.loadDatabaseData(options);
        } else if (options.source.endsWith('.xlsx') || options.source.endsWith('.xls')) {
            data = await this.loadExcelData(options);
        } else if (options.source.endsWith('.csv')) {
            data = await this.loadCSVData(options);
        } else if (options.source.endsWith('.json')) {
            data = await this.loadJSONData(options);
        } else if (options.source.endsWith('.xml')) {
            data = await this.loadXMLData(options);
        } else if (options.source.startsWith('api:')) {
            data = await this.loadAPIData(options);
        } else if (options.source.startsWith('generate:')) {
            data = await this.generateData(options);
        } else {
            throw new Error(`Unsupported data source: ${options.source}`);
        }

        // Apply filter if provided
        if (options.filter) {
            if (typeof options.filter === 'function') {
                data = data.filter(options.filter);
            } else if (typeof options.filter === 'string') {
                // Parse and apply string filter format: "columnName=value;columnName<value;columnName>value"
                data = this.applyStringFilter(data, options.filter);
            }
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

        const ExcelUtil = getExcelUtility();

        // Use CSExcelUtility to read the data
        const data = ExcelUtil.readSheetAsJSON(filePath, options.sheet);

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

        const CsvUtil = getCsvUtility();

        // Use CSCsvUtility to read the data
        const data = CsvUtil.readAsJSON(filePath, {
            delimiter: options.delimiter,
            columns: true,
            skipEmptyLines: true,
            trim: true
        });

        return data as DataRow[];
    }
    
    private async loadJSONData(options: DataProviderOptions): Promise<DataRow[]> {
        const filePath = this.resolveFilePath(options.source);

        if (!fs.existsSync(filePath)) {
            throw new Error(`JSON file not found: ${filePath}`);
        }

        const JsonUtil = getJsonUtility();

        // Use CSJsonUtility to read the data
        const data = JsonUtil.readFile(filePath);

        // If path option is provided, extract data using JSONPath
        if (options.path) {
            const extracted = this.extractByJsonPath(data, options.path);
            if (extracted !== undefined) {
                CSReporter.debug(`Extracted ${Array.isArray(extracted) ? extracted.length : 1} items using path: ${options.path}`);
                return Array.isArray(extracted) ? extracted : [extracted];
            }
            CSReporter.warn(`JSONPath '${options.path}' returned no data, falling back to default extraction`);
        }

        // Handle both array and object formats
        if (Array.isArray(data)) {
            return data;
        } else if (typeof data === 'object') {
            // If object, look for common data properties
            return data.data || data.rows || data.testcases || data.testCases || data.records || data.items || [data];
        }

        return [];
    }

    /**
     * Extract data from JSON using a simple JSONPath-like syntax
     * Supports:
     *   - $.property - root property access
     *   - $.property.nested - nested property access
     *   - $.property[*] - all items in array
     *   - $.property[0] - specific array index
     *   - $[*] - all items from root array
     *   - property - simple property name (without $.)
     *
     * @param data - The JSON data object
     * @param jsonPath - The path expression
     * @returns Extracted data or undefined if not found
     */
    private extractByJsonPath(data: any, jsonPath: string): any {
        if (!data || !jsonPath) return undefined;

        // Normalize path - remove leading $. if present
        let normalizedPath = jsonPath.trim();
        if (normalizedPath.startsWith('$.')) {
            normalizedPath = normalizedPath.substring(2);
        } else if (normalizedPath.startsWith('$[')) {
            normalizedPath = normalizedPath.substring(1);
        } else if (normalizedPath === '$') {
            return data;
        }

        // Handle root array access $[*] or [*]
        if (normalizedPath === '[*]' || normalizedPath === '') {
            return Array.isArray(data) ? data : [data];
        }

        // Split path into segments, handling array notation
        // e.g., "testcases[*]" -> ["testcases", "[*]"]
        // e.g., "data.users[0].name" -> ["data", "users", "[0]", "name"]
        const segments: string[] = [];
        let current = '';

        for (let i = 0; i < normalizedPath.length; i++) {
            const char = normalizedPath[i];

            if (char === '.') {
                if (current) {
                    segments.push(current);
                    current = '';
                }
            } else if (char === '[') {
                if (current) {
                    segments.push(current);
                    current = '';
                }
                // Find closing bracket
                const closeBracket = normalizedPath.indexOf(']', i);
                if (closeBracket !== -1) {
                    segments.push(normalizedPath.substring(i, closeBracket + 1));
                    i = closeBracket;
                }
            } else {
                current += char;
            }
        }
        if (current) {
            segments.push(current);
        }

        // Navigate through the path
        let result: any = data;

        for (const segment of segments) {
            if (result === undefined || result === null) {
                return undefined;
            }

            if (segment === '[*]') {
                // Return all items in array
                if (Array.isArray(result)) {
                    return result;
                }
                return undefined;
            } else if (segment.startsWith('[') && segment.endsWith(']')) {
                // Array index access
                const indexStr = segment.substring(1, segment.length - 1);
                const index = parseInt(indexStr, 10);
                if (!isNaN(index) && Array.isArray(result)) {
                    result = result[index];
                } else {
                    return undefined;
                }
            } else {
                // Property access (case-insensitive fallback)
                if (result[segment] !== undefined) {
                    result = result[segment];
                } else {
                    // Try case-insensitive match
                    const keys = Object.keys(result);
                    const matchingKey = keys.find(k => k.toLowerCase() === segment.toLowerCase());
                    if (matchingKey) {
                        result = result[matchingKey];
                    } else {
                        return undefined;
                    }
                }
            }
        }

        return result;
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
        CSReporter.info('Loading data from database datasource');

        try {
            // Import DatabaseContext dynamically to avoid circular dependencies
            const { DatabaseContext } = await import('../database/context/DatabaseContext');
            const dbContext = DatabaseContext.getInstance();

            // Determine the database connection name
            const connectionName = options.dbname || options.connection;

            // Switch to the specified database connection if provided
            if (connectionName) {
                try {
                    const adapter = dbContext.getAdapter(connectionName);
                    CSReporter.debug(`Switching to database connection: ${connectionName}`);
                    // Connection is already established, just need to get it
                } catch (error) {
                    throw new Error(
                        `Database connection '${connectionName}' not found. ` +
                        `Make sure to establish connection using "user connects to ${connectionName} database" step first. ` +
                        `Error: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            // Determine the query to execute
            let sqlQuery = '';

            if (options.query) {
                // Check if query is a named query reference (no spaces, uppercase pattern)
                if (!options.query.includes(' ') && !options.query.includes(';')) {
                    // Looks like a named query reference like "GET_EMPLOYEES"
                    const namedQuery = this.config.get(options.query);
                    if (namedQuery) {
                        sqlQuery = String(namedQuery);
                        CSReporter.info(`Using named query '${options.query}': ${this.sanitizeQueryForLog(sqlQuery)}`);
                    } else {
                        // Try with DB_QUERY_ prefix
                        const prefixedQuery = this.config.get(`DB_QUERY_${options.query}`);
                        if (prefixedQuery) {
                            sqlQuery = String(prefixedQuery);
                            CSReporter.info(`Using named query 'DB_QUERY_${options.query}': ${this.sanitizeQueryForLog(sqlQuery)}`);
                        } else {
                            throw new Error(
                                `Named query '${options.query}' not found in configuration. ` +
                                `Make sure to define '${options.query}' or 'DB_QUERY_${options.query}' in your .env file.`
                            );
                        }
                    }
                } else {
                    // Direct SQL query
                    sqlQuery = options.query;
                    CSReporter.info(`Using direct SQL query: ${this.sanitizeQueryForLog(sqlQuery)}`);
                }
            } else if (options.source.startsWith('db:')) {
                // Extract query from 'db:' prefix format
                sqlQuery = options.source.substring(3);
                CSReporter.info(`Using query from source: ${this.sanitizeQueryForLog(sqlQuery)}`);
            } else {
                throw new Error(
                    'No query specified for database datasource. ' +
                    'Provide either query parameter or use db:SELECT... format'
                );
            }

            // Validate that we have an active connection
            try {
                dbContext.getActiveAdapter();
            } catch (error) {
                throw new Error(
                    'No active database connection. ' +
                    'Use "user connects to <database_name> database" step before using database datasource. ' +
                    `Error: ${error instanceof Error ? error.message : String(error)}`
                );
            }

            // Execute the query
            const startTime = Date.now();
            CSReporter.info(`Executing database query for DataProvider: ${this.sanitizeQueryForLog(sqlQuery)}`);

            const result = await dbContext.executeQuery(sqlQuery);
            const executionTime = Date.now() - startTime;

            CSReporter.info(
                `Database query executed successfully. ` +
                `Rows: ${result.rowCount}, Columns: ${result.fields.length}, Time: ${executionTime}ms`
            );

            // Convert QueryResult.rows to DataRow[] format
            const data: DataRow[] = result.rows.map((row: any, index: number) => {
                const dataRow: DataRow = {};

                // Convert database row to DataRow format
                if (typeof row === 'object' && row !== null) {
                    Object.keys(row).forEach(key => {
                        dataRow[key] = row[key];
                    });
                } else {
                    // Handle scalar values
                    dataRow['value'] = row;
                    dataRow['index'] = index;
                }

                return dataRow;
            });

            CSReporter.info(`Loaded ${data.length} rows from database query`);

            // Log column names for debugging
            if (data.length > 0) {
                const columns = Object.keys(data[0]);
                CSReporter.debug(`Available columns: ${columns.join(', ')}`);
            }

            return data;

        } catch (error: any) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            CSReporter.error(`Failed to load database data: ${errorMessage}`);

            // Provide helpful error messages
            if (errorMessage.includes('No active database connection')) {
                CSReporter.error(
                    'Hint: Make sure to connect to database first using: ' +
                    'Given user connects to "<DATABASE_NAME>" database'
                );
            }

            throw new Error(`Database datasource loading failed: ${errorMessage}`);
        }
    }

    private sanitizeQueryForLog(query: string): string {
        const maxLength = 100;
        const sanitized = query.replace(/\s+/g, ' ').trim();
        if (sanitized.length > maxLength) {
            return sanitized.substring(0, maxLength) + '...';
        }
        return sanitized;
    }

    private applyStringFilter(data: DataRow[], filterString: string): DataRow[] {
        // Parse filter format: "columnName=value;columnName<value;columnName>value"
        const filters = filterString.split(';').map(f => f.trim()).filter(f => f.length > 0);

        if (filters.length === 0) {
            return data;
        }

        CSReporter.debug(`Applying ${filters.length} filter(s): ${filterString}`);

        return data.filter(row => {
            // All filters must pass (AND logic)
            return filters.every(filterExpr => {
                // Parse filter expression
                let columnName: string;
                let operator: string;
                let expectedValue: string;

                if (filterExpr.includes('>=')) {
                    const parts = filterExpr.split('>=');
                    columnName = parts[0].trim();
                    operator = '>=';
                    expectedValue = parts[1].trim();
                } else if (filterExpr.includes('<=')) {
                    const parts = filterExpr.split('<=');
                    columnName = parts[0].trim();
                    operator = '<=';
                    expectedValue = parts[1].trim();
                } else if (filterExpr.includes('!=') || filterExpr.includes('<>')) {
                    const parts = filterExpr.split(/!=|<>/);
                    columnName = parts[0].trim();
                    operator = '!=';
                    expectedValue = parts[1].trim();
                } else if (filterExpr.includes('=')) {
                    const parts = filterExpr.split('=');
                    columnName = parts[0].trim();
                    operator = '=';
                    expectedValue = parts[1].trim();
                } else if (filterExpr.includes('>')) {
                    const parts = filterExpr.split('>');
                    columnName = parts[0].trim();
                    operator = '>';
                    expectedValue = parts[1].trim();
                } else if (filterExpr.includes('<')) {
                    const parts = filterExpr.split('<');
                    columnName = parts[0].trim();
                    operator = '<';
                    expectedValue = parts[1].trim();
                } else {
                    CSReporter.warn(`Invalid filter expression: ${filterExpr}`);
                    return true; // Skip invalid filters
                }

                // Get actual value from row (case-insensitive column matching)
                let actualValue: any;
                const rowKeys = Object.keys(row);
                const matchingKey = rowKeys.find(key => key.toLowerCase() === columnName.toLowerCase());

                if (matchingKey) {
                    actualValue = row[matchingKey];
                } else {
                    CSReporter.warn(`Column '${columnName}' not found in row. Available columns: ${rowKeys.join(', ')}`);
                    return false; // Filter fails if column doesn't exist
                }

                // Convert values for comparison
                const actualNum = Number(actualValue);
                const expectedNum = Number(expectedValue);
                const isNumericComparison = !isNaN(actualNum) && !isNaN(expectedNum);

                // Apply operator
                switch (operator) {
                    case '=':
                        if (isNumericComparison) {
                            return actualNum === expectedNum;
                        }
                        return String(actualValue).toLowerCase() === expectedValue.toLowerCase();

                    case '!=':
                        if (isNumericComparison) {
                            return actualNum !== expectedNum;
                        }
                        return String(actualValue).toLowerCase() !== expectedValue.toLowerCase();

                    case '>':
                        if (isNumericComparison) {
                            return actualNum > expectedNum;
                        }
                        return String(actualValue) > expectedValue;

                    case '<':
                        if (isNumericComparison) {
                            return actualNum < expectedNum;
                        }
                        return String(actualValue) < expectedValue;

                    case '>=':
                        if (isNumericComparison) {
                            return actualNum >= expectedNum;
                        }
                        return String(actualValue) >= expectedValue;

                    case '<=':
                        if (isNumericComparison) {
                            return actualNum <= expectedNum;
                        }
                        return String(actualValue) <= expectedValue;

                    default:
                        return true;
                }
            });
        });
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