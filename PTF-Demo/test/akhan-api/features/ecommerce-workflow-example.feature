Feature: E-commerce API Workflow Example
  As a QA engineer
  I want to test a complete e-commerce workflow
  So that I can validate end-to-end business processes

  Background:
    Given user is working with API context "ecommerce"
    And user sets base URL to "https://jsonplaceholder.typicode.com"
    And user generates UUID and saves as "sessionId"
    And user sets request header "X-Session-ID" to "{{sessionId}}"

  @api @ecommerce @user-management
  Scenario: User Registration and Profile Management
    # Register new user
    Given user generates UUID and saves as "uniqueId"
    And user sets request body to:
      """
      {
        "name": "John Doe",
        "username": "johndoe_{{uniqueId}}",
        "email": "john.doe.{{uniqueId}}@example.com",
        "phone": "+1-555-0123",
        "website": "johndoe.org",
        "address": {
          "street": "123 Main St",
          "suite": "Apt 1",
          "city": "Anytown",
          "zipcode": "12345",
          "geo": {
            "lat": "40.7128",
            "lng": "-74.0060"
          }
        },
        "company": {
          "name": "John's Company",
          "catchPhrase": "Quality Products"
        }
      }
      """
    When user sends POST request to "/users" and saves response as "user-registration"
    Then response status should be 201
    And response JSON path "$.name" should equal "John Doe"
    And response JSON path "$.email" should contain "@example.com"
    And user saves response JSON path "$.id" as "customerId"

    # Get user profile
    When user sends GET request to "/users/{{customerId}}" and saves response as "user-profile"
    Then response status should be 200
    And response JSON path "$.id" should equal "{{customerId}}"

    # Update user profile
    Given user sets request body to:
      """
      {
        "name": "John Updated",
        "phone": "+1-555-9999"
      }
      """
    When user sends PATCH request to "/users/{{customerId}}" and saves response as "profile-update"
    Then response status should be 200
    And response JSON path "$.name" should equal "John Updated"

  @api @ecommerce @product-catalog
  Scenario: Product Catalog Management
    # Browse products (simulated with posts)
    When user sends GET request to "/posts" and saves response as "product-catalog"
    Then response status should be 200
    And response JSON path "$" should be of type "array"
    And response JSON path "$" array should have length greater than 0
    And user saves response JSON path "$[0].id" as "product1Id"
    And user saves response JSON path "$[1].id" as "product2Id"
    And user saves response JSON path "$[0].title" as "product1Name"
    And user saves response JSON path "$[1].title" as "product2Name"

    # Get product details
    When user sends GET request to "/posts/{{product1Id}}" and saves response as "product1-details"
    Then response status should be 200
    And response JSON path "$.id" should equal "{{product1Id}}"
    And response JSON path "$.title" should equal "{{product1Name}}"

    # Search products (simulated with query parameters)
    Given user sets query parameter "userId" to "1"
    When user sends GET request to "/posts" and saves response as "filtered-products"
    Then response status should be 200
    And response JSON path "$" should be of type "array"

  @api @ecommerce @shopping-cart
  Scenario: Shopping Cart Operations
    # Add item to cart (simulated with post creation)
    Given user saves "100" as "customerId"
    And user sets request body to:
      """
      {
        "userId": {{customerId}},
        "productId": "{{product1Id}}",
        "productName": "{{product1Name}}",
        "quantity": 2,
        "price": 29.99,
        "action": "add_to_cart"
      }
      """
    When user sends POST request to "/posts" and saves response as "cart-add-item1"
    Then response status should be 201
    And user saves response JSON path "$.id" as "cartItem1Id"

    # Add another item to cart
    Given user sets request body to:
      """
      {
        "userId": {{customerId}},
        "productId": "{{product2Id}}",
        "productName": "{{product2Name}}",
        "quantity": 1,
        "price": 49.99,
        "action": "add_to_cart"
      }
      """
    When user sends POST request to "/posts" and saves response as "cart-add-item2"
    Then response status should be 201
    And user saves response JSON path "$.id" as "cartItem2Id"

    # View cart contents (get user's posts)
    When user sends GET request to "/users/{{customerId}}/posts" and saves response as "cart-contents"
    Then response status should be 200
    And response JSON path "$" should be of type "array"

    # Update cart item quantity
    Given user sets request body to:
      """
      {
        "userId": {{customerId}},
        "productId": "{{product1Id}}",
        "quantity": 3,
        "price": 29.99,
        "action": "update_quantity"
      }
      """
    When user sends PUT request to "/posts/{{cartItem1Id}}" and saves response as "cart-update"
    Then response status should be 200

    # Calculate cart total
    Given user saves "179.97" as "cartTotal"  # 3 * 29.99 + 1 * 49.99

  @api @ecommerce @order-management
  Scenario: Order Creation and Management
    # Create order from cart
    Given user generates UUID and saves as "orderId"
    And user generates timestamp and saves as "orderDate"
    And user sets request body to:
      """
      {
        "orderId": "{{orderId}}",
        "customerId": "{{customerId}}",
        "orderDate": {{orderDate}},
        "items": [
          {
            "productId": "{{product1Id}}",
            "productName": "{{product1Name}}",
            "quantity": 3,
            "unitPrice": 29.99,
            "totalPrice": 89.97
          },
          {
            "productId": "{{product2Id}}",
            "productName": "{{product2Name}}",
            "quantity": 1,
            "unitPrice": 49.99,
            "totalPrice": 49.99
          }
        ],
        "subtotal": 139.96,
        "tax": 11.20,
        "shipping": 9.99,
        "total": 161.15,
        "status": "pending"
      }
      """
    When user sends POST request to "/posts" and saves response as "order-creation"
    Then response status should be 201
    And user saves response JSON path "$.id" as "orderRecordId"

    # Get order details
    When user sends GET request to "/posts/{{orderRecordId}}" and saves response as "order-details"
    Then response status should be 200

    # Update order status
    Given user sets request body to:
      """
      {
        "orderId": "{{orderId}}",
        "status": "confirmed",
        "confirmationDate": {{orderDate}},
        "estimatedDelivery": "2024-02-01"
      }
      """
    When user sends PATCH request to "/posts/{{orderRecordId}}" and saves response as "order-confirmation"
    Then response status should be 200

  @api @ecommerce @payment-processing
  Scenario: Payment Processing Workflow
    # Create payment intent
    Given user generates UUID and saves as "paymentId"
    And user sets request body to:
      """
      {
        "paymentId": "{{paymentId}}",
        "orderId": "{{orderId}}",
        "amount": 161.15,
        "currency": "USD",
        "paymentMethod": {
          "type": "credit_card",
          "cardNumber": "****-****-****-1234",
          "expiryMonth": "12",
          "expiryYear": "2025"
        },
        "status": "pending"
      }
      """
    When user sends POST request to "/posts" and saves response as "payment-intent"
    Then response status should be 201
    And user saves response JSON path "$.id" as "paymentRecordId"

    # Process payment
    Given user sets request body to:
      """
      {
        "paymentId": "{{paymentId}}",
        "status": "processing",
        "processedAt": {{orderDate}}
      }
      """
    When user sends PATCH request to "/posts/{{paymentRecordId}}" and saves response as "payment-processing"
    Then response status should be 200

    # Confirm payment
    Given user sets request body to:
      """
      {
        "paymentId": "{{paymentId}}",
        "status": "completed",
        "transactionId": "txn_{{paymentId}}",
        "completedAt": {{orderDate}}
      }
      """
    When user sends PATCH request to "/posts/{{paymentRecordId}}" and saves response as "payment-completion"
    Then response status should be 200

  @api @ecommerce @inventory-management
  Scenario: Inventory Updates and Management
    # Check initial inventory (simulated)
    Given user sets query parameter "productId" to "{{product1Id}}"
    When user sends GET request to "/posts" and saves response as "inventory-check"
    Then response status should be 200

    # Update inventory after purchase
    Given user sets request body to:
      """
      {
        "productId": "{{product1Id}}",
        "action": "inventory_update",
        "quantitySold": 3,
        "remainingStock": 47,
        "lastUpdated": {{orderDate}}
      }
      """
    When user sends POST request to "/posts" and saves response as "inventory-update"
    Then response status should be 201

    # Check low stock alert
    Given user sets request body to:
      """
      {
        "productId": "{{product1Id}}",
        "stockLevel": 47,
        "threshold": 50,
        "alertTriggered": true,
        "alertType": "low_stock"
      }
      """
    When user sends POST request to "/posts" and saves response as "stock-alert"
    Then response status should be 201

  @api @ecommerce @customer-service
  Scenario: Customer Service Operations
    # Create support ticket
    Given user generates UUID and saves as "ticketId"
    And user sets request body to:
      """
      {
        "ticketId": "{{ticketId}}",
        "customerId": "{{customerId}}",
        "orderId": "{{orderId}}",
        "subject": "Question about order delivery",
        "message": "When will my order be delivered?",
        "priority": "medium",
        "status": "open",
        "createdAt": {{orderDate}}
      }
      """
    When user sends POST request to "/posts" and saves response as "support-ticket"
    Then response status should be 201
    And user saves response JSON path "$.id" as "ticketRecordId"

    # Add response to ticket
    Given user sets request body to:
      """
      {
        "ticketId": "{{ticketId}}",
        "response": "Your order is currently being processed and will be shipped within 2-3 business days.",
        "respondedBy": "customer_service",
        "respondedAt": {{orderDate}},
        "status": "responded"
      }
      """
    When user sends PATCH request to "/posts/{{ticketRecordId}}" and saves response as "ticket-response"
    Then response status should be 200

  @api @ecommerce @reporting-analytics
  Scenario: Reporting and Analytics
    # Generate sales report
    Given user sets query parameter "userId" to "{{customerId}}"
    When user sends GET request to "/posts" and saves response as "customer-activity"
    Then response status should be 200
    And response JSON path "$" should be of type "array"

    # Create analytics summary
    Given user sets request body to:
      """
      {
        "reportType": "customer_summary",
        "customerId": "{{customerId}}",
        "period": "last_30_days",
        "metrics": {
          "ordersPlaced": 1,
          "totalSpent": 161.15,
          "averageOrderValue": 161.15,
          "supportTickets": 1
        },
        "generatedAt": {{orderDate}}
      }
      """
    When user sends POST request to "/posts" and saves response as "analytics-report"
    Then response status should be 201

  @api @ecommerce @notifications
  Scenario: Notification System
    # Send order confirmation email
    Given user sets request body to:
      """
      {
        "notificationType": "order_confirmation",
        "recipientEmail": "john.doe.{{uniqueId}}@example.com",
        "orderId": "{{orderId}}",
        "subject": "Order Confirmation - {{orderId}}",
        "message": "Your order has been confirmed and is being processed.",
        "sentAt": {{orderDate}},
        "status": "sent"
      }
      """
    When user sends POST request to "/posts" and saves response as "order-notification"
    Then response status should be 201

    # Send shipment notification
    Given user sets request body to:
      """
      {
        "notificationType": "shipment_notification",
        "recipientEmail": "john.doe.{{uniqueId}}@example.com",
        "orderId": "{{orderId}}",
        "trackingNumber": "TRACK123456789",
        "subject": "Your Order Has Shipped",
        "message": "Your order is on its way! Track your package with tracking number: TRACK123456789",
        "sentAt": {{orderDate}},
        "status": "sent"
      }
      """
    When user sends POST request to "/posts" and saves response as "shipment-notification"
    Then response status should be 201

  @api @ecommerce @order-fulfillment
  Scenario: Order Fulfillment Workflow
    # Update order to shipped status
    Given user sets request body to:
      """
      {
        "orderId": "{{orderId}}",
        "status": "shipped",
        "trackingNumber": "TRACK123456789",
        "carrier": "UPS",
        "shippedAt": {{orderDate}},
        "estimatedDelivery": "2024-02-05"
      }
      """
    When user sends PATCH request to "/posts/{{orderRecordId}}" and saves response as "order-shipment"
    Then response status should be 200

    # Delivery confirmation
    Given user waits for 1 seconds
    And user generates timestamp and saves as "deliveryDate"
    And user sets request body to:
      """
      {
        "orderId": "{{orderId}}",
        "status": "delivered",
        "deliveredAt": {{deliveryDate}},
        "receivedBy": "Customer",
        "deliveryNotes": "Left at front door"
      }
      """
    When user sends PATCH request to "/posts/{{orderRecordId}}" and saves response as "order-delivery"
    Then response status should be 200

  @api @ecommerce @returns-refunds
  Scenario: Returns and Refunds Processing
    # Create return request
    Given user generates UUID and saves as "returnId"
    And user sets request body to:
      """
      {
        "returnId": "{{returnId}}",
        "orderId": "{{orderId}}",
        "customerId": "{{customerId}}",
        "itemsToReturn": [
          {
            "productId": "{{product1Id}}",
            "quantity": 1,
            "reason": "Damaged item"
          }
        ],
        "returnReason": "Product arrived damaged",
        "refundAmount": 29.99,
        "status": "requested",
        "requestedAt": {{deliveryDate}}
      }
      """
    When user sends POST request to "/posts" and saves response as "return-request"
    Then response status should be 201
    And user saves response JSON path "$.id" as "returnRecordId"

    # Approve return
    Given user sets request body to:
      """
      {
        "returnId": "{{returnId}}",
        "status": "approved",
        "approvedAt": {{deliveryDate}},
        "returnLabel": "RETURN123456789",
        "instructions": "Package item securely and use provided return label"
      }
      """
    When user sends PATCH request to "/posts/{{returnRecordId}}" and saves response as "return-approval"
    Then response status should be 200

    # Process refund
    Given user sets request body to:
      """
      {
        "refundId": "ref_{{returnId}}",
        "returnId": "{{returnId}}",
        "amount": 29.99,
        "refundMethod": "original_payment_method",
        "status": "processed",
        "processedAt": {{deliveryDate}}
      }
      """
    When user sends POST request to "/posts" and saves response as "refund-processing"
    Then response status should be 201

  @api @ecommerce @cleanup-reporting
  Scenario: Final Reporting and Cleanup
    # Generate comprehensive report
    Given user sets request body to:
      """
      {
        "reportType": "transaction_summary",
        "sessionId": "{{sessionId}}",
        "customerId": "{{customerId}}",
        "orderId": "{{orderId}}",
        "summary": {
          "userRegistered": true,
          "productsViewed": 2,
          "itemsAddedToCart": 2,
          "orderPlaced": true,
          "paymentProcessed": true,
          "orderShipped": true,
          "orderDelivered": true,
          "returnRequested": true,
          "refundProcessed": true
        },
        "totalTransactionValue": 161.15,
        "netRevenue": 131.16,
        "completedAt": {{deliveryDate}}
      }
      """
    When user sends POST request to "/posts" and saves response as "final-report"
    Then response status should be 201

    # Export test data for analysis
    When user exports context to file "ecommerce-workflow-context.json"

    # Print key variables for verification
    Then user prints variable "customerId"
    And user prints variable "orderId"
    And user prints variable "sessionId"

    # Cleanup - Clear sensitive data
    When user clears variable "customerId"
    And user clears variable "sessionId"