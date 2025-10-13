# CS Playwright Framework - Available Step Definitions

This file helps VS Code Cucumber extension recognize framework steps without node_modules dependency.

## API Steps
```gherkin
Given user sends GET request to "/api/endpoint"
When user sends POST request to "/api/endpoint" with body:
Then response status should be 200
And response body should contain "success"
And response JSON path "$.data.id" should equal "123"
```

## Database Steps
```gherkin
Given user connects to "DATABASE_ALIAS" database
When user executes query "SELECT * FROM table"
Then the query result should have 5 rows
And the value in row 1 column "name" should be "John"
```

## Common Steps
```gherkin
Given I navigate to "https://example.com"
When I click on "Button Text"
Then I should see "Expected Text"
And I wait for 3 seconds
```

For complete list, see framework documentation or check:
node_modules/cs-playwright-test-framework/dist/steps/
