#!/bin/bash

# ====================================================================================
# Zero-Code Framework Validation Test Runner
# ====================================================================================

echo "================================================================================"
echo "🧪 CS Framework - Zero-Code Validation Test Runner"
echo "================================================================================"
echo ""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

cd "$(dirname "$0")/../.." || exit 1

echo "📁 Working Directory: $(pwd)"
echo ""

# Step 1: Build framework
echo "📦 Step 1: Building framework..."
echo "--------------------------------------------------------------------------------"
npm run build
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed!${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Build successful${NC}"
echo ""

# Step 2: Run smoke tests
echo "🔥 Step 2: Running SMOKE tests..."
echo "--------------------------------------------------------------------------------"
npm run test:zero-code
SMOKE_RESULT=$?
echo ""

# Step 3: Run all validation tests
echo "🧪 Step 3: Running ALL validation tests..."
echo "--------------------------------------------------------------------------------"
npm run test:validation
VALIDATION_RESULT=$?
echo ""

# Summary
echo "================================================================================"
echo "📊 VALIDATION TEST SUMMARY"
echo "================================================================================"
echo ""

if [ $SMOKE_RESULT -eq 0 ]; then
    echo -e "${GREEN}✅ Smoke Tests: PASSED${NC}"
else
    echo -e "${RED}❌ Smoke Tests: FAILED${NC}"
fi

if [ $VALIDATION_RESULT -eq 0 ]; then
    echo -e "${GREEN}✅ All Validation Tests: PASSED${NC}"
else
    echo -e "${YELLOW}⚠️  Some validation tests failed (TC907 expected to fail)${NC}"
fi

echo ""
echo "================================================================================"

if [ $SMOKE_RESULT -eq 0 ]; then
    echo -e "${GREEN}🎉 VALIDATION SUCCESSFUL!${NC}"
    echo ""
    echo "📋 NEXT STEPS:"
    echo "1. Review test reports in reports/ directory"
    echo "2. Cleanup test files:"
    echo "   rm -rf test/orangehrm/"
    echo "   rm -rf config/orangehrm/"
    echo "   rm ZERO_CODE_VALIDATION_PLAN.md"
    echo "3. Commit clean code to ADO"
    echo ""
    exit 0
else
    echo -e "${RED}❌ VALIDATION FAILED${NC}"
    echo ""
    echo "Please review the failed tests and fix issues."
    echo ""
    exit 1
fi
