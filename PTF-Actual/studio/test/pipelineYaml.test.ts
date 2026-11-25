import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { spawnSync } from 'child_process';
import { pipelineFile, testPipeline, validateTestPipeline } from '../src/run/pipelineYaml';

test('testPipeline: valid YAML; environment parameter, tags, workers, retries, secrets from the variable group, JUnit published', () => {
    const text = testPipeline({ name: 'Shop regression', project: 'shop', envs: ['qa', 'uat'], tags: '@regression and not @wip', workers: 4, retries: 1, schedule: '0 2 * * 1-5', prValidation: true, variableGroup: 'shop-secrets', secretNames: ['DB_PASSWORD', 'bad-name'], browser: 'chrome' });
    const y = YAML.parse(text);
    assert.deepEqual(y.parameters[0].values, ['qa', 'uat']);
    assert.deepEqual(y.pr.branches.include, ['main']);
    assert.equal(y.schedules[0].cron, '0 2 * * 1-5');
    assert.deepEqual(y.variables[0], { group: 'shop-secrets' });
    const steps = y.jobs[0].steps;
    const run = steps.find((s: { displayName?: string }) => s.displayName === 'Run Shop regression');
    assert.equal(run.script, 'npx cs-playwright-test --project=shop --env=${{ parameters.environment }} --headless=true "--tags=@regression and not @wip" --browser=chrome --parallel=4 --retry=1');
    assert.deepEqual(Object.keys(run.env), ['REPORT_TYPES', 'REPORTS_BASE_DIR', 'BROWSER_VIDEO', 'DB_PASSWORD']);
    assert.equal(run.env.DB_PASSWORD, '$(DB_PASSWORD)');
    assert.match(steps.find((s: { script?: string }) => /playwright install/.test(s.script ?? '')).script, /--with-deps chrome$/);
    const pub = steps.find((s: { task?: string }) => s.task === 'PublishTestResults@2');
    assert.equal(pub.inputs.testResultsFiles, '$(results)/**/junit-results.xml');
    assert.equal(pub.condition, 'succeededOrFailed()');
    assert.equal(pipelineFile('Shop regression!'), 'pipelines/shop-regression.yml');
});

test('testPipeline: several agents split the feature files; bad options refused', () => {
    const y = YAML.parse(testPipeline({ name: 'Split', project: 'shop', envs: ['qa'], agents: 3, features: ['test/shop/features/a.feature', 'test/shop/features/b.feature'] }));
    assert.equal(y.jobs[0].strategy.parallel, 3);
    const steps = y.jobs[0].steps;
    const choose = steps.find((s: { displayName?: string }) => /feature files/.test(s.displayName ?? ''));
    assert.match(choose.bash, /printf '%s\\n' 'test\/shop\/features\/a\.feature' 'test\/shop\/features\/b\.feature'/);
    assert.match(steps.find((s: { displayName?: string }) => s.displayName === 'Run Split').script, / \$\(features\)$/);
    assert.equal(YAML.parse(testPipeline({ name: 'One', project: 'shop', envs: ['qa'] })).pr, 'none');
    for (const [o, re] of [[{ envs: [] }, /environment/], [{ name: "it's" }, /name/], [{ agents: 50 }, /Agents/], [{ schedule: 'daily' }, /cron/], [{ features: ['../x.feature'] }, /feature/], [{ tags: '@a\n- script: evil' }, /Tags/]] as const) {
        assert.throws(() => testPipeline(Object.assign({ name: 'X', project: 'shop', envs: ['qa'] }, o) as never), re);
    }
});

test('testPipeline: the agent split picks every N-th file (the bash run for 2 of 3 agents)', { skip: process.platform === 'win32' }, () => {
    const y = YAML.parse(testPipeline({ name: 'S', project: 'shop', envs: ['qa'], agents: 3, features: ['a.feature', 'b.feature', 'c.feature', 'd.feature'] }));
    const bash = (y.jobs[0].steps.find((s: { bash?: string }) => s.bash).bash as string).replace(/\$\(System\.TotalJobsInPhase\)/g, '3').replace(/\$\(System\.JobPositionInPhase\)/g, '2');
    const r = spawnSync('bash', ['-c', bash], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /##vso\[task\.setvariable variable=features\]--features=b\.feature\n/);
    assert.match(r.stdout, /runs 1 of 4/);
});

test('pipeline route: preview, the secrets the tests use, write to pipelines/ (replace only when asked)', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
    try {
        const dir = path.join(tmp, 'shop-tests');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('config/shop/common/common.env', 'PROJECT=shop\nDB_PASSWORD={{secret:DB_PASSWORD}}\n');
        w('config/shop/environments/qa.env', 'BASE_URL=http://localhost\n');
        w('config/shop/environments/uat.env', 'BASE_URL=http://localhost\n');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk' });
        const call = async (payload: unknown) => { const r = await srv.app.inject({ method: 'POST', url: '/api/pipeline/tests', headers: { authorization: 'Bearer tk' }, payload: payload as never }); return { status: r.statusCode, json: r.json() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const pre = await call({ name: 'Nightly', project: 'shop', envs: ['qa'], tags: '@smoke', schedule: '0 1 * * *' });
        assert.equal(pre.status, 200, JSON.stringify(pre.json));
        assert.equal(pre.json.file, 'pipelines/nightly.yml');
        assert.equal(pre.json.saved, false);
        assert.ok(!fs.existsSync(path.join(dir, 'pipelines/nightly.yml')));
        assert.equal((await call({ name: 'N', project: 'shop', envs: ['prod'] })).status, 400);
        assert.equal((await call({ name: 'Nightly', project: 'shop', save: true })).status, 200);
        assert.match(fs.readFileSync(path.join(dir, 'pipelines/nightly.yml'), 'utf8'), /values: \[qa, uat\]/);
        assert.equal((await call({ name: 'Nightly', project: 'shop', save: true })).status, 400, 'exists');
        assert.equal((await call({ name: 'Nightly', project: 'shop', save: true, overwrite: true })).status, 200);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('testPipeline: a fix mission job when the tests fail (unattended; report in the summary; branch pushed)', () => {
    const y = YAML.parse(testPipeline({ name: 'Nightly', project: 'shop', envs: ['qa'], tags: '@smoke', fixMission: { minutes: 30, pushBranch: true }, secretNames: ['DB_PASSWORD'] }));
    const fix = y.jobs.find((j: { job: string }) => j.job === 'fix');
    assert.equal(fix.dependsOn, 'tests');
    assert.equal(fix.condition, 'failed()');
    assert.equal(fix.steps[0].persistCredentials, true);
    const run = fix.steps.find((s: { displayName?: string }) => s.displayName === 'Mission: fix the failed tests');
    assert.match(run.script, /npx cs-test-studio mission fix-failing --input project=shop --input env=\$\{\{ parameters.environment \}\} --input "tags=@smoke" --minutes 30 --junit "/);
    assert.deepEqual(Object.keys(run.env), ['CS_STUDIO_HOME', 'AGENTS_PROVIDER', 'AGENTS_BASE_URL', 'AGENTS_MODEL', 'AGENTS_PROVIDER_API_KEY', 'COPILOT_GITHUB_TOKEN', 'DB_PASSWORD']);
    assert.ok(fix.steps.some((s: { script?: string }) => /npm install .*--prefix "\$\(Agent.TempDirectory\)\/studio-home\/agents-runtime" @github\/copilot-sdk@\d/.test(s.script ?? '')), 'the agents runtime is installed');
    assert.ok(fix.steps.some((s: { script?: string }) => /task.uploadsummary/.test(s.script ?? '')));
    assert.ok(fix.steps.some((s: { displayName?: string }) => s.displayName === 'Push the mission branch for review'));
    assert.equal(YAML.parse(testPipeline({ name: 'N', project: 'shop', envs: ['qa'] })).jobs.length, 1);
    assert.throws(() => testPipeline({ name: 'N', project: 'shop', envs: ['qa'], fixMission: { minutes: 999 } }), /Fix mission minutes/);
});

test('testPipeline: Windows agents get batch-file and PowerShell syntax; the tag expression stays one argument in bash', { skip: process.platform === 'win32' }, () => {
    const y = YAML.parse(testPipeline({ name: 'Win', project: 'shop', envs: ['qa'], tags: '@smoke and not @wip', agentOs: 'windows', pool: 'Default', agents: 2, fixMission: { pushBranch: true } }));
    const [tests, fix] = y.jobs;
    assert.deepEqual(tests.pool, { name: 'Default' });
    assert.ok(tests.steps.some((s: { powershell?: string }) => /\$mine = @\(for/.test(s.powershell ?? '')), 'split in PowerShell');
    assert.ok(!JSON.stringify(y).includes('- bash'), 'no bash');
    assert.match(tests.steps.find((s: { script?: string }) => /playwright install/.test(s.script ?? '')).script, /^npx playwright install chromium$/);
    const m = fix.steps.find((s: { displayName?: string }) => s.displayName === 'Mission: fix the failed tests');
    assert.match(m.script, /\ncall npx cs-test-studio mission/, 'call: a batch file goes on after npx');
    assert.ok(fix.steps.some((s: { powershell?: string }) => /Write-Host "##vso\[task.uploadsummary\]/.test(s.powershell ?? '')));
    assert.ok(fix.steps.some((s: { powershell?: string }) => /ForEach-Object \{ git push origin \$_; if \(\$LASTEXITCODE\) \{ exit \$LASTEXITCODE \} \}/.test(s.powershell ?? '')));
    // Linux: the run line through bash with a stand-in npx prints one argument per line.
    const lin = YAML.parse(testPipeline({ name: 'L', project: 'shop', envs: ['qa'], tags: '@smoke and not @wip' }));
    const line = lin.jobs[0].steps.find((s: { displayName?: string }) => s.displayName === 'Run L').script.replace('${{ parameters.environment }}', 'qa');
    const r = spawnSync('bash', ['-c', `npx() { printf '%s\\n' "$@"; }; ${line}`], { encoding: 'utf8' });
    assert.ok(r.stdout.split('\n').includes('--tags=@smoke and not @wip'), r.stdout);
});

test('testPipeline: a private package feed (its .npmrc and sign-in) and npm install without a lock file', () => {
    const reg = 'https://pkgs.dev.azure.com/acme/_packaging/fw/npm/registry/';
    const w = YAML.parse(testPipeline({ name: 'F', project: 'shop', envs: ['qa'], agentOs: 'windows', install: { ci: false, registry: reg } }));
    const st = w.jobs[0].steps;
    assert.equal(st.find((s: { displayName?: string }) => s.displayName === 'Use the package feed').powershell, `Set-Content -Path .npmrc -Value "registry=${reg}\`nalways-auth=true" -NoNewline`);
    assert.deepEqual(st.find((s: { task?: string }) => s.task === 'npmAuthenticate@0').inputs, { workingFile: '.npmrc' });
    assert.equal(st.find((s: { displayName?: string }) => s.displayName === 'Install').script, 'npm install --no-audit --no-fund');
    const l = YAML.parse(testPipeline({ name: 'F', project: 'shop', envs: ['qa'], install: { ci: true, registry: reg } })).jobs[0].steps;
    const r = spawnSync('bash', ['-c', `cd "$(mktemp -d)" && ${l.find((s: { displayName?: string }) => s.displayName === 'Use the package feed').script} && cat .npmrc`], { encoding: 'utf8' });
    assert.equal(r.stdout, `registry=${reg}\nalways-auth=true\n`);
    assert.throws(() => testPipeline({ name: 'F', project: 'shop', envs: ['qa'], install: { registry: 'http://x$(evil)' } }), /https/);
});

test('testPipeline: the team\'s agents evaluated beside the tests (every agent runs; fails on a failure, or only on a regression)', () => {
    const lin = YAML.parse(testPipeline({ name: 'Shop', project: 'shop', envs: ['qa'], evalAgents: { agents: ['catalog-checker', 'failure-analyst'] } }));
    const job = lin.jobs.find((j: { job: string }) => j.job === 'evals');
    assert.ok(job && !job.dependsOn && !job.condition, 'beside the tests');
    const run = job.steps.find((s: { displayName?: string }) => s.displayName === 'Evaluate catalog-checker, failure-analyst');
    assert.match(run.script, /npx cs-test-studio eval catalog-checker --junit "\$\(Agent.TempDirectory\)\/evals\/catalog-checker.xml" \|\| failed=1\n.*npx cs-test-studio eval failure-analyst .* \|\| failed=1\nexit \$failed/s);
    assert.equal(run.env.COPILOT_GITHUB_TOKEN, '$(COPILOT_GITHUB_TOKEN)');
    assert.ok(job.steps.some((s: { script?: string }) => /@github\/copilot-sdk@/.test(s.script ?? '')));
    assert.equal(job.steps.at(-1).inputs.testResultsFiles, '$(Agent.TempDirectory)/evals/*.xml');
    const win = YAML.parse(testPipeline({ name: 'Shop', project: 'shop', envs: ['qa'], agentOs: 'windows', pool: 'Default', evalAgents: { agents: ['catalog-checker'], allowFailures: true } }));
    const wrun = win.jobs.find((j: { job: string }) => j.job === 'evals').steps.find((s: { displayName?: string }) => s.displayName === 'Evaluate catalog-checker');
    assert.equal(wrun.script, 'set FAILED=0\ncall npx cs-test-studio eval catalog-checker --junit "$(Agent.TempDirectory)/evals/catalog-checker.xml" --allow-failures\nif errorlevel 1 set FAILED=1\nexit /b %FAILED%\n');
    assert.throws(() => validateTestPipeline({ name: 'S', project: 'shop', envs: ['qa'], evalAgents: { agents: [] } }), /Choose the agents/);
    assert.throws(() => validateTestPipeline({ name: 'S', project: 'shop', envs: ['qa'], evalAgents: { agents: ['Bad Agent'] } }), /Not an agent id/);
});
