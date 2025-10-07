import { CSReporter } from '../reporter/CSReporter';

export class CSFeatureContext {
    private static instance: CSFeatureContext;
    private data: Map<string, any> = new Map();
    private currentFeature?: string;
    private featureTags: string[] = [];
    private featureStartTime?: number;
    
    private constructor() {}
    
    public static getInstance(): CSFeatureContext {
        if (!CSFeatureContext.instance) {
            CSFeatureContext.instance = new CSFeatureContext();
        }
        return CSFeatureContext.instance;
    }
    
    public setCurrentFeature(featureName: string): void {
        this.currentFeature = featureName;
        this.featureStartTime = Date.now();
        CSReporter.debug(`Feature context set: ${featureName}`);
    }
    
    public getCurrentFeature(): string | undefined {
        return this.currentFeature;
    }
    
    public setFeatureTags(tags: string[]): void {
        this.featureTags = tags;
    }
    
    public getFeatureTags(): string[] {
        return this.featureTags;
    }
    
    public hasTag(tag: string): boolean {
        return this.featureTags.includes(tag);
    }
    
    public set(key: string, value: any): void {
        this.data.set(key, value);
        CSReporter.debug(`Feature context data set: ${key}`);
    }
    
    public get<T = any>(key: string): T | undefined {
        return this.data.get(key);
    }

    // Alias for get() to support CSBDDContext
    public getVariable(key: string): any {
        return this.data.get(key);
    }

    public has(key: string): boolean {
        return this.data.has(key);
    }
    
    public delete(key: string): boolean {
        return this.data.delete(key);
    }
    
    public getAll(): Map<string, any> {
        return new Map(this.data);
    }
    
    public clear(): void {
        this.data.clear();
        this.featureTags = [];
        this.currentFeature = undefined;
        this.featureStartTime = undefined;
        CSReporter.debug('Feature context cleared');
    }
    
    public getExecutionTime(): number {
        if (!this.featureStartTime) return 0;
        return Date.now() - this.featureStartTime;
    }
    
    // Store feature-level test data
    public storeTestData(key: string, data: any): void {
        const testData = this.get<Map<string, any>>('testData') || new Map();
        testData.set(key, data);
        this.set('testData', testData);
    }
    
    public getTestData<T = any>(key: string): T | undefined {
        const testData = this.get<Map<string, any>>('testData');
        return testData?.get(key);
    }
    
    // Store feature-level metrics
    public incrementMetric(metricName: string, value: number = 1): void {
        const metrics = this.get<Map<string, number>>('metrics') || new Map();
        const currentValue = metrics.get(metricName) || 0;
        metrics.set(metricName, currentValue + value);
        this.set('metrics', metrics);
    }
    
    public getMetric(metricName: string): number {
        const metrics = this.get<Map<string, number>>('metrics');
        return metrics?.get(metricName) || 0;
    }
    
    public getAllMetrics(): Map<string, number> {
        return this.get<Map<string, number>>('metrics') || new Map();
    }
    
    // Store feature-level configuration overrides
    public setConfig(key: string, value: string): void {
        const config = this.get<Map<string, string>>('config') || new Map();
        config.set(key, value);
        this.set('config', config);
    }
    
    public getConfig(key: string): string | undefined {
        const config = this.get<Map<string, string>>('config');
        return config?.get(key);
    }
    
    // Debug helper
    public debug(): void {
        console.log('=== Feature Context Debug ===');
        console.log('Current Feature:', this.currentFeature);
        console.log('Feature Tags:', this.featureTags);
        console.log('Execution Time:', this.getExecutionTime(), 'ms');
        console.log('Data:', Array.from(this.data.entries()));
        console.log('Metrics:', Array.from(this.getAllMetrics().entries()));
    }
}