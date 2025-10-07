import { Page, Route, Request, Response } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';

export interface MockRule {
    url: string | RegExp;
    method?: string;
    response?: {
        status?: number;
        headers?: Record<string, string>;
        body?: any;
        path?: string;
        delay?: number;
    };
    modify?: (request: Request) => any;
    abort?: boolean;
    errorCode?: string;
}

export interface RecordedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    timestamp: Date;
}

export interface RecordedResponse {
    url: string;
    status: number;
    headers: Record<string, string>;
    body?: Buffer;
    timestamp: Date;
    duration: number;
}

export interface NetworkThrottleProfile {
    downloadSpeed: number; // bytes per second
    uploadSpeed: number;   // bytes per second
    latency: number;       // milliseconds
}

export class CSNetworkInterceptor {
    private static instance: CSNetworkInterceptor;
    private config: CSConfigurationManager;
    private page: Page | null = null;
    private mockRules: MockRule[] = [];
    private recordedRequests: RecordedRequest[] = [];
    private recordedResponses: RecordedResponse[] = [];
    private isRecording: boolean = false;
    private throttleProfile: NetworkThrottleProfile | null = null;
    private blockedUrls: Set<string | RegExp> = new Set();
    private modifiedResponses: Map<string, any> = new Map();
    private requestTimings: Map<string, number> = new Map();
    
    // Predefined network profiles
    private static readonly NETWORK_PROFILES = {
        'offline': { downloadSpeed: 0, uploadSpeed: 0, latency: 0 },
        'slow-2g': { downloadSpeed: 50000, uploadSpeed: 20000, latency: 1800 },
        'fast-2g': { downloadSpeed: 150000, uploadSpeed: 50000, latency: 550 },
        'slow-3g': { downloadSpeed: 400000, uploadSpeed: 100000, latency: 400 },
        'fast-3g': { downloadSpeed: 1500000, uploadSpeed: 750000, latency: 150 },
        'slow-4g': { downloadSpeed: 3000000, uploadSpeed: 1500000, latency: 70 },
        'fast-4g': { downloadSpeed: 10000000, uploadSpeed: 5000000, latency: 20 },
        'wifi': { downloadSpeed: 30000000, uploadSpeed: 15000000, latency: 5 }
    };
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }
    
    public static getInstance(): CSNetworkInterceptor {
        if (!CSNetworkInterceptor.instance) {
            CSNetworkInterceptor.instance = new CSNetworkInterceptor();
        }
        return CSNetworkInterceptor.instance;
    }
    
    public async initialize(page: Page): Promise<void> {
        this.page = page;
        
        // Set up route handler
        await page.route('**/*', async (route, request) => {
            await this.handleRoute(route, request);
        });
        
        CSReporter.debug('Network interceptor initialized');
    }
    
    private async handleRoute(route: Route, request: Request): Promise<void> {
        const url = request.url();
        const method = request.method();
        
        // Record request if recording is enabled
        if (this.isRecording) {
            this.recordRequest(request);
        }
        
        // Check if URL is blocked
        for (const blockedPattern of this.blockedUrls) {
            if (this.matchesPattern(url, blockedPattern)) {
                CSReporter.debug(`Blocked request: ${method} ${url}`);
                await route.abort('blockedbyclient');
                return;
            }
        }
        
        // Apply mock rules
        for (const rule of this.mockRules) {
            if (this.matchesRule(request, rule)) {
                await this.applyMockRule(route, request, rule);
                return;
            }
        }
        
        // Apply throttling if enabled
        if (this.throttleProfile) {
            await this.delay(this.throttleProfile.latency);
        }
        
        // Continue with the request
        const startTime = Date.now();
        this.requestTimings.set(url, startTime);
        
        await route.continue();
    }
    
    private matchesPattern(url: string, pattern: string | RegExp): boolean {
        if (pattern instanceof RegExp) {
            return pattern.test(url);
        }
        return url.includes(pattern);
    }
    
    private matchesRule(request: Request, rule: MockRule): boolean {
        const url = request.url();
        const method = request.method();
        
        // Check URL pattern
        if (!this.matchesPattern(url, rule.url)) {
            return false;
        }
        
        // Check method if specified
        if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) {
            return false;
        }
        
        return true;
    }
    
    private async applyMockRule(route: Route, request: Request, rule: MockRule): Promise<void> {
        const url = request.url();
        const method = request.method();
        
        CSReporter.debug(`Applying mock rule for: ${method} ${url}`);
        
        // Handle abort
        if (rule.abort) {
            await route.abort(rule.errorCode as any || 'blockedbyclient');
            return;
        }
        
        // Handle response modification
        if (rule.modify) {
            const modifiedResponse = await rule.modify(request);
            if (modifiedResponse) {
                await route.fulfill(modifiedResponse);
                return;
            }
        }
        
        // Handle mock response
        if (rule.response) {
            // Apply delay if specified
            if (rule.response.delay) {
                await this.delay(rule.response.delay);
            }
            
            let body: any;
            
            // Load body from file if path is specified
            if (rule.response.path) {
                const filePath = path.isAbsolute(rule.response.path) 
                    ? rule.response.path 
                    : path.join(process.cwd(), 'test', 'mocks', rule.response.path);
                
                if (fs.existsSync(filePath)) {
                    body = fs.readFileSync(filePath);
                } else {
                    CSReporter.warn(`Mock file not found: ${filePath}`);
                    body = '{}';
                }
            } else {
                body = rule.response.body;
            }
            
            // Convert body to appropriate format
            if (typeof body === 'object' && !(body instanceof Buffer)) {
                body = JSON.stringify(body);
            }
            
            await route.fulfill({
                status: rule.response.status || 200,
                headers: rule.response.headers || {},
                body: body
            });
            
            return;
        }
        
        // Continue with the request by default
        await route.continue();
    }
    
    // Mock management methods
    public addMockRule(rule: MockRule): void {
        this.mockRules.push(rule);
        CSReporter.debug(`Added mock rule for: ${rule.url}`);
    }
    
    public removeMockRule(url: string | RegExp, method?: string): void {
        this.mockRules = this.mockRules.filter(rule => {
            if (rule.url !== url) return true;
            if (method && rule.method !== method) return true;
            return false;
        });
    }
    
    public clearMockRules(): void {
        this.mockRules = [];
        CSReporter.debug('Cleared all mock rules');
    }
    
    // URL blocking
    public blockUrl(pattern: string | RegExp): void {
        this.blockedUrls.add(pattern);
        CSReporter.debug(`Blocking URL pattern: ${pattern}`);
    }
    
    public unblockUrl(pattern: string | RegExp): void {
        this.blockedUrls.delete(pattern);
        CSReporter.debug(`Unblocked URL pattern: ${pattern}`);
    }
    
    public blockDomains(domains: string[]): void {
        domains.forEach(domain => {
            this.blockUrl(new RegExp(`^https?://[^/]*${domain.replace('.', '\\.')}.*`));
        });
    }
    
    public blockResourceTypes(types: string[]): void {
        // Common resource types: image, stylesheet, font, script, media
        types.forEach(type => {
            switch (type) {
                case 'image':
                    this.blockUrl(/\.(png|jpg|jpeg|gif|svg|webp|ico)$/i);
                    break;
                case 'stylesheet':
                    this.blockUrl(/\.css$/i);
                    break;
                case 'font':
                    this.blockUrl(/\.(woff|woff2|ttf|otf|eot)$/i);
                    break;
                case 'script':
                    this.blockUrl(/\.js$/i);
                    break;
                case 'media':
                    this.blockUrl(/\.(mp4|webm|mp3|wav|ogg)$/i);
                    break;
            }
        });
    }
    
    // Recording functionality
    public startRecording(): void {
        this.isRecording = true;
        this.recordedRequests = [];
        this.recordedResponses = [];
        CSReporter.info('Started recording network traffic');
    }
    
    public stopRecording(): { requests: RecordedRequest[], responses: RecordedResponse[] } {
        this.isRecording = false;
        CSReporter.info(`Stopped recording: ${this.recordedRequests.length} requests, ${this.recordedResponses.length} responses`);
        
        return {
            requests: [...this.recordedRequests],
            responses: [...this.recordedResponses]
        };
    }
    
    private recordRequest(request: Request): void {
        const recorded: RecordedRequest = {
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
            postData: request.postData() || undefined,
            timestamp: new Date()
        };
        
        this.recordedRequests.push(recorded);
    }
    
    public saveRecording(filePath: string): void {
        const recording = {
            requests: this.recordedRequests,
            responses: this.recordedResponses,
            timestamp: new Date().toISOString()
        };
        
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(filePath, JSON.stringify(recording, null, 2));
        CSReporter.info(`Network recording saved to: ${filePath}`);
    }
    
    public loadRecording(filePath: string): void {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Recording file not found: ${filePath}`);
        }
        
        const recording = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // Create mock rules from recording
        recording.responses.forEach((response: RecordedResponse) => {
            this.addMockRule({
                url: response.url,
                response: {
                    status: response.status,
                    headers: response.headers,
                    body: response.body
                }
            });
        });
        
        CSReporter.info(`Loaded ${recording.responses.length} mock responses from recording`);
    }
    
    // Network throttling
    public async setThrottleProfile(profile: string | NetworkThrottleProfile): Promise<void> {
        if (typeof profile === 'string') {
            const predefined = CSNetworkInterceptor.NETWORK_PROFILES[profile as keyof typeof CSNetworkInterceptor.NETWORK_PROFILES];
            if (!predefined) {
                throw new Error(`Unknown network profile: ${profile}`);
            }
            this.throttleProfile = predefined;
        } else {
            this.throttleProfile = profile;
        }
        
        CSReporter.info(`Network throttling enabled: ${JSON.stringify(this.throttleProfile)}`);
    }
    
    public clearThrottling(): void {
        this.throttleProfile = null;
        CSReporter.info('Network throttling disabled');
    }
    
    // Response modification
    public modifyResponse(url: string | RegExp, modifier: (response: any) => any): void {
        this.addMockRule({
            url,
            modify: async (request) => {
                const response = await request.response();
                if (response) {
                    const body = await response.body();
                    const modified = modifier({
                        status: response.status(),
                        headers: response.headers(),
                        body
                    });
                    return modified;
                }
                return null;
            }
        });
    }
    
    public injectScript(script: string): void {
        this.addMockRule({
            url: /\.html$/,
            modify: async (request) => {
                const response = await request.response();
                if (response) {
                    let body = await response.text();
                    // Inject script before closing body tag
                    body = body.replace('</body>', `<script>${script}</script></body>`);
                    return {
                        status: response.status(),
                        headers: response.headers(),
                        body
                    };
                }
                return null;
            }
        });
    }
    
    public injectCSS(css: string): void {
        this.addMockRule({
            url: /\.html$/,
            modify: async (request) => {
                const response = await request.response();
                if (response) {
                    let body = await response.text();
                    // Inject CSS before closing head tag
                    body = body.replace('</head>', `<style>${css}</style></head>`);
                    return {
                        status: response.status(),
                        headers: response.headers(),
                        body
                    };
                }
                return null;
            }
        });
    }
    
    // HAR file generation
    public async generateHAR(): Promise<any> {
        if (!this.page) {
            throw new Error('Page not initialized');
        }
        
        // This would generate a HAR file from recorded network traffic
        const har = {
            log: {
                version: '1.2',
                creator: {
                    name: 'CS Network Interceptor',
                    version: '1.0.0'
                },
                entries: this.recordedRequests.map((req, index) => ({
                    startedDateTime: req.timestamp.toISOString(),
                    request: {
                        method: req.method,
                        url: req.url,
                        headers: Object.entries(req.headers).map(([name, value]) => ({ name, value })),
                        postData: req.postData ? {
                            mimeType: req.headers['content-type'] || 'application/json',
                            text: req.postData
                        } : undefined
                    },
                    response: this.recordedResponses[index] ? {
                        status: this.recordedResponses[index].status,
                        headers: Object.entries(this.recordedResponses[index].headers).map(([name, value]) => ({ name, value }))
                    } : {}
                }))
            }
        };
        
        return har;
    }
    
    public saveHAR(filePath: string): void {
        const har = this.generateHAR();
        
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(filePath, JSON.stringify(har, null, 2));
        CSReporter.info(`HAR file saved to: ${filePath}`);
    }
    
    // Utility methods
    private async delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    public getRecordedRequests(): RecordedRequest[] {
        return [...this.recordedRequests];
    }
    
    public getRecordedResponses(): RecordedResponse[] {
        return [...this.recordedResponses];
    }
    
    public clearRecordings(): void {
        this.recordedRequests = [];
        this.recordedResponses = [];
    }
    
    public getMockRules(): MockRule[] {
        return [...this.mockRules];
    }
    
    public reset(): void {
        this.clearMockRules();
        this.clearRecordings();
        this.clearThrottling();
        this.blockedUrls.clear();
        this.modifiedResponses.clear();
        this.requestTimings.clear();
        CSReporter.debug('Network interceptor reset');
    }
}