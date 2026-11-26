#!/usr/bin/env node
/**
 * cs-test-studio command line.
 *   cs-test-studio start [--repo <dir>] [--port <n>]
 *   cs-test-studio scan [--staged | --unpushed] [--json] [--repo <dir>]
 *   cs-test-studio hook install | uninstall [--repo <dir>]
 *   cs-test-studio hook run <hook-name> [args...]      (called by git)
 *   cs-test-studio load <test/<project>/load/<name>.load.json> [--env <env>] [--part <n>/<parts>] [--start-at <time>] [--junit <file>] [--json <file>] [--html <file>] [--pdf <file>] [--docx <file>] [--xlsx <file>] [--team <folder>]
 *   cs-test-studio load-merge <part1.json> <part2.json> … (the parts of a distributed run)
 *                                                       (a load test in a pipeline: exit 0 passed, 1 failed)
 */
import * as os from 'os';
import * as path from 'path';
import { GitService } from './git/service';
import { installHooks, runHook, uninstallHooks } from './git/hooks';
import { runGit } from './git/run';
import { scanUnpushed } from './scanner/gitScan';
import { allowlistSet } from './scanner/allowlist';
import { toPublic } from './scanner/scanner';
import { studioHome } from './core/paths';
import { defaultProtector } from './secrets/protector';
import { SecretStore } from './secrets/store';
import { createServer } from './server/server';
import { SettingsStore } from './core/settings';
import { ensurePrivateDir, writeFileAtomic } from './core/paths';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { ActivityLog } from './core/activity';
import { entriesDigest, programsInRepoConfig } from './git/repoConfig';
import * as readline from 'readline';
import { runHeadless, writeRunOutputs } from './api/headless';
import { lintConfig, lintOpenApi } from './api/openapiLint';
import { collectionHtml, collectionMarkdown } from './api/docs';
import { readCollection } from './api/store';
import { connection, DEFAULT_NETWORK } from './core/network';
import { LoadEngine } from './load/engine';
import { prepareLoad } from './load/prepare';
import { DbSessions } from './db/sessions';
import { loadDataRows } from './data/load';
import { junit, LoadRunDetail } from './load/runs';
import { mergeRuns } from './load/merge';
import { loadReportHtml, loadReportXlsx } from './load/report';
import { htmlToPdf, loadReportDocx } from './load/reportDocs';
import { publishRun } from './load/teamStore';
import { regression } from './load/analysis';
import { loadSummaryMarkdown } from './load/pipeline';
import { maxUsers } from './load/policy';

function openStore(): SecretStore {
    const home = studioHome();
    return new SecretStore(home, defaultProtector(home));
}

/** Stored values for exact-match scanning; empty if the user has no store yet (never creates one). */
async function knownSecrets() {
    const store = openStore();
    return store.exists ? store.knownSecrets() : [];
}

/**
 * The token in the launch link. Remembered in the private Studio folder (readable only by this
 * user) so the same link keeps working across restarts; `--new-token` replaces it.
 */
function launchToken(home: string, renew: boolean): string {
    const f = path.join(home, 'keys', 'launch-token');
    try { if (!renew) { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[A-Za-z0-9_-]{40,}$/.test(t)) return t; } } catch { /* first start */ }
    const t = randomBytes(32).toString('base64url');
    ensurePrivateDir(path.dirname(f));
    writeFileAtomic(f, t, 0o600);
    return t;
}

/** Open the link in the default browser without a shell (the URL is passed as one argument). */
function openBrowser(url: string): void {
    try {
        const [cmd, args] = process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]]
            : process.platform === 'darwin' ? ['/usr/bin/open', [url]] : ['xdg-open', [url]];
        const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
        c.on('error', () => undefined);
        c.unref();
    } catch { /* the link is printed anyway */ }
}

/** Yes/no question on the terminal. */
function ask(q: string): Promise<boolean> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
    });
}

/** --junit / --json / --html / --pdf / --docx / --xlsx files of a load run (the HTML and PDF in the project's report template when it has one). */
/**
 * --baseline <results.json>: the regression gate against an earlier run's results (the scenario's gate, or
 * p95 / average +10%, errors +1 point, throughput −10%); its verdict joins the service levels.
 */
function applyBaseline(detail: LoadRunDetail, argv: string[]): void {
    const f = arg(argv, '--baseline');
    if (!f || !detail.result) return;
    let base: LoadRunDetail;
    try { base = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { process.stdout.write(`No baseline (${f} cannot be read): the regression gate is skipped.\n`); return; }
    if (!base.result) return;
    const gate = detail.definition.regression ?? { p95Percent: 10, avgPercent: 10, errorRatePoints: 1, throughputPercent: 10 };
    const g = regression(detail.result, base.result, gate);
    detail.result.slas.push({ sla: { target: 'baseline' }, name: `Regression against the baseline of ${base.result.startedAt}`, pass: g.pass, level: g.pass ? 'pass' : 'fail', details: g.details });
    detail.result.passed &&= g.pass;
    detail.passed = detail.result.passed;
    process.stdout.write(`${g.pass ? 'PASS' : 'FAIL'}  Regression against the baseline: ${g.details.join('; ')}\n`);
}

async function writeLoadOutputs(detail: LoadRunDetail, argv: string[], root = process.cwd()) {
    const out = async (flag: string, label: string, data: () => string | Buffer | Promise<Buffer>) => {
        const f = arg(argv, flag);
        if (!f) return;
        fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true });
        try { fs.writeFileSync(f, await data()); process.stdout.write(`${label}: ${f}\n`); }
        catch (e) { process.stderr.write(`${label} not written: ${(e as Error).message.split('\n')[0]}\n`); }
    };
    let template: string | undefined;
    try { template = fs.readFileSync(path.join(root, 'test', detail.project, 'load', 'report-template.html'), 'utf8'); } catch { /* the default layout */ }
    await out('--junit', 'JUnit', () => junit(detail));
    await out('--json', 'Results', () => JSON.stringify(detail));
    await out('--html', 'Report', () => loadReportHtml(detail, template));
    await out('--pdf', 'PDF report', () => htmlToPdf(loadReportHtml(detail, template), root));
    await out('--docx', 'Word report', () => loadReportDocx(detail, root));
    await out('--xlsx', 'Workbook', () => loadReportXlsx(detail));
    await out('--summary', 'Summary', () => loadSummaryMarkdown(detail));
}

function arg(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}

async function repoRoot(dir: string): Promise<string> {
    // path.resolve: on Windows Git prints E:/project; the rest of the Studio uses E:\\project.
    return path.resolve((await runGit(['rev-parse', '--show-toplevel'], { cwd: dir })).stdout.trim());
}

export async function main(argv: string[]): Promise<number> {
    const [cmd, sub, ...rest] = argv;
    const repoDir = path.resolve(arg(argv, '--repo') ?? process.cwd());

    if (cmd === 'start') {
        let root: string;
        try { root = await repoRoot(repoDir); }
        catch {
            process.stderr.write(`${repoDir} is not inside a Git repository.\nOpen the Studio in your test project folder (the one you cloned), e.g.:\n  cs-test-studio start --repo C:\\work\\orders-tests\nTo get a project first: git clone <repository URL>\n`);
            return 2;
        }
        const home = studioHome();
        const settingsStore = new SettingsStore(home);
        const settings = settingsStore.get();
        // Programs this repository's own .git/config would make Git run (see repoConfig.ts).
        const programs = await programsInRepoConfig(root);
        if (programs.length) {
            const digest = entriesDigest(root, programs);
            if (!settings.trustedRepoConfigs.includes(digest)) {
                process.stdout.write(`This repository's own Git settings (.git/config) run these programs:\n${programs.map((p) => `  ${p.key} = ${p.value}`).join('\n')}\n`
                    + 'The Studio runs Git in the background, so these would run too. If you set them up yourself (or a tool like Git LFS did), that is fine.\n'
                    + 'If this folder was copied from someone else, check them first.\n');
                const ok = argv.includes('--trust-repo-config') || (process.stdin.isTTY && await ask('Continue and remember this answer? [y/N] '));
                if (!ok) { process.stderr.write('Not started. Run again with --trust-repo-config to accept them.\n'); return 2; }
                settingsStore.update({ trustedRepoConfigs: [...settings.trustedRepoConfigs, digest] });
            }
        }
        const name = (await runGit(['config', 'user.name'], { cwd: root, allowFailure: true })).stdout.trim();
        const store = openStore();
        const activity = new ActivityLog(home, () => (store.exists ? store.knownSecrets().map((k) => k.value) : []));
        const server = createServer({ repoRoot: root, store, userName: name || undefined, activity, home, token: launchToken(home, argv.includes('--new-token')) });
        // A fixed port (and a remembered token) keep bookmarks working; if the port is busy (another
        // Studio, another app), the next free one is used.
        const wanted = arg(argv, '--port') !== undefined ? Number(arg(argv, '--port')) : settings.port;
        let url = '';
        for (let p = wanted, tries = 0; ; p = p === 0 ? 0 : p + 1, tries++) {
            try { url = (await server.listen(p)).url; break; }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || tries >= 20 || p === 0) {
                    process.stderr.write(`Could not start the Studio on port ${p}: ${(e as Error).message}\n`);
                    return 2;
                }
            }
        }
        process.stdout.write(`CS Test Studio is running for ${root}\nOpen: ${url}\n(Only this computer can reach it. Press Ctrl+C to stop.)\n`);
        if (settings.openBrowser && !argv.includes('--no-open')) openBrowser(url);
        await new Promise<void>((resolve) => {
            const stop = () => { void server.app.close().then(() => resolve()); };
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
        });
        return 0;
    }

    // A mission without a person (a pipeline): unattended, the result as JUnit/Markdown/JSON, the exit code from the result.
    // An agent's evaluation cases (a pipeline gate): JUnit, the exit code from the result (and regressions).
    // A real check of Copilot in the editor, run from a terminal: install, sign in (a code on github.com),
    // suggestions in a sample project; prints a report (see lang/copilotCheck.ts).
    if (cmd === 'copilot-check') {
        const { copilotCheck, makeSampleProject } = await import('./lang/copilotCheck');
        const home = studioHome();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-copilot-check-'));
        await runGit(['init', '-q', root], { cwd: os.tmpdir() });
        makeSampleProject(root);
        const store = openStore();
        const server = createServer({ repoRoot: root, store, userName: 'copilot-check', home, activity: new ActivityLog(home, () => (store.exists ? store.knownSecrets().map((k) => k.value) : [])) });
        const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
            const r = await server.app.inject({ method, url, headers: { authorization: `Bearer ${server.token}` }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
            return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
        };
        let ok = false;
        try {
            const minutes = Number(arg(argv, '--sign-in-minutes') ?? 10);
            const r = await copilotCheck(call, { out: (t) => process.stdout.write(t), signInMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 10, meta: { studio: (() => { try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version ?? ''); } catch { return ''; } })() } });
            ok = r.ok;
            const file = path.resolve(arg(argv, '--report') ?? 'copilot-check-report.txt');
            try { fs.writeFileSync(file, r.report + '\n'); process.stdout.write(`\nReport written to ${file}\n`); } catch { /* read-only folder: printed above */ }
        } finally {
            await server.app.close().catch(() => undefined);
            fs.rmSync(root, { recursive: true, force: true });
        }
        return ok ? 0 : 1;
    }

    if (cmd === 'mission' || cmd === 'eval') {
        const key = sub;
        if (cmd === 'eval' && (!key || key.startsWith('--'))) { process.stderr.write('Usage: cs-test-studio eval <agent id> [--case <id>]… [--junit <file>] [--json <file>] [--allow-failures] [--repo <dir>]\n  Exit 1 when a case fails (or, with --allow-failures, only when a case that passed in the previous run fails now).\n'); return 2; }
        if (!key || key.startsWith('--')) { process.stderr.write('Usage: cs-test-studio mission <fix-failing|automate-story|heal-locators|flaky-hunter|coverage-gaps|review-pr|team mission> [--input name=value]… [--minutes <n>] [--model-calls <n>] [--attempts <n>] [--junit <file>] [--md <file>] [--json <file>] [--repo <dir>]\n'); return 2; }
        let root: string;
        try { root = await repoRoot(repoDir); } catch { process.stderr.write(`${repoDir} is not inside a Git repository.\n`); return 2; }
        const inputs: Record<string, string> = {};
        argv.forEach((a, i) => { if (a === '--input' && argv[i + 1]?.includes('=')) { const [k, ...v] = argv[i + 1].split('='); inputs[k] = v.join('='); } });
        const budget: Record<string, number> = {};
        for (const [flag, k] of [['--minutes', 'minutes'], ['--model-calls', 'modelCalls'], ['--attempts', 'attempts']] as const) if (arg(argv, flag) !== undefined) budget[k] = Number(arg(argv, flag));
        const home = studioHome();
        // The model from the pipeline's variables (an unset variable reaches the step as the text "$(NAME)").
        const envVal = (k: string) => { const v = process.env[k]?.trim(); return v && !/^\$\(.+\)$/.test(v) ? v : undefined; };
        const provider = envVal('AGENTS_PROVIDER');
        if (provider) {
            if (!['copilot', 'openai', 'azure', 'anthropic'].includes(provider)) { process.stderr.write('AGENTS_PROVIDER: copilot, openai, azure or anthropic.\n'); return 2; }
            const model = envVal('AGENTS_MODEL') ?? 'auto';
            const settings = provider === 'copilot' ? { provider: 'copilot', model } : { provider: 'custom', model, custom: { type: provider, baseUrl: envVal('AGENTS_BASE_URL') ?? '' } };
            fs.mkdirSync(home, { recursive: true });
            fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ ...settings, approvals: { files: 'ask', shell: 'ask', mcp: 'ask', studio: 'ask', urls: 'ask' } }, null, 2));
        }
        const name = (await runGit(['config', 'user.name'], { cwd: root, allowFailure: true })).stdout.trim();
        const store = openStore();
        const server = createServer({ repoRoot: root, store, userName: name || 'pipeline', home, activity: new ActivityLog(home, () => (store.exists ? store.knownSecrets().map((k) => k.value) : [])) });
        const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
            const r = await server.app.inject({ method, url, headers: { authorization: `Bearer ${server.token}` }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
            return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
        };
        if (cmd === 'eval') {
            const cases: string[] = [];
            argv.forEach((a, i) => { if (a === '--case' && argv[i + 1]) cases.push(argv[i + 1]); });
            // The agents look things up: the knowledge index is built first (a fresh agent machine has none).
            if ((await call('GET', '/api/knowledge')).json?.sources?.some((x: { builtAt: string | null; enabled?: boolean }) => x.enabled !== false && !x.builtAt)) {
                process.stdout.write('Building the knowledge index…\n');
                await call('POST', '/api/knowledge/build', {});
                for (let i = 0; i < 300; i++) { const k = (await call('GET', '/api/knowledge')).json; if (!k?.building) { process.stdout.write(`  ${(k?.sources ?? []).map((x: { name: string; docs: number }) => `${x.name}: ${x.docs} documents`).join(', ')}\n`); break; } await new Promise((res) => setTimeout(res, 1000)); }
            }
            const st = await call('POST', `/api/evals/${encodeURIComponent(key)}/run`, cases.length ? { cases } : {});
            if (st.status !== 200) { process.stderr.write(`The evaluation did not start: ${st.json?.error ?? st.status}\n`); await server.app.close(); return 2; }
            process.stdout.write(`Evaluating ${key} (${st.json.total} case(s))\n`);
            const stopEval = () => { void call('POST', `/api/evals/${encodeURIComponent(key)}/stop`, {}); };
            process.once('SIGINT', stopEval); process.once('SIGTERM', stopEval);
            let r: any; // eslint-disable-line @typescript-eslint/no-explicit-any
            let shownCases = 0;
            for (;;) {
                r = (await call('GET', `/api/evals/${encodeURIComponent(key)}/runs/${st.json.id}`)).json;
                const doneCases = (r.cases ?? []).filter((c: { attempts: unknown[]; passRate: number; pass: boolean }, i: number) => i < (r.cases.length - (r.state === 'running' ? 1 : 0)));
                for (const c of doneCases.slice(shownCases)) process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.attempts.length > 1 ? ` (${Math.round(c.passRate * 100)}% of ${c.attempts.length})` : ''}${c.regression ? '  REGRESSION' : c.fixed ? '  fixed' : ''}\n`);
                shownCases = Math.max(shownCases, doneCases.length);
                if (r.state !== 'running') break;
                await new Promise((res) => setTimeout(res, 2000));
            }
            const { evalJUnit } = await import('./agents/evals');
            for (const [flag, text] of [['--junit', evalJUnit(r)], ['--json', JSON.stringify(r, null, 1)]] as const) { const f = arg(argv, flag); if (f) { fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true }); fs.writeFileSync(f, text); process.stdout.write(`Wrote ${f}\n`); } }
            const regressions = r.compared?.regressions ?? 0;
            process.stdout.write(`${r.passed} of ${r.total} case(s) passed${r.compared ? ` (against the previous run: ${regressions} regression(s), ${r.compared.fixed} fixed)` : ''}${r.state !== 'done' ? ` — ${r.state}${r.error ? `: ${r.error}` : ''}` : ''}\n`);
            await server.app.close();
            if (r.state !== 'done') return 1;
            return (argv.includes('--allow-failures') ? regressions > 0 : r.passed < r.total) ? 1 : 0;
        }
        const started = await call('POST', '/api/missions', { key, inputs, budget, unattended: true });
        if (started.status !== 200) { process.stderr.write(`The mission did not start: ${started.json?.error ?? started.status}\n`); await server.app.close(); return 2; }
        const id = started.json.id as string;
        process.stdout.write(`Mission ${id}: ${started.json.title}\n`);
        let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        let shown = 0;
        const finished = ['succeeded', 'partial', 'failed', 'blocked', 'over-budget', 'stopped'];
        const stop = () => { void call('POST', `/api/missions/${id}/stop`, {}); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        for (;;) {
            m = (await call('GET', `/api/missions/${id}`)).json;
            for (const t of (m.timeline ?? []).slice(shown)) process.stdout.write(`  ${new Date(t.at).toISOString().slice(11, 19)} ${t.text}\n`);
            shown = m.timeline?.length ?? shown;
            if (finished.includes(m.state)) break;
            await new Promise((r) => setTimeout(r, 2000));
        }
        const { missionJUnit, missionMarkdown } = await import('./agents/missions');
        const put = (flag: string, text: string) => { const f = arg(argv, flag); if (f) { fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true }); fs.writeFileSync(f, text); process.stdout.write(`Wrote ${f}\n`); } };
        put('--junit', missionJUnit(m));
        put('--md', missionMarkdown(m));
        put('--json', JSON.stringify(m, null, 1));
        process.stdout.write(`${m.state === 'succeeded' || m.state === 'partial' ? 'OK' : 'NOT DONE'}: ${m.reason ?? m.state}${m.copy ? ` (branch ${m.copy.branch})` : ''}\n`);
        await server.app.close();
        return m.state === 'succeeded' || m.state === 'partial' ? 0 : 1;
    }

    if (cmd === 'scan') {
        const json = argv.includes('--json');
        const root = await repoRoot(repoDir);
        let findings;
        if (argv.includes('--unpushed')) {
            const res = await scanUnpushed(root, { allowlist: allowlistSet(root), knownSecrets: await knownSecrets() });
            findings = res.findings.map((f, i) => toPublic(f, `f${i + 1}`));
        } else {
            findings = (await new GitService(root, { knownSecrets }).scanStaged()).findings;
        }
        // The JSON output goes to CI logs and other tools: leave out the fingerprint (it is derived from
        // the value) and keep only the masked preview.
        if (json) process.stdout.write(JSON.stringify({ findings: findings.map(({ fingerprint: _fp, ...rest }) => rest) }, null, 2) + '\n');
        else if (findings.length === 0) process.stdout.write('No secrets found.\n');
        else for (const f of findings) process.stdout.write(`${f.file}:${f.line}:${f.column}  ${f.type}  [${f.preview}]\n`);
        return findings.length ? 1 : 0;
    }

    if (cmd === 'hook') {
        if (sub === 'install') {
            const files = await installHooks(await repoRoot(repoDir), { cliPath: __filename });
            process.stdout.write(`Installed:\n${files.map((f) => '  ' + f).join('\n')}\n`);
            return 0;
        }
        if (sub === 'uninstall') {
            await uninstallHooks(await repoRoot(repoDir));
            process.stdout.write('Hooks removed.\n');
            return 0;
        }
        if (sub === 'run') {
            const [name, ...hookArgs] = rest;
            return runHook(name, hookArgs, await repoRoot(process.cwd()), {
                env: process.env,
                out: (s) => process.stdout.write(s + '\n'),
                err: (s) => process.stderr.write(s + '\n'),
                knownSecrets,
            });
        }
    }

    if (cmd === 'agent') {
        // A load generator: runs the parts of load tests a Studio sends it (see src/load/agent.ts).
        const token = process.env.CS_AGENT_TOKEN ?? '';
        if (token.length < 16) { process.stderr.write('Set CS_AGENT_TOKEN (at least 16 characters) to the token the Studio uses for this generator.\n'); return 2; }
        const port = Number(arg(argv, '--port') ?? 4720), host = arg(argv, '--host') ?? '127.0.0.1';
        const cert = arg(argv, '--tls-cert'), key = arg(argv, '--tls-key');
        if (!!cert !== !!key) { process.stderr.write('--tls-cert and --tls-key go together.\n'); return 2; }
        const { createAgent } = await import('./load/agent');
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
        const server = createAgent({ token, dir: path.join(require('os').homedir(), '.cs-test-studio', 'agent-runs'), workerFile: path.join(__dirname, 'load', 'worker.js'),
            ...(arg(argv, '--repo') ? { repo: path.resolve(arg(argv, '--repo')!) } : {}), ...(arg(argv, '--zone') ? { zone: arg(argv, '--zone') } : {}), version: pkg.version ?? '', ...(cert && key ? { tls: { cert, key } } : {}) });
        await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(port, host, () => res()); });
        process.stdout.write(`Load generator listening on ${cert ? 'https' : 'http'}://${host}:${port}${arg(argv, '--zone') ? ` (zone ${arg(argv, '--zone')})` : ''}\n`);
        if (!cert && host !== '127.0.0.1' && host !== 'localhost') process.stdout.write('Without --tls-cert / --tls-key the parts (and the values in them) travel unencrypted: use a private network.\n');
        await new Promise<void>((res) => { const bye = () => { server.close(); res(); }; process.once('SIGINT', bye); process.once('SIGTERM', bye); });
        return 0;
    }

    if (cmd === 'load-report') {
        // The reports (and the regression gate) of one results file, e.g. a pipeline's single load generator.
        if (!sub || sub.startsWith('--')) { process.stderr.write('Usage: cs-test-studio load-report <results.json> [--baseline <results.json>] [--junit <file>] [--json <file>] [--html <file>] [--pdf <file>] [--docx <file>] [--xlsx <file>] [--summary <file>] [--team <folder>]\n'); return 2; }
        let d: LoadRunDetail;
        try { d = JSON.parse(fs.readFileSync(sub, 'utf8')); if (!d.result) throw new Error('not the results of a load run'); } catch (e) { process.stderr.write(`${sub}: ${(e as Error).message}\n`); return 2; }
        applyBaseline(d, argv);
        await writeLoadOutputs(d, argv);
        const team = arg(argv, '--team');
        if (team) { try { process.stdout.write(`Shared with the team: ${publishRun(team, d, process.env.BUILD_DEFINITIONNAME ? { user: 'pipeline', pipeline: `${process.env.BUILD_DEFINITIONNAME} #${process.env.BUILD_BUILDNUMBER ?? ''}`.trim() } : {}).file}\n`); } catch (e) { process.stderr.write(`Not shared with the team: ${(e as Error).message}\n`); } }
        process.stdout.write(d.result!.passed ? 'PASSED\n' : 'FAILED\n');
        return d.result!.passed ? 0 : 1;
    }

    if (cmd === 'load-merge') {
        // The parts of a distributed run (their --json results) → the results of the whole test.
        // The parts: every .json argument that is not the value of an option (--json, --baseline …).
        const optionValues = new Set(argv.map((a, i) => (a.startsWith('--') ? argv[i + 1] : undefined)).filter(Boolean));
        const files = [sub, ...rest].filter((f): f is string => !!f && !f.startsWith('--') && /\.json$/i.test(f) && !optionValues.has(f));
        if (files.length < 2) { process.stderr.write('Usage: cs-test-studio load-merge <part1.json> <part2.json> … [--baseline <results.json>] [--junit <file>] [--json <file>] [--html <file>] [--pdf <file>] [--docx <file>] [--xlsx <file>] [--summary <file>] [--team <folder>]\n'); return 2; }
        let merged;
        try { merged = mergeRuns(files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))); }
        catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 2; }
        const r = merged.result!;
        process.stdout.write(`${merged.name}: ${files.length} parts, ${r.total.count} requests, ${r.total.throughput.toFixed(1)}/s, errors ${r.total.errorRate.toFixed(2)}%, p95 ${r.total.p95} ms\n`);
        for (const sla of r.slas) process.stdout.write(`${sla.pass ? 'PASS' : 'FAIL'}  SLA ${sla.name}: ${sla.details.join(', ')}\n`);
        applyBaseline(merged, argv);
        await writeLoadOutputs(merged, argv);
        const team = arg(argv, '--team');
        if (team) { try { process.stdout.write(`Shared with the team: ${publishRun(team, { ...merged, id: `merged-${Date.now().toString(36)}` }, process.env.BUILD_DEFINITIONNAME ? { user: 'pipeline', pipeline: `${process.env.BUILD_DEFINITIONNAME} #${process.env.BUILD_BUILDNUMBER ?? ''}`.trim() } : {}).file}\n`); } catch (e) { process.stderr.write(`Not shared with the team: ${(e as Error).message}\n`); } }
        process.stdout.write(r.passed ? 'PASSED\n' : 'FAILED\n');
        return r.passed ? 0 : 1;
    }

    if (cmd === 'docs') {
        // A collection's documentation: a self-contained HTML page and / or Markdown (a pipeline artifact, a wiki page).
        const file = (sub ?? '').replace(/\\/g, '/');
        if (!file || file.startsWith('--') || (!arg(argv, '--html') && !arg(argv, '--md'))) { process.stderr.write('Usage: cs-test-studio docs <test/<project>/api/<name>.collection.json> [--html <file>] [--md <file>] [--repo <dir>]\n'); return 2; }
        const root = await repoRoot(repoDir);
        const c = readCollection(root, file);
        for (const [flag, text] of [['--html', () => collectionHtml(c)], ['--md', () => collectionMarkdown(c)]] as const) {
            const f = arg(argv, flag);
            if (!f) continue;
            fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true });
            fs.writeFileSync(f, text());
            process.stdout.write(`Wrote ${f}\n`);
        }
        return 0;
    }

    if (cmd === 'lint') {
        // OpenAPI documents checked against the specification and the team's rules (.cs-api-lint.json); exit 1 on an error.
        const files = [sub, ...rest].filter((f): f is string => !!f && !f.startsWith('--') && f !== arg(argv, '--repo'));
        if (!files.length) { process.stderr.write('Usage: cs-test-studio lint <openapi.yaml|json> … [--repo <dir>]\n'); return 2; }
        const root = await repoRoot(repoDir).catch(() => repoDir);
        const rules = lintConfig(root);
        let errors = 0;
        for (const f of files) {
            const problems = await lintOpenApi(fs.readFileSync(path.resolve(f), 'utf8'), rules);
            for (const x of problems) process.stdout.write(`${f}:${x.line}:${x.column}  ${x.severity.padEnd(7)}  ${x.message}  [${x.rule}]\n`);
            errors += problems.filter((x) => x.severity === 'error').length;
            process.stdout.write(`${f}: ${problems.filter((x) => x.severity === 'error').length} error(s), ${problems.filter((x) => x.severity === 'warning').length} warning(s)\n`);
        }
        return errors ? 1 : 0;
    }

    if (cmd === 'run') {
        // An API collection, as the Studio's runner runs it (Newman's place in a pipeline). Secrets: environment variables.
        const file = (sub ?? '').replace(/\\/g, '/');
        if (!file || file.startsWith('--')) { process.stderr.write('Usage: cs-test-studio run <test/<project>/api/<name>.collection.json> [--env <env>] [--iterations <n>] [--data <file>] [--folder <name>] [--var name=value]… [--delay <ms>] [--timeout <ms>] [--bail] [--junit <file>] [--json <file>] [--html <file>] [--repo <dir>]\n'); return 2; }
        const root = await repoRoot(repoDir);
        const conn = connection({ ...DEFAULT_NETWORK, proxyMode: 'environment' }, process.env);
        const vars: Record<string, string> = {};
        argv.forEach((a, i) => { if (a === '--var' && argv[i + 1]?.includes('=')) { const [k, ...v] = argv[i + 1].split('='); vars[k] = v.join('='); } });
        let rows: Array<Record<string, string>> | undefined;
        const data = arg(argv, '--data');
        if (data) {
            const project = file.split('/')[1];
            const sessions = new DbSessions({ repoRoot: root, env: () => ({}) });
            try { rows = (await loadDataRows({ repoRoot: root, project, environment: arg(argv, '--env') ?? 'dev', source: { kind: 'file', file: data.replace(/\\/g, '/') }, secretEnv: {}, sessions, connection: conn })).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]))); }
            finally { sessions.stopAll(); }
            if (!rows.length) { process.stderr.write(`${data} has no rows.\n`); return 2; }
        }
        const num = (f: string) => (arg(argv, f) !== undefined ? Number(arg(argv, f)) : undefined);
        const j = await runHeadless(root, file, { env: arg(argv, '--env'), iterations: num('--iterations'), rows, folder: arg(argv, '--folder'), delayMs: num('--delay'), timeoutMs: num('--timeout'), bail: argv.includes('--bail'), vars, connection: conn });
        for (const f of writeRunOutputs(j, { junit: arg(argv, '--junit'), json: arg(argv, '--json'), html: arg(argv, '--html') })) process.stdout.write(`Wrote ${f}\n`);
        const ok = j.summary.failed === 0 && j.summary.requests > 0;
        process.stdout.write(ok ? 'PASSED\n' : 'FAILED\n');
        return ok ? 0 : 1;
    }

    if (cmd === 'load') {
        // In a pipeline: secrets are the pipeline's environment variables ({env:NAME}); the proxy is
        // HTTPS_PROXY / NO_PROXY when set.
        const file = (sub ?? '').replace(/\\/g, '/');
        if (!file || file.startsWith('--')) { process.stderr.write('Usage: cs-test-studio load <test/<project>/load/<name>.load.json> [--env <env>] [--part <n>/<parts>] [--start-at <time>] [--junit <file>] [--json <file>] [--html <file>] [--pdf <file>] [--docx <file>] [--xlsx <file>] [--team <folder>]\n'); return 2; }
        const root = await repoRoot(repoDir);
        const conn = connection({ ...DEFAULT_NETWORK, proxyMode: 'environment' }, process.env);
        // Test data from files, queries, procedures or APIs: loaded once, in the project's own process.
        const sessions = new DbSessions({ repoRoot: root, env: () => ({}) });
        let x;
        try {
            x = await prepareLoad(root, file, arg(argv, '--env'), () => ({}), async (project, environment, source, secretEnv) =>
                (await loadDataRows({ repoRoot: root, project, environment, source, secretEnv, sessions, connection: conn })).rows);
        } finally { sessions.stopAll(); }
        const p = x.scenario.policy;
        process.stdout.write(`Load test "${x.scenario.name}" (${x.project}/${x.environment}): up to ${maxUsers(p)} users for ${p.duration} s, ${x.input.requests.length} request(s) per iteration.\n`);
        // Distributed: this computer runs one of several equal parts of the users.
        let part: { index: number; of: number } | undefined;
        const partArg = arg(argv, '--part');
        if (partArg) {
            const m = /^(\d+)\/(\d+)$/.exec(partArg);
            if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2]) || Number(m[2]) > 100) { process.stderr.write('--part is <n>/<parts>, e.g. 2/4 (at most 100 parts).\n'); return 2; }
            part = { index: Number(m[1]) - 1, of: Number(m[2]) };
            process.stdout.write(`Part ${m[1]} of ${m[2]}: about ${Math.round(maxUsers(p) / part.of)} of the users.\n`);
        }
        const startAt = arg(argv, '--start-at');
        if (startAt) {
            const at = Date.parse(startAt);
            if (!Number.isFinite(at)) { process.stderr.write('--start-at is a time such as 2026-05-01T10:00:00Z.\n'); return 2; }
            const wait = at - Date.now();
            if (wait > 3_600_000) { process.stderr.write('--start-at is more than an hour away.\n'); return 2; }
            if (wait > 0) { process.stdout.write(`Waiting ${Math.round(wait / 1000)} s to start with the other parts…\n`); await new Promise((r) => setTimeout(r, wait)); }
        }
        const engine = new LoadEngine({ ...x.input, connection: conn, ...(part ? { part } : {}) });
        const stop = () => { process.stdout.write('Stopping…\n'); engine.stop('stopped'); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        let last = -10;
        const r = await engine.run((snap) => {
            if (snap.elapsed - last < 10) return;
            last = snap.elapsed;
            process.stdout.write(`  ${Math.round(snap.elapsed)} s  users ${snap.users}  requests ${snap.total.count}  ${snap.total.throughput.toFixed(1)}/s  errors ${snap.total.errorRate.toFixed(2)}%  p95 ${snap.total.p95} ms\n`);
        });
        const pad = (v: string | number, n: number) => String(v).padStart(n);
        process.stdout.write(`\n${'Request'.padEnd(32)}${pad('Count', 8)}${pad('Errors', 9)}${pad('Avg', 9)}${pad('95%', 9)}${pad('99%', 9)}${pad('/s', 8)}\n`);
        for (const t of r.transactions) process.stdout.write(`${t.name.slice(0, 31).padEnd(32)}${pad(t.count, 8)}${pad(t.errorRate.toFixed(2) + '%', 9)}${pad(t.avg, 9)}${pad(t.p95, 9)}${pad(t.p99, 9)}${pad(t.throughput.toFixed(1), 8)}\n`);
        for (const sla of r.slas) process.stdout.write(`${sla.pass ? 'PASS' : 'FAIL'}  SLA ${sla.name}: ${sla.details.join(', ')}\n`);
        if (r.stopReason !== 'completed') process.stdout.write(r.stopReason === 'error-rate' ? 'FAIL  Stopped early: the error rate went over the limit.\n' : r.stopReason === 'data-used' ? 'Ended early: every data row was used once.\n' : 'Stopped before the end.\n');
        for (const m of r.monitors.filter((s) => s.error)) process.stdout.write(`Monitor ${m.name}: ${m.error}\n`);
        const detail = { id: part ? `cli-part${part.index + 1}` : 'cli', scenario: file, name: x.scenario.name, project: x.project, env: x.environment, startedAt: r.startedAt, state: 'finished' as const, maxUsers: maxUsers(p), duration: p.duration, passed: r.passed, stopReason: r.stopReason, definition: x.scenario, result: r };
        applyBaseline(detail, argv);
        await writeLoadOutputs(detail, argv, root);
        const team = arg(argv, '--team');
        if (team) {
            // A pipeline publishes as itself (Azure DevOps sets BUILD_DEFINITIONNAME / BUILD_BUILDNUMBER).
            const pipe = process.env.BUILD_DEFINITIONNAME ? `${process.env.BUILD_DEFINITIONNAME} #${process.env.BUILD_BUILDNUMBER ?? ''}`.trim() : undefined;
            try { const t = publishRun(team, { ...detail, id: `${detail.id}-${Date.now().toString(36)}` }, pipe ? { user: 'pipeline', pipeline: pipe } : {}); process.stdout.write(`Shared with the team: ${t.file}\n`); }
            catch (e) { process.stderr.write(`Not shared with the team: ${(e as Error).message}\n`); }
        }
        process.stdout.write(r.passed ? 'PASSED\n' : 'FAILED\n');
        return r.passed ? 0 : 1;
    }

    process.stderr.write([
        'Usage:',
        '  cs-test-studio start [--repo <dir>] [--port <n>] [--no-open] [--new-token] [--trust-repo-config]',
        '  cs-test-studio scan [--staged | --unpushed] [--json] [--repo <dir>]',
        '  cs-test-studio agent [--port 4720] [--host 0.0.0.0] [--zone <name>] [--repo <dir>] [--tls-cert <file> --tls-key <file>]   (token: CS_AGENT_TOKEN)',
        '  cs-test-studio hook install | uninstall [--repo <dir>]',
        '  cs-test-studio mission <mission> [--input name=value]… [--minutes <n>] [--model-calls <n>] [--attempts <n>] [--junit <file>] [--md <file>] [--json <file>] [--repo <dir>]   (unattended; model key: AGENTS_PROVIDER_API_KEY or COPILOT_GITHUB_TOKEN)',
        '  cs-test-studio eval <agent id> [--case <id>]… [--junit <file>] [--json <file>] [--allow-failures] [--repo <dir>]   (an agent\'s evaluation cases; exit 1 on a failure, or with --allow-failures only on a regression)',
        '  cs-test-studio lint <openapi.yaml|json> … [--repo <dir>]',
        '  cs-test-studio docs <test/<project>/api/<name>.collection.json> [--html <file>] [--md <file>] [--repo <dir>]',
        '  cs-test-studio run <test/<project>/api/<name>.collection.json> [--env <env>] [--iterations <n>] [--data <file>] [--folder <name>] [--var name=value] [--bail] [--junit <file>] [--json <file>] [--html <file>] [--repo <dir>]',
        '  cs-test-studio load <test/<project>/load/<name>.load.json> [--env <env>] [--part <n>/<parts>] [--start-at <time>] [--junit <file>] [--json <file>] [--html <file>] [--pdf <file>] [--docx <file>] [--xlsx <file>] [--team <folder>] [--repo <dir>]',
        '  cs-test-studio load-merge <part1.json> <part2.json> … [--baseline <results.json>] [--junit <file>] [--json <file>] [--html <file>] [--pdf <file>] [--docx <file>] [--xlsx <file>] [--summary <file>] [--team <folder>]',
        '  cs-test-studio load-report <results.json> [--baseline <results.json>] [--junit|--html|--pdf|--docx|--xlsx|--summary <file>] [--team <folder>]',
        '',
    ].join('\n'));
    return 2;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); },
    );
}
