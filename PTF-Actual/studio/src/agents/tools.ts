/**
 * What agents can do in the Studio, as Copilot SDK tools:
 *  - studio_context: the screen the person is on and what is selected there;
 *  - studio_catalog / studio_call: every Studio API call the screens make (code, runs, API requests and
 *    collections, load tests, database, recorder, test data, environments, Azure DevOps…), with the same
 *    checks as the screens (production stays read only). Reading runs at once; changes wait for the
 *    person's approval unless they allowed them;
 *  - browser_*: the Studio's browser (shown live in the Studio): open the application, navigate, read the
 *    screen (accessibility snapshot, scraping, screenshot), act and check; the actions are recorded;
 *  - browser_save_as_test: the recorded manual run → framework test (recorder: feature, JSON test data,
 *    page objects, steps, configuration) following the project's standards;
 *  - tests_run: run features or tags with the framework and get the results and failures;
 *  - app_code_*: the application's code (a repository checked out read-only next to the Studio's data)
 *    to read the area under test.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { CALLS, TYPES } from './catalog.generated';
import type { ElementSpec, StudioBrowser } from './browser';

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown>; handler: (args: any) => Promise<unknown>; skipPermission?: boolean }

export interface ToolDeps {
    repoRoot: string;
    browser: StudioBrowser;
    /** The latest screen context the person's Studio sent. */
    context: () => Record<string, unknown> | null;
    /** Call the Studio's API in-process (same checks as the screens). */
    call: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
    /** Ask the person (approval card in the Studio); resolves true when approved. */
    approve: (title: string, detail: string, kind: 'studio' | 'browser' | 'code' | 'plan') => Promise<boolean>;
    /** Whether changes through the Studio API need approval. */
    changesNeedApproval: () => boolean;
    /** Folder for application code checkouts. */
    appsDir: string;
    /** Repository policy: Studio areas agents cannot call; hosts the browser may open. */
    blockedAreas?: string[];
    allowedHosts?: string[];
    /** A reason this call is not available here (a mission's own copy), checked before any approval. */
    refuse?: (method: string, url: string) => string | null;
    /** No one can approve (an unattended mission). */
    unattended?: () => boolean;
}

/** Whether a host matches a policy pattern (*.contoso.com, localhost, 10.1.2.3); any host when none. */
export function hostAllowed(host: string, allowed?: string[]): boolean {
    if (!allowed?.length) return true;
    const h = host.toLowerCase();
    return allowed.some((p) => { const x = p.toLowerCase().trim(); return x.startsWith('*.') ? h === x.slice(2) || h.endsWith(x.slice(1)) : h === x; });
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const ELEMENT = {
    type: 'object', description: 'The element, as Playwright locates it: role (+ name), label, placeholder, text, testId, altText, title or css; nth for one of several; frames: CSS selectors of iframes to enter, outermost first.',
    properties: {
        role: str('ARIA role, e.g. button, link, textbox, checkbox, combobox, heading, row, cell, tab, menuitem'), name: str('Accessible name (with role)'), exact: { type: 'boolean' },
        label: str('Label text of a form field'), placeholder: str('Placeholder text'), text: str('Visible text'), testId: str('Test id attribute value'),
        altText: str('Image alt text'), title: str('Title attribute'), css: str('CSS selector (last resort)'), nth: { type: 'integer' }, frames: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
};

/** Studio calls that change nothing (previews), allowed without approval. */
const SAFE_POSTS = new Set(['/api/lang/plan', '/api/recorder/preview', '/api/data/preview', '/api/lang/diagnostics', '/api/lang/completions', '/api/lang/completion-details', '/api/lang/signature', '/api/lang/hover', '/api/lang/definition', '/api/lang/references', '/api/lang/format', '/api/lang/steps/plan', '/api/lang/warmup']);
/** Never through agents. */
const BLOCKED = [/^\/api\/agents\b/, /^\/api\/mcp\b/, /^\/api\/missions\b/, /^\/api\/evals\b/, /^\/api\/agent-builder\b/, /^\/api\/inbox\b/];

export function isReadOnlyCall(method: string, url: string, body: unknown): boolean {
    const p = url.split('?')[0];
    if (method === 'GET') return true;
    if (method === 'POST' && SAFE_POSTS.has(p)) return true;
    // A save flag false means a preview (recorder, API feature, DB feature).
    if (method === 'POST' && body && typeof body === 'object' && (body as { save?: unknown }).save === false) return true;
    return false;
}

const run = (cmd: string, args: string[], cwd: string, timeout = 300_000) => new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.slice(-6000) }));
});

const textOf = (v: unknown, max = 60_000) => { const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); return s.length > max ? `${s.slice(0, max)}\n… (cut at ${max} characters; ask for less, e.g. a narrower path or query)` : s; };

export function studioTools(d: ToolDeps): ToolDef[] {
    const appPath = (repo: string, rel = '') => {
        const base = path.resolve(d.appsDir, repo);
        const abs = path.resolve(base, rel);
        if (!/^[\w.-]+$/.test(repo) || !(abs === base || abs.startsWith(base + path.sep))) throw new Error('Not in the checked out application code.');
        return abs;
    };
    return [
        {
            name: 'studio_context', skipPermission: true,
            description: 'The Studio screen the person is looking at and what is selected there (project, environment, file, run, collection, scenario, connection, recording…). Read it first: requests usually refer to it.',
            parameters: obj({}),
            handler: async () => d.context() ?? { page: 'unknown', note: 'The person has not opened a screen yet.' },
        },
        {
            name: 'studio_catalog', skipPermission: true,
            description: 'The Studio API calls the screens make, by area (git, runs, apiws = API requests/collections/runner, load = performance, db = database, recorder, data = test data, env, secrets (names, never values), ado = Azure DevOps work items/PRs/pipelines, lang = steps and code intelligence, file/files = project files, search). With "type", the definition of a type used in arguments or results.',
            parameters: obj({ area: str('Area to list (omit for the areas)'), search: str('Words to find in call names and paths'), type: str('Type name to show') }),
            handler: async ({ area, search, type }: { area?: string; search?: string; type?: string }) => {
                if (type) return TYPES[type] ?? `No type ${type}. Types: ${Object.keys(TYPES).join(', ')}`;
                const all = CALLS.filter((c) => !BLOCKED.some((b) => b.test(c.path)) && !(d.blockedAreas ?? []).includes(c.area));
                if (!area && !search) {
                    const areas: Record<string, number> = {};
                    for (const c of all) areas[c.area] = (areas[c.area] ?? 0) + 1;
                    return { areas, how: 'studio_catalog({ area }) lists calls; studio_call({ method, path, query, body }) runs one. :name in a path is a value to fill in (URL-encoded).' };
                }
                const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
                return all.filter((c) => (!area || c.area === area) && words.every((w) => `${c.name} ${c.path}`.toLowerCase().includes(w)))
                    .map((c) => ({ call: c.name, method: c.method, path: c.path, args: c.args, ...(c.query ? { query: `{ ${c.query} }` } : {}), ...(c.body ? { body: c.body } : {}), result: c.result }));
            },
        },
        {
            name: 'studio_call',
            description: 'Run a Studio API call (see studio_catalog): the same checks as the screens apply (production databases stay read only, secrets are never shown). Reading runs at once; changes are shown to the person for approval first unless they allowed changes.',
            parameters: obj({ method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] }, path: str('Path, e.g. /api/runs or /api/apiws/collection'), query: { type: 'object', description: 'Query parameters', additionalProperties: true }, body: { description: 'JSON body (POST/PUT)' } }, ['method', 'path']),
            skipPermission: true,
            handler: async ({ method, path: p, query, body }: { method: string; path: string; query?: Record<string, unknown>; body?: unknown }) => {
                if (!/^\/api\//.test(p) || p.includes('..')) throw new Error('Only Studio API paths (/api/…).');
                if (BLOCKED.some((b) => b.test(p))) throw new Error('This call is not available to agents.');
                const area = p.split('/')[2] ?? '';
                if ((d.blockedAreas ?? []).includes(area)) throw new Error(`The repository's agent policy does not let agents use ${area} in the Studio.`);
                const qs = query && Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]): [string, string] => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString()}` : '';
                const url = `${p}${qs}`;
                const refused = d.refuse?.(method, url);
                if (refused) return { status: 409, body: refused };
                let readOnly = isReadOnlyCall(method, url, body);
                // A database query that only reads needs no approval (production stays read only anyway).
                if (method === 'POST' && p === '/api/db/query' && body && typeof body === 'object') {
                    const { classify } = require('../db/safety') as typeof import('../db/safety');
                    readOnly = classify(String((body as { sql?: unknown }).sql ?? ''), 'sqlserver').kind === 'read';
                }
                if (!readOnly && d.changesNeedApproval()) {
                    const ok = await d.approve(`${method} ${p}`, textOf(body ?? query ?? '', 4000), 'studio');
                    if (!ok) return d.unattended?.() ? 'Not done: this is an unattended run, and Studio changes need someone to approve them. Say in your report what you could not do.' : 'The person did not approve this change.';
                }
                const r = await d.call(method, url, body);
                return { status: r.status, body: textOf(r.body) };
            },
        },
        {
            name: 'browser_open', skipPermission: true,
            description: 'Open an address in the Studio\'s browser (shown live to the person in the Studio). Starts the browser when needed. Recorded as the first step of the manual run.',
            parameters: obj({ url: str('http(s) address, e.g. the environment\'s BASE_URL or a page of the application') }, ['url']),
            handler: async ({ url }: { url: string }) => {
                let host = '';
                try { host = new URL(url).hostname; } catch { throw new Error(`Not an address: ${url}`); }
                if (!hostAllowed(host, d.allowedHosts)) throw new Error(`The repository's agent policy does not let agents open ${host} (allowed: ${d.allowedHosts!.join(', ')}).`);
                return d.browser.navigate(url);
            },
        },
        {
            name: 'browser_snapshot', skipPermission: true,
            description: 'What the current page shows: its accessibility tree (roles and accessible names you can act on with browser_act), address and title. Take one after each navigation.',
            parameters: obj({ maxChars: { type: 'integer' } }),
            handler: async ({ maxChars }: { maxChars?: number }) => d.browser.snapshot(Math.min(maxChars ?? 20000, 60000)),
        },
        {
            name: 'browser_scrape', skipPermission: true,
            description: 'Screen scraping: the text, tables, links or form fields (label, name, id, placeholder, test id, options) of the page or of one element (CSS selector). Use it to learn data, field names and stable locators.',
            parameters: obj({ what: { type: 'string', enum: ['text', 'tables', 'links', 'forms'] }, css: str('Only inside this element') }, ['what']),
            handler: async ({ what, css }: { what: 'text' | 'tables' | 'links' | 'forms'; css?: string }) => d.browser.scrape(what, css),
        },
        {
            name: 'browser_screenshot', skipPermission: true,
            description: 'A screenshot of the current page (to see layout, messages and states the snapshot does not show).',
            parameters: obj({}),
            handler: async () => {
                const png = await d.browser.screenshot();
                return { textResultForLlm: 'Screenshot of the current page attached.', resultType: 'success', binaryResultsForLlm: [{ data: png.toString('base64'), mimeType: 'image/png', type: 'image' }] };
            },
        },
        {
            name: 'browser_act', skipPermission: true,
            description: 'Do something on the page, as a tester would: click, dblclick, hover, check, uncheck, fill (value), press (key, e.g. Enter), select (value or values). Prefer role + name, label or placeholder (what the snapshot shows) over CSS. Recorded for browser_save_as_test.',
            parameters: obj({ action: { type: 'string', enum: ['click', 'dblclick', 'hover', 'check', 'uncheck', 'fill', 'press', 'select'] }, element: ELEMENT, value: { description: 'fill: text; press: key; select: option value(s)' } }, ['action', 'element']),
            handler: async ({ action, element, value }: { action: 'click'; element: ElementSpec; value?: string | string[] }) => d.browser.act(action, element, value),
        },
        {
            name: 'browser_check', skipPermission: true,
            description: 'Check what the page shows (waits up to 10 s): visible, hidden, text (equals), contains, value (of a field), checked; url (contains) and title need no element. Passing checks are recorded as the test\'s assertions.',
            parameters: obj({ check: { type: 'string', enum: ['visible', 'hidden', 'text', 'contains', 'value', 'checked', 'url', 'title'] }, element: ELEMENT, expected: str('Expected text / value / address part / title') }, ['check']),
            handler: async ({ check, element, expected }: { check: 'visible'; element?: ElementSpec; expected?: string }) => {
                if (!['url', 'title'].includes(check) && !element) throw new Error('This check needs an element.');
                return d.browser.check(check, element ?? null, expected);
            },
        },
        {
            name: 'browser_recording', skipPermission: true,
            description: 'The manual run so far as a Playwright script (each browser_open / browser_act / passing browser_check). clear: start a new recording.',
            parameters: obj({ clear: { type: 'boolean' } }),
            handler: async ({ clear }: { clear?: boolean }) => { if (clear) { d.browser.clearRecording(); return 'Recording cleared.'; } return d.browser.recording(); },
        },
        {
            name: 'browser_save_as_test',
            description: 'Turn the recorded manual run into a framework test with the project\'s standards (recorder): feature (Scenario Outline + JSON test data with runFlag), page objects (existing ones extended), steps (existing ones reused), configuration (BASE_URL). preview: true shows the files without writing. Pages: breaks maps the index of the action that starts a page to its name (e.g. {"0":"Login","5":"Dashboard"}). values: per action index { mode: data|fixed|secret, column }.',
            parameters: obj({
                project: str('Project'), env: str('Environment'), name: str('Test name, e.g. "Create order"'),
                breaks: { type: 'object', additionalProperties: { type: 'string' } }, values: { type: 'object', additionalProperties: true }, labels: { type: 'object', additionalProperties: { type: 'string' } },
                secretMode: { type: 'string', enum: ['encrypted', 'studio'] }, preview: { type: 'boolean' },
            }, ['project', 'name']),
            skipPermission: true,
            handler: async (a: { project: string; env?: string; name: string; breaks?: Record<string, string>; values?: Record<string, unknown>; labels?: Record<string, string>; secretMode?: string; preview?: boolean }) => {
                const script = d.browser.recording();
                if (!d.browser.recordedLines().length) throw new Error('Nothing recorded: open the application and act with browser_open / browser_act first.');
                const b = { project: a.project, env: a.env, name: a.name, script, breaks: a.breaks ?? {}, values: a.values ?? {}, labels: a.labels ?? {}, secretMode: a.secretMode ?? 'encrypted' };
                const pre = await d.call('POST', '/api/recorder/preview', b);
                if (pre.status !== 200 || a.preview) return pre;
                const files = ((pre.body as { files?: Array<{ path: string; change: string }> }).files ?? []).map((f) => `${f.change === 'new' ? '+' : '~'} ${f.path}`).join('\n');
                if (!(await d.approve(`Save the test "${a.name}"`, files, 'code'))) return 'The person did not approve saving the test.';
                return d.call('POST', '/api/recorder/save', b);
            },
        },
        {
            name: 'plan_submit',
            description: 'Plan first: submit the test plan (the feature file you wrote for the story, scenarios and steps, nothing else yet) for the person to approve. It shows them each step as reused (an existing step definition matches) or new. Wait for the answer: only when approved, write the step definitions, page objects and data the plan needs (new steps only; reuse the rest), from the feature as it is then (the person may have edited it). When rejected, ask what to change, revise the feature and submit it again. Check the plan first with studio_call POST /api/lang/plan {path} to reuse more existing steps.',
            parameters: obj({ feature: str('The feature file (repository path, .feature)'), notes: str('What to tell the person about the plan: what it covers, what is left out, questions') }, ['feature']),
            skipPermission: true,
            handler: async ({ feature, notes }: { feature: string; notes?: string }) => {
                const review = await d.call('POST', '/api/lang/plan', { path: feature });
                if (review.status !== 200) return review;
                const r = review.body as { summary: string; coverage: unknown };
                const ok = await d.approve(`Approve the test plan: ${feature}`, `${notes ? `${notes}\n\n` : ''}${r.summary}`, 'plan');
                if (!ok) return 'The person did not approve the plan. Ask them what to change, revise the feature file, and submit it again with plan_submit. Do not write step definitions or page objects yet.';
                // The feature as approved (the person may have changed it while reviewing).
                const now = await d.call('POST', '/api/lang/plan', { path: feature });
                const f = await d.call('GET', `/api/file?path=${encodeURIComponent(feature)}`);
                return { approved: true, feature: (f.body as { content?: string })?.content ?? null, coverage: (now.body as { coverage?: unknown })?.coverage ?? null, next: 'Write only the new steps (reuse the existing ones exactly as worded), the page objects and the test data they need, following the framework\'s standards and the style of the example feature; then run the feature with tests_run and fix it until it passes.' };
            },
        },
        {
            name: 'tests_run',
            description: 'Run tests with the framework (as the Run tests screen does) and wait for the result: features (repository paths), tags or scenario name, in a project and environment. Returns passed/failed counts and each failure with its error, so you can fix and run again.',
            parameters: obj({ project: str('Project'), env: str('Environment'), features: { type: 'array', items: { type: 'string' } }, tags: str('Tag expression, e.g. @smoke'), scenario: str('Scenario name'), headless: { type: 'boolean' }, timeoutMinutes: { type: 'integer' } }, ['project', 'env']),
            skipPermission: true,
            handler: async (a: { project: string; env: string; features?: string[]; tags?: string; scenario?: string; headless?: boolean; timeoutMinutes?: number }) => {
                const started = await d.call('POST', '/api/runs', { project: a.project, env: a.env, features: a.features, tags: a.tags, scenario: a.scenario, headless: a.headless !== false, workers: 1 });
                if (started.status !== 200) return started;
                const id = (started.body as { id: string }).id;
                const until = Date.now() + Math.min(a.timeoutMinutes ?? 20, 120) * 60_000;
                let info: Record<string, unknown> = {};
                for (;;) {
                    const r = await d.call('GET', `/api/runs/${encodeURIComponent(id)}`);
                    info = r.body as Record<string, unknown>;
                    if (info.state !== 'running' || Date.now() > until) break;
                    await new Promise((res) => setTimeout(res, 2000));
                }
                const ev = await d.call('GET', `/api/runs/${encodeURIComponent(id)}/evidence`);
                return { run: id, state: info.state, summary: info.summary ?? info.result, exitCode: info.exitCode, evidence: textOf(ev.body, 30000), log: textOf(String(info.output ?? info.log ?? '').slice(-8000), 8000) };
            },
        },
        {
            name: 'app_code_checkout',
            description: 'Get the application\'s source code (a Git repository: Azure DevOps or other URL) to read the area under test: a shallow, read-only checkout kept in the Studio\'s data folder (cloned once, pulled afterwards). Uses this computer\'s Git sign-in. Returns the folder name for app_code_search / app_code_read.',
            parameters: obj({ url: str('Repository clone URL'), branch: str('Branch (default: the repository\'s default)'), name: str('Folder name (default: from the URL)') }, ['url']),
            skipPermission: true,
            handler: async ({ url, branch, name }: { url: string; branch?: string; name?: string }) => {
                if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url)) throw new Error('A https:// or SSH clone URL.');
                const folder = (name ?? url.replace(/\.git$/, '').split(/[/:]/).pop() ?? 'app').replace(/[^\w.-]/g, '-');
                const dir = appPath(folder);
                if (!(await d.approve(`Get the application code`, `${url}${branch ? ` (${branch})` : ''} into ${dir}`, 'code'))) return 'The person did not approve getting the code.';
                fs.mkdirSync(d.appsDir, { recursive: true });
                if (fs.existsSync(path.join(dir, '.git'))) {
                    // Another branch than the checkout has: fetch it and switch (a read-only copy: nothing to keep).
                    if (branch) {
                        if (!/^[\w./-]{1,200}$/.test(branch) || branch.startsWith('-')) throw new Error('Invalid branch name.');
                        const f = await run('git', ['fetch', '--depth', '1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], dir);
                        if (!f.ok) throw new Error(`git fetch of ${branch} failed: ${f.out}`);
                        const c = await run('git', ['checkout', '-q', '-B', branch, `origin/${branch}`], dir);
                        return { folder, branch, updated: c.ok, output: c.out };
                    }
                    const r = await run('git', ['pull', '--ff-only', '--depth', '1'], dir);
                    return { folder, updated: r.ok, output: r.out };
                }
                const r = await run('git', ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), url, dir], d.appsDir);
                if (!r.ok) throw new Error(`git clone failed: ${r.out}`);
                return { folder, cloned: true };
            },
        },
        {
            name: 'app_code_search', skipPermission: true,
            description: 'Find text in the checked out application code (file names and lines): routes, page components, field names, validation messages, API endpoints of the area under test.',
            parameters: obj({ folder: str('From app_code_checkout'), pattern: str('Text or regular expression'), glob: str('Only files whose path contains this, e.g. src/orders') }, ['folder', 'pattern']),
            handler: async ({ folder, pattern, glob }: { folder: string; pattern: string; glob?: string }) => {
                const base = appPath(folder);
                const r = await run('git', ['grep', '-n', '-I', '-i', '-E', '--max-count=20', pattern, '--', ...(glob ? [`*${glob}*`] : [])], base, 60_000);
                return r.out.split('\n').slice(0, 300).join('\n') || 'Nothing found.';
            },
        },
        {
            name: 'app_code_read', skipPermission: true,
            description: 'Read a file (or list a folder) of the checked out application code.',
            parameters: obj({ folder: str('From app_code_checkout'), file: str('Path in the repository (a folder lists its entries)'), fromLine: { type: 'integer' }, lines: { type: 'integer' } }, ['folder', 'file']),
            handler: async ({ folder, file, fromLine, lines }: { folder: string; file: string; fromLine?: number; lines?: number }) => {
                const abs = appPath(folder, file);
                const st = fs.statSync(abs);
                if (st.isDirectory()) return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== '.git').map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
                const all = fs.readFileSync(abs, 'utf8').split('\n');
                const from = Math.max(1, fromLine ?? 1);
                const n = Math.min(lines ?? 400, 1500);
                return `${file} (lines ${from}-${Math.min(all.length, from + n - 1)} of ${all.length})\n${all.slice(from - 1, from - 1 + n).map((l, i) => `${from + i}: ${l}`).join('\n')}`;
            },
        },
    ];
}
