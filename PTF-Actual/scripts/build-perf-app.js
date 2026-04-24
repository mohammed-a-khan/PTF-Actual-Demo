#!/usr/bin/env node
/**
 * Build script for Performance Testing App
 *
 * Copies root .npmrc into each subdirectory before npm install
 * so that ADO pipeline authentication works in subdirectories.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const perfAppDir = path.join(rootDir, 'performance-testing-app');
const rootNpmrc = path.join(rootDir, '.npmrc');

const subdirs = ['shared', 'frontend', 'backend'];

// Step 1: Copy .npmrc to each subdirectory (if root .npmrc exists)
if (fs.existsSync(rootNpmrc)) {
    console.log('Copying .npmrc to perf app subdirectories for auth...');
    for (const sub of subdirs) {
        const target = path.join(perfAppDir, sub, '.npmrc');
        fs.copyFileSync(rootNpmrc, target);
        console.log(`  Copied to ${sub}/.npmrc`);
    }
} else {
    console.log('No root .npmrc found — using default npm registry');
}

// Step 2: Build shared types
console.log('\n--- Building shared types ---');
run('npm install', path.join(perfAppDir, 'shared'));
run('npm run build', path.join(perfAppDir, 'shared'));

// Step 3: Build frontend
console.log('\n--- Building frontend ---');
run('npm install', path.join(perfAppDir, 'frontend'));
run('npm run build', path.join(perfAppDir, 'frontend'));

// Step 4: Build backend with tsc (individual files, NOT bundled)
// Recording feature requires shared mutable state between modules
// which breaks when bundled into a single file by esbuild
console.log('\n--- Building backend ---');
run('npm install', path.join(perfAppDir, 'backend'));
run('npm run build', path.join(perfAppDir, 'backend'));

// Step 4b: Bundle CLI and MCP entry points (single-file bundles for npx binaries)
// The server runs from individual tsc files, but cs-perf-mcp and mcp.bundle.js
// need to be self-contained bundles for clean npx execution
console.log('\n--- Bundling CLI & MCP entry points ---');
run('npm run bundle', path.join(perfAppDir, 'backend'));

// Step 5: Clean up copied .npmrc files (don't ship credentials)
for (const sub of subdirs) {
    const copied = path.join(perfAppDir, sub, '.npmrc');
    if (fs.existsSync(copied) && fs.existsSync(rootNpmrc)) {
        // Only remove if we copied it (check if content matches root)
        try {
            const rootContent = fs.readFileSync(rootNpmrc, 'utf8');
            const copiedContent = fs.readFileSync(copied, 'utf8');
            if (rootContent === copiedContent) {
                fs.unlinkSync(copied);
                console.log(`  Cleaned up ${sub}/.npmrc`);
            }
        } catch {
            // Leave it if we can't read
        }
    }
}

console.log('\n✅ Performance Testing App built successfully');

function run(cmd, cwd) {
    console.log(`  > ${cmd} (in ${path.relative(rootDir, cwd)})`);
    try {
        execSync(cmd, { cwd, stdio: 'inherit' });
    } catch (error) {
        console.error(`\nFailed: ${cmd} in ${cwd}`);
        process.exit(1);
    }
}
