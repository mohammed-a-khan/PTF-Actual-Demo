# API Testing Examples

This directory contains comprehensive API testing examples using the CS Test Automation Framework. These examples demonstrate various testing patterns, from basic HTTP operations to complex e-commerce workflows.

## Example Files

### 1. **httpbin-api-examples.feature**
Basic API testing examples using httpbin.org for learning and validation:
- Simple GET/POST/PUT/DELETE requests
- Header manipulation
- Authentication (Basic Auth, Bearer Token)
- Query parameters and form data
- Status code validation
- Cookie handling
- Response chaining and variable usage

**Key Learning Points:**
- Basic API testing fundamentals
- Request/response validation
- Variable usage and data extraction
- Simple authentication patterns

### 2. **advanced-api-examples.feature**
Advanced API testing scenarios demonstrating complex features:
- CRUD operations with data chaining
- Parallel request execution
- OAuth2 authentication simulation
- Schema validation and data types
- Error handling and retry mechanisms
- Conditional requests and business logic
- File operations and multipart forms
- Performance monitoring
- Security testing
- Circuit breaker patterns
- Data transformation and JSON manipulation

**Key Learning Points:**
- Advanced validation techniques
- Performance testing patterns
- Security validation approaches
- Complex data workflows
- Resilience testing

### 3. **authentication-examples.feature**
Comprehensive authentication method examples:
- Basic Authentication
- Bearer Token Authentication
- API Key (Header and Query)
- OAuth2 Client Credentials Flow
- JWT Token Authentication
- Digest Authentication
- Certificate-based Authentication (mTLS)
- AWS Signature V4 Authentication
- NTLM Authentication
- Hawk Authentication
- Custom Authentication Patterns
- Token Refresh Workflows
- Session Cookie Authentication
- Multi-Factor Authentication
- Role-Based Access Control
- Scoped Permissions

**Key Learning Points:**
- All 11 supported authentication types
- Token management and refresh
- Security best practices
- Access control patterns

### 4. **validation-examples.feature**
Response validation and assertion examples:
- Status code validation
- Header validation
- JSONPath validation (basic and advanced)
- Nested object validation
- Array operations and validation
- Data type validation
- String pattern validation
- Response content validation
- Performance timing validation
- JSON Schema validation
- Conditional validation
- Cross-field validation
- Error response validation
- Batch response validation
- Data integrity validation
- Custom business rule validation
- Regex pattern validation
- Hash and checksum validation

**Key Learning Points:**
- Comprehensive validation techniques
- Data integrity checks
- Performance assertions
- Error handling validation

### 5. **utilities-examples.feature**
Utility functions and data manipulation examples:
- Variable management (save, retrieve, print)
- Dynamic data generation (UUID, timestamp, random)
- Response data extraction
- String manipulation and transformation
- Encoding/decoding operations (Base64, URL)
- Hashing operations (MD5, SHA256)
- String concatenation and comparison
- Timing and delay operations
- File operations for test data
- Context and variable management
- Debugging and logging utilities
- Conditional logic and flow control
- Data validation helpers
- Performance measurement utilities
- Test cleanup and resource management

**Key Learning Points:**
- Test data management
- Dynamic data generation
- Debugging techniques
- Helper functions usage

### 6. **ecommerce-workflow-example.feature**
Complete e-commerce workflow demonstrating real-world scenarios:
- User Registration and Profile Management
- Product Catalog Browsing
- Shopping Cart Operations
- Order Creation and Management
- Payment Processing Workflow
- Inventory Management
- Customer Service Operations
- Reporting and Analytics
- Notification System
- Order Fulfillment
- Returns and Refunds Processing
- Final Reporting and Cleanup

**Key Learning Points:**
- End-to-end business process testing
- Complex data workflows
- State management across multiple requests
- Real-world API integration patterns

## Running the Examples

### Prerequisites
1. Ensure the CS Test Automation Framework is properly installed
2. Configure your environment with appropriate base URLs
3. Set up any required authentication tokens or credentials

### Running Individual Examples

```bash
# Run basic examples
npm run test:api -- --name "HTTPBin API Testing"

# Run advanced examples
npm run test:api -- --name "Advanced API Testing"

# Run authentication examples
npm run test:api -- --name "API Authentication"

# Run validation examples
npm run test:api -- --name "API Response Validation"

# Run utility examples
npm run test:api -- --name "API Testing Utilities"

# Run e-commerce workflow
npm run test:api -- --name "E-commerce API Workflow"
```

### Running by Tags

```bash
# Run all basic examples
npm run test:api -- --tags "@simple"

# Run authentication tests
npm run test:api -- --tags "@auth"

# Run validation tests
npm run test:api -- --tags "@validation"

# Run parallel execution examples
npm run test:api -- --tags "@parallel"

# Run performance tests
npm run test:api -- --tags "@performance"
```

### Running All Examples

```bash
# Run all API examples
npm run test:api

# Run with specific workers for parallel execution
npm run test:api -- --parallel --workers 4
```

## Configuration

### Environment Variables
Set up environment variables for different test environments:

```bash
# Development
export API_BASE_URL=https://api.dev.example.com
export API_TOKEN=dev-token-123

# Staging
export API_BASE_URL=https://api.staging.example.com
export API_TOKEN=staging-token-456

# Production (for read-only tests)
export API_BASE_URL=https://api.example.com
export API_TOKEN=prod-token-789
```

### Test Data
Create test data files in appropriate directories:
- `test-data/api/` - General API test data
- `test-data/api/schemas/` - JSON Schema files for validation
- `test-data/api/requests/` - Pre-defined request templates

## Best Practices Demonstrated

### 1. Context Management
- Use descriptive context names
- Separate contexts for different test environments
- Clear contexts between unrelated tests

### 2. Variable Usage
- Extract and reuse data between requests
- Use meaningful variable names
- Clean up sensitive data after tests

### 3. Validation Patterns
- Validate both positive and negative scenarios
- Use appropriate validation methods for data types
- Implement comprehensive error checking

### 4. Performance Considerations
- Monitor response times
- Use parallel execution where appropriate
- Implement proper retry mechanisms

### 5. Security Testing
- Test various authentication methods
- Validate authorization boundaries
- Check for proper error handling

### 6. Data Management
- Generate dynamic test data
- Use data-driven testing approaches
- Implement proper cleanup procedures

## Troubleshooting

### Common Issues
1. **Context not set**: Always start scenarios with context setup
2. **Variable not found**: Ensure variables are saved before use
3. **Authentication failures**: Verify tokens and credentials
4. **Timeout issues**: Adjust timeout settings for slow endpoints

### Debug Mode
Enable detailed logging for troubleshooting:

```bash
npm run test:api -- --debug
```

### Output Analysis
- Check generated reports in `reports/` directory
- Review exported context files for debugging
- Use print statements for variable inspection

## Extending Examples

### Adding New Examples
1. Create new .feature files following the existing patterns
2. Use appropriate tags for categorization
3. Include comprehensive documentation
4. Add both positive and negative test cases

### Custom Step Definitions
Extend the framework with custom steps as needed:

```typescript
@CSBDDStepDef("custom step definition")
async customStep(): Promise<void> {
    // Implementation
}
```

These examples provide a comprehensive foundation for API testing with the CS Test Automation Framework, covering everything from basic operations to complex real-world workflows.