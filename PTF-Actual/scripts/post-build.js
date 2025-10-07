#!/usr/bin/env node

/**
 * Post-build script to fix CSCustomChartsEmbedded.js for browser embedding
 * Removes CommonJS exports and TypeScript imports to make it browser-compatible
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../dist/reporter/CSCustomChartsEmbedded.js');

try {
    let content = fs.readFileSync(filePath, 'utf8');

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
    fs.writeFileSync(filePath, content, 'utf8');

    console.log('✅ CSCustomChartsEmbedded.js cleaned for browser embedding');
} catch (error) {
    console.error('❌ Error processing CSCustomChartsEmbedded.js:', error.message);
    process.exit(1);
}
