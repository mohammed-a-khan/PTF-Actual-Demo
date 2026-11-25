import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildWhere, nodeToPath, ItemType } from '../src/ado/boards';

const types: ItemType[] = [
    { name: 'Bug', states: [{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Resolved', category: 'Resolved' }, { name: 'Closed', category: 'Completed' }] },
    { name: 'Test Case', states: [{ name: 'Design', category: 'Proposed' }, { name: 'Ready', category: 'InProgress' }, { name: 'Closed', category: 'Completed' }] },
    { name: 'Task', states: [{ name: 'New', category: 'Proposed' }, { name: 'Closed', category: 'Completed' }, { name: 'Removed', category: 'Removed' }] },
];

test('classification node paths become area paths', () => {
    assert.equal(nodeToPath('\\myproject\\Area'), 'myproject');
    assert.equal(nodeToPath('\\myproject\\Area\\Payments\\Cards'), 'myproject\\Payments\\Cards');
});

test('default filter: visible types, open states per type', () => {
    const w = buildWhere({}, { types });
    assert.match(w, /\[System\.WorkItemType\] IN \('Bug', 'Test Case', 'Task'\)/);
    // Resolved counts as open (only Completed / Removed are done); per type.
    assert.match(w, /\(\[System\.WorkItemType\] = 'Bug' AND \[System\.State\] IN \('New', 'Active', 'Resolved'\)\)/);
    assert.match(w, /\(\[System\.WorkItemType\] = 'Task' AND \[System\.State\] IN \('New'\)\)/);
    assert.doesNotMatch(w, /AssignedTo|AreaPath|IterationPath/);
});

test('team: its areas (with or without sub-areas) and its current sprint', () => {
    const w = buildWhere({ team: 'Payments Team', sprint: 'current' }, { types, teamAreas: [{ path: 'p\\Payments', children: true }, { path: 'p\\Shared', children: false }], currentSprint: 'p\\Sprint 5' });
    assert.match(w, /\(\[System\.AreaPath\] UNDER 'p\\Payments' OR \[System\.AreaPath\] = 'p\\Shared'\)/);
    assert.match(w, /\[System\.IterationPath\] = 'p\\Sprint 5'/);
    // Chosen areas replace the team's.
    const w2 = buildWhere({ team: 'Payments Team', areas: ['p\\Orders'] }, { types, teamAreas: [{ path: 'p\\Payments', children: true }] });
    assert.match(w2, /\[System\.AreaPath\] UNDER 'p\\Orders'/);
    assert.doesNotMatch(w2, /Payments/);
});

test('current sprint without a team (or a team without one) is explained', () => {
    assert.throws(() => buildWhere({ sprint: 'current' }, { types }), /Choose a team/);
    assert.throws(() => buildWhere({ team: 'X', sprint: 'current' }, { types }), /X has no current sprint/);
});

test('states, include done, assignee, tags, text, id, recently changed; quotes escaped', () => {
    const w = buildWhere({ types: ['Bug'], states: ['Closed'], assigned: "O'Brien", tags: ['smoke', " it's "], text: "can't log in", changedDays: 7 }, { types });
    assert.match(w, /\[System\.WorkItemType\] IN \('Bug'\)/);
    assert.match(w, /\[System\.State\] IN \('Closed'\)/);
    assert.match(w, /\[System\.AssignedTo\] = 'O''Brien'/);
    assert.match(w, /\[System\.Tags\] CONTAINS 'smoke' AND \[System\.Tags\] CONTAINS 'it''s'/);
    assert.match(w, /\[System\.Title\] CONTAINS 'can''t log in'/);
    assert.match(w, /\[System\.ChangedDate\] >= @Today - 7/);
    assert.match(buildWhere({ text: '#1260' }, { types }), /\[System\.Id\] = 1260/);
    assert.match(buildWhere({ assigned: 'me' }, { types }), /\[System\.AssignedTo\] = @Me/);
    assert.match(buildWhere({ assigned: 'unassigned' }, { types }), /\[System\.AssignedTo\] = ''/);
    assert.doesNotMatch(buildWhere({ open: false }, { types }), /System\.State/);
});
