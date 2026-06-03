#!/usr/bin/env node
/**
 * Smart Playwright browser installer (postinstall hook).
 *
 * Runs after `npm install` in consumer projects. Decides whether to
 * download Playwright's browser binaries before the first test run.
 *
 * History
 * -------
 * Prior to v1.42.3 this script asked "does *any* directory whose name
 * starts with `chromium` exist?". That returned true even when the
 * directory belonged to a previous Playwright version (e.g. the
 * cached `chromium-1148` from an old install, while the upgraded
 * Playwright now wants `chromium-1223`). Consumers then hit
 *
 *   browserType.launch: Executable doesn't exist at
 *   .../ms-playwright/chromium-1223/chrome-win64/chrome.exe
 *
 * on the first run.
 *
 * v1.42.3 fixes the check by reading the **expected** revisions out
 * of `playwright-core/browsers.json` and verifying that the exact
 * `<name>-<revision>` directory exists with content. If we can't
 * read `browsers.json` (very old Playwright, broken install), we
 * fall back to always invoking `npx playwright install`, which is
 * idempotent — it skips browsers already present.
 *
 * Environment escape hatches
 * --------------------------
 *   CS_SKIP_BROWSER_INSTALL=1     skip the script entirely (CI that
 *                                 manages browsers separately)
 *   PLAYWRIGHT_BROWSERS_PATH=...  honoured — we look there for the
 *                                 cache (same rule Playwright uses)
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Escape hatch ────────────────────────────────────────────────
if (process.env.CS_SKIP_BROWSER_INSTALL === '1') {
    console.log('CS_SKIP_BROWSER_INSTALL=1 — skipping browser install check.');
    process.exit(0);
}

// Browsers we ship with by default. Matches the legacy behaviour
// (chromium / firefox / webkit) plus the headless-shell variant
// Playwright now installs alongside chromium since ~1.49.
const REQUIRED_BROWSERS = new Set([
    'chromium',
    'chromium-headless-shell',
    'firefox',
    'webkit',
]);

// ── Cache path resolution ───────────────────────────────────────

function getPlaywrightBrowserPath() {
    // Honour the official override first.
    if (process.env.PLAYWRIGHT_BROWSERS_PATH &&
        process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
        return process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
    }
    return path.join(os.homedir(), '.cache', 'ms-playwright');
}

// ── Expected-revision lookup ────────────────────────────────────

/**
 * Walk up from the consumer's cwd looking for a `node_modules/playwright-core`
 * with a `browsers.json` next to it. We can't `require('playwright-core/...')`
 * directly because the consumer might not have @playwright/test as a direct
 * dep — they might pull it through us.
 *
 * Returns `{ path, data }` or null if not found.
 */
function readBrowsersJson() {
    const candidates = [];
    // Consumer cwd (npm sets this to the project root during postinstall)
    let cwd = process.cwd();
    for (let i = 0; i < 8; i++) {
        candidates.push(path.join(cwd, 'node_modules', 'playwright-core', 'browsers.json'));
        const parent = path.dirname(cwd);
        if (parent === cwd) break;
        cwd = parent;
    }
    // Fall back to this package's own playwright-core (when running
    // out of a fresh install where peer deps haven't materialised yet).
    candidates.push(path.join(__dirname, '..', 'node_modules', 'playwright-core', 'browsers.json'));

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf-8');
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.browsers)) {
                    return { path: p, data: parsed };
                }
            }
        } catch (_err) {
            // Try next candidate
        }
    }
    return null;
}

/**
 * Return the list of `{ name, revision }` entries we need installed,
 * filtered to the REQUIRED_BROWSERS we ship by default. Returns null
 * if browsers.json couldn't be located — caller should fall back to
 * "just run `npx playwright install` unconditionally."
 */
function getExpectedBrowsers() {
    const found = readBrowsersJson();
    if (!found) return null;

    const wanted = [];
    for (const b of found.data.browsers) {
        if (!REQUIRED_BROWSERS.has(b.name)) continue;
        if (b.installByDefault === false) continue;
        if (!b.revision) continue;
        wanted.push({ name: b.name, revision: String(b.revision) });
    }
    return { browsersJsonPath: found.path, wanted };
}

// ── Per-browser presence check ──────────────────────────────────

/**
 * For a given expected `{ name, revision }`, return true if the
 * exact `<cache>/<name>-<revision>` directory exists and has any
 * files in it. We don't probe the executable path itself —
 * Playwright's directory layout differs per OS — but a missing or
 * empty directory is a reliable "needs install" signal.
 */
function isExactBrowserInstalled(cachePath, name, revision) {
    if (!cachePath || !fs.existsSync(cachePath)) return false;
    const dir = path.join(cachePath, `${name}-${revision}`);
    if (!fs.existsSync(dir)) return false;
    try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) return false;
        return fs.readdirSync(dir).length > 0;
    } catch (_err) {
        return false;
    }
}

// ── Installer ───────────────────────────────────────────────────

function runPlaywrightInstall(args) {
    const cmd = ['npx', 'playwright', 'install', ...args].join(' ');
    console.log(`> ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit', env: { ...process.env } });
        return true;
    } catch (err) {
        console.error(`Browser install failed: ${err.message}`);
        return false;
    }
}

// ── Main ────────────────────────────────────────────────────────

function main() {
    const cachePath = getPlaywrightBrowserPath();
    console.log('Checking Playwright browser installation...');
    console.log(`  Cache path: ${cachePath}`);

    const expected = getExpectedBrowsers();

    // Fallback path: no browsers.json reachable. Trust `npx playwright
    // install` to do the right thing (it's idempotent).
    if (!expected) {
        console.log('  Could not locate playwright-core/browsers.json.');
        console.log('  Falling back to: npx playwright install (idempotent).');
        runPlaywrightInstall([]);
        return;
    }

    console.log(`  Expected revisions read from: ${expected.browsersJsonPath}`);

    const missing = [];
    for (const { name, revision } of expected.wanted) {
        const ok = isExactBrowserInstalled(cachePath, name, revision);
        if (ok) {
            console.log(`  ✓ ${name}@${revision}: present`);
        } else {
            console.log(`  ✗ ${name}@${revision}: MISSING`);
            // Pass the user-facing name to `playwright install`. The
            // `chromium-headless-shell` revision rides along with
            // `chromium` so we don't request it separately.
            const installName = name === 'chromium-headless-shell' ? 'chromium' : name;
            if (!missing.includes(installName)) missing.push(installName);
        }
    }

    if (missing.length === 0) {
        console.log('All required browsers already present at the expected revisions.');
        return;
    }

    console.log(`\nInstalling: ${missing.join(', ')}`);
    const ok = runPlaywrightInstall(missing);
    if (ok) {
        console.log('Browser install complete.');
    } else {
        console.error(
            'Browser install failed. Run manually before your first test:\n' +
            '  npx playwright install ' + missing.join(' '),
        );
        // Don't fail the npm install — surface the message but exit 0
        // so the consumer can still see other postinstall output.
    }
}

// Only auto-run when invoked directly (e.g. via npm postinstall).
// `require()` from a test must not trigger a real install.
if (require.main === module) {
    main();
}

// Exported for unit tests (postinstall-browsers-smoke).
module.exports = {
    getPlaywrightBrowserPath,
    readBrowsersJson,
    getExpectedBrowsers,
    isExactBrowserInstalled,
    REQUIRED_BROWSERS,
};
