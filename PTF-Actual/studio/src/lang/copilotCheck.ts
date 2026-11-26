/**
 * `cs-test-studio copilot-check`: a real end-to-end check of Copilot in the Studio's editor, without clicking
 * through the Studio. It runs the Studio's own server (in this process) on a small sample project, then goes
 * through what a person does: install the Copilot language server (when it is not there), sign in (the one
 * step that needs the person: a code entered on github.com), ask for suggestions in a step file, a function
 * and a feature file, and check that a secret file is never sent. It prints a short report (also written to
 * copilot-check-report.txt) to send back when something does not work.
 *
 * It uses the person's Studio home, so the install and the sign-in are the ones the Studio then uses.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** What the check needs from the Studio's server (its HTTP API, called in-process). */
export type Call = (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The sample project's files: each probe is a file and the place the caret is (where "‸" is). */
export const PROBES: Array<{ name: string; file: string; text: string; expect: 'suggestion' | 'never-sent' }> = [
    {
        name: 'Step definition: finish a Playwright call', file: 'test/demo/steps/login.steps.ts', expect: 'suggestion',
        text: [
            "import { CSBDDStepDef, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';",
            "import { CSBrowserManager } from '@mdakhan.mak/cs-playwright-test-framework/browser';",
            '',
            '@StepDefinitions',
            'export class LoginSteps {',
            "    @CSBDDStepDef('I log in as {string} with password {string}')",
            '    async logIn(user: string, password: string) {',
            '        const page = CSBrowserManager.getInstance().getPage();',
            "        await page.fill('#username', user);",
            '        ‸',
            '    }',
            '}',
            '',
        ].join('\n'),
    },
    {
        name: 'TypeScript: write a function body from its comment', file: 'test/demo/support/dates.ts', expect: 'suggestion',
        text: [
            '/** The date `days` days after `from`, as YYYY-MM-DD. */',
            'export function addDays(from: Date, days: number): string {',
            '    ‸',
            '}',
            '',
        ].join('\n'),
    },
    {
        name: 'Feature file: next Gherkin step', file: 'test/demo/features/login.feature', expect: 'suggestion',
        text: [
            'Feature: Login',
            '',
            '  Scenario: A user signs in with valid details',
            '    Given I open the login page',
            '    When I log in as "anna" with password "secret-pass"',
            '    ‸',
            '',
        ].join('\n'),
    },
    {
        name: 'Secret file (.env) is never sent to Copilot', file: 'config/demo/environments/qa.env', expect: 'never-sent',
        text: 'BASE_URL=https://qa.example.test\nDB_PASSWORD=‸\n',
    },
];

const line = (s = '') => s + '\n';
const ms = (n: number) => `${Math.round(n)} ms`;

/** Make the sample project: a Git repository with the probe files (caret marks removed). */
export function makeSampleProject(dir: string): void {
    for (const p of PROBES) {
        const f = path.join(dir, p.file);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, p.text.replace('‸', ''));
    }
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'commonjs', strict: true, experimentalDecorators: true } }, null, 2));
}

/**
 * Run the check. `out` prints progress; `wait(ms)` sleeps (tests make it instant). Returns the report text and
 * whether everything that should work did.
 */
export async function copilotCheck(call: Call, o: { out: (s: string) => void; wait?: (ms: number) => Promise<void>; signInMinutes?: number; meta?: Record<string, string> }): Promise<{ ok: boolean; report: string }> {
    const wait = o.wait ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n)));
    const rep: string[] = [];
    const note = (s: string) => { rep.push(s); o.out(line(s)); };
    let ok = true;
    note('CS Test Studio — Copilot check');
    for (const [k, v] of Object.entries({ node: process.version, os: `${os.platform()} ${os.release()}`, proxy: process.env.HTTPS_PROXY || process.env.https_proxy ? 'set (HTTPS_PROXY)' : 'none', ...(o.meta ?? {}) })) note(`  ${k}: ${v}`);

    // 1. Installed?
    let st = (await call('GET', '/api/agents/inline')).json;
    if (!st?.enabled) { await call('POST', '/api/agents/inline/settings', { enabled: true }); st = (await call('GET', '/api/agents/inline')).json; }
    if (!st?.installed) {
        o.out(line('Installing the Copilot language server (one time, a minute or two)…'));
        const r = await call('POST', '/api/agents/inline/install', {});
        if (r.status !== 200) { note(`FAIL install: ${r.json?.error ?? r.status}`); return { ok: false, report: rep.join('\n') }; }
        for (let i = 0; i < 600; i++) {
            st = (await call('GET', '/api/agents/inline')).json;
            if (!st?.install?.running) break;
            await wait(1000);
        }
        if (!st?.installed) { note(`FAIL install: ${[...(st?.install?.log ?? [])].slice(-3).join(' | ') || st?.reason || 'not installed'}`); return { ok: false, report: rep.join('\n') }; }
    }
    note(`  language server: ${st.version}${st.custom ? ' (custom command)' : ''}`);

    // 2. Started and signed in?
    let t0 = Date.now();
    let c = await call('POST', '/api/agents/inline/check', {});
    if (c.status !== 200) { note(`FAIL start: ${c.json?.error ?? c.status}`); return { ok: false, report: rep.join('\n') }; }
    st = c.json;
    note(`PASS started the language server (${ms(Date.now() - t0)})`);
    if (st.state !== 'ready') {
        const s = await call('POST', '/api/agents/inline/signin', {});
        if (s.status !== 200) { note(`FAIL sign-in: ${s.json?.error ?? s.status}`); return { ok: false, report: rep.join('\n') }; }
        st = s.json;
        if (st.state !== 'ready' && st.signIn) {
            o.out(line(''));
            o.out(line(`  Sign in to GitHub Copilot: open ${st.signIn.verificationUri}`));
            o.out(line(`  and enter the code  ${st.signIn.userCode}  (waiting up to ${o.signInMinutes ?? 10} minutes)`));
            o.out(line(''));
            const until = Date.now() + (o.signInMinutes ?? 10) * 60_000;
            while (Date.now() < until) {
                await wait(4000);
                st = (await call('POST', '/api/agents/inline/check', {})).json;
                if (st?.state === 'ready' || st?.state === 'error') break;
            }
        }
    }
    if (st?.state !== 'ready') { note(`FAIL sign-in: ${st?.state ?? '?'}${st?.reason ? ` (${st.reason})` : ''}`); return { ok: false, report: rep.join('\n') }; }
    note(`PASS signed in${st.user ? ` as ${st.user}` : ''}`);

    // 3. Suggestions.
    for (const p of PROBES) {
        const offset = p.text.indexOf('‸');
        const content = p.text.replace('‸', '');
        let best: { ms: number; items: Array<{ id: string; text: string }>; skipped?: string; error?: string } | null = null;
        // Two tries: the first one in a file can be slow while Copilot reads it.
        for (let attempt = 0; attempt < 2; attempt++) {
            t0 = Date.now();
            const r = await call('POST', '/api/agents/inline/suggest', { path: p.file, content, offset, invoked: true });
            const res = { ms: Date.now() - t0, items: r.json?.items ?? [], skipped: r.json?.skipped, error: r.status === 200 ? undefined : r.json?.error ?? String(r.status) };
            best = res;
            if (res.items.length || res.error || p.expect === 'never-sent') break;
        }
        const b = best!;
        if (p.expect === 'never-sent') {
            const pass = !b.error && b.items.length === 0 && !!b.skipped;
            if (!pass) ok = false;
            note(`${pass ? 'PASS' : 'FAIL'} ${p.name}${b.skipped ? ` — "${b.skipped}"` : ''}${b.error ? ` — error: ${b.error}` : ''}`);
            continue;
        }
        if (b.error) { ok = false; note(`FAIL ${p.name} — error: ${b.error} (${ms(b.ms)})`); continue; }
        if (!b.items.length) { ok = false; note(`FAIL ${p.name} — no suggestion${b.skipped ? ` (${b.skipped})` : ''} (${ms(b.ms)})`); continue; }
        const first = b.items[0].text.replace(/\s+/g, ' ').trim();
        note(`PASS ${p.name} — ${b.items.length} suggestion(s) in ${ms(b.ms)}: "${first.length > 90 ? first.slice(0, 87) + '…' : first}"`);
        // What the editor does when one is shown and Tab accepts it.
        await call('POST', '/api/agents/inline/shown', { id: b.items[0].id });
        const a = await call('POST', '/api/agents/inline/accepted', { id: b.items[0].id });
        if (a.status !== 200) { ok = false; note(`FAIL accepting the suggestion: ${a.json?.error ?? a.status}`); }
    }

    // 4. Speed once warm.
    const p0 = PROBES[0];
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
        t0 = Date.now();
        await call('POST', '/api/agents/inline/suggest', { path: p0.file, content: p0.text.replace('‸', ''), offset: p0.text.indexOf('‸'), invoked: false });
        times.push(Date.now() - t0);
    }
    times.sort((x, y) => x - y);
    note(`INFO typing-pause suggestion time (3 tries): ${times.map(ms).join(', ')} (median ${ms(times[1])})`);
    note(ok ? 'RESULT: Copilot works in the Studio editor.' : 'RESULT: something did not work — send this report back.');
    return { ok, report: rep.join('\n') };
}
