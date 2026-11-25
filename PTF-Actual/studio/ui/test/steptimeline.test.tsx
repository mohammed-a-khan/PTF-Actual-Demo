import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTimeline } from '../src/components/StepTimeline';

const at = (s: number) => `[2026-11-23T19:35:${String(50 + Math.floor(s / 1000)).padStart(2, '0')}.${String(s % 1000).padStart(3, '0')}Z]`;
const OUT = [
    `${at(0)} [FEATURE] Starting feature: Shop catalog\n`,
    `${at(10)} [INFO]   Scenario: The catalog answers\n${at(20)} [STEP] Given user is working with "Shop" API\n`,
    `${at(30)} [STEP] When I send a GET request to "/products"\n${at(40)} [PASS] GET request successful: 200`,      // joined without a newline
    `${at(45)} [STEP] And the body should contain "/v1"\n${at(55)} [FAIL] Response validation failed with 1 errors\n${at(55)} [ERROR]   body: Expected body to contain '/v1'\n${at(60)} [FAIL] Test completed: The catalog answers\n`,
    `${at(70)} [INFO] Retrying scenario (attempt 2)...\n${at(80)} [INFO]   Scenario: The catalog answers\n${at(90)} [STEP] Given user is working with "Shop" API\n${at(1090)} [PASS] Test completed: The catalog answers\n`,
    `${at(1100)} [INFO]   Scenario: Search\n${at(1110)} [STEP] Given I search\n`,
];

test('parseTimeline: scenarios, steps with durations, a failed step\'s error, retries, the step running now', () => {
    const t = parseTimeline(OUT.map((text) => ({ text, stream: 'out' as const })), true);
    assert.deepEqual(t.map((s) => [s.name, s.attempt, s.state]), [['The catalog answers', 1, 'failed'], ['The catalog answers', 2, 'passed'], ['Search', 1, 'running']]);
    assert.deepEqual(t[0].steps.map((s) => [s.text, s.state, s.ms]), [['Given user is working with "Shop" API', 'passed', 10], ['When I send a GET request to "/products"', 'passed', 15], ['And the body should contain "/v1"', 'failed', 10]]);
    assert.equal(t[0].steps[2].error, "Response validation failed with 1 errors\nbody: Expected body to contain '/v1'");
    assert.equal(t[0].feature, 'Shop catalog');
    assert.equal(t[1].steps[0].ms, 1000);
    assert.equal(t[2].steps[0].state, 'running');
    // The run ended (stopped): what was still running did not finish.
    const done = parseTimeline([{ text: OUT.join(''), stream: 'out' }], false);
    assert.equal(done[2].state, 'skipped');
    assert.deepEqual(parseTimeline([{ text: 'studio line', stream: 'studio' }]), []);
});

test('a scenario that ran no step is not a pass: failed with the error that stopped it, else "did not run"', () => {
    const t = (s: string) => ({ text: s, stream: 'stdout' as const });
    const out = parseTimeline([
        t('[2026-11-24T10:00:00.000Z] [INFO] Scenario: Cart looks right\n'),
        t('[2026-11-24T10:00:00.100Z] [ERROR] ⚠️ DB_X_PASSWORD could not be decrypted\n'),
        t("[2026-11-24T10:00:00.200Z] [ERROR] Failed to launch browser: Executable doesn't exist\n"),
        t('[2026-11-24T10:00:00.375Z] [INFO] Test execution completed\n'),
        t('[2026-11-24T10:00:01.000Z] [INFO] Scenario: Second\n'),
        t('[2026-11-24T10:00:01.100Z] [FEATURE] Feature completed\n'),
    ]);
    assert.deepEqual(out.map((s) => s.state), ['failed', 'skipped']);
    assert.match(out[0].error ?? '', /Failed to launch browser/);
    assert.doesNotMatch(out[0].error ?? '', /decrypted/);
});
