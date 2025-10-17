# Performance Testing Guide

This directory contains performance testing scenarios and step definitions for the application.

## Directory Structure

```
test/performance/
├── features/           # Performance test feature files (Gherkin)
│   └── orangehrmdemo-performance.feature
├── steps/             # Application-specific step definitions
│   └── CSOrangeHRMPerfSteps.ts
└── README.md          # This file
```

## Overview

Performance testing is organized into several test types:

### Test Types

1. **Load Test** - Tests system behavior under expected load
   - Simulates multiple concurrent users
   - Measures response time, throughput, and error rates
   - Example: 10 users for 60 seconds

2. **Stress Test** - Identifies system breaking point
   - Gradually increases load until system fails
   - Helps identify maximum capacity
   - Example: 5 to 50 users in 10-second steps

3. **Spike Test** - Tests system recovery from sudden load increase
   - Simulates sudden traffic spikes
   - Verifies system can recover gracefully
   - Example: 10 baseline users spiking to 100 users

4. **Endurance Test** - Verifies system stability over time
   - Runs for extended periods (hours)
   - Identifies memory leaks and resource exhaustion
   - Example: 20 users for 1+ hours

5. **Baseline Test** - Establishes performance baseline
   - Single or few users
   - Sets baseline metrics for comparison
   - Example: 5 users establishing baseline

6. **Core Web Vitals Test** - Measures user experience metrics
   - LCP (Largest Contentful Paint)
   - FID (First Input Delay)
   - CLS (Cumulative Layout Shift)

7. **UI Load Test** - Tests frontend with concurrent browser sessions
   - Multiple browser instances
   - Frontend-specific metrics

## Running Performance Tests

### Run All Performance Tests
```bash
npm run test -- --features=test/performance/features/ --modules=performance
```

### Run Specific Test Types

**Load Tests:**
```bash
npm run test -- --features=test/performance/features/orangehrmdemo-performance.feature --tags="@load-test"
```

**Stress Tests:**
```bash
npm run test -- --features=test/performance/features/orangehrmdemo-performance.feature --tags="@stress-test"
```

**Web Vitals Tests:**
```bash
npm run test -- --features=test/performance/features/orangehrmdemo-performance.feature --tags="@web-vitals"
```

**Smoke Tests (quick validation):**
```bash
npm run test -- --features=test/performance/features/orangehrmdemo-performance.feature --tags="@smoke"
```

## Generic Performance Steps

The framework provides generic performance testing steps that can be reused across projects:

### Setup Steps (Given)
- `I have a load test with {int} virtual users for {int} seconds`
- `I have a stress test from {int} to {int} users in {int} second steps`
- `I have a spike test with {int} baseline users spiking to {int} users for {int} seconds`
- `I have an endurance test with {int} users for {int} hours`
- `I have a baseline performance test with {int} user(s)`
- `I set the target URL to {string}`
- `I set the response time threshold to {int} milliseconds`
- `I set the error rate threshold to {float} percent`

### Execution Steps (When)
- `I execute the performance test`
- `I run the performance test for {int} seconds`

### Validation Steps (Then)
- `the test should complete successfully`
- `the response time should be less than {int} milliseconds`
- `the 95th percentile response time should be less than {int} milliseconds`
- `the error rate should be less than {float} percent`
- `the throughput should be at least {float} requests per second`
- `the success rate should be at least {float} percent`
- `there should be no critical threshold violations`
- `I should see performance metrics`

### UI Performance Steps (Coming Soon)
These steps are available but currently commented out in the feature file until UI metrics are fully implemented:
- `the Largest Contentful Paint should be less than {int} milliseconds`
- `the First Input Delay should be less than {int} milliseconds`
- `the Cumulative Layout Shift should be less than {float}`
- `the page load should complete in less than {int} seconds`

## Application-Specific Steps

Create custom step definitions in `steps/` for your application-specific scenarios:

```typescript
import { CSBDDStepDef, CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/performance';

export class MyAppPerfSteps {
    @CSBDDStepDef('I perform application-specific action')
    static myCustomStep(): void {
        CSReporter.info('Executing custom step');
        // Your logic here
    }
}
```

**Note:** Always import from the `/performance` entry point to avoid loading the entire framework:
- ✅ `import { ... } from '@mdakhan.mak/cs-playwright-test-framework/performance'`
- ❌ `import { ... } from '@mdakhan.mak/cs-playwright-test-framework'` (loads entire framework)

## Configuration

Performance test configuration can be set via:

1. **Environment Variables:**
   ```bash
   export PERFORMANCE_TARGET_URL="https://your-app.com"
   ```

2. **Configuration Files:**
   Update `config/performance-config.json` with project-specific settings

3. **Feature Files:**
   Set parameters directly in Gherkin scenarios

## Performance Metrics

The framework collects and reports:

- **Response Time Metrics:**
  - Average, Min, Max
  - Percentiles (50th, 75th, 95th, 99th)

- **Load Metrics:**
  - Throughput (requests/second)
  - Concurrent users
  - Request count

- **Error Metrics:**
  - Error rate (%)
  - Error distribution
  - Failed requests

- **Resource Metrics:**
  - Memory usage
  - CPU usage
  - Network bandwidth

## Thresholds and SLAs

Define performance thresholds in your feature files:

```gherkin
Given I set the response time threshold to 2000 milliseconds
And I set the error rate threshold to 5.0 percent
```

Tests will fail if thresholds are violated with `severity: 'critical'`.

## Best Practices

1. **Start Small:** Begin with baseline tests, then gradually increase load
2. **Use Tags:** Organize tests with tags for easy filtering
3. **Set Realistic Thresholds:** Base thresholds on business requirements
4. **Monitor Resources:** Watch system resources during tests
5. **Run Regularly:** Include performance tests in CI/CD pipeline
6. **Isolate Tests:** Run performance tests in dedicated environments
7. **Document Results:** Keep baseline metrics for comparison

## Troubleshooting

### Test Timeouts
Increase timeout in configuration if tests are timing out on long-running scenarios.

### High Error Rates
- Check application logs
- Verify target URL is accessible
- Ensure test data is valid
- Check database connection pool size

### Inconsistent Results
- Run tests multiple times for statistical significance
- Ensure test environment is stable
- Check for competing processes

## Reports

Performance test results are available in:
- HTML Report: `reports/html-report.html` (includes Performance tab)
- Enterprise Dashboard: Real-time metrics visualization
- JSON Report: `reports/test-results.json`

## Next Steps

1. Create application-specific feature files
2. Implement custom step definitions for your workflows
3. Configure realistic performance thresholds
4. Integrate with CI/CD pipeline
5. Set up monitoring and alerting
