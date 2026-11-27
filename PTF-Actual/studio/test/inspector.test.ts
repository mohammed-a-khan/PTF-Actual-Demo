import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as ts from 'typescript';
import { decodeMappings, generatedFor, InspectorSession, inspectorUrl, originalFor, projectFile, readInlineMap, sameFile } from '../src/debug/inspector';

const SRC = `import { helper } from './helper';

export class Basket {
    private lines: Array<{ sku: string; qty: number }> = [];

    add(sku: string, qty: number) {
        const line = { sku, qty };

        this.lines.push(line);
        return this.lines.length;
    }
}
`;
const compiled = () => ts.transpileModule(SRC, { fileName: 'basket.ts', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, sourceMap: true, inlineSourceMap: true, inlineSources: true, experimentalDecorators: true } }).outputText;

test('source maps: decoded as TypeScript wrote them; lines mapped both ways', () => {
    const out = compiled();
    const map = readInlineMap(/sourceMappingURL=(.*)$/m.exec(out)![1])!;
    const lines = out.split('\n');
    assert.ok(map.mappings.length > 10);
    // Line 7 ("const line = …") is where that statement is in the output
    const at = generatedFor(map, 7)!;
    assert.match(lines[at.genLine], /const line = \{ sku, qty \}/);
    assert.equal(at.line, 7);
    // A blank line (8) moves to the next line with code (9)
    const blank = generatedFor(map, 8)!;
    assert.equal(blank.line, 9);
    assert.match(lines[blank.genLine], /this\.lines\.push\(line\)/);
    // And back: that output position is line 9 of the .ts file
    assert.equal(originalFor(map, blank.genLine, blank.genCol), 9);
    // Without a map (plain JavaScript): the same lines
    assert.deepEqual(generatedFor(null, 5), { genLine: 4, genCol: 0, line: 5 });
    assert.equal(originalFor(null, 4, 0), 5);
    assert.equal(readInlineMap('file.js.map'), null);
    assert.deepEqual(decodeMappings('AAAA;AACA'), [{ genLine: 0, genCol: 0, src: 0, line: 0, col: 0 }, { genLine: 1, genCol: 0, src: 0, line: 1, col: 0 }]);
    assert.equal(inspectorUrl('Debugger listening on ws://127.0.0.1:41235/0d1f-aa2b'), 'ws://127.0.0.1:41235/0d1f-aa2b');
    assert.equal(inspectorUrl('Debugger listening on ws://10.0.0.5:9229/x'), null, 'only this computer');
});

test('a debug session on a real process: breakpoint, call stack, variables, evaluate, step over, live breakpoints', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insp-'));
    fs.mkdirSync(path.join(root, 'steps'));
    // Plain JavaScript (lines map 1:1); the function runs after a short wait, as step code runs after loading.
    fs.writeFileSync(path.join(root, 'steps', 'calc.js'), [
        'function total(lines) {',              // 1
        '    let sum = 0;',                      // 2
        '    for (const l of lines) {',          // 3
        '        sum += l.qty * l.price;',       // 4
        '    }',                                 // 5
        '    return sum;',                       // 6
        '}',                                     // 7
        'setTimeout(() => {',                    // 8
        '    const r = total([{ qty: 2, price: 4.5 }, { qty: 1, price: 1.25 }]);', // 9
        '    console.log("total " + r);',        // 10
        '}, 300);',                              // 11
    ].join('\n'));
    const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', path.join(root, 'steps', 'calc.js')], { cwd: root });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const url = await new Promise<string>((res) => child.stderr.on('data', (d) => { const u = inspectorUrl(String(d).split('\n')[0]); if (u) res(u); }));
    const s = new InspectorSession(url, root);
    const pausedOnce = () => new Promise<any>((res) => s.once('paused', res));
    let p = pausedOnce();
    await s.start([{ file: 'steps/calc.js', line: 4 }]);
    let paused = await p;
    assert.equal(paused.reason, 'breakpoint');
    assert.deepEqual([paused.frames[0].name, paused.frames[0].file, paused.frames[0].line, paused.frames[0].external], ['total', 'steps/calc.js', 4, false]);
    assert.equal(paused.frames[1].line, 9, 'the caller');
    const scopes = await s.scopes(0);
    const block = scopes.flatMap((sc) => sc.variables);
    assert.equal(block.find((v) => v.name === 'sum')!.value, '0');
    assert.equal(block.find((v) => v.name === 'l')!.value, '{qty: 2, price: 4.5}');
    const lines = scopes.find((sc) => sc.name === 'Local')!.variables.find((v) => v.name === 'lines')!;
    assert.match(lines.value, /^Array\(2\) \[/);
    assert.equal((await s.properties(lines.objectId!)).filter((v) => /^\d+$/.test(v.name)).length, 2, 'expand an array');
    assert.equal((await s.evaluate('l.qty * l.price', 0)).value, '9');
    assert.equal((await s.evaluate('nope.x', 0)).type, 'error');
    // Step over: the next line of the loop
    p = pausedOnce();
    await s.command('stepOver');
    paused = await p;
    assert.equal(paused.frames[0].line, 3);
    // Breakpoints changed while paused: the one on line 4 goes, one on 6 comes
    await s.setBreakpoints([{ file: 'steps/calc.js', line: 6 }]);
    p = pausedOnce();
    await s.command('resume');
    paused = await p;
    assert.equal(paused.frames[0].line, 6);
    assert.equal((await s.evaluate('sum', 0)).value, '10.25');
    await s.command('resume');
    // The process waits for the debugger to disconnect before it ends (as with the Studio's runner).
    const exited = new Promise<void>((res) => { child.once('exit', () => res()); setTimeout(res, 5000); });
    s.close();
    await exited;
    assert.match(out, /total 10\.25/);
    try { child.kill(); } catch { /* ended */ }
    fs.rmSync(root, { recursive: true, force: true });
});

test('stepping past the end of a step asks the framework to pause before the next step; into a step breaks in its code', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insp-'));
    fs.mkdirSync(path.join(root, 'steps'));
    fs.mkdirSync(path.join(root, 'node_modules', 'fw'), { recursive: true });
    // A framework stand-in (node_modules: skipped): runs steps, loading a module in between (Node's own code), and
    // pauses before a step on request as the framework's debug controller does (waiting for a line on stdin).
    fs.writeFileSync(path.join(root, 'node_modules', 'fw', 'index.js'), [
        'let pauseNext = false, current = null;',
        "globalThis[Symbol.for('cs-test.debug')] = { pauseBeforeNextStep: () => (pauseNext = true), stepFunction: () => current, runToBreakpoint: () => !(pauseNext = false) };",
        'exports.run = async (steps) => {',
        '    for (const s of steps) {',
        "        if (pauseNext) { pauseNext = false; current = s; console.log('pause before ' + s.name); await new Promise((r) => process.stdin.once('data', r)); current = null; }",
        "        require('path');",
        '        await s();',
        '        await new Promise((r) => setTimeout(r, 20));',
        '    }',
        "    console.log('done'); process.stdin.destroy();",
        '};',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'steps', 'run.js'), [
        "const { run } = require('fw');",     // 1
        'function first() {',                  // 2
        '    const a = 1;',                    // 3
        '    return a;',                       // 4
        '}',                                   // 5
        'function second() {',                 // 6
        '    const b = 2;',                    // 7
        '    return b;',                       // 8
        '}',                                   // 9
        'setTimeout(() => run([first, second]), 300);', // 10
    ].join('\n'));
    const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', path.join(root, 'steps', 'run.js')], { cwd: root });
    let out = '';
    const printed = (text: string) => new Promise<void>((res) => { const t = () => { if (out.includes(text)) res(); else setTimeout(t, 20); }; t(); });
    child.stdout.on('data', (d) => { out += d; });
    const url = await new Promise<string>((res) => child.stderr.on('data', (d) => { const u = inspectorUrl(String(d).split('\n')[0]); if (u) res(u); }));
    const s = new InspectorSession(url, root);
    const pauses: any[] = [];
    s.on('paused', (p) => pauses.push(p));
    const pausedOnce = () => new Promise<any>((res) => s.once('paused', res));
    let p = pausedOnce();
    await s.start([{ file: 'steps/run.js', line: 3 }]);
    assert.equal((await p).frames[0].line, 3);
    p = pausedOnce();
    await s.command('stepOver');
    assert.equal((await p).frames[0].line, 4);
    // Out of the step to the project code that called the framework (a timer callback here)…
    p = pausedOnce();
    await s.command('stepOver');
    assert.deepEqual([(await p).frames[0].line, (await p).frames[0].external], [10, false]);
    // …and past its end: no stop in the framework or Node's code; the framework pauses before the next step.
    let resumed = 0;
    s.on('resumed', () => resumed++);
    await s.command('stepOver');
    await printed('pause before second');
    assert.ok(pauses.every((x) => !x.frames[0].external), 'never paused outside the project');
    assert.equal(resumed, 1, 'the steps taken by themselves through Node\'s code resume once for the user');
    assert.deepEqual(pauses.map((x) => x.seq), pauses.map((_, i) => i + 1), 'every pause numbered');
    assert.equal(s.paused, null);
    // Into the step it is paused before: its first line, as a step (not a breakpoint).
    assert.equal(await s.breakInto(), true);
    p = pausedOnce();
    child.stdin.write('next\n');
    const into = await p;
    assert.deepEqual([into.frames[0].name, into.frames[0].line, into.reason], ['second', 7, 'step']);
    await s.command('resume');
    await printed('done');
    const exited = new Promise<void>((res) => { child.once('exit', () => res()); setTimeout(res, 5000); });
    s.close();
    await exited;
    try { child.kill(); } catch { /* ended */ }
    fs.rmSync(root, { recursive: true, force: true });
});

test('script addresses as the project\'s files: Windows file URLs (drive letters, escapes, letter case), backslash paths, network drives', () => {
    const W = 'win32';
    const root = 'C:\\Users\\John Smith\\repo';
    // What Node reports for CommonJS / ts-node scripts on Windows
    assert.equal(projectFile('file:///C:/Users/John%20Smith/repo/test/weblab/steps/shop.steps.ts', root, W), 'test/weblab/steps/shop.steps.ts');
    assert.equal(projectFile('file:///c:/users/john%20smith/REPO/test/Shop.steps.ts', root, W), 'test/Shop.steps.ts', 'letter case of the folder does not matter');
    assert.equal(projectFile('C:\\Users\\John Smith\\repo\\test\\a.ts', root, W), 'test/a.ts', 'a plain path');
    assert.equal(projectFile('c:\\users\\john smith\\repo\\test\\a.ts', 'C:/Users/John Smith/repo', W), 'test/a.ts', 'the root with / too');
    assert.equal(projectFile('\\\\?\\C:\\Users\\John Smith\\repo\\a.ts', root, W), 'a.ts', 'a long path');
    assert.equal(projectFile('file://fileserver/share/repo/steps/a.ts', '\\\\fileserver\\share\\repo', W), 'steps/a.ts', 'a network drive');
    assert.equal(projectFile('file:///C:/Users/John%20Smith/repo/Node_Modules/fw/a.js', root, W), null, 'node_modules (any case) is not the project\'s');
    assert.equal(projectFile('file:///D:/repo/a.ts', root, W), null, 'another drive');
    assert.equal(projectFile('C:\\Users\\John Smith\\repo2\\a.ts', root, W), null, 'a folder next to it');
    assert.equal(projectFile('node:internal/modules/cjs/loader', root, W), null);
    assert.equal(projectFile('evalmachine.<anonymous>', root, W), null);
    assert.equal(projectFile('/C:/x.ts', root, W), null);
    // Linux / macOS: escapes decoded, letter case matters
    assert.equal(projectFile('file:///home/me/my%20repo/test/a.ts', '/home/me/my repo', 'linux'), 'test/a.ts');
    assert.equal(projectFile('/home/me/repo/test/a.ts', '/home/me/repo', 'darwin'), 'test/a.ts');
    assert.equal(projectFile('/home/me/Repo/test/a.ts', '/home/me/repo', 'linux'), null);
    assert.equal(projectFile('file:///home/me/repo/node_modules/x/a.js', '/home/me/repo', 'linux'), null);
    // Breakpoints (saved with /) and scripts are the same file on Windows whatever the letter case or separator
    assert.equal(sameFile('test/weblab/steps/Shop.Steps.ts', 'Test\\Weblab\\steps\\shop.steps.ts', W), true);
    assert.equal(sameFile('test/a.ts', 'test/A.ts', 'linux'), false);
    assert.equal(sameFile('./test/a.ts', 'test/a.ts', 'linux'), true);
});

test('a project in a folder with a space: breakpoint hit; `this` and async callers shown; Stop while paused lets the run end', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insp space-'));
    fs.mkdirSync(path.join(root, 'steps'));
    fs.writeFileSync(path.join(root, 'steps', 'page.js'), [
        'class CartPage {',                          // 1
        '    constructor() { this.items = 2; }',     // 2
        '    async total(price) {',                  // 3
        '        await null;',                       // 4
        '        const sum = this.items * price;',   // 5
        '        return sum;',                       // 6
        '    }',                                     // 7
        '}',                                         // 8
        'async function step() {',                   // 9
        '    const r = await new CartPage().total(3);', // 10
        '    console.log("sum " + r);',              // 11
        '}',                                         // 12
        'setTimeout(() => { step(); setInterval(() => undefined, 1000); }, 300);', // 13
        "process.on('SIGTERM', () => { console.log('cleaned up'); process.exit(0); });", // 14
    ].join('\n'));
    const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', path.join(root, 'steps', 'page.js')], { cwd: root });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const url = await new Promise<string>((res) => child.stderr.on('data', (d) => { const u = inspectorUrl(String(d).split('\n')[0]); if (u) res(u); }));
    const s = new InspectorSession(url, root);
    // A failed check must not leave the process waiting in the debugger (the test run would never end).
    const guard = setTimeout(() => { s.close(); child.kill('SIGKILL'); }, 20000);
    try {
    const p = new Promise<any>((res) => s.once('paused', res));
    await s.start([{ file: 'steps/page.js', line: 6 }]);
    const paused = await p;
    assert.deepEqual([paused.frames[0].name, paused.frames[0].file, paused.frames[0].line], ['total', 'steps/page.js', 6]);
    const caller = paused.frames.find((f: any) => f.async && f.name === 'step');
    assert.ok(caller, 'the async caller is in the call stack');
    assert.deepEqual([caller.file, caller.line, caller.external], ['steps/page.js', 10, false]);
    const local = (await s.scopes(0)).find((sc) => sc.name === 'Local')!.variables;
    assert.equal(local[0].name, 'this');
    assert.match(local[0].value, /^CartPage \{items: 2\}/);
    assert.equal((await s.properties(local[0].objectId!)).find((v) => v.name === 'items')!.value, '2', 'this expands');
    assert.equal(local.find((v) => v.name === 'sum')!.value, '6');
    assert.equal((await s.evaluate('this.items + price', 0)).value, '5', 'evaluated in the paused frame');
    // Stop while paused: the debugger lets it go, so its SIGTERM handler runs
    await s.release();
    child.kill('SIGTERM');
    await new Promise<void>((res) => { child.once('exit', () => res()); setTimeout(res, 5000); });
    assert.match(out, /sum 6/);
    assert.match(out, /cleaned up/);
    } finally {
        clearTimeout(guard);
        s.close();
        try { child.kill('SIGKILL'); } catch { /* ended */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
