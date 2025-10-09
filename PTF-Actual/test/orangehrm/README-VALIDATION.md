# 🧪 Zero-Code Framework Validation Tests

**Purpose**: Validate zero-code and AI features work correctly before publishing to ADO
**Status**: TEMPORARY - Will be removed after successful validation
**Framework Version**: 3.2.0

---

## ⚠️ IMPORTANT

**These tests are TEMPORARY and for FRAMEWORK VALIDATION ONLY.**

After successful validation:
1. ✅ Review test results
2. ✅ Confirm all features working
3. ❌ **DELETE this entire directory** (`test/orangehrm/`)
4. ❌ **DELETE the config** (`config/orangehrm/`)
5. ✅ Commit clean code to ADO

---

## 🎯 What We're Validating

### Zero-Code Feature
- ✅ Execute steps without step definitions
- ✅ NLP intent recognition (navigate, click, type, assert, wait)
- ✅ AI element identification
- ✅ Progressive enhancement (custom definitions → zero-code fallback)

### AI Platform
- ✅ AI healing activates for UI failures
- ✅ 8 healing strategies work correctly
- ✅ Locator extraction from errors
- ✅ Context detection (UI vs API vs Database)

### Parallel Execution
- ✅ Worker-isolated AI instances
- ✅ Zero interference between workers
- ✅ Proper cleanup

---

## 🚀 How to Run Tests

### Step 1: Build the Framework
```bash
cd /mnt/e/PTF-ADO
npm run build
```

### Step 2: Run Zero-Code Validation Tests

#### Option A: Run All Validation Tests
```bash
npm run cs-framework -- --project=orangehrm --tags=@framework-validation
```

#### Option B: Run Specific Test Categories

**Smoke Tests (Critical)**:
```bash
npm run cs-framework -- --project=orangehrm --tags=@zero-code --tags=@smoke
```

**Regression Tests**:
```bash
npm run cs-framework -- --project=orangehrm --tags=@zero-code --tags=@regression
```

**AI Healing + Zero-Code**:
```bash
npm run cs-framework -- --project=orangehrm --tags=@zero-code --tags=@ai-healing
```

**Parallel Execution Tests**:
```bash
npm run cs-framework -- --project=orangehrm --tags=@zero-code --tags=@parallel --parallel=3
```

#### Option C: Run Individual Tests
```bash
# TC901: Basic zero-code login
npm run cs-framework -- --project=orangehrm --tags=@TC901

# TC906: Zero-code + AI healing
npm run cs-framework -- --project=orangehrm --tags=@TC906

# TC909: Performance validation
npm run cs-framework -- --project=orangehrm --tags=@TC909
```

---

## 📊 Expected Results

### ✅ Tests That Should PASS

| Test ID | Description | Expected Result |
|---------|-------------|----------------|
| TC901 | Zero-code login | ✅ PASS |
| TC902 | Navigation & menu | ✅ PASS |
| TC903 | Visibility assertions | ✅ PASS |
| TC904 | Wait handling | ✅ PASS |
| TC905 | Comprehensive workflow | ✅ PASS |
| TC906 | Zero-code + AI healing | ✅ PASS |
| TC908 | Config validation | ✅ PASS |
| TC909 | Performance test | ✅ PASS (<10 sec) |
| TC910-TC912 | Parallel execution | ✅ ALL PASS |

### ❌ Tests That Should FAIL (Expected)

| Test ID | Description | Expected Result |
|---------|-------------|----------------|
| TC907 | Unsupported intent | ❌ FAIL (gracefully) with "Step definition not found" |

---

## 🔍 What to Check During Testing

### Console Logs to Look For

#### Zero-Code Activation
```
[ZeroCode] No step definition found, trying intelligent execution: When I click the Login button
[IntelligentStep] Executing: When I click the Login button
[IntelligentStep] NLP Intent: click, Element: button, Keywords: login, button
[IntelligentStep] ✅ Auto-executed: When I click the Login button
[ZeroCode] ✅ Clicked element: Login button
```

#### AI Healing (if element fails)
```
[AI] Attempting intelligent healing for failed step: When I click the Login button
[AI] Extracted locator from error: #loginButton
[Healer] Trying alternative locators strategy
[AIIntegration] ✅ Healing SUCCESS using alternative_locators (85.0% confidence)
[AI] ✅ Healing successful! Retrying step...
```

#### Context Detection
```
[AIContext] Context detected: ui
[AIIntegration] AI ENABLED for UI step: "When I click the Login button"
```

### Performance Metrics

**Expected Overhead per Step**:
- Zero-code overhead: 100-300ms
- AI healing (if triggered): +200-500ms
- Total acceptable overhead: <10% of test duration

**Example Timeline**:
```
Test Duration: 8 seconds
- Page loads: 3s
- Element waits: 2s
- Network: 1.5s
- Zero-code overhead: 1.5s (18.75% - acceptable)
```

---

## ✅ Validation Checklist

After running all tests, verify:

### Zero-Code Feature
- [ ] TC901-TC905 all pass (core functionality)
- [ ] Console shows `[ZeroCode]` logs
- [ ] Console shows `[IntelligentStep]` logs
- [ ] No "Step definition not found" errors (except TC907)
- [ ] All intents recognized: navigate, click, type, assert, wait

### AI Platform
- [ ] TC906 passes (AI healing + zero-code)
- [ ] Console shows `[AI]` logs
- [ ] Console shows `[AIIntegration]` logs
- [ ] Healing strategies activated when needed
- [ ] Context detection working (UI detected)

### Configuration
- [ ] TC908 passes (config loaded correctly)
- [ ] `INTELLIGENT_STEP_EXECUTION_ENABLED=true` in config
- [ ] `AI_ENABLED=true` in config
- [ ] All AI modules loaded successfully

### Performance
- [ ] TC909 completes in <10 seconds
- [ ] Zero-code overhead acceptable (<10% total duration)
- [ ] No significant delays noticed

### Parallel Execution
- [ ] TC910, TC911, TC912 all pass when run with `--parallel=3`
- [ ] No worker interference
- [ ] Each worker has isolated AI instance

### Error Handling
- [ ] TC907 fails gracefully (expected failure)
- [ ] Error message: "Step definition not found"
- [ ] No crashes or undefined errors

---

## 🐛 Troubleshooting

### Issue: Tests fail with "Step definition not found"

**Possible Causes**:
1. Zero-code feature not enabled
2. Configuration not loaded
3. AI modules failed to compile

**Solution**:
```bash
# Check configuration
grep INTELLIGENT_STEP_EXECUTION_ENABLED config/global.env

# Should show: INTELLIGENT_STEP_EXECUTION_ENABLED=true

# Rebuild framework
npm run build

# Re-run test
npm run cs-framework -- --project=orangehrm --tags=@TC901
```

### Issue: Tests fail with timeout errors

**Possible Causes**:
1. OrangeHRM demo site slow
2. Network issues
3. Element identification taking too long

**Solution**:
```bash
# Increase timeouts in config/orangehrm/orangehrm.env
DEFAULT_TIMEOUT=60000
NAVIGATION_TIMEOUT=90000

# Re-run test
npm run cs-framework -- --project=orangehrm --tags=@TC901
```

### Issue: AI healing not activating

**Possible Causes**:
1. AI platform not enabled
2. Step is non-UI (API/Database)
3. Element found on first try (no healing needed)

**Solution**:
```bash
# Check AI configuration
grep AI_ENABLED config/common/ai.env

# Should show: AI_ENABLED=true

# Check console logs for:
[AIIntegration] AI ENABLED for UI step

# If you see:
[AIIntegration] AI DISABLED
# Then AI is correctly skipping (expected for non-UI steps)
```

---

## 🧹 Cleanup After Validation

**AFTER all tests pass, run this cleanup**:

```bash
cd /mnt/e/PTF-ADO

# Delete test files
rm -rf test/orangehrm/

# Delete test configuration
rm -rf config/orangehrm/

# Verify deletion
ls test/          # Should not show orangehrm/
ls config/        # Should not show orangehrm/

# Ready to commit!
git status
```

---

## 📝 Final Steps Before ADO Commit

1. ✅ **Run All Validation Tests** - Confirm all pass
2. ✅ **Review Console Logs** - Verify zero-code and AI logs appear
3. ✅ **Check Performance** - Ensure tests complete in acceptable time
4. ✅ **Delete Test Files** - Remove `test/orangehrm/` and `config/orangehrm/`
5. ✅ **Verify TypeScript Compilation** - `npm run build` with 0 errors
6. ✅ **Git Status Check** - Ensure test files are removed
7. ✅ **Commit to ADO** - Push clean framework code

---

## 📚 Additional Notes

### Test Credentials
- **URL**: https://opensource-demo.orangehrmlive.com/web/index.php/auth/login
- **Username**: Admin
- **Password**: admin123

### Configuration Files
- **Project Config**: `config/orangehrm/orangehrm.env`
- **AI Config**: `config/common/ai.env`
- **Global Config**: `config/global.env`

### Expected Console Output (Success)
```
✓ TC901: Zero-code login test - No step definitions required (PASSED in 7.2s)
✓ TC902: Zero-code navigation and menu interaction (PASSED in 8.1s)
✓ TC903: Zero-code visibility assertions (PASSED in 3.5s)
✓ TC904: Zero-code wait handling (PASSED in 10.8s)
✓ TC905: Zero-code comprehensive workflow test (PASSED in 12.3s)
✓ TC906: Zero-code with AI healing (PASSED in 9.7s)
✗ TC907: Zero-code fails gracefully for unsupported intent (FAILED - EXPECTED)
✓ TC908: Verify zero-code configuration is enabled (PASSED in 7.4s)
✓ TC909: Zero-code performance overhead acceptable (PASSED in 6.9s)
✓ TC910: Zero-code works in parallel execution - Test 1 (PASSED in 7.5s)
✓ TC911: Zero-code works in parallel execution - Test 2 (PASSED in 7.3s)
✓ TC912: Zero-code works in parallel execution - Test 3 (PASSED in 7.6s)

Test Summary: 11 passed, 1 failed (expected), 0 errors
```

---

**Status**: ✅ Ready for validation testing
**Next Step**: Run `npm run cs-framework -- --project=orangehrm --tags=@framework-validation`
