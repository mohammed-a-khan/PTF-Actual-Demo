/**
 * cs_qa_gov_upgrade_governance — Version-check the framework + MCP server
 * against the latest package.json values.
 *
 * Sources:
 *   consumerPkg     = <workspaceRoot>/package.json
 *   installedFwPkg  = <workspaceRoot>/node_modules/@mdakhan.mak/cs-playwright-test-framework/package.json
 *   registryLatest  = optional — when checkRegistry:true, calls
 *                     `npm view <pkg> version` shelled out (respects any
 *                     .npmrc/proxy). NEVER runs npm install.
 *   changelogHint   = <workspaceRoot>/node_modules/.../CHANGELOG.md — first
 *                     200 lines summarised
 *
 * Optional: when openPr:true AND ADO is configured, opens a PR via
 * cs_qa_ado_write verb=create-pr with a "framework bump" title.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive, getPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';

const InputSchema = z.object({
    packageName: z.string().min(1).default('@mdakhan.mak/cs-playwright-test-framework').describe('Framework package to check. Defaults to the CS Playwright framework.'),
    checkRegistry: z.boolean().default(false).describe('When true, shells `npm view <pkg> version` to look up the latest registry version. Requires npm to be on PATH.'),
    changelogPreviewLines: z.number().int().positive().max(500).default(120),
    openPr: z.boolean().default(false).describe('When true AND the framework is out of date AND ADO creds resolve, open a PR via cs_qa_ado_write verb=create-pr suggesting the bump. NEVER runs npm install.'),
    prRepoId: z.string().min(1).optional().describe('Required when openPr=true — the ADO Git repo ID (or name) to open the PR against.'),
    prSourceBranch: z.string().min(1).optional().describe('When openPr=true, the source branch. Defaults to chore/bump-framework-<newVersion>.'),
    prTargetBranch: z.string().min(1).default('main').describe('Target branch for the bump PR. Defaults to main.'),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    packageName: z.string(),
    consumer: z.object({
        found: z.boolean(),
        declaredVersion: z.string().optional(),
        location: z.string().optional(),
    }),
    installed: z.object({
        found: z.boolean(),
        version: z.string().optional(),
        location: z.string().optional(),
    }),
    latestRegistry: z.object({
        checked: z.boolean(),
        version: z.string().optional(),
        error: z.string().optional(),
    }),
    upgradeAvailable: z.boolean(),
    breakingFlags: z.array(z.string()),
    changelogPreview: z.string().optional(),
    prOpened: z.object({
        attempted: z.boolean(),
        id: z.union([z.number(), z.string()]).optional(),
        url: z.string().optional(),
        note: z.string().optional(),
    }),
    remediation: z.string(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

function readPackageJsonVersion(pkgPath: string): { version?: string; deps?: Record<string, string> } {
    try {
        const j = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        return { version: j.version, deps: { ...(j.dependencies || {}), ...(j.devDependencies || {}) } };
    } catch { return {}; }
}

function compareSemver(a: string, b: string): number {
    // Parse a version string like `1.2.3`, `^1.2`, `v1`, `1.2.3-beta.4` into
    // [major, minor, patch]. Missing segments default to 0 so callers can pass
    // shortened tags (`1.2` vs `1.2.0`) without producing NaN diffs.
    const clean = (s: string): number[] => s.replace(/^[\^~=v]/, '').split('.').map((p) => Number(p.replace(/[^0-9].*$/, '')) || 0);
    const A = clean(a);
    const B = clean(b);
    const aM = A[0] ?? 0, aN = A[1] ?? 0, aP = A[2] ?? 0;
    const bM = B[0] ?? 0, bN = B[1] ?? 0, bP = B[2] ?? 0;
    if (aM !== bM) return aM - bM;
    if (aN !== bN) return aN - bN;
    return aP - bP;
}

function findBreakingFlags(changelogText: string, currentVersion: string | undefined, latestVersion: string | undefined): string[] {
    const flags: string[] = [];
    const lines = changelogText.split(/\r?\n/);
    let inWindow = !currentVersion; // if no boundary, include everything
    for (const l of lines) {
        const versionHeader = /^##?\s+\[?v?(\d+\.\d+\.\d+)\]?/i.exec(l);
        if (versionHeader && currentVersion) {
            const v = versionHeader[1];
            if (compareSemver(v, currentVersion) <= 0) break;
            inWindow = true;
        }
        if (!inWindow) continue;
        if (/(BREAKING(\s+CHANGE)?)|(!:\s)|^!\s/i.test(l)) {
            flags.push(l.trim().slice(0, 200));
        }
    }
    void latestVersion; // reserved for future filtering
    return flags;
}

registerPrimitive({
    name: 'cs_qa_gov_upgrade_governance',
    description: 'Governance hook — version-check the framework + MCP server against latest. Reads consumer package.json + installed node_modules/.../package.json. Optional `checkRegistry` shells `npm view <pkg> version` for the registry latest. Surfaces changelog preview + BREAKING flags. Optional `openPr` (with ADO configured) opens a PR via cs_qa_ado_write verb=create-pr suggesting the bump. NEVER runs npm install — reports only. Inputs: {packageName?, checkRegistry?, openPr?, prRepoId?, prSourceBranch?, prTargetBranch?}. Example: {checkRegistry:true, openPr:true, prRepoId:"my-repo"}.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_upgrade_governance', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // 1. Consumer declared version.
        const consumerPkgPath = path.join(ctx.workspaceRoot, 'package.json');
        const consumer = readPackageJsonVersion(consumerPkgPath);
        const declaredVersion = consumer.deps?.[input.packageName];
        const consumerBlock = {
            found: fs.existsSync(consumerPkgPath),
            declaredVersion,
            location: consumerPkgPath,
        };

        // 2. Installed version.
        const installedPkgPath = path.join(ctx.workspaceRoot, 'node_modules', ...input.packageName.split('/'), 'package.json');
        const installed = readPackageJsonVersion(installedPkgPath);
        const installedBlock = {
            found: fs.existsSync(installedPkgPath),
            version: installed.version,
            location: installedPkgPath,
        };

        // 3. Latest registry (optional).
        let latestBlock: z.infer<typeof OutputSchema>['latestRegistry'] = { checked: false };
        if (input.checkRegistry) {
            // Validate packageName before spawning `npm view` — must be a legal npm
            // package name (scoped or unscoped) so a hostile caller cannot inject
            // shell metacharacters (even though we pass args via array, defense in
            // depth: reject anything that isn't [A-Za-z0-9._/@-]).
            if (!/^[@a-z0-9._/-]+$/i.test(input.packageName)) {
                const err = `refusing to run npm view: packageName ${JSON.stringify(input.packageName)} is not a valid npm identifier (allowed: [A-Za-z0-9._/@-]).`;
                latestBlock = { checked: true, error: err };
                warnings.push(err);
            } else {
                const res = spawnSync('npm', ['view', input.packageName, 'version'], { cwd: ctx.workspaceRoot, encoding: 'utf-8', timeout: 20000 });
                if (res.error) {
                    latestBlock = { checked: true, error: `npm view failed: ${res.error.message}` };
                } else if (res.status !== 0) {
                    latestBlock = { checked: true, error: `npm view exit ${res.status}: ${(res.stderr || '').trim().slice(0, 200)}` };
                } else {
                    latestBlock = { checked: true, version: (res.stdout || '').trim() };
                }
            }
        }

        // 4. Changelog preview from installed copy.
        let changelogPreview: string | undefined;
        let breakingFlags: string[] = [];
        const changelogPath = path.join(path.dirname(installedPkgPath), 'CHANGELOG.md');
        if (fs.existsSync(changelogPath)) {
            try {
                const text = fs.readFileSync(changelogPath, 'utf-8');
                const lines = text.split(/\r?\n/).slice(0, input.changelogPreviewLines);
                changelogPreview = lines.join('\n');
                breakingFlags = findBreakingFlags(text, installedBlock.version, latestBlock.version);
            } catch (e) {
                warnings.push(`Failed to read CHANGELOG.md at ${changelogPath}: ${(e as Error).message}`);
            }
        }

        // 5. Upgrade available?
        let upgradeAvailable = false;
        if (installedBlock.version && latestBlock.version && compareSemver(installedBlock.version, latestBlock.version) < 0) upgradeAvailable = true;

        // 6. Open PR (optional) — never runs npm install.
        let prBlock: z.infer<typeof OutputSchema>['prOpened'] = { attempted: false };
        if (input.openPr && upgradeAvailable) {
            if (!input.prRepoId) {
                prBlock = { attempted: false, note: 'openPr=true but prRepoId not supplied — skipping.' };
            } else {
                const writeTool = getPrimitive('cs_qa_ado_write');
                if (!writeTool) {
                    prBlock = { attempted: false, note: 'cs_qa_ado_write primitive not registered — cannot open PR.' };
                } else {
                    const newVersion = latestBlock.version!;
                    const branch = input.prSourceBranch ?? `chore/bump-framework-${newVersion}`;
                    const title = `chore(deps): bump ${input.packageName} to ${newVersion}`;
                    const description = [
                        `Bumps ${input.packageName} from ${installedBlock.version} to ${newVersion}.`,
                        breakingFlags.length > 0 ? `\n**Breaking flags detected:**\n${breakingFlags.map((b) => `- ${b}`).join('\n')}` : '',
                        `\nGenerated by cs_qa_gov_upgrade_governance. This tool does NOT run npm install; the bump commits must be made manually and pushed to \`${branch}\` before this PR can merge.`,
                    ].join('\n');
                    try {
                        const out = await writeTool.run(ctx, {
                            verb: 'create-pr',
                            repoId: input.prRepoId,
                            sourceBranch: branch,
                            targetBranch: input.prTargetBranch,
                            title,
                            description,
                        });
                        const r = out as { id?: number | string; url?: string; note?: string };
                        prBlock = { attempted: true, id: r.id, url: r.url, note: r.note };
                    } catch (e) {
                        prBlock = { attempted: true, note: `PR create failed: ${(e as Error).message}` };
                    }
                }
            }
        }

        const remediationParts: string[] = [];
        if (upgradeAvailable) {
            remediationParts.push(`Bump ${input.packageName} from ${installedBlock.version} → ${latestBlock.version}: update package.json and run \`npm install\` locally.`);
        } else if (!installedBlock.found) {
            remediationParts.push(`Install ${input.packageName} in this workspace: \`npm install ${input.packageName}\`.`);
        } else if (!latestBlock.checked) {
            remediationParts.push(`Re-run with checkRegistry:true to compare against the registry latest.`);
        } else {
            remediationParts.push(`No action — installed version is current.`);
        }
        if (breakingFlags.length > 0) {
            remediationParts.push(`Review ${breakingFlags.length} BREAKING flag(s) in the changelog before bumping.`);
        }

        log.info('upgrade governance complete', { packageName: input.packageName, installed: installedBlock.version, latest: latestBlock.version, upgradeAvailable, breakingCount: breakingFlags.length });
        return {
            ok: true,
            packageName: input.packageName,
            consumer: consumerBlock,
            installed: installedBlock,
            latestRegistry: latestBlock,
            upgradeAvailable,
            breakingFlags,
            changelogPreview,
            prOpened: prBlock,
            remediation: remediationParts.join(' '),
            warnings,
            note: upgradeAvailable
                ? `Upgrade available: ${installedBlock.version} → ${latestBlock.version}. ${breakingFlags.length} BREAKING flag(s).`
                : `${input.packageName} is current (installed ${installedBlock.version ?? 'unknown'}).`,
        };
    },
});
