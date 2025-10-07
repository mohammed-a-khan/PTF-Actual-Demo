import { Browser, BrowserContext, Page } from '@playwright/test';
import { CSBrowserManager } from './CSBrowserManager';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

export interface BrowserInstance {
    id: string;
    browser: Browser;
    browserType: string;
    context?: BrowserContext;
    page?: Page;
    inUse: boolean;
    lastUsed: number;
    healthCheckFailed: number;
    restartCount: number;
}

export class CSBrowserPool {
    private static instance: CSBrowserPool;
    private pool: Map<string, BrowserInstance[]> = new Map();
    private config: CSConfigurationManager;
    private maxPoolSize: number;
    private reuseStrategy: string;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.maxPoolSize = this.config.getNumber('BROWSER_POOL_SIZE', 4);
        this.reuseStrategy = this.config.get('BROWSER_POOL_REUSE_STRATEGY', 'round-robin');
    }
    
    public static getInstance(): CSBrowserPool {
        if (!CSBrowserPool.instance) {
            CSBrowserPool.instance = new CSBrowserPool();
        }
        return CSBrowserPool.instance;
    }
    
    public async initialize(): Promise<void> {
        const poolEnabled = this.config.getBoolean('BROWSER_POOL_ENABLED', false);
        
        if (!poolEnabled) {
            CSReporter.debug('Browser pool is disabled');
            return;
        }
        
        CSReporter.info(`Initializing browser pool with size: ${this.maxPoolSize}`);
        
        // Pre-launch browsers if configured
        const preLaunch = this.config.getBoolean('BROWSER_POOL_PRELAUNCH', false);
        if (preLaunch) {
            await this.preLaunchBrowsers();
        }
        
        // Start health check if enabled
        if (this.config.getBoolean('BROWSER_HEALTH_CHECK_ENABLED', true)) {
            this.startHealthCheck();
        }
    }
    
    private async preLaunchBrowsers(): Promise<void> {
        const browserTypes = this.config.getList('BROWSER_LIST');
        
        for (const browserType of browserTypes) {
            const instances: BrowserInstance[] = [];
            
            for (let i = 0; i < Math.ceil(this.maxPoolSize / browserTypes.length); i++) {
                const instance = await this.createBrowserInstance(browserType);
                instances.push(instance);
            }
            
            this.pool.set(browserType, instances);
        }
        
        CSReporter.info('Browser pool pre-launch completed');
    }
    
    private async createBrowserInstance(browserType: string): Promise<BrowserInstance> {
        const manager = CSBrowserManager.getInstance();
        await manager.launch(browserType);
        
        return {
            id: `${browserType}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            browser: manager.getBrowser(),
            browserType,
            inUse: false,
            lastUsed: Date.now(),
            healthCheckFailed: 0,
            restartCount: 0
        };
    }
    
    public async acquire(browserType: string): Promise<BrowserInstance> {
        if (!this.pool.has(browserType)) {
            this.pool.set(browserType, []);
        }
        
        const instances = this.pool.get(browserType)!;
        
        // Find available instance based on strategy
        let instance = this.selectInstance(instances);
        
        if (!instance) {
            // Create new instance if pool not full
            if (instances.length < this.maxPoolSize) {
                instance = await this.createBrowserInstance(browserType);
                instances.push(instance);
            } else {
                // Wait for available instance
                instance = await this.waitForAvailableInstance(browserType);
            }
        }
        
        instance.inUse = true;
        instance.lastUsed = Date.now();
        
        // Create new context and page for the instance
        if (!instance.context) {
            instance.context = await instance.browser.newContext(this.getContextOptions());
        }
        if (!instance.page) {
            instance.page = await instance.context.newPage();
        }
        
        CSReporter.debug(`Acquired browser instance: ${instance.id}`);
        return instance;
    }
    
    private selectInstance(instances: BrowserInstance[]): BrowserInstance | null {
        const available = instances.filter(i => !i.inUse && i.healthCheckFailed < 3);
        
        if (available.length === 0) {
            return null;
        }
        
        switch (this.reuseStrategy) {
            case 'round-robin':
                // Select least recently used
                return available.sort((a, b) => a.lastUsed - b.lastUsed)[0];
                
            case 'lru':
                // Least recently used
                return available.sort((a, b) => a.lastUsed - b.lastUsed)[0];
                
            case 'random':
                // Random selection
                return available[Math.floor(Math.random() * available.length)];
                
            case 'load-balanced':
                // Select instance with least restart count
                return available.sort((a, b) => a.restartCount - b.restartCount)[0];
                
            default:
                return available[0];
        }
    }
    
    private async waitForAvailableInstance(browserType: string, timeout: number = 30000): Promise<BrowserInstance> {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            const instances = this.pool.get(browserType)!;
            const instance = this.selectInstance(instances);
            
            if (instance) {
                return instance;
            }
            
            // Wait and retry
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        throw new Error(`No available browser instance for ${browserType} after ${timeout}ms`);
    }
    
    public async release(instance: BrowserInstance): Promise<void> {
        try {
            // Close page and context but keep browser
            if (instance.page) {
                await instance.page.close();
                instance.page = undefined;
            }
            
            if (instance.context) {
                await instance.context.close();
                instance.context = undefined;
            }
            
            instance.inUse = false;
            instance.lastUsed = Date.now();
            
            CSReporter.debug(`Released browser instance: ${instance.id}`);
            
            // Perform health check if configured
            if (this.config.getBoolean('BROWSER_HEALTH_CHECK_ON_RELEASE', false)) {
                await this.healthCheckInstance(instance);
            }
        } catch (error: any) {
            CSReporter.warn(`Error releasing browser instance: ${error.message}`);
            instance.healthCheckFailed++;
        }
    }
    
    private startHealthCheck(): void {
        const interval = this.config.getNumber('BROWSER_HEALTH_CHECK_INTERVAL', 60000);
        
        this.healthCheckInterval = setInterval(async () => {
            for (const [browserType, instances] of this.pool) {
                for (const instance of instances) {
                    if (!instance.inUse) {
                        await this.healthCheckInstance(instance);
                    }
                }
            }
        }, interval);
        
        CSReporter.debug('Browser health check started');
    }
    
    private async healthCheckInstance(instance: BrowserInstance): Promise<void> {
        try {
            // Check if browser is still connected
            if (!instance.browser.isConnected()) {
                throw new Error('Browser disconnected');
            }
            
            // Try to create a context as health check
            const testContext = await instance.browser.newContext();
            await testContext.close();
            
            // Reset failure count on successful check
            instance.healthCheckFailed = 0;
            
        } catch (error: any) {
            instance.healthCheckFailed++;
            CSReporter.warn(`Health check failed for ${instance.id}: ${error.message}`);
            
            // Restart if too many failures
            if (instance.healthCheckFailed >= 3) {
                await this.restartInstance(instance);
            }
        }
    }
    
    private async restartInstance(instance: BrowserInstance): Promise<void> {
        const maxRestarts = this.config.getNumber('BROWSER_MAX_RESTART_ATTEMPTS', 3);
        
        if (instance.restartCount >= maxRestarts) {
            CSReporter.error(`Maximum restarts reached for ${instance.id}`);
            await this.removeInstance(instance);
            return;
        }
        
        try {
            CSReporter.info(`Restarting browser instance: ${instance.id}`);
            
            // Close old browser
            if (instance.browser.isConnected()) {
                await instance.browser.close();
            }
            
            // Create new browser
            const manager = CSBrowserManager.getInstance();
            await manager.launch(instance.browserType);
            
            instance.browser = manager.getBrowser();
            instance.healthCheckFailed = 0;
            instance.restartCount++;
            
            CSReporter.info(`Browser instance restarted: ${instance.id}`);
            
        } catch (error: any) {
            CSReporter.error(`Failed to restart browser instance: ${error.message}`);
            await this.removeInstance(instance);
        }
    }
    
    private async removeInstance(instance: BrowserInstance): Promise<void> {
        const instances = this.pool.get(instance.browserType);
        
        if (instances) {
            const index = instances.indexOf(instance);
            if (index > -1) {
                instances.splice(index, 1);
                
                // Close browser if still connected
                if (instance.browser.isConnected()) {
                    await instance.browser.close();
                }
                
                CSReporter.info(`Removed browser instance: ${instance.id}`);
            }
        }
    }
    
    private getContextOptions(): any {
        return {
            viewport: {
                width: this.config.getNumber('BROWSER_VIEWPORT_WIDTH', 1920),
                height: this.config.getNumber('BROWSER_VIEWPORT_HEIGHT', 1080)
            },
            ignoreHTTPSErrors: this.config.getBoolean('BROWSER_IGNORE_HTTPS_ERRORS', true),
            locale: this.config.get('BROWSER_LOCALE', 'en-US'),
            timezoneId: this.config.get('BROWSER_TIMEZONE', 'America/New_York')
        };
    }
    
    public async shutdown(): Promise<void> {
        CSReporter.info('Shutting down browser pool');
        
        // Stop health check
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        
        // Close all browsers
        for (const [browserType, instances] of this.pool) {
            for (const instance of instances) {
                try {
                    if (instance.page) {
                        await instance.page.close();
                    }
                    if (instance.context) {
                        await instance.context.close();
                    }
                    if (instance.browser.isConnected()) {
                        await instance.browser.close();
                    }
                } catch (error: any) {
                    CSReporter.warn(`Error closing browser ${instance.id}: ${error.message}`);
                }
            }
        }
        
        this.pool.clear();
        CSReporter.info('Browser pool shutdown complete');
    }
    
    public getPoolStatus(): any {
        const status: any = {
            poolSize: this.maxPoolSize,
            strategy: this.reuseStrategy,
            browsers: {}
        };
        
        for (const [browserType, instances] of this.pool) {
            status.browsers[browserType] = {
                total: instances.length,
                inUse: instances.filter(i => i.inUse).length,
                available: instances.filter(i => !i.inUse).length,
                failed: instances.filter(i => i.healthCheckFailed > 0).length
            };
        }
        
        return status;
    }
}