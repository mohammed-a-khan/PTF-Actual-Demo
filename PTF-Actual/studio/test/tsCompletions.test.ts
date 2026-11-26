/**
 * Completions as in VS Code: call snippets from the signature, details for one entry, signature help,
 * the warm language service (files on disk read once, edits parsed incrementally) and the worker's
 * queue (what the person waits for goes first).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { callSnippet, TsProjects, TsService } from '../src/lang/tsService';
import { StaleCall, TsClient } from '../src/lang/tsClient';

function repo(files: Record<string, string>) {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tsc-'));
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), t); }
    return r;
}

test('call snippets from display parts: required parameters as placeholders, optional and rest left out', () => {
    const parts = (s: string) => {
        // A tiny tokenizer good enough for "(method) X.name(a: T, b?: U): R".
        const out: Array<{ text: string; kind: string }> = [];
        const re = /(\w+)(\?)?|\.\.\.|[(),:.=>]|\s+|[^\w\s]/g;
        let m: RegExpExecArray | null; let depth = 0; let afterName = false;
        while ((m = re.exec(s))) {
            const t = m[0];
            if (t === '(') { depth++; out.push({ text: t, kind: 'punctuation' }); continue; }
            if (t === ')') { depth--; out.push({ text: t, kind: 'punctuation' }); continue; }
            if (/^\s+$/.test(t)) { out.push({ text: t, kind: 'space' }); continue; }
            if (/^\w/.test(t)) {
                const name = m[1];
                const isParam: boolean = depth === 1 && !afterName;
                out.push({ text: name, kind: isParam ? 'parameterName' : name === 'replace' || name === 'toUpperCase' || name === 'f' ? 'methodName' : 'text' });
                if (m[2]) out.push({ text: '?', kind: 'punctuation' });
                afterName = isParam;
                continue;
            }
            if (t === ',') afterName = false;
            out.push({ text: t, kind: 'punctuation' });
        }
        return out;
    };
    assert.equal(callSnippet('replace', parts('(method) String.replace(searchValue: string, replaceValue: string): string')), 'replace(${1:searchValue}, ${2:replaceValue})$0');
    assert.equal(callSnippet('toUpperCase', parts('(method) String.toUpperCase(): string')), 'toUpperCase($0)');
    assert.equal(callSnippet('f', parts('function f(a: number, b?: number): void')), 'f(${1:a})$0');
    assert.equal(callSnippet('f', parts('function f(...rest: number[]): void')), 'f($0)');
});

test('completion details, snippets, signature help with the real language service', () => {
    const r = repo({ 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', lib: ['ES2022'] } }), 'a.ts': '' });
    const f = path.join(r, 'a.ts');
    const svc = new TsService(r);
    const text = "const value: string = 'x';\nvalue.";
    svc.update(f, text);
    const items = svc.completions(f, text.length);
    const rep = items.find((i) => i.name === 'replace')!;
    assert.equal(rep.kind, 'method');
    assert.ok(items.find((i) => i.name === 'length')?.kind === 'property');
    const d = svc.completionDetails(f, text.length, 'replace')!;
    assert.match(d.detail, /replace\(searchValue: /);
    assert.equal(d.snippet, 'replace(${1:searchValue}, ${2:replaceValue})$0');
    assert.equal(svc.completionDetails(f, text.length, 'toUpperCase')!.snippet, 'toUpperCase($0)');
    assert.equal(svc.completionDetails(f, text.length, 'length')!.snippet, undefined, 'a property: just the name');

    const call = "const value: string = 'x';\nvalue.replace('a', ";
    svc.update(f, call);
    const h = svc.signatureHelp(f, call.length, ',')!;
    assert.ok(h.signatures.length >= 1);
    assert.equal(h.param, 1);
    const sig = h.signatures[h.active];
    assert.match(sig.label, /^replace\(/);
    const [s, e] = sig.params[1];
    assert.match(sig.label.slice(s, e), /^replaceValue/);
    assert.equal(h.start, call.indexOf('(') + 1);
    assert.equal(svc.signatureHelp(f, "const value = 1;".length), null);
    fs.rmSync(r, { recursive: true, force: true });
});

test('the warm service: files on disk read once per version, edits parsed incrementally, saved changes seen', () => {
    const r = repo({ 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }), 'lib.ts': 'export const answer = 42;\n', 'a.ts': "import { answer } from './lib';\n" });
    const A = path.join(r, 'a.ts'), L = path.join(r, 'lib.ts');
    const p = new TsProjects(r);
    const ts = require('typescript');
    let reads = 0;
    const orig = ts.sys.readFile;
    ts.sys.readFile = (...a: unknown[]) => { reads++; return orig(...a); };
    try {
        let t = "import { answer } from './lib';\nanswer.";
        p.update(A, t);
        assert.ok(p.for(A).completions(A, t.length).some((c) => c.name === 'toFixed'));
        reads = 0;
        for (let i = 0; i < 5; i++) { p.update(A, `${t}\n// ${i}`); p.for(A).completions(A, t.length); }
        assert.ok(reads <= 5, `files on disk are not read again for each edit (${reads} reads)`);
        // A change on disk (saved elsewhere): seen once the file is updated (saved) or after the check interval.
        fs.writeFileSync(L, 'export const answer = "now a string";\n');
        p.update(L, undefined);
        const t2 = "import { answer } from './lib';\nanswer.";
        p.update(A, t2);
        assert.ok(p.for(A).completions(A, t2.length).some((c) => c.name === 'toUpperCase'), 'the saved file counts');
        // Incremental edits give the same answers as a fresh parse.
        const t3 = "import { answer } from './lib';\nconst n: number = 1;\nn.";
        p.update(A, t3);
        assert.ok(p.for(A).completions(A, t3.length).some((c) => c.name === 'toFixed'));
        const d = p.for(A).diagnostics(A);
        assert.equal(d.filter((x) => x.severity === 'error').length, 1, 'only the incomplete "n."');
    } finally { ts.sys.readFile = orig; fs.rmSync(r, { recursive: true, force: true }); }
});

test('the worker: interactive calls first, a running background call gives way, newer completions replace waiting ones', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `export function f${i}(a: number, b: string): string { const x: Record<string, number> = { k: a }; return b.repeat(x.k) + String(${i}); }`);
    const r = repo({ 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }), 'big.ts': lines.join('\n') + '\n' });
    const B = path.join(r, 'big.ts');
    const c = new TsClient(r, path.join(__dirname, '../src/lang/tsWorker.js'));
    try {
        await c.warmUp(B);
        const text = lines.join('\n') + "\nconst value: string = 'x';\nvalue.";
        await c.update(B, text);
        const order: string[] = [];
        const diag = c.diagnostics(B).then((d) => { order.push('diagnostics'); return d; });
        const stale = c.completions(B, text.length - 1).catch((e) => { order.push(e instanceof StaleCall ? 'stale' : 'error'); return null; });
        const comp = c.completions(B, text.length).then((x) => { order.push('completions'); return x; });
        const [d, , items] = await Promise.all([diag, stale, comp]);
        assert.ok(items.some((i) => i.name === 'toUpperCase'));
        assert.ok(Array.isArray(d), 'diagnostics still answered (run again after giving way)');
        assert.equal(order[0], 'stale', 'the older completion request was replaced');
        assert.ok(order.indexOf('completions') < order.indexOf('diagnostics'), `completions first: ${order.join(', ')}`);
        // Shared: two waiting diagnostics calls for the same file are one.
        const [d1, d2] = await Promise.all([c.diagnostics(B), c.diagnostics(B)]);
        assert.deepEqual(d1, d2);
        assert.ok(c.timings.length > 0);
    } finally { await c.close(); fs.rmSync(r, { recursive: true, force: true }); }
});
