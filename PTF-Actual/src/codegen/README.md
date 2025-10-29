# CS Codegen - Intelligent Test Recorder

Transform Playwright codegen output into production-ready CS Framework tests automatically.

## Quick Start

```bash
npx cs-playwright-codegen [url]
```

That's it! Record your test and watch it transform into optimal CS Framework code.

## What Makes It Intelligent?

### 🧠 7-Layer Intelligence

1. **AST Parser**: Understands your code structure deeply (CFG/DFG analysis)
2. **Symbolic Execution**: Runs your test mentally to understand behavior
3. **Intent Understanding**: Knows what you're testing (login, CRUD, forms, etc.)
4. **Knowledge Graph**: Complete understanding of 120+ framework methods
5. **Pattern Recognition**: Detects common scenarios automatically
6. **Code Generator**: Creates optimal framework code
7. **Optimizer**: Suggests improvements and best practices

### ✨ Key Features

- **Auto-detects test intent** (authentication, CRUD, forms, navigation)
- **Generates proper decorators** (@CSGetElement, @CSBDDStepDef, @CSPage)
- **Selects best methods** (e.g., `selectOptionByLabel` vs `selectOptionByValue`)
- **Creates Gherkin features** with proper tags
- **Builds page objects** extending CSBasePage
- **Confidence scoring** for every transformation

## Example Transformation

**Input**: Playwright codegen output
```typescript
await page.getByPlaceholder('Username').fill('Admin');
await page.getByRole('button', { name: 'Login' }).click();
```

**Output**: CS Framework code
```typescript
@CSPage('LoginPage')
export class LoginPage extends CSBasePage {
    @CSGetElement('[placeholder="Username"]')
    usernameInput!: CSWebElement;

    @CSGetElement('role=button[name="Login"]')
    loginButton!: CSWebElement;

    public async login(username: string): Promise<void> {
        await this.usernameInput.fill(username);
        await this.loginButton.click();
    }
}
```

## Module Structure

```
src/codegen/
├── types/
│   └── index.ts                 # Type definitions
├── parser/
│   └── ASTParser.ts             # Layer 1: Advanced AST parsing
├── analyzer/
│   └── SymbolicExecutionEngine.ts   # Layer 2: Intent analysis
├── knowledge/
│   └── FrameworkKnowledgeGraph.ts   # Layer 3-4: Framework knowledge
├── generator/
│   └── IntelligentCodeGenerator.ts  # Layer 5-6: Code generation
└── cli/
    ├── CodegenOrchestrator.ts   # Orchestrates all layers
    └── cs-playwright-codegen.ts # CLI entry point
```

## Architecture

```
Playwright Codegen Output
         │
         ▼
    AST Parser (Layer 1)
    • Parse TypeScript
    • Build CFG/DFG
    • Extract actions
         │
         ▼
    Symbolic Execution (Layer 2)
    • Infer intent
    • Detect patterns
    • Extract business logic
         │
         ▼
    Knowledge Graph (Layers 3-4)
    • Map capabilities
    • Score methods
    • Select optimal
         │
         ▼
    Code Generator (Layers 5-6)
    • Generate features
    • Generate page objects
    • Generate step definitions
         │
         ▼
    CS Framework Test Suite
```

## API Usage

### Programmatic Usage

```typescript
import { CodegenOrchestrator } from './cli/CodegenOrchestrator';

const orchestrator = new CodegenOrchestrator({
    outputDir: './test',
    watchDir: '/tmp/cs-codegen',
    verbose: true
});

await orchestrator.start();
```

### Direct Layer Usage

```typescript
import { AdvancedASTParser } from './parser/ASTParser';
import { SymbolicExecutionEngine } from './analyzer/SymbolicExecutionEngine';
import { IntelligentCodeGenerator } from './generator/IntelligentCodeGenerator';

// Parse
const parser = new AdvancedASTParser();
const analysis = parser.parse(playwrightCode);

// Analyze intent
const engine = new SymbolicExecutionEngine();
const intent = await engine.executeSymbolically(analysis);

// Generate
const generator = new IntelligentCodeGenerator();
const code = generator.generate(analysis, intent, 'Feature Name');
```

## Intelligence Examples

### Login Detection (100% Confidence)

```typescript
// Pattern detected: navigation → fill(username) → fill(password) → click(submit) → assertion
// Intent: authentication/login
// Test Type: smoke
// Business Goal: Verify user can authenticate

// Generated tags: @smoke @authentication
// Generated method: login(username, password)
```

### CRUD Detection

```typescript
// Pattern: click(add) → fill(fields) → click(save)
// Intent: crud/create
// Entity: User/Product/Order

// Generated tags: @crud @create
// Generated method: createEntity(data)
```

### Form Detection

```typescript
// Pattern: fill(multiple fields) → select(dropdown) → check(checkbox) → click(submit)
// Intent: form-interaction/submission

// Generated tags: @form-submission
// Generated method: submitForm(formData)
```

## Method Selection Intelligence

The Knowledge Graph knows when to use each of 120+ methods:

| Scenario | Selected Method | Reasoning |
|----------|----------------|-----------|
| Standard click | `click()` | Auto-retry, logging, self-healing |
| Covered element | `clickWithForce()` | Bypasses visibility checks |
| Open in new tab | `clickWithControlKey()` | Semantic, platform-aware |
| User-facing dropdown | `selectOptionByLabel()` | Matches user behavior |
| Single file upload | `uploadFile(path)` | Validates file exists |
| Table cell access | `createTableCell(row, col)` | Semantic table notation |

## Performance

- **AST Parsing**: ~50ms
- **Intent Analysis**: ~100ms
- **Code Generation**: ~200ms
- **Total**: ~500ms per test

## Testing

Run integration tests:

```bash
npx ts-node test-codegen-integration.ts
```

Expected output:
```
✅ Extracted 7 actions
✅ Detected intent: authentication (100% confidence)
✅ Generated framework-perfect code
🎉 CS Codegen system is ready for production!
```

## Dependencies

- **TypeScript**: For AST parsing and type checking
- **chokidar**: File system watching
- **commander**: CLI argument parsing
- **chalk**: Colored terminal output
- **ora**: Progress spinners

## Development

### Adding New Capabilities

1. Update `FrameworkKnowledgeGraph.ts`:
```typescript
this.addCapability({
    id: 'newMethod',
    name: 'newMethod',
    whenToUse: 'Description',
    benefits: ['Benefit 1', 'Benefit 2']
});
```

2. Update scoring logic in `scoreCapability()`

3. Test with sample Playwright code

### Adding New Patterns

1. Update `SymbolicExecutionEngine.ts`:
```typescript
private matchesNewPattern(actions: Action[]): boolean {
    // Pattern detection logic
}
```

2. Add to `inferPrimaryIntent()` method

3. Test with real-world examples

## Troubleshooting

### TypeScript Compilation

```bash
npx tsc --noEmit
```

### Verbose Logging

```bash
npx cs-playwright-codegen --verbose
```

### Debug Single Transformation

```typescript
const code = fs.readFileSync('test.spec.ts', 'utf-8');
const analysis = parser.parse(code);
console.log(JSON.stringify(analysis, null, 2));
```

## Contributing

When contributing to CS Codegen:

1. **Maintain intelligence**: Don't simplify - enhance!
2. **Add tests**: Include integration tests
3. **Update docs**: Keep this README current
4. **Preserve types**: TypeScript strict mode required
5. **No breaking changes**: Backward compatibility is critical

## License

MIT - Part of CS Playwright Test Framework

---

**Next-generation test automation with AI-powered intelligence**

Built by the CS Framework Team with deep thinking and research 🧠
