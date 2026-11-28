/**
 * Local Studio server. Runs on the user's own machine only.
 *
 * Security model (local-first, no login):
 *  - binds to 127.0.0.1 — not reachable from the network;
 *  - a random per-launch token is required on every API call (Authorization: Bearer …), compared in
 *    constant time; the browser receives it once in the launch URL fragment (never sent to servers
 *    or logged by proxies);
 *  - Host header must be 127.0.0.1/localhost:<port> (blocks DNS-rebinding);
 *  - Origin, when present, must be this server (blocks other web pages calling the API);
 *  - secret VALUES are write-only through the API: they can be set, never read back.
 */
import { AsyncLocalStorage } from 'async_hooks';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import * as fs from 'fs';
import { runGit } from '../git/run';
import { installHooks } from '../git/hooks';
import { frameworkDefaultKeys, HealthCheck, missingKeys, nodeCheck, playwrightBrowsers, usedConfigKeys } from '../doctor/doctor';
import { safeRepoPath, writeFileInRepo } from '../core/safePath';
import * as path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DiffOptions, GitService, INDEX_LOCK_MESSAGE, Override, STALE_HUNK_MESSAGE } from '../git/service';
import { GitError } from '../git/run';
import { UserError } from '../core/errors';
import { SecretStore } from '../secrets/store';
import { allowlistFinding, allowlistMany, FindingRef, ignoreFile, moveManyToStore, moveToStore, planStore, removeMany, removeValue, unstageFile, unstageMany } from '../scanner/fixes';
import { secretsAsEnv } from '../secrets/store';
import { DEFAULT_SETTINGS, SettingsStore } from '../core/settings';
import { ROTATE_DAYS, secretUsage } from '../secrets/usage';
import { collectInbox, InboxNotifier } from '../agents/inbox';
import { EvalRunner, EVALS_DIR, readSuite, saveSuite, suiteVersion, validateSuite, type EvalRun } from '../agents/evals';
import { AGENT_TEMPLATES, deleteAgent, getAgent, listAgents, profileOf, saveAgent, TOOL_GROUPS, AGENTS_DIR, teamCandidates, teamMember } from '../agents/builder';
import { FINISHED as MISSION_FINISHED, label as missionLabel, MissionAgent, MissionDeps, MissionEngine, MissionRun, MissionTriggers, MISSIONS_FILE, PolledTriggers, readMissionsFile, TEMPLATES as BUILT_IN_MISSIONS, templates as missionTemplates } from '../agents/missions';
import { TEAM_MEMORY_FILE } from '../agents/host';
import { BASELINE_MAX } from '../agents/baselines';
import { changeCount } from '../agents/hunks';
import { ChangedElsewhere, checkVersion as checkAgentVersion, fileVersion as agentFileVersion, textVersion } from '../agents/version';
import { htmlText, KnowledgeBase, KnowledgeDoc, KNOWLEDGE_FILE } from '../agents/knowledge';
import { deliver, deliverInbox, Delivery, NotifyChannel, NotifyStore, previousState, runNote, secretName as notifySecret, shouldNotify, validateChannels, validateWebhook } from '../notify/notify';
import { applyGitNetwork, checkGitConnection, gitNetworkCommands, GitNetworkChange, gitNetworkState } from '../git/network';
import { checkConnection, checkUrl, connection, ConnectionExtras, NetworkSettings, PROXY_PASSWORD_SECRET, readCaFile, runEnvFor, systemCertsSupported } from '../core/network';
import { readSystemProxy, SystemProxy } from '../core/systemProxy';
import { Boards, ItemFilter } from '../ado/boards';
import { ApiAuth, ApiCollection, ApiRequest, newCollection, slug, validCollection } from '../api/model';
import { CookieJar } from '../api/cookies';
import { ApiResponse, authorize, CheckResult, evaluateAll, extract, fill, prepare, send, TokenCache, Values, sendWith } from '../api/send';
import { OAuthFlows } from '../api/oauth2';
import { variableScopes } from '../api/scopes';
import { grpcReflect, grpcServicesOf, loadProto, PROTOCOL_LABEL, redactUrl, runExchange, sampleMessage } from '../api/messaging';
import { INTROSPECTION_QUERY, introspectionOf, operationFor, outline as gqlOutline, schemaOf, validateQuery } from '../api/graphql';
import type { GraphQLSchema } from 'graphql';
import { renderVisualizer, runPreScripts, withGlobals, runTestScripts, scriptSender } from '../api/scripts';
import { SecretVault } from '../api/vault';
import { apiTestPlan, templateNames } from '../api/codegen/plan';
import { filterRows, fromCell, prepareValues, type QueryRows } from '../api/checks';
import { importCollection } from '../api/collectionImport';
import { parseCurl } from '../api/curl';
import { importOpenApi, parseSpec } from '../api/openapi';
import { importWsdl } from '../api/wsdl';
import { detectImport, importAsyncApi, importGraphqlSchema, importInsomnia, importJmeter, importRaml, importSoapUi } from '../api/importers';
import { mockFromCollection, recordMock, type MockRecorder } from '../api/mockBuild';
import { collectionPipeline } from '../api/headless';
import { mergeRecording, recordForLoad, type LoadRecorder } from '../load/recordLoad';
import { isOpenApiText, lintConfig, lintOpenApi } from '../api/openapiLint';
import { collectionHtml, collectionMarkdown } from '../api/docs';
import { collectionFlow } from '../api/flow';
import { suggestChecks } from '../api/suggest';
import { requestHistory } from '../api/requestHistory';
import { snippet, SNIPPET_LANGS, type SnippetLang } from '../api/snippets';
import { exportReport } from '../api/collectionExport';
import { CollectionRunner, compareRuns, runnerJUnit, runnerReport, type RunnerJob } from '../api/runner';
import { collectionRel, fileVersion, listCollections, readCollection, staleSave, takeSaveMeta, writeCollection } from '../api/store';
import { allRequests } from '../api/model';
import { LoadRuns, LoadRunDetail, LoadRunInfo, junit } from '../load/runs';
import { mergeRuns } from '../load/merge';
import { correlateMonitors, overlay, rangeStats, regression, steadyRange } from '../load/analysis';
import { findRunResults, listTeamRuns, publishRun, readTeamRun } from '../load/teamStore';
import { runDistributed } from '../load/controller';
import { programsInRepoConfig } from '../git/repoConfig';
import { cloneRepo, openStudio, recentRepos, rememberRepo, repoTop } from '../git/workspaces';
import { LoadScheduler } from '../load/schedule';
import { loadPipeline } from '../load/pipeline';
import { runInsights } from '../load/insights';
import { BugInfo, planBugActions, stateCategories } from '../quality/bugLifecycle';
import { LoadScenario, parseCsv, SlaProfile, validScenario, validSlaProfile } from '../load/scenario';
import { maxUsers } from '../load/policy';
import { prepareLoad, projectFileReader, scenarioFileOk, valuesFor, withVault } from '../load/prepare';
import { BrowserPathDef, importRecordedScenarios, readBrowserPath } from '../load/browserPath';
import { DEFAULT_REPORT_TEMPLATE, loadReportHtml, loadReportXlsx, REPORT_SECTIONS } from '../load/report';
import { differentScenarios, htmlToPdf, loadComparisonDocx, loadComparisonHtml, loadReportDocx } from '../load/reportDocs';
import { compareRuns as compareLoadRuns, explainRun } from '../load/explain';
import { DbSessions } from '../db/sessions';
import { DbType, DRIVER, listConnections, protectedEnvironment } from '../db/connections';
import { describeSource, loadDataRows } from '../data/load';
import { validSource } from '../data/source';
import { RecorderSessions, RecordOptions } from '../recorder/session';
import { StudioBrowser } from '../agents/browser';
import { AgentHost, AgentSettings, COPILOT_TOKEN_SECRET, DEFAULT_AGENT_SETTINGS, PROVIDER_KEY_SECRET } from '../agents/host';
import { convertScript } from '../recorder/convert';
import { Choices, DataChoice, dataBindings, markedBreaks, plan, rememberedValues, ValueMode } from '../recorder/generate';
import { formatOf, readTable, workbookBytes } from '../data/tables';
import { kebab } from '../framework/text';
import { applyCandidates, CorrelationCandidate, findCandidates, replayOnce } from '../load/correlate';
import { MockDefinition, mockFromOpenApi, mockProblems, RunningMock, startMock } from '../api/mock';
import { locatorPolicy, locatorSupport } from '../framework/locators';
import { selectSql } from '../db/schema';
import { CATALOG, listServers, loadStates, markReviewed, missingFor, parseImport, putServer, recordCheck, resolveServer, saveServer, Scope as ToolScope, sdkConfig, secretsOf, serversIn, stateKey, TEAM_FILE, testServer, ToolServer, updateState } from '../agents/toolServers';
import { applyChanges, formatGherkin, planRename, renameProblem, stepUsages } from '../lang/stepRefactor';
import { mcpToken, registerMcp } from '../mcp/http';
import { alignRows, cellValue, DATE_PRECISIONS, ignoreRule, compareRows, CompareOptions, CompareResult, compareVitals, describeComparison } from '../db/compare';
import { loadProjectModel, ModelDeps, ProjectModel } from '../framework/model';
import { applyPlan, ChangePlan, FileKind, Finding, PlanConflictError, reviewPlan, safePath } from '../framework/plan';
import { checkPlan } from '../framework/standards';
import { DB_TYPES, NewProject, scaffoldProject } from '../framework/scaffold';
import { frameworkPackage, frameworkPackageName } from '../framework/package';
import { stepFolders } from '../lang/steps';
import { classify, dangerous } from '../db/safety';
import { dbFeature, DbFeatureInput, featureSlug as dbFeatureSlug } from '../db/feature';
import { CheckOptions, CheckSource, checkFeature as pdfCheckFeature, checkSteps, compareModule, compareModuleDir, inspectPdf, listPdfs, pdfFeatureSlug, pdfPathIn } from '../pdfcheck/pdfcheck';
import { Cell, cellText } from '../db/cells';
import { xlsx, zip } from '../core/xlsx';
import { importHar } from '../api/har';
import { wsAsResponse, wsExchange, wsUrl } from '../api/ws';
import { automatedScenarios, testCaseIdsAt, branchNameFor, scenarioFromTestCase, WorkItems } from '../ado/workItems';
import { prDraft, PullRequests, remoteForRepository, VOTE_LABEL } from '../ado/pullRequests';
import type { PrFinish } from '../ado/pullRequests';
import { checkoutBase, checkoutPr, existingCheckout, prFileDiff, remotes as prRemotes, removeCheckout } from '../git/prWorktree';
import { teamTrends } from '../ado/analytics';
import { mergeTools, runMergeTool } from '../git/mergeTool';
import { bisectRange, runBisect, type BisectState, type TestAt } from '../git/bisect';
import { changeKind, ChangeKind, CoverageStore, prImpact, prStatusOf, recentFailures, selectionCheck } from '../run/prImpact';
import { resultsComment } from '../run/prComment';
import { AUTO_DOWNLOAD_BYTES, fetchArtifact, findReports, Pipelines, reportCandidates } from '../ado/pipelines';
import { getIdentity, setIdentity } from '../git/identity';
import { ConflictError, TextSearchOptions, Workspace } from '../workspace/files';
import { matcher } from '../workspace/textSearch';
import { checkVersion, contentVersion, StaleSaveError } from '../core/version';
import { TsService } from '../lang/tsService';
import { StaleCall, TsClient } from '../lang/tsClient';
import { CopilotInline } from '../lang/copilot';
import { projectFeatureFolder, readCatalog } from '../run/catalog';
import { attachmentTypeOf, entryFor, evidenceFor, publishTargets, runScenarios, tagsForMapping, uploadSettings, scenarioTestSteps, tagsToPublishTo, testCaseTag, TestPlans, TestPoint } from '../ado/testPlans';
import { filesDeclaring, groupHeals, HealDecision, HealEvent, healedOption, healsInReport, proposeEdit } from '../quality/healing';
import { accessibilityChecks, approveAria, approveVisual, ariaSnapshots, configuredDirs, insideRepo, ReviewDecision, StaleReview, visualSnapshots } from '../quality/visual';
import { bugReproHtml, bugsForTagsQuery, readTriage, signatureTag, TriageVerdict, VERDICTS, writeTriage } from '../quality/triage';
import { planCoverage, planSummary } from '../agents/plan';
import { buildQuality, collectRuns, DEFAULT_GATE, GateSettings, isQuarantineTag, QUARANTINE_TAG, readGate, setQuarantineTag, withScenarioTags, failureSignature } from '../quality/quality';
import { indexFeatures, projectPlaywrightCli, readEvidence, resultsRootOf } from '../run/evidence';
import { spawn } from 'child_process';
import { checkFeature, projectOfFeature, DEFAULT_STEP_PATHS, definitionFor, extractStepDefs, featureSteps, isStepFile, StepDef, StepIndex, stepSnippet } from '../lang/steps';
import { classNameFor, generateStep, insertStep, methodSource, StepGenError } from '../lang/stepGen';
import { scanLines } from '../scanner/scanner';
import { allReportFiles, buildArgs, frameworkCli, frameworkReadsScenarios, maskSecrets, RunInfo, RunRequest, TestRunner } from '../run/runner';
import { timingSafeEqual as tse } from 'crypto';
import { allowlistSet } from '../scanner/allowlist';
import { ActivityLog } from '../core/activity';
import { discover, fileLayerPaths, readFileLayer } from '../env/layers';
import { compareEnvironments, resolveConfig } from '../env/resolve';
import { checkUnchanged, createEnvironment, removeKey, setValue, storeSecret } from '../env/edit';
import { AdoClient, AdoSettings } from '../ado/client';
import { pipelineFile, testPipeline, TestPipelineOptions } from '../run/pipelineYaml';
import { adoSettingsFor, checkInAdo, readPipelineSettings, requirements, syncToAdo, writePipelineSettings } from '../ado/pipelineSecrets';

export interface ServerOptions {
    repoRoot: string;
    store: SecretStore;
    /** Project id used for secret scoping; defaults to the repository folder name. */
    projectId?: string;
    token?: string;
    userName?: string;
    /** Local activity log; when omitted nothing is recorded. */
    activity?: ActivityLog;
    /** Test hook: how to talk to Azure DevOps (defaults to the real REST API). */
    adoTransport?: AdoSettings['transport'];
    /** The Studio's private data folder (personal settings live here). */
    home?: string;
    /** Folder with the built UI (index.html + assets). Defaults to dist/ui next to the server. */
    uiDir?: string;
    /** Test hooks: the missions' agent and test runs (default: the Copilot agents and the framework). */
    missionAgent?: MissionAgent;
    missionRunTests?: MissionDeps['runTests'];
}

export interface StudioServer {
    app: FastifyInstance;
    token: string;
    git: GitService;
    listen(port?: number): Promise<{ url: string; port: number }>;
}

class BadRequest extends Error {}

/** A file system error as a sentence, its path relative to the repository (null: not a file system error). */
function fileErrorText(e: NodeJS.ErrnoException, root: string): string | null {
    const known: Record<string, string> = {
        ENOENT: 'is not there (it was moved or deleted)', ENAMETOOLONG: 'has a name that is too long for the file system (use a shorter name)',
        EACCES: 'cannot be opened: permission denied', EPERM: 'cannot be changed: permission denied (is it open in another program?)',
        EISDIR: 'is a folder, not a file', ENOTDIR: 'is inside something that is not a folder', EEXIST: 'exists already', EBUSY: 'is in use by another program',
        ENOTEMPTY: 'is a folder that is not empty', EMFILE: 'cannot be opened: too many files are open', ENOSPC: 'cannot be written: the disk is full',
    };
    if (!e?.code || !known[e.code]) return null;
    const rel = (p?: string) => { if (!p) return ''; const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/').replace(/\/\.[^/]*\.tmp$/, '').slice(0, 120) + (r.length > 120 ? '…' : '') : path.basename(p).slice(0, 80); };
    const where = rel(e.path);
    return `${where ? `"${where}"` : 'The file'} ${known[e.code]}.`;
}
/** The thing changed since the user looked at it (409). */
class Conflict extends Error { statusCode = 409; }
/** What the address names is not there (404): said in words, never with a path of this computer. */
class NotFound extends Error { statusCode = 404; }

/** A whole number a screen sent (iterations, minutes, generators): absent → `def`; a decimal, text or a number out of range is refused, never rounded or clamped. */
function wholeParam(v: unknown, label: string, min: number, max: number, def?: number): number {
    if ((v === undefined || v === null || v === '') && def !== undefined) return def;
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    const why = Number.isFinite(n) && !Number.isInteger(n) ? 'no decimals' : Number.isFinite(n) ? `not ${n}` : 'numbers only';
    throw new BadRequest(`${label}: a whole number from ${min} to ${max} (${why}).`);
}
/** A field's name in words for messages ("projectName" → "Project name", "id" → "The id"). */
function fieldName(field: string): string {
    const w = field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return w === 'id' ? 'The id' : w.charAt(0).toUpperCase() + w.slice(1);
}
function str(v: unknown, field: string, opts: { optional?: boolean; max?: number } = {}): string {
    if (v === undefined || v === null || v === '') {
        if (opts.optional) return '';
        throw new BadRequest(`${fieldName(field)} is missing: fill it in.`);
    }
    if (typeof v !== 'string') throw new BadRequest(`${fieldName(field)} must be text.`);
    if (v.length > (opts.max ?? 10_000)) throw new BadRequest(`${fieldName(field)} is too long (at most ${(opts.max ?? 10_000).toLocaleString('en')} characters).`);
    // A name or title of only spaces is no name.
    if (!opts.optional && /name$|title$/i.test(field) && !v.trim()) throw new BadRequest(`${fieldName(field)} is missing: fill it in.`);
    return v;
}

function strList(v: unknown, field: string): string[] {
    if (!Array.isArray(v) || v.length === 0 || v.length > 10_000 || !v.every((x) => typeof x === 'string' && x.length > 0)) {
        throw new BadRequest(`"${field}" must be a non-empty list of paths.`);
    }
    return v as string[];
}

function findingRef(v: unknown): FindingRef {
    const o = (v ?? {}) as Record<string, unknown>;
    const line = Number(o.line);
    if (!Number.isInteger(line) || line < 0) throw new BadRequest('"finding.line" is invalid.');
    return { fingerprint: str(o.fingerprint, 'finding.fingerprint', { max: 64 }), file: str(o.file, 'finding.file', { max: 4096 }), line };
}

const uiDirForReports = (dir: string) => dir;

/**
 * Repairs two faults of framework HTML reports made before they were fixed in the framework, so
 * reports already on disk work: the embedded chart code is a CommonJS module and stops at
 * "exports" in the browser (no charts), and the scenario video player asks for CORS
 * (crossorigin="anonymous"), which stops the video from loading.
 */
export function repairFrameworkReport(html: string): string {
    let out = html;
    if (/exports\.CSChart\s*=/.test(out) && !/var exports\s*=/.test(out)) {
        out = out.replace(/(<!-- Custom Chart Library \(embedded\)[^>]*-->\s*)<script>/, '$1<script>var exports = {};</script><script>');
    }
    return out.replace(/(<video\b[^>]*?)\s+crossorigin="anonymous"/g, '$1');
}
/** An HTML report file, repaired; other files as they are. */
/**
 * A path relative to a folder, as a URL path ("videos/page.webm"). On Windows path.relative gives
 * "videos\\page.webm", and the static file server refuses any "\\" as Forbidden: every screenshot, video
 * and file in a sub-folder of a run's results failed there (the report itself, at the top, opened).
 */
export const urlPathOf = (rel: string, sep: string = path.sep) => rel.split(sep).join('/');
const sendReportFile = (reply: FastifyReply, rel: string, root: string) => {
    if (!/\.html?$/i.test(rel)) return reply.sendFile(urlPathOf(rel), root);
    const html = fs.readFileSync(path.join(root, rel), 'utf8');
    return reply.type('text/html; charset=utf-8').send(repairFrameworkReport(html));
};

/** The repository's git directory (works in linked worktrees, where .git is a file). */
/**
 * What a save of the run configurations did, for the activity log ("Deleted the saved run "Smoke"", not "Saved 0").
 * The list is saved whole, so the change is worked out from the names before and after.
 */
export function runConfigsChange<T extends { name: string }>(before: T[], after: T[]): string {
    const key = (c: { name: string }) => c.name.toLowerCase();
    const was = new Map(before.map((c) => [key(c), c]));
    const now = new Map(after.map((c) => [key(c), c]));
    const q = (l: T[]) => l.map((c) => `"${c.name}"`).join(', ');
    const added = after.filter((c) => !was.has(key(c)));
    const removed = before.filter((c) => !now.has(key(c)));
    const changed = after.filter((c) => was.has(key(c)) && JSON.stringify(was.get(key(c))) !== JSON.stringify(c));
    const parts: string[] = [];
    if (added.length) parts.push(`Saved run${added.length === 1 ? '' : 's'} added: ${q(added)}`);
    if (changed.length) parts.push(`Saved run${changed.length === 1 ? '' : 's'} replaced: ${q(changed)}`);
    if (removed.length) parts.push(`Saved run${removed.length === 1 ? '' : 's'} deleted: ${q(removed)}`);
    return parts.length ? parts.join('; ') : `Saved runs written again unchanged (${after.length})`;
}

function gitDirOf(root: string): string {
    const dotgit = path.join(root, '.git');
    try {
        if (fs.statSync(dotgit).isFile()) {
            const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
            if (m) return path.resolve(root, m[1].trim());
        }
    } catch { /* fall through */ }
    return dotgit;
}

function diffOpts(q: Record<string, string>): DiffOptions {
    return {
        ignoreWhitespace: q.ws === 'changes' || q.ws === 'all' ? q.ws : 'none',
        ignoreLineEndings: q.eol === 'true',
    };
}

function override(v: unknown): Override | undefined {
    if (v === undefined || v === null) return undefined;
    const o = v as Record<string, unknown>;
    return { reason: str(o.reason, 'override.reason', { max: 500 }), digest: str(o.digest, 'override.digest', { max: 64 }) };
}

export function createServer(opts: ServerOptions): StudioServer {
    const token = opts.token ?? randomBytes(32).toString('base64url');
    const tokenBuf = Buffer.from(token);
    const projectId = opts.projectId ?? (opts.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'project').replace(/[^A-Za-z0-9_.-]/g, '-');
    const git = new GitService(opts.repoRoot, { knownSecrets: () => opts.store.knownSecrets() });
    // Files up to 5 MB can be edited; JSON escaping can double the size of a request body.
    const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
    const settings = opts.home ? new SettingsStore(opts.home) : null;
    const personal = () => settings?.get() ?? { ...DEFAULT_SETTINGS };
    /** The Studio's own network connection (Settings → Network); the proxy password is a Studio secret. */
    // The computer's proxy (system mode) and the PAC file's text, read in the background (at start, when the
    // network settings change, every 30 minutes): requests then decide per address without waiting.
    let netInfo: { system?: SystemProxy; pacScript?: string; pacFrom?: string; error?: string } = {};
    const proxyPassword = () => { const n = personal().network; return n.proxyUser && opts.store.exists ? opts.store.getStudio(PROXY_PASSWORD_SECRET) : undefined; };
    const studioSecret = (name: string) => (opts.store.exists ? opts.store.getStudio(name) : undefined);
    const refreshNetInfo = async () => {
        const n = personal().network;
        const next: typeof netInfo = {};
        try {
            if (n.proxyMode === 'system') next.system = await readSystemProxy();
            const pacUrl = n.proxyMode === 'pac' ? n.pacUrl : n.proxyMode === 'system' ? next.system?.pacUrl : undefined;
            if (pacUrl) {
                next.pacFrom = pacUrl;
                next.pacScript = /^https?:/i.test(pacUrl)
                    ? (await send({ method: 'GET', url: pacUrl, headers: {}, missing: [] }, connection({ ...n, proxyMode: 'off' }, process.env, undefined, { readFile: (f) => fs.readFileSync(f) }), 15_000)).body
                    : fs.readFileSync(pacUrl.replace(/^file:\/\//i, ''), 'utf8');
            }
        } catch (e) { next.error = `The proxy settings could not be read: ${(e as Error).message}`; }
        netInfo = next;
    };
    void refreshNetInfo();
    const netTimer = setInterval(() => void refreshNetInfo(), 30 * 60_000);
    netTimer.unref();
    const netExtras = (): ConnectionExtras => ({ system: netInfo.system, pacScript: netInfo.pacScript, secret: studioSecret });
    const netConnection = () => connection(personal().network, process.env, proxyPassword(), netExtras());
    /** What a load worker needs to make the same connection (serializable: the secrets it uses, not the store). */
    const workerNet = () => {
        const n = personal().network;
        const secrets = Object.fromEntries((n.clientCerts ?? []).filter((c) => c.passphraseSecret).map((c) => [c.passphraseSecret!, studioSecret(c.passphraseSecret!) ?? '']));
        return { network: n, proxyPassword: proxyPassword(), netExtras: { system: netInfo.system, pacScript: netInfo.pacScript, secrets } };
    };
    let port = 0;
    // Changes an agent makes through the screens' API are marked with its conversation in the activity log.
    const agentActor = new AsyncLocalStorage<{ session: string; title: string }>();
    // Fastify does not keep the caller's async context for requests with a body, so the in-process call
    // hands the conversation over with a one-time key that a hook turns back into the context.
    const agentCalls = new Map<string, { session: string; title: string }>();
    const log = (action: string, summary: string, data?: Record<string, string | number | boolean | null>) => {
        const a = agentActor.getStore();
        opts.activity?.record({ action, repo: opts.repoRoot, summary: a ? `${summary} (by an agent: ${a.title})` : summary, data: a ? { ...(data ?? {}), agentSession: a.session } : data });
    };
    const configProjectParam = (v: unknown) => {
        const p = str(v, 'project', { max: 64 });
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p)) throw new BadRequest('"project" is invalid.');
        return p;
    };
    const envParam = (v: unknown, field = 'env') => {
        const e = str(v, field, { max: 32 });
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(e)) throw new BadRequest(`"${field}" is invalid.`);
        return e;
    };
    /** Effective config as a test run started from the Studio would see it. */
    const resolveFor = (project: string, environment: string) => {
        const secretEnv = secretsAsEnv(opts.store, { project: projectId, env: environment });
        const first = resolveConfig({ repoRoot: opts.repoRoot, project, environment, secretEnv });
        // OS environment variables override files in the framework; include those that do.
        const fileKeys = new Set(first.entries.map((e) => e.key));
        const processEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && fileKeys.has(k) && !(k in secretEnv)) processEnv[k] = v;
        const osEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CS_STUDIO_')) osEnv[k] = v;
        return resolveConfig({ repoRoot: opts.repoRoot, project, environment, secretEnv, processEnv, osEnv });
    };

    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        const host = String(req.headers.host ?? '');
        const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (port !== 0 && !allowedHosts.includes(host)) return reply.code(421).send({ error: 'Unexpected Host header.' });
        const origin = req.headers.origin;
        if (origin && port !== 0 && !allowedHosts.some((h) => origin === `http://${h}`)) {
            return reply.code(403).send({ error: 'Requests from other sites are not allowed.' });
        }
        // Decide on what the ROUTER matched (decoded), never on the raw URL text: '/%61pi/…' and
        // '/api%2F…' decode to API routes and must not skip the token check.
        const route = req.routeOptions?.url ?? '';
        let decoded = '';
        try { decoded = decodeURIComponent(req.url.split('?')[0]); } catch { decoded = req.url; }
        const isApi = route.startsWith('/api') || decoded.toLowerCase().startsWith('/api');
        // HTML reports open in a browser tab, which cannot send the token: they use a per-run key.
        if (!isApi && (route.startsWith('/report/') || route.startsWith('/pipeline-report/'))) return;
        if (isApi) {
            const auth = String(req.headers.authorization ?? '');
            const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
            if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
                return reply.code(401).send({ error: 'Missing or invalid Studio token. Open the Studio from the link printed when it started.' });
            }
        }
    });

    // A few errors the UI offers a specific action for ("Refresh", "Remove the stale lock").
    const errorCode = (m: string) => m === STALE_HUNK_MESSAGE ? 'stale-hunk' : m.includes(INDEX_LOCK_MESSAGE) ? 'index-lock' : undefined;
    app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
        if (err instanceof StaleSaveError) return reply.code(409).send({ error: err.message, code: err.code, ...(err.current ? { version: err.current } : {}) });
        if (err instanceof ConflictError) return reply.code(409).send({ error: err.message, conflict: true, ...(err.deleted ? { deleted: true, code: 'deleted' } : {}) });
        if (err instanceof BadRequest || err instanceof UserError) return reply.code(400).send({ error: err.message, code: errorCode(err.message) });
        if (err instanceof GitError) return reply.code(409).send({ error: err.message, code: errorCode(err.message) });
        if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
        // File system errors in words, with paths inside the repository (not this computer's folders).
        const fsErr = fileErrorText(err as NodeJS.ErrnoException, opts.repoRoot);
        if (fsErr) return reply.code(400).send({ error: fsErr });
        // Messages from our own services are written for users and never contain secret values.
        return reply.code(500).send({ error: err.message || 'Unexpected error.' });
    });

    app.addHook('preHandler', (req, _reply, done) => {
        const k = req.headers['x-cs-agent-call'];
        const a = typeof k === 'string' ? agentCalls.get(k) : undefined;
        if (a) agentActor.run(a, done); else done();
    });
    app.addHook('onSend', async (_req: FastifyRequest, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('X-Frame-Options', 'DENY');
        // The UI loads only its own files; antd needs inline style attributes.
        if (_req.url.startsWith('/report/') || _req.url.startsWith('/pipeline-report/')) {
            // The framework's HTML report uses inline scripts/styles; it may only talk to this server.
            reply.header('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'none'");
            reply.header('X-Frame-Options', 'SAMEORIGIN');
        } else {
            reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        }
        return payload;
    });

    type Body = Record<string, unknown>;
    const body = (req: FastifyRequest): Body => (req.body && typeof req.body === 'object' ? (req.body as Body) : {});

    app.get('/api/health', async () => ({ ok: true, repoRoot: opts.repoRoot, projectId }));
    // ---- Health check: what a test run needs, with a fix where the Studio can make one.
    app.get('/api/doctor', async (req) => {
        const q = req.query as Record<string, string>;
        const checks: HealthCheck[] = [nodeCheck()];
        const gitV = await runGit(['--version'], { cwd: opts.repoRoot, allowFailure: true });
        checks.push({ id: 'git', group: 'This computer', title: gitV.stdout.trim() || 'Git', level: gitV.code === 0 ? 'ok' : 'error', detail: gitV.code === 0 ? 'Installed.' : 'Git is not installed or not on the PATH.' });
        const fw = frameworkPackage(opts.repoRoot);
        let fwVersion = '';
        try { fwVersion = fw ? JSON.parse(fs.readFileSync(path.join(fw.dir, 'package.json'), 'utf8')).version : ''; } catch { /* unreadable */ }
        checks.push(fw ? { id: 'framework', group: 'Repository', title: `Framework ${fwVersion}`, level: 'ok', detail: `${fw.name} is installed.` }
            : { id: 'framework', group: 'Repository', title: 'Framework', level: 'error', detail: 'The framework is not installed in this repository: run npm install (or npm install @mdakhan.mak/cs-playwright-test-framework).' });
        const disc = discover(opts.repoRoot);
        const project = q.project && disc.projects.includes(q.project) ? q.project : disc.projects[0];
        const env = project ? (q.env && (disc.environments[project] ?? []).includes(q.env) ? q.env : (disc.environments[project] ?? [])[0]) : undefined;
        let values: Record<string, string> = {};
        if (project && env) try { values = Object.fromEntries(resolveFor(project, env).entries.map((e) => [e.key, e.value ?? ''])); } catch { /* no config */ }
        const exe = values.BROWSER_EXECUTABLE_PATH?.trim();
        const pw = playwrightBrowsers(opts.repoRoot);
        if (exe) checks.push({ id: 'browsers', group: 'This computer', title: 'Browser', level: fs.existsSync(exe) ? 'ok' : 'error', detail: fs.existsSync(exe) ? `BROWSER_EXECUTABLE_PATH: ${exe}` : `BROWSER_EXECUTABLE_PATH points to ${exe}, which does not exist.` });
        else if (!pw) checks.push({ id: 'browsers', group: 'This computer', title: 'Browsers', level: 'warning', detail: 'Playwright is not installed in this repository (it comes with the framework: npm install).' });
        else checks.push(pw.chromium?.installed ? { id: 'browsers', group: 'This computer', title: `Browsers (Playwright ${pw.version})`, level: 'ok', detail: 'Chromium is installed.' }
            : { id: 'browsers', group: 'This computer', title: `Browsers (Playwright ${pw.version})`, level: 'error', detail: 'Chromium for this Playwright version is not installed. Install it, or set BROWSER_EXECUTABLE_PATH to a browser on this computer.', fix: { action: 'install-browsers', label: 'Install Chromium' } });
        let hookOk = false;
        try { hookOk = fs.readFileSync(path.join(gitDirOf(opts.repoRoot), 'hooks', 'pre-commit'), 'utf8').includes('cs-test-studio'); } catch { /* none */ }
        checks.push(hookOk ? { id: 'hooks', group: 'Repository', title: 'Secret scan before each commit', level: 'ok', detail: 'The Git hooks are installed: commits from any tool are scanned for secrets.' }
            : { id: 'hooks', group: 'Repository', title: 'Secret scan before each commit', level: 'warning', detail: 'Commits made outside the Studio (other tools, the command line) are not scanned for secrets.', fix: { action: 'install-hooks', label: 'Install the Git hooks' } });
        if (project && env) {
            let problems: Array<{ severity: string; message: string; key?: string }> = [];
            try { problems = resolveFor(project, env).problems as typeof problems; } catch { /* no config */ }
            const errs = problems.filter((p) => p.severity === 'error');
            checks.push({ id: 'config', group: `${project} / ${env}`, title: 'Configuration', level: errs.length ? 'error' : problems.some((p) => p.severity === 'warning') ? 'warning' : 'ok',
                detail: problems.length ? problems.slice(0, 6).map((p) => `${p.key ? `${p.key}: ` : ''}${p.message}`).join(' · ') : 'No problems found.' });
            const missing = missingKeys(usedConfigKeys(opts.repoRoot), new Set(Object.keys(values)), frameworkDefaultKeys(opts.repoRoot));
            checks.push({ id: 'keys', group: `${project} / ${env}`, title: 'Configuration keys the tests use', level: missing.length ? 'warning' : 'ok',
                detail: missing.length ? `Not set for ${project}/${env}: ${missing.slice(0, 12).map((m) => `${m.key} (${m.file})`).join(', ')}${missing.length > 12 ? ` … ${missing.length - 12} more` : ''}` : 'Every key the features and steps refer to is set.' });
            for (const k of ['BASE_URL', 'API_BASE_URL']) {
                const u = values[k]?.trim();
                if (!u || /[{}$]/.test(u) || !/^https?:\/\//i.test(u)) continue;
                const r = await checkUrl(u, netConnection());
                checks.push({ id: `url-${k}`, group: `${project} / ${env}`, title: `${k} ${u}`, level: r.ok ? 'ok' : 'error', detail: r.message });
            }
            if (values.ADO_ORGANIZATION || values.ADO_ORGANIZATION_URL) {
                try {
                    const st = adoSettingsFor(opts.repoRoot, opts.store, projectId, project, env, process.env, personal());
                    const r = await checkConnection(`${st.orgUrl}/_apis/connectionData`, netConnection(), st.bearer ? `Bearer ${await st.bearer()}` : `Basic ${Buffer.from(`:${st.pat}`).toString('base64')}`);
                    checks.push({ id: 'ado', group: `${project} / ${env}`, title: `Azure DevOps ${st.orgUrl}`, level: r.ok ? 'ok' : 'error', detail: r.message });
                } catch (e) { checks.push({ id: 'ado', group: `${project} / ${env}`, title: 'Azure DevOps', level: 'warning', detail: (e as Error).message }); }
            }
        }
        return { project, env, projects: disc.projects, environments: disc.environments, checks };
    });
    app.post('/api/doctor/fix', async (req) => {
        const action = str(body(req).action, 'action', { max: 40 });
        if (action === 'install-hooks') {
            const files = await installHooks(opts.repoRoot, { cliPath: path.resolve(__dirname, '..', 'cli.js') });
            log('doctor.fix', 'Installed the Git hooks (secret scan before each commit)', {});
            return { done: `Installed: ${files.map((f) => path.basename(f)).join(', ')}` };
        }
        if (action === 'install-browsers') {
            const cli = (() => { try { return require.resolve('playwright/cli.js', { paths: [opts.repoRoot] }); } catch { try { return require.resolve('playwright-core/cli.js', { paths: [opts.repoRoot] }); } catch { return null; } } })();
            if (!cli) throw new BadRequest('Playwright is not installed in this repository: run npm install first.');
            const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
                const child = require('child_process').spawn(process.execPath, [cli, 'install', 'chromium'], { cwd: opts.repoRoot, env: { ...process.env, ...runEnvFor(personal().network, process.env) }, windowsHide: true });
                let out = '';
                child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
                child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
                child.on('close', (code: number | null) => resolve({ code, out }));
                setTimeout(() => child.kill(), 15 * 60_000);
            });
            log('doctor.fix', `Installed Chromium for Playwright: ${r.code === 0 ? 'done' : 'failed'}`, {});
            if (r.code !== 0) throw new BadRequest(`The browser could not be installed:\n${r.out.split('\n').slice(-8).join('\n')}`);
            return { done: 'Chromium is installed.' };
        }
        throw new BadRequest('Unknown fix.');
    });

    // ---- Git
    app.get('/api/git/status', async () => git.status());
    app.get('/api/git/branches', async () => git.branches());
    app.get('/api/git/incoming', async () => git.incoming());
    app.get('/api/git/log', async (req) => {
        const q = req.query as Record<string, string>;
        const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 1000);
        return git.log({ limit, ref: q.ref || undefined, path: q.path || undefined });
    });
    app.get('/api/git/diff', async (req) => {
        const q = req.query as Record<string, string>;
        const file = str(q.file, 'file', { max: 4096 });
        git.safePath(file);
        return { diff: await git.diff(file, q.staged === 'true', diffOpts(q)) };
    });
    app.post('/api/git/stage', async (req) => { await git.stage(strList(body(req).paths, 'paths')); return git.status(); });
    app.post('/api/git/unstage', async (req) => { await git.unstage(strList(body(req).paths, 'paths')); return git.status(); });
    app.post('/api/git/commit', async (req) => {
        const b = body(req);
        const ov = override(b.override);
        const amend = b.amend === true;
        // expectBranch: the branch the screen showed ("Commit … to main"); null = it showed a detached commit.
        const expectBranch = b.expectBranch === null ? null : typeof b.expectBranch === 'string' ? str(b.expectBranch, 'expectBranch', { max: 255 }) : undefined;
        const res = await git.commit(str(b.message, 'message', { max: 20_000 }), ov, { amend, allowRewritePushed: b.allowRewritePushed === true, signoff: b.signoff === true, expectBranch });
        if (res.status === 'ok') {
            log('git.commit', `${amend ? 'Amended last commit' : 'Committed'} ${res.sha?.slice(0, 7)}${res.overridden ? ' with a secret-scan override' : ''}`,
                { sha: res.sha ?? null, amend, overrideReason: res.overridden ? ov?.reason ?? null : null });
        } else if (res.status === 'blocked') {
            log('secret-scan.blocked', `Commit stopped: ${res.findings.length} possible secret(s)`, { findings: res.findings.length });
        }
        return res;
    });
    app.post('/api/git/push', async (req) => {
        const b = body(req);
        const ov = override(b.override);
        const forceWithLease = b.forceWithLease === true;
        const res = await git.push(ov, { forceWithLease, tags: b.tags === true });
        if (res.status === 'ok' && forceWithLease) log('git.push.force', 'Pushed with force-with-lease (rewrote the remote branch)', {});
        if (res.status === 'ok') log('git.push', res.overridden ? 'Pushed with a secret-scan override' : 'Pushed', { overrideReason: res.overridden ? ov?.reason ?? null : null });
        else if (res.status === 'blocked') log('secret-scan.blocked', `Push stopped: ${res.findings.length} possible secret(s)`, { findings: res.findings.length });
        return res;
    });
    app.post('/api/git/pull', async (req) => {
        const m = (req.body as { mode?: string } | undefined)?.mode;
        const r = await git.pull(m === 'merge' || m === 'rebase' || m === 'ff-only' ? m : undefined);
        if (r.localEdits) log('git.pull', `Pulled ${r.pulled ?? 0} commit(s); uncommitted edits clash in ${r.conflicts?.length ?? 0} file(s) (kept in ${r.stash})`, { conflicts: r.conflicts?.length ?? 0 });
        return r;
    });
    // A pull whose put-aside edits clashed: undo it (branch and edits back as before) or finish it (drop the stash copy).
    app.post('/api/git/pull/autostash', async (req) => {
        const action = body(req).action;
        if (action !== 'undo' && action !== 'finish') throw new BadRequest('Give "action": "undo" or "finish".');
        const r = action === 'undo' ? await git.undoPullAutostash() : await git.finishPullAutostash();
        log(action === 'undo' ? 'git.pull.undo' : 'git.pull.finish', r.message, {});
        return { ...(await git.status()), message: r.message };
    });
    app.get('/api/git/pull/mode', async () => ({ mode: await git.pullMode() }));
    app.get('/api/git/commit-template', async () => ({ template: await git.commitTemplate() }));
    app.get('/api/git/clean', async (req) => ({ files: await git.cleanPreview((req.query as Record<string, string>).ignored === 'true') }));
    app.post('/api/git/clean', async (req) => {
        const b = body(req);
        if (!Array.isArray(b.files) || b.files.some((f: unknown) => typeof f !== 'string')) throw new BadRequest('"files" must be a list of paths.');
        const r = await git.clean(b.files as string[], b.ignored === true);
        log('git.clean', `Deleted ${r.removed.length} untracked file(s)`, { files: r.removed.length, ...(r.recoveryDir ? { recoveryDir: relPath(r.recoveryDir) } : {}) });
        return r;
    });
    app.get('/api/git/reflog', async (req) => git.reflog(Number((req.query as Record<string, string>).limit) || 100));
    app.post('/api/git/rebase', async (req) => {
        const b = body(req);
        const onto = str(b.onto, 'onto', { max: 300 });
        if (Array.isArray(b.todo)) {
            const r = await git.rebaseInteractive(onto, (b.todo as Array<Record<string, unknown>>).slice(0, 500).map((t) => ({ sha: String(t.sha ?? ''), action: String(t.action ?? '') as 'pick', ...(typeof t.message === 'string' ? { message: t.message.slice(0, 20_000) } : {}) })));
            log('git.rebase', `Rebased interactively onto ${onto} (${(b.todo as unknown[]).length} commits)`, { status: r.status });
            return r;
        }
        const r = await git.rebaseOnto(onto);
        log('git.rebase', `Rebased onto ${onto}`, { status: r.status });
        return r;
    });
    app.get('/api/git/since', async (req) => git.commitsSince(str((req.query as Record<string, string>).base, 'base', { max: 200 })));
    app.get('/api/git/blame', async (req) => { const q = req.query as Record<string, string>; return git.blame(str(q.file, 'file', { max: 4096 }), q.rev ? str(q.rev, 'rev', { max: 200 }) : undefined); });
    app.get('/api/git/remotes', async () => git.remotes());
    app.post('/api/git/remotes', async (req) => {
        const b = body(req);
        const name = str(b.name, 'name', { max: 100 });
        if (b.action === 'remove') await git.removeRemote(name);
        else if (b.action === 'rename') await git.renameRemote(name, str(b.to, 'to', { max: 100 }));
        else if (b.action === 'set-url') await git.setRemoteUrl(name, str(b.url, 'url', { max: 2000 }));
        else await git.addRemote(name, str(b.url, 'url', { max: 2000 }));
        log('git.remote', `Remote ${name}: ${typeof b.action === 'string' ? b.action : 'add'}`, {});
        return git.remotes();
    });
    app.get('/api/git/submodules', async () => git.submodules());
    app.post('/api/git/submodules/update', async () => { await git.updateSubmodules(); return git.submodules(); });
    app.get('/api/git/lfs', async () => git.lfs());
    app.post('/api/git/lfs/pull', async () => { await git.lfsPull(); return git.lfs(); });
    app.post('/api/git/conflict/base', async (req) => { await git.conflictWithBase(str(body(req).file, 'file', { max: 4096 })); return { ok: true }; });
    app.post('/api/git/trust-folder', async () => { await git.trustFolder(); log('git.safe-directory', 'Trusted the repository folder (safe.directory)', {}); return { ok: true }; });
    app.post('/api/git/fetch', async () => ({ ok: true, ...(await git.fetch()) }));
    app.post('/api/git/branch', async (req) => {
        const b = body(req);
        await git.createBranch(str(b.name, 'name', { max: 255 }), { from: str(b.from, 'from', { optional: true, max: 255 }) || undefined, switchTo: b.switchTo !== false });
        return git.status();
    });
    app.post('/api/git/switch', async (req) => {
        const b = body(req);
        const r = await git.switchBranch(str(b.name, 'name', { max: 255 }), { stash: b.stash === true });
        return { ...(await git.status()), autoStash: r.autoStash, stashed: r.stashed };
    });
    app.post('/api/git/merge', async (req) => {
        const b = body(req);
        return git.merge(str(b.branch, 'branch', { max: 255 }), { noFastForward: b.noFastForward === true, squash: b.squash === true, noCommit: b.noCommit === true });
    });
    app.post('/api/git/merge/abort', async () => { const r = await git.abortMerge(); return { ...(await git.status()), ...(r.message ? { message: r.message } : {}) }; });
    // ---- A conflict in the user's own merge tool (it stays open as long as they need; the page asks how it ended).
    const mergeToolRuns = new Map<string, { tool: string; startedAt: string; done?: { resolved: boolean; message: string; at: string } }>();
    app.get('/api/git/mergetools', async () => ({ ...(await mergeTools(opts.repoRoot)), runs: Object.fromEntries(mergeToolRuns) }));
    app.post('/api/git/mergetool', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 4096 }), tool = str(b.tool, 'tool', { max: 100 });
        if (mergeToolRuns.get(file) && !mergeToolRuns.get(file)!.done) throw new BadRequest(`${file} is already open in ${mergeToolRuns.get(file)!.tool}.`);
        const { tools } = await mergeTools(opts.repoRoot);
        if (!tools.some((t) => t.name === tool)) throw new BadRequest(`${tool} is not a merge tool Git can start here.`);
        const run: { tool: string; startedAt: string; done?: { resolved: boolean; message: string; at: string } } = { tool, startedAt: new Date().toISOString() };
        mergeToolRuns.set(file, run);
        log('git.mergetool', `Opened ${file} in ${tool}`);
        void runMergeTool({ cwd: opts.repoRoot, file, tool, known: tools })
            .then((r) => { run.done = { ...r, at: new Date().toISOString() }; log('git.mergetool', `${file}: ${r.message}`); })
            .catch((e) => { run.done = { resolved: false, message: (e as Error).message, at: new Date().toISOString() }; });
        // Fails at once (a tool that cannot start) are answered now.
        await new Promise((r) => setTimeout(r, 300));
        return { file, ...run };
    });
    app.get('/api/git/conflict', async (req) => {
        const file = str((req.query as Record<string, string>).file, 'file', { max: 4096 });
        git.safePath(file);
        return git.conflictVersions(file);
    });
    app.post('/api/git/conflict/resolve', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 4096 });
        git.safePath(file);
        let r: { deleted: boolean; message?: string };
        if (b.choice === 'ours' || b.choice === 'theirs') r = await git.resolveConflict(file, b.choice);
        else if (typeof b.content === 'string') r = await git.resolveConflict(file, { content: b.content });
        else throw new BadRequest('Give "choice": "ours" | "theirs", or the merged "content".');
        return { ...(await git.status()), resolved: r };
    });

    // ---- History, compare, undo
    app.get('/api/git/history', async (req) => {
        const q = req.query as Record<string, string>;
        return git.history({
            limit: Number(q.limit) || 300, skip: Number(q.skip) || 0, all: q.all === 'true',
            refs: q.refs ? q.refs.split(',').filter(Boolean) : undefined,
            text: q.text || undefined, field: (['message', 'author', 'path'].includes(q.field) ? q.field : 'message') as 'message' | 'author' | 'path',
            path: q.path || undefined, since: q.since || undefined, until: q.until || undefined,
            firstParent: q.firstParent === 'true', noMerges: q.noMerges === 'true',
        });
    });
    app.get('/api/git/commit', async (req) => git.commitDetails(str((req.query as Record<string, string>).rev, 'rev', { max: 200 })));
    app.get('/api/git/commit/diff', async (req) => {
        const q = req.query as Record<string, string>;
        const file = str(q.file, 'file', { max: 4096 });
        return { diff: await git.commitFileDiff(str(q.rev, 'rev', { max: 200 }), file, diffOpts(q)) };
    });
    app.get('/api/git/compare', async (req) => {
        const q = req.query as Record<string, string>;
        return git.compare(str(q.a, 'a', { max: 200 }), str(q.b, 'b', { max: 200 }), q.threeDot === 'true');
    });
    app.get('/api/git/compare/diff', async (req) => {
        const q = req.query as Record<string, string>;
        return { diff: await git.compareFileDiff(str(q.a, 'a', { max: 200 }), str(q.b, 'b', { max: 200 }), str(q.file, 'file', { max: 4096 }), q.threeDot === 'true', diffOpts(q)) };
    });
    app.get('/api/git/messages', async () => git.recentMessages());
    app.post('/api/git/revert', async (req) => {
        const rev = str(body(req).rev, 'rev', { max: 200 });
        const r = await git.revert(rev);
        log('git.revert', `Reverted ${rev.slice(0, 7)}${r.status === 'conflicts' ? ' (needs conflict resolution)' : ''}`, { rev });
        return r;
    });
    app.post('/api/git/cherry-pick', async (req) => {
        const revs = strList(body(req).revs, 'revs');
        const r = await git.cherryPick(revs);
        log('git.cherry-pick', `Cherry-picked ${revs.length} commit(s)`, { revs: revs.map((x) => x.slice(0, 7)).join(', ') });
        return r;
    });
    app.post('/api/git/operation/continue', async (req) => git.continueOperation(override(body(req).override)));
    app.post('/api/git/operation/skip', async () => { const r = await git.skipOperation(); log('git.skip', 'Skipped the commit being applied', {}); return r; });
    app.post('/api/git/operation/abort', async () => { const r = await git.abortOperation(); log('git.abort', r.message ?? 'Aborted the operation in progress', {}); return { ...(await git.status()), ...(r.message ? { message: r.message } : {}) }; });
    app.post('/api/git/reset', async (req) => {
        const b = body(req);
        const mode = str(b.mode, 'mode', { max: 5 }) as 'soft' | 'mixed' | 'hard';
        const rev = str(b.rev, 'rev', { max: 200 });
        const r = await git.reset(rev, mode);
        log('git.reset', `Reset (${mode}) to ${rev.slice(0, 7)}; recovery point saved`, { mode, rev, backup: r.backup });
        return r;
    });
    app.get('/api/git/backups', async () => git.backups());
    app.post('/api/git/backups/restore', async (req) => {
        const ref = str(body(req).ref, 'ref', { max: 200 });
        await git.restoreBackup(ref);
        log('git.restore', `Restored recovery point ${ref.split('/').pop()}`, { ref });
        return git.status();
    });
    app.post('/api/git/discard', async (req) => {
        const paths = strList(body(req).paths, 'paths');
        const r = await git.discard(paths);
        log('git.discard', `Discarded changes in ${paths.length} file(s); copies kept`, { files: paths.join(', ').slice(0, 500), recoveryDir: r.recoveryDir });
        return r;
    });
    app.post('/api/git/restore-file', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 4096 });
        const r = await git.restoreFileFrom(str(b.rev, 'rev', { max: 200 }), file);
        log('git.restore-file', `Restored ${file} from an older commit`, { file });
        return r;
    });
    app.get('/api/git/hunks', async (req) => {
        const q = req.query as Record<string, string>;
        return git.hunks(str(q.file, 'file', { max: 4096 }), q.staged === 'true');
    });
    app.post('/api/git/hunks', async (req) => {
        const b = body(req);
        // Hunk ids (hash of the change as shown) make sure the change staged is the one the user saw;
        // indexes are still accepted for older callers.
        const ids = Array.isArray(b.ids) && b.ids.every((x) => typeof x === 'string' && /^[0-9a-f]{16,64}$/.test(x)) ? b.ids as string[] : null;
        const idx = Array.isArray(b.indexes) && b.indexes.every((n) => Number.isInteger(n) && n >= 0) ? b.indexes as number[] : null;
        const sel = ids ?? idx;
        if (!sel || !sel.length) throw new BadRequest('"ids" must be a list of change ids.');
        await git.stageHunks(str(b.file, 'file', { max: 4096 }), sel, b.unstage === true);
        return git.status();
    });
    app.post('/api/git/lines', async (req) => {
        const b = body(req);
        const id = typeof b.id === 'string' && /^[0-9a-f]{16,64}$/.test(b.id) ? b.id : null;
        const lines = Array.isArray(b.lines) && b.lines.every((n) => Number.isInteger(n) && n > 0) ? b.lines as number[] : null;
        if (!id || !lines?.length) throw new BadRequest('"id" (a change id) and "lines" (line numbers in it) are needed.');
        await git.stageLines(str(b.file, 'file', { max: 4096 }), id, lines, b.unstage === true);
        return git.status();
    });
    app.post('/api/git/intent-to-add', async (req) => { await git.intentToAdd(str(body(req).file, 'file', { max: 4096 })); return git.status(); });
    app.post('/api/git/lock/remove', async () => git.removeStaleLock());
    // ---- Stash
    const stashIdx = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new BadRequest('"index" is invalid.'); return n; };
    app.get('/api/git/stash', async () => git.stashList());
    app.post('/api/git/stash', async (req) => {
        const b = body(req);
        await git.stashSave(str(b.message, 'message', { optional: true, max: 500 }), b.includeUntracked === true);
        log('git.stash', 'Stashed changes', { message: typeof b.message === 'string' ? b.message : null });
        return git.status();
    });
    const stashSha = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    app.post('/api/git/stash/apply', async (req) => { const b = body(req); const r = await git.stashApply(stashIdx(b.index), b.pop === true, stashSha(b.sha)); log(b.pop === true ? 'git.stash.pop' : 'git.stash.apply', `${b.pop === true ? 'Popped' : 'Applied'} stash entry ${stashIdx(b.index)}: ${r.status}`, {}); return r; });
    app.delete('/api/git/stash', async (req) => { const q = req.query as Record<string, string>; await git.stashDrop(stashIdx(q.index), stashSha(q.sha)); log('git.stash.drop', 'Deleted a stash entry', {}); return { ok: true }; });
    app.get('/api/git/stash/files', async (req) => git.stashFiles(stashIdx((req.query as Record<string, string>).index)));
    app.get('/api/git/stash/diff', async (req) => {
        const q = req.query as Record<string, string>;
        return { diff: await git.stashFileDiff(stashIdx(q.index), str(q.file, 'file', { max: 4096 })) };
    });
    // ---- Tags and branch management
    app.get('/api/git/tags', async () => git.tags());
    app.post('/api/git/tags', async (req) => {
        const b = body(req);
        const name = str(b.name, 'name', { max: 200 });
        await git.createTag(name, str(b.rev, 'rev', { max: 200 }), str(b.message, 'message', { optional: true, max: 2000 }));
        log('git.tag', `Created tag ${name}`, { name });
        return git.tags();
    });
    app.delete('/api/git/tags', async (req) => {
        const q = req.query as Record<string, string>;
        const name = str(q.name, 'name', { max: 200 });
        await git.deleteTag(name, q.remote === 'true');
        log('git.tag.delete', `Deleted tag ${name}${q.remote === 'true' ? ' (also on the remote)' : ''}`, { name });
        return git.tags();
    });
    app.post('/api/git/tags/push', async (req) => { const name = str(body(req).name, 'name', { max: 200 }); const r = await git.pushTag(name); if (!r.already) log('git.tag.push', `Pushed tag ${name}`, { name }); return { ok: true, ...(r.already ? { already: true } : {}) }; });
    app.post('/api/git/branch/delete', async (req) => {
        const b = body(req);
        const name = str(b.name, 'name', { max: 255 });
        const r = await git.deleteBranch(name, b.force === true);
        if (r.status === 'ok') log('git.branch.delete', `Deleted branch ${name}`, { name });
        return r;
    });
    app.post('/api/git/branch/delete-remote', async (req) => {
        const name = str(body(req).name, 'name', { max: 255 });
        await git.deleteRemoteBranch(name);
        log('git.branch.delete-remote', `Deleted remote branch ${name}`, { name });
        return { ok: true };
    });
    app.post('/api/git/branch/rename', async (req) => { const b = body(req); await git.renameBranch(str(b.from, 'from', { max: 255 }), str(b.to, 'to', { max: 255 })); return git.branches(); });
    app.post('/api/git/branch/upstream', async (req) => { await git.setUpstream(str(body(req).upstream, 'upstream', { max: 255 })); return git.status(); });

    // ---- Secret scan + fixes
    app.get('/api/scan/staged', async () => {
        const r = await git.scanStaged();
        return { findings: r.findings, digest: r.digest };
    });
    app.post('/api/scan/fix', async (req) => {
        const b = body(req);
        const action = str(b.action, 'action', { max: 32 });
        log('secret-scan.fix', `Applied fix "${action}"`, { action, file: typeof b.file === 'string' ? b.file : (b.finding as Record<string, string> | undefined)?.file ?? null });
        switch (action) {
            case 'move-to-store': {
                const ref = findingRef(b.finding);
                const name = str(b.name, 'name', { max: 64 });
                const scope = b.scope === 'all-projects' ? undefined : projectId;
                const env = str(b.env, 'env', { optional: true, max: 32 }) || undefined;
                return moveToStore(git, opts.store, ref, { name, project: scope, env });
            }
            case 'remove': await removeValue(git, findingRef(b.finding)); return { ok: true };
            case 'unstage': await unstageFile(git, str(b.file, 'file', { max: 4096 })); return { ok: true };
            case 'ignore-file': await ignoreFile(git, str(b.file, 'file', { max: 4096 })); return { ok: true };
            case 'not-a-secret':
                await allowlistFinding(git, findingRef(b.finding), str(b.reason, 'reason', { max: 500 }), opts.userName ?? 'unknown');
                return { ok: true };
            default: throw new BadRequest(`Unknown fix action "${action}".`);
        }
    });

    // ---- Fixes for many findings at once (selected in the review): one scan, each file edited and staged once.
    /** ENCRYPTED: values made with the framework's built-in key, read with the project's own framework (null: kept as written). */
    const frameworkDecrypt = (v: string): string | null => {
        try {
            const pkg = frameworkPackage(opts.repoRoot);
            if (!pkg) return null;
            const mod = require(path.join(pkg.dir, 'dist', 'utils', 'CSEncryptionUtil.js')) as { CSEncryptionUtil?: { getInstance(): { decrypt(v: string): string } } }; // eslint-disable-line @typescript-eslint/no-var-requires
            const d = mod.CSEncryptionUtil?.getInstance().decrypt(v);
            return typeof d === 'string' && d ? d : null;
        } catch { return null; }
    };
    const refsOf = (v: unknown, max = 2000): FindingRef[] => {
        const list = Array.isArray(v) ? v.slice(0, max) : [];
        if (!list.length) throw new BadRequest('Choose at least one finding.');
        return list.map(findingRef);
    };
    app.post('/api/scan/store-plan', async (req) => {
        const b = body(req);
        const plan = await planStore(git, opts.store, refsOf(b.findings), projectId, frameworkDecrypt);
        return { items: plan.map((x) => ({ ...x.ref, name: x.name, env: x.env, group: x.group, exists: x.exists, decrypted: x.decrypted })) };
    });
    app.post('/api/scan/fix-many', async (req) => {
        const b = body(req);
        const action = str(b.action, 'action', { max: 32 });
        const items = Array.isArray(b.items) ? (b.items as Array<Record<string, unknown>>).slice(0, 2000) : [];
        if (!items.length) throw new BadRequest('Choose at least one finding.');
        const refs = items.map((x) => findingRef(x.finding));
        let result: Record<string, unknown> = { ok: true };
        switch (action) {
            case 'move-to-store':
                result = await moveManyToStore(git, opts.store, items.map((x, i) => ({ ref: refs[i], name: str(x.name, 'name', { max: 64 }), env: str(x.env, 'env', { optional: true, max: 32 }) || undefined })),
                    { project: projectId, overwrite: b.overwrite === true, decode: frameworkDecrypt });
                break;
            case 'remove': result = await removeMany(git, refs); break;
            case 'not-a-secret': await allowlistMany(git, refs, str(b.reason, 'reason', { max: 500 }), opts.userName ?? 'unknown'); break;
            case 'unstage': await unstageMany(git, refs.map((r) => r.file)); break;
            default: throw new BadRequest(`Unknown fix action "${action}".`);
        }
        log('secret-scan.fix', `Applied fix "${action}" to ${refs.length} finding(s)`, { action, count: refs.length, files: [...new Set(refs.map((r) => r.file))].slice(0, 20).join(', ') });
        return result;
    });

    // ---- Secrets (write-only values)
    app.get('/api/secrets', async () => {
        const list = opts.store.list({ project: projectId });
        // The length shown is in characters as a person counts them (an emoji is one), not UTF-16 units.
        // knownSecrets() decrypts all in one batch (cached), so each resolve() below is a lookup.
        try {
            opts.store.knownSecrets();
            return list.map((m) => { const v = opts.store.resolve(m.name, { project: m.project, env: m.env }); return v === undefined ? m : { ...m, length: Array.from(v).length }; });
        } catch { return list; }
    });
    // Where each secret is used (configuration, features, API collections, load scenarios, tool servers) and its age.
    app.get('/api/secrets/usage', async () => ({ ...secretUsage(opts.repoRoot, opts.store.exists ? opts.store.list({ project: projectId }) : []), rotateDays: ROTATE_DAYS }));
    app.put('/api/secrets', async (req) => {
        const b = body(req);
        const key = {
            name: str(b.name, 'name', { max: 64 }),
            project: b.scope === 'all-projects' ? undefined : projectId,
            env: str(b.env, 'env', { optional: true, max: 32 }) || undefined,
        };
        // expect: what the screen saw. "new" (Add) over a secret added since in another tab, or "existing" (Replace) of
        // one deleted since, is refused (409) so it is asked about, never replaced or brought back silently.
        if (b.expect === 'new' || b.expect === 'existing') {
            const there = opts.store.exists && opts.store.list().some((x) => x.name === key.name && (x.project ?? '') === (key.project ?? '') && (x.env ?? '') === (key.env ?? ''));
            const where = key.env ? ` for ${key.env}` : '';
            if (b.expect === 'new' && there) throw new StaleSaveError(`${key.name}${where} was added in another tab or by someone else since this list was shown.`);
            if (b.expect === 'existing' && !there) throw new StaleSaveError(`${key.name}${where} was deleted in another tab or by someone else since this list was shown.`);
        }
        const value = str(b.value, 'value', { max: 65_536 });
        // Only spaces (or tabs, new lines) is almost surely a slip (a paste that missed), and would be handed to the tests as is.
        if (!value.trim()) throw new BadRequest('The value is only spaces: type or paste the secret value itself.');
        const meta = opts.store.set(key, value);
        log('secret.set', `Saved secret ${meta.name}${meta.env ? ` (${meta.env})` : ''}`, { name: meta.name, env: meta.env ?? null });
        return meta;
    });
    app.delete('/api/secrets', async (req) => {
        const q = req.query as Record<string, string>;
        const removed = opts.store.delete({ name: str(q.name, 'name', { max: 64 }), project: q.scope === 'all-projects' ? undefined : projectId, env: q.env || undefined });
        if (removed) log('secret.delete', `Deleted secret ${q.name}`, { name: q.name, env: q.env || null });
        return { removed };
    });

    // ---- Environments (framework config: config/<project>/environments/<env>.env)
    app.get('/api/env', async () => discover(opts.repoRoot));
    app.get('/api/env/resolve', async (req) => {
        const q = req.query as Record<string, string>;
        return resolveFor(configProjectParam(q.project), envParam(q.env));
    });
    app.get('/api/env/compare', async (req) => {
        const q = req.query as Record<string, string>;
        const project = configProjectParam(q.project);
        const a = envParam(q.a, 'a');
        const b = envParam(q.b, 'b');
        return { project, a, b, differences: compareEnvironments(resolveFor(project, a), resolveFor(project, b)) };
    });
    // A setting name the framework reads: said in full when it is not one (the same rule as env/edit.ts).
    const envKey = (v: unknown): string => {
        const k = typeof v === 'string' ? v.trim() : '';
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(k)) throw new BadRequest(`${k ? `"${k.length > 60 ? k.slice(0, 60) + '…' : k}"` : 'An empty name'} is not a valid setting name: use Latin letters, digits, _ . and -, starting with a letter or _ (at most 200 characters), for example BASE_URL.`);
        return k;
    };
    app.put('/api/env/value', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 1024 });
        const key = envKey(b.key);
        // was: the value the screen showed in this file; changed since (another tab) → refused, force = Overwrite.
        checkUnchanged(opts.repoRoot, file, key, b.was, b.force);
        const line = setValue(opts.repoRoot, file, key, typeof b.value === 'string' ? b.value : str(b.value, 'value'), { allowLiteralSecret: b.allowLiteralSecret === true });
        log('env.set', `Set ${key} in ${file}`, { file, key, literalSecretConfirmed: b.allowLiteralSecret === true });
        return { file, key, line };
    });
    app.delete('/api/env/value', async (req) => {
        const q = req.query as Record<string, string>;
        const file = str(q.file, 'file', { max: 1024 });
        const key = str(q.key, 'key', { max: 200 });
        if (q.was !== undefined && q.force !== 'true') checkUnchanged(opts.repoRoot, file, key, q.was);
        const removed = removeKey(opts.repoRoot, file, key);
        if (removed) log('env.remove', `Removed ${key} from ${file}`, { file, key });
        return { removed };
    });
    app.post('/api/env/secret', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 1024 });
        const key = envKey(b.key);
        const secretName = str(b.secretName, 'secretName', { max: 64 });
        const env = str(b.env, 'env', { optional: true, max: 32 }) || undefined;
        checkUnchanged(opts.repoRoot, file, key, b.was, b.force);
        const line = storeSecret(opts.repoRoot, opts.store, {
            file, key, secretName, value: str(b.value, 'value', { max: 65_536 }),
            project: b.scope === 'all-projects' ? undefined : projectId, env,
        });
        log('env.secret', `Stored ${key} as secret ${secretName} and referenced it in ${file}`, { file, key, secretName, env: env ?? null });
        return { file, key, line, reference: `{env:${secretName}}` };
    });
    app.post('/api/env/create', async (req) => {
        const b = body(req);
        const project = configProjectParam(b.project);
        const name = envParam(b.name, 'name');
        const copyFrom = b.copyFrom ? envParam(b.copyFrom, 'copyFrom') : undefined;
        const res = createEnvironment(opts.repoRoot, project, name, copyFrom);
        log('env.create', `Created environment ${name} for ${project}${copyFrom ? ` from ${copyFrom}` : ''}`, { project, name, copyFrom: copyFrom ?? null });
        return res;
    });

    // ---- ADO pipeline secrets
    // version: what the screen read (.cs-studio/pipeline.json); a save from an older read is refused (two tabs, a pull).
    const pipelineSettingsView = () => { const s = readPipelineSettings(opts.repoRoot); return { ...s, version: contentVersion(s) }; };
    app.get('/api/pipeline/settings', async () => pipelineSettingsView());
    app.put('/api/pipeline/settings', async (req) => {
        const b = body(req);
        const raw = typeof b.variableGroup === 'string' ? b.variableGroup.trim() : '';
        // An Azure DevOps variable group name: not empty, no characters ADO refuses, only the placeholders the Studio fills in.
        if (!raw) throw new BadRequest('Give the variable group a name (for example cs-studio-secrets).');
        if (Array.from(raw).length > 120) throw new BadRequest(`The variable group name is too long: at most 120 characters (it has ${Array.from(raw).length}).`);
        if (/[\\/:*?"<>|#%]/.test(raw)) throw new BadRequest('A variable group name cannot contain \\ / : * ? " < > | # or %.');
        const unknown = (raw.match(/\{[^{}]*\}/g) ?? []).filter((p) => p !== '{project}' && p !== '{env}');
        if (unknown.length) throw new BadRequest(`Only {project} and {env} are filled in: ${unknown[0]} is not a placeholder the Studio knows.`);
        if (/[{}]/.test(raw.replace(/\{(project|env)\}/g, ''))) throw new BadRequest('A { or } on its own: the only placeholders are {project} and {env}.');
        if (/[^\x00-\x7F]/.test(raw)) throw new BadRequest('Use Latin letters (A-Z), digits, spaces, - _ . and {project} / {env}: Azure DevOps pipelines refer to the group by this name.');
        checkVersion(b.version, contentVersion(readPipelineSettings(opts.repoRoot)), b.force);
        writePipelineSettings(opts.repoRoot, { variableGroup: raw });
        log('pipeline.settings', 'Changed the pipeline variable group name', { variableGroup: raw });
        return pipelineSettingsView();
    });
    const adoClient = (project: string, env: string) =>
        new AdoClient({ ...adoSettingsFor(opts.repoRoot, opts.store, projectId, project, env, process.env, personal()), connection: netConnection(), transport: opts.adoTransport });
    // ---- Azure DevOps work items (read-only)
    /** Project/env for the ADO settings: the ones asked for, else the first project and environment. */
    const adoTarget = (q: Record<string, string>) => {
        const found = discover(opts.repoRoot);
        const project = q.project ? configProjectParam(q.project) : found.projects[0];
        if (!project) throw new BadRequest('No framework project found under config/, so the Azure DevOps settings (ADO_ORGANIZATION, ADO_PROJECT) cannot be read.');
        const env = q.env ? envParam(q.env) : (found.environments[project] ?? [])[0] ?? 'dev';
        return { project, env };
    };
    const workItemsFor = (q: Record<string, string>) => { const t = adoTarget(q); return { ...t, wi: new WorkItems(adoClient(t.project, t.env)) }; };
    app.get('/api/ado/workitems', async (req) => {
        const q = req.query as Record<string, string>;
        const { project, env, wi } = workItemsFor(q);
        const kind = (['mine', 'sprint', 'search'] as const).find((k) => k === q.list) ?? 'mine';
        const type = q.type ? str(q.type, 'type', { max: 100 }) : undefined;
        const r = await wi.list(kind, { team: q.team ? str(q.team, 'team', { max: 200 }) : undefined, text: q.text ? str(q.text, 'text', { max: 200 }) : undefined, type, includeClosed: q.closed === 'true' });
        const automated = automatedScenarios(opts.repoRoot);
        return {
            ...r, project, env,
            capped: r.items.length >= 200,
            items: r.items.map((i) => ({ ...i, automatedIn: i.type === 'Test Case' ? automated.get(i.id) ?? [] : undefined })),
        };
    });
    // ---- Azure Boards with real filters (team, sprint, area, type, state, …), for any project of the
    // organization; only the page on screen is fetched.
    const boardsCache = new Map<string, { at: number; b: Boards }>();
    const boardsFor = (q: Record<string, unknown>) => {
        const t = adoTarget(q as Record<string, string>);
        const client = adoClient(t.project, t.env);
        const c = q.adoProject ? client.forProject(str(q.adoProject, 'adoProject', { max: 64 })) : client;
        const key = `${t.project}/${t.env}/${c.projectName}`;
        const hit = boardsCache.get(key);
        // Types, teams and sprints change rarely: reused for 10 minutes.
        if (hit && Date.now() - hit.at < 10 * 60_000) return { ...t, b: hit.b, adoProject: c.projectName };
        const b = new Boards(c);
        boardsCache.set(key, { at: Date.now(), b });
        return { ...t, b, adoProject: c.projectName };
    };
    app.get('/api/ado/boards/meta', async (req) => {
        const { b, adoProject, project, env } = boardsFor(req.query as Record<string, string>);
        return { ...(await b.meta()), adoProject, project, env };
    });
    app.get('/api/ado/boards/team', async (req) => {
        const q = req.query as Record<string, string>;
        return boardsFor(q).b.team(str(q.team, 'team', { max: 200 }));
    });
    app.get('/api/ado/boards/areas', async (req) => ({ areas: await boardsFor(req.query as Record<string, string>).b.areas() }));
    app.post('/api/ado/workitems/query', async (req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const { b, adoProject } = boardsFor(body);
        const f = (body.filter ?? {}) as Record<string, unknown>;
        const list = (v: unknown, name: string) => (Array.isArray(v) ? v.slice(0, 50).map((x) => str(x, name, { max: 400 })) : undefined);
        const filter: ItemFilter = {
            team: f.team ? str(f.team, 'team', { max: 200 }) : undefined,
            sprint: f.sprint ? str(f.sprint, 'sprint', { max: 400 }) : undefined,
            areas: list(f.areas, 'areas'), types: list(f.types, 'types'), states: list(f.states, 'states'), tags: list(f.tags, 'tags'),
            open: f.open !== false,
            assigned: f.assigned ? str(f.assigned, 'assigned', { max: 200 }) : undefined,
            text: f.text ? str(f.text, 'text', { max: 200 }) : undefined,
            changedDays: typeof f.changedDays === 'number' ? f.changedDays : undefined,
            order: (['changed', 'priority', 'id'] as const).find((o) => o === f.order),
        };
        const r = await b.query(filter, { skip: Number(body.skip) || 0, take: Number(body.take) || 100 });
        const automated = automatedScenarios(opts.repoRoot);
        return { ...r, adoProject, items: r.items.map((i) => ({ ...i, automatedIn: i.type === 'Test Case' ? automated.get(i.id) ?? [] : undefined })) };
    });
    // ---- Azure DevOps pipelines: runs, stages, logs, test results (report artifacts + published runs)
    // An ADO project other than the configured one can be chosen (pipelines often live elsewhere).
    const pipelinesFor = (q: Record<string, string>) => {
        const t = adoTarget(q);
        const client = adoClient(t.project, t.env);
        const c = q.adoProject ? client.forProject(str(q.adoProject, 'adoProject', { max: 64 })) : client;
        return { ...t, p: new Pipelines(c), adoProject: c.projectName };
    };
    const pipelineCache = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'pipelines');
    const pipelineKeys = new Map<number, string>();
    const pipelineKey = (id: number) => { if (!pipelineKeys.has(id)) pipelineKeys.set(id, randomBytes(16).toString('hex')); return pipelineKeys.get(id)!; };
    const runIdParam = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new BadRequest('Invalid run id.'); return n; };
    const maskAll = (t: string) => maskSecrets(t, opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : []);
    let myAdoId: string | null = null;
    /** Who the token belongs to (connectionData is only served as a preview API version). */
    const myId = async (q: Record<string, string>): Promise<string | null> => {
        if (!myAdoId) {
            const t = adoTarget(q);
            const cd = await adoClient(t.project, t.env).get<{ authenticatedUser?: { id?: string } }>('connectionData?api-version=7.1-preview', 'org', 'any');
            myAdoId = cd.authenticatedUser?.id ?? null;
        }
        return myAdoId;
    };
    app.get('/api/ado/projects', async (req) => {
        const t = adoTarget(req.query as Record<string, string>);
        const names: string[] = [];
        for (let skip = 0; skip < 10_000; skip += 500) {
            const r = await adoClient(t.project, t.env).get<{ value: Array<{ name: string }> }>(`projects?$top=500&$skip=${skip}`, 'org', 'Project and Team (Read)');
            names.push(...r.value.map((x) => x.name));
            if (r.value.length < 500) break;
        }
        return { projects: names.sort((a, b) => a.localeCompare(b)), configured: adoSettingsFor(opts.repoRoot, opts.store, projectId, t.project, t.env, process.env, personal()).project };
    });
    app.get('/api/ado/pipelines/definitions', async (req) => {
        const q = req.query as Record<string, string>;
        const { p } = pipelinesFor(q);
        const [defs, folders] = await Promise.all([
            p.definitions({ search: q.search ? str(q.search, 'search', { max: 200 }) : undefined, folder: q.folder ? str(q.folder, 'folder', { max: 400 }) : undefined, continuation: q.next ? str(q.next, 'next', { max: 1000 }) : undefined }),
            q.next ? Promise.resolve(undefined) : p.folders().catch(() => [] as string[]),
        ]);
        return { ...defs, folders };
    });
    app.get('/api/ado/pipelines', async (req) => {
        const q = req.query as Record<string, string>;
        const { p, project, env, adoProject } = pipelinesFor(q);
        const pipelineId = q.pipeline ? Number(q.pipeline) : undefined;
        let requestedFor: string | undefined;
        if (q.mine === 'true') {
            requestedFor = await myId(q) ?? undefined;
        }
        const result = (['succeeded', 'failed', 'partiallySucceeded', 'canceled'] as const).find((r) => r === q.result);
        const runs = await p.runs({
            pipelineId: pipelineId && Number.isInteger(pipelineId) ? pipelineId : undefined,
            branch: q.branch ? str(q.branch, 'branch', { max: 255 }) : undefined,
            result, running: q.result === 'running', requestedFor, top: 40,
            continuation: q.next ? str(q.next, 'next', { max: 1000 }) : undefined,
        });
        return { runs: runs.items, next: runs.next, project, env, adoProject };
    });
    app.get('/api/ado/pipelines/runs/:id', async (req) => {
        const id = runIdParam((req.params as { id: string }).id);
        const { p } = pipelinesFor(req.query as Record<string, string>);
        const [run, raw] = await Promise.all([p.run(id), p.rawTimeline(id)]);
        const timeline = Pipelines.toNodes(raw);
        const [artifacts, testRuns] = await Promise.all([
            p.artifacts(id, timeline),
            p.publishedTestRuns(id).catch((e: Error) => ({ error: e.message })),
        ]);
        const candidates = new Set(reportCandidates(artifacts).map((a) => a.name));
        const stages = Pipelines.stages(raw);
        // Published test runs name the stage by its identifier (Test_DEV): show its display name.
        const stageName = (idOrName?: string) => (idOrName ? stages.find((st) => st.identifier === idOrName || st.name === idOrName)?.name ?? idOrName : idOrName);
        return {
            run, stages,
            timeline: timeline.map((n) => ({ ...n, issues: n.issues.map((i) => ({ ...i, message: maskAll(i.message) })) })),
            artifacts: artifacts.map((a) => ({ ...a, candidate: candidates.has(a.name) })),
            publishedTestRuns: Array.isArray(testRuns) ? testRuns.map((t) => ({ ...t, stage: stageName(t.stage) })) : [], publishedTestRunsError: Array.isArray(testRuns) ? undefined : testRuns.error,
        };
    });
    app.get('/api/ado/pipelines/runs/:id/logs/:logId', async (req) => {
        const prm = req.params as { id: string; logId: string };
        const id = runIdParam(prm.id);
        const logId = Number(prm.logId); if (!Number.isInteger(logId) || logId <= 0) throw new BadRequest('Invalid log id.');
        const { p } = pipelinesFor(req.query as Record<string, string>);
        const l = await p.log(id, logId);
        return { text: maskAll(l.text), truncated: l.truncated, totalLines: l.totalLines };
    });
    app.get('/api/ado/pipelines/testruns/:id', async (req) => {
        const id = runIdParam((req.params as { id: string }).id);
        const { p } = pipelinesFor(req.query as Record<string, string>);
        const results = await p.publishedTestResults(id);
        return { results: results.map((r) => ({ ...r, title: maskAll(r.title), errorMessage: r.errorMessage && maskAll(r.errorMessage), stackTrace: r.stackTrace && maskAll(r.stackTrace) })) };
    });
    /**
     * The framework's reports inside a run's artifacts. Without `artifact`: the likely ones (named
     * like reports, or from a testing stage/job, and not too large). With `artifact`: that one.
     */
    app.post('/api/ado/pipelines/runs/:id/results', async (req) => {
        const id = runIdParam((req.params as { id: string }).id);
        const b = body(req) as Record<string, string>;
        const { p } = pipelinesFor(b);
        const [run, timeline] = await Promise.all([p.run(id), p.timeline(id)]);
        const all = await p.artifacts(id, timeline);
        const chosen = b.artifact ? all.filter((a) => a.name === str(b.artifact, 'artifact', { max: 300 })) : reportCandidates(all);
        if (b.artifact && !chosen.length) throw new BadRequest('That artifact is not part of this run.');
        const features = indexFeatures(opts.repoRoot);
        const key = pipelineKey(id);
        const runDir = path.join(pipelineCache, String(id));
        const out: Array<Record<string, unknown>> = [];
        const errors: Array<{ artifact: string; message: string }> = [];
        for (const a of chosen) {
            let dir: string;
            try { dir = await fetchArtifact(p, run, a, pipelineCache, netConnection(), b.artifact ? undefined : AUTO_DOWNLOAD_BYTES); }
            catch (e) { errors.push({ artifact: a.name, message: (e as Error).message }); continue; }
            for (const r of findReports(dir).reports) {
                // The same report published twice by one job (e.g. as a pipeline and a classic
                // artifact) is shown, and counted, once. Other stages/jobs are separate test runs.
                let digest = '';
                try { digest = `${a.stage ?? ''}|${a.job ?? ''}|${createHash('sha256').update(fs.readFileSync(path.join(r.reportDir, 'report-data.json'))).digest('hex')}`; } catch { /* unreadable: keep */ }
                const twin = digest ? out.find((o) => o.digest === digest) : undefined;
                if (twin) { (twin.alsoIn as string[]).push(a.name); continue; }
                const ev = readEvidence(dir, r.reportDir, { features });
                const rel = path.relative(runDir, resultsRootOf(r.reportDir)).split(path.sep).join('/');
                out.push({
                    name: r.name || a.name, artifact: a.name, stage: a.stage, job: a.job,
                    base: `/pipeline-report/${id}/${key}/${rel.split('/').map(encodeURIComponent).join('/')}`,
                    scenarios: ev.scenarios.map((sc) => ({ ...sc, name: maskAll(sc.name),
                        failedStep: sc.failedStep ? { ...sc.failedStep, name: maskAll(sc.failedStep.name), error: sc.failedStep.error && maskAll(sc.failedStep.error) } : undefined,
                        steps: sc.steps.map((st) => ({ ...st, text: maskAll(st.text), error: st.error && maskAll(st.error), actions: st.actions.map((x) => ({ ...x, text: maskAll(x.text) })) })) })),
                    run: ev.run, reportIndex: ev.reportIndex, digest, alsoIn: [] as string[],
                });
            }
        }
        log('pipelines.results', `Opened test results of pipeline run ${run.number}`, { run: id, artifacts: chosen.map((a) => a.name).join(', ') });
        return { run, projects: out.map(({ digest: _d, ...o }) => o), looked: chosen.map((a) => a.name), errors, others: all.filter((a) => !chosen.some((c) => c.name === a.name)).map((a) => a.name) };
    });
    // Queue a run: an action in Azure DevOps, so the UI asks first and must say so (confirm: true).
    app.post('/api/ado/pipelines/:id/run', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm starting the pipeline.');
        const pipelineId = runIdParam((req.params as { id: string }).id);
        const branch = str(b.branch, 'branch', { max: 255 });
        const params: Record<string, string> = {};
        if (b.parameters && typeof b.parameters === 'object') for (const [k, v] of Object.entries(b.parameters as Record<string, unknown>)) {
            if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(k) || typeof v !== 'string' || v.length > 2000) throw new BadRequest(`Invalid parameter ${k}.`);
            params[k] = v;
        }
        const { p } = pipelinesFor(b as Record<string, string>);
        const run = await p.queue(pipelineId, branch, params);
        log('pipelines.queue', `Started pipeline ${run.pipeline.name} on ${branch} (run ${run.number})`, { pipeline: pipelineId, branch });
        return run;
    });
    // Report files of a pipeline run (screenshots, traces, HTML report), behind a per-run key.
    app.get('/pipeline-report/:id/:key/*', async (req, reply) => {
        const prm = req.params as { id: string; key: string; '*': string };
        const id = Number(prm.id);
        const expected = Number.isInteger(id) ? pipelineKeys.get(id) : undefined;
        const a = Buffer.from(prm.key), e = Buffer.from(expected ?? '');
        if (!expected || a.length !== e.length || !tse(a, e)) return reply.code(404).send({ error: 'Not found.' });
        const root = path.join(pipelineCache, String(id));
        const file = path.resolve(root, prm['*'] || 'index.html');
        const rel = path.relative(root, file);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send({ error: 'Not found.' });
        if (path.relative(fs.realpathSync(root), fs.realpathSync(file)).startsWith('..')) return reply.code(404).send({ error: 'Not found.' });
        return sendReportFile(reply, rel, root);
    });
    app.get('/api/ado/workitems/:id/edit-options', async (req) => {
        const q = req.query as Record<string, string>;
        const { wi } = workItemsFor(q);
        return wi.editOptions(str(q.type, 'type', { max: 80 }));
    });
    app.patch('/api/ado/workitems/:id', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm the change to the work item.');
        const id = posInt((req.params as { id: string }).id, 'work item');
        const { wi } = workItemsFor(b as Record<string, string>);
        const c = (b.changes ?? {}) as Record<string, unknown>;
        const s = (k: string, max: number) => (c[k] === undefined ? undefined : str(c[k], k, { max, allowEmpty: k === 'assignedTo' } as never));
        const changes = {
            ...(c.state !== undefined ? { state: s('state', 80) } : {}), ...(c.assignedTo !== undefined ? { assignedTo: typeof c.assignedTo === 'string' ? c.assignedTo.slice(0, 256) : '' } : {}),
            ...(c.iteration !== undefined ? { iteration: s('iteration', 512) } : {}), ...(c.area !== undefined ? { area: s('area', 512) } : {}),
            ...(c.priority !== undefined ? { priority: Math.max(1, Math.min(Number(c.priority) || 2, 4)) } : {}),
            ...(Array.isArray(c.tags) ? { tags: (c.tags as unknown[]).map((t) => String(t).replace(/;/g, ' ').trim().slice(0, 100)).filter(Boolean).slice(0, 50) } : {}),
            ...(typeof c.comment === 'string' ? { comment: c.comment } : {}),
        };
        try {
            const r = await wi.update(id, changes as never, b.rev === undefined ? undefined : Number(b.rev));
            log('ado.workitem.update', `Changed work item ${id}: ${Object.keys(changes).join(', ')}`, { id });
            return { ok: true, ...r };
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.get('/api/ado/workitems/:id', async (req) => {
        const q = req.query as Record<string, string>;
        const id = Number((req.params as { id: string }).id);
        if (!Number.isInteger(id) || id <= 0) throw new BadRequest('Invalid work item id.');
        const { wi } = workItemsFor(q);
        const d = await wi.detail(id);
        const related = d.relations.length ? await wi.many(d.relations.map((r) => r.id!).filter(Boolean)) : [];
        return {
            ...d,
            related: d.relations.map((r) => ({ kind: r.kind, item: related.find((x) => x.id === r.id) ?? null, id: r.id })),
            automatedIn: d.type === 'Test Case' ? automatedScenarios(opts.repoRoot).get(id) ?? [] : undefined,
            scenario: d.type === 'Test Case' ? scenarioFromTestCase(d) : undefined,
            branchName: branchNameFor(d),
        };
    });
    // ---- Azure DevOps Test Plans: plans, suites, test points and the scenarios that automate them
    const testPlansFor = (q: Record<string, string>) => {
        const t = adoTarget(q);
        const base = adoClient(t.project, t.env);
        // Another Azure DevOps project of the organization (as on Work items), else the configured one.
        const ado = q.adoProject ? base.forProject(str(q.adoProject, 'adoProject', { max: 64 })) : base;
        return { ...t, tp: new TestPlans(ado), ado };
    };
    /** The project's publishing settings (ADO_INTEGRATION_ENABLED, ADO_TEST_PLAN_ID, ADO_TEST_SUITE_ID) and every scenario's target. */
    const adoPublishing = (project: string, env: string) => {
        let entries: Array<{ key: string; value: string }> = [];
        try { entries = resolveFor(project, env).entries; } catch { /* no configuration */ }
        const val = (k: string) => entries.find((e) => e.key === k)?.value?.trim() ?? '';
        const num = (k: string) => { const n = parseInt(val(k), 10); return n > 0 ? n : undefined; };
        const config = { plan: num('ADO_TEST_PLAN_ID'), suite: num('ADO_TEST_SUITE_ID') };
        // What the installed framework does with several scenarios per test case and several configurations.
        let combines = false, chooses = false;
        try {
            const pkg = frameworkPackage(opts.repoRoot);
            const js = pkg ? fs.readFileSync(path.join(pkg.dir, 'dist', 'ado', 'CSADOPublisher.js'), 'utf8') : '';
            combines = js.includes('combinedResult'); chooses = js.includes('ADO_TEST_CONFIGURATION');
        } catch { /* not installed */ }
        return { project, env, enabled: /^(true|yes|1)$/i.test(val('ADO_INTEGRATION_ENABLED')), ...config, configuration: val('ADO_TEST_CONFIGURATION'), combines, chooses, targets: publishTargets(readCatalog(opts.repoRoot), config), upload: uploadSettings(val) };
    };
    const posInt = (v: unknown, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`Invalid ${name}.`); return n; };
    app.get('/api/ado/testplans', async (req) => {
        const q = req.query as Record<string, string>;
        const { project, env, tp, ado } = testPlansFor(q);
        return { project, env, adoProject: ado.projectName, plans: await tp.plans(q.inactive === 'true') };
    });
    app.get('/api/ado/testplans/:plan/suites', async (req) => {
        const { tp } = testPlansFor(req.query as Record<string, string>);
        return { suites: await tp.suites(posInt((req.params as { plan: string }).plan, 'plan')) };
    });
    app.get('/api/ado/testplans/:plan/suites/:suite/points', async (req) => {
        const prm = req.params as { plan: string; suite: string };
        const plan = posInt(prm.plan, 'plan'), suite = posInt(prm.suite, 'suite');
        const { tp, project, env } = testPlansFor(req.query as Record<string, string>);
        const points = await tp.points(plan, suite);
        const cases = await tp.testCases([...new Set(points.map((p) => p.testCase))]);
        const pub = adoPublishing(project, env);
        // Each scenario tagged with the test case, and where its results actually go.
        const status = (t: { plan?: number; suite?: number }) => (!t.plan || !t.suite ? 'unpublished' : t.plan === plan && t.suite === suite ? 'here' : 'elsewhere');
        const inSuite = new Set(points.map((p) => p.testCase));
        return {
            publishing: { project: pub.project, env: pub.env, enabled: pub.enabled, plan: pub.plan ?? null, suite: pub.suite ?? null, configuration: pub.configuration, combines: pub.combines, chooses: pub.chooses },
            points: points.map((p) => ({
                ...p,
                scenarios: pub.targets.filter((t) => t.testCases.includes(p.testCase)).map((t) => ({ ...t, status: status(t) })),
                automationStatus: cases.get(p.testCase)?.automationStatus, automatedTestName: cases.get(p.testCase)?.automatedTestName,
            })),
            // Scenarios whose results go to this suite for a test case that is not in it: the framework finds
            // no test point for them and publishes nothing ("No test point found").
            missing: pub.targets.filter((t) => t.plan === plan && t.suite === suite).flatMap((t) => t.testCases.filter((id) => !inSuite.has(id)).map((id) => ({ testCase: id, file: t.file, line: t.line, name: t.name }))),
        };
    });
    /** Scenarios of the repository with the test cases they are tagged with (to add to a suite). */
    app.get('/api/ado/testplans/scenarios', async (req) => {
        const { project, env } = adoTarget(req.query as Record<string, string>);
        return { scenarios: adoPublishing(project, env).targets };
    });
    /** A scenario as test steps (what a test case made from it, or synced with it, gets). */
    const scenarioAt = (file: string, line: number, name: string) => {
        if (!file.endsWith('.feature')) throw new BadRequest('Only feature files hold scenarios.');
        const f = ws.read(file);
        if (f.binary) throw new BadRequest(`${file} is not a text file.`);
        const sc = scenarioTestSteps(f.content, line);
        if (!sc || sc.name !== name.trim()) throw new BadRequest(`"${name}" is no longer on line ${line} of ${file}: reload.`);
        return { ...sc, text: f.content, hash: f.hash };
    };
    app.post('/api/ado/testplans/steps', async (req) => {
        const b = body(req);
        const sc = scenarioAt(str(b.file, 'file', { max: 1024 }), posInt(b.line, 'line'), str(b.name, 'name', { max: 1000 }));
        return { name: sc.name, steps: sc.steps };
    });
    // Create test cases from scenarios, add them to a suite, and tag each scenario with its new @TestCaseId.
    app.post('/api/ado/testplans/:plan/suites/:suite/add-scenarios', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm creating the test cases in Azure DevOps.');
        const prm = req.params as { plan: string; suite: string };
        const plan = posInt(prm.plan, 'plan'), suite = posInt(prm.suite, 'suite');
        const list = Array.isArray(b.scenarios) ? b.scenarios.slice(0, 50) as Array<Record<string, unknown>> : [];
        if (!list.length) throw new BadRequest('Choose scenarios.');
        const { tp, project, env } = testPlansFor(b as Record<string, string>);
        const targets = adoPublishing(project, env).targets;
        const p = (await tp.plans(true)).find((x) => x.id === plan);
        if (!p) throw new BadRequest('That test plan is not in the project.');
        const created: Array<{ id: number; name: string; file: string }> = [];
        for (const it of list) {
            const file = str(it.file, 'file', { max: 1024 }), line = posInt(it.line, 'line'), name = str(it.name, 'name', { max: 1000 });
            const sc = scenarioAt(file, line, name);
            const id = await tp.createTestCase({ title: sc.name, steps: sc.steps, areaPath: p.areaPath, iterationPath: p.iteration,
                ...(b.markAutomated === true ? { automatedTestName: sc.name, automatedTestStorage: file } : {}), ...(sc.parameters ? { parameters: sc.parameters } : {}) });
            await tp.addToSuite(plan, suite, [id]);
            // Tags on the scenario now (the file may have changed meanwhile: read it again): its test case, and
            // the plan and suite when its results would otherwise go elsewhere (scenario tags override the
            // feature's and the configuration's, as in the framework).
            const cur = ws.read(file);
            if (!cur.binary) {
                const t = targets.find((x) => x.file === file && x.line === line) ?? {};
                const next = withScenarioTags(cur.content, line, name, [`@TestCaseId:${id}`, ...tagsToPublishTo(t, plan, suite)]);
                if (next !== cur.content) ws.write(file, next, cur.hash);
            }
            created.push({ id, name: sc.name, file });
            log('ado.testcase.create', `Created test case ${id} "${sc.name}" in plan ${plan} suite ${suite} and tagged the scenario (${file})`, { id, plan, suite, file });
        }
        return { created };
    });
    // Replace a test case's steps with its scenario's (optionally marking it automated by the scenario).
    app.post('/api/ado/testcases/:id/sync', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm updating the test case in Azure DevOps.');
        const id = posInt((req.params as { id: string }).id, 'test case');
        const file = str(b.file, 'file', { max: 1024 }), line = posInt(b.line, 'line'), name = str(b.name, 'name', { max: 1000 });
        const sc = scenarioAt(file, line, name);
        if (!new RegExp(`@TestCaseId:(\\{[^}]*\\b${id}\\b[^}]*\\}|${id}\\b)`, 'i').test(sc.text.split(/\r?\n/).slice(Math.max(0, line - 6), line).join(' '))) throw new BadRequest(`That scenario is not tagged @TestCaseId:${id}.`);
        const { tp } = testPlansFor(b as Record<string, string>);
        await tp.updateTestCase(id, sc.steps, b.markAutomated === true ? { name: sc.name, storage: file } : undefined, sc.parameters);
        log('ado.testcase.sync', `Updated the steps of test case ${id} from "${sc.name}" (${file})`, { id, file });
        return { ok: true, steps: sc.steps.length };
    });
    app.get('/api/pipeline/secrets', async (req) => {
        const q = req.query as Record<string, string>;
        const project = configProjectParam(q.project);
        const env = envParam(q.env);
        const reqs = requirements(opts.repoRoot, opts.store, projectId, project, env);
        if (q.check !== 'true') {
            // Not set up (no address, no token): said right away, like the other Azure DevOps screens (no network used here).
            try { adoSettingsFor(opts.repoRoot, opts.store, projectId, project, env, process.env, personal()); return { ...reqs, adoChecked: false }; }
            catch (e) { return { ...reqs, adoChecked: false, adoError: e instanceof Error ? e.message : String(e) }; }
        }
        try {
            const target = new URL(adoSettingsFor(opts.repoRoot, opts.store, projectId, project, env, process.env, personal()).orgUrl).hostname;
            return { ...(await checkInAdo(reqs, adoClient(project, env))), adoChecked: true, adoHost: target };
        }
        catch (e) { return { ...reqs, adoChecked: false, adoError: e instanceof Error ? e.message : String(e) }; }
    });
    /** How the repository's packages install: npm ci with a lock file; the private feed the framework came from (its .npmrc, or where npm resolved it). */
    const pipelineInstall = (root: string): { ci: boolean; registry?: string } => {
        const ci = fs.existsSync(path.join(root, 'package-lock.json'));
        let registry: string | undefined;
        try { registry = /^registry\s*=\s*(https:\/\/pkgs\.dev\.azure\.com\/\S+|https:\/\/[\w.-]+\.pkgs\.visualstudio\.com\/\S+)/m.exec(fs.readFileSync(path.join(root, '.npmrc'), 'utf8'))?.[1]; } catch { /* none */ }
        if (!registry) {
            try {
                const lock = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '.package-lock.json'), 'utf8')) as { packages?: Record<string, { resolved?: string }> };
                const r = Object.entries(lock.packages ?? {}).find(([k]) => k.endsWith('/cs-playwright-test-framework'))?.[1].resolved;
                const m = r && /^(https:\/\/pkgs\.dev\.azure\.com\/[^/]+(?:\/[^/]+)?\/_packaging\/[^/]+\/npm\/registry\/)/.exec(r);
                if (m) registry = m[1];
            } catch { /* not installed */ }
        }
        return { ci, ...(registry ? { registry } : {}) };
    };
    // An Azure DevOps pipeline that runs the project's tests (preview; written to pipelines/ when asked).
    app.post('/api/pipeline/tests', async (req) => {
        const b = body(req);
        const project = configProjectParam(b.project);
        const all = discover(opts.repoRoot).environments[project] ?? [];
        const envs = Array.isArray(b.envs) && b.envs.length ? b.envs.map(String) : all;
        for (const e of envs) if (!all.includes(e)) throw new BadRequest(`There is no environment "${e}" for ${project}.`);
        const reqs = requirements(opts.repoRoot, opts.store, projectId, project, envs[0] ?? 'dev');
        const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
        const o: TestPipelineOptions = {
            name: str(b.name, 'name', { max: 100 }), project, envs,
            ...(typeof b.tags === 'string' && b.tags.trim() ? { tags: b.tags.trim() } : {}),
            ...(Array.isArray(b.features) && b.features.length ? { features: b.features.map(String) } : {}),
            ...(typeof b.browser === 'string' && b.browser ? { browser: b.browser as TestPipelineOptions['browser'] } : {}),
            workers: num(b.workers), retries: num(b.retries), agents: num(b.agents), timeoutMinutes: num(b.timeoutMinutes),
            ...(typeof b.schedule === 'string' && b.schedule.trim() ? { schedule: b.schedule.trim() } : {}),
            ...(typeof b.branch === 'string' && b.branch.trim() ? { branch: b.branch.trim() } : {}),
            prValidation: b.prValidation === true,
            variableGroup: typeof b.variableGroup === 'string' && b.variableGroup.trim() ? b.variableGroup.trim() : reqs.variableGroup,
            secretNames: reqs.rows.map((r) => r.name),
            ...(typeof b.pool === 'string' && b.pool.trim() ? { pool: b.pool.trim() } : {}),
            ...(b.agentOs === 'windows' || b.agentOs === 'linux' ? { agentOs: b.agentOs } : {}),
            install: pipelineInstall(opts.repoRoot),
            ...(b.fixMission && typeof b.fixMission === 'object' ? { fixMission: { minutes: num((b.fixMission as Record<string, unknown>).minutes), pushBranch: (b.fixMission as Record<string, unknown>).pushBranch === true } } : {}),
            ...(b.evalAgents && typeof b.evalAgents === 'object' && Array.isArray((b.evalAgents as Record<string, unknown>).agents) ? { evalAgents: { agents: ((b.evalAgents as Record<string, unknown>).agents as unknown[]).map(String), allowFailures: (b.evalAgents as Record<string, unknown>).allowFailures === true } } : {}),
        };
        let yamlText: string;
        try { yamlText = testPipeline(o); } catch (e) { throw new BadRequest((e as Error).message); }
        const target = pipelineFile(o.name);
        const abs = safePath(opts.repoRoot, target);
        const exists = fs.existsSync(abs);
        if (b.save === true) {
            if (exists && b.overwrite !== true) throw new BadRequest(`${target} exists: choose to replace it.`);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, yamlText);
            log('pipeline.tests', `Wrote the pipeline ${target} for ${project}`);
        }
        return { yaml: yamlText, file: target, exists, secretNames: o.secretNames, variableGroup: o.variableGroup, saved: b.save === true };
    });
    app.post('/api/pipeline/secrets/sync', async (req) => {
        const b = body(req);
        const project = configProjectParam(b.project);
        const env = envParam(b.env);
        const names = strList(b.names, 'names');
        const reqs = requirements(opts.repoRoot, opts.store, projectId, project, env);
        const client = adoClient(project, env);
        // The user must have seen where the secrets go: the host they confirmed must be the target.
        const target = new URL(adoSettingsFor(opts.repoRoot, opts.store, projectId, project, env, process.env, personal()).orgUrl).hostname;
        if (str(b.confirmHost, 'confirmHost', { max: 253 }).toLowerCase() !== target.toLowerCase()) throw new BadRequest(`Please confirm sending to ${target}.`);
        const res = await syncToAdo(reqs, names, opts.store, projectId, client);
        log('pipeline.sync', `${res.created ? 'Created' : 'Updated'} ADO variable group ${reqs.variableGroup} with ${res.sent.length} secret(s)`, { group: reqs.variableGroup, names: res.sent.join(', ') });
        return { ...res, variableGroup: reqs.variableGroup };
    });

    // ---- Editor: files, search, language features
    const ws = new Workspace(opts.repoRoot);
    // TypeScript runs in a worker thread; started when a code file is first used (or warmed up
    // by the Code page), so the rest of the Studio never waits for it.
    const tsc = new TsClient(opts.repoRoot);
    app.addHook('onClose', async () => { await tsc.close(); });
    const ts = async (abs: string, text: string) => { await tsc.update(abs, text); return tsc; };
    // Index only the folders the framework loads steps from: STEP_DEFINITIONS_PATH of each project
    // (last definition across its configuration files wins, as when the framework loads them).
    const stepIndex = new StepIndex(opts.repoRoot, () => {
        const out: Array<{ project?: string; value: string }> = [];
        const found = discover(opts.repoRoot);
        for (const project of found.projects) {
            let value: string | undefined;
            const env = found.environments[project]?.[0] ?? '';
            for (const l of fileLayerPaths(opts.repoRoot, project, env)) {
                const v = readFileLayer(opts.repoRoot, l.source, l.label).values.STEP_DEFINITIONS_PATH;
                if (v !== undefined) value = v;
            }
            if (value !== undefined) out.push({ project, value });
            else out.push({ project, value: DEFAULT_STEP_PATHS });
        }
        return out;
    }, (project) => {
        // A new project: the STEP_DEFINITIONS_PATH of the shared layers (global.env), for its name.
        let value: string | undefined;
        for (const l of fileLayerPaths(opts.repoRoot, project, '')) {
            const v = readFileLayer(opts.repoRoot, l.source, l.label).values.STEP_DEFINITIONS_PATH;
            if (v !== undefined) value = v;
        }
        return value;
    });
    // Per project: a feature is checked against the steps ITS project loads.
    let stepCache: Map<string, { at: number; defs: StepDef[] }> | null = null;
    const projectOf = (file?: string) => file ? projectOfFeature(file, discover(opts.repoRoot).projects) : undefined;
    const stepDefs = (file?: string) => {
        const project = projectOf(file);
        if (!stepCache) stepCache = new Map();
        const key = project ?? '';
        let c = stepCache.get(key);
        if (!c || Date.now() - c.at > 3000) { c = { at: Date.now(), defs: stepIndex.all(project) }; stepCache.set(key, c); }
        return c.defs;
    };
    const filePath = (v: unknown) => { const p = str(v, 'path', { max: 4096 }); ws.abs(p); return p; };
    const content = (v: unknown) => { if (typeof v !== 'string') throw new BadRequest('"content" must be text.'); if (v.length > 5_000_000) throw new BadRequest('File too large.'); return v; };
    const offsetOf = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new BadRequest('"offset" is invalid.'); return n; };
    const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

    app.get('/api/files', async () => ws.list());
    app.get('/api/file', async (req) => ws.read(filePath((req.query as Record<string, string>).path)));
    /**
     * A library file that go to definition or find usages led to (a framework class's .d.ts under node_modules),
     * to show read-only. Only files the language service named, so a package installed as a link (npm link,
     * pnpm) can be shown although it is outside the project; nothing else outside the project can be read here.
     */
    const libFiles = new Set<string>();
    const noteLibFiles = <T extends { path: string }>(locs: T[]): T[] => {
        for (const l of locs) if (/(^|\/)node_modules\//.test(l.path) && /\.(d\.)?[cm]?[jt]sx?$/.test(l.path) && !l.path.startsWith('..')) { libFiles.add(l.path); if (libFiles.size > 2000) libFiles.delete(libFiles.values().next().value as string); }
        return locs;
    };
    app.get('/api/file/library', async (req) => {
        const rel = str((req.query as Record<string, string>).path, 'path', { max: 4096 });
        if (!libFiles.has(rel)) throw new BadRequest(`${rel} can only be opened from go to definition or find usages.`);
        const a = path.resolve(opts.repoRoot, rel);
        const st = fs.statSync(a);
        if (!st.isFile() || st.size > 5 * 1024 * 1024) throw new BadRequest(`${rel} cannot be shown (not a file, or larger than 5 MB).`);
        const content = fs.readFileSync(a, 'utf8');
        return { path: rel, content, hash: '', size: st.size, eol: content.includes('\r\n') ? '\r\n' : '\n', binary: false, readOnly: true };
    });
    app.put('/api/file', async (req) => {
        const b = body(req);
        const p = filePath(b.path);
        const r = ws.write(p, content(b.content), b.expectedHash === null ? null : str(b.expectedHash, 'expectedHash', { max: 64 }));
        if (TsService.supports(p) && tsc.isStarted) await tsc.update(ws.abs(p), undefined);
        stepCache = null;
        return r;
    });
    app.post('/api/file/folder', async (req) => { const p = filePath(body(req).path); ws.createFolder(p); return { ok: true }; });
    app.post('/api/file/rename', async (req) => {
        const b = body(req);
        const from = filePath(b.from), to = filePath(b.to);
        ws.rename(from, to);
        log('file.rename', `Renamed ${from} to ${to}`, { from, to });
        stepCache = null;
        return { ok: true };
    });
    app.post('/api/file/copy', async (req) => {
        const b = body(req);
        const from = filePath(b.from), to = filePath(b.to);
        ws.copy(from, to);
        log('file.copy', `Copied ${from} to ${to}`, { from, to });
        stepCache = null;
        return { ok: true };
    });
    app.delete('/api/file', async (req) => {
        const p = filePath((req.query as Record<string, string>).path);
        const r = await ws.remove(p);
        log('file.delete', `Deleted ${p} (a copy is kept)`, { path: p });
        stepCache = null;
        return r;
    });
    /** The search's options from the address (?q=&regex=&case=&word=&glob=&folder=&file=&ignored=). */
    const searchOptions = (q: Record<string, string>): TextSearchOptions => {
        const o: TextSearchOptions = {
            q: str(q.q, 'searchText', { max: 500 }), regex: q.regex === 'true', caseSensitive: q.case === 'true', wholeWord: q.word === 'true',
            glob: q.glob ? str(q.glob, 'glob', { max: 500 }) : undefined,
            folder: q.folder ? str(q.folder, 'folder', { max: 4096 }) : undefined,
            file: q.file ? str(q.file, 'file', { max: 4096 }) : undefined,
            includeIgnored: q.ignored === 'true',
        };
        try { matcher(o); } catch (e) { throw new BadRequest((e as Error).message); }
        return o;
    };
    // The results only (other screens, e.g. Run tests looking for a scenario).
    app.get('/api/search', async (req) => (await ws.textSearch(searchOptions(req.query as Record<string, string>))).hits);
    // Search in the Code screen: the results, and every file with matches and how many (for Replace all).
    app.get('/api/search/text', async (req) => ws.textSearch(searchOptions(req.query as Record<string, string>)));

    app.post('/api/lang/diagnostics', async (req) => {
        const b = body(req);
        const p = filePath(b.path);
        const text = content(b.content);
        const out: Array<{ line: number; column: number; endLine: number; endColumn: number; message: string; severity: string; source: string; fix?: string }> = [];
        if (TsService.supports(p)) {
            const s = await ts(ws.abs(p), text);
            for (const d of await s.diagnostics(ws.abs(p))) out.push({ ...d, source: 'TypeScript' });
        } else if (/(^|\/)tsconfig(\.[\w-]+)?\.json$/.test(p)) {
            // Project-level problems (e.g. TS5011, invalid options) shown on the tsconfig itself.
            await tsc.update(ws.abs(p), undefined);
            for (const d of await tsc.projectDiagnostics(ws.abs(p))) out.push({ ...d, source: 'TypeScript' });
        } else if (/\.(ya?ml|json)$/i.test(p) && isOpenApiText(text)) {
            // An API description: the specification and the team's design rules (.cs-api-lint.json).
            for (const d of await lintOpenApi(text, lintConfig(opts.repoRoot))) out.push({ ...d, message: `${d.message} [${d.rule}]` });
        } else if (p.endsWith('.feature')) {
            for (const d of checkFeature(text, stepDefs(p), opts.repoRoot)) out.push({ line: d.line, column: d.column, endLine: d.line, endColumn: d.endColumn, message: d.message, severity: d.severity, source: 'Steps', ...(d.fix ? { fix: d.fix } : {}) });
        }
        // Same scanner that guards commits: warn while typing, long before the commit.
        const known = opts.store.exists ? opts.store.knownSecrets() : [];
        const lines = text.split(/\r?\n/).map((t, i) => ({ file: p, line: i + 1, text: t }));
        for (const f of scanLines(lines, { knownSecrets: known, allowlist: allowlistSet(opts.repoRoot) })) {
            out.push({ line: f.line, column: f.column, endLine: f.line, endColumn: f.column + f.value.length, severity: 'warning', source: 'Secrets',
                message: `${f.type}: ${f.reason} Move it to your secret store and use {env:NAME}.` });
        }
        return { diagnostics: out };
    });
    app.post('/api/lang/completions', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content); const offset = offsetOf(b.offset);
        if (TsService.supports(p)) {
            const s = await ts(ws.abs(p), text);
            try { return { items: await s.completions(ws.abs(p), offset) }; } catch (e) { if (e instanceof StaleCall) return { items: [], stale: true }; throw e; }
        }
        if (p.endsWith('.feature')) {
            const lineText = text.split(/\r?\n/)[lineAt(text, offset) - 1] ?? '';
            if (!/^\s*(Given|When|Then|And|But|\*)\s/.test(lineText)) return { items: [] };
            const seen = new Set<string>();
            const items = stepDefs(p).filter((d) => !d.notLoaded && !seen.has(d.pattern) && seen.add(d.pattern)).map((d) => ({
                name: d.pattern, kind: d.builtIn ? 'framework step' : 'project step', sortText: d.builtIn ? '1' : '0', insertText: stepSnippet(d.pattern), detail: `${d.file}:${d.line}`,
            }));
            return { items };
        }
        return { items: [] };
    });
    /** One completion's signature and documentation, its call snippet, and edits that go with it (an import). */
    app.post('/api/lang/completion-details', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content); const offset = offsetOf(b.offset);
        const name = str(b.name, 'name', { max: 500 });
        const source = b.source === undefined ? undefined : str(b.source, 'source', { max: 2000 });
        if (!TsService.supports(p)) return {};
        const s = await ts(ws.abs(p), text);
        try { return (await s.completionDetails(ws.abs(p), offset, name, source, b.data)) ?? {}; } catch (e) { if (e instanceof StaleCall) return { stale: true }; throw e; }
    });
    /** Parameter hints while typing a call's arguments. */
    app.post('/api/lang/signature', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content); const offset = offsetOf(b.offset);
        const trigger = typeof b.trigger === 'string' && /^[(,<]$/.test(b.trigger) ? b.trigger : undefined;
        if (!TsService.supports(p)) return { help: null };
        const s = await ts(ws.abs(p), text);
        try { return { help: await s.signatureHelp(ws.abs(p), offset, trigger) }; } catch (e) { if (e instanceof StaleCall) return { help: null, stale: true }; throw e; }
    });
    app.post('/api/lang/hover', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content); const offset = offsetOf(b.offset);
        if (TsService.supports(p)) { const s = await ts(ws.abs(p), text); return (await s.quickInfo(ws.abs(p), offset)) ?? {}; }
        if (p.endsWith('.feature')) {
            const d = definitionFor(text, lineAt(text, offset), stepDefs(p));
            return d ? { text: d.pattern, doc: `${d.builtIn ? 'Framework step' : 'Step'} defined in ${d.file}:${d.line}` } : {};
        }
        return {};
    });
    app.post('/api/lang/definition', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content); const offset = offsetOf(b.offset);
        if (TsService.supports(p)) { const s = await ts(ws.abs(p), text); return { locations: noteLibFiles(await s.definition(ws.abs(p), offset)) }; }
        if (p.endsWith('.feature')) {
            const d = definitionFor(text, lineAt(text, offset), stepDefs(p));
            return { locations: d ? [{ path: d.file, line: d.line, column: 1, endLine: d.line, endColumn: 1 }] : [] };
        }
        return { locations: [] };
    });
    app.post('/api/lang/references', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content); const offset = offsetOf(b.offset);
        if (!TsService.supports(p)) return { locations: [] };
        const s = await ts(ws.abs(p), text);
        return { locations: noteLibFiles(await s.references(ws.abs(p), offset)) };
    });
    app.post('/api/lang/format', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content);
        if (p.endsWith('.feature')) return { content: formatGherkin(text) };
        if (!TsService.supports(p)) return { content: text };
        const s = await ts(ws.abs(p), text);
        return { content: await s.format(ws.abs(p)) };
    });
    // ---- A step across the project: usages, rename (see lang/stepRefactor.ts).
    /** The step at the caret: a feature step's definition, or the definition written at (or just above) the line in a step file. */
    const stepDefAt = (p: string, text: string, offset: number): StepDef => {
        const line = lineAt(text, offset);
        if (p.endsWith('.feature')) {
            const d = definitionFor(text, line, stepDefs(p));
            if (!d) throw new BadRequest('No step definition runs the step here.');
            return d;
        }
        // On the decorator or the method's own line(s), not inside the method's body: there the caret is on code
        // (this.loginPage.enterUsername), whose usages come from TypeScript.
        const lines = text.split(/\r?\n/);
        const opensBody = (from: number, to: number) => lines.slice(from - 1, to - 1).some((l) => l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '').includes('{'));
        const here = extractStepDefs(text, p, false).filter((d) => d.line <= line && line - d.line <= 4 && !opensBody(d.line, line)).sort((x, y) => y.line - x.line)[0];
        if (!here) throw new BadRequest('Put the caret on a step definition (its @CSBDDStepDef line or method).');
        const d = stepDefs(p).find((x) => x.file === p && x.pattern === here.pattern);
        if (!d) throw new BadRequest(`"${here.pattern}" is not loaded by any project (its folder is not in STEP_DEFINITIONS_PATH).`);
        return d;
    };
    const allFeatures = () => readCatalog(opts.repoRoot).map((f) => f.path).map((f) => { let text = ''; try { text = fs.readFileSync(ws.abs(f), 'utf8'); } catch { /* gone */ } return { path: f, text }; });
    const usagesOf = (d: StepDef) => stepUsages(d, allFeatures(), (f) => stepDefs(f));
    app.post('/api/lang/step-usages', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const d = stepDefAt(p, content(b.content), offsetOf(b.offset));
        return { step: { pattern: d.pattern, file: d.file, line: d.line, builtIn: d.builtIn }, usages: usagesOf(d) };
    });
    /** Rename a step: preview (the lines that change), or apply (only from saved files, as previewed). */
    app.post('/api/lang/step-rename', async (req) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content);
        const disk = (f: string) => fs.readFileSync(ws.abs(f), 'utf8');
        if (text.replace(/\r\n/g, '\n') !== disk(p).replace(/\r\n/g, '\n')) throw new BadRequest('Save the file first: the rename works on saved files.');
        const d = stepDefAt(p, text, offsetOf(b.offset));
        if (d.builtIn) throw new BadRequest(`"${d.pattern}" is one of the framework's own steps: it cannot be renamed here.`);
        const np = str(b.pattern, 'pattern', { max: 500 }).trim();
        const problem = renameProblem(d.pattern, np, stepDefs(d.file));
        if (problem) throw new BadRequest(problem);
        const usages = usagesOf(d);
        const plan = planRename(d, np, disk(d.file).replace(/\r\n/g, '\n'), usages, (f) => disk(f).replace(/\r\n/g, '\n'));
        const files = [...new Set(plan.changes.map((c) => c.path))];
        if (b.apply !== true) return { step: { pattern: d.pattern, file: d.file, line: d.line }, pattern: np, changes: plan.changes, files, skipped: plan.skipped };
        // Apply: every file read again; a line that changed since the preview stops the whole rename.
        const written: string[] = [];
        const next = files.map((f) => { const raw = disk(f); const crlf = raw.includes('\r\n'); const t = applyChanges(raw.replace(/\r\n/g, '\n'), plan.changes.filter((c) => c.path === f)); return { f, out: crlf ? t.replace(/\n/g, '\r\n') : t }; });
        for (const x of next) { const cur = ws.read(x.f) as { hash: string }; ws.write(x.f, x.out, cur.hash); written.push(x.f); }
        stepCache = null;
        for (const f of written) if (TsService.supports(f) && tsc.isStarted) await tsc.update(ws.abs(f), undefined);
        log('lang.step-rename', `Renamed the step "${d.pattern}" to "${np}" (${plan.changes.length - 1} feature steps in ${written.length - 1} files)`, { file: d.file });
        return { step: { pattern: np, file: d.file, line: d.line }, changes: plan.changes, files: written, skipped: plan.skipped };
    });
    app.post('/api/lang/close', async (req) => { const p = filePath(body(req).path); if (TsService.supports(p)) await tsc.update(ws.abs(p), undefined); return { ok: true }; });
    // The Code page calls this when it opens: TypeScript builds the project in the background.
    app.post('/api/lang/warmup', async (req) => {
        // The project of the file being edited (its nearest tsconfig.json), so its first completion does not build it.
        const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
        const p = typeof b.path === 'string' && b.path ? filePath(b.path) : undefined;
        void tsc.warmUp(p && TsService.supports(p) ? ws.abs(p) : undefined).catch(() => undefined);
        return { ok: true };
    });
    // ---- "Create step definition" for an undefined step
    /** The undefined step on a line of a feature file, with what follows it (table / doc string). */
    const stepAt = (text: string, line: number) => {
        const s = featureSteps(text).find((x) => x.line === line);
        if (!s) throw new BadRequest('There is no step on that line.');
        const lines = text.split(/\r?\n/);
        let j = line; while (j < lines.length && !lines[j].trim()) j++;
        const next = (lines[j] ?? '').trim();
        return { step: s, dataTable: next.startsWith('|'), docString: /^("{3}|`{3})/.test(next) };
    };
    const rel = (abs: string) => path.relative(opts.repoRoot, abs).split(path.sep).join('/');
    const planStep = (featurePath: string, text: string, line: number) => {
        const { step, dataTable, docString } = stepAt(text, line);
        const outline = step.variants.length > 1 || step.variants[0] !== step.text;
        let g;
        try { g = generateStep(step.text, { variants: outline ? step.variants : undefined, dataTable, docString }); }
        catch (e) { if (e instanceof StepGenError) throw new BadRequest(e.message); throw e; }
        // Where to put it: step files the framework loads, the feature's own project first.
        const project = /^test\/([^/]+)\//.exec(featurePath)?.[1];
        const base = path.basename(featurePath, '.feature').toLowerCase().replace(/[^a-z0-9]/g, '');
        const loaded = stepIndex.loadedFiles(project).map(rel).filter((f) => /\.ts$/.test(f));
        const score = (f: string) => (project && f.startsWith(`test/${project}/`) ? 2 : 0) + (path.basename(f).toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(base) ? 4 : 0);
        const existing = [...loaded].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
        // A new file named after the feature, in the project's loaded steps folder.
        const folders = stepIndex.folders(project).map(rel).filter((f) => f && !f.startsWith('..') && !/\.(ts|js)$/.test(f));
        const folder = folders.find((f) => project && f.startsWith(`test/${project}/`)) ?? folders[0] ?? (project ? `test/${project}/steps` : 'test/common/steps');
        const newFile = `${folder}/${path.basename(featurePath, '.feature').replace(/[^A-Za-z0-9_-]+/g, '-')}.steps.ts`;
        // Suggest: the file named like the feature; else the project's only step file; else a new file.
        const inProject = existing.filter((f) => project && f.startsWith(`test/${project}/`));
        const suggested = existing.length && score(existing[0]) >= 4 ? existing[0] : inProject.length === 1 ? inProject[0] : null;
        const targets = [
            ...existing.map((f) => ({ file: f, exists: true, recommended: f === suggested })),
            ...(loaded.includes(newFile) ? [] : [{ file: newFile, exists: false, recommended: !suggested }]),
        ];
        return { step: step.text, g, targets, className: classNameFor(path.basename(featurePath)) };
    };
    /** A test plan (feature file) against the steps its project loads: each step reused or new (the agents' plan review). */
    app.post('/api/lang/plan', async (req) => {
        const b = body(req);
        const p = filePath(b.path);
        if (!p.endsWith('.feature')) throw new BadRequest('A plan is a .feature file.');
        const text = b.content !== undefined ? content(b.content) : (() => { const f = ws.read(p); if (f.binary) throw new BadRequest(`${p} is not a text file.`); return f.content; })();
        const coverage = planCoverage(text, stepDefs(p));
        return { coverage, summary: planSummary(p, coverage) };
    });
    app.post('/api/lang/steps/plan', async (req) => {
        const b = body(req);
        const p = filePath(b.path);
        if (!p.endsWith('.feature')) throw new BadRequest('Steps are created from a .feature file.');
        const line = Number(b.line); if (!Number.isInteger(line) || line < 1) throw new BadRequest('"line" is invalid.');
        const plan = planStep(p, content(b.content), line);
        return { step: plan.step, pattern: plan.g.pattern, params: plan.g.params, preview: methodSource(plan.g, plan.step, '    ', '\n'), targets: plan.targets };
    });
    app.post('/api/lang/steps/create', async (req) => {
        const b = body(req);
        const p = filePath(b.path);
        const line = Number(b.line); if (!Number.isInteger(line) || line < 1) throw new BadRequest('"line" is invalid.');
        const plan = planStep(p, content(b.content), line);
        const target = filePath(b.target);
        if (!/\.ts$/.test(target)) throw new BadRequest('Choose a TypeScript step file (.ts).');
        if (!plan.targets.some((t) => t.file === target) && !isStepFile(path.basename(target))) {
            throw new BadRequest('The framework only loads files named *.steps.ts, *.step.ts or *Steps.ts.');
        }
        // The open editor's text (unsaved edits included) when the target is open, else the file.
        let base: string | null = typeof b.targetContent === 'string' ? content(b.targetContent) : null;
        let baseHash: string | null = null;
        if (base === null && fs.existsSync(ws.abs(target))) {
            const f = ws.read(target);
            if (f.binary) throw new BadRequest(`${target} is not a text file.`);
            base = f.content; baseHash = f.hash;
        }
        const ins = insertStep(base, plan.g, plan.step, plan.className, `${frameworkPackageName(opts.repoRoot)}/bdd`);
        stepCache = null;
        return { file: target, content: ins.content, line: ins.line, created: base === null, baseHash, pattern: plan.g.pattern, methodName: ins.methodName };
    });
    app.get('/api/lang/steps', async () => stepDefs().filter((d) => !d.notLoaded).map((d) => ({ pattern: d.pattern, file: d.file, line: d.line, builtIn: d.builtIn })));
    app.get('/api/lang/info', async () => ({ typescript: tsc.isStarted ? { ...(await tsc.info()), from: 'studio' } : null }));

    // ---- Test runs
    const runner = new TestRunner(opts.repoRoot, path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'runs.json'));
    app.addHook('onClose', async () => { runner.stopAll(); });

    // ---- Run notifications (Teams, Slack, any webhook): personal, kept on this computer; addresses in the secret store.
    const notifyStore = opts.home ? new NotifyStore(opts.home) : null;
    const deliveries: Delivery[] = [];
    const notifyChannels = () => notifyStore?.get() ?? [];
    const webhookOf = (c: NotifyChannel) => studioSecret(notifySecret(c.id));
    const recordDelivery = (d: Delivery) => { deliveries.unshift(d); deliveries.length = Math.min(deliveries.length, 50); if (!d.ok) log('notify.failed', `Could not notify ${d.channel}: ${d.detail}`); };
    runner.on('ended', (run: RunInfo) => {
        const chans = notifyChannels().filter((c) => c.enabled);
        if (!chans.length) return;
        void (async () => {
            const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: opts.repoRoot, allowFailure: true })).stdout.trim();
            const note = runNote(run, opts.userName, branch && branch !== 'HEAD' ? branch : undefined);
            const prev = previousState(runner.list(), run);
            for (const c of chans) {
                const url = webhookOf(c);
                if (!url || !shouldNotify(c, note, prev)) continue;
                recordDelivery(await deliver(c, url, note, netConnection()));
            }
        })().catch(() => { /* a notification never breaks a run */ });
    });
    const notifyChannelsView = () => notifyChannels().map((c) => ({ ...c, hasWebhook: !!webhookOf(c) }));
    // version: what the screen read; a save from a screen that read an older version is refused (two tabs).
    const notifyView = () => { const channels = notifyChannelsView(); return { channels, version: contentVersion(channels), deliveries, canSave: !!notifyStore && opts.store.exists }; };
    app.get('/api/notifications', async () => notifyView());
    app.put('/api/notifications', async (req) => {
        if (!notifyStore) throw new BadRequest('Notifications need the Studio\'s data folder.');
        const b = body(req);
        checkVersion(b.version, contentVersion(notifyChannelsView()), b.force);
        const channels = validateChannels(b.channels);
        const hooks = (b.webhooks && typeof b.webhooks === 'object' ? b.webhooks : {}) as Record<string, unknown>;
        for (const c of channels) {
            const v = hooks[c.id];
            if (typeof v === 'string' && v.trim()) {
                if (!opts.store.exists) throw new BadRequest('Set up the secret store first (Secrets): webhook addresses are kept there.');
                opts.store.setStudio(notifySecret(c.id), validateWebhook(c.kind, v));
            }
            if (!webhookOf(c)) throw new BadRequest(`"${c.name}" needs its webhook address.`);
        }
        // Channels removed: their addresses go too.
        for (const old of notifyChannels()) if (!channels.some((c) => c.id === old.id) && opts.store.exists) opts.store.deleteStudio(notifySecret(old.id));
        notifyStore.set(channels);
        log('notify.settings', `Saved ${channels.length} notification channel${channels.length === 1 ? '' : 's'}`);
        return notifyView();
    });
    app.post('/api/notifications/test', async (req) => {
        const id = str(body(req).id, 'id', { max: 40 });
        const c = notifyChannels().find((x) => x.id === id);
        if (!c) throw new BadRequest('No such channel.');
        const url = webhookOf(c);
        if (!url) throw new BadRequest(`"${c.name}" has no webhook address.`);
        const now = new Date().toISOString();
        const d = await deliver(c, url, { id: 'test', state: 'passed', project: 'example', env: 'qa', what: 'a test message from CS Test Studio', startedAt: now, endedAt: now, durationMs: 0, passed: 1, failed: 0, skipped: 0, failures: [], by: opts.userName }, netConnection());
        recordDelivery(d);
        return d;
    });
    // Folders the framework writes into the project (reports, .flaky-test-data) that Git would pick
    // up as new files: offer to add them to .gitignore.
    const outputDirs = () => [...new Set(['.flaky-test-data', 'reports', 'test-results', ...runner.reportDirs.map((d) => d.replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0])])]
        .filter((d) => d && !d.startsWith('..') && !path.isAbsolute(d) && !/^[.]git$/i.test(d));
    app.get('/api/runs/untracked-output', async () => {
        const out: string[] = [];
        for (const d of outputDirs()) {
            if (!fs.existsSync(path.join(opts.repoRoot, d))) continue;
            const ignored = await runGit(['check-ignore', '-q', '--no-index', '--', d + '/'], { cwd: opts.repoRoot, allowFailure: true });
            if (ignored.code !== 0) out.push(d);
        }
        return { paths: out };
    });
    app.post('/api/runs/ignore-output', async (req) => {
        const b = body(req);
        const wanted = Array.isArray(b.paths) ? b.paths.filter((p): p is string => typeof p === 'string') : [];
        const allowed = new Set(outputDirs());
        const add = wanted.filter((p) => allowed.has(p));
        if (!add.length) throw new BadRequest('Nothing to add.');
        const gi = safeRepoPath(opts.repoRoot, '.gitignore', { write: true });
        const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
        const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
        const lines = add.map((p) => `/${p}/`).filter((l) => !have.has(l));
        if (lines.length) {
            const eol = cur.includes('\r\n') ? '\r\n' : '\n';
            writeFileInRepo(gi, cur + (cur && !/\n$/.test(cur) ? eol : '') + `# Test run output (added by CS Test Studio)${eol}` + lines.join(eol) + eol);
        }
        log('runs.ignore', `Added ${add.join(', ')} to .gitignore`);
        return { added: lines };
    });
    app.get('/api/runs/framework', async () => { try { const f = frameworkCli(opts.repoRoot); return { installed: true, version: f.version, severalScenarios: frameworkReadsScenarios(f.script) }; } catch (e) { return { installed: false, message: (e as Error).message }; } });
    /** Where the HTML report is, relative to the report URL root (the results folder). */
    const reportIndexOf = (r: { summary?: { reportDir: string; hasHtml: boolean } }) =>
        r.summary?.hasHtml ? path.relative(resultsRootOf(r.summary.reportDir), path.join(r.summary.reportDir, 'index.html')).split(path.sep).join('/') : null;
    // What can be run: features with their tags and scenarios, and each project's default folder.
    app.get('/api/runs/catalog', async () => {
        const features = readCatalog(opts.repoRoot);
        const projects = discover(opts.repoRoot).projects;
        return { features, projectFolders: Object.fromEntries(projects.map((p) => [p, projectFeatureFolder(opts.repoRoot, p)])) };
    });
    app.get('/api/runs', async () => runner.list().map((r) => ({ ...r, reportKey: runner.reportKey(r.id), reportIndex: reportIndexOf(r) })));
    // Failure evidence (screenshots, traces, videos) of a finished run, read from its report.
    const runWithReport = (id: string) => {
        const r = runner.get(id);
        if (!r) throw new BadRequest('Unknown run.');
        if (!r.summary) throw new BadRequest('This run has no results to show.');
        return r as typeof r & { summary: NonNullable<typeof r.summary> };
    };
    app.get('/api/runs/:id/evidence', async (req) => {
        const r = runWithReport((req.params as { id: string }).id);
        const ev = readEvidence(runner.base(r), r.summary.reportDir, { features: indexFeatures(runner.base(r)), ran: r.request.features });
        const secrets = opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : [];
        const mask = (t?: string) => (t === undefined ? t : maskSecrets(t, secrets));
        return {
            ...ev,
            hasPlaywright: projectPlaywrightCli(opts.repoRoot) !== null,
            scenarios: ev.scenarios.map((sc) => ({
                ...sc, name: mask(sc.name)!,
                failedStep: sc.failedStep ? { ...sc.failedStep, name: mask(sc.failedStep.name)!, error: mask(sc.failedStep.error) } : undefined,
                steps: sc.steps.map((st) => ({ ...st, text: mask(st.text)!, error: mask(st.error), actions: st.actions.map((a) => ({ ...a, text: mask(a.text)! })) })),
            })),
        };
    });
    app.post('/api/runs/:id/trace', async (req) => {
        const r = runWithReport((req.params as { id: string }).id);
        const file = str(body(req).file, 'file', { max: 1024 });
        const ev = readEvidence(runner.base(r), r.summary.reportDir);
        const f = ev.run.find((x) => x.kind === 'trace' && x.file === file) ?? ev.scenarios.flatMap((x) => x.files).find((x) => x.kind === 'trace' && x.file === file);
        if (!f) throw new BadRequest('That trace is not part of this run.');
        const cli = projectPlaywrightCli(opts.repoRoot);
        if (!cli) throw new BadRequest('Playwright was not found in this project (node_modules). Download the trace and open it with "npx playwright show-trace <file>".');
        const abs = path.join(runner.base(r), ev.resultsRoot, f.file);
        // The project's own Playwright, as a separate program (like running the tests themselves).
        const child = spawn(process.execPath, [cli, 'show-trace', abs], { cwd: opts.repoRoot, detached: true, stdio: 'ignore', windowsHide: false, shell: false });
        child.on('error', () => undefined);
        child.unref();
        log('runs.trace', `Opened a trace in the Trace Viewer`, { file: f.name });
        return { ok: true };
    });
    app.post('/api/runs', async (req, reply) => {
        const b = body(req);
        const list = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : undefined;
        const rr: RunRequest = {
            ...(typeof b.rerunOf === 'string' && /^[\w-]{1,64}$/.test(b.rerunOf) ? { rerunOf: b.rerunOf } : {}),
            project: configProjectParam(b.project), env: envParam(b.env),
            features: list(b.features)?.map((f) => { ws.abs(f); return f; }),
            tags: str(b.tags, 'tags', { optional: true, max: 500 }) || undefined,
            scenario: str(b.scenario, 'scenario', { optional: true, max: 500 }) || undefined,
            scenarios: list(b.scenarios),
            headless: typeof b.headless === 'boolean' ? b.headless : undefined,
            browser: str(b.browser, 'browser', { optional: true, max: 20 }) || undefined,
            workers: b.workers === undefined || b.workers === null ? undefined : Number(b.workers),
            ...(b.retries !== undefined && b.retries !== null ? { retries: Number(b.retries) } : {}),
            ...(typeof b.device === 'string' && b.device ? { device: b.device } : {}),
            ...(b.viewport && typeof b.viewport === 'object' ? { viewport: { width: Number((b.viewport as Record<string, unknown>).width), height: Number((b.viewport as Record<string, unknown>).height) } } : {}),
            ...(b.variables && typeof b.variables === 'object' && !Array.isArray(b.variables) ? { variables: Object.fromEntries(Object.entries(b.variables as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])) } : {}),
            // "Azure DevOps results" for this run (Don't send / Send); left out: as the project is configured.
            ...(b.ado === true || b.ado === false ? { ado: b.ado } : b.ado !== undefined && b.ado !== null ? (() => { throw new BadRequest('Azure DevOps results: on or off.'); })() : {}),
            ...(b.debug && typeof b.debug === 'object' ? { debug: {
                steps: (b.debug as Record<string, unknown>).steps === true,
                pauseOnFailure: (b.debug as Record<string, unknown>).pauseOnFailure === true,
                ...((b.debug as Record<string, unknown>).slowMo !== undefined ? { slowMo: Number((b.debug as Record<string, unknown>).slowMo) } : {}),
                // The saved breakpoints (Code: click a line number)
                breakpoints: readBreakpoints(),
                exceptions: (b.debug as Record<string, unknown>).exceptions === true,
            } } : {}),
        };
        try { buildArgs(rr); } catch (e) { throw new BadRequest((e as Error).message); }
        // Production-like environments (by name, or STUDIO_PROTECTED=true in its config): the user confirms each run.
        let values: Record<string, string> = {};
        try { values = Object.fromEntries(resolveFor(rr.project, rr.env).entries.map((e) => [e.key, e.value ?? ''])); } catch { /* no config */ }
        const prot = protectedEnvironment(rr.env, values) ?? (/^(true|1|yes)$/i.test(values.STUDIO_PROTECTED ?? '') ? `STUDIO_PROTECTED=true for ${rr.env}` : null);
        if (prot && b.confirmed !== true) return reply.code(409).send({ error: `${prot}. Run the tests against it anyway?`, code: 'run-protected', reason: prot });
        const secretEnv = opts.store.exists ? secretsAsEnv(opts.store, { project: projectId, env: rr.env }) : {};
        try {
            const cfg = resolveFor(rr.project, rr.env);
            runner.reportDirs = ['REPORTS_BASE_DIR', 'REPORT_PATH', 'TEST_RESULTS_DIR'].map((k) => cfg.entries.find((e) => e.key === k)?.value ?? '').filter((v) => v && !v.includes('{'));
        } catch { runner.reportDirs = []; }
        const run = runner.start(rr, secretEnv, runEnvFor(personal().network, process.env));
        log('test.run', `Started tests: ${run.command.slice(1).join(' ')}`, { id: run.id, secrets: run.secretNames.join(', '), ...(prot ? { protected: prot } : {}), ...(rr.device ? { device: rr.device } : {}), ...(rr.variables ? { variables: Object.keys(rr.variables).join(', ') } : {}) });
        return run;
    });
    // ---- Saved run configurations: shared with the team in the repository (.cs-studio/run-configurations.json).
    const runConfigsFile = path.join(opts.repoRoot, '.cs-studio', 'run-configurations.json');
    // The version of the file a screen read: a save over a newer one (another tab, a teammate's pull) is refused.
    const runConfigsVersion = () => { try { return contentVersion(fs.readFileSync(runConfigsFile, 'utf8')); } catch { return contentVersion(''); } };
    app.get('/api/run-configs', async () => { try { return { configs: JSON.parse(fs.readFileSync(runConfigsFile, 'utf8')), file: relPath(runConfigsFile), version: runConfigsVersion() }; } catch { return { configs: [], file: relPath(runConfigsFile), version: runConfigsVersion() }; } });
    app.put('/api/run-configs', async (req) => {
        const b = body(req);
        // force: the person chose Overwrite after a refusal.
        checkVersion(b.force === true ? undefined : b.version, runConfigsVersion());
        let before: Array<{ name: string; [k: string]: unknown }> = [];
        try { const j = JSON.parse(fs.readFileSync(runConfigsFile, 'utf8')); if (Array.isArray(j)) before = j.filter((x) => x && typeof x.name === 'string'); } catch { /* none yet */ }
        const list = Array.isArray(b.configs) ? (b.configs as unknown[]) : null;
        if (!list || list.length > 200) throw new BadRequest('At most 200 run configurations.');
        const names = new Set<string>();
        const clean = list.map((x) => {
            const c = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
            const name = str(c.name, 'name', { max: 120 }).trim();
            if (!name || names.has(name.toLowerCase())) throw new BadRequest(`Each run configuration needs its own name (${name || 'empty'}).`);
            names.add(name.toLowerCase());
            const r = (c.request && typeof c.request === 'object' ? c.request : {}) as Record<string, unknown>;
            const rr = { ...r, project: configProjectParam(r.project), env: envParam(r.env) } as RunRequest;
            delete (rr as { debug?: unknown }).debug;
            try { buildArgs(rr); } catch (e) { throw new BadRequest(`${name}: ${(e as Error).message}`); }
            return { name, ...(typeof c.description === 'string' ? { description: c.description.slice(0, 500) } : {}), request: rr };
        });
        fs.mkdirSync(path.dirname(runConfigsFile), { recursive: true });
        fs.writeFileSync(runConfigsFile, JSON.stringify(clean, null, 2) + '\n');
        log('run.configs', runConfigsChange(before, clean), { file: relPath(runConfigsFile) });
        return { configs: clean, file: relPath(runConfigsFile), version: runConfigsVersion() };
    });
    // ---- Team test trends from Azure DevOps Analytics (every published result, not only this computer's runs).
    app.get('/api/ado/analytics/tests', async (req) => {
        const q = req.query as Record<string, string>;
        const t = adoTarget(q);
        const base = adoClient(t.project, t.env);
        const client = q.adoProject ? base.forProject(str(q.adoProject, 'adoProject', { max: 64 })) : base;
        const days = Number(q.days ?? 30);
        if (!Number.isInteger(days) || days < 1 || days > 180) throw new BadRequest('Days must be 1 to 180.');
        const workflow = q.workflow === 'Build' || q.workflow === 'Release' ? q.workflow : undefined;
        let configured = '';
        try { configured = adoSettingsFor(opts.repoRoot, opts.store, projectId, t.project, t.env, process.env, personal()).project; } catch { /* said by the call below */ }
        const web = `${client.orgUrl.replace(/\/$/, '')}/${encodeURIComponent(client.projectName)}`;
        // Where the numbers come from, said on the screen: the organization, the project, and the configuration they were read from.
        const source = { org: client.orgUrl, adoProject: client.projectName, configured, from: { project: t.project, env: t.env }, runsUrl: `${web}/_testManagement/runs`, analyticsUrl: `${web}/_test/analytics` };
        const r = await teamTrends(client, { days, workflow,
            ...(q.pipeline ? { pipeline: str(q.pipeline, 'pipeline', { max: 300 }) } : {}),
            ...(q.branch ? { branch: str(q.branch, 'branch', { max: 300 }) } : {}),
            ...(q.container ? { container: str(q.container, 'container', { max: 300 }) } : {}) });
        return { ...r, source };
    });
    // ---- Which commit broke a test: Git bisect in a separate copy, each step a run of that one scenario.
    let bisect: (BisectState & { feature: string; scenario: string; project: string; env: string }) | null = null;
    let bisectStop = false;
    const bisectDir = () => path.join(checkoutBase(opts.repoRoot, gitDirOf(opts.repoRoot)), '_bisect');
    /** The failing end (this commit) and the good end: the last run where the scenario passed on a commit of this history. */
    app.get('/api/bisect/suggest', async (req) => {
        const q = req.query as Record<string, string>;
        const scenario = str(q.scenario, 'scenario', { max: 500 });
        const head = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: opts.repoRoot, allowFailure: true })).stdout.trim();
        if (!head) throw new BadRequest('This repository has no commits yet.');
        const log = (await runGit(['log', '-n', '200', '--format=%H%x00%s%x00%an%x00%aI', 'HEAD'], { cwd: opts.repoRoot })).stdout.split('\n').filter(Boolean)
            .map((l) => { const [commit, subject, author, date] = l.split('\0'); return { commit, subject, author, date }; });
        const inHistory = new Set(log.map((c) => c.commit));
        const passedRuns = runner.list().filter((r) => !r.pr && !r.bisect && r.commit && !r.dirty && inHistory.has(r.commit) && r.commit !== head
            && r.summary?.scenarios.some((x) => x.name === scenario && x.status === 'passed'));
        const lastGood = passedRuns.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
        const failed = runner.list().filter((r) => r.summary?.scenarios.some((x) => x.name === scenario && (x.status === 'failed' || x.status === 'broken'))).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
        return {
            bad: head, commits: log,
            ...(lastGood ? { good: lastGood.commit, goodRun: { id: lastGood.id, at: lastGood.startedAt } } : {}),
            ...(failed?.dirty && failed.commit === head ? { warning: 'The run that failed had changes that were not committed: if they caused it, the search will not find a commit.' } : {}),
        };
    });
    app.get('/api/bisect/range', async (req) => {
        const q = req.query as Record<string, string>;
        try { return await bisectRange(opts.repoRoot, str(q.good, 'good', { max: 200 }), str(q.bad, 'bad', { optional: true, max: 200 }) || 'HEAD'); } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.get('/api/bisect', async () => ({ bisect }));
    app.post('/api/bisect/stop', async () => {
        if (!bisect || bisect.state !== 'running') return { bisect };
        bisectStop = true;
        const running = runner.list().find((r) => r.state === 'running' && r.bisect);
        if (running) runner.stop(running.id);
        return { bisect };
    });
    app.post('/api/bisect/start', async (req, reply) => {
        const b = body(req);
        if (bisect?.state === 'running') throw new BadRequest('A search is already running: stop it first.');
        if (runner.isRunning()) throw new BadRequest('A test run is in progress. Wait for it to finish first.');
        const feature = str(b.feature, 'feature', { max: 1000 });
        ws.abs(feature);
        const scenario = str(b.scenario, 'scenario', { max: 500 });
        if (scenario.includes(',')) throw new BadRequest('Scenario names containing commas cannot be selected individually.');
        const rr: RunRequest = { project: configProjectParam(b.project), env: envParam(b.env), features: [feature], scenarios: [scenario], headless: true, workers: 1,
            browser: str(b.browser, 'browser', { optional: true, max: 20 }) || undefined };
        const range = await bisectRange(opts.repoRoot, str(b.good, 'good', { max: 200 }), str(b.bad, 'bad', { optional: true, max: 200 }) || 'HEAD').catch((e) => { throw new BadRequest((e as Error).message); });
        try { buildArgs(rr); } catch (e) { throw new BadRequest((e as Error).message); }
        // Production-like environments (by name, or STUDIO_PROTECTED=true in its config): the user confirms each run.
        let values: Record<string, string> = {};
        try { values = Object.fromEntries(resolveFor(rr.project, rr.env).entries.map((e) => [e.key, e.value ?? ''])); } catch { /* no config */ }
        const prot = protectedEnvironment(rr.env, values) ?? (/^(true|1|yes)$/i.test(values.STUDIO_PROTECTED ?? '') ? `STUDIO_PROTECTED=true for ${rr.env}` : null);
        if (prot && b.confirmed !== true) return reply.code(409).send({ error: `${prot}. Run the tests against it anyway?`, code: 'run-protected', reason: prot });
        const secretEnv = opts.store.exists ? secretsAsEnv(opts.store, { project: projectId, env: rr.env }) : {};
        try {
            const cfg = resolveFor(rr.project, rr.env);
            runner.reportDirs = ['REPORTS_BASE_DIR', 'REPORT_PATH', 'TEST_RESULTS_DIR'].map((k) => cfg.entries.find((e) => e.key === k)?.value ?? '').filter((v) => v && !v.includes('{'));
        } catch { runner.reportDirs = []; }
        const dir = bisectDir();
        const rel = path.relative(opts.repoRoot, dir).split(path.sep).join('/');
        const testAt: TestAt = (commit) => new Promise((resolve) => {
            let run: RunInfo;
            try { run = runner.start(rr, secretEnv, runEnvFor(personal().network, process.env), { workdir: rel, bisect: { commit } }); }
            catch (e) { resolve({ outcome: 'skip', note: (e as Error).message }); return; }
            runner.once(`end:${run.id}`, (r: RunInfo) => {
                const sc = r.summary?.scenarios.find((x) => x.name === scenario);
                if (sc?.status === 'passed') resolve({ outcome: 'pass', run: r.id });
                else if (sc && (sc.status === 'failed' || sc.status === 'broken')) resolve({ outcome: 'fail', run: r.id, ...(sc.error ? { note: maskAll(sc.error.split('\n')[0].slice(0, 300)) } : {}) });
                else resolve({ outcome: 'skip', run: r.id, note: r.state === 'stopped' ? 'stopped' : r.message ?? 'the scenario did not run at this commit' });
            });
        });
        bisectStop = false;
        bisect = { state: 'running', good: range.good, bad: range.bad, commits: range.commits, estimate: range.estimate, steps: [], startedAt: new Date().toISOString(), feature, scenario, project: rr.project, env: rr.env };
        const meta = { feature, scenario, project: rr.project, env: rr.env };
        log('test.bisect', `Started searching for the commit that broke "${scenario}" (${range.commits} commits)`);
        void runBisect({ repoRoot: opts.repoRoot, dir, good: range.good, bad: range.bad, test: testAt, stopped: () => bisectStop, onChange: (st) => { bisect = { ...st, ...meta }; } })
            .then((st) => { bisect = { ...st, ...meta }; log('test.bisect', st.result ? `"${scenario}" broke in ${st.result.commit.slice(0, 8)} ${st.result.subject}` : `Search for "${scenario}": ${st.state}${st.message ? ` (${st.message})` : ''}`); })
            .catch((e) => { bisect = { ...(bisect as BisectState), ...meta, state: 'error', message: (e as Error).message, endedAt: new Date().toISOString() }; });
        return { bisect };
    });
    // ---- Debugging: breakpoints (kept per repository on this computer) and a debug run's controls
    const breakpointsFile = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'breakpoints.json');
    function readBreakpoints(): Array<{ file: string; line: number }> {
        try {
            const j = JSON.parse(fs.readFileSync(breakpointsFile, 'utf8'));
            return Array.isArray(j) ? j.filter((b) => b && typeof b.file === 'string' && Number.isInteger(b.line) && b.line > 0 && !b.file.split(/[\\/]/).includes('..') && !path.isAbsolute(b.file)).slice(0, 500) : [];
        } catch { return []; }
    }
    app.get('/api/breakpoints', async () => ({ breakpoints: readBreakpoints() }));
    app.put('/api/breakpoints', async (req) => {
        const raw = body(req).breakpoints;
        if (!Array.isArray(raw) || raw.length > 500) throw new BadRequest('"breakpoints" must be a list.');
        const list = raw.map((b) => {
            const file = str((b as Record<string, unknown>)?.file, 'file', { max: 1024 });
            ws.abs(file);
            const line = Number((b as Record<string, unknown>)?.line);
            if (!Number.isInteger(line) || line < 1) throw new BadRequest('Invalid line.');
            return { file, line };
        });
        fs.mkdirSync(path.dirname(breakpointsFile), { recursive: true });
        fs.writeFileSync(breakpointsFile, JSON.stringify(list, null, 1));
        // A debug run going on gets them at once (as in an editor).
        const live = runner.list().find((r) => r.state === 'running' && r.request.debug);
        if (live) await runner.setBreakpoints(live.id, list);
        return { breakpoints: list };
    });
    app.post('/api/runs/:id/debug', async (req) => {
        const id = (req.params as { id: string }).id;
        const cmd = str(body(req).command, 'command', { max: 10 });
        if (cmd === 'next' || cmd === 'continue' || cmd === 'stop') runner.debugCommand(id, cmd);
        else if (cmd === 'into') await runner.debugStepInto(id);
        else if (cmd === 'resume' || cmd === 'stepOver' || cmd === 'stepInto' || cmd === 'stepOut' || cmd === 'pause') await runner.debugCode(id, cmd);
        else throw new BadRequest('Unknown command.');
        return { ok: true };
    });
    const frameParam = (v: unknown) => { const n = Number(v ?? 0); if (!Number.isInteger(n) || n < 0 || n > 1000) throw new BadRequest('Invalid frame.'); return n; };
    const debugMask = (t: string) => maskSecrets(t, opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : []);
    app.get('/api/runs/:id/debug/scopes', async (req) => {
        const scopes = await runner.debugScopes((req.params as { id: string }).id, frameParam((req.query as Record<string, string>).frame));
        return { scopes: scopes.map((sc) => ({ ...sc, variables: sc.variables.map((v) => ({ ...v, value: debugMask(v.value) })) })) };
    });
    app.get('/api/runs/:id/debug/properties', async (req) => {
        const objectId = str((req.query as Record<string, string>).objectId, 'objectId', { max: 200 });
        const vars = await runner.debugProperties((req.params as { id: string }).id, objectId);
        return { variables: vars.map((v) => ({ ...v, value: debugMask(v.value) })) };
    });
    app.post('/api/runs/:id/debug/evaluate', async (req) => {
        const b = body(req);
        const v = await runner.debugEvaluate((req.params as { id: string }).id, str(b.expression, 'expression', { max: 2000 }), frameParam(b.frame), { noSideEffects: b.hover === true });
        return { ...v, value: debugMask(v.value) };
    });
    /**
     * A debug run's pauses as they happen (newline-delimited JSON): each one at once, a code pause with the
     * variables of its top frame (one message: the editor line and the variables change together), and when it
     * runs on. Ends with the run.
     */
    app.get('/api/runs/:id/debug/stream', (req, reply) => {
        const id = (req.params as { id: string }).id;
        const r = runner.get(id);
        if (!r) { void reply.code(404).send({ error: 'Unknown run.' }); return; }
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        let open = true;
        const write = (o: unknown) => { if (open) res.write(JSON.stringify(o) + '\n'); };
        const state = async () => {
            const run = runner.get(id);
            if (!run || run.state !== 'running') return;
            const code = run.codePaused ?? null;
            let scopes: Awaited<ReturnType<typeof runner.debugScopes>> | undefined;
            if (code) {
                scopes = await runner.debugScopes(id, 0).catch(() => undefined);
                // Paused again (or run on) meanwhile: that newer state is sent instead.
                if (runner.get(id)?.codePaused?.seq !== code.seq) return;
            }
            write({
                type: 'state',
                paused: run.paused ? { ...run.paused, step: debugMask(run.paused.step), ...(run.paused.error ? { error: debugMask(run.paused.error) } : {}) } : null,
                codePaused: code ? { ...code, ...(code.exception ? { exception: debugMask(code.exception) } : {}) } : null,
                ...(scopes ? { scopes: scopes.map((sc) => ({ ...sc, variables: sc.variables.map((v) => ({ ...v, value: debugMask(v.value) })) })) } : {}),
            });
        };
        const onDebug = () => { void state(); };
        const onEnd = () => { write({ type: 'end' }); cleanup(); res.end(); };
        const cleanup = () => { open = false; runner.off(`debug:${id}`, onDebug); runner.off(`end:${id}`, onEnd); };
        if (r.state !== 'running') { write({ type: 'end' }); res.end(); return; }
        runner.on(`debug:${id}`, onDebug);
        runner.on(`end:${id}`, onEnd);
        req.raw.on('close', cleanup);
        void state();
    });
    app.post('/api/runs/:id/stop', async (req) => { const id = (req.params as { id: string }).id; runner.stop(id); return { ok: true }; });
    app.get('/api/runs/:id', async (req) => {
        const id = (req.params as { id: string }).id;
        const r = runner.get(id);
        if (!r) throw new BadRequest('Unknown run.');
        return { ...r, reportKey: runner.reportKey(id), reportIndex: reportIndexOf(r), log: runner.log(id, Number((req.query as Record<string, string>).from) || 0) };
    });

    // ---- A finished run's results published to Azure DevOps Test Plans. Only this run's results are sent.
    // Two ways to choose where: the scenarios' tags (@TestCaseId and @TestPlanId / @TestSuiteId, else the
    // feature's, else ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID, as the framework does), or a plan and suite chosen
    // here with the run's scenario(s) picked for each of its test cases. Either way the person ticks the test
    // cases and test points; one scenario can give the result of several test cases.
    const publishContext = (id: string, adoProject: unknown) => {
        const r = runner.get(id);
        if (!r) throw new BadRequest('Unknown run.');
        if (r.state === 'running' || !r.summary) throw new BadRequest('The run has no results yet.');
        const { tp, ado, project, env } = testPlansFor({ project: r.request.project, env: r.request.env, ...(typeof adoProject === 'string' && adoProject ? { adoProject } : {}) });
        const pub = adoPublishing(project, env);
        let configured = '';
        try { configured = adoSettingsFor(opts.repoRoot, opts.store, projectId, project, env, process.env, personal()).project; } catch { /* shown by the call that fails */ }
        // The run's own feature files first, then its project's folder (a feature copied elsewhere has the same names).
        const runFiles = new Set((r.request.features ?? []).map((f) => f.replace(/\\/g, '/')));
        const prefer = (file: string) => (runFiles.has(file) || [...runFiles].some((f) => f.endsWith('/') && file.startsWith(f)) ? 2 : file.startsWith(`test/${project}/`) ? 1 : 0);
        const scenarios = runScenarios(r.summary.scenarios, pub.targets, prefer);
        // The run's evidence (screenshots, videos, logs…) of each scenario, attached as the framework does.
        let ev: ReturnType<typeof readEvidence> | null = null;
        try { ev = r.summary.reportDir ? readEvidence(runner.base(r), r.summary.reportDir, { features: indexFeatures(runner.base(r)), ran: r.request.features }) : null; } catch { ev = null; }
        const evidence = ev ? evidenceFor(scenarios, ev.scenarios, pub.upload, ev.run) : new Map<string, Array<{ kind: string; file: string; name: string; size: number }>>();
        return { r, tp, ado, project, env, pub, configured, scenarios, ev, evidence };
    };
    /** Suites of a plan by id, each with its path ("Root › Login › Smoke"). */
    const suitePaths = async (tp: TestPlans, plan: number) => {
        const list = await tp.suites(plan);
        const by = new Map(list.map((x) => [x.id, x]));
        const pathOf = (sid: number): string => { const x = by.get(sid); if (!x) return String(sid); const up = x.parent && by.has(x.parent) ? pathOf(x.parent) : ''; return up ? `${up} › ${x.name}` : x.name; };
        return new Map(list.map((x) => [x.id, pathOf(x.id)]));
    };
    const pointView = (p: TestPoint) => ({ id: p.id, configuration: p.configuration, ...(p.tester ? { tester: p.tester } : {}) });
    app.post('/api/runs/:id/publish-ado/preview', async (req) => {
        const b = body(req);
        const c = publishContext((req.params as { id: string }).id, b.adoProject);
        // A plan and one or more of its suites chosen here (else the scenarios' tags decide).
        const chosenSuites = [...new Set([...(Array.isArray(b.suites) ? b.suites : []), ...(b.suite ? [b.suite] : [])].map((x) => posInt(x, 'suite')))].slice(0, 50);
        const chosen = b.plan || chosenSuites.length ? { plan: posInt(b.plan, 'plan'), suites: chosenSuites } : null;
        if (chosen && !chosen.suites.length) throw new BadRequest('Choose at least one suite.');
        const planNames = new Map<number, string>();
        try { for (const p of await c.tp.plans(true)) planNames.set(p.id, p.name); } catch (e) { throw new BadRequest((e as Error).message); }
        type Case = { testCase: number; title: string; inSuite: boolean; points: ReturnType<typeof pointView>[]; scenarios: string[] };
        type Group = { plan: number; planName?: string; suite: number; suiteName?: string; from: string[]; cases: Case[]; error?: string };
        const groups: Group[] = [];
        const notLinked: string[] = [], noPlan: string[] = [];
        const suiteNames = new Map<number, Map<number, string>>();
        const nameOfSuite = async (plan: number, suite: number) => {
            if (!suiteNames.has(plan)) { try { suiteNames.set(plan, await suitePaths(c.tp, plan)); } catch { suiteNames.set(plan, new Map()); } }
            return suiteNames.get(plan)!.get(suite);
        };
        const fill = async (g: Group, ids: number[] | null, scenariosOf: (tc: number) => string[]) => {
            let points: TestPoint[] = [];
            // Every point (Azure DevOps marks a point inactive once it has a result: it can still take a new one, as in the framework).
            try { points = await c.tp.points(g.plan, g.suite); }
            catch (e) { g.error = (e as Error).message; }
            const inSuite = new Map<number, TestPoint[]>();
            for (const p of points) inSuite.set(p.testCase, [...(inSuite.get(p.testCase) ?? []), p]);
            const list = ids ?? [...inSuite.keys()];
            const missing = list.filter((tc) => !inSuite.has(tc));
            const titles = missing.length ? await c.tp.testCases(missing).catch(() => new Map<number, { title?: string }>()) : new Map<number, { title?: string }>();
            g.cases = list.map((tc) => ({ testCase: tc, title: inSuite.get(tc)?.[0]?.title || titles.get(tc)?.title || '', inSuite: inSuite.has(tc), points: (inSuite.get(tc) ?? []).map(pointView), scenarios: scenariosOf(tc) }));
            g.planName = planNames.get(g.plan); g.suiteName = await nameOfSuite(g.plan, g.suite);
        };
        if (chosen) {
            if (!planNames.has(chosen.plan)) throw new BadRequest(`Test plan ${chosen.plan} is not in ${c.ado.projectName}.`);
            for (const suite of chosen.suites) {
                const g: Group = { plan: chosen.plan, suite, from: ['chosen'], cases: [] };
                // Each test case of the suite, with the run's scenarios tagged with it (whatever plan their tags name).
                await fill(g, null, (tc) => c.scenarios.filter((s) => s.testCases.includes(tc)).map((s) => s.key));
                groups.push(g);
            }
            for (const s of c.scenarios) if (!s.testCases.length) notLinked.push(s.key);
        } else {
            const by = new Map<string, Group & { ids: Set<number> }>();
            for (const s of c.scenarios) {
                if (!s.testCases.length) { notLinked.push(s.key); continue; }
                if (!s.plan || !s.suite) { noPlan.push(s.key); continue; }
                const k = `${s.plan}/${s.suite}`;
                if (!by.has(k)) by.set(k, { plan: s.plan, suite: s.suite, from: [], cases: [], ids: new Set() });
                const g = by.get(k)!;
                const from = s.planFrom === s.suiteFrom ? `${s.planFrom}` : `${s.planFrom}/${s.suiteFrom}`;
                if (!g.from.includes(from)) g.from.push(from);
                for (const tc of s.testCases) g.ids.add(tc);
            }
            for (const g of by.values()) {
                await fill(g, [...g.ids], (tc) => c.scenarios.filter((s) => s.plan === g.plan && s.suite === g.suite && s.testCases.includes(tc)).map((s) => s.key));
                const { ids, ...rest } = g; void ids;
                groups.push(rest);
            }
        }
        return {
            ado: { org: c.ado.orgUrl, project: c.ado.projectName, configured: c.configured, from: { project: c.project, env: c.env } },
            run: { id: c.r.id, name: `${c.project} ${c.env} – Studio run ${c.r.id}${c.r.commit ? ` @ ${c.r.commit.slice(0, 8)}${c.r.dirty ? '+changes' : ''}` : ''}` },
            scenarios: c.scenarios, groups, notLinked, noPlan,
            upload: c.pub.upload,
            // What each scenario would attach: kind → count.
            evidence: Object.fromEntries([...c.evidence].map(([k, files]) => [k, files.reduce<Record<string, number>>((m, f) => ({ ...m, [f.kind]: (m[f.kind] ?? 0) + 1 }), {})])),
            resultsZip: !!c.ev,
        };
    });
    app.post('/api/runs/:id/publish-ado', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm publishing to Azure DevOps.');
        const c = publishContext((req.params as { id: string }).id, b.adoProject);
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 2000).map((x) => {
            const it = (x ?? {}) as Record<string, unknown>;
            const points = (Array.isArray(it.points) ? it.points : []).map((p) => posInt(p, 'test point'));
            const keys = (Array.isArray(it.scenarios) ? it.scenarios : []).map((k) => String(k));
            return { plan: posInt(it.plan, 'plan'), suite: posInt(it.suite, 'suite'), testCase: posInt(it.testCase, 'test case'), points, keys };
        }).filter((x) => x.points.length);
        if (!items.length) throw new BadRequest('Tick at least one test point.');
        const byKey = new Map(c.scenarios.map((s) => [s.key, s]));
        for (const it of items) {
            if (!it.keys.length) throw new BadRequest(`Choose the scenario whose result goes to test case ${it.testCase}.`);
            for (const k of it.keys) if (!byKey.has(k)) throw new BadRequest(`"${k}" is not a scenario of this run.`);
        }
        const name = (typeof b.runName === 'string' && b.runName.trim() ? b.runName.trim() : `${c.project} ${c.env} – Studio run ${c.r.id}${c.r.commit ? ` @ ${c.r.commit.slice(0, 8)}${c.r.dirty ? '+changes' : ''}` : ''}`).slice(0, 250);
        // Every ticked point belongs to its suite and test case (checked before anything is written).
        const bySuite = new Map<string, typeof items>();
        for (const it of items) bySuite.set(`${it.plan}/${it.suite}`, [...(bySuite.get(`${it.plan}/${it.suite}`) ?? []), it]);
        for (const list of bySuite.values()) {
            const { plan, suite } = list[0];
            const pts = await c.tp.points(plan, suite);
            for (const it of list) for (const p of it.points) {
                const found = pts.find((x) => x.id === p);
                if (!found || found.testCase !== it.testCase) throw new BadRequest(`Test point ${p} is not a point of test case ${it.testCase} in suite ${suite} of plan ${plan}.`);
            }
        }
        // One test run per test plan, as the framework does: suites of the same plan share it.
        const byPlan = new Map<number, typeof items>();
        for (const it of items) byPlan.set(it.plan, [...(byPlan.get(it.plan) ?? []), it]);
        const attach = b.attachEvidence !== false && c.pub.upload.attachments;
        const attachZip = b.attachResults !== false;
        // The zipped results folder for each test run (as the framework attaches it): an existing zip, else made here.
        let resultsZip: { name: string; data: Buffer } | null = null;
        let zipNote: string | undefined;
        if (attachZip && c.ev) {
            const root = path.join(runner.base(c.r), c.ev.resultsRoot);
            const max = c.pub.upload.maxMb * 1024 * 1024;
            try {
                if (fs.existsSync(`${root}.zip`) && fs.statSync(`${root}.zip`).size <= max) resultsZip = { name: path.basename(`${root}.zip`), data: fs.readFileSync(`${root}.zip`) };
                else {
                    const entries: Array<{ name: string; data: Buffer }> = [];
                    let total = 0;
                    const walk = (dir: string) => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, d.name); if (d.isDirectory()) walk(f); else if (d.isFile()) { total += fs.statSync(f).size; if (total > max) throw new Error('too big'); entries.push({ name: path.relative(root, f).split(path.sep).join('/'), data: fs.readFileSync(f) }); } } };
                    walk(root);
                    resultsZip = { name: `${path.basename(root)}.zip`, data: zip(entries) };
                }
            } catch (e) { zipNote = (e as Error).message === 'too big' ? `The results are larger than ADO_ATTACHMENT_MAX_MB (${c.pub.upload.maxMb} MB): not attached to the test run.` : `The results could not be zipped: ${(e as Error).message}`; }
        }
        const published: Array<{ plan: number; suites: number[]; runId: number; url: string; published: number; testCases: number; attached: number; attachFailed: string[]; resultsAttached: boolean }> = [];
        for (const [plan, list] of byPlan) {
            const suites = [...new Set(list.map((it) => it.suite))];
            const entries = list.map((it) => entryFor(it.testCase, it.points, it.keys.map((k) => byKey.get(k)!)));
            // Evidence: each result gets the files of the scenario(s) that gave its outcome; the test run gets the
            // zipped results. A failed upload is reported; the results stay published.
            let attached = 0, resultsAttached = false;
            const attachFailed: string[] = [];
            const attachAll = async (runId: number, results: Array<{ testCase: number; resultId: number }>) => {
                if (attach && c.ev) {
                    const root = path.join(runner.base(c.r), c.ev.resultsRoot);
                    for (const it of list) {
                        const files = [...new Map(it.keys.flatMap((k) => c.evidence.get(k) ?? []).map((f) => [f.file, f])).values()];
                        const ids = results.filter((x) => x.testCase === it.testCase).map((x) => x.resultId);
                        for (const f of files) {
                            let data: Buffer;
                            try { data = fs.readFileSync(path.join(root, f.file)); } catch { attachFailed.push(`${f.name} (not found)`); continue; }
                            for (const id of ids) {
                                try { await c.tp.attachToResult(runId, id, f.name, data, attachmentTypeOf(f.kind)); attached++; }
                                catch (e) { attachFailed.push(`${f.name}: ${(e as Error).message.slice(0, 160)}`); }
                            }
                        }
                    }
                }
                if (resultsZip) {
                    try { await c.tp.attachToRun(runId, resultsZip.name, resultsZip.data); resultsAttached = true; }
                    catch (e) { attachFailed.push(`${resultsZip.name}: ${(e as Error).message.slice(0, 160)}`); }
                }
            };
            let done: Awaited<ReturnType<TestPlans['publishTo']>>;
            try { done = await c.tp.publishTo(plan, name, entries, `Published from CS Test Studio by ${opts.userName}${c.r.dirty ? ' (the working copy had changes not committed)' : ''}.`, attachAll); }
            catch (e) { throw new BadRequest(`Plan ${plan}: ${(e as Error).message}${published.length ? ` (already published: ${published.map((x) => `test run ${x.runId}`).join(', ')})` : ''}`); }
            const { results: _r, ...rest } = done; void _r;
            published.push({ plan, suites, testCases: new Set(list.map((it) => it.testCase)).size, ...rest, attached, attachFailed: [...new Set(attachFailed)], resultsAttached });
        }
        log('ado.publish', `Published run ${c.r.id} to Azure DevOps ${c.ado.projectName}: ${published.map((x) => `run ${x.runId} (plan ${x.plan}, suite ${x.suites.join(', ')}, ${x.published} results)`).join('; ')}`, { id: c.r.id });
        // Optionally the mapping goes back into the feature files: each scenario gets the test cases it was
        // published to (with those it already had), and the plan and suite when its tags would send it elsewhere.
        const tagged: Array<{ file: string; line: number; name: string; tags: string[] }> = [];
        const notTagged: Array<{ scenario: string; reason: string }> = [];
        const skip = (scenario: string, reason: string) => { if (!notTagged.some((x) => x.scenario === scenario)) notTagged.push({ scenario, reason }); };
        if (b.writeTags === true) {
            const per = new Map<string, { s: (typeof c.scenarios)[number]; ids: Set<number>; targets: Set<string> }>();
            for (const it of items) for (const k of it.keys) {
                const s = byKey.get(k)!;
                if (!s.file || !s.line) { skip(`${s.feature}: ${s.name}`, 'not found in the feature files'); continue; }
                if (!per.has(k)) per.set(k, { s, ids: new Set(s.testCases), targets: new Set() });
                per.get(k)!.ids.add(it.testCase); per.get(k)!.targets.add(`${it.plan}/${it.suite}`);
            }
            const byFile = new Map<string, Array<{ s: (typeof c.scenarios)[number]; ids: Set<number>; targets: Set<string> }>>();
            for (const v of per.values()) byFile.set(v.s.file!, [...(byFile.get(v.s.file!) ?? []), v]);
            for (const [file, list] of byFile) {
                let cur = ws.read(file);
                if (cur.binary) continue;
                let text = cur.content;
                // Bottom up: a tag line added above one scenario does not move the ones above it.
                for (const v of list.sort((a, b2) => b2.s.line! - a.s.line!)) {
                    const label = `${v.s.feature}: ${v.s.name}`;
                    const d = tagsForMapping(v.s, v.ids, v.targets);
                    if ('skip' in d) { skip(label, d.skip); continue; }
                    const tags = d.tags;
                    if (!tags.length) continue;
                    try { text = withScenarioTags(text, v.s.line!, v.s.name, tags); tagged.push({ file, line: v.s.line!, name: v.s.name, tags }); }
                    catch (e) { skip(label, (e as Error).message); }
                }
                if (text !== cur.content) { ws.write(file, text, cur.hash); cur = ws.read(file); }
            }
            if (tagged.length) log('ado.publish.tags', `Tagged ${tagged.length} scenario(s) with their Azure DevOps test cases`, { files: [...new Set(tagged.map((t) => t.file))].join(', ') });
        }
        return { published, tagged, notTagged, ...(zipNote ? { zipNote } : {}) };
    });

    // ---- Quality: results across runs, classification, failure groups, quarantine, gate
    const qualityFile = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'quality.json');
    type QualityNotes = Record<string, { at: string; reason: string }>;
    const readQualityState = (): { gate: GateSettings; notes: QualityNotes } => {
        let notes: QualityNotes = {};
        try { const j = JSON.parse(fs.readFileSync(qualityFile, 'utf8')) as { notes?: QualityNotes }; if (j.notes && typeof j.notes === 'object') notes = j.notes; } catch { /* none yet */ }
        return { gate: readGate(qualityFile), notes };
    };
    const writeQualityState = (st: { gate: GateSettings; notes: QualityNotes }) => {
        fs.mkdirSync(path.dirname(qualityFile), { recursive: true });
        fs.writeFileSync(qualityFile, JSON.stringify({ ...st.gate, notes: st.notes }, null, 1));
    };
    /** Whether runs leave quarantined scenarios out: EXCLUDE_TAGS in the configuration, and a framework that reads it. */
    const quarantineSetup = (project?: string, env?: string) => {
        let excludeTags = '', from = '';
        try {
            const p = project ?? discover(opts.repoRoot).projects[0];
            if (p) {
                const e = resolveFor(p, env ?? 'dev').entries.find((x) => x.key === 'EXCLUDE_TAGS');
                if (e) { excludeTags = e.value; from = e.from.source; }
            }
        } catch { /* no configuration */ }
        let supported: boolean | null = null;
        try {
            const pkg = frameworkPackage(opts.repoRoot);
            const runnerJs = pkg && path.join(pkg.dir, 'dist', 'bdd', 'CSBDDRunner.js');
            if (runnerJs && fs.existsSync(runnerJs)) supported = fs.readFileSync(runnerJs, 'utf8').includes('EXCLUDE_TAGS');
        } catch { /* unknown */ }
        return { excludeTags, from, skipsQuarantined: excludeTags.split(',').map((t) => t.trim()).some(isQuarantineTag), frameworkSupports: supported };
    };
    /** Finished runs with results (the Studio's and report folders on disk), oldest first, and the project asked for. */
    const qualityRuns = (q: Record<string, string>) => {
        const catalog = readCatalog(opts.repoRoot);
        const featureProject = new Map<string, string>();
        for (const f of catalog) { const m = /^test\/([^/]+)\//.exec(f.path); if (m && !featureProject.has(f.name)) featureProject.set(f.name, m[1]); }
        const runs = collectRuns(runner.list().filter((r) => r.state !== 'running'), allReportFiles(opts.repoRoot, runner.reportDirs), opts.repoRoot, (n) => featureProject.get(n));
        // One project at a time (the latest run's unless one is chosen); "all" mixes them.
        const project = q.project === 'all' ? undefined : q.project ? configProjectParam(q.project) : runs[runs.length - 1]?.run.project;
        return { catalog, runs, project, projects: [...new Set(runs.map((r) => r.run.project).filter((p): p is string => !!p))].sort() };
    };
    app.get('/api/quality', async (req) => {
        const q = req.query as Record<string, string>;
        const window = Math.min(200, Math.max(2, Number(q.window) || 30));
        const st = readQualityState();
        const { catalog, runs, project } = qualityRuns(q);
        const report = buildQuality({ runs, catalog, window, project, gate: st.gate });
        const triage = readTriage(opts.repoRoot);
        const secrets = opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : [];
        const mask = (t?: string) => (t === undefined ? t : maskSecrets(t, secrets));
        const latest = report.runs[report.runs.length - 1];
        return {
            ...report,
            scenarios: report.scenarios.map((s) => ({ ...s, note: s.quarantined ? st.notes[s.key] : undefined, results: s.results.map((r) => ({ ...r, error: mask(r.error) })) })),
            // Each cause with its tag (as the framework tags its bugs) and what the team decided about it.
            groups: report.groups.map((g) => { const tag = signatureTag(g.signature); return { ...g, sample: mask(g.sample)!, signature: mask(g.signature)!, tag, ...(triage[tag] ? { triage: triage[tag] } : {}) }; }),
            projects: [...new Set(runs.map((r) => r.run.project).filter((p): p is string => !!p))].sort(),
            project: project ?? null,
            settings: st.gate,
            settingsVersion: contentVersion(st.gate),
            quarantine: quarantineSetup(project ?? latest?.project, latest?.env),
        };
    });
    app.put('/api/quality/gate', async (req) => {
        const b = body(req);
        // Whole numbers only: 12.5 is refused (not rounded), so what is saved is what was typed.
        const n = (v: unknown, lo: number, hi: number, what: string) => { const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; if (typeof x !== 'number' || !Number.isInteger(x) || x < lo || x > hi) throw new BadRequest(`${what}: give a whole number from ${lo} to ${hi}.`); return x; };
        const gate: GateSettings = {
            minPassRate: b.minPassRate === undefined ? DEFAULT_GATE.minPassRate : n(b.minPassRate, 0, 100, 'The pass rate'),
            noNewFailures: b.noNewFailures !== false,
            maxFlaky: b.maxFlaky === null || b.maxFlaky === undefined || b.maxFlaky === '' ? null : n(b.maxFlaky, 0, 100000, 'The most flaky scenarios'),
            ignoreQuarantined: b.ignoreQuarantined !== false,
        };
        const st = readQualityState();
        // The gate this screen was shown: a save over one changed since (another tab) is refused; force = Overwrite.
        checkVersion(b.force === true ? undefined : b.version, contentVersion(st.gate));
        writeQualityState({ ...st, gate });
        log('quality.gate', `Quality gate: pass rate ≥ ${gate.minPassRate}%${gate.noNewFailures ? ', no new failures' : ''}${gate.maxFlaky !== null ? `, at most ${gate.maxFlaky} flaky` : ''}`);
        return { ...gate, version: contentVersion(gate) };
    });
    app.post('/api/quality/quarantine', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 1024 });
        if (!file.endsWith('.feature')) throw new BadRequest('Only feature files can be changed.');
        const line = Number(b.line);
        if (!Number.isInteger(line) || line < 1) throw new BadRequest('"line" is invalid.');
        const name = str(b.name, 'name', { max: 1000 });
        const key = str(b.key, 'key', { max: 2000 });
        const on = b.on === true;
        const reason = on ? str(b.reason, 'reason', { optional: true, max: 500 }) : '';
        const abs = safeRepoPath(opts.repoRoot, file, { write: true });
        let text: string;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { throw new BadRequest('The feature file is not there any more.'); }
        let next: string;
        try { next = setQuarantineTag(text, line, name, on); } catch (e) { throw new BadRequest((e as Error).message); }
        if (next !== text) writeFileInRepo(abs, next);
        const st = readQualityState();
        if (on) st.notes[key] = { at: new Date().toISOString(), reason: reason || '' }; else delete st.notes[key];
        writeQualityState(st);
        log(on ? 'quality.quarantine' : 'quality.release', `${on ? 'Quarantined' : 'Released'} "${name}" (${QUARANTINE_TAG} in ${file})`, { file, reason: reason || null });
        return { ok: true, changed: next !== text };
    });
    // ---- Healed locators: review, update the page object, dismiss
    const healingFile = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'healing.json');
    const readDecisions = (): Record<string, HealDecision> => { try { const j = JSON.parse(fs.readFileSync(healingFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
    const writeDecisions = (d: Record<string, HealDecision>) => { fs.mkdirSync(path.dirname(healingFile), { recursive: true }); fs.writeFileSync(healingFile, JSON.stringify(d, null, 1)); };
    const healGroups = (q: Record<string, string>) => {
        const { runs, project, projects } = qualityRuns(q);
        const mine = runs.filter((r) => !project || r.run.project === project);
        const events: HealEvent[] = [];
        for (const r of mine) { const f = r.run.reportDir && path.join(r.run.reportDir, 'report-data.json'); if (f && fs.existsSync(f)) events.push(...healsInReport(f, r.run)); }
        const later = mine.map((r) => ({ at: r.run.at, scenarios: new Set(r.summary.scenarios.map((s) => s.name)) }));
        const info = new Map(mine.map((r) => [r.run.id, { project: r.run.project, env: r.run.env }]));
        // An applied heal is applied while its page object still has the healed locator.
        const stillApplied = (d: { healed: string; file?: string }) => { if (!d.file) return true; try { const t = fs.readFileSync(safePath(opts.repoRoot, d.file), 'utf8'); const v = healedOption(d.healed).value; return t.includes(v) || t.includes(d.healed); } catch { return false; } };
        return { groups: groupHeals(events, readDecisions(), later, info, stillApplied), project, projects };
    };
    const healGroup = (key: string) => {
        const g = healGroups({ project: 'all' }).groups.find((x) => x.key === key);
        if (!g) throw new BadRequest('That healed element is not in the recent runs any more.');
        return g;
    };
    /** The page object change for a heal: the file, and the decorator before and after. */
    const healChange = (key: string, healed: string) => {
        const g = healGroup(key);
        if (!g.pageClass || !g.property) throw new BadRequest('This run did not record which page object the element is in (an older framework version): change the page object by hand.');
        if (!g.variants.some((v) => v.healed === healed)) throw new BadRequest('That locator was not seen for this element.');
        const ts = require('typescript') as typeof import('typescript');
        for (const file of filesDeclaring(opts.repoRoot, g.pageClass)) {
            const f = ws.read(file);
            if (f.binary) continue;
            const edit = proposeEdit(ts, f.content, g.pageClass, g.property, healed);
            if (edit) return { group: g, file, baseHash: f.hash, edit };
        }
        throw new BadRequest(`@CSGetElement "${g.property}" of class ${g.pageClass} was not found in the repository.`);
    };
    app.get('/api/healing', async (req) => {
        const r = healGroups(req.query as Record<string, string>);
        // Updated page objects: the line (found again for updates made before it was kept) and whether the change
        // is still to commit, or in which commit it went.
        const pending = new Set((await git.status().catch(() => ({ files: [] as Array<{ path: string }> }))).files.map((f) => f.path));
        for (const g of r.groups) {
            const ch = g.change;
            if (!ch) continue;
            if (!ch.line) {
                try {
                    const lines = fs.readFileSync(safePath(opts.repoRoot, ch.file), 'utf8').split(/\r?\n/);
                    const v = healedOption(ch.healed).value;
                    const i = lines.findIndex((l) => l.includes(v) || l.includes(ch.healed));
                    if (i >= 0) ch.line = i + 1;
                } catch { /* the file is gone */ }
            }
            let commit: { sha: string; subject: string; date: string } | undefined;
            if (!pending.has(ch.file)) {
                const lg = await runGit(['log', '-1', `--since=${ch.at}`, '--format=%H%x00%s%x00%aI', '--', ch.file], { cwd: opts.repoRoot, allowFailure: true });
                const [sha, subject, date] = lg.stdout.trim().split('\0');
                if (sha) commit = { sha, subject, date };
            }
            Object.assign(ch, { uncommitted: pending.has(ch.file), ...(commit ? { commit } : {}) });
        }
        const secrets = opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : [];
        const mask = (t: string) => maskSecrets(t, secrets);
        return { ...r, project: r.project ?? null, groups: r.groups.map((g) => ({ ...g, events: g.events.map((e) => ({ ...e, step: mask(e.step) })) })) };
    });
    app.post('/api/healing/preview', async (req) => {
        const b = body(req);
        const c = healChange(str(b.key, 'key', { max: 1000 }), str(b.healed, 'healed', { max: 2000 }));
        return { file: c.file, baseHash: c.baseHash, line: c.edit.line, before: c.edit.before, after: c.edit.after, option: c.edit.option };
    });
    app.post('/api/healing/apply', async (req) => {
        const b = body(req);
        const key = str(b.key, 'key', { max: 1000 }), healed = str(b.healed, 'healed', { max: 2000 });
        const c = healChange(key, healed);
        if (typeof b.baseHash === 'string' && b.baseHash !== c.baseHash) throw new BadRequest(`${c.file} changed since the preview: look at the change again.`);
        ws.write(c.file, c.edit.text, c.baseHash);
        const d = readDecisions();
        d[key] = { healed, action: 'applied', at: new Date().toISOString(), file: c.file, line: c.edit.line, before: c.edit.before, after: c.edit.after };
        writeDecisions(d);
        log('healing.apply', `Updated ${c.group.pageClass}.${c.group.property} in ${c.file}: ${c.edit.option.key} ${c.edit.option.value}`, { file: c.file });
        return { ok: true, file: c.file, line: c.edit.line };
    });
    app.post('/api/healing/dismiss', async (req) => {
        const b = body(req);
        const key = str(b.key, 'key', { max: 1000 });
        const d = readDecisions();
        if (b.undo === true) delete d[key];
        else { const g = healGroup(key); d[key] = { healed: str(b.healed, 'healed', { optional: true, max: 2000 }) || g.healed, action: 'dismissed', at: new Date().toISOString() }; }
        writeDecisions(d);
        log(b.undo === true ? 'healing.undo' : 'healing.dismiss', `${b.undo === true ? 'Back to review' : 'Dismissed the heal of'} ${key}`);
        return { ok: true };
    });

    // ---- Triage memory: verdict, note and bug of a cause of failure (.cs-studio/triage.json, committed)
    const tagParam = (v: unknown) => { const t = str(v, 'tag', { max: 40 }); if (!/^cs-failure-[0-9a-f]{12}$/.test(t)) throw new BadRequest('Invalid failure tag.'); return t; };
    const triageMask = (t: string) => maskSecrets(t, opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : []);
    app.get('/api/triage', async () => ({ entries: readTriage(opts.repoRoot) }));
    /** The triage of failures by their messages (a run's failed scenarios): the entry of each one's cause, or null. */
    app.post('/api/triage/match', async (req) => {
        const b = body(req);
        const errors = (Array.isArray(b.errors) ? b.errors : []).slice(0, 500).map((e: unknown) => (typeof e === 'string' ? e.slice(0, 20000) : ''));
        const all = readTriage(opts.repoRoot);
        return { matches: errors.map((e: string) => (e ? all[signatureTag(failureSignature(e))] ?? null : null)) };
    });
    app.put('/api/triage', async (req) => {
        const b = body(req);
        const tag = tagParam(b.tag);
        const verdict = b.verdict === undefined || b.verdict === null || b.verdict === '' ? undefined : str(b.verdict, 'verdict', { max: 20 }) as TriageVerdict;
        if (verdict && !VERDICTS.includes(verdict)) throw new BadRequest('Unknown verdict.');
        const bug = b.bug === undefined || b.bug === null || b.bug === '' ? undefined : Number(b.bug);
        if (bug !== undefined && (!Number.isInteger(bug) || bug <= 0 || bug > 99_999_999)) throw new BadRequest('Invalid bug id.');
        const note = typeof b.note === 'string' && b.note.trim() ? triageMask(b.note.trim().slice(0, 2000)) : undefined;
        const all = writeTriage(opts.repoRoot, tag, { signature: triageMask(str(b.signature, 'signature', { max: 400 })), ...(verdict ? { verdict } : {}), ...(note ? { note } : {}), ...(bug ? { bug } : {}), by: opts.userName ?? 'unknown' });
        log('triage.set', all[tag] ? `Triage of a failure cause: ${verdict ?? 'no verdict'}${bug ? `, bug ${bug}` : ''}` : 'Triage of a failure cause removed', { file: '.cs-studio/triage.json' });
        return { entry: all[tag] ?? null };
    });
    /**
     * The bugs of these causes of failure: the ones named in the triage (by id), and the ones carrying a cause's tag
     * (filed by the framework or here), with their state.
     */
    app.post('/api/triage/bugs', async (req) => {
        const b = body(req);
        // Azure DevOps not set up (no address or token): no bugs to show, not an error (the Quality screen asks on every visit).
        let t: ReturnType<typeof adoTarget>, ado: ReturnType<typeof adoClient>;
        try { t = adoTarget({ ...(b.project ? { project: String(b.project) } : {}), ...(b.env ? { env: String(b.env) } : {}) }); ado = adoClient(t.project, t.env); }
        catch (e) { return { bugs: [], unavailable: (e as Error).message }; }
        const tags = (Array.isArray(b.tags) ? b.tags : []).map(tagParam).slice(0, 60);
        const named = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 200);
        let tagged: number[] = [];
        try { if (tags.length) tagged = (await ado.post<{ workItems: Array<{ id: number }> }>('wit/wiql?$top=200', { query: bugsForTagsQuery(tags) })).workItems.map((w) => w.id); }
        catch (e) { if (/access token|ADO_PAT|not set up|organization/i.test((e as Error).message)) return { bugs: [], unavailable: (e as Error).message }; throw e; }
        const ids = [...new Set([...named, ...tagged])];
        if (!ids.length) return { bugs: [] };
        const fields = ['System.Id', 'System.Title', 'System.State', 'System.Tags', 'System.ChangedDate', 'Microsoft.VSTS.Common.ResolvedDate', 'System.WorkItemType'];
        // Azure DevOps reads at most 200 work items a request.
        const r: { value: Array<{ id: number; fields: Record<string, unknown> } | null> } = { value: [] };
        for (let i = 0; i < ids.length; i += 200) r.value.push(...(await ado.get<typeof r>(`wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=${fields.join(',')}&errorPolicy=omit`)).value);
        const web = (rel: string) => `${ado.orgUrl}/${encodeURIComponent(ado.projectName)}/${rel}`;
        return {
            bugs: r.value.filter((w): w is { id: number; fields: Record<string, unknown> } => !!w).map((w) => ({
                id: w.id, title: triageMask(String(w.fields['System.Title'] ?? '')), state: String(w.fields['System.State'] ?? ''), type: String(w.fields['System.WorkItemType'] ?? ''),
                tags: String(w.fields['System.Tags'] ?? '').split(';').map((x) => x.trim()).filter((x) => /^cs-failure-[0-9a-f]{12}$/.test(x)),
                changed: String(w.fields['System.ChangedDate'] ?? ''), ...(w.fields['Microsoft.VSTS.Common.ResolvedDate'] ? { resolved: String(w.fields['Microsoft.VSTS.Common.ResolvedDate']) } : {}),
                url: web(`_workitems/edit/${w.id}`),
            })),
        };
    });
    /**
     * Bug lifecycle: what to do with each cause's bug now (file / comment / reopen / resolve), from the recent runs.
     * Nothing changes until /apply with the actions the person chose.
     */
    const bugsOf = async (ado: ReturnType<typeof adoClient>, tags: string[], named: number[]): Promise<BugInfo[]> => {
        let tagged: number[] = [];
        for (let i = 0; i < tags.length; i += 60) tagged.push(...(await ado.post<{ workItems: Array<{ id: number }> }>('wit/wiql?$top=200', { query: bugsForTagsQuery(tags.slice(i, i + 60)) })).workItems.map((w) => w.id));
        const ids = [...new Set([...named, ...tagged])];
        const out: BugInfo[] = [];
        for (let i = 0; i < ids.length; i += 200) {
            const r = await ado.get<{ value: Array<{ id: number; fields: Record<string, unknown> } | null> }>(`wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=System.Id,System.Title,System.State,System.Tags,System.ChangedDate&errorPolicy=omit`);
            for (const w of r.value) if (w) out.push({ id: w.id, title: String(w.fields['System.Title'] ?? ''), state: String(w.fields['System.State'] ?? ''), changed: String(w.fields['System.ChangedDate'] ?? ''),
                tags: String(w.fields['System.Tags'] ?? '').split(';').map((x) => x.trim()).filter((x) => /^cs-failure-[0-9a-f]{12}$/.test(x)), url: `${ado.orgUrl}/${encodeURIComponent(ado.projectName)}/_workitems/edit/${w.id}` });
        }
        return out;
    };
    const bugStates = async (ado: ReturnType<typeof adoClient>) => stateCategories((await ado.get<{ value: Array<{ name: string; category: string }> }>('wit/workitemtypes/Bug/states')).value);
    app.post('/api/triage/bugs/plan', async (req) => {
        const b = body(req);
        const t = adoTarget({ ...(b.project ? { project: String(b.project) } : {}), ...(b.env ? { env: String(b.env) } : {}) });
        const ado = adoClient(t.project, t.env);
        const { catalog, runs, project } = qualityRuns({ project: typeof b.qualityProject === 'string' ? b.qualityProject : 'all' });
        const report = buildQuality({ runs, catalog, window: 200, project, gate: readQualityState().gate });
        const triage = readTriage(opts.repoRoot);
        const tags = report.groups.map((g) => signatureTag(g.signature));
        const named = Object.values(triage).map((e) => e.bug).filter((x): x is number => !!x);
        const [bugs, states] = await Promise.all([tags.length || named.length ? bugsOf(ado, tags, named) : Promise.resolve([]), bugStates(ado)]);
        const passesNeeded = Math.max(1, Math.min(Number(b.passesNeeded) || 3, 20));
        const actions = planBugActions({ groups: report.groups, scenarios: report.scenarios, triage, bugs, states, passesNeeded }).map((a) => ('title' in a ? { ...a, title: triageMask(a.title) } : a));
        return { actions: actions.map((a) => ({ ...a, why: triageMask(a.why), ...('comment' in a ? { comment: triageMask(a.comment) } : {}) })), bugs: bugs.map((x) => ({ ...x, title: triageMask(x.title) })), states: { reopen: states.reopen, resolve: states.resolve } };
    });
    app.post('/api/triage/bugs/apply', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm the changes to the bugs.');
        const t = adoTarget({ ...(b.project ? { project: String(b.project) } : {}), ...(b.env ? { env: String(b.env) } : {}) });
        const ado = adoClient(t.project, t.env);
        const list = (Array.isArray(b.actions) ? b.actions : []).slice(0, 100) as Array<Record<string, unknown>>;
        const results: Array<{ kind: string; bug?: number; ok: boolean; error?: string }> = [];
        const comment = (id: number, html: string) => ado.post(`wit/workItems/${id}/comments?api-version=7.1-preview.4`, { text: triageMask(html.slice(0, 8000)) }, 'project', 'Work Items (Read & write)');
        for (const a of list) {
            const kind = String(a.kind);
            try {
                if (kind === 'file') {
                    const tag = tagParam(a.tag);
                    const { catalog, runs, project } = qualityRuns({ project: 'all' });
                    const g = buildQuality({ runs, catalog, window: 200, project, gate: readQualityState().gate }).groups.find((x) => signatureTag(x.signature) === tag);
                    if (!g) throw new Error('That cause of failure is not in the recent runs any more.');
                    const created = await ado.jsonPatch<{ id: number }>('POST', 'wit/workitems/$Bug', [
                        { op: 'add', path: '/fields/System.Title', value: triageMask(str(a.title, 'title', { max: 255 })) },
                        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: triageMask(bugReproHtml(g)) },
                        { op: 'add', path: '/fields/System.Tags', value: `automation; ${tag}` },
                    ]);
                    const prev = readTriage(opts.repoRoot)[tag];
                    writeTriage(opts.repoRoot, tag, { signature: triageMask(g.signature), verdict: prev?.verdict ?? 'product-bug', ...(prev?.note ? { note: prev.note } : {}), bug: created.id, by: opts.userName ?? 'unknown' });
                    results.push({ kind, bug: created.id, ok: true });
                    continue;
                }
                const id = Number(a.bug);
                if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid bug id.');
                const text = str(a.comment ?? '', 'comment', { max: 10_000 });
                if (kind === 'reopen' || kind === 'resolve') {
                    const to = str(a.to, 'to', { max: 60 });
                    await ado.jsonPatch('PATCH', `wit/workitems/${id}`, [{ op: 'add', path: '/fields/System.State', value: to }]);
                } else if (kind !== 'update') throw new Error(`Unknown action ${kind}.`);
                if (text) await comment(id, text);
                results.push({ kind, bug: id, ok: true });
            } catch (e) { results.push({ kind, ...(a.bug ? { bug: Number(a.bug) } : {}), ok: false, error: (e as Error).message }); }
        }
        log('triage.bugs', `Updated bugs from the test results: ${results.filter((r) => r.ok).map((r) => `${r.kind}${r.bug ? ` ${r.bug}` : ''}`).join(', ') || 'none'}`);
        return { results };
    });
    /** File a bug for a cause of failure (its scenarios, latest message, signature; tagged like the framework's). */
    app.post('/api/triage/bug', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm filing the bug.');
        const tag = tagParam(b.tag);
        const title = triageMask(str(b.title, 'title', { max: 255 }));
        const { catalog, runs, project } = qualityRuns({ project: typeof b.qualityProject === 'string' ? b.qualityProject : 'all' });
        const g = buildQuality({ runs, catalog, window: 200, project, gate: readQualityState().gate }).groups.find((x) => signatureTag(x.signature) === tag);
        if (!g) throw new BadRequest('That cause of failure is not in the recent runs any more.');
        const t = adoTarget({ ...(b.project ? { project: String(b.project) } : {}), ...(b.env ? { env: String(b.env) } : {}) });
        const repro = triageMask(bugReproHtml(g));
        const created = await adoClient(t.project, t.env).jsonPatch<{ id: number }>('POST', 'wit/workitems/$Bug', [
            { op: 'add', path: '/fields/System.Title', value: title },
            { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: repro },
            { op: 'add', path: '/fields/System.Tags', value: `automation; ${tag}` },
        ]);
        const prev = readTriage(opts.repoRoot)[tag];
        writeTriage(opts.repoRoot, tag, { signature: triageMask(g.signature), verdict: prev?.verdict ?? 'product-bug', ...(prev?.note ? { note: prev.note } : {}), bug: created.id, by: opts.userName ?? 'unknown' });
        log('triage.bug', `Filed bug ${created.id} for a failure cause`, { bug: created.id });
        return { id: created.id };
    });

    // ---- Visual and accessibility review: baselines, what the last run saw, approve as the new baseline
    const visualReviewFile = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'visual-review.json');
    const readReview = (): Record<string, ReviewDecision> => { try { const j = JSON.parse(fs.readFileSync(visualReviewFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
    const writeReview = (d: Record<string, ReviewDecision>) => { fs.mkdirSync(path.dirname(visualReviewFile), { recursive: true }); fs.writeFileSync(visualReviewFile, JSON.stringify(d, null, 1)); };
    const visualDirs = () => configuredDirs(opts.repoRoot, 'VISUAL_AI_DIR', 'test/visual-ai');
    const ariaDirs = () => configuredDirs(opts.repoRoot, 'ARIA_SNAPSHOT_DIR', 'test/accessibility/snapshots');
    const reviewMask = (t: string) => maskSecrets(t, opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : []);
    /** A snapshot named by the client: one of the review folders, an existing name. */
    const reviewTarget = (dirs: string[], dir: unknown, name: unknown) => {
        const d = str(dir, 'dir', { max: 500 }), n = str(name, 'name', { max: 300 });
        if (!dirs.includes(d)) throw new BadRequest('Unknown snapshot folder.');
        if (!/^[^/\\]+$/.test(n) || n === '.' || n === '..') throw new BadRequest('Invalid snapshot name.');
        return { dir: d, name: n };
    };
    app.get('/api/visual', async () => {
        const dirs = visualDirs();
        return { dirs, snapshots: visualSnapshots(opts.repoRoot, dirs, readReview()).map((v) => ({
            ...v, ...(v.message ? { message: reviewMask(v.message) } : {}), ...(v.scenario ? { scenario: reviewMask(v.scenario) } : {}), ...(v.feature ? { feature: reviewMask(v.feature) } : {}),
            ariaChanges: v.ariaChanges.map(reviewMask), layoutChanges: v.layoutChanges.map((c) => ({ ...c, element: reviewMask(c.element) })),
        })) };
    });
    app.get('/api/visual/image', async (req, reply) => {
        const p = str((req.query as Record<string, string>).path, 'path', { max: 800 });
        const abs = path.resolve(opts.repoRoot, p);
        const ok = p.endsWith('.png') && visualDirs().some((d) => { const rel = path.relative(path.join(opts.repoRoot, d), abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
        if (!ok || !fs.existsSync(abs)) throw new BadRequest('Unknown image.');
        // The real file must be in the repository too (not a link out of it).
        let real: string;
        try { real = insideRepo(opts.repoRoot, abs); } catch { throw new BadRequest('Unknown image.'); }
        return reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store').send(fs.readFileSync(real));
    });
    app.post('/api/visual/approve', async (req) => {
        const b = body(req);
        const t = reviewTarget(visualDirs(), b.dir, b.name);
        const expected = str(b.actualSha, 'actualSha', { max: 64 });
        let sha: string;
        try { sha = approveVisual(opts.repoRoot, t.dir, t.name, expected); } catch (e) { throw e instanceof StaleReview ? new Conflict(e.message) : new BadRequest((e as Error).message); }
        const d = readReview();
        d[`${t.dir}/${t.name}`] = { action: 'approved', at: new Date().toISOString(), sha };
        writeReview(d);
        log('visual.approve', `Approved the last screenshot of "${t.name}" as its baseline (${t.dir})`, { file: `${t.dir}/baseline/${t.name}.png` });
        return { ok: true };
    });
    app.post('/api/visual/accept', async (req) => {
        const b = body(req);
        const t = reviewTarget(visualDirs(), b.dir, b.name);
        const hashFile = path.join(opts.repoRoot, t.dir, 'baseline', `${t.name}.pixel-hash`);
        if (!fs.existsSync(hashFile)) throw new BadRequest('That snapshot has no baseline.');
        const current = fs.readFileSync(hashFile, 'utf8').trim();
        if (current !== str(b.baselineSha, 'baselineSha', { max: 64 })) throw new Conflict(`A newer run changed the baseline of "${t.name}": look at it again.`);
        const d = readReview();
        d[`${t.dir}/${t.name}`] = { action: 'accepted', at: new Date().toISOString(), sha: current };
        writeReview(d);
        log('visual.accept', `Accepted the new baseline of "${t.name}" (${t.dir})`);
        return { ok: true };
    });
    app.get('/api/accessibility', async (req) => {
        const { runs } = qualityRuns({ ...(req.query as Record<string, string>), project: 'all' });
        const folders = runs.filter((r) => r.run.reportDir).map((r) => ({ folder: path.dirname(r.run.reportDir!), run: r.run.id }));
        const checks = accessibilityChecks(folders).map((c) => ({
            ...c, url: reviewMask(c.url), ...(c.scenario ? { scenario: reviewMask(c.scenario) } : {}), ...(c.feature ? { feature: reviewMask(c.feature) } : {}),
            violations: c.violations.map((v) => ({ ...v, description: reviewMask(v.description), ...(v.element ? { element: reviewMask(v.element) } : {}), ...(v.help ? { help: reviewMask(v.help) } : {}) })),
        }));
        const dirs = ariaDirs();
        return { checks, dirs, snapshots: ariaSnapshots(opts.repoRoot, dirs).map((s) => ({ ...s, ...(s.diff ? { diff: s.diff.map((l) => ({ ...l, text: reviewMask(l.text) })) } : {}) })) };
    });
    app.post('/api/accessibility/approve', async (req) => {
        const b = body(req);
        const t = reviewTarget(ariaDirs(), b.dir, b.name);
        try { approveAria(opts.repoRoot, t.dir, t.name, str(b.actualSha, 'actualSha', { max: 64 })); } catch (e) { throw e instanceof StaleReview ? new Conflict(e.message) : new BadRequest((e as Error).message); }
        log('accessibility.approve', `Approved the last accessibility snapshot of "${t.name}" as its baseline (${t.dir})`, { file: `${t.dir}/${t.name}.yaml` });
        return { ok: true };
    });

    // Leave quarantined scenarios out of every run: EXCLUDE_TAGS in config/global.env (added to any tags already there).
    app.post('/api/quality/exclude-quarantined', async () => {
        const cur = quarantineSetup();
        if (cur.skipsQuarantined) return { ok: true, file: cur.from };
        const file = cur.from && cur.from.endsWith('.env') && !path.isAbsolute(cur.from) ? cur.from : 'config/global.env';
        const value = [...cur.excludeTags.split(',').map((t) => t.trim()).filter(Boolean), QUARANTINE_TAG].join(',');
        setValue(opts.repoRoot, file, 'EXCLUDE_TAGS', value);
        log('quality.exclude', `Set EXCLUDE_TAGS=${value} in ${file}`, { file });
        return { ok: true, file };
    });
    /** Live output as newline-delimited JSON (fetch streaming; EventSource cannot send the token). */
    app.get('/api/runs/:id/stream', (req, reply) => {
        const id = (req.params as { id: string }).id;
        const r = runner.get(id);
        if (!r) { void reply.code(404).send({ error: 'Unknown run.' }); return; }
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
        for (const l of runner.log(id, Number((req.query as Record<string, string>).from) || 0)) send({ type: 'log', ...l });
        if (runner.get(id)!.state !== 'running') { send({ type: 'end', run: { ...runner.get(id), reportKey: runner.reportKey(id), reportIndex: reportIndexOf(runner.get(id)!) } }); res.end(); return; }
        const onLog = (l: unknown) => send({ type: 'log', ...(l as object) });
        const onEnd = () => { send({ type: 'end', run: { ...runner.get(id), reportKey: runner.reportKey(id), reportIndex: reportIndexOf(runner.get(id)!) } }); cleanup(); res.end(); };
        const cleanup = () => { runner.off(`log:${id}`, onLog); runner.off(`end:${id}`, onEnd); };
        runner.on(`log:${id}`, onLog);
        runner.on(`end:${id}`, onEnd);
        req.raw.on('close', cleanup);
    });
    // ---- Pull requests: review, test locally, comment, vote
    /** Pull requests of the configured ADO project, or of another project of the organization (?adoProject=). */
    const prsFor = async (q: Record<string, string>, query?: unknown) => {
        const t = adoTarget(q);
        const base = adoClient(t.project, t.env);
        const ap = q.adoProject ?? (query as Record<string, string> | undefined)?.adoProject;
        const client = ap ? base.forProject(str(ap, 'adoProject', { max: 64 })) : base;
        return { ...t, client, pr: new PullRequests(client, (await myId(q).catch(() => null)) ?? undefined), wi: new WorkItems(client) };
    };
    const prParams = (req: { params: unknown }) => {
        const p = req.params as { repo: string; id: string };
        return { repo: str(p.repo, 'repo', { max: 200 }), id: runIdParam(p.id) };
    };
    const confirmed = (b: Record<string, unknown>, what: string) => { if (b.confirm !== true) throw new BadRequest(`Confirm ${what}.`); };
    const hex = (v: unknown, f: string) => { const x = str(v, f, { max: 64 }); if (!/^[0-9a-f]{7,64}$/i.test(x)) throw new BadRequest(`"${f}" is invalid.`); return x; };
    app.get('/api/ado/prs', async (req) => {
        const q = req.query as Record<string, string>;
        const { pr } = await prsFor(q);
        const scope = (['review', 'mine', 'all'] as const).find((x) => x === q.scope) ?? 'review';
        const status = (['active', 'completed', 'abandoned'] as const).find((x) => x === q.status) ?? 'active';
        const remotesHere = await prRemotes(opts.repoRoot).catch(() => []);
        const top = Math.min(Math.max(Number(q.top) || 50, 1), 200), skip = Math.max(Number(q.skip) || 0, 0);
        const prs = await pr.list({ scope, status, top: top + 1, skip,
            repository: q.repository ? str(q.repository, 'repository', { max: 200 }) : undefined,
            target: q.target ? str(q.target, 'target', { max: 250 }) : undefined });
        return {
            prs: prs.slice(0, top).map((p) => ({ ...p, title: maskAll(p.title), local: remoteForRepository(remotesHere, p.repository.name) !== null })),
            more: prs.length > top,
        };
    });
    // The project's repositories; "here": this folder is a clone of it (its tests can run here).
    app.get('/api/ado/git/repos', async (req) => {
        const q = req.query as Record<string, string>;
        const { pr, client } = await prsFor(q);
        const remotesHere = await prRemotes(opts.repoRoot).catch(() => []);
        const repos = await pr.repositories();
        return { adoProject: client.projectName, repos: repos.map((r) => ({ ...r, here: remoteForRepository(remotesHere, r.name) !== null })) };
    });
    // A pull request at a glance (for lists): what kind of files it changes, linked test cases, and
    // whether its tests can run here. Cached per pull request version.
    const glanceCache = new Map<string, unknown>();
    app.get('/api/ado/prs/:repo/:id/glance', async (req) => {
        const q = req.query as Record<string, string>;
        const { repo, id } = prParams(req);
        const { pr, wi, client } = await prsFor(q);
        const g = await pr.glance(repo, id);
        const key = `${client.projectName}/${repo}/${id}/${g.commit ?? ''}/${g.workItems.join(',')}/${q.target ?? ''}`;
        if (glanceCache.has(key)) return glanceCache.get(key);
        const counts: Record<ChangeKind, number> = { feature: 0, steps: 0, code: 0, config: 0, data: 0, other: 0 };
        for (const c of g.changes) counts[changeKind(c.path)]++;
        const remote = remoteForRepository(await prRemotes(opts.repoRoot).catch(() => []), repo);
        const here = remote !== null;
        // Linked test cases (directly) and whether a scenario on the pull request's target branch
        // automates them (the target as last fetched; this folder's files only when it is on it).
        const items = g.workItems.length ? await wi.many(g.workItems.slice(0, 50)).catch(() => []) : [];
        const tcs = items.filter((w) => /test case/i.test(w.type)).map((w) => w.id);
        let automatedIds: Set<number> | null = null;
        if (here && tcs.length) {
            const target = q.target ? str(q.target, 'target', { max: 250 }).replace(/^refs\/heads\//, '') : '';
            automatedIds = target ? await testCaseIdsAt(opts.repoRoot, `refs/remotes/${remote}/${target}`) : null;
            if (!automatedIds) {
                const cur = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: opts.repoRoot, allowFailure: true })).stdout.trim();
                if (!target || cur === target) automatedIds = new Set(automatedScenarios(opts.repoRoot).keys());
            }
        }
        const out = { files: g.changes.length, counts, here, workItems: g.workItems.length, testCases: tcs.length,
            ...(automatedIds ? { automatedHere: tcs.filter((t) => automatedIds!.has(t)).length } : {}) };
        if (glanceCache.size > 500) glanceCache.clear();
        glanceCache.set(key, out);
        return out;
    });
    app.get('/api/ado/prs/:repo/:id', async (req) => {
        const q = req.query as Record<string, string>;
        const { repo, id } = prParams(req);
        const { pr, wi, client } = await prsFor(q);
        const d = await pr.detail(repo, id, await client.projectId().catch(() => undefined));
        const items = d.workItems.length ? await wi.many(d.workItems).catch(() => []) : [];
        // Test cases: linked directly, or "Tested By" of a linked story/bug.
        const testCaseIds = new Set<number>(items.filter((w) => /test case/i.test(w.type)).map((w) => w.id));
        for (const w of items.filter((x) => !/test case/i.test(x.type)).slice(0, 20)) {
            const full = await wi.detail(w.id).catch(() => null);
            for (const r of full?.relations ?? []) if (/tested by/i.test(r.kind) && r.id) testCaseIds.add(r.id);
        }
        const remote = remoteForRepository(await prRemotes(opts.repoRoot).catch(() => []), d.repository.name);
        const local = remote ? await existingCheckout(opts.repoRoot, gitDirOf(opts.repoRoot), id) : null;
        return {
            ...d, title: maskAll(d.title), description: maskAll(d.description),
            threads: d.threads.map((t) => ({ ...t, comments: t.comments.map((c) => ({ ...c, content: maskAll(c.content) })) })),
            workItemDetails: items, testCaseIds: [...testCaseIds],
            local: { canTest: !!remote, remote, checkout: local },
            runs: runner.list().filter((r) => r.pr?.id === id && r.pr.repository === d.repository.name).slice(0, 10).map((r) => ({ ...r, reportKey: runner.reportKey(r.id), reportIndex: reportIndexOf(r), check: selectionCheck(r) })),
        };
    });
    /** Get the pull request into its local copy and work out which tests it calls for. */
    // ---- Other repositories: clone (with the user's Azure DevOps sign-in), open as another Studio, recently opened.
    const studioHomeDir = opts.home ?? path.join(gitDirOf(opts.repoRoot), 'cs-studio');
    if (opts.home) { try { rememberRepo(opts.home, opts.repoRoot); } catch { /* best effort */ } }
    app.get('/api/workspaces', async () => ({ current: opts.repoRoot, recent: recentRepos(studioHomeDir), parent: path.dirname(opts.repoRoot) }));
    app.get('/api/workspaces/ado-repos', async (req) => {
        const { pr } = await prsFor(req.query as Record<string, string>);
        return { repos: await pr.cloneable() };
    });
    app.post('/api/workspaces/clone', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm the clone.');
        const url = str(b.url, 'url', { max: 1000 });
        let authHeader: string | undefined, authHost: string | undefined;
        // The Azure DevOps sign-in goes only to the organization's own host.
        try {
            const t = adoTarget(b as Record<string, string>);
            const st = adoSettingsFor(opts.repoRoot, opts.store, projectId, t.project, t.env, process.env, personal());
            authHost = new URL(st.orgUrl).hostname;
            authHeader = st.bearer ? `Bearer ${await st.bearer()}` : st.pat ? `Basic ${Buffer.from(`:${st.pat}`).toString('base64')}` : undefined;
        } catch { /* not an Azure DevOps project here: Git's own credentials */ }
        try {
            const dest = await cloneRepo({ url, parent: str(b.parent, 'parent', { max: 1000 }), ...(typeof b.name === 'string' && b.name.trim() ? { name: b.name.trim() } : {}), ...(authHeader ? { authHeader, authHost } : {}) });
            rememberRepo(studioHomeDir, dest);
            log('workspace.clone', `Cloned ${url.replace(/\/\/[^@/]+@/, '//')} into ${dest}`);
            return { path: dest };
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/workspaces/open', async (req) => {
        const b = body(req);
        let top: string;
        try { top = await repoTop(path.resolve(str(b.path, 'path', { max: 1000 }))); } catch (e) { throw new BadRequest((e as Error).message); }
        if (path.resolve(top) === path.resolve(opts.repoRoot)) return { url: null, same: true };
        // Programs the repository's own Git settings would run: shown first, run only when the person agrees.
        const programs = await programsInRepoConfig(top);
        if (programs.length && b.trustRepoConfig !== true) return { needsTrust: programs.map((p) => `${p.key} = ${p.value}`), path: top };
        const ts = path.join(__dirname, '..', 'cli.ts'), js = path.join(__dirname, '..', 'cli.js');
        const cli = fs.existsSync(js) ? js : ts;
        try {
            const r = await openStudio({ cli, repo: top, trustRepoConfig: programs.length > 0, ...(cli === ts ? { execArgv: process.execArgv } : {}) });
            rememberRepo(studioHomeDir, top);
            log('workspace.open', `Opened ${top} in another Studio`);
            return { url: r.url, path: top };
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // ---- A new pull request for the current branch (drafted from its commits; the branch must be pushed).
    const thisRepoName = async (): Promise<string | null> => {
        const origin = (await prRemotes(opts.repoRoot)).find((r) => r.name === 'origin') ?? (await prRemotes(opts.repoRoot))[0];
        const m = origin ? /\/_git\/([^/?#]+)/.exec(origin.url) ?? /vs-ssh\.visualstudio\.com[:/]v3\/[^/]+\/[^/]+\/([^/?#]+)/.exec(origin.url) ?? /ssh\.dev\.azure\.com[:/]v3\/[^/]+\/[^/]+\/([^/?#]+)/.exec(origin.url) : null;
        return m ? decodeURIComponent(m[1]).replace(/\.git$/, '') : null;
    };
    app.get('/api/ado/prs/new', async (req) => {
        const q = req.query as Record<string, string>;
        const { pr } = await prsFor(q);
        const st = await git.status();
        if (!st.branch) throw new BadRequest('Check out a branch first (the working copy is on a detached commit).');
        const repos = await pr.repositories();
        const name = q.repository ? str(q.repository, 'repository', { max: 200 }) : await thisRepoName();
        const repo = repos.find((r) => r.name.toLowerCase() === (name ?? '').toLowerCase());
        if (!repo) return { branch: st.branch, repositories: repos, repository: null, problem: `This repository's remote is not one of the project's Git repositories${name ? ` (${name})` : ''}: choose it.` };
        const target = q.target ? str(q.target, 'target', { max: 200 }) : repo.defaultBranch ?? 'main';
        if (target === st.branch) return { branch: st.branch, repositories: repos, repository: repo.name, target, problem: `You are on ${target} itself: create a branch for your change first.` };
        const log = await runGit(['log', `origin/${target}..HEAD`, '--format=%s%x1f%b%x1e', '-n', '200'], { cwd: opts.repoRoot, allowFailure: true });
        const commits = log.stdout.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => { const [subject, b] = c.split('\x1f'); return { subject: subject.trim(), body: (b ?? '').trim() }; });
        const draft = prDraft(st.branch, commits);
        const pushed = !!st.upstream && !st.upstreamGone && st.ahead === 0;
        const reviewers = await pr.reviewerCandidates().catch(() => []);
        return { branch: st.branch, repositories: repos, repository: repo.name, target, commits: commits.length, pushed, upstream: st.upstream, ahead: st.ahead, ...draft, reviewers,
            ...(!pushed ? { problem: st.upstream ? `${st.ahead} commit${st.ahead === 1 ? ' is' : 's are'} not pushed yet: push the branch first.` : 'The branch is not on the server yet: push it first.' } : !commits.length ? { problem: `The branch has no commits that ${target} does not have.` } : {}) };
    });
    app.post('/api/ado/prs', async (req) => {
        const b = body(req);
        if (b.confirm !== true) throw new BadRequest('Confirm opening the pull request.');
        const { pr } = await prsFor(b as Record<string, string>);
        const st = await git.status();
        if (!st.branch) throw new BadRequest('Check out a branch first.');
        if (!st.upstream || st.upstreamGone || st.ahead > 0) throw new BadRequest('Push the branch first: the pull request is made from what is on the server.');
        const reviewers = (Array.isArray(b.reviewers) ? b.reviewers : []).filter((x): x is { id: string; required?: boolean } => !!x && typeof (x as { id?: unknown }).id === 'string' && /^[0-9a-f-]{36}$/i.test((x as { id: string }).id));
        const workItems = (Array.isArray(b.workItems) ? b.workItems : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
        try {
            const r = await pr.create(str(b.repository, 'repository', { max: 200 }), { source: st.branch, target: str(b.target, 'target', { max: 200 }), title: str(b.title, 'title', { max: 400 }), description: typeof b.description === 'string' ? b.description.slice(0, 4000) : '', draft: b.draft === true, reviewers, workItems });
            log('ado.pr.create', `Opened pull request ${r.id} from ${st.branch}`, { id: r.id });
            return r;
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/ado/prs/:repo/:id/checkout', async (req) => {
        const b = body(req) as Record<string, string>;
        const { repo, id } = prParams(req);
        const { pr } = await prsFor(b, req.query);
        const d = await pr.detail(repo, id);
        if (d.status !== 'active') throw new BadRequest(`This pull request is ${d.status}.`);
        const co = await checkoutPr(opts.repoRoot, gitDirOf(opts.repoRoot), { id, repository: d.repository.name, sourceBranch: d.source });
        const projects = discover(opts.repoRoot).projects;
        // The target's version of changed step files (a removed or renamed step matters too).
        const target = d.commits.target && /^[0-9a-f]{40}$/i.test(d.commits.target) ? d.commits.target : null;
        const olds = new Map<string, string>();
        if (target) for (const c of d.changes.filter((x) => isStepFile(path.basename(x.path))).slice(0, 200)) {
            const r = await runGit(['show', `${target}:${c.path}`], { cwd: opts.repoRoot, allowFailure: true, maxOutputBytes: 5 * 1024 * 1024 });
            if (r.code === 0) olds.set(c.path, r.stdout);
        }
        const oldText = (file: string) => olds.get(file) ?? null;
        // Linked work items give the linked test cases: if they cannot be read, say so (else their tests silently drop out).
        let itemsNote: string | null = null;
        const items = d.workItems.length ? await new WorkItems(adoClient(adoTarget(b).project, adoTarget(b).env)).many(d.workItems)
            .catch((e: Error) => { itemsNote = `The linked work items could not be read (${e.message.split('\n')[0]}): the scenarios of linked test cases are not in the suggestions.`; return []; }) : [];
        const testCaseIds = new Set<number>(items.filter((w) => /test case/i.test(w.type)).map((w) => w.id));
        for (const raw of Array.isArray((b as Record<string, unknown>).testCaseIds) ? (b as Record<string, unknown>).testCaseIds as unknown[] : []) { const n = Number(raw); if (Number.isInteger(n) && n > 0) testCaseIds.add(n); }
        // Step files each project loads (its STEP_DEFINITIONS_PATH), as paths in the repository.
        const loaded = new Map<string, Set<string>>();
        const loadsStepFile = (project: string | undefined, file: string) => {
            if (!project) return true; // cannot tell: keep it
            if (!loaded.has(project)) loaded.set(project, new Set(stepIndex.loadedFiles(project).map((f) => path.relative(opts.repoRoot, f).split(path.sep).join('/'))));
            const set = loaded.get(project)!;
            // A file the pull request adds is not in the project yet: judge by its folder.
            return set.has(file) || stepIndex.folders(project).some((dir) => file.startsWith(path.relative(opts.repoRoot, dir).split(path.sep).join('/') + '/'));
        };
        // What recorded runs saw (the framework's IMPACT_COLLECT data, kept in the project's own copy).
        let coverage: CoverageStore | null = null;
        for (const dir of [opts.repoRoot, co.dir]) {
            try { coverage = JSON.parse(fs.readFileSync(path.join(dir, '.cs-ai', 'impact', 'impact-data.json'), 'utf8')) as CoverageStore; break; } catch { /* none */ }
        }
        const impact = prImpact({ root: co.dir, changes: d.changes, oldText, testCaseIds: [...testCaseIds], projects, loadsStepFile, coverage, recentFailures: recentFailures(runner.list()) });
        log('pr.checkout', `Got pull request #${id} (${d.repository.name}) locally to test it`, { pr: id, commit: co.commit });
        return { checkout: itemsNote ? { ...co, notes: [...(co.notes ?? []), itemsNote] } : co, impact };
    });
    app.delete('/api/ado/prs/:repo/:id/checkout', async (req) => {
        const { id } = prParams(req);
        await removeCheckout(opts.repoRoot, gitDirOf(opts.repoRoot), id);
        return { ok: true };
    });
    app.get('/api/ado/prs/:repo/:id/diff', async (req) => {
        const q = req.query as Record<string, string>;
        return { diff: await prFileDiff(opts.repoRoot, hex(q.target, 'target'), hex(q.commit, 'commit'), str(q.path, 'path', { max: 1024 }), q.from ? str(q.from, 'from', { max: 1024 }) : undefined) };
    });
    app.post('/api/ado/prs/:repo/:id/run', async (req) => {
        const b = body(req);
        const { repo, id } = prParams(req);
        const co = await existingCheckout(opts.repoRoot, gitDirOf(opts.repoRoot), id);
        if (!co) throw new BadRequest('Get the pull request locally first.');
        const list = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : undefined;
        const inCopy = (f: string) => { const a = path.resolve(co.dir, f); const r = path.relative(co.dir, a); if (!r || r.startsWith('..') || path.isAbsolute(r) || !fs.existsSync(a)) throw new BadRequest(`Not in the pull request: ${f}`); return f; };
        // Observe: every test of the project runs; the chosen ones are kept to check the choice against the failures.
        const observe = b.observe === true;
        const chosen = (list(b.features) ?? []).map(inCopy);
        const catalogIn = observe || chosen.length ? readCatalog(co.dir) : [];
        const selection = chosen.length ? {
            observe,
            features: chosen.map((f) => ({ path: f, name: catalogIn.find((c) => c.path === f)?.name ?? f, scenarios: (list(b.scenarios) ?? []).filter((n) => catalogIn.find((c) => c.path === f)?.scenarios.some((x) => x.name === n)) })),
        } : undefined;
        const rr: RunRequest = {
            project: configProjectParam(b.project), env: envParam(b.env),
            features: observe ? undefined : chosen.length ? chosen : undefined,
            scenarios: observe ? undefined : list(b.scenarios),
            headless: typeof b.headless === 'boolean' ? b.headless : undefined,
            browser: str(b.browser, 'browser', { optional: true, max: 20 }) || undefined,
            workers: b.workers === undefined || b.workers === null ? undefined : Number(b.workers),
        };
        const secretEnv = opts.store.exists ? secretsAsEnv(opts.store, { project: projectId, env: rr.env }) : {};
        const mergeRef = await runGit(['rev-parse', '--verify', '-q', `refs/cs-studio/pr/${id}/merge`], { cwd: opts.repoRoot, allowFailure: true });
        const based = mergeRef.stdout.trim() === co.commit ? 'merge' as const : 'source' as const;
        const run = runner.start(rr, secretEnv, runEnvFor(personal().network, process.env), {
            workdir: co.rel, pr: { id, repository: repo, title: maskAll(str(b.title, 'title', { optional: true, max: 400 }) || ''), commit: co.commit, based, ...(selection ? { selection } : {}) },
        });
        log('pr.test', `Started tests of pull request #${id}: ${run.command.slice(1).join(' ')}`, { id: run.id, pr: id });
        return run;
    });
    /** The results of a run as a comment for the pull request (the user can edit it before posting). */
    app.get('/api/ado/prs/:repo/:id/results-comment', async (req) => {
        const r = runner.get(str((req.query as Record<string, string>).run, 'run', { max: 64 }));
        if (!r || !r.pr) throw new BadRequest('Unknown pull request run.');
        return { text: resultsComment(r, maskAll) };
    });
    app.post('/api/ado/prs/:repo/:id/comment', async (req) => {
        const b = body(req);
        confirmed(b, 'posting the comment');
        const { repo, id } = prParams(req);
        const { pr } = await prsFor(b as Record<string, string>, req.query);
        const text = str(b.text, 'text', { max: 150_000 });
        const at = b.file ? { file: str(b.file, 'file', { max: 1024 }), line: Number(b.line) || 1 } : undefined;
        const thread = await pr.comment(repo, id, text, at, b.kind === 'results');
        log('pr.comment', `Commented on pull request #${id}`, { pr: id });
        return { thread };
    });
    /** A run's result as a status check on the pull request (cs-test-studio/tests): passed, failed, or not finished. */
    app.post('/api/ado/prs/:repo/:id/status', async (req) => {
        const b = body(req);
        confirmed(b, 'posting the status');
        const { repo, id } = prParams(req);
        const r = runner.get(str(b.run, 'run', { max: 64 }));
        if (!r || !r.pr || r.pr.id !== id || r.pr.repository !== repo) throw new BadRequest('Unknown run of this pull request.');
        const st = prStatusOf(r);
        const { pr } = await prsFor(b as Record<string, string>, req.query);
        await pr.postStatus(repo, id, st);
        log('pr.status', `Posted the test status to pull request #${id}: ${st.state}`, { pr: id, run: r.id });
        return st;
    });
    app.post('/api/ado/prs/:repo/:id/threads/:thread', async (req) => {
        const b = body(req);
        confirmed(b, 'the change to the discussion');
        const { repo, id } = prParams(req);
        const thread = runIdParam((req.params as { thread: string }).thread);
        const { pr } = await prsFor(b as Record<string, string>, req.query);
        if (b.reply) await pr.reply(repo, id, thread, str(b.reply, 'reply', { max: 150_000 }));
        if (b.status) {
            const st = (['active', 'fixed', 'closed'] as const).find((x) => x === b.status);
            if (!st) throw new BadRequest('Invalid status.');
            await pr.setThread(repo, id, thread, st);
        }
        return { ok: true };
    });
    app.post('/api/ado/prs/:repo/:id/finish', async (req) => {
        const b = body(req);
        const action = str(b.action, 'action', { max: 30 }) as PrFinish;
        if (!['complete', 'auto-complete', 'cancel-auto-complete', 'abandon', 'reactivate'].includes(action)) throw new BadRequest('Unknown action.');
        confirmed(b, action === 'abandon' ? 'abandoning the pull request' : action === 'complete' ? 'completing the pull request' : 'this change');
        const { repo, id } = prParams(req);
        const { pr } = await prsFor(b as Record<string, string>, req.query);
        const strategy = (['squash', 'noFastForward', 'rebase', 'rebaseMerge'] as const).find((x) => x === b.strategy);
        const r = await pr.finish(repo, id, action, { ...(strategy ? { strategy } : {}), deleteSourceBranch: b.deleteSourceBranch !== false, transitionWorkItems: b.transitionWorkItems !== false,
            ...(typeof b.message === 'string' && b.message.trim() ? { message: b.message } : {}), ...(typeof b.expectedCommit === 'string' ? { expectedCommit: b.expectedCommit } : {}) });
        log('pr.finish', `${action} pull request #${id}`, { pr: id, action, ...(strategy ? { strategy } : {}) });
        return r;
    });
    app.post('/api/ado/prs/:repo/:id/vote', async (req) => {
        const b = body(req);
        confirmed(b, 'your vote');
        const { repo, id } = prParams(req);
        const { pr } = await prsFor(b as Record<string, string>, req.query);
        const vote = Number(b.vote);
        await pr.vote(repo, id, vote);
        log('pr.vote', `Voted "${VOTE_LABEL[String(vote)]}" on pull request #${id}`, { pr: id, vote });
        return { ok: true };
    });

    app.get('/report/:id/:key/*', async (req, reply) => {
        const p = req.params as { id: string; key: string; '*': string };
        const expected = runner.reportKey(p.id);
        const a = Buffer.from(p.key), e = Buffer.from(expected ?? '');
        if (!expected || a.length !== e.length || !tse(a, e)) return reply.code(404).send({ error: 'Not found.' });
        // Served from the results folder (test-results-<time>/): the report links "../screenshots/…".
        const reportDir = runner.get(p.id)!.summary!.reportDir;
        const dir = resultsRootOf(reportDir);
        // Links made before reports were served from the results folder pointed at …/index.html.
        if ((p['*'] || 'index.html') === 'index.html' && dir !== reportDir && !fs.existsSync(path.join(dir, 'index.html'))) {
            return reply.redirect(`/report/${encodeURIComponent(p.id)}/${encodeURIComponent(p.key)}/${path.relative(dir, path.join(reportDir, 'index.html')).split(path.sep).map(encodeURIComponent).join('/')}`);
        }
        const inside = (base: string, target: string) => { const r = path.relative(base, target); return !r.startsWith('..') && !path.isAbsolute(r); };
        const file = path.resolve(dir, p['*'] || 'index.html');
        // Report folders must be inside the repository, and files inside the report folder.
        if (!inside(opts.repoRoot, dir) || !inside(dir, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send({ error: 'Not found.' });
        if (!inside(fs.realpathSync(opts.repoRoot), fs.realpathSync(file))) return reply.code(404).send({ error: 'Not found.' });
        return sendReportFile(reply, path.relative(uiDirForReports(dir), file), uiDirForReports(dir));
    });

    // ---- Personal settings and Git identity
    const gitChange = (b: Record<string, unknown>): GitNetworkChange => {
        const opt = (v: unknown, f: string) => (v === undefined ? undefined : v === null ? null : str(v, f, { max: 2048 }));
        const backend = b.sslBackend;
        if (backend !== undefined && backend !== null && backend !== 'schannel' && backend !== 'openssl') throw new BadRequest('"sslBackend" must be schannel or openssl.');
        return { proxy: opt(b.proxy, 'proxy'), sslBackend: backend as GitNetworkChange['sslBackend'], sslCAInfo: opt(b.sslCAInfo, 'sslCAInfo'), restoreSslVerify: b.restoreSslVerify === true };
    };
    /** Settings for the UI: never the proxy password, only whether one is stored. */
    const settingsView = async () => {
        const p = personal();
        const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
        let envProxyLabel = '';
        if (envProxy) { try { const u = new URL(envProxy); u.username = ''; u.password = ''; envProxyLabel = u.href; } catch { envProxyLabel = '(set, but not a valid address)'; } }
        return {
            ...p, git: await getIdentity(opts.repoRoot),
            // What the Network card read: its save (the whole network block) is refused when it changed since (two tabs).
            networkVersion: contentVersion(p.network),
            networkInfo: {
                systemCertsSupported: systemCertsSupported(), nodeVersion: process.version,
                hasProxyPassword: opts.store.exists && opts.store.hasStudio(PROXY_PASSWORD_SECRET),
                environmentProxy: envProxyLabel, environmentNoProxy: process.env.NO_PROXY || process.env.no_proxy || '',
            },
        };
    };
    app.get('/api/settings', async () => settingsView());
    const clientCertList = (v: unknown): NonNullable<NetworkSettings['clientCerts']> => {
        if (!Array.isArray(v) || v.length > 50) throw new BadRequest('"clientCerts" must be a list (at most 50).');
        return v.map((x, i) => {
            const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
            const host = str(o.host, `clientCerts[${i}].host`, { max: 255 }).trim();
            if (!/^\.?[A-Za-z0-9.-]+$/.test(host)) throw new BadRequest(`clientCerts[${i}].host: a host name, or a suffix such as .bank.local`);
            const f = (k: string) => (o[k] === undefined || o[k] === '' ? undefined : str(o[k], `clientCerts[${i}].${k}`, { max: 1024 }));
            const c = { host, pfxFile: f('pfxFile'), certFile: f('certFile'), keyFile: f('keyFile'), passphraseSecret: f('passphraseSecret') };
            if (!c.pfxFile && !(c.certFile && c.keyFile)) throw new BadRequest(`clientCerts[${i}]: give a .pfx/.p12 file, or a certificate and a key file.`);
            for (const file of [c.pfxFile, c.certFile, c.keyFile]) if (file && !fs.existsSync(file)) throw new BadRequest(`${file} does not exist.`);
            if (c.passphraseSecret && !/^[A-Z][A-Z0-9_]{0,99}$/.test(c.passphraseSecret)) throw new BadRequest(`clientCerts[${i}].passphraseSecret: a Studio secret name (CAPITALS_AND_UNDERSCORES).`);
            return Object.fromEntries(Object.entries(c).filter(([, v2]) => v2 !== undefined)) as NonNullable<NetworkSettings['clientCerts']>[number];
        });
    };
    app.get('/api/settings/network/info', async () => ({ system: netInfo.system ?? null, pacFrom: netInfo.pacFrom ?? null, pacLoaded: !!netInfo.pacScript, error: netInfo.error ?? netConnection().pacError ?? null }));
    app.put('/api/settings/network/secret', async (req) => {
        // A client certificate passphrase (or another network secret): write-only, in the Studio's own scope.
        const b = body(req);
        const name = str(b.name, 'name', { max: 100 });
        if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name) || name === PROXY_PASSWORD_SECRET) throw new BadRequest('A secret name is CAPITALS_AND_UNDERSCORES.');
        if (b.value === null) opts.store.deleteStudio(name); else opts.store.setStudio(name, str(b.value, 'value', { max: 4096 }));
        log('settings.network', `${b.value === null ? 'Removed' : 'Saved'} the network secret ${name}`);
        return { ok: true };
    });
    app.put('/api/settings/network', async (req) => {
        if (!settings) throw new BadRequest('Settings are not available.');
        const b = body(req);
        const cur = personal().network;
        checkVersion(b.version, contentVersion(cur), b.force);
        // Empty is a valid value here (no proxy address, no certificate file).
        const s2 = (v: unknown, f: string, d: string) => (v === undefined ? d : str(v, f, { optional: true, max: 2048 }) ?? '');
        const proxyMode = (['off', 'environment', 'manual', 'system', 'pac'] as const).find((m) => m === b.proxyMode) ?? cur.proxyMode;
        // A field the chosen mode does not use (hidden on the screen) never blocks the save: when it is
        // not acceptable, the saved value stays.
        const unused = (v: unknown, f: string, d: string) => { try { return s2(v, f, d); } catch { return d; } };
        const signIn = proxyMode !== 'off';
        const next = settings.update({ network: {
            proxyMode,
            pacUrl: (proxyMode === 'pac' ? s2 : unused)(b.pacUrl, 'pacUrl', cur.pacUrl ?? ''),
            proxyAuth: (['basic', 'ntlm', 'digest'] as const).find((m) => m === b.proxyAuth) ?? cur.proxyAuth ?? 'basic',
            proxyDomain: (signIn ? s2 : unused)(b.proxyDomain, 'proxyDomain', cur.proxyDomain ?? ''),
            clientCerts: b.clientCerts === undefined ? cur.clientCerts ?? [] : clientCertList(b.clientCerts),
            proxyUrl: (proxyMode === 'manual' ? s2 : unused)(b.proxyUrl, 'proxyUrl', cur.proxyUrl),
            proxyUser: (signIn ? s2 : unused)(b.proxyUser, 'proxyUser', cur.proxyUser),
            bypass: b.bypass === undefined ? cur.bypass : strList(b.bypass, 'bypass'),
            useSystemCerts: typeof b.useSystemCerts === 'boolean' ? b.useSystemCerts : cur.useSystemCerts,
            caFile: s2(b.caFile, 'caFile', cur.caFile),
            certsForTestRuns: typeof b.certsForTestRuns === 'boolean' ? b.certsForTestRuns : cur.certsForTestRuns,
        } });
        void refreshNetInfo();
        log('settings.network', `Network: proxy ${next.network.proxyMode}${next.network.proxyMode === 'manual' ? ` (${next.network.proxyUrl})` : ''}, computer certificates ${next.network.useSystemCerts ? 'on' : 'off'}${next.network.caFile ? ', certificate file set' : ''}`);
        return settingsView();
    });
    // The proxy password: write-only, kept in the Studio's own secret scope (never given to test runs).
    app.put('/api/settings/network/password', async (req) => {
        const b = body(req);
        if (b.password === null) { opts.store.deleteStudio(PROXY_PASSWORD_SECRET); log('settings.network', 'Removed the proxy password'); }
        else { opts.store.setStudio(PROXY_PASSWORD_SECRET, str(b.password, 'password', { max: 1024 })); log('settings.network', 'Saved the proxy password'); }
        return settingsView();
    });
    app.post('/api/settings/network/certificates', async (req) => {
        const file = str(body(req).file, 'file', { max: 2048 });
        return { certificates: readCaFile(file).map(({ subject, issuer, validTo }) => ({ subject, issuer, validTo })) };
    });
    // Git's own network settings (global Git config), shown and changed one command at a time.
    app.get('/api/git/network', async () => gitNetworkState(opts.repoRoot));
    app.post('/api/git/network/preview', async (req) => ({ commands: gitNetworkCommands(gitChange(body(req))).map((a) => `git ${a.join(' ')}`) }));
    app.put('/api/git/network', async (req) => {
        const ran = await applyGitNetwork(opts.repoRoot, gitChange(body(req)));
        log('git.network', `Changed global Git network settings: ${ran.join('; ')}`);
        return { ran, state: await gitNetworkState(opts.repoRoot) };
    });
    app.post('/api/git/network/test', async () => checkGitConnection(opts.repoRoot));
    app.post('/api/settings/network/test', async (req) => {
        // The Azure DevOps organization from the project's config (with the token, to check it too);
        // without config, just the Azure DevOps service.
        const q = body(req) as Record<string, string>;
        let url = 'https://dev.azure.com/';
        let auth: string | undefined;
        try {
            const t = adoTarget(q);
            const s = adoSettingsFor(opts.repoRoot, opts.store, projectId, t.project, t.env, process.env, personal());
            url = `${s.orgUrl}/_apis/connectionData`;
            auth = s.bearer ? `Bearer ${await s.bearer()}` : `Basic ${Buffer.from(`:${s.pat}`).toString('base64')}`;
        } catch (e) {
            // No usable ADO config/token: still test the network path to Azure DevOps.
            if (!(e instanceof UserError || e instanceof BadRequest)) throw e;
        }
        const r = await checkConnection(url, netConnection(), auth);
        log('settings.network', `Connection test: ${r.ok ? 'ok' : r.stage}`, { url: new URL(url).host });
        return { ...r, tokenChecked: !!auth };
    });
    app.put('/api/settings', async (req) => {
        if (!settings) throw new BadRequest('Settings are not available.');
        const b = body(req);
        const patch: Record<string, unknown> = {};
        if (Array.isArray(b.trustedAdoHosts)) patch.trustedAdoHosts = b.trustedAdoHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
        if (typeof b.adoPatSecret === 'string') patch.adoPatSecret = b.adoPatSecret.trim();
        if (b.adoAuth === 'pat' || b.adoAuth === 'entra') patch.adoAuth = b.adoAuth;
        if (typeof b.openBrowser === 'boolean') patch.openBrowser = b.openBrowser;
        if (b.port !== undefined) patch.port = Number(b.port);
        if (typeof b.loadTeamFolder === 'string') {
            const f = b.loadTeamFolder.trim();
            if (f && !(fs.existsSync(f) && fs.statSync(f).isDirectory())) throw new BadRequest(`The folder ${f} cannot be reached from this computer.`);
            patch.loadTeamFolder = f;
        }
        const next = settings.update(patch);
        log('settings', 'Changed personal settings', { trustedAdoHosts: next.trustedAdoHosts.join(', '), adoPatSecret: next.adoPatSecret });
        void next;
        // The whole view (network information too): the Settings screen shows what it gets back.
        return settingsView();
    });
    app.put('/api/settings/git-identity', async (req) => {
        const b = body(req);
        // The limits and their messages are setIdentity's (name at most 100 characters, email required).
        const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : '');
        const r = await setIdentity(opts.repoRoot, text(b.name), text(b.email), b.scope === 'global' ? 'global' : 'repository');
        log('settings.git', `Set Git identity (${r.scope})`, { name: r.name });
        return r;
    });

    // ---- Activity
    app.get('/api/activity', async (req) => {
        const limit = Math.min(Math.max(Number((req.query as Record<string, string>).limit) || 100, 1), 1000);
        return opts.activity ? opts.activity.recent(limit, { repo: opts.repoRoot }) : [];
    });

    // ---- UI (static files; the API token is what protects data, not these files)
    // CS_STUDIO_UI_DIR: a UI built elsewhere (development: several UI builds side by side).
    const uiDir = opts.uiDir ?? (process.env.CS_STUDIO_UI_DIR || path.resolve(__dirname, '../../ui'));
    const hasUi = fs.existsSync(path.join(uiDir, 'index.html'));
    // ---- API workspace: collections (in the project), send, import (collection files, cURL), feature.
    const apiProject = (v: unknown) => {
        const p = configProjectParam(v);
        if (!discover(opts.repoRoot).projects.includes(p)) throw new BadRequest(`No framework project "${p}" under config/.`);
        return p;
    };
    const apiHistoryFile = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'api-history.json');
    const apiHistoryDir = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'api-history');
    /** pm.globals of scripts, per collection, for the session. */
    const apiGlobals = new Map<string, Record<string, string>>();
    /** OAuth2 tokens of this Studio session (reused until they expire). */
    const apiTokens: TokenCache = new Map();
    // Cookies of Send, per project / environment / collection (as one API client of a test keeps them).
    const apiJars = new Map<string, CookieJar>();
    const apiJar = (project: string, env: string, collection: string) => {
        const k = `${project}|${env}|${collection}`;
        let j = apiJars.get(k);
        if (!j) { j = new CookieJar(); apiJars.set(k, j); }
        return j;
    };
    /**
     * Values for requests of a collection, as a test run of project/env sees them: the collection's
     * variables, the configuration ({config:KEY}) and the Studio secrets ({env:NAME}); plus the secret
     * values, to mask them in what is shown.
     */
    // Browser sign-in tokens go along (Send, the runner, load workers).
    // Vault references in configuration / secrets ({kv:…}, {vault:…}, {awssm:…}): one reader per project and
    // environment (its secrets may hold the vault sign-in), values kept for the session.
    const vaults = new Map<string, SecretVault>();
    const vaultFor = (project: string, env: string, secretEnv: Record<string, string>) => {
        const k = `${project}|${env}`;
        let v = vaults.get(k);
        if (!v) { v = new SecretVault({ ...process.env, ...secretEnv }); vaults.set(k, v); }
        return v;
    };
    const apiValues = async (project: string, env: string, c: ApiCollection) => {
        const secretEnv = secretsAsEnv(opts.store, { project: projectId, env });
        const r = await withVault(valuesFor(opts.repoRoot, project, env, c, secretEnv), c, vaultFor(project, env, secretEnv));
        if (apiTokens.size) r.values.tokens = Object.fromEntries(apiTokens);
        return r;
    };
    // ---- OAuth 2.0 sign-in in the browser (authorization code + PKCE, implicit, device code).
    const oauth = new OAuthFlows(apiTokens, netConnection);
    /** The auth of a request with its values filled in (secrets, config, collection variables). */
    const oauthAuth = async (b: Body): Promise<ApiAuth> => {
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const a = (b.auth && typeof b.auth === 'object' ? b.auth : c.auth) as ApiAuth;
        if (a.type !== 'oauth2') throw new BadRequest('Not an OAuth 2.0 authorization.');
        const { values } = await apiValues(project, env, c);
        const missing = new Set<string>();
        const g = (x?: string) => (x === undefined ? undefined : fill(x, values, missing));
        const r: ApiAuth = { ...a, tokenUrl: g(a.tokenUrl), authUrl: g(a.authUrl), deviceUrl: g(a.deviceUrl), clientId: g(a.clientId), clientSecret: g(a.clientSecret), scope: g(a.scope), audience: g(a.audience), refreshToken: g(a.refreshToken) };
        if (missing.size) throw new BadRequest(`Not filled in: ${[...missing].join(', ')}.`);
        return r;
    };
    const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const redirectUri = () => `http://127.0.0.1:${port}/oauth/callback`;
    app.post('/api/oauth2/start', async (req) => {
        const a = await oauthAuth(body(req));
        const r = oauth.start(a, redirectUri());
        log('api.oauth2', `Started an OAuth 2.0 sign-in (${a.grant})`, {});
        return { url: r.url, redirectUri: redirectUri() };
    });
    app.post('/api/oauth2/device', async (req) => oauth.startDevice(await oauthAuth(body(req))));
    app.get('/api/oauth2/device/:id', async (req) => oauth.deviceStatus((req.params as { id: string }).id));
    app.post('/api/oauth2/status', async (req) => oauth.status(await oauthAuth(body(req))));
    app.post('/api/oauth2/forget', async (req) => { oauth.forget(await oauthAuth(body(req))); return { ok: true }; });
    const oauthPage = (title: string, text: string, script = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:64px auto;max-width:520px;color:#1f2328;padding:0 16px}h1{font-size:20px}</style>${script ? '<script src="/oauth/implicit.js"></script>' : ''}</head><body><h1>${escapeHtml(title)}</h1><p id="msg">${escapeHtml(text)}</p></body></html>`;
    // The provider sends the browser here (no Studio token: the one-time state proves it is our sign-in).
    app.get('/oauth/callback', async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        reply.type('text/html; charset=utf-8');
        if (!q.code && !q.error && !q.state) return oauthPage('Signing in…', 'Finishing the sign-in…', true);
        try {
            if (q.error) throw new Error(`Sign-in refused: ${q.error}${q.error_description ? ` (${q.error_description})` : ''}`);
            await oauth.complete(String(q.state ?? ''), String(q.code ?? ''));
            log('api.oauth2', 'Signed in (OAuth 2.0 authorization code)', {});
            return oauthPage('Signed in', 'You are signed in. Close this window and go back to the Studio.');
        } catch (e) { reply.code(400); return oauthPage('Sign-in failed', (e as Error).message); }
    });
    app.get('/oauth/implicit.js', async (_req, reply) => {
        reply.type('application/javascript');
        return `(function(){var h=new URLSearchParams(location.hash.slice(1));var o={};h.forEach(function(v,k){o[k]=v;});history.replaceState(null,'',location.pathname);fetch('/oauth/implicit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)}).then(function(r){return r.json();}).then(function(j){document.getElementById('msg').textContent=j.ok?'You are signed in. Close this window and go back to the Studio.':('Sign-in failed: '+j.error);});})();`;
    });
    app.post('/oauth/implicit', async (req, reply) => {
        const b = body(req);
        const frag = Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]));
        try { oauth.completeImplicit(frag.state ?? '', frag); log('api.oauth2', 'Signed in (OAuth 2.0 implicit)', {}); return { ok: true }; }
        catch (e) { reply.code(400); return { ok: false, error: (e as Error).message }; }
    });
    // ---- API mocks: definitions in test/<project>/mocks/<name>.mock.json, run on this computer from the Studio.
    const mockRuns = new Map<string, { mock: RunningMock; startedAt: string }>();
    app.addHook('onClose', async () => { for (const r of mockRuns.values()) await r.mock.close().catch(() => undefined); mockRuns.clear(); if (mockRecorder) await mockRecorder.rec.stop().catch(() => undefined); });
    const mockFile = (project: string, v: unknown) => {
        const file = str(v, 'file', { max: 300 }).replace(/\\/g, '/');
        if (!file.startsWith(`test/${project}/mocks/`) || !/^[\w./-]+\.mock\.json$/.test(file) || file.includes('..')) throw new BadRequest(`A mock is a test/${project}/mocks/<name>.mock.json file.`);
        try { safePath(opts.repoRoot, file); } catch (e) { throw new BadRequest((e as Error).message); }
        return file;
    };
    const readMock = (file: string): MockDefinition => {
        try { return JSON.parse(fs.readFileSync(path.join(opts.repoRoot, file), 'utf8')) as MockDefinition; }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound(`There is no mock ${file}: it was deleted or renamed, or the link is wrong.`);
            throw new BadRequest(`${file}: ${(e as Error).message.replace(/\/[^\s'"]*\//g, '')}`);
        }
    };
    app.get('/api/mocks', async (req) => {
        const project = apiProject((req.query as Record<string, string>).project);
        const dir = path.join(opts.repoRoot, 'test', project, 'mocks');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mock.json')).sort() : [];
        return { mocks: files.map((f) => {
            const file = `test/${project}/mocks/${f}`;
            let name = f.replace(/\.mock\.json$/, ''), routes = 0, problems: string[] = [];
            try { const d = readMock(file); name = d.name || name; routes = Array.isArray(d.routes) ? d.routes.length : 0; problems = mockProblems(d); } catch (e) { problems = [(e as Error).message]; }
            const run = mockRuns.get(file);
            return { file, name, routes, problems, ...(run ? { url: run.mock.url, startedAt: run.startedAt } : {}) };
        }) };
    });
    app.get('/api/mocks/file', async (req) => {
        const project = apiProject((req.query as Record<string, string>).project);
        const file = mockFile(project, (req.query as Record<string, string>).file);
        const run = mockRuns.get(file);
        // version: the file as read (a save from another tab over a later save is refused: Reload / Overwrite).
        return { file, mock: readMock(file), version: fileVersion(path.join(opts.repoRoot, file)), ...(run ? { url: run.mock.url } : {}) };
    });
    // A definition from the saved examples of a collection of the repository: not saved yet.
    app.post('/api/mocks/from-collection', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 300 });
        try { return mockFromCollection(readCollection(opts.repoRoot, file), typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : undefined); }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    // Recording: a proxy to the real service (through the network settings) that keeps every answer; stopped, a definition.
    let mockRecorder: { target: string; rec: MockRecorder } | null = null;
    app.post('/api/mocks/record/start', async (req) => {
        const b = body(req);
        const target = str(b.target, 'target', { max: 2000 }).trim();
        if (!/^https?:\/\//i.test(target)) throw new BadRequest('Record from an http:// or https:// address.');
        try { if (!new URL(target).hostname) throw new Error('no host'); } catch { throw new BadRequest('The address needs a host after http:// or https://, e.g. https://api.example.com.'); }
        if (mockRecorder) await mockRecorder.rec.stop();
        const conn = netConnection();
        try { mockRecorder = { target, rec: await recordMock(target, { agentFor: (u) => conn.agentFor(u) as never, ...(conn.ca ? { ca: conn.ca } : {}) }) }; }
        catch (e) { throw new BadRequest((e as Error).message); }
        return { url: mockRecorder.rec.url, target };
    });
    app.get('/api/mocks/record', async () => (mockRecorder ? { url: mockRecorder.rec.url, target: mockRecorder.target, count: mockRecorder.rec.count() } : { url: null }));
    app.post('/api/mocks/record/stop', async (req) => {
        const b = body(req);
        if (!mockRecorder) throw new BadRequest('Not recording.');
        const r = mockRecorder; mockRecorder = null;
        const mock = await r.rec.stop();
        if (typeof b.name === 'string' && b.name.trim()) mock.name = b.name.trim().slice(0, 80);
        return { mock, warnings: mock.routes.length ? [] : ['Nothing was recorded: send requests to the recording address first.'] };
    });
    // A definition from an OpenAPI document (text, or a file of the repository): not saved yet.
    app.post('/api/mocks/from-openapi', async (req) => {
        const b = body(req);
        let text = typeof b.text === 'string' ? b.text : '';
        if (!text && typeof b.specFile === 'string') { const f = str(b.specFile, 'specFile', { max: 300 }); try { text = fs.readFileSync(safePath(opts.repoRoot, f), 'utf8'); } catch (e) { throw new BadRequest((e as Error).message); } }
        if (!text.trim()) throw new BadRequest('Paste the OpenAPI document or choose its file.');
        try { const r = mockFromOpenApi(parseSpec(text.slice(0, 10 * 1024 * 1024)), typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : undefined); return { mock: { ...r.mock, ...(typeof b.specFile === 'string' ? { source: b.specFile } : {}) }, warnings: r.warnings }; }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.put('/api/mocks/file', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const file = mockFile(project, b.file);
        const { item: mockItem, meta: mockMeta } = takeSaveMeta(b.mock);
        const d = mockItem as MockDefinition;
        const problems = mockProblems(d);
        if (problems.length) throw new BadRequest(problems.join(' '));
        // The name tells mocks apart in the list: given, and not another mock's.
        if (typeof d.name !== 'string' || !d.name.trim()) throw new BadRequest('The mock needs a name.');
        d.name = d.name.trim();
        if (d.name.length > 120) throw new BadRequest('The mock name is too long (at most 120 characters).');
        const dir = path.join(opts.repoRoot, 'test', project, 'mocks');
        const clash = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.mock.json') && `test/${project}/mocks/${f}` !== file).find((f) => {
            try { return (readMock(`test/${project}/mocks/${f}`).name || f.replace(/\.mock\.json$/, '')).trim().toLowerCase() === d.name.toLowerCase(); } catch { return false; }
        });
        if (clash) throw new BadRequest(`Another mock is already called "${d.name}" (${clash}): choose another name.`);
        const abs = path.join(opts.repoRoot, file);
        // Saved over a version someone else changed meanwhile (another tab): refused, the UI offers Reload / Overwrite.
        const mockStale = staleSave(abs, mockMeta);
        if (mockStale) throw new Conflict(mockStale);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `${JSON.stringify(d, null, 2)}\n`);
        log('mock.save', `Saved the API mock ${file}`, { routes: d.routes.length });
        const version = fileVersion(abs);
        // A running mock answers with the saved definition at once; a new port needs a restart.
        const run = mockRuns.get(file);
        if (!run) return { file, saved: true, version };
        run.mock.update(d);
        const restart = d.port !== undefined && d.port !== 0 && d.port !== run.mock.port;
        return { file, saved: true, version, applied: true, ...(restart ? { restartForPort: true } : {}) };
    });
    app.delete('/api/mocks/file', async (req) => {
        const q = req.query as Record<string, string>;
        const project = apiProject(q.project);
        const file = mockFile(project, q.file);
        const run = mockRuns.get(file);
        if (run) { await run.mock.close(); mockRuns.delete(file); }
        try { fs.rmSync(path.join(opts.repoRoot, file)); } catch { /* gone */ }
        return { removed: true };
    });
    app.post('/api/mocks/start', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const file = mockFile(project, b.file);
        const had = mockRuns.get(file);
        if (had) { await had.mock.close(); mockRuns.delete(file); }
        const d = readMock(file);
        if (b.port !== undefined && b.port !== null && b.port !== '') { const pt = Number(b.port); if (!Number.isInteger(pt) || pt < 0 || pt > 65535) throw new BadRequest('Port: 0–65535 (0: any free port).'); d.port = pt; }
        try {
            const mock = await startMock(d);
            mockRuns.set(file, { mock, startedAt: new Date().toISOString() });
            log('mock.start', `Started the API mock ${file} at ${mock.url}`, {});
            return { url: mock.url, port: mock.port };
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/mocks/stop', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const file = mockFile(project, b.file);
        const run = mockRuns.get(file);
        if (run) { await run.mock.close(); mockRuns.delete(file); }
        return { stopped: !!run };
    });
    app.get('/api/mocks/log', async (req) => {
        const q = req.query as Record<string, string>;
        const project = apiProject(q.project);
        const file = mockFile(project, q.file);
        const run = mockRuns.get(file);
        return { running: !!run, url: run?.mock.url, log: run ? run.mock.log.slice(-200) : [] };
    });
    app.get('/api/apiws/collections', async () => {
        const found = discover(opts.repoRoot);
        return { projects: found.projects, environments: found.environments, collections: listCollections(opts.repoRoot, found.projects) };
    });
    app.get('/api/apiws/collection', async (req) => {
        const file = str((req.query as Record<string, string>).file, 'file', { max: 300 });
        try { return { file, collection: readCollection(opts.repoRoot, file), version: fileVersion(path.join(opts.repoRoot, file)) }; }
        catch (e) {
            // A bad link (#/api/<file that is not there>): said in words, without this computer's paths.
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound(`There is no API collection ${file}: it was deleted or renamed, or the link is wrong.`);
            throw new BadRequest(fileErrorText(e as NodeJS.ErrnoException, opts.repoRoot) ?? `${file}: ${(e as Error).message.replace(/\/[^\s'"]*\//g, '')}`);
        }
    });
    app.put('/api/apiws/collection', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        let c: ApiCollection;
        const { item: cItem, meta: cMeta } = takeSaveMeta(b.collection);
        try { c = validCollection(cItem); } catch (e) { throw new BadRequest((e as Error).message); }
        const file = b.file ? str(b.file, 'file', { max: 300 }) : collectionRel(project, c.name);
        // Saved over a version someone else changed meanwhile (another tab): refused, the UI offers Reload / Overwrite.
        if (b.file) { const stale = staleSave(path.join(opts.repoRoot, file), cMeta); if (stale) throw new Conflict(stale); }
        // A new collection must not replace another one with the same file name.
        if (!b.file && fs.existsSync(path.join(opts.repoRoot, file)) && b.overwrite !== true) throw new BadRequest(`${file} already exists. Choose another name.`);
        // Secret values never go into the file: only {env:NAME} references.
        for (const v of c.variables) if (v.secret && v.value && !/^\{env:[\w.-]+\}$/.test(v.value.trim())) throw new BadRequest(`Variable "${v.key}" is secret: store its value as a Studio secret and use {env:NAME}.`);
        try { writeCollection(opts.repoRoot, project, c, file); } catch (e) { throw new BadRequest((e as Error).message); }
        log('api.collection.save', `Saved the API collection ${c.name}`, { file });
        return { file, version: fileVersion(path.join(opts.repoRoot, file)) };
    });
    app.delete('/api/apiws/collection', async (req) => {
        const q = req.query as Record<string, string>;
        const file = str(q.file, 'file', { max: 300 });
        if (q.confirm !== 'true') throw new BadRequest('Confirm deleting the collection.');
        readCollection(opts.repoRoot, file); // only collection files
        fs.rmSync(path.join(opts.repoRoot, file), { force: true });
        log('api.collection.delete', `Deleted the API collection file ${file}`, { file });
        return { ok: true };
    });
    // Correlation by replay (see load/correlate.ts): the collection as it is in the editor, replayed twice; the values
    // that change between the replays and later requests send fixed; applied to the collection given back (not saved).
    app.post('/api/apiws/correlate', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const reqs = allRequests(c.items).map((x) => x.request).filter((r) => !r.ws);
        if (!reqs.length) throw new BadRequest('The collection has no HTTP requests to replay.');
        const { values, secrets } = await apiValues(project, env, c);
        const o = { connection: netConnection(), timeoutMs: 30_000, readFile: projectFileReader(opts.repoRoot) };
        const a = await replayOnce(c, reqs, values, o), r2 = await replayOnce(c, reqs, values, o);
        const candidates = findCandidates(reqs, a.responses, r2.responses);
        const mask = (t: string) => { let out = t; for (const x of secrets.filter((s) => s && s.length >= 4)) out = out.split(x).join('••••'); return out; };
        log('api.correlate', `Replayed ${c.name} to find dynamic values`, { env, candidates: candidates.length });
        return {
            steps: r2.steps.map((x) => ({ ...x, ...(x.error ? { error: mask(x.error) } : {}) })),
            candidates: candidates.map((k) => ({ ...k, samples: k.samples.map((v) => mask(v).slice(0, 120)), to: k.to.map((t) => ({ ...t, current: mask(t.current).slice(0, 120) })) })),
        };
    });
    app.post('/api/apiws/correlate/apply', async (req) => {
        const b = body(req);
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const chosen = (Array.isArray(b.candidates) ? b.candidates : []) as CorrelationCandidate[];
        // Only well-formed choices: a request of the collection, a variable name, known places.
        const ids = new Set(allRequests(c.items).map((x) => x.request.id));
        const ok = chosen.filter((k) => k && ids.has(k.from) && /^[A-Za-z_][\w]{0,60}$/.test(String(k.variable)) && ['json', 'header', 'cookie'].includes(k.source) && typeof k.path === 'string' && k.path.length <= 300
            && Array.isArray(k.to) && k.to.every((t) => ids.has(t.request) && ['query', 'header', 'json', 'form', 'path'].includes(t.where) && typeof t.field === 'string' && t.field.length <= 300));
        if (!ok.length) throw new BadRequest('Choose the values to correlate.');
        const r = applyCandidates(c, ok, (x) => allRequests(x.items).map((y) => y.request));
        try { validCollection(r.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        return { collection: r.collection, changed: r.changed };
    });
    // ---- GraphQL: the schema by introspection (the request's URL, sign-in and headers), checks, starting operations.
    const gqlSchemas = new Map<string, GraphQLSchema>();
    const gqlSchema = (url: unknown) => { const x = gqlSchemas.get(String(url ?? '')); if (!x) throw new BadRequest('Read the schema first (Schema).'); return x; };
    app.post('/api/apiws/graphql/schema', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const r0 = (b.request ?? {}) as ApiRequest;
        try { validCollection({ ...c, items: [r0] }); } catch (e) { throw new BadRequest((e as Error).message); }
        const { values, secrets } = await apiValues(project, env, c);
        const saved = (b.saved && typeof b.saved === 'object' ? b.saved : {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(saved)) if (typeof v === 'string' && /^[\w.-]{1,100}$/.test(k)) values.vars[k] = v;
        const r: ApiRequest = { ...r0, method: 'POST', body: { mode: 'graphql', graphql: { query: INTROSPECTION_QUERY } } };
        const mask = (t: string) => maskSecrets(t, secrets);
        let p = prepare(c, r, withGlobals(values, apiGlobals.get(c.name) ?? {}), { readFile: projectFileReader(opts.repoRoot) });
        if (p.missing.length) throw new BadRequest(`Not filled in: ${p.missing.join(', ')}.`);
        try {
            p = await authorize(c, r, values, p, netConnection(), apiTokens);
            const res = await send(p, netConnection(), 30_000, apiJar(project, env, c.name));
            if (res.status >= 400 && !res.body.includes('__schema')) throw new Error(`The server answered ${res.status} ${res.statusText}.`);
            const schema = schemaOf(introspectionOf(res.body));
            gqlSchemas.set(r0.url, schema);
            return { url: r0.url, outline: gqlOutline(schema) };
        } catch (e) { throw new BadRequest(mask((e as Error).message)); }
    });
    app.post('/api/apiws/graphql/check', async (req) => {
        const b = body(req);
        return { errors: validateQuery(gqlSchema(b.url), String(b.query ?? '').slice(0, 1024 * 1024)) };
    });
    app.post('/api/apiws/graphql/operation', async (req) => {
        const b = body(req);
        const root = String(b.root);
        if (root !== 'query' && root !== 'mutation' && root !== 'subscription') throw new BadRequest('root: query, mutation or subscription.');
        try { return operationFor(gqlSchema(b.url), root, String(b.field ?? '')); } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // gRPC: the services and methods of the request's .proto file (or the server's reflection), a sample message.
    app.post('/api/apiws/grpc/describe', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const r = (b.request ?? {}) as ApiRequest;
        try { validCollection({ ...c, items: [r] }); } catch (e) { throw new BadRequest((e as Error).message); }
        const o = r.ws?.options ?? {};
        try {
            let def: Awaited<ReturnType<typeof loadProto>>;
            if (o.protoFile?.trim()) def = await loadProto(opts.repoRoot, o.protoFile.trim());
            else {
                const { values, secrets } = await apiValues(project, env, c);
                const p = prepare(c, r, values);
                if (p.missing.length) throw new BadRequest(`Not filled in: ${p.missing.join(', ')}.`);
                try {
                    const list = await grpcReflect(p.url, undefined, 15_000, netConnection(), p.headers);
                    const defs = await Promise.all(list.services.map((s) => grpcReflect(p.url, s, 15_000, netConnection(), p.headers)));
                    def = Object.assign({}, ...defs.map((d) => d.definition));
                } catch (e) { throw new BadRequest(maskSecrets((e as Error).message, secrets)); }
            }
            const services = await grpcServicesOf(def);
            const sample = o.service && o.method ? sampleMessage(def, o.service, o.method) : undefined;
            return { services, ...(sample ? { sample } : {}) };
        } catch (e) { if (e instanceof BadRequest) throw e; throw new BadRequest((e as Error).message); }
    });
    // The request in other languages (values filled; secrets shown only when asked).
    app.post('/api/apiws/snippet', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const r = (b.request ?? {}) as ApiRequest;
        try { validCollection({ ...c, items: [r] }); } catch (e) { throw new BadRequest((e as Error).message); }
        const lang = String(b.lang ?? 'curl') as SnippetLang;
        if (!SNIPPET_LANGS.some((l) => l.id === lang)) throw new BadRequest('Unknown language.');
        const { values, secrets } = await apiValues(project, env, c);
        const saved = (b.saved && typeof b.saved === 'object' ? b.saved : {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(saved)) if (typeof v === 'string' && /^[\w.-]{1,100}$/.test(k)) values.vars[k] = v;
        const p = prepare(c, r, withGlobals(values, apiGlobals.get(c.name) ?? {}), { readFile: projectFileReader(opts.repoRoot) });
        const text = snippet(lang, { method: p.method, url: p.url, headers: p.headers, body: p.body });
        return { code: b.reveal === true ? text : maskSecrets(text, secrets), missing: p.missing, masked: b.reveal !== true && secrets.some((x) => text.includes(x)), ...(p.challenge || (r.auth.type === 'inherit' ? c.auth : r.auth).type === 'oauth2' ? { note: 'The sign-in (OAuth 2.0, NTLM, Digest, Kerberos) happens when the request is sent: add it in your code.' } : {}) };
    });
    // Checks suggested from a response (no AI).
    app.post('/api/apiws/suggest', async (req) => {
        const b = body(req);
        const r = b.response as { status?: unknown; headers?: unknown; body?: unknown } | undefined;
        if (!r || typeof r.status !== 'number' || typeof r.body !== 'string') throw new BadRequest('Send the request first: suggestions come from its response.');
        return { suggestions: suggestChecks({ status: r.status, headers: (r.headers ?? {}) as Record<string, string>, body: r.body.slice(0, 2_000_000) }, Array.isArray(b.checks) ? b.checks as ApiRequest['checks'] : []) };
    });
    // A request's history from Git (by its id, through renames and moves).
    app.get('/api/apiws/request-history', async (req) => {
        const q = req.query as Record<string, string>;
        const file = str(q.file, 'file', { max: 300 });
        if (!/^test\/[A-Za-z0-9][\w.-]*\/api\/[\w.-]+\.collection\.json$/.test(file)) throw new BadRequest('Not a collection file.');
        return { changes: await requestHistory(opts.repoRoot, file, str(q.id, 'id', { max: 100 })) };
    });
    // Who is writing a comment (the Git user name of this computer).
    app.get('/api/apiws/me', async () => {
        const n = await runGit(['config', 'user.name'], { cwd: opts.repoRoot, allowFailure: true });
        return { name: n.stdout.trim() || opts.userName || 'me' };
    });
    // The flow of a collection: values passed between requests, script jumps, the feature's scenarios.
    app.post('/api/apiws/flow', async (req) => {
        const b = body(req);
        try { return collectionFlow(validCollection(b.collection)); } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // Where each value of the collection comes from (saved, collection, globals, configuration, secrets).
    app.post('/api/apiws/scopes', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const saved = Object.fromEntries(Object.entries((b.saved && typeof b.saved === 'object' ? b.saved : {}) as Record<string, unknown>).filter(([k, v]) => typeof v === 'string' && /^[\w.-]{1,100}$/.test(k))) as Record<string, string>;
        const { values, secrets } = await apiValues(project, env, c);
        const secretNames = Object.keys(secretsAsEnv(opts.store, { project: projectId, env }));
        const entries = variableScopes(c, values, saved, apiGlobals.get(c.name) ?? {}, secretNames);
        const mask = (t: string) => maskSecrets(t, secrets);
        return { env, entries: entries.map((e) => ({ ...e, value: e.value === undefined ? undefined : e.secret ? '••••••' : mask(e.value), shadowed: e.shadowed.map((x) => ({ ...x, value: e.secret ? '••••••' : mask(x.value) })) })) };
    });
    app.post('/api/apiws/globals/clear', async (req) => { const b = body(req); apiGlobals.delete(String(b.collection ?? '')); return { ok: true }; });
    app.post('/api/apiws/send', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const r0 = (b.request ?? {}) as ApiRequest;
        try { validCollection({ ...c, items: [r0] }); } catch (e) { throw new BadRequest((e as Error).message); }
        const saved = (b.saved && typeof b.saved === 'object' ? b.saved : {}) as Record<string, unknown>;
        const { values, secrets } = await apiValues(project, env, c);
        for (const [k, v] of Object.entries(saved)) if (typeof v === 'string' && /^[\w.-]{1,100}$/.test(k)) values.vars[k] = v;
        // A test data row (the scenario's <column> values), when the request runs over a data file.
        if (b.row && typeof b.row === 'object') values.row = Object.fromEntries(Object.entries(b.row as Record<string, unknown>).filter(([k]) => /^[\w .-]{1,100}$/.test(k)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v ?? '')]));
        const queryRows = apiQueryRows(project, env);
        let preparedNotes: string[] = [];
        try { preparedNotes = await prepareValues(r0.prepare, values, queryRows); }
        catch (e) { return { prepared: { method: r0.method, url: r0.url, headers: {}, missing: [] }, error: maskSecrets((e as Error).message, secrets) }; }
        values.readFile = projectFileReader(opts.repoRoot);
        // Scripts (pm API): globals per collection for the session; what they set is returned as saved values.
        const globals = apiGlobals.get(c.name) ?? {};
        apiGlobals.set(c.name, globals);
        const sender = scriptSender((p) => send(p, netConnection(), 30_000));
        const varsBefore = { ...values.vars };
        const pre = await runPreScripts(c, r0, values, globals, sender);
        const scriptLogs = [...pre.logs];
        if (pre.error) return { prepared: { method: r0.method, url: r0.url, headers: {}, missing: [] }, error: maskSecrets(pre.error, secrets), logs: scriptLogs.map((l) => ({ ...l, text: maskSecrets(l.text, secrets) })) };
        if (pre.skip) return { prepared: { method: r0.method, url: r0.url, headers: {}, missing: [] }, error: 'The pre-request script skipped this request (pm.execution.skipRequest).', logs: scriptLogs };
        const r = pre.request;
        let prepared = prepare(c, r, withGlobals(values, globals), { readFile: values.readFile });
        const mask = (t: string) => maskSecrets(t, secrets);
        const bodyText = (b: string | Buffer | undefined) => (b === undefined ? undefined : typeof b === 'string' ? mask(b) : mask(b.toString('latin1').replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, '·').slice(0, 20_000)));
        try { prepared = await authorize(c, r, values, prepared, netConnection(), apiTokens); }
        catch (e) { return { prepared: { method: prepared.method, url: mask(prepared.url), headers: {}, missing: prepared.missing }, error: mask((e as Error).message) }; }
        const shown = { method: prepared.method, url: mask(prepared.url), headers: Object.fromEntries(Object.entries(prepared.headers).map(([k, v]) => [k, mask(v)])), body: bodyText(prepared.body), missing: prepared.missing };
        if (r.ws) { shown.method = PROTOCOL_LABEL[r.ws.protocol ?? 'websocket']; shown.url = mask(redactUrl(r.ws.protocol && r.ws.protocol !== 'websocket' ? prepared.url : wsUrl(prepared.url))); delete shown.body; }
        if (prepared.missing.length) {
            // The fix depends on what is missing: a value (variables, settings, secrets), a file, the token.
            const hints = [
                prepared.missing.some((m) => /^\{/.test(m)) ? 'Add the variable, the setting (Environments) or the secret (Secrets).' : '',
                prepared.missing.some((m) => m.startsWith('the file ')) ? 'A file part is read from the project folder: give its path inside the project (for example test/shop/data/a.pdf).' : '',
                prepared.missing.some((m) => m.startsWith('the bearer token')) ? 'Fill in the token under Auth (of the request or the collection), or remove the authentication.' : '',
            ].filter(Boolean).join(' ');
            return { prepared: shown, error: `Not filled in: ${prepared.missing.join(', ')}. ${hints}`.trim() };
        }
        // A body that is not valid JSON: GraphQL variables cannot be sent that way; a JSON body is sent as written, with a note.
        if (!r.ws && (r.body.mode === 'graphql' || r.body.mode === 'json') && typeof prepared.body === 'string' && prepared.body.trim()) {
            try { JSON.parse(prepared.body); } catch (e) {
                const why = (e as Error).message.replace(/^JSON\.parse: |^Unexpected token/, (m) => (m.startsWith('Unexpected') ? m : ''));
                if (r.body.mode === 'graphql') return { prepared: shown, error: `The GraphQL variables are not valid JSON (${why}). Fix them under Body → Variables, for example {"first": 10}.` };
                preparedNotes.push(`The JSON body is not valid JSON (${why}); it was sent as written.`);
            }
        }
        let res: ApiResponse;
        let checks: CheckResult[], extracted: ReturnType<typeof extract>;
        let visualizer: string | undefined;
        if (r.ws) {
            const w = wsAsResponse(await runExchange(r.ws, prepared, values, 30_000, netConnection(), opts.repoRoot, { environment: env }), r.ws.steps, PROTOCOL_LABEL[r.ws.protocol ?? 'websocket']);
            res = w.response; checks = w.checks; extracted = w.extracted;
        } else {
            const jar = apiJar(project, env, c.name);
            const fromJar = jar.header(prepared.url);
            if (fromJar) (shown.headers as Record<string, string>)['Cookie (kept)'] = mask(fromJar);
            const sentAt = Date.now();
            try { res = await sendWith(prepared, r.settings, netConnection(), undefined, jar); }
            catch (e) {
                // Kept in History too: a request that could not connect or timed out was still sent.
                const error = mask((e as Error).message);
                try {
                    let h: unknown[] = [];
                    try { h = JSON.parse(fs.readFileSync(apiHistoryFile, 'utf8')); } catch { /* none yet */ }
                    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
                    h.unshift({ id, at: new Date().toISOString(), project, env, collection: c.name, file: typeof b.file === 'string' ? b.file : undefined, requestId: r.id, request: r.name, method: r.method, url: shown.url, status: 0, timeMs: Date.now() - sentAt, passed: 0, checks: r.checks.length, error });
                    fs.mkdirSync(apiHistoryDir, { recursive: true });
                    fs.writeFileSync(apiHistoryFile, JSON.stringify(h.slice(0, 200)));
                    fs.writeFileSync(path.join(apiHistoryDir, `${id}.json`), JSON.stringify({ def: r0, sent: { ...shown, body: shown.body && shown.body.length > 100_000 ? `${shown.body.slice(0, 100_000)}\n… (cut)` : shown.body }, error }));
                } catch { /* history is best effort */ }
                return { prepared: shown, error };
            }
            // Values saved first: checks may compare with them ({{name}}).
            extracted = extract(r.extract, res);
            for (const x of extracted) if (x.found && x.value !== undefined) values.vars[x.variable] = x.value;
            checks = await evaluateAll(r.checks, res, values, queryRows);
            const t = await runTestScripts(c, r, prepared, res, values, globals, sender);
            checks = [...checks, ...t.checks];
            scriptLogs.push(...t.logs);
            if (t.visualizer) visualizer = mask(renderVisualizer(t.visualizer));
        }
        // What the scripts set (and the saved values): sent back so the next Send sees them.
        const scriptVars = Object.fromEntries(Object.entries(values.vars).filter(([k, v]) => varsBefore[k] !== v && !extracted.some((x) => x.variable === k)));
        // History (this computer only; secrets masked).
        try {
            let h: unknown[] = [];
            try { h = JSON.parse(fs.readFileSync(apiHistoryFile, 'utf8')); } catch { /* none yet */ }
            const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
            h.unshift({ id, at: new Date().toISOString(), project, env, collection: c.name, file: typeof b.file === 'string' ? b.file : undefined, requestId: r.id, request: r.name, method: r.method, url: shown.url, status: res.status, timeMs: res.timeMs, passed: checks.filter((x) => x.pass).length, checks: checks.length });
            fs.mkdirSync(apiHistoryDir, { recursive: true });
            fs.writeFileSync(apiHistoryFile, JSON.stringify(h.slice(0, 200)));
            // The whole exchange (the request as defined, what was sent, the response; secrets masked, bodies cut at 100 KB).
            const cut = (t?: string) => (t === undefined ? undefined : t.length > 100_000 ? `${t.slice(0, 100_000)}\n… (cut)` : t);
            fs.writeFileSync(path.join(apiHistoryDir, `${id}.json`), JSON.stringify({ def: r0, sent: { ...shown, body: cut(shown.body) },
                response: { status: res.status, statusText: res.statusText, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, mask(v)])), body: res.bodyBase64 ? '' : cut(mask(res.body)), truncated: res.truncated || res.body.length > 100_000, size: res.size, timeMs: res.timeMs, redirects: res.redirects, ...(res.timings ? { timings: res.timings } : {}), ...(res.tls ? { tls: res.tls } : {}), ...(res.remote ? { remote: res.remote } : {}) },
                checks: checks.map((x) => ({ pass: x.pass, message: mask(x.message), ...(x.actual !== undefined ? { actual: mask(x.actual) } : {}) })) }));
            const keep = new Set((h.slice(0, 200) as Array<{ id?: string }>).map((x) => `${x.id}.json`));
            for (const f of fs.readdirSync(apiHistoryDir)) if (!keep.has(f)) fs.rmSync(path.join(apiHistoryDir, f), { force: true });
        } catch { /* history is best effort */ }
        return {
            prepared: shown,
            response: { ...res, body: mask(res.body), headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, mask(v)])), json: undefined },
            checks: checks.map((x) => ({ ...x, actual: x.actual === undefined ? undefined : mask(x.actual), message: mask(x.message) })),
            extracted: extracted.map((x) => ({ ...x })),
            cookies: r.ws ? [] : cookieView(apiJar(project, env, c.name), mask),
            ...(preparedNotes.length ? { notes: preparedNotes.map(mask) } : {}),
            ...(scriptLogs.length ? { logs: scriptLogs.map((l) => ({ ...l, text: mask(l.text) })) } : {}),
            ...(visualizer ? { visualizer } : {}),
            ...(Object.keys(scriptVars).length ? { scriptVars } : {}),
        };
    });
    const cookieView = (j: CookieJar, mask: (t: string) => string) => j.list().map((x) => ({ name: x.name, value: mask(x.value), domain: x.domain, path: x.path, secure: x.secure, httpOnly: x.httpOnly, expires: x.expires ? new Date(x.expires).toISOString() : null }));
    /** The cookies Send keeps for a collection (project / environment); remove one or all. Values of secrets masked. */
    const jarOf = async (q: Record<string, string>) => {
        const project = apiProject(q.project);
        const env = q.env ? envParam(q.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const collection = str(q.collection, 'collection', { max: 200 });
        const { secrets } = await apiValues(project, env, { ...newCollection(collection) });
        return { jar: apiJar(project, env, collection), mask: (t: string) => maskSecrets(t, secrets) };
    };
    app.get('/api/apiws/cookies', async (req) => { const { jar, mask } = await jarOf(req.query as Record<string, string>); return { cookies: cookieView(jar, mask) }; });
    app.delete('/api/apiws/cookies', async (req) => {
        const q = req.query as Record<string, string>;
        const { jar, mask } = await jarOf(q);
        if (q.name) jar.remove(str(q.name, 'name', { max: 200 }), q.domain || undefined); else jar.clear();
        return { cookies: cookieView(jar, mask) };
    });
    app.get('/api/apiws/history', async () => { try { return { items: JSON.parse(fs.readFileSync(apiHistoryFile, 'utf8')) }; } catch { return { items: [] }; } });
    app.get('/api/apiws/history/:id', async (req) => {
        const id = String((req.params as { id: string }).id);
        if (!/^[a-z0-9]{6,40}$/.test(id)) throw new BadRequest('No such entry.');
        try { return JSON.parse(fs.readFileSync(path.join(apiHistoryDir, `${id}.json`), 'utf8')); } catch { throw new BadRequest('This entry has no details (sent before the Studio kept them, or cleared).'); }
    });
    app.delete('/api/apiws/history', async (req) => {
        if ((req.query as Record<string, string>).confirm !== 'true') throw new BadRequest('Confirm clearing the history.');
        fs.rmSync(apiHistoryFile, { force: true });
        fs.rmSync(apiHistoryDir, { recursive: true, force: true });
        return { ok: true };
    });
    // Collection runner (background); finished runs kept on this computer (the last 50, in the repository's .git).
    const apiRunner = new CollectionRunner();
    const apiRunsDir = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'api-runs');
    const keepRun = (j: RunnerJob) => {
        fs.mkdirSync(apiRunsDir, { recursive: true });
        fs.writeFileSync(path.join(apiRunsDir, `${j.id}.json`), JSON.stringify(j));
        const files = fs.readdirSync(apiRunsDir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: fs.statSync(path.join(apiRunsDir, f)).mtimeMs })).sort((x, y) => y.t - x.t);
        for (const x of files.slice(50)) fs.rmSync(path.join(apiRunsDir, x.f), { force: true });
    };
    const keptRun = (id: string): RunnerJob | null => { if (!/^[a-z0-9]+$/.test(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(apiRunsDir, `${id}.json`), 'utf8')); } catch { return null; } };
    const keptRuns = () => { try { return fs.readdirSync(apiRunsDir).filter((f) => f.endsWith('.json')).map((f) => { try { const { steps: _s, ...j } = JSON.parse(fs.readFileSync(path.join(apiRunsDir, f), 'utf8')) as RunnerJob; return j; } catch { return null; } }).filter((x): x is Omit<RunnerJob, 'steps'> => !!x); } catch { return []; } };
    /**
     * A query of the API checks and prepared data: a DB_QUERY_<name> of the project (or SQL) on a
     * connection, read only, its rows as the framework's adapters give them (dates as dates).
     */
    const apiQueryRows = (project: string, env: string): QueryRows => async (connection, query, params, fallbackSql) => {
        const q = query.trim();
        const sql = /\s/.test(q) ? q : dbValues(project, env)[`DB_QUERY_${q.replace(/^DB_QUERY_/i, '')}`] ?? fallbackSql?.trim();
        if (!sql) throw new Error(`DB_QUERY_${q.replace(/^DB_QUERY_/i, '')} is not in the configuration of ${project} (${env}).`);
        if (!connection.trim()) throw new Error(`No database connection for ${q}.`);
        const r = await dbSessions.request<{ columns: Array<{ name: string }>; rows: unknown[][] }>(project, env,
            { op: 'query', alias: connection.trim(), sql, params: params.map((p) => (p instanceof Date ? p.toISOString() : typeof p === 'object' && p !== null ? JSON.stringify(p) : String(p ?? ''))), maxRows: 10_000, timeoutMs: 60_000, mode: 'read' }, dbDeadline(60_000));
        return r.rows.map((cells) => Object.fromEntries(r.columns.map((col, i) => [col.name, fromCell(cells[i])])));
    };
    app.post('/api/apiws/runs', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const ids = Array.isArray(b.requests) ? (b.requests as unknown[]).map(String) : [];
        const all = allRequests(c.items).map((x) => x.request);
        const requests = ids.length ? ids.map((id) => all.find((r) => r.id === id)).filter((r): r is ApiRequest => !!r) : all;
        if (!requests.length) throw new BadRequest('No requests to run.');
        let rows: Array<Record<string, string>> = [];
        if (b.data !== undefined && b.data !== null) {
            try { rows = await dataRowsFor(project, env, b.data); } catch (e) { throw new BadRequest((e as Error).message.split('\n').slice(0, 4).join('\n')); }
            if (!rows.length) throw new BadRequest('The test data has no rows.');
        } else if (b.dataFile) {
            const rel = str(b.dataFile, 'dataFile', { max: 300 });
            try { rows = parseCsv(projectFileReader(opts.repoRoot)(rel).toString('utf8')).rows; } catch (e) { throw new BadRequest(`The data file ${rel} cannot be read: ${(e as Error).message}`); }
            if (!rows.length) throw new BadRequest(`The data file ${rel} has no rows.`);
        } else {
            // The test data of the requests (as the feature's Examples read it): its rows, filtered.
            const d = requests.find((r) => r.data?.source?.trim())?.data;
            if (d) {
                try { rows = filterRows(await dataRowsFor(project, env, { kind: 'file', file: d.source.trim(), sheet: d.sheet, path: d.type === 'json' ? d.path || '$' : undefined }), d.filter); }
                catch (e) { throw new BadRequest((e as Error).message.split('\n').slice(0, 4).join('\n')); }
                if (!rows.length) throw new BadRequest(`${d.source} has no rows${d.filter ? ` for ${d.filter}` : ''}.`);
            }
        }
        // Whole numbers in range, or refused (2.5 iterations is not run as 3, a delay is not cut silently).
        const iterations = wholeParam(b.iterations, 'Iterations', 1, 1000, 1);
        const delayMs = wholeParam(b.delayMs, 'Delay (ms)', 0, 60_000, 0);
        const job = await startCollectionRun({ c, file: typeof b.file === 'string' ? b.file : '', project, env, requests, rows, iterations, delayMs, stopOnFailure: b.stopOnFailure === true });
        log('api.run', `Ran the API collection ${c.name} (${job.total} requests)`, { env });
        return job;
    });
    async function startCollectionRun(x: { c: ApiCollection; file: string; project: string; env: string; requests: ApiRequest[]; rows: Array<Record<string, string>>; iterations: number; delayMs: number; stopOnFailure: boolean; onDone?: (j: RunnerJob) => void }): Promise<RunnerJob> {
        const { values, secrets } = await apiValues(x.project, x.env, x.c);
        return apiRunner.start({ collection: x.c, file: x.file, project: x.project, env: x.env, requests: x.requests, values, rows: x.rows, queryRows: apiQueryRows(x.project, x.env),
            iterations: x.iterations, delayMs: x.delayMs, stopOnFailure: x.stopOnFailure,
            timeoutMs: 30_000, connection: netConnection(), readFile: projectFileReader(opts.repoRoot), projectRoot: opts.repoRoot, environment: x.env, mask: (t) => maskSecrets(t, secrets), onDone: (j) => { keepRun(j); x.onDone?.(j); } });
    }
    // ---- Monitors: a collection run on a schedule while the Studio is open (this computer), with an alert when it
    // fails or recovers (a Teams / Slack incoming webhook, its address kept as a Studio secret). Pipelines with a
    // schedule (Run it in a pipeline) are the same without the Studio.
    interface Monitor { id: string; name: string; file: string; env: string; everyMinutes: number; enabled: boolean; webhookSecret?: string; alertOn: 'failure' | 'change'; last?: { at: string; runId: string; passed: boolean; failed: number; requests: number; alert?: string } }
    const monitorsFile = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'api-monitors.json');
    const readMonitors = (): Monitor[] => { try { return JSON.parse(fs.readFileSync(monitorsFile, 'utf8')); } catch { return []; } };
    const writeMonitors = (m: Monitor[]) => { fs.mkdirSync(path.dirname(monitorsFile), { recursive: true }); fs.writeFileSync(monitorsFile, JSON.stringify(m, null, 2)); };
    const monitorBusy = new Set<string>();
    const runMonitor = async (m: Monitor): Promise<RunnerJob> => {
        const c = readCollection(opts.repoRoot, m.file);
        const project = m.file.split('/')[1];
        monitorBusy.add(m.id);
        const before = m.last?.passed;
        return startCollectionRun({ c, file: m.file, project, env: m.env, requests: allRequests(c.items).map((x) => x.request), rows: [], iterations: 1, delayMs: 0, stopOnFailure: false, onDone: (j) => {
            monitorBusy.delete(m.id);
            const passed = j.summary.failed === 0 && j.summary.requests > 0;
            const last: NonNullable<Monitor['last']> = { at: j.endedAt ?? new Date().toISOString(), runId: j.id, passed, failed: j.summary.failed, requests: j.summary.requests };
            const send = m.webhookSecret && (m.alertOn === 'failure' ? !passed : before !== undefined && before !== passed);
            const save = (extra: Partial<NonNullable<Monitor['last']>> = {}) => writeMonitors(readMonitors().map((x) => (x.id === m.id ? { ...x, last: { ...last, ...extra } } : x)));
            save();
            if (!send) return;
            const url = secretsAsEnv(opts.store, { project: projectId, env: m.env })[m.webhookSecret!];
            if (!url) { save({ alert: `No Studio secret ${m.webhookSecret} for the alert.` }); return; }
            const failedNames = [...new Set(j.steps.filter((s) => !s.passed).map((s) => s.name))].slice(0, 10);
            const text = passed ? `✅ ${m.name} recovered: ${j.summary.passed}/${j.summary.requests} requests passed (${m.env}).` : `❌ ${m.name} failed: ${j.summary.failed} of ${j.summary.requests} requests (${m.env}). ${failedNames.join(', ')}`;
            void send0(url, text).then((r) => save({ alert: r })).catch((e) => save({ alert: `The alert was not sent: ${(e as Error).message}` }));
        } });
    };
    const send0 = async (url: string, text: string) => {
        const r = await send({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), missing: [] }, netConnection(), 15_000);
        return r.status < 300 ? `Alert sent (${r.status}).` : `The alert was refused: ${r.status} ${r.statusText}.`;
    };
    const monitorTimer = setInterval(() => {
        const now = Date.now();
        for (const m of readMonitors()) {
            if (!m.enabled || monitorBusy.has(m.id)) continue;
            const lastAt = m.last ? Date.parse(m.last.at) : 0;
            if (now - lastAt >= m.everyMinutes * 60_000) void runMonitor(m).catch((e) => writeMonitors(readMonitors().map((x) => (x.id === m.id ? { ...x, last: { at: new Date().toISOString(), runId: '', passed: false, failed: 0, requests: 0, alert: (e as Error).message } } : x))));
        }
    }, Number(process.env.CS_STUDIO_MONITOR_TICK_MS) || 30_000);
    monitorTimer.unref();
    app.addHook('onClose', async () => clearInterval(monitorTimer));
    app.get('/api/apiws/monitors', async () => ({ monitors: readMonitors() }));
    app.put('/api/apiws/monitors', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 300 });
        try { readCollection(opts.repoRoot, file); } catch (e) { throw new BadRequest((e as Error).message); }
        const every = wholeParam(b.everyMinutes, 'Every (minutes)', 5, 7 * 24 * 60);
        const wh = typeof b.webhookSecret === 'string' && b.webhookSecret.trim() ? b.webhookSecret.trim() : undefined;
        if (wh && !/^[A-Za-z_][\w]{0,100}$/.test(wh)) throw new BadRequest('The alert is the name of a Studio secret (its value is the webhook address).');
        const list = readMonitors();
        const id = typeof b.id === 'string' && list.some((x) => x.id === b.id) ? b.id : Date.now().toString(36);
        const prev = list.find((x) => x.id === id);
        // A new monitor needs a name the person gave it (none is taken silently from the collection); an old nameless one can still be switched on or off.
        if ((typeof b.name !== 'string' || !b.name.trim()) && !(prev && !prev.name.trim())) throw new BadRequest('Give the monitor a name.');
        const m: Monitor = { id, name: str(b.name, 'name', { max: 120 }).trim(), file, env: b.env ? envParam(b.env) : 'dev', everyMinutes: every, enabled: b.enabled !== false, alertOn: b.alertOn === 'change' ? 'change' : 'failure', ...(wh ? { webhookSecret: wh } : {}), ...(prev?.last ? { last: prev.last } : {}) };
        writeMonitors(prev ? list.map((x) => (x.id === id ? m : x)) : [...list, m]);
        return m;
    });
    app.delete('/api/apiws/monitors/:id', async (req) => { const id = String((req.params as { id: string }).id); writeMonitors(readMonitors().filter((x) => x.id !== id)); return { ok: true }; });
    app.post('/api/apiws/monitors/:id/run', async (req) => {
        const m = readMonitors().find((x) => x.id === String((req.params as { id: string }).id));
        if (!m) throw new BadRequest('No such monitor.');
        if (monitorBusy.has(m.id)) throw new BadRequest('It is running.');
        try { return await runMonitor(m); } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.get('/api/apiws/monitors/:id/runs', async (req) => {
        const m = readMonitors().find((x) => x.id === String((req.params as { id: string }).id));
        if (!m) throw new BadRequest('No such monitor.');
        return { runs: keptRuns().filter((j) => j.collection === m.file && j.env === m.env).sort((x, y) => y.startedAt.localeCompare(x.startedAt)) };
    });
    app.get('/api/apiws/runs', async () => {
        const live = apiRunner.list().map(({ steps: _s, ...j }) => j);
        const ids = new Set(live.map((j) => j.id));
        return { runs: [...live, ...keptRuns().filter((j) => !ids.has(j.id))].sort((x, y) => y.startedAt.localeCompare(x.startedAt)) };
    });
    const runById = (id: string) => apiRunner.get(id) ?? keptRun(id);
    app.get('/api/apiws/runs/compare', async (req) => {
        const q = req.query as Record<string, string>;
        const a = runById(str(q.a, 'a', { max: 40 })), b = runById(str(q.b, 'b', { max: 40 }));
        if (!a || !b) throw new BadRequest('No such run.');
        return compareRuns(a, b);
    });
    app.get('/api/apiws/runs/:id', async (req) => { const j = runById(str((req.params as { id: string }).id, 'id', { max: 40 })); if (!j) throw new BadRequest('No such run (the last 50 runs are kept).'); return j; });
    app.delete('/api/apiws/runs/:id', async (req) => {
        const id = str((req.params as { id: string }).id, 'id', { max: 40 });
        if (!/^[a-z0-9]+$/.test(id)) throw new BadRequest('No such run.');
        fs.rmSync(path.join(apiRunsDir, `${id}.json`), { force: true });
        return { ok: true };
    });
    app.post('/api/apiws/runs/:id/stop', async (req) => ({ stopped: apiRunner.stop(str((req.params as { id: string }).id, 'id', { max: 40 })) }));
    app.get('/api/apiws/runs/:id/report', async (req, reply) => {
        const j = runById(str((req.params as { id: string }).id, 'id', { max: 40 }));
        if (!j) throw new BadRequest('No such run.');
        const format = (req.query as Record<string, string>).format ?? 'html';
        if (format === 'junit') return reply.type('application/xml; charset=utf-8').header('Content-Disposition', `attachment; filename="api-run-${j.id}.xml"`).send(runnerJUnit(j));
        if (format === 'json') return reply.type('application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="api-run-${j.id}.json"`).send(JSON.stringify(j, null, 2));
        return reply.type('text/html; charset=utf-8').header('Content-Disposition', `attachment; filename="api-run-${j.id}.html"`).send(runnerReport(j));
    });
    // Documentation of a collection: an HTML page or Markdown to download, or a page of the Azure DevOps wiki.
    app.get('/api/apiws/docs', async (req, reply) => {
        const q = req.query as Record<string, string>;
        const file = str(q.file, 'file', { max: 300 });
        let c: ApiCollection;
        try { c = readCollection(opts.repoRoot, file); } catch (e) { throw new BadRequest((e as Error).message); }
        if (q.format === 'md') return reply.type('text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="${slug(c.name)}.md"`).send(collectionMarkdown(c));
        return reply.type('text/html; charset=utf-8').header('Content-Disposition', `attachment; filename="${slug(c.name)}.html"`).send(collectionHtml(c));
    });
    app.post('/api/apiws/docs/wiki', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 300 });
        let c: ApiCollection;
        try { c = readCollection(opts.repoRoot, file); } catch (e) { throw new BadRequest((e as Error).message); }
        const project = file.split('/')[1];
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const page = typeof b.path === 'string' && b.path.trim() ? b.path.trim().slice(0, 200) : `API/${c.name}`;
        if (/\.\.|[<>*?|"]/.test(page)) throw new BadRequest('A wiki page path such as API/Orders.');
        try {
            const r = await adoClient(project, env).putWikiPage(page, collectionMarkdown(c), typeof b.wiki === 'string' && b.wiki.trim() ? b.wiki.trim() : undefined);
            log('api.docs', `Published the documentation of ${c.name} to the wiki page ${page}`);
            return { ...r, page };
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // An Azure DevOps pipeline that runs a collection (preview; saved in the project when asked).
    app.post('/api/apiws/pipeline', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 300 });
        let c: ApiCollection;
        try { c = readCollection(opts.repoRoot, file); } catch (e) { throw new BadRequest((e as Error).message); }
        const project = file.split('/')[1];
        const envs = discover(opts.repoRoot).environments[project] ?? [];
        // The secrets it reads: {env:NAME} anywhere in the collection.
        const secretNames = [...new Set([...JSON.stringify(c).matchAll(/\{env:([A-Za-z_][\w]*)\}/g)].map((m) => m[1]))];
        const schedule = typeof b.schedule === 'string' && b.schedule.trim() ? b.schedule.trim() : undefined;
        if (schedule && !/^[\d*/,-]+( [\d*/,-]+){4}$/.test(schedule)) throw new BadRequest('The schedule is a cron line of five fields, e.g. 0 6 * * 1-5.');
        const group = typeof b.variableGroup === 'string' && b.variableGroup.trim() ? b.variableGroup.trim().slice(0, 120) : undefined;
        const yamlText = collectionPipeline(file, { name: c.name, envs, variableGroup: group, schedule, secretNames, branch: typeof b.branch === 'string' && /^[\w./-]{1,100}$/.test(b.branch) ? b.branch : undefined });
        const target = `test/${project}/pipelines/${slug(c.name)}.api-pipeline.yml`;
        if (b.save === true) {
            const abs = safePath(opts.repoRoot, target);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, yamlText);
            log('api.pipeline', `Wrote the pipeline ${target} for ${c.name}`);
        }
        return { yaml: yamlText, file: target, secretNames, saved: b.save === true };
    });
    app.post('/api/apiws/export', async (req) => {
        const b = body(req);
        // With the project's payload and schema files (read for the export), and what the format cannot carry over.
        const reader = projectFileReader(opts.repoRoot);
        const readText = (rel: string) => { try { return reader(rel).toString('utf8'); } catch { return undefined; } };
        try { return exportReport(validCollection(b.collection), { readFile: readText }); } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/apiws/import', async (req) => {
        const b = body(req);
        const kind = str(b.kind, 'kind', { max: 20 });
        // A description read from its address (a service's ?wsdl, an OpenAPI URL), through the network settings.
        let fromUrl: string | undefined;
        if ((kind === 'wsdl' || kind === 'openapi') && typeof b.url === 'string' && b.url.trim()) {
            fromUrl = b.url.trim();
            if (!/^https?:\/\//i.test(fromUrl)) throw new BadRequest('The address starts with http:// or https://.');
            const res = await send({ method: 'GET', url: fromUrl, headers: { Accept: 'application/xml, application/json, text/yaml, */*' }, missing: [] }, netConnection(), 30_000);
            if (res.status >= 400) throw new BadRequest(`${fromUrl} answered ${res.status} ${res.statusText}.`);
            b.text = res.body;
        }
        const text = str(b.text, 'text', { max: 20 * 1024 * 1024 });
        try {
            if (kind === 'curl') return parseCurl(text);
            if (kind === 'openapi') return importOpenApi(text);
            if (kind === 'wsdl') return importWsdl(text, { url: fromUrl });
            // Other tools' files, by their content (or as named).
            if (kind === 'other' || ['insomnia', 'soapui', 'jmeter', 'raml', 'asyncapi', 'graphql'].includes(kind)) {
                const k = kind === 'other' ? detectImport(text) : kind;
                if (k === 'insomnia') return { ...importInsomnia(JSON.parse(text)), format: 'Insomnia' };
                if (k === 'soapui') return { ...importSoapUi(text), format: 'SoapUI / ReadyAPI' };
                if (k === 'jmeter') return { ...importJmeter(text), format: 'JMeter' };
                if (k === 'raml') return { ...importRaml(text), format: 'RAML' };
                if (k === 'asyncapi') return { ...importAsyncApi(text), format: 'AsyncAPI' };
                if (k === 'graphql') return { ...importGraphqlSchema(text), format: 'GraphQL schema' };
                if (k === 'wsdl') { const r = importWsdl(text); return { collection: r.collection, report: { requests: r.report.operations, folders: 0, warnings: r.report.warnings }, format: 'WSDL' }; }
                if (k === 'openapi') { const r = importOpenApi(text); return { collection: r.collection, report: { requests: r.report.operations, folders: r.report.folders, warnings: r.report.warnings }, format: 'OpenAPI' }; }
                throw new Error(k ? `This is a ${k === 'postman' ? 'Postman collection' : k.toUpperCase()} file: use its own import.` : 'The format of this file is not recognised (Insomnia, SoapUI, JMeter, RAML, AsyncAPI, GraphQL schema, WSDL, OpenAPI).');
            }
            if (kind === 'har') {
                const hosts = Array.isArray(b.hosts) ? (b.hosts as unknown[]).filter((h): h is string => typeof h === 'string').slice(0, 100) : undefined;
                const skipCorrelations = Array.isArray(b.skipCorrelations) ? (b.skipCorrelations as unknown[]).filter((h): h is string => typeof h === 'string').slice(0, 500) : undefined;
                return importHar(text, { hosts, skipCorrelations, name: typeof b.name === 'string' ? b.name.slice(0, 200) : undefined });
            }
            if (kind === 'collection') {
                const env = b.environment ? JSON.parse(str(b.environment, 'environment', { max: 5 * 1024 * 1024 })) : undefined;
                return importCollection(JSON.parse(text), env);
            }
        } catch (e) { throw new BadRequest((e as Error).message); }
        throw new BadRequest('Unknown import.');
    });
    app.post('/api/apiws/feature', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        let c: ApiCollection;
        try { c = validCollection(b.collection); } catch (e) { throw new BadRequest((e as Error).message); }
        const folder = projectFeatureFolder(opts.repoRoot, project) ?? `test/${project}/features`;
        // Through the framework core: every line checked against the steps the project loads.
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const model = projectModel(project, env);
        const config = dbValues(project, env);
        // The columns of the data files the scenarios run over (to fill payload templates from the row).
        const columns = new Map<string, string[]>();
        for (const { request } of allRequests(c.items)) {
            const d = request.data;
            if (!d?.source?.trim() || columns.has(d.source)) continue;
            try { columns.set(d.source, (await loadDataRows({ repoRoot: opts.repoRoot, project, environment: env, source: { kind: 'file', file: d.source.trim(), sheet: d.sheet, path: d.type === 'json' ? d.path || '$' : undefined }, secretEnv: dbSecretEnv(project, env), sessions: dbSessions, connection: netConnection(), timeoutMs: 60_000 })).columns); }
            catch { columns.set(d.source, []); }
        }
        const readRepo = (rel: string): string | null => { try { return fs.readFileSync(path.join(opts.repoRoot, rel), 'utf8'); } catch { return null; } };
        const plan = apiTestPlan(c, {
            project, featureFolder: folder, stepsFolder: model.stepsFolder, pkg: frameworkPackageName(opts.repoRoot), read: readRepo, config,
            columns: (d) => columns.get(d.source) ?? [],
            templateVars: (f) => { const t = readRepo(`${(config.PAYLOAD_BASE_PATH || 'test-data/payloads').replace(/\/+$/, '')}/${f}`); return t ? templateNames(t) : []; },
            fileExists: (f) => [f, `${(config.PAYLOAD_BASE_PATH || 'test-data/payloads').replace(/\/+$/, '')}/${f}`].some((x) => { try { return fs.statSync(safePath(opts.repoRoot, x)).isFile(); } catch { return false; } }),
            // WebSocket requests as steps when the project's framework has them.
            wsSteps: (() => { const d = frameworkPackage(opts.repoRoot)?.dir; return !!d && fs.existsSync(path.join(d, 'dist', 'steps', 'api', 'CSWebSocketSteps.js')); })(),
            msgSteps: (() => { const d = frameworkPackage(opts.repoRoot)?.dir; return !!d && fs.existsSync(path.join(d, 'dist', 'steps', 'api', 'CSMessagingSteps.js')); })(),
        });
        const r = { text: plan.text, warnings: plan.warnings, scenarios: plan.scenarios };
        const file = plan.feature;
        const abs = path.join(opts.repoRoot, file);
        const exists = fs.existsSync(abs);
        const change: ChangePlan = { title: `Test from the API collection "${c.name}"`, files: plan.files, warnings: r.warnings };
        if (b.save !== true) return { file, exists, text: r.text, warnings: r.warnings, scenarios: r.scenarios, current: exists ? fs.readFileSync(abs, 'utf8') : undefined, review: await reviewOf(change, model) };
        if (exists && b.overwrite !== true && !b.baseHashes) throw new BadRequest(`${file} already exists.`);
        const applied = applyOf(change, model, b);
        log('api.feature', `Wrote ${file} from the API collection ${c.name}`, { file, scenarios: r.scenarios, ...(applied.recoveryDir ? { recoveryDir: relPath(applied.recoveryDir) } : {}) });
        return { file, exists: true, text: r.text, warnings: r.warnings, scenarios: r.scenarios };
    });

    // ---- Performance: load scenarios (in the project) and load runs (worker thread, results kept here).
    const loadRuns = new LoadRuns(path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'load-runs'), path.join(__dirname, '..', 'load', 'worker.js'));
    app.get('/api/load/scenarios', async () => {
        const found = discover(opts.repoRoot);
        const scenarios: Array<{ project: string; file: string; name: string; collection: string; users: number; duration: number }> = [];
        for (const project of found.projects) {
            let names: string[] = [];
            try { names = fs.readdirSync(path.join(opts.repoRoot, 'test', project, 'load')).filter((f) => f.endsWith('.load.json')); } catch { continue; }
            for (const n of names) {
                const file = `test/${project}/load/${n}`;
                try { const sc = validScenario(JSON.parse(fs.readFileSync(path.join(opts.repoRoot, file), 'utf8'))); scenarios.push({ project, file, name: sc.name, collection: sc.collection, users: maxUsers(sc.policy), duration: sc.policy.duration }); } catch { /* not valid: skipped */ }
            }
        }
        const browserPaths: Array<{ project: string; file: string; name: string; startUrl: string; actions: number }> = [];
        for (const project of found.projects) {
            let names: string[] = [];
            try { names = fs.readdirSync(path.join(opts.repoRoot, 'test', project, 'load')).filter((f) => f.endsWith('.browser.json')); } catch { continue; }
            for (const n of names) { const file = `test/${project}/load/${n}`; try { const d = readBrowserPath(opts.repoRoot, file); browserPaths.push({ project, file, name: d.name, startUrl: d.startUrl, actions: d.actions.length }); } catch { /* skipped */ } }
        }
        return { projects: found.projects, environments: found.environments, scenarios, collections: listCollections(opts.repoRoot, found.projects), browserPaths, running: loadRuns.running() };
    });
    app.get('/api/load/scenario', async (req) => {
        const file = str((req.query as Record<string, string>).file, 'file', { max: 300 });
        if (!scenarioFileOk(file)) throw new BadRequest('Not a load scenario file.');
        let text: string;
        try { text = fs.readFileSync(path.join(opts.repoRoot, file), 'utf8'); }
        catch (e) {
            // A bad link (#/perf/<file that is not there>): said in words, without this computer's paths.
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound(`There is no load scenario ${file}: it was deleted or renamed, or the link is wrong.`);
            throw new BadRequest(fileErrorText(e as NodeJS.ErrnoException, opts.repoRoot) ?? `${file} cannot be read.`);
        }
        try { return { file, scenario: validScenario(JSON.parse(text)), version: fileVersion(path.join(opts.repoRoot, file)) }; } catch (e) { throw new BadRequest(`${file}: ${(e as Error).message}`); }
    });
    app.put('/api/load/scenario', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        let sc: LoadScenario;
        const { item: scItem, meta: scMeta } = takeSaveMeta(b.scenario);
        try { sc = validScenario(scItem); } catch (e) { throw new BadRequest((e as Error).message); }
        const inProject = (x: { browserPath?: string; collection?: string }) => (x.browserPath ? x.browserPath.startsWith(`test/${project}/load/`) : !!x.collection?.startsWith(`test/${project}/api/`));
        if (!inProject(sc) || !(sc.populations ?? []).every(inProject)) throw new BadRequest('The scenario must use collections or browser paths of the same project.');
        const file = b.file ? str(b.file, 'file', { max: 300 }) : `test/${project}/load/${slug(sc.name)}.load.json`;
        if (!scenarioFileOk(file) || !file.startsWith(`test/${project}/load/`)) throw new BadRequest('Not a load scenario file.');
        if (!b.file && fs.existsSync(path.join(opts.repoRoot, file))) throw new BadRequest(`${file} already exists. Choose another name.`);
        // Saved over a version someone else changed meanwhile (another tab): refused, the UI offers Reload / Overwrite.
        const scStale = b.file ? staleSave(path.join(opts.repoRoot, file), scMeta) : null;
        if (scStale) throw new Conflict(scStale);
        fs.mkdirSync(path.dirname(path.join(opts.repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(opts.repoRoot, file), JSON.stringify(sc, null, 2) + '\n');
        log('load.scenario.save', `Saved the load scenario ${sc.name}`, { file });
        return { file, version: fileVersion(path.join(opts.repoRoot, file)) };
    });
    // Reusable service levels: test/<project>/load/sla/<name>.sla.json.
    app.get('/api/load/sla-profiles', async (req) => {
        const project = apiProject((req.query as Record<string, unknown>).project);
        const dir = path.join(opts.repoRoot, 'test', project, 'load', 'sla');
        let names: string[] = [];
        try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.sla.json')).sort(); } catch { /* none yet */ }
        const profiles: Array<{ file: string; name: string; description?: string; slas: number; interval?: number; error?: string }> = [];
        for (const n of names) {
            const file = `test/${project}/load/sla/${n}`;
            try { const p = validSlaProfile(JSON.parse(fs.readFileSync(path.join(opts.repoRoot, file), 'utf8'))); profiles.push({ file, name: p.name, ...(p.description ? { description: p.description } : {}), slas: p.slas.length, ...(p.interval ? { interval: p.interval } : {}) }); }
            catch (e) { profiles.push({ file, name: n, slas: 0, error: (e as Error).message }); }
        }
        return { profiles };
    });
    app.get('/api/load/sla-profile', async (req) => {
        const file = str((req.query as Record<string, string>).file, 'file', { max: 300 });
        if (!/^test\/[\w.-]+\/load\/sla\/[\w.-]+\.sla\.json$/.test(file)) throw new BadRequest('Not a service-level profile file.');
        try { return { file, profile: validSlaProfile(JSON.parse(fs.readFileSync(path.join(opts.repoRoot, file), 'utf8'))) }; } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.put('/api/load/sla-profile', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        let p: SlaProfile;
        try { p = validSlaProfile({ format: 'cs-studio-sla/1', ...(b.profile as object) }); } catch (e) { throw new BadRequest((e as Error).message); }
        const file = `test/${project}/load/sla/${slug(p.name)}.sla.json`;
        if (b.overwrite !== true && fs.existsSync(path.join(opts.repoRoot, file))) throw new BadRequest(`${file} already exists.`);
        fs.mkdirSync(path.dirname(path.join(opts.repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(opts.repoRoot, file), JSON.stringify(p, null, 2) + '\n');
        log('load.sla.save', `Saved the service-level profile ${p.name}`, { file });
        return { file };
    });
    app.get('/api/load/browser-path', async (req) => {
        const file = str((req.query as Record<string, string>).file, 'file', { max: 300 });
        try { return { file, path: readBrowserPath(opts.repoRoot, file) }; } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // Recorded browser scenarios (the performance app's scenarios.json, or one scenario) → browser path files.
    app.post('/api/load/browser-paths/import', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        let defs: BrowserPathDef[];
        try { defs = importRecordedScenarios(JSON.parse(str(b.text, 'text', { max: 50 * 1024 * 1024 }))); } catch (e) { throw new BadRequest((e as Error).message); }
        const files: string[] = [];
        for (const d of defs) {
            let file = `test/${project}/load/${slug(d.name)}.browser.json`;
            for (let i = 2; fs.existsSync(path.join(opts.repoRoot, file)); i++) file = `test/${project}/load/${slug(d.name)}-${i}.browser.json`;
            fs.mkdirSync(path.dirname(path.join(opts.repoRoot, file)), { recursive: true });
            fs.writeFileSync(path.join(opts.repoRoot, file), JSON.stringify(d, null, 2) + '\n');
            files.push(file);
        }
        log('load.browser.import', `Imported ${files.length} recorded browser path(s)`, { files: files.join(', ') });
        return { files };
    });
    app.delete('/api/load/scenario', async (req) => {
        const q = req.query as Record<string, string>;
        const file = str(q.file, 'file', { max: 300 });
        if (!scenarioFileOk(file) || q.confirm !== 'true') throw new BadRequest('Confirm deleting the scenario.');
        fs.rmSync(path.join(opts.repoRoot, file), { force: true });
        log('load.scenario.delete', `Deleted the load scenario file ${file}`, { file });
        return { ok: true };
    });
    const loadInput = async (file: string, env?: string) => {
        try {
            const x = await prepareLoad(opts.repoRoot, file, env ? envParam(env) : undefined, (e) => secretsAsEnv(opts.store, { project: projectId, env: e }), dataRowsFor);
            // Vault references in the configuration, read before the workers start.
            const se = secretsAsEnv(opts.store, { project: projectId, env: x.environment });
            for (const part of [x.input, ...(x.input.populations ?? [])]) {
                const v = await withVault({ values: part.values, secrets: part.secrets ?? [] }, { variables: [] }, vaultFor(x.project, x.environment, se));
                part.values = v.values; part.secrets = v.secrets;
            }
            // Browser sign-in tokens (and their refresh tokens) go to the load workers.
            if (apiTokens.size) { const t = Object.fromEntries(apiTokens); x.input.values.tokens = t; for (const p of x.input.populations ?? []) p.values.tokens = t; }
            return { project: x.project, environment: x.environment, sc: x.scenario, input: x.input };
        } catch (e) { throw new BadRequest((e as Error).message); }
    };
    /** Start a load test (this computer, or its load generators); `by` is shown in the activity log. */
    const startLoadRun = async (file: string, env: string | undefined, o: { local?: boolean; by?: string } = {}): Promise<LoadRunInfo> => {
        const x = await loadInput(file, env);
        let info: LoadRunInfo;
        try {
            // Load generators: each runs its part of the users; this Studio controls them and adds their numbers up.
            const gens = o.local ? [] : x.sc.generators ?? [];
            info = gens.length
                ? loadRuns.startDistributed({ scenarioFile: file, project: x.project, env: x.environment, definition: x.sc,
                    run: (cb) => runDistributed({ generators: gens, scenarioFile: file, project: x.project, env: x.environment, definition: x.sc, input: x.input, values: x.input.values, conn: netConnection() }, cb) })
                : loadRuns.start({ scenarioFile: file, project: x.project, env: x.environment, definition: x.sc, input: x.input, ...workerNet() });
        } catch (e) { throw new BadRequest((e as Error).message); }
        log('load.run', `Started the load test ${x.sc.name} (${info.maxUsers} users, ${x.sc.policy.duration} s)${o.by ? ` ${o.by}` : ''}`, { file, env: x.environment });
        return info;
    };
    app.post('/api/load/runs', async (req) => {
        const b = body(req);
        return startLoadRun(str(b.file, 'file', { max: 300 }), b.env ? str(b.env, 'env', { max: 32 }) : undefined, { local: b.local === true });
    });
    // Scheduled load tests (while the Studio is open).
    const loadScheduler = new LoadScheduler(path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'load-schedules.json'), async (file, env) => (await startLoadRun(file, env, { by: '(scheduled)' })).id);
    loadScheduler.begin(Number(process.env.CS_STUDIO_LOAD_TICK_MS) || 30_000);
    app.addHook('onClose', async () => loadScheduler.end());
    app.get('/api/load/schedules', async () => ({ schedules: loadScheduler.list() }));
    app.put('/api/load/schedules', async (req) => {
        const b = body(req) as Record<string, unknown>;
        if (typeof b.file === 'string' && !fs.existsSync(path.join(opts.repoRoot, b.file))) throw new BadRequest(`${b.file} does not exist.`);
        try { const s = loadScheduler.save(b as never); log('load.schedule', `Scheduled the load test ${s.file} (${s.kind} ${s.kind === 'weekly' ? `${s.days!.join(',')} ` : ''}${s.at})`, { id: s.id }); return s; }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.delete('/api/load/schedules/:id', async (req) => ({ removed: loadScheduler.remove(str((req.params as { id: string }).id, 'id', { max: 40 })) }));
    app.get('/api/load/runs', async () => ({ runs: loadRuns.list() }));
    app.get('/api/load/runs/:id', async (req) => {
        const r = loadRuns.get(str((req.params as { id: string }).id, 'id', { max: 80 }));
        if (!r) throw new BadRequest('No such load run.');
        return r;
    });
    // Recording a user path for load tests: a recording address in front of the service; stopped, a collection (new,
    // or an existing one updated: checks and saved values kept).
    let loadRecorder: { target: string; rec: LoadRecorder } | null = null;
    app.post('/api/load/record/start', async (req) => {
        const target = str(body(req).target, 'target', { max: 2000 }).trim();
        if (!/^https?:\/\//i.test(target)) throw new BadRequest('Record from an http:// or https:// address.');
        if (loadRecorder) await loadRecorder.rec.stop().catch(() => undefined);
        const conn = netConnection();
        try { loadRecorder = { target, rec: await recordForLoad(target, { agentFor: (u) => conn.agentFor(u) as never, ...(conn.ca ? { ca: conn.ca } : {}) }) }; }
        catch (e) { throw new BadRequest((e as Error).message); }
        return { url: loadRecorder.rec.url, target };
    });
    app.get('/api/load/record', async () => (loadRecorder ? { url: loadRecorder.rec.url, target: loadRecorder.target, count: loadRecorder.rec.count() } : { url: null }));
    app.post('/api/load/record/stop', async (req) => {
        const b = body(req);
        if (!loadRecorder) throw new BadRequest('Not recording.');
        const r = loadRecorder; loadRecorder = null;
        const out = await r.rec.stop({ name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 120) : undefined }).catch((e: Error) => { throw new BadRequest(e.message); });
        if (typeof b.mergeInto === 'string' && b.mergeInto) {
            let existing: ApiCollection;
            try { existing = readCollection(opts.repoRoot, b.mergeInto); } catch (e) { throw new BadRequest((e as Error).message); }
            const m = mergeRecording(existing, out.collection);
            return { collection: m.collection, merge: m.report, report: out.report, file: b.mergeInto };
        }
        if (!out.collection.items.length) throw new BadRequest('Nothing was recorded: send requests to the recording address first.');
        return { collection: out.collection, report: out.report };
    });
    app.addHook('onClose', async () => { if (loadRecorder) await loadRecorder.rec.stop().catch(() => undefined); });
    app.post('/api/load/runs/:id/adjust', async (req) => {
        const f = Number(body(req).factor);
        if (!(f >= 0 && f <= 10)) throw new BadRequest('The load is 0 to 10 times the plan.');
        const id = str((req.params as { id: string }).id, 'id', { max: 80 });
        const ok = loadRuns.adjust(id, f);
        if (ok) log('load.adjust', `Changed the load of the running test to ${Math.round(f * 100)}% of the plan`);
        return { adjusted: ok, factor: f };
    });
    app.post('/api/load/runs/:id/stop', async (req) => ({ stopped: loadRuns.stop(str((req.params as { id: string }).id, 'id', { max: 80 })) }));
    // Analysis: a range of the run (default: its steady part), monitors against response times, the baseline.
    app.get('/api/load/runs/:id/analysis', async (req) => {
        const d = loadRuns.get(str((req.params as { id: string }).id, 'id', { max: 80 }));
        if (!d?.result) throw new BadRequest('No results for this run.');
        const q = req.query as Record<string, string>;
        const steady = steadyRange(d.result);
        const from = q.from !== undefined ? Math.max(0, Number(q.from) || 0) : steady?.from ?? 0;
        const to = q.to !== undefined ? Math.max(from, Number(q.to) || 0) : steady?.to ?? d.result.elapsed;
        const names = Object.fromEntries(d.result.transactions.map((t) => [t.id, t.name]));
        const baseId = loadRuns.baselineOf(d.scenario);
        const base = baseId && baseId !== d.id ? loadRuns.get(baseId) : null;
        const gate = d.definition.regression ?? { p95Percent: 10, avgPercent: 10, errorRatePoints: 1, throughputPercent: 10 };
        return {
            steady, range: rangeStats(d.result.intervals ?? [], from, to, names), intervals: (d.result.intervals ?? []).map((i) => ({ t0: i.t0, t1: i.t1 })),
            correlation: correlateMonitors(d.result),
            ...(base?.result ? { baseline: { id: base.id, startedAt: base.startedAt, gate, gateFromScenario: !!d.definition.regression, regression: regression(d.result, base.result, gate) } } : {}),
            isBaseline: baseId === d.id,
        };
    });
    // Results in plain language (status, every number explained and rated, risks, next steps).
    app.get('/api/load/runs/:id/explain', async (req) => {
        const d = loadRuns.get(str((req.params as { id: string }).id, 'id', { max: 80 }));
        if (!d?.result) throw new BadRequest('No results for this run.');
        return explainRun(d.result, d.definition);
    });
    // Two runs compared (A the reference): verdict, measures with changes, transactions, both over time.
    app.get('/api/load/compare', async (req) => {
        const q = req.query as Record<string, string>;
        const a = loadRuns.get(str(q.a, 'a', { max: 80 })), b = loadRuns.get(str(q.b, 'b', { max: 80 }));
        if (!a?.result || !b?.result) throw new BadRequest('Choose two finished runs.');
        if (a.id === b.id) throw new BadRequest('Choose two different runs.');
        const mixed = differentScenarios([a, b]);
        if (mixed) throw new BadRequest(mixed);
        const label = (d: LoadRunDetail, k: string) => `Run ${k} (${new Date(d.startedAt).toLocaleString()})`;
        const info = (d: LoadRunDetail) => ({ id: d.id, name: d.name, scenario: d.scenario, env: d.env, startedAt: d.startedAt, passed: d.result!.passed, maxUsers: d.maxUsers, duration: d.duration });
        return { a: info(a), b: info(b), comparison: compareLoadRuns(a.result, b.result, { a: label(a, 'A'), b: label(b, 'B') }, { a: a.definition, b: b.definition }),
            series: overlay([{ id: a.id, label: 'A', result: a.result }, { id: b.id, label: 'B', result: b.result }], 'p95'), throughput: overlay([{ id: a.id, label: 'A', result: a.result }, { id: b.id, label: 'B', result: b.result }], 'throughput') };
    });
    app.get('/api/load/runs/:id/insights', async (req) => {
        const d = loadRuns.get(str((req.params as { id: string }).id, 'id', { max: 80 }));
        if (!d?.result) throw new BadRequest('No results for this run.');
        return runInsights(d.result);
    });
    app.post('/api/load/runs/:id/baseline', async (req) => {
        const id = str((req.params as { id: string }).id, 'id', { max: 80 });
        try { loadRuns.setBaseline(id, body(req).on !== false); } catch (e) { throw new BadRequest((e as Error).message); }
        log('load.baseline', `${body(req).on !== false ? 'Set' : 'Cleared'} the baseline run ${id}`, { id });
        return { ok: true };
    });
    app.get('/api/load/compare/report', async (req, reply) => {
        const q = req.query as Record<string, string>;
        const runs = str(q.ids ?? '', 'ids', { max: 400 }).split(',').map((x) => loadRuns.get(x.trim())).filter((d): d is LoadRunDetail => !!d?.result).slice(0, 4);
        let html: string;
        try { html = loadComparisonHtml(runs); } catch (e) { throw new BadRequest((e as Error).message); }
        const base = `${slug(runs[0].name)}-comparison`;
        if (q.format === 'docx') {
            try { return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').header('Content-Disposition', `attachment; filename="${base}.docx"`).send(await loadComparisonDocx(runs, opts.repoRoot)); }
            catch (e) { throw new BadRequest((e as Error).message); }
        }
        if (q.format === 'pdf') {
            try { return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${base}.pdf"`).send(await htmlToPdf(html, opts.repoRoot)); }
            catch (e) { throw new BadRequest(`The PDF could not be made: ${(e as Error).message.split('\n')[0]}`); }
        }
        return reply.type('text/html; charset=utf-8').header('Content-Disposition', `attachment; filename="${base}.html"`).send(html);
    });
    app.get('/api/load/report-template', async (req) => {
        const project = apiProject((req.query as Record<string, unknown>).project);
        const file = `test/${project}/load/report-template.html`;
        const exists = fs.existsSync(path.join(opts.repoRoot, file));
        return { file, exists, sections: REPORT_SECTIONS, default: DEFAULT_REPORT_TEMPLATE };
    });
    // Team results: the shared folder (Settings) with everyone's runs; Azure DevOps pipeline results imported.
    const teamFolder = () => settings?.get().loadTeamFolder;
    app.get('/api/load/team', async (req) => {
        const q = req.query as Record<string, string>;
        const folder = teamFolder();
        if (!folder) return { folder: null, runs: [] };
        try { return { folder, runs: listTeamRuns(folder, { ...(q.project ? { project: apiProject(q.project) } : {}), ...(q.scenario ? { scenario: str(q.scenario, 'scenario', { max: 300 }) } : {}), limit: 500 }) }; }
        catch (e) { return { folder, runs: [], error: (e as Error).message }; }
    });
    app.post('/api/load/runs/:id/share', async (req) => {
        const d = loadRuns.get(str((req.params as { id: string }).id, 'id', { max: 80 }));
        if (!d) throw new BadRequest('No such run.');
        const folder = teamFolder();
        if (!folder) throw new BadRequest('Set the team results folder first (Settings › Team results).');
        try { const t = publishRun(folder, d, { ...(opts.userName ? { user: opts.userName } : {}) }); log('load.share', `Shared the load run ${d.name} with the team`, { id: d.id, file: t.file }); return t; }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/load/team/open', async (req) => {
        const folder = teamFolder();
        if (!folder) throw new BadRequest('No team results folder.');
        try { const info = loadRuns.importRun({ ...readTeamRun(folder, str(body(req).file, 'file', { max: 400 })), message: 'From the team results.' } as LoadRunDetail); return info; }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/load/team/ado-import', async (req) => {
        const b = body(req) as Record<string, string>;
        const id = runIdParam(String(b.runId));
        const { p } = pipelinesFor(b);
        const [run, timeline] = await Promise.all([p.run(id), p.timeline(id)]);
        const arts = (await p.artifacts(id, timeline)).filter((a) => /^PipelineArtifact$/i.test(a.type) && (b.artifact ? a.name === b.artifact : /load|perf/i.test(a.name)));
        if (!arts.length) throw new BadRequest('This run has no pipeline artifact with load-test results (named like load-results).');
        const imported: LoadRunInfo[] = [];
        const shared: string[] = [];
        for (const a of arts) {
            const dir = await fetchArtifact(p, run, a, pipelineCache, netConnection());
            for (const d of findRunResults(dir)) {
                const info = loadRuns.importRun({ ...d, message: `From pipeline run ${run.number ?? id} (${a.name}).` } as LoadRunDetail);
                imported.push(info);
                const folder = teamFolder();
                if (folder && b.share !== 'false') { try { shared.push(publishRun(folder, { ...loadRuns.get(info.id)!, id: `ado-${id}-${info.id}` }, { user: 'pipeline', machine: 'Azure DevOps', pipeline: `${run.pipeline?.name ?? ''} #${run.number ?? id}`.trim() }).file); } catch { /* the folder is optional */ } }
            }
        }
        if (!imported.length) throw new BadRequest('No load-test results (cs-test-studio load … --json) were found in the artifacts.');
        log('load.ado.import', `Imported ${imported.length} load run(s) from pipeline run ${id}`, { id });
        return { imported, shared };
    });
    // An Azure DevOps pipeline for a load scenario (parallel generators, gate against the last run, reports).
    app.post('/api/load/pipeline', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 300 });
        if (!scenarioFileOk(file)) throw new BadRequest('Not a load scenario file.');
        let sc: LoadScenario;
        try { sc = validScenario(JSON.parse(fs.readFileSync(path.join(opts.repoRoot, file), 'utf8'))); } catch (e) { throw new BadRequest((e as Error).message); }
        const project = file.split('/')[1];
        const envs = discover(opts.repoRoot).environments[project] ?? [];
        // The secrets the test reads: {env:NAME} in the scenario and its collections.
        let text = JSON.stringify(sc);
        for (const c of [sc.collection, ...(sc.populations ?? []).map((p) => p.collection)].filter((x): x is string => !!x)) { try { text += fs.readFileSync(path.join(opts.repoRoot, c), 'utf8'); } catch { /* checked when it runs */ } }
        const secretNames = [...new Set([...text.matchAll(/\{env:([A-Za-z_][\w]*)\}/g)].map((m) => m[1]))];
        const schedule = typeof b.schedule === 'string' && b.schedule.trim() ? b.schedule.trim() : undefined;
        if (schedule && !/^[\d*/,-]+( [\d*/,-]+){4}$/.test(schedule)) throw new BadRequest('The schedule is a cron line of five fields (UTC), e.g. 0 2 * * 1-5.');
        const generators = wholeParam(b.generators, 'Load generators', 1, 50, 1);
        const opt = (k: string, re: RegExp) => (typeof b[k] === 'string' && re.test(b[k] as string) ? b[k] as string : undefined);
        const yamlText = loadPipeline(file, { name: sc.name, envs, generators, schedule, secretNames, variableGroup: opt('variableGroup', /^[^\n']{1,120}$/), branch: opt('branch', /^[\w./-]{1,100}$/), pool: opt('pool', /^[^\n']{1,120}$/), teamFolder: opt('teamFolder', /^[^\n']{1,300}$/) });
        const target = `test/${project}/pipelines/${slug(sc.name)}.load-pipeline.yml`;
        if (b.save === true) {
            const abs = safePath(opts.repoRoot, target);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, yamlText);
            log('load.pipeline', `Wrote the load pipeline ${target} for ${sc.name}`);
        }
        return { yaml: yamlText, file: target, secretNames, saved: b.save === true };
    });
    app.get('/api/load/overlay', async (req) => {
        const q = req.query as Record<string, string>;
        const ids = str(q.ids ?? '', 'ids', { max: 400 }).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4);
        const metric = (['p95', 'avg', 'throughput', 'errors', 'users'] as const).find((m) => m === q.metric) ?? 'p95';
        const runs = ids.map((id) => loadRuns.get(id)).filter((d): d is LoadRunDetail => !!d?.result).map((d) => ({ id: d.id, label: `${d.name} · ${new Date(d.startedAt).toLocaleString()}`, result: d.result! }));
        return { metric, series: overlay(runs, metric) };
    });
    app.delete('/api/load/runs/:id', async (req) => ({ removed: loadRuns.remove(str((req.params as { id: string }).id, 'id', { max: 80 })) }));
    app.post('/api/load/runs/import', async (req) => {
        const b = body(req);
        const texts = (Array.isArray(b.texts) ? b.texts : [b.text]).map((t, i) => str(t, `file ${i + 1}`, { max: 200 * 1024 * 1024 }));
        let detail: LoadRunDetail;
        try {
            const parsed = texts.map((t) => JSON.parse(t) as LoadRunDetail);
            detail = parsed.length > 1 ? mergeRuns(parsed) : parsed[0];
            const info = loadRuns.importRun(detail);
            log('load.run.import', `Imported the results of ${info.name}${texts.length > 1 ? ` (${texts.length} parts merged)` : ''}`, { id: info.id });
            return info;
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.get('/api/load/runs/:id/report', async (req, reply) => {
        const r = loadRuns.get(str((req.params as { id: string }).id, 'id', { max: 80 }));
        if (!r || r.state !== 'finished' || !r.result) throw new BadRequest('The run is not finished.');
        const f = (req.query as Record<string, string>).format;
        const kind = f === 'xlsx' || f === 'pdf' || f === 'docx' ? f : 'html';
        const base = `${slug(r.name)}-${r.id}`;
        if (kind === 'xlsx') return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${base}.xlsx"`).send(loadReportXlsx(r));
        if (kind === 'docx') {
            try { return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').header('Content-Disposition', `attachment; filename="${base}.docx"`).send(await loadReportDocx(r, opts.repoRoot)); }
            catch (e) { throw new BadRequest((e as Error).message); }
        }
        // The project's own layout, when it has one (test/<project>/load/report-template.html).
        let template: string | undefined;
        try { template = fs.readFileSync(path.join(opts.repoRoot, 'test', r.project, 'load', 'report-template.html'), 'utf8'); } catch { /* the default */ }
        const html = loadReportHtml(r, template);
        if (kind === 'pdf') {
            try { return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${base}.pdf"`).send(await htmlToPdf(html, opts.repoRoot)); }
            catch (e) { throw new BadRequest(`The PDF could not be made: ${(e as Error).message.split('\n')[0]}`); }
        }
        return reply.type('text/html; charset=utf-8').header('Content-Disposition', `attachment; filename="${base}.html"`).send(html);
    });
    app.get('/api/load/runs/:id/junit', async (req, reply) => {
        const r = loadRuns.get(str((req.params as { id: string }).id, 'id', { max: 80 }));
        if (!r || r.state !== 'finished') throw new BadRequest('The run is not finished.');
        return reply.type('application/xml').header('Content-Disposition', `attachment; filename="load-${r.id}.junit.xml"`).send(junit(r));
    });

    // ---- Database: the project's connections (DB_<ALIAS>_*), queried through the project's own framework
    // and drivers in a separate process per project + environment (src/db/worker.ts).
    const dbSecretEnv = (project: string, environment: string) => secretsAsEnv(opts.store, { project: projectId, env: environment });
    const dbSessions = new DbSessions({ repoRoot: opts.repoRoot, env: (project, environment) => { void project; return dbSecretEnv(project, environment); } });
    app.addHook('onClose', async () => { dbSessions.stopAll(); });
    /** Test data rows (API runs, load tests) from any source, in the project's process. */
    const dataRowsFor = async (project: string, environment: string, source: unknown, secretEnv = dbSecretEnv(project, environment)) =>
        (await loadDataRows({ repoRoot: opts.repoRoot, project, environment, source, secretEnv, sessions: dbSessions, connection: netConnection() })).rows;
    app.post('/api/data/preview', async (req) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        try {
            // In a recording: {remembered:name} in the parameters is the value remembered so far.
            let src = b.source;
            const rec = typeof b.recording === 'string' ? recorder.studioOf(b.recording) : undefined;
            if (rec && src && typeof src === 'object' && Array.isArray((src as { params?: unknown }).params)) {
                const mem = rec.rememberedNow();
                src = { ...(src as object), params: ((src as { params: unknown[] }).params).map((p) => String(p).replace(/\{remembered:(\w+)\}/g, (m, n: string) => mem[n] ?? m)) };
            }
            const r = await loadDataRows({ repoRoot: opts.repoRoot, project, environment, source: src, secretEnv: dbSecretEnv(project, environment), sessions: dbSessions, connection: netConnection(), timeoutMs: 120_000, ...(rec ? { remembered: rec.rememberedNow() } : {}) });
            log('data.preview', `Loaded test data: ${describeSource(r.source)} (${r.total} rows)`, { env: environment });
            return { columns: r.columns, rows: r.rows.slice(0, 50).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, maskAll(v)]))), total: r.total, readOnly: r.readOnly };
        } catch (e) { throw new BadRequest((e as Error).message.split('\n').slice(0, 4).join('\n')); }
    });
    const dbHistoryFile = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'db-history.json');
    /** Real config values (server only: never sent to the browser). */
    const dbValues = (project: string, environment: string): Record<string, string> => {
        const secretEnv = dbSecretEnv(project, environment);
        const osEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CS_STUDIO_')) osEnv[k] = v;
        return resolveConfig({ repoRoot: opts.repoRoot, project, environment, secretEnv, osEnv, unmasked: true }).values ?? {};
    };
    const dbTarget = (q: Record<string, unknown>) => {
        const project = apiProject(q.project);
        const environment = q.env ? envParam(q.env) : ((discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev');
        return { project, environment };
    };
    const driverInstalled = (type: string) => { const d = DRIVER[type as DbType]; if (!d) return false; try { require.resolve(`${d}/package.json`, { paths: [opts.repoRoot] }); return true; } catch { try { require.resolve(d, { paths: [opts.repoRoot] }); return true; } catch { return false; } } };
    const dbConn = (project: string, environment: string, alias: unknown) => {
        const a = str(alias, 'alias', { max: 64 }).toUpperCase();
        const values = dbValues(project, environment);
        const c = listConnections(values).find((x) => x.alias === a);
        if (!c) throw new BadRequest(`No connection ${a} in ${project}/${environment} (DB_${a}_TYPE is not set).`);
        if (c.problems.length) throw new BadRequest(c.problems.join(' '));
        if (!driverInstalled(c.type)) throw new BadRequest(`The ${DRIVER[c.type as DbType]} driver is not installed in this repository (the framework needs it for ${c.type}): npm install ${DRIVER[c.type as DbType]}`);
        return { c, values };
    };
    const dbDeadline = (ms: number) => ms + 20_000;
    const dbHistory = (entry: Record<string, unknown>) => {
        try {
            let h: unknown[] = [];
            try { h = JSON.parse(fs.readFileSync(dbHistoryFile, 'utf8')); } catch { /* none yet */ }
            h.unshift(entry);
            fs.mkdirSync(path.dirname(dbHistoryFile), { recursive: true });
            fs.writeFileSync(dbHistoryFile, JSON.stringify(h.slice(0, 300)));
        } catch { /* history is best effort */ }
    };
    app.get('/api/db/connections', async (req) => {
        const found = discover(opts.repoRoot);
        const q = req.query as Record<string, unknown>;
        if (!q.project) return { projects: found.projects, environments: found.environments, connections: [] };
        const { project, environment } = dbTarget(q);
        const values = dbValues(project, environment);
        // @mdakhan.mak, or the framework under another npm scope.
        const fwDir = frameworkPackage(opts.repoRoot)?.dir;
        const frameworkInstalled = !!fwDir && fs.existsSync(path.join(fwDir, 'dist', 'lib', 'database.js'));
        return {
            projects: found.projects, environments: found.environments, project, environment, frameworkInstalled,
            protected: protectedEnvironment(environment, values),
            connections: listConnections(values).map((c) => ({ ...c, driver: DRIVER[c.type as DbType] ?? null, driverInstalled: driverInstalled(c.type) })),
            running: dbSessions.running(project, environment),
        };
    });
    app.post('/api/db/ping', async (req) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        const { c } = dbConn(project, environment, b.alias);
        try { return await dbSessions.request(project, environment, { op: 'ping', alias: c.alias }, 60_000); }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.get('/api/db/objects', async (req) => {
        const q = req.query as Record<string, unknown>;
        const { project, environment } = dbTarget(q);
        const { c } = dbConn(project, environment, q.alias);
        try { return await dbSessions.request(project, environment, { op: 'objects', alias: c.alias }, 90_000); }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.get('/api/db/columns', async (req) => {
        const q = req.query as Record<string, unknown>;
        const { project, environment } = dbTarget(q);
        const { c } = dbConn(project, environment, q.alias);
        try { return await dbSessions.request(project, environment, { op: 'columns', alias: c.alias, schema: str(q.schema ?? '', 'schema', { optional: true, max: 256 }), table: str(q.table, 'table', { max: 256 }) }, 60_000); }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    /** The rows of a MongoDB collection or a Redis key group (no SQL), as a query result. */
    app.get('/api/db/rows', async (req) => {
        const q = req.query as Record<string, unknown>;
        const { project, environment } = dbTarget(q);
        const { c } = dbConn(project, environment, q.alias);
        if (c.type !== 'mongodb' && c.type !== 'redis') throw new BadRequest(`Rows of ${c.type} are read with a query.`);
        const maxRows = Math.max(1, Math.min(Number(q.maxRows) || 100, 10000));
        try {
            const r = await dbSessions.request<Record<string, unknown>>(project, environment, { op: 'rows', alias: c.alias, table: str(q.table, 'table', { max: 512 }), maxRows }, dbDeadline(120_000));
            return { ...r, command: 'READ', type: c.type, kind: 'read' };
        } catch (e) { throw new BadRequest(maskAll((e as Error).message)); }
    });
    // ---- Whole database compare: the tables of two connections (two environments), paired by name; each table's rows
    // by its primary key, side by side. Reads only.
    /** The date precision asked for (exact, second, minute, day). */
    const datesOf = (v: unknown): Pick<CompareOptions, 'dates'> => (typeof v === 'string' && (DATE_PRECISIONS as string[]).includes(v) ? { dates: v as CompareOptions['dates'] } : {});
    /** The project's comparison rules (DB_COMPARE_IGNORE, DB_COMPARE_DATES), as the framework's steps read them. */
    const compareRules = (project: string, env: string) => {
        let v: Record<string, string> = {};
        try { v = dbValues(project, env); } catch { /* no config */ }
        return { ignore: (v.DB_COMPARE_IGNORE ?? '').split(',').map((x) => x.trim()).filter(Boolean), dates: (DATE_PRECISIONS as string[]).includes((v.DB_COMPARE_DATES ?? '').trim().toLowerCase()) ? (v.DB_COMPARE_DATES ?? '').trim().toLowerCase() : 'exact' };
    };
    app.get('/api/db/compare/rules', async (req) => {
        const q = req.query as Record<string, unknown>;
        const { project, environment } = dbTarget(q);
        return { ...compareRules(project, environment), file: `config/${project}/common/common.env` };
    });
    app.put('/api/db/compare/rules', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const asked = (Array.isArray(b.ignore) ? b.ignore : []).map((x: unknown) => String(x).trim()).filter(Boolean);
        // Column names and patterns (letters of any language, digits, _ . * ? $ # -); one that is not is refused, not dropped.
        const bad = asked.filter((x: string) => !/^[\p{L}\p{N}_.*?$#-]{1,128}$/u.test(x));
        if (bad.length) throw new BadRequest(`Not a column name or pattern: ${bad.slice(0, 5).map((x: string) => `"${x}"`).join(', ')} (letters, digits and _ . * ? $ # -; a comma separates them).`);
        const ignore = asked.slice(0, 100);
        const dates = typeof b.dates === 'string' && (DATE_PRECISIONS as string[]).includes(b.dates) ? b.dates : 'exact';
        const file = `config/${project}/common/common.env`;
        if (ignore.length) setValue(opts.repoRoot, file, 'DB_COMPARE_IGNORE', ignore.join(', ')); else removeKey(opts.repoRoot, file, 'DB_COMPARE_IGNORE');
        if (dates !== 'exact') setValue(opts.repoRoot, file, 'DB_COMPARE_DATES', dates); else removeKey(opts.repoRoot, file, 'DB_COMPARE_DATES');
        log('db.compare.rules', `Saved the comparison rules of ${project}`, { file });
        return { file, ignore, dates };
    });
    const cmpSide = (project: string, fallbackEnv: string, x: unknown) => {
        const o = (x ?? {}) as Record<string, unknown>;
        const env = o.env ? envParam(o.env) : fallbackEnv;
        if (!(discover(opts.repoRoot).environments[project] ?? []).includes(env)) throw new BadRequest(`The project ${project} has no environment "${env}".`);
        const { c } = dbConn(project, env, o.alias);
        return { c, env };
    };
    app.post('/api/db/compare/tables', async (req) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        const src = cmpSide(project, environment, b.source), tgt = cmpSide(project, environment, b.target);
        const list = async (x: typeof src) => {
            const r = await dbSessions.request<{ objects: Array<{ schema: string; name: string; kind: string; rows?: number }>; unsupported?: boolean }>(project, x.env, { op: 'objects', alias: x.c.alias }, 90_000);
            if (r.unsupported) throw new BadRequest(`Listing tables is not available for ${x.c.type} (${x.c.alias}).`);
            return r.objects.filter((o) => o.kind === 'table');
        };
        let st: Awaited<ReturnType<typeof list>>, tt: Awaited<ReturnType<typeof list>>;
        try { [st, tt] = await Promise.all([list(src), list(tgt)]); } catch (e) { throw e instanceof BadRequest ? e : new BadRequest(maskAll((e as Error).message)); }
        // Paired by schema and name; by name alone when the schemas differ between the two (a database per environment).
        const key = (o: { schema: string; name: string }, bySchema: boolean) => (bySchema ? `${o.schema}.${o.name}` : o.name).toLowerCase();
        const sameSchemas = st.some((a) => tt.some((t) => key(a, true) === key(t, true)));
        const tMap = new Map(tt.map((t) => [key(t, sameSchemas), t]));
        const pairs: Array<{ name: string; source?: { schema: string; name: string; rows?: number }; target?: { schema: string; name: string; rows?: number } }> = [];
        for (const a of st) { const t = tMap.get(key(a, sameSchemas)); tMap.delete(key(a, sameSchemas)); pairs.push({ name: sameSchemas && a.schema ? `${a.schema}.${a.name}` : a.name, source: { schema: a.schema, name: a.name, rows: a.rows }, ...(t ? { target: { schema: t.schema, name: t.name, rows: t.rows } } : {}) }); }
        for (const t of tMap.values()) pairs.push({ name: sameSchemas && t.schema ? `${t.schema}.${t.name}` : t.name, target: { schema: t.schema, name: t.name, rows: t.rows } });
        pairs.sort((x, y) => x.name.localeCompare(y.name));
        return { pairs, source: { alias: src.c.alias, env: src.env, type: src.c.type }, target: { alias: tgt.c.alias, env: tgt.env, type: tgt.c.type } };
    });
    app.post('/api/db/compare/table', async (req) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        const src = cmpSide(project, environment, b.source), tgt = cmpSide(project, environment, b.target);
        const tableOf = (x: unknown) => { const o = (x ?? {}) as Record<string, unknown>; return { schema: str(o.schema ?? '', 'schema', { optional: true, max: 256 }), name: str(o.name, 'table', { max: 256 }) }; };
        const ts = tableOf((b.source as Record<string, unknown>)?.table), tt = tableOf((b.target as Record<string, unknown>)?.table);
        const maxRows = Math.max(1, Math.min(Number(b.maxRows) || 50000, 200000));
        const o = (b.options && typeof b.options === 'object' ? b.options : {}) as Record<string, unknown>;
        const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 128).slice(0, 200);
        const tolerance = Number(o.tolerance ?? 0);
        if (!Number.isFinite(tolerance) || tolerance < 0) throw new BadRequest('Tolerance: a number, 0 or more.');
        type Cols = { columns: Array<{ name: string; key: boolean; type: string }> };
        type Q = { columns: Array<{ name: string }>; rows: unknown[][]; total: number; truncated: boolean; ms: number };
        const read = async (x: typeof src, t: typeof ts) => {
            const cols = await dbSessions.request<Cols>(project, x.env, { op: 'columns', alias: x.c.alias, schema: t.schema, table: t.name }, 60_000);
            // MongoDB collections and Redis key groups: read through the drivers (no SQL).
            const nosql = x.c.type === 'mongodb' || x.c.type === 'redis';
            const sql = nosql ? '' : selectSql(x.c.type, t.schema, t.name, maxRows + 1);
            if (!nosql && !sql) throw new BadRequest(`Reading a table is not available for ${x.c.type}.`);
            const q = nosql
                ? await dbSessions.request<Q>(project, x.env, { op: 'rows', alias: x.c.alias, table: t.name, maxRows }, dbDeadline(120_000))
                : await dbSessions.request<Q>(project, x.env, { op: 'query', alias: x.c.alias, sql, params: [], maxRows, timeoutMs: 120_000, mode: 'read' }, dbDeadline(120_000));
            return { cols: cols.columns, q, rows: q.rows.map((row) => Object.fromEntries(q.columns.map((c, i) => [c.name, cellValue(row[i])]))) };
        };
        let rs: Awaited<ReturnType<typeof read>>, rt: Awaited<ReturnType<typeof read>>;
        try { [rs, rt] = await Promise.all([read(src, ts), read(tgt, tt)]); } catch (e) { throw e instanceof BadRequest ? e : new BadRequest(maskAll((e as Error).message)); }
        // The key: the columns asked for (a business key), else the source's primary key (when the target has those
        // columns), else every column. Ids that differ between environments (generated: identity, sequence, UUID):
        // the primary key and the id columns (id, …_id) are left out, and rows match by their other columns.
        const tNames = new Set(rt.q.columns.map((c) => c.name.toLowerCase()));
        const common = rs.q.columns.map((c) => c.name).filter((n) => tNames.has(n.toLowerCase()));
        const pk = rs.cols.filter((c) => c.key).map((c) => c.name).filter((n) => tNames.has(n.toLowerCase()));
        const idsDiffer = o.idsDiffer === true;
        const typeOf = new Map(rs.cols.map((c) => [c.name.toLowerCase(), String(c.type ?? '').toLowerCase()]));
        // An id: "id", "..._id" / "..._ID", "orderId" (not PAID, VALID), of a number or UUID type (a primary key column of a type not known too).
        const inPk = (n: string) => pk.some((k) => k.toLowerCase() === n.toLowerCase());
        const idLike = (n: string) => {
            if (!(/^id$|_id$/i.test(n) || /[a-z0-9]Id$/.test(n) || inPk(n))) return false;
            const t = typeOf.get(n.toLowerCase()) ?? '';
            return t ? /int|serial|number|numeric|decimal|uuid|uniqueidentifier|objectid/.test(t) : inPk(n);
        };
        const asked = list(o.keys);
        const idCols = idsDiffer ? common.filter((n) => idLike(n) && !asked.some((k) => k.toLowerCase() === n.toLowerCase())) : [];
        const ignoredByRule = ignoreRule(list(o.ignore), ts.schema ? `${ts.schema}.${ts.name}` : ts.name);
        const rest = common.filter((n) => !idCols.includes(n) && !ignoredByRule(n));
        if (idsDiffer && !asked.length && !rest.length) throw new BadRequest(`${ts.name}: every column is an id or ignored, so rows cannot be matched. Choose the key columns that identify a row.`);
        const keys = asked.length ? asked : idsDiffer ? rest : pk.length ? pk : common;
        const keyKind = asked.length ? 'chosen' : idsDiffer ? 'other columns (ids left out)' : pk.length ? 'primary key' : 'all columns';
        const copts: CompareOptions = { keys, ignore: [...list(o.ignore), ...idCols], table: ts.schema ? `${ts.schema}.${ts.name}` : ts.name, tolerance, ignoreCase: o.ignoreCase === true, trim: o.trim !== false, ...datesOf(o.dates) };
        let result: CompareResult, side: ReturnType<typeof alignRows>;
        try { result = compareRows(rs.rows, rt.rows, copts); side = alignRows(rs.rows, rt.rows, { ...copts, limit: Math.max(1, Math.min(Number(b.limit) || 300, 2000)), same: b.same === true }); }
        catch (e) { throw new BadRequest((e as Error).message); }
        const shown = (r?: Record<string, unknown>) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : typeof v === 'string' ? v.slice(0, 500) : v])) : undefined);
        return {
            result, keys: copts.keys, keyKind, idColumns: idCols, primaryKey: pk, summary: describeComparison(result),
            source: { rows: rs.q.total, truncated: rs.q.truncated, ms: rs.q.ms, columns: rs.q.columns.map((c) => c.name) },
            target: { rows: rt.q.total, truncated: rt.q.truncated, ms: rt.q.ms, columns: rt.q.columns.map((c) => c.name) },
            side: { columns: side.columns, targetColumn: side.targetColumn, truncated: side.truncated, rows: side.rows.map((x) => ({ ...x, source: shown(x.source), target: shown(x.target) })) },
        };
    });
    // Compare the result of a source query with a target query (two connections, or two tables of one): rows matched by
    // their key columns, values compared as data, and their vital checks. Reads only (each query is checked).
    app.post('/api/db/compare', async (req) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        // Each side in an environment of the project (the same table in qa and uat); default: the screen's.
        const side = (x: unknown, name: string) => {
            const o = (x ?? {}) as Record<string, unknown>;
            const env = o.env ? envParam(o.env) : environment;
            if (!(discover(opts.repoRoot).environments[project] ?? []).includes(env)) throw new BadRequest(`The project ${project} has no environment "${env}".`);
            const { c } = dbConn(project, env, o.alias);
            const sql = str(o.sql, `${name} query`, { max: 1024 * 1024 });
            if (!sql.trim()) throw new BadRequest(`Write the ${name} query.`);
            const kind = classify(sql, c.type);
            if (kind.kind === 'change') throw new BadRequest(`The ${name} query looks like a change (${kind.reason}): a comparison only reads.`);
            return { c, sql, env };
        };
        const src = side(b.source, 'source'), tgt = side(b.target, 'target');
        const maxRows = Math.max(1, Math.min(Number(b.maxRows) || 50000, 200000));
        const o = (b.options && typeof b.options === 'object' ? b.options : {}) as Record<string, unknown>;
        const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 128).slice(0, 200);
        const map: Record<string, string> = {};
        for (const p2 of list(o.map)) { const m = /^(.+?)\s*(?:=|->|→)\s*(.+)$/.exec(p2); if (m) map[m[1].trim()] = m[2].trim(); }
        const tolerance = Number(o.tolerance ?? 0);
        if (!Number.isFinite(tolerance) || tolerance < 0) throw new BadRequest('Tolerance: a number, 0 or more.');
        const copts: CompareOptions = { keys: list(o.keys), ignore: list(o.ignore), map, tolerance, ignoreCase: o.ignoreCase === true, trim: o.trim !== false, ...datesOf(o.dates), ...(list(o.columns).length ? { columns: list(o.columns) } : {}) };
        const timeoutMs = 120_000;
        const run = (x: { c: { alias: string; queryTimeoutMs: number }; sql: string; env: string }) => dbSessions.request<{ columns: Array<{ name: string }>; rows: unknown[][]; total: number; truncated: boolean; ms: number }>(project, x.env, { op: 'query', alias: x.c.alias, sql: x.sql, params: [], maxRows, timeoutMs, mode: 'read' }, dbDeadline(timeoutMs));
        let rs: Awaited<ReturnType<typeof run>>, rt: Awaited<ReturnType<typeof run>>;
        try { [rs, rt] = await Promise.all([run(src), run(tgt)]); } catch (e) { throw new BadRequest(maskAll((e as Error).message)); }
        const rowsOf = (r: typeof rs) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, cellValue(row[i])])));
        let result: CompareResult, vitals: ReturnType<typeof compareVitals>;
        try { result = compareRows(rowsOf(rs), rowsOf(rt), copts); vitals = compareVitals(rowsOf(rs), rowsOf(rt), copts); }
        catch (e) { throw new BadRequest((e as Error).message); }
        log('db.compare', `Compared ${src.c.alias} (${src.env}) with ${tgt.c.alias} (${tgt.env}) in ${project}`, { env: src.env === tgt.env ? src.env : `${src.env}, ${tgt.env}`, rows: rs.total + rt.total });
        // The framework step for it, when the project's framework has it (a query as it is: SQL, or a DB_QUERY_ key).
        const fw = frameworkPackage(opts.repoRoot)?.dir;
        const stepAvailable = !!fw && fs.existsSync(path.join(fw, 'dist', 'steps', 'database', 'CSDataCompareSteps.js'));
        return {
            result, vitals: { passed: vitals.passed, differences: vitals.differences.slice(0, 200), source: vitals.source, target: vitals.target },
            summary: describeComparison(result), source: { alias: src.c.alias, env: src.env, rows: rs.total, truncated: rs.truncated, ms: rs.ms, columns: rs.columns.map((c) => c.name) },
            target: { alias: tgt.c.alias, env: tgt.env, rows: rt.total, truncated: rt.truncated, ms: rt.ms, columns: rt.columns.map((c) => c.name) }, stepAvailable,
        };
    });
    app.post('/api/db/query', async (req, reply) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        const { c, values } = dbConn(project, environment, b.alias);
        const sql = str(b.sql, 'sql', { max: 2 * 1024 * 1024 });
        if (!sql.trim()) throw new BadRequest('Write a query first.');
        const params = Array.isArray(b.params) ? (b.params as unknown[]).slice(0, 200).map((p) => String(p ?? '')) : [];
        const kind = classify(sql, c.type);
        // Any statement runs as the database login's permissions allow. Production-like environments and
        // read-only connections only run reads (the database session is read-only there too).
        const prot = protectedEnvironment(environment, values) ?? (c.readOnlyByConfig ? `DB_${c.alias}_STUDIO_READONLY=true` : null);
        if (kind.kind === 'change' && prot) return reply.code(403).send({ error: `This looks like a change (${kind.reason}). Only reads run here: ${prot}.`, code: 'db-protected' });
        // Whole-table removals run after one confirmation, as in database tools.
        const risky = prot ? null : dangerous(sql, c.type);
        if (risky && b.confirmed !== true) return reply.code(409).send({ error: `This statement removes data or objects wholesale (${risky}) on ${c.alias} in ${environment}.`, code: 'db-confirm', reason: risky });
        const maxRows = Math.max(1, Math.min(Number(b.maxRows) || 500, 100000));
        const timeoutMs = Math.max(1, Math.min(Number(b.timeoutSec) || Math.round(c.queryTimeoutMs / 1000) || 30, 3600)) * 1000;
        const started = new Date().toISOString();
        const masked = maskAll(sql).slice(0, 4000);
        try {
            const r = await dbSessions.request<Record<string, unknown>>(project, environment, { op: 'query', alias: c.alias, sql, params, maxRows, timeoutMs, mode: prot ? 'read' : 'change' }, dbDeadline(timeoutMs));
            dbHistory({ at: started, project, env: environment, alias: c.alias, sql: masked, kind: kind.kind, ok: true, rows: r.total, affected: r.affected, ms: r.ms });
            log(kind.kind === 'change' ? 'db.change' : 'db.query', `${kind.kind === 'change' ? 'Ran a change' : 'Ran a query'} on ${c.alias} (${project}/${environment})`,
                { alias: c.alias, env: environment, rows: Number(r.total ?? 0), ms: Number(r.ms ?? 0), ...(kind.kind === 'change' ? { sql: masked.slice(0, 2000), affected: Number(r.affected ?? 0) } : {}) });
            return { ...r, kind: kind.kind };
        } catch (e) {
            const msg = maskAll((e as Error).message);
            dbHistory({ at: started, project, env: environment, alias: c.alias, sql: masked, kind: kind.kind, ok: false, error: msg.slice(0, 500) });
            throw new BadRequest(msg);
        }
    });
    app.get('/api/db/ddl', async (req) => {
        const q = req.query as Record<string, unknown>;
        const { project, environment } = dbTarget(q);
        const { c } = dbConn(project, environment, q.alias);
        const kind = str(q.kind ?? 'table', 'kind', { max: 12 });
        if (!['table', 'view', 'procedure', 'function'].includes(kind)) throw new BadRequest('kind is table, view, procedure or function.');
        try { return await dbSessions.request(project, environment, { op: 'ddl', alias: c.alias, kind, schema: str(q.schema ?? '', 'schema', { max: 256 }), table: str(q.name, 'name', { max: 256 }) }, 90_000); }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/db/stop', async (req) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        const stopped = dbSessions.stop(project, environment);
        if (stopped) log('db.stop', `Stopped the database queries of ${project}/${environment}`, { env: environment });
        return { stopped };
    });
    app.get('/api/db/history', async () => { try { return { items: JSON.parse(fs.readFileSync(dbHistoryFile, 'utf8')) }; } catch { return { items: [] }; } });
    app.delete('/api/db/history', async (req) => {
        if ((req.query as Record<string, string>).confirm !== 'true') throw new BadRequest('Confirm clearing the history.');
        fs.rmSync(dbHistoryFile, { force: true });
        return { ok: true };
    });
    // Saved queries: test/<project>/queries/<name>.sql (in the project, reviewed through Git; the
    // framework's "user executes query from file" step runs them).
    const queryFileOk = (f: string) => /^test\/[A-Za-z0-9][\w.-]*\/queries\/[\p{L}\p{M}\p{N}_ .-]+\.sql$/u.test(f) && !f.includes('..');
    /** A query's file name from its name: letters of any language kept, the rest becomes "-" (up to 120 characters). */
    const queryFileName = (name: string) => { if (/[\\/]|\.\./.test(name)) throw new BadRequest(`"${name.slice(0, 60)}" cannot be a query name: no "/", "\\" or ".." (the query is saved as one file in test/<project>/queries). Use letters, digits and spaces.`); const n = name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/, ''); if (!n) throw new BadRequest('Use letters or digits in the name (it becomes the file name).'); return n; };
    app.get('/api/db/queries', async (req) => {
        const project = apiProject((req.query as Record<string, unknown>).project);
        const dir = path.join(opts.repoRoot, 'test', project, 'queries');
        let names: string[] = [];
        try { names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort(); } catch { /* none */ }
        return { queries: names.map((n) => { const text = fs.readFileSync(path.join(dir, n), 'utf8'); return { file: `test/${project}/queries/${n}`, name: n.replace(/\.sql$/i, ''), connection: /^--\s*connection:\s*(\w+)/im.exec(text)?.[1]?.toUpperCase() ?? null, size: text.length }; }) };
    });
    app.get('/api/db/query-file', async (req) => {
        const file = str((req.query as Record<string, unknown>).file, 'file', { max: 300 });
        if (!queryFileOk(file)) throw new BadRequest('Not a saved query (test/<project>/queries/<name>.sql).');
        // version: what the editor was shown; its save over a file changed since (another tab) is refused.
        try { const text = fs.readFileSync(path.join(opts.repoRoot, file), 'utf8'); return { file, text, version: contentVersion(text), connection: /^--\s*connection:\s*(\w+)/im.exec(text)?.[1]?.toUpperCase() ?? null }; }
        catch { throw new BadRequest(`${file} does not exist.`); }
    });
    app.put('/api/db/query-file', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const text = str(b.text, 'text', { max: 2 * 1024 * 1024 });
        const file = b.file ? str(b.file, 'file', { max: 300 }) : `test/${project}/queries/${queryFileName(str(b.name, 'name', { max: 120 }))}.sql`;
        if (!queryFileOk(file) || !file.startsWith(`test/${project}/queries/`)) throw new BadRequest('Not a saved query file of this project.');
        const abs = path.join(opts.repoRoot, file);
        if (!b.file && fs.existsSync(abs) && b.overwrite !== true) throw new BadRequest(`${file} already exists.`);
        // A saved query opened earlier: the version it was read at (a file deleted since reads as empty, so it is refused too).
        if (b.file) { let now = ''; try { now = fs.readFileSync(abs, 'utf8'); } catch { /* deleted since */ } checkVersion(b.version, contentVersion(now), b.force); }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
        log('db.query.save', `Saved the query ${file}`, { file });
        return { file, version: contentVersion(text) };
    });
    app.delete('/api/db/query-file', async (req) => {
        const q = req.query as Record<string, unknown>;
        const file = str(q.file, 'file', { max: 300 });
        if (!queryFileOk(file) || q.confirm !== 'true') throw new BadRequest('Confirm deleting the query.');
        fs.rmSync(path.join(opts.repoRoot, file), { force: true });
        log('db.query.delete', `Deleted the query ${file}`, { file });
        return { ok: true };
    });
    // A test from a query and its result: preview, or write <feature folder>/database/<name>.feature.
    app.post('/api/db/feature', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const name = str(b.name, 'name', { max: 200 });
        const alias = str(b.alias, 'alias', { max: 64 }).toUpperCase();
        const file = b.file ? str(b.file, 'file', { max: 300 }) : undefined;
        if (file && !queryFileOk(file)) throw new BadRequest('Not a saved query file.');
        const result = (b.result ?? {}) as DbFeatureInput['result'];
        if (!Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new BadRequest('Run the query first.');
        const checks = (b.checks ?? {}) as DbFeatureInput['checks'];
        const r = dbFeature({ name, alias, file, sql: typeof b.sql === 'string' ? b.sql : undefined, params: Array.isArray(b.params) ? (b.params as unknown[]).map(String) : [],
            result: { columns: result.columns, rows: result.rows.slice(0, 50), total: Number(result.total) || result.rows.length, truncated: !!result.truncated },
            checks: { rowCount: ['exact', 'atLeast', 'none'].includes(checks.rowCount) ? checks.rowCount : 'exact', columns: checks.columns !== false, rows: Math.max(0, Math.min(Number(checks.rows) || 0, 50)), firstRow: checks.firstRow === true } });
        const stepPath = resolveFor(project, (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev').entries.find((e) => e.key === 'STEP_DEFINITIONS_PATH')?.value ?? '';
        if (!/node_modules/.test(stepPath) || !/cs-playwright-test-framework/.test(stepPath)) r.warnings.unshift(`STEP_DEFINITIONS_PATH of ${project} does not name the framework package: its database steps are not loaded. Add node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps/database to it.`);
        const folder = projectFeatureFolder(opts.repoRoot, project) ?? `test/${project}/features`;
        const out = `${folder}/database/${dbFeatureSlug(name)}.feature`;
        const abs = path.join(opts.repoRoot, out);
        const exists = fs.existsSync(abs);
        // Through the framework core: every line checked against the steps the project loads.
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const model = projectModel(project, env);
        const change: ChangePlan = { title: `Test from a query on ${alias}`, files: [{ path: out, kind: 'feature', text: r.text }], warnings: r.warnings };
        if (b.save !== true) return { file: out, exists, text: r.text, warnings: r.warnings, current: exists ? fs.readFileSync(abs, 'utf8') : undefined, review: await reviewOf(change, model) };
        if (exists && b.overwrite !== true && !b.baseHashes) throw new BadRequest(`${out} already exists.`);
        const applied = applyOf(change, model, b);
        log('db.feature', `Wrote ${out} from a query on ${alias}`, { file: out, ...(applied.recoveryDir ? { recoveryDir: relPath(applied.recoveryDir) } : {}) });
        return { file: out, exists: true, text: r.text, warnings: r.warnings };
    });
    app.post('/api/db/export', async (req, reply) => {
        const b = body(req);
        const columns = Array.isArray(b.columns) ? (b.columns as Array<{ name: string }>).map((c) => String(c?.name ?? '')) : [];
        const rows = Array.isArray(b.rows) ? (b.rows as Cell[][]).slice(0, 100000) : [];
        const buf = xlsx([{ name: str(b.sheet ?? 'Result', 'sheet', { max: 31 }) || 'Result', columns, rows: rows.map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === 'number' || typeof c === 'boolean' ? c : c === null ? null : cellText(c))) : [])) }]);
        return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="query-result.xlsx"').send(buf);
    });

    // Recorder: Playwright's recorder on this computer → feature, test data, page objects, steps and
    // configuration, built on what the project already has (src/recorder/generate.ts).
    const recorder = new RecorderSessions({ repoRoot: opts.repoRoot, dir: path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'recordings') });
    app.addHook('onClose', async () => { recorder.stopAll(); });
    // The framework core (src/framework): one project model, one standards check, one review and apply.
    const modelDeps: ModelDeps = {
        repoRoot: opts.repoRoot,
        featureFolder: (project) => projectFeatureFolder(opts.repoRoot, project),
        configLayers: (project, env) => fileLayerPaths(opts.repoRoot, project, env),
        readLayer: (source, label) => readFileLayer(opts.repoRoot, source, label),
        stepFolders: (configured) => stepFolders(opts.repoRoot, configured),
        stepDefs: (project) => { stepCache = null; return stepIndex.all(project); },
        values: (project, env) => dbValues(project, env),
    };
    const projectModel = (project: string, env: string): ProjectModel => loadProjectModel(require('typescript') as typeof import('typescript'), modelDeps, project, env);
    const beforeOf = (p: string): string | null => { try { return fs.readFileSync(path.join(opts.repoRoot, p), 'utf8'); } catch { return null; } };
    const secretValues = () => (opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : []);
    /** Review a plan: diffs and the framework's standards. */
    const reviewOf = async (plan: ChangePlan, model: ProjectModel, display?: (t: string) => string) => {
        const findings: Finding[] = checkPlan(require('typescript') as typeof import('typescript'), plan, model, { secretValues: secretValues(), before: beforeOf, repoRoot: opts.repoRoot });
        return reviewPlan(opts.repoRoot, plan, findings, display);
    };
    /** Apply a reviewed plan: refused when a file changed since the review, or (unless forced) when the review found errors. */
    const applyOf = (plan: ChangePlan, model: ProjectModel, b: Record<string, unknown>, transform?: (f: { path: string }, t: string) => string) => {
        const baseHashes = b.baseHashes && typeof b.baseHashes === 'object' ? Object.fromEntries(Object.entries(b.baseHashes as Record<string, unknown>).filter(([, v]) => v === null || typeof v === 'string').map(([k, v]) => [k, v as string | null])) : undefined;
        if (b.force !== true) {
            const errors = checkPlan(require('typescript') as typeof import('typescript'), plan, model, { secretValues: secretValues(), before: beforeOf, repoRoot: opts.repoRoot }).filter((x) => x.level === 'error');
            if (errors.length) throw new BadRequest(`The framework check found ${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors.slice(0, 3).map((x) => `${x.file ?? ''}${x.line ? `:${x.line}` : ''} ${x.message}`).join(' ')}${errors.length > 3 ? ' …' : ''} Fix them, or apply anyway.`);
        }
        try {
            const r = applyPlan(opts.repoRoot, plan, { baseHashes, transform, encode: (f, text) => workbookBytes(opts.repoRoot, f.path, f.encode!.sheet, text), recoveryDir: path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'recovery', new Date().toISOString().replace(/[:.]/g, '-')) });
            stepCache = null;
            return r;
        } catch (e) {
            if (e instanceof PlanConflictError) throw new BadRequest(e.message);
            throw new BadRequest((e as Error).message);
        }
    };
    const relPath = (abs: string) => path.relative(opts.repoRoot, abs).split(path.sep).join('/');

    // ---- PDF checks: any PDF against a data file, a query, another PDF or typed values (the framework's comparison).
    const pdfReports = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'pdf-compare');
    const pdfOptions = (b: Record<string, unknown>): CheckOptions & { password?: string } => {
        const o = (b.options && typeof b.options === 'object' ? b.options : {}) as Record<string, unknown>;
        const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
        return {
            key: typeof b.key === 'string' && b.key.trim() ? str(b.key, 'key', { max: 200 }).trim() : undefined,
            tolerance: Number(o.tolerance) > 0 ? Number(o.tolerance) : undefined,
            caseSensitive: o.caseSensitive === true, dayFirst: o.dayFirst === true, extraRows: o.extraRows === true, rowOrder: o.rowOrder === true,
            keyColumns: list(o.keyColumns), ignore: list(o.ignore).map((x) => x.slice(0, 500)),
            pages: typeof o.pages === 'string' ? o.pages.slice(0, 100) : undefined,
            password: typeof b.password === 'string' && b.password ? b.password : undefined,
        };
    };
    /** The CompareOptions the framework takes, from the screen's options. */
    const frameworkOptions = (o: CheckOptions & { password?: string }) => ({
        ...(o.tolerance ? { numberTolerance: o.tolerance } : {}), caseSensitive: o.caseSensitive, dayFirst: o.dayFirst, failOnExtraRows: o.extraRows, rowOrder: o.rowOrder,
        ...(o.keyColumns?.length ? { keyColumns: o.keyColumns } : {}), ...(o.ignore?.length ? { ignore: o.ignore } : {}), password: o.password,
        ...(o.pages ? { pages: o.pages.split(',').flatMap((x) => { const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(x); return m ? Array.from({ length: Math.min(+m[2] - +m[1] + 1, 5000) }, (_, i) => +m[1] + i) : [Number(x)]; }).filter((n) => n > 0) } : {}),
    });
    const pdfSource = (x: unknown): CheckSource => {
        const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        if (s.kind === 'file') return { kind: 'file', file: str(s.file, 'file', { max: 300 }), ...(typeof s.sheet === 'string' && s.sheet ? { sheet: str(s.sheet, 'sheet', { max: 100 }) } : {}) };
        if (s.kind === 'query') return { kind: 'query', connection: str(s.connection, 'connection', { max: 64 }).toUpperCase(), sql: str(s.sql, 'sql', { max: 100_000 }) };
        if (s.kind === 'pdf') return { kind: 'pdf', file: str(s.file, 'file', { max: 300 }) };
        if (s.kind === 'values') {
            const rows = Array.isArray(s.rows) ? (s.rows as unknown[]).slice(0, 2000).map((r) => (Array.isArray(r) ? r.slice(0, 50).map((c) => String(c ?? '').slice(0, 2000)) : [])) : [];
            return { kind: 'values', rows };
        }
        throw new BadRequest('Choose what to compare the PDF with.');
    };
    const pdfAbs = (p: unknown) => { try { return pdfPathIn(opts.repoRoot, str(p, 'pdf', { max: 500 })); } catch (e) { throw new BadRequest((e as Error).message); } };
    app.get('/api/pdf/list', async () => ({ files: listPdfs(opts.repoRoot), engine: compareModuleDir(opts.repoRoot)?.from ?? null }));
    app.get('/api/pdf/file', async (req, reply) => {
        const abs = pdfAbs((req.query as Record<string, unknown>).path);
        return reply.type('application/pdf').header('Content-Disposition', 'inline').send(fs.createReadStream(abs));
    });
    app.post('/api/pdf/upload', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        // The file's own name (letters of any language kept); characters that are not safe in a file name become "_".
        const name = path.basename(str(b.name, 'name', { max: 200 })).normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200d\ufe0f._\- ]+/gu, '_').replace(/^[.\s]+/, '');
        if (!/\.pdf$/i.test(name) || name.length < 5) throw new BadRequest('Choose a .pdf file.');
        const data = Buffer.from(str(b.data, 'data', { optional: true, max: 16 * 1024 * 1024 }) ?? '', 'base64');
        if (!data.length) throw new BadRequest(`${name} is empty (0 bytes): choose a PDF file with content.`);
        if (data.subarray(0, 1024).indexOf('%PDF-') < 0) throw new BadRequest('That file is not a PDF.');
        // A file whose name differs only in capitals is the same file on Windows and macOS: it is that file.
        const pdfDir = path.join(opts.repoRoot, `test/${project}/data/pdf`);
        const same = (fs.existsSync(pdfDir) ? fs.readdirSync(pdfDir) : []).find((f) => f.toLowerCase() === name.toLowerCase());
        const rel = `test/${project}/data/pdf/${same ?? name}`;
        // A file with that name is replaced only when the person said so.
        if (same && b.replace !== true) throw new Conflict(`${rel} exists${same !== name ? ` (the same name as ${name} on Windows and macOS)` : ''}.`);
        const replaced = !!same;
        fs.mkdirSync(path.dirname(path.join(opts.repoRoot, rel)), { recursive: true });
        fs.writeFileSync(path.join(opts.repoRoot, rel), data);
        log('pdf.upload', `${replaced ? 'Replaced' : 'Added'} ${rel}`, { file: rel });
        return { path: rel };
    });
    app.post('/api/pdf/inspect', async (req) => {
        const b = body(req);
        const abs = pdfAbs(b.path);
        try { return await inspectPdf(compareModule(opts.repoRoot), abs, typeof b.password === 'string' && b.password ? b.password : undefined); }
        catch (e) { throw new BadRequest((e as Error).message.split('\n')[0]); }
    });
    app.post('/api/pdf/compare', async (req) => {
        const b = body(req);
        const { project, environment } = dbTarget(b);
        const pdfRel = str(b.pdf, 'pdf', { max: 500 });
        const abs = pdfAbs(pdfRel);
        const source = pdfSource(b.source);
        const o = pdfOptions(b);
        const fo = frameworkOptions(o);
        const mod = compareModule(opts.repoRoot);
        const t0 = Date.now();
        let result: Record<string, unknown>;
        try {
            const load = (p: string) => mod.CSPdfContent.load(p, { password: o.password, pages: fo.pages, name: relPath(p) });
            const pdf = await load(abs);
            const rowsOf = (data: unknown): Array<Record<string, unknown>> => {
                if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
                const arr = data && typeof data === 'object' ? Object.values(data as Record<string, unknown>).find((v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object')) : undefined;
                if (!arr) throw new Error('The file holds no list of records.');
                return arr as Array<Record<string, unknown>>;
            };
            if (source.kind === 'pdf') result = mod.compareTwoPdfs(await load(pdfAbs(source.file)), pdf, fo);
            else if (source.kind === 'values') result = mod.compareWithPdf(mod.expectedFromDataTable(source.rows, 'expected values', 'values typed in the Studio'), pdf, fo);
            else if (source.kind === 'file' && /\.(json|ya?ml)$/i.test(source.file)) {
                const fileAbs = path.resolve(opts.repoRoot, source.file);
                if (!fileAbs.startsWith(path.resolve(opts.repoRoot) + path.sep) || !fs.existsSync(fileAbs)) throw new Error(`Not found: ${source.file}`);
                const text = fs.readFileSync(fileAbs, 'utf8');
                const data = /\.json$/i.test(source.file) ? JSON.parse(text) : (require('js-yaml') as { load(t: string): unknown }).load(text);
                if (o.key) result = mod.compareRecords(rowsOf(data), o.key, pdf, source.file, fo);
                else { const e = mod.expectedFromObject(data, source.file, path.basename(source.file)); result = mod.compareWithPdf(e.expected, pdf, { ...e.options, ...fo }); }
            } else {
                if (source.kind === 'api') throw new Error('API responses are compared in a test run (the step uses a saved response).');
                const ds = source.kind === 'file' ? { kind: 'file', file: source.file, ...(source.sheet ? { sheet: source.sheet } : {}) } : { kind: 'query', connection: source.connection, sql: source.sql };
                let rows: Array<Record<string, unknown>>;
                try { rows = await dataRowsFor(project, environment, ds); }
                catch (e) {
                    // A repository without the framework installed: files are still read, by the framework the Studio has.
                    if (source.kind !== 'file' || !/not installed/i.test((e as Error).message)) throw e;
                    const dir = compareModuleDir(opts.repoRoot)!.dir;
                    const { CSDataProvider } = require(path.join(dir, 'dist', 'data', 'CSDataProvider.js')) as { CSDataProvider: { getInstance(): { loadData(o: Record<string, unknown>): Promise<Array<Record<string, unknown>>> } } };
                    rows = await CSDataProvider.getInstance().loadData({ source: path.join(opts.repoRoot, source.file), ...(source.sheet ? { sheet: source.sheet } : {}), noCache: true });
                }
                const label = source.kind === 'file' ? `${source.file}${source.sheet ? ` (sheet ${source.sheet})` : ''}` : `query on ${source.connection} (${environment})`;
                result = o.key ? mod.compareRecords(rows, o.key, pdf, label, fo) : mod.compareWithPdf(mod.expectedFromRows(rows, source.kind === 'file' ? path.basename(source.file) : 'query result', label), pdf, fo);
            }
        } catch (e) { throw new BadRequest(maskAll((e as Error).message.split('\n').slice(0, 3).join('\n'))); }
        const r = result as { passed: boolean; findings: unknown[]; matched: unknown[]; counts: Record<string, number> };
        let reportId: string | null = null;
        try { reportId = path.basename(mod.writeCompareReport(result, pdfReports, path.basename(pdfRel, '.pdf')).html); } catch { /* the result is still returned */ }
        log('pdf.compare', `Compared ${pdfRel} with ${source.kind === 'pdf' || source.kind === 'file' ? source.file : source.kind === 'query' ? `a query on ${source.connection}` : 'typed values'}: ${r.passed ? 'passed' : `${r.findings.length} difference(s)`}`, { file: pdfRel, passed: r.passed, ms: Date.now() - t0 });
        return { ...result, findings: r.findings.slice(0, 2000), matched: r.matched.slice(0, 2000), reportId, summary: mod.summaryLine(result), steps: checkSteps(pdfRel, source, o) };
    });
    app.get('/api/pdf/report/:id', async (req, reply) => {
        const id = path.basename(str((req.params as { id: string }).id, 'id', { max: 200 }));
        const f = path.join(pdfReports, id);
        if (!/\.html$/.test(id) || !fs.existsSync(f)) throw new BadRequest('No such report.');
        return reply.type('text/html; charset=utf-8').send(fs.readFileSync(f, 'utf8'));
    });
    app.post('/api/pdf/feature', async (req) => {
        const b = body(req);
        const project = apiProject(b.project);
        const name = str(b.name, 'name', { max: 200 }).trim() || 'PDF check';
        const pdfRel = str(b.pdf, 'pdf', { max: 500 });
        pdfAbs(pdfRel);
        let text: string;
        try { text = pdfCheckFeature(name, pdfRel, pdfSource(b.source), pdfOptions(b), Array.isArray(b.tags) ? (b.tags as unknown[]).map(String).slice(0, 10) : []); }
        catch (e) { throw new BadRequest((e as Error).message); }
        const folder = projectFeatureFolder(opts.repoRoot, project) ?? `test/${project}/features`;
        const out = `${folder}/pdf/${pdfFeatureSlug(name)}.feature`;
        const abs = path.join(opts.repoRoot, out);
        const exists = fs.existsSync(abs);
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const warnings: string[] = [];
        const stepPath = resolveFor(project, env).entries.find((e) => e.key === 'STEP_DEFINITIONS_PATH')?.value ?? '';
        if (stepPath && !/cs-playwright-test-framework/.test(stepPath)) warnings.push(`STEP_DEFINITIONS_PATH of ${project} does not name the framework package: its PDF comparison steps are not loaded. Add node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps/report-validation to it.`);
        const model = projectModel(project, env);
        const change: ChangePlan = { title: `PDF check ${name}`, files: [{ path: out, kind: 'feature', text }], warnings };
        if (b.save !== true) return { file: out, exists, text, warnings, current: exists ? fs.readFileSync(abs, 'utf8') : undefined, review: await reviewOf(change, model) };
        if (exists && b.overwrite !== true && !b.baseHashes) throw new BadRequest(`${out} already exists.`);
        const applied = applyOf(change, model, b);
        log('pdf.feature', `Wrote ${out}`, { file: out, ...(applied.recoveryDir ? { recoveryDir: relPath(applied.recoveryDir) } : {}) });
        return { file: out, exists: true, text, warnings };
    });
    const recContext =(project: string, env: string): ProjectModel => projectModel(project, env);
    /** The recording's data file choice, validated, with the file's rows as they are now. */
    const recData = (x: unknown, ctx: ProjectModel, name: string): { choice: DataChoice; path: string; raw?: string } => {
        const d = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const opt = (k: string, max: number) => (typeof d[k] === 'string' && (d[k] as string).trim() && (d[k] as string).length <= max ? (d[k] as string).trim() : undefined);
        const choice: DataChoice = { format: d.format === 'csv' || d.format === 'excel' ? d.format : 'json', sheet: opt('sheet', 31), path: opt('path', 200), filter: opt('filter', 500) };
        const file = opt('file', 300);
        if (file) {
            if (!formatOf(file)) throw new BadRequest('Test data: a .json, .csv, .xlsx, .xls or .xml file.');
            try { safePath(opts.repoRoot, file); } catch (e) { throw new BadRequest((e as Error).message); }
            if (!fs.existsSync(path.join(opts.repoRoot, file))) throw new BadRequest(`Test data: ${file} does not exist.`);
            choice.file = file;
        }
        const slug = kebab(name) || 'recorded';
        const target = choice.file ?? `${ctx.dataFolder}/${slug}.${choice.format === 'excel' ? 'xlsx' : choice.format}`;
        if (!fs.existsSync(path.join(opts.repoRoot, target))) return { choice, path: target };
        try { choice.existing = readTable(opts.repoRoot, target, { sheet: choice.sheet, path: choice.path }); }
        catch (e) { throw new BadRequest(`Test data: ${(e as Error).message}`); }
        return { choice, path: target, raw: formatOf(target) === 'json' ? fs.readFileSync(path.join(opts.repoRoot, target), 'utf8') : undefined };
    };
    // The project's data files (to use one for a recording), and a file's columns.
    app.get('/api/recorder/data-files', async (req) => {
        const project = apiProject((req.query as Record<string, unknown>).project);
        const out: Array<{ path: string; format: string }> = [];
        const walk = (dir: string, depth: number) => {
            let es: fs.Dirent[] = [];
            try { es = fs.readdirSync(path.join(opts.repoRoot, dir), { withFileTypes: true }); } catch { return; }
            for (const e of es) {
                const r = `${dir}/${e.name}`;
                if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && e.name !== 'uploads') walk(r, depth - 1);
                else if (e.isFile() && formatOf(e.name) && out.length < 500) out.push({ path: r, format: formatOf(e.name)! });
            }
        };
        walk(`test/${project}/data`, 3);
        return { files: out.sort((a, b) => a.path.localeCompare(b.path)) };
    });
    app.post('/api/recorder/data-file', async (req) => {
        const b = body(req);
        const file = str(b.file, 'file', { max: 300 });
        if (!formatOf(file)) throw new BadRequest('A .json, .csv, .xlsx, .xls or .xml file.');
        try { safePath(opts.repoRoot, file); } catch (e) { throw new BadRequest((e as Error).message); }
        try {
            const t = readTable(opts.repoRoot, file, { sheet: typeof b.sheet === 'string' ? b.sheet : undefined, path: typeof b.path === 'string' && b.path ? b.path : undefined });
            return { columns: t.columns, rows: t.rows.length, sheets: t.sheets ?? [], format: formatOf(file), readOnly: formatOf(file) === 'xml' };
        } catch (e) { throw new BadRequest((e as Error).message.split('\n')[0]); }
    });
    const recPlan = async (b: Record<string, unknown>) => {
        const project = str(b.project, 'project', { max: 64 });
        if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(project)) throw new BadRequest('A project name: letters, digits, ., - and _.');
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const name = str(b.name, 'name', { max: 80 }).trim();
        if (!/[\p{L}\p{N}]/u.test(name)) throw new BadRequest('Name the recording (letters or digits, in any language).');
        const script = str(b.script, 'script', { max: 2 * 1024 * 1024 });
        const num = (o: unknown) => (o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).filter(([k]) => /^\d+$/.test(k)) : []);
        const breaks: Record<number, string> = {};
        for (const [k, v] of num(b.breaks)) if (typeof v === 'string' && v.length <= 60) breaks[Number(k)] = v;
        const values: Choices['values'] = {};
        for (const [k, v] of num(b.values)) {
            const x = v as { mode?: unknown; column?: unknown };
            values[Number(k)] = { ...(['data', 'fixed', 'secret', 'unique', 'date'].includes(String(x?.mode)) ? { mode: x.mode as ValueMode } : {}), ...(typeof (x as { when?: unknown }).when === 'string' && ((x as { when: string }).when).length <= 60 ? { when: (x as { when: string }).when } : {}), ...(typeof (x as { format?: unknown }).format === 'string' && /^[dMy\/.\- ,]{4,20}$/.test((x as { format: string }).format) ? { format: (x as { format: string }).format } : {}), ...(typeof x?.column === 'string' && x.column.length <= 60 ? { column: x.column } : {}) };
        }
        const labels: Record<string, string> = {};
        if (b.labels && typeof b.labels === 'object') for (const [k, v] of Object.entries(b.labels as Record<string, unknown>)) if (typeof v === 'string' && v.length <= 80 && k.length <= 2000) labels[k] = v;
        // The tester's locator choices (element key → one of its confirmed framework locators).
        const locators: NonNullable<Choices['locators']> = {};
        if (b.locators && typeof b.locators === 'object') for (const [k, v] of Object.entries(b.locators as Record<string, unknown>)) {
            const x = v as { key?: unknown; value?: unknown } | null;
            if (k.length <= 2000 && x && ['testId', 'id', 'name', 'role', 'text'].includes(String(x.key)) && typeof x.value === 'string' && x.value.length <= 300) locators[k] = { key: x.key as 'testId', value: x.value };
        }
        // The project's locator policy (common env); a pattern that does not read is reported, not used.
        let policyOf: ReturnType<typeof locatorPolicy> = { policy: {}, problems: [] };
        try { policyOf = locatorPolicy(dbValues(project, env)); } catch { /* no config: no policy */ }
        const ts = require('typescript') as typeof import('typescript');
        // A script that is not valid JavaScript/TypeScript: said, not converted into "nothing recorded".
        {
            const sf = ts.createSourceFile('recording.spec.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) as unknown as { parseDiagnostics?: Array<{ start?: number; messageText: unknown }> };
            const d = sf.parseDiagnostics?.[0];
            if (d) {
                const line = d.start !== undefined ? script.slice(0, d.start).split('\n').length : 0;
                throw new BadRequest(`The script is not valid JavaScript/TypeScript${line ? ` (line ${line})` : ''}: ${typeof d.messageText === 'string' ? d.messageText.replace(/\.+$/, '') : 'it cannot be read'}.`);
            }
        }
        const conv = convertScript(ts, script, { testIdAttribute: typeof b.testIdAttribute === 'string' && /^[\w-]{1,60}$/.test(b.testIdAttribute) ? b.testIdAttribute : undefined });
        let ctx = recContext(project, env);
        // Values taken from test data while recording: a file becomes the scenario's data; a database
        // query read in every run; any source's rows copied into the data file now.
        const bindings = dataBindings(script, conv.actions);
        const bindWarnings: string[] = [];
        const dataIn = (b.data && typeof b.data === 'object' ? { ...(b.data as Record<string, unknown>) } : {}) as Record<string, unknown>;
        const fetched: Choices['fetched'] = {};
        const sources: Choices['sources'] = {};
        let copied: { name: string; table: { columns: string[]; rows: Array<Record<string, string>> } } | undefined;
        for (const [k, bd] of Object.entries(bindings)) {
            const i = Number(k);
            const src = bd.source as Record<string, unknown>;
            const nameOk = /^[A-Za-z][\w-]{0,39}$/.test(bd.name);
            if (!nameOk) { bindWarnings.push(`Step ${i + 1}: the test data name "${bd.name}" is not valid (letters, digits, - and _): its value is written as it was recorded.`); continue; }
            if (bd.mode === 'file' && src.kind === 'file' && typeof src.file === 'string') {
                if (dataIn.file && dataIn.file !== src.file) { bindWarnings.push(`Step ${i + 1} took its value from ${src.file}, but the test data is ${String(dataIn.file)}: choose one file.`); continue; }
                if (!dataIn.file) Object.assign(dataIn, { file: src.file, sheet: src.sheet, path: src.path, ...(src.filter ? { filter: src.filter } : {}) });
                values[i] = { ...values[i], mode: values[i]?.mode ?? 'data', column: values[i]?.column ?? bd.column };
            } else if (bd.mode === 'run' && src.kind === 'api' && typeof src.collection === 'string' && typeof src.request === 'string') {
                fetched[i] = { name: bd.name, column: bd.column };
                sources[bd.name] = { kind: 'api', collection: src.collection, request: src.request, ...(typeof src.path === 'string' && src.path ? { path: src.path } : {}) };
            } else if (bd.mode === 'run' && (src.kind === 'query' || src.kind === 'procedure') && typeof src.connection === 'string') {
                fetched[i] = { name: bd.name, column: bd.column };
                sources[bd.name] = { kind: src.kind, connection: src.connection, ...(src.kind === 'query' ? { sql: String(src.sql ?? '') } : { procedure: String(src.procedure ?? '') }), ...(Array.isArray(src.params) && src.params.length ? { params: (src.params as unknown[]).map(String) } : {}) };
            } else if (bd.mode === 'copy') {
                if (copied && copied.name !== bd.name) { bindWarnings.push(`Step ${i + 1}: only one source's rows can be copied into the data file (${copied.name}); its value is written as recorded.`); continue; }
                if (dataIn.file) { bindWarnings.push(`Step ${i + 1}: the rows of "${bd.name}" are not copied: the test data is the file ${String(dataIn.file)}.`); continue; }
                if (!copied) {
                    let r;
                    try { r = await loadDataRows({ repoRoot: opts.repoRoot, project, environment: env, source: src, secretEnv: dbSecretEnv(project, env), sessions: dbSessions, connection: netConnection(), timeoutMs: 120_000 }); }
                    catch (e) { throw new BadRequest(`Test data "${bd.name}": ${(e as Error).message.split('\n')[0]}`); }
                    const rows = r.rows.slice(0, 200);
                    if (!rows.length) { bindWarnings.push(`The test data "${bd.name}" has no rows now: nothing to copy.`); continue; }
                    copied = { name: bd.name, table: { columns: ['testCaseId', 'description', 'runFlag', ...r.columns.filter((c) => !['testCaseId', 'description', 'runFlag'].includes(c))], rows: rows.map((x, n) => ({ ...x, testCaseId: `TC${String(n + 1).padStart(2, '0')}`, description: `${name}: ${bd.name} row ${n + 1}`, runFlag: 'Yes' })) } };
                    if (r.total > rows.length) bindWarnings.push(`The first ${rows.length} of ${r.total} rows of "${bd.name}" are copied into the data file.`);
                }
                values[i] = { ...values[i], mode: 'data', column: bd.column };
            }
        }
        // The test data file: a new one in a format, or one of the project's; read as it is now.
        const data = recData(dataIn, ctx, name);
        if (data.raw !== undefined) ctx = { ...ctx, files: { ...ctx.files, [data.path]: data.raw } };
        if (copied && !data.choice.file) {
            if (data.choice.existing) bindWarnings.push(`${data.path} is replaced by the rows of "${copied.name}".`);
            data.choice.existing = copied.table; data.choice.fresh = true;
        }
        // Pages the recorder saw change, unless the tester named pages there.
        // The sign-in: the steps up to a check that shows the user is signed in (the repository's .gitignore gets .auth/).
        const signIn = b.signIn && typeof b.signIn === 'object' && Number.isInteger((b.signIn as { marker?: unknown }).marker) ? { marker: (b.signIn as { marker: number }).marker } : undefined;
        if (signIn) { const gi = beforeOf('.gitignore'); if (gi !== null) ctx = { ...ctx, files: { ...ctx.files, '.gitignore': gi } }; }
        const p = plan(ts, conv.actions, ctx, { pkg: frameworkPackageName(opts.repoRoot), name, breaks: { ...markedBreaks(script, conv.actions), ...breaks }, values, labels, locators, policy: policyOf.policy, secretMode: b.secretMode === 'studio' ? 'studio' : 'encrypted', data: data.choice, fetched, sources, signIn,
            remembered: rememberedValues(script),
            optional: Object.fromEntries((Array.isArray(b.optional) ? (b.optional as unknown[]) : []).filter((x) => Number.isInteger(x)).map((x) => [x as number, true])),
            // Reusable steps: ranges of actions with a name (and the step's text).
            blocks: (Array.isArray(b.blocks) ? (b.blocks as unknown[]) : []).slice(0, 50).flatMap((x) => {
                const o = (x ?? {}) as { from?: unknown; to?: unknown; name?: unknown; text?: unknown };
                if (!Number.isInteger(o.from) || !Number.isInteger(o.to) || typeof o.name !== 'string' || !o.name.trim() || o.name.length > 200) return [];
                return [{ from: o.from as number, to: o.to as number, name: o.name, ...(typeof o.text === 'string' && o.text.length <= 300 ? { text: o.text } : {}) }];
            }) });
        p.warnings.unshift(...bindWarnings, ...policyOf.problems);
        // The picker shows each locator's grade as the framework's locator linter gives it.
        const sup = locatorSupport(opts.repoRoot);
        const graded = (l: { key: string; value: string; score: number }) => {
            if (!sup.scorer) return l;
            try { const g = sup.scorer(l.key, l.value); return { ...l, tier: g.tier, reasons: g.reasons.slice(0, 4) }; } catch { return l; }
        };
        const shown = (t: string) => t.replace(/__CS_ENCRYPT_\d+__/g, 'ENCRYPTED:(encrypted when saved)');
        const change: ChangePlan = { title: `Recording "${name}"`, files: p.files.map((f) => ({ path: f.path, kind: f.kind, text: f.text, ...(f.encode ? { encode: f.encode, shownBefore: f.shownBefore } : {}) })), warnings: [...conv.warnings, ...p.warnings] };
        return {
            project, env, plan: p, conv, ctx, change, shown,
            out: {
                rows: p.rows.map((r, i) => ({ ...r, ...(r.locators ? { locators: r.locators.map(graded) } : {}), selector: conv.actions[i]?.target?.selector, frames: conv.actions[i]?.target?.frames ?? [], ...(conv.actions[r.index]?.line ? { scriptLine: conv.actions[r.index].line } : {}) })),
                files: p.files.map((f) => ({ ...f, text: shown(f.text) })),
                pages: p.pages, secrets: p.secrets.map((x) => x.name), warnings: [...conv.warnings, ...p.warnings], summary: p.summary,
                existingPages: ctx.pages.map((x) => x.className).sort(),
                folders: { featureFolder: ctx.featureFolder, stepsFolder: ctx.stepsFolder, pagesFolder: ctx.pagesFolder, dataFolder: ctx.dataFolder },
            },
        };
    };
    /** What a recording takes from the project: the size its tests run at, its locator policy. */
    const recProjectOpts = (project: string, env: string) => {
        // Record at the size the project's tests run at (responsive pages show other elements at other sizes).
        let viewport: { width: number; height: number } | undefined;
        let policy: { ignoreId?: string; ignoreClass?: string } | undefined;
        try {
            const v = dbValues(project, env);
            const w = Number(v.BROWSER_VIEWPORT_WIDTH), h = Number(v.BROWSER_VIEWPORT_HEIGHT);
            if (w >= 320 && w <= 3840 && h >= 320 && h <= 2160) viewport = { width: Math.round(w), height: Math.round(h) };
            // The project's locator policy (common env), applied while recording too.
            const pol = locatorPolicy(v).policy;
            if (pol.ignoreId || pol.ignoreClass) policy = { ignoreId: pol.ignoreId?.source, ignoreClass: pol.ignoreClass?.source };
        } catch { /* the defaults */ }
        return { viewport, policy };
    };
    // Record from a step of a finished recording (its steps up to it done again, new ones after it).
    app.post('/api/recorder/:id/continue', async (req) => {
        const b = body(req);
        const id = str((req.params as { id: string }).id, 'id', { max: 40 });
        const project = str(b.project, 'project', { max: 64 });
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const at = Number(b.at);
        if (!Number.isInteger(at) || at < 0) throw new BadRequest('Choose the step to record from.');
        const n = personal().network;
        try {
            const r = await recorder.continueStudio(id, at, { ...recProjectOpts(project, env), ignoreHttpsErrors: b.ignoreHttpsErrors === true,
                ...(n.proxyMode === 'manual' && n.proxyUrl ? { proxy: { server: n.proxyUrl, bypass: n.bypass.join(',') } } : {}) });
            log('recorder.continue', `Recording again from step ${at + 1}`, { env });
            return r;
        } catch (e) { throw new BadRequest((e as Error).message.split('\n')[0]); }
    });
    app.post('/api/recorder/start', async (req) => {
        const b = body(req);
        const project = str(b.project, 'project', { max: 64 });
        const env = b.env ? envParam(b.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const url = (typeof b.url === 'string' && b.url.trim()) || (fs.existsSync(path.join(opts.repoRoot, 'config', project)) ? dbValues(project, env).BASE_URL ?? '' : '');
        if (!url) throw new BadRequest(`Enter the address to record (BASE_URL is not set for ${project}/${env}).`);
        const n = personal().network;
        const browser = ['chromium', 'firefox', 'webkit', 'msedge', 'chrome'].includes(String(b.browser)) ? b.browser as RecordOptions['browser'] : 'chromium';
        const { viewport, policy } = recProjectOpts(project, env);
        const startOpts = { url, browser, viewport, policy, testIdAttribute: typeof b.testIdAttribute === 'string' && b.testIdAttribute.trim() ? b.testIdAttribute.trim() : undefined,
            device: typeof b.device === 'string' && b.device.trim() ? b.device.trim() : undefined, ignoreHttpsErrors: b.ignoreHttpsErrors === true, window: b.window === true,
            ...(n.proxyMode === 'manual' && n.proxyUrl ? { proxy: { server: n.proxyUrl, bypass: n.bypass.join(',') } } : {}) };
        try {
            // In the Studio (default): the application in the Studio's own browser, shown live.
            const r = b.engine === 'playwright' ? recorder.start(startOpts) : await recorder.startStudio(startOpts);
            if (r.state === 'failed') throw new Error(r.error ?? 'The recording could not start.');
            log('recorder.start', `Started recording ${url}${r.engine === 'studio' ? (r.window ? ' (in a browser window)' : ' (in the Studio)') : ''}`, { env });
            return { ...r, warnings: n.proxyMode === 'manual' && n.proxyUser ? ['The recorded browser uses the proxy without its login: sign in to the proxy in the browser if it asks.'] : [] };
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // A new project, laid out as the team's projects are (framework defaults in config/global.env): reviewed, then written.
    const newProjectOf = (b: Record<string, unknown>): NewProject => {
        const slug = str(b.slug, 'slug', { max: 40 });
        if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new BadRequest('Project name: lower case letters, digits and hyphens, starting with a letter (e.g. crm or claims-portal).');
        const url = (v: unknown, what: string, optional = false): string | undefined => {
            if (optional && (v === undefined || v === null || v === '')) return undefined;
            const t = str(v, what, { max: 500 });
            let u: URL; try { u = new URL(t); } catch { throw new BadRequest(`${what}: not an address (https://…).`); }
            if (!/^https?:$/.test(u.protocol)) throw new BadRequest(`${what}: an http(s) address.`);
            return t;
        };
        const envs = (Array.isArray(b.environments) ? b.environments as Array<Record<string, unknown>> : []).slice(0, 8).map((e) => {
            const name = str(e?.name, 'environment', { max: 20 });
            if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new BadRequest(`Environment "${name}": lower case letters, digits and hyphens.`);
            return { name, baseUrl: url(e.baseUrl, `${name}: application address`)!, loginUrl: url(e.loginUrl, `${name}: sign-in address`, true), apiBaseUrl: url(e.apiBaseUrl, `${name}: API address`, true) };
        });
        if (!envs.length) throw new BadRequest('Add at least one environment with the application\'s address.');
        if (new Set(envs.map((e) => e.name)).size !== envs.length) throw new BadRequest('Each environment once.');
        const dbType = (DB_TYPES as readonly string[]).includes(String(b.dbType ?? 'none')) ? String(b.dbType ?? 'none') as NewProject['dbType'] : 'none';
        const opt = (o: unknown, k: string) => { const v = (o as Record<string, unknown> | undefined)?.[k]; return typeof v === 'string' && v && v.length <= 200 ? v : undefined; };
        const display = typeof b.displayName === 'string' && b.displayName.trim().length <= 80 ? b.displayName.trim() : undefined;
        return { slug, displayName: display, environments: envs, dbType, credentials: { username: opt(b.credentials, 'username'), password: opt(b.credentials, 'password') } };
    };
    app.post('/api/projects/new/preview', async (req) => {
        const input = newProjectOf((req.body ?? {}) as Record<string, unknown>);
        const s = scaffoldProject(opts.repoRoot, input);
        const review = await reviewOf(s.plan, projectModel(input.slug, input.environments[0].name));
        return { review, dirs: s.dirs, environments: s.environments, alias: s.alias, globalEnv: s.globalEnv, notes: s.notes };
    });
    app.post('/api/projects/new/apply', async (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const input = newProjectOf(b);
        const s = scaffoldProject(opts.repoRoot, input);
        const r = applyOf(s.plan, projectModel(input.slug, input.environments[0].name), b);
        for (const d of s.dirs) fs.mkdirSync(safePath(opts.repoRoot, d), { recursive: true });
        log('project.create', `Created the project ${input.slug} (${s.environments.join(', ')})`, { files: r.written.length });
        return { written: r.written, dirs: s.dirs, environments: s.environments };
    });

    // In-Studio recording: the picture, the person's input, checks, pause, steps.
    const live = (req: { params: unknown }) => {
        const r = recorder.studioOf(str((req.params as { id: string }).id, 'id', { max: 40 }));
        if (!r) throw new BadRequest('This recording is not running in the Studio.');
        return r;
    };
    const num = (v: unknown, name: string) => { const x = Number(v); if (!Number.isFinite(x)) throw new BadRequest(`"${name}" is not a number.`); return x; };
    const rerr = (e: unknown) => new BadRequest((e as Error).message.split('\n')[0]);
    app.get('/api/recorder/:id/live', async (req) => {
        const r = live(req);
        const f = r.browser.latest(Number((req.query as Record<string, string>).after) || 0);
        return { frame: f, steps: r.steps(), paused: r.paused, running: r.browser.running, notes: r.notes, dialog: r.dialogInfo(), tabs: r.browser.tabs(), suggest: r.suggest, suggestions: r.suggested(), replay: r.replayState, insertAt: r.insertPoint(), ...(r.inWindow ? { window: r.windowState() } : {}) };
    });
    // Suggested checks: on or off; one dismissed (accepting one is a confirm).
    app.post('/api/recorder/:id/suggest', async (req) => {
        const r = live(req); const b = body(req);
        if (typeof b.on === 'boolean') r.suggest = b.on;
        if (b.dismiss && typeof b.dismiss === 'object') { const d = b.dismiss as { kind?: unknown; code?: unknown; expected?: unknown }; if (typeof d.kind === 'string' && typeof d.code === 'string') r.dropSuggestion(d.kind, d.code, typeof d.expected === 'string' ? d.expected : undefined); }
        return { suggest: r.suggest, suggestions: r.suggested() };
    });
    // Recording in a real window: a check chosen in the Studio's toolbar picks the window's next clicked element.
    app.post('/api/recorder/:id/pick', async (req) => {
        const r = live(req); const b = body(req);
        if (!r.inWindow) throw new BadRequest('This recording is not in a browser window.');
        const mode = b.mode === null || b.mode === undefined ? null : str(b.mode, 'mode', { max: 40 });
        await r.setPick(mode);
        return { mode };
    });
    app.post('/api/recorder/:id/input', async (req) => {
        const r = live(req); const b = body(req);
        try {
            if (b.type === 'click') return await r.click(num(b.x, 'x'), num(b.y, 'y'));
            if (b.type === 'dblclick') return await r.dblclick(num(b.x, 'x'), num(b.y, 'y'));
            if (b.type === 'rightclick') return await r.rightClick(num(b.x, 'x'), num(b.y, 'y'));
            if (b.type === 'hover') return await r.hoverOn(num(b.x, 'x'), num(b.y, 'y'));
            if (b.type === 'drag') return await r.drag(num(b.x, 'x'), num(b.y, 'y'), num(b.x2, 'x2'), num(b.y2, 'y2'));
            if (b.type === 'type') { await r.type(str(b.text, 'text', { max: 10000 })); return {}; }
            if (b.type === 'key') { const k = str(b.key, 'key', { max: 40 }); if (!/^((Shift|Control|Alt|Meta)\+)*[\w ]{1,20}$/.test(k)) throw new BadRequest('Unknown key.'); return await r.key(k); }
            if (b.type === 'scroll') { await r.scroll(Math.max(-5000, Math.min(5000, num(b.dy, 'dy')))); return {}; }
        } catch (e) { throw rerr(e); }
        throw new BadRequest('Unknown input.');
    });
    app.post('/api/recorder/:id/hover', async (req) => { const r = live(req); const b = body(req); try { return { hit: await r.hover(num(b.x, 'x'), num(b.y, 'y')) }; } catch (e) { throw rerr(e); } });
    app.post('/api/recorder/:id/select', async (req) => {
        const r = live(req); const b = body(req);
        const values = Array.isArray(b.values) ? (b.values as unknown[]).slice(0, 200).map((v) => String(v)) : [];
        try { return await r.choose(values); } catch (e) { throw rerr(e); }
    });
    const CHECKS = ['visible', 'text', 'contains', 'value', 'checked', 'url', 'title', 'hidden', 'enabled', 'disabled', 'attribute', 'count', 'cell', 'compare', 'column', 'wait'];
    app.post('/api/recorder/:id/propose', async (req) => {
        const r = live(req); const b = body(req);
        if (!CHECKS.includes(String(b.kind))) throw new BadRequest('Unknown check.');
        try { return await r.propose(b.kind as 'text', b.x === undefined ? undefined : num(b.x, 'x'), b.y === undefined ? undefined : num(b.y, 'y')); } catch (e) { throw rerr(e); }
    });
    app.post('/api/recorder/:id/confirm', async (req) => {
        const r = live(req); const b = body(req);
        if (!CHECKS.includes(String(b.kind))) throw new BadRequest('Unknown check.');
        try { return await r.confirm(b.kind as 'text', str(b.code, 'code', { max: 4000 }), typeof b.expected === 'string' ? b.expected : '', { attribute: typeof b.attribute === 'string' ? b.attribute.slice(0, 100) : undefined, op: typeof b.op === 'string' ? b.op : undefined, name: typeof b.name === 'string' && b.name ? b.name.slice(0, 40) : undefined, plus: typeof b.plus === 'number' ? b.plus : undefined, column: typeof b.column === 'string' ? b.column : undefined, reload: b.reload === true, seconds: typeof b.seconds === 'number' ? b.seconds : undefined }); } catch (e) { throw rerr(e); }
    });
    // Files for the file field the tester clicked (base64 in JSON: the body limit allows about 8 MB of files).
    app.post('/api/recorder/:id/upload', async (req) => {
        const r = live(req); const b = body(req);
        const files = Array.isArray(b.files) ? (b.files as Array<{ name?: unknown; data?: unknown }>).slice(0, 20) : [];
        if (!files.length) throw new BadRequest('Choose a file to upload.');
        const decoded = files.map((f) => ({ name: str(f.name, 'name', { max: 200 }), data: Buffer.from(str(f.data, 'data', { max: 12 * 1024 * 1024 }), 'base64') }));
        try { return await r.upload(decoded); } catch (e) { throw rerr(e); }
    });
    // A value from test data into the focused field, marked with its source (name, column, how the test gets it).
    app.post('/api/recorder/:id/data', async (req) => {
        const r = live(req); const b = body(req);
        const value = str(b.value, 'value', { max: 10000, optional: true });
        const bd = (b.binding && typeof b.binding === 'object' ? b.binding : {}) as Record<string, unknown>;
        const name = str(bd.name, 'name', { max: 40 });
        if (!/^[A-Za-z][\w-]{0,39}$/.test(name)) throw new BadRequest('Name the test data: letters, digits, - and _.');
        const mode = bd.mode === 'run' || bd.mode === 'copy' || bd.mode === 'file' ? bd.mode : null;
        if (!mode) throw new BadRequest('How the test gets the value: run, copy or file.');
        let source;
        try { source = validSource(bd.source); } catch (e) { throw new BadRequest((e as Error).message); }
        if (mode === 'file' && source.kind !== 'file') throw new BadRequest('Only a file can be the scenario\'s data.');
        if (mode === 'run' && source.kind !== 'query' && source.kind !== 'procedure' && source.kind !== 'api') throw new BadRequest('Only a database query, a procedure or an API request can be read in every run.');
        // A check of the application's data at this point (read again in the run).
        if (b.check === true) {
            if (mode !== 'run') throw new BadRequest('A check reads the data in every run: choose "Read in every run".');
            try { return await r.dataCheck({ name, column: str(bd.column, 'column', { max: 200 }), mode, source: source as unknown as Record<string, unknown> }, value); } catch (e) { throw rerr(e); }
        }
        try { return await r.inject(value, { name, column: str(bd.column, 'column', { max: 200 }), mode, source: source as unknown as Record<string, unknown> }); } catch (e) { throw rerr(e); }
    });
    // Remember a value of the page (the element proposed for a text check) under a name, for later steps.
    app.post('/api/recorder/:id/remember', async (req) => {
        const r = live(req); const b = body(req);
        try { return await r.remember(str(b.code, 'code', { max: 4000 }), str(b.name, 'name', { max: 40 }), typeof b.pattern === 'string' && b.pattern ? b.pattern.slice(0, 200) : undefined); } catch (e) { throw rerr(e); }
    });
    // The page's dialog (alert / confirm / prompt): answered from the Studio, the same way in the test.
    app.post('/api/recorder/:id/dialog', async (req) => {
        const r = live(req); const b = body(req);
        if (b.action !== 'accept' && b.action !== 'dismiss') throw new BadRequest('Accept or dismiss the dialog.');
        try { return await r.answerDialog(b.action, typeof b.text === 'string' ? b.text.slice(0, 2000) : undefined); } catch (e) { throw rerr(e); }
    });
    app.post('/api/recorder/:id/close-tab', async (req) => { const r = live(req); try { return await r.closeTab(); } catch (e) { throw rerr(e); } });
    app.post('/api/recorder/:id/tab', async (req) => {
        const r = live(req);
        try { return await r.switchTab(num(body(req).index, 'index')); } catch (e) { throw rerr(e); }
    });
    app.post('/api/recorder/:id/pause', async (req) => { const r = live(req); r.paused = body(req).paused === true; return { paused: r.paused }; });
    app.delete('/api/recorder/:id/steps/:index', async (req) => { const r = live(req); r.remove(Number((req.params as { index: string }).index)); return { steps: r.steps() }; });
    app.post('/api/recorder/:id/navigate', async (req) => { const r = live(req); try { await r.navigate(str(body(req).url, 'url', { max: 4000 })); return { ok: true }; } catch (e) { throw rerr(e); } });
    app.post('/api/recorder/:id/back', async (req) => { const r = live(req); await r.back(); return { ok: true }; });
    app.post('/api/recorder/:id/reload', async (req) => { const r = live(req); await r.reload(); return { ok: true }; });
    app.get('/api/recorder', async () => ({ recordings: recorder.list() }));
    app.get('/api/recorder/:id', async (req) => {
        const r = recorder.get(str((req.params as { id: string }).id, 'id', { max: 40 }));
        if (!r) throw new BadRequest('No such recording.');
        return r;
    });
    app.post('/api/recorder/:id/stop', async (req) => ({ stopped: await recorder.stopAndWait(str((req.params as { id: string }).id, 'id', { max: 40 })) }));
    app.delete('/api/recorder/:id', async (req) => ({ removed: recorder.remove(str((req.params as { id: string }).id, 'id', { max: 40 })) }));
    // A finished recording changed in review (a step deleted): kept with the recording, so opening it again shows it.
    app.put('/api/recorder/:id', async (req) => {
        const id = str((req.params as { id: string }).id, 'id', { max: 40 });
        const b = body(req);
        try { const r = recorder.update(id, { ...(typeof b.script === 'string' ? { script: str(b.script, 'script', { max: 2 * 1024 * 1024 }) } : {}), ...(typeof b.name === 'string' ? { name: b.name } : {}) }); return r; }
        catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/recorder/preview', async (req) => {
        const r = await recPlan(body(req));
        return { ...r.out, review: await reviewOf(r.change, r.ctx, r.shown) };
    });
    app.post('/api/recorder/save', async (req) => {
        const b = body(req);
        const { project, env, plan: p, out, change, ctx } = await recPlan(b);
        if (!out.rows.length) throw new BadRequest('Nothing recorded.');
        // Every file is written as planned: new files, and existing ones only where the plan extends them.
        let encrypted: string[] = [];
        if (p.encrypt.length) {
            try { encrypted = (await dbSessions.request<{ values: string[] }>(project, env, { op: 'encrypt', values: p.encrypt.map((x) => x.value) }, 60_000)).values; }
            catch (e) { throw new BadRequest(`The project's framework could not encrypt the secret values (${(e as Error).message.split('\n')[0]}): choose Studio secrets instead.`); }
        }
        // Through the framework core: checked, refused if a file changed since the preview, replaced files kept.
        const applied = applyOf(change, ctx, b, (_f, text) => { let t = text; p.encrypt.forEach((x, i) => { t = t.split(x.token).join(encrypted[i]); }); return t; });
        // Files uploaded while recording: into the data folder's uploads (an existing file of that name is kept).
        const uploads: Array<{ path: string; change: 'new' | 'kept' }> = [];
        const recId = typeof b.recording === 'string' ? b.recording : '';
        if (recId && recorder.uploads(recId).length) {
            const to = safePath(opts.repoRoot, `${ctx.dataFolder}/uploads`);
            fs.mkdirSync(to, { recursive: true });
            for (const n of recorder.uploads(recId)) {
                const dest = path.join(to, n);
                const exists = fs.existsSync(dest);
                if (!exists) fs.copyFileSync(path.join(recorder.uploadDir(recId), n), dest);
                uploads.push({ path: relPath(dest), change: exists ? 'kept' : 'new' });
            }
        }
        const secretsSaved: string[] = [];
        for (const x of p.secrets) { opts.store.set({ name: x.name, project: projectId, env }, x.value); secretsSaved.push(x.name); }
        log('recorder.save', `Saved the recording ${String(b.name)}: ${applied.written.map((f) => `${f.path} (${f.change})`).join(', ')}`, { feature: p.files[0]?.path ?? null, env, ...(applied.recoveryDir ? { recoveryDir: relPath(applied.recoveryDir) } : {}) });
        // The recording remembers the name and the feature it was saved as (opened again, saving updates them, not a copy).
        if (recId) { try { recorder.update(recId, { name: str(b.name, 'name', { max: 80 }).trim(), savedAs: p.files.find((f) => f.kind === 'feature')?.path ?? '' }); } catch { /* a pasted script has no recording */ } }
        return { files: applied.written, uploads, feature: p.files.find((f) => f.kind === 'feature')?.path, secretsSaved, project, env, recoveryDir: applied.recoveryDir ? relPath(applied.recoveryDir) : null };
    });

    // Agents (GitHub Copilot SDK): sessions with the Studio's tools, the Studio browser and the framework's MCP.
    const agentHome = opts.home ?? path.join(gitDirOf(opts.repoRoot), 'cs-studio');
    // Set with the tool server routes (below).
    let onToolServer: (e: { name: string; status?: string; error?: string; toolCount?: number }) => void = () => undefined;
    let probeToolServer: (name: string, timeoutMs: number) => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true });
    // ---- Tool servers (see agents/toolServers.ts): {secret:NAME} from the Studio secrets, {db:project/env/ALIAS} a PostgreSQL address.
    const tsSecret = (n: string) => (opts.store.exists ? opts.store.getStudio(n) : undefined);
    const tsDb = (ref: string): string | null => {
        const [project, environment, alias] = ref.split('/');
        const values = dbValues(project, environment);
        const c = listConnections(values).find((x) => x.alias === alias);
        if (!c) throw new Error(`no connection ${alias} in ${project}/${environment}`);
        if (c.type !== 'postgresql') throw new Error(`${alias} is ${c.type}, not PostgreSQL`);
        const pw = values[`DB_${alias}_PASSWORD`] ?? '';
        if (/^ENCRYPTED:/.test(pw)) throw new Error(`its password is encrypted in the configuration: keep it as the Studio secret DB_${alias}_PASSWORD for ${project}/${environment}`);
        const user = values[`DB_${alias}_USERNAME`] ?? '';
        return `postgresql://${encodeURIComponent(user)}${pw ? `:${encodeURIComponent(pw)}` : ''}@${c.host}:${c.port}/${encodeURIComponent(c.database)}`;
    };
    const studioBrowser = new StudioBrowser({ repoRoot: opts.repoRoot, ...(() => { const n = personal().network; return n.proxyMode === 'manual' && n.proxyUrl ? { proxy: { server: n.proxyUrl, bypass: n.bypass.join(',') } } : {}; })() });
    const knowledgeRef: { current?: KnowledgeBase } = {}, ensureKnowledgeRef: { current?: () => void } = {};
    // The company network for the Copilot runtime and language server: proxy (with its sign-in) and certificates.
    const agentNetworkEnv = (): Record<string, string> => {
        const n = personal().network;
        const out: Record<string, string> = { ...runEnvFor({ ...n, certsForTestRuns: true }, process.env) };
        if (n.proxyMode === 'manual' && n.proxyUrl) {
            let u = n.proxyUrl;
            if (n.proxyUser) {
                try {
                    const url = new URL(u);
                    url.username = encodeURIComponent(n.proxyUser);
                    const pw = opts.store.exists ? opts.store.getStudio(PROXY_PASSWORD_SECRET) : undefined;
                    if (pw) url.password = encodeURIComponent(pw);
                    u = url.toString();
                } catch { /* the address as written */ }
            }
            out.HTTPS_PROXY = out.HTTP_PROXY = out.https_proxy = out.http_proxy = u;
            out.NO_PROXY = out.no_proxy = n.bypass.join(',');
        }
        return out;
    };
    const agents = new AgentHost({
        repoRoot: opts.repoRoot, home: agentHome, browser: studioBrowser,
        // On a build agent the model key or Copilot token comes from the pipeline's secret variables (environment).
        secret: (name) => (opts.store.exists ? opts.store.getStudio(name) : undefined) ?? ([PROVIDER_KEY_SECRET, COPILOT_TOKEN_SECRET].includes(name) && process.env[name] && !/^\$\(.+\)$/.test(process.env[name]!.trim()) ? process.env[name] : undefined),
        // The screens' own API, in-process: the same checks (production read only, validation, activity log).
        call: async (method, url, payload, actor) => {
            const key = actor ? randomBytes(16).toString('hex') : '';
            if (actor) agentCalls.set(key, actor);
            let r;
            try {
                r = await app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}`, ...(key ? { 'x-cs-agent-call': key } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
            } finally { if (key) agentCalls.delete(key); }
            let b: unknown = r.body;
            try { b = JSON.parse(r.body); } catch { /* text */ }
            return { status: r.statusCode, body: b };
        },
        projects: () => { const f = discover(opts.repoRoot); return f.projects.map((p) => ({ name: p, environments: f.environments[p] ?? [] })); },
        log: (action, text, data) => log(action, text, data),
        // Tool servers with their secrets and connections filled in (one that misses something is left out).
        toolServers: () => listServers(opts.repoRoot, agentHome).flatMap((x) => {
            if (x.server.enabled === false || missingFor(x.server, tsSecret, tsDb).length) return [];
            return [{ name: x.name, changes: x.server.changes !== false, config: sdkConfig(resolveServer(x.server, tsSecret, tsDb), opts.repoRoot, {}) }];
        }),
        onToolServer: (e) => onToolServer(e),
        probeToolServer: (name, ms) => probeToolServer(name, ms),
        knowledge: (sources) => { ensureKnowledgeRef.current?.(); return knowledgeRef.current?.tools(sources) ?? []; },
        runtimeEnv: agentNetworkEnv,
        mask: (t) => maskAll(t),
    });
    app.addHook('onClose', async () => { await agents.stop().catch(() => undefined); await studioBrowser.close(); });
    const agentErr = (e: unknown) => { const err = e as Error & { code?: string }; return new BadRequest(err.message.split('\n')[0]); };
    app.get('/api/agents/status', async () => agents.status());
    /**
     * What the plan-first story workflow starts from: the story (an Azure DevOps work item: title, description,
     * acceptance criteria), the project's example feature for the plan's style (STUDIO_SEED_FEATURE in its
     * configuration) and its features to choose another.
     */
    app.get('/api/agents/plan-context', async (req) => {
        const q = req.query as Record<string, string>;
        const project = configProjectParam(str(q.project, 'project', { max: 100 }));
        const env = q.env ? envParam(q.env) : (discover(opts.repoRoot).environments[project] ?? [])[0] ?? 'dev';
        const folder = (projectFeatureFolder(opts.repoRoot, project) ?? `test/${project}/features`).replace(/\/+$/, '');
        const features = readCatalog(opts.repoRoot).map((f) => f.path).filter((f) => f.startsWith(`${folder}/`)).sort();
        let seed: string | null = null;
        try { const v = resolveFor(project, env).entries.find((e) => e.key === 'STUDIO_SEED_FEATURE')?.value?.trim(); if (v && features.includes(v)) seed = v; } catch { /* no configuration */ }
        const out: Record<string, unknown> = { project, folder, features, seed };
        const id = /^#?(\d{1,9})$/.exec((q.story ?? '').trim());
        if (id) {
            try {
                const d = await new WorkItems(adoClient(project, env)).detail(Number(id[1]));
                const mask = (t: string) => maskSecrets(t, opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : []);
                out.story = { id: d.id, type: d.type, title: mask(d.title), state: d.state, url: d.url, description: mask((d.description ?? '').slice(0, 8000)), acceptanceCriteria: mask((d.acceptanceCriteria ?? '').slice(0, 8000)) };
            } catch (e) { out.storyError = (e as Error).message; }
        }
        return out;
    });
    // The agents runtime, installed by the Studio into its own folder (once per computer).
    app.get('/api/agents/runtime', async () => agents.runtime());
    app.post('/api/agents/runtime/install', async (req) => {
        const v = body(req).version;
        try { return agents.installRuntime(v === undefined ? undefined : str(v, 'version', { max: 40 })); } catch (e) { throw agentErr(e); }
    });
    app.post('/api/agents/runtime/cancel', async () => { agents.installer.cancel(); return { ok: true }; });
    app.delete('/api/agents/runtime', async () => { try { await agents.removeRuntime(); return agents.runtime(); } catch (e) { throw agentErr(e); } });
    // Sign in to GitHub (Copilot) from the Studio: browser or device code; github.com or GitHub Enterprise Cloud.
    app.get('/api/agents/signin', async () => agents.signInState());
    app.post('/api/agents/signin', async (req) => {
        const b = body(req);
        const provider = b.provider === 'proxima' ? 'proxima' : 'githubDotCom';
        const method = b.method === 'device-code' ? 'device-code' : 'web';
        try { return await agents.signInBegin(provider, method); } catch (e) { throw agentErr(e); }
    });
    app.post('/api/agents/signin/answer', async (req) => {
        const b = body(req);
        try {
            return await agents.signInAnswer({ ...(b.input !== undefined ? { input: str(b.input, 'input', { max: 300 }) } : {}), ...(b.selectionId !== undefined ? { selectionId: str(b.selectionId, 'selectionId', { max: 300 }) } : {}), ...(typeof b.consent === 'boolean' ? { consent: b.consent } : {}) });
        } catch (e) { throw agentErr(e); }
    });
    app.delete('/api/agents/signin', async () => { await agents.signInCancel(); return agents.signInState(); });

    // ---- Copilot inline suggestions in the editor (GitHub's Copilot language server; see lang/copilot.ts).
    const copilot = new CopilotInline({
        home: agentHome, repoRoot: opts.repoRoot,
        studioVersion: (() => { try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version ?? ''); } catch { return ''; } })(),
        env: agentNetworkEnv,
        proxy: () => agentNetworkEnv().HTTPS_PROXY,
        token: () => (opts.store.exists ? opts.store.getStudio(COPILOT_TOKEN_SECRET) : undefined),
        knownSecrets: () => (opts.store.exists ? opts.store.knownSecrets().map((k) => k.value) : []),
        blocked: () => (agents.policyNow()?.enabled === false ? 'Turned off by this repository\'s agent policy.' : null),
        log: (action, text) => log(action, text),
    });
    app.addHook('onClose', async () => { await copilot.stop().catch(() => undefined); });
    const copilotErr = (e: unknown) => new BadRequest((e as Error).message.split('\n')[0]);
    app.get('/api/agents/inline', async (req) => {
        // The editor asks with start=1: the language server starts on demand (in the background).
        // Once: after an idle stop it starts again with the next suggestion asked for.
        if ((req.query as Record<string, string>).start === '1') copilot.startOnce();
        return copilot.status();
    });
    app.post('/api/agents/inline/settings', async (req) => { const b = body(req); if (typeof b.enabled !== 'boolean') throw new BadRequest('"enabled" must be true or false.'); await copilot.setEnabled(b.enabled); return copilot.status(); });
    app.post('/api/agents/inline/install', async (req) => {
        const b = body(req);
        try { return copilot.install(b.version === undefined ? undefined : str(b.version, 'version', { max: 40 })); } catch (e) { throw copilotErr(e); }
    });
    app.post('/api/agents/inline/install/cancel', async () => { copilot.installer.cancel(); return copilot.status(); });
    app.delete('/api/agents/inline/install', async () => { try { return await copilot.remove(); } catch (e) { throw copilotErr(e); } });
    app.post('/api/agents/inline/restart', async () => { try { return await copilot.restart(); } catch (e) { throw copilotErr(e); } });
    app.post('/api/agents/inline/check', async () => { try { return await copilot.checkStatus(); } catch (e) { throw copilotErr(e); } });
    app.post('/api/agents/inline/signin', async () => { try { return await copilot.signIn(); } catch (e) { throw copilotErr(e); } });
    app.delete('/api/agents/inline/signin', async () => copilot.cancelSignIn());
    app.post('/api/agents/inline/signout', async () => { try { return await copilot.signOut(); } catch (e) { throw copilotErr(e); } });
    app.post('/api/agents/inline/use-existing', async (req) => {
        const id = Number(body(req).tokenId);
        if (!Number.isInteger(id)) throw new BadRequest('"tokenId" is invalid.');
        try { return await copilot.useExisting(id); } catch (e) { throw copilotErr(e); }
    });
    app.post('/api/agents/inline/suggest', async (req, reply) => {
        const b = body(req);
        const p = filePath(b.path); const text = content(b.content); const offset = offsetOf(b.offset);
        // The editor typed on (it aborts the request): the language server's request is cancelled too.
        const ac = new AbortController();
        reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
        try {
            return await copilot.inline(p, text, offset, {
                signal: ac.signal, invoked: b.invoked === true,
                tabSize: typeof b.tabSize === 'number' && b.tabSize > 0 && b.tabSize <= 16 ? b.tabSize : 4, insertSpaces: b.insertSpaces !== false,
            });
        } catch (e) { throw copilotErr(e); }
    });
    app.post('/api/agents/inline/shown', async (req) => { copilot.shown(str(body(req).id, 'id', { max: 40 })); return { ok: true }; });
    app.post('/api/agents/inline/accepted', async (req) => {
        const b = body(req);
        const n = b.acceptedLength === undefined ? undefined : Number(b.acceptedLength);
        if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new BadRequest('"acceptedLength" is invalid.');
        await copilot.accepted(str(b.id, 'id', { max: 40 }), n);
        return { ok: true };
    });
    app.post('/api/agents/inline/close', async (req) => { copilot.close(filePath(body(req).path)); return { ok: true }; });
    app.post('/api/agents/signout', async (req) => {
        // Forget a token kept in the Studio too, when asked.
        if (body(req).forgetToken === true && opts.store.exists) opts.store.deleteStudio(COPILOT_TOKEN_SECRET);
        try { return await agents.signOut(); } catch (e) { throw agentErr(e); }
    });
    app.post('/api/agents/accounts/switch', async (req) => {
        try { await agents.switchAccount(str(body(req).selectionId, 'selectionId', { max: 300 })); return { ok: true }; } catch (e) { throw agentErr(e); }
    });
    // A whole-file save of the Agents screens: the version the screen read (unless it overwrites on purpose); 409 when it changed since.
    const sentVersion = (b: Record<string, unknown>) => (b.force === true ? undefined : b.version);
    const changedElsewhere = (e: unknown) => (e instanceof ChangedElsewhere ? new Conflict(e.message) : e);
    app.put('/api/agents/settings', async (req) => {
        const b = body(req);
        const s = { ...DEFAULT_AGENT_SETTINGS, ...(b.settings as Partial<AgentSettings>) } as AgentSettings;
        try { checkAgentVersion(agents.settingsVersion(), sentVersion(b), 'the agent settings'); } catch (e) { throw changedElsewhere(e); }
        if (typeof b.providerKey === 'string') { if (b.providerKey) opts.store.setStudio(PROVIDER_KEY_SECRET, b.providerKey); else opts.store.deleteStudio(PROVIDER_KEY_SECRET); }
        if (typeof b.copilotToken === 'string') { if (b.copilotToken) opts.store.setStudio(COPILOT_TOKEN_SECRET, b.copilotToken); else opts.store.deleteStudio(COPILOT_TOKEN_SECRET); }
        try { await agents.saveSettings(s); } catch (e) { throw agentErr(e); }
        log('agent.settings', `Changed the agent settings (${s.provider === 'custom' ? `${s.custom?.type} model ${s.model}` : `GitHub Copilot, ${s.model}`})`);
        return agents.status();
    });
    app.post('/api/agents/context', async (req) => { const b = body(req); agents.setContext((b.context && typeof b.context === 'object' ? b.context : {}) as Record<string, unknown>); return { ok: true }; });
    // ---- Tool servers: the outside MCP servers agents use (Agents → Tool servers).
    const runEnv = () => { const e: Record<string, string> = {}; for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CS_STUDIO_')) e[k] = v; return e; };
    const checking = new Map<string, Promise<unknown>>();
    /** Start the server, list its tools, keep the result (compared with the last review). */
    const checkServer = (name: string, timeoutMs?: number) => {
        const x = listServers(opts.repoRoot, agentHome).find((s) => s.name === name);
        if (!x) throw new BadRequest(`No tool server ${name}.`);
        const key = stateKey(x.scope, x.name);
        const running = checking.get(key);
        if (running) return running as Promise<ReturnType<typeof recordCheck>>;
        const p = (async () => {
            let missing: string[] = [];
            try { missing = missingFor(x.server, tsSecret, tsDb); } catch (e) { missing = [(e as Error).message]; }
            const r = missing.length
                ? { ok: false, tools: [], error: `Missing: ${missing.join(', ')}.`, ms: 0 }
                : await testServer(resolveServer(x.server, tsSecret, tsDb), opts.repoRoot, runEnv(), timeoutMs, netConnection());
            const masked = { ...r, error: r.error ? maskAll(r.error) : undefined };
            const st = updateState(opts.repoRoot, agentHome, key, (prev) => recordCheck(prev, masked))!;
            log('agent.tool-server', `Checked the tool server ${name}: ${r.ok ? `${r.tools.length} tools${st.diff ? ` (changed: +${st.diff.added.length} −${st.diff.removed.length} ~${st.diff.changed.length})` : ''}` : 'failed'}`, {});
            if (timeoutMs === undefined) agents.forgetProbe(name);
            return st;
        })().finally(() => checking.delete(key));
        checking.set(key, p);
        return p;
    };
    // Before a session that may use tool servers: each must start within a short time (agents/host.ts), checked like Check.
    probeToolServer = async (name, ms) => { const st = await checkServer(name, ms); return { ok: !!st.ok, ...(st.error ? { error: st.error } : {}) }; };
    // What agent sessions see: a failure is kept for the screen; a different number of tools starts a new check.
    const lastAuto = new Map<string, number>();
    onToolServer = (e) => {
        const x = listServers(opts.repoRoot, agentHome).find((s) => s.name === e.name);
        if (!x) return;
        const key = stateKey(x.scope, x.name);
        const st = updateState(opts.repoRoot, agentHome, key, (prev) => ({ ...prev, session: { status: e.status ?? prev.session?.status ?? 'connected', error: e.error ? maskAll(e.error) : (e.status ? undefined : prev.session?.error), toolCount: e.toolCount ?? prev.session?.toolCount, at: new Date().toISOString() } }))!;
        if (e.toolCount !== undefined && st.known && e.toolCount !== st.known.length && Date.now() - (lastAuto.get(key) ?? 0) > 10 * 60_000) {
            lastAuto.set(key, Date.now());
            void checkServer(x.name).catch(() => undefined);
        }
    };
    const serverView = () => {
        const f = discover(opts.repoRoot);
        const connections: Array<{ value: string; label: string }> = [];
        for (const p of f.projects) for (const e of f.environments[p] ?? []) {
            try { for (const c of listConnections(dbValues(p, e))) if (c.type === 'postgresql') connections.push({ value: `${p}/${e}/${c.alias}`, label: `${c.alias} (${p} / ${e})` }); } catch { /* no config */ }
        }
        const policy = agents.policyNow();
        const states = loadStates(opts.repoRoot, agentHome);
        return {
            catalog: CATALOG.map(({ make: _m, ...c }) => c), // eslint-disable-line @typescript-eslint/no-unused-vars
            servers: listServers(opts.repoRoot, agentHome).map((x) => {
                const st = states[stateKey(x.scope, x.name)] ?? {};
                return {
                    ...x, version: textVersion(JSON.stringify(x.server)), missing: missingFor(x.server, tsSecret, tsDb),
                    allowed: policy?.enabled !== false && policy?.toolServers !== false && (!Array.isArray(policy?.toolServers) || policy!.toolServers.includes(x.name)),
                    checking: checking.has(stateKey(x.scope, x.name)),
                    state: { known: st.known ?? null, server: st.server ?? null, checkedAt: st.checkedAt ?? null, ok: st.ok ?? null, error: st.error ?? null, diff: st.diff ?? null, session: st.session ?? null },
                };
            }),
            connections, teamFile: TEAM_FILE, policy: policy?.toolServers ?? null,
        };
    };
    const scopeOf = (v: unknown): ToolScope => { if (v === 'team' || v === 'personal') return v; throw new BadRequest('Scope: team (the repository, shared) or personal (only you).'); };
    const serverIn = (scope: ToolScope, name: string) => {
        const x = serversIn(opts.repoRoot, agentHome, scope)[name];
        if (!x) throw new BadRequest(`No ${scope} tool server ${name}.`);
        return x;
    };
    app.get('/api/agents/tool-servers', async () => serverView());
    app.put('/api/agents/tool-servers', async (req) => {
        const b = body(req);
        const scope = scopeOf(b.scope);
        const name = str(b.name, 'name', { max: 40 });
        let server: ToolServer;
        if (typeof b.from === 'string') {
            const entry = CATALOG.find((c) => c.id === b.from);
            if (!entry) throw new BadRequest(`No ready entry ${b.from}.`);
            const v = (b.values && typeof b.values === 'object' ? b.values : {}) as Record<string, unknown>;
            const values: Record<string, string> = {};
            for (const f of entry.fields) {
                const x = String(v[f.key] ?? '').trim();
                if (!x && !f.optional) throw new BadRequest(`${f.label}: required.`);
                if (x && f.kind === 'secret' && !/^[A-Z][A-Z0-9_]{0,63}$/.test(x)) throw new BadRequest(`${f.label}: the name of a Studio secret (capital letters, digits, _).`);
                if (x && f.kind === 'text' && !/^[\w./\\:@ -]{1,300}$/.test(x)) throw new BadRequest(`${f.label}: letters, digits and . / \\ : @ - only.`);
                if (x && f.choices && !f.choices.includes(x.toLowerCase())) throw new BadRequest(`${f.label}: one of ${f.choices.join(', ')} (got "${x}").`);
                values[f.key] = f.choices && x ? x.toLowerCase() : x;
            }
            server = { ...entry.make(values), from: entry.id, description: entry.title };
        } else {
            const raw = (b.server ?? {}) as Partial<ToolServer>;
            server = {
                kind: raw.kind === 'http' ? 'http' : 'stdio',
                command: raw.command, args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
                env: raw.env && typeof raw.env === 'object' ? raw.env as Record<string, string> : undefined,
                url: raw.url, headers: raw.headers && typeof raw.headers === 'object' ? raw.headers as Record<string, string> : undefined,
                tools: Array.isArray(raw.tools) ? raw.tools.map(String) : undefined, changes: raw.changes !== false,
                description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : undefined,
                from: typeof raw.from === 'string' ? raw.from : undefined, enabled: raw.enabled === false ? false : undefined,
            };
        }
        const editing = typeof b.editing === 'string' ? b.editing : null;
        // The secrets a pasted configuration made stay the server's when it is edited.
        const before = editing ? serversIn(opts.repoRoot, agentHome, scope)[editing] : undefined;
        // Edited in another tab (or the team file pulled) since this form opened: not replaced silently.
        if (editing) { try { checkAgentVersion(before ? textVersion(JSON.stringify(before)) : '', sentVersion(b), `the tool server ${editing}`); } catch (e) { throw changedElsewhere(e); } }
        if (before?.pastedSecrets?.length) server.pastedSecrets = before.pastedSecrets;
        // One write: a new name that another server has is refused (a rename never replaces another server).
        try { putServer(opts.repoRoot, agentHome, scope, name, server, editing); } catch (e) { throw new BadRequest((e as Error).message); }
        if (editing && editing !== name) updateState(opts.repoRoot, agentHome, stateKey(scope, editing), () => null);
        agents.forgetProbe();
        log('agent.tool-server', `${editing ? 'Changed' : 'Added'} the tool server ${name} (${scope === 'team' ? `for the team, in ${TEAM_FILE}` : 'for you'})`, {});
        return serverView();
    });
    /** Turn a server on or off; choose its tools (a list: only those, new ones off; null: all, new ones included). */
    app.patch('/api/agents/tool-servers/:name', async (req) => {
        const name = str((req.params as { name: string }).name, 'name', { max: 40 });
        const b = body(req);
        const scope = scopeOf(b.scope);
        const cur = { ...serverIn(scope, name) };
        if (typeof b.enabled === 'boolean') { if (b.enabled) delete cur.enabled; else cur.enabled = false; }
        if (b.tools === null) delete cur.tools;
        else if (Array.isArray(b.tools)) cur.tools = [...new Set(b.tools.map((t: unknown) => str(t, 'tool', { max: 200 })))].sort();
        try { saveServer(opts.repoRoot, agentHome, scope, name, cur); } catch (e) { throw new BadRequest((e as Error).message); }
        agents.forgetProbe(name);
        log('agent.tool-server', `Changed the tool server ${name}: ${typeof b.enabled === 'boolean' ? (b.enabled ? 'turned on' : 'turned off') : cur.tools ? `${cur.tools.length} tools on` : 'all tools'}`, {});
        return serverView();
    });
    app.delete('/api/agents/tool-servers/:name', async (req) => {
        const name = str((req.params as { name: string }).name, 'name', { max: 40 });
        const q = req.query as Record<string, string>;
        const scope = q.scope === 'team' ? 'team' : 'personal';
        const gone = serversIn(opts.repoRoot, agentHome, scope)[name];
        try { saveServer(opts.repoRoot, agentHome, scope, name, null); } catch (e) { throw new BadRequest((e as Error).message); }
        agents.forgetProbe(name);
        updateState(opts.repoRoot, agentHome, stateKey(scope, name), () => null);
        // ?secrets=remove: the Studio secrets its pasted configuration made go too (unless another server uses them).
        const removed: string[] = [];
        if (q.secrets === 'remove' && gone?.pastedSecrets?.length && opts.store.exists) {
            const used = new Set(listServers(opts.repoRoot, agentHome).flatMap((x) => secretsOf(x.server)));
            for (const n of gone.pastedSecrets) if (!used.has(n) && opts.store.deleteStudio(n)) removed.push(n);
        }
        log('agent.tool-server', `Removed the tool server ${name} (${scope})${removed.length ? `, and its secrets ${removed.join(', ')}` : ''}`, {});
        return { ...serverView(), removedSecrets: removed };
    });
    app.post('/api/agents/tool-servers/:name/test', async (req) => {
        const name = str((req.params as { name: string }).name, 'name', { max: 40 });
        const st = await checkServer(name);
        return { ok: st.ok, tools: st.ok ? st.known ?? [] : [], server: st.server, error: st.ok ? undefined : st.error, at: st.checkedAt, diff: st.diff ?? null };
    });
    /** Check every server that is on (one after the other). */
    app.post('/api/agents/tool-servers/check', async () => {
        for (const x of listServers(opts.repoRoot, agentHome)) if (x.server.enabled !== false) await checkServer(x.name).catch(() => undefined);
        return serverView();
    });
    app.post('/api/agents/tool-servers/:name/reviewed', async (req) => {
        const name = str((req.params as { name: string }).name, 'name', { max: 40 });
        const scope = scopeOf(body(req).scope);
        updateState(opts.repoRoot, agentHome, stateKey(scope, name), (prev) => markReviewed(prev));
        log('agent.tool-server', `Reviewed the tool changes of ${name}`, {});
        return serverView();
    });
    /** Add servers from the configuration their documentation gives: preview, then add (keys saved as Studio secrets). */
    app.post('/api/agents/tool-servers/import', async (req) => {
        const b = body(req);
        const scope = scopeOf(b.scope);
        let items;
        try { items = parseImport(str(b.text, 'text', { max: 100_000 })); } catch (e) { throw new BadRequest((e as Error).message); }
                const view = items.map((i) => ({
            name: i.name, server: i.server, problem: i.problem, exists: !!serversIn(opts.repoRoot, agentHome, scope)[i.name],
            secrets: i.secrets.map((s) => ({ secret: s.secret, where: s.where, fromPaste: s.value !== undefined, saved: !!tsSecret(s.secret) })),
        }));
        if (b.apply !== true) return { servers: view };
        const bad = view.find((v) => v.problem);
        if (bad) throw new BadRequest(`${bad.name}: ${bad.problem}`);
        if (b.replace !== true) { const dup = view.find((v) => v.exists); if (dup) throw new BadRequest(`There is a ${scope} tool server ${dup.name} already.`); }
        const keys = items.flatMap((i) => i.secrets.filter((s) => s.value !== undefined));
        for (const k of keys) opts.store.setStudio(k.secret, k.value!);
        for (const i of items) {
            const pasted = i.secrets.filter((x) => x.value !== undefined).map((x) => x.secret);
            saveServer(opts.repoRoot, agentHome, scope, i.name, pasted.length ? { ...i.server, pastedSecrets: [...new Set(pasted)] } : i.server);
        }
        log('agent.tool-server', `Added tool servers from a configuration: ${items.map((i) => i.name).join(', ')} (${scope}${keys.length ? `, ${keys.length} keys saved as Studio secrets` : ''})`, {});
        return { ...serverView(), added: items.map((i) => i.name) };
    });
    // ---- MCP: the Studio is an MCP server itself (/mcp, see mcp/http.ts); here its switch, address and token.
    const mcpKeys = path.join(opts.home ?? agentHome, 'keys');
    let studioVersion = '';
    try { studioVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version ?? ''; } catch { /* unknown */ }
    // Without a personal settings store (tests): on.
    const mcpOn = () => (settings ? personal().mcpEnabled === true : true);
    registerMcp(app, { keysDir: mcpKeys, host: agents, enabled: mcpOn, version: studioVersion, log });
    const mcpView = () => ({ enabled: mcpOn(), url: `http://127.0.0.1:${port}/mcp`, token: mcpToken(mcpKeys), refusal: agents.mcpRefusal() });
    app.get('/api/mcp', async () => mcpView());
    app.put('/api/mcp', async (req) => {
        const b = body(req);
        if (typeof b.enabled !== 'boolean') throw new BadRequest('enabled: true or false.');
        if (!settings) throw new BadRequest('No settings store.');
        settings.update({ mcpEnabled: b.enabled });
        log('settings.mcp', b.enabled ? 'Turned on the Studio\'s MCP server' : 'Turned off the Studio\'s MCP server', {});
        return mcpView();
    });
    app.post('/api/mcp/token', async () => {
        mcpToken(mcpKeys, true);
        log('settings.mcp', 'Renewed the MCP token (clients need the new one)', {});
        return mcpView();
    });
    // ---- Missions: agents that work toward a goal alone, in their own copy, verified by the Studio (agents/missions.ts).
    const missionRunTests: MissionDeps['runTests'] = opts.missionRunTests ?? (async (rr, workdir) => {
        try { buildArgs(rr); } catch (e) { return { id: '', state: 'error', message: (e as Error).message }; }
        let values: Record<string, string> = {};
        try { values = Object.fromEntries(resolveFor(rr.project, rr.env).entries.map((e) => [e.key, e.value ?? ''])); } catch { /* no config */ }
        const prot = protectedEnvironment(rr.env, values) ?? (/^(true|1|yes)$/i.test(values.STUDIO_PROTECTED ?? '') ? `STUDIO_PROTECTED=true for ${rr.env}` : null);
        if (prot) return { id: '', state: 'error', message: `Missions do not run tests against a protected environment (${prot}). Choose another environment.` };
        const secretEnv = opts.store.exists ? secretsAsEnv(opts.store, { project: projectId, env: rr.env }) : {};
        let run: RunInfo;
        try { run = runner.start(rr, secretEnv, runEnvFor(personal().network, process.env), workdir ? { workdir } : {}); }
        catch (e) { return { id: '', state: 'error', message: (e as Error).message }; }
        log('test.run', `A mission started tests: ${run.command.slice(1).join(' ')}`, { id: run.id });
        const done: RunInfo = run.state !== 'running' ? run : await new Promise((resolve) => runner.once(`end:${run.id}`, resolve));
        return { id: done.id, state: done.state, ...(done.summary ? { summary: done.summary } : {}), ...(done.message ? { message: done.message } : {}) };
    });
    const missionNotify = (m: MissionRun) => {
        // A channel that takes the inbox gets "waiting for you" from the inbox (once per question), not from here.
        const ch = notifyChannels().filter((c) => c.enabled && (c.when === 'always' || ['failed', 'over-budget', 'blocked', 'waiting'].includes(m.state)) && !(m.state === 'waiting' && c.inbox));
        if (!ch.length) return;
        const note = { id: `mission-${m.id}`, state: m.state === 'succeeded' ? 'passed' : m.state, project: m.inputs.project ?? '', env: m.inputs.env ?? '', what: `mission "${m.title}" — ${missionLabel(m.state)}${m.reason ? `: ${m.reason}` : ''}`, startedAt: m.createdAt, ...(m.endedAt ? { endedAt: m.endedAt } : {}), failures: (m.verifications.at(-1)?.failures ?? []).map((f) => ({ name: f.name, ...(f.error ? { error: f.error } : {}) })), ...(m.state === 'waiting' ? { message: `Waiting for you: ${m.checkpoints.at(-1)?.question ?? ''}` } : {}) };
        void (async () => { for (const c of ch) { const url = webhookOf(c); if (url) recordDelivery(await deliver(c, url, note, netConnection())); } })().catch(() => undefined);
    };
    // ---- Knowledge: what agents look up (agents/knowledge.ts). Built on this computer; the sources are the team's.
    const stripHtml = (h: string) => htmlText(String(h ?? ''));
    const fetchPage = (u: string, hops = 0): Promise<{ title: string; text: string }> => new Promise((resolve, reject) => {
        let url: URL;
        try { url = new URL(u); } catch { reject(new Error('Not a web address.')); return; }
        const conn = netConnection();
        const mod = url.protocol === 'http:' ? require('http') as typeof import('http') : require('https') as typeof import('https');
        const req = mod.get(url, { agent: conn.agentFor(u), timeout: 20_000, headers: { 'User-Agent': 'cs-test-studio', Accept: 'text/html,text/plain,text/markdown,*/*' }, ...(url.protocol === 'https:' && conn.ca ? { ca: conn.ca } : {}) }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location && hops < 5) { res.resume(); resolve(fetchPage(new URL(res.headers.location, u).href, hops + 1)); return; }
            if ((res.statusCode ?? 0) >= 400) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
            const chunks: Buffer[] = []; let size = 0;
            res.on('data', (c: Buffer) => { size += c.length; if (size <= 5_000_000) chunks.push(c); });
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const html = /html/i.test(String(res.headers['content-type'] ?? '')) || /<html/i.test(body.slice(0, 500));
                resolve({ title: html ? stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '') || u : u, text: html ? stripHtml(body) : body });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
    });
    const knowledge = new KnowledgeBase(opts.repoRoot, path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'knowledge'), {
        mask: (t) => maskAll(t),
        workItems: async (src) => {
            const t = adoTarget(src.project ? { project: src.project } : {});
            const ado = adoClient(t.project, t.env);
            const query = src.query?.trim() || "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Product Backlog Item', 'Bug', 'Feature', 'Test Case', 'Requirement') AND [System.ChangedDate] >= @today - 180 ORDER BY [System.ChangedDate] DESC";
            const ids = (await ado.post<{ workItems: Array<{ id: number }> }>('wit/wiql?$top=2000', { query })).workItems.map((w) => w.id);
            const fields = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.Tags', 'System.AreaPath', 'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.TCM.ReproSteps', 'Microsoft.VSTS.TCM.Steps'];
            const docs: KnowledgeDoc[] = [];
            for (let i = 0; i < ids.length; i += 200) {
                const r = await ado.get<{ value: Array<{ id: number; fields: Record<string, unknown> } | null> }>(`wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=${fields.join(',')}&errorPolicy=omit`);
                for (const w of r.value) {
                    if (!w) continue;
                    const f = w.fields;
                    const part = (label: string, v: unknown) => (v ? `${label}:\n${stripHtml(String(v))}` : '');
                    docs.push({ path: `work-item/${w.id}`, title: `${f['System.WorkItemType'] ?? 'Work item'} ${w.id}: ${f['System.Title'] ?? ''}`, type: 'workitem', url: `${ado.orgUrl}/${encodeURIComponent(ado.projectName)}/_workitems/edit/${w.id}`,
                        text: [`${f['System.WorkItemType']} ${w.id}: ${f['System.Title']} (${f['System.State']}; ${f['System.AreaPath'] ?? ''}${f['System.Tags'] ? `; tags ${f['System.Tags']}` : ''})`,
                            part('Description', f['System.Description']), part('Acceptance criteria', f['Microsoft.VSTS.Common.AcceptanceCriteria']), part('Repro steps', f['Microsoft.VSTS.TCM.ReproSteps']), part('Test steps', f['Microsoft.VSTS.TCM.Steps'])].filter(Boolean).join('\n\n') });
                }
            }
            return docs;
        },
        wiki: async (src) => {
            const t = adoTarget(src.project ? { project: src.project } : {});
            const ado = adoClient(t.project, t.env);
            const all = await ado.get<{ value: Array<{ name: string; type: string; remoteUrl?: string }> }>('wiki/wikis', 'project', 'Wiki (Read)');
            const w = all.value.find((x) => (src.wiki ? x.name === src.wiki : x.type === 'projectWiki')) ?? all.value[0];
            if (!w) throw new Error('This project has no wiki.');
            type Page = { path: string; subPages?: Page[] };
            const tree = await ado.get<Page>(`wiki/wikis/${encodeURIComponent(w.name)}/pages?path=/&recursionLevel=full`, 'project', 'Wiki (Read)');
            const paths: string[] = [];
            const walk = (p: Page) => { if (p.path && p.path !== '/') paths.push(p.path); for (const c of p.subPages ?? []) walk(c); };
            walk(tree);
            const docs: KnowledgeDoc[] = [];
            for (const p of paths.slice(0, 500)) {
                const page = await ado.get<{ content?: string; remoteUrl?: string }>(`wiki/wikis/${encodeURIComponent(w.name)}/pages?path=${encodeURIComponent(p)}&includeContent=true`, 'project', 'Wiki (Read)');
                if (page.content?.trim()) docs.push({ path: `wiki${p}`, title: `${w.name}${p}`, text: page.content, type: 'wiki', ...(page.remoteUrl ? { url: page.remoteUrl } : {}) });
            }
            return docs;
        },
        history: () => {
            const docs: KnowledgeDoc[] = [];
            const triage = readTriage(opts.repoRoot);
            for (const [tag, e] of Object.entries(triage)) docs.push({ path: `triage/${tag}`, title: `Failure cause: ${e.signature.slice(0, 120)}`, type: 'learned', text: `A test failure (${e.signature}).${e.verdict ? ` Triaged as ${e.verdict}.` : ''}${e.note ? ` Note: ${e.note}` : ''}${e.bug ? ` Bug ${e.bug}.` : ''}` });
            const seen = new Set<string>();
            for (const r of runner.list().slice(0, 300)) for (const sc of r.summary?.scenarios ?? []) {
                if (sc.status !== 'failed' || !sc.error) continue;
                const key = `${sc.feature}|${sc.name}|${sc.error.split('\n')[0].replace(/\d+/g, '#').slice(0, 160)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                docs.push({ path: `run/${r.id}/${sc.name}`, title: `Failed: ${sc.feature}: ${sc.name}`, type: 'learned', text: `Scenario "${sc.name}" (${sc.feature}) failed in run ${r.id} (${r.request.project}/${r.request.env}, ${r.startedAt.slice(0, 10)}): ${sc.error.slice(0, 1500)}` });
            }
            for (const m of missionsRef.current?.list() ?? []) {
                if (!m.report) continue;
                docs.push({ path: `mission/${m.id}`, title: `Mission: ${m.title} (${m.state})`, type: 'learned', text: [`Mission "${m.title}" ended ${m.state}${m.verifications.at(-1)?.passed ? ', verified' : ''}.`, m.report.summary,
                    ...(m.report.findings ?? []).map((f) => `- ${f.scenario ? `${f.scenario}: ` : ''}${f.cause ? `[${f.cause}] ` : ''}${f.detail}${f.fixed ? ' (fixed)' : ''}`),
                    ...(m.changes.length ? [`Changed: ${m.changes.map((c) => c.path).join(', ')}`] : [])].join('\n') });
            }
            return docs;
        },
        web: (u) => fetchPage(u),
    });
    const missionsRef: { current?: MissionEngine } = {};
    knowledgeRef.current = knowledge;
    app.get('/api/knowledge', async () => { const cur = knowledge.sources(); return { sources: knowledge.status(), building: knowledge.building, file: KNOWLEDGE_FILE, problems: cur.problems, invalid: cur.invalid, unreadable: cur.unreadable === true, version: knowledge.version() }; });
    /** Remove an entry of the file that is not right (the others stay as written). */
    app.post('/api/knowledge/sources/remove-invalid', async (req) => {
        const index = Number(body(req).index);
        if (!Number.isInteger(index) || index < 0) throw new BadRequest('index: the entry\'s place in the file.');
        try { knowledge.removeInvalid(index); } catch (e) { throw new BadRequest((e as Error).message); }
        log('knowledge.sources', 'Removed an entry of the knowledge sources that was not right', { file: KNOWLEDGE_FILE });
        return { sources: knowledge.status() };
    });
    app.put('/api/knowledge/sources', async (req) => {
        const b = body(req);
        try { knowledge.saveSources(b.sources, sentVersion(b) as string | undefined); } catch (e) { const c = changedElsewhere(e); throw c instanceof Conflict ? c : new BadRequest((e as Error).message); }
        log('knowledge.sources', 'Changed the knowledge sources', { file: KNOWLEDGE_FILE });
        return { sources: knowledge.status(), version: knowledge.version() };
    });
    let knowledgeBuild: Promise<unknown> | null = null;
    app.post('/api/knowledge/build', async (req) => {
        if (knowledgeBuild) throw new BadRequest('The knowledge index is being built.');
        const only = typeof body(req).source === 'string' ? String(body(req).source) : undefined;
        knowledgeBuild = knowledge.build(only).then((r) => { log('knowledge.build', `Built the knowledge index: ${r.map((x) => `${x.source} ${x.docs} documents`).join(', ')}`); return r; })
            .catch((e) => log('knowledge.build', `The knowledge index could not be built: ${(e as Error).message}`)).finally(() => { knowledgeBuild = null; });
        return { started: true };
    });
    app.get('/api/knowledge/search', async (req) => {
        const q = req.query as Record<string, string>;
        const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
        // At most 500 characters as people count them (an emoji is one), as the screen counts.
        const text = str(q.q, 'the search', { max: 2000 });
        const n = Array.from(text).length;
        if (n > 500) throw new BadRequest(`The search is too long: at most 500 characters (it has ${n}).`);
        return { hits: knowledge.search(text, { k: Number(q.k) || 10, sources: list(q.sources), types: list(q.types) as never }) };
    });
    app.get('/api/knowledge/read', async (req) => {
        const r = knowledge.read(str((req.query as Record<string, string>).id, 'id', { max: 80 }));
        if (!r) throw new BadRequest('No such passage.');
        return r;
    });
    // The first time agents need knowledge: this repository and the learned history are indexed (in the background).
    const ensureKnowledge = () => { if (!knowledgeBuild && knowledge.status().every((x) => !x.builtAt)) knowledgeBuild = knowledge.build().catch(() => undefined).finally(() => { knowledgeBuild = null; }); };
    ensureKnowledgeRef.current = ensureKnowledge;

    const missionAgent = opts.missionAgent ?? { start: (o) => agents.createMission(o), send: (id, t) => agents.send(id, t), abort: (id) => agents.abort(id), usageOf: (id) => agents.usageOf(id), pendingOf: (id) => agents.pendingOf(id), decide: (id, a, d) => agents.decide(id, a, d) };
    const missions = new MissionEngine({
        repoRoot: opts.repoRoot, gitDir: gitDirOf(opts.repoRoot), userName: opts.userName,
        agent: missionAgent,
        runTests: missionRunTests, runInfo: (id) => runner.get(id), notify: missionNotify, outputDirs: () => outputDirs(), log: (a, t, d) => log(a, t, d),
        browser: studioBrowser,
        // Written code is checked against the framework's standards before its tests run (what the Recorder applies).
        standards: (files, project, env) => {
            const kind = (p: string): FileKind => p.endsWith('.feature') ? 'feature' : p.endsWith('.json') ? 'data' : p.endsWith('.env') ? 'config'
                : isStepFile(path.basename(p)) ? 'steps' : /(^|\/)pages?\//.test(p) || /Page\.ts$/.test(p) ? 'page' : 'other';
            const plan: ChangePlan = { title: 'Mission', warnings: [], files: files.map((f) => ({ path: f.path, kind: kind(f.path), text: f.text })) };
            return checkPlan(require('typescript') as typeof import('typescript'), plan, projectModel(project, env), { secretValues: secretValues(), before: beforeOf, repoRoot: opts.repoRoot });
        },
        // A team member that explores gets a browser of its own (headless, the same network settings).
        newBrowser: () => new StudioBrowser({ repoRoot: opts.repoRoot, headless: true, ...(() => { const n = personal().network; return n.proxyMode === 'manual' && n.proxyUrl ? { proxy: { server: n.proxyUrl, bypass: n.bypass.join(',') } } : {}; })() }),
    });
    missionsRef.current = missions;
    const triggers = new MissionTriggers(missions, opts.repoRoot, (a, t, d) => log(a, t, d));
    runner.on('ended', (run: RunInfo) => { void triggers.onRunEnded(run).catch(() => undefined); });
    const triggerTimer = setInterval(() => { void triggers.tick().catch(() => undefined); }, 30_000);
    triggerTimer.unref?.();
    app.addHook('onClose', async () => { clearInterval(triggerTimer); for (const m of missions.running()) await missions.stop(m.id, 'the Studio closing').catch(() => undefined); });
    const missionId = (req: FastifyRequest) => { const id = str((req.params as { id: string }).id, 'id', { max: 40 }); if (!missions.get(id)) throw new NotFound('Mission not found: it may have been deleted.'); return id; };
    const missionSummary = (m: MissionRun) => ({ id: m.id, key: m.key, title: m.title, state: m.state, reason: m.reason, trigger: m.trigger, createdAt: m.createdAt, endedAt: m.endedAt, used: m.used, budget: m.budget, changes: m.changes.length, verified: !!m.verifications.at(-1)?.passed && !m.verifications.at(-1)?.reportOnly, waiting: m.checkpoints.some((c) => c.answer === undefined) && m.state === 'waiting', result: m.result?.kind });
    app.get('/api/missions', async () => {
        const f = readMissionsFile(opts.repoRoot);
        return {
            templates: missionTemplates(opts.repoRoot).map((t) => ({ key: t.key, title: t.title, about: t.about, inputs: t.inputs, ...(t.oneOf ? { oneOf: t.oneOf } : {}), writes: t.writes, budget: t.budget, ...(t.team?.length ? { team: t.team.map((id) => teamMember(opts.repoRoot, id)).filter((x) => !!x).map((x) => ({ id: x!.id, name: x!.name })) } : {}) })),
            runs: missions.list().map(missionSummary), triggers: f.file.triggers ?? [], problems: f.problems, file: MISSIONS_FILE,
            // Mission agents' own triggers (set in Agent builder): listed and counted with the team's.
            agentTriggers: listAgents(opts.repoRoot).agents.filter((a) => a.mode === 'mission').flatMap((a) => (a.triggers ?? []).map((t) => ({ agent: a.id, name: a.name, ...t }))),
        };
    });
    app.get('/api/missions/:id', async (req) => missions.get(missionId(req)));
    app.get('/api/missions/:id/shots/:file', async (req, reply) => {
        const f = missions.shot(missionId(req), str((req.params as { file: string }).file, 'file', { max: 40 }));
        if (!f) throw new BadRequest('No such screenshot.');
        return reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store').send(fs.readFileSync(f));
    });
    app.post('/api/missions', async (req) => {
        const b = body(req);
        const inputs = (b.inputs && typeof b.inputs === 'object' ? b.inputs : {}) as Record<string, string>;
        const budget = (b.budget && typeof b.budget === 'object' ? b.budget : {}) as Record<string, number>;
        try {
            const m = await missions.start(str(b.key, 'key', { max: 40 }), Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v ?? '')])), {
                autonomy: b.autonomy === 'supervised' ? 'supervised' : 'autonomous', queue: b.queue === true, unattended: b.unattended === true,
                ...(b.unattended === true ? { trigger: { kind: 'pipeline' as const, by: opts.userName ?? 'pipeline' } } : {}),
                // Passed as sent: a decimal, text or a number out of range is refused (missions.start), never dropped or rounded.
                budget: Object.fromEntries(Object.entries(budget).filter(([k, v]) => ['minutes', 'modelCalls', 'attempts'].includes(k) && v !== undefined && v !== null)) as Record<string, number>,
            });
            return missionSummary(m);
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // A finished mission taken off the list (its copy, screenshots and branch go too, unless a pull request uses the branch).
    app.delete('/api/missions/:id', async (req) => {
        confirmed(body(req), 'deleting the mission');
        try { await missions.remove(missionId(req), opts.userName ?? 'you'); } catch (e) { throw new BadRequest((e as Error).message); }
        return { ok: true };
    });
    app.post('/api/missions/:id/stop', async (req) => { try { await missions.stop(missionId(req), opts.userName ?? 'you'); } catch (e) { throw new BadRequest((e as Error).message); } return { ok: true }; });
    app.post('/api/missions/:id/answer', async (req) => {
        const b = body(req);
        try { missions.answer(missionId(req), str(b.checkpoint, 'checkpoint', { max: 20 }), str(b.answer, 'answer', { max: 20000 }), opts.userName ?? 'you'); } catch (e) { throw new BadRequest((e as Error).message); }
        return { ok: true };
    });
    app.post('/api/missions/:id/approve', async (req) => {
        const b = body(req);
        const d = String(b.decision);
        if (!['once', 'session', 'reject'].includes(d)) throw new BadRequest('Decision: once, session or reject.');
        try { missions.approve(missionId(req), str(b.approval, 'approval', { max: 40 }), d as 'once', opts.userName ?? 'you'); } catch (e) { throw new BadRequest((e as Error).message); }
        return { ok: true };
    });
    // A bug the mission found in the application, filed in Azure DevOps (the person confirms; tagged so it is found again).
    app.post('/api/missions/:id/bugs/:index', async (req) => {
        const b = body(req);
        confirmed(b, 'filing the bug in Azure DevOps');
        const m = missions.get(missionId(req))!;
        const index = Number((req.params as { index: string }).index);
        const bug = m.report?.bugs?.[index];
        if (!bug) throw new BadRequest('No such bug in the mission\'s report.');
        if (bug.filed) throw new BadRequest(`Already filed as ${bug.filed.id}.`);
        const t = adoTarget({ ...(m.inputs.project ? { project: m.inputs.project } : {}), ...(m.inputs.env ? { env: m.inputs.env } : {}) });
        const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const title = maskAll(str(b.title, 'title', { optional: true, max: 255 }) || bug.title).slice(0, 255);
        const v = m.verifications.at(-1);
        const repro = maskAll([`<p>${esc(typeof b.detail === 'string' && b.detail.trim() ? b.detail : bug.detail).replace(/\n/g, '<br>')}</p>`,
            `<p>Found by the CS Test Studio mission "${esc(m.title)}" (${m.id}) in project ${esc(m.inputs.project ?? '')}, environment ${esc(m.inputs.env ?? '')}.</p>`,
            ...(m.report?.findings?.filter((f) => f.cause === 'product').length ? [`<ul>${m.report.findings.filter((f) => f.cause === 'product').map((f) => `<li>${f.scenario ? `<b>${esc(f.scenario)}</b>: ` : ''}${esc(f.detail)}</li>`).join('')}</ul>`] : []),
            ...(v ? [`<p>Verification: ${esc(v.why)} ${v.passed ? 'Passed' : 'Failed'}.</p>`] : [])].join(''));
        let created: { id: number };
        try {
            created = await adoClient(t.project, t.env).jsonPatch<{ id: number }>('POST', 'wit/workitems/$Bug', [
                { op: 'add', path: '/fields/System.Title', value: title },
                { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: repro },
                { op: 'add', path: '/fields/System.Tags', value: `automation; cs-mission; cs-mission-${m.id}` },
            ]);
        } catch (e) { throw new BadRequest((e as Error).message); }
        const ado = adoClient(t.project, t.env);
        const url = `${ado.orgUrl}/${encodeURIComponent(ado.projectName)}/_workitems/edit/${created.id}`;
        missions.bugFiled(m.id, index, { id: created.id, url }, opts.userName ?? 'you');
        log('mission.bug', `Filed bug ${created.id} from the mission ${m.title}`, { bug: created.id });
        return { id: created.id, url };
    });
    app.get('/api/missions/:id/diff', async (req, reply) => reply.type('text/plain; charset=utf-8').send(maskAll(await missions.diff(missionId(req)))));
    app.post('/api/missions/:id/apply', async (req) => {
        confirmed(body(req), 'bringing the mission\'s changes into your working copy');
        try { const r = await missions.apply(missionId(req), opts.userName ?? 'you'); log('mission.apply', `Brought a mission's changes into the working copy (${r.files.length} files)`); return r; } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/missions/:id/discard', async (req) => {
        confirmed(body(req), 'discarding the mission\'s copy and branch');
        try { await missions.discard(missionId(req), opts.userName ?? 'you'); } catch (e) { throw new BadRequest((e as Error).message); }
        return { ok: true };
    });
    // The mission's branch pushed and opened as a pull request (the person confirms).
    app.post('/api/missions/:id/publish', async (req) => {
        const b = body(req);
        confirmed(b, 'pushing the mission\'s branch and opening a pull request');
        const m = missions.get(missionId(req))!;
        if (!MISSION_FINISHED.includes(m.state) || !m.commit || !m.copy) throw new BadRequest('Only a finished mission with changes can be published.');
        if (m.result) throw new BadRequest(`Already ${m.result.kind}.`);
        const { pr } = await prsFor(b as Record<string, string>);
        const remote = (await runGit(['remote'], { cwd: opts.repoRoot })).stdout.split('\n').map((x) => x.trim()).filter(Boolean);
        const name = remote.includes('origin') ? 'origin' : remote[0];
        if (!name) throw new BadRequest('This repository has no remote to push to.');
        const push = await runGit(['push', name, `${m.copy.branch}:refs/heads/${m.copy.branch}`], { cwd: opts.repoRoot, allowFailure: true });
        if (push.code !== 0) throw new BadRequest(`Could not push ${m.copy.branch}: ${push.stderr.trim().split('\n').pop()}`);
        const v = m.verifications.at(-1);
        const description = [`**${missionLabel(m.state)}**${v?.passed ? ' — verified by CS Test Studio' : ''}`, '', m.report?.summary ?? '', '',
            ...(m.report?.findings?.length ? ['### Findings', ...m.report.findings.map((f) => `- ${f.scenario ? `**${f.scenario}** ` : ''}${f.cause ? `(${f.cause}) ` : ''}${f.detail}${f.fixed ? ' — fixed' : ''}`), ''] : []),
            ...(m.report?.bugs?.length ? ['### Application bugs found', ...m.report.bugs.map((x) => `- **${x.title}**: ${x.detail}`), ''] : []),
            ...(v ? ['### Verification', `${v.why} ${v.passed ? 'Passed' : 'Failed'}${v.runs.length ? ` (${v.runs.map((r) => `run ${r.id}: ${r.passed ?? 0} passed, ${r.failed ?? 0} failed`).join('; ')})` : ''}.`] : [])].join('\n');
        try {
            const r = await pr.create(str(b.repository, 'repository', { max: 200 }), { source: m.copy.branch, target: str(b.target, 'target', { max: 200 }), title: str(b.title, 'title', { optional: true, max: 400 }) || m.title, description: maskAll(description).slice(0, 4000), draft: b.draft !== false });
            missions.published(m.id, r, opts.userName ?? 'you');
            log('mission.publish', `Opened pull request ${r.id} from the mission ${m.title}`, { id: r.id });
            return r;
        } catch (e) { throw new BadRequest((e as Error).message); }
    });
    // Team memory: notes agents read every time; agents propose, people accept.
    const memoryFile = () => path.join(opts.repoRoot, TEAM_MEMORY_FILE);
    app.get('/api/missions-memory', async () => ({ file: TEAM_MEMORY_FILE, text: fs.existsSync(memoryFile()) ? fs.readFileSync(memoryFile(), 'utf8') : '', version: agentFileVersion(memoryFile()) }));
    app.put('/api/missions-memory', async (req) => {
        const text = typeof body(req).text === 'string' ? String(body(req).text) : '';
        try { checkAgentVersion(agentFileVersion(memoryFile()), sentVersion(body(req)), TEAM_MEMORY_FILE); } catch (e) { throw changedElsewhere(e); }
        if (text.length > 20000) throw new BadRequest('Keep the team notes under 20,000 characters: agents read them every time.');
        fs.mkdirSync(path.dirname(memoryFile()), { recursive: true });
        fs.writeFileSync(memoryFile(), maskAll(text));
        log('agent.memory', 'Changed the team notes for agents');
        return { ok: true, version: agentFileVersion(memoryFile()) };
    });
    app.post('/api/missions/:id/memory/:note', async (req) => {
        const id = missionId(req);
        const accept = body(req).accept === true;
        let note: string | null;
        try { note = missions.memory(id, str((req.params as { note: string }).note, 'note', { max: 20 }), accept); } catch (e) { throw new BadRequest((e as Error).message); }
        if (note) {
            fs.mkdirSync(path.dirname(memoryFile()), { recursive: true });
            const cur = fs.existsSync(memoryFile()) ? fs.readFileSync(memoryFile(), 'utf8') : '# Notes for agents\n';
            fs.writeFileSync(memoryFile(), `${cur.replace(/\s*$/, '\n')}- ${maskAll(note).replace(/\n+/g, ' ')}\n`);
            log('agent.memory', 'Accepted a note for agents from a mission');
        }
        return { ok: true };
    });

    // ---- Agent Builder: the team's agents (.cs-studio/agents/<id>.json), assistants or missions.
    const builderView = () => {
        const l = listAgents(opts.repoRoot);
        return { agents: l.agents, versions: l.versions, problems: l.problems, dir: AGENTS_DIR, templates: AGENT_TEMPLATES, teamCandidates: teamCandidates(opts.repoRoot), groups: TOOL_GROUPS.map(({ id, label, about }) => ({ id, label, about })),
            knowledge: knowledge.sources().sources.map((x) => ({ id: x.id, name: x.name })), reserved: BUILT_IN_MISSIONS.map((t) => t.key), policyModels: agents.policyNow()?.models ?? null };
    };
    app.get('/api/agent-builder', async () => builderView());
    app.put('/api/agent-builder/:id', async (req) => {
        const b = body(req);
        const id = str((req.params as { id: string }).id, 'id', { max: 40 });
        const a = (b.agent && typeof b.agent === 'object' ? b.agent : {}) as Record<string, unknown>;
        if (a.id !== id) throw new BadRequest('The agent id does not match the address.');
        const models = agents.policyNow()?.models;
        if (typeof a.model === 'string' && a.model && models?.length && !models.includes(a.model)) throw new BadRequest(`The repository's agent policy allows these models only: ${models.join(', ')}.`);
        const unknown = (Array.isArray(a.team) ? a.team : []).filter((t) => typeof t !== 'string' || !teamMember(opts.repoRoot, t));
        if (unknown.length) throw new BadRequest(`No agent for the team member(s): ${unknown.join(', ')}.`);
        try {
            const v = sentVersion(b);
            const saved = saveAgent(opts.repoRoot, a, opts.userName ?? 'unknown', { knowledgeIds: knowledge.sources().sources.map((x) => x.id), reserved: BUILT_IN_MISSIONS.map((t) => t.key), isNew: b.isNew === true, ...(typeof v === 'string' ? { version: v } : {}) });
            log('agent.builder', `${b.isNew === true ? 'Made' : 'Changed'} the team agent ${saved.name}`, { file: `${AGENTS_DIR}/${saved.id}.json` });
            return { agent: saved, ...builderView() };
        } catch (e) { const c = changedElsewhere(e); throw c instanceof Conflict ? c : new BadRequest((e as Error).message); }
    });
    // Evaluations: test cases for an agent, run in safe sessions, compared with the run before.
    const evals = new EvalRunner({ repoRoot: opts.repoRoot, gitDir: gitDirOf(opts.repoRoot), agent: missionAgent, userName: opts.userName, log: (a, t, d) => log(a, t, d) });
    const evalAgent = (req: FastifyRequest) => { const id = str((req.params as { agent: string }).agent, 'agent', { max: 40 }); if (!teamMember(opts.repoRoot, id)) throw new BadRequest(`No agent "${id}".`); return id; };
    const evalSummary = (r: EvalRun) => ({ id: r.id, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt, by: r.by, passed: r.passed, total: r.total, ...(r.compared ? { compared: r.compared } : {}), subject: r.subject, ...(r.models?.length ? { models: r.models } : {}) });
    app.get('/api/evals/:agent', async (req) => {
        const id = evalAgent(req);
        const f = path.join(opts.repoRoot, EVALS_DIR, `${id}.json`);
        let problem: string | undefined;
        if (fs.existsSync(f)) { try { validateSuite(JSON.parse(fs.readFileSync(f, 'utf8')), id); } catch (e) { problem = `${EVALS_DIR}/${id}.json: ${(e as Error).message}`; } }
        return { file: `${EVALS_DIR}/${id}.json`, suite: readSuite(opts.repoRoot, id) ?? { agent: id, cases: [] }, version: suiteVersion(opts.repoRoot, id), runs: evals.runs(id).map(evalSummary), running: evals.isRunning(id), ...(problem ? { problem } : {}) };
    });
    // Saved with the version of the file the screen read: changed meanwhile (another tab, a pull) → 409, unless forced.
    app.put('/api/evals/:agent', async (req) => {
        const id = evalAgent(req);
        const b = body(req);
        try {
            const v = sentVersion(b);
            const suite = saveSuite(opts.repoRoot, id, (b as { suite?: unknown }).suite, opts.userName ?? 'unknown', typeof v === 'string' ? { version: v } : {});
            log('agent.eval', `Saved ${suite.cases.length} evaluation case(s) for ${id}`, { file: `${EVALS_DIR}/${id}.json` });
            return { suite, version: suiteVersion(opts.repoRoot, id) };
        } catch (e) { const c = changedElsewhere(e); throw c instanceof Conflict ? c : new BadRequest((e as Error).message); }
    });
    app.post('/api/evals/:agent/run', async (req) => {
        const id = evalAgent(req);
        const only = (body(req) as { cases?: unknown }).cases;
        try { return evalSummary(evals.start(id, opts.userName ?? 'unknown', Array.isArray(only) ? only.map(String) : undefined)); } catch (e) { throw new BadRequest((e as Error).message); }
    });
    app.post('/api/evals/:agent/stop', async (req) => { try { await evals.stop(evalAgent(req)); return { ok: true }; } catch (e) { throw new BadRequest((e as Error).message); } });
    app.get('/api/evals/:agent/runs/:run', async (req) => {
        const r = evals.get(evalAgent(req), str((req.params as { run: string }).run, 'run', { max: 40 }));
        if (!r) throw new BadRequest('No such evaluation run.');
        return r;
    });
    // ---- The inbox: everything agents wait for a person on (agents/inbox.ts), answered in place, sent to channels once.
    const inboxItems = () => collectInbox({ missions: () => missions.list(), conversations: () => agents.conversationsWaiting(), evaluations: () => evals.latestAll() });
    const inboxNotifier = new InboxNotifier((item) => {
        for (const c of notifyChannels().filter((x) => x.enabled && x.inbox)) {
            const url = webhookOf(c);
            if (url) void deliverInbox(c, url, item, netConnection()).then(recordDelivery).catch(() => undefined);
        }
    });
    const inboxCheck = () => { try { inboxNotifier.update(inboxItems()); } catch { /* next time */ } };
    // What waits now is not sent again; from here on each new item is sent once (at once for missions, else within 5 s).
    inboxCheck();
    missions.onChange(() => inboxCheck());
    const inboxTimer = setInterval(inboxCheck, 5000);
    inboxTimer.unref?.();
    app.addHook('onClose', async () => { clearInterval(inboxTimer); });
    app.get('/api/inbox', async () => ({ items: inboxItems() }));
    app.post('/api/inbox/act', async (req) => {
        const b = body(req) as { id?: string; action?: string; text?: string };
        const id = str(b.id, 'id', { max: 200 });
        const item = inboxItems().find((x) => x.id === id);
        if (!item) throw new BadRequest('It is no longer waiting (answered, or the mission ended).');
        const action = String(b.action ?? '');
        if (!item.actions.includes(action as never) || action === 'open') throw new BadRequest(`"${action}" is not possible here.`);
        const by = opts.userName ?? 'unknown';
        const [type, sid, part, rest] = id.split(':');
        try {
            if (type === 'm' && part === 'cp') missions.answer(sid, rest, str(b.text, 'text', { max: 20000 }), by);
            else if (type === 'm' && part === 'ap') missions.approve(sid, rest, action === 'approve' ? 'once' : action === 'approve-session' ? 'session' : 'reject', by);
            else if (type === 'c') agents.decide(sid, part, action === 'approve' ? 'once' : action === 'approve-session' ? 'session' : 'reject');
            else throw new Error('Nothing to do here: open it.');
        } catch (e) { throw new BadRequest((e as Error).message); }
        log('inbox.act', `${by} ${action === 'answer' ? 'answered' : action === 'reject' ? 'rejected' : 'approved'} from the inbox: ${item.title.slice(0, 200)}`, { inbox: id });
        return { items: inboxItems() };
    });
    app.delete('/api/agent-builder/:id', async (req) => {
        confirmed(body(req), 'deleting the agent');
        const id = str((req.params as { id: string }).id, 'id', { max: 40 });
        try { deleteAgent(opts.repoRoot, id); } catch (e) { throw new BadRequest((e as Error).message); }
        // Its evaluation cases go with it: a new agent with the same id starts with none.
        const evalFile = path.join(opts.repoRoot, EVALS_DIR, `${id}.json`);
        const hadEvals = fs.existsSync(evalFile);
        if (hadEvals) fs.rmSync(evalFile, { force: true });
        log('agent.builder', `Deleted the team agent ${id}${hadEvals ? ' and its evaluation cases' : ''}`, { file: `${AGENTS_DIR}/${id}.json` });
        return builderView();
    });
    // Work-item and pull-request triggers of mission agents: Azure DevOps is asked every 5 minutes (only while one is on).
    const polled = new PolledTriggers(missions, opts.repoRoot, path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'trigger-state.json'), {
        workItems: async (query, project) => {
            const t = adoTarget(project ? { project } : {});
            return (await adoClient(t.project, t.env).post<{ workItems: Array<{ id: number }> }>('wit/wiql?$top=200', { query })).workItems.map((w) => w.id);
        },
        pullRequests: async (o) => {
            const t = adoTarget(o.project ? { project: o.project } : {});
            const q = new URLSearchParams({ 'searchCriteria.status': 'active', $top: '100', ...(o.target ? { 'searchCriteria.targetRefName': `refs/heads/${o.target.replace(/^refs\/heads\//, '')}` } : {}) });
            const r = await adoClient(t.project, t.env).get<{ value: Array<{ pullRequestId: number; repository: { name: string }; lastMergeSourceCommit?: { commitId?: string } }> }>(`git/pullrequests?${q.toString()}`, 'project', 'Code (Read)');
            return r.value.filter((p) => !o.repository || p.repository.name === o.repository).map((p) => ({ repository: p.repository.name, id: p.pullRequestId, updated: p.lastMergeSourceCommit?.commitId ?? '' }));
        },
    }, (a, t, d) => log(a, t, d));
    const hasPolled = () => listAgents(opts.repoRoot).agents.some((a) => a.mode === 'mission' && (a.triggers ?? []).some((t) => (t.on === 'work-item' || t.on === 'pull-request') && t.enabled !== false));
    const pollTimer = setInterval(() => { if (hasPolled()) void polled.check().catch(() => undefined); }, 5 * 60_000);
    pollTimer.unref?.();
    app.addHook('onClose', async () => { clearInterval(pollTimer); });
    app.post('/api/agent-builder/check-triggers', async () => ({ started: (await polled.check()).map((m) => ({ id: m.id, title: m.title })) }));

    app.get('/api/agents/sessions', async () => ({ sessions: agents.list() }));
    app.post('/api/agents/sessions', async (req) => {
        const b = body(req);
        let profile;
        if (typeof b.agent === 'string' && b.agent) {
            const a = getAgent(opts.repoRoot, b.agent);
            if (!a) throw new BadRequest('No such team agent.');
            if (a.mode !== 'assistant') throw new BadRequest(`${a.name} is a mission agent: start it from Missions.`);
            profile = profileOf(a);
        }
        try { return await agents.create({ title: typeof b.title === 'string' ? b.title : profile?.name, workflow: typeof b.workflow === 'string' ? b.workflow : undefined, ...(profile ? { profile } : {}) }); } catch (e) { throw agentErr(e); }
    });
    app.delete('/api/agents/sessions/:id', async (req) => { await agents.remove(str((req.params as { id: string }).id, 'id', { max: 80 })); return { ok: true }; });
    app.post('/api/agents/sessions/:id/messages', async (req) => {
        const b = body(req);
        const text = str(b.text, 'text', { max: 100_000 });
        try { await agents.send(str((req.params as { id: string }).id, 'id', { max: 80 }), text, b.context && typeof b.context === 'object' ? b.context as Record<string, unknown> : undefined); } catch (e) { throw agentErr(e); }
        return { ok: true };
    });
    app.get('/api/agents/sessions/:id/events', async (req) => agents.events(str((req.params as { id: string }).id, 'id', { max: 80 }), Number((req.query as Record<string, string>).after) || 0));
    // What a conversation changed (current Git state of each file) and the conversation as Markdown.
    app.get('/api/agents/sessions/:id/changes', async (req) => {
        const files = agents.changes(str((req.params as { id: string }).id, 'id', { max: 80 }));
        const st = await git.status().catch(() => null);
        return { files: files.map((p) => {
            const f = st?.files.find((x) => x.path === p);
            const state = !f ? (fs.existsSync(path.join(opts.repoRoot, p)) ? 'unchanged' : 'gone') : f.untracked ? 'new' : f.unstaged === 'D' || f.staged === 'D' ? 'deleted' : f.staged === 'A' ? 'new' : 'modified';
            return { path: p, state, staged: !!f && f.staged !== '.' && !f.untracked };
        }) };
    });
    // Review of an agent's edits in the editor (as VS Code's Keep / Undo): each file against its state before the
    // conversation first changed it (src/agents/baselines.ts), with the changed blocks (src/agents/hunks.ts).
    const readNowOrNull = (rel: string): string | null => {
        try { const abs = safePath(opts.repoRoot, rel); const st = fs.statSync(abs); if (!st.isFile() || st.size > BASELINE_MAX) return null; return fs.readFileSync(abs, 'utf8'); } catch { return null; }
    };
    const baselineOf = async (id: string, rel: string): Promise<string | null | undefined> => {
        const b = agents.baselines.get(id, rel);
        if (b) return b.text;
        // Changed before baselines were kept (or named only in a Studio answer): the last commit.
        const r = await runGit(['show', `HEAD:${rel}`], { cwd: opts.repoRoot, allowFailure: true });
        return r.code === 0 ? r.stdout : null;
    };
    const reviewFiles = async (id: string) => {
        const out: Array<{ path: string; state: 'new' | 'modified' | 'deleted'; added: number; removed: number; before: string | null; after: string | null }> = [];
        for (const rel of agents.changes(id).slice(0, 200)) {
            const before = await baselineOf(id, rel);
            if (before === undefined) continue;
            const after = readNowOrNull(rel);
            if (before === after || (after === null && !fs.existsSync(path.join(opts.repoRoot, rel)) && before === null)) continue;
            const exists = fs.existsSync(path.join(opts.repoRoot, rel));
            if (exists && after === null) continue; // too large or not text: Source control shows it
            const n = changeCount(before, after);
            out.push({ path: rel, state: before === null ? 'new' : !exists ? 'deleted' : 'modified', added: n.added, removed: n.removed, before, after });
        }
        return out;
    };
    /** Every conversation's edits waiting for review (not missions: theirs are on their own branch). */
    app.get('/api/agents/review', async () => {
        const sessions = agents.list().filter((x) => !x.id.startsWith('mission-') && x.changes > 0).slice(0, 30);
        const files: Array<{ session: string; title: string; busy: boolean } & Awaited<ReturnType<typeof reviewFiles>>[number]> = [];
        for (const x of sessions) for (const f of await reviewFiles(x.id)) files.push({ session: x.id, title: x.title, busy: !!x.busy, ...f });
        return { files };
    });
    app.post('/api/agents/sessions/:id/review/keep', async (req) => {
        const id = str((req.params as { id: string }).id, 'id', { max: 80 });
        const b = body(req);
        const mine = new Set(agents.changes(id));
        const paths = b.path === undefined ? [...mine] : [filePath(b.path)];
        for (const p of paths) {
            if (!mine.has(p)) throw new BadRequest(`${p} was not changed by this conversation.`);
            // One change kept: the baseline with it taken in (the client sends it); else the whole file as it is now.
            if (b.baseline !== undefined && b.path !== undefined) agents.baselines.set(id, p, b.baseline === null ? null : content(b.baseline));
            else agents.baselines.set(id, p, fs.existsSync(path.join(opts.repoRoot, p)) ? readNowOrNull(p) : null);
        }
        log('agent.keep', `Kept ${paths.length === 1 ? (b.baseline !== undefined ? `a change in ${paths[0]}` : paths[0]) : `${paths.length} files`} an agent changed`, { agentSession: id });
        return { ok: true };
    });
    app.post('/api/agents/sessions/:id/review/undo', async (req) => {
        const id = str((req.params as { id: string }).id, 'id', { max: 80 });
        const b = body(req);
        const mine = new Set(agents.changes(id));
        const paths = b.path === undefined ? [...mine] : [filePath(b.path)];
        const recoveryDir = path.join(gitDirOf(opts.repoRoot), 'cs-studio', 'recovery', `${new Date().toISOString().replace(/[:.]/g, '-')}-agent-undo`);
        let n = 0;
        for (const p of paths) {
            if (!mine.has(p)) throw new BadRequest(`${p} was not changed by this conversation.`);
            const before = await baselineOf(id, p);
            if (before === undefined) continue;
            const abs = safePath(opts.repoRoot, p);
            const now = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
            if (now !== null && before !== null && now.toString('utf8') === before) continue;
            if (now !== null) { const d = path.join(recoveryDir, p); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, now); }
            if (before === null) fs.rmSync(abs, { force: true });
            else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, before); }
            n++;
        }
        stepCache = null;
        log('agent.undo', `Undid an agent's changes to ${n} file(s); copies kept`, { agentSession: id, recoveryDir });
        return { ok: true, files: n, recoveryDir: n ? recoveryDir : undefined };
    });
    app.get('/api/agents/sessions/:id/transcript', async (req, reply) => {
        const id = str((req.params as { id: string }).id, 'id', { max: 80 });
        let md = '';
        try { md = maskAll(agents.transcript(id)); } catch (e) { throw agentErr(e); }
        return reply.type('text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="agent-${id}.md"`).send(md);
    });
    app.post('/api/agents/sessions/:id/abort', async (req) => { await agents.abort(str((req.params as { id: string }).id, 'id', { max: 80 })); return { ok: true }; });
    app.post('/api/agents/sessions/:id/auto-approve', async (req) => {
        const id = str((req.params as { id: string }).id, 'id', { max: 80 });
        try { return agents.setAutoApprove(id, body(req).on === true); } catch (e) { throw agentErr(e); }
    });
    app.get('/api/agents/sessions/:id/auto-approve', async (req) => ({ autoApprove: agents.autoApproveOf(str((req.params as { id: string }).id, 'id', { max: 80 })) }));
    app.post('/api/agents/sessions/:id/approvals/:aid', async (req) => {
        const p = req.params as { id: string; aid: string };
        const d = String(body(req).decision);
        if (!['once', 'session', 'reject'].includes(d)) throw new BadRequest('Decision: once, session or reject.');
        try { agents.decide(p.id, p.aid, d as 'once'); } catch (e) { throw agentErr(e); }
        return { ok: true };
    });
    // The Studio browser: live frames, a person taking over, the recorded manual run.
    app.get('/api/agents/browser/frame', async (req) => {
        const f = studioBrowser.latest(Number((req.query as Record<string, string>).after) || 0);
        return { running: studioBrowser.running, actor: studioBrowser.lastActor, frame: f };
    });
    app.post('/api/agents/browser/open', async (req) => { try { return await studioBrowser.navigate(str(body(req).url, 'url', { max: 4000 })); } catch (e) { throw agentErr(e); } });
    app.post('/api/agents/browser/input', async (req) => {
        const b = body(req);
        const t = String(b.type);
        try {
            if (t === 'click') await studioBrowser.input({ type: 'click', x: Number(b.x), y: Number(b.y) });
            else if (t === 'type') await studioBrowser.input({ type: 'type', text: str(b.text, 'text', { max: 10_000 }) });
            else if (t === 'key') await studioBrowser.input({ type: 'key', key: str(b.key, 'key', { max: 40 }) });
            else if (t === 'scroll') await studioBrowser.input({ type: 'scroll', dy: Number(b.dy) || 0 });
            else if (t === 'back') await studioBrowser.back();
            else if (t === 'reload') await studioBrowser.reload();
            else throw new BadRequest('Unknown input.');
        } catch (e) { throw e instanceof BadRequest ? e : agentErr(e); }
        return { ok: true };
    });
    app.post('/api/agents/browser/close', async () => { await studioBrowser.close(); return { ok: true }; });
    app.get('/api/agents/browser/recording', async () => ({ script: studioBrowser.recording(), lines: studioBrowser.recordedLines().length }));

    if (hasUi) {
        // wildcard: files are looked up when asked for, so a rebuilt UI (new file names) works without a restart.
        void app.register(fastifyStatic, { root: uiDir, prefix: '/', index: ['index.html'], wildcard: true });
    }
    app.setNotFoundHandler((req, reply) => {
        // A missing script, style or image is a 404, never the page (the browser would run HTML as a script).
        if (req.method === 'GET' && /\.(js|mjs|css|map|png|svg|ico|woff2?|ttf|json)(\?|$)/i.test(req.url.split('#')[0])) return reply.code(404).send({ error: 'Not found.' });
        if (req.method === 'GET' && !req.url.startsWith('/api/') && hasUi) return reply.type('text/html').sendFile('index.html');
        return reply.code(404).send({ error: 'Not found.' });
    });

    return {
        app, token, git,
        async listen(wanted = 0) {
            await app.listen({ host: '127.0.0.1', port: wanted });
            const addr = app.server.address();
            port = typeof addr === 'object' && addr ? addr.port : wanted;
            return { url: `http://127.0.0.1:${port}/#token=${token}`, port };
        },
    };
}
