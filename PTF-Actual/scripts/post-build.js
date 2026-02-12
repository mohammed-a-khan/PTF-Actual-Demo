#!/usr/bin/env node

/**
 * Post-build script
 * 1. Fix CSCustomChartsEmbedded.js for browser embedding
 * 2. Invalidate step cache to ensure fresh cache after build
 */

const fs = require('fs');
const path = require('path');

// Task 1: Clean CSCustomChartsEmbedded.js for browser embedding
const chartsFilePath = path.join(__dirname, '../dist/reporter/CSCustomChartsEmbedded.js');

try {
    let content = fs.readFileSync(chartsFilePath, 'utf8');

    // Remove all export statements (CommonJS)
    content = content.replace(/^exports\.[^=]+=\s*[^;]+;$/gm, '');
    content = content.replace(/^Object\.defineProperty\(exports[^)]+\);$/gm, '');
    content = content.replace(/^exports\.__esModule\s*=\s*[^;]+;$/gm, '');

    // Remove require statements
    content = content.replace(/^"use strict";$/gm, '');
    content = content.replace(/^Object\.defineProperty\(exports[^)]+\);$/gm, '');

    // Clean up extra blank lines
    content = content.replace(/\n{3,}/g, '\n\n');

    // Write back the cleaned content
    fs.writeFileSync(chartsFilePath, content, 'utf8');

    console.log('✅ CSCustomChartsEmbedded.js cleaned for browser embedding');
} catch (error) {
    console.error('❌ Error processing CSCustomChartsEmbedded.js:', error.message);
    process.exit(1);
}

// Task 2 (removed): Agent .md files are now embedded into TypeScript at build time
// via scripts/embed-agents.js -> src/mcp/agents/embeddedAgentContent.ts
// No need to copy .md files to dist anymore.

// Task 3: Invalidate step cache (ensures fresh cache after code changes)
const cachePath = path.join(process.cwd(), '.cs-step-cache.json');

try {
    if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
        console.log('✅ Step cache invalidated for rebuild');
    }
} catch (error) {
    // Non-critical - just warn
    console.warn('⚠️  Failed to invalidate step cache:', error.message);
}
