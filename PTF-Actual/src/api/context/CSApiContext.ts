import { OutgoingHttpHeaders } from 'http';
import { CSRequestOptions, CSResponse, CSAuthConfig, CSProxyConfig, CSCookie, CSRequestInfo } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSApiContext {
    public id: string;
    public name: string;
    public baseUrl: string;
    public headers: OutgoingHttpHeaders;
    public auth?: CSAuthConfig;
    public proxy?: CSProxyConfig;
    public timeout: number;
    public variables: Map<string, any>;
    public responses: Map<string, CSResponse>;
    public cookies: CSCookie[];
    public history: CSRequestInfo[];
    public metadata: Record<string, any>;
    private responseAliases: Map<string, string>;
    private extractedData: Map<string, any>;

    constructor(name: string = 'default', baseUrl: string = '') {
        this.id = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.name = name;
        this.baseUrl = baseUrl;
        this.headers = {};
        this.timeout = 30000;
        this.variables = new Map();
        this.responses = new Map();
        this.cookies = [];
        this.history = [];
        this.metadata = {};
        this.responseAliases = new Map();
        this.extractedData = new Map();
    }

    public setVariable(key: string, value: any): void {
        this.variables.set(key, value);
        CSReporter.debug(`Context variable set: ${key}`);
    }

    public getVariable(key: string): any {
        return this.variables.get(key);
    }

    public hasVariable(key: string): boolean {
        return this.variables.has(key);
    }

    public deleteVariable(key: string): boolean {
        return this.variables.delete(key);
    }

    public clearVariables(): void {
        this.variables.clear();
    }

    public getAllVariables(): Record<string, any> {
        const vars: Record<string, any> = {};
        this.variables.forEach((value, key) => {
            vars[key] = value;
        });
        return vars;
    }

    public setHeader(name: string, value: string): void {
        this.headers[name] = value;
    }

    public getHeader(name: string): string | string[] | undefined {
        const value = this.headers[name];
        if (typeof value === 'number') {
            return String(value);
        }
        return value as string | string[] | undefined;
    }

    public removeHeader(name: string): void {
        delete this.headers[name];
    }

    public clearHeaders(): void {
        this.headers = {};
    }

    public setAuth(auth: CSAuthConfig): void {
        this.auth = auth;
    }

    public clearAuth(): void {
        this.auth = undefined;
    }

    public setProxy(proxy: CSProxyConfig): void {
        this.proxy = proxy;
    }

    public clearProxy(): void {
        this.proxy = undefined;
    }

    public setBaseUrl(url: string): void {
        this.baseUrl = url;
    }

    public setTimeout(timeout: number): void {
        this.timeout = timeout;
    }

    public addCookie(cookie: CSCookie): void {
        const existingIndex = this.cookies.findIndex(c =>
            c.name === cookie.name &&
            c.domain === cookie.domain &&
            c.path === cookie.path
        );

        if (existingIndex >= 0) {
            this.cookies[existingIndex] = cookie;
        } else {
            this.cookies.push(cookie);
        }
    }

    public getCookie(name: string, domain?: string): CSCookie | undefined {
        return this.cookies.find(c =>
            c.name === name &&
            (!domain || c.domain === domain)
        );
    }

    public getCookies(domain?: string): CSCookie[] {
        if (!domain) {
            return [...this.cookies];
        }
        return this.cookies.filter(c => c.domain === domain);
    }

    public removeCookie(name: string, domain?: string): void {
        this.cookies = this.cookies.filter(c =>
            !(c.name === name && (!domain || c.domain === domain))
        );
    }

    public clearCookies(): void {
        this.cookies = [];
    }

    public saveResponse(key: string, response: CSResponse): void {
        this.responses.set(key, response);
        this.history.push(response.request);
        CSReporter.debug(`Response saved: ${key}`);
    }

    public getResponse(key: string): CSResponse | undefined {
        const alias = this.responseAliases.get(key);
        return this.responses.get(alias || key);
    }

    public hasResponse(key: string): boolean {
        const alias = this.responseAliases.get(key);
        return this.responses.has(alias || key);
    }

    public deleteResponse(key: string): boolean {
        const alias = this.responseAliases.get(key);
        return this.responses.delete(alias || key);
    }

    public clearResponses(): void {
        this.responses.clear();
        this.responseAliases.clear();
    }

    public setResponseAlias(alias: string, key: string): void {
        this.responseAliases.set(alias, key);
    }

    public addToHistory(request: CSRequestInfo): void {
        this.history.push(request);
    }

    public getHistory(): CSRequestInfo[] {
        return [...this.history];
    }

    public clearHistory(): void {
        this.history = [];
    }

    public getLastResponse(): CSResponse | undefined {
        // Always return the response stored with key 'last' if it exists
        // This ensures we get the actual last API response, not just the last saved response
        return this.responses.get('last');
    }

    public getLastRequest(): CSRequestInfo | undefined {
        // Return the most recent request from history
        if (this.history.length === 0) {
            return undefined;
        }
        return this.history[this.history.length - 1];
    }

    public clear(): void {
        this.variables.clear();
        this.responses.clear();
        this.history = [];
        this.cookies = [];
        this.extractedData.clear();
        this.responseAliases.clear();
    }

    public extractFromResponse(responseKey: string, path: string, variableName: string): any {
        const response = this.getResponse(responseKey);
        if (!response) {
            throw new Error(`Response '${responseKey}' not found`);
        }

        const value = this.extractValue(response.body, path);
        this.setVariable(variableName, value);
        this.extractedData.set(variableName, { responseKey, path, value });

        CSReporter.debug(`Extracted value from ${responseKey}.${path} to ${variableName}`);
        return value;
    }

    private extractValue(data: any, path: string): any {
        if (path.startsWith('$.')) {
            return this.extractJsonPath(data, path);
        }

        const parts = path.split('.');
        let value = data;

        for (const part of parts) {
            if (value === null || value === undefined) {
                return undefined;
            }

            const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (arrayMatch) {
                value = value[arrayMatch[1]];
                if (Array.isArray(value)) {
                    value = value[parseInt(arrayMatch[2])];
                }
            } else {
                value = value[part];
            }
        }

        return value;
    }

    private extractJsonPath(data: any, jsonPath: string): any {
        const path = jsonPath.substring(2);
        const parts = path.split(/\.|\[|\]/).filter(p => p);
        let value = data;

        for (const part of parts) {
            if (value === null || value === undefined) {
                return undefined;
            }

            if (part === '*') {
                if (Array.isArray(value)) {
                    const results: any[] = [];
                    for (const item of value) {
                        if (item !== null && item !== undefined) {
                            results.push(item);
                        }
                    }
                    value = results;
                } else if (typeof value === 'object') {
                    value = Object.values(value);
                }
            } else if (/^\d+$/.test(part)) {
                const index = parseInt(part);
                value = Array.isArray(value) ? value[index] : undefined;
            } else {
                value = value[part];
            }
        }

        return value;
    }

    public mergeOptions(options: CSRequestOptions): CSRequestOptions {
        const merged: CSRequestOptions = { ...options };

        if (this.baseUrl && !merged.url.startsWith('http')) {
            merged.url = this.baseUrl + merged.url;
        }

        merged.headers = { ...this.headers, ...merged.headers };

        if (this.auth && !merged.auth) {
            merged.auth = this.auth;
        }

        if (this.proxy && !merged.proxy) {
            merged.proxy = this.proxy;
        }

        if (!merged.timeout) {
            merged.timeout = this.timeout;
        }

        // Check if followRedirects has been set in context variables
        const followRedirects = this.getVariable('followRedirects');
        if (followRedirects !== undefined && merged.followRedirects === undefined) {
            merged.followRedirects = followRedirects;
        }

        return merged;
    }

    public clone(): CSApiContext {
        const cloned = new CSApiContext(this.name + '_clone', this.baseUrl);

        cloned.headers = { ...this.headers };
        cloned.auth = this.auth ? { ...this.auth } : undefined;
        cloned.proxy = this.proxy ? { ...this.proxy } : undefined;
        cloned.timeout = this.timeout;
        cloned.variables = new Map(this.variables);
        cloned.responses = new Map(this.responses);
        cloned.cookies = [...this.cookies];
        cloned.history = [...this.history];
        cloned.metadata = { ...this.metadata };
        cloned.responseAliases = new Map(this.responseAliases);
        cloned.extractedData = new Map(this.extractedData);

        return cloned;
    }

    public export(): any {
        return {
            id: this.id,
            name: this.name,
            baseUrl: this.baseUrl,
            headers: this.headers,
            auth: this.auth,
            proxy: this.proxy,
            timeout: this.timeout,
            variables: Array.from(this.variables.entries()),
            cookies: this.cookies,
            metadata: this.metadata
        };
    }

    public import(data: any): void {
        if (data.name) this.name = data.name;
        if (data.baseUrl) this.baseUrl = data.baseUrl;
        if (data.headers) this.headers = data.headers;
        if (data.auth) this.auth = data.auth;
        if (data.proxy) this.proxy = data.proxy;
        if (data.timeout) this.timeout = data.timeout;
        if (data.variables) {
            this.variables.clear();
            data.variables.forEach(([key, value]: [string, any]) => {
                this.variables.set(key, value);
            });
        }
        if (data.cookies) this.cookies = data.cookies;
        if (data.metadata) this.metadata = data.metadata;
    }

    public reset(): void {
        this.variables.clear();
        this.responses.clear();
        this.cookies = [];
        this.history = [];
        this.responseAliases.clear();
        this.extractedData.clear();
        CSReporter.debug(`Context '${this.name}' reset`);
    }

    public getStats(): any {
        return {
            variableCount: this.variables.size,
            responseCount: this.responses.size,
            cookieCount: this.cookies.length,
            requestCount: this.history.length,
            extractedDataCount: this.extractedData.size
        };
    }

    public setMetadata(key: string, value: any): void {
        this.metadata[key] = value;
    }

    public getMetadata(key?: string): any {
        return key ? this.metadata[key] : this.metadata;
    }

    public clearMetadata(): void {
        this.metadata = {};
    }

    public setLastResponse(response: CSResponse): void {
        this.saveResponse('last', response);
    }

    public removeVariable(key: string): void {
        this.variables.delete(key);
    }
}