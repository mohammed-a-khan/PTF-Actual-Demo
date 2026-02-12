#!/usr/bin/env node
/**
 * Smart Playwright Browser Installation Script
 * Only installs browsers that are missing or outdated
 *
 * This script runs as postinstall in consumer projects.
 * npm sets cwd to the package root when running postinstall.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Ensure we're running from the correct context
const SCRIPT_DIR = __dirname;
const PACKAGE_ROOT = path.dirname(SCRIPT_DIR);

// Required browsers for the framework
const REQUIRED_BROWSERS = ['chromium', 'firefox', 'webkit'];

// Get Playwright browser installation path
function getPlaywrightBrowserPath() {
    // Playwright stores browsers in ~/.cache/ms-playwright on Linux/Mac
    // or %LOCALAPPDATA%\ms-playwright on Windows
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    } else {
        return path.join(os.homedir(), '.cache', 'ms-playwright');
    }
}

// Check if a specific browser is installed
function isBrowserInstalled(browserName) {
    const browserPath = getPlaywrightBrowserPath();

    if (!fs.existsSync(browserPath)) {
        return false;
    }

    try {
        const dirs = fs.readdirSync(browserPath);
        // Look for directories starting with the browser name
        // e.g., chromium-1148, firefox-1456, webkit-2104
        const browserDir = dirs.find(dir => dir.toLowerCase().startsWith(browserName.toLowerCase()));

        if (browserDir) {
            const fullPath = path.join(browserPath, browserDir);
            // Check if directory exists and has content
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                const contents = fs.readdirSync(fullPath);
                return contents.length > 0;
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}

// Get installed browser version
function getInstalledBrowserVersion(browserName) {
    const browserPath = getPlaywrightBrowserPath();

    if (!fs.existsSync(browserPath)) {
        return null;
    }

    try {
        const dirs = fs.readdirSync(browserPath);
        const browserDir = dirs.find(dir => dir.toLowerCase().startsWith(browserName.toLowerCase()));

        if (browserDir) {
            // Extract version from directory name (e.g., chromium-1148 -> 1148)
            const match = browserDir.match(/\d+/);
            return match ? match[0] : null;
        }
        return null;
    } catch (error) {
        return null;
    }
}

// Check which browsers need to be installed
function getMissingBrowsers() {
    const missing = [];

    for (const browser of REQUIRED_BROWSERS) {
        if (!isBrowserInstalled(browser)) {
            missing.push(browser);
        }
    }

    return missing;
}

// Install specific browsers
function installBrowsers(browsers) {
    if (browsers.length === 0) {
        return true;
    }

    const browserList = browsers.join(' ');
    console.log(`Installing browsers: ${browserList}`);

    try {
        execSync(`npx playwright install ${browserList}`, {
            stdio: 'inherit',
            env: { ...process.env }
        });
        return true;
    } catch (error) {
        console.error(`Failed to install browsers: ${error.message}`);
        return false;
    }
}

// Main function
function main() {
    console.log('Checking Playwright browser installation...');
    console.log(`Browser cache path: ${getPlaywrightBrowserPath()}`);

    // Check each browser
    const status = {};
    for (const browser of REQUIRED_BROWSERS) {
        const installed = isBrowserInstalled(browser);
        const version = getInstalledBrowserVersion(browser);
        status[browser] = { installed, version };

        if (installed) {
            console.log(`  ✓ ${browser}: installed (build ${version || 'unknown'})`);
        } else {
            console.log(`  ✗ ${browser}: not installed`);
        }
    }

    // Get missing browsers
    const missingBrowsers = getMissingBrowsers();

    if (missingBrowsers.length === 0) {
        console.log('\nAll required browsers are already installed. Skipping download.');
        return;
    }

    console.log(`\nMissing browsers: ${missingBrowsers.join(', ')}`);
    console.log('Installing missing browsers...\n');

    const success = installBrowsers(missingBrowsers);

    if (success) {
        console.log('\nBrowser installation complete.');
    } else {
        console.error('\nBrowser installation failed. You may need to run: npx playwright install');
        // Don't exit with error to avoid breaking npm install
    }
}

// Run
main();
