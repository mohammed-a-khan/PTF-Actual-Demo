import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import * as fs from 'fs';
import * as path from 'path';

export interface ADOConfig {
    organization: string;
    project: string;
    pat: string;
    apiVersion?: string;
    proxy?: ProxyConfig;
}

export interface ProxyConfig {
    enabled: boolean;
    protocol: 'http' | 'https' | 'socks5';
    host: string;
    port: number;
    auth?: {
        required: boolean;
        username?: string;
        password?: string;
    };
    bypassList?: string[];
}

export interface TestCase {
    id: number;
    name: string;
    state: string;
    priority: number;
    automationStatus: string;
    steps?: TestStep[];
}

export interface TestStep {
    action: string;
    expectedResult: string;
}

export interface TestResult {
    testCaseId: number;
    outcome: 'Passed' | 'Failed' | 'Blocked' | 'NotApplicable';
    errorMessage?: string;
    stackTrace?: string;
    attachments?: string[];
    duration?: number;
    iterationDetails?: TestIterationDetails[];  // For manual data-driven tests
    subResults?: any[];  // For automated data-driven tests (proper way for automated tests)
    testCaseTitle?: string;  // Custom title for test result (used for iteration naming)
    comment?: string;  // Comment for test result
}

export interface TestIterationDetails {
    id: number;
    outcome: 'Passed' | 'Failed' | 'Blocked' | 'NotApplicable';
    parameters?: TestParameter[];
    errorMessage?: string;
    durationInMs?: number;
    startedDate?: string;
    completedDate?: string;
}

export interface TestParameter {
    parameterName: string;
    value: string;
}

export interface Bug {
    title: string;
    description: string;
    severity: string;
    priority: number;
    assignedTo?: string;
    attachments?: Attachment[];
    reproSteps?: string;
}

export interface Attachment {
    fileName: string;
    content: Buffer | string;
    comment?: string;
}

export class CSADOClient {
    private static instance: CSADOClient;
    private config: CSConfigurationManager;
    private adoConfig: ADOConfig;
    private proxyAgent?: HttpsProxyAgent<string> | SocksProxyAgent;
    private baseUrl: string;
    private headers: any;
    private testPointsCache: Map<string, any[]> = new Map();  // Cache for test points
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.adoConfig = this.loadADOConfig();

        // Debug logging to verify correct values
        // CSReporter.debug(`ADO Organization: ${this.adoConfig.organization}`);
        // CSReporter.debug(`ADO Project: ${this.adoConfig.project}`);

        this.baseUrl = `https://dev.azure.com/${this.adoConfig.organization}/${this.adoConfig.project}/_apis`;
        // CSReporter.info(`ADO Base URL: ${this.baseUrl}`);

        this.headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(`:${this.adoConfig.pat}`).toString('base64')}`
        };
        
        if (this.adoConfig.proxy?.enabled) {
            this.setupProxy(this.adoConfig.proxy);
        }
    }
    
    public static getInstance(): CSADOClient {
        if (!CSADOClient.instance) {
            CSADOClient.instance = new CSADOClient();
        }
        return CSADOClient.instance;
    }
    
    private loadADOConfig(): ADOConfig {
        return {
            organization: this.config.get('ADO_ORGANIZATION'),
            project: this.config.get('ADO_PROJECT'),
            pat: this.config.get('ADO_PAT'),
            apiVersion: this.config.get('ADO_API_VERSION', '7.0'),
            proxy: {
                enabled: this.config.getBoolean('ADO_PROXY_ENABLED', false),
                protocol: this.config.get('ADO_PROXY_PROTOCOL', 'http') as any,
                host: this.config.get('ADO_PROXY_HOST'),
                port: this.config.getNumber('ADO_PROXY_PORT', 8080),
                auth: {
                    required: this.config.getBoolean('ADO_PROXY_AUTH_REQUIRED', false),
                    username: this.config.get('ADO_PROXY_USERNAME'),
                    password: this.config.get('ADO_PROXY_PASSWORD')
                },
                bypassList: this.config.getList('ADO_PROXY_BYPASS_LIST')
            }
        };
    }
    
    private setupProxy(proxyConfig: ProxyConfig): void {
        let proxyUrl = `${proxyConfig.protocol}://`;
        
        if (proxyConfig.auth?.required && proxyConfig.auth.username && proxyConfig.auth.password) {
            const password = this.decryptIfNeeded(proxyConfig.auth.password);
            proxyUrl += `${proxyConfig.auth.username}:${password}@`;
        }
        
        proxyUrl += `${proxyConfig.host}:${proxyConfig.port}`;
        
        if (proxyConfig.protocol === 'socks5') {
            this.proxyAgent = new SocksProxyAgent(proxyUrl);
        } else {
            this.proxyAgent = new HttpsProxyAgent(proxyUrl);
        }
        
        // CSReporter.info(`ADO proxy configured: ${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`);
    }
    
    private decryptIfNeeded(value: string): string {
        if (value.startsWith('ENCRYPTED:')) {
            return this.config.get(value.replace('ENCRYPTED:', ''));
        }
        return value;
    }
    
    private shouldBypassProxy(url: string): boolean {
        if (!this.adoConfig.proxy?.bypassList) {
            return false;
        }
        
        return this.adoConfig.proxy.bypassList.some(pattern => url.includes(pattern));
    }
    
    private async makeRequest(method: string, endpoint: string, data?: any): Promise<any> {
        const url = `${this.baseUrl}${endpoint}?api-version=${this.adoConfig.apiVersion}`;
        
        if (this.shouldBypassProxy(url)) {
            // CSReporter.debug(`Bypassing proxy for: ${url}`);
        }
        
        const timeout = this.config.getNumber('ADO_API_TIMEOUT', 30000);
        const retryCount = this.config.getNumber('ADO_API_RETRY_COUNT', 3);
        const retryDelay = this.config.getNumber('ADO_API_RETRY_DELAY', 2000);
        
        let lastError: any;
        
        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                const response = await this.executeRequest(method, url, data, timeout);
                return response;
            } catch (error: any) {
                lastError = error;
                CSReporter.warn(`ADO API request failed (attempt ${attempt}/${retryCount}): ${error.message}`);
                
                if (attempt < retryCount) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                }
            }
        }
        
        throw lastError;
    }
    
    private executeRequest(method: string, url: string, data: any, timeout: number): Promise<any> {
        return new Promise((resolve, reject) => {
            // Debug log the actual URL being used
            // CSReporter.debug(`Making ADO request to: ${url}`);

            const urlObj = new URL(url);

            const options: any = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: this.headers,
                timeout: timeout
            };
            
            if (this.proxyAgent && !this.shouldBypassProxy(url)) {
                options.agent = this.proxyAgent;
            }
            
            const req = https.request(options, (res) => {
                let responseData = '';
                
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(responseData));
                        } catch {
                            resolve(responseData);
                        }
                    } else {
                        reject(new Error(`ADO API error: ${res.statusCode} - ${responseData}`));
                    }
                });
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            if (data) {
                req.write(JSON.stringify(data));
            }
            
            req.end();
        });
    }
    
    public async getTestCase(testCaseId: number): Promise<TestCase> {
        // CSReporter.info(`Fetching test case: ${testCaseId}`);
        
        const response = await this.makeRequest('GET', `/test/testcases/${testCaseId}`);
        
        return {
            id: response.id,
            name: response.fields['System.Title'],
            state: response.fields['System.State'],
            priority: response.fields['Microsoft.VSTS.Common.Priority'],
            automationStatus: response.fields['Microsoft.VSTS.TCM.AutomationStatus'],
            steps: this.parseTestSteps(response.fields['Microsoft.VSTS.TCM.Steps'])
        };
    }
    
    private parseTestSteps(stepsXml: string): TestStep[] {
        // Simplified XML parsing - in production use proper XML parser
        const steps: TestStep[] = [];
        
        if (!stepsXml) return steps;
        
        const stepMatches = stepsXml.match(/<step[^>]*>.*?<\/step>/g);
        
        if (stepMatches) {
            stepMatches.forEach(stepXml => {
                const actionMatch = stepXml.match(/<action>(.*?)<\/action>/);
                const expectedMatch = stepXml.match(/<expectedResult>(.*?)<\/expectedResult>/);
                
                steps.push({
                    action: actionMatch ? actionMatch[1] : '',
                    expectedResult: expectedMatch ? expectedMatch[1] : ''
                });
            });
        }
        
        return steps;
    }
    
    /**
     * Add a new test result to a test run (for data-driven iterations)
     */
    public async addTestResult(result: TestResult, runId: number): Promise<void> {
        if (!this.config.getBoolean('ADO_UPDATE_TEST_CASES', true)) {
            return;
        }

        // CSReporter.info(`Adding new test result for test case: ${result.testCaseId} in run: ${runId}`);

        try {
            // Create a new test result for this iteration
            const data = [{
                testCase: { id: result.testCaseId },
                testCaseTitle: result.testCaseTitle || `Test Case ${result.testCaseId}`,
                outcome: result.outcome,
                errorMessage: result.errorMessage,
                stackTrace: result.stackTrace,
                durationInMs: result.duration,
                state: 'Completed',
                completedDate: new Date().toISOString(),
                startedDate: new Date(Date.now() - (result.duration || 0)).toISOString(),
                comment: result.comment || `Automated test execution - ${new Date().toISOString()}`
            }];

            // CSReporter.debug(`Adding new test result with data: ${JSON.stringify(data, null, 2)}`);

            const response = await this.makeRequest('POST', `/test/runs/${runId}/results`, data);

            if (response && response.value && response.value.length > 0) {
                CSReporter.info(`✅ New test result added for test case ${result.testCaseId}: ${result.outcome}`);
            } else {
                CSReporter.warn(`Failed to add new test result for test case ${result.testCaseId}`);
            }
        } catch (error) {
            CSReporter.error(`Failed to add test result for test case ${result.testCaseId}: ${error}`);
        }
    }

    public async updateTestResult(result: TestResult, runId?: number): Promise<void> {
        if (!this.config.getBoolean('ADO_UPDATE_TEST_CASES', true)) {
            return;
        }

        // Require runId to be provided
        if (!runId) {
            CSReporter.error('Cannot update test result: No test run ID provided');
            return;
        }

        // CSReporter.info(`Updating test result for test case: ${result.testCaseId} in run: ${runId}`);

        try {
            // First, get the test results from the run to find the correct result ID
            const runResults = await this.makeRequest('GET', `/test/runs/${runId}/results`);

            if (!runResults.value || runResults.value.length === 0) {
                CSReporter.error(`No test results found in test run ${runId}`);
                return;
            }

            // Debug log first result structure (commented out to reduce verbosity)
            // CSReporter.debug(`Sample test result structure: ${JSON.stringify(runResults.value[0], null, 2)}`);

            // Test results in ADO may have test case ID in different locations
            // When created from test points, the test case is under testCase.id
            const testCaseIdStr = String(result.testCaseId);
            const testResult = runResults.value.find((r: any) => {
                // Check all possible locations for test case ID
                const tcId = r.testCase?.id || r.testCaseReference?.id || r.testCaseId || r.workItem?.id;
                return String(tcId) === testCaseIdStr;
            });

            if (!testResult) {
                CSReporter.warn(`No test result found for test case ${result.testCaseId} in run ${runId}`);
                // Commented out detailed debug logging to reduce verbosity
                // CSReporter.debug(`Looking for test case ID: ${testCaseIdStr}`);
                // CSReporter.debug(`Available test results in run: ${JSON.stringify(runResults.value?.map((r: any) => ({
                //     resultId: r.id,
                //     testCaseId: r.testCase?.id || r.testCaseReference?.id || r.testCaseId || 'unknown',
                //     testCaseName: r.testCase?.name || r.testCaseReference?.name || r.testCaseTitle || 'unknown',
                //     state: r.state,
                //     outcome: r.outcome
                // })), null, 2)}`);
                return;
            }

            // CSReporter.debug(`Found test result ${testResult.id} for test case ${result.testCaseId}`);

            // Update the specific test result
            const data: any = [{
                id: testResult.id,
                outcome: result.outcome,
                errorMessage: result.errorMessage,
                stackTrace: result.stackTrace,
                durationInMs: result.duration,
                state: 'Completed',
                completedDate: new Date().toISOString(),
                comment: result.comment || `Automated test execution - ${new Date().toISOString()}`
            }];

            // Add test case title if provided (for iteration naming)
            if (result.testCaseTitle) {
                data[0].testCaseTitle = result.testCaseTitle;
            }

            // For data-driven tests, pass iterationDetails directly
            if (result.iterationDetails && result.iterationDetails.length > 0) {
                data[0].iterationDetails = result.iterationDetails.map(iteration => ({
                    id: iteration.id,
                    outcome: iteration.outcome,
                    errorMessage: iteration.errorMessage,
                    durationInMs: iteration.durationInMs,
                    startedDate: iteration.startedDate || new Date().toISOString(),
                    completedDate: iteration.completedDate || new Date().toISOString(),
                    parameters: iteration.parameters || []
                }));
                // CSReporter.info(`✅ Sending ${result.iterationDetails.length} iterations to ADO`);
                // CSReporter.info(`📋 Iteration 1 details: ID=${data[0].iterationDetails[0].id}, Outcome=${data[0].iterationDetails[0].outcome}, Params=${JSON.stringify(data[0].iterationDetails[0].parameters)}`);
            }

            // Enable detailed debug logging to diagnose 500 error
            // CSReporter.debug(`Updating test result with data: ${JSON.stringify(data, null, 2)}`);

            const updateResponse = await this.makeRequest('PATCH', `/test/runs/${runId}/results`, data);

            if (updateResponse && updateResponse.value && updateResponse.value.length > 0) {
                // CSReporter.info(`✅ Test result updated for test case ${result.testCaseId}: ${result.outcome} (${result.duration}ms)`);
            } else {
                CSReporter.warn(`Test result update may have failed for test case ${result.testCaseId}`);
            }
        } catch (error) {
            CSReporter.error(`Failed to update test result for test case ${result.testCaseId}: ${error}`);
        }
        
        // Upload attachments if any
        if (result.attachments && result.attachments.length > 0) {
            for (const attachment of result.attachments) {
                await this.uploadAttachment(result.testCaseId, attachment);
            }
        }
        
        // CSReporter.info(`✅ Test result updated for test case ${result.testCaseId}: ${result.outcome}`);
    }
    
    public async createBug(bug: Bug): Promise<number> {
        if (!this.config.getBoolean('ADO_CREATE_BUGS_ON_FAILURE', false)) {
            return 0;
        }
        
        // CSReporter.info(`Creating bug: ${bug.title}`);
        
        const data = [
            {
                op: 'add',
                path: '/fields/System.Title',
                value: bug.title
            },
            {
                op: 'add',
                path: '/fields/System.Description',
                value: bug.description
            },
            {
                op: 'add',
                path: '/fields/Microsoft.VSTS.Common.Severity',
                value: bug.severity
            },
            {
                op: 'add',
                path: '/fields/Microsoft.VSTS.Common.Priority',
                value: bug.priority
            },
            {
                op: 'add',
                path: '/fields/System.AssignedTo',
                value: bug.assignedTo || this.config.get('DEFAULT_BUG_ASSIGNEE')
            },
            {
                op: 'add',
                path: '/fields/Microsoft.VSTS.TCM.ReproSteps',
                value: bug.reproSteps
            }
        ];
        
        const response = await this.makeRequest('POST', '/wit/workitems/$Bug', data);
        const bugId = response.id;
        
        // Upload attachments
        if (bug.attachments && bug.attachments.length > 0) {
            for (const attachment of bug.attachments) {
                await this.uploadBugAttachment(bugId, attachment);
            }
        }
        
        // CSReporter.info(`Bug created with ID: ${bugId}`);
        return bugId;
    }
    
    private async uploadAttachment(testCaseId: number, filePath: string): Promise<void> {
        // Simplified attachment upload
        // CSReporter.debug(`Uploading attachment for test case ${testCaseId}: ${filePath}`);
        
        // In production, implement actual file upload
        await this.makeRequest('POST', `/test/testcases/${testCaseId}/attachments`, {
            fileName: filePath,
            comment: 'Test execution evidence'
        });
    }
    
    private async uploadBugAttachment(bugId: number, attachment: Attachment): Promise<void> {
        // CSReporter.debug(`Uploading attachment for bug ${bugId}: ${attachment.fileName}`);
        
        // First upload the attachment
        const uploadResponse = await this.makeRequest('POST', '/wit/attachments', attachment.content);
        const attachmentUrl = uploadResponse.url;
        
        // Then link it to the bug
        const linkData = [
            {
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: 'AttachedFile',
                    url: attachmentUrl,
                    attributes: {
                        comment: attachment.comment || 'Bug evidence'
                    }
                }
            }
        ];
        
        await this.makeRequest('PATCH', `/wit/workitems/${bugId}`, linkData);
    }
    
    public async getTestPlan(planId: number): Promise<any> {
        // CSReporter.info(`Fetching test plan: ${planId}`);
        return await this.makeRequest('GET', `/test/plans/${planId}`);
    }
    
    public async getTestSuite(planId: number, suiteId: number): Promise<any> {
        // CSReporter.info(`Fetching test suite: ${suiteId}`);
        return await this.makeRequest('GET', `/test/plans/${planId}/suites/${suiteId}`);
    }

    public getTestPoints(planId: number, suiteId: number): any[] {
        // In a real implementation, this would fetch test points from ADO
        // For now, return cached test points if available
        // This is a synchronous method for compatibility with the publisher
        const cacheKey = `testpoints-${planId}-${suiteId}`;
        if (this.testPointsCache.has(cacheKey)) {
            return this.testPointsCache.get(cacheKey)!;
        }

        // Return empty array if not cached
        // The async version (fetchTestPoints) should be called first to populate cache
        return [];
    }

    public async fetchTestPoints(planId: number, suiteId: number): Promise<any[]> {
        // CSReporter.info(`Fetching test points for plan ${planId}, suite ${suiteId}`);
        // Match Java framework: Use 'points' not 'testpoints'
        const response = await this.makeRequest('GET', `/test/plans/${planId}/suites/${suiteId}/points`);

        const testPoints = response.value || [];

        // Log test case IDs found in test points for debugging
        if (testPoints.length > 0) {
            const testCaseIds = testPoints.map((tp: any) => {
                // Try to find test case ID in various possible locations
                return tp.testCase?.id || tp.testCaseReference?.id || tp.testCaseId || tp.workItem?.id || 'unknown';
            });
            // CSReporter.info(`Test points contain test case IDs: ${testCaseIds.join(', ')}`);
        }

        // Cache the test points
        const cacheKey = `testpoints-${planId}-${suiteId}`;
        this.testPointsCache.set(cacheKey, testPoints);

        // CSReporter.info(`Fetched ${testPoints.length} test points`);
        return testPoints;
    }
    
    public async createTestRun(name: string, testPoints: number[], planId?: number): Promise<number> {
        CSReporter.info(`Creating test run in ADO: ${name}`);

        const data: any = {
            name: name,
            automated: true,
            state: 'InProgress',
            startedDate: new Date().toISOString()
        };

        // If we have test points, we need to specify the plan ID
        // Azure DevOps requires plan.id when creating a run with test points
        if (testPoints && testPoints.length > 0) {
            data.pointIds = testPoints;
            // Plan ID is required when using test points
            if (planId) {
                data.plan = { id: planId };
                // CSReporter.info(`Creating test run with ${testPoints.length} test points from plan ${planId}`);
            } else {
                // Try to get plan ID from configuration as fallback
                const configPlanId = this.config.getNumber('ADO_TEST_PLAN_ID');
                if (configPlanId) {
                    data.plan = { id: configPlanId };
                    // CSReporter.info(`Creating test run with ${testPoints.length} test points from plan ${configPlanId} (from config)`);
                } else {
                    // This will fail in ADO, but log for debugging
                    CSReporter.error(`Cannot create test run: Test points specified but no plan ID available`);
                    throw new Error('Plan ID is required when creating a test run with test points');
                }
            }
        }

        // CSReporter.debug(`Test run creation payload: ${JSON.stringify(data, null, 2)}`);

        const response = await this.makeRequest('POST', '/test/runs', data);
        CSReporter.info(`✅ Created test run in ADO - Test Run ID: ${response.id}`);
        return response.id;
    }
    
    public async completeTestRun(runId: number): Promise<void> {
        // CSReporter.info(`Completing test run: ${runId}`);

        const data = {
            state: 'Completed',
            completedDate: new Date().toISOString()
        };

        await this.makeRequest('PATCH', `/test/runs/${runId}`, data);
        CSReporter.info(`✅ Test run completed in ADO - Run ID: ${runId}`);
    }

    public async uploadTestRunAttachment(runId: number, filePath: string, attachmentType: string = 'GeneralAttachment'): Promise<void> {
        // CSReporter.info(`Uploading attachment to test run ${runId}: ${path.basename(filePath)}`);

        if (!fs.existsSync(filePath)) {
            CSReporter.error(`Attachment file not found: ${filePath}`);
            return;
        }

        try {
            // Read the file
            const fileContent = fs.readFileSync(filePath);
            const fileName = path.basename(filePath);
            const fileStats = fs.statSync(filePath);

            // CSReporter.debug(`Uploading file: ${fileName} (${fileStats.size} bytes)`);

            // Azure DevOps Test Run Attachments API
            // First, we need to upload the file content as a stream
            const attachmentData = {
                stream: fileContent.toString('base64'),
                fileName: fileName,
                comment: `Test execution results - ${new Date().toISOString()}`,
                attachmentType: attachmentType
            };

            // Upload directly to test run attachments endpoint
            const response = await this.makeRequest('POST', `/test/runs/${runId}/attachments`, attachmentData);

            if (response && response.id) {
                // CSReporter.info(`✅ Attachment uploaded successfully to test run ${runId}: ${fileName} (ID: ${response.id}`);
            } else {
                CSReporter.warn(`Attachment upload completed but no ID returned for: ${fileName}`);
            }
        } catch (error) {
            CSReporter.error(`Failed to upload attachment: ${error}`);
        }
    }
    
    public async syncTestCases(featureFiles: string[]): Promise<void> {
        // CSReporter.info('Syncing test cases with Azure DevOps');
        
        // Parse feature files and sync with ADO
        // This is a placeholder for the actual implementation
        
        for (const featureFile of featureFiles) {
            // Parse feature file
            // Match scenarios with test cases
            // Update test cases in ADO
            // CSReporter.debug(`Syncing feature file: ${featureFile}`);
        }
        
        // CSReporter.info('Test case sync completed');
    }
}