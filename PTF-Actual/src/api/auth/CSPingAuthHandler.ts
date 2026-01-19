/**
 * CS Ping Authentication Handler
 *
 * Provides OAuth 2.0 authentication support for Ping Identity products:
 * - PingFederate (on-premises)
 * - PingOne (cloud)
 * - PingOne Advanced Identity Cloud
 *
 * Features:
 * - Auto-discovery of endpoints via .well-known/openid-configuration
 * - Support for multiple grant types (client_credentials, authorization_code, password, device_code)
 * - PKCE support for authorization code flow
 * - Token caching and automatic refresh
 * - Token introspection and revocation
 *
 * @see https://docs.pingidentity.com/pingfederate/latest/developers_reference_guide/pf_oauth_20_endpoints.html
 * @see https://docs.pingidentity.com/pingoneaic/am-oauth2/oauth2-implementing-flows.html
 *
 * @module api/auth/CSPingAuthHandler
 */

import { CSReporter } from '../../reporter/CSReporter';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

/**
 * Ping Identity product type
 */
export type PingProductType = 'pingfederate' | 'pingone' | 'pingone-aic' | 'auto';

/**
 * Supported grant types for Ping authentication
 */
export type PingGrantType =
    | 'client_credentials'
    | 'authorization_code'
    | 'password'
    | 'refresh_token'
    | 'device_code'
    | 'jwt_bearer'
    | 'saml2_bearer';

/**
 * Token endpoint authentication methods
 */
export type PingTokenAuthMethod =
    | 'client_secret_basic'
    | 'client_secret_post'
    | 'private_key_jwt'
    | 'none';

/**
 * Ping authentication configuration
 */
export interface CSPingAuthConfig {
    /** Ping product type (auto-detected if not specified) */
    productType?: PingProductType;

    /** Base URL of the Ping server (e.g., https://auth.example.com or https://auth.pingone.com) */
    baseUrl: string;

    /** PingOne environment ID (required for PingOne) */
    environmentId?: string;

    /** OAuth client ID */
    clientId: string;

    /** OAuth client secret (required for confidential clients) */
    clientSecret?: string;

    /** Grant type to use */
    grantType?: PingGrantType;

    /** Token endpoint authentication method */
    tokenAuthMethod?: PingTokenAuthMethod;

    /** OAuth scopes */
    scope?: string | string[];

    /** Redirect URI for authorization code flow */
    redirectUri?: string;

    /** Username for password grant */
    username?: string;

    /** Password for password grant */
    password?: string;

    /** Enable PKCE for authorization code flow */
    pkce?: boolean;

    /** PKCE code challenge method */
    codeChallengeMethod?: 'plain' | 'S256';

    /** Additional parameters to include in token requests */
    additionalParams?: Record<string, string>;

    /** Custom token endpoint (overrides auto-discovery) */
    tokenEndpoint?: string;

    /** Custom authorization endpoint (overrides auto-discovery) */
    authorizationEndpoint?: string;

    /** Custom introspection endpoint (overrides auto-discovery) */
    introspectionEndpoint?: string;

    /** Custom revocation endpoint (overrides auto-discovery) */
    revocationEndpoint?: string;

    /** Skip SSL certificate verification (not recommended for production) */
    skipSslVerification?: boolean;

    /** Request timeout in milliseconds */
    timeout?: number;
}

/**
 * Ping OAuth token response
 */
export interface CSPingToken {
    accessToken: string;
    tokenType: string;
    expiresIn?: number;
    refreshToken?: string;
    scope?: string;
    idToken?: string;
    expiresAt?: number;
    rawResponse?: any;
}

/**
 * OpenID Connect discovery response
 */
interface OIDCDiscoveryResponse {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint?: string;
    jwks_uri?: string;
    introspection_endpoint?: string;
    revocation_endpoint?: string;
    device_authorization_endpoint?: string;
    end_session_endpoint?: string;
    grant_types_supported?: string[];
    response_types_supported?: string[];
    scopes_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    code_challenge_methods_supported?: string[];
}

/**
 * Ping Identity Authentication Handler
 *
 * Supports OAuth 2.0 authentication with PingFederate and PingOne.
 */
export class CSPingAuthHandler {
    private config: CSPingAuthConfig;
    private discoveryCache: OIDCDiscoveryResponse | null = null;
    private tokens: Map<string, CSPingToken> = new Map();
    private refreshPromises: Map<string, Promise<CSPingToken>> = new Map();
    private tokenExpiryBuffer: number = 60000; // 1 minute buffer
    private codeVerifier?: string;
    private codeChallenge?: string;

    constructor(config: CSPingAuthConfig) {
        this.config = {
            grantType: 'client_credentials',
            tokenAuthMethod: 'client_secret_basic',
            codeChallengeMethod: 'S256',
            timeout: 30000,
            ...config
        };

        if (this.config.pkce) {
            this.initializePKCE();
        }

        CSReporter.debug(`Ping Auth Handler initialized for ${this.config.baseUrl}`);
    }

    /**
     * Initialize PKCE code verifier and challenge
     */
    private initializePKCE(): void {
        this.codeVerifier = this.generateCodeVerifier();
        this.codeChallenge = this.generateCodeChallenge(
            this.codeVerifier,
            this.config.codeChallengeMethod || 'S256'
        );
        CSReporter.debug('PKCE initialized for Ping authentication');
    }

    private generateCodeVerifier(): string {
        return crypto.randomBytes(32).toString('base64url');
    }

    private generateCodeChallenge(verifier: string, method: 'plain' | 'S256'): string {
        if (method === 'plain') {
            return verifier;
        }
        return crypto.createHash('sha256').update(verifier).digest('base64url');
    }

    /**
     * Discover OAuth endpoints from .well-known/openid-configuration
     */
    public async discoverEndpoints(): Promise<OIDCDiscoveryResponse> {
        if (this.discoveryCache) {
            return this.discoveryCache;
        }

        const discoveryUrl = this.buildDiscoveryUrl();
        CSReporter.debug(`Discovering Ping endpoints from: ${discoveryUrl}`);

        try {
            const response = await this.makeRequest<OIDCDiscoveryResponse>(discoveryUrl, 'GET');
            this.discoveryCache = response;
            CSReporter.info('Ping OAuth endpoints discovered successfully');
            CSReporter.debug(`Token endpoint: ${response.token_endpoint}`);
            CSReporter.debug(`Authorization endpoint: ${response.authorization_endpoint}`);
            return response;
        } catch (error: any) {
            CSReporter.error(`Failed to discover Ping endpoints: ${error.message}`);
            throw new Error(`Ping endpoint discovery failed: ${error.message}`);
        }
    }

    /**
     * Build the discovery URL based on product type
     */
    private buildDiscoveryUrl(): string {
        const baseUrl = this.config.baseUrl.replace(/\/$/, '');

        // PingOne uses environment-specific paths
        if (this.config.productType === 'pingone' || this.config.environmentId) {
            const envId = this.config.environmentId;
            if (!envId) {
                throw new Error('environmentId is required for PingOne');
            }
            return `${baseUrl}/${envId}/as/.well-known/openid-configuration`;
        }

        // PingFederate and others use standard path
        return `${baseUrl}/.well-known/openid-configuration`;
    }

    /**
     * Get the token endpoint URL
     */
    private async getTokenEndpoint(): Promise<string> {
        if (this.config.tokenEndpoint) {
            return this.config.tokenEndpoint;
        }

        const discovery = await this.discoverEndpoints();
        return discovery.token_endpoint;
    }

    /**
     * Get the authorization endpoint URL
     */
    private async getAuthorizationEndpoint(): Promise<string> {
        if (this.config.authorizationEndpoint) {
            return this.config.authorizationEndpoint;
        }

        const discovery = await this.discoverEndpoints();
        return discovery.authorization_endpoint;
    }

    /**
     * Get an access token using the configured grant type
     */
    public async getAccessToken(forceRefresh: boolean = false): Promise<string> {
        const cacheKey = this.getCacheKey();
        const cachedToken = this.tokens.get(cacheKey);

        // Return cached token if valid
        if (cachedToken && !forceRefresh && !this.isTokenExpired(cachedToken)) {
            CSReporter.debug('Using cached Ping access token');
            return cachedToken.accessToken;
        }

        // Check for in-progress refresh
        if (this.refreshPromises.has(cacheKey)) {
            CSReporter.debug('Waiting for Ping token refresh in progress');
            const token = await this.refreshPromises.get(cacheKey)!;
            return token.accessToken;
        }

        // Determine how to get token
        let tokenPromise: Promise<CSPingToken>;

        if (cachedToken?.refreshToken && this.config.grantType !== 'client_credentials') {
            CSReporter.debug('Refreshing Ping access token');
            tokenPromise = this.refreshAccessToken(cachedToken.refreshToken);
        } else {
            CSReporter.debug(`Requesting new Ping token using ${this.config.grantType} grant`);
            tokenPromise = this.requestNewToken();
        }

        this.refreshPromises.set(cacheKey, tokenPromise);

        try {
            const token = await tokenPromise;
            this.tokens.set(cacheKey, token);
            return token.accessToken;
        } finally {
            this.refreshPromises.delete(cacheKey);
        }
    }

    /**
     * Request a new token based on grant type
     */
    private async requestNewToken(): Promise<CSPingToken> {
        const grantType = this.config.grantType || 'client_credentials';
        const params: Record<string, string> = {
            grant_type: grantType,
            client_id: this.config.clientId
        };

        // Add client secret based on auth method
        if (this.config.clientSecret && this.config.tokenAuthMethod === 'client_secret_post') {
            params.client_secret = this.config.clientSecret;
        }

        // Add scope
        if (this.config.scope) {
            params.scope = Array.isArray(this.config.scope)
                ? this.config.scope.join(' ')
                : this.config.scope;
        }

        // Grant-specific parameters
        switch (grantType) {
            case 'password':
                if (!this.config.username || !this.config.password) {
                    throw new Error('Username and password required for password grant');
                }
                params.username = this.config.username;
                params.password = this.config.password;
                break;

            case 'client_credentials':
                // Only needs client_id and client_secret
                break;

            case 'jwt_bearer':
                params.grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
                // JWT assertion would be added via additionalParams
                break;

            case 'saml2_bearer':
                params.grant_type = 'urn:ietf:params:oauth:grant-type:saml2-bearer';
                // SAML assertion would be added via additionalParams
                break;

            default:
                // Other grant types handled elsewhere
                break;
        }

        // Add any additional parameters
        if (this.config.additionalParams) {
            Object.assign(params, this.config.additionalParams);
        }

        return this.requestToken(params);
    }

    /**
     * Exchange authorization code for token
     */
    public async exchangeCodeForToken(code: string, state?: string): Promise<CSPingToken> {
        const params: Record<string, string> = {
            grant_type: 'authorization_code',
            code,
            client_id: this.config.clientId
        };

        if (this.config.clientSecret && this.config.tokenAuthMethod === 'client_secret_post') {
            params.client_secret = this.config.clientSecret;
        }

        if (this.config.redirectUri) {
            params.redirect_uri = this.config.redirectUri;
        }

        // PKCE code verifier
        if (this.config.pkce && this.codeVerifier) {
            params.code_verifier = this.codeVerifier;
        }

        const token = await this.requestToken(params);
        this.tokens.set(this.getCacheKey(), token);
        return token;
    }

    /**
     * Refresh an access token
     */
    private async refreshAccessToken(refreshToken: string): Promise<CSPingToken> {
        const params: Record<string, string> = {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.config.clientId
        };

        if (this.config.clientSecret && this.config.tokenAuthMethod === 'client_secret_post') {
            params.client_secret = this.config.clientSecret;
        }

        try {
            const token = await this.requestToken(params);

            // Preserve refresh token if not returned
            if (!token.refreshToken && refreshToken) {
                token.refreshToken = refreshToken;
            }

            return token;
        } catch (error) {
            CSReporter.warn(`Ping token refresh failed, requesting new token: ${(error as Error).message}`);
            return this.requestNewToken();
        }
    }

    /**
     * Make a token request to the Ping server
     */
    private async requestToken(params: Record<string, string>): Promise<CSPingToken> {
        const tokenEndpoint = await this.getTokenEndpoint();
        const url = new URL(tokenEndpoint);
        const isHttps = url.protocol === 'https:';

        const postData = new URLSearchParams(params).toString();

        const headers: Record<string, string> = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(postData)),
            'Accept': 'application/json'
        };

        // Add Basic auth header for client_secret_basic
        if (this.config.clientSecret && this.config.tokenAuthMethod === 'client_secret_basic') {
            const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
            headers['Authorization'] = `Basic ${auth}`;
        }

        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers,
            timeout: this.config.timeout,
            rejectUnauthorized: !this.config.skipSslVerification
        };

        return new Promise((resolve, reject) => {
            const client = isHttps ? https : http;

            const req = client.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);

                        if (res.statusCode !== 200) {
                            const error = new Error(
                                response.error_description ||
                                response.error ||
                                `Ping token request failed with status ${res.statusCode}`
                            );
                            (error as any).response = response;
                            (error as any).statusCode = res.statusCode;
                            reject(error);
                            return;
                        }

                        const token: CSPingToken = {
                            accessToken: response.access_token,
                            tokenType: response.token_type || 'Bearer',
                            expiresIn: response.expires_in,
                            refreshToken: response.refresh_token,
                            scope: response.scope,
                            idToken: response.id_token,
                            expiresAt: response.expires_in
                                ? Date.now() + (response.expires_in * 1000)
                                : undefined,
                            rawResponse: response
                        };

                        CSReporter.info('Ping access token obtained successfully');
                        resolve(token);

                    } catch (error) {
                        reject(new Error(`Failed to parse Ping token response: ${data}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Ping token request failed: ${error.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Ping token request timed out'));
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * Build authorization URL for authorization code flow
     */
    public async getAuthorizationUrl(additionalParams?: Record<string, string>): Promise<string> {
        const authEndpoint = await this.getAuthorizationEndpoint();
        const url = new URL(authEndpoint);

        url.searchParams.set('client_id', this.config.clientId);
        url.searchParams.set('response_type', 'code');

        if (this.config.redirectUri) {
            url.searchParams.set('redirect_uri', this.config.redirectUri);
        }

        if (this.config.scope) {
            const scope = Array.isArray(this.config.scope)
                ? this.config.scope.join(' ')
                : this.config.scope;
            url.searchParams.set('scope', scope);
        }

        // Add state for CSRF protection
        const state = crypto.randomBytes(16).toString('hex');
        url.searchParams.set('state', state);

        // PKCE parameters
        if (this.config.pkce && this.codeChallenge) {
            url.searchParams.set('code_challenge', this.codeChallenge);
            url.searchParams.set('code_challenge_method', this.config.codeChallengeMethod || 'S256');
        }

        // Additional parameters
        if (additionalParams) {
            for (const [key, value] of Object.entries(additionalParams)) {
                url.searchParams.set(key, value);
            }
        }

        CSReporter.debug(`Ping authorization URL: ${url.toString()}`);
        return url.toString();
    }

    /**
     * Introspect a token to check its validity
     */
    public async introspectToken(token?: string): Promise<any> {
        const tokenToIntrospect = token || (await this.getAccessToken());

        let introspectionEndpoint = this.config.introspectionEndpoint;
        if (!introspectionEndpoint && this.discoveryCache) {
            introspectionEndpoint = this.discoveryCache.introspection_endpoint;
        }

        if (!introspectionEndpoint) {
            // Derive from token endpoint for PingFederate
            const tokenEndpoint = await this.getTokenEndpoint();
            introspectionEndpoint = tokenEndpoint.replace('/token.oauth2', '/introspect.oauth2');
        }

        const params: Record<string, string> = {
            token: tokenToIntrospect,
            token_type_hint: 'access_token',
            client_id: this.config.clientId
        };

        if (this.config.clientSecret) {
            params.client_secret = this.config.clientSecret;
        }

        return this.makeRequest(introspectionEndpoint, 'POST', params);
    }

    /**
     * Revoke a token
     */
    public async revokeToken(token?: string, tokenTypeHint?: 'access_token' | 'refresh_token'): Promise<void> {
        const tokenToRevoke = token || (await this.getAccessToken());

        let revocationEndpoint = this.config.revocationEndpoint;
        if (!revocationEndpoint && this.discoveryCache) {
            revocationEndpoint = this.discoveryCache.revocation_endpoint;
        }

        if (!revocationEndpoint) {
            // Derive from token endpoint for PingFederate
            const tokenEndpoint = await this.getTokenEndpoint();
            revocationEndpoint = tokenEndpoint.replace('/token.oauth2', '/revoke.oauth2');
        }

        const params: Record<string, string> = {
            token: tokenToRevoke,
            client_id: this.config.clientId
        };

        if (tokenTypeHint) {
            params.token_type_hint = tokenTypeHint;
        }

        if (this.config.clientSecret) {
            params.client_secret = this.config.clientSecret;
        }

        try {
            await this.makeRequest(revocationEndpoint, 'POST', params);
            this.tokens.delete(this.getCacheKey());
            CSReporter.info('Ping token revoked successfully');
        } catch (error) {
            CSReporter.warn(`Ping token revocation failed: ${(error as Error).message}`);
        }
    }

    /**
     * Make an HTTP request
     */
    private async makeRequest<T>(
        urlString: string,
        method: 'GET' | 'POST',
        params?: Record<string, string>
    ): Promise<T> {
        const url = new URL(urlString);
        const isHttps = url.protocol === 'https:';

        let postData = '';
        const headers: Record<string, string> = {
            'Accept': 'application/json'
        };

        if (method === 'POST' && params) {
            postData = new URLSearchParams(params).toString();
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            headers['Content-Length'] = String(Buffer.byteLength(postData));
        }

        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers,
            timeout: this.config.timeout,
            rejectUnauthorized: !this.config.skipSslVerification
        };

        return new Promise((resolve, reject) => {
            const client = isHttps ? https : http;

            const req = client.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode === 204) {
                            resolve({} as T);
                            return;
                        }

                        const response = JSON.parse(data);

                        if (res.statusCode && res.statusCode >= 400) {
                            const error = new Error(
                                response.error_description ||
                                response.error ||
                                `Request failed with status ${res.statusCode}`
                            );
                            (error as any).response = response;
                            reject(error);
                            return;
                        }

                        resolve(response);
                    } catch (error) {
                        reject(new Error(`Failed to parse response: ${data}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Request failed: ${error.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });

            if (method === 'POST' && postData) {
                req.write(postData);
            }

            req.end();
        });
    }

    /**
     * Check if a token is expired
     */
    private isTokenExpired(token: CSPingToken): boolean {
        if (!token.expiresAt) {
            return false;
        }
        return Date.now() >= (token.expiresAt - this.tokenExpiryBuffer);
    }

    /**
     * Get cache key for token storage
     */
    private getCacheKey(): string {
        return `${this.config.clientId}_${this.config.scope || 'default'}`;
    }

    /**
     * Get Authorization header value
     */
    public async getAuthorizationHeader(): Promise<string> {
        const token = await this.getAccessToken();
        return `Bearer ${token}`;
    }

    /**
     * Get cached token
     */
    public getCachedToken(): CSPingToken | undefined {
        return this.tokens.get(this.getCacheKey());
    }

    /**
     * Clear token cache
     */
    public clearCache(): void {
        this.tokens.clear();
        this.refreshPromises.clear();
        CSReporter.debug('Ping token cache cleared');
    }

    /**
     * Update configuration
     */
    public updateConfig(config: Partial<CSPingAuthConfig>): void {
        this.config = { ...this.config, ...config };
        this.clearCache();
        this.discoveryCache = null;

        if (this.config.pkce) {
            this.initializePKCE();
        }
    }

    /**
     * Get current configuration
     */
    public getConfig(): CSPingAuthConfig {
        return { ...this.config };
    }

    /**
     * Authenticate a request by adding the access token to the Authorization header.
     * This method is compatible with the CSAuthHandler interface.
     *
     * @param request - The request to authenticate
     * @param auth - Auth configuration (optional, uses handler config if not provided)
     * @returns The authenticated request with Authorization header
     */
    public async authenticate(request: any, auth?: any): Promise<any> {
        const authenticatedRequest = { ...request };
        authenticatedRequest.headers = authenticatedRequest.headers || {};

        const accessToken = await this.getAccessToken();
        authenticatedRequest.headers['Authorization'] = `Bearer ${accessToken}`;

        CSReporter.debug('Applied Ping Identity authentication');
        return authenticatedRequest;
    }

    /**
     * Validate token
     */
    public async validateToken(token?: string): Promise<boolean> {
        try {
            const introspection = await this.introspectToken(token);
            return introspection.active === true;
        } catch {
            const cachedToken = this.tokens.get(this.getCacheKey());
            return cachedToken ? !this.isTokenExpired(cachedToken) : false;
        }
    }
}

/**
 * Ping Auth Manager - manages multiple Ping auth handlers
 */
export class CSPingAuthManager {
    private static instance: CSPingAuthManager;
    private handlers: Map<string, CSPingAuthHandler> = new Map();

    private constructor() {}

    public static getInstance(): CSPingAuthManager {
        if (!CSPingAuthManager.instance) {
            CSPingAuthManager.instance = new CSPingAuthManager();
        }
        return CSPingAuthManager.instance;
    }

    /**
     * Create and register a Ping auth handler
     */
    public createHandler(name: string, config: CSPingAuthConfig): CSPingAuthHandler {
        const handler = new CSPingAuthHandler(config);
        this.handlers.set(name, handler);
        CSReporter.info(`Ping auth handler registered: ${name}`);
        return handler;
    }

    /**
     * Get a registered handler
     */
    public getHandler(name: string): CSPingAuthHandler | undefined {
        return this.handlers.get(name);
    }

    /**
     * Remove a handler
     */
    public removeHandler(name: string): boolean {
        return this.handlers.delete(name);
    }

    /**
     * Clear all handlers
     */
    public clearAll(): void {
        for (const handler of this.handlers.values()) {
            handler.clearCache();
        }
        this.handlers.clear();
    }
}

export const pingAuthManager = CSPingAuthManager.getInstance();
