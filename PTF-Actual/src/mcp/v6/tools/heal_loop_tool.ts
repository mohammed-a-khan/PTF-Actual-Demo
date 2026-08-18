import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

const IS_WINDOWS = process.platform === 'win32';

function killTree(pid: number): void {
    if (IS_WINDOWS) {
        try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* noop */ }
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* noop */ }
    }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
    const started = Date.now();
    return new Promise((resolve) => {
        let settled = false;
        const child = spawn(cmd, args, { cwd, shell: false, detached: !IS_WINDOWS });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const to = setTimeout(() => {
            timedOut = true;
            if (child.pid) killTree(child.pid);
            try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, timeoutMs);
        const backup = setTimeout(() => {
            if (!settled) { settled = true; resolve({ exitCode: null, stdout, stderr, durationMs: Date.now() - started, timedOut: true }); }
        }, timeoutMs + 15_000);
        child.stdout.on('data', (c) => { stdout += c.toString('utf-8').slice(0, 500_000); });
        child.stderr.on('data', (c) => { stderr += c.toString('utf-8').slice(0, 500_000); });
        child.on('close', (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimeout(to); clearTimeout(backup);
            resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
        });
        child.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(to); clearTimeout(backup);
            resolve({ exitCode: 1, stdout: '', stderr: e.message, durationMs: Date.now() - started, timedOut: false });
        });
    });
}

interface FailureSignature {
    pattern: string;
    matches: (log: string) => boolean;
    proposal: (log: string) => string;
}

const KNOWN_PATTERNS: FailureSignature[] = [
    {
        pattern: 'element-visibility-timeout',
        matches: (log) => /did not become visible|Wait for visible failed|Timeout .* exceeded while waiting for|waiting for locator|selector resolved to hidden|Element is not visible/i.test(log),
        proposal: (log) => {
            const selectorMatch = /waiting for locator[^"']*["']([^"']+)["']|selector[^"']*["']([^"']+)["']|Locator[^"']*["']([^"']+)["']/i.exec(log);
            const failingSelector = selectorMatch ? (selectorMatch[1] || selectorMatch[2] || selectorMatch[3]) : '(selector not extracted from log — search logTail)';
            const urlMatch = /Navigating to[^h]*(https?:\/\/[^\s]+)|current(?:Url)?[^h]*(https?:\/\/[^\s]+)|goto\(["']([^"']+)["']/i.exec(log);
            const suspectUrl = urlMatch ? (urlMatch[1] || urlMatch[2] || urlMatch[3]) : '(URL not extracted — read logTail)';
            return `Element visibility timeout. Failing selector: ${failingSelector}. Suspect URL: ${suspectUrl}.

CONCRETE NEXT ACTIONS (do all in order, do not stop at the first):
1. Find the failure screenshot in the returned evidence.screenshots[] and inspect what the browser actually rendered.
2. Open the same URL via cs_qa_browse: {verb:"start", sessionId:"heal"}, then {verb:"actions", actions:[{action:"goto", url:"<suspectUrl>"}]}, then {verb:"snapshot"}.
3. Compare selectors returned by the snapshot with the selector the page-object used. Common causes: character typo in a name/id/class attribute, stale CSS class after a UI refresh, unsupported pseudo-locator, DOM restructure.
4. GREP for the failing selector: cs_qa_search {query:"<selector-substring>", root:"test"} — locates the page-object that owns it.
5. FIX THE PAGE-OBJECT. Any page-object you did NOT generate this run is consumer infrastructure — fixing it is legitimate healing, not a "hand-patch violation". The never-hand-patch rule applies only to generation output for the current source.
6. Re-run heal_loop with iteration: N+1 (and scenarioTag when scoped to one scenario). Loop until passed:true.

Also check: (a) page-object uses \`public async navigate() { await super.navigate("full-url"); }\` — NOT constructor+this.url (framework injection bypasses it); (b) alternative locators in @CSGetElement actually work; (c) CSReporter shows the right URL was reached before the wait.`;
        },
    },
    {
        pattern: 'step-def-not-found',
        matches: (log) => /step definition not found|no matching step/i.test(log),
        proposal: (log) => {
            const m = /step definition not found[^']*'([^']+)'/i.exec(log) || /(?:not found[^:]*:\s*)"([^"]+)"/i.exec(log);
            const step = m ? m[1] : '(step text unknown)';
            return `Step-def missing for: '${step}'. Search for a matching @CSBDDStepDef in test/**/steps/**. If none exists, either (a) reword the feature step to match an existing step-def verbatim, or (b) add a NEW @CSBDDStepDef whose body composes existing page-object methods.`;
        },
    },
    {
        pattern: 'locator-syntax',
        matches: (log) => /Unknown engine|Unsupported selector|strict mode violation/i.test(log),
        proposal: (log) => `Locator syntax problem. If using xpath, ensure it starts with '//' or use Playwright's 'xpath=' prefix. 'strict mode violation' = selector matches multiple elements; narrow it with normalize-space, nth-child, or getByRole+name.\nContext: ${log.split('\\n').filter((l) => /violation|Unknown|Unsupported/i.test(l)).slice(0, 3).join(' ')}`,
    },
    {
        pattern: 'auth-redirect-login',
        matches: (log) => /Authentication page detected|\/auth\/login|Login required/i.test(log),
        proposal: () => 'App requires login before the test flow. Add a Background: with the existing login step-def (search: @CSBDDStepDef.*login).',
    },
    {
        pattern: 'navigate-to-base-url',
        matches: (log) => /Navigating to: https?:\/\/[^\/]+\/?\s*$/im.test(log),
        proposal: () => 'Page navigated to BASE_URL instead of intended page URL. Root cause: page-object sets `this.url` in constructor but framework injection bypasses it. Fix: override navigate() with `public async navigate() { await super.navigate("full-url-here"); }` and REMOVE the constructor/this.url pattern.',
    },
    {
        pattern: 'ts-compile-error',
        matches: (log) => /error TS\d+:/i.test(log),
        proposal: (log) => `TypeScript compile error. First few errors:\n${log.split('\\n').filter((l) => /error TS/i.test(l)).slice(0, 5).join('\\n')}\nFix imports, method names, or types per the exact error message.`,
    },
    {
        pattern: 'missing-page-property',
        matches: (log) => /Property '[a-zA-Z_]+' does not exist on type/i.test(log),
        proposal: (log) => {
            const m = /Property '([^']+)' does not exist on type '([^']+)'/i.exec(log);
            return m ? `Missing property '${m[1]}' on type '${m[2]}'. Add the @CSGetElement field or method to the page-object, or fix the caller to use an existing one.` : 'Missing property on page-object type. Add the field/method or fix the caller.';
        },
    },
    {
        pattern: 'browser-launch-fail',
        matches: (log) => /browserType\.launch|Executable doesn't exist|playwright install/i.test(log),
        proposal: () => 'Playwright browser binary missing. Run `npx playwright install chromium` in the workspace before test execution.',
    },
    {
        pattern: 'unique-id-collision',
        matches: (log) => /\balready\s+exists|duplicate\s+(?:key|entry|record|id|value)|must\s+be\s+unique|not\s+unique|constraint\s+violation|unique\s+constraint|conflict.*(?:id|record|row)|record\s+with\s+.*\s+id\s+.*\s+exists/i.test(log),
        proposal: (log) => {
            const idHint = /(?:id|number|identifier)\s*[:=]?\s*['"]?(\w+)['"]?/i.exec(log);
            const collisionCol = idHint ? idHint[1] : '(the column that collided — grep scenarios.json)';
            return `Unique-ID collision: the app rejected the record because a value already exists. This is almost always a hardcoded unique identifier in scenarios.json that gets reused every run.

ROOT CAUSE — the app treats the column as a primary/unique key; hardcoded values collide on re-run.

FIX (per the skill's "Dates and unique IDs" section — MANDATORY framework utilities):
1. Locate the offending column in test/<project>/data/<env>/<story-slug>/scenarios.json. Likely name matches /id$|number$|identifier/i. Collided value hint from log: ${collisionCol}.
2. Choose ONE of the two acceptable patterns:
   (a) OMIT the column from scenarios.json entirely — have the step-def generate at runtime:
       import { CSDataGenerator } from '@mdakhan.mak/cs-playwright-test-framework/data';
       const uniqueId = CSDataGenerator.getInstance().generateNumber(10000, 99999).toString();
       await this.<page>.enterEmployeeId(uniqueId);
       // store on context for downstream steps
   (b) SENTINEL TOKEN in the data row — write "employeeId": "__AUTO_NUMBER__" (or "__AUTO_ID:EMP__"), and have your step-def / data resolver substitute before applying:
       const raw = row.employeeId;
       const value = raw === '__AUTO_NUMBER__'
         ? CSDataGenerator.getInstance().generateNumber(10000, 99999).toString()
         : raw;
3. After generating, STORE the actual id (on scenario context / page-object field) so downstream assertions/searches can reference the value the app actually saw.
4. NEVER hardcode a numeric id in scenarios.json for any column the app treats as unique — verifier will grow a warning for this class.
5. Related framework utilities also required by the skill: CSDataGenerator.getInstance().generateEmail(), .generateUsername(), .generateId(prefix, length), .generatePerson() — use them for any other collision-prone strings.

Also: for date/time values that must not repeat or drift, use CSDateTimeUtility (Americas timezone default) — never new Date()/Date.now() or hardcoded date literals.`;
        },
    },
];

registerPrimitive({
    name: 'cs_qa_heal_loop',
    description: 'Structured PER-SCENARIO heal loop for failing tests. Runs the test command (optionally scoped to a single scenario tag via `scenarioTag` — the tool automatically injects `--tags=<scenarioTag>` into testArgs), reads reports/<latest>/reports/report-data.json for authoritative pass/fail truth, and returns focused proposals. Copilot MUST loop per-scenario until every scenario passes: (1) run full feature to see failures, (2) heal_loop returns `nextTargetTag` = first failing tag, (3) fix that scenario\'s root cause, (4) call heal_loop again with `scenarioTag: nextTargetTag` to verify the fix, (5) once that scenario passes, drop scenarioTag and run full feature again — either more pass due to shared fix or the next failing tag appears. Never stop until report shows totalScenarios===passedScenarios AND failedScenarios===0.',
    inputSchema: z.object({
        testCommand: z.string().default('npx'),
        testArgs: z.array(z.string()).default(['cs-playwright-test']),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().max(30 * 60_000).default(15 * 60_000),
        iteration: z.number().int().nonnegative().default(1),
        maxLogBytes: z.number().int().positive().max(500_000).default(200_000),
        scenarioTag: z.string().optional(),
    }),
    outputSchema: z.object({
        iteration: z.number(),
        exitCode: z.number().nullable(),
        durationMs: z.number(),
        timedOut: z.boolean(),
        passed: z.boolean(),
        summary: z.object({ total: z.number().optional(), passed: z.number().optional(), failed: z.number().optional() }).optional(),
        patternMatched: z.string().optional(),
        proposal: z.string().optional(),
        logTail: z.string(),
        note: z.string().optional(),
        scopedToTag: z.string().optional(),
        nextTargetTag: z.string().optional(),
        remainingFailedTags: z.array(z.string()).optional(),
    }),
    run: async (ctx, input) => {
        const cwd = input.cwd ? path.resolve(ctx.workspaceRoot, input.cwd) : ctx.workspaceRoot;
        // Inject --tags filter when scenarioTag provided, unless caller already put --tags in args
        let effectiveArgs = input.testArgs;
        if (input.scenarioTag) {
            const alreadyHasTagsFlag = input.testArgs.some((a) => /^--tags[=\s]/.test(a) || a === '--tags');
            if (!alreadyHasTagsFlag) {
                // Inject into the final PowerShell -Command string if that's the shape we're using
                effectiveArgs = input.testArgs.map((a) => {
                    if (a.includes('cs-playwright-test') && !a.includes('--tags')) {
                        return a + ` --tags=${input.scenarioTag}`;
                    }
                    return a;
                });
                // If no arg contained cs-playwright-test (bare npx form), append as a new arg
                const injected = effectiveArgs.join(' ').includes(input.scenarioTag);
                if (!injected) effectiveArgs = [...input.testArgs, `--tags=${input.scenarioTag}`];
            }
        }
        const result = await run(input.testCommand, effectiveArgs, cwd, input.timeoutMs);
        const combined = (result.stdout + '\n' + result.stderr).slice(-input.maxLogBytes);

        // AUTHORITATIVE truth: read report-data.json AND count failure screenshots.
        // The runner exits 0 in soft-failure mode even when every scenario failed —
        // trusting exitCode alone is a lie. Trust the report file first, then screenshots,
        // then the log summary, then (last) the exit code.
        const evidence = findLatestFailureEvidence(cwd);
        const reportSummary = evidence.reportDir ? readReportSummary(path.join(cwd, evidence.reportDir)) : undefined;

        let summary: { total?: number; passed?: number; failed?: number } | undefined = reportSummary
            ? { total: reportSummary.total, passed: reportSummary.passed, failed: reportSummary.failed }
            : undefined;
        if (!summary) {
            const summaryMatch = /Total:\s*(\d+).*?Passed:\s*(\d+).*?Failed:\s*(\d+)/is.exec(combined)
                || /(\d+)\s+scenarios?\s+(passed|failed).*?of\s+(\d+)/i.exec(combined);
            if (summaryMatch) {
                if (summaryMatch[0].includes('Total')) summary = { total: parseInt(summaryMatch[1]), passed: parseInt(summaryMatch[2]), failed: parseInt(summaryMatch[3]) };
                else summary = { total: parseInt(summaryMatch[3]), passed: summaryMatch[2] === 'passed' ? parseInt(summaryMatch[1]) : undefined, failed: summaryMatch[2] === 'failed' ? parseInt(summaryMatch[1]) : undefined };
            }
        }

        const hasFailureScreenshots = evidence.screenshots.length > 0;
        const reportSaysFailure = !!reportSummary && (reportSummary.failed > 0 || reportSummary.total === 0);
        const logSaysFailure = /(\d+)\s+scenarios?\s+failed|Failed:\s*[1-9]/i.test(combined);
        const truePassed = result.exitCode === 0
            && !result.timedOut
            && !hasFailureScreenshots
            && !reportSaysFailure
            && !logSaysFailure
            && !!reportSummary
            && reportSummary.total > 0
            && reportSummary.passed === reportSummary.total;

        if (truePassed) {
            const scopedNote = input.scenarioTag
                ? `SCENARIO ${input.scenarioTag} PASSED. Now DROP scenarioTag and call heal_loop again to run the full feature — other scenarios may now pass due to shared fixes, or the next failing tag will surface. Do NOT report "done" until report-data.json shows totalScenarios===passedScenarios for the UNSCOPED feature run.`
                : `TRULY PASSED — report-data.json confirms ${reportSummary!.passed}/${reportSummary!.total} scenarios passed and no failure screenshots present.`;
            return {
                iteration: input.iteration, exitCode: result.exitCode, durationMs: result.durationMs,
                timedOut: result.timedOut, passed: true, summary,
                logTail: combined.slice(-4000),
                note: scopedNote,
                scopedToTag: input.scenarioTag,
            };
        }

        // NOT PASSED — extract the real failure story from the report
        const failedScenariosDetail = (reportSummary?.failedDetails || []).slice(0, 5)
            .map((f, i) => `  ${i + 1}. "${f.name}" (${f.tag ?? '(no tag)'}) — first fail: [${f.step}] → ${f.error.slice(0, 200)}`)
            .join('\n');
        const nextTargetTag = reportSummary?.failedDetails?.[0]?.tag;
        const remainingFailedTags = (reportSummary?.failedDetails ?? []).map((f) => f.tag).filter((t): t is string => !!t);

        let patternMatched: string | undefined;
        let proposal: string | undefined;
        // Prefer log-based patterns (usually more specific), fall back to report-based
        for (const p of KNOWN_PATTERNS) {
            if (p.matches(combined)) { patternMatched = p.pattern; proposal = p.proposal(combined); break; }
        }
        // If no log-pattern hit but the report shows failures, synthesize an element-visibility proposal
        // from the first failing step's error message.
        if (!patternMatched && reportSummary?.failedDetails && reportSummary.failedDetails.length > 0) {
            const firstErr = reportSummary.failedDetails[0].error;
            for (const p of KNOWN_PATTERNS) {
                if (p.matches(firstErr)) { patternMatched = p.pattern; proposal = p.proposal(firstErr); break; }
            }
        }

        const scopeBanner = input.scenarioTag
            ? `SCOPED-RUN: --tags=${input.scenarioTag} (this run ONLY exercised that one scenario).`
            : `UNSCOPED-RUN: entire feature.`;
        const reportBanner = reportSummary
            ? `RUN STATUS (from report-data.json — AUTHORITATIVE): total=${reportSummary.total} passed=${reportSummary.passed} failed=${reportSummary.failed}`
            : `RUN STATUS: no report-data.json found; runner may not have executed any scenarios (broken invocation).`;
        const focusBlock = nextTargetTag
            ? `\nNEXT FOCUS: single failing scenario ${nextTargetTag}.\nMANDATORY NEXT STEPS (per-scenario heal protocol):\n  A. Read reports/<latest>/reports/report-data.json for the FULL error stack of scenario "${reportSummary!.failedDetails[0].name}".\n  B. Fix ONLY the root cause of THAT scenario's first failing step. Do NOT try to fix all failing scenarios at once.\n  C. Call cs_qa_heal_loop again with scenarioTag: "${nextTargetTag}" — the tool will inject --tags=${nextTargetTag} so ONLY that scenario runs. This tight loop isolates root cause fast.\n  D. Once that scenario shows passed:true (scoped), call cs_qa_heal_loop WITHOUT scenarioTag to re-run the full feature. Shared fixes often heal several sibling scenarios at once; if not, the new nextTargetTag points at the next failure.\n  E. Repeat until an unscoped run reports totalScenarios===passedScenarios AND failedScenarios===0.\n  F. Never stop at partial passing — that is not done. Keep iterating.`
            : '';

        const proposalWithEvidence = [
            scopeBanner,
            reportBanner,
            failedScenariosDetail ? `FAILED SCENARIOS (top 5):\n${failedScenariosDetail}` : '',
            focusBlock,
            proposal ? `\nPATTERN PROPOSAL:\n${proposal}` : '',
            `\nFAILURE EVIDENCE: ${evidence.summary}`,
        ].filter(Boolean).join('\n');

        return {
            iteration: input.iteration, exitCode: result.exitCode, durationMs: result.durationMs,
            timedOut: result.timedOut, passed: false, summary,
            patternMatched, proposal: proposalWithEvidence,
            logTail: combined.slice(-4000),
            note: `passed=false. ${reportSummary ? `${reportSummary.failed}/${reportSummary.total} scenarios failed` : 'no report found'}, ${evidence.screenshots.length} failure screenshots. ${input.scenarioTag ? `Scoped scenario ${input.scenarioTag} still failing — fix ITS root cause, retry with same scenarioTag.` : `Pick FIRST failing tag (nextTargetTag=${nextTargetTag ?? '?'}), fix ONE thing, call heal_loop with scenarioTag=${nextTargetTag ?? '@TS_XXX_YY'} to verify.`} NEVER report "done" while any scenario is failing.`,
            scopedToTag: input.scenarioTag,
            nextTargetTag,
            remainingFailedTags,
        };
    },
});

interface FailedScenarioDetail { name: string; step: string; error: string; tag?: string; }
interface ReportSummary { total: number; passed: number; failed: number; failedDetails: FailedScenarioDetail[]; }

function extractScenarioTag(sc: { tags?: unknown; name?: string }): string | undefined {
    // Try `tags` array of strings first (framework standard)
    if (Array.isArray(sc.tags)) {
        for (const t of sc.tags) {
            if (typeof t === 'string' && /^@TS_\w+/i.test(t)) return t.startsWith('@') ? t : `@${t}`;
            if (typeof t === 'object' && t !== null && 'name' in t) {
                const tn = (t as { name?: string }).name;
                if (typeof tn === 'string' && /^@?TS_\w+/i.test(tn)) return tn.startsWith('@') ? tn : `@${tn}`;
            }
        }
        // Fall back to first @tag that isn't a category
        for (const t of sc.tags) {
            const s = typeof t === 'string' ? t : (typeof t === 'object' && t !== null && 'name' in t ? (t as { name?: string }).name : undefined);
            if (typeof s === 'string' && s.startsWith('@')) return s;
        }
    }
    return undefined;
}

function readReportSummary(reportDir: string): ReportSummary | undefined {
    const jsonPath = path.join(reportDir, 'reports', 'report-data.json');
    if (!fs.existsSync(jsonPath)) return undefined;
    try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw) as { suite?: { totalScenarios?: number; passedScenarios?: number; failedScenarios?: number; scenarios?: Array<{ name?: string; status?: string; tags?: unknown; steps?: Array<{ keyword?: string; text?: string; status?: string; error?: string }> }> } };
        const suite = data.suite ?? {};
        const total = typeof suite.totalScenarios === 'number' ? suite.totalScenarios : 0;
        const passed = typeof suite.passedScenarios === 'number' ? suite.passedScenarios : 0;
        const failed = typeof suite.failedScenarios === 'number' ? suite.failedScenarios : Math.max(0, total - passed);
        const failedDetails: FailedScenarioDetail[] = [];
        for (const sc of suite.scenarios ?? []) {
            if (sc.status === 'passed') continue;
            const firstFail = (sc.steps ?? []).find((s) => s.status === 'failed');
            failedDetails.push({
                name: sc.name ?? '(unnamed)',
                step: firstFail ? `${firstFail.keyword ?? ''}${firstFail.text ?? ''}`.trim() : '(no failing step captured)',
                error: firstFail?.error ?? '(no error message captured)',
                tag: extractScenarioTag(sc),
            });
        }
        return { total, passed, failed, failedDetails };
    } catch {
        return undefined;
    }
}

function findLatestFailureEvidence(cwd: string): { summary: string; reportDir?: string; screenshots: string[]; failedSteps: string[] } {
    const reportsRoot = path.join(cwd, 'reports');
    if (!fs.existsSync(reportsRoot)) return { summary: 'no reports/ directory', screenshots: [], failedSteps: [] };
    let latest: { dir: string; mtimeMs: number } | undefined;
    try {
        for (const entry of fs.readdirSync(reportsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (!/^test-results-/.test(entry.name)) continue;
            const abs = path.join(reportsRoot, entry.name);
            const st = fs.statSync(abs);
            if (!latest || st.mtimeMs > latest.mtimeMs) latest = { dir: abs, mtimeMs: st.mtimeMs };
        }
    } catch { /* noop */ }
    if (!latest) return { summary: 'no test-results-* directory found', screenshots: [], failedSteps: [] };
    const shotsDir = path.join(latest.dir, 'screenshots');
    const screenshots: string[] = [];
    const failedSteps: string[] = [];
    if (fs.existsSync(shotsDir)) {
        for (const f of fs.readdirSync(shotsDir)) {
            if (!/^step-failure-/.test(f)) continue;
            const relPath = path.relative(cwd, path.join(shotsDir, f)).replace(/\\/g, '/');
            screenshots.push(relPath);
            const stepMatch = /step-failure-(Given|When|Then|And|But)-(.+?)-\d{4}-/i.exec(f);
            if (stepMatch) failedSteps.push(`${stepMatch[1]} ${stepMatch[2].replace(/-/g, ' ')}`);
        }
    }
    const relReport = path.relative(cwd, latest.dir).replace(/\\/g, '/');
    if (screenshots.length === 0) return { summary: `report=${relReport} (no failure screenshots)`, reportDir: relReport, screenshots: [], failedSteps: [] };
    const stepsSummary = failedSteps.length > 0 ? ` FIRST-FAILURE=[${failedSteps[0]}]` : '';
    return {
        summary: `report=${relReport} screenshots=${screenshots.length}${stepsSummary} — read: ${screenshots.slice(0, 3).join(', ')}`,
        reportDir: relReport,
        screenshots,
        failedSteps,
    };
}
