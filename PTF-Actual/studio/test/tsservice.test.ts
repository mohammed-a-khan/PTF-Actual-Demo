import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TsService } from '../src/lang/tsService';

let root: string; let svc: TsService;
before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ts-'));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, experimentalDecorators: true, skipLibCheck: true }, include: ['src/**/*.ts'] }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/pages.ts'), '/** Orders page */\nexport class OrdersPage {\n    /** Open an order */\n    open(id: string): number { return id.length; }\n}\n');
    fs.writeFileSync(path.join(root, 'src/steps.ts'), "import { OrdersPage } from './pages';\nconst p = new OrdersPage();\np.open('a');\n");
    svc = new TsService(root);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('uses the project tsconfig', () => { assert.equal(svc.configPath, path.join(root, 'tsconfig.json')); });

test('diagnostics follow unsaved edits', () => {
    const f = path.join(root, 'src/steps.ts');
    assert.deepEqual(svc.diagnostics(f).filter((d) => d.severity === 'error'), []);
    svc.update(f, "import { OrdersPage } from './pages';\nconst p = new OrdersPage();\np.open(42);\n");
    const d = svc.diagnostics(f).filter((x) => x.severity === 'error');
    assert.equal(d.length, 1);
    assert.equal(d[0].line, 3);
    assert.equal(d[0].column, 8);
    assert.match(d[0].message, /number.*string/);
    svc.update(f, undefined);
});

test('completions, hover, definition, references, format', () => {
    const f = path.join(root, 'src/steps.ts');
    const text = "import { OrdersPage } from './pages';\nconst p = new OrdersPage();\np.";
    svc.update(f, text);
    assert.ok(svc.completions(f, text.length).some((c) => c.name === 'open'));
    const t2 = "import { OrdersPage } from './pages';\nconst p = new OrdersPage();\np.open('a');\n";
    svc.update(f, t2);
    const off = t2.indexOf('open');
    const q = svc.quickInfo(f, off)!;
    assert.match(q.text, /open\(id: string\): number/);
    assert.equal(q.doc, 'Open an order');
    assert.deepEqual(svc.definition(f, off).map((d) => [d.path, d.line]), [['src/pages.ts', 4]]);
    assert.equal(svc.references(f, off).length, 2);
    svc.update(f, 'const  x=1;\nif(x){\nconsole.log( x )}\n');
    assert.equal(svc.format(f), 'const x = 1;\nif (x) {\n    console.log(x)\n}\n');
});

test('nearest tsconfig, project references, JS files, project problems, worker', async () => {
    const { TsProjects } = await import('../src/lang/tsService');
    const { TsClient } = await import('../src/lang/tsClient');
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tsm-'));
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), t); };
    w('tsconfig.json', JSON.stringify({ files: [], references: [{ path: './packages/api' }] }));
    w('packages/api/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, composite: true }, include: ['src'] }));
    w('packages/api/src/a.ts', 'export function f(x) { return x; }\n'); // strict → implicit any
    w('tools/tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }));
    w('tools/b.ts', 'export function g(x) { return x; }\n');
    w('scripts/c.js', 'const n = 1;\nn.toFixed();\n');
    w('bad/tsconfig.json', JSON.stringify({ compilerOptions: { outFile: 'x.js', module: 'commonjs', composite: true, declaration: false } }));
    const p = new TsProjects(r);
    const A = path.join(r, 'packages/api/src/a.ts');
    assert.equal(p.for(A).configPath, path.join(r, 'packages/api/tsconfig.json'));
    assert.ok(p.for(A).diagnostics(A).some((d) => d.code === 7006));
    const B = path.join(r, 'tools/b.ts');
    assert.ok(!p.for(B).diagnostics(B).some((d) => d.code === 7006));
    const C = path.join(r, 'scripts/c.js');
    p.update(C, fs.readFileSync(C, 'utf8'));
    assert.ok(p.for(C).completions(C, 'const n = 1;\nn.'.length).some((c) => c.name === 'toFixed'));
    assert.ok(p.projectDiagnostics(path.join(r, 'bad/tsconfig.json')).some((d) => d.severity === 'error'));

    const c = new TsClient(r, path.join(__dirname, '../src/lang/tsWorker.js'));
    await c.update(B, 'export const s: string = 1;\n');
    const d = await c.diagnostics(B);
    assert.ok(d.some((x) => x.code === 2322));
    await c.close();
    fs.rmSync(r, { recursive: true, force: true });
});
