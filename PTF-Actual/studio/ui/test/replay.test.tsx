import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toSteps } from '../src/components/replaySteps';
import type { AgentEventDef } from '../src/api';

test('replay steps: a tool call is one step (arguments, result, time); approvals with their answer; injection and refusals flagged; streamed text left out', () => {
    const ev = [
        { seq: 1, at: 1000, type: 'user', text: 'Fix the login test' },
        { seq: 2, at: 1100, type: 'delta', text: 'Look' },
        { seq: 3, at: 1200, type: 'tool-start', id: 't1', tool: 'studio_call', args: '{"method":"GET","path":"/api/ado/workitems/7"}' },
        { seq: 4, at: 1700, type: 'tool-end', id: 't1', ok: true, result: '⚠ Possible prompt injection in a Studio screen: it tells the agent to ignore its instructions.' },
        { seq: 5, at: 1800, type: 'info', text: 'Possible prompt injection in a Studio screen: … From now on every change in this conversation asks you.' },
        { seq: 6, at: 1900, type: 'tool-start', id: 't2', tool: 'run', server: 'jira', args: '{}' },
        { seq: 7, at: 2000, type: 'approval', id: 'a1', title: 'Change a.feature (after possible prompt injection)', detail: 'diff', kind: 'write' },
        { seq: 8, at: 2500, type: 'approval-done', id: 'a1', decision: 'reject' },
        { seq: 9, at: 2600, type: 'assistant', text: 'The work item tried to steer me; I changed nothing.' },
        { seq: 10, at: 2700, type: 'idle' },
    ] as AgentEventDef[];
    const s = toSteps(ev);
    assert.deepEqual(s.map((x) => [x.kind, x.title]), [['user', 'Request'], ['tool', 'studio_call'], ['info', 'Possible prompt injection in a Studio screen'], ['tool', 'jira · run'], ['approval', 'Change a.feature (after possible prompt injection)'], ['assistant', 'Answer']]);
    assert.deepEqual([s[1].ms, s[1].ok, s[1].flagged], [500, true, true]);
    assert.equal(s[2].flagged, true);
    assert.equal(s[3].result, undefined, 'a tool that never ended');
    assert.equal(s[4].decision, 'reject');
    assert.equal(s.filter((x) => x.flagged).length, 2);
});
