import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { accessibilityChecks, approveAria, approveVisual, ariaSnapshots, configuredDirs, insideRepo, lineDiff, visualSnapshots } from '../src/quality/visual';
import { png, sha, visualFixture } from './visual-fixtures';

test('the visual folders: VISUAL_AI_DIR of the env files, and the default, when they exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    fs.mkdirSync(path.join(root, 'config', 'shop', 'common'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'shop', 'common', 'common.env'), 'PROJECT=shop\nVISUAL_AI_DIR=test/shop/visual\n');
    fs.writeFileSync(path.join(root, 'config', 'global.env'), 'VISUAL_AI_DIR=../outside\nX=1\n');
    fs.mkdirSync(path.join(root, 'test', 'shop', 'visual'), { recursive: true });
    assert.deepEqual(configuredDirs(root, 'VISUAL_AI_DIR', 'test/visual-ai'), ['test/shop/visual'], 'missing default and a folder outside left out');
    fs.mkdirSync(path.join(root, 'test', 'visual-ai'), { recursive: true });
    assert.deepEqual(configuredDirs(root, 'VISUAL_AI_DIR', 'test/visual-ai'), ['test/shop/visual', 'test/visual-ai']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('visual snapshots: changed, new, cosmetic, same; approving makes the last screenshot the baseline', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    const dir = 'test/visual-ai';
    const green = png(4, 3, [0, 128, 0]), red = png(4, 3, [200, 0, 0]);
    visualFixture(root, dir, 'basket', { baseline: green, actual: red, result: { passed: false, verdict: 'structural_change', message: 'Page has structural changes', timestamp: new Date(Date.now() + 2000).toISOString(), scenario: 'Basket', pixelResult: { passed: false, diffPercentage: 12.5, changedPixels: 3, totalPixels: 12, changedArea: { x: 1, y: 0, width: 2, height: 2 } }, structuralResult: { ariaChanges: ['Added: "- button"'], layoutChanges: [] } } });
    visualFixture(root, dir, 'home', { baseline: green, actual: green, result: { passed: true, verdict: 'identical', baselineCreated: true, timestamp: new Date().toISOString() } });
    visualFixture(root, dir, 'menu', { baseline: green, actual: red, result: { passed: true, verdict: 'cosmetic_only', pixelResult: { passed: false, diffPercentage: 0.4 } } });
    visualFixture(root, dir, 'footer', { baseline: green, actual: green, result: { passed: true, verdict: 'identical' } });
    let list = visualSnapshots(root, [dir], {});
    assert.deepEqual(list.map((v) => `${v.name}:${v.status}`), ['basket:changed', 'home:new', 'menu:cosmetic', 'footer:same']);
    const basket = list[0];
    assert.equal(basket.pixels?.percent, 12.5);
    assert.deepEqual(basket.pixels?.area, { x: 1, y: 0, width: 2, height: 2 });
    assert.deepEqual(basket.ariaChanges, ['Added: "- button"']);
    assert.deepEqual(basket.files, { baseline: `${dir}/baseline/basket.png`, actual: `${dir}/actual/basket.png`, diff: `${dir}/diff/basket.diff.png` });
    assert.equal(list[3].files.actual, null, 'the same picture: no "last run" to show');
    // A new baseline someone looked at: not new any more
    const homeSha = fs.readFileSync(path.join(root, dir, 'baseline', 'home.pixel-hash'), 'utf8');
    list = visualSnapshots(root, [dir], { [`${dir}/home`]: { action: 'accepted', at: '2026-11-22T10:00:00Z', sha: homeSha } });
    assert.equal(list.find((v) => v.name === 'home')!.status, 'same');
    fs.mkdirSync(path.join(root, '.cs-visual-baseline-store'));
    fs.writeFileSync(path.join(root, '.cs-visual-baseline-store', 'baseline-tolerances.json'), JSON.stringify({ version: 1, entries: { basket__ssim: { samples: [0.99] }, 'basket__phash-dct': { samples: [3] }, home__ssim: { samples: [1] } } }));
    // Approve the change: only the screenshot the reviewer saw
    assert.equal(basket.actualSha, sha(red));
    assert.throws(() => approveVisual(root, dir, 'basket', sha(green)), /newer run/);
    fs.writeFileSync(path.join(root, dir, 'baseline', 'basket.dct-phash'), 'old');
    const hash = approveVisual(root, dir, 'basket', basket.actualSha!);
    assert.equal(hash, sha(red));
    assert.deepEqual(fs.readFileSync(path.join(root, dir, 'baseline', 'basket.png')), red);
    assert.equal(fs.readFileSync(path.join(root, dir, 'baseline', 'basket.pixel-hash'), 'utf8'), sha(red));
    assert.equal(fs.readFileSync(path.join(root, dir, 'baseline', 'basket.structural.json'), 'utf8'), '{"v":"new"}', 'the structure comes along');
    assert.equal(fs.existsSync(path.join(root, dir, 'diff', 'basket.diff.png')), false);
    assert.equal(fs.existsSync(path.join(root, dir, 'baseline', 'basket.dct-phash')), false, 'a hash the approved run did not compute goes');
    const store = JSON.parse(fs.readFileSync(path.join(root, '.cs-visual-baseline-store', 'baseline-tolerances.json'), 'utf8'));
    assert.deepEqual(Object.keys(store.entries), ['home__ssim'], 'the approved snapshot\'s learned scores are forgotten, others kept');
    assert.equal(visualSnapshots(root, [dir], {}).find((v) => v.name === 'basket')!.status, 'same');
    assert.throws(() => approveVisual(root, dir, 'nothing'), /No screenshot/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('visual snapshots: a comparison older than the baseline (updated since) is not offered again', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    const dir = 'test/visual-ai';
    visualFixture(root, dir, 'home', { baseline: png(2, 2, [0, 0, 0]), actual: png(2, 2, [9, 9, 250]), result: { passed: false, verdict: 'visual_change', timestamp: new Date(Date.now() - 3_600_000).toISOString() } });
    const v = visualSnapshots(root, [dir], {})[0];
    assert.equal(v.status, 'same');
    assert.equal(v.files.actual, null);
    fs.rmSync(root, { recursive: true, force: true });
});

test('the same picture with another structure (an alt text): changed, and approving settles it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    const dir = 'test/visual-ai';
    const same = png(2, 2, [10, 20, 30]);
    visualFixture(root, dir, 'home', { baseline: same, actual: same, result: { passed: false, verdict: 'structural_change', timestamp: new Date(Date.now() + 2000).toISOString(), structuralResult: { ariaChanges: ['Removed: "- img \\"Mug\\""', 'Added: "- img \\"Cup\\""'], layoutChanges: [] } } });
    let v = visualSnapshots(root, [dir], {})[0];
    assert.equal(v.status, 'changed');
    assert.equal(v.files.actual, null, 'no second picture to show');
    assert.equal(v.ariaChanges.length, 2);
    approveVisual(root, dir, 'home', v.actualSha!);
    assert.equal(fs.readFileSync(path.join(root, dir, 'baseline', 'home.structural.json'), 'utf8'), '{"v":"new"}');
    v = visualSnapshots(root, [dir], {})[0];
    assert.equal(v.status, 'same');
    fs.rmSync(root, { recursive: true, force: true });
});

test('approving never follows a link out of the repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-out-'));
    const dir = 'test/visual-ai';
    visualFixture(root, dir, 'home', { baseline: png(2, 2, [0, 0, 0]), actual: png(2, 2, [200, 0, 0]) });
    const target = path.join(outside, 'victim.png');
    fs.writeFileSync(target, 'keep');
    fs.rmSync(path.join(root, dir, 'baseline', 'home.png'));
    fs.symlinkSync(target, path.join(root, dir, 'baseline', 'home.png'));
    assert.throws(() => approveVisual(root, dir, 'home'), /link/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    // A screenshot that is a link to a file outside: not read
    fs.rmSync(path.join(root, dir, 'baseline', 'home.png'));
    fs.rmSync(path.join(root, dir, 'actual', 'home.png'));
    fs.writeFileSync(path.join(outside, 'secret.png'), png(1, 1, [1, 2, 3]));
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(root, dir, 'actual', 'home.png'));
    assert.throws(() => approveVisual(root, dir, 'home'), /Outside/);
    assert.equal(insideRepo(root, path.join(root, dir, 'baseline', 'home.pixel-hash')), fs.realpathSync(path.join(root, dir, 'baseline', 'home.pixel-hash')));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});

test('accessibility snapshots: a changed one with its line diff; approving makes it the baseline', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    const dir = 'test/accessibility/snapshots';
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'home.yaml'), '- main:\n  - heading "Basket" [level=2]\n  - img "Mug"\n  - button "Checkout"\n');
    fs.writeFileSync(path.join(root, dir, 'home.actual.yaml'), '- main:\n  - heading "Basket" [level=3]\n  - img\n  - button "Checkout"\n');
    fs.writeFileSync(path.join(root, dir, 'menu.yaml'), '- navigation\n');
    const list = ariaSnapshots(root, [dir]);
    assert.deepEqual(list.map((s) => `${s.name}:${s.status}`), ['home:changed', 'menu:same']);
    assert.throws(() => approveAria(root, dir, 'home', '0'.repeat(64)), /newer run/);
    const d = list[0].diff!;
    assert.deepEqual(d.filter((l) => l.kind !== 'same').map((l) => `${l.kind} ${l.text.trim()}`), ['del - heading "Basket" [level=2]', 'del - img "Mug"', 'add - heading "Basket" [level=3]', 'add - img']);
    assert.equal(d[0].text, '- main:');
    approveAria(root, dir, 'home', list[0].actualSha);
    assert.match(fs.readFileSync(path.join(root, dir, 'home.yaml'), 'utf8'), /level=3/);
    assert.equal(fs.existsSync(path.join(root, dir, 'home.actual.yaml')), false);
    assert.throws(() => approveAria(root, dir, 'home'), /No changed/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('line diff: unchanged start and end kept, the middle compared', () => {
    assert.deepEqual(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']), [{ kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'x' }, { kind: 'same', text: 'c' }]);
    assert.deepEqual(lineDiff(['a'], ['a', 'b']), [{ kind: 'same', text: 'a' }, { kind: 'add', text: 'b' }]);
    assert.deepEqual(lineDiff([], []), []);
});

test('accessibility checks: the latest per page and scenario, from the runs\' records, worst first', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    const rec = (run: string, file: string, r: Record<string, unknown>) => { fs.mkdirSync(path.join(root, run, 'accessibility'), { recursive: true }); fs.writeFileSync(path.join(root, run, 'accessibility', file), JSON.stringify(r)); };
    rec('r1', 'a.json', { check: 'violations', url: 'http://shop/basket', scenario: 'Basket', timestamp: '2026-11-20T10:00:00Z', passed: false, violations: [{ id: 'missing-alt-text', impact: 'serious', description: 'Image element has no alt text', helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/image-alt' }] });
    rec('r2', 'a.json', { check: 'violations', url: 'http://shop/basket', scenario: 'Basket', timestamp: '2026-11-21T10:00:00Z', passed: false, violations: [{ id: 'missing-label', impact: 'critical', description: 'Button has no label', element: '- button', helpUrl: 'javascript:alert(1)' }, { id: 'heading-order', impact: 'moderate', description: 'h1 to h3' }] });
    rec('r2', 'b.json', { check: 'violations', url: 'http://shop/home', scenario: 'Home', timestamp: '2026-11-21T10:00:00Z', passed: true, violations: [], passes: 12 });
    rec('r2', 'c.json', { check: 'aria-snapshot', passed: false });
    const checks = accessibilityChecks([{ folder: path.join(root, 'r1'), run: 'run-1' }, { folder: path.join(root, 'r2'), run: 'run-2' }, { folder: path.join(root, 'none'), run: 'x' }]);
    assert.deepEqual(checks.map((c) => `${c.url}:${c.run}:${c.violations.length}`), ['http://shop/basket:run-2:2', 'http://shop/home:run-2:0']);
    assert.equal(checks[0].violations[0].helpUrl, undefined, 'only https links');
    assert.equal(checks[1].passes, 12);
    fs.rmSync(root, { recursive: true, force: true });
});
