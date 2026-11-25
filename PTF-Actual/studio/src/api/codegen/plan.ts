/**
 * The files a collection's test is: the feature, and the project code its checks need.
 *
 *   test/<project>/features/api/<name>.feature
 *   test/<project>/steps/<name>-api.steps.ts + helpers/<Name>ApiChecks.ts   database checks, prepared data
 *   test/<project>/steps/api-response-checks.steps.ts + helpers/ApiResponseChecks.ts
 *       the shared helper: written when the project has none; a project's own copy is never replaced
 *   config/<project>/common/<project>-db-queries.env      DB_QUERY_<name> of the database checks (added)
 */
import * as path from 'path';
import type { PlannedFile as ChangeFile } from '../../framework/plan';
import { allRequests, ApiCollection, ApiData, slug } from '../model';
import { toFeature } from '../feature';
import { CHECK_STEPS_FILE, checkStepsText, HELPER_FILE, helperText } from './helper';
import { collectionCode } from './collection';

export interface ApiTestContext {
    /** A multipart part's file is in the project (repository root or the payload folder). */
    fileExists?: (path: string) => boolean;
    project: string;
    featureFolder: string;
    /** The project's (loaded) step folder; helpers go next to it. */
    stepsFolder: string;
    /** The framework package code imports from. */
    pkg: string;
    /** A repository file's text, or null. */
    read: (rel: string) => string | null;
    /** The configuration (to know the queries the project has). */
    config: Record<string, string>;
    columns?: (data: ApiData) => string[];
    templateVars?: (file: string) => string[];
    /** The project's framework has WebSocket steps. */
    wsSteps?: boolean;
    msgSteps?: boolean;
}

export interface ApiTestPlan {
    feature: string;
    text: string;
    scenarios: number;
    files: ChangeFile[];
    warnings: string[];
}

/** {{name}} and {{fn(name)}} of a payload template. */
export function templateNames(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(/\{\{\s*(?:[\w$]+\(\s*)?([A-Za-z_][\w.-]*)\s*\)?\s*\}\}/g)) out.add(m[1]);
    return [...out];
}

export function apiTestPlan(c: ApiCollection, x: ApiTestContext): ApiTestPlan {
    const warnings: string[] = [];
    const code = collectionCode(c, x.pkg);
    const r = toFeature(c, { code, columns: x.columns, templateVars: x.templateVars, wsSteps: x.wsSteps, msgSteps: x.msgSteps, ...(x.fileExists ? { fileExists: x.fileExists } : {}) });
    warnings.push(...r.warnings);
    const feature = `${x.featureFolder}/api/${slug(c.name)}.feature`;
    const files: ChangeFile[] = [{ path: feature, kind: 'feature', text: r.text }];
    const helpers = `${path.posix.dirname(x.stepsFolder)}/helpers`;
    if (code) {
        files.push({ path: `${helpers}/${code.helperFile}`, kind: 'other', text: code.helperText });
        files.push({ path: `${x.stepsFolder}/${code.stepsFile}`, kind: 'steps', text: code.stepsText });
    }
    if (code || r.usesChecks) {
        // The shared helper: the project's copy stays (it may be changed); a missing one is written.
        const helperPath = `${helpers}/${HELPER_FILE}`, stepsPath = `${x.stepsFolder}/${CHECK_STEPS_FILE}`;
        const haveHelper = x.read(helperPath), haveSteps = x.read(stepsPath);
        if (haveHelper === null) files.push({ path: helperPath, kind: 'other', text: helperText(x.pkg) });
        if (haveSteps === null) files.push({ path: stepsPath, kind: 'steps', text: checkStepsText(x.pkg) });
        else {
            // A step the feature uses that the project's copy does not have (an older copy).
            const want = checkStepsText(x.pkg);
            const missing = [...want.matchAll(/@CSBDDStepDef\('([^']+)'\)/g)].map((m) => m[1]).filter((p) => !haveSteps.includes(`'${p}'`) && r.text.includes(p.replace(/\{string\}.*$/, '').trim()));
            if (missing.length) warnings.push(`${stepsPath} has no step "${missing[0]}"${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ''}: it was written by an earlier Studio. Delete it (and ${helperPath}) to have it written again, or add the steps.`);
        }
    }
    // Queries the database checks use that the project does not have yet.
    const rules = allRequests(c.items).flatMap((i) => i.request.checks.filter((ch) => ch.kind === 'dbItems' && ch.db).map((ch) => ch.db!));
    const add: string[] = [];
    for (const rule of rules) {
        const name = rule.query.trim().replace(/^DB_QUERY_/i, '');
        if (!name || /\s/.test(name)) continue; // SQL written in the check
        const key = `DB_QUERY_${name}`;
        if (x.config[key] !== undefined || add.some((l) => l.startsWith(`${key}=`))) continue;
        if (!rule.sql?.trim()) { warnings.push(`${key} is not in the project's configuration: add it to config/${x.project}/common/${x.project}-db-queries.env (or give the check its SQL).`); continue; }
        add.push(`# ${rule.title || 'item'} of ${rule.items} (written by CS Test Studio)`, `${key}=${rule.sql.trim().replace(/\s*\n\s*/g, ' ')}`);
    }
    if (add.length) {
        const queries = `config/${x.project}/common/${x.project}-db-queries.env`;
        const before = x.read(queries) ?? `# Database queries of ${x.project}: DB_QUERY_<NAME>=SQL (CSDBUtils.executeQuery(alias, 'NAME', params))\n`;
        files.push({ path: queries, kind: 'config', text: `${before.replace(/\s*$/, '')}\n\n${add.join('\n')}\n` });
    }
    return { feature, text: r.text, scenarios: r.scenarios, files, warnings };
}
