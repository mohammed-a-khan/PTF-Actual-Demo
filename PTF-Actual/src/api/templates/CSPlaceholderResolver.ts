import { CSReporter } from '../../reporter/CSReporter';
import { CSValueResolver } from '../../utils/CSValueResolver';
import * as crypto from 'crypto';

export interface CSPlaceholderContext {
    variables: Map<string, any>;
    env: Record<string, string | undefined>;
    functions: Map<string, Function>;
    responses: Map<string, any>;
    cookies: Map<string, string>;
    headers: Map<string, string>;
    metadata: Map<string, any>;
}

export interface CSResolverOptions {
    throwOnUndefined?: boolean;
    enableFunctions?: boolean;
    enableExpressions?: boolean;
    enableChaining?: boolean;
    maxDepth?: number;
    cache?: boolean;
    customDelimiters?: {
        start: string;
        end: string;
    };
}

export class CSPlaceholderResolver {
    private context: CSPlaceholderContext;
    private options: CSResolverOptions;
    private resolverCache: Map<string, string>;
    private builtInFunctions: Map<string, Function>;
    private customTransformers: Map<string, Function>;

    constructor(context?: CSPlaceholderContext, options?: CSResolverOptions) {
        this.context = context || this.createDefaultContext();
        this.options = {
            throwOnUndefined: false,
            enableFunctions: true,
            enableExpressions: true,
            enableChaining: true,
            maxDepth: 10,
            cache: true,
            customDelimiters: { start: '{{', end: '}}' },
            ...options
        };
        this.resolverCache = new Map();
        this.builtInFunctions = this.initializeBuiltInFunctions();
        this.customTransformers = new Map();
    }

    private createDefaultContext(): CSPlaceholderContext {
        return {
            variables: new Map(),
            env: process.env,
            functions: new Map(),
            responses: new Map(),
            cookies: new Map(),
            headers: new Map(),
            metadata: new Map()
        };
    }

    private initializeBuiltInFunctions(): Map<string, Function> {
        const functions = new Map<string, Function>();

        // String functions
        functions.set('uppercase', (str: string) => String(str).toUpperCase());
        functions.set('lowercase', (str: string) => String(str).toLowerCase());
        functions.set('capitalize', (str: string) => String(str).charAt(0).toUpperCase() + String(str).slice(1));
        functions.set('trim', (str: string) => String(str).trim());
        functions.set('substring', (str: string, start: number, end?: number) => String(str).substring(start, end));
        functions.set('replace', (str: string, search: string, replace: string) => String(str).replace(new RegExp(search, 'g'), replace));
        functions.set('split', (str: string, separator: string) => String(str).split(separator));
        functions.set('join', (arr: any[], separator: string = ',') => arr.join(separator));
        functions.set('length', (value: any) => {
            if (typeof value === 'string' || Array.isArray(value)) return value.length;
            if (typeof value === 'object' && value !== null) return Object.keys(value).length;
            return 0;
        });

        // Number functions
        functions.set('add', (a: number, b: number) => Number(a) + Number(b));
        functions.set('subtract', (a: number, b: number) => Number(a) - Number(b));
        functions.set('multiply', (a: number, b: number) => Number(a) * Number(b));
        functions.set('divide', (a: number, b: number) => Number(a) / Number(b));
        functions.set('mod', (a: number, b: number) => Number(a) % Number(b));
        functions.set('round', (n: number, decimals: number = 0) => Math.round(Number(n) * Math.pow(10, decimals)) / Math.pow(10, decimals));
        functions.set('floor', (n: number) => Math.floor(Number(n)));
        functions.set('ceil', (n: number) => Math.ceil(Number(n)));
        functions.set('abs', (n: number) => Math.abs(Number(n)));
        functions.set('min', (...args: number[]) => Math.min(...args.map(Number)));
        functions.set('max', (...args: number[]) => Math.max(...args.map(Number)));
        functions.set('random', (min: number = 0, max: number = 1) => Math.random() * (max - min) + min);
        functions.set('randomInt', (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min);

        // Date/Time functions
        functions.set('now', () => Date.now());
        functions.set('timestamp', () => new Date().toISOString());
        functions.set('date', (format?: string) => this.formatDate(new Date(), format));
        functions.set('dateAdd', (date: string, amount: number, unit: string) => this.dateAdd(date, amount, unit));
        functions.set('dateDiff', (date1: string, date2: string, unit: string) => this.dateDiff(date1, date2, unit));
        functions.set('formatDate', (date: string, format: string) => this.formatDate(new Date(date), format));
        functions.set('parseDate', (date: string) => Date.parse(date));

        // Encoding functions
        functions.set('base64', (str: string) => Buffer.from(str).toString('base64'));
        functions.set('base64Decode', (str: string) => Buffer.from(str, 'base64').toString());
        functions.set('urlEncode', (str: string) => encodeURIComponent(str));
        functions.set('urlDecode', (str: string) => decodeURIComponent(str));
        functions.set('htmlEncode', (str: string) => this.htmlEncode(str));
        functions.set('htmlDecode', (str: string) => this.htmlDecode(str));
        functions.set('jsonEncode', (obj: any) => JSON.stringify(obj));
        functions.set('jsonDecode', (str: string) => JSON.parse(str));

        // Hash functions
        functions.set('md5', (str: string) => crypto.createHash('md5').update(str).digest('hex'));
        functions.set('sha1', (str: string) => crypto.createHash('sha1').update(str).digest('hex'));
        functions.set('sha256', (str: string) => crypto.createHash('sha256').update(str).digest('hex'));
        functions.set('sha512', (str: string) => crypto.createHash('sha512').update(str).digest('hex'));
        functions.set('hmac', (str: string, key: string, algorithm: string = 'sha256') =>
            crypto.createHmac(algorithm, key).update(str).digest('hex'));

        // UUID functions
        functions.set('uuid', () => this.generateUUID());
        functions.set('guid', () => this.generateUUID());
        functions.set('shortId', () => Math.random().toString(36).substring(2, 15));

        // Array functions
        functions.set('first', (arr: any[]) => arr[0]);
        functions.set('last', (arr: any[]) => arr[arr.length - 1]);
        functions.set('slice', (arr: any[], start: number, end?: number) => arr.slice(start, end));
        functions.set('reverse', (arr: any[]) => [...arr].reverse());
        functions.set('sort', (arr: any[]) => [...arr].sort());
        functions.set('unique', (arr: any[]) => [...new Set(arr)]);
        functions.set('filter', (arr: any[], predicate: string) => this.filterArray(arr, predicate));
        functions.set('map', (arr: any[], transform: string) => this.mapArray(arr, transform));

        // Object functions
        functions.set('keys', (obj: any) => Object.keys(obj));
        functions.set('values', (obj: any) => Object.values(obj));
        functions.set('entries', (obj: any) => Object.entries(obj));
        functions.set('merge', (...objs: any[]) => Object.assign({}, ...objs));
        functions.set('pick', (obj: any, ...keys: string[]) => this.pickKeys(obj, keys));
        functions.set('omit', (obj: any, ...keys: string[]) => this.omitKeys(obj, keys));

        // Conditional functions
        functions.set('if', (condition: any, trueVal: any, falseVal: any) => condition ? trueVal : falseVal);
        functions.set('switch', (value: any, ...cases: any[]) => this.switchCase(value, cases));
        functions.set('default', (value: any, defaultVal: any) => value ?? defaultVal);
        functions.set('exists', (value: any) => value !== undefined && value !== null);

        // Type functions
        functions.set('type', (value: any) => typeof value);
        functions.set('isString', (value: any) => typeof value === 'string');
        functions.set('isNumber', (value: any) => typeof value === 'number');
        functions.set('isBoolean', (value: any) => typeof value === 'boolean');
        functions.set('isArray', (value: any) => Array.isArray(value));
        functions.set('isObject', (value: any) => typeof value === 'object' && value !== null && !Array.isArray(value));
        functions.set('isNull', (value: any) => value === null);
        functions.set('isUndefined', (value: any) => value === undefined);

        // Faker functions (for test data generation)
        functions.set('faker.name', () => this.generateFakeName());
        functions.set('faker.email', () => this.generateFakeEmail());
        functions.set('faker.phone', () => this.generateFakePhone());
        functions.set('faker.address', () => this.generateFakeAddress());
        functions.set('faker.company', () => this.generateFakeCompany());
        functions.set('faker.lorem', (words: number = 10) => this.generateLorem(words));
        functions.set('faker.number', (min: number = 0, max: number = 100) => Math.floor(Math.random() * (max - min + 1)) + min);
        functions.set('faker.boolean', () => Math.random() > 0.5);

        return functions;
    }

    public resolve(template: string, depth: number = 0): string {
        if (depth > this.options.maxDepth!) {
            throw new Error(`Maximum placeholder resolution depth (${this.options.maxDepth}) exceeded`);
        }

        // Check cache
        if (this.options.cache && this.resolverCache.has(template)) {
            return this.resolverCache.get(template)!;
        }

        let resolved = template;
        const { start, end } = this.options.customDelimiters!;
        const regex = new RegExp(`${this.escapeRegex(start)}([^${this.escapeRegex(end)}]+)${this.escapeRegex(end)}`, 'g');

        resolved = resolved.replace(regex, (match, expression) => {
            try {
                const result = this.resolveExpression(expression.trim(), depth + 1);
                return result !== undefined ? String(result) : match;
            } catch (error) {
                if (this.options.throwOnUndefined) {
                    throw error;
                }
                CSReporter.debug(`Failed to resolve placeholder: ${expression} - ${(error as Error).message}`);
                return match;
            }
        });

        // Cache the result
        if (this.options.cache) {
            this.resolverCache.set(template, resolved);
        }

        return resolved;
    }

    private resolveExpression(expression: string, depth: number): any {
        // Handle pipe operations (chaining)
        if (this.options.enableChaining && expression.includes('|')) {
            return this.resolveChainedExpression(expression, depth);
        }

        // Handle function calls
        if (this.options.enableFunctions && expression.includes('(')) {
            return this.resolveFunctionCall(expression, depth);
        }

        // Handle dot notation for nested properties
        if (expression.includes('.')) {
            return this.resolveDotNotation(expression);
        }

        // Handle array/object access
        if (expression.includes('[')) {
            return this.resolveArrayAccess(expression);
        }

        // Direct variable lookup
        return this.resolveVariable(expression);
    }

    private resolveChainedExpression(expression: string, depth: number): any {
        const parts = expression.split('|').map(p => p.trim());
        let result = this.resolveExpression(parts[0], depth);

        for (let i = 1; i < parts.length; i++) {
            const transform = parts[i];
            if (transform.includes('(')) {
                // Function with result as first argument
                const [funcName, argsStr] = transform.split('(');
                const args = argsStr.replace(')', '').split(',').map(a => a.trim());
                result = this.callFunction(funcName.trim(), [result, ...args]);
            } else {
                // Simple transformer
                const transformer = this.customTransformers.get(transform) || this.builtInFunctions.get(transform);
                if (transformer) {
                    result = transformer(result);
                }
            }
        }

        return result;
    }

    private resolveFunctionCall(expression: string, depth: number): any {
        const match = expression.match(/^([a-zA-Z_][\w.]*)\((.*)\)$/);
        if (!match) return undefined;

        const [, funcName, argsStr] = match;
        const args = this.parseArguments(argsStr, depth);

        return this.callFunction(funcName, args);
    }

    private parseArguments(argsStr: string, depth: number): any[] {
        if (!argsStr.trim()) return [];

        const args: any[] = [];
        let current = '';
        let inString = false;
        let stringChar = '';
        let bracketDepth = 0;

        for (let i = 0; i < argsStr.length; i++) {
            const char = argsStr[i];

            if ((char === '"' || char === "'") && argsStr[i - 1] !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                }
            }

            if (!inString) {
                if (char === '(') bracketDepth++;
                if (char === ')') bracketDepth--;
                if (char === ',' && bracketDepth === 0) {
                    args.push(this.parseArgument(current.trim(), depth));
                    current = '';
                    continue;
                }
            }

            current += char;
        }

        if (current.trim()) {
            args.push(this.parseArgument(current.trim(), depth));
        }

        return args;
    }

    private parseArgument(arg: string, depth: number): any {
        // String literal
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            return arg.slice(1, -1);
        }

        // Number literal
        if (/^-?\d+(\.\d+)?$/.test(arg)) {
            return parseFloat(arg);
        }

        // Boolean literal
        if (arg === 'true') return true;
        if (arg === 'false') return false;
        if (arg === 'null') return null;
        if (arg === 'undefined') return undefined;

        // Array literal
        if (arg.startsWith('[') && arg.endsWith(']')) {
            return JSON.parse(arg);
        }

        // Object literal
        if (arg.startsWith('{') && arg.endsWith('}')) {
            return JSON.parse(arg);
        }

        // Variable or expression
        return this.resolveExpression(arg, depth);
    }

    private callFunction(funcName: string, args: any[]): any {
        // Check built-in functions
        if (this.builtInFunctions.has(funcName)) {
            return this.builtInFunctions.get(funcName)!(...args);
        }

        // Check context functions
        if (this.context.functions.has(funcName)) {
            return this.context.functions.get(funcName)!(...args);
        }

        // Check custom transformers
        if (this.customTransformers.has(funcName)) {
            return this.customTransformers.get(funcName)!(...args);
        }

        throw new Error(`Function '${funcName}' not found`);
    }

    private resolveDotNotation(expression: string): any {
        const parts = expression.split('.');
        let current = this.resolveVariable(parts[0]);

        for (let i = 1; i < parts.length; i++) {
            if (current === undefined || current === null) {
                return undefined;
            }
            current = current[parts[i]];
        }

        return current;
    }

    private resolveArrayAccess(expression: string): any {
        const match = expression.match(/^([^[]+)\[([^\]]+)\](.*)$/);
        if (!match) return undefined;

        const [, base, index, rest] = match;
        let current = this.resolveVariable(base);

        if (current === undefined || current === null) {
            return undefined;
        }

        // Resolve index
        const resolvedIndex = /^\d+$/.test(index) ? parseInt(index) : this.resolveVariable(index);
        current = current[resolvedIndex];

        // Continue with rest if present
        if (rest) {
            if (rest.startsWith('.')) {
                return this.resolveDotNotation(current + rest);
            } else if (rest.startsWith('[')) {
                return this.resolveArrayAccess(current + rest);
            }
        }

        return current;
    }

    private resolveVariable(name: string): any {
        // Check different contexts in order
        if (this.context.variables.has(name)) {
            return this.context.variables.get(name);
        }

        if (name.startsWith('env.') && this.context.env) {
            return this.context.env[name.substring(4)];
        }

        if (name.startsWith('response.') && this.context.responses.size > 0) {
            const parts = name.substring(9).split('.');
            const responseKey = parts[0];
            if (this.context.responses.has(responseKey)) {
                const response = this.context.responses.get(responseKey);
                return this.getNestedProperty(response, parts.slice(1));
            }
        }

        if (name.startsWith('cookie.') && this.context.cookies.size > 0) {
            return this.context.cookies.get(name.substring(7));
        }

        if (name.startsWith('header.') && this.context.headers.size > 0) {
            return this.context.headers.get(name.substring(7));
        }

        if (name.startsWith('meta.') && this.context.metadata.size > 0) {
            return this.context.metadata.get(name.substring(5));
        }

        return undefined;
    }

    private getNestedProperty(obj: any, path: string[]): any {
        let current = obj;
        for (const key of path) {
            if (current === undefined || current === null) {
                return undefined;
            }
            current = current[key];
        }
        return current;
    }

    // Helper functions
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private formatDate(date: Date, format?: string): string {
        if (!format) {
            return date.toISOString();
        }

        const replacements: Record<string, string> = {
            'YYYY': date.getFullYear().toString(),
            'MM': String(date.getMonth() + 1).padStart(2, '0'),
            'DD': String(date.getDate()).padStart(2, '0'),
            'HH': String(date.getHours()).padStart(2, '0'),
            'mm': String(date.getMinutes()).padStart(2, '0'),
            'ss': String(date.getSeconds()).padStart(2, '0'),
            'SSS': String(date.getMilliseconds()).padStart(3, '0')
        };

        let result = format;
        for (const [key, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(key, 'g'), value);
        }

        return result;
    }

    private dateAdd(dateStr: string, amount: number, unit: string): string {
        const date = new Date(dateStr);
        const units: Record<string, number> = {
            second: 1000,
            minute: 60000,
            hour: 3600000,
            day: 86400000,
            week: 604800000,
            month: 2592000000,
            year: 31536000000
        };

        if (units[unit]) {
            date.setTime(date.getTime() + (amount * units[unit]));
        }

        return date.toISOString();
    }

    private dateDiff(date1Str: string, date2Str: string, unit: string): number {
        const date1 = new Date(date1Str);
        const date2 = new Date(date2Str);
        const diff = date2.getTime() - date1.getTime();

        const units: Record<string, number> = {
            second: 1000,
            minute: 60000,
            hour: 3600000,
            day: 86400000,
            week: 604800000,
            month: 2592000000,
            year: 31536000000
        };

        return units[unit] ? Math.floor(diff / units[unit]) : 0;
    }

    private htmlEncode(str: string): string {
        const entities: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };

        return str.replace(/[&<>"']/g, char => entities[char]);
    }

    private htmlDecode(str: string): string {
        const entities: Record<string, string> = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#39;': "'"
        };

        return str.replace(/&[a-z]+;|&#\d+;/gi, entity => entities[entity] || entity);
    }

    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    private filterArray(arr: any[], predicate: string): any[] {
        // Simple predicate evaluation
        return arr.filter((item, index) => {
            this.context.variables.set('item', item);
            this.context.variables.set('index', index);
            const result = this.resolveExpression(predicate, 0);
            this.context.variables.delete('item');
            this.context.variables.delete('index');
            return result;
        });
    }

    private mapArray(arr: any[], transform: string): any[] {
        return arr.map((item, index) => {
            this.context.variables.set('item', item);
            this.context.variables.set('index', index);
            const result = this.resolveExpression(transform, 0);
            this.context.variables.delete('item');
            this.context.variables.delete('index');
            return result;
        });
    }

    private pickKeys(obj: any, keys: string[]): any {
        const result: any = {};
        for (const key of keys) {
            if (key in obj) {
                result[key] = obj[key];
            }
        }
        return result;
    }

    private omitKeys(obj: any, keys: string[]): any {
        const result = { ...obj };
        for (const key of keys) {
            delete result[key];
        }
        return result;
    }

    private switchCase(value: any, cases: any[]): any {
        for (let i = 0; i < cases.length - 1; i += 2) {
            if (value === cases[i]) {
                return cases[i + 1];
            }
        }
        // Return last item as default if odd number of arguments
        return cases.length % 2 === 1 ? cases[cases.length - 1] : undefined;
    }

    // Faker data generators
    private generateFakeName(): string {
        const firstNames = ['John', 'Jane', 'Bob', 'Alice', 'Charlie', 'Emma', 'Oliver', 'Sophia'];
        const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'];
        return `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
    }

    private generateFakeEmail(): string {
        const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'example.com', 'test.com'];
        const username = Math.random().toString(36).substring(2, 10);
        return `${username}@${domains[Math.floor(Math.random() * domains.length)]}`;
    }

    private generateFakePhone(): string {
        return `+1-${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 9000) + 1000}`;
    }

    private generateFakeAddress(): string {
        const streets = ['Main St', 'Oak Ave', 'Elm St', 'Park Rd', 'First Ave'];
        const cities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'];
        const number = Math.floor(Math.random() * 9999) + 1;
        return `${number} ${streets[Math.floor(Math.random() * streets.length)]}, ${cities[Math.floor(Math.random() * cities.length)]}`;
    }

    private generateFakeCompany(): string {
        const prefixes = ['Tech', 'Global', 'Advanced', 'Dynamic', 'Smart'];
        const suffixes = ['Solutions', 'Systems', 'Corp', 'Industries', 'Group'];
        return `${prefixes[Math.floor(Math.random() * prefixes.length)]} ${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
    }

    private generateLorem(words: number): string {
        const loremWords = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua'];
        const result: string[] = [];
        for (let i = 0; i < words; i++) {
            result.push(loremWords[Math.floor(Math.random() * loremWords.length)]);
        }
        return result.join(' ');
    }

    // Public methods for managing the resolver
    public setVariable(name: string, value: any): void {
        this.context.variables.set(name, value);
    }

    public getVariable(name: string): any {
        return this.context.variables.get(name);
    }

    public setFunction(name: string, func: Function): void {
        this.context.functions.set(name, func);
    }

    public setTransformer(name: string, func: Function): void {
        this.customTransformers.set(name, func);
    }

    public setResponse(name: string, response: any): void {
        this.context.responses.set(name, response);
    }

    public setCookie(name: string, value: string): void {
        this.context.cookies.set(name, value);
    }

    public setHeader(name: string, value: string): void {
        this.context.headers.set(name, value);
    }

    public setMetadata(name: string, value: any): void {
        this.context.metadata.set(name, value);
    }

    public clearCache(): void {
        this.resolverCache.clear();
    }

    public getContext(): CSPlaceholderContext {
        return this.context;
    }

    public setContext(context: CSPlaceholderContext): void {
        this.context = context;
    }

    public export(): any {
        return {
            variables: Array.from(this.context.variables.entries()),
            functions: Array.from(this.context.functions.keys()),
            responses: Array.from(this.context.responses.keys()),
            cookies: Array.from(this.context.cookies.entries()),
            headers: Array.from(this.context.headers.entries()),
            metadata: Array.from(this.context.metadata.entries())
        };
    }

    public import(data: any): void {
        if (data.variables) {
            this.context.variables.clear();
            data.variables.forEach(([key, value]: [string, any]) => {
                this.context.variables.set(key, value);
            });
        }

        if (data.cookies) {
            this.context.cookies.clear();
            data.cookies.forEach(([key, value]: [string, string]) => {
                this.context.cookies.set(key, value);
            });
        }

        if (data.headers) {
            this.context.headers.clear();
            data.headers.forEach(([key, value]: [string, string]) => {
                this.context.headers.set(key, value);
            });
        }

        if (data.metadata) {
            this.context.metadata.clear();
            data.metadata.forEach(([key, value]: [string, any]) => {
                this.context.metadata.set(key, value);
            });
        }
    }
}

export const placeholderResolver = new CSPlaceholderResolver();