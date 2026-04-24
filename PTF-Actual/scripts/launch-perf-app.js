#!/usr/bin/env node
/**
 * CS Performance Testing App Launcher
 *
 * Launches the performance testing platform from within the installed framework package.
 * The app (backend + frontend) is pre-built and bundled inside node_modules.
 *
 * Usage:
 *   npx cs-perf-app                    # Launch on default port 3001
 *   npx cs-perf-app --port 4000        # Launch on custom port
 *   npx cs-perf-app --no-open          # Launch without opening browser
 *   npx cs-perf-app --help             # Show help
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

// --- Argument parsing ---

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
CS Performance Testing Platform

Usage:
  npx cs-perf-app [options]

Options:
  --port <number>   Port for the server (default: 3001)
  --no-open         Don't open browser automatically
  --help, -h        Show this help

Examples:
  npx cs-perf-app
  npx cs-perf-app --port 4000
  npx cs-perf-app --no-open
`);
    process.exit(0);
}

const portArg = getArg('--port', '3001');
const port = parseInt(portArg, 10);
const noOpen = args.includes('--no-open');

// --- Main ---

(async function main() {
    console.log('');
    console.log('\x1b[35m%s\x1b[0m', '  CS Performance Testing Platform');
    console.log('\x1b[90m%s\x1b[0m', '  ' + '='.repeat(45));
    console.log('');

    // Step 1: Find the app
    const appRoot = findAppRoot();
    if (!appRoot) {
        console.error('\x1b[31m%s\x1b[0m', '  Error: Cannot find performance-testing-app directory.');
        console.error('  Make sure @mdakhan.mak/cs-playwright-test-framework is installed.');
        process.exit(1);
    }

    const backendDir = path.join(appRoot, 'backend');
    const frontendDistDir = path.join(appRoot, 'frontend', 'dist');

    // Step 2: Check if backend dist exists
    const serverEntry = findServerEntry(backendDir);
    if (!serverEntry) {
        console.error('\x1b[31m%s\x1b[0m', '  Error: Backend is not built.');
        console.error('  Run: cd performance-testing-app/backend && npm run build');
        process.exit(1);
    }

    // Step 2b: Ensure backend dependencies are installed (first run only)
    // All backend deps are public npm packages — no private feed needed
    const backendNodeModules = path.join(backendDir, 'node_modules', 'fastify');
    if (!fs.existsSync(backendNodeModules)) {
        console.log('\x1b[36m%s\x1b[0m', '  Installing backend dependencies (first run only)...');
        try {
            const { spawnSync } = require('child_process');
            const result = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--registry=https://registry.npmjs.org'], {
                cwd: backendDir,
                stdio: 'inherit',
                shell: true,
                timeout: 300000,
                env: { ...process.env }
            });
            if (result.status !== 0) {
                throw new Error(`npm install exited with code ${result.status}`);
            }
            console.log('\x1b[32m%s\x1b[0m', '  Dependencies installed.');
        } catch (err) {
            console.error('\x1b[31m%s\x1b[0m', '  Failed to install backend dependencies.');
            console.error('  Try manually: cd ' + backendDir + ' && npm install --registry=https://registry.npmjs.org');
            process.exit(1);
        }
    }

    // Step 3: Check if port is already in use
    const portInUse = await isPortInUse(port);
    if (portInUse) {
        // Check if it's our app
        const isOurApp = await checkHealth(port);
        if (isOurApp) {
            console.log('\x1b[36m%s\x1b[0m', `  Performance app is already running on port ${port}`);
            if (!noOpen) {
                console.log('\x1b[36m%s\x1b[0m', `  Opening browser...`);
                openBrowser(`http://localhost:${port}`);
            }
            console.log('');
            process.exit(0);
        } else {
            console.error('\x1b[31m%s\x1b[0m', `  Error: Port ${port} is already in use by another process.`);
            console.error(`  Use --port <number> to specify a different port.`);
            process.exit(1);
        }
    }

    // Step 4: Check if frontend is built
    const hasFrontendBuild = fs.existsSync(path.join(frontendDistDir, 'index.html'));

    // Step 5: Create data and artifacts directories in user's project for persistence
    const dataDir = path.join(process.cwd(), 'perf-data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const artifactsDir = path.join(process.cwd(), 'perf-artifacts');
    if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
    }

    // Copy default data files if they don't exist
    const backendDataDir = path.join(backendDir, 'data');
    if (fs.existsSync(backendDataDir)) {
        for (const file of ['scenarios.json', 'baselines.json', 'apdex-history.json']) {
            const target = path.join(dataDir, file);
            const source = path.join(backendDataDir, file);
            if (!fs.existsSync(target) && fs.existsSync(source)) {
                fs.copyFileSync(source, target);
            }
        }
    }

    // Step 6: Start the backend
    console.log('\x1b[36m%s\x1b[0m', `  Starting backend on port ${port}...`);

    const env = {
        ...process.env,
        PORT: String(port),
        HOST: 'localhost',
        NODE_ENV: 'production',
        PERF_DATA_DIR: dataDir,
        PERF_ARTIFACTS_DIR: artifactsDir,
        HEADLESS: 'false'
    };

    // If frontend is built, tell backend to serve it
    if (hasFrontendBuild) {
        env.SERVE_FRONTEND = frontendDistDir;
    }

    const backend = spawn('node', [serverEntry], {
        cwd: backendDir,
        env,
        stdio: 'pipe'
    });

    let started = false;

    backend.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (!msg) return;

        if (!started && (msg.includes('listening') || msg.includes('started'))) {
            started = true;
            const url = `http://localhost:${port}`;
            console.log('');
            console.log('\x1b[32m%s\x1b[0m', `  App running at: ${url}`);

            if (hasFrontendBuild) {
                console.log('\x1b[90m%s\x1b[0m', `  Frontend served from pre-built files`);
            } else {
                console.log('\x1b[33m%s\x1b[0m', `  Warning: Frontend not built. Only API available.`);
            }

            console.log('');
            console.log('\x1b[90m%s\x1b[0m', '  Press Ctrl+C to stop');
            console.log('');

            if (!noOpen) {
                openBrowser(url);
            }
        }

        // Always pass through backend logs so we can see errors
        // Filter out noisy JSON pino logs, show human-readable ones
        if (!msg.startsWith('{')) {
            console.log(`  [API] ${msg}`);
        }
    });

    backend.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
            process.stderr.write(`  [API] ${msg}\n`);
        }
    });

    backend.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`\n  Backend exited with code ${code}`);
        }
        process.exit(code || 0);
    });

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n\x1b[90m%s\x1b[0m', '  Shutting down...');
        backend.kill('SIGTERM');
        setTimeout(() => {
            backend.kill('SIGKILL');
            process.exit(0);
        }, 3000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Fallback: if backend doesn't print a "listening" message within 10s, assume it started
    setTimeout(() => {
        if (!started) {
            started = true;
            const url = `http://localhost:${port}`;
            console.log('');
            console.log('\x1b[32m%s\x1b[0m', `  App should be running at: ${url}`);
            console.log('\x1b[90m%s\x1b[0m', '  Press Ctrl+C to stop');
            console.log('');
            if (!noOpen) {
                openBrowser(url);
            }
        }
    }, 10000);
})();

// --- Helpers ---

function findAppRoot() {
    // 1. Check relative to this script (framework development / direct run)
    const fromScript = path.resolve(__dirname, '..', 'performance-testing-app');
    if (fs.existsSync(path.join(fromScript, 'backend'))) return fromScript;

    // 2. Check in node_modules from cwd (user's project)
    const fromCwd = path.resolve(
        process.cwd(),
        'node_modules',
        '@mdakhan.mak',
        'cs-playwright-test-framework',
        'performance-testing-app'
    );
    if (fs.existsSync(path.join(fromCwd, 'backend'))) return fromCwd;

    // 3. Check in node_modules from this script's location
    const scriptRoot = path.resolve(__dirname, '..');
    const fromScriptNodeModules = path.resolve(
        scriptRoot, '..', '..', '..',
        'performance-testing-app'
    );
    if (fs.existsSync(path.join(fromScriptNodeModules, 'backend'))) return fromScriptNodeModules;

    return null;
}

function findServerEntry(backendDir) {
    // Prefer unbundled server (recording requires shared state between modules)
    const regular = path.join(backendDir, 'dist', 'simple-server.js');
    if (fs.existsSync(regular)) return regular;

    const server = path.join(backendDir, 'dist', 'server.js');
    if (fs.existsSync(server)) return server;

    return null;
}

function isPortInUse(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(false);
        });
        server.listen(port, 'localhost');
    });
}

function checkHealth(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/health`, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.status === 'healthy');
                } catch {
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function openBrowser(url) {
    const { platform } = process;
    try {
        if (platform === 'win32') {
            spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' });
        } else if (platform === 'darwin') {
            spawn('open', [url], { detached: true, stdio: 'ignore' });
        } else {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        }
    } catch {
        // Silently fail if browser can't open
    }
}

function getArg(name, defaultVal) {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return defaultVal;
}
