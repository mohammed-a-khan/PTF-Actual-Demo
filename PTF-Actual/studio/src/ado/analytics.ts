/**
 * Test trends of the whole team, from Azure DevOps Analytics: every test result published by any pipeline (or by
 * hand), not only the runs on this computer. Daily pass rate, the tests that fail most, flaky ones (Azure DevOps'
 * own flaky detection, and tests that both pass and fail in the period), compared with the period before.
 */
export interface OData { odata<T>(entityAndQuery: string, maxPages?: number): Promise<T[]> }

export interface TrendFilter { days: number; pipeline?: string; branch?: string; workflow?: 'Build' | 'Release'; container?: string; today?: Date }
export interface TrendDay { date: string; total: number; passed: number; failed: number; notExecuted: number; flaky: number; passRate: number | null; durationSec: number }
export interface TrendTest {
    name: string; container: string; total: number; passed: number; failed: number; flaky: number; notExecuted: number;
    failRate: number; avgSec: number; lastFailed?: string;
    kind: 'failing' | 'flaky' | 'stable';
}
export interface TeamTrends {
    from: string; to: string; days: TrendDay[];
    totals: { total: number; passed: number; failed: number; flaky: number; notExecuted: number; passRate: number | null };
    previous: { passRate: number | null; total: number };
    tests: TrendTest[];
    status: 'green' | 'amber' | 'red' | 'none';
    summary: string;
    options: { pipelines: string[]; branches: string[] };
}

const sk = (d: Date) => Number(d.toISOString().slice(0, 10).replace(/-/g, ''));
const iso = (n: number) => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 1000) / 10}%`);
const AGG = 'ResultCount with sum as Total,ResultPassCount with sum as Passed,ResultFailCount with sum as Failed,ResultFlakyCount with sum as Flaky,ResultNotExecutedCount with sum as NotExecuted,ResultDurationSeconds with sum as Duration';
type Agg = { Total: number; Passed: number; Failed: number; Flaky: number; NotExecuted: number; Duration: number };

/** The OData filter for a period (dates as DateSK numbers) and the chosen pipeline / branch / kind / suite. */
export function trendFilter(f: TrendFilter, from: number, to: number): string {
    const parts = [`DateSK ge ${from}`, `DateSK le ${to}`];
    if (f.pipeline) parts.push(`Pipeline/PipelineName eq ${lit(f.pipeline)}`);
    if (f.branch) parts.push(`Branch/BranchName eq ${lit(f.branch.startsWith('refs/') ? f.branch : `refs/heads/${f.branch}`)}`);
    if (f.workflow) parts.push(`Workflow eq ${lit(f.workflow)}`);
    if (f.container) parts.push(`Test/ContainerName eq ${lit(f.container)}`);
    return parts.join(' and ');
}

export function periodOf(f: TrendFilter): { from: number; to: number; prevFrom: number; prevTo: number } {
    const days = Math.max(1, Math.min(180, Math.round(f.days)));
    const today = f.today ?? new Date();
    const day = (offset: number) => sk(new Date(today.getTime() - offset * 86400_000));
    return { from: day(days - 1), to: day(0), prevFrom: day(2 * days - 1), prevTo: day(days) };
}

export function classify(t: Omit<TrendTest, 'kind'>): TrendTest['kind'] {
    if (!t.failed && !t.flaky) return 'stable';
    if (t.flaky > 0) return 'flaky';
    const ran = t.passed + t.failed;
    return ran > 0 && t.passed === 0 ? 'failing' : t.failRate >= 0.9 ? 'failing' : 'flaky';
}

/** One sentence for people who do not read charts, and a traffic light. */
export function trendSummary(t: Pick<TeamTrends, 'totals' | 'previous' | 'tests'>, days: number): { status: TeamTrends['status']; summary: string } {
    if (!t.totals.total) return { status: 'none', summary: `No test results were published to Azure DevOps in the last ${days} days for this choice.` };
    const rate = t.totals.passRate ?? 0;
    const failing = t.tests.filter((x) => x.kind === 'failing').length, flaky = t.tests.filter((x) => x.kind === 'flaky').length;
    const change = t.previous.passRate === null ? '' : Math.abs(rate - t.previous.passRate) < 0.01 ? ', about the same as the period before'
        : rate > t.previous.passRate ? `, up from ${pct(t.previous.passRate)} the period before` : `, down from ${pct(t.previous.passRate)} the period before`;
    const status = rate >= 0.95 && !failing ? 'green' : rate >= 0.8 ? 'amber' : 'red';
    const parts = [`${pct(rate)} of ${t.totals.total} test results passed in the last ${days} days${change}.`];
    if (failing) parts.push(failing === 1 ? '1 test fails every time it runs: likely a real problem or an outdated test.' : `${failing} tests fail every time they run: likely real problems or outdated tests.`);
    if (flaky) parts.push(`${flaky} test${flaky === 1 ? ' is' : 's are'} flaky (pass and fail on the same code): ${flaky === 1 ? 'it makes' : 'they make'} results less trustworthy.`);
    return { status, summary: parts.join(' ') };
}

export async function teamTrends(c: OData, f: TrendFilter): Promise<TeamTrends> {
    const p = periodOf(f);
    const filter = trendFilter(f, p.from, p.to);
    const q = (apply: string) => `TestResultsDaily?$apply=${encodeURIComponent(apply)}`;
    const [daily, tests, lastFails, prev, opts] = await Promise.all([
        c.odata<Agg & { DateSK: number }>(q(`filter(${filter})/groupby((DateSK),aggregate(${AGG}))`)),
        c.odata<Agg & { Test: { TestName: string; ContainerName: string } }>(q(`filter(${filter})/groupby((Test/TestName,Test/ContainerName),aggregate(${AGG}))`), 20),
        c.odata<{ Last: number; Test: { TestName: string; ContainerName: string } }>(q(`filter(${filter} and ResultFailCount gt 0)/groupby((Test/TestName,Test/ContainerName),aggregate(DateSK with max as Last))`), 20),
        c.odata<Agg>(q(`filter(${trendFilter(f, p.prevFrom, p.prevTo)})/aggregate(${AGG})`)),
        c.odata<{ Pipeline?: { PipelineName: string | null }; Branch?: { BranchName: string | null } }>(q(`filter(DateSK ge ${p.prevFrom})/groupby((Pipeline/PipelineName,Branch/BranchName))`)),
    ]);
    const byDay = new Map(daily.map((d) => [d.DateSK, d]));
    const days: TrendDay[] = [];
    for (let t = Date.parse(iso(p.from)); t <= Date.parse(iso(p.to)); t += 86400_000) {
        const n = sk(new Date(t)), d = byDay.get(n);
        const total = d?.Total ?? 0, passed = d?.Passed ?? 0, failed = d?.Failed ?? 0;
        days.push({ date: iso(n), total, passed, failed, notExecuted: d?.NotExecuted ?? 0, flaky: d?.Flaky ?? 0, passRate: passed + failed ? passed / (passed + failed) : null, durationSec: Math.round((d?.Duration ?? 0) * 10) / 10 });
    }
    const sum = (k: keyof Agg) => daily.reduce((a, d) => a + (d[k] ?? 0), 0);
    const totals = { total: sum('Total'), passed: sum('Passed'), failed: sum('Failed'), flaky: sum('Flaky'), notExecuted: sum('NotExecuted'), passRate: null as number | null };
    totals.passRate = totals.passed + totals.failed ? totals.passed / (totals.passed + totals.failed) : null;
    const pv = prev[0];
    const previous = { total: pv?.Total ?? 0, passRate: pv && pv.Passed + pv.Failed ? pv.Passed / (pv.Passed + pv.Failed) : null };
    const key = (t: { TestName: string; ContainerName: string }) => `${t.ContainerName}\u0000${t.TestName}`;
    const last = new Map(lastFails.map((x) => [key(x.Test), x.Last]));
    const list: TrendTest[] = tests.map((t) => {
        const ran = t.Passed + t.Failed;
        const base = { name: t.Test.TestName, container: t.Test.ContainerName, total: t.Total, passed: t.Passed, failed: t.Failed, flaky: t.Flaky, notExecuted: t.NotExecuted,
            failRate: ran ? t.Failed / ran : 0, avgSec: t.Total ? Math.round((t.Duration / t.Total) * 100) / 100 : 0, ...(last.has(key(t.Test)) ? { lastFailed: iso(last.get(key(t.Test))!) } : {}) };
        return { ...base, kind: classify(base) };
    });
    const order = { failing: 0, flaky: 1, stable: 2 };
    list.sort((a, b) => order[a.kind] - order[b.kind] || b.failed - a.failed || b.flaky - a.flaky || a.name.localeCompare(b.name));
    const result = { totals, previous, tests: list };
    const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
    return {
        from: iso(p.from), to: iso(p.to), days, ...result, ...trendSummary(result, Math.round(f.days)),
        options: { pipelines: uniq(opts.map((o) => o.Pipeline?.PipelineName)), branches: uniq(opts.map((o) => o.Branch?.BranchName?.replace(/^refs\/heads\//, ''))) },
    };
}
