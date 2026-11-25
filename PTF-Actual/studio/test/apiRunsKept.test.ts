/** Runner: runs kept, compared (fixed / broke / still failing, times, checks that changed) and exported as JUnit XML and JSON. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { DOMParser } from '@xmldom/xmldom';
import { CollectionRunner, compareRuns, runnerJUnit, RunnerJob } from '../src/api/runner';
import { ApiRequest, newCollection, newRequest } from '../src/api/model';

test('two runs compared, and the run as JUnit XML (suites per iteration, a failure per failed request, the checks that failed)', async () => {
    let round = 1;
    const s = http.createServer((q, r) => {
        const ok = q.url === '/a' ? round === 2 : q.url === '/b' ? round === 1 : true;     // /a gets fixed, /b breaks, /c stays ok
        r.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ round, path: q.url }));
    });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    try {
        const c = { ...newCollection('Orders <&> "x"'), baseUrl: `http://127.0.0.1:${port}` };
        const reqs: ApiRequest[] = ['a', 'b', 'c', 'd'].map((x) => ({ ...newRequest(`Get ${x}`), id: x, url: `/${x}`, checks: [{ kind: 'status', value: '200' }, ...(x === 'd' ? [{ kind: 'bodyContains' as const, value: '"round":1' }] : [])] }));
        const kept: RunnerJob[] = [];
        const run = async () => {
            const runner = new CollectionRunner();
            const j = runner.start({ collection: c, file: 'f', project: 'p', env: 'dev', requests: reqs, values: { vars: {}, config: {}, env: {} }, rows: [], iterations: 2, delayMs: 0, stopOnFailure: false, timeoutMs: 5000, mask: (t) => t, onDone: (x) => kept.push(JSON.parse(JSON.stringify(x))) });
            for (let i = 0; i < 100 && runner.get(j.id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 30));
            return runner.get(j.id)!;
        };
        const first = await run();
        round = 2;
        const second = await run();
        assert.equal(kept.length, 2, 'onDone keeps each run');
        const cmp = compareRuns(first, second);
        const by = (it: number, n: string) => cmp.rows.find((r) => r.iteration === it && r.name === n)!;
        assert.equal(by(1, 'Get a').change, 'fixed');
        assert.equal(by(2, 'Get b').change, 'broke');
        assert.equal(by(1, 'Get c').change, 'same');
        assert.equal(by(1, 'Get d').change, 'broke');
        assert.equal(by(1, 'Get d').checksChanged?.length, 1);
        assert.match(by(1, 'Get d').checksChanged![0], /^now fails: .*round/);
        assert.deepEqual(cmp.counts, { fixed: 2, broke: 4, same: 2, 'still failing': 0, new: 0, gone: 0 });
        assert.equal(typeof by(1, 'Get c').timeDelta, 'number');
        // JUnit.
        const x = runnerJUnit(second);
        const doc = new DOMParser().parseFromString(x, 'text/xml');
        const root = doc.documentElement;
        assert.equal(root.nodeName, 'testsuites');
        assert.deepEqual([root.getAttribute('tests'), root.getAttribute('failures')], ['8', '4']);
        const suites = Array.from(doc.getElementsByTagName('testsuite'));
        assert.deepEqual(suites.map((e) => e.getAttribute('name')), ['Orders <&> "x" — iteration 1', 'Orders <&> "x" — iteration 2']);
        const cases = Array.from(doc.getElementsByTagName('testcase'));
        assert.equal(cases.length, 8);
        const failB = cases.find((e) => e.getAttribute('name') === 'Get b')!.getElementsByTagName('failure')[0];
        assert.match(failB.textContent!, /Status is 200 \(got 500\)|status/i);
    } finally { s.close(); }
});
