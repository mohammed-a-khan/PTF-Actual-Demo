/**
 * CS Playwright MCP Heal-Loop Tools
 *
 * Two thin primitives that the host LLM (Copilot in agent mode) calls
 * to drive a browser-grounded heal loop after a generated test fails:
 *
 *   - `csaa_run_scenario` — execute one BDD scenario and return a
 *     structured pass/fail with last-successful-step + screenshot path.
 *     Wraps `test_run` with `--scenario` filter so the LLM can target a
 *     single scenario instead of the full feature.
 *
 *   - `csaa_capture_failure_state` — inspect the test-results artifact
 *     directory for a scenario, return DOM snapshot path, screenshot
 *     path, console errors, network failures, last URL. The LLM uses
 *     this output plus `browser_generate_locator` (existing tool) to
 *     propose a fix and apply via `replace_string_in_file`.
 *
 * The actual heal loop runs in chat — the LLM reads the output of
 * these two tools, decides what to fix, calls the framework's built-in
 * edit tools to apply the patch, then re-invokes `csaa_run_scenario`.
 * No sampling required — Copilot drives the loop with its own
 * reasoning over the structured payloads we surface.
 *
 * @module CSMCPHealLoopTools
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helpers
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [
            { type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent,
        ],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

/**
 * Spawn the framework's test runner with a scenario filter and capture
 * stdout/stderr. Returns the exit code + combined output. Does NOT throw
 * on non-zero exit — failed tests are expected; the caller parses output.
 */
function runScenarioCommand(
    workspaceRoot: string,
    cwd: string,
    args: string[],
    timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
        const command = 'node';
        const runnerPath = path.join(
            workspaceRoot,
            'node_modules',
            '@mdakhan.mak',
            'cs-playwright-test-framework',
            'dist',
            'index.js',
        );
        const fullArgs = fs.existsSync(runnerPath)
            ? [runnerPath, ...args]
            : [path.join(workspaceRoot, 'dist', 'index.js'), ...args];

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const proc = spawn(command, fullArgs, { cwd, env: process.env });
        proc.stdout?.on('data', (d) => (stdout += d.toString()));
        proc.stderr?.on('data', (d) => (stderr += d.toString()));

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill('SIGTERM');
            } catch {
                /* ignore */
            }
        }, timeoutMs);

        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                exitCode: code ?? -1,
                stdout,
                stderr,
                timedOut,
            });
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({
                exitCode: -1,
                stdout,
                stderr: stderr + '\n' + (err.message || String(err)),
                timedOut,
            });
        });
    });
}

/**
 * Walk the framework's `test-results/` directory tree to find the most
 * recent run folder. Returns absolute path or null if none exist.
 */
function findLatestRunDir(workspaceRoot: string): string | null {
    const root = path.join(workspaceRoot, 'test-results');
    if (!fs.existsSync(root)) return null;
    let latest: { path: string; mtime: number } | null = null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const abs = path.join(root, entry.name);
        try {
            const stat = fs.statSync(abs);
            if (!latest || stat.mtimeMs > latest.mtime) {
                latest = { path: abs, mtime: stat.mtimeMs };
            }
        } catch {
            /* ignore unreadable entries */
        }
    }
    return latest?.path ?? null;
}

/**
 * Within a run dir, find the artefact subfolder matching a scenario.
 * Scenarios usually live at `test-results/<runId>/<scenario-slug>/...`
 * but the slug pattern varies — we match on a prefix of the scenario
 * id (e.g., `TS_001` matches `TS_001_<...>`) or fall back to title
 * substring.
 */
function findScenarioArtefactDir(
    runDir: string,
    scenarioId: string,
): string | null {
    const slug = scenarioId.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase();
    if (!fs.existsSync(runDir)) return null;
    let best: string | null = null;
    for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const norm = entry.name.toLowerCase();
        if (norm.startsWith(slug) || norm.includes(slug)) {
            best = path.join(runDir, entry.name);
            break;
        }
    }
    return best;
}

/**
 * Parse the framework's BDD output to extract the failure detail for
 * one scenario. Looks for `✗ Scenario: ...` lines + the `Step failed:`
 * markers the framework emits.
 */
function parseScenarioFailure(
    output: string,
    scenarioId: string,
): {
    passed: boolean;
    lastSuccessfulStep?: string;
    failedStep?: string;
    failureMessage?: string;
} {
    const lines = output.split(/\r?\n/);
    let lastStepPass: string | undefined;
    let failedStep: string | undefined;
    let failureMessage: string | undefined;
    let inScope = false;
    let scenarioPassed: boolean | undefined;

    const idMatch = scenarioId.replace(/[^A-Za-z0-9_-]/g, '');
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        // Enter scope on the line that names this scenario.
        if (ln.includes(idMatch) || ln.includes(scenarioId)) {
            inScope = true;
        }
        if (!inScope) continue;

        const passStep = /^\s*✓\s+(?:Given|When|Then|And|But)\s+(.+)$/.exec(ln);
        if (passStep) {
            lastStepPass = passStep[1].trim();
            continue;
        }
        const failStep = /^\s*✗\s+(?:Given|When|Then|And|But)\s+(.+)$/.exec(ln);
        if (failStep) {
            failedStep = failStep[1].trim();
            scenarioPassed = false;
            // Failure message is usually on the next 1-3 lines.
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                const m = /^\s*(?:Error|AssertionError|TimeoutError):\s*(.+)$/.exec(
                    lines[j],
                );
                if (m) {
                    failureMessage = m[1].trim();
                    break;
                }
            }
            continue;
        }
        const scenarioDone =
            /^\s*[✓✗]\s+Scenario(?:\s+Outline)?:/.exec(ln);
        if (scenarioDone && inScope) {
            scenarioPassed = ln.includes('✓');
            break;
        }
    }

    return {
        passed: scenarioPassed === true,
        lastSuccessfulStep: lastStepPass,
        failedStep,
        failureMessage,
    };
}

// ============================================================================
// Tool: csaa_run_scenario
// ============================================================================

const runScenarioTool = defineTool()
    .name('csaa_run_scenario')
    .title('Run one BDD scenario')
    .description(
        'Execute a single BDD scenario by id and return a structured pass/fail with the last successful step, failed step, screenshot path, and console errors. ' +
        'Use this after generation to verify a scenario, and again after each apply_patch fix to confirm green. ' +
        'Pair with `csaa_capture_failure_state` on failure to read DOM/screenshot artefacts.',
    )
    .openWorld()
    .category('testing')
    .stringParam('scenarioId', 'Scenario id (e.g., TS_001 or @TC#3430). Matched against the @<id> tag in the feature file.', { required: true })
    .stringParam('project', 'Project name (the test/<project>/ folder)', { required: true })
    .stringParam('env', 'Environment (e.g., dev, sit, uat). Defaults to dev.', { default: 'dev' })
    .stringParam('feature', 'Feature file path (relative to test/<project>/features/) — narrows the run if the scenarioId is ambiguous')
    .booleanParam('headed', 'Run with visible browser (slower but easier to debug). Default false.', { default: false })
    .numberParam('timeoutMs', 'Max wall time for the scenario before forced termination. Default 90000 (90s).', { default: 90000 })
    .handler(async (params, context) => {
        const scenarioId = String(params.scenarioId).trim();
        const project = String(params.project).trim();
        const env = String(params.env || 'dev').trim();
        const feature = params.feature ? String(params.feature).trim() : undefined;
        const headed = params.headed === true;
        const timeoutMs = Number(params.timeoutMs ?? 90000);

        const cwd = context.server.workingDirectory;
        const args: string[] = [`--project=${project}`, `--env=${env}`];
        // Match @TS_xxx style tags so the runner targets exactly one scenario.
        const tagFilter = scenarioId.startsWith('@')
            ? scenarioId
            : `@${scenarioId}`;
        args.push(`--tags=${tagFilter}`);
        if (feature) args.push(`--features=${feature}`);
        if (headed) args.push('--headed');
        else args.push('--headless');

        context.log(
            'info',
            `csaa_run_scenario: starting ${scenarioId} (project=${project}, env=${env})`,
        );
        const result = await runScenarioCommand(cwd, cwd, args, timeoutMs);

        const fullOutput = result.stdout + '\n' + result.stderr;
        const parsed = parseScenarioFailure(fullOutput, scenarioId);
        const passed = parsed.passed && result.exitCode === 0;

        const summary = passed
            ? `Scenario ${scenarioId} passed. Re-run is no-op.`
            : `Action required: scenario ${scenarioId} failed at step "${
                  parsed.failedStep ?? '(unknown)'
              }". Call csaa_capture_failure_state with the same scenarioId, then propose a fix via replace_string_in_file on the implicated page object or step file. Last successful step: "${
                  parsed.lastSuccessfulStep ?? '(none)'
              }".`;

        return createJsonResult({
            scenarioId,
            project,
            env,
            passed,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            lastSuccessfulStep: parsed.lastSuccessfulStep,
            failedStep: parsed.failedStep,
            failureMessage: parsed.failureMessage,
            summary,
            // Truncated output — the full log is on disk for the LLM to read
            // via read_file if needed.
            outputTail: fullOutput.slice(-2000),
            nextStepNeeded: !passed,
            nextSuggestedTool: passed ? undefined : 'csaa_capture_failure_state',
            nextSuggestedArgs: passed
                ? undefined
                : { scenarioId, project },
        });
    })
    .build();

// ============================================================================
// Tool: csaa_capture_failure_state
// ============================================================================

const captureFailureStateTool = defineTool()
    .name('csaa_capture_failure_state')
    .title('Capture failure state for a scenario')
    .description(
        'Read the most recent test-results artefact directory for a failed scenario. ' +
        'Returns paths to the screenshot, DOM snapshot (if captured), console log, network log, and the last URL the test was on when it failed. ' +
        'Use this output plus `browser_generate_locator` to propose a locator fix.',
    )
    .readOnly()
    .category('testing')
    .stringParam('scenarioId', 'Scenario id whose failure artefacts to read', { required: true })
    .stringParam('project', 'Project name (used to scope which test-results subdirectory)', { required: true })
    .stringParam('runDir', 'Override the auto-detected run directory (absolute path). Use when running across multiple framework instances.')
    .handler(async (params, context) => {
        const scenarioId = String(params.scenarioId).trim();
        const project = String(params.project).trim();
        const cwd = context.server.workingDirectory;
        const runDir = params.runDir
            ? String(params.runDir).trim()
            : findLatestRunDir(cwd);

        if (!runDir) {
            return createErrorResult(
                'no test-results/ directory found. Run csaa_run_scenario or test_run first to produce artefacts, then re-call this tool.',
            );
        }

        const artefactDir = findScenarioArtefactDir(runDir, scenarioId);
        if (!artefactDir) {
            return createErrorResult(
                `no artefact subfolder for scenario ${scenarioId} under ${runDir}. The scenario may not have been run yet, or the framework's slug does not include ${scenarioId}. Inspect the run dir contents and re-call with explicit runDir.`,
            );
        }

        // Walk the artefact dir and collect known artefact types.
        const screenshot = locateOne(artefactDir, /\.png$/i);
        const trace = locateOne(artefactDir, /\.zip$/i);
        const har = locateOne(artefactDir, /\.har$/i);
        const consoleLog = locateOne(artefactDir, /console.*\.(log|txt|json)$/i);
        const domSnapshot = locateOne(artefactDir, /(dom|snapshot).*\.(html|json)$/i);
        const stepLog = locateOne(artefactDir, /steps?.*\.(log|txt|json)$/i);

        // Try to extract the last page URL from the console log if present.
        let lastPageUrl: string | undefined;
        if (consoleLog && fs.existsSync(consoleLog)) {
            try {
                const txt = fs.readFileSync(consoleLog, 'utf-8').slice(-8 * 1024);
                const m = /https?:\/\/[^\s"]+/g.exec(txt);
                if (m) lastPageUrl = m[0];
            } catch {
                /* ignore */
            }
        }

        const summary = `Action required: read the screenshot at ${
            screenshot ?? '(none)'
        }, optionally open the trace at ${
            trace ?? '(none)'
        }, then call browser_generate_locator on the failing element. Once you have a candidate locator, apply via replace_string_in_file on the implicated page object and re-invoke csaa_run_scenario.`;

        return createJsonResult({
            scenarioId,
            project,
            artefactDir,
            screenshot,
            trace,
            har,
            consoleLog,
            domSnapshot,
            stepLog,
            lastPageUrl,
            summary,
            nextStepNeeded: true,
            nextSuggestedTool: 'browser_generate_locator',
            nextSuggestedArgs: lastPageUrl
                ? { url: lastPageUrl, intent: '<describe the element from the failed step>' }
                : { intent: '<describe the element from the failed step>' },
        });
    })
    .build();

/**
 * Walk a directory tree (one level deep) and return the first file whose
 * basename matches the regex. Returns absolute path or undefined.
 */
function locateOne(dir: string, pattern: RegExp): string | undefined {
    if (!fs.existsSync(dir)) return undefined;
    const stack: string[] = [dir];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const abs = path.join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(abs);
            } else if (e.isFile() && pattern.test(e.name)) {
                return abs;
            }
        }
    }
    return undefined;
}

// ============================================================================
// Export + registration
// ============================================================================

export const healLoopTools: MCPToolDefinition[] = [
    runScenarioTool,
    captureFailureStateTool,
];

export function registerHealLoopTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(healLoopTools);
}
