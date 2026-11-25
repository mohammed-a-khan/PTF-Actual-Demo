/**
 * The project model: what every generator builds on, read once from the repository the way the
 * framework itself reads it.
 *  - Folders: features (from the run catalogue), steps (the project's own folder in
 *    STEP_DEFINITIONS_PATH), pages, test data.
 *  - Page objects (classes extending CSBasePage, their @CSPage ids, elements and locators, methods).
 *  - Step definitions: every one the project's features can use (project and framework), plus those
 *    in files the framework does not load (so a check can say why a step is not found).
 *  - Configuration: the project's own files, the resolved values of the environment, where
 *    STEP_DEFINITIONS_PATH is set and which step folders it loads.
 *  - Files a generator may extend (step files, data files, features): path → text.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as TS from 'typescript';
import type { StepDef } from '../lang/steps';
import { ExistingPage, parsePageObject } from './code';

export interface ExistingStepDef { pattern: string; regex: RegExp; file: string; builtIn: boolean }
export interface ConfigFile { path: string; text: string | null }

export interface ProjectContext {
    project: string;
    env: string;
    featureFolder: string; pagesFolder: string; stepsFolder: string; dataFolder: string;
    pages: ExistingPage[];
    /** Step definitions the project's features can use (loaded ones). */
    steps: ExistingStepDef[];
    /** Other files the generator may extend (step files, data files, features): path → text. */
    files: Record<string, string>;
    config: {
        /** config/<project> exists. */
        exists: boolean;
        common: ConfigFile;
        envFile: ConfigFile;
        /** Resolved values for the environment (to find address keys). */
        values: Record<string, string>;
        /** STEP_DEFINITIONS_PATH: value and the file that sets it (null: not set, the framework default applies). */
        stepPath: { value: string; file: ConfigFile } | null;
        /** The steps folder is loaded by the framework already. */
        stepsLoaded: boolean;
    };
}

/** The model the checks need beyond what generators use. */
export interface ProjectModel extends ProjectContext {
    /** Every definition, including those in files the framework does not load (notLoaded). */
    allSteps: StepDef[];
    /** Step folders the framework loads for this project (repository paths). */
    loadedStepFolders: string[];
}

/** What the model is read with: the Studio's own readers (the same ones its screens use). */
export interface ModelDeps {
    repoRoot: string;
    featureFolder: (project: string) => string | null;
    configLayers: (project: string, env: string) => Array<{ source: string; label: string }>;
    readLayer: (source: string, label: string) => { values: Record<string, string> };
    /** Step folders (absolute) a STEP_DEFINITIONS_PATH value loads. */
    stepFolders: (configured: Array<{ project?: string; value: string }>) => string[];
    /** Step definitions for the project, as the framework loads them for it (all, notLoaded marked); also for a project not created yet. */
    stepDefs: (project: string) => StepDef[];
    /** Resolved configuration values of the project and environment. */
    values: (project: string, env: string) => Record<string, string>;
}

export function loadProjectModel(ts: typeof TS, d: ModelDeps, project: string, env: string): ProjectModel {
    const root = d.repoRoot;
    const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
    const read = (r: string): string | null => { try { return fs.readFileSync(path.join(root, r), 'utf8'); } catch { return null; } };
    const collect = (dir: string, ext: RegExp, depth: number, out: Record<string, string>, limit = 600) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (Object.keys(out).length >= limit) return;
            const r = `${dir}/${e.name}`;
            if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') collect(r, ext, depth - 1, out, limit);
            else if (e.isFile() && ext.test(e.name)) { const t = read(r); if (t !== null && t.length < 2_000_000) out[r] = t; }
        }
    };
    const exists = fs.existsSync(path.join(root, 'config', project));
    const featureFolder = d.featureFolder(project) ?? `test/${project}/features`;
    // The step folder: the project's own one from STEP_DEFINITIONS_PATH (the last file that sets it).
    let stepPath: ProjectContext['config']['stepPath'] = null;
    for (const l of d.configLayers(project, env)) {
        const layer = d.readLayer(l.source, l.label);
        if (layer.values.STEP_DEFINITIONS_PATH !== undefined) stepPath = { value: layer.values.STEP_DEFINITIONS_PATH, file: { path: l.source, text: read(l.source) } };
    }
    const loaded = d.stepFolders(stepPath ? [{ project, value: stepPath.value }] : []).map(rel);
    const stepsFolder = loaded.find((x) => x.startsWith(`test/${project}/`)) ?? `test/${project}/steps`;
    const pagesFolder = `${stepsFolder.split('/').slice(0, -1).join('/') || `test/${project}`}/pages`;
    // Page objects anywhere in test/<project>.
    const tsFiles: Record<string, string> = {};
    collect(`test/${project}`, /\.ts$/, 6, tsFiles, 2000);
    const pages = Object.entries(tsFiles).filter(([, t]) => /extends\s+CS(Base|Frame)Page/.test(t)).map(([f, t]) => parsePageObject(ts, t, f)).filter((x): x is ExistingPage => !!x);
    const files: Record<string, string> = {};
    // Step files, and the shared helpers of recorded steps (support/, beside the step folder).
    const supportFolder = `${stepsFolder.split('/').slice(0, -1).join('/') || `test/${project}`}/support`;
    for (const [f, t] of Object.entries(tsFiles)) if (f.startsWith(`${stepsFolder}/`) || f.startsWith(`${supportFolder}/`)) files[f] = t;
    collect(`test/${project}/data`, /\.json$/, 0, files);
    collect(featureFolder, /\.feature$/, 3, files);
    const allSteps = d.stepDefs(project);
    const steps = allSteps.filter((x) => !x.notLoaded).map((x) => ({ pattern: x.pattern, regex: x.regex, file: x.file, builtIn: x.builtIn }));
    const common = `config/${project}/common/common.env`, envFile = `config/${project}/environments/${env}.env`;
    // BASE_URL counts only when the project's own files set it (global.env often holds a template).
    const values = { ...d.values(project, env) };
    const ownBase = d.configLayers(project, env).some((l) => l.source.startsWith(`config/${project}/`) && d.readLayer(l.source, l.label).values.BASE_URL !== undefined);
    if (!ownBase || /[{}]/.test(values.BASE_URL ?? '')) delete values.BASE_URL;
    return {
        project, env, featureFolder, pagesFolder, stepsFolder, dataFolder: `test/${project}/data`, pages, steps, files, allSteps, loadedStepFolders: loaded,
        config: { exists, common: { path: common, text: read(common) }, envFile: { path: envFile, text: read(envFile) }, values, stepPath, stepsLoaded: !stepPath || loaded.includes(stepsFolder) },
    };
}
