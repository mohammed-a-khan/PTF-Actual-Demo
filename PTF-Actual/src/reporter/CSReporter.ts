import * as fs from 'fs';
import * as path from 'path';

export interface TestResult {
    name: string;
    status: 'pass' | 'fail' | 'skip' | 'pending';
    duration: number;
    error?: string;
    steps: StepResult[];
    screenshot?: string;
    timestamp: string;
}

export interface StepResult {
    name: string;
    status: 'pass' | 'fail' | 'skip';
    duration: number;
    error?: string;
    screenshot?: string;
    actions: ActionDetail[];
    timestamp: string;
    diagnostics?: any;  // Playwright 1.56+ diagnostic data (console logs, page errors, network requests)
    aiData?: StepAIData;  // AI operations data for this step
}

export interface StepAIData {
    healing?: {
        attempted: boolean;
        success: boolean;
        strategy: string;
        confidence: number;
        duration: number;
        originalLocator?: string;
        healedLocator?: string;
        attempts: number;
    };
    identification?: {
        method: string;
        confidence: number;
        alternatives: number;
        duration: number;
    };
    prediction?: {
        predicted: boolean;
        prevented: boolean;
        confidence: number;
        fragilityScore: number;
    };
    // NEW: Failure analysis from intelligent retry (v3.3.0+)
    failureAnalysis?: {
        failureType: string;  // ElementNotFound, Timeout, NetworkError, etc.
        healable: boolean;  // Whether failure can be healed
        confidence: number;  // Confidence in the analysis
        rootCause: string;  // Why it failed
        suggestedStrategies: string[];  // Healing strategies to try
        diagnosticInsights: string[];  // Insights from diagnostics
    };
    // NEW: Advanced context from zero-code execution (v3.3.0+)
    advancedContext?: {
        shadowDOM?: boolean;
        shadowRootHost?: string;
        framework?: string;  // react, angular, vue, svelte
        componentLibrary?: string;  // material-ui, ant-design, bootstrap
        inTable?: boolean;
        tableHeaders?: string[];
        inIframe?: boolean;
        nearLoadingIndicator?: boolean;
    };
    // NEW: Intelligent retry decision (v3.3.0+)
    retryDecision?: {
        shouldRetry: boolean;
        reason: string;  // Why retry was skipped or allowed
        analysisUsed: boolean;  // Whether failure analysis was used
    };
}

export interface ActionDetail {
    action: string;
    status: 'pass' | 'fail';
    duration: number;
    timestamp: string;
}

export class CSReporter {
    private static results: TestResult[] = [];
    private static currentTest: TestResult | null = null;
    private static currentStep: StepResult | null = null;
    private static startTime: number = Date.now();
    private static logBuffer: string[] = [];
    private static reportPath: string = '';
    
    public static initialize(): void {
        const reportDir = './reports';
        const timestamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0];
        this.reportPath = path.join(reportDir, `report-${timestamp}`);
        
        if (!fs.existsSync(this.reportPath)) {
            fs.mkdirSync(this.reportPath, { recursive: true });
        }
        
        console.log(`📊 Report directory: ${this.reportPath}`);
    }

    public static pass(message: string): void {
        this.log('PASS', message);
    }

    public static fail(message: string): void {
        this.log('FAIL', message);
    }

    public static info(message: string): void {
        this.log('INFO', message);
    }

    public static warn(message: string): void {
        this.log('WARN', message);
    }

    public static error(message: string): void {
        this.log('ERROR', message);
    }

    public static debug(message: string): void {
        this.log('DEBUG', message);
    }

    public static startTest(name: string): void {
        this.currentTest = {
            name,
            status: 'pending',
            duration: 0,
            steps: [],
            timestamp: new Date().toISOString()
        };
        this.log('TEST', `Starting test: ${name}`);
    }

    public static endTest(status: 'pass' | 'fail' | 'skip' = 'pass'): void {
        if (this.currentTest) {
            this.currentTest.status = status;
            this.currentTest.duration = Date.now() - this.startTime;
            this.results.push(this.currentTest);
            this.log(status.toUpperCase(), `Test completed: ${this.currentTest.name}`);
            this.currentTest = null;
        }
    }

    public static startBDDStep(name: string): void {
        this.currentStep = {
            name,
            status: 'pass',
            duration: 0,
            actions: [],
            timestamp: new Date().toISOString()
        };
        this.log('STEP', name);
    }

    public static endBDDStep(status: 'pass' | 'fail' | 'skip' = 'pass', duration?: number): void {
        if (this.currentStep && this.currentTest) {
            this.currentStep.status = status;
            if (duration !== undefined) {
                this.currentStep.duration = duration;
            }
            this.currentTest.steps.push(this.currentStep);
            this.currentStep = null;
        }
    }

    public static startStep(name: string): void {
        this.startBDDStep(name);
    }

    public static endStep(status: 'pass' | 'fail' | 'skip' = 'pass'): void {
        this.endBDDStep(status);
    }

    public static passStep(duration?: number): void {
        this.endBDDStep('pass', duration);
    }

    public static failStep(error: string, duration?: number): void {
        if (this.currentStep) {
            this.currentStep.error = error;
        }
        this.endBDDStep('fail', duration);
    }

    public static skipStep(): void {
        this.endBDDStep('skip');
    }

    public static startFeature(name: string): void {
        this.log('FEATURE', `Starting feature: ${name}`);
    }

    public static endFeature(): void {
        this.log('FEATURE', 'Feature completed');
    }

    public static startScenario(name: string): void {
        this.startTest(name);
    }

    public static endScenario(): void {
        this.endTest();
    }

    public static passScenario(): void {
        this.endTest('pass');
    }

    public static failScenario(error: string): void {
        if (this.currentTest) {
            this.currentTest.error = error;
        }
        this.endTest('fail');
    }

    public static addAction(action: string, status: 'pass' | 'fail' = 'pass', duration: number = 0): void {
        if (this.currentStep) {
            this.currentStep.actions.push({
                action,
                status,
                duration,
                timestamp: new Date().toISOString()
            });
        }
    }

    // AI Data Recording Methods
    public static recordAIHealing(healingData: StepAIData['healing']): void {
        if (this.currentStep && healingData) {
            if (!this.currentStep.aiData) {
                this.currentStep.aiData = {};
            }
            this.currentStep.aiData.healing = healingData;
            this.debug(`[AI] Healing recorded: ${healingData.success ? 'SUCCESS' : 'FAILED'} using ${healingData.strategy} (${(healingData.confidence * 100).toFixed(1)}% confidence)`);
        }
    }

    public static recordAIIdentification(identificationData: StepAIData['identification']): void {
        if (this.currentStep && identificationData) {
            if (!this.currentStep.aiData) {
                this.currentStep.aiData = {};
            }
            this.currentStep.aiData.identification = identificationData;
            this.debug(`[AI] Identification recorded: ${identificationData.method} (${(identificationData.confidence * 100).toFixed(1)}% confidence, ${identificationData.alternatives} alternatives)`);
        }
    }

    public static recordAIPrediction(predictionData: StepAIData['prediction']): void {
        if (this.currentStep && predictionData) {
            if (!this.currentStep.aiData) {
                this.currentStep.aiData = {};
            }
            this.currentStep.aiData.prediction = predictionData;
            this.debug(`[AI] Prediction recorded: ${predictionData.predicted ? 'PREDICTED' : 'NOT PREDICTED'} (Fragility: ${(predictionData.fragilityScore * 100).toFixed(1)}%)`);
        }
    }

    // NEW: v3.3.0+ AI Data Recording Methods
    public static recordAIFailureAnalysis(failureAnalysisData: StepAIData['failureAnalysis']): void {
        if (this.currentStep && failureAnalysisData) {
            if (!this.currentStep.aiData) {
                this.currentStep.aiData = {};
            }
            this.currentStep.aiData.failureAnalysis = failureAnalysisData;
            this.debug(`[AI] Failure Analysis recorded: ${failureAnalysisData.failureType} (${failureAnalysisData.healable ? 'HEALABLE' : 'NOT HEALABLE'}, ${(failureAnalysisData.confidence * 100).toFixed(1)}% confidence)`);
        }
    }

    public static recordAIAdvancedContext(advancedContextData: StepAIData['advancedContext']): void {
        if (this.currentStep && advancedContextData) {
            if (!this.currentStep.aiData) {
                this.currentStep.aiData = {};
            }
            this.currentStep.aiData.advancedContext = advancedContextData;
            const features: string[] = [];
            if (advancedContextData.framework) features.push(`framework: ${advancedContextData.framework}`);
            if (advancedContextData.componentLibrary) features.push(`library: ${advancedContextData.componentLibrary}`);
            if (advancedContextData.shadowDOM) features.push('shadowDOM');
            if (advancedContextData.inTable) features.push('table');
            if (advancedContextData.inIframe) features.push('iframe');
            this.debug(`[AI] Advanced Context recorded: ${features.join(', ') || 'none'}`);
        }
    }

    public static recordAIRetryDecision(retryDecisionData: StepAIData['retryDecision']): void {
        if (this.currentStep && retryDecisionData) {
            if (!this.currentStep.aiData) {
                this.currentStep.aiData = {};
            }
            this.currentStep.aiData.retryDecision = retryDecisionData;
            this.debug(`[AI] Retry Decision recorded: ${retryDecisionData.shouldRetry ? 'RETRY ALLOWED' : 'RETRY SKIPPED'} (${retryDecisionData.reason})`);
        }
    }

    // Getter methods for accessing test data
    public static getResults(): TestResult[] {
        return [...this.results];
    }

    public static getCurrentTest(): TestResult | null {
        return this.currentTest;
    }

    public static getCurrentStep(): StepResult | null {
        return this.currentStep;
    }

    public static getLogBuffer(): string[] {
        return [...this.logBuffer];
    }

    public static clearResults(): void {
        this.results = [];
        this.currentTest = null;
        this.currentStep = null;
        this.logBuffer = [];
    }

    public static async generateReports(): Promise<void> {
        this.log('INFO', 'Generating reports...');
        
        // Generate JSON report
        const jsonPath = path.join(this.reportPath, 'results.json');
        fs.writeFileSync(jsonPath, JSON.stringify(this.results, null, 2));
        this.log('INFO', `JSON report generated: ${jsonPath}`);
        
        // Generate simple HTML report
        const htmlPath = path.join(this.reportPath, 'index.html');
        const html = this.generateSimpleHTML();
        fs.writeFileSync(htmlPath, html);
        this.log('INFO', `HTML report generated: ${htmlPath}`);
    }

    private static log(level: string, message: string): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}`;

        // Store in log buffer
        this.logBuffer.push(logMessage);

        // Add to current step if it exists
        if (this.currentStep && level !== 'STEP' && level !== 'TEST' && level !== 'FEATURE') {
            // Add detailed log entry to current step
            if (!this.currentStep.actions) {
                this.currentStep.actions = [];
            }
            this.currentStep.actions.push({
                action: message,
                status: level === 'PASS' ? 'pass' : level === 'FAIL' || level === 'ERROR' ? 'fail' : 'pass',
                duration: 0,
                timestamp: timestamp
            });
        }

        // Check log level hierarchy
        const logLevel = process.env.LOG_LEVEL || 'DEBUG';
        const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
        const currentLevelIndex = levels.indexOf(level);
        const configuredLevelIndex = levels.indexOf(logLevel.toUpperCase());

        // Skip console output if current level is below configured level
        if (currentLevelIndex !== -1 && configuredLevelIndex !== -1 && currentLevelIndex < configuredLevelIndex) {
            return;
        }

        // Console output with colors
        const colors: any = {
            'PASS': '\x1b[32m',    // Green
            'FAIL': '\x1b[31m',    // Red
            'WARN': '\x1b[33m',    // Yellow
            'INFO': '\x1b[36m',    // Cyan
            'DEBUG': '\x1b[90m',   // Gray
            'ERROR': '\x1b[31m',   // Red
            'TEST': '\x1b[35m',    // Magenta
            'STEP': '\x1b[37m',    // White
            'FEATURE': '\x1b[34m', // Blue
        };

        const color = colors[level] || '\x1b[37m';
        const reset = '\x1b[0m';

        console.log(`${color}${logMessage}${reset}`);
        this.logBuffer.push(logMessage);
    }

    private static generateSimpleHTML(): string {
        const totalTests = this.results.length;
        const passedTests = this.results.filter(r => r.status === 'pass').length;
        const failedTests = this.results.filter(r => r.status === 'fail').length;
        const skippedTests = this.results.filter(r => r.status === 'skip').length;
        
        return `<!DOCTYPE html>
<html>
<head>
    <title>Test Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .summary { background: #f0f0f0; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .pass { color: green; }
        .fail { color: red; }
        .skip { color: orange; }
        .test { margin: 10px 0; padding: 10px; border: 1px solid #ddd; }
    </style>
</head>
<body>
    <h1>Test Report</h1>
    <div class="summary">
        <h2>Summary</h2>
        <p>Total: ${totalTests}</p>
        <p class="pass">Passed: ${passedTests}</p>
        <p class="fail">Failed: ${failedTests}</p>
        <p class="skip">Skipped: ${skippedTests}</p>
    </div>
    <h2>Test Results</h2>
    ${this.results.map(test => `
        <div class="test ${test.status}">
            <h3>${test.name}</h3>
            <p>Status: ${test.status}</p>
            <p>Duration: ${test.duration}ms</p>
            ${test.error ? `<p>Error: ${test.error}</p>` : ''}
        </div>
    `).join('')}
</body>
</html>`;
    }

    // Additional methods for compatibility
    public static addConsoleLog(log: string): void {
        this.logBuffer.push(log);
    }

    public static addNetworkLog(method: string, url: string, status: number, duration: number, size: number): void {
        this.log('NETWORK', `${method} ${url} - Status: ${status}, Duration: ${duration}ms, Size: ${size} bytes`);
    }
}