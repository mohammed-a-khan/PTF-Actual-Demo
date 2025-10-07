import { CSHttpClient } from '../client/CSHttpClient';
import { CSApiContextManager } from '../context/CSApiContextManager';
import { CSSoapEnvelopeBuilder, SoapBodyContent, SoapVersion } from './CSSoapEnvelopeBuilder';
import { CSSoapSecurityHandler, WsSecurityConfig } from './CSSoapSecurityHandler';
import { CSXmlParser } from './CSXmlParser';
import { CSReporter } from '../../reporter/CSReporter';
import { CSRequestOptions, CSResponse } from '../types/CSApiTypes';

/**
 * SOAP Client for making SOAP web service requests
 * Integrates with existing PTF API infrastructure
 */

export interface SoapRequestOptions {
    url: string;
    operation: string;
    parameters?: Record<string, any>;
    soapAction?: string;
    version?: SoapVersion;
    namespace?: string;
    headers?: Record<string, string>;
    timeout?: number;
    security?: WsSecurityConfig;
    validateResponse?: boolean;
    proxy?: any;
}

export interface SoapResponse<T = any> {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: T;
    rawXml: string;
    soapFault?: SoapFault;
    duration: number;
    timestamp: Date;
    request: any;
    retries: number;
    redirects: string[];
}

export interface SoapFault {
    faultCode: string;
    faultString: string;
    faultActor?: string;
    detail?: any;
}

export class CSSoapClient {
    private httpClient: CSHttpClient;
    private contextManager: CSApiContextManager;
    private envelopeBuilder: CSSoapEnvelopeBuilder;
    private securityHandler: CSSoapSecurityHandler;
    private xmlParser: CSXmlParser;
    private defaultVersion: SoapVersion;
    private defaultTimeout: number;

    constructor() {
        this.httpClient = CSHttpClient.getInstance();
        this.contextManager = CSApiContextManager.getInstance();
        this.envelopeBuilder = new CSSoapEnvelopeBuilder();
        this.securityHandler = new CSSoapSecurityHandler();
        this.xmlParser = new CSXmlParser();
        this.defaultVersion = '1.1';
        this.defaultTimeout = 30000;
    }

    /**
     * Send SOAP request
     */
    public async sendRequest<T = any>(options: SoapRequestOptions): Promise<SoapResponse<T>> {
        const startTime = Date.now();

        try {
            // Build SOAP envelope
            const envelope = await this.buildSoapEnvelope(options);

            // Prepare HTTP request options
            const requestOptions = this.prepareHttpRequest(options, envelope);

            CSReporter.info(`Sending SOAP ${options.version || this.defaultVersion} request to: ${options.url}`);
            CSReporter.debug(`SOAP Operation: ${options.operation}`);
            CSReporter.debug(`SOAP Envelope:\n${envelope}`);

            // Send HTTP request
            const response = await this.httpClient.request<string>(requestOptions);

            // Parse SOAP response
            const soapResponse = await this.parseSoapResponse<T>(response, startTime);

            // Save to context
            const context = this.contextManager.getCurrentContext();
            context.saveResponse('soap_last', soapResponse);
            context.setVariable('soap_last_request', envelope);
            context.setVariable('soap_last_response', soapResponse.rawXml);

            // Check for SOAP fault
            if (soapResponse.soapFault) {
                CSReporter.warn(`SOAP Fault: ${soapResponse.soapFault.faultString}`);
            } else {
                CSReporter.pass(`SOAP request successful: ${response.status}`);
            }

            return soapResponse;
        } catch (error) {
            const duration = Date.now() - startTime;
            CSReporter.error(`SOAP request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Build SOAP envelope with security
     */
    private async buildSoapEnvelope(options: SoapRequestOptions): Promise<string> {
        // Configure envelope builder
        const version = options.version || this.defaultVersion;
        this.envelopeBuilder.setVersion(version);
        this.envelopeBuilder.clearHeaders();

        // Set SOAP action
        if (options.soapAction) {
            this.envelopeBuilder.setSoapAction(options.soapAction);
        }

        // Add security header if configured
        if (options.security) {
            const securityHeader = this.securityHandler.createSecurityHeader(options.security);
            this.envelopeBuilder.addHeader(securityHeader);

            // Add security namespaces
            const securityNamespaces = this.securityHandler.getNamespaceDefinitions();
            this.envelopeBuilder.addNamespaces(securityNamespaces);
        }

        // Build body content
        const bodyContent: SoapBodyContent = {
            operation: options.operation,
            parameters: options.parameters,
            namespace: options.namespace
        };

        // Build envelope
        return this.envelopeBuilder.buildEnvelope(bodyContent);
    }

    /**
     * Prepare HTTP request options
     */
    private prepareHttpRequest(options: SoapRequestOptions, envelope: string): CSRequestOptions {
        const httpHeaders = this.envelopeBuilder.getHttpHeaders();

        // Merge with custom headers
        const headers = {
            ...httpHeaders,
            ...options.headers
        };

        return {
            url: options.url,
            method: 'POST',
            body: envelope,
            headers,
            timeout: options.timeout || this.defaultTimeout,
            proxy: options.proxy,
            responseType: 'text'
        };
    }

    /**
     * Parse SOAP response
     */
    private async parseSoapResponse<T>(
        httpResponse: CSResponse<string>,
        startTime: number
    ): Promise<SoapResponse<T>> {
        const rawXml = typeof httpResponse.body === 'string'
            ? httpResponse.body
            : JSON.stringify(httpResponse.body);

        // Parse XML
        const parsed = await this.xmlParser.parseXml(rawXml);

        // Extract SOAP body
        let body: any;
        try {
            body = await this.xmlParser.extractSoapBody(rawXml);
        } catch (error) {
            CSReporter.warn('Could not extract SOAP body, using full response');
            body = parsed;
        }

        // Check for SOAP fault
        let soapFault: SoapFault | undefined;
        try {
            const faultData = await this.xmlParser.extractSoapFault(rawXml);
            if (faultData) {
                soapFault = this.parseSoapFault(faultData);
            }
        } catch (error) {
            // No fault present
        }

        return {
            status: httpResponse.status,
            statusText: httpResponse.statusText,
            headers: this.normalizeHeaders(httpResponse.headers),
            body: body as T,
            rawXml,
            soapFault,
            duration: Date.now() - startTime,
            timestamp: new Date(),
            request: httpResponse.request,
            retries: httpResponse.retries,
            redirects: httpResponse.redirects
        };
    }

    /**
     * Normalize HTTP headers to Record<string, string>
     */
    private normalizeHeaders(headers: any): Record<string, string> {
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (Array.isArray(value)) {
                normalized[key] = value.join(', ');
            } else if (value !== undefined) {
                normalized[key] = String(value);
            }
        }
        return normalized;
    }

    /**
     * Parse SOAP fault
     */
    private parseSoapFault(faultData: any): SoapFault {
        // SOAP 1.1 format
        if (faultData.faultcode || faultData.faultstring) {
            return {
                faultCode: faultData.faultcode || '',
                faultString: faultData.faultstring || '',
                faultActor: faultData.faultactor,
                detail: faultData.detail
            };
        }

        // SOAP 1.2 format
        if (faultData.Code || faultData.Reason) {
            return {
                faultCode: faultData.Code?.Value || '',
                faultString: faultData.Reason?.Text || '',
                faultActor: faultData.Role,
                detail: faultData.Detail
            };
        }

        return {
            faultCode: 'Unknown',
            faultString: 'Unknown fault format',
            detail: faultData
        };
    }

    /**
     * Send simple SOAP request (shorthand)
     */
    public async call<T = any>(
        url: string,
        operation: string,
        parameters?: Record<string, any>,
        options?: Partial<SoapRequestOptions>
    ): Promise<SoapResponse<T>> {
        return this.sendRequest<T>({
            url,
            operation,
            parameters,
            ...options
        });
    }

    /**
     * Set default SOAP version
     */
    public setDefaultVersion(version: SoapVersion): void {
        this.defaultVersion = version;
    }

    /**
     * Set default timeout
     */
    public setDefaultTimeout(timeout: number): void {
        this.defaultTimeout = timeout;
    }

    /**
     * Get last SOAP request envelope
     */
    public getLastRequest(): string | undefined {
        return this.contextManager.getCurrentContext().getVariable('soap_last_request');
    }

    /**
     * Get last SOAP response XML
     */
    public getLastResponse(): string | undefined {
        return this.contextManager.getCurrentContext().getVariable('soap_last_response');
    }

    /**
     * Get last SOAP response object
     */
    public getLastResponseObject<T = any>(): SoapResponse<T> | undefined {
        const response = this.contextManager.getCurrentContext().getResponse('soap_last');
        return response ? response as unknown as SoapResponse<T> : undefined;
    }

    /**
     * Query last SOAP response using XPath
     */
    public async queryLastResponse(xpath: string): Promise<any> {
        const lastResponse = this.getLastResponse();
        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const result = await this.xmlParser.queryXPath(lastResponse, xpath);
        return result.value;
    }

    /**
     * Extract value from last SOAP response
     */
    public async extractFromLastResponse(elementName: string): Promise<any> {
        const lastResponse = this.getLastResponse();
        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        return await this.xmlParser.getElementByTagName(lastResponse, elementName);
    }

    /**
     * Validate last SOAP response against expected XML
     */
    public async validateLastResponse(expectedXml: string, ignoreOrder: boolean = false): Promise<{
        valid: boolean;
        differences: string[];
    }> {
        const lastResponse = this.getLastResponse();
        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const comparison = await this.xmlParser.compareXml(lastResponse, expectedXml, ignoreOrder);
        return {
            valid: comparison.equal,
            differences: comparison.differences
        };
    }

    /**
     * Check if last response has SOAP fault
     */
    public async hasLastResponseFault(): Promise<boolean> {
        const lastResponse = this.getLastResponse();
        if (!lastResponse) {
            return false;
        }

        return await this.xmlParser.isSoapFault(lastResponse);
    }

    /**
     * Get SOAP fault from last response
     */
    public getLastSoapFault(): SoapFault | undefined {
        const lastResponseObj = this.getLastResponseObject();
        return lastResponseObj?.soapFault;
    }

    /**
     * Send SOAP request with Basic Authentication
     */
    public async sendWithBasicAuth<T = any>(
        url: string,
        operation: string,
        username: string,
        password: string,
        parameters?: Record<string, any>,
        options?: Partial<SoapRequestOptions>
    ): Promise<SoapResponse<T>> {
        // Add HTTP Basic Auth header
        const headers = {
            ...options?.headers,
            'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        };

        return this.sendRequest<T>({
            url,
            operation,
            parameters,
            ...options,
            headers
        });
    }

    /**
     * Send SOAP request with WS-Security UsernameToken
     */
    public async sendWithWsSecurityAuth<T = any>(
        url: string,
        operation: string,
        username: string,
        password: string,
        passwordType: 'PasswordText' | 'PasswordDigest' = 'PasswordText',
        parameters?: Record<string, any>,
        options?: Partial<SoapRequestOptions>
    ): Promise<SoapResponse<T>> {
        const security: WsSecurityConfig = {
            type: 'UsernameToken',
            username,
            password,
            passwordType,
            nonce: true,
            timestamp: true
        };

        return this.sendRequest<T>({
            url,
            operation,
            parameters,
            ...options,
            security
        });
    }

    /**
     * Send SOAP request with Certificate Authentication
     */
    public async sendWithCertificate<T = any>(
        url: string,
        operation: string,
        certificate: string,
        privateKey: string,
        parameters?: Record<string, any>,
        options?: Partial<SoapRequestOptions>
    ): Promise<SoapResponse<T>> {
        const security: WsSecurityConfig = {
            type: 'BinarySecurityToken',
            certificate,
            privateKey,
            timestamp: true
        };

        return this.sendRequest<T>({
            url,
            operation,
            parameters,
            ...options,
            security
        });
    }

    /**
     * Parse WSDL (basic extraction - full WSDL parsing would require external library)
     */
    public async parseWsdlOperations(wsdlUrl: string): Promise<string[]> {
        try {
            const response = await this.httpClient.request<string>({
                url: wsdlUrl,
                method: 'GET',
                responseType: 'text'
            });

            const wsdlXml = typeof response.body === 'string'
                ? response.body
                : JSON.stringify(response.body);

            // Extract operation names from WSDL
            const operationMatches = wsdlXml.match(/<wsdl:operation name="([^"]+)"/g);
            if (!operationMatches) {
                return [];
            }

            const operations = operationMatches.map(match => {
                const nameMatch = match.match(/name="([^"]+)"/);
                return nameMatch ? nameMatch[1] : '';
            }).filter(op => op !== '');

            CSReporter.info(`Found ${operations.length} operations in WSDL`);
            return operations;
        } catch (error) {
            CSReporter.error(`Failed to parse WSDL: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Get WSDL definition
     */
    public async getWsdl(wsdlUrl: string): Promise<string> {
        const response = await this.httpClient.request<string>({
            url: wsdlUrl,
            method: 'GET',
            responseType: 'text'
        });

        return typeof response.body === 'string'
            ? response.body
            : JSON.stringify(response.body);
    }

    /**
     * Save SOAP response to variable
     */
    public saveResponseToVariable(variableName: string, xpath?: string): void {
        const context = this.contextManager.getCurrentContext();
        const lastResponse = this.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available to save');
        }

        if (xpath) {
            this.xmlParser.queryXPath(lastResponse, xpath).then(result => {
                context.setVariable(variableName, result.value);
                CSReporter.debug(`Saved SOAP response value to variable: ${variableName}`);
            });
        } else {
            context.setVariable(variableName, lastResponse);
            CSReporter.debug(`Saved SOAP response XML to variable: ${variableName}`);
        }
    }

    /**
     * Create new SOAP envelope builder
     */
    public createEnvelopeBuilder(version?: SoapVersion): CSSoapEnvelopeBuilder {
        return new CSSoapEnvelopeBuilder({ version });
    }

    /**
     * Create new security handler
     */
    public createSecurityHandler(): CSSoapSecurityHandler {
        return new CSSoapSecurityHandler();
    }

    /**
     * Create new XML parser
     */
    public createXmlParser(): CSXmlParser {
        return new CSXmlParser();
    }

    /**
     * Get statistics
     */
    public getStats(): any {
        const context = this.contextManager.getCurrentContext();
        return {
            lastRequestTime: context.getVariable('soap_last_request_time'),
            lastResponseTime: context.getVariable('soap_last_response_time'),
            totalRequests: context.getVariable('soap_total_requests') || 0
        };
    }
}

// Export singleton instance
export const soapClient = new CSSoapClient();
