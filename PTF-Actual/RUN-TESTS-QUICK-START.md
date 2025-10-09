# 🚀 Quick Start - Run Zero-Code Validation Tests

## ✅ Framework Built Successfully

The framework has been built and is ready for testing!

---

## 🧪 Run Validation Tests (3 Options)

### Option 1: Automated Test Runner (Recommended)
```bash
./test/orangehrm/run-validation-tests.sh
```

### Option 2: Run Smoke Tests Only (Quick - 4 tests)
```bash
npm run test:zero-code
```

### Option 3: Run All Validation Tests (Complete - 12 tests)
```bash
npm run test:validation
```

---

## 📋 Individual Test Commands

### Run Specific Test by ID
```bash
# TC901: Basic zero-code login
npm test -- --project=orangehrm --tags=@TC901

# TC906: Zero-code + AI healing
npm test -- --project=orangehrm --tags=@TC906

# TC909: Performance validation
npm test -- --project=orangehrm --tags=@TC909
```

### Run by Category
```bash
# All smoke tests
npm test -- --project=orangehrm --tags=@zero-code --tags=@smoke

# All regression tests
npm test -- --project=orangehrm --tags=@zero-code --tags=@regression

# Parallel execution tests
npm test -- --project=orangehrm --tags=@zero-code --tags=@parallel --parallel=3
```

---

## ✅ Expected Results

### Should PASS (11 tests):
- ✅ TC901, TC902, TC903, TC904, TC905, TC906
- ✅ TC908, TC909
- ✅ TC910, TC911, TC912

### Should FAIL (1 test - expected):
- ❌ TC907: "Step definition not found" (this is correct behavior)

---

## 🔍 What to Look For

### Zero-Code Logs
```
[ZeroCode] No step definition found, trying intelligent execution
[IntelligentStep] Executing: When I click the Login button
[IntelligentStep] NLP Intent: click, Element: button
[IntelligentStep] ✅ Auto-executed: When I click the Login button
```

### AI Logs (if element fails)
```
[AIIntegration] AI ENABLED for UI step
[AI] Attempting intelligent healing
[AIIntegration] ✅ Healing SUCCESS using alternative_locators
```

---

## 🧹 Cleanup After Successful Testing

**IMPORTANT**: Delete these temporary test files before committing to ADO:

```bash
# Delete test files
rm -rf test/orangehrm/
rm -rf config/orangehrm/
rm ZERO_CODE_VALIDATION_PLAN.md
rm RUN-TESTS-QUICK-START.md

# Verify cleanup
git status

# Should NOT show:
# - test/orangehrm/
# - config/orangehrm/
# - ZERO_CODE_VALIDATION_PLAN.md
# - RUN-TESTS-QUICK-START.md
```

---

## 🎯 Next Steps After Validation

1. ✅ Run tests: `npm run test:zero-code`
2. ✅ Verify 11 pass, 1 fails (TC907)
3. ✅ Check console for [ZeroCode] and [AI] logs
4. ✅ Cleanup test files (commands above)
5. ✅ Commit to ADO

---

**Status**: ✅ Ready to test!
**Start with**: `npm run test:zero-code`
