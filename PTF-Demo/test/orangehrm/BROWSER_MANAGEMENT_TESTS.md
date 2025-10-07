# Browser Management Enhancement Tests

## Overview
This document describes the test scenarios for the new browser management features:
1. **Browser Switching** - Switch between different browsers during test execution
2. **Context Clearing** - Clear browser context for re-authentication (multi-user workflows)

## Test File
📁 `test/orangehrm/features/browser-management-enhancements.feature`

## Prerequisites
- OrangeHRM demo site: https://opensource-demo.orangehrmlive.com
- Browsers installed: Chrome, Edge, Firefox (optional: Safari/Webkit)
- Framework configuration in `config/global.env`

## Configuration

### For Sequential Execution
```env
# config/global.env or test/orangehrm/config/orangehrm.env
BROWSER=chrome
HEADLESS=false
BROWSER_REUSE_ENABLED=true
PARALLEL=false
```

### For Parallel Execution
```env
BROWSER=chrome
HEADLESS=false
BROWSER_REUSE_ENABLED=true
PARALLEL=true
PARALLEL_WORKERS=3
```

## Running Tests

### Run All Browser Management Tests
```bash
# Sequential execution
npx cs-framework --project orangehrm --tags "@browser-management"

# Parallel execution
npx cs-framework --project orangehrm --tags "@browser-management" --parallel
```

### Run Specific Test Categories

#### Browser Switching Tests Only
```bash
npx cs-framework --project orangehrm --tags "@browser-switching"
```

#### Context Clearing Tests Only
```bash
npx cs-framework --project orangehrm --tags "@context-clearing"
```

#### Multi-User Workflow Tests
```bash
npx cs-framework --project orangehrm --tags "@multi-user"
```

#### Combined Tests (Browser Switching + Context Clearing)
```bash
npx cs-framework --project orangehrm --tags "@combined"
```

#### Parallel Safety Tests
```bash
npx cs-framework --project orangehrm --tags "@parallel-safe" --parallel
```

### Run Specific Scenarios

#### Test Browser Switching (Chrome to Edge)
```bash
npx cs-framework --project orangehrm --tags "@TC601"
```

#### Test Multi-User Workflow
```bash
npx cs-framework --project orangehrm --tags "@TC606"
```

#### Test Combined Workflow
```bash
npx cs-framework --project orangehrm --tags "@TC611"
```

## Test Scenarios Summary

### Browser Switching Tests (TC601-TC605)
| Test ID | Description | Key Validation |
|---------|-------------|----------------|
| TC601 | Chrome to Edge switching | Session preserved, URL maintained |
| TC602 | Browser switch with state preservation | Logged-in state maintained |
| TC603 | Browser switch with state clearing | State cleared, requires re-login |
| TC604 | Browser switch without URL preservation | Fresh browser, no navigation |
| TC605 | Cross-browser testing (Chrome, Edge, Firefox) | Same functionality across browsers |

### Context Clearing Tests (TC606-TC610)
| Test ID | Description | Key Validation |
|---------|-------------|----------------|
| TC606 | Clear context and re-authenticate | Context cleared, navigates to BASE_URL |
| TC607 | Multi-user approval workflow | Simulates requester → approver flow |
| TC608 | Clear context with custom URL | Navigates to specific login URL |
| TC609 | Clear context without navigation | Context cleared, manual navigation |
| TC610 | Data isolation verification | Browser context cleared, scenario context intact |

### Combined Tests (TC611-TC613)
| Test ID | Description | Key Validation |
|---------|-------------|----------------|
| TC611 | Browser switch + context clear | Complete isolation between sessions |
| TC612 | Multi-browser multi-user workflow | Independent sessions across browsers |
| TC613 | Context clearing with browser reuse | Browser alive, context refreshed |

### Parallel Execution Safety Tests (TC614-TC615)
| Test ID | Description | Key Validation |
|---------|-------------|----------------|
| TC614 | Browser switching in parallel | Each worker switches independently |
| TC615 | Context clearing in parallel | Each worker has independent context |

## Expected Behavior

### Browser Switching
✅ **What Should Happen:**
- Browser closes gracefully
- New browser launches
- URL is preserved (unless `without preserving URL` option used)
- Session state preserved (unless `and clears state` option used)
- Works with browser reuse enabled

❌ **What Should NOT Happen:**
- Browser crash
- Loss of test data
- Interference between parallel workers

### Context Clearing
✅ **What Should Happen:**
- Browser context cleared (cookies, localStorage, sessionStorage, cache)
- Navigates to BASE_URL (or custom loginUrl if specified)
- Browser instance stays alive (for performance)
- Ready for re-authentication immediately
- Works with browser reuse enabled

❌ **What Should NOT Happen:**
- Browser closes
- Test data in scenario context lost
- Navigation fails

## Real-World Use Cases

### Use Case 1: Cross-Browser Compatibility Testing
Test the same feature across Chrome, Edge, and Firefox in a single scenario.

```gherkin
Scenario: Verify checkout works across all browsers
  Given user is on product page
  When user adds item to cart
  And user switches to "edge" browser
  Then cart should still have the item
  When user proceeds to checkout
  Then checkout should complete successfully

  # Test same flow in Firefox
  When user switches to "firefox" browser and clears state
  And user navigates to product page
  # Repeat test...
```

### Use Case 2: Multi-Role Approval Workflow
Test end-to-end approval process with different user roles.

```gherkin
Scenario: Purchase request approval workflow
  # Requester submits
  Given user logs in as "requester@company.com"
  When user creates purchase request for "$5000"
  And user saves request ID as "requestId"

  # L1 Manager approves
  When user clears browser context for re-authentication
  And user logs in as "manager@company.com"
  And user approves request "{requestId}"

  # L2 Director approves
  When user clears browser context for re-authentication
  And user logs in as "director@company.com"
  And user final approves request "{requestId}"

  # Finance processes
  When user clears browser context for re-authentication
  And user logs in as "finance@company.com"
  Then request "{requestId}" should be "Processed"
```

### Use Case 3: Session Isolation Testing
Test that user sessions don't interfere with each other.

```gherkin
Scenario: Verify session isolation between users
  Given user logs in as "user1@test.com"
  When user adds item to wishlist
  And user saves wishlist count as "user1Count"

  # Switch user completely
  When user clears browser context for re-authentication
  And user logs in as "user2@test.com"
  Then wishlist should be empty
  And wishlist count should NOT equal "{user1Count}"
```

## Troubleshooting

### Browser Not Switching
**Problem:** Browser doesn't switch
**Solution:** Check that browser is installed and accessible

### Context Not Clearing
**Problem:** Still logged in after clearing context
**Solution:** Verify BASE_URL is configured in global.env

### Tests Fail in Parallel
**Problem:** Tests interfere with each other in parallel mode
**Solution:** Each worker has independent browser/context - check for shared state issues

### Video/Screenshots Not Captured
**Problem:** Artifacts not saved during browser switches
**Solution:** Artifacts are saved when context closes - this is expected behavior

## Performance Notes

### Browser Reuse Impact
- **With Browser Reuse ON**: Browser stays alive, context is refreshed (~500ms)
- **With Browser Reuse OFF**: Browser closes and relaunches (~2-3s)

### Browser Switching Impact
- **Same Browser Type**: ~500ms (just creates new context)
- **Different Browser Type**: ~3-5s (launches new browser)

### Context Clearing Impact
- **Context Close**: ~200-500ms
- **Context Create**: ~200-500ms
- **Navigation to LOGIN**: ~1-2s
- **Total**: ~2-3s per context clear

## Best Practices

1. **Use Browser Switching For:**
   - Cross-browser compatibility testing
   - Testing browser-specific behaviors
   - Visual regression across browsers

2. **Use Context Clearing For:**
   - Multi-user workflows
   - Approval/authorization testing
   - Session isolation testing
   - Permission-based testing

3. **Performance Optimization:**
   - Enable `BROWSER_REUSE_ENABLED=true` for faster execution
   - Use `skipNavigation: true` if you'll navigate manually
   - Batch browser switches (don't switch back and forth unnecessarily)

4. **Parallel Execution:**
   - Both features are thread-safe
   - Each worker has independent browser/context
   - No special configuration needed

## Framework Integration

These features are available:
- ✅ In step definitions (via CSCommonSteps)
- ✅ In page objects (via CSBrowserManager)
- ✅ In custom steps (via CSBrowserManager)
- ✅ In hooks (Before/After scenarios)

```typescript
// Example: In custom step definition
import { CSBrowserManager } from 'cs-test-automation-framework';

const browserManager = CSBrowserManager.getInstance();

// Switch browser
await browserManager.switchBrowser('edge', {
  preserveUrl: true,
  clearState: false
});

// Clear context
await browserManager.clearContextAndReauthenticate({
  loginUrl: 'https://app.example.com/login'
});
```

## Support

For issues or questions:
1. Check test execution logs in `reports/`
2. Review artifacts (screenshots, videos, traces)
3. Verify browser installations
4. Check framework version compatibility

---

**Note:** These tests are part of the framework's test suite and are excluded from npm packaging (configured in `.npmignore`).
