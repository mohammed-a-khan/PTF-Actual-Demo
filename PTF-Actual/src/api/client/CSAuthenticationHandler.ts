import * as crypto from 'crypto';
import { CSRequestOptions, CSAuthConfig, CSAuthType, CSOAuth2Token } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

export class CSAuthenticationHandler {
    private tokenCache: Map<string, CSOAuth2Token>;
    private configManager: CSConfigurationManager;

    constructor() {
        this.tokenCache = new Map();
        this.configManager = CSConfigurationManager.getInstance();
    }

    public async authenticate(request: CSRequestOptions, auth: CSAuthConfig): Promise<CSRequestOptions> {
        if (!auth || !auth.type) {
            return request;
        }

        const authenticatedRequest = { ...request };
        authenticatedRequest.headers = authenticatedRequest.headers || {};

        try {
            switch (auth.type) {
                case 'basic':
                    return this.applyBasicAuth(authenticatedRequest, auth);

                case 'bearer':
                    return this.applyBearerAuth(authenticatedRequest, auth);

                case 'apikey':
                    return this.applyApiKeyAuth(authenticatedRequest, auth);

                case 'oauth2':
                    return await this.applyOAuth2Auth(authenticatedRequest, auth);

                case 'digest':
                    return this.applyDigestAuth(authenticatedRequest, auth);

                case 'jwt':
                    return this.applyJwtAuth(authenticatedRequest, auth);

                case 'aws':
                    return this.applyAwsAuth(authenticatedRequest, auth);

                case 'ntlm':
                    return this.applyNtlmAuth(authenticatedRequest, auth);

                case 'hawk':
                    return this.applyHawkAuth(authenticatedRequest, auth);

                case 'custom':
                    return await this.applyCustomAuth(authenticatedRequest, auth);

                case 'certificate':
                    return this.applyCertificateAuth(authenticatedRequest, auth);

                default:
                    CSReporter.warn(`Unsupported authentication type: ${auth.type}`);
                    return authenticatedRequest;
            }
        } catch (error) {
            CSReporter.error(`Authentication failed: ${(error as Error).message}`);
            throw error;
        }
    }

    private applyBasicAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { username, password } = auth.credentials || {};

        if (!username || !password) {
            throw new Error('Basic auth requires username and password');
        }

        const credentials = Buffer.from(`${username}:${password}`).toString('base64');
        request.headers!['Authorization'] = `Basic ${credentials}`;

        CSReporter.debug('Applied Basic authentication');
        return request;
    }

    private applyBearerAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { token } = auth.credentials || {};

        if (!token) {
            throw new Error('Bearer auth requires token');
        }

        const scheme = auth.options?.scheme || 'Bearer';
        request.headers!['Authorization'] = `${scheme} ${token}`;

        CSReporter.debug('Applied Bearer authentication');
        return request;
    }

    private applyApiKeyAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { apiKey } = auth.credentials || {};
        const { headerName, parameterName } = auth.options || {};

        if (!apiKey) {
            throw new Error('API key auth requires apiKey');
        }

        if (headerName) {
            request.headers![headerName] = apiKey;
        } else if (parameterName) {
            request.query = request.query || {};
            request.query[parameterName] = apiKey;
        } else {
            request.headers!['X-API-Key'] = apiKey;
        }

        CSReporter.debug('Applied API Key authentication');
        return request;
    }

    private async applyOAuth2Auth(request: CSRequestOptions, auth: CSAuthConfig): Promise<CSRequestOptions> {
        const token = await this.getOAuth2Token(auth);

        if (!token) {
            throw new Error('Failed to obtain OAuth2 token');
        }

        request.headers!['Authorization'] = `${token.token_type || 'Bearer'} ${token.access_token}`;

        CSReporter.debug('Applied OAuth2 authentication');
        return request;
    }

    private async getOAuth2Token(auth: CSAuthConfig): Promise<CSOAuth2Token | null> {
        const cacheKey = this.getOAuth2CacheKey(auth);
        const cachedToken = this.tokenCache.get(cacheKey);

        if (cachedToken && this.isTokenValid(cachedToken)) {
            return cachedToken;
        }

        const { grantType } = auth.options || {};

        switch (grantType) {
            case 'client_credentials':
                return await this.getClientCredentialsToken(auth);

            case 'password':
                return await this.getPasswordToken(auth);

            case 'refresh_token':
                return await this.refreshToken(auth);

            default:
                CSReporter.warn(`Unsupported OAuth2 grant type: ${grantType}`);
                return null;
        }
    }

    private async getClientCredentialsToken(auth: CSAuthConfig): Promise<CSOAuth2Token> {
        const { clientId, clientSecret } = auth.credentials || {};
        const { tokenUrl, scope } = auth.options || {};

        if (!clientId || !clientSecret || !tokenUrl) {
            throw new Error('Client credentials grant requires clientId, clientSecret, and tokenUrl');
        }

        const params = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        });

        if (scope) {
            params.append('scope', Array.isArray(scope) ? scope.join(' ') : scope);
        }

        const response = await this.makeTokenRequest(tokenUrl, params);
        const token = await response.json();

        if (token.expires_in) {
            token.expires_at = Date.now() + (token.expires_in * 1000);
        }

        const cacheKey = this.getOAuth2CacheKey(auth);
        this.tokenCache.set(cacheKey, token);

        return token;
    }

    private async getPasswordToken(auth: CSAuthConfig): Promise<CSOAuth2Token> {
        const { username, password, clientId, clientSecret } = auth.credentials || {};
        const { tokenUrl, scope } = auth.options || {};

        if (!username || !password || !tokenUrl) {
            throw new Error('Password grant requires username, password, and tokenUrl');
        }

        const params = new URLSearchParams({
            grant_type: 'password',
            username,
            password
        });

        if (clientId) params.append('client_id', clientId);
        if (clientSecret) params.append('client_secret', clientSecret);
        if (scope) params.append('scope', Array.isArray(scope) ? scope.join(' ') : scope);

        const response = await this.makeTokenRequest(tokenUrl, params);
        const token = await response.json();

        if (token.expires_in) {
            token.expires_at = Date.now() + (token.expires_in * 1000);
        }

        const cacheKey = this.getOAuth2CacheKey(auth);
        this.tokenCache.set(cacheKey, token);

        return token;
    }

    private async refreshToken(auth: CSAuthConfig): Promise<CSOAuth2Token> {
        const { refreshToken, clientId, clientSecret } = auth.credentials || {};
        const { tokenUrl } = auth.options || {};

        if (!refreshToken || !tokenUrl) {
            throw new Error('Refresh token grant requires refreshToken and tokenUrl');
        }

        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        });

        if (clientId) params.append('client_id', clientId);
        if (clientSecret) params.append('client_secret', clientSecret);

        const response = await this.makeTokenRequest(tokenUrl, params);
        const token = await response.json();

        if (token.expires_in) {
            token.expires_at = Date.now() + (token.expires_in * 1000);
        }

        const cacheKey = this.getOAuth2CacheKey(auth);
        this.tokenCache.set(cacheKey, token);

        return token;
    }

    private async makeTokenRequest(url: string, params: URLSearchParams): Promise<any> {
        const https = url.startsWith('https') ? require('https') : require('http');
        const urlObj = new URL(url);

        return new Promise((resolve, reject) => {
            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(params.toString())
                }
            };

            const req = https.request(options, (res: any) => {
                let data = '';
                res.on('data', (chunk: any) => data += chunk);
                res.on('end', () => {
                    try {
                        resolve({ json: () => JSON.parse(data) });
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on('error', reject);
            req.write(params.toString());
            req.end();
        });
    }

    private applyDigestAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { username, password } = auth.credentials || {};
        const { realm, qop, nonce, opaque, algorithm } = auth.options || {};

        if (!username || !password) {
            throw new Error('Digest auth requires username and password');
        }

        const ha1 = this.md5(`${username}:${realm}:${password}`);
        const ha2 = this.md5(`${request.method}:${new URL(request.url).pathname}`);
        const nc = '00000001';
        const cnonce = crypto.randomBytes(16).toString('hex');

        let response;
        if (qop === 'auth') {
            response = this.md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
        } else {
            response = this.md5(`${ha1}:${nonce}:${ha2}`);
        }

        const authHeader = [
            `Digest username="${username}"`,
            `realm="${realm}"`,
            `nonce="${nonce}"`,
            `uri="${new URL(request.url).pathname}"`,
            `algorithm="${algorithm || 'MD5'}"`,
            `response="${response}"`,
            qop ? `qop=${qop}` : '',
            qop ? `nc=${nc}` : '',
            qop ? `cnonce="${cnonce}"` : '',
            opaque ? `opaque="${opaque}"` : ''
        ].filter(Boolean).join(', ');

        request.headers!['Authorization'] = authHeader;

        CSReporter.debug('Applied Digest authentication');
        return request;
    }

    private applyJwtAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { privateKey, token } = auth.credentials || {};

        if (token) {
            request.headers!['Authorization'] = `Bearer ${token}`;
        } else if (privateKey) {
            const jwt = this.generateJWT(auth);
            request.headers!['Authorization'] = `Bearer ${jwt}`;
        } else {
            throw new Error('JWT auth requires token or privateKey');
        }

        CSReporter.debug('Applied JWT authentication');
        return request;
    }

    private generateJWT(auth: CSAuthConfig): string {
        const { privateKey } = auth.credentials || {};
        const { algorithm, issuer, audience, subject, expiration } = auth.options || {};

        const header = {
            alg: algorithm || 'HS256',
            typ: 'JWT'
        };

        const payload: any = {
            iss: issuer,
            sub: subject,
            aud: audience,
            iat: Math.floor(Date.now() / 1000),
            exp: expiration || Math.floor(Date.now() / 1000) + 3600
        };

        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

        const signatureInput = `${encodedHeader}.${encodedPayload}`;
        const signature = crypto
            .createHmac('sha256', privateKey as string)
            .update(signatureInput)
            .digest('base64url');

        return `${signatureInput}.${signature}`;
    }

    private applyAwsAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { accessKey, secretKey, sessionToken } = auth.credentials || {};
        const { region, service } = auth.options || {};

        if (!accessKey || !secretKey) {
            throw new Error('AWS auth requires accessKey and secretKey');
        }

        const date = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
        const dateStamp = date.substr(0, 8);

        const canonical_uri = new URL(request.url).pathname;
        const canonical_querystring = new URL(request.url).search.substr(1);
        const canonical_headers = `host:${new URL(request.url).hostname}\nx-amz-date:${date}\n`;
        const signed_headers = 'host;x-amz-date';

        const payload_hash = crypto.createHash('sha256').update(request.body || '').digest('hex');
        const canonical_request = `${request.method}\n${canonical_uri}\n${canonical_querystring}\n${canonical_headers}\n${signed_headers}\n${payload_hash}`;

        const algorithm = 'AWS4-HMAC-SHA256';
        const credential_scope = `${dateStamp}/${region}/${service}/aws4_request`;
        const string_to_sign = `${algorithm}\n${date}\n${credential_scope}\n${crypto.createHash('sha256').update(canonical_request).digest('hex')}`;

        const signing_key = this.getAWSSignatureKey(secretKey, dateStamp, region || 'us-east-1', service || 'execute-api');
        const signature = crypto.createHmac('sha256', signing_key).update(string_to_sign).digest('hex');

        const authorization_header = `${algorithm} Credential=${accessKey}/${credential_scope}, SignedHeaders=${signed_headers}, Signature=${signature}`;

        request.headers!['Authorization'] = authorization_header;
        request.headers!['x-amz-date'] = date;
        if (sessionToken) {
            request.headers!['x-amz-security-token'] = sessionToken;
        }

        CSReporter.debug('Applied AWS Signature authentication');
        return request;
    }

    private getAWSSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Buffer {
        const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
        const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
        const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
        const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
        return kSigning;
    }

    private applyNtlmAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { username, password, domain, workstation } = auth.credentials || {};

        if (!username || !password) {
            throw new Error('NTLM auth requires username and password');
        }

        const type1Message = this.createNTLMType1Message(domain, workstation);
        request.headers!['Authorization'] = `NTLM ${type1Message}`;

        CSReporter.debug('Applied NTLM Type 1 authentication');
        return request;
    }

    private createNTLMType1Message(domain?: string, workstation?: string): string {
        const NTLMSSP_SIGNATURE = 'NTLMSSP\0';
        const NTLM_TYPE1 = 0x00000001;
        const flags = 0x00088207;

        const domainLen = domain ? domain.length : 0;
        const workstationLen = workstation ? workstation.length : 0;

        const buffer = Buffer.alloc(32 + domainLen + workstationLen);
        let offset = 0;

        buffer.write(NTLMSSP_SIGNATURE, offset);
        offset += 8;

        buffer.writeUInt32LE(NTLM_TYPE1, offset);
        offset += 4;

        buffer.writeUInt32LE(flags, offset);
        offset += 4;

        buffer.writeUInt16LE(domainLen, offset);
        buffer.writeUInt16LE(domainLen, offset + 2);
        buffer.writeUInt32LE(32 + workstationLen, offset + 4);
        offset += 8;

        buffer.writeUInt16LE(workstationLen, offset);
        buffer.writeUInt16LE(workstationLen, offset + 2);
        buffer.writeUInt32LE(32, offset + 4);
        offset += 8;

        if (workstation) {
            buffer.write(workstation, 32);
        }
        if (domain) {
            buffer.write(domain, 32 + workstationLen);
        }

        return buffer.toString('base64');
    }

    private applyHawkAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { hawkId, hawkKey } = auth.credentials || {};
        const { hawkAlgorithm, hawkExt } = auth.options || {};

        if (!hawkId || !hawkKey) {
            throw new Error('Hawk auth requires hawkId and hawkKey');
        }

        const url = new URL(request.url);
        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = crypto.randomBytes(6).toString('base64');
        const method = request.method || 'GET';

        const mac = this.calculateHawkMac(
            timestamp,
            nonce,
            method,
            url.pathname + url.search,
            url.hostname,
            url.port || (url.protocol === 'https:' ? 443 : 80),
            hawkKey,
            hawkAlgorithm || 'sha256'
        );

        const authHeader = `Hawk id="${hawkId}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"${hawkExt ? `, ext="${hawkExt}"` : ''}`;

        request.headers!['Authorization'] = authHeader;

        CSReporter.debug('Applied Hawk authentication');
        return request;
    }

    private applyCertificateAuth(request: CSRequestOptions, auth: CSAuthConfig): CSRequestOptions {
        const { certificate, privateKey, password } = auth.credentials || {};
        const fs = require('fs');
        const path = require('path');

        if (!certificate) {
            throw new Error('Certificate auth requires certificate path');
        }

        try {
            // Check if this is a PFX/P12 file
            const certPath = typeof certificate === 'string' ? certificate : '';
            const isPfx = certPath.toLowerCase().endsWith('.pfx') || certPath.toLowerCase().endsWith('.p12');

            if (isPfx) {
                // Handle PFX/PKCS12 certificate
                if (typeof certificate === 'string' && fs.existsSync(certificate)) {
                    // Read PFX file as binary
                    request.pfx = fs.readFileSync(certificate);
                    if (password) {
                        request.passphrase = password;
                    }
                    CSReporter.debug('Applied PFX certificate authentication');
                } else {
                    throw new Error('PFX certificate file not found');
                }
            } else {
                // Handle PEM certificate
                let certData: string;
                if (typeof certificate === 'string' && fs.existsSync(certificate)) {
                    certData = fs.readFileSync(certificate, 'utf8');
                } else {
                    certData = certificate.toString(); // Already a Buffer or string content
                }

                // Clean the certificate data to extract just the certificate part
                request.cert = this.extractCertificateFromPEM(certData);

                if (privateKey) {
                    let keyData: string;
                    if (typeof privateKey === 'string' && fs.existsSync(privateKey)) {
                        keyData = fs.readFileSync(privateKey, 'utf8');
                    } else {
                        keyData = privateKey.toString(); // Already a Buffer or string content
                    }
                    request.key = this.extractPrivateKeyFromPEM(keyData);
                } else {
                    // Extract private key from the same certificate file if privateKey not specified
                    request.key = this.extractPrivateKeyFromPEM(certData);
                }

                if (password) {
                    request.passphrase = password;
                }

                CSReporter.debug('Applied PEM certificate authentication');
            }
        } catch (error) {
            throw new Error(`Failed to load certificate: ${(error as Error).message}`);
        }

        return request;
    }

    private extractCertificateFromPEM(pemData: string): string {
        // Extract certificate from PEM data, removing any bag attributes or metadata
        const certMatch = pemData.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
        if (!certMatch) {
            throw new Error('No certificate found in PEM data');
        }
        return certMatch[0];
    }

    private extractPrivateKeyFromPEM(pemData: string): string {
        // Extract private key from PEM data, supporting both encrypted and unencrypted keys
        const keyPatterns = [
            /-----BEGIN ENCRYPTED PRIVATE KEY-----[\s\S]*?-----END ENCRYPTED PRIVATE KEY-----/,
            /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/,
            /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/
        ];

        for (const pattern of keyPatterns) {
            const keyMatch = pemData.match(pattern);
            if (keyMatch) {
                return keyMatch[0];
            }
        }

        throw new Error('No private key found in PEM data');
    }

    private calculateHawkMac(
        timestamp: number,
        nonce: string,
        method: string,
        uri: string,
        host: string,
        port: number | string,
        key: string,
        algorithm: string
    ): string {
        const normalized = `hawk.1.header\n${timestamp}\n${nonce}\n${method}\n${uri}\n${host.toLowerCase()}\n${port}\n\n\n`;
        return crypto.createHmac(algorithm, key).update(normalized).digest('base64');
    }

    private async applyCustomAuth(request: CSRequestOptions, auth: CSAuthConfig): Promise<CSRequestOptions> {
        const { customAuth } = auth.credentials || {};

        if (!customAuth || typeof customAuth !== 'function') {
            throw new Error('Custom auth requires customAuth function');
        }

        const authenticatedRequest = await customAuth(request);

        CSReporter.debug('Applied Custom authentication');
        return authenticatedRequest;
    }

    private getOAuth2CacheKey(auth: CSAuthConfig): string {
        const { clientId, username } = auth.credentials || {};
        const { tokenUrl } = auth.options || {};
        return `${tokenUrl}:${clientId || username || 'default'}`;
    }

    private isTokenValid(token: CSOAuth2Token): boolean {
        if (!token.expires_at) {
            return true;
        }

        const bufferTime = 60000;
        return Date.now() < (token.expires_at - bufferTime);
    }

    private md5(data: string): string {
        return crypto.createHash('md5').update(data).digest('hex');
    }

    public clearTokenCache(): void {
        this.tokenCache.clear();
        CSReporter.debug('OAuth2 token cache cleared');
    }

    public getCachedTokens(): Map<string, CSOAuth2Token> {
        return new Map(this.tokenCache);
    }

    public setAuthentication(authConfig: CSAuthConfig): void {
        // Store the auth configuration for use in authenticate method
        this.currentAuthConfig = authConfig;
    }

    public clearAuthentication(): void {
        this.currentAuthConfig = undefined;
        this.clearTokenCache();
    }

    private currentAuthConfig?: CSAuthConfig;
}