import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseAddedLines, parseLog, parseStatusV2 } from '../src/git/parse';

test('parseStatusV2: branch headers, changes, rename, conflict, untracked', () => {
    const out = [
        '# branch.oid 1111111111111111111111111111111111111111',
        '# branch.head feature/login',
        '# branch.upstream origin/feature/login',
        '# branch.ab +2 -1',
        '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
        '1 .M N... 100644 100644 100644 aaa bbb src/with space.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts',
        'old/name.ts',
        'u UU N... 100644 100644 100644 100644 h1 h2 h3 features/x.feature',
        '? notes.txt',
        '',
    ].join('\0');
    const st = parseStatusV2(out);
    assert.equal(st.branch, 'feature/login');
    assert.equal(st.upstream, 'origin/feature/login');
    assert.equal(st.ahead, 2);
    assert.equal(st.behind, 1);
    assert.equal(st.hasConflicts, true);
    assert.deepEqual(st.files.map((f) => [f.path, f.staged, f.unstaged]), [
        ['src/a.ts', 'M', '.'],
        ['src/with space.ts', '.', 'M'],
        ['new/name.ts', 'R', '.'],
        ['features/x.feature', 'U', 'U'],
        ['notes.txt', '.', '?'],
    ]);
    assert.equal(st.files[2].origPath, 'old/name.ts');
    assert.equal(st.files[4].untracked, true);
});

test('parseStatusV2: initial and detached', () => {
    assert.equal(parseStatusV2('# branch.oid (initial)\0# branch.head main\0').head, null);
    assert.equal(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0').branch, null);
});

test('parseAddedLines: line numbers across hunks, quoted paths, binary, deletions', () => {
    const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1..2 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -3,0 +4,2 @@',
        '+line four',
        '+line five',
        '@@ -10 +12 @@',
        '-old',
        '+line twelve',
        'diff --git "a/sp\\303\\251cial file.ts" "b/sp\\303\\251cial file.ts"',
        'new file mode 100644',
        '--- /dev/null',
        '+++ "b/sp\\303\\251cial file.ts"',
        '@@ -0,0 +1 @@',
        '+hello',
        'diff --git a/img.png b/img.png',
        'new file mode 100644',
        'Binary files /dev/null and b/img.png differ',
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
        '',
    ].join('\n');
    const files = parseAddedLines(diff);
    assert.equal(files.length, 4);
    assert.deepEqual(files[0].added.map((a) => [a.line, a.text]), [[4, 'line four'], [5, 'line five'], [12, 'line twelve']]);
    assert.equal(files[1].path, 'spécial file.ts');
    assert.equal(files[1].added[0].file, 'spécial file.ts');
    assert.equal(files[2].binary, true);
    assert.equal(files[3].deleted, true);
    assert.equal(files[3].path, 'gone.ts');
});

test('parseLog', () => {
    const out = 'abc\x1fA B\x1fa@b.c\x1f2026-01-01T00:00:00Z\x1fFirst: subject\x1e\ndef\x1fC\x1fc@d\x1f2026-01-02T00:00:00Z\x1fSecond\x1e\n';
    assert.deepEqual(parseLog(out).map((e) => [e.sha, e.subject]), [['abc', 'First: subject'], ['def', 'Second']]);
});

test('parseAddedLines: trailing TAB after names with spaces, quoted non-ASCII + TAB', () => {
    const diff = [
        'diff --git a/name with space.ts b/name with space.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/name with space.ts\t',
        '@@ -0,0 +1 @@',
        '+x',
        'diff --git "a/caf\\303\\251 x.ts" "b/caf\\303\\251 x.ts"',
        'new file mode 100644',
        '--- /dev/null',
        '+++ "b/caf\\303\\251 x.ts"\t',
        '@@ -0,0 +1 @@',
        '+y',
        '',
    ].join('\n');
    const files = parseAddedLines(diff);
    assert.deepEqual(files.map((f) => f.path), ['name with space.ts', 'café x.ts']);
    assert.equal(files[1].added[0].file, 'café x.ts');
});

test('parseAddedLines: "+++"/"---"/"Binary files" text inside a hunk is content, not a header', () => {
    const diff = [
        'diff --git a/notes.ts b/notes.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/notes.ts',
        '@@ -0,0 +1,4 @@',
        '+++ counter.ts',
        '+-- comment',
        '+Binary files are fine',
        '+const apiKey = "x";',
        '',
    ].join('\n');
    const [f] = parseAddedLines(diff);
    assert.equal(f.path, 'notes.ts');
    assert.equal(f.binary, false);
    assert.deepEqual(f.added.map((a) => [a.line, a.text]), [[1, '++ counter.ts'], [2, '-- comment'], [3, 'Binary files are fine'], [4, 'const apiKey = "x";']]);
});

test('parseAddedLines: combined diff (diff --cc, @@@ hunks)', () => {
    const diff = [
        'diff --cc a.txt',
        'index f533456,3efedce..f730fc2',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@@ -1,3 -1,3 +1,4 @@@',
        '- side',
        ' +1',
        '  2',
        '++secret line',
        '',
    ].join('\n');
    const [f] = parseAddedLines(diff);
    assert.equal(f.path, 'a.txt');
    assert.deepEqual(f.added.map((a) => [a.line, a.text]), [[1, '1'], [3, 'secret line']]);
});

test('parseStatusV2: upstream gone (branch.upstream without branch.ab)', () => {
    const gone = parseStatusV2(['# branch.oid 1111111111111111111111111111111111111111', '# branch.head feat', '# branch.upstream origin/feat', ''].join('\0'));
    assert.equal(gone.upstreamGone, true);
    const ok = parseStatusV2(['# branch.oid 1111111111111111111111111111111111111111', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +0 -0', ''].join('\0'));
    assert.equal(ok.upstreamGone, false);
});
