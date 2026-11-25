import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { frameworkPackage, frameworkPackageName } from '../src/framework/package';
import { convertScript } from '../src/recorder/convert';
import { plan } from '../src/recorder/generate';
import { ensureImports, generateStep, insertStep } from '../src/lang/stepGen';
import { scaffoldProject } from '../src/framework/scaffold';
import type { ProjectContext } from '../src/framework/model';

const ORG = '@example.org/cs-playwright-test-framework';
const MAK = '@mdakhan.mak/cs-playwright-test-framework';

function repo(installed: string[], dependsOn?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-pkg-'));
    for (const name of installed) {
        const p = path.join(dir, 'node_modules', ...name.split('/'));
        fs.mkdirSync(path.join(p, 'dist', 'utils'), { recursive: true });
        fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name }));
        fs.writeFileSync(path.join(p, 'dist', 'utils', 'CSEncryptionUtil.js'), "exports.CSEncryptionUtil = { getInstance: () => ({ createEncryptedConfigValue: (t) => 'ENCRYPTED:x' + t.length }) };");
    }
    if (dependsOn) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [dependsOn]: '^1.55.0' } }));
    return dir;
}

test('framework package: @mdakhan.mak or the framework under another scope (@example.org), the one installed (package.json decides)', () => {
    const dirs = [repo([ORG], ORG), repo([MAK]), repo([MAK, ORG], ORG), repo([]), repo([], ORG)];
    try {
        assert.equal(frameworkPackage(dirs[0])?.name, ORG);
        assert.equal(frameworkPackage(dirs[1])?.name, MAK);
        assert.equal(frameworkPackage(dirs[2])?.name, ORG, 'both installed: the declared one');
        assert.equal(frameworkPackage(dirs[3]), null);
        assert.equal(frameworkPackageName(dirs[3]), MAK, 'default');
        assert.equal(frameworkPackageName(dirs[4]), ORG, 'declared, not installed yet');
        // A workspace package: the framework hoisted to the root.
        const nested = path.join(dirs[0], 'packages', 'tests');
        fs.mkdirSync(nested, { recursive: true });
        assert.equal(frameworkPackage(nested)?.dir, path.join(dirs[0], 'node_modules', '@example.org', 'cs-playwright-test-framework'));
    } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});

test('code the Studio writes imports from the framework under another scope when the repository uses it', () => {
    const ctx = { project: 'crm', env: 'dev', featureFolder: 'test/crm/features', pagesFolder: 'test/crm/pages', stepsFolder: 'test/crm/steps', dataFolder: 'test/crm/data', pages: [], steps: [], files: {},
        config: { exists: true, common: { path: 'config/crm/common/common.env', text: '' }, envFile: { path: 'config/crm/environments/dev.env', text: '' }, values: {}, stepPath: null, stepsLoaded: true } } as unknown as ProjectContext;
    const c = convertScript(ts, `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://crm.test/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
});`);
    const p = plan(ts, c.actions, ctx, { name: 'Login', pkg: ORG });
    const code = p.files.filter((f) => f.kind === 'page' || f.kind === 'steps').map((f) => f.text).join('\n');
    assert.match(code, /from '@example\.org\/cs-playwright-test-framework\/core'/);
    assert.match(code, /from '@example\.org\/cs-playwright-test-framework\/bdd'/);
    assert.doesNotMatch(code, /@mdakhan\.mak/);
    // A new step file, and a file that imports from the framework under another scope already (extended, not a second import).
    const g = generateStep('the user waits 5 seconds');
    assert.match(insertStep(null, g, 'the user waits 5 seconds', 'WaitSteps', `${ORG}/bdd`).content, /import \{ CSBDDStepDef, StepDefinitions \} from '@example\.org\/cs-playwright-test-framework\/bdd';/);
    const theirs = "import { StepDefinitions } from '@example.org/cs-playwright-test-framework/bdd';\n\n@StepDefinitions\nexport class S {}\n";
    const out = ensureImports(theirs, ['CSBDDStepDef', 'StepDefinitions'], '\n', `${MAK}/bdd`);
    assert.match(out, /^import \{ StepDefinitions, CSBDDStepDef \} from '@example\.org\/cs-playwright-test-framework\/bdd';$/m);
    assert.doesNotMatch(out, /@mdakhan\.mak/);
});

test('a new project in a repository with the framework under another scope loads its steps from it', () => {
    const dir = repo([ORG], ORG);
    try {
        const s = scaffoldProject(dir, { slug: 'crm', dbType: 'none', environments: [{ name: 'dev', baseUrl: 'https://crm.test' }] });
        assert.match(s.plan.files.find((f) => f.path.endsWith('common.env'))!.text, /^STEP_DEFINITIONS_PATH=test\/crm\/steps;test\/common\/steps;node_modules\/@example\.org\/cs-playwright-test-framework\/dist\/steps$/m);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
