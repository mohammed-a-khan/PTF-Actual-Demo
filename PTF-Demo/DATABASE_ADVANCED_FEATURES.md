# Database Testing - Advanced Features Guide

## Overview
This guide covers **ADVANCED** database testing features that were not included in the basic guide:
- **Predefined Queries from .env files**
- **Context Storage & Sharing Between Steps/Scenarios**
- **Variable Interpolation (all 3 types)**
- **Session Variables**
- **Query Result Caching**
- **Data-Driven Testing with Databases**
- **Query History & Performance Tracking**

---

## 🎯 What Was Missing from the Initial Implementation

The initial database demo missed these **critical framework features**:

### ❌ Missing Features (Now Added):
1. **Predefined Queries from .env Files** - Framework's ability to load queries from config files
2. **Context Storage** - Storing and reusing query results across steps
3. **Variable Interpolation** - All three types: `${ENV}`, `%CONFIG%`, `{{context}}`
4. **Session Variables** - Data sharing across scenarios via DatabaseContext
5. **Query Result Caching** - Performance optimization by caching expensive queries
6. **Data-Driven Testing** - Scenario Outlines with database queries
7. **Query History** - Performance tracking and query profiling
8. **Query from Files** - Loading SQL from external .sql files

---

## 📁 New Files Created

### 1. **oracle_queries.env**
Location: `/config/orangehrm/common/oracle_queries.env`

Contains **60+ predefined Oracle queries** organized by category:
- Basic employee & department queries
- Salary analysis queries
- Department analysis queries
- Product inventory queries
- Join queries (complex)
- Aggregate & statistical queries
- Data validation queries
- Queries with variable interpolation support
- Performance & monitoring queries
- Reporting queries

**Example Queries:**
```properties
# Get all employees
DB_QUERY_GET_ALL_EMPLOYEES=SELECT * FROM employees ORDER BY employee_id

# Get IT Department employees
DB_QUERY_GET_IT_EMPLOYEES=SELECT * FROM employees WHERE department_id = 10 ORDER BY salary DESC

# Get high earners (salary > 80000)
DB_QUERY_GET_HIGH_EARNERS=SELECT employee_id, first_name, last_name, salary FROM employees WHERE salary > 80000 ORDER BY salary DESC

# Department summary with employee details
DB_QUERY_GET_DEPT_SUMMARY=SELECT d.department_name, d.location, COUNT(e.employee_id) AS emp_count, AVG(e.salary) AS avg_salary, MIN(e.salary) AS min_salary, MAX(e.salary) AS max_salary FROM departments d LEFT JOIN employees e ON d.department_id = e.department_id GROUP BY d.department_id, d.department_name, d.location ORDER BY emp_count DESC

# With variable interpolation (context variable)
DB_QUERY_GET_EMPLOYEES_BY_DEPT=SELECT * FROM employees WHERE department_id = {{dept_id}} ORDER BY employee_id
```

### 2. **mysql_queries.env**
Location: `/config/orangehrm/common/mysql_queries.env`

Contains **80+ predefined MySQL queries** organized by category:
- Basic employee, department, project queries
- Customer & order queries
- Employee analysis queries
- Project management queries
- Sales & order analysis queries
- HR analytics queries
- Cross-table join queries
- Queries with variable interpolation
- Aggregate & statistical queries
- Data validation queries
- Performance monitoring queries
- Reporting queries

**Example Queries:**
```properties
# Get all employees
DB_QUERY_MYSQL_GET_ALL_EMPLOYEES=SELECT * FROM employees ORDER BY employee_id

# Get top earners (top 10)
DB_QUERY_MYSQL_GET_TOP_EARNERS=SELECT employee_id, first_name, last_name, job_title, salary FROM employees ORDER BY salary DESC LIMIT 10

# Get active projects with team size
DB_QUERY_MYSQL_PROJECTS_WITH_TEAM=SELECT p.project_name, p.status, p.budget, COUNT(ep.employee_id) AS team_size, SUM(ep.hours_allocated) AS total_hours FROM projects p LEFT JOIN employee_projects ep ON p.project_id = ep.project_id GROUP BY p.project_id, p.project_name, p.status, p.budget ORDER BY team_size DESC

# With variable interpolation
DB_QUERY_MYSQL_EMPLOYEES_BY_DEPT_ID=SELECT * FROM employees WHERE department_id = {{dept_id}} ORDER BY employee_id
```

### 3. **database-advanced-features.feature**
Location: `/test/orangehrm/features/database-advanced-features.feature`

Contains **30+ scenarios** demonstrating:
- Predefined query execution (from .env files)
- Context storage within scenarios
- Context storage across complex multi-step operations
- Variable interpolation (all 3 types)
- Session variables across scenarios
- Query result caching
- Data-driven testing with Scenario Outlines
- Query from file execution
- Query history & performance tracking
- Multi-database data-driven testing
- Advanced context manipulation
- Query profiling with execution plans
- Real-world data pipelines
- Batch operations with context

---

## 🔧 How It Works

### 1. Predefined Queries from .env Files

**Framework Mechanism:**
- Framework's `CSConfigurationManager` loads all `.env` files from config hierarchy
- Queries are defined as: `DB_QUERY_{QUERY_NAME}=SQL_STATEMENT`
- Step definition `user executes predefined query "{QUERY_NAME}"` reads from config
- Framework code: `QueryExecutionSteps.ts:74` - `this.configManager.get('DB_QUERY_${queryName.toUpperCase()}')`

**Usage:**
```gherkin
# Execute predefined query defined in oracle_queries.env
When user executes predefined query "GET_ALL_EMPLOYEES"

# Execute MySQL predefined query from mysql_queries.env
When user executes predefined query "MYSQL_GET_TOP_EARNERS"
```

**Configuration:**
```properties
# In config/orangehrm/common/oracle_queries.env
DB_QUERY_GET_ALL_EMPLOYEES=SELECT * FROM employees ORDER BY employee_id

# In config/orangehrm/common/mysql_queries.env
DB_QUERY_MYSQL_GET_TOP_EARNERS=SELECT * FROM employees ORDER BY salary DESC LIMIT 10
```

---

### 2. Context Storage & Sharing

**Framework Mechanism:**
- `DatabaseContext` singleton maintains `storedResults: Map<string, QueryResult>`
- Method: `storeResult(alias: string, result: QueryResult): void` (line 124)
- Method: `getStoredResult(alias: string): QueryResult` (line 129)
- Results persist throughout the test run
- Accessible across steps and scenarios

**Usage:**
```gherkin
# Store query result with alias
When user executes query "SELECT MAX(salary) AS max_sal FROM employees" and stores result as "MAX_SALARY_RESULT"

# Store another result
When user executes query "SELECT MIN(salary) AS min_sal FROM employees" and stores result as "MIN_SALARY_RESULT"

# Results are now accessible in DatabaseContext.storedResults map
# Can be retrieved with: DatabaseContext.getInstance().getStoredResult("MAX_SALARY_RESULT")
```

**Framework Code:**
```typescript
// DatabaseContext.ts:124
storeResult(alias: string, result: QueryResult): void {
    this.storedResults.set(alias, result);
    CSReporter.info(`Database operation - storeResult, alias: ${alias}, rowCount: ${result.rowCount}`);
}

// DatabaseContext.ts:129
getStoredResult(alias: string): QueryResult {
    const result = this.storedResults.get(alias);
    if (!result) {
        throw new Error(`No stored result found with alias '${alias}'`);
    }
    return result;
}
```

---

### 3. Variable Interpolation (All 3 Types)

The framework supports **three types of variable interpolation**:

#### Type 1: Environment Variables - `${VAR}`
**Framework Code:** All step classes have:
```typescript
text.replace(/\${([^}]+)}/g, (match, varName) => {
    return process.env[varName] || match;
});
```

**Usage:**
```gherkin
# Assuming environment variable TABLE_NAME=employees
When user executes query "SELECT * FROM ${TABLE_NAME}"
```

#### Type 2: Configuration Variables - `%VAR%`
**Framework Code:**
```typescript
text.replace(/%([^%]+)%/g, (match, varName) => {
    return this.configManager.get(varName, match) as string;
});
```

**Usage:**
```gherkin
# Configuration from .env file: DEPARTMENT_ID=10
When user executes query "SELECT * FROM employees WHERE dept_id = %DEPARTMENT_ID%"
```

**Example .env:**
```properties
# In global.env or project .env
DEPARTMENT_ID=10
SALARY_THRESHOLD=80000
```

#### Type 3: Context Variables - `{{var}}`
**Framework Code:**
```typescript
text.replace(/{{([^}]+)}}/g, (match, varName) => {
    const retrieved = this.contextVariables.get(varName);
    return retrieved !== undefined ? String(retrieved) : match;
});
```

**Usage:**
```gherkin
# First, store a value in context (automatically or manually)
When user executes scalar query "SELECT MAX(department_id) FROM departments"
# Framework stores result in contextVariables

# Then use it in subsequent queries
When user executes query "SELECT * FROM employees WHERE dept_id = {{max_dept_id}}"
```

**Predefined Queries with Interpolation:**
```properties
# oracle_queries.env
DB_QUERY_GET_EMPLOYEES_BY_DEPT=SELECT * FROM employees WHERE department_id = {{dept_id}} ORDER BY employee_id

DB_QUERY_GET_HIGH_SALARY_EMPLOYEES=SELECT * FROM employees WHERE salary > {{salary_threshold}} ORDER BY salary DESC
```

---

### 4. Session Variables

**Framework Mechanism:**
- `DatabaseContext` maintains `sessionVariables: Map<string, any>` (line 18)
- Methods:
  - `setSessionVariable(key: string, value: any)` (line 192)
  - `getSessionVariable(key: string)` (line 197)
  - `clearSessionVariables()` (line 201)
- Session variables persist across scenarios in the same test run
- Singleton pattern ensures same instance across scenarios

**Usage:**
```gherkin
# Scenario 1: Set session variables
Scenario: Session Variables - Part 1
  When user executes query "SELECT MAX(employee_id) AS max_id FROM employees" and stores result as "GLOBAL_STATS"
  # Result stored in DatabaseContext.storedResults
  # Accessible in subsequent scenarios

# Scenario 2: Use session variables from Part 1
Scenario: Session Variables - Part 2
  # Can access "GLOBAL_STATS" stored in previous scenario
  When user executes query "SELECT * FROM employees WHERE employee_id = 108"
```

**Framework Code:**
```typescript
// DatabaseContext.ts:192
setSessionVariable(key: string, value: any): void {
    this.sessionVariables.set(key, value);
    CSReporter.info(`Database operation - setSessionVariable, key: ${key}, value: ${value}`);
}

// DatabaseContext.ts:197
getSessionVariable(key: string): any {
    return this.sessionVariables.get(key);
}
```

---

### 5. Query Result Caching

**Framework Mechanism:**
- Store expensive query results with `storeResult(alias, result)`
- Reuse cached results instead of re-querying
- Improves performance for complex joins and aggregations

**Usage:**
```gherkin
# Execute expensive query once and cache
When user executes query "SELECT e.*, d.*, p.* FROM employees e JOIN departments d ON e.department_id = d.department_id LEFT JOIN employee_projects ep ON e.employee_id = ep.employee_id LEFT JOIN projects p ON ep.project_id = p.project_id" and stores result as "COMPLETE_EMPLOYEE_DATA"

# Use cached result for validation
Then the query result should have at least 40 rows

# Continue with other operations - cached result available in DatabaseContext
When user executes query "SELECT * FROM projects WHERE status = 'Active'"
```

---

### 6. Data-Driven Testing with Databases

**Scenario Outline with Database:**
```gherkin
Scenario Outline: Data-Driven Database Testing
  When user connects to "PRACTICE_ORACLE" database

  # Use example data in query
  When user executes query "SELECT * FROM employees WHERE department_id = <dept_id>"
  Then the query result should have <expected_count> rows
  And all values in column "department_id" should be "<dept_id>"

  When user disconnects from "PRACTICE_ORACLE" database

  Examples:
    | dept_id | expected_count |
    | 10      | 4              |
    | 20      | 2              |
    | 30      | 1              |
    | 40      | 1              |
```

**Multi-Database Data-Driven:**
```gherkin
Scenario Outline: Multi-Database Testing
  When user connects to "<database>" database
  When user executes query "<count_query>"
  Then the value in row 1 column "<count_column>" should not be null
  When user disconnects from "<database>" database

  Examples:
    | database         | count_query                     | count_column |
    | PRACTICE_ORACLE  | SELECT COUNT(*) AS cnt FROM emp | cnt          |
    | PRACTICE_MYSQL   | SELECT COUNT(*) AS total FROM e | total        |
```

---

### 7. Query History & Performance Tracking

**Framework Mechanism:**
- `DatabaseContext` maintains `queryHistory: QueryHistoryEntry[]` (line 14)
- Each query execution creates a history entry with:
  - `query` - SQL statement
  - `params` - Query parameters
  - `result` - Query result
  - `timestamp` - Execution time
  - `duration` - Execution duration in ms
  - `connectionName` - Database connection used
  - `success` - Whether query succeeded
  - `executionPlan` - Execution plan (if profiled)

**Usage:**
```gherkin
# Enable query logging to track performance
When user enables database query logging

# Execute queries - framework tracks each one
When user executes query "SELECT * FROM employees"
When user executes query "SELECT * FROM departments"
When user executes query "SELECT * FROM projects WHERE status = 'Active'"

# Framework automatically tracks:
# - Query execution time
# - Number of rows returned
# - Success/failure status
# - Timestamp

# View query history programmatically:
# DatabaseContext.getInstance().getQueryHistory()
```

**Query Profiling:**
```gherkin
# Get execution plan for complex query
When user profiles query "SELECT e.*, d.* FROM employees e JOIN departments d ON e.department_id = d.department_id"
Then the query result should have at least 40 rows

# View execution plan
And user logs query execution plan
# Shows: index usage, join type, row estimates, query cost
```

**Framework Code:**
```typescript
// DatabaseContext.ts:71
async executeQuery(query: string, params?: any[]): Promise<QueryResult> {
    const startTime = Date.now();
    const result = await adapter.query(this.activeConnection, query, params, options);

    const historyEntry: QueryHistoryEntry = {
        query,
        result,
        timestamp: new Date(),
        duration: Date.now() - startTime,
        connectionName: this.activeConnectionName,
        success: true
    };
    this.addToHistory(historyEntry);

    return result;
}
```

---

### 8. Query from File

**Framework Mechanism:**
- Step: `user executes query from file "{string}"`
- Framework searches for SQL files in:
  - `./test-data/queries/`
  - `./resources/queries/`
  - `./queries/`
  - Direct path

**Usage:**
```gherkin
# Place SQL in file: test-data/queries/get_employees.sql
# Contents: SELECT * FROM employees WHERE department_id = 10

When user executes query from file "get_employees.sql"
Then the query result should have 4 rows
```

**File Example:**
```sql
-- test-data/queries/get_it_dept_stats.sql
SELECT
    d.department_name,
    COUNT(e.employee_id) AS emp_count,
    AVG(e.salary) AS avg_salary,
    MIN(e.salary) AS min_salary,
    MAX(e.salary) AS max_salary
FROM departments d
JOIN employees e ON d.department_id = e.department_id
WHERE d.department_id = 10
GROUP BY d.department_id, d.department_name
```

**Framework Code:**
```typescript
// QueryExecutionSteps.ts:19
@CSBDDStepDef('user executes query from file {string}')
async executeQueryFromFile(filePath: string): Promise<void> {
    const resolvedPath = this.resolveFilePath(filePath);
    const content = await fs.promises.readFile(resolvedPath, 'utf-8');
    const query = content;
    const interpolatedQuery = this.interpolateVariables(query);

    const result = await this.databaseContext.executeQuery(interpolatedQuery);
    this.databaseContext.storeResult('last', result);
}
```

---

## 🎯 Complete Feature Comparison

| Feature | Basic Demo | Advanced Demo | Framework Support |
|---------|------------|---------------|-------------------|
| Basic Query Execution | ✅ | ✅ | ✅ |
| Predefined Queries (.env) | ❌ | ✅ | ✅ |
| Context Storage | ❌ | ✅ | ✅ |
| Variable Interpolation ${ENV} | ❌ | ✅ | ✅ |
| Variable Interpolation %CONFIG% | ❌ | ✅ | ✅ |
| Variable Interpolation {{context}} | ❌ | ✅ | ✅ |
| Session Variables | ❌ | ✅ | ✅ |
| Query Result Caching | ❌ | ✅ | ✅ |
| Data-Driven Testing | ❌ | ✅ | ✅ |
| Query from File | ❌ | ✅ | ✅ |
| Query History Tracking | ❌ | ✅ | ✅ |
| Performance Profiling | ✅ | ✅ | ✅ |
| Execution Plans | ✅ | ✅ | ✅ |
| Transaction Management | ✅ | ✅ | ✅ |
| Multi-Database | ✅ | ✅ | ✅ |

---

## 📊 Real-World Usage Example

### Complete Data Pipeline with All Features

```gherkin
Scenario: Real-World Data Pipeline with Context Storage
  When user connects to "PRACTICE_MYSQL" database
  And user enables database query logging

  # Step 1: Extract - Using predefined query from .env
  When user executes predefined query "MYSQL_GET_ACTIVE_PROJECTS" and stores result as "ACTIVE_PROJECTS"
  Then the query result should have at least 5 rows

  # Step 2: Transform - Get team allocations with variable interpolation
  # Uses DB_QUERY_MYSQL_PROJECTS_WITH_TEAM from mysql_queries.env
  When user executes predefined query "MYSQL_PROJECTS_WITH_TEAM" and stores result as "PROJECT_TEAMS"
  Then the query result should have at least 8 rows

  # Step 3: Analyze - Get employee workload (cached for performance)
  When user executes predefined query "MYSQL_EMPLOYEE_WORKLOAD" and stores result as "EMPLOYEE_WORKLOAD"
  Then the query result should have at least 40 rows

  # Step 4: Aggregate - Using context variable from previous query
  When user executes query "SELECT SUM(budget) AS total FROM projects WHERE status = 'Active'" and stores result as "FINANCIALS"
  Then the value in row 1 column "total" should not be null

  # Step 5: Report - Query using context variable interpolation
  # Framework replaces {{min_hours}} with value from context
  When user executes query "SELECT * FROM employee_projects WHERE hours_allocated > {{min_hours}}"

  # All results cached in DatabaseContext.storedResults
  # Query history tracked in DatabaseContext.queryHistory
  # Session variables persist for next scenario

  When user disables database query logging
  And user disconnects from "PRACTICE_MYSQL" database
```

---

## 🚀 Running the Advanced Tests

```bash
# Run all advanced feature scenarios
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-advanced-features.feature

# Run only predefined query scenarios
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-advanced-features.feature --tags="@predefined-queries"

# Run only context storage scenarios
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-advanced-features.feature --tags="@context-storage"

# Run only variable interpolation scenarios
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-advanced-features.feature --tags="@variable-interpolation"

# Run data-driven scenarios
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-advanced-features.feature --tags="@data-driven"

# Run all database tests (basic + advanced)
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-*.feature
```

---

## 📝 Summary of All Features

### Files Created:
1. ✅ `config/orangehrm/common/oracle_queries.env` - 60+ Oracle queries
2. ✅ `config/orangehrm/common/mysql_queries.env` - 80+ MySQL queries
3. ✅ `test/orangehrm/features/database-advanced-features.feature` - 30+ scenarios
4. ✅ `DATABASE_ADVANCED_FEATURES.md` - This documentation

### Features Demonstrated:
1. ✅ **Predefined Queries from .env Files** - Execute queries by name
2. ✅ **Context Storage** - Store and reuse query results
3. ✅ **Variable Interpolation** - All 3 types (${ENV}, %CONFIG%, {{context}})
4. ✅ **Session Variables** - Cross-scenario data sharing
5. ✅ **Query Result Caching** - Performance optimization
6. ✅ **Data-Driven Testing** - Scenario Outlines with databases
7. ✅ **Query from Files** - Load SQL from external files
8. ✅ **Query History** - Performance tracking
9. ✅ **Query Profiling** - Execution plans
10. ✅ **Multi-Database** - Switch between Oracle and MySQL

### Total Scenarios:
- **Basic Demo:** 49 scenarios
- **Advanced Demo:** 30 scenarios
- **Total:** 79 comprehensive database testing scenarios

---

## 🔗 Related Documentation
- [DATABASE_TESTING_GUIDE.md](./DATABASE_TESTING_GUIDE.md) - Basic features guide
- [config/global.env](./config/global.env) - Global configuration
- [config/orangehrm/common/oracle_queries.env](./config/orangehrm/common/oracle_queries.env) - Oracle queries
- [config/orangehrm/common/mysql_queries.env](./config/orangehrm/common/mysql_queries.env) - MySQL queries

---

**Created:** 2025-10-10
**Framework Version:** cs-playwright-test-framework 1.0.0+
**Author:** CS Framework Team
