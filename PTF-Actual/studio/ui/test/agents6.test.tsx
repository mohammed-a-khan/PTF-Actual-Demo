import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { agentIdProblem, cronProblem, instructionsProblem } from '../src/agents-checks';

test('Agent builder checks as you type: the server\'s id, instructions and cron rules', () => {
    assert.equal(agentIdProblem('qa-mission', { reserved: ['fix-failing'], existing: ['catalog-reviewer'] }), null);
    assert.match(agentIdProblem('fix-failing', { reserved: ['fix-failing'] })!, /built-in mission/);
    assert.match(agentIdProblem('catalog-reviewer', { existing: ['catalog-reviewer'] })!, /An agent "catalog-reviewer" exists/);
    assert.match(agentIdProblem('')!, /Give the agent an id/);
    assert.match(agentIdProblem('a')!, /At least 2/);
    assert.match(agentIdProblem('-x')!, /Lower-case letters/);
    assert.match(agentIdProblem('x'.repeat(41))!, /At most 40/);
    assert.match(instructionsProblem('   ')!, /Write how it works/);
    assert.match(instructionsProblem('too short')!, /At least 20 characters \(now 9\)/);
    assert.equal(instructionsProblem('Review the catalog tests and cite the guide.'), null);
    assert.equal(cronProblem('0 2 * * 1-5'), null);
    assert.equal(cronProblem('*/15 8-18 * * 1,3,5'), null);
    assert.match(cronProblem('not a cron')!, /3 fields, not 5/);
    assert.match(cronProblem('61 2 * * *')!, /Not a schedule: minute 0-59/);
    assert.match(cronProblem('')!, /Give the schedule/);
});
