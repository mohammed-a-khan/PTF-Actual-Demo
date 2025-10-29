# CS Codegen - Usage Example

## Single Command Test Recording

Transform Playwright recordings into CS Framework tests with one command.

## Step-by-Step Example

### 1. Start CS Codegen

```bash
npx cs-playwright-codegen https://opensource-demo.orangehrmlive.com/
```

You'll see:
```
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   CS Framework - Intelligent Test Codegen                 ║
║   Next-Generation Test Recorder with AI Intelligence      ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

🧠 Powered by 7-layer intelligence system:
   • Layer 1: Advanced AST Parsing (CFG/DFG)
   • Layer 2: Symbolic Execution Engine
   • Layer 3: Intent Understanding
   • Layer 4: Framework Knowledge Graph
   • Layer 5: Pattern Recognition
   • Layer 6: Intelligent Code Generation
   • Layer 7: Optimal Method Selection

🚀 CS Framework Intelligent Codegen
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Next-generation test recorder with 7-layer intelligence

👀 Starting intelligent file watcher...
   Watching: /tmp/cs-codegen

🎬 Launching Playwright Codegen...
   Command: npx playwright codegen --target playwright-test -o /tmp/cs-codegen/test.spec.ts https://opensource-demo.orangehrmlive.com/
```

### 2. Record Your Test

Playwright Inspector opens. Perform these actions:
1. Click on "Username" field
2. Type "Admin"
3. Click on "Password" field
4. Type "admin123"
5. Click "Login" button
6. Verify "Dashboard" heading is visible

### 3. Automatic Transformation

The moment you save, CS Codegen processes it:

```
⚡ New test detected!
   File: test.spec.ts

Layer 1: Parsing AST with CFG/DFG analysis... ✓
✅ Layer 1: Extracted 7 actions
   Actions: navigation, click, fill, click, fill, click, assertion

Layer 2: Analyzing test intent with symbolic execution... ✓
✅ Layer 2: Detected intent - authentication (100% confidence)
   Test Type: smoke
   Business Goal: Verify user can authenticate

Layers 3-4: Generating optimal CS Framework code... ✓
✅ Layers 3-4: Generated framework-perfect code

Writing CS Framework files... ✓
✅ Transformation complete!

📊 Transformation Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Feature:          user-authentication.feature
  Page Objects:     1 generated
  Step Definitions: 1 generated
  Confidence:       100%
  Intelligence:     3 smart elements
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Your test is ready to run!
```

### 4. Generated Files

Check your `./test` directory:

```
test/
├── features/
│   └── user-authentication.feature
├── pages/
│   └── LoginPage.ts
└── steps/
    └── LoginSteps.ts
```

## What Was Generated

### Feature File: `user-authentication.feature`

```gherkin
@smoke @authentication
Feature: User Authentication

  Scenario: authentication login
  Given user navigates to application
  When user enters credentials
    | Field    | Value        |
    | Username | {{username}} |
    | Password | {{password}} |
  And user clicks on "Login" button
  Then user should see "role=heading[name="Dashboard"]"
```

### Page Object: `LoginPage.ts`

```typescript
import { CSBasePage } from '../core/CSBasePage';
import { CSPage } from '../bdd/decorators/CSPage';
import { CSGetElement } from '../bdd/decorators/CSGetElement';
import { CSWebElement } from '../element/CSWebElement';

@CSPage('LoginPage')
export class LoginPage extends CSBasePage {
    // click target
    @CSGetElement('[placeholder="Username"]')
    usernameInput!: CSWebElement;

    // click target
    @CSGetElement('[placeholder="Password"]')
    passwordInput!: CSWebElement;

    // click target
    @CSGetElement('role=button[name="Login"]')
    loginButton!: CSWebElement;

    // Perform login with credentials
    public async login(username: string, password: string): Promise<void> {
        await this.usernameInput.fill(username);
        await this.passwordInput.fill(password);
        await this.loginButton.click();
    }
}
```

### Step Definition: `LoginSteps.ts`

```typescript
import { CSBDDStepDef } from '../bdd/decorators/CSBDDStepDef';
import { LoginPage } from '../pages/LoginPage';
import { DataTable } from '@cucumber/cucumber';

export class LoginSteps {
    @CSBDDStepDef('user navigates to application')
    public async navigateToApplication(): Promise<void> {
        await this.page.goto('https://application-url.com');
    }

    @CSBDDStepDef('user enters credentials')
    public async enterCredentials(dataTable: DataTable): Promise<void> {
        const loginPage = new LoginPage(this.page);
        const data = dataTable.rowsHash();

        await loginPage.login(data['Username'], data['Password']);
    }

    @CSBDDStepDef('user should see {string}')
    public async shouldSee(elementName: string): Promise<void> {
        const element = this.page.getByText(elementName);
        await element.waitForVisible();
    }
}
```

## Key Observations

### ✨ Intelligence at Work

1. **Intent Detection**: Recognized this as a login flow (100% confidence)
2. **Test Classification**: Tagged as `@smoke @authentication`
3. **Smart Elements**: Created semantic names (`usernameInput`, `passwordInput`, `loginButton`)
4. **Method Generation**: Added `login(username, password)` method automatically
5. **Optimal Locators**: Used CS Framework locator syntax (`role=button[name="Login"]`)
6. **Proper Decorators**: Applied `@CSGetElement`, `@CSPage`, `@CSBDDStepDef`
7. **Data Tables**: Generated Gherkin data tables for credentials

### 🎯 What Makes This Different

**Before (Manual Playwright Code):**
```typescript
await page.getByPlaceholder('Username').fill('Admin');
await page.getByPlaceholder('Password').fill('admin123');
await page.getByRole('button', { name: 'Login' }).click();
```

**After (CS Framework Code):**
```typescript
@CSGetElement('[placeholder="Username"]')
usernameInput!: CSWebElement;

public async login(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
}
```

## Next Steps

### 1. Review Generated Code

```bash
cd test
cat features/user-authentication.feature
cat pages/LoginPage.ts
cat steps/LoginSteps.ts
```

### 2. Customize as Needed

Update the page object URL:
```typescript
@CSBDDStepDef('user navigates to application')
public async navigateToApplication(): Promise<void> {
    await this.page.goto('https://opensource-demo.orangehrmlive.com/');
}
```

### 3. Run Your Test

```bash
npx cs-playwright-test --features=test/features/user-authentication.feature
```

## Advanced Usage

### Custom Output Directory

```bash
npx cs-playwright-codegen --output-dir ./my-custom-tests
```

### Verbose Mode

```bash
npx cs-playwright-codegen --verbose
```

This shows detailed intelligence reasoning:
- Why each method was selected
- Alternative methods considered
- Confidence scores for each decision
- Business logic extracted

### Multiple Tests

Keep CS Codegen running and record multiple tests. Each save triggers automatic transformation:

```bash
# Terminal 1: Keep this running
npx cs-playwright-codegen

# Record test 1 → saves → transforms automatically
# Record test 2 → saves → transforms automatically
# Record test 3 → saves → transforms automatically
```

## Real-World Examples

### Example 1: CRUD Operation

**Recording**: Create a new user
1. Click "Add User" button
2. Fill user details (name, email, role)
3. Select role from dropdown
4. Click "Save"
5. Verify success message

**Generated**:
- Intent: `crud/create` (95% confidence)
- Tags: `@crud @create`
- Method: `createUser(userData)`
- Smart selectors for all form fields

### Example 2: Form Submission

**Recording**: Contact form
1. Fill name, email, subject, message
2. Upload attachment
3. Accept terms checkbox
4. Submit form
5. Verify confirmation

**Generated**:
- Intent: `form-interaction/submission` (90% confidence)
- Tags: `@form-submission`
- Method: `submitContactForm(formData)`
- Uses `uploadFile()` for attachment
- Uses `check()` for checkbox

### Example 3: Navigation Flow

**Recording**: Multi-page workflow
1. Navigate to products
2. Search for item
3. Click on product
4. Add to cart
5. Go to checkout

**Generated**:
- Intent: `navigation` (85% confidence)
- Tags: `@navigation @e2e`
- Multiple page objects (ProductsPage, ProductDetailsPage, CartPage)
- Step definitions for each navigation step

## Tips for Best Results

### 1. Use Semantic Actions

✅ **Good**: Click on "Login" button (uses visible text)
❌ **Avoid**: Click on element with ID "btn_xyz_123"

### 2. Complete Flows

Record entire user journeys in one session for better intent detection.

### 3. Add Assertions

Always include verification steps - they help with intent analysis.

### 4. Stable Selectors

Click on elements with stable attributes (role, placeholder, text).

### 5. Review Generated Code

Always review and customize:
- Update placeholder URLs
- Add environment-specific values
- Enhance business logic
- Add comments for clarity

## Troubleshooting

### Issue: No transformation happening

**Solution**: Check the watch directory
```bash
npx cs-playwright-codegen --verbose
```

### Issue: Playwright not installed

**Solution**: Install Playwright
```bash
npx playwright install
```

### Issue: Generated code has compilation errors

**Solution**: Ensure framework is built
```bash
npm install
npm run build
```

## Performance

Typical transformation timeline:
- **Save file**: 0ms
- **Detect change**: 100ms (file watcher)
- **Parse AST**: 50ms
- **Analyze intent**: 100ms
- **Generate code**: 200ms
- **Write files**: 50ms
- **Total**: ~500ms (half a second!)

## Summary

CS Codegen transforms the Playwright recording experience:

1. **One command**: `npx cs-playwright-codegen`
2. **Record normally**: Use Playwright Inspector as usual
3. **Save**: Hit save in the inspector
4. **Done**: Get production-ready CS Framework tests instantly

**No manual conversion. No template copying. No boilerplate.**

Just intelligent, framework-perfect test code, automatically.

---

**Welcome to the future of test automation! 🚀**
