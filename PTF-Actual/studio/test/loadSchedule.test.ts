/**
 * Scheduled load tests (once, daily, weekdays; busy: tried again for 30 minutes) and several load tests at once
 * (different scenarios, up to a limit; one scenario once at a time).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { LoadScheduler, nextRun, validSchedule } from '../src/load/schedule';
import { LoadRuns } from '../src/load/runs';
import { newScenario } from '../src/load/scenario';
import { newRequest } from '../src/api/model';

const WORKER = ['worker.ts', 'worker.js'].map((f) => path.join(__dirname, '..', 'src', 'load', f)).find((f) => fs.existsSync(f))!;
const F = 'test/orders/load/checkout.load.json';

test('when schedules are due: once, daily, weekdays', () => {
    const mon = new Date(2026, 10, 23, 9, 0); // Monday 23 Nov 2026, 09:00 local
    assert.equal(nextRun({ kind: 'daily', at: '08:30' }, mon)!.getDate(), 24, 'past today: tomorrow');
    assert.equal(nextRun({ kind: 'daily', at: '22:15' }, mon)!.getHours(), 22);
    const w = nextRun({ kind: 'weekly', at: '02:00', days: [6] }, mon)!;
    assert.deepEqual([w.getDay(), w.getDate(), w.getHours()], [6, 28, 2]);
    assert.equal(nextRun({ kind: 'once', at: new Date(2026, 10, 24).toISOString(), last: { at: 'x' } }, mon), null, 'a one-off that ran is done');
    assert.match(validSchedule({ file: F, kind: 'weekly', at: '02:00', days: [] })!, /days of the week/);
    assert.match(validSchedule({ file: '../x.load.json', kind: 'daily', at: '02:00' })!, /scenario/);
    assert.match(validSchedule({ file: F, kind: 'daily', at: '25:00' })!, /HH:MM/);
});

test('the scheduler starts what is due, tries again while busy, gives up after 30 minutes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    try {
        let now = new Date(2026, 10, 23, 1, 59);
        let busy = false;
        const started: string[] = [];
        const s = new LoadScheduler(path.join(dir, 's.json'), async (file) => { if (busy) throw new Error('Checkout is already running. Stop it first.'); started.push(file); return `run-${started.length}`; }, () => now);
        const nightly = s.save({ file: F, kind: 'daily', at: '02:00', env: 'qa' });
        const once = s.save({ file: 'test/orders/load/spike.load.json', kind: 'once', at: new Date(2026, 10, 23, 2, 0).toISOString() });
        assert.throws(() => s.save({ file: F, kind: 'once', at: new Date(2026, 10, 22).toISOString() }), /time has passed/);
        assert.equal(s.list().length, 2);
        await s.tick();
        assert.deepEqual(started, [], 'not yet');
        now = new Date(2026, 10, 23, 2, 0, 30);
        await s.tick();
        assert.deepEqual(started, [F, 'test/orders/load/spike.load.json']);
        const after = Object.fromEntries(s.list().map((x) => [x.id, x]));
        assert.equal(after[nightly.id].last!.runId, 'run-1');
        assert.equal(new Date(after[nightly.id].next!).getDate(), 24, 'next: tomorrow at 02:00');
        assert.deepEqual([after[once.id].enabled, after[once.id].next], [false, null], 'a one-off is done');
        // The next night the scenario is still running: tried each tick, recorded after 30 minutes.
        busy = true;
        now = new Date(2026, 10, 24, 2, 0, 10); await s.tick();
        now = new Date(2026, 10, 24, 2, 20); await s.tick();
        assert.equal(s.list().find((x) => x.id === nightly.id)!.last!.runId, 'run-1', 'still waiting');
        busy = false;
        now = new Date(2026, 10, 24, 2, 21); await s.tick();
        assert.equal(s.list().find((x) => x.id === nightly.id)!.last!.runId, 'run-3', 'started once free');
        busy = true;
        now = new Date(2026, 10, 25, 2, 0, 5); await s.tick();
        now = new Date(2026, 10, 25, 2, 31); await s.tick();
        const gaveUp = s.list().find((x) => x.id === nightly.id)!;
        assert.match(gaveUp.last!.error!, /already running/);
        assert.equal(new Date(gaveUp.next!).getDate(), 26);
        assert.equal(s.remove(once.id), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('several load tests at once: different scenarios run together, the same one only once, up to the limit', { timeout: 60_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
    const app = http.createServer((_q, r) => setTimeout(() => r.end('ok'), 3));
    const port = await new Promise<number>((res) => app.listen(0, '127.0.0.1', () => res((app.address() as net.AddressInfo).port)));
    try {
        const runs = new LoadRuns(dir, WORKER, 2);
        const go = (name: string) => {
            const sc = { ...newScenario(name, 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant' as const, users: 1, duration: 2 } };
            return runs.start({ scenarioFile: `test/p/load/${name}.load.json`, project: 'p', env: 'qa', definition: sc,
                input: { scenario: sc, collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } }, requests: [{ ...newRequest('Home', 'home'), url: '/', checks: [] }], values: { vars: {}, config: {}, env: {} }, rows: [] } });
        };
        const a = go('alpha'), b = go('beta');
        assert.throws(() => go('alpha'), /alpha is already running/);
        assert.throws(() => go('gamma'), /2 load tests are running already/);
        assert.deepEqual(runs.runningAll().map((x) => x.name).sort(), ['alpha', 'beta']);
        assert.equal(runs.stop(b.id), true);
        for (let i = 0; i < 100 && runs.runningAll().length; i++) await new Promise((r) => setTimeout(r, 100));
        assert.deepEqual([runs.get(a.id)!.state, runs.get(a.id)!.result!.stopReason, runs.get(b.id)!.result!.stopReason], ['finished', 'completed', 'stopped']);
        assert.ok(runs.get(a.id)!.result!.total.count > 0);
    } finally { app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
