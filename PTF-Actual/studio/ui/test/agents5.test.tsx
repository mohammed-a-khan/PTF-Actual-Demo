import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import './support/browser-stub';
import { wholeNumberProblem } from '../src/components/WholeNumber';
import { serverNameProblem } from '../src/components/ToolServers';
import { count } from '../src/pages/Knowledge';
import { runModel } from '../src/components/AgentEvals';

test('whole-number fields: 1.5, -1 and letters are said, not dropped (1.5 never becomes 15); out of range is said', () => {
    assert.equal(wholeNumberProblem('', 'Minutes', 5, 480), null);
    assert.equal(wholeNumberProblem('15', 'Minutes', 5, 480), null);
    assert.match(wholeNumberProblem('1.5', 'Minutes', 5, 480)!, /Minutes: no decimals/);
    assert.match(wholeNumberProblem('2.0', 'Minutes', 5, 480)!, /no decimals/);
    assert.match(wholeNumberProblem('-1', 'Attempts', 1, 10)!, /no negative numbers/);
    assert.match(wholeNumberProblem('abc', 'Attempts', 1, 10)!, /numbers only/);
    assert.match(wholeNumberProblem('600', 'Minutes', 5, 480)!, /from 5 to 480 \(not 600\)/);
});

test('tool server names: checked in the dialog (at most 40, the server\'s rule)', () => {
    assert.equal(serverNameProblem('my-server'), null);
    assert.match(serverNameProblem('a'.repeat(200))!, /at most 40 characters \(it has 200\)/);
    assert.match(serverNameProblem('Bad Name')!, /lower-case letters/);
    assert.match(serverNameProblem('')!, /give the server a name/);
});

test('knowledge counts and the evaluation model column', () => {
    assert.equal(count(1, 'document'), '1 document');
    assert.equal(count(3, 'passage'), '3 passages');
    assert.equal(runModel({ subject: { tools: [] }, models: ['mock-1'] } as never), 'mock-1');
    assert.equal(runModel({ subject: { tools: [], model: 'gpt-x' } } as never), 'gpt-x');
    assert.equal(runModel({ subject: { tools: [] } } as never), 'not recorded');
});
