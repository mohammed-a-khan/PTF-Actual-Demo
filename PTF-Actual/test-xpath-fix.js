const { AdvancedASTParser } = require('./dist/codegen/parser/ASTParser.js');
const { SymbolicExecutionEngine } = require('./dist/codegen/analyzer/SymbolicExecutionEngine.js');
const { IntelligentCodeGenerator } = require('./dist/codegen/generator/IntelligentCodeGenerator.js');
const fs = require('fs');
const path = require('path');

async function test() {
    try {
        console.log('🧪 Testing XPath Fix\n');

        const sourceCode = fs.readFileSync('.temp/codegen/test.spec.ts', 'utf-8');
        const parser = new AdvancedASTParser();
        const symbolicEngine = new SymbolicExecutionEngine();
        const codeGenerator = new IntelligentCodeGenerator();

        const analysis = parser.parse(sourceCode);
        const intentAnalysis = await symbolicEngine.executeSymbolically(analysis);
        const generatedCode = await codeGenerator.generate(analysis, intentAnalysis, 'Application Navigation');

        const testDir = './test';
        const pageDir = path.join(testDir, 'pages');
        if (!fs.existsSync(pageDir)) fs.mkdirSync(pageDir, { recursive: true });

        fs.writeFileSync(path.join(pageDir, generatedCode.pageObjects[0].fileName), generatedCode.pageObjects[0].content);

        const pageContent = fs.readFileSync(path.join(pageDir, generatedCode.pageObjects[0].fileName), 'utf-8');

        // Check for correct XPath
        const hasCorrectXPath = pageContent.includes('xpath://*[@role="textbox" and @name="Username"]');
        const hasWrongXPath = pageContent.includes('xpath:////role=');

        console.log('XPath Verification:\n');
        console.log(`✓ Correct XPath format:  ${hasCorrectXPath ? '✅' : '❌'}`);
        console.log(`✓ No //// in XPath:      ${!hasWrongXPath ? '✅' : '❌'}`);

        // Show sample XPath
        const xpathMatch = pageContent.match(/xpath:([^\n']+)/);
        if (xpathMatch) {
            console.log(`\n📝 Sample XPath: ${xpathMatch[1]}`);
        }

        if (hasCorrectXPath && !hasWrongXPath) {
            console.log('\n✨ XPath fix verified successfully!\n');
        } else {
            console.log('\n❌ XPath still has issues\n');
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

test();
