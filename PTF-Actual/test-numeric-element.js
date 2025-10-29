const { IntelligentCodeGenerator } = require('./dist/codegen/generator/IntelligentCodeGenerator.js');

async function test() {
    console.log('🧪 Testing Numeric Element Name Handling\n');

    const generator = new IntelligentCodeGenerator();

    // Test cases for sanitizeIdentifier (private method, so we test through generateElementName)
    const testCases = [
        {
            description: 'Pure number (2)',
            target: {
                type: 'getByText',
                selector: '2',
                action: 'click'
            },
            expected: 'text2Link' // Should become text2Link not 2Link
        },
        {
            description: 'Starts with number (2fa)',
            target: {
                type: 'getByText',
                selector: '2fa',
                action: 'click'
            },
            expected: '_2faLink' // Should start with underscore
        },
        {
            description: 'Normal text',
            target: {
                type: 'getByText',
                selector: 'Login',
                action: 'click'
            },
            expected: 'loginLink'
        },
        {
            description: 'Empty or special chars only',
            target: {
                type: 'getByText',
                selector: '!!!',
                action: 'click'
            },
            expected: 'textElementLink' // Should handle gracefully
        }
    ];

    console.log('Test Results:\n');

    let passed = 0;
    let failed = 0;

    for (const test of testCases) {
        try {
            // Access private method through reflection
            const elementName = generator['generateElementName'](test.target);

            const success = elementName === test.expected;

            if (success) {
                console.log(`✅ ${test.description}`);
                console.log(`   Input: "${test.target.selector}"`);
                console.log(`   Output: ${elementName}`);
                passed++;
            } else {
                console.log(`❌ ${test.description}`);
                console.log(`   Input: "${test.target.selector}"`);
                console.log(`   Expected: ${test.expected}`);
                console.log(`   Got: ${elementName}`);
                failed++;
            }
            console.log('');
        } catch (error) {
            console.log(`❌ ${test.description} - ERROR`);
            console.log(`   ${error.message}`);
            failed++;
            console.log('');
        }
    }

    console.log('━'.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('━'.repeat(50));

    if (failed > 0) {
        console.log('\n⚠️  Some tests failed');
        process.exit(1);
    } else {
        console.log('\n✨ All tests passed!');
    }
}

test().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
