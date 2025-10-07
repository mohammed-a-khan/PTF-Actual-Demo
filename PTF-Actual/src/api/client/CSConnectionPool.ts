import * as http from 'http';
import * as https from 'https';
import { CSRequestOptions, CSConnectionPoolConfig, CSConnectionMetrics } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSConnectionPool {
    private static instance: CSConnectionPool;
    private httpAgents: Map<string, http.Agent>;
    private httpsAgents: Map<string, https.Agent>;
    private connectionMetrics: Map<string, CSConnectionMetrics>;
    private defaultConfig: CSConnectionPoolConfig;
    private cleanupInterval: NodeJS.Timeout | null = null;

    private constructor() {
        this.httpAgents = new Map();
        this.httpsAgents = new Map();
        this.connectionMetrics = new Map();
        this.defaultConfig = {
            maxSockets: 50,
            maxFreeSockets: 10,
            timeout: 60000,
            keepAliveTimeout: 30000,
            maxCachedSessions: 100
        };
        this.startCleanupTimer();
    }

    public static getInstance(): CSConnectionPool {
        if (!CSConnectionPool.instance) {
            CSConnectionPool.instance = new CSConnectionPool();
        }
        return CSConnectionPool.instance;
    }

    public getHttpAgent(options: CSRequestOptions): http.Agent {
        const key = this.getAgentKey(options);

        if (!this.httpAgents.has(key)) {
            const agent = new http.Agent(this.createAgentOptions(options));
            this.httpAgents.set(key, agent);
            this.initializeMetrics(key);
        }

        this.updateMetrics(key, 'request');
        return this.httpAgents.get(key)!;
    }

    public getHttpsAgent(options: CSRequestOptions): https.Agent {
        const key = this.getAgentKey(options);

        if (!this.httpsAgents.has(key)) {
            const agentOptions = {
                ...this.createAgentOptions(options),
                rejectUnauthorized: options.rejectUnauthorized !== false,
                cert: options.cert,
                key: options.key,
                ca: options.ca,
                pfx: options.pfx,
                passphrase: options.passphrase,
                secureProtocol: 'TLSv1_2_method',
                maxCachedSessions: this.defaultConfig.maxCachedSessions
            };

            const agent = new https.Agent(agentOptions);
            this.httpsAgents.set(key, agent);
            this.initializeMetrics(key);
        }

        this.updateMetrics(key, 'request');
        return this.httpsAgents.get(key)!;
    }

    private createAgentOptions(options: CSRequestOptions): http.AgentOptions {
        const config = options.connectionPool || this.defaultConfig;

        return {
            keepAlive: options.keepAlive !== false,
            keepAliveMsecs: config.keepAliveTimeout || 30000,
            maxSockets: config.maxSockets || 50,
            maxFreeSockets: config.maxFreeSockets || 10,
            timeout: config.timeout || 60000,
            scheduling: 'lifo'
        };
    }

    private getAgentKey(options: CSRequestOptions): string {
        const url = new URL(options.url);
        const parts = [
            url.protocol,
            url.hostname,
            url.port || (url.protocol === 'https:' ? '443' : '80')
        ];

        if (options.proxy) {
            parts.push('proxy', options.proxy.host, String(options.proxy.port));
        }

        if (options.cert) parts.push('cert');
        if (options.key) parts.push('key');
        if (options.ca) parts.push('ca');
        if (options.pfx) parts.push('pfx');

        return parts.join(':');
    }

    private initializeMetrics(key: string): void {
        this.connectionMetrics.set(key, {
            activeConnections: 0,
            idleConnections: 0,
            totalRequests: 0,
            totalErrors: 0,
            averageResponseTime: 0
        });
    }

    private updateMetrics(key: string, event: 'request' | 'response' | 'error', responseTime?: number): void {
        const metrics = this.connectionMetrics.get(key);
        if (!metrics) return;

        switch (event) {
            case 'request':
                metrics.totalRequests++;
                metrics.activeConnections++;
                break;
            case 'response':
                metrics.activeConnections--;
                metrics.idleConnections++;
                if (responseTime !== undefined) {
                    const totalTime = metrics.averageResponseTime * (metrics.totalRequests - 1) + responseTime;
                    metrics.averageResponseTime = totalTime / metrics.totalRequests;
                }
                break;
            case 'error':
                metrics.totalErrors++;
                metrics.activeConnections--;
                break;
        }
    }

    public getMetrics(key?: string): CSConnectionMetrics | Map<string, CSConnectionMetrics> {
        if (key) {
            return this.connectionMetrics.get(key) || this.createEmptyMetrics();
        }
        return new Map(this.connectionMetrics);
    }

    private createEmptyMetrics(): CSConnectionMetrics {
        return {
            activeConnections: 0,
            idleConnections: 0,
            totalRequests: 0,
            totalErrors: 0,
            averageResponseTime: 0
        };
    }

    public getAllMetrics(): Record<string, CSConnectionMetrics> {
        const allMetrics: Record<string, CSConnectionMetrics> = {};
        this.connectionMetrics.forEach((metrics, key) => {
            allMetrics[key] = { ...metrics };
        });
        return allMetrics;
    }

    public getTotalConnections(): number {
        let total = 0;
        this.connectionMetrics.forEach(metrics => {
            total += metrics.activeConnections + metrics.idleConnections;
        });
        return total;
    }

    public getActiveConnections(): number {
        let active = 0;
        this.connectionMetrics.forEach(metrics => {
            active += metrics.activeConnections;
        });
        return active;
    }

    public closeIdleConnections(maxIdleTime: number = 30000): number {
        let closed = 0;

        this.httpAgents.forEach((agent, key) => {
            const sockets = (agent as any).sockets;
            const freeSockets = (agent as any).freeSockets;

            Object.values(freeSockets || {}).forEach((socketList: any) => {
                if (!Array.isArray(socketList)) return;
                socketList.forEach((socket: any) => {
                    const idleTime = Date.now() - (socket._idleStart || Date.now());
                    if (idleTime > maxIdleTime) {
                        socket.destroy();
                        closed++;
                    }
                });
            });
        });

        this.httpsAgents.forEach((agent, key) => {
            const sockets = (agent as any).sockets;
            const freeSockets = (agent as any).freeSockets;

            Object.values(freeSockets || {}).forEach((socketList: any) => {
                if (!Array.isArray(socketList)) return;
                socketList.forEach((socket: any) => {
                    const idleTime = Date.now() - (socket._idleStart || Date.now());
                    if (idleTime > maxIdleTime) {
                        socket.destroy();
                        closed++;
                    }
                });
            });
        });

        if (closed > 0) {
            CSReporter.debug(`Closed ${closed} idle connections`);
        }

        return closed;
    }

    public destroyAgent(key: string): void {
        const httpAgent = this.httpAgents.get(key);
        if (httpAgent) {
            httpAgent.destroy();
            this.httpAgents.delete(key);
        }

        const httpsAgent = this.httpsAgents.get(key);
        if (httpsAgent) {
            httpsAgent.destroy();
            this.httpsAgents.delete(key);
        }

        this.connectionMetrics.delete(key);
        CSReporter.debug(`Destroyed agent for key: ${key}`);
    }

    public destroyAllAgents(): void {
        this.httpAgents.forEach(agent => agent.destroy());
        this.httpAgents.clear();

        this.httpsAgents.forEach(agent => agent.destroy());
        this.httpsAgents.clear();

        this.connectionMetrics.clear();
        CSReporter.info('All connection pool agents destroyed');
    }

    public setDefaultConfig(config: Partial<CSConnectionPoolConfig>): void {
        this.defaultConfig = { ...this.defaultConfig, ...config };
        CSReporter.debug(`Connection pool default config updated: ${JSON.stringify(config)}`);
    }

    public getAgentInfo(key: string): any {
        const httpAgent = this.httpAgents.get(key);
        const httpsAgent = this.httpsAgents.get(key);
        const agent = httpAgent || httpsAgent;

        if (!agent) {
            return null;
        }

        return {
            type: httpAgent ? 'http' : 'https',
            sockets: Object.keys((agent as any).sockets || {}).length,
            freeSockets: Object.keys((agent as any).freeSockets || {}).length,
            requests: Object.keys((agent as any).requests || {}).length,
            maxSockets: agent.maxSockets,
            maxFreeSockets: agent.maxFreeSockets,
            keepAlive: (agent as any).keepAlive
        };
    }

    public getAllAgentsInfo(): Record<string, any> {
        const info: Record<string, any> = {};

        this.httpAgents.forEach((agent, key) => {
            info[key] = this.getAgentInfo(key);
        });

        this.httpsAgents.forEach((agent, key) => {
            if (!info[key]) {
                info[key] = this.getAgentInfo(key);
            }
        });

        return info;
    }

    private startCleanupTimer(): void {
        this.cleanupInterval = setInterval(() => {
            this.performCleanup();
        }, 60000);

        process.on('exit', () => {
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
            }
        });
    }

    private performCleanup(): void {
        const maxAge = 300000;
        const now = Date.now();

        this.httpAgents.forEach((agent, key) => {
            const metrics = this.connectionMetrics.get(key);
            if (metrics && metrics.totalRequests === 0 && now - (metrics as any).created > maxAge) {
                this.destroyAgent(key);
            }
        });

        this.httpsAgents.forEach((agent, key) => {
            const metrics = this.connectionMetrics.get(key);
            if (metrics && metrics.totalRequests === 0 && now - (metrics as any).created > maxAge) {
                this.destroyAgent(key);
            }
        });

        this.closeIdleConnections();
    }

    public getConnectionStats(): any {
        const stats = {
            httpAgents: this.httpAgents.size,
            httpsAgents: this.httpsAgents.size,
            totalConnections: this.getTotalConnections(),
            activeConnections: this.getActiveConnections(),
            totalRequests: 0,
            totalErrors: 0,
            averageResponseTime: 0
        };

        let totalResponseTime = 0;
        let requestCount = 0;

        this.connectionMetrics.forEach(metrics => {
            stats.totalRequests += metrics.totalRequests;
            stats.totalErrors += metrics.totalErrors;
            if (metrics.totalRequests > 0) {
                totalResponseTime += metrics.averageResponseTime * metrics.totalRequests;
                requestCount += metrics.totalRequests;
            }
        });

        if (requestCount > 0) {
            stats.averageResponseTime = totalResponseTime / requestCount;
        }

        return stats;
    }

    public resetMetrics(key?: string): void {
        if (key) {
            this.initializeMetrics(key);
        } else {
            this.connectionMetrics.forEach((_, k) => this.initializeMetrics(k));
        }
    }

    public exportMetrics(): string {
        return JSON.stringify(this.getAllMetrics(), null, 2);
    }

    public importMetrics(data: string): void {
        try {
            const metrics = JSON.parse(data);
            Object.entries(metrics).forEach(([key, value]) => {
                this.connectionMetrics.set(key, value as CSConnectionMetrics);
            });
        } catch (error) {
            CSReporter.error(`Failed to import metrics: ${(error as Error).message}`);
        }
    }

    public destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.destroyAllAgents();
        CSReporter.info('Connection pool destroyed');
    }
}