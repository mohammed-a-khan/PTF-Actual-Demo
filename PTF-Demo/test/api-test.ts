import { CSAPIClient, CSAPIExecutor, CSRequestBuilder } from '@mdakhan.mak/cs-playwright-test-framework/api';

async function testAPIFunctionality() {
    console.log('Testing API functionality...');

    // Test 1: Basic client creation
    const client = new CSAPIClient();
    client.setBaseUrl('https://jsonplaceholder.typicode.com');
    console.log('✓ API Client created');

    // Test 2: Request builder
    const builder = new CSRequestBuilder();
    const request = builder
        .setUrl('https://jsonplaceholder.typicode.com/posts/1')
        .setMethod('GET')
        .build();
    console.log('✓ Request builder working');

    // Test 3: API Executor
    const executor = new CSAPIExecutor();
    console.log('✓ API Executor created');

    // Test 4: Simple GET request
    try {
        const response = await client.get('/posts/1');
        console.log('✓ GET request successful');
        console.log('Response status:', response.status);
    } catch (error) {
        console.error('✗ GET request failed:', error);
    }

    // Test 5: Execute requests via executor
    try {
        const result = await executor.execute(
            [
                { url: 'https://jsonplaceholder.typicode.com/posts/1', method: 'GET' },
                { url: 'https://jsonplaceholder.typicode.com/posts/2', method: 'GET' }
            ],
            { mode: 'parallel' }
        );
        console.log('✓ API Executor execute successful');
        console.log('Results:', result.successfulRequests, 'successful,', result.failedRequests, 'failed');
    } catch (error) {
        console.error('✗ API Executor execute failed:', error);
    }

    console.log('\nAll tests completed!');
}

testAPIFunctionality().catch(console.error);