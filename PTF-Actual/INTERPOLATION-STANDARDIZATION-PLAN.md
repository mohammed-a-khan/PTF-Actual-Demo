# Variable Interpolation Standardization Plan

## Status: In Progress

### Completed ✅

1. **CSConfigurationManager.ts** - Enhanced with context variable support
   - Added `public interpolate(value, contextMap?)` method
   - Supports all existing syntax: `{VAR}`, `${VAR}`, `{env:VAR}`, `{config:VAR}`, `<placeholders>`
   - NEW: Supports `{{VAR}}` and `{context:VAR}` for runtime context variables
   - Backward compatible with all existing .env file syntax

2. **DatabaseGenericSteps.ts** - Updated to use centralized system
   - Replaced custom `interpolateVariables()` with `configManager.interpolate(query, this.contextVariables)`
   - Removed duplicate interpolation code

3. **ConnectionSteps.ts** - Updated to use centralized system
   - Replaced custom `interpolateVariables()` with `configManager.interpolate(connectionString, this.contextVariables)`
   - Updated parseDataTable() method
   - Removed duplicate interpolation code

### Remaining Database Step Files (5 files)

#### 1. QueryExecutionSteps.ts (13 uses)
   - Line ~60: `executeQuery()` method
   - Line ~90: `executeQueryAndStore()` method
   - Line ~120: `executeQueryWithTimeout()` method
   - Plus ~10 more uses in other methods
   - Has private `interpolateVariables()` method to remove

#### 2. DataValidationSteps.ts (13 uses)
   - Used in query validation methods
   - Has private `interpolateVariables()` method to remove

#### 3. DatabaseUtilitySteps.ts (12 uses)
   - Used in utility methods
   - Has private `interpolateVariables()` method to remove

#### 4. StoredProcedureSteps.ts (10 uses)
   - Used for stored procedure calls
   - Has private `interpolateVariables()` method to remove

#### 5. TransactionSteps.ts (2 uses)
   - Used in transaction methods
   - Has private `interpolateVariables()` method to remove

### API Step Files (6 files) - Not Started Yet

All API step files use a simpler interpolation (just `{{VAR}}` for context):

1. **CSAPIRequestBodySteps.ts** - Uses `interpolateValue()`
2. **CSAPIRequestHeaderSteps.ts** - May use interpolation
3. **CSAPIRequestConfigSteps.ts** - May use interpolation
4. **CSAPIResponseValidationSteps.ts** - May use interpolation
5. **CSAPIRequestExecutionSteps.ts** - May use interpolation
6. **CSAPIUtilitySteps.ts** - May use interpolation

### Pattern for Replacement

**OLD CODE:**
```typescript
private interpolateVariables(text: string): string {
    text = text.replace(/\${([^}]+)}/g, (match, varName) => {
        return process.env[varName] || match;
    });
    text = text.replace(/{{([^}]+)}}/g, (match, varName) => {
        const retrieved = this.contextVariables.get(varName);
        return retrieved !== undefined ? String(retrieved) : match;
    });
    text = text.replace(/%([^%]+)%/g, (match, varName) => {
        return this.configManager.get(varName, match) as string;
    });
    return text;
}

// Usage:
const interpolated = this.interpolateVariables(query);
```

**NEW CODE:**
```typescript
// Remove private interpolateVariables() method entirely

// Usage:
const interpolated = this.configManager.interpolate(query, this.contextVariables);
```

### Benefits of Standardization

1. **Single Source of Truth**: All interpolation logic in CSConfigurationManager
2. **Consistent Syntax**: Same syntax works everywhere (DB queries, API requests, config files)
3. **More Features**: Database/API steps now get access to:
   - `{ternary:COND?TRUE:FALSE}` - Conditional values
   - `{concat:VAR1+VAR2}` - Concatenation
   - `{upper:VAR}`, `{lower:VAR}` - Transformations
   - `<random>`, `<uuid>`, `<timestamp>` - Dynamic values
   - `<generate:email>`, `<generate:phone>` - Generated values
4. **Easier Maintenance**: Update interpolation logic in one place
5. **Better Testing**: Test interpolation once, works everywhere

### Migration Impact

**Breaking Changes**: None! The new system is backward compatible:
- `${VAR}` still works (checks config THEN environment)
- `{{VAR}}` still works (context variables)
- Old syntax `%VAR%` no longer needed (use `{VAR}` or `${VAR}` instead)

**User Impact**: Users can immediately start using advanced features:
```gherkin
# Example: Use dynamic values in database queries
When user executes query "INSERT INTO users VALUES ('<uuid>', '<generate:email>', '<timestamp>')"

# Example: Use conditional values
When user executes query "SELECT * FROM users WHERE status = '{ternary:USE_ACTIVE?active:inactive}'"

# Example: Use context variables from previous steps
When user executes query "SELECT * FROM orders WHERE user_id = '{{userId}}'"
```

### Next Steps

1. ✅ Complete remaining 5 database step files
2. ⏳ Update 6 API step files
3. ⏳ Search for any other files with custom interpolation
4. ⏳ Run full test suite
5. ⏳ Update documentation
6. ⏳ Bump version to 1.1.0 (minor version for new features)
7. ⏳ Commit and publish

### Estimated Time

- Remaining database files: ~15 minutes
- API files: ~20 minutes
- Testing: ~10 minutes
- Documentation: ~15 minutes
- **Total**: ~60 minutes

### Testing Checklist

- [ ] Test config file interpolation (existing functionality)
- [ ] Test database query interpolation with all syntaxes
- [ ] Test API request interpolation with all syntaxes
- [ ] Test context variables in database queries
- [ ] Test context variables in API requests
- [ ] Test new features (ternary, concat, dynamic values) in queries
- [ ] Test backward compatibility with old syntax
- [ ] Run full framework test suite
- [ ] Test with demo project
