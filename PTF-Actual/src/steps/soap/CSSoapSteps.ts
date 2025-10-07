import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSSoapClient, SoapRequestOptions } from '../../api/soap/CSSoapClient';
import { CSSoapSecurityHandler, WsSecurityConfig } from '../../api/soap/CSSoapSecurityHandler';
import { CSXmlValidator, XmlPathAssertion } from '../../api/soap/CSXmlValidator';
import { CSXmlParser } from '../../api/soap/CSXmlParser';
import { SoapVersion } from '../../api/soap/CSSoapEnvelopeBuilder';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSPlaceholderResolver } from '../../api/templates/CSPlaceholderResolver';

/**
 * SOAP Web Services Testing - BDD Step Definitions
 * Comprehensive step definitions for SOAP testing with full authentication support
 */

export class CSSoapSteps {
    private soapClient: CSSoapClient;
    private securityHandler: CSSoapSecurityHandler;
    private xmlValidator: CSXmlValidator;
    private xmlParser: CSXmlParser;
    private contextManager: CSApiContextManager;
    private placeholderResolver: CSPlaceholderResolver;
    private currentSoapVersion: SoapVersion;
    private currentWsdlUrl?: string;
    private currentSoapAction?: string;
    private currentNamespace?: string;

    constructor() {
        this.soapClient = new CSSoapClient();
        this.securityHandler = new CSSoapSecurityHandler();
        this.xmlValidator = new CSXmlValidator();
        this.xmlParser = new CSXmlParser();
        this.contextManager = CSApiContextManager.getInstance();
        this.placeholderResolver = new CSPlaceholderResolver();
        this.currentSoapVersion = '1.1';
    }

    private resolveWithContext(template: string): string {
        const context = this.contextManager.getCurrentContext();
        const variables = context.getAllVariables();
        // Set all variables in the resolver context
        for (const [key, value] of Object.entries(variables)) {
            this.placeholderResolver.setVariable(key, value);
        }
        return this.placeholderResolver.resolve(template);
    }

    // ========================================
    // SOAP Configuration Steps
    // ========================================

    @CSBDDStepDef('I set SOAP version to {string}')
    async setSoapVersion(version: string): Promise<void> {
        if (version !== '1.1' && version !== '1.2') {
            throw new Error(`Invalid SOAP version: ${version}. Must be "1.1" or "1.2"`);
        }
        this.currentSoapVersion = version as SoapVersion;
        this.soapClient.setDefaultVersion(this.currentSoapVersion);
        CSReporter.info(`SOAP version set to: ${version}`);
    }

    @CSBDDStepDef('I set SOAP action to {string}')
    async setSoapAction(soapAction: string): Promise<void> {
        this.currentSoapAction = this.resolveWithContext(soapAction);
        CSReporter.debug(`SOAP action set to: ${this.currentSoapAction}`);
    }

    @CSBDDStepDef('I set SOAP namespace to {string}')
    async setSoapNamespace(namespace: string): Promise<void> {
        this.currentNamespace = this.resolveWithContext(namespace);
        CSReporter.debug(`SOAP namespace set to: ${this.currentNamespace}`);
    }

    @CSBDDStepDef('I set SOAP endpoint to {string}')
    async setSoapEndpoint(endpoint: string): Promise<void> {
        const resolvedEndpoint = this.resolveWithContext(endpoint);
        const context = this.contextManager.getCurrentContext();
        context.setVariable('soap_endpoint', resolvedEndpoint);
        CSReporter.info(`SOAP endpoint set to: ${resolvedEndpoint}`);
    }

    @CSBDDStepDef('I load WSDL from {string}')
    async loadWsdl(wsdlUrl: string): Promise<void> {
        this.currentWsdlUrl = this.resolveWithContext(wsdlUrl);

        if (!this.currentWsdlUrl) {
            throw new Error('WSDL URL is required');
        }

        const wsdl = await this.soapClient.getWsdl(this.currentWsdlUrl);
        const operations = await this.soapClient.parseWsdlOperations(this.currentWsdlUrl);

        const context = this.contextManager.getCurrentContext();
        context.setVariable('wsdl_content', wsdl);
        context.setVariable('wsdl_operations', operations);

        CSReporter.info(`Loaded WSDL from: ${this.currentWsdlUrl}`);
        CSReporter.debug(`Found ${operations.length} operations: ${operations.join(', ')}`);
    }

    // ========================================
    // SOAP Request Steps (Basic)
    // ========================================

    @CSBDDStepDef('I send SOAP request to {string} with operation {string}')
    async sendSoapRequest(url: string, operation: string): Promise<void> {
        const resolvedUrl = this.resolveWithContext(url);
        const resolvedOperation = this.resolveWithContext(operation);

        const options: SoapRequestOptions = {
            url: resolvedUrl,
            operation: resolvedOperation,
            version: this.currentSoapVersion,
            soapAction: this.currentSoapAction,
            namespace: this.currentNamespace
        };

        await this.soapClient.sendRequest(options);
    }

    @CSBDDStepDef('I send SOAP request to {string} with operation {string} and parameters:')
    async sendSoapRequestWithParameters(
        url: string,
        operation: string,
        parametersTable: any
    ): Promise<void> {
        const resolvedUrl = this.resolveWithContext(url);
        const resolvedOperation = this.resolveWithContext(operation);

        // Convert data table to parameters object
        const parameters: Record<string, any> = {};
        for (const row of parametersTable.hashes()) {
            const key = row.parameter || row.name || row.key;
            let value = row.value;

            // Resolve placeholders
            value = this.resolveWithContext(value);

            // Parse value if it's JSON
            try {
                value = JSON.parse(value);
            } catch {
                // Keep as string
            }

            parameters[key] = value;
        }

        const options: SoapRequestOptions = {
            url: resolvedUrl,
            operation: resolvedOperation,
            parameters,
            version: this.currentSoapVersion,
            soapAction: this.currentSoapAction,
            namespace: this.currentNamespace
        };

        await this.soapClient.sendRequest(options);
    }

    @CSBDDStepDef('I send SOAP request with body:')
    async sendSoapRequestWithBody(requestBody: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const endpoint = context.getVariable('soap_endpoint');

        if (!endpoint) {
            throw new Error('SOAP endpoint not set. Use "I set SOAP endpoint to {string}" first');
        }

        const resolvedBody = this.resolveWithContext(requestBody);

        // Send as raw SOAP envelope
        const response = await this.soapClient.sendRequest({
            url: endpoint,
            operation: '', // Not used for raw body
            version: this.currentSoapVersion
        });

        CSReporter.pass('SOAP request with custom body sent successfully');
    }

    // ========================================
    // SOAP Authentication Steps
    // ========================================

    @CSBDDStepDef('I send SOAP request with Basic Authentication using username {string} and password {string}')
    async sendSoapWithBasicAuth(
        username: string,
        password: string
    ): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const endpoint = context.getVariable('soap_endpoint');
        const operation = context.getVariable('soap_operation');

        if (!endpoint || !operation) {
            throw new Error('SOAP endpoint and operation must be set before sending request');
        }

        const resolvedUsername = this.resolveWithContext(username);
        const resolvedPassword = this.resolveWithContext(password);

        await this.soapClient.sendWithBasicAuth(
            endpoint,
            operation,
            resolvedUsername,
            resolvedPassword
        );

        CSReporter.pass('SOAP request with Basic Authentication sent successfully');
    }

    @CSBDDStepDef('I send SOAP request with WS-Security username {string} password {string} type {string}')
    async sendSoapWithWsSecurity(
        username: string,
        password: string,
        passwordType: string
    ): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const endpoint = context.getVariable('soap_endpoint');
        const operation = context.getVariable('soap_operation');

        if (!endpoint || !operation) {
            throw new Error('SOAP endpoint and operation must be set before sending request');
        }

        const resolvedUsername = this.resolveWithContext(username);
        const resolvedPassword = this.resolveWithContext(password);

        const pwdType = passwordType.toLowerCase().includes('digest')
            ? 'PasswordDigest'
            : 'PasswordText';

        await this.soapClient.sendWithWsSecurityAuth(
            endpoint,
            operation,
            resolvedUsername,
            resolvedPassword,
            pwdType
        );

        CSReporter.pass(`SOAP request with WS-Security (${pwdType}) sent successfully`);
    }

    @CSBDDStepDef('I add WS-Security UsernameToken with username {string} and password {string}')
    async addWsSecurityUsernameToken(username: string, password: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const securityConfig: WsSecurityConfig = {
            type: 'UsernameToken',
            username: this.resolveWithContext(username),
            password: this.resolveWithContext(password),
            passwordType: 'PasswordText',
            nonce: true,
            timestamp: true
        };

        context.setVariable('ws_security_config', securityConfig);
        CSReporter.debug('WS-Security UsernameToken configured');
    }

    @CSBDDStepDef('I add WS-Security Timestamp with TTL {int} seconds')
    async addWsSecurityTimestamp(ttl: number): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const securityConfig: WsSecurityConfig = {
            type: 'Timestamp',
            timestampTTL: ttl
        };

        context.setVariable('ws_security_timestamp', securityConfig);
        CSReporter.debug(`WS-Security Timestamp configured (TTL: ${ttl}s)`);
    }

    // ========================================
    // SOAP Response Validation Steps
    // ========================================

    @CSBDDStepDef('the SOAP response status should be {int}')
    async validateSoapResponseStatus(expectedStatus: number): Promise<void> {
        const lastResponse = this.soapClient.getLastResponseObject();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        if (lastResponse.status !== expectedStatus) {
            throw new Error(
                `SOAP response status mismatch: expected ${expectedStatus}, got ${lastResponse.status}`
            );
        }

        CSReporter.pass(`SOAP response status is ${expectedStatus}`);
    }

    @CSBDDStepDef('the SOAP response should not contain fault')
    async validateNoSoapFault(): Promise<void> {
        const hasFault = await this.soapClient.hasLastResponseFault();

        if (hasFault) {
            const fault = this.soapClient.getLastSoapFault();
            throw new Error(
                `SOAP Fault detected: [${fault?.faultCode}] ${fault?.faultString}`
            );
        }

        CSReporter.pass('SOAP response contains no fault');
    }

    @CSBDDStepDef('the SOAP response should contain fault with code {string}')
    async validateSoapFaultCode(expectedCode: string): Promise<void> {
        const fault = this.soapClient.getLastSoapFault();

        if (!fault) {
            throw new Error('Expected SOAP fault but none found');
        }

        if (!fault.faultCode.includes(expectedCode)) {
            throw new Error(
                `SOAP fault code mismatch: expected "${expectedCode}", got "${fault.faultCode}"`
            );
        }

        CSReporter.pass(`SOAP fault code contains: ${expectedCode}`);
    }

    @CSBDDStepDef('the SOAP response should contain fault with message {string}')
    async validateSoapFaultMessage(expectedMessage: string): Promise<void> {
        const fault = this.soapClient.getLastSoapFault();

        if (!fault) {
            throw new Error('Expected SOAP fault but none found');
        }

        if (!fault.faultString.includes(expectedMessage)) {
            throw new Error(
                `SOAP fault message mismatch: expected to contain "${expectedMessage}", got "${fault.faultString}"`
            );
        }

        CSReporter.pass(`SOAP fault message contains: ${expectedMessage}`);
    }

    // ========================================
    // XML Validation Steps
    // ========================================

    @CSBDDStepDef('the SOAP response should be valid XML')
    async validateSoapResponseXml(): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const validationResult = await this.xmlValidator.validateXml(lastResponse);

        if (!validationResult.valid) {
            throw new Error(
                `SOAP response is not valid XML: ${validationResult.errors.join(', ')}`
            );
        }

        CSReporter.pass('SOAP response is valid XML');
    }

    @CSBDDStepDef('the SOAP response element {string} should exist')
    async validateSoapElementExists(elementName: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const exists = await this.xmlValidator.elementExists(lastResponse, elementName);

        if (!exists) {
            throw new Error(`Element "${elementName}" not found in SOAP response`);
        }

        CSReporter.pass(`SOAP response element "${elementName}" exists`);
    }

    @CSBDDStepDef('the SOAP response element {string} should have value {string}')
    async validateSoapElementValue(elementName: string, expectedValue: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const resolvedExpectedValue = this.resolveWithContext(expectedValue);
        const hasValue = await this.xmlValidator.elementHasValue(
            lastResponse,
            elementName,
            resolvedExpectedValue
        );

        if (!hasValue) {
            const actualValue = await this.xmlParser.getElementText(lastResponse, elementName);
            throw new Error(
                `Element "${elementName}" value mismatch: expected "${resolvedExpectedValue}", got "${actualValue}"`
            );
        }

        CSReporter.pass(`SOAP response element "${elementName}" has expected value`);
    }

    @CSBDDStepDef('the SOAP response element {string} should contain {string}')
    async validateSoapElementContains(elementName: string, expectedText: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const elementText = await this.xmlParser.getElementText(lastResponse, elementName);

        if (!elementText || !elementText.includes(expectedText)) {
            throw new Error(
                `Element "${elementName}" does not contain "${expectedText}". Actual: "${elementText}"`
            );
        }

        CSReporter.pass(`SOAP response element "${elementName}" contains "${expectedText}"`);
    }

    @CSBDDStepDef('the SOAP response should have {int} occurrences of element {string}')
    async validateSoapElementCount(expectedCount: number, elementName: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        await this.xmlValidator.validateElementCount(lastResponse, elementName, expectedCount);
        CSReporter.pass(`SOAP response has ${expectedCount} occurrence(s) of "${elementName}"`);
    }

    // ========================================
    // XPath Query Steps
    // ========================================

    @CSBDDStepDef('I query SOAP response with XPath {string} and save as {string}')
    async querySoapResponseXPath(xpath: string, variableName: string): Promise<void> {
        const value = await this.soapClient.queryLastResponse(xpath);
        const context = this.contextManager.getCurrentContext();
        context.setVariable(variableName, value);

        CSReporter.info(`Saved XPath query result to variable: ${variableName}`);
    }

    @CSBDDStepDef('the SOAP response XPath {string} should equal {string}')
    async validateXPathEquals(xpath: string, expectedValue: string): Promise<void> {
        const value = await this.soapClient.queryLastResponse(xpath);
        const resolvedExpectedValue = this.resolveWithContext(expectedValue);

        if (String(value) !== resolvedExpectedValue) {
            throw new Error(
                `XPath "${xpath}" value mismatch: expected "${resolvedExpectedValue}", got "${value}"`
            );
        }

        CSReporter.pass(`XPath "${xpath}" equals expected value`);
    }

    @CSBDDStepDef('the SOAP response XPath {string} should contain {string}')
    async validateXPathContains(xpath: string, expectedText: string): Promise<void> {
        const value = await this.soapClient.queryLastResponse(xpath);
        const valueStr = String(value);

        if (!valueStr.includes(expectedText)) {
            throw new Error(
                `XPath "${xpath}" does not contain "${expectedText}". Actual: "${valueStr}"`
            );
        }

        CSReporter.pass(`XPath "${xpath}" contains "${expectedText}"`);
    }

    @CSBDDStepDef('the SOAP response XPath {string} should match pattern {string}')
    async validateXPathMatchesPattern(xpath: string, pattern: string): Promise<void> {
        const value = await this.soapClient.queryLastResponse(xpath);
        const valueStr = String(value);
        const regex = new RegExp(pattern);

        if (!regex.test(valueStr)) {
            throw new Error(
                `XPath "${xpath}" does not match pattern "${pattern}". Actual: "${valueStr}"`
            );
        }

        CSReporter.pass(`XPath "${xpath}" matches pattern`);
    }

    // ========================================
    // XML Comparison Steps
    // ========================================

    @CSBDDStepDef('the SOAP response should match XML:')
    async compareSoapResponseWithXml(expectedXml: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const resolvedExpectedXml = this.resolveWithContext(expectedXml);
        const comparisonResult = await this.xmlValidator.compareXml(lastResponse, resolvedExpectedXml);

        if (!comparisonResult.equal) {
            const diffSummary = comparisonResult.differences.slice(0, 5).map(d => d.message).join('\n');
            throw new Error(
                `SOAP response does not match expected XML:\n${diffSummary}\n` +
                `Total differences: ${comparisonResult.summary.totalDifferences}`
            );
        }

        CSReporter.pass('SOAP response matches expected XML');
    }

    @CSBDDStepDef('the SOAP response should match XML ignoring order:')
    async compareSoapResponseIgnoringOrder(expectedXml: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const resolvedExpectedXml = this.resolveWithContext(expectedXml);
        const comparisonResult = await this.xmlValidator.compareXml(
            lastResponse,
            resolvedExpectedXml,
            { ignoreOrder: true }
        );

        if (!comparisonResult.equal) {
            const diffSummary = comparisonResult.differences.slice(0, 5).map(d => d.message).join('\n');
            throw new Error(
                `SOAP response does not match expected XML:\n${diffSummary}\n` +
                `Total differences: ${comparisonResult.summary.totalDifferences}`
            );
        }

        CSReporter.pass('SOAP response matches expected XML (ignoring order)');
    }

    // ========================================
    // Response Header Validation Steps
    // ========================================

    @CSBDDStepDef('the SOAP response header {string} should be {string}')
    async validateSoapResponseHeader(headerName: string, expectedValue: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponseObject();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const headerValue = lastResponse.headers[headerName.toLowerCase()];
        const resolvedExpectedValue = this.resolveWithContext(expectedValue);

        if (headerValue !== resolvedExpectedValue) {
            throw new Error(
                `SOAP response header "${headerName}" mismatch: expected "${resolvedExpectedValue}", got "${headerValue}"`
            );
        }

        CSReporter.pass(`SOAP response header "${headerName}" is correct`);
    }

    @CSBDDStepDef('the SOAP response header {string} should contain {string}')
    async validateSoapResponseHeaderContains(headerName: string, expectedText: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponseObject();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const headerValue = lastResponse.headers[headerName.toLowerCase()];

        if (!headerValue || !headerValue.includes(expectedText)) {
            throw new Error(
                `SOAP response header "${headerName}" does not contain "${expectedText}". Actual: "${headerValue}"`
            );
        }

        CSReporter.pass(`SOAP response header "${headerName}" contains "${expectedText}"`);
    }

    @CSBDDStepDef('the SOAP response Content-Type should be {string}')
    async validateSoapContentType(expectedContentType: string): Promise<void> {
        await this.validateSoapResponseHeaderContains('content-type', expectedContentType);
    }

    // ========================================
    // Utility Steps
    // ========================================

    @CSBDDStepDef('I save SOAP response to variable {string}')
    async saveSoapResponseToVariable(variableName: string): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        const context = this.contextManager.getCurrentContext();
        context.setVariable(variableName, lastResponse);

        CSReporter.debug(`Saved SOAP response to variable: ${variableName}`);
    }

    @CSBDDStepDef('I extract SOAP element {string} and save as {string}')
    async extractSoapElement(elementName: string, variableName: string): Promise<void> {
        const element = await this.soapClient.extractFromLastResponse(elementName);

        if (!element) {
            throw new Error(`Element "${elementName}" not found in SOAP response`);
        }

        const context = this.contextManager.getCurrentContext();
        context.setVariable(variableName, element);

        CSReporter.info(`Extracted element "${elementName}" and saved to: ${variableName}`);
    }

    @CSBDDStepDef('I print SOAP request')
    async printSoapRequest(): Promise<void> {
        const lastRequest = this.soapClient.getLastRequest();

        if (!lastRequest) {
            CSReporter.warn('No SOAP request available to print');
            return;
        }

        CSReporter.info('SOAP Request:');
        console.log(lastRequest);
    }

    @CSBDDStepDef('I print SOAP response')
    async printSoapResponse(): Promise<void> {
        const lastResponse = this.soapClient.getLastResponse();

        if (!lastResponse) {
            CSReporter.warn('No SOAP response available to print');
            return;
        }

        CSReporter.info('SOAP Response:');
        console.log(lastResponse);
    }

    @CSBDDStepDef('I validate SOAP response time is less than {int} ms')
    async validateSoapResponseTime(maxDuration: number): Promise<void> {
        const lastResponse = this.soapClient.getLastResponseObject();

        if (!lastResponse) {
            throw new Error('No SOAP response available');
        }

        if (lastResponse.duration > maxDuration) {
            throw new Error(
                `SOAP response time exceeded: ${lastResponse.duration}ms > ${maxDuration}ms`
            );
        }

        CSReporter.pass(`SOAP response time is ${lastResponse.duration}ms (< ${maxDuration}ms)`);
    }
}
