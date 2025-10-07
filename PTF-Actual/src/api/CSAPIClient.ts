import { CSHttpClient } from './client/CSHttpClient';
import { CSRequestBuilder } from './client/CSRequestBuilder';
import { CSApiContext } from './context/CSApiContext';
import { CSApiContextManager } from './context/CSApiContextManager';
import { CSAuthenticationHandler } from './client/CSAuthenticationHandler';
import { CSResponseParser } from './client/CSResponseParser';
import { CSConnectionPool } from './client/CSConnectionPool';
import { CSRetryHandler } from './client/CSRetryHandler';
import {
    CSRequestOptions,
    CSResponse,
    CSAuthConfig,
    CSProxyConfig,
    CSValidationConfig,
    CSValidationResult
} from './types/CSApiTypes';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export class CSAPIClient {
    private httpClient: CSHttpClient;
    private contextManager: CSApiContextManager;
    private configManager: CSConfigurationManager;
    private responseParser: CSResponseParser;
    private authHandler: CSAuthenticationHandler;
    private connectionPool: CSConnectionPool;
    private baseUrl?: string;

    constructor() {
        this.httpClient = CSHttpClient.getInstance();
        this.contextManager = CSApiContextManager.getInstance();
        this.configManager = CSConfigurationManager.getInstance();
        this.responseParser = new CSResponseParser();
        this.authHandler = new CSAuthenticationHandler();
        this.connectionPool = CSConnectionPool.getInstance();
    }

    public async request<T = any>(options: CSRequestOptions): Promise<CSResponse<T>> {
        const context = this.contextManager.getCurrentContext();
        const mergedOptions = context.mergeOptions(options);

        CSReporter.debug(`API Request: ${mergedOptions.method} ${mergedOptions.url}`);

        try {
            const response = await this.httpClient.request<T>(mergedOptions);

            // Save response to context
            const responseKey = `${mergedOptions.method}_${new URL(mergedOptions.url).pathname}`;
            context.saveResponse(responseKey, response);

            // Extract cookies if present
            if (response.cookies) {
                response.cookies.forEach(cookie => context.addCookie(cookie));
            }

            CSReporter.pass(`API Request successful: ${response.status}`);
            return response;

        } catch (error) {
            // Check if this is an HTTP error with a response
            if ((error as any).response) {
                const response = (error as any).response;

                // Save response to context even for error responses
                const responseKey = `${mergedOptions.method}_${new URL(mergedOptions.url).pathname}`;
                context.saveResponse(responseKey, response);

                // Extract cookies if present
                if (response.cookies) {
                    response.cookies.forEach((cookie: any) => context.addCookie(cookie));
                }

                CSReporter.info(`API Request returned status: ${response.status}`);
                return response;
            }

            CSReporter.fail(`API Request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    public async get<T = any>(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'GET' });
    }

    public async post<T = any>(url: string, body?: any, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'POST', body });
    }

    public async put<T = any>(url: string, body?: any, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'PUT', body });
    }

    public async patch<T = any>(url: string, body?: any, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'PATCH', body });
    }

    public async delete<T = any>(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'DELETE' });
    }

    public async head(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse<void>> {
        return this.request<void>({ ...options, url, method: 'HEAD' });
    }

    public async options(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse> {
        return this.request({ ...options, url, method: 'OPTIONS' });
    }

    public builder(url?: string): CSRequestBuilder {
        const builder = new CSRequestBuilder(url);
        const context = this.contextManager.getCurrentContext();

        if (context.baseUrl) {
            builder.setUrl(context.baseUrl + (url || ''));
        }

        // Apply context headers
        Object.entries(context.headers).forEach(([key, value]) => {
            builder.setHeader(key, value as string);
        });

        // Apply context auth
        if (context.auth) {
            builder.setAuth(context.auth);
        }

        return builder;
    }

    public async execute(builder: CSRequestBuilder): Promise<CSResponse> {
        const options = builder.build();
        return this.request(options);
    }

    public createContext(name: string, baseUrl?: string): CSApiContext {
        return this.contextManager.createContext(name, baseUrl);
    }

    public getContext(name?: string): CSApiContext {
        return this.contextManager.getContext(name);
    }

    public switchContext(name: string): void {
        this.contextManager.switchContext(name);
    }

    public setBaseUrl(url: string): void {
        this.contextManager.getCurrentContext().setBaseUrl(url);
    }

    public setDefaultHeader(name: string, value: string): void {
        this.contextManager.getCurrentContext().setHeader(name, value);
    }

    public setAuth(auth: CSAuthConfig): void {
        this.contextManager.getCurrentContext().setAuth(auth);
    }

    public setProxy(proxy: CSProxyConfig): void {
        this.contextManager.getCurrentContext().setProxy(proxy);
    }

    public setTimeout(timeout: number): void {
        this.contextManager.getCurrentContext().setTimeout(timeout);
    }

    public setVariable(key: string, value: any): void {
        this.contextManager.getCurrentContext().setVariable(key, value);
    }

    public getVariable(key: string): any {
        return this.contextManager.getCurrentContext().getVariable(key);
    }

    public extractFromResponse(responseKey: string, path: string, variableName: string): any {
        return this.contextManager.getCurrentContext().extractFromResponse(responseKey, path, variableName);
    }

    public getResponse(key: string): CSResponse | undefined {
        return this.contextManager.getCurrentContext().getResponse(key);
    }

    public getLastResponse(): CSResponse | undefined {
        const context = this.contextManager.getCurrentContext();
        const responses = Array.from(context.responses.values());
        return responses[responses.length - 1];
    }

    public clearCookies(): void {
        this.httpClient.clearCookies();
        this.contextManager.getCurrentContext().clearCookies();
    }

    public async uploadFile(
        url: string,
        filePath: string,
        fieldName?: string,
        additionalFields?: Record<string, any>,
        options?: Partial<CSRequestOptions>
    ): Promise<CSResponse> {
        return this.httpClient.uploadFile(url, filePath, fieldName || 'file', options);
    }

    public async downloadFile(
        url: string,
        destinationPath: string,
        options?: Partial<CSRequestOptions>
    ): Promise<void> {
        return this.httpClient.downloadFile(url, destinationPath, options);
    }

    public async testConnection(url: string, timeout?: number): Promise<boolean> {
        return this.httpClient.testConnection(url, timeout);
    }

    public async healthCheck(url: string, expectedStatus: number = 200): Promise<boolean> {
        try {
            const response = await this.get(url, {
                timeout: 5000,
                validateStatus: (status) => status === expectedStatus
            });
            return response.status === expectedStatus;
        } catch {
            return false;
        }
    }

    public getConnectionStats(): any {
        return this.connectionPool.getConnectionStats();
    }

    public closeIdleConnections(maxIdleTime?: number): number {
        return this.connectionPool.closeIdleConnections(maxIdleTime);
    }

    public destroyAllConnections(): void {
        this.connectionPool.destroyAllAgents();
    }

    public clearTokenCache(): void {
        this.authHandler.clearTokenCache();
    }

    public getContextStats(): any {
        return this.contextManager.getStats();
    }

    public resetContext(name?: string): void {
        this.contextManager.resetContext(name);
    }

    public exportContext(name?: string): any {
        const context = this.contextManager.getContext(name);
        return context.export();
    }

    public importContext(name: string, data: any): void {
        const context = this.contextManager.getContext(name);
        context.import(data);
    }

    public async parseResponse(response: CSResponse, contentType?: string): Promise<any> {
        return this.responseParser.parse(response, contentType);
    }

    public destroy(): void {
        this.connectionPool.destroy();
        this.contextManager.destroy();
        CSReporter.info('API Client destroyed');
    }

    public setAuthentication(authConfig: CSAuthConfig): void {
        this.authHandler.setAuthentication(authConfig);
    }

    public clearAuthentication(): void {
        this.authHandler.clearAuthentication();
    }

    public getHttpClient(): CSHttpClient {
        return this.httpClient;
    }

    public getBaseUrl(): string | undefined {
        return this.baseUrl;
    }
}

// Export singleton instance for convenience
export const apiClient = new CSAPIClient();

// Export all types
export * from './types/CSApiTypes';

// Export builders and utilities
export { CSRequestBuilder } from './client/CSRequestBuilder';
export { CSApiContext } from './context/CSApiContext';
export { CSApiContextManager } from './context/CSApiContextManager';
export { CSHttpClient } from './client/CSHttpClient';
export { CSAuthenticationHandler } from './client/CSAuthenticationHandler';
export { CSResponseParser } from './client/CSResponseParser';