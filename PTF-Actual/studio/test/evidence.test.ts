import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectPlaywrightCli, readEvidence, resultsRootOf, timeFromName } from '../src/run/evidence';

/** A results folder shaped exactly like a real framework 1.54.0 run (see evidence.ts). */
export function fakeRun(repo: string): string {
    const root = path.join(repo, 'reports', 'test-results-2026-11-19_08-30-43');
    const w = (f: string, data: string | Buffer = 'x') => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), data); };
    const shot = 'step-failure-Then-the-heading-is--Goodbye--2026-11-19T08-30-45-180Z.png';
    for (const t of ['44-797', '44-994', '45-180']) w(`screenshots/step-failure-Then-the-heading-is--Goodbye--2026-11-19T08-30-${t}Z.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    for (const t of ['45-229', '45-270', '45-290']) w(`traces/trace-2026-11-19T08-30-${t}Z.zip`, 'PK');
    w('console-logs/console-logs-2026-11-19T08-30-47.txt', 'log');
    w('reports/index.html', '<img src="../screenshots/' + shot + '">');
    w('reports/report-data.json', JSON.stringify({
        suite: { name: 'x', scenarios: [
            { name: 'Heading passes', status: 'passed', feature: 'Web evidence', tags: [], duration: 1029, startTime: '2026-11-19T08:30:43.498Z', endTime: '2026-11-19T08:30:44.527Z',
                steps: [{ name: 'Given I open a page saying "Hello"', status: 'passed' }] },
            { name: 'Heading fails', status: 'failed', feature: 'Web evidence', tags: [], duration: 164, startTime: '2026-11-19T08:30:45.064Z', endTime: '2026-11-19T08:30:45.228Z',
                steps: [{ name: 'Given I open a page saying "Hello"', status: 'passed' },
                    { name: 'Then the heading is "Goodbye"', status: 'failed', error: 'heading is "Hello", expected "Goodbye"', screenshot: shot }] },
        ] },
        artifacts: {
            screenshots: [{ name: shot, path: `../screenshots/${shot}`, size: 4 }],
            videos: [],
            traces: ['45-229', '45-270', '45-290'].map((t) => ({ name: `trace-2026-11-19T08-30-${t}Z.zip`, path: `../traces/trace-2026-11-19T08-30-${t}Z.zip`, size: 2 })),
            consoleLogs: [{ name: 'console-logs-2026-11-19T08-30-47.txt', path: '../console-logs/console-logs-2026-11-19T08-30-47.txt', size: 3 }],
            har: [],
        },
    }));
    return path.join(root, 'reports');
}

test('evidence: failed step screenshot by name, traces by time, run files, report served from the results folder', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ev-'));
    const reportDir = fakeRun(repo);
    assert.equal(resultsRootOf(reportDir), path.dirname(reportDir));
    assert.equal(timeFromName('trace-2026-11-19T08-30-45-229Z.zip'), Date.parse('2026-11-19T08:30:45.229Z'));
    const ev = readEvidence(repo, reportDir);
    assert.equal(ev.resultsRoot, 'reports/test-results-2026-11-19_08-30-43');
    assert.equal(ev.reportIndex, 'reports/index.html');
    const [pass, fail] = ev.scenarios;
    assert.equal(pass.files.length, 0);
    assert.equal(pass.failedStep, undefined);
    assert.equal(fail.failedStep?.name, 'Then the heading is "Goodbye"');
    assert.equal(fail.failedStep?.screenshot?.file, 'screenshots/step-failure-Then-the-heading-is--Goodbye--2026-11-19T08-30-45-180Z.png');
    assert.deepEqual(fail.files.map((f) => f.file), ['traces/trace-2026-11-19T08-30-45-229Z.zip', 'traces/trace-2026-11-19T08-30-45-270Z.zip', 'traces/trace-2026-11-19T08-30-45-290Z.zip']);
    assert.equal(fail.matchedByTime, true);
    assert.ok(ev.run.some((f) => f.kind === 'console'));
    // Paths in the report cannot point outside the results folder.
    const data = JSON.parse(fs.readFileSync(path.join(reportDir, 'report-data.json'), 'utf8'));
    fs.writeFileSync(path.join(repo, 'secret.txt'), 's');
    data.suite.scenarios[1].steps[1].screenshot = '../../../secret.txt';
    data.artifacts.videos = [{ path: '../../../secret.txt' }, '/etc/passwd'];
    fs.writeFileSync(path.join(reportDir, 'report-data.json'), JSON.stringify(data));
    const ev2 = readEvidence(repo, reportDir);
    assert.equal(ev2.scenarios[1].failedStep?.screenshot, undefined);
    assert.ok(!ev2.run.some((f) => f.name === 'secret.txt' || f.name === 'passwd'));
    fs.rmSync(repo, { recursive: true, force: true });
});

test("the project's own Playwright CLI is found only inside the project", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pw-'));
    assert.equal(projectPlaywrightCli(repo), null);
    const cli = path.join(repo, 'node_modules', '@playwright', 'test', 'node_modules', 'playwright-core', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '');
    assert.equal(projectPlaywrightCli(repo), cli);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('steps and actions as the framework records them; steps after a failure are shown as not run', async () => {
    const { groupActions, indexFeatures, readEvidence } = await import('../src/run/evidence');
    // Exactly as in a real 1.54.0 report (CSWebElement logs "Executing …" then "… successful … (Nms)").
    const acts = groupActions([
        { name: 'ℹ Login form is shown', status: 'passed' },
        { name: 'ℹ Executing Fill with "qa.user" on User name field', status: 'passed' },
        { name: '✓ Fill with "qa.user" successful on User name field (388ms)', status: 'passed' },
        { name: 'ℹ Executing Click on Sign in button', status: 'passed' },
        { name: '⚠ Click failed on attempt 1/3: element is not visible', status: 'passed' },
        { name: '✓ Signed in as qa.user', status: 'passed' },
        { name: '✗ Something broke', status: 'failed' },
    ]);
    assert.deepEqual(acts.map((a) => [a.kind, a.text, a.durationMs]), [
        ['info', 'Login form is shown', undefined],
        ['pass', 'Fill with "qa.user" on User name field', 388],
        ['info', 'Click on Sign in button', undefined],
        ['warn', 'Click failed on attempt 1/3: element is not visible', undefined],
        ['pass', 'Signed in as qa.user', undefined],
        ['fail', 'Something broke', undefined],
    ]);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ev2-'));
    const reportDir = fakeRun(repo);
    fs.mkdirSync(path.join(repo, 'test/web/features'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'test/web/features/web.feature'), [
        'Feature: Web evidence', '  Background:', '    Given I open a page saying "Hello"',
        '  Scenario: Heading fails', '    Then the heading is "Goodbye"', '    And the footer is shown', '',
        '  Scenario: Heading passes', '    Then the heading is "Hello"'].join('\n'));
    const ev = readEvidence(repo, reportDir, { features: indexFeatures(repo) });
    const fail = ev.scenarios[1];
    assert.deepEqual(fail.location, { file: 'test/web/features/web.feature', line: 4 });
    assert.deepEqual(fail.steps.map((s) => [s.text, s.status]), [
        ['Given I open a page saying "Hello"', 'passed'], ['Then the heading is "Goodbye"', 'failed'], ['And the footer is shown', 'not run']]);
    assert.ok(fail.steps[1].screenshot);
    // A different shape (steps that do not match the file) adds nothing.
    fs.writeFileSync(path.join(repo, 'test/web/features/web.feature'), 'Feature: Web evidence\n  Scenario: Heading fails\n    Given something else\n    Then more\n    And more\n');
    const ev2 = readEvidence(repo, reportDir, { features: indexFeatures(repo) });
    assert.equal(ev2.scenarios[1].steps.length, 2);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('Playwright for the Trace Viewer is also found inside the framework package (npm nesting)', async () => {
    const { projectPlaywrightCli } = await import('../src/run/evidence');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pw-'));
    const pkg = path.join(root, 'node_modules/@mdakhan.mak/cs-playwright-test-framework');
    fs.mkdirSync(path.join(pkg, 'node_modules/playwright-core'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'node_modules/playwright-core/cli.js'), '');
    assert.equal(projectPlaywrightCli(root), path.join(pkg, 'node_modules/playwright-core/cli.js'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('a scenario in same-named feature copies is located by the files the run was given', async () => {
    const { locateScenario } = await import('../src/run/evidence');
    const index = { byFeature: new Map([['Test Failure', [
        { name: 'Test with deliberate failure', file: 'test/akhan/features/test-deliberate-fail.feature', line: 6, outline: false, steps: [] },
        { name: 'Test with deliberate failure', file: 'test/orangehrm/features/test-deliberate-fail.feature', line: 4, outline: false, steps: [] },
    ]]]) } as never;
    assert.equal(locateScenario(index, 'Test Failure', 'Test with deliberate failure'), null, 'ambiguous without the run files');
    assert.equal(locateScenario(index, 'Test Failure', 'Test with deliberate failure', ['test/akhan/features/test-deliberate-fail.feature'])!.line, 6);
    assert.equal(locateScenario(index, 'Test Failure', 'Test with deliberate failure', ['./test/orangehrm'])!.file, 'test/orangehrm/features/test-deliberate-fail.feature');
});

test('evidence: a video (no time in its name) goes with the scenario that ran when it was written', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ev-'));
    const reportDir = fakeRun(repo);
    const root = path.dirname(reportDir);
    fs.mkdirSync(path.join(root, 'videos'));
    const vid = path.join(root, 'videos', 'page@0123abcd.webm');
    fs.writeFileSync(vid, 'webm');
    const at = (iso: string) => { const t = new Date(iso); fs.utimesSync(vid, t, t); };
    at('2026-11-19T08:30:45.300Z'); // written as the failing scenario's page closed
    let ev = readEvidence(repo, reportDir);
    assert.deepEqual(ev.scenarios[1].files.filter((f) => f.kind === 'video').map((f) => f.file), ['videos/page@0123abcd.webm']);
    assert.equal(ev.scenarios[0].files.some((f) => f.kind === 'video'), false);
    at('2026-11-19T08:30:44.600Z'); // during the first (passed) scenario: its video, not the failing one's
    ev = readEvidence(repo, reportDir);
    assert.equal(ev.scenarios[0].files.some((f) => f.kind === 'video'), true);
    assert.equal(ev.scenarios[1].files.some((f) => f.kind === 'video'), false);
});

test("a node_modules linked outside the project (pnpm, a shared install) is used when it really is Playwright's CLI", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pw-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pw-store-'));
    fs.mkdirSync(path.join(store, 'playwright-core'), { recursive: true });
    fs.writeFileSync(path.join(store, 'playwright-core', 'cli.js'), '');
    fs.writeFileSync(path.join(store, 'playwright-core', 'package.json'), JSON.stringify({ name: 'playwright-core' }));
    fs.symlinkSync(store, path.join(repo, 'node_modules'));
    assert.equal(projectPlaywrightCli(repo), path.join(repo, 'node_modules', 'playwright-core', 'cli.js'));
    // Something else named cli.js behind the link is not run.
    fs.writeFileSync(path.join(store, 'playwright-core', 'package.json'), JSON.stringify({ name: 'not-playwright' }));
    assert.equal(projectPlaywrightCli(repo), null);
    fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true });
});
