import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { layoutGraph, parseGraphLog } from '../src/git/graph';

test('linear history stays in column 0', () => {
    const rows = layoutGraph([{ sha: 'c', parents: ['b'] }, { sha: 'b', parents: ['a'] }, { sha: 'a', parents: [] }]);
    assert.deepEqual(rows.map((r) => [r.col, r.into, r.passThrough, r.out]), [[0, [], [], [0]], [0, [0], [], [0]], [0, [0], [], []]]);
});

test('branch and merge', () => {
    // m merges f (feature) into d (main); both come from a.
    const rows = layoutGraph([
        { sha: 'm', parents: ['d', 'f'] },
        { sha: 'd', parents: ['a'] },
        { sha: 'f', parents: ['a'] },
        { sha: 'a', parents: [] },
    ]);
    assert.deepEqual(rows[0], { col: 0, into: [], passThrough: [], out: [0, 1], width: 2 });
    assert.deepEqual(rows[1], { col: 0, into: [0], passThrough: [1], out: [0], width: 2 });
    assert.deepEqual(rows[2], { col: 1, into: [1], passThrough: [0], out: [1], width: 2 });
    // both lanes point at a: they join into column 0
    assert.deepEqual(rows[3], { col: 0, into: [0, 1], passThrough: [], out: [], width: 2 });
});

test('two branch tips, unrelated column reused after it ends', () => {
    const rows = layoutGraph([
        { sha: 'x2', parents: ['x1'] },
        { sha: 'y1', parents: ['r'] },
        { sha: 'x1', parents: ['r'] },
        { sha: 'r', parents: [] },
    ]);
    assert.equal(rows[1].col, 1);
    assert.deepEqual(rows[1].passThrough, [0]);
    assert.deepEqual(rows[3].into, [0, 1]);
});

test('parse decorated log', () => {
    const out = 'aaa\x1fbbb ccc\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1fMerge\x1fHEAD -> main, origin/main, tag: v1.0\x1e\nbbb\x1f\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1fFirst\x1f\x1e\n';
    const c = parseGraphLog(out);
    assert.deepEqual(c[0].parents, ['bbb', 'ccc']);
    assert.deepEqual(c[0].refs, [{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }, { name: 'origin/main', kind: 'remote' }, { name: 'v1.0', kind: 'tag' }]);
    assert.deepEqual(c[1].parents, []);
});

test('full decorations: local branches with a slash are branches, not remotes', () => {
    const out = 'aaa\x1f\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1fS\x1fHEAD -> refs/heads/main, refs/heads/feature/x, refs/remotes/origin/feature/x, tag: refs/tags/v1.0, refs/stash, refs/cs-studio/backups/1\x1e\n';
    const [c] = parseGraphLog(out);
    assert.deepEqual(c.refs, [
        { name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' },
        { name: 'feature/x', kind: 'branch' }, { name: 'origin/feature/x', kind: 'remote' },
        { name: 'v1.0', kind: 'tag' }, { name: 'stash', kind: 'stash' },
    ]);
});
