/**
 * An Azure DevOps pipeline (YAML) that runs the framework's tests: on a schedule, on pushes, as pull request
 * validation. The environment is a run-time parameter; secrets come from a variable group as environment variables
 * (the framework reads configuration from the environment first); the results are published as test results
 * (JUnit), and the HTML report is kept as an artifact. Several agents split the feature files between them.
 */
import { UserError } from '../core/errors';
import { SDK_TESTED_VERSION as AGENTS_RUNTIME } from '../agents/runtime';

/** A run name as an Azure DevOps build number: without the characters it refuses (" / : < > \\ | ? @ *). */
const buildName = (n: string) => n.replace(/["/:<>\\|?@*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 200) || 'Tests';

export interface TestPipelineOptions {
    name: string; project: string; envs: string[];
    tags?: string; features?: string[];
    browser?: 'chromium' | 'chrome' | 'msedge' | 'firefox' | 'webkit';
    workers?: number; retries?: number;
    /** Agents that split the feature files between them (1–20). */
    agents?: number;
    schedule?: string; branch?: string; prValidation?: boolean;
    variableGroup?: string; secretNames?: string[];
    pool?: string; nodeVersion?: string; timeoutMinutes?: number;
    /** The agents' operating system: Windows agents get PowerShell and batch-file syntax (default: linux). */
    agentOs?: 'linux' | 'windows';
    /** How packages install: npm ci needs a lock file; a private feed (Azure Artifacts) gets an .npmrc and npmAuthenticate. */
    install?: { ci?: boolean; registry?: string };
    /**
     * When tests fail: a "fix a failed run" mission (unattended) in a second job; its report in the run's summary, its
     * branch pushed for review. The model key comes from the variable group (AGENTS_PROVIDER_API_KEY or COPILOT_GITHUB_TOKEN).
     */
    fixMission?: { minutes?: number; pushBranch?: boolean };
    /**
     * The team's agents evaluated on every run (their cases in .cs-studio/evals): a job beside the tests, JUnit results;
     * it fails on a failing case, or with allowFailures only when a case that passed before fails now.
     */
    evalAgents?: { agents: string[]; allowFailures?: boolean };
}

const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const NAME_RE = /^[A-Za-z_][\w]*$/;
// Install the browser the tests use (Chrome and Edge are installed on Microsoft-hosted agents).
const INSTALL: Record<string, string> = { chromium: 'chromium', chrome: 'chrome', msedge: 'msedge', firefox: 'firefox', webkit: 'webkit' };

export function validateTestPipeline(o: TestPipelineOptions): TestPipelineOptions {
    if (!o.name?.trim() || o.name.length > 100 || /[\n']/.test(o.name)) throw new UserError('Give the pipeline a name (one line, no quotes).');
    if (!/^[\w.-]{1,100}$/.test(o.project ?? '')) throw new UserError('Choose a project.');
    if (!o.envs?.length || o.envs.some((e) => !/^[\w.-]{1,60}$/.test(e))) throw new UserError('Choose at least one environment.');
    if (o.tags && (/[\n'"]/.test(o.tags) || o.tags.length > 300)) throw new UserError('Tags: one line, no quotes.');
    for (const f of o.features ?? []) if (!/^[\w./ -]{1,300}\.feature$/.test(f) || f.includes('..')) throw new UserError(`Not a feature file: ${f}`);
    if (o.browser && !INSTALL[o.browser]) throw new UserError('Unknown browser.');
    const int = (v: number | undefined, lo: number, hi: number, what: string) => { if (v !== undefined && (!Number.isInteger(v) || v < lo || v > hi)) throw new UserError(`${what}: ${lo} to ${hi}.`); };
    int(o.workers, 1, 16, 'Workers per agent'); int(o.retries, 0, 5, 'Retries'); int(o.agents, 1, 20, 'Agents'); int(o.timeoutMinutes, 5, 720, 'Time limit (minutes)');
    if (o.schedule && !/^(\S+\s+){4}\S+$/.test(o.schedule.trim())) throw new UserError('The schedule is a cron line with five fields, e.g. "0 2 * * 1-5" (02:00 UTC on weekdays).');
    if (o.branch && !/^[\w./-]{1,100}$/.test(o.branch)) throw new UserError('Not a branch name.');
    if (o.variableGroup && /[\n']/.test(o.variableGroup)) throw new UserError('Variable group: one line, no quotes.');
    if (o.pool && /[\n']/.test(o.pool)) throw new UserError('Agent pool: one line, no quotes.');
    if (o.fixMission) int(o.fixMission.minutes, 5, 240, 'Fix mission minutes');
    if (o.evalAgents) {
        if (!o.evalAgents.agents?.length || o.evalAgents.agents.length > 20) throw new UserError('Choose the agents to evaluate (1 to 20).');
        for (const a of o.evalAgents.agents) if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(a)) throw new UserError(`Not an agent id: ${a}`);
    }
    if (o.agentOs && !['linux', 'windows'].includes(o.agentOs)) throw new UserError('Agents run on linux or windows.');
    if (o.install?.registry && !/^https:\/\/[\w.-]+\/[^\s'"`$]*$/.test(o.install.registry)) throw new UserError('The package feed is an https address.');
    return { ...o, secretNames: (o.secretNames ?? []).filter((n) => NAME_RE.test(n)) };
}

export function testPipeline(input: TestPipelineOptions): string {
    const o = validateTestPipeline(input);
    const branch = o.branch ?? 'main';
    const agents = o.agents ?? 1;
    const browser = o.browser ?? 'chromium';
    const args = [`--project=${o.project}`, '--env=${{ parameters.environment }}', '--headless=true',
        ...(o.features?.length && agents === 1 ? [`--features=${o.features.join(',')}`] : []),
        // Quoted: a tag expression has spaces ("@smoke and not @wip"); double quotes work in bash and cmd.
        ...(o.tags?.trim() ? [`"--tags=${o.tags.trim()}"`] : []),
        ...(o.browser ? [`--browser=${o.browser}`] : []),
        `--parallel=${(o.workers ?? 1) > 1 ? o.workers : 'false'}`,
        ...(o.retries ? [`--retry=${o.retries}`] : [])];
    const env = [
        '        REPORT_TYPES: html,json,junit',
        '        REPORTS_BASE_DIR: $(results)',
        '        BROWSER_VIDEO: retain-on-failure',
        ...o.secretNames!.map((n) => `        ${n}: $(${n})`),
    ];
    // Several agents: each takes every N-th feature file (sorted, so the split is stable).
    const win = o.agentOs === 'windows';
    const split = agents > 1 && win ? [
        '    - powershell: |',
        `        $all = @(${o.features?.length ? o.features.map(q).join(', ') : `Get-ChildItem -Recurse -Filter *.feature test/${o.project} | ForEach-Object { (Resolve-Path -Relative $_.FullName).TrimStart('.', '\\').Replace('\\', '/') } | Sort-Object`})`,
        '        $mine = @(for ($i = 0; $i -lt $all.Count; $i++) { if ($i % $(System.TotalJobsInPhase) -eq $(System.JobPositionInPhase) - 1) { $all[$i] } })',
        '        if ($mine.Count -eq 0) { Write-Host "##vso[task.setvariable variable=features]" } else { Write-Host "##vso[task.setvariable variable=features]--features=$($mine -join \',\')" }',
        '        Write-Host "This agent runs $($mine.Count) of $($all.Count) feature files."',
        '      displayName: Choose this agent\'s feature files',
    ] : agents > 1 ? [
        '    - bash: |',
        '        set -euo pipefail',
        `        mapfile -t all < <(${o.features?.length ? `printf '%s\\n' ${o.features.map(q).join(' ')}` : `find test/${o.project} -name '*.feature' | sort`})`,
        '        mine=()',
        '        for i in "${!all[@]}"; do if (( i % $(System.TotalJobsInPhase) == $(System.JobPositionInPhase) - 1 )); then mine+=("${all[$i]}"); fi; done',
        '        if (( ${#mine[@]} == 0 )); then echo "##vso[task.setvariable variable=features]"; else echo "##vso[task.setvariable variable=features]--features=$(IFS=,; echo "${mine[*]}")"; fi',
        '        echo "This agent runs ${#mine[@]} of ${#all[@]} feature files."',
        '      displayName: Choose this agent\'s feature files',
    ] : [];
    return [
        `# ${o.name}: the ${o.project} tests with the CS Playwright Test Framework. Made with CS Test Studio.`,
        '# Secrets come from the variable group as environment variables (the framework reads them before its .env files).',
        `name: ${q(`${buildName(o.name)} $(Date:yyyyMMdd)$(Rev:.r)`)}`,
        '',
        `trigger:\n  branches:\n    include: [${branch}]\n  paths:\n    include: [${q(`test/${o.project}/*`)}, ${q(`config/${o.project}/*`)}, 'package.json', 'package-lock.json']`,
        o.prValidation ? `\npr:\n  branches:\n    include: [${branch}]` : '\npr: none',
        ...(o.schedule ? ['', `schedules:\n  - cron: ${q(o.schedule.trim())}\n    displayName: ${q(`${o.name} (scheduled)`)}\n    branches:\n      include: [${branch}]\n    always: true`] : []),
        '',
        `parameters:\n  - name: environment\n    displayName: Environment\n    type: string\n    default: ${o.envs[0]}\n    values: [${o.envs.join(', ')}]`,
        '',
        `variables:${o.variableGroup ? `\n  - group: ${q(o.variableGroup)}` : ''}\n  - name: results\n    value: $(Agent.TempDirectory)/test-results`,
        '',
        'jobs:',
        '  - job: tests',
        `    displayName: ${q(o.name)}`,
        `    timeoutInMinutes: ${o.timeoutMinutes ?? 120}`,
        ...(agents > 1 ? [`    strategy:\n      parallel: ${agents}`] : []),
        o.pool ? `    pool:\n      name: ${q(o.pool)}` : '    pool:\n      vmImage: ubuntu-latest',
        '    steps:',
        '    - checkout: self',
        `    - task: UseNode@1\n      inputs:\n        version: ${q(o.nodeVersion ?? '20.x')}`,
        ...installSteps(o),
        `    - script: npx playwright install ${win ? '' : '--with-deps '}${INSTALL[browser]}\n      displayName: Install the browser`,
        ...split,
        `    - script: npx cs-playwright-test ${args.join(' ')}${agents > 1 ? ' $(features)' : ''}`,
        `      displayName: ${q(`Run ${o.name}`)}`,
        '      env:',
        ...env,
        `    - task: PublishTestResults@2\n      condition: succeededOrFailed()\n      inputs:\n        testResultsFormat: JUnit\n        testResultsFiles: '$(results)/**/junit-results.xml'\n        mergeTestResults: true\n        testRunTitle: ${q(`${o.name} (\${{ parameters.environment }})${agents > 1 ? ' agent $(System.JobPositionInPhase)' : ''}`)}\n        failTaskOnFailedTests: true`,
        `    - publish: $(results)\n      artifact: test-report-$(System.JobPositionInPhase)-$(System.JobAttempt)\n      condition: succeededOrFailed()\n      displayName: Keep the report`,
        ...(o.fixMission ? fixJob(o) : []),
        ...(o.evalAgents ? evalJob(o) : []),
        '',
    ].join('\n');
}

export const pipelineFile = (name: string) => `pipelines/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tests'}.yml`;

/** The model variables agents read on the agent (the same as the fix mission's). */
const AGENT_ENV = ['        CS_STUDIO_HOME: $(Agent.TempDirectory)/studio-home', '        AGENTS_PROVIDER: $(AGENTS_PROVIDER)', '        AGENTS_BASE_URL: $(AGENTS_BASE_URL)', '        AGENTS_MODEL: $(AGENTS_MODEL)', '        AGENTS_PROVIDER_API_KEY: $(AGENTS_PROVIDER_API_KEY)', '        COPILOT_GITHUB_TOKEN: $(COPILOT_GITHUB_TOKEN)'];

/** The agents' evaluations: beside the tests (they change nothing), one JUnit file per agent. */
function evalJob(o: TestPipelineOptions): string[] {
    const e = o.evalAgents!;
    const win = o.agentOs === 'windows';
    const each = e.agents.map((a) => `${win ? 'call ' : ''}npx cs-test-studio eval ${a} --junit "$(Agent.TempDirectory)/evals/${a}.xml"${e.allowFailures ? ' --allow-failures' : ''}`);
    return [
        '  - job: evals',
        `    displayName: ${q('Evaluate the team\'s agents (CS Test Studio)')}`,
        `    timeoutInMinutes: ${Math.min(30 * e.agents.length, 240)}`,
        o.pool ? `    pool:\n      name: ${q(o.pool)}` : '    pool:\n      vmImage: ubuntu-latest',
        '    steps:',
        '    - checkout: self',
        `    - task: UseNode@1\n      inputs:\n        version: ${q(o.nodeVersion ?? '20.x')}`,
        ...installSteps(o),
        `    - script: npm install --no-audit --no-fund --prefix "$(Agent.TempDirectory)/studio-home/agents-runtime" @github/copilot-sdk@${AGENTS_RUNTIME}\n      displayName: Install the agents runtime`,
        // Every agent runs even when one fails; the step fails at the end when any did.
        ...(win ? ['    - script: |', '        set FAILED=0', ...each.flatMap((c) => [`        ${c}`, '        if errorlevel 1 set FAILED=1']), '        exit /b %FAILED%']
            : ['    - script: |', '        failed=0', ...each.map((c) => `        ${c} || failed=1`), '        exit $failed']),
        `      displayName: ${q(`Evaluate ${e.agents.join(', ')}`)}`,
        '      env:',
        ...AGENT_ENV,
        `    - task: PublishTestResults@2\n      condition: succeededOrFailed()\n      inputs:\n        testResultsFormat: JUnit\n        testResultsFiles: '$(Agent.TempDirectory)/evals/*.xml'\n        mergeTestResults: true\n        testRunTitle: ${q(`${o.name}: agent evaluations`)}`,
    ];
}

/** The fix mission's job: runs only when the tests failed. */
function fixJob(o: TestPipelineOptions): string[] {
    const f = o.fixMission!;
    const win = o.agentOs === 'windows';
    const inputs = [`--input project=${o.project}`, '--input env=${{ parameters.environment }}', ...(o.tags?.trim() ? [`--input "tags=${o.tags.trim()}"`] : [])].join(' ');
    return [
        '  - job: fix',
        `    displayName: ${q('Fix the failures (CS Test Studio mission)')}`,
        '    dependsOn: tests',
        '    condition: failed()',
        `    timeoutInMinutes: ${(f.minutes ?? 45) + 20}`,
        o.pool ? `    pool:\n      name: ${q(o.pool)}` : '    pool:\n      vmImage: ubuntu-latest',
        '    steps:',
        `    - checkout: self${f.pushBranch ? '\n      persistCredentials: true' : ''}`,
        // The agents' runtime (the Copilot SDK) next to the Studio's data on the agent.
        `    - task: UseNode@1\n      inputs:\n        version: ${q(o.nodeVersion ?? '20.x')}`,
        ...installSteps(o),
        `    - script: npx playwright install ${win ? '' : '--with-deps '}${INSTALL[o.browser ?? 'chromium']}\n      displayName: Install the browser`,
        `    - script: npm install --no-audit --no-fund --prefix "$(Agent.TempDirectory)/studio-home/agents-runtime" @github/copilot-sdk@${AGENTS_RUNTIME}\n      displayName: Install the agents runtime`,
        '    - script: |',
        '        git config user.name "CS Test Studio mission"',
        '        git config user.email "missions@cs-test-studio.local"',
        `        ${win ? 'call ' : ''}npx cs-test-studio mission fix-failing ${inputs} --minutes ${f.minutes ?? 45} --junit "$(Agent.TempDirectory)/mission/junit.xml" --md "$(Agent.TempDirectory)/mission/report.md" --json "$(Agent.TempDirectory)/mission/mission.json"`,
        `      displayName: ${q('Mission: fix the failed tests')}`,
        '      env:',
        '        CS_STUDIO_HOME: $(Agent.TempDirectory)/studio-home',
        '        AGENTS_PROVIDER: $(AGENTS_PROVIDER)',
        '        AGENTS_BASE_URL: $(AGENTS_BASE_URL)',
        '        AGENTS_MODEL: $(AGENTS_MODEL)',
        '        AGENTS_PROVIDER_API_KEY: $(AGENTS_PROVIDER_API_KEY)',
        '        COPILOT_GITHUB_TOKEN: $(COPILOT_GITHUB_TOKEN)',
        ...o.secretNames!.map((n) => `        ${n}: $(${n})`),
        win ? '    - powershell: Write-Host "##vso[task.uploadsummary]$(Agent.TempDirectory)/mission/report.md"\n      condition: succeededOrFailed()\n      displayName: Mission report in the summary'
            : '    - script: echo "##vso[task.uploadsummary]$(Agent.TempDirectory)/mission/report.md"\n      condition: succeededOrFailed()\n      displayName: Mission report in the summary',
        ...(f.pushBranch ? (win ? ['    - powershell: |',
            '        git for-each-ref --format="%(refname:short)" refs/heads/cs-studio/ | ForEach-Object { git push origin $_; if ($LASTEXITCODE) { exit $LASTEXITCODE } }',
            '      condition: succeeded()',
            `      displayName: ${q('Push the mission branch for review')}`] : ['    - script: |',
            '        set -e',
            '        for b in $(git for-each-ref --format="%(refname:short)" refs/heads/cs-studio/); do git push origin "$b"; done',
            '      condition: succeeded()',
            `      displayName: ${q('Push the mission branch for review')}`]) : []),
        `    - task: PublishTestResults@2\n      condition: succeededOrFailed()\n      inputs:\n        testResultsFormat: JUnit\n        testResultsFiles: '$(Agent.TempDirectory)/mission/junit.xml'\n        testRunTitle: ${q(`${o.name}: fix mission`)}`,
    ];
}

/** Packages: the private feed's .npmrc and sign-in (as the team's own pipelines do), then npm ci (lock file) or npm install. */
function installSteps(o: TestPipelineOptions): string[] {
    const reg = o.install?.registry;
    const win = o.agentOs === 'windows';
    return [
        ...(reg ? [
            win ? `    - powershell: Set-Content -Path .npmrc -Value "registry=${reg}\`nalways-auth=true" -NoNewline\n      displayName: Use the package feed`
                : `    - script: printf 'registry=%s\\nalways-auth=true\\n' ${q(reg)} > .npmrc\n      displayName: Use the package feed`,
            '    - task: npmAuthenticate@0\n      inputs:\n        workingFile: .npmrc\n      displayName: Sign in to the package feed',
        ] : []),
        `    - script: ${o.install?.ci === false ? 'npm install --no-audit --no-fund' : 'npm ci'}\n      displayName: Install`,
    ];
}
