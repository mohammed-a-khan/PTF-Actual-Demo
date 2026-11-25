import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../src/git/run';
import { endpointProblem } from '../src/agents/host';
import { KnowledgeBase } from '../src/agents/knowledge';

const assistant = { id: 'two-tabs', name: 'Two tabs', mode: 'assistant', instructions: 'Review the test code against the team standards and list improvements.', tools: ['knowledge', 'studio-read'] };

async function server() {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-versions-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, '.cs-studio'), { recursive: true });
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk', home: path.join(tmp, 'home') });
    const call = async (method: string, url: string, payload?: unknown) => {
        const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) });
        return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    return { tmp, dir, srv, call };
}

test('an agent saved from two tabs: the second save (with the version it read) is refused with 409; overwrite on purpose works', async () => {
    const { tmp, srv, call } = await server();
    try {
        assert.equal((await call('PUT', '/api/agent-builder/two-tabs', { agent: assistant, isNew: true })).status, 200);
        const read = (await call('GET', '/api/agent-builder')).json;
        const v = read.versions['two-tabs'];
        assert.match(v, /^[0-9a-f]{16}$/);
        // Tab A saves with the version it read: fine, and the version changes.
        const a = await call('PUT', '/api/agent-builder/two-tabs', { agent: { ...assistant, name: 'QA two A' }, version: v });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.notEqual(a.json.versions['two-tabs'], v);
        // Tab B still has the old version: refused, A's change kept.
        const b = await call('PUT', '/api/agent-builder/two-tabs', { agent: { ...assistant, name: 'QA two B' }, version: v });
        assert.equal(b.status, 409);
        assert.match(b.json.error, /Changed in another tab or by someone else/);
        assert.equal((await call('GET', '/api/agent-builder')).json.agents[0].name, 'QA two A');
        // Overwrite on purpose.
        const f = await call('PUT', '/api/agent-builder/two-tabs', { agent: { ...assistant, name: 'QA two B' }, version: v, force: true });
        assert.equal(f.status, 200);
        assert.equal(f.json.agents[0].name, 'QA two B');
        // Deleted in another tab meanwhile: a save with the old version is refused too (not silently re-created).
        const v2 = f.json.versions['two-tabs'];
        assert.equal((await call('DELETE', '/api/agent-builder/two-tabs', { confirm: true })).status, 200);
        assert.equal((await call('PUT', '/api/agent-builder/two-tabs', { agent: assistant, version: v2 })).status, 409);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('knowledge sources: saves carry the version read (409 when changed meanwhile); a missing folder is flagged on its row and blocks only itself', async () => {
    const { tmp, dir, srv, call } = await server();
    try {
        fs.mkdirSync(path.join(dir, 'docs'));
        fs.writeFileSync(path.join(dir, '.cs-studio/knowledge.json'), JSON.stringify({ sources: [
            { id: 'repo', name: 'This repository', kind: 'repo' },
            { id: 'etc', name: 'Etc', kind: 'folder', path: '../../no-such-folder-here' },
        ] }));
        const k = (await call('GET', '/api/knowledge')).json;
        assert.match(k.version, /^[0-9a-f]{16}$/);
        const etc = k.sources.find((s: { id: string }) => s.id === 'etc');
        assert.match(etc.warning, /does not exist/, 'the row says what is wrong');
        assert.equal(k.sources.find((s: { id: string }) => s.id === 'repo').warning, undefined);
        const plain = (list: Array<Record<string, unknown>>) => list.map(({ id, name, kind, enabled, path: p }) => ({ id, name, kind, enabled, ...(p ? { path: p } : {}) }));
        // Toggling another source works although Etc's folder is missing (Etc stays as written).
        const off = await call('PUT', '/api/knowledge/sources', { sources: plain(k.sources).map((s) => (s.id === 'repo' ? { ...s, enabled: false } : s)), version: k.version });
        assert.equal(off.status, 200, JSON.stringify(off.json));
        assert.equal(off.json.sources.find((s: { id: string }) => s.id === 'etc').path, '../../no-such-folder-here');
        // A source added with a missing folder is refused; one with a folder that is there is added.
        const k2 = (await call('GET', '/api/knowledge')).json;
        const bad = await call('PUT', '/api/knowledge/sources', { sources: [...plain(k2.sources), { id: 'gone', name: 'Gone', kind: 'folder', path: 'gone' }], version: k2.version });
        assert.equal(bad.status, 400); assert.match(bad.json.error, /Source "Gone": the folder gone does not exist/);
        const good = await call('PUT', '/api/knowledge/sources', { sources: [...plain(k2.sources), { id: 'docs', name: 'Docs', kind: 'folder', path: 'docs' }], version: k2.version });
        assert.equal(good.status, 200, JSON.stringify(good.json));
        // Fixing the bad source's folder works too.
        const k3 = (await call('GET', '/api/knowledge')).json;
        assert.equal((await call('PUT', '/api/knowledge/sources', { sources: plain(k3.sources).map((s) => (s.id === 'etc' ? { ...s, path: 'docs-again' } : s)), version: k3.version })).status, 400, 'still a missing folder');
        fs.mkdirSync(path.join(dir, 'docs-again'));
        const fixed = await call('PUT', '/api/knowledge/sources', { sources: plain(k3.sources).map((s) => (s.id === 'etc' ? { ...s, path: 'docs-again' } : s)), version: k3.version });
        assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
        assert.equal(fixed.json.sources.find((s: { id: string }) => s.id === 'etc').warning, undefined);
        // A second tab with the old version: refused, the file not touched.
        const before = fs.readFileSync(path.join(dir, '.cs-studio/knowledge.json'), 'utf8');
        const stale = await call('PUT', '/api/knowledge/sources', { sources: plain(k3.sources), version: k3.version });
        assert.equal(stale.status, 409);
        assert.match(stale.json.error, /Changed in another tab or by someone else/);
        assert.equal(fs.readFileSync(path.join(dir, '.cs-studio/knowledge.json'), 'utf8'), before);
        assert.equal((await call('PUT', '/api/knowledge/sources', { sources: plain(k3.sources).filter((s) => s.id !== 'etc'), version: k3.version, force: true })).status, 200, 'overwrite on purpose');
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('KnowledgeBase.saveSources: version checked; an existing missing folder does not block', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-v-'));
    try {
        const kb = new KnowledgeBase(tmp, path.join(tmp, 'index'));
        assert.equal(kb.version(), '', 'no file yet');
        kb.saveSources([{ id: 'repo', name: 'Repo', kind: 'repo' }], '');
        const v = kb.version();
        assert.throws(() => kb.saveSources([{ id: 'repo', name: 'Repo', kind: 'repo' }], ''), /Changed in another tab/);
        fs.writeFileSync(path.join(tmp, '.cs-studio/knowledge.json'), JSON.stringify({ sources: [{ id: 'repo', name: 'Repo', kind: 'repo' }, { id: 'x', name: 'X', kind: 'folder', path: 'nope' }] }));
        assert.throws(() => kb.saveSources([{ id: 'repo', name: 'Repo', kind: 'repo' }], v), /Changed in another tab/);
        assert.doesNotThrow(() => kb.saveSources([{ id: 'repo', name: 'Repo', kind: 'repo', enabled: false }, { id: 'x', name: 'X', kind: 'folder', path: 'nope' }]));
        assert.match(kb.status().find((s) => s.id === 'x')!.warning!, /The folder nope does not exist/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('team notes, agent settings and a tool server: the version read goes back with the save (409 when changed meanwhile)', async () => {
    const { tmp, srv, call } = await server();
    try {
        const n = (await call('GET', '/api/missions-memory')).json;
        assert.equal(n.version, '');
        const s1 = await call('PUT', '/api/missions-memory', { text: '# Notes\n- A', version: n.version });
        assert.equal(s1.status, 200);
        const stale = await call('PUT', '/api/missions-memory', { text: '# Notes\n- B', version: n.version });
        assert.equal(stale.status, 409);
        assert.match(stale.json.error, /Changed in another tab or by someone else/);
        assert.equal((await call('PUT', '/api/missions-memory', { text: '# Notes\n- B', version: s1.json.version })).status, 200);

        const st = (await call('GET', '/api/agents/status')).json;
        assert.equal(typeof st.settingsVersion, 'string');
        const custom = { ...st.settings, provider: 'custom', model: 'mock-1', custom: { type: 'openai', baseUrl: 'http://127.0.0.1:47401/v1' } };
        const ok = await call('PUT', '/api/agents/settings', { settings: custom, version: st.settingsVersion });
        assert.equal(ok.status, 200, JSON.stringify(ok.json));
        assert.equal((await call('PUT', '/api/agents/settings', { settings: { ...custom, model: 'mock-2' }, version: st.settingsVersion })).status, 409, 'another tab saved meanwhile');
        assert.equal((await call('PUT', '/api/agents/settings', { settings: { ...custom, model: 'mock-2' }, version: ok.json.settingsVersion })).status, 200);
        // The model: at most 120 characters; the endpoint: a real http(s) address.
        const long = await call('PUT', '/api/agents/settings', { settings: { ...custom, model: 'm'.repeat(130) } });
        assert.equal(long.status, 400); assert.match(long.json.error, /at most 120 characters \(it has 130\)/);
        assert.equal((await call('PUT', '/api/agents/settings', { settings: { ...custom, model: 'm'.repeat(120) } })).status, 200, '120 is fine');
        for (const bad of ['not a url', 'http://127.0.0.1:47401/v1 😀', 'ftp://host/v1', '']) {
            const r = await call('PUT', '/api/agents/settings', { settings: { ...custom, custom: { type: 'openai', baseUrl: bad } } });
            assert.equal(r.status, 400, bad); assert.match(r.json.error, /^Endpoint: /, bad);
        }

        const added = await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'srv-a', server: { kind: 'stdio', command: 'node', args: ['a.js'] } });
        assert.equal(added.status, 200, JSON.stringify(added.json));
        const ver = added.json.servers.find((x: { name: string }) => x.name === 'srv-a').version;
        const tabA = await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'srv-a', editing: 'srv-a', version: ver, server: { kind: 'stdio', command: 'node', args: ['b.js'] } });
        assert.equal(tabA.status, 200);
        const tabB = await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'srv-a', editing: 'srv-a', version: ver, server: { kind: 'stdio', command: 'node', args: ['c.js'] } });
        assert.equal(tabB.status, 409);
        assert.deepEqual(tabA.json.servers.find((x: { name: string }) => x.name === 'srv-a').server.args, ['b.js']);
        assert.equal((await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'srv-a', editing: 'srv-a', version: ver, force: true, server: { kind: 'stdio', command: 'node', args: ['c.js'] } })).status, 200);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('endpointProblem: http(s) addresses only, no spaces or emoji', () => {
    assert.equal(endpointProblem('https://my-resource.openai.azure.com/openai/v1'), null);
    assert.equal(endpointProblem('http://127.0.0.1:47401/v1'), null);
    for (const bad of ['not a url', 'http://127.0.0.1:47401/v1 😀', 'ftp://x', 'https://', '']) assert.ok(endpointProblem(bad), bad);
});

test('missions: mission agents\' triggers are listed with the team\'s; a finished mission can be deleted (asked first)', async () => {
    const { tmp, dir, srv, call } = await server();
    try {
        const mission = { id: 'nightly', name: 'Nightly', mode: 'mission', instructions: 'Run the smoke tests and explain every failure with evidence.', goal: 'Run the tests.', tools: ['knowledge', 'tests'], writes: false, verify: { kind: 'report' },
            triggers: [{ on: 'schedule', cron: '0 2 * * 1-5' }, { on: 'run-failed', enabled: false }] };
        assert.equal((await call('PUT', '/api/agent-builder/nightly', { agent: mission, isNew: true })).status, 200);
        const m = (await call('GET', '/api/missions')).json;
        assert.deepEqual(m.agentTriggers.map((t: { agent: string; on: string; enabled?: boolean }) => [t.agent, t.on, t.enabled !== false]), [['nightly', 'schedule', true], ['nightly', 'run-failed', false]]);
        await srv.app.close();
        // A finished mission (from an earlier Studio run) is deleted with the person's confirmation.
        const file = path.join(dir, '.git', 'cs-studio', 'missions.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify([{ id: 'mdone1234', key: 'explore', title: 'Explore', inputs: {}, state: 'succeeded', trigger: { kind: 'manual', by: 'Tester' }, autonomy: 'autonomous', createdAt: new Date().toISOString(), budget: { minutes: 5, modelCalls: 10, attempts: 1 }, used: { activeMs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, attempts: 0 }, changes: [], timeline: [], checkpoints: [], verifications: [], memory: [] }]));
        const again = await server2(dir, tmp);
        assert.equal((await again.call('DELETE', '/api/missions/mdone1234', {})).status, 400, 'asks first');
        assert.equal((await again.call('DELETE', '/api/missions/mdone1234', { confirm: true })).status, 200);
        assert.deepEqual((await again.call('GET', '/api/missions')).json.runs, []);
        assert.equal((await again.call('DELETE', '/api/missions/mdone1234', { confirm: true })).status, 400, 'gone');
        await again.srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

async function server2(dir: string, tmp: string) {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk', home: path.join(tmp, 'home') });
    const call = async (method: string, url: string, payload?: unknown) => {
        const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) });
        return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    return { srv, call };
}
