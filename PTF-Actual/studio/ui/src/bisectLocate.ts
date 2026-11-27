/** "Which commit broke it?": the feature file of each failed scenario of a run (no browser code: tested on its own). */
/** A scenario's name as written in its feature file: a data-driven run's "…_Iteration-2" / "… (Example 2)" is the scenario itself. */
export const baseScenarioName = (n: string) => n.replace(/_Iteration-\d+$/, '').replace(/\s*\(Example \d+\)$/, '');

/**
 * The feature file of each failed scenario: from the run's evidence, else from the project's feature files (by
 * feature and scenario name; a copy of the feature in another folder: the one under test/<project>/).
 */
export function locateFailed(failed: Array<{ name: string; feature?: string; file?: string }>, project: string,
    evidence: Array<{ name: string; feature: string; location?: { file: string } }>, catalog: Array<{ path: string; name: string; scenarios: Array<{ name: string }> }>): Array<{ name: string; file?: string }> {
    const norm = (x: string) => x.trim().toLowerCase();
    const out = new Map<string, { name: string; file?: string }>();
    for (const f of failed) {
        const name = baseScenarioName(f.name);
        let file = f.file ?? evidence.find((e) => e.name === f.name && (!f.feature || e.feature === f.feature))?.location?.file;
        if (!file) {
            const hits = catalog.filter((c) => (!f.feature || norm(c.name) === norm(f.feature)) && c.scenarios.some((s) => norm(s.name) === norm(name))).map((c) => c.path);
            file = hits.find((p) => p.startsWith(`test/${project}/`)) ?? hits[0];
        }
        if (!out.has(name) || (!out.get(name)!.file && file)) out.set(name, { name, ...(file ? { file } : {}) });
    }
    return [...out.values()];
}

