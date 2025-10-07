// src/database/adapters/RedisAdapter.ts

import { CSDatabaseAdapter } from './DatabaseAdapter';
import {
    DatabaseConfig,
    DatabaseConnection,
    QueryResult,
    PreparedStatement,
    BulkInsertOptions,
    TransactionOptions,
    DatabaseCapabilities,
    ConnectionHealth,
    QueryOptions,
    DatabaseMetadata,
    TableInfo
} from '../types/database.types';
import { CSReporter } from '../../reporter/CSReporter';
import * as redis from 'redis';

export class CSRedisAdapter extends CSDatabaseAdapter {
    readonly type = 'redis';
    readonly capabilities: DatabaseCapabilities = {
        transactions: true,
        preparedStatements: false,
        storedProcedures: false,
        bulkInsert: true,
        streaming: true,
        savepoints: false,
        schemas: false,
        json: true,
        arrays: true
    };

    private client: redis.RedisClientType | null = null;
    private subscriber: redis.RedisClientType | null = null;
    private publisher: redis.RedisClientType | null = null;
    private transactionClient: redis.RedisClientType | null = null;
    private isInTransaction: boolean = false;
    private transactionCommands: Array<() => Promise<any>> = [];
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private connectionId: number = 0;
    protected override config?: DatabaseConfig;
    private lastHealthCheck: Date = new Date();
    private isHealthy: boolean = true;
    private pubsubHandlers: Map<string, (message: string, channel: string) => void> = new Map();
    private streamConsumers: Map<string, any> = new Map();
    private scripts: Map<string, string> = new Map();

    async connect(config: DatabaseConfig): Promise<DatabaseConnection> {
        this.config = config;
        try {
            CSReporter.info(`Connecting to Redis - Host: ${config.host}, Port: ${config.port}`);

            const clientOptions: redis.RedisClientOptions = {
                socket: {
                    host: config.host,
                    port: config.port || 6379,
                    connectTimeout: config.connectionTimeout || 30000,
                    reconnectStrategy: (retries: number) => {
                        if (retries > 10) {
                            return new Error('Max reconnection attempts reached');
                        }
                        return Math.min(retries * 100, 3000);
                    }
                },
                password: config.password,
                database: config.additionalOptions?.['db'] || 0,
                name: 'CS-Test-Automation',
                commandsQueueMaxLength: 100,
                ...this.buildSSLOptions(config)
            };

            if (config.additionalOptions?.['cluster']) {
                const clusterNodes = this.parseClusterNodes(config);
                (clientOptions as any).cluster = {
                    nodes: clusterNodes,
                    redisOptions: {
                        password: config.password,
                        ...this.buildSSLOptions(config)
                    }
                };
            }

            this.client = redis.createClient(clientOptions) as redis.RedisClientType;

            this.setupEventHandlers(this.client, 'main');

            await this.client.connect();

            await this.client.ping();

            if (config.additionalOptions?.['enablePubSub']) {
                await this.setupPubSubClients(clientOptions);
            }

            await this.loadLuaScripts();

            this.startHealthMonitoring();

            CSReporter.info(`Successfully connected to Redis: ${config.host}:${config.port || 6379}`);
            CSReporter.info('Connected to Redis');
            
            return {
                id: `redis-${++this.connectionId}`,
                type: 'redis',
                instance: this.client,
                config,
                connected: true,
                lastActivity: new Date(),
                inTransaction: false,
                transactionLevel: 0,
                savepoints: []
            };

        } catch (error) {
            const enhancedError = this.enhanceError(error as Error, 'connect', config);
            CSReporter.error(`Failed to connect to Redis: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async disconnect(_connection: DatabaseConnection): Promise<void> {
        try {
            CSReporter.info('Disconnecting from Redis');

            if (this.healthCheckInterval) {
                clearInterval(this.healthCheckInterval);
                this.healthCheckInterval = null;
            }

            this.pubsubHandlers.clear();
            this.streamConsumers.clear();

            const disconnectPromises: Promise<void>[] = [];
            
            if (this.subscriber) {
                disconnectPromises.push(this.subscriber.quit().then(() => {}));
            }
            if (this.publisher) {
                disconnectPromises.push(this.publisher.quit().then(() => {}));
            }
            if (this.transactionClient) {
                disconnectPromises.push(this.transactionClient.quit().then(() => {}));
            }
            if (this.client) {
                disconnectPromises.push(this.client.quit().then(() => {}));
            }

            await Promise.all(disconnectPromises);

            this.client = null;
            this.subscriber = null;
            this.publisher = null;
            this.transactionClient = null;

            CSReporter.info('Disconnected from Redis');
            CSReporter.info('Disconnected from Redis');

        } catch (error) {
            const enhancedError = this.enhanceError(error as Error, 'disconnect');
            CSReporter.error(`Failed to disconnect from Redis: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async query(
        _connection: DatabaseConnection,
        query: string, 
        params?: any[], 
        _options?: QueryOptions
    ): Promise<QueryResult> {
        const startTime = Date.now();
        
        try {
            this.validateConnection();
            CSReporter.debug(`Executing Redis query: ${query}`);

            const command = this.parseRedisCommand(query, params);
            let result: any;

            if (this.isInTransaction && !['EXEC', 'DISCARD', 'WATCH', 'UNWATCH'].includes(command.cmd.toUpperCase())) {
                this.transactionCommands.push(async () => {
                    return await this.executeRedisCommand(command);
                });
                result = 'QUEUED';
            } else {
                result = await this.executeRedisCommand(command);
            }

            const duration = Date.now() - startTime;
            const queryResult = this.formatResult(result, command.cmd, duration);
            
            CSReporter.debug(`Redis query completed in ${duration}ms, ${queryResult.rowCount} rows affected`);
            return queryResult;

        } catch (error) {
            const enhancedError = this.enhanceError(error as Error, 'execute', { query, params });
            CSReporter.error(`Query execution failed: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async beginTransaction(_connection: DatabaseConnection, _options?: TransactionOptions): Promise<void> {
        try {
            this.validateConnection();
            CSReporter.info('Beginning Redis transaction');

            if (this.isInTransaction) {
                throw new Error('Transaction already in progress');
            }

            await this.client!.multi();
            this.isInTransaction = true;
            this.transactionCommands = [];

            CSReporter.debug('Redis transaction started (MULTI)');
            CSReporter.info('Redis transaction started');

        } catch (error) {
            const enhancedError = this.enhanceError(error as Error, 'beginTransaction');
            CSReporter.error(`Failed to begin transaction: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async commitTransaction(_connection: DatabaseConnection): Promise<void> {
        try {
            CSReporter.info('Committing Redis transaction');

            if (!this.isInTransaction) {
                throw new Error('No active transaction to commit');
            }

            await Promise.all(
                this.transactionCommands.map(cmd => cmd())
            );

            this.isInTransaction = false;
            this.transactionCommands = [];

            CSReporter.debug('Redis transaction committed (EXEC)');
            CSReporter.info('Redis transaction committed');

        } catch (error) {
            this.isInTransaction = false;
            this.transactionCommands = [];
            
            const enhancedError = this.enhanceError(error as Error, 'commit');
            CSReporter.error(`Failed to commit transaction: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async rollbackTransaction(_connection: DatabaseConnection): Promise<void> {
        try {
            CSReporter.info('Rolling back Redis transaction');

            if (!this.isInTransaction) {
                CSReporter.warn('No active transaction to rollback');
                return;
            }

            this.isInTransaction = false;
            this.transactionCommands = [];

            CSReporter.debug('Redis transaction discarded');
            CSReporter.info('Redis transaction rolled back');

        } catch (error) {
            this.isInTransaction = false;
            this.transactionCommands = [];
            
            const enhancedError = this.enhanceError(error as Error, 'rollback');
            CSReporter.error(`Failed to rollback transaction: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async prepareStatement(query: string): Promise<PreparedStatement> {
        const id = `ps_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const preparedStatement: PreparedStatement = {
            id,
            query,
            paramCount: this.countParameters(query),
            execute: async (params?: any[]) => {
                return await this.query({ id: 'prepared-statement', type: 'redis', instance: this.client } as DatabaseConnection, query, params);
            },
            close: async () => {
                CSReporter.debug(`Closed prepared statement simulation: ${id}`);
            }
        };

        CSReporter.debug(`Created simulated prepared statement for Redis: ${id}`);
        return preparedStatement;
    }

    async executeBulkInsert(
        table: string,
        columns: string[],
        values: any[][],
        options?: BulkInsertOptions
    ): Promise<QueryResult> {
        const startTime = Date.now();
        
        try {
            this.validateConnection();
            CSReporter.info(`Bulk insert operation - Table: ${table}, Count: ${values.length}`);

            const pipeline = this.client!.multi();
            let insertedCount = 0;

            if (table.includes(':hash:')) {
                for (const row of values) {
                    const key = `${table}:${row[0]}`;
                    const hashData: Record<string, any> = {};
                    
                    columns.slice(1).forEach((col, index) => {
                        hashData[col] = row[index + 1];
                    });
                    
                    pipeline.hSet(key, hashData);
                    insertedCount++;
                }
            } else if (table.includes(':set:')) {
                for (const row of values) {
                    const key = `${table}:${row[0]}`;
                    const members = row.slice(1);
                    pipeline.sAdd(key, members);
                    insertedCount++;
                }
            } else if (table.includes(':list:')) {
                for (const row of values) {
                    const key = `${table}:${row[0]}`;
                    const elements = row.slice(1);
                    pipeline.rPush(key, elements);
                    insertedCount++;
                }
            } else if (table.includes(':zset:')) {
                for (const row of values) {
                    const key = `${table}:${row[0]}`;
                    const members: { score: number; value: string }[] = [];
                    
                    for (let i = 1; i < row.length; i += 2) {
                        if (i + 1 < row.length) {
                            members.push({
                                score: parseFloat(row[i]),
                                value: String(row[i + 1])
                            });
                        }
                    }
                    
                    pipeline.zAdd(key, members);
                    insertedCount++;
                }
            } else {
                for (const row of values) {
                    const key = `${table}:${row[0]}`;
                    const value = columns.length > 1 ? 
                        JSON.stringify(Object.fromEntries(
                            columns.slice(1).map((col, idx) => [col, row[idx + 1]])
                        )) : 
                        row[1];
                    
                    if (options?.ttl) {
                        pipeline.setEx(key, options.ttl, value);
                    } else {
                        pipeline.set(key, value);
                    }
                    insertedCount++;
                }
            }

            await pipeline.exec();

            const duration = Date.now() - startTime;
            const queryResult: QueryResult = {
                rows: [],
                rowCount: insertedCount,
                fields: [],
                command: 'INSERT',
                duration
            };

            CSReporter.debug(`Bulk insert to ${table} completed in ${duration}ms, ${insertedCount} rows inserted`);
            return queryResult;

        } catch (error) {
            const enhancedError = this.enhanceError(error as Error, 'bulkInsert', { 
                key: table, 
                count: values.length 
            });
            CSReporter.error(`Bulk insert failed: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async getConnectionHealth(): Promise<ConnectionHealth> {
        try {
            if (!this.client || !this.client.isOpen) {
                return {
                    isHealthy: false,
                    lastCheck: new Date(),
                    latency: -1,
                    error: 'Not connected',
                    details: { status: 'disconnected' }
                };
            }

            const startTime = Date.now();
            
            await this.client.ping();
            const latency = Date.now() - startTime;

            const info = await this.client.info();
            const serverInfo = this.parseRedisInfo(info);

            const clientList = await this.client.clientList();
            const clientListStr = typeof clientList === 'string' ? clientList : '';
            const activeConnections = Array.isArray(clientList) ? clientList.length : clientListStr.split('\n').filter((line: string) => line.trim()).length;

            const memoryInfo = serverInfo.memory || {};
            const usedMemory = parseInt(memoryInfo.used_memory || '0');
            const maxMemory = parseInt(memoryInfo.maxmemory || '0');

            const health: ConnectionHealth = {
                isHealthy: true,
                lastCheck: new Date(),
                latency,
                activeConnections,
                totalConnections: parseInt(serverInfo.stats?.total_connections_received || '0'),
                details: {
                    version: serverInfo.server?.redis_version,
                    mode: serverInfo.server?.redis_mode || 'standalone',
                    role: serverInfo.replication?.role,
                    connectedSlaves: parseInt(serverInfo.replication?.connected_slaves || '0'),
                    usedMemory: `${(usedMemory / 1024 / 1024).toFixed(2)} MB`,
                    maxMemory: maxMemory > 0 ? `${(maxMemory / 1024 / 1024).toFixed(2)} MB` : 'unlimited',
                    memoryUsagePercent: maxMemory > 0 ? ((usedMemory / maxMemory) * 100).toFixed(2) + '%' : 'N/A',
                    uptime: parseInt(serverInfo.server?.uptime_in_seconds || '0'),
                    connectedClients: parseInt(serverInfo.clients?.connected_clients || '0'),
                    blockedClients: parseInt(serverInfo.clients?.blocked_clients || '0'),
                    commandsProcessed: parseInt(serverInfo.stats?.total_commands_processed || '0'),
                    opsPerSecond: parseInt(serverInfo.stats?.instantaneous_ops_per_sec || '0'),
                    hitRate: this.calculateHitRate(serverInfo.stats),
                    evictedKeys: parseInt(serverInfo.stats?.evicted_keys || '0'),
                    expiredKeys: parseInt(serverInfo.stats?.expired_keys || '0')
                }
            };

            this.lastHealthCheck = new Date();
            this.isHealthy = true;
            return health;

        } catch (error) {
            this.isHealthy = false;
            return {
                isHealthy: false,
                lastCheck: new Date(),
                latency: -1,
                error: (error as Error).message,
                details: { error: error }
            };
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            if (!this.client || !this.client.isOpen) {
                return false;
            }

            const result = await this.client.ping();
            return result === 'PONG';

        } catch {
            return false;
        }
    }

    async executeStoredProcedure(
        _connection: DatabaseConnection,
        procedureName: string, 
        params?: any[], 
        _options?: QueryOptions
    ): Promise<QueryResult> {
        const startTime = Date.now();
        
        try {
            this.validateConnection();
            CSReporter.info(`Executing stored procedure: ${procedureName}`);

            let result: any;

            if (this.scripts.has(procedureName)) {
                const script = this.scripts.get(procedureName)!;
                const keys = params?.[0] || [];
                const args = params?.[1] || [];
                
                result = await this.client!.eval(script, {
                    keys,
                    arguments: args.map(String)
                });
            } else {
                result = await this.executeRedisFunction(procedureName, params);
            }

            const duration = Date.now() - startTime;
            const queryResult = this.formatResult(result, 'EVAL', duration);

            CSReporter.debug(`Stored procedure ${procedureName} completed in ${duration}ms, ${queryResult.rowCount} rows affected`);
            return queryResult;

        } catch (error) {
            const enhancedError = this.enhanceError(error as Error, 'executeStoredProcedure', { name: procedureName, params });
            CSReporter.error(`Stored procedure execution failed: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    async executeFunction(
        _connection: DatabaseConnection,
        functionName: string, 
        params?: any[], 
        _options?: QueryOptions
    ): Promise<any> {
        const startTime = Date.now();
        
        try {
            this.validateConnection();
            CSReporter.info(`Executing function: ${functionName}`);

            const result = await this.executeRedisFunction(functionName, params);

            const duration = Date.now() - startTime;
            CSReporter.debug(`Function ${functionName} completed in ${duration}ms`);
            return result;

        } catch (error) {
            const enhancedError = this.enhanceError(error as Error, 'executeFunction', { name: functionName, params });
            CSReporter.error(`Function execution failed: ${enhancedError.message}`);
            throw enhancedError;
        }
    }

    getConnectionInfo(): any {
        if (!this.client) {
            return null;
        }

        return {
            type: this.type,
            isConnected: this.client.isOpen,
            isReady: this.client.isReady,
            options: this.client.options,
            lastHealthCheck: this.lastHealthCheck,
            isHealthy: this.isHealthy,
            pubsubActive: this.subscriber !== null,
            transactionActive: this.isInTransaction
        };
    }


    async publish(channel: string, message: string): Promise<number> {
        this.validateConnection();
        
        if (!this.publisher) {
            throw new Error('Pub/Sub not enabled. Set enablePubSub in connection options.');
        }

        return await this.publisher.publish(channel, message);
    }

    async subscribe(channel: string, handler: (message: string, channel: string) => void): Promise<void> {
        this.validateConnection();
        
        if (!this.subscriber) {
            throw new Error('Pub/Sub not enabled. Set enablePubSub in connection options.');
        }

        this.pubsubHandlers.set(channel, handler);
        await this.subscriber.subscribe(channel, (message, channel) => {
            const handler = this.pubsubHandlers.get(channel);
            if (handler) {
                handler(message, channel);
            }
        });
    }

    async unsubscribe(channel: string): Promise<void> {
        if (!this.subscriber) {
            return;
        }

        this.pubsubHandlers.delete(channel);
        await this.subscriber.unsubscribe(channel);
    }


    private buildSSLOptions(config: DatabaseConfig): any {
        if (!config.ssl) {
            return {};
        }

        const tls: any = {
            rejectUnauthorized: config.sslOptions?.rejectUnauthorized !== false,
            checkServerIdentity: config.sslOptions?.checkServerIdentity !== false
        };

        if (config.sslOptions?.ca) {
            tls.ca = config.sslOptions.ca;
        }
        if (config.sslOptions?.cert) {
            tls.cert = config.sslOptions.cert;
        }
        if (config.sslOptions?.key) {
            tls.key = config.sslOptions.key;
        }

        return { tls };
    }

    private parseClusterNodes(config: DatabaseConfig): Array<{ host: string; port: number }> {
        const nodes: Array<{ host: string; port: number }> = [];
        
        const hostList = config.host.split(',');
        
        for (const hostPort of hostList) {
            const [host, portStr] = hostPort.trim().split(':');
            const port = parseInt(portStr || String(config.port || 6379));
            nodes.push({ host: host || 'localhost', port });
        }

        return nodes;
    }

    private setupEventHandlers(client: redis.RedisClientType, name: string): void {
        client.on('error', (error) => {
            CSReporter.error(`Redis ${name} client error: ` + (error as Error).message);
            this.isHealthy = false;
        });

        client.on('connect', () => {
            CSReporter.info(`Redis ${name} client connected`);
        });

        client.on('ready', () => {
            CSReporter.info(`Redis ${name} client ready`);
            this.isHealthy = true;
        });

        client.on('end', () => {
            CSReporter.info(`Redis ${name} client disconnected`);
            this.isHealthy = false;
        });

        client.on('reconnecting', () => {
            CSReporter.info(`Redis ${name} client reconnecting`);
        });
    }

    private async setupPubSubClients(options: redis.RedisClientOptions): Promise<void> {
        this.subscriber = redis.createClient(options) as redis.RedisClientType;
        this.setupEventHandlers(this.subscriber, 'subscriber');
        await this.subscriber.connect();

        this.publisher = redis.createClient(options) as redis.RedisClientType;
        this.setupEventHandlers(this.publisher, 'publisher');
        await this.publisher.connect();

        CSReporter.info('Redis Pub/Sub clients initialized');
    }

    private async loadLuaScripts(): Promise<void> {
        
        this.scripts.set('incrWithMax', `
            local current = redis.call('get', KEYS[1])
            if not current then current = 0 else current = tonumber(current) end
            local max = tonumber(ARGV[1])
            if current >= max then
                return current
            else
                return redis.call('incr', KEYS[1])
            end
        `);

        this.scripts.set('setIfGreater', `
            local current = redis.call('get', KEYS[1])
            local new = ARGV[1]
            if not current or tonumber(new) > tonumber(current) then
                redis.call('set', KEYS[1], new)
                return 1
            else
                return 0
            end
        `);

        CSReporter.debug('Loaded Redis Lua scripts');
    }

    private startHealthMonitoring(): void {
        this.healthCheckInterval = setInterval(async () => {
            try {
                await this.getConnectionHealth();
            } catch (error) {
                CSReporter.error('Health check failed: ' + (error as Error).message);
                this.isHealthy = false;
            }
        }, 30000);
    }

    protected override validateConnection(): void {
        if (!this.client || !this.client.isOpen) {
            throw new Error('Not connected to Redis');
        }

        if (this.config === undefined) {
            throw new Error('Database configuration not set');
        }

        if (!this.isHealthy) {
            throw new Error('Redis connection is unhealthy');
        }
    }

    private parseRedisCommand(query: string, params?: any[]): any {
        const trimmedQuery = query.trim();
        const parts = trimmedQuery.split(/\s+/);
        if (parts.length === 0 || !parts[0]) {
            throw new Error('Invalid Redis command: empty query');
        }
        const cmd = parts[0].toUpperCase();
        let args = parts.slice(1);

        if (params && params.length > 0) {
            args = args.map(arg => {
                if (arg.startsWith('$')) {
                    const index = parseInt(arg.substring(1)) - 1;
                    return params[index] !== undefined ? String(params[index]) : arg;
                }
                return arg;
            });
        }

        return { cmd, args };
    }

    private async executeRedisCommand(command: any): Promise<any> {
        const { cmd, args } = command;
        const client = this.client!;

        switch (cmd) {
            case 'GET': return await client.get(args[0]);
            case 'SET': return await client.set(args[0], args[1]);
            case 'SETEX': return await client.setEx(args[0], parseInt(args[1]), args[2]);
            case 'SETNX': return await client.setNX(args[0], args[1]);
            case 'MGET': return await client.mGet(args);
            case 'MSET': {
                const obj: Record<string, string> = {};
                for (let i = 0; i < args.length; i += 2) {
                    obj[args[i]] = args[i + 1];
                }
                return await client.mSet(obj);
            }
            case 'INCR': return await client.incr(args[0]);
            case 'DECR': return await client.decr(args[0]);
            case 'INCRBY': return await client.incrBy(args[0], parseInt(args[1]));
            case 'DECRBY': return await client.decrBy(args[0], parseInt(args[1]));
            case 'APPEND': return await client.append(args[0], args[1]);
            case 'STRLEN': return await client.strLen(args[0]);
            case 'GETRANGE': return await client.getRange(args[0], parseInt(args[1]), parseInt(args[2]));
            case 'SETRANGE': return await client.setRange(args[0], parseInt(args[1]), args[2]);
            
            case 'DEL': return await client.del(args);
            case 'EXISTS': return await client.exists(args);
            case 'EXPIRE': return await client.expire(args[0], parseInt(args[1]));
            case 'EXPIREAT': return await client.expireAt(args[0], parseInt(args[1]));
            case 'TTL': return await client.ttl(args[0]);
            case 'PERSIST': return await client.persist(args[0]);
            case 'KEYS': return await client.keys(args[0]);
            case 'SCAN': {
                const cursor = args[0] || '0';
                const options: any = {};
                for (let i = 1; i < args.length; i += 2) {
                    if (args[i] === 'MATCH') options.MATCH = args[i + 1];
                    if (args[i] === 'COUNT') options.COUNT = parseInt(args[i + 1]);
                }
                return await client.scan(cursor as any, options);
            }
            case 'TYPE': return await client.type(args[0]);
            case 'RENAME': return await client.rename(args[0], args[1]);
            case 'RENAMENX': return await client.renameNX(args[0], args[1]);
            
            case 'HGET': return await client.hGet(args[0], args[1]);
            case 'HSET': return await client.hSet(args[0], args[1], args[2]);
            case 'HMGET': return await client.hmGet(args[0], args.slice(1));
            case 'HMSET': {
                const hash: Record<string, string> = {};
                for (let i = 1; i < args.length; i += 2) {
                    hash[args[i]] = args[i + 1];
                }
                return await client.hSet(args[0], hash);
            }
            case 'HGETALL': return await client.hGetAll(args[0]);
            case 'HDEL': return await client.hDel(args[0], args.slice(1));
            case 'HEXISTS': return await client.hExists(args[0], args[1]);
            case 'HKEYS': return await client.hKeys(args[0]);
            case 'HVALS': return await client.hVals(args[0]);
            case 'HLEN': return await client.hLen(args[0]);
            case 'HINCRBY': return await client.hIncrBy(args[0], args[1], parseInt(args[2]));
            case 'HSCAN': {
                const cursor = args[1] || '0';
                const options: any = {};
                for (let i = 2; i < args.length; i += 2) {
                    if (args[i] === 'MATCH') options.MATCH = args[i + 1];
                    if (args[i] === 'COUNT') options.COUNT = parseInt(args[i + 1]);
                }
                return await client.hScan(args[0], cursor as any, options);
            }
            
            case 'LPUSH': return await client.lPush(args[0], args.slice(1));
            case 'RPUSH': return await client.rPush(args[0], args.slice(1));
            case 'LPOP': return await client.lPop(args[0]);
            case 'RPOP': return await client.rPop(args[0]);
            case 'LLEN': return await client.lLen(args[0]);
            case 'LRANGE': return await client.lRange(args[0], parseInt(args[1]), parseInt(args[2]));
            case 'LTRIM': return await client.lTrim(args[0], parseInt(args[1]), parseInt(args[2]));
            case 'LINDEX': return await client.lIndex(args[0], parseInt(args[1]));
            case 'LSET': return await client.lSet(args[0], parseInt(args[1]), args[2]);
            case 'LREM': return await client.lRem(args[0], parseInt(args[1]), args[2]);
            case 'LINSERT': return await client.lInsert(args[0], args[1] as 'BEFORE' | 'AFTER', args[2], args[3]);
            case 'BLPOP': return await client.blPop(args.slice(0, -1), parseInt(args[args.length - 1]));
            case 'BRPOP': return await client.brPop(args.slice(0, -1), parseInt(args[args.length - 1]));
            
            case 'SADD': return await client.sAdd(args[0], args.slice(1));
            case 'SREM': return await client.sRem(args[0], args.slice(1));
            case 'SMEMBERS': return await client.sMembers(args[0]);
            case 'SISMEMBER': return await client.sIsMember(args[0], args[1]);
            case 'SCARD': return await client.sCard(args[0]);
            case 'SPOP': return args[1] ? await client.sPop(args[0], parseInt(args[1])) : await client.sPop(args[0]);
            case 'SRANDMEMBER': return args[1] ? await client.sRandMemberCount(args[0], parseInt(args[1])) : await client.sRandMember(args[0]);
            case 'SMOVE': return await client.sMove(args[0], args[1], args[2]);
            case 'SUNION': return await client.sUnion(args);
            case 'SINTER': return await client.sInter(args);
            case 'SDIFF': return await client.sDiff(args);
            case 'SUNIONSTORE': return await client.sUnionStore(args[0], args.slice(1));
            case 'SINTERSTORE': return await client.sInterStore(args[0], args.slice(1));
            case 'SDIFFSTORE': return await client.sDiffStore(args[0], args.slice(1));
            case 'SSCAN': {
                const cursor = args[1] || '0';
                const options: any = {};
                for (let i = 2; i < args.length; i += 2) {
                    if (args[i] === 'MATCH') options.MATCH = args[i + 1];
                    if (args[i] === 'COUNT') options.COUNT = parseInt(args[i + 1]);
                }
                return await client.sScan(args[0], cursor as any, options);
            }
            
            case 'ZADD': {
                const members: { score: number; value: string }[] = [];
                for (let i = 1; i < args.length; i += 2) {
                    members.push({
                        score: parseFloat(args[i]),
                        value: args[i + 1]
                    });
                }
                return await client.zAdd(args[0], members);
            }
            case 'ZREM': return await client.zRem(args[0], args.slice(1));
            case 'ZRANGE': return await client.zRange(args[0], parseInt(args[1]), parseInt(args[2]));
            case 'ZREVRANGE': return await client.zRange(args[0], parseInt(args[1]), parseInt(args[2]), { REV: true });
            case 'ZRANGEBYSCORE': return await client.zRangeByScore(args[0], args[1], args[2]);
            case 'ZREVRANGEBYSCORE': return await client.zRangeByScore(args[0], args[2], args[1]);
            case 'ZCARD': return await client.zCard(args[0]);
            case 'ZSCORE': return await client.zScore(args[0], args[1]);
            case 'ZRANK': return await client.zRank(args[0], args[1]);
            case 'ZREVRANK': return await client.zRevRank(args[0], args[1]);
            case 'ZINCRBY': return await client.zIncrBy(args[0], parseFloat(args[1]), args[2]);
            case 'ZCOUNT': return await client.zCount(args[0], args[1], args[2]);
            case 'ZREMRANGEBYRANK': return await client.zRemRangeByRank(args[0], parseInt(args[1]), parseInt(args[2]));
            case 'ZREMRANGEBYSCORE': return await client.zRemRangeByScore(args[0], args[1], args[2]);
            
            case 'MULTI': return await client.multi();
            case 'EXEC': return 'OK';
            case 'DISCARD': return 'OK';
            case 'WATCH': return await client.watch(args);
            case 'UNWATCH': return await client.unwatch();
            
            case 'PING': return await client.ping(args[0]);
            case 'ECHO': return await client.echo(args[0]);
            case 'INFO': return await client.info(args[0]);
            case 'DBSIZE': return await client.dbSize();
            case 'FLUSHDB': return await client.flushDb();
            case 'FLUSHALL': return await client.flushAll();
            case 'TIME': return await client.time();
            case 'LASTSAVE': return await client.lastSave();
            case 'CONFIG': {
                if (args[0] === 'GET') {
                    return await client.configGet(args[1]);
                } else if (args[0] === 'SET') {
                    return await client.configSet(args[1], args[2]);
                }
                throw new Error(`Unsupported CONFIG subcommand: ${args[0]}`);
            }
            
            case 'PUBLISH': return await this.publish(args[0], args[1]);
            case 'SUBSCRIBE': throw new Error('Use subscribe() method for SUBSCRIBE');
            case 'UNSUBSCRIBE': throw new Error('Use unsubscribe() method for UNSUBSCRIBE');
            
            case 'XADD': {
                const key = args[0];
                const id = args[1];
                const fields: Record<string, string> = {};
                for (let i = 2; i < args.length; i += 2) {
                    fields[args[i]] = args[i + 1];
                }
                return await client.xAdd(key, id, fields);
            }
            case 'XREAD': {
                const streams: Array<{ key: string; id: string }> = [];
                const streamsIndex = args.indexOf('STREAMS');
                if (streamsIndex > -1) {
                    const keys = args.slice(streamsIndex + 1, streamsIndex + 1 + (args.length - streamsIndex - 1) / 2);
                    const ids = args.slice(streamsIndex + 1 + keys.length);
                    for (let i = 0; i < keys.length; i++) {
                        streams.push({ key: keys[i], id: ids[i] });
                    }
                }
                return await client.xRead(streams);
            }
            case 'XLEN': return await client.xLen(args[0]);
            case 'XRANGE': return await client.xRange(args[0], args[1], args[2]);
            case 'XREVRANGE': return await client.xRevRange(args[0], args[1], args[2]);
            
            case 'GEOADD': {
                const key = args[0];
                const members: Array<{ longitude: number; latitude: number; member: string }> = [];
                for (let i = 1; i < args.length; i += 3) {
                    members.push({
                        longitude: parseFloat(args[i]),
                        latitude: parseFloat(args[i + 1]),
                        member: args[i + 2]
                    });
                }
                return await client.geoAdd(key, members);
            }
            case 'GEODIST': return await client.geoDist(args[0], args[1], args[2], args[3] as any);
            case 'GEOPOS': return await client.geoPos(args[0], args.slice(1));
            case 'GEORADIUS': return await client.geoRadius(args[0], { longitude: parseFloat(args[1]), latitude: parseFloat(args[2]) }, parseFloat(args[3]), args[4] as any);
            
            case 'PFADD': return await client.pfAdd(args[0], args.slice(1));
            case 'PFCOUNT': return await client.pfCount(args);
            case 'PFMERGE': return await client.pfMerge(args[0], args.slice(1));
            
            case 'SETBIT': return await client.setBit(args[0], parseInt(args[1]), parseInt(args[2]) as 0 | 1);
            case 'GETBIT': return await client.getBit(args[0], parseInt(args[1]));
            case 'BITCOUNT': return args.length > 1 ? await client.bitCount(args[0], { start: parseInt(args[1]), end: parseInt(args[2]) }) : await client.bitCount(args[0]);
            case 'BITOP': return await client.bitOp(args[0] as any, args[1], args.slice(2));
            
            default:
                throw new Error(`Unsupported Redis command: ${cmd}`);
        }
    }

    private async executeRedisFunction(name: string, params?: any[]): Promise<any> {
        const functionMap: Record<string, () => Promise<any>> = {
            'dbsize': async () => await this.client!.dbSize(),
            'randomkey': async () => await this.client!.randomKey(),
            'lastsave': async () => await this.client!.lastSave(),
            
            'multiget': async () => {
                const keys = params?.[0] || [];
                return await this.client!.mGet(keys);
            },
            'multiset': async () => {
                const pairs = params?.[0] || {};
                return await this.client!.mSet(pairs);
            },
            
            'deletePattern': async () => {
                const pattern = params?.[0] || '*';
                const keys = await this.client!.keys(pattern);
                if (keys.length > 0) {
                    return await this.client!.del(keys);
                }
                return 0;
            },
            'countPattern': async () => {
                const pattern = params?.[0] || '*';
                const keys = await this.client!.keys(pattern);
                return keys.length;
            },
            
            'setWithTTL': async () => {
                const key = params?.[0];
                const value = params?.[1];
                const ttl = params?.[2] || 3600;
                return await this.client!.setEx(key, ttl, value);
            },
            'getTTL': async () => {
                const key = params?.[0];
                return await this.client!.ttl(key);
            },
            
            'getSet': async () => {
                const key = params?.[0];
                const value = params?.[1];
                return await this.client!.getSet(key, value);
            },
            'incrByFloat': async () => {
                const key = params?.[0];
                const increment = params?.[1] || 1.0;
                return await this.client!.incrByFloat(key, increment);
            },
            
            'jsonSet': async () => {
                const key = params?.[0];
                const path = params?.[1] || '$';
                const value = params?.[2];
                return await this.client!.json.set(key, path, value);
            },
            'jsonGet': async () => {
                const key = params?.[0];
                const path = params?.[1] || '$';
                return await this.client!.json.get(key, { path });
            },
            
            'search': async () => {
                const index = params?.[0];
                const query = params?.[1];
                const options = params?.[2] || {};
                return await this.client!.ft.search(index, query, options);
            },
            
            'tsAdd': async () => {
                const key = params?.[0];
                const timestamp = params?.[1] || '*';
                const value = params?.[2];
                return await this.client!.ts.add(key, timestamp, value);
            },
            'tsRange': async () => {
                const key = params?.[0];
                const fromTimestamp = params?.[1] || '-';
                const toTimestamp = params?.[2] || '+';
                return await this.client!.ts.range(key, fromTimestamp, toTimestamp);
            }
        };

        const func = functionMap[name];
        if (!func) {
            throw new Error(`Unknown Redis function: ${name}`);
        }

        return await func();
    }

    private formatResult(result: any, command: string, duration: number): QueryResult {
        let rows: any[] = [];
        let fields: Array<{ name: string; dataType: string }> = [];
        let rowCount = 0;

        if (result === null || result === undefined) {
            rowCount = 0;
        } else if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
            rows = [{ value: result }];
            fields = [{ name: 'value', dataType: typeof result }];
            rowCount = 1;
        } else if (Array.isArray(result)) {
            rows = result.map((item, index) => ({ [`item_${index}`]: item }));
            fields = result.length > 0 ? 
                [{ name: 'item_0', dataType: typeof result[0] }] : 
                [];
            rowCount = result.length;
        } else if (typeof result === 'object') {
            rows = [result];
            fields = Object.keys(result).map(key => ({
                name: key,
                dataType: typeof result[key]
            }));
            rowCount = 1;
        }

        const commandMap: Record<string, string> = {
            'SET': 'INSERT',
            'GET': 'SELECT',
            'DEL': 'DELETE',
            'HSET': 'INSERT',
            'HGET': 'SELECT',
            'SADD': 'INSERT',
            'SMEMBERS': 'SELECT',
            'ZADD': 'INSERT',
            'ZRANGE': 'SELECT',
            'LPUSH': 'INSERT',
            'LRANGE': 'SELECT'
        };

        return {
            rows,
            rowCount,
            fields,
            command: commandMap[command] || command,
            duration
        };
    }

    private parseRedisInfo(info: string): any {
        const sections: any = {};
        let currentSection = 'server';

        const lines = info.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            
            if (!trimmed || trimmed.startsWith('#')) {
                if (trimmed.startsWith('# ')) {
                    currentSection = trimmed.substring(2).toLowerCase();
                    sections[currentSection] = {};
                }
                continue;
            }

            const [key, value] = trimmed.split(':');
            if (key && value) {
                sections[currentSection][key] = value;
            }
        }

        return sections;
    }

    private calculateHitRate(stats: any): string {
        if (!stats) return 'N/A';
        
        const hits = parseInt(stats.keyspace_hits || '0');
        const misses = parseInt(stats.keyspace_misses || '0');
        const total = hits + misses;
        
        if (total === 0) return 'N/A';
        
        const rate = (hits / total) * 100;
        return `${rate.toFixed(2)}%`;
    }

    private countParameters(query: string): number {
        const matches = query.match(/\$\d+/g);
        return matches ? new Set(matches).size : 0;
    }

    async ping(_connection: DatabaseConnection): Promise<void> {
        await this.client!.ping();
    }

    async getMetadata(_connection: DatabaseConnection): Promise<DatabaseMetadata> {
        const info = await this.client!.info();
        const serverInfo = this.parseRedisInfo(info);
        
        return {
            version: serverInfo.server?.redis_version || 'unknown',
            databaseName: String(this.config?.additionalOptions?.['db'] || 0),
            serverType: 'redis',
            capabilities: this.capabilities,
            characterSet: 'utf-8',
            collation: 'binary',
            timezone: serverInfo.server?.timezone || 'UTC',
            currentUser: this.config?.username || 'default',
            currentSchema: 'none'
        };
    }

    async getTableInfo(_connection: DatabaseConnection, tableName: string): Promise<TableInfo> {
        const keyType = await this.client!.type(tableName);
        const ttl = await this.client!.ttl(tableName);
        
        return {
            name: tableName,
            type: 'table' as const,
            columns: [
                {
                    name: 'value',
                    ordinalPosition: 1,
                    dataType: keyType,
                    nullable: true,
                    isPrimaryKey: false,
                    isUnique: false,
                    isAutoIncrement: false
                }
            ],
            rowCount: 1,
            comment: `Redis ${keyType} key, TTL: ${ttl}`
        };
    }

    async createSavepoint(_connection: DatabaseConnection, _name: string): Promise<void> {
        throw new Error('Redis does not support savepoints');
    }

    async releaseSavepoint(_connection: DatabaseConnection, _name: string): Promise<void> {
        throw new Error('Redis does not support savepoints');
    }

    async rollbackToSavepoint(_connection: DatabaseConnection, _name: string): Promise<void> {
        throw new Error('Redis does not support savepoints');
    }

    async prepare(_connection: DatabaseConnection, query: string): Promise<PreparedStatement> {
        return this.prepareStatement(query);
    }

    async executePrepared(
        statement: PreparedStatement,
        params?: any[]
    ): Promise<QueryResult> {
        return statement.execute(params);
    }

    async bulkInsert(
        _connection: DatabaseConnection,
        table: string,
        data: any[]
    ): Promise<number> {
        if (data.length === 0) return 0;
        const columns = Object.keys(data[0]);
        const values = data.map(row => columns.map(col => row[col]));
        
        const result = await this.executeBulkInsert(table, columns, values);
        return result.rowCount;
    }

    private enhanceError(error: Error, operation: string, context?: any): Error {
        const enhancedError = new Error(`Redis ${operation} failed: ${error.message}`);
        enhancedError.name = 'RedisError';
        
        (enhancedError as any).context = {
            operation,
            ...context
        };

        if (error.message.includes('Connection')) {
            (enhancedError as any).code = 'CONNECTION_ERROR';
            (enhancedError as any).solution = 'Check Redis connection settings and ensure the server is running';
        } else if (error.message.includes('NOAUTH') || error.message.includes('AUTH')) {
            (enhancedError as any).code = 'AUTH_ERROR';
            (enhancedError as any).solution = 'Verify the Redis password in configuration';
        } else if (error.message.includes('timeout')) {
            (enhancedError as any).code = 'TIMEOUT_ERROR';
            (enhancedError as any).solution = 'Increase timeout settings or check network connectivity';
        } else if (error.message.includes('OOM')) {
            (enhancedError as any).code = 'MEMORY_ERROR';
            (enhancedError as any).solution = 'Redis is out of memory. Consider increasing maxmemory or enabling eviction policies';
        } else if (error.message.includes('READONLY')) {
            (enhancedError as any).code = 'READONLY_ERROR';
            (enhancedError as any).solution = 'Connected to a read-only replica. Connect to the master instance for write operations';
        } else if (error.message.includes('CROSSSLOT')) {
            (enhancedError as any).code = 'CLUSTER_ERROR';
            (enhancedError as any).solution = 'Keys in multi-key operation must hash to the same slot. Use hash tags {user:123}';
        }

        return enhancedError;
    }
}
