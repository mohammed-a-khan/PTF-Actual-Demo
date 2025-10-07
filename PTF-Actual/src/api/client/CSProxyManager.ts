import * as url from 'url';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import { CSProxyConfig } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSProxyRule {
    pattern: string | RegExp;
    proxy?: CSProxyConfig;
    direct?: boolean;
}

export interface CSProxyAuth {
    username: string;
    password: string;
    type?: 'basic' | 'digest' | 'ntlm';
}

export interface CSAdvancedProxyConfig extends CSProxyConfig {
    auth?: CSProxyAuth;
    tunnel?: boolean;
    rejectUnauthorized?: boolean;
    timeout?: number;
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    maxSockets?: number;
    maxFreeSockets?: number;
    localAddress?: string;
    family?: 4 | 6;
    autoDetect?: boolean;
    pac?: string; // Proxy Auto-Config URL
    bypass?: string[]; // List of hosts to bypass proxy
    rules?: CSProxyRule[]; // Custom proxy rules
}

export class CSProxyManager {
    private static instance: CSProxyManager;
    private proxyConfigs: Map<string, CSAdvancedProxyConfig>;
    private defaultProxy?: CSAdvancedProxyConfig;
    private bypassList: Set<string>;
    private proxyRules: CSProxyRule[];
    private pacScript?: string;
    private connectionCache: Map<string, any>;

    private constructor() {
        this.proxyConfigs = new Map();
        this.bypassList = new Set();
        this.proxyRules = [];
        this.connectionCache = new Map();
        // Defer initialization until actually needed
        // this.initializeSystemProxy();
    }

    private initialized: boolean = false;

    public static getInstance(): CSProxyManager {
        if (!CSProxyManager.instance) {
            CSProxyManager.instance = new CSProxyManager();
        }
        return CSProxyManager.instance;
    }

    private ensureInitialized(): void {
        if (!this.initialized) {
            this.initializeSystemProxy();
            this.initialized = true;
        }
    }

    private initializeSystemProxy(): void {
        // Check environment variables for proxy settings
        const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
        const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
        const noProxy = process.env.NO_PROXY || process.env.no_proxy;

        if (httpProxy) {
            this.setSystemProxy('http', httpProxy);
        }

        if (httpsProxy) {
            this.setSystemProxy('https', httpsProxy);
        }

        if (noProxy) {
            this.setBypassList(noProxy.split(',').map(h => h.trim()));
        }

        CSReporter.debug('Proxy manager initialized with system settings');
    }

    private setSystemProxy(protocol: string, proxyUrl: string): void {
        try {
            const parsed = new URL(proxyUrl);
            const config: CSAdvancedProxyConfig = {
                protocol: parsed.protocol.replace(':', '') as 'http' | 'https' | 'socks',
                host: parsed.hostname,
                port: parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
            };

            if (parsed.username && parsed.password) {
                config.auth = {
                    username: decodeURIComponent(parsed.username),
                    password: decodeURIComponent(parsed.password),
                    type: 'basic'
                };
            }

            this.proxyConfigs.set(protocol, config);
            CSReporter.debug(`Set ${protocol} proxy from environment: ${parsed.hostname}:${config.port}`);
        } catch (error) {
            CSReporter.warn(`Failed to parse ${protocol} proxy from environment: ${proxyUrl}`);
        }
    }

    public setDefaultProxy(config: CSAdvancedProxyConfig): void {
        this.defaultProxy = config;
        CSReporter.info(`Default proxy set: ${config.host}:${config.port}`);
    }

    public setProxy(name: string, config: CSAdvancedProxyConfig): void {
        this.proxyConfigs.set(name, config);
        CSReporter.debug(`Proxy configuration '${name}' registered`);
    }

    public getProxy(name: string): CSAdvancedProxyConfig | undefined {
        return this.proxyConfigs.get(name);
    }

    public removeProxy(name: string): boolean {
        return this.proxyConfigs.delete(name);
    }

    public setBypassList(hosts: string[]): void {
        this.bypassList.clear();
        hosts.forEach(host => this.bypassList.add(this.normalizeHost(host)));
        CSReporter.debug(`Proxy bypass list updated: ${hosts.join(', ')}`);
    }

    public addBypassHost(host: string): void {
        this.bypassList.add(this.normalizeHost(host));
    }

    public removeBypassHost(host: string): boolean {
        return this.bypassList.delete(this.normalizeHost(host));
    }

    public addProxyRule(rule: CSProxyRule): void {
        this.proxyRules.push(rule);
        CSReporter.debug(`Added proxy rule for pattern: ${rule.pattern}`);
    }

    public clearProxyRules(): void {
        this.proxyRules = [];
    }

    public shouldBypassProxy(targetUrl: string): boolean {
        try {
            const parsed = new URL(targetUrl);
            const hostname = parsed.hostname;

            // Check bypass list
            if (this.bypassList.has(hostname)) {
                return true;
            }

            // Check wildcard patterns in bypass list
            for (const bypass of this.bypassList) {
                if (bypass.startsWith('*.')) {
                    const domain = bypass.substring(2);
                    if (hostname.endsWith(domain)) {
                        return true;
                    }
                } else if (bypass.includes('*')) {
                    const pattern = new RegExp(bypass.replace(/\*/g, '.*'));
                    if (pattern.test(hostname)) {
                        return true;
                    }
                }
            }

            // Check proxy rules
            for (const rule of this.proxyRules) {
                const pattern = typeof rule.pattern === 'string'
                    ? new RegExp(rule.pattern)
                    : rule.pattern;

                if (pattern.test(targetUrl)) {
                    return rule.direct === true;
                }
            }

            // Check for localhost and private IPs
            if (this.isLocalhost(hostname) || this.isPrivateIP(hostname)) {
                return true;
            }

            return false;
        } catch {
            return false;
        }
    }

    public getProxyForUrl(targetUrl: string): CSAdvancedProxyConfig | undefined {
        this.ensureInitialized();
        // Check if proxy should be bypassed
        if (this.shouldBypassProxy(targetUrl)) {
            CSReporter.debug(`Bypassing proxy for: ${targetUrl}`);
            return undefined;
        }

        // Check proxy rules
        for (const rule of this.proxyRules) {
            const pattern = typeof rule.pattern === 'string'
                ? new RegExp(rule.pattern)
                : rule.pattern;

            if (pattern.test(targetUrl)) {
                if (rule.direct) {
                    return undefined;
                }
                if (rule.proxy) {
                    return rule.proxy as CSAdvancedProxyConfig;
                }
            }
        }

        // Check protocol-specific proxy
        try {
            const parsed = new URL(targetUrl);
            const protocol = parsed.protocol.replace(':', '');

            const protocolProxy = this.proxyConfigs.get(protocol);
            if (protocolProxy) {
                return protocolProxy;
            }
        } catch {
            // Invalid URL, fall through to default
        }

        // Return default proxy
        return this.defaultProxy;
    }

    public createProxyAgent(targetUrl: string, options?: http.RequestOptions): http.Agent | https.Agent {
        this.ensureInitialized();
        const proxyConfig = this.getProxyForUrl(targetUrl);

        if (!proxyConfig) {
            // No proxy needed, return standard agent
            const parsed = new URL(targetUrl);
            return parsed.protocol === 'https:'
                ? new https.Agent(options as any)
                : new http.Agent(options as any);
        }

        // Create proxy agent based on proxy type
        return this.createProxyAgentForConfig(proxyConfig, targetUrl, options);
    }

    private createProxyAgentForConfig(
        proxyConfig: CSAdvancedProxyConfig,
        targetUrl: string,
        options?: http.RequestOptions
    ): http.Agent | https.Agent {
        const cacheKey = `${proxyConfig.host}:${proxyConfig.port}:${proxyConfig.protocol}`;

        // Check cache
        if (this.connectionCache.has(cacheKey)) {
            return this.connectionCache.get(cacheKey);
        }

        let agent: http.Agent | https.Agent;

        if (proxyConfig.protocol === 'socks' || proxyConfig.protocol === 'socks5') {
            agent = this.createSocksAgent(proxyConfig, targetUrl, options);
        } else if (proxyConfig.tunnel) {
            agent = this.createTunnelAgent(proxyConfig, targetUrl, options);
        } else {
            agent = this.createHttpProxyAgent(proxyConfig, targetUrl, options);
        }

        // Cache the agent
        this.connectionCache.set(cacheKey, agent);

        return agent;
    }

    private createHttpProxyAgent(
        proxyConfig: CSAdvancedProxyConfig,
        targetUrl: string,
        options?: http.RequestOptions
    ): http.Agent | https.Agent {
        const parsed = new URL(targetUrl);
        const isHttps = parsed.protocol === 'https:';

        const agentOptions: https.AgentOptions = {
            ...options,
            host: proxyConfig.host,
            port: proxyConfig.port,
            path: targetUrl,
            rejectUnauthorized: proxyConfig.rejectUnauthorized !== false,
            keepAlive: proxyConfig.keepAlive,
            keepAliveMsecs: proxyConfig.keepAliveMsecs,
            maxSockets: proxyConfig.maxSockets,
            maxFreeSockets: proxyConfig.maxFreeSockets
        };

        // Add proxy authentication
        if (proxyConfig.auth) {
            const authHeader = this.createAuthHeader(proxyConfig.auth);
            (agentOptions as any).headers = {
                ...(agentOptions as any).headers,
                'Proxy-Authorization': authHeader
            };
        }

        return isHttps
            ? new https.Agent(agentOptions)
            : new http.Agent(agentOptions);
    }

    private createTunnelAgent(
        proxyConfig: CSAdvancedProxyConfig,
        targetUrl: string,
        options?: http.RequestOptions
    ): https.Agent {
        // Implement HTTP CONNECT tunneling for HTTPS through HTTP proxy
        const agent = new https.Agent({
            ...options,
            proxy: {
                host: proxyConfig.host,
                port: proxyConfig.port,
                headers: {}
            }
        } as any);

        // Add proxy authentication
        if (proxyConfig.auth) {
            const authHeader = this.createAuthHeader(proxyConfig.auth);
            (agent as any).proxy.headers['Proxy-Authorization'] = authHeader;
        }

        return agent;
    }

    private createSocksAgent(
        proxyConfig: CSAdvancedProxyConfig,
        targetUrl: string,
        options?: http.RequestOptions
    ): http.Agent | https.Agent {
        // SOCKS proxy implementation
        // In production, you'd use a library like socks-proxy-agent
        CSReporter.warn('SOCKS proxy support requires additional implementation');

        // Fallback to standard agent
        const parsed = new URL(targetUrl);
        return parsed.protocol === 'https:'
            ? new https.Agent(options as any)
            : new http.Agent(options as any);
    }

    private createAuthHeader(auth: CSProxyAuth): string {
        switch (auth.type) {
            case 'basic':
            default:
                const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
                return `Basic ${credentials}`;

            case 'digest':
                // Digest authentication requires challenge-response
                CSReporter.warn('Digest proxy authentication requires challenge-response implementation');
                return '';

            case 'ntlm':
                // NTLM authentication requires multi-step negotiation
                CSReporter.warn('NTLM proxy authentication requires negotiation implementation');
                return '';
        }
    }

    public async loadPacScript(pacUrl: string): Promise<void> {
        try {
            // Fetch PAC script
            const response = await this.fetchPacScript(pacUrl);
            this.pacScript = response;
            CSReporter.info(`PAC script loaded from: ${pacUrl}`);

            // Parse PAC script and update proxy rules
            this.parsePacScript(this.pacScript);
        } catch (error) {
            CSReporter.error(`Failed to load PAC script: ${(error as Error).message}`);
            throw error;
        }
    }

    private async fetchPacScript(pacUrl: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const client = pacUrl.startsWith('https') ? https : http;

            client.get(pacUrl, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    resolve(data);
                });
            }).on('error', reject);
        });
    }

    private parsePacScript(script: string): void {
        // Basic PAC script parsing
        // In production, you'd use a proper PAC script evaluator
        CSReporter.debug('PAC script parsing would be implemented here');
    }

    private normalizeHost(host: string): string {
        return host.toLowerCase().trim();
    }

    private isLocalhost(hostname: string): boolean {
        return hostname === 'localhost' ||
               hostname === '127.0.0.1' ||
               hostname === '::1' ||
               hostname.endsWith('.local');
    }

    private isPrivateIP(hostname: string): boolean {
        // Check if hostname is a private IP address
        const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;

        if (!ipPattern.test(hostname)) {
            return false;
        }

        const parts = hostname.split('.').map(p => parseInt(p));

        // Check private IP ranges
        // 10.0.0.0 - 10.255.255.255
        if (parts[0] === 10) return true;

        // 172.16.0.0 - 172.31.255.255
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

        // 192.168.0.0 - 192.168.255.255
        if (parts[0] === 192 && parts[1] === 168) return true;

        return false;
    }

    public rotateProxy(targetUrl: string): CSAdvancedProxyConfig | undefined {
        // Implement proxy rotation for load balancing
        const availableProxies = Array.from(this.proxyConfigs.values());

        if (availableProxies.length === 0) {
            return undefined;
        }

        // Simple round-robin selection
        const index = Math.floor(Math.random() * availableProxies.length);
        return availableProxies[index];
    }

    public async testProxy(proxyConfig: CSAdvancedProxyConfig, testUrl: string = 'http://www.google.com'): Promise<boolean> {
        return new Promise((resolve) => {
            const options: http.RequestOptions = {
                host: proxyConfig.host,
                port: proxyConfig.port,
                path: testUrl,
                method: 'HEAD',
                timeout: proxyConfig.timeout || 5000
            };

            if (proxyConfig.auth) {
                options.headers = {
                    'Proxy-Authorization': this.createAuthHeader(proxyConfig.auth)
                };
            }

            const req = http.request(options, (res) => {
                resolve(res.statusCode !== undefined && res.statusCode < 500);
            });

            req.on('error', () => {
                resolve(false);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.end();
        });
    }

    public clearCache(): void {
        this.connectionCache.clear();
    }

    public getStats(): any {
        return {
            configuredProxies: this.proxyConfigs.size,
            bypassHosts: this.bypassList.size,
            proxyRules: this.proxyRules.length,
            cachedConnections: this.connectionCache.size,
            hasPacScript: !!this.pacScript,
            hasDefaultProxy: !!this.defaultProxy
        };
    }

    public exportConfiguration(): any {
        return {
            proxies: Array.from(this.proxyConfigs.entries()),
            defaultProxy: this.defaultProxy,
            bypassList: Array.from(this.bypassList),
            rules: this.proxyRules
        };
    }

    public importConfiguration(config: any): void {
        if (config.proxies) {
            this.proxyConfigs.clear();
            config.proxies.forEach(([name, proxy]: [string, CSAdvancedProxyConfig]) => {
                this.proxyConfigs.set(name, proxy);
            });
        }

        if (config.defaultProxy) {
            this.defaultProxy = config.defaultProxy;
        }

        if (config.bypassList) {
            this.bypassList = new Set(config.bypassList);
        }

        if (config.rules) {
            this.proxyRules = config.rules;
        }

        CSReporter.info('Proxy configuration imported');
    }

    public destroy(): void {
        this.proxyConfigs.clear();
        this.bypassList.clear();
        this.proxyRules = [];
        this.connectionCache.clear();
        this.pacScript = undefined;
        this.defaultProxy = undefined;

        CSReporter.info('Proxy manager destroyed');
    }
}

// Remove global instance creation - let consumers call getInstance() when needed
// This was causing 20+ second delay at startup
// export const proxyManager = CSProxyManager.getInstance();