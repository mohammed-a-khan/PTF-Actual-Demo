/**
 * "What to run", in the order people think about it:
 *   1. Features (files or whole folders). Nothing chosen: the project's features.
 *   2. Tags of those features (optional): runs scenarios having ANY of the chosen tags.
 *   3. Scenarios of those features (optional, narrowed by the chosen tags).
 * A summary line says what will run. The framework's own rules apply (see src/run/catalog.ts):
 * --tags is "any of", there is no "and/not" expression and no exclude option on the command line.
 */
import React from 'react';
import { Alert, Form, Select, Tooltip, Typography } from 'antd';
import { FileOutlined, FolderOutlined } from '@ant-design/icons';
import type { RunCatalog, CatalogFeature } from '../api';

export interface Picked { features: string[]; tags: string[]; scenarios: string[] }
export const EMPTY_PICK: Picked = { features: [], tags: [], scenarios: [] };

const DIR = 'dir:';
const scenKey = (f: CatalogFeature, i: number) => `${f.path}#${i}`;
const enabledOff = (tags: string[]) => tags.some((t) => /^@?enabled:\s*(false|no|0)$/i.test(t));

/** Feature files covered by the chosen tree keys (files and folders). */
function filesOf(keys: string[], all: CatalogFeature[]): CatalogFeature[] {
    if (!keys.length) return [];
    const dirs = keys.filter((k) => k.startsWith(DIR)).map((k) => k.slice(DIR.length) + '/');
    const files = new Set(keys.filter((k) => !k.startsWith(DIR)));
    return all.filter((f) => files.has(f.path) || dirs.some((d) => f.path.startsWith(d)));
}

/** The features the run is about: the chosen ones, else the project's folder, else all. */
export function scopeOf(p: Picked, cat: RunCatalog | null, project: string): { features: CatalogFeature[]; label: string } {
    const all = cat?.features ?? [];
    if (p.features.length) return { features: filesOf(p.features, all), label: 'the chosen features' };
    const folder = cat?.projectFolders[project];
    if (folder) return { features: all.filter((f) => f.path.startsWith(folder + '/')), label: `${folder}/` };
    return { features: all, label: 'the features in the project settings (FEATURE_PATH)' };
}

/** Scenarios that will run for this choice (tags: any of; then the chosen scenarios). */
export function selectedScenarios(p: Picked, scope: CatalogFeature[]) {
    const out: Array<{ f: CatalogFeature; i: number; examples: number }> = [];
    const chosen = new Set(p.scenarios);
    scope.forEach((f) => !f.parseError && f.scenarios.forEach((s, i) => {
        const tags = [...f.tags, ...s.tags];
        if (enabledOff(tags)) return;
        if (p.tags.length && !p.tags.some((t) => tags.includes(t))) return;
        if (chosen.size && !chosen.has(scenKey(f, i))) return;
        out.push({ f, i, examples: s.outline ? Math.max(1, s.examples) : 1 });
    }));
    return out;
}

/** The framework arguments for a choice. */
export function requestOf(p: Picked, cat: RunCatalog | null, project: string): { features?: string[]; tags?: string; scenarios?: string[] } {
    const all = cat?.features ?? [];
    const scope = scopeOf(p, cat, project).features;
    const features = p.features.map((k) => k.startsWith(DIR) ? k.slice(DIR.length) : k);
    if (p.scenarios.length) {
        const picked = selectedScenarios({ ...p, tags: [] }, scope);
        const names = [...new Set(picked.map((x) => x.f.scenarios[x.i].name))];
        // Only the files that hold them, so a same-named scenario elsewhere does not run too.
        const files = [...new Set(picked.map((x) => x.f.path))];
        return { features: files.length ? files : features, scenarios: names };
    }
    void all;
    return { ...(features.length ? { features } : {}), ...(p.tags.length ? { tags: p.tags.join(',') } : {}) };
}

/** A saved request back as the picker's choice (feature files, tags, scenarios by name within those files). */
export function pickOf(r: { features?: string[]; tags?: string; scenarios?: string[] }, cat: RunCatalog | null): Picked {
    const all = cat?.features ?? [];
    const features = (r.features ?? []).map((f) => (all.some((x) => x.path === f) ? f : `${DIR}${f}`));
    const tags = (r.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const names = new Set(r.scenarios ?? []);
    const inFiles = (f: CatalogFeature) => !r.features?.length || r.features.some((x) => f.path === x || f.path.startsWith(`${x.replace(/\/+$/, '')}/`));
    const scenarios = names.size ? all.filter(inFiles).flatMap((f) => f.scenarios.map((s, i) => (names.has(s.name) ? scenKey(f, i) : null)).filter((k): k is string => !!k)) : [];
    return { features, tags, scenarios };
}

interface FeatureOption { value: string; label: string; search: string; dir: boolean; count: number; name: string }

/**
 * Folders (all features in them) and feature files, as one flat list. A flat list renders only the
 * rows on screen, so it stays fast with thousands of features (a checkable tree re-processes every
 * node on each key press).
 */
function optionsOf(features: CatalogFeature[]): FeatureOption[] {
    const dirs = new Map<string, number>();
    for (const f of features) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); dirs.set(d, (dirs.get(d) ?? 0) + 1); }
    }
    const folders = [...dirs.entries()].filter(([, n]) => n > 1).sort((x, y) => x[0].localeCompare(y[0]))
        .map(([d, n]) => ({ value: DIR + d, label: `${d}/`, search: d.toLowerCase(), dir: true, count: n, name: '' }));
    const files = features.map((f) => ({ value: f.path, label: f.path.split('/').pop()!, search: `${f.path} ${f.name}`.toLowerCase(), dir: false, count: f.scenarios.length, name: f.name }));
    return [...folders, ...files];
}

export function RunPicker({ catalog, project, value, onChange }: { catalog: RunCatalog | null; project: string; value: Picked; onChange: (p: Picked) => void }) {
    const all = catalog?.features ?? [];
    // The project's own features (its folder, e.g. test/shop/…): another project's features run with the wrong settings.
    const projectRoot = (() => { const f = catalog?.projectFolders[project]; return f ? f.replace(/\/features$/, '') : null; })();
    // A feature that does not parse cannot run: it is not offered (the warning below names it).
    const featureOptions = React.useMemo(() => optionsOf((projectRoot ? all.filter((f) => f.path.startsWith(projectRoot + '/')) : all).filter((f) => !f.parseError)), [all, projectRoot]);
    const scope = scopeOf(value, catalog, project);
    // Tags of the features in scope, with how many scenarios each would run.
    const tagCounts = React.useMemo(() => {
        const m = new Map<string, number>();
        scope.features.forEach((f) => !f.parseError && f.scenarios.forEach((s) => {
            for (const t of new Set([...f.tags, ...s.tags])) if (!/^@?enabled:/i.test(t)) m.set(t, (m.get(t) ?? 0) + 1);
        }));
        return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }, [scope.features]);
    const tagged = selectedScenarios({ ...value, scenarios: [] }, scope.features);
    const willRun = selectedScenarios(value, scope.features);
    const examples = willRun.reduce((n, x) => n + x.examples, 0);
    const featureCount = new Set(willRun.map((x) => x.f.path)).size;

    // Drop tags/scenarios that no longer belong to the chosen features.
    React.useEffect(() => {
        const tags = value.tags.filter((t) => tagCounts.some(([k]) => k === t));
        const keys = new Set(scope.features.flatMap((f) => f.scenarios.map((_, i) => scenKey(f, i))));
        const scenarios = value.scenarios.filter((k) => keys.has(k));
        if (tags.length !== value.tags.length || scenarios.length !== value.scenarios.length) onChange({ ...value, tags, scenarios });
    }, [scope.features, tagCounts]); // eslint-disable-line react-hooks/exhaustive-deps

    const runnable = scope.features.filter((f) => !f.parseError).length;
    const defaultLabel = catalog?.projectFolders[project] ? `All features of ${project} (${runnable})` : `All features (${runnable})`;
    return (
        <>
            <Form.Item label="Features" style={{ marginBottom: 8 }}
                help={value.features.length ? undefined : <>Nothing chosen: runs {scope.label === 'the chosen features' ? '' : scope.label}</>}>
                <Select aria-label="Features" mode="multiple" allowClear showSearch value={value.features} onChange={(v) => onChange({ ...value, features: v })}
                    placeholder={defaultLabel} maxTagCount="responsive" options={featureOptions} optionFilterProp="search"
                    filterOption={(input, o) => !!o && (o as FeatureOption).search.includes(input.toLowerCase())}
                    popupMatchSelectWidth={460} listHeight={360} style={{ width: '100%' }}
                    optionRender={(o) => {
                        const f = o.data as FeatureOption;
                        return f.dir
                            ? <span className="pick-file"><FolderOutlined style={{ marginRight: 6, opacity: .6 }} />{f.label}<Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>all {f.count} features</Typography.Text></span>
                            : <span className="pick-file" title={f.value}><FileOutlined style={{ marginRight: 6, opacity: .6 }} />{f.label}<Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{f.name} · {f.value.slice(0, f.value.lastIndexOf('/'))}</Typography.Text></span>;
                    }} />
            </Form.Item>
            <Form.Item label={<>Tags <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>optional</Typography.Text></>} style={{ marginBottom: 8 }}
                help={value.tags.length > 1 ? 'Runs scenarios that have any of these tags.' : undefined}>
                <Select aria-label="Tags" mode="multiple" allowClear value={value.tags} onChange={(tags) => onChange({ ...value, tags })} maxTagCount="responsive"
                    placeholder={tagCounts.length ? `Any tag (${tagCounts.length} in these features)` : 'These features have no tags'} disabled={!tagCounts.length}
                    options={tagCounts.map(([t, n]) => ({ value: t, label: <span>{t} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{n}</Typography.Text></span>, search: t }))}
                    optionFilterProp="search" optionLabelProp="search" title="Scenarios with any of the chosen tags run (the framework selects by tag, not by tag expressions)" />
            </Form.Item>
            <Form.Item label={<>Scenarios <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>optional</Typography.Text></>} style={{ marginBottom: 8 }}>
                <Select aria-label="Scenarios" mode="multiple" allowClear value={value.scenarios} onChange={(scenarios) => onChange({ ...value, scenarios })} maxTagCount="responsive"
                    placeholder={`All ${tagged.length} scenario(s)${value.tags.length ? ' with these tags' : ''}`} disabled={!tagged.length}
                    popupMatchSelectWidth={460} optionFilterProp="search"
                    options={[...new Set(tagged.map((x) => x.f))].map((f) => ({
                        label: f.path.split('/').pop(),
                        options: tagged.filter((x) => x.f === f).map((x) => {
                            const s = f.scenarios[x.i];
                            const comma = s.name.includes(',');
                            return {
                                value: scenKey(f, x.i), disabled: comma, search: s.name.toLowerCase(), title: comma ? 'This name contains a comma, which the framework cannot select by name. Use a tag instead.' : s.name,
                                label: <Tooltip title={comma ? 'This name contains a comma, which the framework cannot select by name. Use a tag instead.' : undefined}>
                                    <span>{s.name}{s.outline && <Typography.Text type="secondary" style={{ fontSize: 12 }}> · outline, {s.examples} example(s)</Typography.Text>}</span>
                                </Tooltip>,
                            };
                        }),
                    }))} />
            </Form.Item>
            <Typography.Text type={willRun.length ? 'secondary' : 'warning'} style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
                {willRun.length
                    ? <>Will run <b>{willRun.length}</b> scenario{willRun.length === 1 ? '' : 's'}{examples > willRun.length ? ` (${examples} with all examples)` : ''} from <b>{featureCount}</b> feature{featureCount === 1 ? '' : 's'}.</>
                    : 'Nothing to run with this choice.'}
            </Typography.Text>
            {(() => {
                const broken = scope.features.filter((f) => f.parseError);
                return broken.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }}
                    message={`${broken.length} feature${broken.length === 1 ? '' : 's'} cannot be parsed and ${broken.length === 1 ? 'is' : 'are'} left out of the run`}
                    description={<ul style={{ margin: 0, paddingLeft: 18 }}>{broken.slice(0, 5).map((f) => <li key={f.path}><Typography.Text code>{f.path}</Typography.Text> {f.parseError}</li>)}{broken.length > 5 && <li>… and {broken.length - 5} more</li>}</ul>} />;
            })()}
        </>
    );
}
