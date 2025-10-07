import { CSXmlParser } from './CSXmlParser';
import { CSReporter } from '../../reporter/CSReporter';

/**
 * SOAP Envelope Builder
 * Supports SOAP 1.1 and SOAP 1.2 specifications
 * Handles SOAP headers, body, and various namespaces
 */

export type SoapVersion = '1.1' | '1.2';

export interface SoapNamespace {
    prefix: string;
    uri: string;
}

export interface SoapHeader {
    name: string;
    value: any;
    attributes?: Record<string, string>;
    mustUnderstand?: boolean;
    actor?: string; // SOAP 1.1
    role?: string;  // SOAP 1.2
}

export interface SoapBodyContent {
    operation: string;
    parameters?: Record<string, any>;
    namespace?: string;
    attributes?: Record<string, string>;
}

export interface SoapEnvelopeOptions {
    version?: SoapVersion;
    headers?: SoapHeader[];
    namespaces?: SoapNamespace[];
    encodingStyle?: string;
    soapAction?: string;
}

export class CSSoapEnvelopeBuilder {
    private version: SoapVersion;
    private headers: SoapHeader[];
    private namespaces: SoapNamespace[];
    private encodingStyle?: string;
    private soapAction?: string;
    private xmlParser: CSXmlParser;

    // SOAP 1.1 Constants
    private readonly SOAP11_NAMESPACE = 'http://schemas.xmlsoap.org/soap/envelope/';
    private readonly SOAP11_ENCODING = 'http://schemas.xmlsoap.org/soap/encoding/';

    // SOAP 1.2 Constants
    private readonly SOAP12_NAMESPACE = 'http://www.w3.org/2003/05/soap-envelope';
    private readonly SOAP12_ENCODING = 'http://www.w3.org/2003/05/soap-encoding';

    // Common Namespaces
    private readonly XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';
    private readonly XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema';

    constructor(options?: SoapEnvelopeOptions) {
        this.version = options?.version || '1.1';
        this.headers = options?.headers || [];
        this.namespaces = options?.namespaces || [];
        this.encodingStyle = options?.encodingStyle;
        this.soapAction = options?.soapAction;

        this.xmlParser = new CSXmlParser({
            explicitArray: false,
            ignoreAttrs: false,
            mergeAttrs: false
        });
    }

    /**
     * Build a complete SOAP envelope
     */
    public buildEnvelope(bodyContent: SoapBodyContent): string {
        const envelope = this.version === '1.1'
            ? this.buildSoap11Envelope(bodyContent)
            : this.buildSoap12Envelope(bodyContent);

        CSReporter.debug(`Built SOAP ${this.version} envelope for operation: ${bodyContent.operation}`);
        return envelope;
    }

    /**
     * Build SOAP 1.1 Envelope
     */
    private buildSoap11Envelope(bodyContent: SoapBodyContent): string {
        const envelopePrefix = 'soap';
        const namespaces = this.buildNamespaceAttributes(envelopePrefix);

        let envelope = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        envelope += `<${envelopePrefix}:Envelope${namespaces}`;

        if (this.encodingStyle) {
            envelope += ` ${envelopePrefix}:encodingStyle="${this.encodingStyle}"`;
        }

        envelope += `>\n`;

        // Add SOAP Header if present
        if (this.headers.length > 0) {
            envelope += `  <${envelopePrefix}:Header>\n`;
            envelope += this.buildHeaders(envelopePrefix);
            envelope += `  </${envelopePrefix}:Header>\n`;
        }

        // Add SOAP Body
        envelope += `  <${envelopePrefix}:Body>\n`;
        envelope += this.buildBody(bodyContent);
        envelope += `  </${envelopePrefix}:Body>\n`;

        envelope += `</${envelopePrefix}:Envelope>`;

        return envelope;
    }

    /**
     * Build SOAP 1.2 Envelope
     */
    private buildSoap12Envelope(bodyContent: SoapBodyContent): string {
        const envelopePrefix = 'env';
        const namespaces = this.buildNamespaceAttributes(envelopePrefix);

        let envelope = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        envelope += `<${envelopePrefix}:Envelope${namespaces}`;

        if (this.encodingStyle) {
            envelope += ` ${envelopePrefix}:encodingStyle="${this.encodingStyle}"`;
        }

        envelope += `>\n`;

        // Add SOAP Header if present
        if (this.headers.length > 0) {
            envelope += `  <${envelopePrefix}:Header>\n`;
            envelope += this.buildHeaders(envelopePrefix);
            envelope += `  </${envelopePrefix}:Header>\n`;
        }

        // Add SOAP Body
        envelope += `  <${envelopePrefix}:Body>\n`;
        envelope += this.buildBody(bodyContent);
        envelope += `  </${envelopePrefix}:Body>\n`;

        envelope += `</${envelopePrefix}:Envelope>`;

        return envelope;
    }

    /**
     * Build namespace attributes for envelope
     */
    private buildNamespaceAttributes(soapPrefix: string): string {
        let attrs = '';

        // Add SOAP namespace
        const soapNs = this.version === '1.1' ? this.SOAP11_NAMESPACE : this.SOAP12_NAMESPACE;
        attrs += ` xmlns:${soapPrefix}="${soapNs}"`;

        // Add XSI and XSD namespaces
        attrs += ` xmlns:xsi="${this.XSI_NAMESPACE}"`;
        attrs += ` xmlns:xsd="${this.XSD_NAMESPACE}"`;

        // Add custom namespaces
        for (const ns of this.namespaces) {
            attrs += ` xmlns:${ns.prefix}="${ns.uri}"`;
        }

        return attrs;
    }

    /**
     * Build SOAP headers
     */
    private buildHeaders(soapPrefix: string): string {
        let headersXml = '';

        for (const header of this.headers) {
            headersXml += `    <${header.name}`;

            // Add attributes
            if (header.attributes) {
                for (const [key, value] of Object.entries(header.attributes)) {
                    headersXml += ` ${key}="${value}"`;
                }
            }

            // Add mustUnderstand
            if (header.mustUnderstand) {
                const mustUnderstandValue = this.version === '1.1' ? '1' : 'true';
                headersXml += ` ${soapPrefix}:mustUnderstand="${mustUnderstandValue}"`;
            }

            // Add actor (SOAP 1.1) or role (SOAP 1.2)
            if (this.version === '1.1' && header.actor) {
                headersXml += ` ${soapPrefix}:actor="${header.actor}"`;
            } else if (this.version === '1.2' && header.role) {
                headersXml += ` ${soapPrefix}:role="${header.role}"`;
            }

            headersXml += '>';

            // Add header value
            if (typeof header.value === 'string') {
                headersXml += header.value;
            } else {
                headersXml += this.objectToXml(header.value, 0);
            }

            headersXml += `</${header.name}>\n`;
        }

        return headersXml;
    }

    /**
     * Build SOAP body
     */
    private buildBody(bodyContent: SoapBodyContent): string {
        let bodyXml = '    ';

        // Start operation element
        if (bodyContent.namespace) {
            const nsPrefix = this.findNamespacePrefix(bodyContent.namespace) || 'ns';
            bodyXml += `<${nsPrefix}:${bodyContent.operation}`;

            // If namespace not already defined, add it
            if (!this.findNamespacePrefix(bodyContent.namespace)) {
                bodyXml += ` xmlns:${nsPrefix}="${bodyContent.namespace}"`;
            }
        } else {
            bodyXml += `<${bodyContent.operation}`;
        }

        // Add attributes
        if (bodyContent.attributes) {
            for (const [key, value] of Object.entries(bodyContent.attributes)) {
                bodyXml += ` ${key}="${value}"`;
            }
        }

        bodyXml += '>';

        // Add parameters
        if (bodyContent.parameters) {
            bodyXml += '\n';
            bodyXml += this.objectToXml(bodyContent.parameters, 6);
            bodyXml += '    ';
        }

        // Close operation element
        if (bodyContent.namespace) {
            const nsPrefix = this.findNamespacePrefix(bodyContent.namespace) || 'ns';
            bodyXml += `</${nsPrefix}:${bodyContent.operation}>`;
        } else {
            bodyXml += `</${bodyContent.operation}>`;
        }

        bodyXml += '\n';

        return bodyXml;
    }

    /**
     * Convert JavaScript object to XML string
     */
    private objectToXml(obj: any, indent: number = 0): string {
        const indentStr = ' '.repeat(indent);
        let xml = '';

        if (typeof obj === 'object' && obj !== null) {
            if (Array.isArray(obj)) {
                // Handle arrays
                for (const item of obj) {
                    xml += this.objectToXml(item, indent);
                }
            } else {
                // Handle objects
                for (const [key, value] of Object.entries(obj)) {
                    if (value === null || value === undefined) {
                        xml += `${indentStr}<${key} xsi:nil="true"/>\n`;
                    } else if (typeof value === 'object') {
                        xml += `${indentStr}<${key}>\n`;
                        xml += this.objectToXml(value, indent + 2);
                        xml += `${indentStr}</${key}>\n`;
                    } else {
                        xml += `${indentStr}<${key}>${this.escapeXml(String(value))}</${key}>\n`;
                    }
                }
            }
        } else {
            xml += `${indentStr}${this.escapeXml(String(obj))}\n`;
        }

        return xml;
    }

    /**
     * Escape special XML characters
     */
    private escapeXml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Find namespace prefix by URI
     */
    private findNamespacePrefix(uri: string): string | null {
        const ns = this.namespaces.find(n => n.uri === uri);
        return ns ? ns.prefix : null;
    }

    /**
     * Set SOAP version
     */
    public setVersion(version: SoapVersion): this {
        this.version = version;
        return this;
    }

    /**
     * Add SOAP header
     */
    public addHeader(header: SoapHeader): this {
        this.headers.push(header);
        return this;
    }

    /**
     * Add multiple SOAP headers
     */
    public addHeaders(headers: SoapHeader[]): this {
        this.headers.push(...headers);
        return this;
    }

    /**
     * Clear all headers
     */
    public clearHeaders(): this {
        this.headers = [];
        return this;
    }

    /**
     * Add namespace
     */
    public addNamespace(prefix: string, uri: string): this {
        this.namespaces.push({ prefix, uri });
        return this;
    }

    /**
     * Add multiple namespaces
     */
    public addNamespaces(namespaces: SoapNamespace[]): this {
        this.namespaces.push(...namespaces);
        return this;
    }

    /**
     * Set encoding style
     */
    public setEncodingStyle(encodingStyle: string): this {
        this.encodingStyle = encodingStyle;
        return this;
    }

    /**
     * Set SOAP action
     */
    public setSoapAction(soapAction: string): this {
        this.soapAction = soapAction;
        return this;
    }

    /**
     * Get SOAP action
     */
    public getSoapAction(): string | undefined {
        return this.soapAction;
    }

    /**
     * Get content type for SOAP request
     */
    public getContentType(): string {
        if (this.version === '1.1') {
            return 'text/xml; charset=utf-8';
        } else {
            return 'application/soap+xml; charset=utf-8';
        }
    }

    /**
     * Get SOAP headers for HTTP request
     */
    public getHttpHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': this.getContentType()
        };

        // SOAP 1.1 uses SOAPAction header
        if (this.version === '1.1' && this.soapAction) {
            headers['SOAPAction'] = `"${this.soapAction}"`;
        }
        // SOAP 1.2 includes action in Content-Type
        else if (this.version === '1.2' && this.soapAction) {
            headers['Content-Type'] += `; action="${this.soapAction}"`;
        }

        return headers;
    }

    /**
     * Build SOAP fault response
     */
    public buildFaultEnvelope(
        faultCode: string,
        faultString: string,
        faultActor?: string,
        detail?: any
    ): string {
        const envelopePrefix = this.version === '1.1' ? 'soap' : 'env';
        const namespaces = this.buildNamespaceAttributes(envelopePrefix);

        let envelope = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        envelope += `<${envelopePrefix}:Envelope${namespaces}>\n`;
        envelope += `  <${envelopePrefix}:Body>\n`;
        envelope += `    <${envelopePrefix}:Fault>\n`;

        if (this.version === '1.1') {
            // SOAP 1.1 Fault structure
            envelope += `      <faultcode>${faultCode}</faultcode>\n`;
            envelope += `      <faultstring>${this.escapeXml(faultString)}</faultstring>\n`;
            if (faultActor) {
                envelope += `      <faultactor>${this.escapeXml(faultActor)}</faultactor>\n`;
            }
            if (detail) {
                envelope += `      <detail>\n`;
                envelope += this.objectToXml(detail, 8);
                envelope += `      </detail>\n`;
            }
        } else {
            // SOAP 1.2 Fault structure
            envelope += `      <${envelopePrefix}:Code>\n`;
            envelope += `        <${envelopePrefix}:Value>${faultCode}</${envelopePrefix}:Value>\n`;
            envelope += `      </${envelopePrefix}:Code>\n`;
            envelope += `      <${envelopePrefix}:Reason>\n`;
            envelope += `        <${envelopePrefix}:Text xml:lang="en">${this.escapeXml(faultString)}</${envelopePrefix}:Text>\n`;
            envelope += `      </${envelopePrefix}:Reason>\n`;
            if (faultActor) {
                envelope += `      <${envelopePrefix}:Role>${this.escapeXml(faultActor)}</${envelopePrefix}:Role>\n`;
            }
            if (detail) {
                envelope += `      <${envelopePrefix}:Detail>\n`;
                envelope += this.objectToXml(detail, 8);
                envelope += `      </${envelopePrefix}:Detail>\n`;
            }
        }

        envelope += `    </${envelopePrefix}:Fault>\n`;
        envelope += `  </${envelopePrefix}:Body>\n`;
        envelope += `</${envelopePrefix}:Envelope>`;

        return envelope;
    }

    /**
     * Parse WSDL operation to create SOAP envelope
     */
    public buildFromWsdlOperation(
        operationName: string,
        parameters: Record<string, any>,
        targetNamespace: string
    ): string {
        const bodyContent: SoapBodyContent = {
            operation: operationName,
            parameters: parameters,
            namespace: targetNamespace
        };

        return this.buildEnvelope(bodyContent);
    }

    /**
     * Clone builder with current settings
     */
    public clone(): CSSoapEnvelopeBuilder {
        return new CSSoapEnvelopeBuilder({
            version: this.version,
            headers: [...this.headers],
            namespaces: [...this.namespaces],
            encodingStyle: this.encodingStyle,
            soapAction: this.soapAction
        });
    }

    /**
     * Reset builder to default state
     */
    public reset(): this {
        this.version = '1.1';
        this.headers = [];
        this.namespaces = [];
        this.encodingStyle = undefined;
        this.soapAction = undefined;
        return this;
    }

    /**
     * Get current configuration
     */
    public getConfiguration(): SoapEnvelopeOptions {
        return {
            version: this.version,
            headers: [...this.headers],
            namespaces: [...this.namespaces],
            encodingStyle: this.encodingStyle,
            soapAction: this.soapAction
        };
    }
}
