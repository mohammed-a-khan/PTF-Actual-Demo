/**
 * A new framework project, laid out as the team's projects are:
 *
 *   config/global.env                                   the framework's defaults (every project; lowest
 *                                                       precedence), copied from the installed framework's
 *                                                       templates/config/global.env when the repository has none
 *   config/<project>/common/common.env                  the project's own settings (overrides of the defaults):
 *                                                       identity, its features and steps, its database connection
 *   config/<project>/common/<project>-db-queries.env    its named queries (DB_QUERY_<NAME>=…), with a database
 *   config/<project>/environments/<env>.env             each environment's overrides: addresses, the database
 *                                                       connection, the application user (passwords ENCRYPTED:,
 *                                                       encrypted by the framework)
 *   test/<project>/{features,pages,steps,data,helpers}
 *
 * Keys are the framework's: DATABASE_CONNECTIONS / DB_<ALIAS>_* (CSDatabase), DB_QUERY_<NAME> (CSDBUtils), the
 * alias being the project in capitals (e.g. ORDERS for the project orders). Nothing is written here: the files are a plan the Studio
 * reviews and applies.
 */
import * as fs from 'fs';
import * as path from 'path';
import { UserError } from '../core/errors';
import { frameworkPackage } from './package';
import type { ChangePlan } from './plan';

/** The framework's database types (CSDatabase DatabaseType) and their usual ports. */
export const DB_TYPES = ['none', 'oracle', 'sqlserver', 'mysql', 'postgresql'] as const;
const PORTS: Record<string, string> = { oracle: '1521', sqlserver: '1433', mysql: '3306', postgresql: '5432' };

export interface NewProject {
    slug: string;
    /** Shown name (PROJECT_NAME / APPLICATION_NAME); default: the project in capitals. */
    displayName?: string;
    environments: Array<{ name: string; baseUrl: string; loginUrl?: string; apiBaseUrl?: string }>;
    dbType: typeof DB_TYPES[number];
    /** The application user of every environment (its password encrypted by the framework). */
    credentials?: { username?: string; password?: string };
}

export interface Scaffolded {
    plan: ChangePlan;
    /** Folders it creates (test/<slug>/…). */
    dirs: string[];
    environments: string[];
    /** The connection alias and the keys of the project (for the review). */
    alias: string;
    /** config/global.env: written from the framework's defaults, the repository's own kept, or none available. */
    globalEnv: 'written' | 'kept' | 'unavailable';
    notes: string[];
}

const header = (title: string, lines: string[]) => [
    '# ==============================================================================',
    `# ${title}`,
    '# ==============================================================================',
    ...lines.map((l) => (l ? `# ${l}` : '#')),
    '# ==============================================================================',
    '',
];

export function scaffoldProject(repoRoot: string, input: NewProject): Scaffolded {
    const fw = frameworkPackage(repoRoot);
    if (!fw?.dir) throw new UserError('The CS Playwright Test Framework is not installed in this repository (npm install).');
    const slug = input.slug;
    if (fs.existsSync(path.join(repoRoot, 'config', slug)) || fs.existsSync(path.join(repoRoot, 'test', slug))) {
        throw new UserError(`The project ${slug} exists already (config/${slug} or test/${slug}): its settings are on the Environments page.`);
    }
    const alias = slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const display = input.displayName?.trim() || slug.toUpperCase();
    const files: ChangePlan['files'] = [];
    const notes: string[] = [];

    // 1. The framework's defaults, when the repository has none.
    let globalEnv: Scaffolded['globalEnv'] = 'kept';
    if (!fs.existsSync(path.join(repoRoot, 'config', 'global.env'))) {
        const tpl = path.join(fw.dir, 'templates', 'config', 'global.env');
        if (fs.existsSync(tpl)) { files.push({ path: 'config/global.env', kind: 'config', text: fs.readFileSync(tpl, 'utf8') }); globalEnv = 'written'; }
        else { globalEnv = 'unavailable'; notes.push(`This framework version does not ship its defaults (templates/config/global.env): config/global.env is not written; the framework uses its built-in defaults.`); }
    }

    // The framework encrypts passwords (CSEncryptionUtil), as `npx cs-playwright-mcp encrypt` does.
    const encrypt = (v: string): string => {
        const util = path.join(fw.dir!, 'dist', 'utils', 'CSEncryptionUtil.js');
        if (!fs.existsSync(util)) throw new UserError('The framework\'s encryption (CSEncryptionUtil) is not available: leave the password empty and set it on the Environments page.');
        const enc = (require(util) as { CSEncryptionUtil: { getInstance(): { createEncryptedConfigValue(t: string): string } } }).CSEncryptionUtil.getInstance().createEncryptedConfigValue(v);
        return enc.startsWith('ENCRYPTED:') ? enc : `ENCRYPTED:${enc}`;
    };
    const user = input.credentials?.username?.trim() ?? '';
    const password = input.credentials?.password ? encrypt(input.credentials.password) : '';
    const db = input.dbType !== 'none';

    // 2. The project's own settings.
    files.push({ path: `config/${slug}/common/common.env`, kind: 'config', text: [
        ...header(`${alias} - PROJECT SETTINGS`, [
            `The project's overrides of the framework defaults (config/global.env).`,
            `Each environment's addresses and credentials: environments/<env>.env.`,
            ...(db ? [`Its named database queries: ${slug}-db-queries.env (in this folder).`] : []),
        ]),
        `PROJECT=${slug}`,
        `PROJECT_NAME=${display}`,
        `APPLICATION_NAME=${display}`,
        '',
        '# Tests of this project',
        `FEATURES=test/${slug}/features/**/*.feature`,
        `FEATURE_PATH=test/${slug}/features/`,
        `STEP_DEFINITIONS_PATH=test/${slug}/steps;test/common/steps;node_modules/${fw.name}/dist/steps`,
        '',
        ...(db ? [
            '# Database: the connection of this project (its details per environment)',
            'DB_ENABLED=true',
            `DATABASE_CONNECTIONS=${alias}`,
            `DB_${alias}_TYPE=${input.dbType}`,
            `DB_${alias}_CONNECTION_TIMEOUT=60000`,
            `DB_${alias}_REQUEST_TIMEOUT=30000`,
            `DB_${alias}_POOL_MIN=2`,
            `DB_${alias}_POOL_MAX=10`,
            `DB_${alias}_POOL_IDLE_TIMEOUT=30000`,
            '',
        ] : []),
    ].join('\n') });

    // 3. Its named queries (none yet: each one is written from the real schema).
    if (db) files.push({ path: `config/${slug}/common/${slug}-db-queries.env`, kind: 'config', text: [
        ...header(`${alias} - DATABASE QUERIES`, [
            `Named queries of the ${alias} connection, used by name from steps and CSDBUtils:`,
            `  DB_QUERY_<NAME>=<SQL with ? for each parameter>`,
            `e.g. a step runs "GET_USER_BY_ID" with one parameter; the framework reads DB_QUERY_GET_USER_BY_ID.`,
            '',
            'Group them under a comment per area; for larger projects, one file per area',
            `(${slug}-<area>-db-queries.env) in this folder: every .env file here is loaded.`,
            'Table and column names come from the application\'s schema, never guessed.',
        ]),
    ].join('\n') });

    // 4. Each environment's overrides.
    for (const e of input.environments) {
        files.push({ path: `config/${slug}/environments/${e.name}.env`, kind: 'config', text: [
            ...header(`${alias} - ${e.name.toUpperCase()} ENVIRONMENT`, [`Overrides for ${e.name}: addresses, the database connection and credentials.`, 'Passwords as ENCRYPTED: values (npx cs-playwright-mcp encrypt <value>).']),
            `ENVIRONMENT=${e.name}`,
            '',
            '# Application',
            `BASE_URL=${e.baseUrl}`,
            ...(e.loginUrl ? [`LOGIN_URL=${e.loginUrl}`] : []),
            ...(e.apiBaseUrl ? [`API_BASE_URL=${e.apiBaseUrl}`] : []),
            '',
            ...(db ? [
                `# Database (${alias}, ${input.dbType})`,
                `DB_${alias}_HOST=`,
                `DB_${alias}_PORT=${PORTS[input.dbType] ?? ''}`,
                `DB_${alias}_DATABASE=`,
                `DB_${alias}_USERNAME=`,
                `DB_${alias}_PASSWORD=`,
                '',
            ] : []),
            '# Application user',
            `${alias}_USERNAME=${user}`,
            `${alias}_PASSWORD=${password}`,
            '',
        ].join('\n') });
    }
    if (db) notes.push(`Set each environment's database connection (DB_${alias}_HOST, _DATABASE, _USERNAME, _PASSWORD) on the Environments page.`);

    return {
        plan: { title: `New project "${slug}"`, files, warnings: [] },
        dirs: ['features', 'pages', 'steps', 'data', 'helpers'].map((d) => `test/${slug}/${d}`),
        environments: input.environments.map((e) => e.name),
        alias,
        globalEnv,
        notes,
    };
}
