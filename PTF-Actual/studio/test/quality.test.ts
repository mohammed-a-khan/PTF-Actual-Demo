import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildQuality, classify, collectRuns, DEFAULT_GATE, failureCategory, failureSignature, setQuarantineTag } from '../src/quality/quality';
import type { RunInfo, RunSummary } from '../src/run/runner';
import type { CatalogFeature } from '../src/run/catalog';

const r = (status: 'passed' | 'failed' | 'skipped', retries = 0) => ({ status, retries });

test('classify: stable, new failure, failing, fixed, flaky, skipped', () => {
    assert.equal(classify([r('passed'), r('passed')]).cls, 'stable');
    assert.equal(classify([r('passed'), r('failed')]).cls, 'new-failure');
    assert.equal(classify([r('failed')]).cls, 'new-failure');
    const failing = classify([r('passed'), r('failed'), r('failed'), r('failed')]);
    assert.equal(failing.cls, 'failing');
    assert.equal(failing.failingFor, 3);
    assert.equal(classify([r('failed'), r('failed'), r('passed')]).cls, 'fixed');
    // Still fixed some runs later (failed earlier in the window, passes since)
    assert.equal(classify([r('failed'), r('passed'), r('passed'), r('passed')]).cls, 'fixed');
    // Two or more switches: flaky (even when the latest run failed)
    assert.equal(classify([r('passed'), r('failed'), r('passed'), r('failed')]).cls, 'flaky');
    // Passed only after a retry: flaky though every final result passed
    assert.equal(classify([r('passed'), r('passed', 1)]).cls, 'flaky');
    // Skipped runs do not count
    assert.equal(classify([r('passed'), r('skipped'), r('passed')]).cls, 'stable');
    assert.equal(classify([r('skipped')]).cls, 'skipped');
});

test('failure signature: the same cause matches across runs and values', () => {
    const a = failureSignature('Error: Unable to locate element: Save button (id: #save-12) within 4000 ms\n    at Foo (x.ts:1:2)');
    const b = failureSignature('Error: Unable to locate element: Save button (id: #save-98) within 10000 ms');
    assert.equal(a, b);
    assert.equal(failureSignature('Expected status 200 but got 500 at https://api.example.org/orders/42'), failureSignature('Expected status 200 but got 500 at https://api.example.org/orders/7'));
    // A different status is a different cause
    assert.equal(failureSignature('Status validation failed: Expected 200, got 503'), 'Status validation failed: Expected 200, got 503');
    assert.notEqual(failureSignature('Status validation failed: Expected 200, got 503'), failureSignature('Status validation failed: Expected 200, got 500'));
    assert.equal(failureSignature('total is "12.5" in the response, "12.75" expected'), failureSignature('total is "3" in the response, "4" expected'));
    assert.notEqual(failureSignature('Timeout 30000ms exceeded'), failureSignature('Unable to locate element: X'));
    // Colour codes and the call log do not matter
    assert.equal(failureSignature('\u001b[31mTimeout 5000ms exceeded\u001b[0m\nCall log:\n  - waiting'), failureSignature('Timeout 1000ms exceeded'));
});

test('failure category', () => {
    assert.equal(failureCategory('Unable to locate element: Save'), 'element');
    assert.equal(failureCategory('locator.click: Timeout 1000ms exceeded.'), 'timeout');
    assert.equal(failureCategory('Expected status 200 but response status was 500'), 'api');
    assert.equal(failureCategory('Status validation failed: Expected 200, got 503'), 'api');
    assert.equal(failureCategory('Validation failed: 1 difference(s) with the database'), 'database');
    assert.equal(failureCategory("TypeError: Cannot read properties of undefined (reading 'x')"), 'script');
    assert.equal(failureCategory('Undefined step: I do something'), 'step');
    assert.equal(failureCategory('expected "a" to equal "b"'), 'assertion');
    assert.equal(failureCategory('something odd'), 'other');
});

const summary = (scs: Array<{ name: string; status: string; error?: string; retries?: number; feature?: string }>): RunSummary => ({
    total: scs.length, passed: scs.filter((s) => s.status === 'passed').length, failed: scs.filter((s) => s.status === 'failed').length, skipped: 0, duration: 1,
    scenarios: scs.map((s) => ({ feature: s.feature ?? 'Orders', duration: 10, ...s, ...(s.retries !== undefined ? { flaky: s.retries > 0 && s.status === 'passed' } : {}) })), reportDir: '/x', hasHtml: false,
});
const run = (i: number, s: RunSummary, extra: Partial<RunInfo> = {}) => ({ run: { id: `r${i}`, at: `2026-11-0${i}T10:00:00.000Z`, source: 'studio' as const, project: 'shop', env: 'dev', total: s.total, passed: s.passed, failed: s.failed, skipped: 0, flaky: 0, passRate: 0, ...extra }, summary: s });
const catalog: CatalogFeature[] = [{ path: 'test/shop/features/orders.feature', name: 'Orders', tags: [], scenarios: [
    { name: 'Create', line: 3, tags: [], outline: false, examples: 0 },
    { name: 'Cancel', line: 7, tags: ['@quarantine'], outline: false, examples: 0 },
    { name: 'Price for <sku>', line: 11, tags: [], outline: true, examples: 2 },
] }];

test('buildQuality: classes, failure groups, quarantine, outline rows, gate', () => {
    const runs = [
        run(1, summary([{ name: 'Create', status: 'passed' }, { name: 'Cancel', status: 'passed' }, { name: 'Search', status: 'failed', error: 'Unable to locate element: Search box (id: #q1) within 4000 ms' }, { name: 'Price for <sku>_Iteration-1', status: 'passed' }])),
        run(2, summary([{ name: 'Create', status: 'passed' }, { name: 'Cancel', status: 'failed', error: 'Timeout 3000ms exceeded' }, { name: 'Search', status: 'failed', error: 'Unable to locate element: Search box (id: #q2) within 4000 ms' }, { name: 'Price for <sku>_Iteration-1', status: 'passed' }])),
        run(3, summary([{ name: 'Create', status: 'failed', error: 'Unable to locate element: Search box (id: #q3) within 4000 ms' }, { name: 'Cancel', status: 'passed', retries: 1 }, { name: 'Search', status: 'failed', error: 'Unable to locate element: Search box (id: #q4) within 4000 ms' }, { name: 'Price for <sku>_Iteration-1', status: 'passed' }])),
    ];
    const q = buildQuality({ runs, catalog, window: 30, gate: DEFAULT_GATE });
    const by = (n: string) => q.scenarios.find((s) => s.name === n)!;
    assert.equal(by('Create').cls, 'new-failure');
    assert.equal(by('Create').file, 'test/shop/features/orders.feature');
    assert.equal(by('Search').cls, 'failing');
    assert.equal(by('Search').failingFor, 3);
    assert.equal(by('Search').file, undefined);
    assert.equal(by('Cancel').cls, 'flaky');
    assert.equal(by('Cancel').quarantined, true);
    assert.equal(by('Price for <sku>_Iteration-1').line, 11);
    // New failures first
    assert.equal(q.scenarios[0].name, 'Create');
    // One cause, two scenarios, in the latest run
    assert.equal(q.groups[0].category, 'element');
    assert.equal(q.groups[0].scenarios.length, 2);
    assert.equal(q.groups[0].failures, 4);
    assert.equal(q.groups[0].runs, 3);
    assert.equal(q.groups[0].inLatest, true);
    assert.equal(q.counts.quarantined, 1);
    // Gate on the latest run (Cancel quarantined, left out): 1 of 3 passed; Create is a new failure
    assert.equal(q.gate.ok, false);
    assert.match(q.gate.rules[0].detail, /33\.3% \(1 of 3/);
    assert.equal(q.gate.rules[1].ok, false);
    assert.match(q.gate.rules[1].detail, /Create/);
    // Window: only the last run
    const last = buildQuality({ runs, catalog, window: 1, gate: DEFAULT_GATE });
    assert.equal(last.runs.length, 1);
    assert.equal(last.scenarios.find((s) => s.name === 'Search')!.cls, 'new-failure');
    // Gate that passes: nothing failing, flaky allowed
    const ok = buildQuality({ runs: [run(1, summary([{ name: 'Create', status: 'passed' }]))], catalog, window: 30, gate: { ...DEFAULT_GATE, maxFlaky: 0 } });
    assert.equal(ok.gate.ok, true);
    assert.equal(ok.gate.rules.length, 3);
});

test('gate: a run of only some scenarios does not hide another scenario\'s failing latest result', () => {
    const runs = [
        run(1, summary([{ name: 'Create', status: 'passed' }, { name: 'Price for <sku>_Iteration-1', status: 'failed', error: 'expected 12 to equal 13' }])),
        // Only "Create" was chosen for this run.
        run(2, summary([{ name: 'Create', status: 'passed' }])),
    ];
    const q = buildQuality({ runs, catalog, window: 30, gate: DEFAULT_GATE });
    assert.equal(q.gate.ok, false);
    assert.equal(q.gate.run, 'r2');
    assert.equal(q.gate.rules[0].ok, false);
    assert.match(q.gate.rules[0].detail, /^50% \(1 of 2 scenarios, each by its latest result: 1 from the last run, 1 from an earlier run – a failure\)/);
    // A new failure still counts while no later result says otherwise.
    assert.equal(q.gate.rules[1].ok, false);
    assert.match(q.gate.rules[1].detail, /Price for/);
    // Fixed later (by a run of that scenario only): the gate passes, every scenario judged by its latest result.
    const fixed = buildQuality({ runs: [...runs, run(3, summary([{ name: 'Price for <sku>_Iteration-1', status: 'passed' }]))], catalog, window: 30, gate: DEFAULT_GATE });
    assert.equal(fixed.gate.ok, true);
    assert.match(fixed.gate.rules[0].detail, /^100% \(2 of 2 scenarios, each by its latest result: 1 from the last run, 1 from an earlier run\)/);
    // Several from earlier runs, one of them failing.
    const more = buildQuality({ runs: [run(1, summary([{ name: 'Create', status: 'passed' }, { name: 'Search', status: 'passed' }, { name: 'Price for <sku>_Iteration-1', status: 'failed', error: 'x' }])), run(2, summary([{ name: 'Create', status: 'passed' }]))], catalog, window: 30, gate: DEFAULT_GATE });
    assert.match(more.gate.rules[0].detail, /^66\.7% \(2 of 3 scenarios, each by its latest result: 1 from the last run, 2 from earlier runs – 1 failed\)$/);
    // A debug run is not judged: the earlier failure stands.
    const debug = buildQuality({ runs: [...runs, run(3, summary([{ name: 'Price for <sku>_Iteration-1', status: 'passed' }]), { debug: true } as never)], catalog, window: 30, gate: DEFAULT_GATE });
    assert.equal(debug.gate.ok, false);
    assert.equal(debug.gate.run, 'r2');
    // Quarantined scenarios are left out when set.
    const q2 = buildQuality({ runs: [run(1, summary([{ name: 'Cancel', status: 'failed', error: 'x' }, { name: 'Create', status: 'passed' }])), run(2, summary([{ name: 'Create', status: 'passed' }]))], catalog, window: 30, gate: DEFAULT_GATE });
    assert.equal(q2.gate.ok, true);
    assert.match(q2.gate.rules[0].detail, /100% \(1 of 1 scenario, each by its latest result; quarantined left out\)/);
});

test('collectRuns: Studio runs and report folders on disk, without pull request runs or duplicates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-'));
    const write = (dir: string, data: unknown) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); fs.writeFileSync(path.join(root, dir, 'report-data.json'), JSON.stringify(data)); };
    write('reports/test-results-a/reports', { suite: { startTime: '2026-11-02T08:00:00.000Z', scenarios: [{ name: 'Create', feature: 'Orders', status: 'passed', duration: 5 }] } });
    write('reports/test-results-b/reports', { suite: { startTime: '2026-11-03T08:00:00.000Z', scenarios: [{ name: 'Create', feature: 'Orders', status: 'failed', duration: 5, error: 'x' }] } });
    const base: Omit<RunInfo, 'id' | 'summary'> = { request: { project: 'shop', env: 'dev' }, command: [], state: 'failed', startedAt: '2026-11-03T08:00:00.000Z', secretNames: [] };
    const studio: RunInfo[] = [
        { ...base, id: 's1', summary: { ...summary([{ name: 'Create', status: 'failed' }]), reportDir: path.join(root, 'reports/test-results-b/reports') } },
        { ...base, id: 's2', pr: { id: 1, repository: 'r', title: 't', commit: 'c', based: 'merge' }, summary: summary([{ name: 'Create', status: 'passed' }]) },
    ];
    const files = [path.join(root, 'reports/test-results-a/reports/report-data.json'), path.join(root, 'reports/test-results-b/reports/report-data.json')];
    const runs = collectRuns(studio, files, root);
    assert.deepEqual(runs.map((x) => x.run.id), ['report:reports/test-results-a/reports', 's1']);
    assert.equal(runs[0].run.at, '2026-11-02T08:00:00.000Z');
    fs.rmSync(root, { recursive: true, force: true });
});

test('setQuarantineTag: adds to the tag line or a new one, removes, keeps line endings and comments', () => {
    const f = 'Feature: Orders\n\n  @smoke # keep\n  Scenario: Create\n    Given x\n\n  Scenario: Cancel\n    Given y\n';
    const a = setQuarantineTag(f, 4, 'Create', true);
    assert.match(a, /\n {2}@smoke @quarantine # keep\n {2}Scenario: Create/);
    assert.equal(setQuarantineTag(a, 4, 'Create', true), a);
    assert.equal(setQuarantineTag(a, 4, 'Create', false), f);
    const b = setQuarantineTag(f, 7, 'Cancel', true);
    assert.match(b, /\n {2}@quarantine\n {2}Scenario: Cancel/);
    assert.equal(setQuarantineTag(b, 8, 'Cancel', false), f);
    const crlf = f.replace(/\n/g, '\r\n');
    assert.equal(setQuarantineTag(crlf, 7, 'Cancel', true), b.replace(/\n/g, '\r\n'));
    assert.throws(() => setQuarantineTag(f, 4, 'Cancel', true), /no longer on that line/);
});
