const { AdvancedASTParser } = require('./dist/codegen/parser/ASTParser.js');
const { SymbolicExecutionEngine } = require('./dist/codegen/analyzer/SymbolicExecutionEngine.js');
const { IntelligentCodeGenerator } = require('./dist/codegen/generator/IntelligentCodeGenerator.js');
const fs = require('fs');
const path = require('path');

async function test() {
    try {
        console.log('🧪 Testing Feature File and Step Definitions Sync\n');

        const sourceCode = fs.readFileSync('.temp/codegen/test.spec.ts', 'utf-8');
        const parser = new AdvancedASTParser();
        const symbolicEngine = new SymbolicExecutionEngine();
        const codeGenerator = new IntelligentCodeGenerator();

        const analysis = parser.parse(sourceCode);
        const intentAnalysis = await symbolicEngine.executeSymbolically(analysis);
        const generatedCode = await codeGenerator.generate(analysis, intentAnalysis, 'Application Navigation');

        // Write generated files
        const testDir = './test';
        const pageDir = path.join(testDir, 'pages');
        const stepsDir = path.join(testDir, 'steps');
        const featuresDir = path.join(testDir, 'features');

        [pageDir, stepsDir, featuresDir].forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });

        // Write files
        fs.writeFileSync(path.join(pageDir, generatedCode.pageObjects[0].fileName), generatedCode.pageObjects[0].content);
        fs.writeFileSync(path.join(stepsDir, generatedCode.stepDefinitions[0].fileName), generatedCode.stepDefinitions[0].content);
        fs.writeFileSync(path.join(featuresDir, generatedCode.feature.fileName), generatedCode.feature.content);

        // Read generated files
        const featureContent = fs.readFileSync(path.join(featuresDir, generatedCode.feature.fileName), 'utf-8');
        const stepsContent = fs.readFileSync(path.join(stepsDir, generatedCode.stepDefinitions[0].fileName), 'utf-8');

        console.log('📄 Generated Feature File:\n');
        console.log(featureContent);
        console.log('\n📄 Generated Step Definitions:\n');
        console.log(stepsContent);

        // Extract steps from feature file
        const featureSteps = [];
        const featureLines = featureContent.split('\n');
        for (const line of featureLines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Given ') || trimmed.startsWith('When ') || trimmed.startsWith('And ') || trimmed.startsWith('Then ')) {
                const stepText = trimmed.replace(/^(Given|When|And|Then)\s+/, '');
                featureSteps.push(stepText);
            }
        }

        // Extract step definitions
        const stepDefPattern = /@CSBDDStepDef\('([^']+)'\)/g;
        const stepDefs = [];
        let match;
        while ((match = stepDefPattern.exec(stepsContent)) !== null) {
            stepDefs.push(match[1]);
        }

        console.log('\n🔍 Verification:\n');
        console.log(`Feature Steps (${featureSteps.length}):`);
        featureSteps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));

        console.log(`\nStep Definitions (${stepDefs.length}):`);
        stepDefs.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));

        // Check if they match
        console.log('\n✅ Matching Steps:');
        const unmatchedFeatureSteps = [];
        const unmatchedStepDefs = [];

        for (const featureStep of featureSteps) {
            // Convert feature step to match step def pattern
            const featureStepPattern = featureStep.replace(/"[^"]+"/g, '{string}');

            const hasMatch = stepDefs.some(stepDef => {
                // Exact match
                if (stepDef === featureStep) return true;
                // Pattern match (replace quoted values with {string})
                const stepDefPattern = stepDef.replace(/\{string\}/g, '{string}');
                return stepDefPattern === featureStepPattern;
            });

            if (hasMatch) {
                console.log(`  ✓ "${featureStep}"`);
            } else {
                unmatchedFeatureSteps.push(featureStep);
            }
        }

        if (unmatchedFeatureSteps.length > 0) {
            console.log('\n❌ Unmatched Feature Steps:');
            unmatchedFeatureSteps.forEach(step => console.log(`  ✗ "${step}"`));
        }

        // Check for unused step definitions
        for (const stepDef of stepDefs) {
            const stepDefPattern = stepDef.replace(/\{string\}/g, '"[^"]+"');
            const regex = new RegExp(stepDefPattern);

            const hasMatch = featureSteps.some(featureStep => {
                // Exact match
                if (featureStep === stepDef) return true;
                // Pattern match
                const featureStepWithPlaceholder = featureStep.replace(/"[^"]+"/g, '{string}');
                return stepDef === featureStepWithPlaceholder;
            });

            if (!hasMatch) {
                unmatchedStepDefs.push(stepDef);
            }
        }

        if (unmatchedStepDefs.length > 0) {
            console.log('\n⚠️  Unused Step Definitions:');
            unmatchedStepDefs.forEach(step => console.log(`  • "${step}"`));
        }

        if (unmatchedFeatureSteps.length === 0) {
            console.log('\n✨ All feature steps have matching step definitions!\n');
        } else {
            console.log('\n❌ Feature file and step definitions are NOT in sync\n');
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

test();
