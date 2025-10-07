import { CSApiContext } from './CSApiContext';
import { CSReporter } from '../../reporter/CSReporter';

export class CSApiContextManager {
    private static instance: CSApiContextManager;
    private contexts: Map<string, CSApiContext>;
    private activeContext: string;
    private sharedData: Map<string, any>;
    private globalHeaders: Record<string, string>;

    private constructor() {
        this.contexts = new Map();
        this.activeContext = 'default';
        this.sharedData = new Map();
        this.globalHeaders = {};

        // Create default context
        this.contexts.set('default', new CSApiContext('default'));
    }

    public static getInstance(): CSApiContextManager {
        if (!CSApiContextManager.instance) {
            CSApiContextManager.instance = new CSApiContextManager();
        }
        return CSApiContextManager.instance;
    }

    public createContext(name: string, baseUrl?: string): CSApiContext {
        if (this.contexts.has(name)) {
            throw new Error(`Context '${name}' already exists`);
        }

        const context = new CSApiContext(name, baseUrl);

        // Apply global headers to new context
        Object.entries(this.globalHeaders).forEach(([key, value]) => {
            context.setHeader(key, value);
        });

        this.contexts.set(name, context);
        CSReporter.info(`Created API context: ${name}`);

        return context;
    }

    public getContext(name?: string): CSApiContext {
        const contextName = name || this.activeContext;
        const context = this.contexts.get(contextName);

        if (!context) {
            throw new Error(`Context '${contextName}' not found`);
        }

        return context;
    }

    public getCurrentContext(): CSApiContext {
        return this.getContext(this.activeContext);
    }

    public switchContext(name: string): void {
        if (!this.contexts.has(name)) {
            throw new Error(`Context '${name}' not found`);
        }

        this.activeContext = name;
        CSReporter.debug(`Switched to context: ${name}`);
    }

    public setCurrentContext(name: string): void {
        this.switchContext(name);
    }

    public deleteContext(name: string): boolean {
        if (name === 'default') {
            throw new Error('Cannot delete default context');
        }

        if (this.activeContext === name) {
            this.activeContext = 'default';
        }

        const deleted = this.contexts.delete(name);
        if (deleted) {
            CSReporter.debug(`Deleted context: ${name}`);
        }

        return deleted;
    }

    public listContexts(): string[] {
        return Array.from(this.contexts.keys());
    }

    public hasContext(name: string): boolean {
        return this.contexts.has(name);
    }

    public cloneContext(sourceName: string, targetName: string): CSApiContext {
        const source = this.getContext(sourceName);
        const cloned = source.clone();

        cloned.name = targetName;
        this.contexts.set(targetName, cloned);

        CSReporter.debug(`Cloned context '${sourceName}' to '${targetName}'`);
        return cloned;
    }

    public mergeContexts(source: string, target: string, overwrite: boolean = false): void {
        const sourceContext = this.getContext(source);
        const targetContext = this.getContext(target);

        // Merge variables
        sourceContext.variables.forEach((value, key) => {
            if (overwrite || !targetContext.hasVariable(key)) {
                targetContext.setVariable(key, value);
            }
        });

        // Merge headers
        Object.entries(sourceContext.headers).forEach(([key, value]) => {
            if (overwrite || !targetContext.headers[key]) {
                targetContext.setHeader(key, value as string);
            }
        });

        // Merge cookies
        sourceContext.cookies.forEach(cookie => {
            targetContext.addCookie(cookie);
        });

        CSReporter.debug(`Merged context '${source}' into '${target}'`);
    }

    public setSharedData(key: string, value: any): void {
        this.sharedData.set(key, value);
        CSReporter.debug(`Set shared data: ${key}`);
    }

    public getSharedData(key: string): any {
        return this.sharedData.get(key);
    }

    public hasSharedData(key: string): boolean {
        return this.sharedData.has(key);
    }

    public deleteSharedData(key: string): boolean {
        return this.sharedData.delete(key);
    }

    public clearSharedData(): void {
        this.sharedData.clear();
    }

    public setGlobalHeader(name: string, value: string): void {
        this.globalHeaders[name] = value;

        // Apply to all existing contexts
        this.contexts.forEach(context => {
            context.setHeader(name, value);
        });

        CSReporter.debug(`Set global header: ${name}`);
    }

    public removeGlobalHeader(name: string): void {
        delete this.globalHeaders[name];

        // Remove from all existing contexts
        this.contexts.forEach(context => {
            context.removeHeader(name);
        });

        CSReporter.debug(`Removed global header: ${name}`);
    }

    public clearGlobalHeaders(): void {
        this.globalHeaders = {};

        // Clear headers in all contexts
        this.contexts.forEach(context => {
            context.clearHeaders();
        });
    }

    public exportAll(): any {
        const exported: any = {
            activeContext: this.activeContext,
            sharedData: Array.from(this.sharedData.entries()),
            globalHeaders: this.globalHeaders,
            contexts: {}
        };

        this.contexts.forEach((context, name) => {
            exported.contexts[name] = context.export();
        });

        return exported;
    }

    public importAll(data: any): void {
        if (data.activeContext) {
            this.activeContext = data.activeContext;
        }

        if (data.sharedData) {
            this.sharedData.clear();
            data.sharedData.forEach(([key, value]: [string, any]) => {
                this.sharedData.set(key, value);
            });
        }

        if (data.globalHeaders) {
            this.globalHeaders = data.globalHeaders;
        }

        if (data.contexts) {
            this.contexts.clear();
            Object.entries(data.contexts).forEach(([name, contextData]) => {
                const context = new CSApiContext(name);
                context.import(contextData);
                this.contexts.set(name, context);
            });
        }

        // Ensure default context exists
        if (!this.contexts.has('default')) {
            this.contexts.set('default', new CSApiContext('default'));
        }
    }

    public resetAll(): void {
        this.contexts.forEach(context => context.reset());
        this.sharedData.clear();
        CSReporter.debug('All contexts reset');
    }

    public resetContext(name?: string): void {
        const context = this.getContext(name);
        context.reset();
    }

    public getStats(): any {
        const stats: any = {
            contextCount: this.contexts.size,
            activeContext: this.activeContext,
            sharedDataCount: this.sharedData.size,
            globalHeaderCount: Object.keys(this.globalHeaders).length,
            contexts: {}
        };

        this.contexts.forEach((context, name) => {
            stats.contexts[name] = context.getStats();
        });

        return stats;
    }

    public findContextByBaseUrl(baseUrl: string): CSApiContext | undefined {
        for (const context of this.contexts.values()) {
            if (context.baseUrl === baseUrl) {
                return context;
            }
        }
        return undefined;
    }

    public getAllResponses(): Map<string, any> {
        const allResponses = new Map();

        this.contexts.forEach((context, contextName) => {
            context.responses.forEach((response, responseKey) => {
                allResponses.set(`${contextName}.${responseKey}`, response);
            });
        });

        return allResponses;
    }

    public getAllVariables(): Map<string, any> {
        const allVariables = new Map();

        this.contexts.forEach((context, contextName) => {
            context.variables.forEach((value, key) => {
                allVariables.set(`${contextName}.${key}`, value);
            });
        });

        // Add shared data
        this.sharedData.forEach((value, key) => {
            allVariables.set(`shared.${key}`, value);
        });

        return allVariables;
    }

    public clearAllResponses(): void {
        this.contexts.forEach(context => context.clearResponses());
        CSReporter.debug('Cleared all responses from all contexts');
    }

    public clearAllVariables(): void {
        this.contexts.forEach(context => context.clearVariables());
        this.sharedData.clear();
        CSReporter.debug('Cleared all variables from all contexts');
    }

    public destroy(): void {
        this.contexts.clear();
        this.sharedData.clear();
        this.globalHeaders = {};
        this.activeContext = 'default';

        // Recreate default context
        this.contexts.set('default', new CSApiContext('default'));

        CSReporter.info('API Context Manager destroyed and reset');
    }
}