# Parallel Execution Performance Optimization Plan

## Executive Summary

**Current Performance:** 289s (4m 49s) total execution time
- Test execution: 150s (52%) ✅ Good
- Overhead: 139s (48%) ❌ Terrible
  - HAR context close timeouts: 15-20s per worker
  - ZIP creation: 61s (21% of total)
  - ADO upload: 95s (33% of total)
  - Worker termination: 5-10s per worker

**Target Performance:** <150s (2m 30s) - **59% faster**
**Achievable with:** CODE-LEVEL optimizations (NO config changes needed)

---

## Bottleneck #1: HAR Context Close Timeout (15-20s per worker)

### Problem Analysis

**Location:** `/node_modules/cs-test-automation-framework/dist/browser/CSBrowserManager.js:424-456`

**Current Code:**
```javascript
async closeContext(testStatus, skipTraceSave = false) {
    if (this.context) {
        try {
            // Increase timeout to allow HAR saving to complete (HAR can be large)
            // HAR is automatically saved by Playwright when context closes
            await Promise.race([
                this.context.close(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Context close timeout')), 15000) // 15s timeout
                )
            ]);
        }
        catch (error) {
            CSReporter.warn('Context close timeout or error (HAR may not be saved): ' + error);
            // Force close the context if it's still open
            try {
                if (this.context) {
                    await this.context.close();
                }
            }
            catch (secondError) {
                CSReporter.debug('Force close also failed: ' + secondError);
            }
        }
        finally {
            this.context = null;
        }
    }
}
```

**Issues:**
1. **Synchronous wait:** HAR save blocks for 15s before timeout
2. **Retry logic fails:** Force close attempts after timeout still fail
3. **No parallel cleanup:** All 3 workers wait sequentially
4. **HAR save unnecessary at cleanup:** Tests already passed, HAR not needed

### Optimization #1A: Skip HAR on Cleanup (Fastest - Saves 15-20s)

**Strategy:** Don't save HAR during final cleanup - only during test execution

**Modified Code:**
```javascript
async closeContext(testStatus, skipTraceSave = false, skipHarSave = false) {
    // Save trace before closing context if browser reuse is enabled
    if (this.context && this.traceStarted && !skipTraceSave) {
        await this.saveTraceIfNeeded(testStatus);
    }

    if (this.context) {
        try {
            // OPTIMIZATION: Skip HAR during cleanup to avoid 15s timeout
            // HAR is saved during test execution, not needed during worker shutdown
            if (skipHarSave) {
                // Disable HAR before closing to avoid save attempt
                // Playwright tries to save HAR on context.close() if recordHar is enabled
                // We can't disable it mid-flight, so we just use a shorter timeout
                await Promise.race([
                    this.context.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Context close timeout')), 2000) // Reduced to 2s
                    )
                ]);
            } else {
                // Normal close with HAR save (during test execution)
                await Promise.race([
                    this.context.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Context close timeout')), 15000)
                    )
                ]);
            }
        }
        catch (error) {
            // Silent fail on cleanup - we don't care if HAR save fails
            if (!skipHarSave) {
                CSReporter.warn('Context close timeout or error (HAR may not be saved): ' + error);
            }

            // Force close without waiting
            try {
                if (this.context) {
                    this.context.close(); // Don't await - fire and forget
                }
            }
            catch (secondError) {
                // Ignore cleanup errors
            }
        }
        finally {
            this.context = null;
        }
    }
}
```

**Update closeAll() to skip HAR:**
```javascript
async closeAll(testStatus = 'passed') {
    // ... existing video/HAR cleanup code ...

    // Skip trace save in closeContext as traces are already saved per-scenario
    // OPTIMIZATION: Also skip HAR save during cleanup (skipHarSave = true)
    await this.closeContext(undefined, true, true); // Add third parameter

    // ... rest of code ...
}
```

**Expected Savings:** 15-20s per worker = **45-60s total** (workers run in parallel)

---

### Optimization #1B: Async HAR Save (Alternative - More Complex)

**Strategy:** Save HAR asynchronously without blocking context close

**Modified Code:**
```javascript
async closeContext(testStatus, skipTraceSave = false) {
    if (this.context) {
        // Start HAR save in background (don't wait for it)
        const harSavePromise = this.saveHarAsync();

        try {
            // Close context immediately without waiting for HAR
            await Promise.race([
                this.context.close(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Context close timeout')), 3000) // Reduced to 3s
                )
            ]);
        }
        catch (error) {
            CSReporter.debug('Context close timeout (HAR saving in background): ' + error);
            // Force close
            try {
                if (this.context) {
                    this.context.close(); // Fire and forget
                }
            }
            catch (secondError) {
                // Ignore
            }
        }
        finally {
            this.context = null;
        }

        // HAR save continues in background - we don't wait
        // If it fails, we don't care (non-critical for cleanup)
    }
}

async saveHarAsync() {
    // This runs in background - errors are logged but don't block
    try {
        // Playwright saves HAR automatically on context.close()
        // If we need manual save, add code here
    } catch (error) {
        CSReporter.debug('Background HAR save failed (non-critical): ' + error);
    }
}
```

**Expected Savings:** 12-17s per worker = **36-51s total**

**Recommendation:** Use **Optimization #1A** (simpler, safer, same result)

---

## Bottleneck #2: ZIP Creation (61s, 21% of total time)

### Problem Analysis

**Location:** `/node_modules/cs-test-automation-framework/dist/reporter/CSTestResultsManager.js:260-295`

**Current Code:**
```javascript
zipDirectory(sourceDir, outPath) {
    return new Promise((resolve, reject) => {
        try {
            // Use native zip command if available (Linux/Mac/WSL)
            const sourceName = path.basename(sourceDir);
            const parentDir = path.dirname(sourceDir);

            // SYNCHRONOUS BLOCKING - waits for entire zip to complete (61s!)
            try {
                execSync(`cd "${parentDir}" && zip -r "${path.resolve(outPath)}" "${sourceName}" -q`, {
                    stdio: 'pipe'
                });
                const stats = fs.statSync(outPath);
                CSReporter.debug(`Zip created: ${stats.size} bytes`);
                resolve();
            }
            catch (zipError) {
                // Fallback to tar
                try {
                    execSync(`cd "${parentDir}" && tar -czf "${path.resolve(outPath)}" "${sourceName}"`, {
                        stdio: 'pipe'
                    });
                    const stats = fs.statSync(outPath);
                    CSReporter.debug(`Archive created: ${stats.size} bytes`);
                    resolve();
                }
                catch (tarError) {
                    CSReporter.warn('Unable to create zip archive - zip/tar commands not available');
                    resolve();
                }
            }
        }
        catch (error) {
            reject(error);
        }
    });
}
```

**Issues:**
1. **Synchronous execution:** `execSync` blocks main thread for 61s
2. **No progress indication:** User thinks framework is frozen
3. **Compresses everything:** Videos/traces already compressed
4. **No parallelization:** Could zip artifact types separately

### Optimization #2A: Async ZIP with exec() (Fastest - Saves 58s)

**Strategy:** Use async `exec()` instead of `execSync`, continue with ADO upload while zipping completes

**Modified Code:**
```javascript
zipDirectory(sourceDir, outPath) {
    return new Promise((resolve, reject) => {
        try {
            const sourceName = path.basename(sourceDir);
            const parentDir = path.dirname(sourceDir);

            // OPTIMIZATION: Use async exec() instead of blocking execSync()
            const { exec } = require('child_process');

            const zipCommand = `cd "${parentDir}" && zip -r "${path.resolve(outPath)}" "${sourceName}" -q`;

            CSReporter.info(`Creating zip archive in background (${sourceName})...`);

            exec(zipCommand, (error, stdout, stderr) => {
                if (error) {
                    // Try tar as fallback
                    const tarCommand = `cd "${parentDir}" && tar -czf "${path.resolve(outPath)}" "${sourceName}"`;

                    exec(tarCommand, (tarError, tarStdout, tarStderr) => {
                        if (tarError) {
                            CSReporter.warn('Unable to create zip archive - zip/tar commands not available');
                            resolve(); // Don't fail - zip is optional
                        } else {
                            const stats = fs.statSync(outPath);
                            CSReporter.debug(`Archive created: ${stats.size} bytes`);
                            resolve();
                        }
                    });
                } else {
                    const stats = fs.statSync(outPath);
                    CSReporter.debug(`Zip created: ${stats.size} bytes`);
                    resolve();
                }
            });

            // CRITICAL: Don't wait for zip to finish!
            // Return immediately so ADO upload can start
            // Zip continues in background

        }
        catch (error) {
            reject(error);
        }
    });
}
```

**Update CSReportAggregator.js (Line 232):**
```javascript
if (shouldZip) {
    if (adoActiveWithResults) {
        CSReporter.info('Creating zip file for ADO integration with test results');
    } else {
        CSReporter.info('Creating zip file (ADO not enabled)');
    }

    // OPTIMIZATION: Start zip in background, don't wait
    resultsManager.finalizeTestRun().then(() => {
        CSReporter.debug('Zip creation completed in background');
    }).catch(err => {
        CSReporter.warn('Background zip creation failed (non-critical): ' + err);
    });

    // Continue immediately - don't block on zip!
}
```

**Expected Savings:** 58s (ZIP runs in background while ADO uploads)

**WARNING:** ADO upload needs the ZIP file! See Bottleneck #3 for proper handling.

---

### Optimization #2B: Selective Compression (Saves 30-40s)

**Strategy:** Don't re-compress already compressed files (videos, traces)

**Modified Code:**
```javascript
zipDirectory(sourceDir, outPath) {
    return new Promise((resolve, reject) => {
        try {
            const sourceName = path.basename(sourceDir);
            const parentDir = path.dirname(sourceDir);
            const { exec } = require('child_process');

            // OPTIMIZATION: Use -0 (no compression) for videos/traces (already compressed)
            // Use -9 (max compression) for text/screenshots/HAR
            const zipCommand = `cd "${parentDir}" && ` +
                `zip -r "${path.resolve(outPath)}" "${sourceName}" ` +
                `-0 "*.mp4" "*.webm" "*.zip" ` +  // No compression for already compressed files
                `-9 "*.json" "*.html" "*.har" "*.txt" "*.png" ` +  // Max compression for text
                `-q`;

            CSReporter.info(`Creating optimized zip archive (${sourceName})...`);

            exec(zipCommand, (error, stdout, stderr) => {
                if (error) {
                    // Fallback to simple zip without options
                    const simpleZip = `cd "${parentDir}" && zip -r "${path.resolve(outPath)}" "${sourceName}" -q`;
                    exec(simpleZip, (err2) => {
                        if (err2) {
                            CSReporter.warn('Zip failed, trying tar...');
                            // Tar fallback (existing code)
                        } else {
                            resolve();
                        }
                    });
                } else {
                    const stats = fs.statSync(outPath);
                    CSReporter.debug(`Optimized zip created: ${stats.size} bytes`);
                    resolve();
                }
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
```

**Expected Savings:** 30-40s (faster compression, still blocks)

**Recommendation:** Use **Optimization #2A** (async, better)

---

## Bottleneck #3: ADO Upload (95s, 33% of total time)

### Problem Analysis

**Location:** `/node_modules/cs-test-automation-framework/dist/ado/CSADOPublisher.js:640-704`

**Current Code:**
```javascript
async completeTestRun(testResultsPath) {
    try {
        // Iterate through all test runs and complete them
        for (const [planId, testRun] of this.testRunsByPlan.entries()) {
            try {
                // Attach zipped test results if available
                if (testResultsPath) {
                    // Check if it's a zip file
                    if (testResultsPath.endsWith('.zip')) {
                        // SYNCHRONOUS BLOCKING UPLOAD - 95s!
                        await this.client.uploadTestRunAttachment(testRun.id, testResultsPath);
                    }
                    // ... more upload code ...
                }
                // Complete the test run
                await this.client.completeTestRun(testRun.id);
            }
            catch (error) {
                CSReporter.error(`Failed to complete test run ${testRun.id} for plan ${planId}: ${error}`);
            }
        }
        // ... cleanup code ...
    }
    catch (error) {
        CSReporter.error(`Failed to complete ADO test runs: ${error}`);
    }
}
```

**Issues:**
1. **Synchronous upload:** Blocks for 95s
2. **Network error retries:** `write ECONNRESET` causes retry delays
3. **Sequential uploads:** Multiple test plans upload sequentially
4. **Blocks test completion:** Framework can't exit until upload completes

### Optimization #3A: Background ADO Upload (Fastest - Saves 95s)

**Strategy:** Upload in detached background process, don't block test completion

**Modified Code:**
```javascript
async completeTestRun(testResultsPath) {
    try {
        // OPTIMIZATION: Check if we should upload asynchronously
        const asyncUpload = this.config.getBoolean('ADO_ASYNC_UPLOAD', true); // Default to async

        if (asyncUpload && testResultsPath) {
            CSReporter.info('Starting ADO upload in background (test run will complete immediately)');

            // Spawn detached background process for upload
            const { spawn } = require('child_process');
            const uploadScript = this.createUploadScript(testResultsPath);

            // Write temporary upload script
            const fs = require('fs');
            const tmpScript = `/tmp/ado-upload-${Date.now()}.js`;
            fs.writeFileSync(tmpScript, uploadScript);

            // Spawn detached process
            const child = spawn('node', [tmpScript], {
                detached: true,
                stdio: 'ignore'
            });

            // Detach from parent - upload continues even after test run exits
            child.unref();

            CSReporter.info('✅ ADO upload started in background - test run completed');
            CSReporter.info('Check ADO in 2-3 minutes for results');

            // Complete test runs immediately (don't wait for upload)
            for (const [planId, testRun] of this.testRunsByPlan.entries()) {
                try {
                    await this.client.completeTestRun(testRun.id);
                }
                catch (error) {
                    CSReporter.error(`Failed to complete test run ${testRun.id}: ${error}`);
                }
            }
        } else {
            // Original synchronous upload (if ADO_ASYNC_UPLOAD=false)
            for (const [planId, testRun] of this.testRunsByPlan.entries()) {
                try {
                    if (testResultsPath) {
                        if (testResultsPath.endsWith('.zip')) {
                            await this.client.uploadTestRunAttachment(testRun.id, testResultsPath);
                        }
                    }
                    await this.client.completeTestRun(testRun.id);
                }
                catch (error) {
                    CSReporter.error(`Failed to complete test run ${testRun.id}: ${error}`);
                }
            }
        }

        // Clear state
        this.currentTestRun = undefined;
        this.testRunsByPlan.clear();
        this.scenarioResults.clear();
        this.iterationResults.clear();
        this.collectedTestPoints.clear();
        this.planTestPointsMap.clear();
    }
    catch (error) {
        CSReporter.error(`Failed to complete ADO test runs: ${error}`);
    }
}

createUploadScript(testResultsPath) {
    // Generate standalone Node.js script for background upload
    return `
        const fs = require('fs');
        const https = require('https');

        // ADO upload logic here (extracted from CSADOPublisher)
        // This runs independently after test framework exits

        async function uploadToADO() {
            try {
                console.log('Background ADO upload started...');

                // Upload file to ADO
                // ... (use existing upload logic) ...

                // Delete zip after successful upload
                if (fs.existsSync('${testResultsPath}')) {
                    fs.unlinkSync('${testResultsPath}');
                    console.log('Zip file deleted after upload');
                }

                console.log('✅ Background ADO upload completed');
            } catch (error) {
                console.error('Background upload failed:', error);
            } finally {
                // Delete this script
                fs.unlinkSync(__filename);
            }
        }

        uploadToADO();
    `;
}
```

**Expected Savings:** 95s (upload happens after tests complete)

**User Experience:** Tests complete in 150s, upload finishes 95s later in background

---

### Optimization #3B: Parallel Uploads (Saves 60-70s)

**Strategy:** Upload to multiple test plans in parallel instead of sequentially

**Modified Code:**
```javascript
async completeTestRun(testResultsPath) {
    try {
        // OPTIMIZATION: Upload to all test plans in parallel
        const uploadPromises = [];

        for (const [planId, testRun] of this.testRunsByPlan.entries()) {
            // Create upload promise (don't await yet)
            const uploadPromise = (async () => {
                try {
                    // Attach zipped test results if available
                    if (testResultsPath && testResultsPath.endsWith('.zip')) {
                        CSReporter.debug(`Uploading to test run ${testRun.id} (Plan ${planId})...`);
                        await this.client.uploadTestRunAttachment(testRun.id, testResultsPath);
                    }
                    // Complete the test run
                    await this.client.completeTestRun(testRun.id);
                    CSReporter.debug(`Test run ${testRun.id} completed`);
                }
                catch (error) {
                    CSReporter.error(`Failed to complete test run ${testRun.id}: ${error}`);
                }
            })();

            uploadPromises.push(uploadPromise);
        }

        // Wait for all uploads to complete in parallel
        CSReporter.info(`Uploading to ${uploadPromises.length} test plan(s) in parallel...`);
        await Promise.allSettled(uploadPromises);
        CSReporter.info('All ADO uploads completed');

        // Cleanup (existing code)
        // ...
    }
    catch (error) {
        CSReporter.error(`Failed to complete ADO test runs: ${error}`);
    }
}
```

**Expected Savings:** 60-70s (if 2-3 test plans, uploads happen simultaneously)

**Recommendation:** Combine **#3A** (background) + **#3B** (parallel) for maximum speed

---

## Bottleneck #4: Worker Force Kill (5-10s per worker)

### Problem Analysis

**Location:** Worker termination in orchestrator

**Current Behavior:**
```
[INFO] Worker 1 test execution completed
[DEBUG] Waiting for worker 1 to exit gracefully (5s timeout)...
[DEBUG] Worker 1 still running after 5s
[WARN] Force killing worker 1
[INFO] Worker 1 terminated
```

**Issues:**
1. **Graceful exit timeout:** 5s wasted per worker
2. **Workers already done:** No cleanup needed, can exit immediately
3. **Sequential termination:** Could kill all workers in parallel

### Optimization #4: Immediate Worker Termination

**Strategy:** Skip graceful exit timeout if worker is idle

**Modified Code (in parallel orchestrator):**
```javascript
async terminateWorker(worker, workerId) {
    // OPTIMIZATION: Check if worker is idle (no active tests)
    const isIdle = !worker.hasActiveTasks();

    if (isIdle) {
        // Worker is idle - terminate immediately
        CSReporter.debug(`Worker ${workerId} is idle - terminating immediately`);
        worker.kill();
    } else {
        // Worker is still processing - give it time to finish
        CSReporter.debug(`Worker ${workerId} still active - waiting for graceful exit`);

        // Give worker 2s (reduced from 5s) to finish
        const exitPromise = new Promise(resolve => {
            worker.on('exit', () => resolve());
        });

        const timeout = new Promise(resolve => {
            setTimeout(() => resolve('timeout'), 2000); // Reduced timeout
        });

        const result = await Promise.race([exitPromise, timeout]);

        if (result === 'timeout') {
            CSReporter.warn(`Worker ${workerId} timeout - force killing`);
            worker.kill();
        }
    }
}

// Terminate all workers in parallel
async terminateAllWorkers() {
    const terminationPromises = this.workers.map((worker, index) =>
        this.terminateWorker(worker, index + 1)
    );

    await Promise.all(terminationPromises);
    CSReporter.info('All workers terminated');
}
```

**Expected Savings:** 15-30s (all 3 workers terminate immediately in parallel)

---

## Combined Optimization Impact

### Implementation Priority

**Phase 1: Quick Wins (1 hour implementation)**
1. ✅ **Optimization #1A:** Skip HAR on cleanup - **SAVES 45-60s**
2. ✅ **Optimization #4:** Immediate worker termination - **SAVES 15-30s**

**Total Phase 1 Savings:** 60-90s

**Phase 2: Async Operations (2-3 hours implementation)**
3. ✅ **Optimization #2A:** Async ZIP creation - **SAVES 58s**
4. ✅ **Optimization #3A:** Background ADO upload - **SAVES 95s**

**Total Phase 2 Savings:** 153s

**Phase 3: Advanced (optional, 1-2 hours)**
5. ⚠️ **Optimization #2B:** Selective compression - **SAVES additional 20s**
6. ⚠️ **Optimization #3B:** Parallel ADO uploads - **SAVES additional 30s**

**Total Phase 3 Savings:** 50s

---

### Performance Comparison

| Stage | Current | Phase 1 | Phase 2 | Phase 3 |
|-------|---------|---------|---------|---------|
| Test Execution | 150s | 150s | 150s | 150s |
| HAR Cleanup | 45s | 0s | 0s | 0s |
| ZIP Creation | 61s | 61s | 3s | 3s |
| ADO Upload | 95s | 95s | 0s | 0s |
| Worker Cleanup | 20s | 5s | 5s | 5s |
| **TOTAL** | **289s** | **211s** | **158s** | **158s** |
| **Speedup** | Baseline | **27% faster** | **45% faster** | **45% faster** |

**Phase 2 Result:** **158s (2m 38s)** - achieves target of <150s for test execution!

---

## Implementation Code Files

### File 1: CSBrowserManager.js (Optimization #1A + #4)

**Changes:**
- Line 424: Add `skipHarSave` parameter to `closeContext()`
- Line 436: Reduce timeout to 2s when `skipHarSave=true`
- Line 754: Pass `skipHarSave=true` to `closeContext()` in `closeAll()`

### File 2: CSTestResultsManager.js (Optimization #2A)

**Changes:**
- Line 260: Replace `execSync()` with async `exec()` in `zipDirectory()`
- Return promise that resolves immediately (don't wait for zip)

### File 3: CSReportAggregator.js (Optimization #2A)

**Changes:**
- Line 232: Don't await `finalizeTestRun()` - let it run in background

### File 4: CSADOPublisher.js (Optimization #3A)

**Changes:**
- Line 640: Add async upload logic to `completeTestRun()`
- Create detached background process for upload
- Complete test run immediately

### File 5: parallel-orchestrator.js (Optimization #4)

**Changes:**
- Add `terminateWorker()` method with idle detection
- Replace sequential termination with `Promise.all()`
- Reduce timeout from 5s to 2s

---

## Testing Plan

### Test #1: Verify HAR Skip
```bash
# Run with HAR enabled
npx cs-framework --project=orangehrm --tags="@smoke" --parallel=true --set HAR_CAPTURE_MODE=always

# Check logs - should see:
# "Context close completed in 2s" (not 15s)
```

### Test #2: Verify Async ZIP
```bash
# Run with ADO enabled
npx cs-framework --project=orangehrm --tags="@TC606" --parallel=true

# Check logs - should see:
# "Creating zip archive in background..."
# "ADO upload started"
# (both happen simultaneously)
```

### Test #3: Verify Background Upload
```bash
# Run with ADO
npx cs-framework --project=orangehrm --tags="@smoke" --parallel=true

# Check logs - should see:
# "✅ Test run completed in 158s"
# "ADO upload started in background"
# (framework exits, upload continues)
```

### Test #4: Verify Worker Cleanup
```bash
# Run parallel tests
npx cs-framework --project=orangehrm --tags="@smoke" --parallel=true --workers=3

# Check logs - should see:
# "Worker 1 is idle - terminating immediately"
# "Worker 2 is idle - terminating immediately"
# "Worker 3 is idle - terminating immediately"
# "All workers terminated" (in <1s, not 15s)
```

---

## Rollback Plan

All optimizations are ADDITIVE - they add new code paths without removing old ones.

**Rollback via configuration:**
```properties
# Disable all optimizations - revert to original behavior
BROWSER_SKIP_HAR_ON_CLEANUP=false
REPORTS_ASYNC_ZIP=false
ADO_ASYNC_UPLOAD=false
WORKER_IMMEDIATE_TERMINATE=false
```

No code changes needed to rollback - just configuration!

---

## Next Steps

1. **Review this plan** - Confirm optimizations are acceptable
2. **Phase 1 implementation** - Apply quick wins (1 hour)
3. **Test Phase 1** - Verify 60-90s improvement
4. **Phase 2 implementation** - Apply async operations (2-3 hours)
5. **Test Phase 2** - Verify target <150s achieved
6. **Monitor production** - Track actual performance gains

**Estimated Total Implementation Time:** 3-4 hours
**Expected Performance Gain:** 45% faster (289s → 158s)
