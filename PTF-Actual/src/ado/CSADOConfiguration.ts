/**
 * Azure DevOps Configuration Manager
 * Manages all ADO-related configuration settings
 */

import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

export interface ADOProxyConfig {
    enabled: boolean;
    protocol?: string;
    host?: string;
    port?: number;
    authRequired?: boolean;
    username?: string;
    password?: string;
}

export interface ADOBugTemplate {
    titleTemplate?: string;
    assignedTo?: string;
    areaPath?: string;
    iterationPath?: string;
    priority?: number;
    severity?: string;
    tags?: string[];
}

export interface ADOEndpoints {
    testPlans: string;
    testSuites: string;
    testRuns: string;
    testResults: string;
    testCases: string;
    testPoints: string;
    attachments: string;
    workItems: string;
    builds?: string;
    releases?: string;
}

export class CSADOConfiguration {
    private static instance: CSADOConfiguration;

    // Core configuration
    private enabled: boolean = false;
    private organization: string = '';
    private organizationUrl: string = '';
    private project: string = '';
    private projectId?: string;
    private pat: string = '';
    private apiVersion: string = '7.0';

    // Test configuration
    private testPlanId?: number;
    private testSuiteId?: number;
    private buildId?: string;
    private releaseId?: string;
    private environment?: string;
    private runName?: string;
    private automated: boolean = true;

    // Upload settings
    private uploadAttachments: boolean = true;
    private uploadScreenshots: boolean = true;
    private uploadVideos: boolean = true;
    private uploadLogs: boolean = true;
    private uploadHar: boolean = false;
    private uploadTraces: boolean = false;
    private updateTestCases: boolean = true;
    private createBugsOnFailure: boolean = false;

    // Bug template
    private bugTemplate: ADOBugTemplate = {};

    // API settings
    private timeout: number = 30000;
    private retryCount: number = 3;
    private retryDelay: number = 2000;

    // Proxy configuration
    private proxy?: ADOProxyConfig;

    // Endpoints
    private endpoints?: ADOEndpoints;

    private config: CSConfigurationManager;
    private initialized: boolean = false;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSADOConfiguration {
        if (!CSADOConfiguration.instance) {
            CSADOConfiguration.instance = new CSADOConfiguration();
        }
        return CSADOConfiguration.instance;
    }

    /**
     * Initialize configuration from environment and config files
     */
    public initialize(): void {
        if (this.initialized) {
            return;
        }

        try {
            CSReporter.info('Initializing Azure DevOps configuration...');

            // Check if ADO integration is enabled
            this.enabled = this.config.getBoolean('ADO_INTEGRATION_ENABLED', false);

            if (!this.enabled) {
                CSReporter.info('Azure DevOps integration is disabled');
                this.initialized = true;
                return;
            }

            // Load core configuration
            this.loadCoreConfiguration();

            // Load test configuration
            this.loadTestConfiguration();

            // Load upload settings
            this.loadUploadSettings();

            // Load API settings
            this.loadAPISettings();

            // Load proxy configuration
            this.loadProxyConfiguration();

            // Load bug template
            this.loadBugTemplate();

            // Validate configuration
            this.validateConfiguration();

            // Build endpoints
            this.buildEndpoints();

            CSReporter.info('Azure DevOps configuration initialized successfully');
            this.initialized = true;

        } catch (error) {
            CSReporter.error(`Failed to initialize Azure DevOps configuration: ${error}`);
            this.enabled = false;
            this.initialized = false;
            throw error;
        }
    }

    private loadCoreConfiguration(): void {
        this.organization = this.config.get('ADO_ORGANIZATION', '');

        // Build organization URL
        const orgUrl = this.config.get('ADO_ORGANIZATION_URL', '');
        if (orgUrl) {
            this.organizationUrl = orgUrl.replace(/\/$/, '');
        } else if (this.organization) {
            this.organizationUrl = `https://dev.azure.com/${this.organization}`;
        }

        this.project = this.config.get('ADO_PROJECT', '');
        this.projectId = this.config.get('ADO_PROJECT_ID');

        // Get Personal Access Token (support encrypted tokens)
        let token = this.config.get('ADO_PAT', '');
        if (token.startsWith('ENCRYPTED:')) {
            // Decrypt token if encrypted
            token = token.substring(10); // TODO: Add decryption support
        }
        this.pat = token;

        this.apiVersion = this.config.get('ADO_API_VERSION', '7.0');
    }

    private loadTestConfiguration(): void {
        const planId = this.config.get('ADO_TEST_PLAN_ID');
        if (planId) {
            this.testPlanId = parseInt(planId);
        }

        const suiteId = this.config.get('ADO_TEST_SUITE_ID');
        if (suiteId) {
            this.testSuiteId = parseInt(suiteId);
        }

        this.buildId = this.config.get('ADO_BUILD_ID');
        this.releaseId = this.config.get('ADO_RELEASE_ID');
        this.environment = this.config.get('ADO_ENVIRONMENT');
        // Get run name with date/time interpolation
        let runName = this.config.get('ADO_RUN_NAME', 'PTF Automated Run - {date} {time}');
        const now = new Date();
        runName = runName
            .replace('{date}', now.toLocaleDateString())
            .replace('{time}', now.toLocaleTimeString())
            .replace('{datetime}', now.toISOString())
            .replace('{timestamp}', now.getTime().toString());
        this.runName = runName;

        this.automated = this.config.getBoolean('ADO_AUTOMATED', true);
    }

    private loadUploadSettings(): void {
        this.uploadAttachments = this.config.getBoolean('ADO_UPLOAD_ATTACHMENTS', true);
        this.uploadScreenshots = this.config.getBoolean('ADO_UPLOAD_SCREENSHOTS', true);
        this.uploadVideos = this.config.getBoolean('ADO_UPLOAD_VIDEOS', true);
        this.uploadLogs = this.config.getBoolean('ADO_UPLOAD_LOGS', true);
        this.uploadHar = this.config.getBoolean('ADO_UPLOAD_HAR', false);
        this.uploadTraces = this.config.getBoolean('ADO_UPLOAD_TRACES', false);
        this.updateTestCases = this.config.getBoolean('ADO_UPDATE_TEST_CASES', true);
        this.createBugsOnFailure = this.config.getBoolean('ADO_CREATE_BUGS_ON_FAILURE', false);
    }

    private loadAPISettings(): void {
        this.timeout = this.config.getNumber('ADO_API_TIMEOUT', 30000);
        this.retryCount = this.config.getNumber('ADO_API_RETRY_COUNT', 3);
        this.retryDelay = this.config.getNumber('ADO_API_RETRY_DELAY', 2000);
    }

    private loadProxyConfiguration(): void {
        const proxyEnabled = this.config.getBoolean('ADO_PROXY_ENABLED', false);

        if (proxyEnabled) {
            this.proxy = {
                enabled: true,
                protocol: this.config.get('ADO_PROXY_PROTOCOL', 'http'),
                host: this.config.get('ADO_PROXY_HOST'),
                port: this.config.getNumber('ADO_PROXY_PORT', 8080),
                authRequired: this.config.getBoolean('ADO_PROXY_AUTH_REQUIRED', false),
                username: this.config.get('ADO_PROXY_USERNAME'),
                password: this.config.get('ADO_PROXY_PASSWORD')
            };
        }
    }

    private loadBugTemplate(): void {
        if (this.createBugsOnFailure) {
            this.bugTemplate = {
                titleTemplate: this.config.get('ADO_BUG_TITLE_TEMPLATE', 'Test Failed: {testName}'),
                assignedTo: this.config.get('DEFAULT_BUG_ASSIGNEE'),
                areaPath: this.config.get('ADO_BUG_AREA_PATH', this.project),
                iterationPath: this.config.get('ADO_BUG_ITERATION_PATH', this.project),
                priority: this.config.getNumber('ADO_BUG_PRIORITY', 2),
                severity: this.config.get('ADO_BUG_SEVERITY', '3 - Medium'),
                tags: this.config.get('ADO_BUG_TAGS', 'automation,test-failure').split(',').map(t => t.trim())
            };
        }
    }

    private validateConfiguration(): void {
        if (!this.enabled) {
            return;
        }

        const errors: string[] = [];

        if (!this.organizationUrl) {
            errors.push('Azure DevOps organization URL is required');
        }

        if (!this.project) {
            errors.push('Azure DevOps project name is required');
        }

        if (!this.pat) {
            errors.push('Azure DevOps Personal Access Token (PAT) is required');
        }

        if (this.proxy?.enabled) {
            if (!this.proxy.host) {
                errors.push('Proxy host is required when proxy is enabled');
            }

            if (this.proxy.authRequired && (!this.proxy.username || !this.proxy.password)) {
                errors.push('Proxy username and password are required when proxy auth is enabled');
            }
        }

        if (errors.length > 0) {
            const errorMessage = 'Azure DevOps configuration validation failed:\n' + errors.join('\n');
            CSReporter.error(errorMessage);
            throw new Error(errorMessage);
        }
    }

    private buildEndpoints(): void {
        if (!this.organizationUrl || !this.project) {
            return;
        }

        const baseUrl = `${this.organizationUrl}/${this.project}/_apis`;

        this.endpoints = {
            testPlans: `${baseUrl}/test/plans`,
            testSuites: `${baseUrl}/test/plans/{planId}/suites`,
            testRuns: `${baseUrl}/test/runs`,
            testResults: `${baseUrl}/test/runs/{runId}/results`,
            testCases: `${baseUrl}/wit/workitems`,
            testPoints: `${baseUrl}/test/plans/{planId}/suites/{suiteId}/points`,
            attachments: `${baseUrl}/wit/attachments`,
            workItems: `${baseUrl}/wit/workitems`,
            builds: `${baseUrl}/build/builds`,
            releases: `${baseUrl}/release/releases`
        };
    }

    /**
     * Get authentication headers for ADO API requests
     */
    public getAuthHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        if (this.pat) {
            // PAT authentication - base64 encode ":pat"
            const token = Buffer.from(`:${this.pat}`).toString('base64');
            headers['Authorization'] = `Basic ${token}`;
        }

        return headers;
    }

    /**
     * Build URL with parameters and API version
     */
    public buildUrl(endpoint: string, params?: Record<string, any>): string {
        if (!endpoint) {
            throw new Error('Endpoint cannot be empty');
        }

        let url = endpoint;

        // Replace path parameters
        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
            });
        }

        // Add API version
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}api-version=${this.apiVersion}`;

        return url;
    }

    /**
     * Format bug title with placeholders
     */
    public formatBugTitle(testName: string, errorMessage?: string): string {
        if (!this.bugTemplate.titleTemplate) {
            return `Test Failed: ${testName}`;
        }

        const now = new Date();
        return this.bugTemplate.titleTemplate
            .replace('{testName}', testName)
            .replace('{date}', now.toLocaleDateString())
            .replace('{time}', now.toLocaleTimeString())
            .replace('{error}', errorMessage || 'Unknown error');
    }

    // Getters
    public isEnabled(): boolean { return this.enabled; }
    public getOrganization(): string { return this.organization; }
    public getOrganizationUrl(): string { return this.organizationUrl; }
    public getProject(): string { return this.project; }
    public getProjectId(): string | undefined { return this.projectId; }
    public getPAT(): string { return this.pat; }
    public getApiVersion(): string { return this.apiVersion; }
    public getTestPlanId(): number | undefined { return this.testPlanId; }
    public getTestSuiteId(): number | undefined { return this.testSuiteId; }
    public getBuildId(): string | undefined { return this.buildId; }
    public getReleaseId(): string | undefined { return this.releaseId; }
    public getEnvironment(): string | undefined { return this.environment; }
    public getRunName(): string | undefined { return this.runName; }
    public isAutomated(): boolean { return this.automated; }
    public shouldUploadAttachments(): boolean { return this.uploadAttachments; }
    public shouldUploadScreenshots(): boolean { return this.uploadScreenshots; }
    public shouldUploadVideos(): boolean { return this.uploadVideos; }
    public shouldUploadLogs(): boolean { return this.uploadLogs; }
    public shouldUploadHar(): boolean { return this.uploadHar; }
    public shouldUploadTraces(): boolean { return this.uploadTraces; }
    public shouldUpdateTestCases(): boolean { return this.updateTestCases; }
    public shouldCreateBugsOnFailure(): boolean { return this.createBugsOnFailure; }
    public getBugTemplate(): ADOBugTemplate { return this.bugTemplate; }

    public getTimeout(): number { return this.timeout; }
    public getRetryCount(): number { return this.retryCount; }
    public getRetryDelay(): number { return this.retryDelay; }
    public getProxy(): ADOProxyConfig | undefined { return this.proxy; }
    public getEndpoints(): ADOEndpoints | undefined { return this.endpoints; }

    /**
     * Reset configuration (useful for testing)
     */
    public reset(): void {
        this.initialized = false;
        this.enabled = false;
    }
}