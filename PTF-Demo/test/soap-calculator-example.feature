@soap @web-services @example
Feature: SOAP Calculator Web Service Testing
  As a QA Engineer
  I want to test SOAP web services
  So that I can validate calculator operations

  Background:
    Given I set SOAP version to "1.1"
    And I set SOAP endpoint to "http://www.dneonline.com/calculator.asmx"
    And I set SOAP namespace to "http://tempuri.org/"

  @TC001 @smoke @addition
  Scenario: Add two positive numbers
    Given I set SOAP action to "http://tempuri.org/Add"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Add" and parameters:
      | parameter | value |
      | intA      | 15    |
      | intB      | 25    |
    Then the SOAP response status should be 200
    And the SOAP response should be valid XML
    And the SOAP response should not contain fault
    And the SOAP response element "AddResult" should exist
    And the SOAP response element "AddResult" should have value "40"
    And I validate SOAP response time is less than 3000 ms

  @TC002 @smoke @subtraction
  Scenario: Subtract two numbers
    Given I set SOAP action to "http://tempuri.org/Subtract"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Subtract" and parameters:
      | parameter | value |
      | intA      | 100   |
      | intB      | 35    |
    Then the SOAP response status should be 200
    And the SOAP response should not contain fault
    And the SOAP response element "SubtractResult" should exist
    And the SOAP response element "SubtractResult" should have value "65"

  @TC003 @smoke @multiplication
  Scenario: Multiply two numbers
    Given I set SOAP action to "http://tempuri.org/Multiply"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Multiply" and parameters:
      | parameter | value |
      | intA      | 7     |
      | intB      | 8     |
    Then the SOAP response status should be 200
    And the SOAP response should not contain fault
    And the SOAP response element "MultiplyResult" should exist
    And the SOAP response element "MultiplyResult" should have value "56"

  @TC004 @smoke @division
  Scenario: Divide two numbers
    Given I set SOAP action to "http://tempuri.org/Divide"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Divide" and parameters:
      | parameter | value |
      | intA      | 100   |
      | intB      | 5     |
    Then the SOAP response status should be 200
    And the SOAP response should not contain fault
    And the SOAP response element "DivideResult" should exist
    And the SOAP response element "DivideResult" should have value "20"

  @TC005 @negative @division-by-zero
  Scenario: Divide by zero should handle gracefully
    Given I set SOAP action to "http://tempuri.org/Divide"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Divide" and parameters:
      | parameter | value |
      | intA      | 10    |
      | intB      | 0     |
    Then the SOAP response status should be 200
    # NOTE: Some SOAP services may return 500 for faults, adjust based on actual service behavior

  @TC006 @xpath @extraction
  Scenario: Extract result using XPath
    Given I set SOAP action to "http://tempuri.org/Add"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Add" and parameters:
      | parameter | value |
      | intA      | 45    |
      | intB      | 55    |
    Then the SOAP response status should be 200
    And I query SOAP response with XPath "AddResponse.AddResult" and save as "calculatedSum"
    And I print SOAP response

  @TC007 @variables @reuse
  Scenario: Use variables in SOAP requests
    Given I set variable "firstNumber" to "30"
    And I set variable "secondNumber" to "20"
    And I set SOAP action to "http://tempuri.org/Add"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Add" and parameters:
      | parameter | value             |
      | intA      | ${firstNumber}    |
      | intB      | ${secondNumber}   |
    Then the SOAP response status should be 200
    And the SOAP response element "AddResult" should have value "50"

  @TC008 @headers @validation
  Scenario: Validate SOAP response headers
    Given I set SOAP action to "http://tempuri.org/Add"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Add" and parameters:
      | parameter | value |
      | intA      | 5     |
      | intB      | 10    |
    Then the SOAP response status should be 200
    And the SOAP response Content-Type should be "text/xml"

  @TC009 @multiple-operations @chain
  Scenario: Chain multiple SOAP operations
    # First operation: Add
    Given I set SOAP action to "http://tempuri.org/Add"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Add" and parameters:
      | parameter | value |
      | intA      | 10    |
      | intB      | 5     |
    Then the SOAP response status should be 200
    And I query SOAP response with XPath "AddResponse.AddResult" and save as "addResult"

    # Second operation: Multiply the result
    Given I set SOAP action to "http://tempuri.org/Multiply"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "Multiply" and parameters:
      | parameter | value        |
      | intA      | ${addResult} |
      | intB      | 2            |
    Then the SOAP response status should be 200
    And the SOAP response element "MultiplyResult" should have value "30"

  @TC010 @performance @batch
  Scenario Outline: Batch calculator operations performance test
    Given I set SOAP action to "http://tempuri.org/<operation>"
    When I send SOAP request to "http://www.dneonline.com/calculator.asmx" with operation "<operation>" and parameters:
      | parameter | value   |
      | intA      | <num1>  |
      | intB      | <num2>  |
    Then the SOAP response status should be 200
    And the SOAP response should not contain fault
    And the SOAP response element "<resultElement>" should exist
    And I validate SOAP response time is less than 3000 ms

    Examples:
      | operation | num1 | num2 | resultElement    |
      | Add       | 1    | 2    | AddResult        |
      | Add       | 100  | 200  | AddResult        |
      | Subtract  | 50   | 25   | SubtractResult   |
      | Multiply  | 3    | 4    | MultiplyResult   |
      | Divide    | 20   | 4    | DivideResult     |

# ============================================================================
# IMPLEMENTATION NOTES:
# ============================================================================
#
# 1. SOAP VERSION:
#    - This example uses SOAP 1.1
#    - For SOAP 1.2, change: I set SOAP version to "1.2"
#    - SOAP 1.2 uses different namespace and Content-Type
#
# 2. PUBLIC SOAP SERVICE:
#    - Using public calculator service for demonstration
#    - URL: http://www.dneonline.com/calculator.asmx
#    - No authentication required
#    - Available operations: Add, Subtract, Multiply, Divide
#
# 3. SOAP ACTION:
#    - Required for SOAP 1.1
#    - Format: http://tempuri.org/{OperationName}
#    - Set using: I set SOAP action to "..."
#
# 4. PARAMETERS:
#    - Use data table format for parameters
#    - Supports variable substitution: ${variableName}
#    - Automatic type conversion
#
# 5. VALIDATION:
#    - Element existence: element "name" should exist
#    - Element value: element "name" should have value "..."
#    - XPath queries: query ... with XPath "path" and save as "var"
#    - Performance: response time is less than X ms
#
# 6. AUTHENTICATION:
#    - This service doesn't require authentication
#    - For authenticated services, use:
#      * Basic Auth: I send SOAP request with Basic Authentication...
#      * WS-Security: I add WS-Security UsernameToken...
#
# 7. ERROR HANDLING:
#    - SOAP faults are automatically detected
#    - Use: the SOAP response should not contain fault
#    - Or: the SOAP response should contain fault with code "..."
#
# 8. DEBUGGING:
#    - Use: I print SOAP request
#    - Use: I print SOAP response
#    - Check test reports for detailed XML
#
# ============================================================================
