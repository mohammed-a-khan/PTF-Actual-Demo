import * as crypto from 'crypto';
import { CSReporter } from '../../reporter/CSReporter';
import { SoapHeader } from './CSSoapEnvelopeBuilder';

/**
 * SOAP Security Handler
 * Implements WS-Security standards including:
 * - UsernameToken Authentication
 * - X.509 Binary Security Token
 * - SAML Assertions
 * - Timestamp
 * - Digital Signatures
 */

export type WsSecurityType =
    | 'UsernameToken'
    | 'BinarySecurityToken'
    | 'SAMLAssertion'
    | 'Timestamp'
    | 'Signature';

export interface WsSecurityConfig {
    type: WsSecurityType;
    username?: string;
    password?: string;
    passwordType?: 'PasswordText' | 'PasswordDigest';
    nonce?: boolean;
    timestamp?: boolean;
    certificate?: string;
    privateKey?: string;
    tokenReference?: string;
    samlAssertion?: string;
    timestampTTL?: number; // Time to live in seconds
}

export interface WsSecurityTimestamp {
    created: string;
    expires: string;
}

export class CSSoapSecurityHandler {
    private readonly WSSE_NAMESPACE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
    private readonly WSU_NAMESPACE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
    private readonly WSSE_PASSWORD_TEXT = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';
    private readonly WSSE_PASSWORD_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
    private readonly WSSE_BASE64_BINARY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
    private readonly X509_TOKEN_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';

    /**
     * Create WS-Security header based on configuration
     */
    public createSecurityHeader(config: WsSecurityConfig): SoapHeader {
        let securityValue = '';

        switch (config.type) {
            case 'UsernameToken':
                securityValue = this.createUsernameToken(config);
                break;
            case 'BinarySecurityToken':
                securityValue = this.createBinarySecurityToken(config);
                break;
            case 'Timestamp':
                securityValue = this.createTimestamp(config.timestampTTL);
                break;
            case 'SAMLAssertion':
                securityValue = this.createSAMLAssertion(config);
                break;
            default:
                throw new Error(`Unsupported WS-Security type: ${config.type}`);
        }

        // Add timestamp if requested
        if (config.timestamp && config.type !== 'Timestamp') {
            securityValue = this.createTimestamp(config.timestampTTL) + '\n' + securityValue;
        }

        return {
            name: 'wsse:Security',
            value: securityValue,
            attributes: {
                'xmlns:wsse': this.WSSE_NAMESPACE,
                'xmlns:wsu': this.WSU_NAMESPACE
            },
            mustUnderstand: true
        };
    }

    /**
     * Create UsernameToken for WS-Security
     */
    private createUsernameToken(config: WsSecurityConfig): string {
        if (!config.username || !config.password) {
            throw new Error('UsernameToken requires username and password');
        }

        const passwordType = config.passwordType || 'PasswordText';
        const useNonce = config.nonce !== false; // Default to true

        let token = '<wsse:UsernameToken>\n';
        token += `  <wsse:Username>${this.escapeXml(config.username)}</wsse:Username>\n`;

        if (passwordType === 'PasswordDigest') {
            const nonce = useNonce ? crypto.randomBytes(16).toString('base64') : '';
            const created = new Date().toISOString();
            const passwordDigest = this.createPasswordDigest(config.password, nonce, created);

            token += `  <wsse:Password Type="${this.WSSE_PASSWORD_DIGEST}">${passwordDigest}</wsse:Password>\n`;
            if (useNonce) {
                token += `  <wsse:Nonce EncodingType="${this.WSSE_BASE64_BINARY}">${nonce}</wsse:Nonce>\n`;
            }
            token += `  <wsu:Created>${created}</wsu:Created>\n`;
        } else {
            token += `  <wsse:Password Type="${this.WSSE_PASSWORD_TEXT}">${this.escapeXml(config.password)}</wsse:Password>\n`;
            if (useNonce) {
                const nonce = crypto.randomBytes(16).toString('base64');
                token += `  <wsse:Nonce EncodingType="${this.WSSE_BASE64_BINARY}">${nonce}</wsse:Nonce>\n`;
            }
        }

        token += '</wsse:UsernameToken>';

        CSReporter.debug(`Created WS-Security UsernameToken (${passwordType})`);
        return token;
    }

    /**
     * Create password digest according to WS-Security specification
     * Digest = Base64( SHA-1( nonce + created + password ) )
     */
    private createPasswordDigest(password: string, nonce: string, created: string): string {
        const nonceBytes = Buffer.from(nonce, 'base64');
        const createdBytes = Buffer.from(created, 'utf8');
        const passwordBytes = Buffer.from(password, 'utf8');

        const combined = Buffer.concat([nonceBytes, createdBytes, passwordBytes]);
        const hash = crypto.createHash('sha1').update(combined).digest();

        return hash.toString('base64');
    }

    /**
     * Create Binary Security Token (typically X.509 certificate)
     */
    private createBinarySecurityToken(config: WsSecurityConfig): string {
        if (!config.certificate) {
            throw new Error('BinarySecurityToken requires certificate');
        }

        // Remove PEM headers and newlines
        const certData = config.certificate
            .replace(/-----BEGIN CERTIFICATE-----/g, '')
            .replace(/-----END CERTIFICATE-----/g, '')
            .replace(/\s/g, '');

        let token = '<wsse:BinarySecurityToken\n';
        token += `  EncodingType="${this.WSSE_BASE64_BINARY}"\n`;
        token += `  ValueType="${this.X509_TOKEN_TYPE}"\n`;
        token += `  wsu:Id="X509Token">\n`;
        token += `  ${certData}\n`;
        token += '</wsse:BinarySecurityToken>';

        CSReporter.debug('Created WS-Security BinarySecurityToken');
        return token;
    }

    /**
     * Create Timestamp element
     */
    private createTimestamp(ttl: number = 300): string {
        const created = new Date();
        const expires = new Date(created.getTime() + (ttl * 1000));

        let timestamp = '<wsu:Timestamp wsu:Id="Timestamp">\n';
        timestamp += `  <wsu:Created>${created.toISOString()}</wsu:Created>\n`;
        timestamp += `  <wsu:Expires>${expires.toISOString()}</wsu:Expires>\n`;
        timestamp += '</wsu:Timestamp>';

        CSReporter.debug(`Created WS-Security Timestamp (TTL: ${ttl}s)`);
        return timestamp;
    }

    /**
     * Create SAML Assertion
     */
    private createSAMLAssertion(config: WsSecurityConfig): string {
        if (!config.samlAssertion) {
            throw new Error('SAMLAssertion type requires samlAssertion data');
        }

        // SAML assertions are typically provided as complete XML
        // Just wrap it in the Security header
        CSReporter.debug('Using provided SAML Assertion');
        return config.samlAssertion;
    }

    /**
     * Create signature reference (placeholder - full implementation would require crypto library)
     */
    public createSignatureReference(config: WsSecurityConfig): string {
        CSReporter.warn('Digital signatures require additional crypto libraries for full implementation');

        let signature = '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">\n';
        signature += '  <ds:SignedInfo>\n';
        signature += '    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>\n';
        signature += '    <ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>\n';
        signature += '    <ds:Reference URI="#Body">\n';
        signature += '      <ds:Transforms>\n';
        signature += '        <ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>\n';
        signature += '      </ds:Transforms>\n';
        signature += '      <ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>\n';
        signature += '      <ds:DigestValue></ds:DigestValue>\n';
        signature += '    </ds:Reference>\n';
        signature += '  </ds:SignedInfo>\n';
        signature += '  <ds:SignatureValue></ds:SignatureValue>\n';
        signature += '  <ds:KeyInfo>\n';
        signature += '    <wsse:SecurityTokenReference>\n';
        signature += '      <wsse:Reference URI="#X509Token"/>\n';
        signature += '    </wsse:SecurityTokenReference>\n';
        signature += '  </ds:KeyInfo>\n';
        signature += '</ds:Signature>';

        return signature;
    }

    /**
     * Verify password digest
     */
    public verifyPasswordDigest(
        providedDigest: string,
        password: string,
        nonce: string,
        created: string
    ): boolean {
        const calculatedDigest = this.createPasswordDigest(password, nonce, created);
        return providedDigest === calculatedDigest;
    }

    /**
     * Parse WS-Security header from SOAP response
     */
    public parseSecurityHeader(securityHeaderXml: string): {
        usernameToken?: any;
        timestamp?: WsSecurityTimestamp;
        binarySecurityToken?: string;
    } {
        const result: any = {};

        // Extract UsernameToken
        const usernameMatch = securityHeaderXml.match(
            /<wsse:UsernameToken[^>]*>([\s\S]*?)<\/wsse:UsernameToken>/
        );
        if (usernameMatch) {
            const usernameTokenXml = usernameMatch[1];
            const usernameValue = usernameTokenXml.match(/<wsse:Username[^>]*>([^<]+)<\/wsse:Username>/);
            const passwordValue = usernameTokenXml.match(/<wsse:Password[^>]*>([^<]+)<\/wsse:Password>/);

            result.usernameToken = {
                username: usernameValue ? usernameValue[1] : null,
                password: passwordValue ? passwordValue[1] : null
            };
        }

        // Extract Timestamp
        const timestampMatch = securityHeaderXml.match(
            /<wsu:Timestamp[^>]*>([\s\S]*?)<\/wsu:Timestamp>/
        );
        if (timestampMatch) {
            const timestampXml = timestampMatch[1];
            const createdValue = timestampXml.match(/<wsu:Created[^>]*>([^<]+)<\/wsu:Created>/);
            const expiresValue = timestampXml.match(/<wsu:Expires[^>]*>([^<]+)<\/wsu:Expires>/);

            result.timestamp = {
                created: createdValue ? createdValue[1] : '',
                expires: expiresValue ? expiresValue[1] : ''
            };
        }

        // Extract BinarySecurityToken
        const binaryTokenMatch = securityHeaderXml.match(
            /<wsse:BinarySecurityToken[^>]*>([\s\S]*?)<\/wsse:BinarySecurityToken>/
        );
        if (binaryTokenMatch) {
            result.binarySecurityToken = binaryTokenMatch[1].trim();
        }

        return result;
    }

    /**
     * Validate timestamp
     */
    public validateTimestamp(timestamp: WsSecurityTimestamp): boolean {
        const now = new Date();
        const created = new Date(timestamp.created);
        const expires = new Date(timestamp.expires);

        if (now < created) {
            CSReporter.warn('Timestamp created time is in the future');
            return false;
        }

        if (now > expires) {
            CSReporter.warn('Timestamp has expired');
            return false;
        }

        return true;
    }

    /**
     * Create custom security header
     */
    public createCustomSecurityHeader(
        headerName: string,
        headerValue: any,
        mustUnderstand: boolean = true
    ): SoapHeader {
        return {
            name: headerName,
            value: headerValue,
            attributes: {
                'xmlns:wsse': this.WSSE_NAMESPACE,
                'xmlns:wsu': this.WSU_NAMESPACE
            },
            mustUnderstand
        };
    }

    /**
     * Escape XML special characters
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
     * Create complete WS-Security configuration for Basic Authentication
     */
    public static createBasicAuthConfig(username: string, password: string): WsSecurityConfig {
        return {
            type: 'UsernameToken',
            username,
            password,
            passwordType: 'PasswordText',
            nonce: true,
            timestamp: true
        };
    }

    /**
     * Create complete WS-Security configuration for Digest Authentication
     */
    public static createDigestAuthConfig(username: string, password: string): WsSecurityConfig {
        return {
            type: 'UsernameToken',
            username,
            password,
            passwordType: 'PasswordDigest',
            nonce: true,
            timestamp: true
        };
    }

    /**
     * Create complete WS-Security configuration for Certificate Authentication
     */
    public static createCertificateAuthConfig(certificate: string, privateKey?: string): WsSecurityConfig {
        return {
            type: 'BinarySecurityToken',
            certificate,
            privateKey,
            timestamp: true
        };
    }

    /**
     * Create complete WS-Security configuration with Timestamp only
     */
    public static createTimestampConfig(ttl: number = 300): WsSecurityConfig {
        return {
            type: 'Timestamp',
            timestampTTL: ttl
        };
    }

    /**
     * Get WS-Security namespace definitions
     */
    public getNamespaceDefinitions(): { prefix: string; uri: string }[] {
        return [
            { prefix: 'wsse', uri: this.WSSE_NAMESPACE },
            { prefix: 'wsu', uri: this.WSU_NAMESPACE }
        ];
    }
}
