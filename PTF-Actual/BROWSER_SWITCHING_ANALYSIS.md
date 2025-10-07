# Browser Switching Enhancement - Analysis & Fix

## Problem Statement

The current browser switching implementation has **inconsistent behavior** between:
1. **Between-scenarios cleanup** (when `BROWSER_REUSE_ENABLED=true`)
2. **`switchBrowser()` method** (switching to same browser)
3. **`clearContextAndReauthenticate()` method**

---

## Current Behavior Analysis

### 1. Between-Scenarios Cleanup (BROWSER_REUSE_ENABLED=true, BROWSER_REUSE_CLEAR_STATE=true)

**Location:** `CSBDDRunner.ts:2207-2235`

**What it does:**
```typescript
// Step 1: Navigate to about:blank
await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });

// Step 2: Clear cookies at CONTEXT level (no context recreation)
await context.clearCookies();

// Step 3: Clear permissions
await context.clearPermissions();

// Step 4: Clear localStorage/sessionStorage
await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
});

// Step 5: Clear saved browser state
this.browserManager.clearBrowserState();
```

**Result:** ✅ Clean state, context NOT recreated, browser NOT closed

---

### 2. switchBrowser() - Same Browser Type

**Location:** `CSBrowserManager.ts:1090-1094`

**Current Code:**
```typescript
// If switching to same browser type, just clear state if requested
if (this.currentBrowserType === browserType && !clearState) {
    CSReporter.info(`Already using ${browserType}, no switch needed`);
    return;  // ← EXITS WITHOUT CLEARING!
}
```

**Problem:** When `clearState=true` and switching to SAME browser:
- Code continues past this check
- Lines 1100-1107: **Closes page and context!**
- Lines 1109-1121: Tries to close browser (but doesn't because same type)
- Line 1124: Calls `launch()` which creates new context/page

**Result:** ❌ Context IS recreated (inconsistent with between-scenarios behavior)

---

### 3. clearContextAndReauthenticate()

**Location:** `CSBrowserManager.ts:1194-1217`

**Current Code:**
```typescript
// Close current page
if (this.page) {
    await this.closePage();  // ← CLOSES page
}

// Close current context (saves artifacts)
if (this.context) {
    await this.closeContext('passed');  // ← CLOSES and RECREATES context
}

// Create fresh context
await this.createContext();  // ← NEW context (artifacts restart!)

// Create fresh page
await this.createPage();

// Restart trace if browser reuse enabled
if (browserReuseEnabled) {
    await this.restartTraceForNextScenario();
}
```

**Problem:**
- Closes and recreates context (causes video/HAR/trace to stop/start)
- Visual "flash" as browser artifacts restart
- Inconsistent with between-scenarios cleanup

**Result:** ❌ Context IS recreated (should mirror between-scenarios cleanup)

---

## Expected Behavior (Corrected)

### Scenario 1: BROWSER_REUSE_ENABLED=true + switchBrowser(SAME browser)

**Expected:**
```
1. Keep browser open
2. Keep context open
3. Navigate to about:blank
4. Clear cookies (context.clearCookies())
5. Clear permissions
6. Clear localStorage/sessionStorage
7. Clear saved state
8. Navigate to target URL if preserveUrl=true
```

**Result:** Clean state, NO context recreation, NO browser close/reopen

---

### Scenario 2: BROWSER_REUSE_ENABLED=false + switchBrowser(SAME browser)

**Expected:**
```
1. Close current page
2. Close current context
3. Close browser
4. Launch new browser
5. Create new context
6. Create new page
7. Navigate to target URL if preserveUrl=true
```

**Result:** Full restart, context recreated, browser closed/reopened

---

### Scenario 3: BROWSER_REUSE_ENABLED=true + clearContextAndReauthenticate()

**Expected:**
```
1. Keep browser open
2. Keep context open
3. Navigate to about:blank
4. Clear cookies (context.clearCookies())
5. Clear permissions
6. Clear localStorage/sessionStorage
7. Clear saved state
8. Navigate to loginUrl
```

**Result:** Clean state, NO context recreation, NO browser close/reopen

---

### Scenario 4: BROWSER_REUSE_ENABLED=false + clearContextAndReauthenticate()

**Expected:**
```
1. Close current page
2. Close current context
3. Create fresh context
4. Create fresh page
5. Navigate to loginUrl
```

**Result:** Context recreated (browser stays open, just context refresh)

---

## Code Changes Required

### Fix 1: Update switchBrowser() for Same Browser Type

**File:** `src/browser/CSBrowserManager.ts:1090-1145`

**Change:**
```typescript
// If switching to same browser type
if (this.currentBrowserType === browserType) {
    // Check if we need to clear state
    if (!clearState) {
        CSReporter.info(`Already using ${browserType}, no switch needed`);
        return;
    }

    // Clear state - behavior depends on BROWSER_REUSE_ENABLED
    const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

    if (browserReuseEnabled) {
        // REUSE MODE: Clear state WITHOUT recreating context (like between-scenarios)
        CSReporter.info(`Switching to same browser (${browserType}) - clearing state (reuse mode)`);
        await this.clearStateWithoutRecreatingContext(currentUrl, preserveUrl);
    } else {
        // NON-REUSE MODE: Full restart (close and recreate)
        CSReporter.info(`Switching to same browser (${browserType}) - full restart (non-reuse mode)`);
        await this.closePage();
        await this.closeContext('passed');
        await this.closeBrowser();
        await this.launch(browserType);

        // Navigate to previous URL if requested
        if (preserveUrl && currentUrl && this.page) {
            await this.page.goto(currentUrl, {
                waitUntil: 'domcontentloaded',
                timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
            });
        }
    }

    CSReporter.info(`Successfully switched to ${browserType} browser (same type)`);
    return;
}

// Continue with different browser type logic...
```

---

### Fix 2: Update clearContextAndReauthenticate()

**File:** `src/browser/CSBrowserManager.ts:1177-1249`

**Change:**
```typescript
public async clearContextAndReauthenticate(options?: {
    loginUrl?: string;
    skipNavigation?: boolean;
    waitForNavigation?: boolean;
}): Promise<void> {
    const {
        loginUrl,
        skipNavigation = false,
        waitForNavigation = true
    } = options || {};

    if (!this.browser) {
        throw new Error('No browser instance available. Call launch() first.');
    }

    CSReporter.info('Clearing browser context for re-authentication');

    // Check browser reuse setting
    const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

    if (browserReuseEnabled) {
        // REUSE MODE: Clear state WITHOUT recreating context (like between-scenarios)
        CSReporter.info('Browser reuse enabled - clearing state without recreating context');

        if (!this.page || !this.context) {
            throw new Error('No page or context available');
        }

        // Navigate to about:blank to leave current app
        CSReporter.debug('Navigating to about:blank...');
        await this.page.goto('about:blank', {
            waitUntil: 'domcontentloaded',
            timeout: 5000
        });

        // Clear cookies at context level (no context recreation!)
        CSReporter.debug('Clearing cookies...');
        await this.context.clearCookies();

        // Clear permissions
        CSReporter.debug('Clearing permissions...');
        await this.context.clearPermissions();

        // Clear localStorage and sessionStorage
        CSReporter.debug('Clearing localStorage and sessionStorage...');
        await this.page.evaluate(() => {
            try {
                localStorage.clear();
                sessionStorage.clear();
            } catch (e) {
                // Ignore errors on about:blank
            }
        });

        // Clear saved browser state
        this.clearBrowserState();

        CSReporter.info('✓ Browser state cleared (context preserved)');

    } else {
        // NON-REUSE MODE: Recreate context for full clean state
        CSReporter.info('Browser reuse disabled - recreating context');

        // Close current page
        if (this.page) {
            await this.closePage();
        }

        // Close current context
        if (this.context) {
            await this.closeContext('passed');
        }

        // Create fresh context
        await this.createContext();

        // Create fresh page
        await this.createPage();

        CSReporter.info('✓ Fresh context created');
    }

    // Navigate to login URL unless skipNavigation is true
    if (!skipNavigation && this.page) {
        const targetUrl = loginUrl || this.config.get('BASE_URL');

        if (!targetUrl) {
            CSReporter.warn('No login URL provided and BASE_URL not configured. Skipping navigation.');
            return;
        }

        try {
            CSReporter.debug(`Navigating to login page: ${targetUrl}`);
            const navigationOptions: any = {
                timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
            };

            if (waitForNavigation) {
                navigationOptions.waitUntil = 'domcontentloaded';
            }

            await this.page.goto(targetUrl, navigationOptions);
            CSReporter.info(`Successfully navigated to login page: ${targetUrl}`);
        } catch (error: any) {
            CSReporter.warn(`Failed to navigate to login page: ${error.message}`);
            throw error;
        }
    } else {
        CSReporter.info('Context cleared successfully (navigation skipped).');
    }
}
```

---

### Fix 3: Add Helper Method clearStateWithoutRecreatingContext()

**File:** `src/browser/CSBrowserManager.ts` (new private method)

**Add:**
```typescript
/**
 * Clear browser state WITHOUT recreating context
 * Used for browser reuse mode to maintain artifacts (video/HAR/trace)
 * Mirrors the between-scenarios cleanup behavior
 */
private async clearStateWithoutRecreatingContext(
    previousUrl?: string | null,
    preserveUrl: boolean = true
): Promise<void> {
    if (!this.page || !this.context) {
        throw new Error('No page or context available');
    }

    CSReporter.debug('Clearing state without recreating context...');

    // Step 1: Navigate to about:blank to leave current app
    await this.page.goto('about:blank', {
        waitUntil: 'domcontentloaded',
        timeout: 5000
    });

    // Step 2: Clear cookies at context level (no context recreation!)
    await this.context.clearCookies();

    // Step 3: Clear permissions
    await this.context.clearPermissions();

    // Step 4: Clear localStorage and sessionStorage
    await this.page.evaluate(() => {
        try {
            localStorage.clear();
            sessionStorage.clear();
        } catch (e) {
            // Ignore errors on about:blank
        }
    });

    // Step 5: Clear saved browser state
    this.clearBrowserState();

    // Step 6: Navigate to previous URL if requested
    if (preserveUrl && previousUrl) {
        try {
            CSReporter.debug(`Navigating to previous URL: ${previousUrl}`);
            await this.page.goto(previousUrl, {
                waitUntil: 'domcontentloaded',
                timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
            });
        } catch (error: any) {
            CSReporter.warn(`Failed to navigate to previous URL: ${error.message}`);
        }
    }

    CSReporter.debug('✓ State cleared without recreating context');
}
```

---

## Summary of Changes

### Files Modified:
1. `src/browser/CSBrowserManager.ts`
   - Fix `switchBrowser()` method (lines 1090-1145)
   - Fix `clearContextAndReauthenticate()` method (lines 1177-1249)
   - Add new helper method `clearStateWithoutRecreatingContext()`

### Behavior Changes:

| Scenario | Old Behavior | New Behavior |
|----------|-------------|--------------|
| **switchBrowser(SAME) + REUSE=true** | Context recreated | Context preserved ✅ |
| **switchBrowser(SAME) + REUSE=false** | Context recreated | Browser fully restarted ✅ |
| **clearContext... + REUSE=true** | Context recreated | Context preserved ✅ |
| **clearContext... + REUSE=false** | Context recreated | Context recreated (same) ✅ |

### Benefits:
- ✅ **Consistent behavior** across all cleanup methods
- ✅ **No visual "flash"** when switching to same browser (reuse mode)
- ✅ **Artifacts preserved** (video/HAR/trace continuous)
- ✅ **Better performance** (no context recreation overhead)
- ✅ **Matches between-scenarios cleanup** (same code pattern)

---

**Status:** Ready for implementation
**Impact:** Medium (fixes inconsistency, no breaking changes)
**Testing Required:** Manual testing with browser switching scenarios
