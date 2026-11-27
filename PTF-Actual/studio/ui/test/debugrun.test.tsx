import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { debugPlan, envFor, targetForProject } from '../src/runChoice';
import { commandFor, debugActionOf, handleDebugKey, registerDebugKeys } from '../src/debugKeys';

test('Run tests: another project keeps the options, resets the environment only when the new project lacks it', () => {
    const t = { project: 'weblab', env: 'qa', browser: 'firefox', workers: 3, headless: false };
    const a = targetForProject(t, 'storelab', ['dev', 'uat']);
    assert.equal(a.changed, true, 'the choice of features / tags / scenarios is cleared');
    assert.deepEqual(a.target, { project: 'storelab', env: 'dev', browser: 'firefox', workers: 3, headless: false });
    const b = targetForProject(t, 'other', ['dev', 'qa']);
    assert.equal(b.target.env, 'qa', 'kept: the new project has it');
    assert.equal(targetForProject(t, 'none', []).target.env, 'qa', 'no environments listed: kept');
    assert.equal(targetForProject(t, 'weblab', ['qa']).changed, false, 'the same project: the choice stays');
    assert.equal(envFor('qa', ['dev']), 'dev');
    assert.equal(envFor('qa', ['qa', 'dev']), null);
    assert.equal(envFor('qa', []), null);
});

test('Debug dialog: breakpoints alone can start a debug run; nothing to pause it: disabled, with the reason', () => {
    const bps = [
        { file: 'test/weblab/steps/shop.steps.ts', line: 20 },
        { file: 'test/weblab/steps/text.ts', line: 3 },
        { file: 'test/weblab/features/shop.feature', line: 5 },
        { file: 'test/other/features/x.feature', line: 2 },
    ];
    const none = { steps: false, pauseOnFailure: false };
    const p = debugPlan(bps, ['test/weblab/features/shop.feature'], none);
    assert.equal(p.startable, true);
    assert.equal(p.breakpoints.length, 3, 'a feature file that does not run cannot pause it');
    assert.equal(p.files, 3);
    assert.match(p.reason, /^3 breakpoints in 3 files will pause the run$/);
    const one = debugPlan([bps[0]], [], none);
    assert.match(one.reason, /^1 breakpoint in 1 file will pause the run$/);
    const nothing = debugPlan([bps[3]], ['test/weblab/features/shop.feature'], none);
    assert.equal(nothing.startable, false);
    assert.match(nothing.reason, /Nothing would pause the run.*1 in feature files that do not run/);
    assert.equal(debugPlan([], [], none).startable, false);
    assert.equal(debugPlan([], [], { steps: true, pauseOnFailure: false }).startable, true);
    assert.equal(debugPlan([], [], { steps: false, pauseOnFailure: true }).startable, true);
    assert.equal(debugPlan([{ file: 'Test/Steps/A.JS', line: 1 }], [], none).startable, true, 'JavaScript too, any letter case');
});

test('debugger keys: F5 / F10 / F11 / Shift+F11 / Shift+F5, and the commands at a code or a step pause', () => {
    assert.equal(debugActionOf({ key: 'F5' }), 'continue');
    assert.equal(debugActionOf({ key: 'F5', shiftKey: true }), 'stop');
    assert.equal(debugActionOf({ key: 'F10' }), 'over');
    assert.equal(debugActionOf({ key: 'F11' }), 'into');
    assert.equal(debugActionOf({ key: 'F11', shiftKey: true }), 'out');
    assert.equal(debugActionOf({ key: 'F5', ctrlKey: true }), null, 'Ctrl+F5: the browser\'s');
    assert.equal(debugActionOf({ key: 'a' }), null);
    assert.equal(commandFor('over', 'code'), 'stepOver');
    assert.equal(commandFor('into', 'code'), 'stepInto');
    assert.equal(commandFor('out', 'code'), 'stepOut');
    assert.equal(commandFor('continue', 'code'), 'resume');
    assert.equal(commandFor('over', 'step', 'before-step'), 'next');
    assert.equal(commandFor('into', 'step', 'before-step'), 'into', 'into the step definition\'s code');
    assert.equal(commandFor('into', 'step', 'after-failure'), null);
    assert.equal(commandFor('continue', 'step', 'before-step'), 'continue');
    assert.equal(commandFor('out', 'step', 'before-step'), null);
});

test('debugger keys go to the newest screen that takes them, once per press, and only while one does', () => {
    const got: string[] = [];
    let paused = false;
    const off1 = registerDebugKeys((a) => { got.push(`runs:${a}`); return true; });
    const off2 = registerDebugKeys((a) => { if (!paused) return false; got.push(`code:${a}`); return true; });
    let prevented = 0;
    const ev = { key: 'F10', preventDefault: () => { prevented++; } };
    assert.equal(handleDebugKey(ev), true);
    assert.deepEqual(got, ['runs:over'], 'the Code screen is not paused: the next one takes it');
    paused = true;
    assert.equal(handleDebugKey(ev), true, 'the same press handed over again (the shell\'s event)');
    assert.deepEqual(got, ['runs:over'], 'not twice');
    handleDebugKey({ key: 'F11', shiftKey: true, preventDefault: () => { prevented++; } });
    assert.deepEqual(got, ['runs:over', 'code:out']);
    assert.equal(prevented, 2, 'F5 never reloads the page while a debug run takes it');
    handleDebugKey({ key: 'F10', repeat: true });
    assert.equal(got.length, 2, 'a key held down: one step');
    off1(); off2();
    const f5 = { key: 'F5', preventDefault: () => { prevented++; } };
    assert.equal(handleDebugKey(f5), false, 'no debug run: the key is left alone');
    assert.equal(prevented, 2);
});

test('Run again / Rerun failed: the mode is chosen each time; "Run again" after a rerun can go back to what the first run ran', async () => {
    const { inMode, originOf } = await import('../src/runChoice');
    const dbg = { project: 'p', env: 'qa', features: ['a.feature'], scenarios: ['x'], debug: { steps: true, pauseOnFailure: true, breakpoints: [] } };
    assert.deepEqual(inMode(dbg, { mode: 'run', steps: true, pauseOnFailure: true }), { project: 'p', env: 'qa', features: ['a.feature'], scenarios: ['x'] }, 'a debug run run again as a plain run: no debug settings left');
    assert.deepEqual(inMode({ project: 'p', env: 'qa' } as { project: string; env: string; debug?: unknown }, { mode: 'debug', steps: false, pauseOnFailure: true }), { project: 'p', env: 'qa', debug: { steps: false, pauseOnFailure: true } });
    const runs = [
        { id: 'c', request: { rerunOf: 'b' } }, { id: 'b', request: { rerunOf: 'a' } }, { id: 'a', request: {} }, { id: 'z', request: { rerunOf: 'gone' } },
    ];
    assert.equal(originOf(runs[0], runs)?.id, 'a', 'a rerun of a rerun: the first run');
    assert.equal(originOf(runs[2], runs), null, 'not a rerun');
    assert.equal(originOf(runs[3], runs), null, 'its first run is no longer listed');
});
