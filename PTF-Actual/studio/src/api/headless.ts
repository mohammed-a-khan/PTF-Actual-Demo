/**
 * A collection run without the Studio (a pipeline, a terminal): `cs-test-studio run <collection>`, like Newman. The
 * configuration of the environment ({config:KEY}), the secrets as environment variables ({env:NAME}; vault
 * references read), test data rows, iterations; each request printed with its checks; JUnit / JSON / HTML results.
 * And the Azure DevOps pipeline that runs it and publishes the results.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CollectionRunner, RunnerJob, runnerJUnit, runnerReport } from './runner';
import { readCollection } from './store';
import { allRequests, ApiRequest } from './model';
import { projectFileReader, valuesFor, withVault } from '../load/prepare';
import { SecretVault } from './vault';
import { maskSecrets } from '../run/runner';
import type { Connection } from '../core/network';

export interface HeadlessOptions {
    env?: string;
    iterations?: number;
    /** Test data rows (from a file or another source, loaded by the caller). */
    rows?: Array<Record<string, string>>;
    /** Only the requests of this folder (or with this name). */
    folder?: string;
    delayMs?: number;
    bail?: boolean;
    timeoutMs?: number;
    /** Extra {{name}} values (--var name=value), above the collection's variables. */
    vars?: Record<string, string>;
    connection?: Connection;
    secretEnv?: Record<string, string>;
    out?: (line: string) => void;
}

export async function runHeadless(root: string, file: string, o: HeadlessOptions = {}): Promise<RunnerJob> {
    const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
    const c = readCollection(root, rel);
    const project = rel.split('/')[1];
    const env = o.env ?? 'dev';
    const all = o.secretEnv ?? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
    // The secrets are the environment variables the collection reads ({env:NAME}; all of them are still readable):
    // only those are masked in what is printed and written.
    const used = new Set([...JSON.stringify(c).matchAll(/\{env:([\w.-]+)\}/g)].map((m) => m[1]));
    const secretEnv = Object.fromEntries(Object.entries(all).filter(([k]) => used.has(k)));
    const { values, secrets } = await withVault(valuesFor(root, project, env, c, secretEnv), c, new SecretVault(all));
    Object.assign(values.vars, o.vars ?? {});
    let requests: ApiRequest[] = allRequests(c.items).filter((x) => !o.folder || x.folders.includes(o.folder) || x.request.name === o.folder).map((x) => x.request);
    if (!requests.length) throw new Error(o.folder ? `No folder or request "${o.folder}" in ${rel}.` : `${rel} has no requests.`);
    requests = requests.filter((r) => r.kind === 'request');
    const out = o.out ?? ((l: string) => process.stdout.write(`${l}\n`));
    const mask = (t: string) => maskSecrets(t, secrets);
    out(`${c.name} (${project}/${env}): ${requests.length} request(s)${o.rows?.length ? `, ${o.rows.length} data row(s)` : (o.iterations ?? 1) > 1 ? ` × ${o.iterations}` : ''}`);
    const runner = new CollectionRunner();
    const job = runner.start({ collection: c, file: rel, project, env, requests, values, rows: o.rows ?? [], iterations: o.iterations ?? 1, delayMs: o.delayMs ?? 0, stopOnFailure: !!o.bail,
        timeoutMs: o.timeoutMs ?? 30_000, connection: o.connection, readFile: projectFileReader(root), projectRoot: root, mask });
    let shown = 0, lastIt = 0;
    for (;;) {
        const j = runner.get(job.id)!;
        for (; shown < j.steps.length; shown++) {
            const s = j.steps[shown];
            if (s.iteration !== lastIt && (j.iterations > 1)) { out(`\nIteration ${s.iteration}/${j.iterations}`); lastIt = s.iteration; }
            out(`${s.passed ? '✓' : '✗'} ${s.name}  ${s.method} ${s.url}  [${s.status ?? '—'}${s.timeMs !== undefined ? `, ${s.timeMs} ms` : ''}]`);
            for (const ch of s.checks) out(`    ${ch.pass ? '✓' : '✗'} ${ch.message}${!ch.pass && ch.actual !== undefined && !ch.message.includes(String(ch.actual)) ? ` (got ${ch.actual})` : ''}`);
            if (s.error) out(`    ✗ ${s.error}`);
            for (const l of s.logs ?? []) out(`    │ ${l}`);
        }
        if (j.state !== 'running') break;
        await new Promise((r) => setTimeout(r, 100));
    }
    const j = runner.get(job.id)!;
    const s = j.summary;
    out(`\n${s.passed}/${s.requests} requests passed · ${s.checksPassed}/${s.checks} checks · average ${s.avgMs} ms${j.state === 'stopped' ? ' · stopped at the first failure' : ''}`);
    return j;
}

/** The results files a run asks for (--junit, --json, --html). */
export function writeRunOutputs(j: RunnerJob, files: { junit?: string; json?: string; html?: string }): string[] {
    const written: string[] = [];
    const put = (f: string | undefined, text: string) => { if (!f) return; fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true }); fs.writeFileSync(f, text); written.push(f); };
    put(files.junit, runnerJUnit(j));
    put(files.json, JSON.stringify(j, null, 2));
    put(files.html, runnerReport(j));
    return written;
}

/**
 * An Azure DevOps pipeline (YAML) that runs a collection on a schedule or on changes: the Studio's runner from the
 * repository's own node_modules, the environment as a parameter, the secrets from a variable group (as environment
 * variables, so {env:NAME} finds them), the results published as test results and kept as artifacts.
 */
export function collectionPipeline(file: string, o: { name: string; envs: string[]; variableGroup?: string; schedule?: string; branch?: string; secretNames?: string[]; nodeVersion?: string }): string {
    const envs = o.envs.length ? o.envs : ['dev'];
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const secretEnv = (o.secretNames ?? []).filter((n) => /^[A-Za-z_][\w]*$/.test(n));
    return [
        `# ${o.name}: the API collection ${file}, run with CS Test Studio's runner.`,
        '# Secrets come from the variable group as environment variables ({env:NAME} in the collection).',
        `name: ${q(`${o.name} $(Date:yyyyMMdd)$(Rev:.r)`)}`,
        '',
        `trigger:\n  branches:\n    include: [${o.branch ?? 'main'}]\n  paths:\n    include: [${q(path.posix.dirname(file) + '/*')}]`,
        ...(o.schedule ? ['', `schedules:\n  - cron: ${q(o.schedule)}\n    displayName: ${q(`${o.name} (scheduled)`)}\n    branches:\n      include: [${o.branch ?? 'main'}]\n    always: true`] : []),
        '',
        `parameters:\n  - name: environment\n    displayName: Environment\n    type: string\n    default: ${envs[0]}\n    values: [${envs.join(', ')}]`,
        '',
        `variables:${o.variableGroup ? `\n  - group: ${q(o.variableGroup)}` : ''}\n  - name: results\n    value: $(Agent.TempDirectory)/api-results`,
        '',
        'pool:\n  vmImage: ubuntu-latest',
        '',
        'steps:',
        '  - checkout: self',
        `  - task: UseNode@1\n    inputs:\n      version: ${q(o.nodeVersion ?? '20.x')}`,
        '  - script: npm ci\n    displayName: Install',
        `  - script: >-\n      npx cs-test-studio run ${q(file)}\n      --env \${{ parameters.environment }}\n      --junit $(results)/junit.xml --json $(results)/run.json --html $(results)/report.html\n    displayName: ${q(`Run ${o.name}`)}${secretEnv.length ? `\n    env:\n${secretEnv.map((n) => `      ${n}: $(${n})`).join('\n')}` : ''}`,
        `  - task: PublishTestResults@2\n    condition: succeededOrFailed()\n    inputs:\n      testResultsFormat: JUnit\n      testResultsFiles: $(results)/junit.xml\n      testRunTitle: ${q(`${o.name} (\${{ parameters.environment }})`)}\n      failTaskOnFailedTests: true`,
        `  - publish: $(results)\n    artifact: api-results-$(System.JobAttempt)\n    condition: succeededOrFailed()`,
        '',
    ].join('\n');
}
