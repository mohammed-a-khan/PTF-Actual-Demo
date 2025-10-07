// Lazy load Playwright types for performance
// import { Page, BrowserContext } from '@playwright/test';
type Page = any;
type BrowserContext = any;
import { CSPageFactory } from '../core/CSPageFactory';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSFeatureContext } from './CSFeatureContext';
import { CSScenarioContext } from './CSScenarioContext';

export class CSBDDContext {
    private static instance: CSBDDContext;
    
    public page!: any; // Page type from Playwright
    public browserContext!: any; // BrowserContext type from Playwright
    public pageFactory!: CSPageFactory;
    public config: CSConfigurationManager;
    
    // Context data storage
    private featureContext: CSFeatureContext;
    private scenarioContext: CSScenarioContext;
    private worldData: Map<string, any> = new Map();
    
    // Current execution state
    private currentFeature?: string;
    private currentScenario?: string;
    private currentStep?: string;
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.featureContext = CSFeatureContext.getInstance();
        this.scenarioContext = CSScenarioContext.getInstance();
    }
    
    public static getInstance(): CSBDDContext {
        if (!CSBDDContext.instance) {
            CSBDDContext.instance = new CSBDDContext();
        }
        return CSBDDContext.instance;
    }
    
    public async initialize(page: any, browserContext: any): Promise<void> {
        this.page = page;
        this.browserContext = browserContext;

        // Only initialize PageFactory if page is provided (not for API-only tests)
        if (page) {
            this.pageFactory = new CSPageFactory(page);
        }

        CSReporter.debug('BDD Context initialized');
    }
    
    // Feature context methods
    public setCurrentFeature(featureName: string): void {
        this.currentFeature = featureName;
        this.featureContext.setCurrentFeature(featureName);
        CSReporter.info(`Feature: ${featureName}`);
    }
    
    public getCurrentFeature(): string | undefined {
        return this.currentFeature;
    }
    
    // Scenario context methods
    public setCurrentScenario(scenarioName: string): void {
        this.currentScenario = scenarioName;
        this.scenarioContext.setCurrentScenario(scenarioName);
        CSReporter.info(`  Scenario: ${scenarioName}`);
    }
    
    public getCurrentScenario(): string | undefined {
        return this.currentScenario;
    }
    
    // Step context methods
    public setCurrentStep(stepText: string): void {
        this.currentStep = stepText;
        CSReporter.info(`    ${stepText}`);
    }
    
    public getCurrentStep(): string | undefined {
        return this.currentStep;
    }
    
    // World data management
    public set(key: string, value: any): void {
        this.worldData.set(key, value);
        CSReporter.debug(`Set world data: ${key}`);
    }

    public get<T = any>(key: string): T | undefined {
        return this.worldData.get(key);
    }

    // Alias for get() to support CSValueResolver
    public getVariable(key: string): any {
        // Handle special prefixes for clear distinction
        if (key.startsWith('__config_')) {
            // Configuration value requested explicitly
            const configKey = key.substring(9); // Remove '__config_' prefix
            return this.config.get(configKey);
        }

        if (key.startsWith('__env_')) {
            // Environment variable requested explicitly
            const envKey = key.substring(6); // Remove '__env_' prefix
            return process.env[envKey];
        }

        // For regular variables, check contexts only (NOT configuration)
        // This provides clear separation between test variables and config

        // First check world data (highest priority - test-specific variables)
        if (this.worldData.has(key)) {
            return this.worldData.get(key);
        }

        // Then check scenario context
        const scenarioVar = this.scenarioContext.getVariable(key);
        if (scenarioVar !== undefined) {
            return scenarioVar;
        }

        // Check API context if available (for API test variables)
        try {
            const { CSApiContextManager } = require('../api/context/CSApiContextManager');
            const apiContextManager = CSApiContextManager.getInstance();
            const apiContext = apiContextManager.getCurrentContext();
            if (apiContext) {
                const apiVar = apiContext.getVariable(key);
                if (apiVar !== undefined) {
                    return apiVar;
                }
            }
        } catch (e) {
            // API context might not be available in non-API tests
        }

        // Finally check feature context
        const featureVar = this.featureContext.getVariable(key);
        if (featureVar !== undefined) {
            return featureVar;
        }

        // Return undefined if not found in any context
        // NOTE: We do NOT check configuration here to avoid naming conflicts
        return undefined;
    }

    // Set variable (alias for set)
    public setVariable(key: string, value: any): void {
        this.set(key, value);
    }

    public has(key: string): boolean {
        return this.worldData.has(key);
    }

    public delete(key: string): boolean {
        return this.worldData.delete(key);
    }

    public clear(): void {
        this.worldData.clear();
    }
    
    // Page Object access
    public async getPage<T>(pageName: string): Promise<T> {
        if (!this.pageFactory) {
            throw new Error('Page factory not initialized. Browser may not be available for API-only tests.');
        }
        return this.pageFactory.create<T>(pageName);
    }

    public async getCurrentPage<T>(): Promise<T> {
        if (!this.pageFactory) {
            throw new Error('Page factory not initialized. Browser may not be available for API-only tests.');
        }
        // Return the current page factory context
        return this.pageFactory as any;
    }
    
    // Navigation helpers
    public async navigateTo(url: string): Promise<void> {
        if (!this.page) {
            throw new Error('Page not initialized. Browser may not be available for API-only tests.');
        }
        const fullUrl = this.config.get(url) || url;
        await this.page.goto(fullUrl);
        CSReporter.pass(`Navigated to: ${fullUrl}`);
    }

    public async waitForNavigation(): Promise<void> {
        if (!this.page) {
            throw new Error('Page not initialized. Browser may not be available for API-only tests.');
        }
        await this.page.waitForLoadState('networkidle');
    }
    
    // Assertion helpers
    public async assertTitle(expectedTitle: string): Promise<void> {
        const actualTitle = await this.page.title();
        if (actualTitle !== expectedTitle) {
            throw new Error(`Title assertion failed. Expected: ${expectedTitle}, Actual: ${actualTitle}`);
        }
        CSReporter.pass(`Title verified: ${expectedTitle}`);
    }
    
    public async assertUrl(expectedUrl: string): Promise<void> {
        const actualUrl = this.page.url();
        if (!actualUrl.includes(expectedUrl)) {
            throw new Error(`URL assertion failed. Expected to contain: ${expectedUrl}, Actual: ${actualUrl}`);
        }
        CSReporter.pass(`URL verified: ${expectedUrl}`);
    }
    
    public async assertElementVisible(selector: string): Promise<void> {
        const element = await this.page.locator(selector);
        const isVisible = await element.isVisible();
        if (!isVisible) {
            throw new Error(`Element not visible: ${selector}`);
        }
        CSReporter.pass(`Element visible: ${selector}`);
    }
    
    public async assertElementText(selector: string, expectedText: string): Promise<void> {
        const element = await this.page.locator(selector);
        const actualText = await element.textContent();
        if (actualText?.trim() !== expectedText) {
            throw new Error(`Text assertion failed. Expected: ${expectedText}, Actual: ${actualText}`);
        }
        CSReporter.pass(`Text verified: ${expectedText}`);
    }
    
    // Screenshot helpers
    public async takeScreenshot(name?: string): Promise<void> {
        const screenshotName = name || `${this.currentScenario}_${Date.now()}`;
        const path = `screenshots/${screenshotName}.png`;
        await this.page.screenshot({ path, fullPage: true });
        CSReporter.info(`Screenshot saved: ${path}`);
    }
    
    // Data management
    public storeValue(key: string, value: any): void {
        this.scenarioContext.set(key, value);
    }
    
    public retrieveValue<T = any>(key: string): T | undefined {
        return this.scenarioContext.get<T>(key) || this.featureContext.get<T>(key);
    }
    
    // Cleanup methods
    public async cleanupScenario(): Promise<void> {
        this.scenarioContext.clear();
        this.currentStep = undefined;
        CSReporter.debug('Scenario context cleaned up');
    }
    
    public async cleanupFeature(): Promise<void> {
        this.featureContext.clear();
        this.scenarioContext.clear();
        this.worldData.clear();
        this.currentFeature = undefined;
        this.currentScenario = undefined;
        this.currentStep = undefined;
        CSReporter.debug('Feature context cleaned up');
    }
    
    // Utility methods
    public async wait(milliseconds: number): Promise<void> {
        await this.page.waitForTimeout(milliseconds);
    }
    
    public async reload(): Promise<void> {
        await this.page.reload();
        CSReporter.info('Page reloaded');
    }
    
    public async goBack(): Promise<void> {
        await this.page.goBack();
        CSReporter.info('Navigated back');
    }
    
    public async goForward(): Promise<void> {
        await this.page.goForward();
        CSReporter.info('Navigated forward');
    }
    
    // Debug helpers
    public async debug(): Promise<void> {
        console.log('=== BDD Context Debug ===');
        console.log('Current Feature:', this.currentFeature);
        console.log('Current Scenario:', this.currentScenario);
        console.log('Current Step:', this.currentStep);
        console.log('World Data:', Array.from(this.worldData.entries()));
        console.log('Feature Context:', this.featureContext.getAll());
        console.log('Scenario Context:', this.scenarioContext.getAll());
    }
}