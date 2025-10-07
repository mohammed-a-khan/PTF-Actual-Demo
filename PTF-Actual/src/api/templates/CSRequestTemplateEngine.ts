import { CSPlaceholderResolver, CSPlaceholderContext } from './CSPlaceholderResolver';
import { CSRequestOptions } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface CSRequestTemplate {
    id: string;
    name?: string;
    description?: string;
    method: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, any>;
    body?: any;
    auth?: any;
    timeout?: number;
    retries?: number;
    variables?: Record<string, any>;
    assertions?: any[];
    pre?: CSTemplateScript;
    post?: CSTemplateScript;
    metadata?: Record<string, any>;
}

export interface CSTemplateScript {
    script?: string;
    file?: string;
    function?: string;
}

export interface CSTemplateCollection {
    id: string;
    name: string;
    description?: string;
    version?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    auth?: any;
    variables?: Record<string, any>;
    templates: CSRequestTemplate[];
    setup?: CSTemplateScript;
    teardown?: CSTemplateScript;
    metadata?: Record<string, any>;
}

export interface CSTemplateEngineOptions {
    templatesDir?: string;
    enableScripts?: boolean;
    enableDynamicImports?: boolean;
    validateTemplates?: boolean;
    cacheTemplates?: boolean;
    resolverOptions?: any;
}

export class CSRequestTemplateEngine {
    private resolver: CSPlaceholderResolver;
    private templates: Map<string, CSRequestTemplate>;
    private collections: Map<string, CSTemplateCollection>;
    private options: CSTemplateEngineOptions;
    private scriptCache: Map<string, Function>;
    private templateCache: Map<string, string>;

    constructor(resolver?: CSPlaceholderResolver, options?: CSTemplateEngineOptions) {
        this.resolver = resolver || new CSPlaceholderResolver();
        this.templates = new Map();
        this.collections = new Map();
        this.scriptCache = new Map();
        this.templateCache = new Map();
        this.options = {
            templatesDir: './templates',
            enableScripts: true,
            enableDynamicImports: false,
            validateTemplates: true,
            cacheTemplates: true,
            ...options
        };
    }

    public async loadTemplate(templatePath: string): Promise<CSRequestTemplate> {
        try {
            const ext = path.extname(templatePath).toLowerCase();
            let content: string;

            // Check cache
            if (this.options.cacheTemplates && this.templateCache.has(templatePath)) {
                content = this.templateCache.get(templatePath)!;
            } else {
                content = await fs.promises.readFile(templatePath, 'utf-8');
                if (this.options.cacheTemplates) {
                    this.templateCache.set(templatePath, content);
                }
            }

            let template: CSRequestTemplate;

            switch (ext) {
                case '.json':
                    template = JSON.parse(content);
                    break;
                case '.yaml':
                case '.yml':
                    template = yaml.load(content) as CSRequestTemplate;
                    break;
                case '.js':
                case '.ts':
                    if (this.options.enableDynamicImports) {
                        template = await this.loadDynamicTemplate(templatePath);
                    } else {
                        throw new Error('Dynamic imports are disabled');
                    }
                    break;
                default:
                    // Try to parse as JSON
                    template = JSON.parse(content);
            }

            if (this.options.validateTemplates) {
                this.validateTemplate(template);
            }

            // Register template
            this.templates.set(template.id, template);

            CSReporter.info(`Template loaded: ${template.name || template.id}`);
            return template;

        } catch (error) {
            CSReporter.error(`Failed to load template: ${templatePath} - ${(error as Error).message}`);
            throw error;
        }
    }

    public async loadCollection(collectionPath: string): Promise<CSTemplateCollection> {
        try {
            const content = await fs.promises.readFile(collectionPath, 'utf-8');
            const ext = path.extname(collectionPath).toLowerCase();

            let collection: CSTemplateCollection;

            if (ext === '.yaml' || ext === '.yml') {
                collection = yaml.load(content) as CSTemplateCollection;
            } else {
                collection = JSON.parse(content);
            }

            if (this.options.validateTemplates) {
                this.validateCollection(collection);
            }

            // Register collection and its templates
            this.collections.set(collection.id, collection);
            for (const template of collection.templates) {
                this.templates.set(template.id, template);
            }

            CSReporter.info(`Collection loaded: ${collection.name} with ${collection.templates.length} templates`);
            return collection;

        } catch (error) {
            CSReporter.error(`Failed to load collection: ${collectionPath} - ${(error as Error).message}`);
            throw error;
        }
    }

    public async loadTemplatesFromDirectory(directory?: string): Promise<CSRequestTemplate[]> {
        const dir = directory || this.options.templatesDir!;
        const templates: CSRequestTemplate[] = [];

        try {
            const files = await fs.promises.readdir(dir);

            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = await fs.promises.stat(filePath);

                if (stat.isDirectory()) {
                    // Recursively load from subdirectories
                    const subTemplates = await this.loadTemplatesFromDirectory(filePath);
                    templates.push(...subTemplates);
                } else if (this.isTemplateFile(file)) {
                    try {
                        const template = await this.loadTemplate(filePath);
                        templates.push(template);
                    } catch (error) {
                        CSReporter.warn(`Skipping invalid template: ${filePath}`);
                    }
                }
            }

            CSReporter.info(`Loaded ${templates.length} templates from ${dir}`);
            return templates;

        } catch (error) {
            CSReporter.error(`Failed to load templates from directory: ${dir} - ${(error as Error).message}`);
            throw error;
        }
    }

    public async processTemplate(
        templateId: string,
        variables?: Record<string, any>,
        context?: CSPlaceholderContext
    ): Promise<CSRequestOptions> {
        const template = this.templates.get(templateId);

        if (!template) {
            throw new Error(`Template '${templateId}' not found`);
        }

        // Set up context
        if (context) {
            this.resolver.setContext(context);
        }

        // Merge variables
        const mergedVariables = {
            ...template.variables,
            ...variables
        };

        // Set variables in resolver
        for (const [key, value] of Object.entries(mergedVariables)) {
            this.resolver.setVariable(key, value);
        }

        // Execute pre-script
        if (template.pre && this.options.enableScripts) {
            await this.executeScript(template.pre, 'pre');
        }

        // Process template fields
        const processed: CSRequestOptions = {
            method: this.resolveValue(template.method) as any,
            url: this.resolveValue(template.url) as string,
            headers: this.resolveObject(template.headers),
            query: this.resolveObject(template.query),
            body: this.resolveValue(template.body),
            timeout: template.timeout,
            retries: template.retries
        };

        // Process auth
        if (template.auth) {
            processed.auth = this.resolveValue(template.auth);
        }

        // Execute post-script
        if (template.post && this.options.enableScripts) {
            await this.executeScript(template.post, 'post', processed);
        }

        CSReporter.debug(`Template processed: ${template.name || template.id}`);
        return processed;
    }

    public async processCollection(
        collectionId: string,
        variables?: Record<string, any>,
        context?: CSPlaceholderContext
    ): Promise<CSRequestOptions[]> {
        const collection = this.collections.get(collectionId);

        if (!collection) {
            throw new Error(`Collection '${collectionId}' not found`);
        }

        const requests: CSRequestOptions[] = [];

        // Set up context
        if (context) {
            this.resolver.setContext(context);
        }

        // Merge variables
        const mergedVariables = {
            ...collection.variables,
            ...variables
        };

        // Set variables
        for (const [key, value] of Object.entries(mergedVariables)) {
            this.resolver.setVariable(key, value);
        }

        // Set collection-level properties
        if (collection.baseUrl) {
            this.resolver.setVariable('baseUrl', collection.baseUrl);
        }

        // Execute setup script
        if (collection.setup && this.options.enableScripts) {
            await this.executeScript(collection.setup, 'setup');
        }

        // Process each template
        for (const template of collection.templates) {
            try {
                // Merge collection headers with template headers
                const mergedTemplate = {
                    ...template,
                    headers: {
                        ...collection.headers,
                        ...template.headers
                    },
                    auth: template.auth || collection.auth
                };

                // Update template in map
                this.templates.set(template.id, mergedTemplate);

                // Process template
                const request = await this.processTemplate(template.id, mergedVariables);
                requests.push(request);

            } catch (error) {
                CSReporter.error(`Failed to process template '${template.id}': ${(error as Error).message}`);
                if (this.options.validateTemplates) {
                    throw error;
                }
            }
        }

        // Execute teardown script
        if (collection.teardown && this.options.enableScripts) {
            await this.executeScript(collection.teardown, 'teardown');
        }

        CSReporter.info(`Collection processed: ${collection.name} - ${requests.length} requests`);
        return requests;
    }

    private resolveValue(value: any): any {
        if (value === null || value === undefined) {
            return value;
        }

        if (typeof value === 'string') {
            return this.resolver.resolve(value);
        }

        if (Array.isArray(value)) {
            return value.map(item => this.resolveValue(item));
        }

        if (typeof value === 'object') {
            return this.resolveObject(value);
        }

        return value;
    }

    private resolveObject(obj: any): any {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }

        const resolved: any = {};

        for (const [key, value] of Object.entries(obj)) {
            // Resolve key (in case it contains placeholders)
            const resolvedKey = this.resolver.resolve(key);
            resolved[resolvedKey] = this.resolveValue(value);
        }

        return resolved;
    }

    private async executeScript(script: CSTemplateScript, phase: string, data?: any): Promise<void> {
        try {
            let scriptFunction: Function;

            if (script.script) {
                // Inline script
                scriptFunction = this.compileScript(script.script, phase);
            } else if (script.file) {
                // Script from file
                scriptFunction = await this.loadScriptFile(script.file);
            } else if (script.function) {
                // Named function
                const cachedFunction = this.scriptCache.get(script.function) || this.resolver.getContext().functions.get(script.function);

                if (!cachedFunction) {
                    throw new Error(`Script function '${script.function}' not found`);
                }
                scriptFunction = cachedFunction;
            } else {
                return;
            }

            // Execute script with context
            const context = {
                resolver: this.resolver,
                variables: this.resolver.getContext().variables,
                data,
                phase,
                console: {
                    log: (msg: string) => CSReporter.info(`[Script] ${msg}`),
                    error: (msg: string) => CSReporter.error(`[Script] ${msg}`),
                    warn: (msg: string) => CSReporter.warn(`[Script] ${msg}`),
                    debug: (msg: string) => CSReporter.debug(`[Script] ${msg}`)
                },
                require: this.options.enableDynamicImports ? require : undefined
            };

            await scriptFunction.call(context, context);

        } catch (error) {
            CSReporter.error(`Script execution failed (${phase}): ${(error as Error).message}`);
            if (this.options.validateTemplates) {
                throw error;
            }
        }
    }

    private compileScript(code: string, name: string): Function {
        const cacheKey = `inline_${name}_${code.substring(0, 50)}`;

        if (this.scriptCache.has(cacheKey)) {
            return this.scriptCache.get(cacheKey)!;
        }

        try {
            // Create function from code
            const scriptFunction = new Function('context', `
                const { resolver, variables, data, phase, console } = context;
                ${code}
            `);

            this.scriptCache.set(cacheKey, scriptFunction);
            return scriptFunction;

        } catch (error) {
            throw new Error(`Failed to compile script: ${(error as Error).message}`);
        }
    }

    private async loadScriptFile(filePath: string): Promise<Function> {
        if (this.scriptCache.has(filePath)) {
            return this.scriptCache.get(filePath)!;
        }

        try {
            const absolutePath = path.isAbsolute(filePath)
                ? filePath
                : path.join(this.options.templatesDir!, filePath);

            const content = await fs.promises.readFile(absolutePath, 'utf-8');
            const scriptFunction = this.compileScript(content, path.basename(filePath));

            this.scriptCache.set(filePath, scriptFunction);
            return scriptFunction;

        } catch (error) {
            throw new Error(`Failed to load script file '${filePath}': ${(error as Error).message}`);
        }
    }

    private async loadDynamicTemplate(templatePath: string): Promise<CSRequestTemplate> {
        try {
            const module = require(templatePath);
            return module.default || module;
        } catch (error) {
            throw new Error(`Failed to load dynamic template: ${(error as Error).message}`);
        }
    }

    private isTemplateFile(fileName: string): boolean {
        const extensions = ['.json', '.yaml', '.yml'];
        if (this.options.enableDynamicImports) {
            extensions.push('.js', '.ts');
        }
        return extensions.some(ext => fileName.endsWith(ext));
    }

    private validateTemplate(template: CSRequestTemplate): void {
        const errors: string[] = [];

        if (!template.id) {
            errors.push('Template must have an id');
        }

        if (!template.method) {
            errors.push('Template must have a method');
        }

        if (!template.url) {
            errors.push('Template must have a url');
        }

        const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        if (template.method && !validMethods.includes(template.method.toUpperCase())) {
            errors.push(`Invalid method: ${template.method}`);
        }

        if (errors.length > 0) {
            throw new Error(`Template validation failed:\n${errors.join('\n')}`);
        }
    }

    private validateCollection(collection: CSTemplateCollection): void {
        const errors: string[] = [];

        if (!collection.id) {
            errors.push('Collection must have an id');
        }

        if (!collection.name) {
            errors.push('Collection must have a name');
        }

        if (!collection.templates || !Array.isArray(collection.templates)) {
            errors.push('Collection must have templates array');
        }

        if (collection.templates) {
            collection.templates.forEach((template, index) => {
                try {
                    this.validateTemplate(template);
                } catch (error) {
                    errors.push(`Template ${index}: ${(error as Error).message}`);
                }
            });
        }

        if (errors.length > 0) {
            throw new Error(`Collection validation failed:\n${errors.join('\n')}`);
        }
    }

    public createTemplate(options: Partial<CSRequestTemplate>): CSRequestTemplate {
        const template: CSRequestTemplate = {
            id: options.id || `template_${Date.now()}`,
            name: options.name,
            description: options.description,
            method: options.method || 'GET',
            url: options.url || '',
            headers: options.headers,
            query: options.query,
            body: options.body,
            auth: options.auth,
            timeout: options.timeout,
            retries: options.retries,
            variables: options.variables,
            assertions: options.assertions,
            pre: options.pre,
            post: options.post,
            metadata: options.metadata
        };

        if (this.options.validateTemplates) {
            this.validateTemplate(template);
        }

        this.templates.set(template.id, template);
        return template;
    }

    public createCollection(options: Partial<CSTemplateCollection>): CSTemplateCollection {
        const collection: CSTemplateCollection = {
            id: options.id || `collection_${Date.now()}`,
            name: options.name || 'Unnamed Collection',
            description: options.description,
            version: options.version,
            baseUrl: options.baseUrl,
            headers: options.headers,
            auth: options.auth,
            variables: options.variables,
            templates: options.templates || [],
            setup: options.setup,
            teardown: options.teardown,
            metadata: options.metadata
        };

        if (this.options.validateTemplates) {
            this.validateCollection(collection);
        }

        this.collections.set(collection.id, collection);
        return collection;
    }

    public async saveTemplate(template: CSRequestTemplate, filePath: string): Promise<void> {
        try {
            const ext = path.extname(filePath).toLowerCase();
            let content: string;

            if (ext === '.yaml' || ext === '.yml') {
                content = yaml.dump(template);
            } else {
                content = JSON.stringify(template, null, 2);
            }

            await fs.promises.writeFile(filePath, content, 'utf-8');
            CSReporter.info(`Template saved: ${filePath}`);

        } catch (error) {
            CSReporter.error(`Failed to save template: ${(error as Error).message}`);
            throw error;
        }
    }

    public async saveCollection(collection: CSTemplateCollection, filePath: string): Promise<void> {
        try {
            const ext = path.extname(filePath).toLowerCase();
            let content: string;

            if (ext === '.yaml' || ext === '.yml') {
                content = yaml.dump(collection);
            } else {
                content = JSON.stringify(collection, null, 2);
            }

            await fs.promises.writeFile(filePath, content, 'utf-8');
            CSReporter.info(`Collection saved: ${filePath}`);

        } catch (error) {
            CSReporter.error(`Failed to save collection: ${(error as Error).message}`);
            throw error;
        }
    }

    public getTemplate(id: string): CSRequestTemplate | undefined {
        return this.templates.get(id);
    }

    public getCollection(id: string): CSTemplateCollection | undefined {
        return this.collections.get(id);
    }

    public listTemplates(): CSRequestTemplate[] {
        return Array.from(this.templates.values());
    }

    public listCollections(): CSTemplateCollection[] {
        return Array.from(this.collections.values());
    }

    public registerScript(name: string, func: Function): void {
        this.scriptCache.set(name, func);
    }

    public clearCache(): void {
        this.templateCache.clear();
        this.scriptCache.clear();
        this.resolver.clearCache();
    }

    public getResolver(): CSPlaceholderResolver {
        return this.resolver;
    }

    public setResolver(resolver: CSPlaceholderResolver): void {
        this.resolver = resolver;
    }

    public async processRequest(request: any, context?: any): Promise<any> {
        // Process request with variable resolution
        if (!request) return request;

        // Set context if provided
        if (context) {
            this.resolver.setContext(context);

            // Set variables from context
            if (context.variables) {
                for (const [key, value] of Object.entries(context.variables)) {
                    this.resolver.setVariable(key, value);
                }
            }
        }

        return this.resolveValue(request);
    }

    public export(): any {
        return {
            templates: Array.from(this.templates.entries()),
            collections: Array.from(this.collections.entries()),
            scripts: Array.from(this.scriptCache.keys())
        };
    }

    public import(data: any): void {
        if (data.templates) {
            this.templates.clear();
            data.templates.forEach(([id, template]: [string, CSRequestTemplate]) => {
                this.templates.set(id, template);
            });
        }

        if (data.collections) {
            this.collections.clear();
            data.collections.forEach(([id, collection]: [string, CSTemplateCollection]) => {
                this.collections.set(id, collection);
            });
        }

        CSReporter.info('Template engine data imported');
    }
}

export const templateEngine = new CSRequestTemplateEngine();