/** `cs-test-studio copilot-check`: the steps and the report, against a fake Studio API. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { copilotCheck, PROBES } from '../src/lang/copilotCheck';

type Res = { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function fakeStudio(o: { installed?: boolean; signedIn?: boolean; suggest?: (path: string) => Res }) {
    const st = { enabled: true, installed: !!o.installed, version: o.installed ? '1.574.3' : null, state: o.signedIn ? 'ready' : 'sign-in', install: { running: false, log: [] as string[] } } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const calls: string[] = [];
    let checks = 0;
    const call = async (method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Res> => {
        calls.push(`${method} ${url}`);
        if (url === '/api/agents/inline') return { status: 200, json: st };
        if (url === '/api/agents/inline/install') { st.installed = true; st.version = '1.574.3'; return { status: 200, json: st }; }
        if (url === '/api/agents/inline/check') { checks++; if (checks > 2 && st.signIn) { st.state = 'ready'; st.user = 'anna'; } return { status: 200, json: st }; }
        if (url === '/api/agents/inline/signin') { st.signIn = { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' }; return { status: 200, json: st }; }
        if (url === '/api/agents/inline/suggest') {
            const p = (payload as { path: string }).path;
            if (/\.env$/.test(p)) return { status: 200, json: { items: [], skipped: 'This file may hold secrets: it is never sent to Copilot.' } };
            return o.suggest ? o.suggest(p) : { status: 200, json: { items: [{ id: 's1', text: 'return x;' }] } };
        }
        return { status: 200, json: { ok: true } };
    };
    return { call, calls };
}

test('copilot-check: installs, waits for the sign-in code, asks in every sample file, keeps the secret file back', async () => {
    const out: string[] = [];
    const f = fakeStudio({});
    const r = await copilotCheck(f.call, { out: (s) => out.push(s), wait: async () => undefined, signInMinutes: 1 });
    assert.equal(r.ok, true, r.report);
    assert.ok(f.calls.includes('POST /api/agents/inline/install'));
    assert.match(out.join(''), /enter the code {2}ABCD-1234/);
    assert.match(r.report, /PASS signed in as anna/);
    for (const p of PROBES) assert.match(r.report, new RegExp(`PASS ${p.name.replace(/[.()]/g, '\\$&')}`));
    assert.match(r.report, /RESULT: Copilot works/);
});

test('copilot-check: no suggestion or an error is a failure, named in the report', async () => {
    const f = fakeStudio({ installed: true, signedIn: true, suggest: (p) => (p.endsWith('.feature') ? { status: 400, json: { error: 'Copilot is not enabled for this account.' } } : { status: 200, json: { items: [] } }) });
    const r = await copilotCheck(f.call, { out: () => undefined, wait: async () => undefined });
    assert.equal(r.ok, false);
    assert.match(r.report, /FAIL Feature file: next Gherkin step — error: Copilot is not enabled for this account\./);
    assert.match(r.report, /FAIL Step definition: finish a Playwright call — no suggestion/);
    assert.match(r.report, /RESULT: something did not work/);
});
