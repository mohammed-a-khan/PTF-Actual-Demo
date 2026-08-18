import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

type WriteReport = { path: string; sizeBytes: number };
type SkipReport = { path: string; reason: string };

const ENV_KEYS = ['dev', 'sit', 'uat', 'prod'] as const;

registerPrimitive({
    name: 'cs_qa_init_project',
    description: 'Bootstrap a fresh CS Playwright consumer project from empty. Idempotent — never overwrites existing files unless force:true. Writes: package.json (framework dep + per-env test scripts), tsconfig.json (decorators + framework types), cs-playwright-mcp.config.json (ADO + MCP + encryption placeholders), config/<slug>/common/common.env (browser + timeouts + step/feature paths + project name), config/<slug>/environments/<env>.env for each provided env (BASE_URL / LOGIN_URL / DB / API), config/<slug>/common/<dbType>_queries.env if dbType provided, empty test/<slug>/{pages,steps,features,data/<env>,helpers} skeleton, .gitignore, cucumber.js. Optionally accepts credentials + dbCredentials + adoPat, which are encrypted at bootstrap time via the framework CSEncryptionUtil so the emitted env files contain ready-to-use ENCRYPTED:... values instead of placeholders (eliminates manual `npx cs-playwright-mcp encrypt` step). Use BEFORE story generation when detecting a cold-start workspace (no package.json, or no config/<slug>/, or no test/<slug>/).',
    inputSchema: z.object({
        projectSlug: z.string().regex(/^[a-z][a-z0-9-]*$/, 'projectSlug must be lower-kebab-case, start with a letter'),
        baseUrls: z.record(z.string(), z.string().url()).refine((r) => Object.keys(r).length > 0, 'baseUrls must include at least one environment'),
        loginUrls: z.record(z.string(), z.string().url()).optional(),
        apiBaseUrls: z.record(z.string(), z.string().url()).optional(),
        dbType: z.enum(['oracle', 'mysql', 'sqlserver', 'postgres', 'none']).default('none'),
        ado: z.object({
            organization: z.string().min(1),
            project: z.string().min(1),
            baseUrl: z.string().url().default('https://dev.azure.com'),
        }).optional(),
        // Optional plaintext credentials — encrypted at bootstrap via CSEncryptionUtil so the
        // env files contain ENCRYPTED:... blobs. If omitted, files keep the placeholder and the
        // user runs `npx cs-playwright-mcp encrypt <value>` manually. Credentials are cleared
        // from memory after encryption and never logged.
        credentials: z.object({
            adminUsername: z.string().min(1).optional(),
            adminPassword: z.string().min(1).optional(),
        }).optional(),
        dbCredentials: z.object({
            username: z.string().min(1).optional(),
            password: z.string().min(1).optional(),
        }).optional(),
        adoPat: z.string().min(1).optional(),
        // Write cross-project common config (config/common/common.env + config/common/environments/*.env)?
        // These are framework precedence levels 6/7 — useful ONLY when the workspace has MULTIPLE
        // consumer projects that share config. For single-project consumers they are empty noise.
        // Default false. Set true when adding a second consumer to an existing multi-project workspace.
        enableCrossProjectCommon: z.boolean().default(false),
        force: z.boolean().default(false),
    }),
    outputSchema: z.object({
        projectSlug: z.string(),
        filesWritten: z.array(z.object({ path: z.string(), sizeBytes: z.number() })),
        filesSkipped: z.array(z.object({ path: z.string(), reason: z.string() })),
        directoriesCreated: z.array(z.string()),
        nextSteps: z.array(z.string()),
    }),
    run: async (ctx, input) => {
        const slug = input.projectSlug;
        // Default to dev+sit+uat when the caller only provided one env — the common
        // convention for CS Playwright consumer projects. Envs the caller didn't specify
        // get the same base URL with an env-tag suffix so it's
        // obviously a placeholder that the user should replace.
        const suppliedEnvs = Object.keys(input.baseUrls);
        const effectiveEnvs = suppliedEnvs.length > 0 ? Array.from(new Set([...suppliedEnvs, 'dev', 'sit', 'uat'])) : ['dev', 'sit', 'uat'];
        const effectiveBaseUrls: Record<string, string> = { ...input.baseUrls };
        for (const env of effectiveEnvs) {
            if (!effectiveBaseUrls[env]) {
                // If any real URL was supplied, reuse the first one as a placeholder with an env-marker query.
                // Otherwise use a synthetic REPLACE_ME URL so the missing value is obvious.
                const firstReal = suppliedEnvs.length > 0 ? input.baseUrls[suppliedEnvs[0]] : `https://REPLACE_ME_${env.toUpperCase()}.example.com`;
                effectiveBaseUrls[env] = firstReal;
            }
        }
        const envs = effectiveEnvs as Array<typeof ENV_KEYS[number]>;
        const written: WriteReport[] = [];
        const skipped: SkipReport[] = [];
        const dirsCreated: string[] = [];

        // Encrypt supplied credentials via the framework's CSEncryptionUtil so the env
        // files can be written with ENCRYPTED:... blobs directly. If the util can't be
        // loaded (e.g. framework not installed yet), fall back to placeholders.
        const encrypted = encryptCredentials(ctx.workspaceRoot, input);

        const writeIfAbsent = (relPath: string, content: string): void => {
            const abs = path.resolve(ctx.workspaceRoot, relPath);
            if (!abs.startsWith(path.resolve(ctx.workspaceRoot) + path.sep)) {
                skipped.push({ path: relPath, reason: 'path-escape' });
                return;
            }
            if (fs.existsSync(abs) && !input.force) {
                skipped.push({ path: relPath, reason: 'already-exists' });
                return;
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf-8');
            written.push({ path: relPath, sizeBytes: Buffer.byteLength(content, 'utf-8') });
        };

        const mkdirIfAbsent = (relPath: string): void => {
            const abs = path.resolve(ctx.workspaceRoot, relPath);
            if (!fs.existsSync(abs)) {
                fs.mkdirSync(abs, { recursive: true });
                dirsCreated.push(relPath);
            }
        };

        // 1. package.json
        writeIfAbsent('package.json', renderPackageJson(slug, envs));

        // 2. tsconfig.json
        writeIfAbsent('tsconfig.json', renderTsconfigJson());

        // 3. cs-playwright-mcp.config.json
        writeIfAbsent('cs-playwright-mcp.config.json', renderMcpConfigJson(slug, input.ado, encrypted.adoPat));

        // 4. cucumber.js (IDE step-def resolution)
        writeIfAbsent('cucumber.js', renderCucumberJs());

        // 5. .gitignore
        writeIfAbsent('.gitignore', renderGitignore());

        // 5b. .npmrc — framework registry config
        writeIfAbsent('.npmrc', renderNpmrc());

        // 6a. config/global.env — TRUE framework-wide defaults (loaded as base, precedence level 8)
        writeIfAbsent('config/global.env', renderGlobalEnv());

        // 6b/c. config/common/* — cross-project common (precedence levels 6/7). Only emit
        //       when the workspace is (or will be) multi-project. Single-project consumers
        //       don't need these — global.env (level 8) and project-specific config
        //       (levels 3-5) cover everything. Emitting empty scaffolds here was noise.
        if (input.enableCrossProjectCommon) {
            writeIfAbsent('config/common/common.env', renderCrossProjectCommonEnv());
            for (const env of envs) {
                writeIfAbsent(`config/common/environments/${env}.env`, renderCrossProjectEnv(env));
            }
        }

        // 6d. config/<slug>/common/common.env — PROJECT-specific common (precedence level 5)
        writeIfAbsent(`config/${slug}/common/common.env`, renderCommonEnv(slug, input.dbType));

        // 7. config/<slug>/environments/<env>.env for each env (always dev+sit+uat minimum)
        //
        // Surgical URL repair: an earlier init_project call that omitted loginUrls
        // writes LOGIN_URL === BASE_URL (origin only) which breaks login on any app
        // whose login lives at a sub-path (e.g. /web/auth/login, /lightning/login,
        // /sso/redirect etc). Because writeIfAbsent skips existing files,
        // that broken state persists forever unless we surgically fix it. When the
        // caller passes loginUrls this time, we merge just the URL lines.
        for (const env of envs) {
            const relPath = `config/${slug}/environments/${env}.env`;
            const absPath = path.resolve(ctx.workspaceRoot, relPath);
            const desiredLoginUrl = input.loginUrls?.[env];
            const desiredBaseUrl = effectiveBaseUrls[env];
            const desiredApiBaseUrl = input.apiBaseUrls?.[env];
            if (fs.existsSync(absPath) && !input.force) {
                const existing = fs.readFileSync(absPath, 'utf-8');
                const repaired = repairUrlLines(existing, desiredBaseUrl, desiredLoginUrl, desiredApiBaseUrl);
                if (repaired !== existing) {
                    fs.writeFileSync(absPath, repaired, 'utf-8');
                    written.push({ path: relPath, sizeBytes: Buffer.byteLength(repaired, 'utf-8') });
                } else {
                    skipped.push({ path: relPath, reason: 'already-exists' });
                }
            } else {
                writeIfAbsent(
                    relPath,
                    renderEnvEnv(slug, env, desiredBaseUrl, desiredLoginUrl, desiredApiBaseUrl, input.dbType, encrypted),
                );
            }
        }

        // 8. config/<slug>/common/<dbType>_queries.env if dbType != none
        if (input.dbType !== 'none') {
            writeIfAbsent(`config/${slug}/common/${input.dbType}_queries.env`, renderQueriesEnv(input.dbType));
        }

        // 9. test/<slug>/ directory skeleton — dirs only, NO .gitkeep files
        //    (git tracks empty dirs via first real file added; .gitkeep is noise the user hates)
        for (const sub of ['pages', 'steps', 'features', 'helpers']) {
            mkdirIfAbsent(`test/${slug}/${sub}`);
        }
        for (const env of envs) {
            mkdirIfAbsent(`test/${slug}/data/${env}`);
        }

        // 10. reports/ / temp/ / tmp/ — DO NOT precreate; the runner creates its own timestamped
        //     dirs at test time. Precreating causes empty-noise dirs in fresh cold-start checkouts.

        const nextSteps: string[] = [
            `Run 'npm install' to install @mdakhan.mak/cs-playwright-test-framework and dev deps.`,
        ];
        if (!encrypted.usedEncryption && (input.credentials || input.dbCredentials || input.adoPat)) {
            nextSteps.push(`⚠️  CSEncryptionUtil was not available (framework may not be installed yet) — supplied credentials were LEFT AS PLACEHOLDERS in the env/mcp files. After 'npm install', re-run 'cs_qa_init_project' with force:true to encrypt them, OR encrypt manually via 'npx cs-playwright-mcp encrypt <value>'.`);
        } else if (encrypted.usedEncryption) {
            nextSteps.push(`✅ Supplied credentials were encrypted via CSEncryptionUtil at bootstrap — env files contain ready-to-use ENCRYPTED:... blobs.`);
        } else {
            nextSteps.push(`Edit config/${slug}/environments/<env>.env — set real credentials via ENCRYPTED: prefix (use 'npx cs-playwright-mcp encrypt <value>' from the framework CLI). Or re-run cs_qa_init_project with force:true and pass 'credentials' / 'dbCredentials' / 'adoPat' to encrypt in place.`);
        }
        nextSteps.push(`Proceed to Phase 1 of the qa-agent skill: fetch the source (ADO story / doc / URL) and generate story tests under test/${slug}/.`);
        nextSteps.push(`Verify runner picks up the project: 'npm run test:${slug}:${envs[0]} -- --features=test/${slug}/features/<some-feature>.feature' (once you have a feature).`);

        return {
            projectSlug: slug,
            filesWritten: written,
            filesSkipped: skipped,
            directoriesCreated: dirsCreated,
            nextSteps,
        };
    },
});

function renderPackageJson(slug: string, envs: string[]): string {
    const testScripts: Record<string, string> = {
        'cs-framework': `cross-env NODE_OPTIONS="--tls-min-v1.2" npx cs-framework`,
        test: `npm run cs-framework -- --project=${slug}`,
        [`test:${slug}`]: `npm run cs-framework -- --project=${slug}`,
    };
    for (const env of envs) {
        testScripts[`test:${slug}:${env}`] = `npm run cs-framework -- --project=${slug} --env=${env}`;
    }
    testScripts['test:headless'] = `npm run cs-framework -- --project=${slug} --headless=true`;
    testScripts['test:parallel'] = `npm run cs-framework -- --project=${slug} --parallel --workers=4`;
    testScripts.typecheck = 'tsc --noEmit';
    testScripts.build = 'tsc';
    testScripts.clean = 'rimraf dist';

    const pkg = {
        name: `${slug}-tests`,
        version: '1.0.0',
        description: `${slug.toUpperCase()} test project utilizing @mdakhan.mak/cs-playwright-test-framework`,
        private: true,
        scripts: testScripts,
        keywords: ['automation', 'testing', 'playwright', 'cucumber', 'bdd', slug],
        author: '',
        license: 'ISC',
        dependencies: {
            '@mdakhan.mak/cs-playwright-test-framework': '^1.49.0',
            exceljs: '^4.4.0',
            xlsx: '^0.18.5',
        },
        devDependencies: {
            '@types/node': '^20.0.0',
            'cross-env': '^10.1.0',
            rimraf: '^5.0.0',
            'ts-node': '^10.9.2',
            'tsconfig-paths': '^4.2.0',
            typescript: '^5.0.0',
        },
    };
    return JSON.stringify(pkg, null, 2) + '\n';
}

function renderTsconfigJson(): string {
    const cfg = {
        compilerOptions: {
            target: 'ES2020',
            module: 'node16',
            lib: ['ES2020', 'dom'],
            outDir: './dist',
            rootDir: '.',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            resolveJsonModule: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            downlevelIteration: true,
            moduleResolution: 'node16',
            allowSyntheticDefaultImports: true,
            types: ['node', '@playwright/test'],
            baseUrl: '.',
        },
        'ts-node': {
            transpileOnly: true,
            compilerOptions: {
                module: 'commonjs',
                moduleResolution: 'node',
            },
        },
        include: ['test/**/*', 'config/**/*'],
        exclude: ['node_modules', 'dist'],
    };
    return JSON.stringify(cfg, null, 2) + '\n';
}

function renderMcpConfigJson(slug: string, ado?: { organization: string; project: string; baseUrl: string }, encryptedPat?: string): string {
    const cfg = {
        version: '1',
        ado: {
            organization: ado?.organization ?? 'your-org',
            project: ado?.project ?? 'your-project',
            baseUrl: ado?.baseUrl ?? 'https://dev.azure.com',
            personalAccessToken: encryptedPat ?? 'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',
            apiVersion: '7.1',
            defaults: {
                environment: 'uat',
                runName: 'CS Automated Run - {date} {time}',
                areaPath: ado?.project ?? '',
                iterationPath: ado?.project ?? '',
                appUrl: '',
                workItemId: '',
            },
            proxy: {
                enabled: false,
                host: '',
                port: 8080,
                protocol: 'http',
                authRequired: false,
                auth: {
                    username: '',
                    password: 'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',
                },
                bypassList: [] as string[],
            },
            upload: {
                attachments: true,
                screenshots: true,
                videos: false,
                logs: true,
                har: false,
                traces: false,
            },
            bug: {
                areaPath: '',
                iterationPath: '',
                assignedTo: '',
                priority: 2,
                severity: '3 - Medium',
                tags: [] as string[],
            },
        },
        legacy: {
            sourcePaths: [] as string[],
            frameworks: [] as string[],
        },
        mcp: {
            adoDomains: ['work-items', 'test-plans'],
            strictMode: false,
            cacheTtlMs: 300000,
            journalDir: '.cs-qa',
            hmacSecret: 'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',
        },
        otel: { exporterOtlpEndpoint: '' },
        nodeExtraCaCerts: '',
        logging: { level: 'info' },
    };
    void slug;
    return JSON.stringify(cfg, null, 2) + '\n';
}

function renderCucumberJs(): string {
    return `module.exports = {
  default: {
    requireModule: ['ts-node/register'],
    publish: false,
  },
};
`;
}

function renderGitignore(): string {
    return `node_modules/
dist/
reports/
tmp/
temp/
.cs-qa/
*.log
.DS_Store
Thumbs.db

# VS Code local settings — do commit .vscode/settings.json for team defaults if desired
.vscode/*.local

# OS junk
._*
*.pyc
`;
}

function renderGlobalEnv(): string {
    return `###############################################################################
# GLOBAL FRAMEWORK DEFAULTS
###############################################################################
# CSConfigurationManager precedence (level 8 — LOWEST, base defaults):
#   3. config/<project>/environments/<env>.env  (highest — per-env project override)
#   4. config/<project>/*.env
#   5. config/<project>/common/common.env       (project-specific common)
#   6. config/common/environments/<env>.env     (cross-project per-env)
#   7. config/common/common.env                 (cross-project common)
#   8. config/global.env                        (THIS FILE — base defaults)
#
# Anything set here can be overridden by any layer above (5, 6, 7 shadow this file).
# Keep values here framework-wide — no project names, no app URLs, no credentials.
###############################################################################

###############################################################################
# BROWSER
###############################################################################
BROWSER=chromium
HEADLESS=false
SLOW_MO=0
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_CLEAR_STATE=true
BROWSER_ALWAYS_LAUNCH=true

###############################################################################
# TIMEOUTS (milliseconds)
###############################################################################
TIMEOUT=60000
DEFAULT_TIMEOUT=30000
NAVIGATION_TIMEOUT=60000
BROWSER_ACTION_TIMEOUT=15000
BROWSER_NAVIGATION_TIMEOUT=60000
ELEMENT_TIMEOUT=15000
ACTION_TIMEOUT=10000
ASSERTION_TIMEOUT=5000

###############################################################################
# CROSS-DOMAIN NAVIGATION
###############################################################################
CROSS_DOMAIN_NAVIGATION_ENABLED=false
CROSS_DOMAIN_NAVIGATION_TIMEOUT=120000
CROSS_DOMAIN_MAX_REDIRECTS=5
CROSS_DOMAIN_UPDATE_ON_NAVIGATE=false

###############################################################################
# RETRY
###############################################################################
# RETRY_COUNT=0 during development — a failing test should fail fast, not burn
# time on 2 retries of the same broken selector. Raise to 1-2 only for CI where
# transient network / element-timing flake matters more than turnaround time.
RETRY_COUNT=0
ELEMENT_RETRY_COUNT=3
ELEMENT_CLEAR_BEFORE_TYPE=true

# Spinner / loader detection — extend per project's app
SPINNER_SELECTORS=.spinner;.loading;.loader
WAIT_FOR_SPINNERS=true

###############################################################################
# MEDIA CAPTURE
###############################################################################
BROWSER_VIDEO=retain-on-failure
BROWSER_VIDEO_WIDTH=1280
BROWSER_VIDEO_HEIGHT=720
VIDEO_ON_FAILURE=true
VIDEO_TRIM_ON_FAILURE=true

SCREENSHOT_CAPTURE_MODE=on-failure
SCREENSHOT_ON_FAILURE=true
SCREENSHOT_ON_STEP_FAILURE=true
PRE_ASSERTION_SCREENSHOT=true

BROWSER_TRACE_ENABLED=true
TRACE_ON_FAILURE=true
TRACE_CAPTURE_MODE=on-failure

BROWSER_HAR_ENABLED=false
HAR_CAPTURE_MODE=on-failure

###############################################################################
# REPORTING
###############################################################################
REPORTS_BASE_DIR=./reports
REPORTS_CREATE_TIMESTAMP_FOLDER=true
REPORT_TYPES=html,json,junit
REPORTS_ZIP_RESULTS=true

###############################################################################
# EVIDENCE COLLECTION
###############################################################################
EVIDENCE_PATH=./evidence
EVIDENCE_COLLECTION_ENABLED=true
AUTO_SAVE_EVIDENCE=true
EVIDENCE_MASK_SENSITIVE_DATA=true
EVIDENCE_PACKAGE_ON_COMPLETE=true

###############################################################################
# LOGGING
###############################################################################
LOG_LEVEL=INFO
DEBUG_CONSOLE_LOGS=false
CONSOLE_LOG_CAPTURED=true

###############################################################################
# SELF-HEALING & AI
###############################################################################
SELF_HEALING_ENABLED=true
AI_ENABLED=false

###############################################################################
# PARALLEL EXECUTION
###############################################################################
PARALLEL=false
MAX_PARALLEL_WORKERS=4
PARALLEL_WORKERS=3
WORKER_HEAP_SIZE=2048
USE_WORKER_THREADS=true

###############################################################################
# TIMEZONE (Americas default — CSDateTimeUtility respects this)
###############################################################################
DEFAULT_TIMEZONE=America/New_York

###############################################################################
# FRAMEWORK IDENTITY
###############################################################################
FRAMEWORK_NAME=CS-Playwright-Test-Framework
`;
}

function renderCrossProjectCommonEnv(): string {
    return `###############################################################################
# CROSS-PROJECT COMMON CONFIGURATION
###############################################################################
# CSConfigurationManager precedence level 7 — loaded after global.env (level 8),
# before any per-project config (level 5). Use for keys shared across multiple
# consumer projects in this repo (rare for single-project consumers; leave empty).
#
# Examples (uncomment and set):
# ORGANIZATION_NAME=YourCompany
# DEFAULT_ADMIN_USERNAME=Admin
# ADO_ORGANIZATION_URL=https://dev.azure.com/YourOrg
###############################################################################
`;
}

function renderCrossProjectEnv(env: string): string {
    return `###############################################################################
# CROSS-PROJECT ${env.toUpperCase()} ENVIRONMENT CONFIGURATION
###############################################################################
# CSConfigurationManager precedence level 6 — loaded after global.env + common.env,
# before per-project env. Use for env-specific keys shared across projects.
# Leave empty for single-project consumers.
###############################################################################

ENVIRONMENT=${env}
`;
}

function renderCommonEnv(slug: string, dbType: string): string {
    const upper = slug.toUpperCase();
    const dbConnName = dbType === 'none' ? '' : `${upper}_${dbType.toUpperCase()}`;
    const dbBlock = dbType === 'none'
        ? `# DB_ENABLED=false — enable when the project needs DB verification
DB_ENABLED=false
DATABASE_CONNECTIONS=
`
        : `# Enable database features globally
DB_ENABLED=true

# Comma-separated list of named connections to initialize at runtime.
# Per-connection credentials/host live in environments/<env>.env.
DATABASE_CONNECTIONS=${dbConnName}

# Pool + timeout defaults for ${dbConnName} (values will be overridden by environment-specific config)
DB_${dbConnName}_TYPE=${dbType}
DB_${dbConnName}_CONNECTION_TIMEOUT=60000
DB_${dbConnName}_REQUEST_TIMEOUT=180000
DB_${dbConnName}_POOL_MIN=2
DB_${dbConnName}_POOL_MAX=10
DB_${dbConnName}_POOL_INCREMENT=2
DB_${dbConnName}_POOL_IDLE_TIMEOUT=60000
`;
    return `###############################################################################
# ${upper} - Project Common Configuration
###############################################################################
# CSConfigurationManager precedence level 5 — loaded after global/common defaults,
# before env-specific project config. Keep PROJECT-SPECIFIC keys here.
# Framework-wide defaults (browser, timeouts, media, reporting, parallel, evidence,
# logging, timezone) live in config/global.env — don't repeat them here.
###############################################################################

###############################################################################
# PROJECT IDENTITY
###############################################################################
PROJECT=${slug}
PROJECT_NAME=${upper}
APPLICATION_NAME=${upper}

###############################################################################
# TEST EXECUTION — project-scoped paths
###############################################################################
FEATURES=test/${slug}/features/**/*.feature
FEATURE_PATH=test/${slug}/features/
STEP_DEFINITIONS_PATH=test/${slug}/steps;node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps
PAGES_PATH=test/${slug}/pages
DATA_PATH=test/${slug}/data
HELPERS_PATH=test/${slug}/helpers

###############################################################################
# DATABASE — connection names per project
###############################################################################
${dbBlock}
###############################################################################
# AZURE DEVOPS INTEGRATION — per-project ADO namespace
###############################################################################
ADO_INTEGRATION_ENABLED=false
ADO_ORGANIZATION=
ADO_ORGANIZATION_URL=https://dev.azure.com/{ADO_ORGANIZATION}
ADO_PROJECT=
ADO_API_VERSION=7.0

# ADO uploads
ADO_UPLOAD_ATTACHMENTS=true
ADO_UPLOAD_SCREENSHOTS=true
ADO_UPLOAD_VIDEOS=true
ADO_UPLOAD_TRACES=true
ADO_UPLOAD_HARS=true

# Test case management
ADO_CREATE_BUGS_ON_FAILURE=false

# Test run naming
ADO_RUN_NAME=${upper} Automated Test Run - {date} {time}
ADO_AUTOMATED=true
`;
}

function renderNpmrc(): string {
    return `# Framework package registry (edit if your organization hosts the CS Playwright framework in a private registry)
# @mdakhan.mak:registry=https://registry.npmjs.org/

# Recommended: strict-ssl on, fund off (avoids npm-fund noise)
strict-ssl=true
fund=false
audit=false
save-exact=true
`;
}

function repairUrlLines(existing: string, desiredBaseUrl: string, desiredLoginUrl?: string, desiredApiBaseUrl?: string): string {
    // Update in place. Only touch BASE_URL / LOGIN_URL / API_BASE_URL — leave every other
    // line (credentials, DB, timestamps, whatever the user added) untouched.
    let out = existing;
    const setLine = (key: string, val: string): void => {
        const re = new RegExp(`^${key}=.*$`, 'm');
        if (re.test(out)) {
            out = out.replace(re, `${key}=${val}`);
        } else {
            // Append near the URL block if we can identify it; otherwise at file end.
            if (/^# APPLICATION URLS$/m.test(out)) {
                out = out.replace(/^(# APPLICATION URLS[\s\S]*?)(^BASE_URL=.*$)/m, `$1$2\n${key}=${val}`);
            } else {
                out = `${out.replace(/\s+$/, '')}\n${key}=${val}\n`;
            }
        }
    };
    setLine('BASE_URL', desiredBaseUrl);
    // If loginUrl not provided this call, keep whatever is on disk — do NOT clobber
    // to origin-only when the user may have manually corrected it.
    if (desiredLoginUrl) setLine('LOGIN_URL', desiredLoginUrl);
    if (desiredApiBaseUrl) setLine('API_BASE_URL', desiredApiBaseUrl);
    return out;
}

function renderEnvEnv(slug: string, env: string, baseUrl: string, loginUrl?: string, apiBaseUrl?: string, dbType?: string, encrypted?: EncryptedCredentials): string {
    const upper = slug.toUpperCase();
    const envUpper = env.toUpperCase();
    const adminUsername = encrypted?.adminUsername ?? 'Admin';
    const adminPassword = encrypted?.adminPassword ?? 'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here';
    const dbBlock = dbType && dbType !== 'none' ? renderDbBlock(dbType, encrypted) : '# No DB configured for this project.\n';
    return `###############################################################################
# ${upper} - ${envUpper} Environment Configuration
###############################################################################

ENVIRONMENT=${env}
ENV_NAME=${envUpper}

# APPLICATION URLS
BASE_URL=${baseUrl}
LOGIN_URL=${loginUrl ?? baseUrl}
${apiBaseUrl ? `API_BASE_URL=${apiBaseUrl}\n` : ''}
# CREDENTIALS (encrypt via 'npx cs-playwright-mcp encrypt <value>' — or pass credentials to cs_qa_init_project to auto-encrypt)
ADMIN_USERNAME=${adminUsername}
ADMIN_PASSWORD=${adminPassword}

# DATABASE
${dbBlock}
# CERTIFICATES (uncomment + set if mTLS required for API tests)
# API_CERTIFICATE_PATH=config/${slug}/certificates/<env>-client.pfx
# API_CERTIFICATE_PASSPHRASE=ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here
`;
}

function renderDbBlock(dbType: string, encrypted?: EncryptedCredentials): string {
    const dbUsername = encrypted?.dbUsername ?? 'your_user';
    const dbPassword = encrypted?.dbPassword ?? 'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here';
    if (dbType === 'oracle') {
        return `DB_TYPE=oracle
DB_HOST=your-oracle-host.example.com
DB_PORT=1521
DB_SERVICE_NAME=YOURSERVICE
DB_USERNAME=${dbUsername}
DB_PASSWORD=${dbPassword}
DB_SCHEMA=YOUR_SCHEMA
`;
    }
    if (dbType === 'mysql') {
        return `DB_TYPE=mysql
DB_HOST=your-mysql-host.example.com
DB_PORT=3306
DB_NAME=your_db
DB_USERNAME=${dbUsername}
DB_PASSWORD=${dbPassword}
`;
    }
    if (dbType === 'sqlserver') {
        return `DB_TYPE=sqlserver
DB_HOST=your-mssql-host.example.com
DB_PORT=1433
DB_NAME=your_db
DB_USERNAME=${dbUsername}
DB_PASSWORD=${dbPassword}
DB_TRUST_SERVER_CERTIFICATE=true
`;
    }
    if (dbType === 'postgres') {
        return `DB_TYPE=postgres
DB_HOST=your-postgres-host.example.com
DB_PORT=5432
DB_NAME=your_db
DB_USERNAME=${dbUsername}
DB_PASSWORD=${dbPassword}
`;
    }
    return '';
}

interface EncryptedCredentials {
    usedEncryption: boolean;
    adminUsername?: string;
    adminPassword?: string;
    dbUsername?: string;
    dbPassword?: string;
    adoPat?: string;
}

function encryptCredentials(workspaceRoot: string, input: {
    credentials?: { adminUsername?: string; adminPassword?: string };
    dbCredentials?: { username?: string; password?: string };
    adoPat?: string;
}): EncryptedCredentials {
    const anyProvided = input.credentials?.adminUsername || input.credentials?.adminPassword
        || input.dbCredentials?.username || input.dbCredentials?.password
        || input.adoPat;
    if (!anyProvided) return { usedEncryption: false };
    try {
        const cryptoUtilPath = path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSEncryptionUtil.js');
        if (!fs.existsSync(cryptoUtilPath)) return { usedEncryption: false };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CSEncryptionUtil } = require(cryptoUtilPath) as {
            CSEncryptionUtil: {
                getInstance(): { createEncryptedConfigValue(t: string): string; encrypt(t: string): string };
            };
        };
        const util = CSEncryptionUtil.getInstance();
        const enc = (v?: string): string | undefined => {
            if (!v) return undefined;
            const wrapped = util.createEncryptedConfigValue(v);
            // createEncryptedConfigValue may return 'ENCRYPTED:...' or just the raw blob depending on framework version.
            return wrapped.startsWith('ENCRYPTED:') ? wrapped : `ENCRYPTED:${wrapped}`;
        };
        return {
            usedEncryption: true,
            adminUsername: input.credentials?.adminUsername,
            adminPassword: enc(input.credentials?.adminPassword),
            dbUsername: input.dbCredentials?.username,
            dbPassword: enc(input.dbCredentials?.password),
            adoPat: enc(input.adoPat),
        };
    } catch {
        return { usedEncryption: false };
    }
}

function renderQueriesEnv(dbType: string): string {
    return `###############################################################################
# Named SQL queries for ${dbType.toUpperCase()}
###############################################################################
# Reference from step-defs via cs_qa_db_select (or CSDBUtils.executeQuery('<QUERY_NAME>'))
# Only SELECT statements are permitted; DDL/DML is enforced-blocked by cs_qa_db_select.
###############################################################################

# Example — replace with real queries for your consumer domain
GET_USER_BY_ID=SELECT id, name, email FROM users WHERE id = :id
COUNT_RECENT_RECORDS=SELECT COUNT(*) AS total FROM audit_log WHERE created_at >= :since
`;
}
