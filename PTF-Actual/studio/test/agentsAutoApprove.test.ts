/** "Approve everything in this conversation": commands go ahead without asking; what waits goes ahead; off asks again. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentHost } from '../src/agents/host';
import { writeFakeCopilotSdk } from './fakeCopilot';

const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastConfig = (): any => (global as unknown as { __fakeCopilot: { lastConfig: unknown } }).__fakeCopilot.lastConfig;

test('approve everything: a waiting command goes ahead when it is switched on, new ones do not ask; off, they ask again; another conversation still asks', async () => {
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-auto-'));
    const repoDir = path.join(home, 'repo');
    fs.mkdirSync(path.join(repoDir, '.cs-studio'), { recursive: true });
    writeFakeCopilotSdk(path.join(home, 'rt'));
    const host = new AgentHost({ repoRoot: repoDir, home, runtimeDir: path.join(home, 'rt'), browser: { running: false } as never, secret: () => undefined, call: async () => ({ status: 200, body: {} }), projects: () => [], log: () => undefined });
    const run = (cfg: any, id: string, command: string) => { const o: { d?: { permissionDecision: string } } = {}; void cfg.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command } }, { sessionId: id }).then((d: { permissionDecision: string }) => { o.d = d; }); return o; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
        const { id } = await host.create({ title: 'Copilot' });
        const cfg = lastConfig();
        const first = run(cfg, id, 'npm test');
        await later(60);
        assert.equal(first.d, undefined, 'asks first');
        assert.deepEqual(host.setAutoApprove(id, true), { autoApprove: true, approved: 1 }, 'the waiting command is approved by switching it on');
        await until(() => !!first.d);
        assert.equal(first.d!.permissionDecision, 'allow');
        const next = run(cfg, id, 'npx tsc --noEmit');
        await until(() => !!next.d);
        assert.equal(next.d!.permissionDecision, 'allow', 'another command goes ahead without asking');
        assert.equal(host.autoApproveOf(id), true);
        host.setAutoApprove(id, false);
        const off = run(cfg, id, 'git status');
        await later(60);
        assert.equal(off.d, undefined, 'switched off: asks again');
        const ap = (host.events(id) as { events: Array<{ type: string; id?: string }> }).events.filter((e) => e.type === 'approval').at(-1)!;
        host.decide(id, ap.id!, 'reject');
        await until(() => !!off.d);
        // Another conversation is not affected.
        const { id: other } = await host.create({ title: 'Other' });
        const cfg2 = lastConfig();
        const o2 = run(cfg2, other, 'npm test');
        await later(60);
        assert.equal(o2.d, undefined, 'another conversation still asks');
        assert.throws(() => host.setAutoApprove('nope', true), /No such conversation/);
    } finally { await host.stop().catch(() => undefined); delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(home, { recursive: true, force: true }); }
});
