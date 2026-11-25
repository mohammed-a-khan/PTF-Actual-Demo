import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Workspace } from '../src/workspace/files';
import { nameProblem, newPathProblem, shorten } from '../src/workspace/newName';

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-newname-')));

test('new file names: names Windows cannot hold are refused, with the reason', () => {
    for (const n of ['con<>.txt', 'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\\b', 'tab\there', 'bell\u0007', 'CON', 'con.txt', 'Con.tar.gz', 'PRN.feature', 'aux', 'NUL.json', 'com1', 'COM9.ts', 'lpt1.txt', 'LPT9', 'notes.', 'notes ', 'con .txt'])
        assert.ok(nameProblem(n), n);
    for (const n of ['console.md', 'connect.ts', 'com10.txt', 'lpt.txt', 'auxiliary.feature', 'a.b.c', '.github', 'nul-check.ts', 'é-ü.feature'])
        assert.equal(nameProblem(n), null, n);
    assert.match(nameProblem('con<>.txt')!, /contains "<" ">": Windows does not allow them/);
    assert.match(nameProblem('aux.json')!, /reserved name on Windows \(AUX, with any extension\)/);
    assert.match(nameProblem('notes.')!, /ends with a dot/);
    assert.match(nameProblem('x\u0001')!, /control character/);
    assert.equal(newPathProblem('test/orders/features/search.feature'), null);
    assert.match(newPathProblem('test/aux/x.feature')!, /AUX/);
    assert.match(newPathProblem('test//x.feature')!, /empty/);
    // A long name is cut at its end in messages (its start stays readable).
    const long = 'L'.repeat(300) + '<.txt';
    assert.ok(nameProblem(long)!.startsWith(`"${'L'.repeat(59)}…"`));
    assert.equal(shorten('abc', 60), 'abc');
    assert.match(nameProblem('L'.repeat(300) + '.txt')!, /^"L+…" is 304 characters long: a name can have at most 255\.$/);
    assert.equal(nameProblem('L'.repeat(255)), null);
});

test('the editor\'s New file / New folder / Rename refuse such names on the server too', () => {
    const root = mk();
    const ws = new Workspace(root);
    assert.throws(() => ws.write('con<>.txt', '', null), /Windows does not allow/);
    assert.throws(() => ws.write('test/qa/CON.feature', '', null), /reserved/);
    assert.throws(() => ws.write('test/qa/x.feature ', '', null), /./);
    assert.throws(() => ws.write('test/a?b/x.feature', '', null), /Windows does not allow/);
    assert.ok(!fs.existsSync(path.join(root, 'con<>.txt')));
    assert.ok(!fs.existsSync(path.join(root, 'test')));
    assert.throws(() => ws.createFolder('pages/lpt3'), /reserved/);
    assert.throws(() => ws.createFolder('pages/con .x'), /reserved name on Windows/);
    ws.write('test/ok.feature', 'Feature: x\n', null);
    assert.throws(() => ws.rename('test/ok.feature', 'test/ok|.feature'), /Windows does not allow/);
    assert.ok(fs.existsSync(path.join(root, 'test/ok.feature')));
    ws.rename('test/ok.feature', 'test/fine.feature');
    // A file that already has such a name (made elsewhere) can still be saved.
    fs.writeFileSync(path.join(root, 'test/odd?.txt'), 'a');
    const h = ws.read('test/odd?.txt').hash;
    ws.write('test/odd?.txt', 'b', h);
    assert.equal(fs.readFileSync(path.join(root, 'test/odd?.txt'), 'utf8'), 'b');
});
