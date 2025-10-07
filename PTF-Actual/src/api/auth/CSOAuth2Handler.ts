import { CSReporter } from '../../reporter/CSReporter';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface CSOAuth2Config {
    clientId: string;
    clientSecret?: string;
    authorizationUrl: string;
    tokenUrl: string;
    redirectUri?: string;
    scope?: string | string[];
    state?: string;
    responseType?: 'code' | 'token';
    grantType?: 'authorization_code' | 'implicit' | 'password' | 'client_credentials' | 'refresh_token';
    username?: string;
    password?: string;
    refreshToken?: string;
    accessToken?: string;
    tokenType?: string;
    expiresIn?: number;
    additionalParams?: Record<string, any>;
    pkce?: boolean;
    codeVerifier?: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'plain' | 'S256';
}

export interface CSOAuth2Token {
    accessToken: string;
    tokenType: string;
    expiresIn?: number;
    refreshToken?: string;
    scope?: string;
    idToken?: string;
    expiresAt?: number;
    rawResponse?: any;
}

export class CSOAuth2Handler {
    private config: CSOAuth2Config;
    private tokens: Map<string, CSOAuth2Token>;
    private tokenExpiryBuffer: number = 60000; // 1 minute buffer before expiry
    private refreshPromises: Map<string, Promise<CSOAuth2Token>>;

    constructor(config: CSOAuth2Config) {
        this.config = config;
        this.tokens = new Map();
        this.refreshPromises = new Map();

        if (this.config.pkce) {
            this.initializePKCE();
        }
    }

    private initializePKCE(): void {
        if (!this.config.codeVerifier) {
            this.config.codeVerifier = this.generateCodeVerifier();
        }

        if (!this.config.codeChallenge) {
            this.config.codeChallenge = this.generateCodeChallenge(
                this.config.codeVerifier,
                this.config.codeChallengeMethod || 'S256'
            );
        }
    }

    private generateCodeVerifier(): string {
        return crypto.randomBytes(32).toString('base64url');
    }

    private generateCodeChallenge(verifier: string, method: 'plain' | 'S256'): string {
        if (method === 'plain') {
            return verifier;
        }

        return crypto
            .createHash('sha256')
            .update(verifier)
            .digest('base64url');
    }

    public getAuthorizationUrl(additionalParams?: Record<string, any>): string {
        const url = new URL(this.config.authorizationUrl);

        // Add required parameters
        url.searchParams.set('client_id', this.config.clientId);
        url.searchParams.set('response_type', this.config.responseType || 'code');

        // Add optional parameters
        if (this.config.redirectUri) {
            url.searchParams.set('redirect_uri', this.config.redirectUri);
        }

        if (this.config.scope) {
            const scope = Array.isArray(this.config.scope)
                ? this.config.scope.join(' ')
                : this.config.scope;
            url.searchParams.set('scope', scope);
        }

        if (this.config.state) {
            url.searchParams.set('state', this.config.state);
        }

        // PKCE parameters
        if (this.config.pkce && this.config.codeChallenge) {
            url.searchParams.set('code_challenge', this.config.codeChallenge);
            url.searchParams.set('code_challenge_method', this.config.codeChallengeMethod || 'S256');
        }

        // Add any additional parameters
        if (additionalParams) {
            for (const [key, value] of Object.entries(additionalParams)) {
                url.searchParams.set(key, value);
            }
        }

        if (this.config.additionalParams) {
            for (const [key, value] of Object.entries(this.config.additionalParams)) {
                url.searchParams.set(key, value);
            }
        }

        CSReporter.debug(`OAuth2 authorization URL: ${url.toString()}`);
        return url.toString();
    }

    public async exchangeCodeForToken(code: string, state?: string): Promise<CSOAuth2Token> {
        if (state && this.config.state && state !== this.config.state) {
            throw new Error('OAuth2 state mismatch - possible CSRF attack');
        }

        const params: Record<string, any> = {
            grant_type: 'authorization_code',
            code,
            client_id: this.config.clientId
        };

        if (this.config.clientSecret) {
            params.client_secret = this.config.clientSecret;
        }

        if (this.config.redirectUri) {
            params.redirect_uri = this.config.redirectUri;
        }

        // PKCE verification
        if (this.config.pkce && this.config.codeVerifier) {
            params.code_verifier = this.config.codeVerifier;
        }

        return this.requestToken(params);
    }

    public async getAccessToken(forceRefresh: boolean = false): Promise<string> {
        const cacheKey = this.getCacheKey();
        const cachedToken = this.tokens.get(cacheKey);

        // Check if we have a valid token
        if (cachedToken && !forceRefresh && !this.isTokenExpired(cachedToken)) {
            CSReporter.debug('Using cached OAuth2 token');
            return cachedToken.accessToken;
        }

        // Check if refresh is already in progress
        if (this.refreshPromises.has(cacheKey)) {
            CSReporter.debug('Waiting for OAuth2 token refresh in progress');
            const token = await this.refreshPromises.get(cacheKey)!;
            return token.accessToken;
        }

        // Determine how to get the token
        let tokenPromise: Promise<CSOAuth2Token>;

        if (cachedToken?.refreshToken) {
            CSReporter.debug('Refreshing OAuth2 token');
            tokenPromise = this.refreshAccessToken(cachedToken.refreshToken);
        } else {
            CSReporter.debug('Requesting new OAuth2 token');
            tokenPromise = this.requestNewToken();
        }

        // Store the promise to prevent concurrent refreshes
        this.refreshPromises.set(cacheKey, tokenPromise);

        try {
            const token = await tokenPromise;
            this.tokens.set(cacheKey, token);
            return token.accessToken;
        } finally {
            this.refreshPromises.delete(cacheKey);
        }
    }

    private async requestNewToken(): Promise<CSOAuth2Token> {
        const grantType = this.config.grantType || 'client_credentials';
        const params: Record<string, any> = {
            grant_type: grantType,
            client_id: this.config.clientId
        };

        if (this.config.clientSecret) {
            params.client_secret = this.config.clientSecret;
        }

        // Handle different grant types
        switch (grantType) {
            case 'password':
                if (!this.config.username || !this.config.password) {
                    throw new Error('Username and password required for password grant');
                }
                params.username = this.config.username;
                params.password = this.config.password;
                break;

            case 'client_credentials':
                // Client credentials only need client_id and client_secret
                break;

            case 'refresh_token':
                if (!this.config.refreshToken) {
                    throw new Error('Refresh token required for refresh_token grant');
                }
                params.refresh_token = this.config.refreshToken;
                break;

            default:
                throw new Error(`Unsupported grant type: ${grantType}`);
        }

        if (this.config.scope) {
            params.scope = Array.isArray(this.config.scope)
                ? this.config.scope.join(' ')
                : this.config.scope;
        }

        // Add any additional parameters
        if (this.config.additionalParams) {
            Object.assign(params, this.config.additionalParams);
        }

        return this.requestToken(params);
    }

    private async refreshAccessToken(refreshToken: string): Promise<CSOAuth2Token> {
        const params: Record<string, any> = {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.config.clientId
        };

        if (this.config.clientSecret) {
            params.client_secret = this.config.clientSecret;
        }

        try {
            const token = await this.requestToken(params);

            // Preserve refresh token if not returned in response
            if (!token.refreshToken && refreshToken) {
                token.refreshToken = refreshToken;
            }

            return token;
        } catch (error) {
            CSReporter.error(`Failed to refresh OAuth2 token: ${(error as Error).message}`);

            // If refresh fails, try to get a new token
            return this.requestNewToken();
        }
    }

    private async requestToken(params: Record<string, any>): Promise<CSOAuth2Token> {
        return new Promise((resolve, reject) => {
            const tokenUrl = new URL(this.config.tokenUrl);
            const isHttps = tokenUrl.protocol === 'https:';

            const postData = new URLSearchParams(params).toString();

            const options: https.RequestOptions = {
                hostname: tokenUrl.hostname,
                port: tokenUrl.port || (isHttps ? 443 : 80),
                path: tokenUrl.pathname + tokenUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'Accept': 'application/json'
                }
            };

            // Add basic auth header if client secret is provided and not in body
            if (this.config.clientSecret && !params.client_secret) {
                const auth = Buffer.from(
                    `${this.config.clientId}:${this.config.clientSecret}`
                ).toString('base64');
                (options.headers as any)['Authorization'] = `Basic ${auth}`;
            }

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
                                `OAuth2 token request failed with status ${res.statusCode}`
                            );
                            (error as any).response = response;
                            reject(error);
                            return;
                        }

                        const token: CSOAuth2Token = {
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

                        CSReporter.debug('OAuth2 token obtained successfully');
                        resolve(token);

                    } catch (error) {
                        reject(new Error(`Failed to parse OAuth2 response: ${data}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`OAuth2 request failed: ${error.message}`));
            });

            req.write(postData);
            req.end();
        });
    }

    private isTokenExpired(token: CSOAuth2Token): boolean {
        if (!token.expiresAt) {
            return false; // No expiry information, assume valid
        }

        return Date.now() >= (token.expiresAt - this.tokenExpiryBuffer);
    }

    private getCacheKey(): string {
        return `${this.config.clientId}_${this.config.scope || 'default'}`;
    }

    public async revokeToken(token?: string): Promise<void> {
        const tokenToRevoke = token || (await this.getAccessToken());

        // Not all OAuth2 providers support revocation
        if (!this.config.tokenUrl.includes('revoke')) {
            CSReporter.warn('Token revocation endpoint not configured');
            return;
        }

        const revokeUrl = this.config.tokenUrl.replace(/\/token$/, '/revoke');

        return new Promise((resolve, reject) => {
            const url = new URL(revokeUrl);
            const isHttps = url.protocol === 'https:';

            const postData = new URLSearchParams({
                token: tokenToRevoke,
                token_type_hint: 'access_token',
                client_id: this.config.clientId,
                ...(this.config.clientSecret && { client_secret: this.config.clientSecret })
            }).toString();

            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const client = isHttps ? https : http;

            const req = client.request(options, (res) => {
                if (res.statusCode === 200 || res.statusCode === 204) {
                    // Clear cached token
                    this.tokens.delete(this.getCacheKey());
                    CSReporter.debug('OAuth2 token revoked successfully');
                    resolve();
                } else {
                    CSReporter.warn(`Token revocation returned status ${res.statusCode}`);
                    resolve(); // Don't fail on revocation errors
                }
            });

            req.on('error', (error) => {
                CSReporter.warn(`Token revocation failed: ${error.message}`);
                resolve(); // Don't fail on revocation errors
            });

            req.write(postData);
            req.end();
        });
    }

    public async introspectToken(token?: string): Promise<any> {
        const tokenToIntrospect = token || (await this.getAccessToken());

        // Not all OAuth2 providers support introspection
        const introspectUrl = this.config.tokenUrl.replace(/\/token$/, '/introspect');

        return new Promise((resolve, reject) => {
            const url = new URL(introspectUrl);
            const isHttps = url.protocol === 'https:';

            const postData = new URLSearchParams({
                token: tokenToIntrospect,
                token_type_hint: 'access_token',
                client_id: this.config.clientId,
                ...(this.config.clientSecret && { client_secret: this.config.clientSecret })
            }).toString();

            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'Accept': 'application/json'
                }
            };

            const client = isHttps ? https : http;

            const req = client.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        CSReporter.debug('Token introspection successful');
                        resolve(response);
                    } catch (error) {
                        reject(new Error(`Failed to parse introspection response: ${data}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Token introspection failed: ${error.message}`));
            });

            req.write(postData);
            req.end();
        });
    }

    public getAuthorizationHeader(): string {
        return `Bearer ${this.config.accessToken}`;
    }

    public async getAuthorizationHeaderAsync(): Promise<string> {
        const token = await this.getAccessToken();
        return `Bearer ${token}`;
    }

    public getCachedToken(): CSOAuth2Token | undefined {
        return this.tokens.get(this.getCacheKey());
    }

    public clearCache(): void {
        this.tokens.clear();
        this.refreshPromises.clear();
        CSReporter.debug('OAuth2 token cache cleared');
    }

    public updateConfig(config: Partial<CSOAuth2Config>): void {
        this.config = { ...this.config, ...config };
        this.clearCache(); // Clear cache when config changes
    }

    public getConfig(): CSOAuth2Config {
        return { ...this.config };
    }

    public setTokenExpiryBuffer(milliseconds: number): void {
        this.tokenExpiryBuffer = milliseconds;
    }

    public async validateToken(token?: string): Promise<boolean> {
        try {
            const introspection = await this.introspectToken(token);
            return introspection.active === true;
        } catch {
            // If introspection is not supported, check expiry
            const cachedToken = this.tokens.get(this.getCacheKey());
            return cachedToken ? !this.isTokenExpired(cachedToken) : false;
        }
    }
}

export class CSOAuth2Manager {
    private static instance: CSOAuth2Manager;
    private handlers: Map<string, CSOAuth2Handler>;

    private constructor() {
        this.handlers = new Map();
    }

    public static getInstance(): CSOAuth2Manager {
        if (!CSOAuth2Manager.instance) {
            CSOAuth2Manager.instance = new CSOAuth2Manager();
        }
        return CSOAuth2Manager.instance;
    }

    public createHandler(name: string, config: CSOAuth2Config): CSOAuth2Handler {
        const handler = new CSOAuth2Handler(config);
        this.handlers.set(name, handler);
        CSReporter.info(`OAuth2 handler registered: ${name}`);
        return handler;
    }

    public getHandler(name: string): CSOAuth2Handler | undefined {
        return this.handlers.get(name);
    }

    public removeHandler(name: string): boolean {
        return this.handlers.delete(name);
    }

    public clearAll(): void {
        for (const handler of this.handlers.values()) {
            handler.clearCache();
        }
        this.handlers.clear();
    }
}

export const oauth2Manager = CSOAuth2Manager.getInstance();