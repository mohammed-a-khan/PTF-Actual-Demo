# 🤖 AI Platform Test Scenarios - README

## Overview

This directory contains comprehensive test scenarios designed to demonstrate and verify the AI self-healing capabilities of the CS Test Automation Framework v3.2.0.

---

## 📁 Test Scenario Files

### 1. `ai-self-healing-demo.feature`
**Purpose**: Comprehensive demonstration of all AI capabilities

**Scenarios**: 21 test cases covering:
- ✅ AI healing demonstrations (5 scenarios)
- ✅ Context detection (UI vs API vs Database) (2 scenarios)
- ✅ Learning and pattern matching (2 scenarios)
- ✅ Reporting and statistics (1 scenario)
- ✅ Parallel execution (3 scenarios)
- ✅ Configuration testing (2 scenarios)
- ✅ Edge cases and error handling (3 scenarios)
- ✅ Performance and timing (2 scenarios)
- ✅ End-to-end comprehensive test (1 scenario)

**Tags**: `@ai-healing`, `@ai-context`, `@ai-learning`, `@ai-reporting`, `@ai-parallel`, `@ai-config`, `@ai-edge-case`, `@ai-performance`, `@ai-comprehensive`

**Run Time**: ~15-20 minutes (all scenarios)

### 2. `ai-quick-test.feature`
**Purpose**: Quick smoke test for AI functionality

**Scenarios**: 4 test cases
- Basic login with AI enabled
- Dashboard navigation with potential healing
- Parallel execution test 1
- Parallel execution test 2

**Tags**: `@ai-quick-test`, `@ai-enabled`, `@ai-healing`, `@ai-parallel`

**Run Time**: ~2-3 minutes

---

## 🚀 How to Run

### Quick Test (Recommended for First Run)

```bash
# Sequential execution
cd /mnt/e/PTF-Demo-Project
npm run cs-framework -- --project=orangehrm --tags=@ai-quick-test

# Parallel execution (2 workers)
npm run cs-framework -- --project=orangehrm --tags=@ai-parallel --parallel=2
```

### Full AI Demo

```bash
# Run all AI scenarios
npm run cs-framework -- --project=orangehrm --tags=@ai-self-healing-demo

# Run specific AI capability
npm run cs-framework -- --project=orangehrm --tags=@ai-healing
npm run cs-framework -- --project=orangehrm --tags=@ai-context
npm run cs-framework -- --project=orangehrm --tags=@ai-learning
```

### Parallel Execution Testing

```bash
# 2 workers
npm run cs-framework -- --project=orangehrm --tags=@ai-parallel --parallel=2

# 3 workers
npm run cs-framework -- --project=orangehrm --tags=@ai-parallel --parallel=3

# 5 workers (stress test)
npm run cs-framework -- --project=orangehrm --tags=@ai-parallel --parallel=5
```

### With AI Disabled (Baseline)

```bash
# Temporarily disable AI to compare behavior
AI_ENABLED=false npm run cs-framework -- --project=orangehrm --tags=@ai-quick-test
```

---

## 📊 What to Look For

### Console Logs

#### 1. AI Initialization
```
[AIIntegration][main] Initialized - AI: true, Healing: true, UI Only: true
```

#### 2. Context Detection
```
[AIIntegration][main] AI ENABLED for UI step: "When I click the Login button"
[AIIntegration][main] AI DISABLED for API step - using existing retry behavior
```

#### 3. Locator Extraction
```
[AI] Extracted locator from error: #login-btn
```

#### 4. Healing Attempts
```
[AI] Attempting intelligent healing for failed step: When I click the Login button
[Healer] Trying alternative_locators strategy
[IntelligentHealer] Healing SUCCESS using alternative_locators (89.0% confidence)
[AI] ✅ Healing successful! Retrying step with healed locator...
[AI] Step passed after healing (retry duration: 234ms)
```

#### 5. Parallel Worker Isolation
```
[Worker 1] AI integration initialized
[Worker 2] AI integration initialized
[Worker 3] AI integration initialized
...
[Worker 1] AI integration cleaned up (ID: 1)
[Worker 2] AI integration cleaned up (ID: 2)
[Worker 3] AI integration cleaned up (ID: 3)
```

### Test Reports

#### 1. Step-Level AI Data (JSON)
Check `reports/test-results-{timestamp}/results.json`:

```json
{
  "name": "When I click the Login button",
  "status": "passed",
  "duration": 1456,
  "aiData": {
    "healing": {
      "attempted": true,
      "success": true,
      "strategy": "alternative_locators",
      "confidence": 0.89,
      "duration": 234,
      "originalLocator": "#login-btn",
      "healedLocator": "text='Login'",
      "attempts": 1
    }
  }
}
```

#### 2. HTML Report
Check `reports/test-results-{timestamp}/index.html`:
- Steps with AI healing show healing details
- Duration includes healing time
- Confidence scores displayed

---

## 🔍 Debugging AI

### Enable Debug Logs

```bash
# Method 1: Environment variable
LOG_LEVEL=DEBUG npm run cs-framework -- --project=orangehrm --tags=@ai-quick-test

# Method 2: Edit config/global.env
# LOG_LEVEL=DEBUG
```

### Common Issues and Solutions

#### Issue 1: AI Not Initializing
**Symptom**: No `[AIIntegration]` logs
**Check**:
1. `config/common/ai.env` exists? (Should be there after v3.2.0)
2. `AI_ENABLED=true` in config?
3. TypeScript compiled? Run `npm run build`

#### Issue 2: AI Not Healing
**Symptom**: Step fails but no healing attempt logged
**Check**:
1. Is it a UI step? (AI only activates for UI by default)
2. Is `AI_INTELLIGENT_HEALING_ENABLED=true`?
3. Is `AI_UI_ONLY=true` and step is API/Database?
4. Check logs for "[AI] Skipped for non-UI step"

#### Issue 3: Parallel Workers Not Isolated
**Symptom**: Workers interfering with each other
**Check**:
1. Check logs for worker IDs: `[Worker 1]`, `[Worker 2]`, etc.
2. Verify different worker IDs in AI initialization logs
3. Check cleanup logs show correct worker IDs

---

## 📝 Test Scenario Details

### TC601: AI Heals Login Button Locator Failure
**Purpose**: Demonstrate alternative locator strategy
**AI Strategies Used**: alternative_locators (text, ARIA, role)
**Expected Result**: If #login-btn fails, AI finds by text="Login"
**Time**: ~2s (including healing)

### TC603: AI Heals with Scroll Into View
**Purpose**: Demonstrate scroll_into_view strategy
**AI Strategies Used**: scroll_into_view, wait_for_visible
**Expected Result**: Element scrolled into view before interaction
**Time**: ~3s

### TC604: AI Removes Overlay/Modal
**Purpose**: Demonstrate overlay removal
**AI Strategies Used**: remove_overlays, close_modal
**Expected Result**: Modal dismissed, element accessible
**Time**: ~4s (includes modal dismiss time)

### TC608: AI Pattern Matching (Login Form)
**Purpose**: Demonstrate built-in pattern recognition
**Patterns Used**: login_form (Pattern #1 of 15)
**Expected Result**: AI recognizes pattern, applies targeted strategies
**Time**: ~2s

### TC611-TC613: Parallel Execution
**Purpose**: Verify worker isolation
**Workers**: 3 workers, each with isolated AI instance
**Expected Result**: No shared state, independent healing
**Time**: ~6s total (parallel execution)

### TC621: End-to-End Comprehensive
**Purpose**: Exercise all AI capabilities in single scenario
**Interactions**: 10-15 UI steps
**Expected AI Operations**: 0-5 healing attempts
**Time**: ~20s

---

## 🎯 Success Criteria

### ✅ Pass Criteria

1. **All scenarios pass** (with or without AI healing)
2. **AI logs show proper activation decisions** (enabled for UI, disabled for API/DB)
3. **Healing statistics captured** in test results
4. **No crashes or unhandled errors** from AI code
5. **Parallel workers isolated** (separate AI instances)
6. **Performance acceptable** (AI adds < 1s per healed step)

### 📊 Expected AI Metrics

For full demo suite (21 scenarios):

- **Total UI Interactions**: ~50-60 steps
- **AI Healing Attempts**: 0-10 (depends on locator stability)
- **Healing Success Rate**: 70-90% (7-9 out of 10 attempts succeed)
- **Time Saved**: 5-30 minutes per healed failure (vs manual debugging)
- **Performance Impact**: < 500ms per healing attempt

---

## 🛠️ Customization

### Add Your Own AI Test Scenarios

```gherkin
@TC999 @ai-custom
Scenario: My custom AI healing test
  Given I navigate to my application
  When I click on some element that might fail
  Then AI should heal the failure if it's a UI step
  # AI will automatically activate if step fails
  # Check logs for healing attempts and results
```

### Disable AI for Specific Scenarios

```gherkin
@TC998 @no-ai
Scenario: Test without AI (baseline comparison)
  Given I navigate to the application
  # To disable AI for this specific test, use tag-based config or:
  # Run with: AI_ENABLED=false npm run cs-framework
```

---

## 📚 Additional Resources

- **AI Integration Guide**: `/mnt/e/PTF-ADO/AI_INTEGRATION_GUIDE.md`
- **AI User Guide**: `/mnt/e/PTF-ADO/AI_INTEGRATION_COMPLETE.md`
- **Deep Analysis**: `/mnt/e/PTF-ADO/AI_DEEP_ANALYSIS_AND_VERIFICATION.md`
- **AI Configuration**: `/mnt/e/PTF-ADO/config/common/ai.env`

---

## 🤝 Contributing

To add new AI test scenarios:

1. Create new `.feature` file in `test/orangehrm/features/`
2. Use `@ai-*` tags for categorization
3. Add detailed scenario descriptions
4. Document expected AI behaviors
5. Update this README with new scenarios

---

**Created**: 2025-10-07
**Framework Version**: 3.2.0
**AI Platform**: Fully Integrated and Operational ✅
