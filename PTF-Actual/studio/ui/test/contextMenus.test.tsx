import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { areaOf, changesMenu, duplicateName, editorMenu, featuresIn, folderGlob, fullPath, gitStateOf, MenuAction, MenuEntry, scenarioAt, tabMenu, tabsToClose, tidy, treeMenu } from '../src/contextMenus';

const keys = (m: MenuEntry[]) => m.map((e) => (e === 'divider' ? '|' : e.key));
const item = (m: MenuEntry[], k: string) => m.find((e): e is MenuAction => e !== 'divider' && e.key === k);

test('dividers only between groups', () => {
    assert.deepEqual(tidy(['divider', { key: 'a', label: 'A' }, 'divider', null, 'divider', false, { key: 'b', label: 'B' }, 'divider']).map((e) => (e === 'divider' ? '|' : e.key)), ['a', '|', 'b']);
});

test('editor menu: every item with its shortcut, in order; page items in their places', () => {
    const base = { readOnly: false, hasSelection: true, canDefinition: true, canUsages: true, canRename: true, canComment: true, canFormat: true };
    const m = editorMenu({ ...base, breakpoint: { allowed: true, has: false } }, {
        actions: [{ key: 'runScenario', label: 'Run this scenario' }],
        file: [{ key: 'copyPath', label: 'Copy path' }],
    });
    assert.deepEqual(keys(m), ['definition', 'usages', 'rename', '|', 'runScenario', 'breakpoint', '|', 'cut', 'copy', 'paste', 'selectAll', '|', 'comment', 'format', 'find', 'replace', 'gotoLine', '|', 'copyPath']);
    assert.equal(item(m, 'definition')!.shortcut, 'F12');
    assert.equal(item(m, 'usages')!.shortcut, 'Shift+F12');
    assert.equal(item(m, 'rename')!.shortcut, 'F2');
    assert.equal(item(m, 'comment')!.shortcut, 'Ctrl+/');
    assert.equal(item(m, 'format')!.shortcut, 'Shift+Alt+F');
    assert.equal(item(m, 'find')!.shortcut, 'Ctrl+F');
    assert.equal(item(m, 'replace')!.shortcut, 'Ctrl+H');
    assert.equal(item(m, 'gotoLine')!.shortcut, 'Ctrl+G');
    assert.ok(m.every((e) => e === 'divider' || !e.disabled));
    // No page items, no breakpoints (another screen using the editor): the editor's own items only.
    assert.deepEqual(keys(editorMenu(base)), ['definition', 'usages', 'rename', '|', 'cut', 'copy', 'paste', 'selectAll', '|', 'comment', 'format', 'find', 'replace', 'gotoLine']);
});

test('editor menu: read-only files and no selection disable (not hide) items', () => {
    const m = editorMenu({ readOnly: true, hasSelection: false, canDefinition: false, canUsages: true, canRename: true, canComment: true, canFormat: true, breakpoint: { allowed: false, has: false } });
    const disabled = m.filter((e): e is MenuAction => e !== 'divider' && !!e.disabled).map((e) => e.key);
    assert.deepEqual(disabled, ['definition', 'rename', 'breakpoint', 'cut', 'copy', 'paste', 'comment', 'format', 'replace']);
    for (const k of ['usages', 'selectAll', 'find', 'gotoLine']) assert.ok(!item(m, k)!.disabled, k);
    // A breakpoint already there can always be removed.
    const b = editorMenu({ readOnly: false, hasSelection: false, canDefinition: true, canUsages: true, canRename: true, canComment: false, canFormat: false, breakpoint: { allowed: false, has: true } });
    assert.equal(item(b, 'breakpoint')!.disabled, false);
    assert.match(item(b, 'breakpoint')!.label, /Remove breakpoint/);
    assert.ok(item(b, 'comment')!.disabled && item(b, 'format')!.disabled);
});

test('the scenario around the caret line', () => {
    const f = ['Feature: Orders', '  Background:', '    Given I am signed in', '', '  Scenario: Search', '    When I search', '    Then I see results', '',
        '  Scenario Outline: Search by <field>', '    When I search by "<field>"', '    Examples:', '      | field |', '      | id    |', '  Scenario: Search, then sort', '    When x'].join('\n');
    assert.equal(scenarioAt(f, 1), null); // the Feature line
    assert.equal(scenarioAt(f, 3), null); // Background
    const s = scenarioAt(f, 6)!;
    assert.equal(s.name, 'Search'); assert.equal(s.outline, false); assert.equal(s.line, 5);
    assert.deepEqual(s.alsoMatches, ['Search by <field>', 'Search, then sort']);
    assert.equal(scenarioAt(f, 5)!.name, 'Search'); // on the heading itself
    const o = scenarioAt(f, 13)!;
    assert.equal(o.name, 'Search by <field>'); assert.equal(o.outline, true); assert.deepEqual(o.alsoMatches, []);
    // A name with a comma cannot be selected by name.
    assert.equal(scenarioAt(f, 15), null);
    assert.equal(scenarioAt('Feature: x\r\n  Scenario: a\r\n    Given b', 3)!.name, 'a');
});

test('file tree menu: file, feature, folder and empty space', () => {
    const plain = treeMenu({ path: 'src/a.ts', isDir: false, git: null });
    assert.deepEqual(keys(plain), ['open', '|', 'newFile', 'newFolder', 'rename', 'duplicate', 'delete', '|', 'copyName', 'copyPath', 'copyFullPath', '|', 'findInFolder', '|', 'history']);
    assert.equal(item(plain, 'rename')!.shortcut, 'F2');
    assert.equal(item(plain, 'delete')!.shortcut, 'Delete');
    assert.ok(item(plain, 'delete')!.danger);
    const feat = treeMenu({ path: 'test/qa/a.feature', isDir: false, git: { staged: false, unstaged: true, untracked: false, conflicted: false, deleted: false } });
    assert.deepEqual(keys(feat).slice(0, 4), ['open', '|', 'run', 'debug']);
    assert.deepEqual(keys(feat).slice(-5), ['|', 'openChanges', 'stage', 'discard', 'history']);
    const staged = treeMenu({ path: 'a.ts', isDir: false, git: { staged: true, unstaged: false, untracked: false, conflicted: false, deleted: false } });
    assert.ok(keys(staged).includes('unstage') && !keys(staged).includes('stage') && !keys(staged).includes('discard'));
    const fresh = treeMenu({ path: 'new.ts', isDir: false, git: { staged: false, unstaged: false, untracked: true, conflicted: false, deleted: false } });
    assert.ok(keys(fresh).includes('stage') && keys(fresh).includes('discard') && !keys(fresh).includes('history'));
    const conflict = treeMenu({ path: 'a.ts', isDir: false, git: { staged: false, unstaged: true, untracked: false, conflicted: true, deleted: false } });
    assert.equal(item(conflict, 'openChanges')!.label, 'Resolve conflict');
    assert.ok(!keys(conflict).includes('stage') && !keys(conflict).includes('discard'));
    const dir = treeMenu({ path: 'test/qa', isDir: true, featuresInside: 3, git: null });
    assert.deepEqual(keys(dir), ['runFolder', '|', 'newFile', 'newFolder', 'rename', 'delete', '|', 'copyName', 'copyPath', 'copyFullPath', '|', 'findInFolder', '|', 'history', '|', 'collapse']);
    assert.equal(item(dir, 'runFolder')!.label, 'Run all features in this folder (3)');
    assert.ok(!keys(treeMenu({ path: 'src', isDir: true, featuresInside: 0, git: null })).includes('runFolder'));
    assert.deepEqual(keys(treeMenu({ path: null, isDir: false })), ['newFile', 'newFolder', '|', 'collapse', 'refresh']);
});

test('Duplicate names: "name copy.ext", then numbered', () => {
    assert.equal(duplicateName('test/qa/login.feature', []), 'test/qa/login copy.feature');
    assert.equal(duplicateName('test/qa/login.feature', ['test/qa/login copy.feature']), 'test/qa/login copy 2.feature');
    assert.equal(duplicateName('test/qa/login.feature', ['test/qa/login copy.feature', 'test/qa/login copy 2.feature']), 'test/qa/login copy 3.feature');
    assert.equal(duplicateName('Makefile', []), 'Makefile copy');
    assert.equal(duplicateName('config/.env', []), 'config/.env copy');
    assert.equal(duplicateName('a/b.test.ts', []), 'a/b.test copy.ts');
});

test('folders: features inside, search filter, git state, full path', () => {
    const files = ['test/qa/a.feature', 'test/qa/sub/b.feature', 'test/qa/steps.ts', 'test/qab/c.feature'];
    assert.deepEqual(featuresIn(files, 'test/qa'), ['test/qa/a.feature', 'test/qa/sub/b.feature']);
    assert.equal(featuresIn(files, '').length, 3);
    assert.equal(folderGlob('test/qa'), 'test/qa/');
    assert.equal(folderGlob(''), '');
    const st = [{ path: 'test/qa/a.feature', staged: 'M', unstaged: '.', untracked: false, conflicted: false }, { path: 'test/qa/n.ts', staged: '?', unstaged: '?', untracked: true, conflicted: false }];
    assert.deepEqual(gitStateOf(st, 'test/qa', true), { staged: true, unstaged: false, untracked: true, conflicted: false, deleted: false });
    assert.equal(gitStateOf(st, 'test/qab', true), null);
    assert.equal(gitStateOf(st, 'test/qa/steps.ts', false), null);
    assert.equal(fullPath('/home/me/repo', 'test/a.feature'), '/home/me/repo/test/a.feature');
    assert.equal(fullPath('C:\\work\\repo\\', 'test/a.feature'), 'C:\\work\\repo\\test\\a.feature');
    assert.equal(areaOf({ staged: 'M', unstaged: '.', untracked: false, conflicted: false }), 'staged');
    assert.equal(areaOf({ staged: 'M', unstaged: 'M', untracked: false, conflicted: false }), 'changes');
    assert.equal(areaOf({ staged: '?', unstaged: '?', untracked: true, conflicted: false }), 'changes');
    assert.equal(areaOf({ staged: 'U', unstaged: 'U', untracked: false, conflicted: true }), 'conflict');
});

test('tab menu: which tabs each close command closes', () => {
    const tabs = ['a', 'b', 'c', 'd'];
    const dirty = (p: string) => p === 'b' || p === 'd';
    assert.deepEqual(tabsToClose('close', tabs, 'b', dirty), ['b']);
    assert.deepEqual(tabsToClose('others', tabs, 'b', dirty), ['a', 'c', 'd']);
    assert.deepEqual(tabsToClose('right', tabs, 'b', dirty), ['c', 'd']);
    assert.deepEqual(tabsToClose('right', tabs, 'd', dirty), []);
    assert.deepEqual(tabsToClose('saved', tabs, 'b', dirty), ['a', 'c']);
    assert.deepEqual(tabsToClose('all', tabs, 'b', dirty), tabs);
    const m = tabMenu({ count: 4, index: 3, dirtyCount: 2, cleanCount: 2 });
    assert.deepEqual(keys(m), ['close', 'others', 'right', 'saved', 'all', '|', 'copyPath', 'reveal']);
    assert.ok(item(m, 'right')!.disabled);
    const one = tabMenu({ count: 1, index: 0, dirtyCount: 1, cleanCount: 0 });
    assert.ok(item(one, 'others')!.disabled && item(one, 'right')!.disabled && item(one, 'saved')!.disabled && !item(one, 'all')!.disabled);
});

test('Source control changes menu', () => {
    const ch = changesMenu({ area: 'changes', onDisk: true, untracked: false });
    assert.deepEqual(keys(ch), ['open', 'openChanges', '|', 'stage', 'discard', '|', 'copyPath', 'history']);
    assert.ok(ch.every((e) => e === 'divider' || !e.disabled));
    const st = changesMenu({ area: 'staged', onDisk: false, untracked: false });
    assert.deepEqual(keys(st), ['open', 'openChanges', '|', 'unstage', 'discard', '|', 'copyPath', 'history']);
    assert.ok(item(st, 'open')!.disabled && item(st, 'discard')!.disabled);
    const nw = changesMenu({ area: 'changes', onDisk: true, untracked: true });
    assert.ok(item(nw, 'history')!.disabled);
    const cf = changesMenu({ area: 'conflict', onDisk: true, untracked: false });
    assert.equal(item(cf, 'openChanges')!.label, 'Resolve conflict');
    assert.ok(item(cf, 'stage')!.disabled);
});
