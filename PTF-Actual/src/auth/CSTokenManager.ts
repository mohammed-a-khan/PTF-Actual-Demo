import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSEncryptionUtil } from '../utils/CSEncryptionUtil';
import fs from 'fs/promises';
import path from 'path';

export interface TokenInfo {
    service: string;
    token: string;
    refreshToken?: string;
    expiresAt: number;
    issuedAt: number;
    scopes?: string[];
    tokenType: 'bearer' | 'basic' | 'api_key' | 'oauth2' | 'jwt';
    metadata?: Record<string, any>;
}

export interface TokenConfig {
    service: string;
    authUrl: string;
    clientId?: string;
    clientSecret?: string;
    username?: string;
    password?: string;
    scope?: string;
    grantType?: 'client_credentials' | 'password' | 'refresh_token' | 'authorization_code';
    refreshUrl?: string;
    validateUrl?: string;
    headers?: Record<string, string>;
    refreshBuffer?: number; // seconds before expiry to refresh
    maxRetries?: number;
    retryDelay?: number;
    storageType?: 'memory' | 'file' | 'encrypted';
}

export interface RefreshConfig {
    enabled: boolean;
    bufferTime: number;
    maxRetries: number;
    retryDelay: number;
    backgroundRefresh: boolean;
}

export class CSTokenManager {
    private static instance: CSTokenManager;
    private tokens: Map<string, TokenInfo> = new Map();
    private tokenConfigs: Map<string, TokenConfig> = new Map();
    private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
    private refreshPromises: Map<string, Promise<string>> = new Map();
    private config: CSConfigurationManager;
    private storageDir: string;
    private refreshConfig: RefreshConfig;
    private encryptionUtil: CSEncryptionUtil;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.storageDir = this.config.get('TOKEN_STORAGE_DIR', './tokens');
        this.encryptionUtil = CSEncryptionUtil.getInstance();
        this.refreshConfig = {
            enabled: this.config.getBoolean('TOKEN_AUTO_REFRESH_ENABLED', true),
            bufferTime: this.config.getNumber('TOKEN_REFRESH_BUFFER_TIME', 300), // 5 minutes
            maxRetries: this.config.getNumber('TOKEN_REFRESH_MAX_RETRIES', 3),
            retryDelay: this.config.getNumber('TOKEN_REFRESH_RETRY_DELAY', 5000),
            backgroundRefresh: this.config.getBoolean('TOKEN_BACKGROUND_REFRESH', true)
        };
        
        this.initializeStorage();
        this.loadStoredTokens();
    }

    public static getInstance(): CSTokenManager {
        if (!CSTokenManager.instance) {
            CSTokenManager.instance = new CSTokenManager();
        }
        return CSTokenManager.instance;
    }

    private async initializeStorage(): Promise<void> {
        try {
            await fs.mkdir(this.storageDir, { recursive: true });
            CSReporter.debug(`Token storage initialized: ${this.storageDir}`);
        } catch (error) {
            CSReporter.warn(`Failed to initialize token storage: ${(error as Error).message}`);
        }
    }

    public async registerTokenConfig(config: TokenConfig): Promise<void> {
        this.tokenConfigs.set(config.service, {
            refreshBuffer: 300, // 5 minutes default
            maxRetries: 3,
            retryDelay: 5000,
            storageType: 'encrypted',
            ...config
        });

        CSReporter.info(`Token configuration registered for service: ${config.service}`);
    }

    public async getToken(service: string, forceRefresh: boolean = false): Promise<string> {
        try {
            // Check if refresh is already in progress
            const refreshPromise = this.refreshPromises.get(service);
            if (refreshPromise) {
                CSReporter.debug(`Waiting for token refresh in progress: ${service}`);
                return await refreshPromise;
            }

            const tokenInfo = this.tokens.get(service);
            
            if (!tokenInfo || forceRefresh) {
                return await this.acquireNewToken(service);
            }

            // Check if token is expired or about to expire
            if (this.isTokenExpired(tokenInfo) || this.shouldRefreshToken(tokenInfo)) {
                return await this.refreshToken(service);
            }

            CSReporter.debug(`Using cached token for service: ${service}`);
            return tokenInfo.token;

        } catch (error) {
            CSReporter.fail(`Failed to get token for service: ${service}: ${(error as Error).message}`);
            throw error;
        }
    }

    public async refreshToken(service: string): Promise<string> {
        const tokenInfo = this.tokens.get(service);
        const config = this.tokenConfigs.get(service);

        if (!config) {
            throw new Error(`No configuration found for service: ${service}`);
        }

        // Prevent multiple concurrent refresh attempts
        const existingPromise = this.refreshPromises.get(service);
        if (existingPromise) {
            return existingPromise;
        }

        const refreshPromise = this.performTokenRefresh(service, tokenInfo, config);
        this.refreshPromises.set(service, refreshPromise);

        try {
            const newToken = await refreshPromise;
            this.refreshPromises.delete(service);
            return newToken;
        } catch (error) {
            this.refreshPromises.delete(service);
            throw error;
        }
    }

    private async performTokenRefresh(
        service: string, 
        tokenInfo: TokenInfo | undefined, 
        config: TokenConfig
    ): Promise<string> {
        CSReporter.info(`Refreshing token for service: ${service}`);

        let attempt = 0;
        const maxRetries = config.maxRetries || 3;

        while (attempt < maxRetries) {
            try {
                let newTokenInfo: TokenInfo;

                if (tokenInfo?.refreshToken && config.refreshUrl) {
                    // Use refresh token
                    newTokenInfo = await this.useRefreshToken(service, tokenInfo, config);
                } else {
                    // Get new token
                    newTokenInfo = await this.acquireTokenFromService(service, config);
                }

                // Store the new token
                this.tokens.set(service, newTokenInfo);
                await this.storeToken(newTokenInfo);

                // Schedule next refresh if auto-refresh is enabled
                this.scheduleTokenRefresh(service, newTokenInfo);

                CSReporter.pass(`Token refreshed successfully for service: ${service}`);
                return newTokenInfo.token;

            } catch (error) {
                attempt++;
                CSReporter.warn(`Token refresh attempt ${attempt} failed for service: ${service}: ${(error as Error).message}`);

                if (attempt >= maxRetries) {
                    CSReporter.fail(`Token refresh failed after ${maxRetries} attempts for service: ${service}: ${(error as Error).message}`);
                    throw error;
                }

                // Wait before retrying
                await this.delay(config.retryDelay || 5000);
            }
        }

        throw new Error(`Token refresh failed after ${maxRetries} attempts`);
    }

    private async acquireNewToken(service: string): Promise<string> {
        const config = this.tokenConfigs.get(service);
        if (!config) {
            throw new Error(`No configuration found for service: ${service}`);
        }

        CSReporter.info(`Acquiring new token for service: ${service}`);
        
        const tokenInfo = await this.acquireTokenFromService(service, config);
        this.tokens.set(service, tokenInfo);
        await this.storeToken(tokenInfo);

        // Schedule refresh if auto-refresh is enabled
        this.scheduleTokenRefresh(service, tokenInfo);

        return tokenInfo.token;
    }

    private async acquireTokenFromService(service: string, config: TokenConfig): Promise<TokenInfo> {
        const requestBody = this.buildTokenRequest(config);
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...config.headers
        };

        CSReporter.debug(`Making token request to: ${config.authUrl}`);

        const response = await fetch(config.authUrl, {
            method: 'POST',
            headers,
            body: new URLSearchParams(requestBody).toString()
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Token request failed: ${response.status} ${response.statusText}\n${errorText}`);
        }

        const tokenResponse = await response.json();
        return this.parseTokenResponse(service, tokenResponse, config);
    }

    private async useRefreshToken(service: string, tokenInfo: TokenInfo, config: TokenConfig): Promise<TokenInfo> {
        if (!tokenInfo.refreshToken || !config.refreshUrl) {
            throw new Error(`Refresh token not available for service: ${service}`);
        }

        const requestBody = {
            grant_type: 'refresh_token',
            refresh_token: tokenInfo.refreshToken
        };

        if (config.clientId) (requestBody as any)['client_id'] = config.clientId;
        if (config.clientSecret) (requestBody as any)['client_secret'] = config.clientSecret;

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...config.headers
        };

        const response = await fetch(config.refreshUrl, {
            method: 'POST',
            headers,
            body: new URLSearchParams(requestBody).toString()
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Token refresh failed: ${response.status} ${response.statusText}\n${errorText}`);
        }

        const tokenResponse = await response.json();
        return this.parseTokenResponse(service, tokenResponse, config);
    }

    private buildTokenRequest(config: TokenConfig): Record<string, string> {
        const request: Record<string, string> = {
            grant_type: config.grantType || 'client_credentials'
        };

        if (config.clientId) request.client_id = config.clientId;
        if (config.clientSecret) request.client_secret = config.clientSecret;
        if (config.username) request.username = config.username;
        if (config.password) request.password = config.password;
        if (config.scope) request.scope = config.scope;

        return request;
    }

    private parseTokenResponse(service: string, response: any, config: TokenConfig): TokenInfo {
        const now = Date.now();
        const expiresIn = response.expires_in || 3600; // Default 1 hour
        
        return {
            service,
            token: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt: now + (expiresIn * 1000),
            issuedAt: now,
            scopes: response.scope ? response.scope.split(' ') : config.scope?.split(' '),
            tokenType: response.token_type || 'bearer',
            metadata: {
                ...response,
                config_service: service
            }
        };
    }

    private isTokenExpired(tokenInfo: TokenInfo): boolean {
        const now = Date.now();
        const expired = now >= tokenInfo.expiresAt;
        
        if (expired) {
            CSReporter.debug(`Token expired for service: ${tokenInfo.service} - expiresAt: ${new Date(tokenInfo.expiresAt).toISOString()}, now: ${new Date(now).toISOString()}`);
        }
        
        return expired;
    }

    private shouldRefreshToken(tokenInfo: TokenInfo): boolean {
        const now = Date.now();
        const bufferTime = this.refreshConfig.bufferTime * 1000;
        const shouldRefresh = now >= (tokenInfo.expiresAt - bufferTime);
        
        if (shouldRefresh) {
            CSReporter.debug(`Token should be refreshed for service: ${tokenInfo.service} - expiresAt: ${new Date(tokenInfo.expiresAt).toISOString()}, refreshTime: ${new Date(tokenInfo.expiresAt - bufferTime).toISOString()}`);
        }
        
        return shouldRefresh;
    }

    private scheduleTokenRefresh(service: string, tokenInfo: TokenInfo): void {
        if (!this.refreshConfig.enabled || !this.refreshConfig.backgroundRefresh) {
            return;
        }

        // Clear existing timer
        const existingTimer = this.refreshTimers.get(service);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Calculate refresh time (token expiry minus buffer)
        const bufferTime = this.refreshConfig.bufferTime * 1000;
        const refreshTime = tokenInfo.expiresAt - bufferTime - Date.now();

        if (refreshTime > 0) {
            const timer = setTimeout(async () => {
                try {
                    CSReporter.debug(`Background token refresh triggered for service: ${service}`);
                    await this.refreshToken(service);
                } catch (error) {
                    CSReporter.warn(`Background token refresh failed for service: ${service}: ${(error as Error).message}`);
                }
            }, refreshTime);

            this.refreshTimers.set(service, timer);
            CSReporter.debug(`Token refresh scheduled for service: ${service} - refreshIn: ${Math.round(refreshTime / 1000)}s, refreshAt: ${new Date(Date.now() + refreshTime).toISOString()}`);
        }
    }

    public async validateToken(service: string): Promise<boolean> {
        const tokenInfo = this.tokens.get(service);
        if (!tokenInfo) return false;

        const config = this.tokenConfigs.get(service);
        if (!config?.validateUrl) {
            // If no validation URL, check expiry time
            return !this.isTokenExpired(tokenInfo);
        }

        try {
            const response = await fetch(config.validateUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `${tokenInfo.tokenType} ${tokenInfo.token}`,
                    ...config.headers
                }
            });

            const isValid = response.ok;
            CSReporter.debug(`Token validation for service: ${service} - valid: ${isValid}`);
            return isValid;

        } catch (error) {
            CSReporter.warn(`Token validation failed for service: ${service}: ${(error as Error).message}`);
            return false;
        }
    }

    public async revokeToken(service: string): Promise<void> {
        const tokenInfo = this.tokens.get(service);
        if (!tokenInfo) return;

        // Clear timer
        const timer = this.refreshTimers.get(service);
        if (timer) {
            clearTimeout(timer);
            this.refreshTimers.delete(service);
        }

        // Remove from memory
        this.tokens.delete(service);

        // Remove from storage
        await this.removeStoredToken(service);

        CSReporter.info(`Token revoked for service: ${service}`);
    }

    private async storeToken(tokenInfo: TokenInfo): Promise<void> {
        const config = this.tokenConfigs.get(tokenInfo.service);
        const storageType = config?.storageType || 'encrypted';

        try {
            const filePath = path.join(this.storageDir, `${tokenInfo.service}.token`);
            
            let data: string;
            if (storageType === 'encrypted') {
                data = await this.encryptionUtil.encrypt(JSON.stringify(tokenInfo));
            } else {
                data = JSON.stringify(tokenInfo, null, 2);
            }

            await fs.writeFile(filePath, data, 'utf8');
            CSReporter.debug(`Token stored for service: ${tokenInfo.service} - encrypted: ${storageType === 'encrypted'}`);

        } catch (error) {
            CSReporter.warn(`Failed to store token for service: ${tokenInfo.service}: ${(error as Error).message}`);
        }
    }

    private async loadStoredTokens(): Promise<void> {
        try {
            const files = await fs.readdir(this.storageDir);
            const tokenFiles = files.filter(f => f.endsWith('.token'));

            for (const file of tokenFiles) {
                const service = file.replace('.token', '');
                await this.loadStoredToken(service);
            }

            CSReporter.debug(`Loaded ${tokenFiles.length} stored tokens`);

        } catch (error) {
            CSReporter.debug(`No stored tokens found or failed to load: ${(error as Error).message}`);
        }
    }

    private async loadStoredToken(service: string): Promise<void> {
        try {
            const filePath = path.join(this.storageDir, `${service}.token`);
            const data = await fs.readFile(filePath, 'utf8');

            let tokenInfo: TokenInfo;
            try {
                // Try to decrypt first if data looks encrypted
                if (data.startsWith('ENCRYPTED:') || data.includes('{"encrypted":')) {
                    const decryptedData = await this.encryptionUtil.decrypt(data);
                    if (decryptedData) {
                        tokenInfo = JSON.parse(decryptedData);
                    } else {
                        // Decryption failed, try plain JSON
                        tokenInfo = JSON.parse(data);
                    }
                } else {
                    // Data doesn't look encrypted, try plain JSON first
                    tokenInfo = JSON.parse(data);
                }
            } catch (error: any) {
                // If JSON parsing fails, log the error for debugging but don't crash
                console.error('Token parsing failed:', error.message.substring(0, 100));
                throw new Error('Invalid token format');
            }

            // Validate token is not expired
            if (!this.isTokenExpired(tokenInfo)) {
                this.tokens.set(service, tokenInfo);
                this.scheduleTokenRefresh(service, tokenInfo);
                CSReporter.debug(`Loaded stored token for service: ${service}`);
            } else {
                CSReporter.debug(`Stored token expired for service: ${service}, removing`);
                await this.removeStoredToken(service);
            }

        } catch (error) {
            CSReporter.debug(`Failed to load stored token for service: ${service}: ${(error as Error).message}`);
        }
    }

    private async removeStoredToken(service: string): Promise<void> {
        try {
            const filePath = path.join(this.storageDir, `${service}.token`);
            await fs.unlink(filePath);
            CSReporter.debug(`Removed stored token for service: ${service}`);
        } catch (error) {
            CSReporter.debug(`Failed to remove stored token for service: ${service}: ${(error as Error).message}`);
        }
    }

    public getTokenInfo(service: string): TokenInfo | undefined {
        return this.tokens.get(service);
    }

    public getStoredServices(): string[] {
        return Array.from(this.tokens.keys());
    }

    public async getTokenStats(): Promise<Record<string, any>> {
        const stats = {
            totalTokens: this.tokens.size,
            services: [],
            refreshScheduled: this.refreshTimers.size,
            refreshInProgress: this.refreshPromises.size
        };

        for (const [service, tokenInfo] of this.tokens.entries()) {
            const isValid = await this.validateToken(service);
            const timeToExpiry = tokenInfo.expiresAt - Date.now();
            
            (stats.services as any[]).push({
                service,
                isValid,
                expiresAt: new Date(tokenInfo.expiresAt).toISOString(),
                timeToExpiry: Math.max(0, Math.round(timeToExpiry / 1000)),
                tokenType: tokenInfo.tokenType,
                hasRefreshToken: !!tokenInfo.refreshToken
            });
        }

        return stats;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public async cleanup(): Promise<void> {
        // Clear all timers
        for (const timer of this.refreshTimers.values()) {
            clearTimeout(timer);
        }
        this.refreshTimers.clear();

        // Wait for ongoing refreshes
        if (this.refreshPromises.size > 0) {
            await Promise.allSettled(Array.from(this.refreshPromises.values()));
        }

        CSReporter.info('Token manager cleanup completed');
    }
}