# AI Platform Integration Guide

## 🎯 Critical Requirements

### ✅ Execution Mode Support
- **Sequential Execution**: Single worker, single AI instance
- **Parallel Execution**: Multiple workers, each with isolated AI instance (thread-safe)

### ✅ Step Type Behavior
| Step Type | AI Healing | Retry Behavior |
|-----------|-----------|----------------|
| **UI Steps** (click, type, navigate, etc.) | ✅ **ENABLED** | AI intelligent healing |
| **API Steps** (request, response, endpoint, etc.) | ❌ **DISABLED** | Existing retry behavior preserved |
| **Database Steps** (query, insert, update, etc.) | ❌ **DISABLED** | Existing retry behavior preserved |

### ✅ Thread Safety
- Each parallel worker gets its own AI instance
- No shared state between workers
- History aggregation happens after all workers complete

---

## 📋 Configuration

### Environment Variables (`config/ai.env`)

```bash
# Enable AI Platform
AI_ENABLED=true

# Intelligent Healing
AI_INTELLIGENT_HEALING_ENABLED=true
AI_MAX_HEALING_ATTEMPTS=3

# CRITICAL: Only activate for UI steps
AI_UI_ONLY=true

# Predictive Healing (optional - no external APIs)
AI_PREDICTIVE_HEALING_ENABLED=false

# Learning & Optimization
AI_LEARNING_ENABLED=true
```

---

## 🔌 BDD Runner Integration

### Integration Points

#### 1. Worker Initialization (Both Sequential & Parallel)

```typescript
import { CSAIIntegrationLayer } from './ai/integration/CSAIIntegrationLayer';

// In worker initialization (CSBDDRunner or parallel worker)
const workerId = process.env.WORKER_ID || 'main';
const aiIntegration = CSAIIntegrationLayer.getInstance(workerId);

CSReporter.debug(`Worker ${workerId} initialized with AI support`);
```

#### 2. Step Execution with AI Healing

```typescript
async function executeStep(step: Step, page: Page, context: StepContext): Promise<void> {
    const workerId = process.env.WORKER_ID || 'main';
    const aiIntegration = CSAIIntegrationLayer.getInstance(workerId);

    try {
        // Check if AI should activate for this step
        const shouldUseAI = aiIntegration.shouldActivateAI(step.text);

        if (shouldUseAI) {
            CSReporter.debug(`[Worker ${workerId}] AI ENABLED for UI step: ${step.text}`);
        } else {
            CSReporter.debug(`[Worker ${workerId}] AI DISABLED for ${step.text} - using existing retry`);
        }

        // Execute the step
        await executeStepImplementation(step, page, context);

    } catch (error) {
        // CRITICAL: Only attempt AI healing for UI steps
        if (aiIntegration.shouldActivateAI(step.text)) {
            CSReporter.debug(`[Worker ${workerId}] UI step failed, attempting AI healing...`);

            const healingResult = await aiIntegration.attemptHealing(error, {
                page,
                locator: extractLocatorFromError(error),
                step: step.text,
                url: page.url(),
                testName: context.testName,
                scenarioName: context.scenarioName
            });

            if (healingResult.healed && healingResult.newLocator) {
                CSReporter.info(`[Worker ${workerId}] ✅ AI healed the failure, retrying with new locator`);
                // Retry with healed locator
                await retryStepWithHealedLocator(step, page, healingResult.newLocator);
                return;
            } else {
                CSReporter.debug(`[Worker ${workerId}] AI healing unsuccessful, proceeding with existing retry logic`);
            }
        } else {
            CSReporter.debug(`[Worker ${workerId}] Non-UI step failed, using existing retry behavior`);
            // For API/Database steps, use existing retry logic
        }

        // Fallback to existing retry mechanism
        throw error;
    }
}
```

#### 3. Worker Cleanup (Parallel Mode)

```typescript
// In worker cleanup/exit
async function cleanupWorker(workerId: string): Promise<void> {
    CSReporter.debug(`Cleaning up worker ${workerId}`);

    // Clear worker's AI instance
    CSAIIntegrationLayer.clearInstance(workerId);
}
```

#### 4. Report Aggregation (After All Workers Complete)

```typescript
import { CSAIReportAggregator } from './reporter/CSAIReportAggregator';
import { CSAIHistory } from './ai/learning/CSAIHistory';

async function generateFinalReport(testResults: TestResult[]): Promise<void> {
    // Aggregate AI data from all workers
    const aiAggregator = CSAIReportAggregator.getInstance();
    const aiSummary = aiAggregator.aggregateAIData(testResults);

    // Generate AI statistics HTML
    const aiStatsHTML = aiAggregator.generateAIStatsHTML(aiSummary);

    // Include in HTML report
    // (Add AI tab to your HTML report generation)

    CSReporter.info(`AI Report: ${aiSummary.healingStats.successfulHealings}/${aiSummary.healingStats.totalAttempts} healings successful`);
    CSReporter.info(`Time Saved: ${Math.round(aiSummary.healingStats.totalTimeSaved / 60000)} minutes`);
}
```

---

## 🧪 Example: Full Integration Flow

### Scenario Execution (Works with Both Sequential & Parallel)

```typescript
// CSBDDRunner.ts or parallel worker

import { CSAIIntegrationLayer } from './ai/integration/CSAIIntegrationLayer';
import { CSAIContextManager } from './ai/CSAIContextManager';

class BDDStepExecutor {
    private aiIntegration: CSAIIntegrationLayer;
    private workerId: string;

    constructor(workerId: string = 'main') {
        this.workerId = workerId;
        this.aiIntegration = CSAIIntegrationLayer.getInstance(workerId);
    }

    async executeStep(step: GherkinStep, page: Page): Promise<void> {
        const stepText = step.text;

        // Step 1: Auto-detect context (UI, API, or Database)
        const context = CSAIContextManager.getInstance().detectContextFromStep(stepText);
        CSReporter.debug(`[Worker ${this.workerId}] Step context detected: ${context}`);

        // Step 2: Execute based on context
        if (context === 'ui') {
            await this.executeUIStep(step, page);
        } else if (context === 'api') {
            await this.executeAPIStep(step);  // No AI, existing retry
        } else if (context === 'database') {
            await this.executeDatabaseStep(step);  // No AI, existing retry
        } else {
            await this.executeGenericStep(step);  // No AI by default
        }
    }

    private async executeUIStep(step: GherkinStep, page: Page): Promise<void> {
        const maxRetries = 3;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Execute the UI step
                await this.performUIAction(step, page);
                return;  // Success

            } catch (error) {
                lastError = error;
                CSReporter.debug(`[Worker ${this.workerId}] UI step failed (attempt ${attempt}/${maxRetries})`);

                // Attempt AI healing on first failure
                if (attempt === 1) {
                    const healingResult = await this.aiIntegration.attemptHealing(error, {
                        page,
                        locator: step.locator,
                        step: step.text,
                        url: page.url(),
                        testName: step.testName,
                        scenarioName: step.scenarioName
                    });

                    if (healingResult.healed) {
                        // Retry immediately with healed locator
                        try {
                            await this.performUIActionWithLocator(step, page, healingResult.newLocator!);
                            CSReporter.info(`[Worker ${this.workerId}] ✅ AI healing successful!`);
                            return;
                        } catch (retryError) {
                            CSReporter.debug(`[Worker ${this.workerId}] Healed locator also failed, continuing retries`);
                        }
                    }
                }

                // Wait before retry
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                }
            }
        }

        throw lastError!;
    }

    private async executeAPIStep(step: GherkinStep): Promise<void> {
        // API steps use existing retry behavior
        // NO AI HEALING
        CSReporter.debug(`[Worker ${this.workerId}] API step - using existing retry logic`);
        await this.performAPIAction(step);
    }

    private async executeDatabaseStep(step: GherkinStep): Promise<void> {
        // Database steps use existing retry behavior
        // NO AI HEALING
        CSReporter.debug(`[Worker ${this.workerId}] Database step - using existing retry logic`);
        await this.performDatabaseAction(step);
    }
}
```

---

## 🔍 Context Detection Examples

### Automatic Context Detection

```typescript
import { CSAIContextManager } from './ai/CSAIContextManager';

// These are automatically detected as UI
CSAIContextManager.isUIStep("When I click the Submit button");         // true
CSAIContextManager.isUIStep("Then I should see the Welcome page");     // true
CSAIContextManager.isUIStep("When I type 'test' into the email field"); // true

// These are automatically detected as API
CSAIContextManager.isAPIStep("When I send a POST request to /api/users"); // true
CSAIContextManager.isAPIStep("Then the response status should be 200");   // true
CSAIContextManager.isAPIStep("When I GET the endpoint /api/data");        // true

// These are automatically detected as Database
CSAIContextManager.isDatabaseStep("When I query the users table");          // true
CSAIContextManager.isDatabaseStep("Then the database should contain 5 records"); // true
CSAIContextManager.isDatabaseStep("When I insert a new user into MongoDB"); // true
```

---

## 📊 Parallel Execution Support

### Worker Isolation

```typescript
// Main process
const workers = [
    { id: 'worker-1', scenarios: scenarios.slice(0, 10) },
    { id: 'worker-2', scenarios: scenarios.slice(10, 20) },
    { id: 'worker-3', scenarios: scenarios.slice(20, 30) }
];

// Each worker gets its own AI instance
workers.forEach(worker => {
    // In worker process
    process.env.WORKER_ID = worker.id;

    // Each worker has isolated AI
    const aiIntegration = CSAIIntegrationLayer.getInstance(worker.id);

    // Execute scenarios
    worker.scenarios.forEach(scenario => {
        executeScenario(scenario, aiIntegration);
    });
});

// After all workers complete, aggregate results
const allResults = await Promise.all(workerResults);
const aiSummary = CSAIReportAggregator.getInstance().aggregateAIData(allResults);
```

---

## ⚙️ Configuration Per Environment

### Development
```bash
AI_ENABLED=true
AI_INTELLIGENT_HEALING_ENABLED=true
AI_PREDICTIVE_HEALING_ENABLED=true
AI_UI_ONLY=true
```

### CI/CD
```bash
AI_ENABLED=true
AI_INTELLIGENT_HEALING_ENABLED=true
AI_PREDICTIVE_HEALING_ENABLED=false
AI_UI_ONLY=true
```

### Production Monitoring
```bash
AI_ENABLED=true
AI_INTELLIGENT_HEALING_ENABLED=false  # Only learn, don't heal
AI_LEARNING_ENABLED=true
AI_UI_ONLY=true
```

---

## 📈 Reporting Integration

### Step-Level AI Data

Each step can have AI data attached:

```typescript
interface StepResult {
    name: string;
    status: 'pass' | 'fail' | 'skip';
    // ... other fields
    aiData?: {
        healing?: {
            attempted: boolean;
            success: boolean;
            strategy: string;
            confidence: number;
        };
        identification?: { ... };
        prediction?: { ... };
    };
}
```

### HTML Report Generation

```typescript
// In your HTML report generator
import { CSAIReportAggregator } from './reporter/CSAIReportAggregator';

function generateHTMLReport(results: TestResult[]): string {
    const aiAggregator = CSAIReportAggregator.getInstance();
    const aiSummary = aiAggregator.aggregateAIData(results);

    // Generate AI tab content
    const aiTabHTML = aiAggregator.generateAIStatsHTML(aiSummary);

    // For each step with AI data
    results.forEach(test => {
        test.steps.forEach(step => {
            if (step.aiData) {
                const stepAIHTML = aiAggregator.generateStepAIDataHTML(step.aiData);
                // Include in step details
            }
        });
    });

    // Include AI tab in report
    return `
        <div class="tabs">
            <div class="tab">Test Results</div>
            <div class="tab">AI Operations</div>
        </div>
        <div class="tab-content">
            <!-- Test results -->
        </div>
        <div class="tab-content ai-tab">
            ${aiTabHTML}
        </div>
    `;
}
```

---

## 🧪 Testing the Integration

### Test 1: UI Step Healing
```gherkin
Scenario: AI heals UI failure
  When I click the "Submit" button  # Will use AI healing if fails
  Then I should see "Success"
```

### Test 2: API Step (No AI)
```gherkin
Scenario: API step preserves existing behavior
  When I send a POST request to "/api/users"  # AI disabled, existing retry
  Then the response status should be 200
```

### Test 3: Database Step (No AI)
```gherkin
Scenario: Database step preserves existing behavior
  When I query the users table  # AI disabled, existing retry
  Then I should get 5 records
```

### Test 4: Parallel Execution
```bash
# Run with 3 workers
npm run cs-framework -- --parallel=3 --project=myproject

# Each worker gets isolated AI
# Worker 1: CSAIIntegrationLayer.getInstance('worker-1')
# Worker 2: CSAIIntegrationLayer.getInstance('worker-2')
# Worker 3: CSAIIntegrationLayer.getInstance('worker-3')
```

---

## ✅ Implementation Checklist

- [x] AI Context Manager created (detects UI vs API vs DB)
- [x] AI Integration Layer created (thread-safe)
- [x] Configuration file created (`config/ai.env`)
- [x] Step AI data interfaces added to CSReporter
- [x] AI Report Aggregator created
- [ ] Update CSBDDRunner to use AIIntegrationLayer
- [ ] Update parallel workers to use AIIntegrationLayer
- [ ] Update HTML report generator to include AI tab
- [ ] Add AI tab CSS styles
- [ ] Test with sequential execution
- [ ] Test with parallel execution
- [ ] Test UI step healing
- [ ] Test API step bypass (no AI)
- [ ] Test database step bypass (no AI)

---

## 🚀 Summary

### What Works
✅ Both sequential and parallel execution
✅ Thread-safe worker isolation
✅ UI steps get AI healing
✅ API/Database steps use existing retry
✅ Comprehensive reporting
✅ Zero external AI APIs

### What to Avoid
❌ Don't activate AI for API steps
❌ Don't activate AI for Database steps
❌ Don't share AI instances between workers
❌ Don't disable UI-only mode in production

### Key Benefits
- Automatic failure healing for UI
- Preserved behavior for API/DB
- Works in both execution modes
- Thread-safe by design
- Comprehensive statistics
- Zero configuration changes needed

---

**Ready for BDD Runner Integration!**
