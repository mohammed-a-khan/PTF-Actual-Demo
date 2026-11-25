/** Runner tests with a stand-in CLI (the real framework run is verified separately, end to end). */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attemptsFromOutput, withRetries, buildArgs, findResults, TestRunner } from '../src/run/runner';

let root: string;
before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-run-'));
    const pkg = path.join(root, 'node_modules/@mdakhan.mak/cs-playwright-test-framework');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '9.9.9', bin: { 'cs-playwright-test': 'dist/index.js' } }));
    // Stand-in CLI: echoes its args and a secret, writes report-data.json like the framework, can hang.
    fs.writeFileSync(path.join(pkg, 'dist/index.js'), `
const fs=require('fs'),path=require('path');
console.log('ARGS ' + process.argv.slice(2).join(' '));
console.log('secret seen: ' + process.env.QA_PW + ' / auto-open: ' + process.env.AUTO_OPEN_REPORT);
if (process.argv.includes('--tags=@hang')) { setInterval(()=>{}, 1000); return; }
if (process.argv.includes('--tags=@utf8')) {
  const buf = Buffer.from('✓ Scenario passed — 日本語\\nfinal line without newline', 'utf8');
  process.stdout.write(buf.subarray(0, 2)); setTimeout(() => { process.stdout.write(buf.subarray(2)); process.exit(1); }, 50); return;
}
if (process.argv.includes('--debug-steps')) {
  // Like the framework's debug controller: a pause line, then wait for a command on stdin.
  const rl = require('readline').createInterface({ input: process.stdin });
  const pauses = [{kind:'before-step',step:'Given I sign in',scenario:'Login',file:'test/a.feature',line:4,reason:'breakpoint'}, {kind:'after-failure',step:'Then I see ' + process.env.QA_PW,error:'Expected welcome\\nmore'}];
  let i = 0; const next = () => { if (i >= pauses.length) { console.log('done'); process.exit(0); } console.log('##cs-debug ' + JSON.stringify(pauses[i++])); };
  rl.on('line', (l) => { console.log('##cs-debug {"resumed":true}'); console.log('got ' + l); if (l === 'stop') process.exit(130); next(); });
  next(); return;
}
if (process.argv.includes('--tags=@noreport')) { console.log('crashed before writing a report'); process.exit(1); }
if (process.argv.includes('--tags=@quiet')) { console.log('nothing to report'); process.exit(0); }
if (process.argv.includes('--tags=@none')) {
  const d=path.join(process.cwd(),'reports','test-results-n','reports'); fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(d,'report-data.json'), JSON.stringify({suite:{duration:1,scenarios:[]}}));
  process.exit(0);
}
if (process.argv.includes('--tags=@multi')) {
  const d=path.join(process.cwd(),'reports','test-results-m','orders','reports'); fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(d,'report-data.json'), JSON.stringify({suite:{duration:5,scenarios:[{name:'deep',feature:'F',status:'passed',duration:5}]}}));
  process.exit(0);
}
const d=path.join(process.cwd(),'reports','test-results-x','reports'); fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(path.join(d,'report-data.json'), JSON.stringify({suite:{name:'s',duration:42,scenarios:[
 {name:'ok',feature:'F',status:'passed',duration:10,steps:[]},
 {name:'bad',feature:'F',status:'failed',duration:20,steps:[{status:'failed',error:'boom ' + (process.env.QA_PW || '')}]}]}}));
fs.writeFileSync(path.join(d,'index.html'),'<h1>report</h1>');
process.exit(0); // the real framework exits 0 even when a scenario failed
`);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('arguments follow the framework CLI and refuse unsafe values', () => {
    assert.deepEqual(buildArgs({ project: 'orders', env: 'qa', features: ['test/a.feature', 'test/b.feature'], tags: '@smoke and not @wip', scenarios: ['Login works'], headless: true, browser: 'chromium', workers: 3 }),
        ['--project=orders', '--env=qa', '--features=test/a.feature,test/b.feature', '--tags=@smoke and not @wip', '--scenarios=Login works', '--headless=true', '--browser=chromium', '--parallel=3']);
    assert.deepEqual(buildArgs({ project: 'orders', env: 'qa', workers: 1 }), ['--project=orders', '--env=qa', '--parallel=false']);
    assert.throws(() => buildArgs({ project: '../x', env: 'qa' }));
    assert.throws(() => buildArgs({ project: 'p', env: 'qa', features: ['--require=evil.js'] }));
    assert.throws(() => buildArgs({ project: 'p', env: 'qa', browser: 'netscape' }));
    assert.throws(() => buildArgs({ project: 'p', env: 'qa', scenarios: ['a,b'] }));
});

test('a run: args, secrets in, secrets masked in output, results from report-data.json even with exit code 0', async () => {
    const runner = new TestRunner(root, path.join(root, '.git/cs-studio/runs.json'));
    const run = runner.start({ project: 'orders', env: 'qa', tags: '@smoke' }, { QA_PW: 'hunter2pw' });
    assert.deepEqual(run.secretNames, ['QA_PW']);
    const done = await new Promise<typeof run>((res) => runner.once(`end:${run.id}`, res));
    const text = runner.log(run.id).map((l) => l.text).join('\n');
    assert.match(text, /ARGS --project=orders --env=qa --tags=@smoke/);
    assert.match(text, /secret seen: •••••• \/ auto-open: false/);
    assert.ok(!text.includes('hunter2pw'));
    assert.equal(done.state, 'failed', 'one scenario failed although the exit code was 0');
    assert.deepEqual([done.summary!.passed, done.summary!.failed, done.summary!.scenarios[1].error], [1, 1, 'boom ••••••'], 'secret masked in stored results');
    assert.ok(!fs.readFileSync(path.join(root, '.git/cs-studio/runs.json'), 'utf8').includes('hunter2pw'), 'never written to the history file');
    assert.ok(runner.reportKey(run.id));
    const again = new TestRunner(root, path.join(root, '.git/cs-studio/runs.json'));
    assert.equal(again.list()[0].id, run.id, 'history survives a restart');
});

test('debug runs: arguments, pauses read from the output, commands written to the run', async () => {
    assert.deepEqual(buildArgs({ project: 'orders', env: 'qa', headless: true, workers: 4, debug: { steps: true, pauseOnFailure: true } }),
        ['--project=orders', '--env=qa', '--headless=false', '--parallel=false', '--debug-steps', '--pause-on-failure']);
    assert.deepEqual(buildArgs({ project: 'orders', env: 'qa', debug: { pauseOnFailure: true } }), ['--project=orders', '--env=qa', '--headless=false', '--parallel=false', '--pause-on-failure']);
    // Nothing to pause on yet is fine: breakpoints can be added while it runs
    assert.deepEqual(buildArgs({ project: 'orders', env: 'qa', debug: {} }), ['--project=orders', '--env=qa', '--headless=false', '--parallel=false']);
    assert.throws(() => buildArgs({ project: 'orders', env: 'qa', debug: { breakpoints: [{ file: '../x.feature', line: 3 }] } }), /Invalid breakpoints/);
    assert.throws(() => buildArgs({ project: 'orders', env: 'qa', debug: { breakpoints: [{ file: 'a.feature', line: 0 }] } }), /Invalid breakpoints/);
    assert.throws(() => buildArgs({ project: 'orders', env: 'qa', debug: { steps: true, slowMo: 99999 } }), /Slow motion/);
    const runner = new TestRunner(root, path.join(root, '.git/cs-studio/runs-dbg.json'));
    const paused = () => new Promise<void>((res) => { const h = (p: unknown) => { if (p) { runner.off(`debug:${run.id}`, h); res(); } }; runner.on(`debug:${run.id}`, h); });
    const run = runner.start({ project: 'orders', env: 'qa', debug: { steps: true, pauseOnFailure: true } }, { QA_PW: 'hunter2pw' });
    await paused();
    assert.deepEqual(runner.get(run.id)!.paused, { kind: 'before-step', step: 'Given I sign in', scenario: 'Login', file: 'test/a.feature', line: 4, reason: 'breakpoint' });
    const second = paused();
    runner.debugCommand(run.id, 'next');
    await second;
    const p2 = runner.get(run.id)!.paused!;
    assert.equal(p2.kind, 'after-failure');
    assert.equal(p2.step, 'Then I see ••••••', 'secrets masked in pauses');
    assert.equal(p2.error, 'Expected welcome\nmore');
    await assert.rejects(runner.debugStepInto(run.id), /not paused before a step/, 'into a step only before one');
    const done = new Promise<void>((res) => runner.once(`end:${run.id}`, () => res()));
    runner.debugCommand(run.id, 'stop');
    await done;
    const log = runner.log(run.id).map((l) => l.text).join('\n');
    assert.match(log, /got next\ngot stop/);
    assert.doesNotMatch(log, /##cs-debug/, 'pause lines are kept out of the output');
    assert.equal(runner.get(run.id)!.paused, null);
    assert.throws(() => runner.debugCommand(run.id, 'next'), /not running/);
});

test('stop ends the process tree; only one run at a time', async () => {
    const runner = new TestRunner(root, path.join(root, '.git/cs-studio/runs2.json'));
    const run = runner.start({ project: 'orders', env: 'qa', tags: '@hang' }, {});
    assert.throws(() => runner.start({ project: 'orders', env: 'qa' }, {}), /already in progress/);
    await new Promise((r) => setTimeout(r, 300));
    runner.stop(run.id);
    const done = await new Promise<typeof run>((res) => runner.once(`end:${run.id}`, res));
    assert.equal(done.state, 'stopped');
});

test('results of multi-project runs (consolidated-data.json)', () => {
    const d = path.join(root, 'reports', 'test-results-multi');
    fs.mkdirSync(d, { recursive: true });
    const since = Date.now() - 1;
    fs.writeFileSync(path.join(d, 'consolidated-data.json'), JSON.stringify({ projects: [{ name: 'a', scenarios: [{ name: 'x', status: 'passed', duration: 1.5 }] }, { name: 'b', scenarios: [{ name: 'y', status: 'failed', error: 'e', duration: 2 }] }] }));
    const r = findResults(root, since)!;
    assert.deepEqual([r.total, r.passed, r.failed, r.scenarios[1].error, r.duration], [2, 1, 1, 'e', 3500], 'consolidated durations are seconds');
});

test('output: characters split between chunks, last line without newline', async () => {
    const runner = new TestRunner(root, path.join(root, '.git/cs-studio/runs3.json'));
    const run = runner.start({ project: 'orders', env: 'qa', tags: '@utf8' }, {});
    await new Promise((res) => runner.once(`end:${run.id}`, res));
    const text = runner.log(run.id).map((l) => l.text);
    assert.ok(text.includes('✓ Scenario passed — 日本語'), JSON.stringify(text));
    assert.ok(text.includes('final line without newline'));
});

test('exit code 0 is not a pass when no scenario ran (filters matched nothing, or no report)', async () => {
    const runner = new TestRunner(root, path.join(root, '.git/cs-studio/runs-none.json'));
    for (const [tags, why] of [['@none', /^No scenario ran: the chosen features, tags or scenarios matched nothing\.$/], ['@quiet', /^The run ended without results: the framework's report was not found\.$/]] as const) {
        const run = runner.start({ project: 'orders', env: 'qa', tags }, {});
        const done = await new Promise<typeof run>((res) => runner.once(`end:${run.id}`, res));
        assert.equal(done.exitCode, 0);
        assert.equal(done.state, 'error', tags);
        assert.match(done.message ?? '', why);
    }
});

test("a run that writes no report does not show an older run's results", async () => {
    const runner = new TestRunner(root, path.join(root, '.git/cs-studio/runs4.json'));
    const run = runner.start({ project: 'orders', env: 'qa', tags: '@noreport' }, {});
    const done = await new Promise<typeof run>((res) => runner.once(`end:${run.id}`, res));
    assert.equal(done.summary, undefined);
    assert.equal(done.state, 'failed');
});

test('results in per-project folders are found', async () => {
    const runner = new TestRunner(root, path.join(root, '.git/cs-studio/runs5.json'));
    const run = runner.start({ project: 'orders', env: 'qa', tags: '@multi' }, {});
    const done = await new Promise<typeof run>((res) => runner.once(`end:${run.id}`, res));
    assert.equal(done.summary?.scenarios[0].name, 'deep');
});

test('history entries with report folders outside the repository are ignored', () => {
    const f = path.join(root, '.git/cs-studio/runs6.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'x', request: {}, command: [], state: 'passed', startedAt: new Date().toISOString(), secretNames: [], summary: { reportDir: '/', hasHtml: true, scenarios: [] } }]));
    const r = new TestRunner(root, f);
    assert.equal(r.get('x')!.summary, undefined);
    assert.equal(r.reportKey('x'), undefined);
});

test('retries: from the framework report when it has them, else from the run output; scenarios the report left out', () => {
    // Output of a real run on framework 1.54 (RETRY_COUNT=2): "Fails once then passes" is not in its report.
    const lines = [
        '\x1b[31m[2026-11-21T16:34:22.796Z] [FAIL] Test completed: Fails once then passes\x1b[0m',
        '\x1b[36m[2026-11-21T16:34:22.798Z] [INFO] Retrying scenario (attempt 2)...\x1b[0m',
        '\x1b[32m[2026-11-21T16:34:22.810Z] [PASS] Test completed: Fails once then passes\x1b[0m',
        '\x1b[32m[2026-11-21T16:34:22.897Z] [PASS] Test completed: Always passes\x1b[0m',
        '\x1b[31m[2026-11-21T16:34:23.000Z] [FAIL] Test completed: Always fails\x1b[0m',
        '\x1b[36m[2026-11-21T16:34:23.001Z] [INFO] Retrying scenario (attempt 2)...\x1b[0m',
        '\x1b[31m[2026-11-21T16:34:23.100Z] [FAIL] Test completed: Always fails\x1b[0m',
        '\x1b[36m[2026-11-21T16:34:23.101Z] [INFO] Retrying scenario (attempt 1)...\x1b[0m',
        '\x1b[31m[2026-11-21T16:34:23.200Z] [FAIL] Test completed: Always fails\x1b[0m',
    ];
    assert.deepEqual([...attemptsFromOutput(lines)], [['Fails once then passes', { retries: 1, status: 'passed' }], ['Always passes', { retries: 0, status: 'passed' }], ['Always fails', { retries: 2, status: 'failed' }]]);
    const base = { total: 2, passed: 1, failed: 1, skipped: 0, duration: 1, reportDir: 'r', hasHtml: true };
    const old = withRetries({ ...base, scenarios: [{ name: 'Always passes', feature: 'F', status: 'passed', duration: 1 }, { name: 'Always fails', feature: 'F', status: 'failed', duration: 1 }] }, lines);
    assert.deepEqual(old.scenarios.map((s) => [s.name, s.retries, s.flaky]), [['Always passes', 0, false], ['Always fails', 2, false]]);
    assert.deepEqual(old.missing, [{ name: 'Fails once then passes', status: 'passed', retries: 1 }]);
    assert.equal(old.flaky, 0);
    // A framework that records retries: the report's values are used.
    const now = withRetries({ ...base, total: 3, passed: 2, scenarios: [{ name: 'Fails once then passes', feature: 'F', status: 'passed', duration: 1, retries: 1, flaky: true }, { name: 'Always passes', feature: 'F', status: 'passed', duration: 1, retries: 0, flaky: false }, { name: 'Always fails', feature: 'F', status: 'failed', duration: 1, retries: 2, flaky: false }] }, lines);
    assert.equal(now.flaky, 1);
    assert.equal(now.missing, undefined);
});

test('an older framework (no --scenarios): one chosen scenario runs with --scenario, several are refused', async () => {
    const { buildArgs } = await import('../src/run/runner');
    assert.ok(buildArgs({ project: 'p', env: 'qa', scenarios: ['A'] }, { scenariosFlag: false }).includes('--scenario=A'));
    assert.throws(() => buildArgs({ project: 'p', env: 'qa', scenarios: ['A', 'B'] }, { scenariosFlag: false }), /one chosen scenario at a time/);
    assert.ok(buildArgs({ project: 'p', env: 'qa', scenarios: ['A', 'B'] }).includes('--scenarios=A,B'));
});

test('a feature the framework cannot parse is flagged (editor problems and the run catalog), with the framework\'s own parser', async () => {
    const { gherkinProblems, gherkinFor } = await import('../src/lang/gherkin');
    const g = gherkinFor(process.env.CS_STUDIO_FRAMEWORK_DIR ?? process.cwd());
    if (!g) return; // the parser comes with the framework
    const bad = 'Feature: F\n  Scenario: S\n    Given a step\n    This line is not gherkin\n';
    const p = gherkinProblems(bad, g);
    assert.equal(p[0]?.line, 4);
    assert.match(p[0].message, /left out of the run: "This line is not gherkin" is not Gherkin here/);
    assert.deepEqual(gherkinProblems('@DataProvider(source="a b.xlsx", type="excel")\nFeature: F\n  Scenario Outline: S\n    Given a <x>\n', g), []);
    assert.deepEqual(gherkinProblems('Feature: F\n  Scenario: S\n    """\n    a doc\n    """\n    Given a step\n', g), []);
});
