#!/usr/bin/env node
/**
 * Bundles the performance testing backend into a single self-contained JS file.
 * Uses esbuild to transpile TypeScript AND bundle all dependencies.
 * All deps (fastify, socket.io, pino, etc.) are inlined into one file.
 * Only playwright and native modules are kept external.
 */

const path = require('path');
const fs = require('fs');

let backendDir = process.cwd();
if (!fs.existsSync(path.join(backendDir, 'src', 'simple-server.ts'))) {
    backendDir = path.join(__dirname, '..', 'performance-testing-app', 'backend');
}

const srcDir = path.join(backendDir, 'src');
const distDir = path.join(backendDir, 'dist');

if (!fs.existsSync(path.join(srcDir, 'simple-server.ts'))) {
    console.error('Cannot find src/simple-server.ts');
    process.exit(1);
}

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const entryPoint = path.join(srcDir, 'simple-server.ts');
const outFile = path.join(distDir, 'server.bundle.js');
const cliEntry = path.join(srcDir, 'cli.ts');
const mcpEntry = path.join(srcDir, 'mcp.ts');

console.log('Bundling backend from TypeScript source...');
console.log(`  Entry: ${entryPoint}`);
console.log(`  Output: ${outFile}`);

// Plugin to strip shebang lines from source files before bundling.
// Source files may have #!/usr/bin/env node but the bundler adds its own
// via the banner option — having both causes "SyntaxError: Invalid or unexpected token".
const stripShebangPlugin = {
    name: 'strip-shebang',
    setup(build) {
        build.onLoad({ filter: /\.(ts|js|mjs)$/ }, async (args) => {
            const source = require('fs').readFileSync(args.path, 'utf-8');
            if (source.startsWith('#!')) {
                return {
                    contents: source.replace(/^#![^\n]*\n/, ''),
                    loader: args.path.endsWith('.ts') ? 'ts' : 'js',
                };
            }
            return undefined; // let esbuild handle normally
        });
    }
};

// Plugin to force ANY import containing 'cs-playwright-test-framework' as external.
// esbuild's glob externals (@scope/*) don't match deep subpaths like
// @scope/pkg/dist/deep/path.js — this plugin catches them all.
const forceExternalPlugin = {
    name: 'force-external-framework',
    setup(build) {
        build.onResolve({ filter: /cs-playwright-test-framework/ }, (args) => {
            // Only match bare import specifiers (e.g. @mdakhan.mak/cs-playwright-test-framework/...)
            // NOT local file paths (e.g. Y:\...\cs-playwright-test-framework\src\simple-server.ts)
            // which happen when the bundler runs from inside the framework directory itself.
            if (args.path.startsWith('.') || args.path.startsWith('/') || /^[A-Z]:/i.test(args.path)) {
                return undefined; // let esbuild resolve normally
            }
            // Rewrite /dist/ paths — the framework's package.json exports
            // already map subpaths to dist/, so importing with /dist/ causes
            // double resolution: dist/dist/. Remove /dist/ from the path.
            let fixedPath = args.path.replace(
                /cs-playwright-test-framework\/dist\//,
                'cs-playwright-test-framework/'
            );
            return { path: fixedPath, external: true };
        });
    }
};

const sharedExternals = [
    'playwright', 'playwright-core', 'playwright-core/*',
    '@playwright/test',
    'chromium-bidi', 'chromium-bidi/*',
    'sharp', 'better-sqlite3', 'oracledb', 'pg-native',
    'msnodesqlv8', 'fsevents', 'prisma', '@prisma/client',
];

const sharedOptions = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    plugins: [stripShebangPlugin, forceExternalPlugin],
    external: sharedExternals,
    banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
    },
    logLevel: 'warning',
    nodePaths: [path.join(backendDir, 'node_modules')],
    resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
};

// Use async build (required for plugins)
async function bundle() {
    // Server bundle
    await require('esbuild').build({
        ...sharedOptions,
        entryPoints: [entryPoint],
        outfile: outFile,
    });
    const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
    console.log(`  ✅ Server bundle: ${sizeMB} MB`);

    // CLI bundle
    if (fs.existsSync(cliEntry)) {
        await require('esbuild').build({
            ...sharedOptions,
            entryPoints: [cliEntry],
            outfile: path.join(distDir, 'cli.bundle.js'),
            banner: {
                js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);"
            },
        });
        console.log(`  ✅ CLI bundle created`);
    }

    // MCP bundle
    if (fs.existsSync(mcpEntry)) {
        await require('esbuild').build({
            ...sharedOptions,
            entryPoints: [mcpEntry],
            outfile: path.join(distDir, 'mcp.bundle.js'),
        });
        console.log(`  ✅ MCP bundle created`);
    }

    console.log(`\n✅ All bundles created successfully`);
}

bundle().catch((error) => {
    console.error('Bundle failed:', error.message);
    process.exit(1);
});
