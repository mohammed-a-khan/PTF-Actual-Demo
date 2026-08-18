/**
 * WebSocket scenario emitter — per-scenario Gherkin `.feature` files plus a
 * shared step-def bundle and `_websocket-helper.ts` that speaks the Node `ws`
 * package (referenced by name only; the emitted README carries the install
 * hint). Uses CSReporter for all logging.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface WsScenario {
    name: string;
    connect?: { headers?: Record<string, string> };
    send: Array<{ message: string; waitFor?: string }>;
    expectMessages: Array<{ matches: string; timeoutMs?: number }>;
    expectClose?: { code?: number };
}

export interface EmitWsArgs {
    outputRoot: string;
    wsUrl: string;
    authTokenEnvVar?: string;
    scenarios: WsScenario[];
    warnings: string[];
}

export interface EmittedWsBundle {
    featureFiles: Array<{ filePath: string; scenarioName: string }>;
    stepDefFile: string;
    helperFile: string;
    readmeFile: string;
    envTemplateFile: string;
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ws';
}

function tsLit(s: string): string {
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}

// ---------------------------------------------------------------------------
// Feature files — one .feature per scenario, tagged @websocket.
// ---------------------------------------------------------------------------

export function emitWsFeatureFiles(args: EmitWsArgs): Array<{ filePath: string; scenarioName: string }> {
    const dir = path.join(args.outputRoot, 'features');
    fs.mkdirSync(dir, { recursive: true });
    const out: Array<{ filePath: string; scenarioName: string }> = [];
    for (const scenario of args.scenarios) {
        const filePath = path.join(dir, `${slugify(scenario.name)}.feature`);
        const lines: string[] = [];
        lines.push('@websocket @auto-generated');
        lines.push(`Feature: WebSocket - ${scenario.name}`);
        lines.push(`  Auto-generated WebSocket scenario against ${args.wsUrl}.`);
        lines.push('');
        lines.push('  @happy-path');
        lines.push(`  Scenario: ${scenario.name}`);
        lines.push(`    Given a WebSocket connection to "${args.wsUrl}"`);
        if (args.authTokenEnvVar) {
            lines.push(`    And the connection carries a token from env "${args.authTokenEnvVar}"`);
        }
        lines.push(`    When the scenario "${scenario.name}" plays`);
        lines.push(`    Then all expected messages arrive within their timeouts`);
        if (scenario.expectClose?.code !== undefined) {
            lines.push(`    And the connection closes with code ${scenario.expectClose.code}`);
        }
        lines.push('');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        out.push({ filePath, scenarioName: scenario.name });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Step defs — deterministic dispatch on scenario name.
// ---------------------------------------------------------------------------

export function emitWsStepDefs(args: EmitWsArgs): string {
    const stepsDir = path.join(args.outputRoot, 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    const filePath = path.join(stepsDir, 'WebSocketSteps.ts');

    const scenarioMap: Record<string, WsScenario> = {};
    for (const s of args.scenarios) scenarioMap[s.name] = s;
    const scenarioLiteral = JSON.stringify(scenarioMap, null, 4);
    const authVar = tsLit(args.authTokenEnvVar || 'WS_AUTH_TOKEN');

    const src = `import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import { WebSocketClient, runWsScenario, type WsScenarioDef } from '../_websocket-helper';

const AUTH_TOKEN_ENV_VAR = ${authVar};

const SCENARIOS: Record<string, WsScenarioDef> = ${scenarioLiteral};

interface StepState {
    url?: string;
    headers: Record<string, string>;
    scenarioName?: string;
    result?: { received: string[]; closedCode?: number };
}

const state: StepState = { headers: {} };

export class WebSocketSteps {
    @CSBDDStepDef('a WebSocket connection to "([^"]+)"')
    async connect(url: string): Promise<void> {
        state.url = url;
        state.headers = {};
        state.scenarioName = undefined;
        state.result = undefined;
        CSReporter.info(\`Prepared WebSocket target \${url}\`);
    }

    @CSBDDStepDef('the connection carries a token from env "([^"]+)"')
    async attachToken(envVar: string): Promise<void> {
        const token = process.env[envVar] || process.env[AUTH_TOKEN_ENV_VAR] || '';
        if (!token) {
            CSReporter.warn(\`No token in env var \${envVar} — proceeding unauthenticated\`);
            return;
        }
        state.headers['Authorization'] = \`Bearer \${token}\`;
        CSReporter.info('Attached Bearer token to WebSocket handshake');
    }

    @CSBDDStepDef('the scenario "([^"]+)" plays')
    async play(name: string): Promise<void> {
        const def = SCENARIOS[name];
        if (!def) throw new Error(\`Unknown WebSocket scenario "\${name}" — regenerate with cs_qa_gen_protocol_test (verb:'websocket')\`);
        if (!state.url) throw new Error('WebSocket URL not prepared');
        state.scenarioName = name;
        state.result = await runWsScenario({
            url: state.url,
            headers: state.headers,
            def,
        });
        CSReporter.info(\`WebSocket scenario "\${name}" completed with \${state.result.received.length} message(s)\`);
    }

    @CSBDDStepDef('all expected messages arrive within their timeouts')
    async assertMessages(): Promise<void> {
        if (!state.result || !state.scenarioName) throw new Error('Scenario did not run');
        const def = SCENARIOS[state.scenarioName];
        for (const expect of def.expectMessages) {
            const re = new RegExp(expect.matches);
            const hit = state.result.received.some((m) => re.test(m));
            if (!hit) {
                throw new Error(\`Expected WS message matching \${expect.matches} was never received. Got: \${JSON.stringify(state.result.received)}\`);
            }
        }
    }

    @CSBDDStepDef('the connection closes with code (\\\\d+)')
    async assertClose(code: string): Promise<void> {
        if (!state.result) throw new Error('Scenario did not run');
        if (state.result.closedCode !== Number(code)) {
            throw new Error(\`Expected close code \${code}, got \${state.result.closedCode ?? '(none)'}\`);
        }
    }

    private _client?: WebSocketClient;
}
`;
    fs.writeFileSync(filePath, src, 'utf-8');
    return filePath;
}

// ---------------------------------------------------------------------------
// Runtime helper — uses `ws` package by name (installed by consumer per README).
// ---------------------------------------------------------------------------

export function emitWsHelper(outputRoot: string, warnings: string[]): string {
    const filePath = path.join(outputRoot, '_websocket-helper.ts');
    if (fs.existsSync(filePath)) {
        warnings.push(`_websocket-helper.ts already exists at ${filePath} — kept as-is (generator does not clobber consumer edits).`);
        return filePath;
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    const src = `/* eslint-disable */
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

// Auto-generated WebSocket helper. Requires the "ws" npm package at runtime;
// install with:  npm i --save-dev ws @types/ws

// eslint-disable-next-line @typescript-eslint/no-var-requires
type WsCtor = new (address: string, opts?: { headers?: Record<string, string> }) => WsLike;

interface WsLike {
    on(event: 'open', cb: () => void): void;
    on(event: 'message', cb: (data: unknown) => void): void;
    on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
    send(data: string): void;
    close(code?: number): void;
    readyState: number;
}

function loadWsCtor(): WsCtor {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('ws');
        return (mod && (mod.default || mod)) as WsCtor;
    } catch (e) {
        throw new Error('The "ws" npm package is required for WebSocket tests. Install with: npm i --save-dev ws @types/ws');
    }
}

export interface WsSendStep {
    message: string;
    waitFor?: string;
}

export interface WsExpectMessage {
    matches: string;
    timeoutMs?: number;
}

export interface WsScenarioDef {
    name: string;
    connect?: { headers?: Record<string, string> };
    send: WsSendStep[];
    expectMessages: WsExpectMessage[];
    expectClose?: { code?: number };
}

export interface WsRunResult {
    received: string[];
    closedCode?: number;
}

export interface WsRunArgs {
    url: string;
    headers: Record<string, string>;
    def: WsScenarioDef;
}

export class WebSocketClient {
    private ws?: WsLike;
    private received: string[] = [];
    private closedCode?: number;

    async connect(url: string, headers: Record<string, string>): Promise<void> {
        const Ctor = loadWsCtor();
        return new Promise<void>((resolve, reject) => {
            try {
                this.ws = new Ctor(url, { headers });
            } catch (e) {
                reject(e as Error);
                return;
            }
            this.ws.on('open', () => {
                CSReporter.info(\`WebSocket open \${url}\`);
                resolve();
            });
            this.ws.on('message', (data: unknown) => {
                const text = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
                this.received.push(text);
                CSReporter.debug(\`WebSocket message: \${text.slice(0, 200)}\`);
            });
            this.ws.on('close', (code: number) => {
                this.closedCode = code;
                CSReporter.info(\`WebSocket closed code=\${code}\`);
            });
            this.ws.on('error', (err: Error) => {
                CSReporter.error(\`WebSocket error: \${err.message}\`);
                reject(err);
            });
        });
    }

    async waitForMessage(regex: RegExp, timeoutMs: number): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        // First check messages already received.
        for (const m of this.received) if (regex.test(m)) return m;
        return new Promise<string>((resolve, reject) => {
            const iv = setInterval(() => {
                for (const m of this.received) {
                    if (regex.test(m)) {
                        clearInterval(iv);
                        resolve(m);
                        return;
                    }
                }
                if (Date.now() > deadline) {
                    clearInterval(iv);
                    reject(new Error(\`Timed out waiting for WebSocket message matching \${regex}\`));
                }
            }, 50);
        });
    }

    send(message: string): void {
        if (!this.ws) throw new Error('WebSocket not connected');
        this.ws.send(message);
        CSReporter.debug(\`WebSocket send: \${message.slice(0, 200)}\`);
    }

    close(code?: number): void {
        if (this.ws) this.ws.close(code);
    }

    getReceived(): string[] { return [...this.received]; }
    getClosedCode(): number | undefined { return this.closedCode; }
}

export async function runWsScenario(args: WsRunArgs): Promise<WsRunResult> {
    const client = new WebSocketClient();
    const mergedHeaders = { ...(args.def.connect?.headers || {}), ...args.headers };
    await client.connect(args.url, mergedHeaders);
    try {
        for (const step of args.def.send) {
            client.send(step.message);
            if (step.waitFor) {
                await client.waitForMessage(new RegExp(step.waitFor), 5000);
            }
        }
        for (const exp of args.def.expectMessages) {
            await client.waitForMessage(new RegExp(exp.matches), exp.timeoutMs || 5000);
        }
        if (args.def.expectClose) {
            client.close(args.def.expectClose.code);
            // Give the socket a tick to flush the close frame.
            await new Promise((r) => setTimeout(r, 100));
        }
    } finally {
        if (!args.def.expectClose) client.close();
    }
    return { received: client.getReceived(), closedCode: client.getClosedCode() };
}
`;
    fs.writeFileSync(filePath, src, 'utf-8');
    return filePath;
}

// ---------------------------------------------------------------------------
// README + env template.
// ---------------------------------------------------------------------------

export function emitWsReadme(args: EmitWsArgs): string {
    const filePath = path.join(args.outputRoot, 'README.md');
    fs.mkdirSync(args.outputRoot, { recursive: true });
    const lines: string[] = [];
    lines.push('# WebSocket test bundle');
    lines.push('');
    lines.push('Auto-generated by cs_qa_gen_protocol_test (verb: `websocket`).');
    lines.push('');
    lines.push('## Install (once per workspace)');
    lines.push('');
    lines.push('```bash');
    lines.push('npm i --save-dev ws @types/ws');
    lines.push('```');
    lines.push('');
    lines.push(`## Target endpoint: \`${args.wsUrl}\``);
    lines.push('');
    if (args.authTokenEnvVar) {
        lines.push(`Auth token env var: \`${args.authTokenEnvVar}\` — value MUST be pasted after \`ENCRYPTED:\` in \`.env.template\`.`);
        lines.push('');
    }
    lines.push(`## Scenarios covered (${args.scenarios.length})`);
    lines.push('');
    for (const s of args.scenarios) {
        lines.push(`- \`${s.name}\` — ${s.send.length} send step(s), ${s.expectMessages.length} expected message(s)`);
    }
    lines.push('');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
}

export function emitWsEnvTemplate(outputRoot: string, authTokenEnvVar?: string): string {
    const templatePath = path.join(outputRoot, '.env.template');
    fs.mkdirSync(outputRoot, { recursive: true });
    let existing = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : '';
    const key = authTokenEnvVar || 'WS_AUTH_TOKEN';
    const newLines: string[] = [];
    if (!existing.includes(`${key}=`)) newLines.push(`${key}=ENCRYPTED:`);
    if (existing.length === 0) {
        existing = '# Auto-generated by cs_qa_gen_protocol_test. Fill values via `cs-playwright-mcp encrypt <plain>` and paste after ENCRYPTED:.\n';
    }
    const finalText = existing + (newLines.length > 0 ? (existing.endsWith('\n') ? '' : '\n') + newLines.join('\n') + '\n' : '');
    fs.writeFileSync(templatePath, finalText, 'utf-8');
    return templatePath;
}
