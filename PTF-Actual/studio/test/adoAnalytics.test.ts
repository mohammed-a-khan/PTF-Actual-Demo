/**
 * Team test trends from Azure DevOps Analytics: the right host for each kind of organization URL, the filters
 * (quotes escaped), paging, every day of the period (gaps kept), failing / flaky / stable tests, the comparison with
 * the period before, and a summary sentence for people who do not read charts.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AdoClient } from '../src/ado/client';
import { classify, teamTrends, trendFilter, trendSummary } from '../src/ado/analytics';

const TODAY = new Date('2026-11-23T12:00:00Z');
const test1 = { TestName: 'Customer can sign in', ContainerName: 'qa.regression' };
const test2 = { TestName: "Order's total", ContainerName: 'orders.api' };
const test3 = { TestName: 'Search works', ContainerName: 'qa.regression' };

function fake(seen: string[]) {
    return async (req: { url: string; method: string; headers?: Record<string, string> }) => {
        seen.push(decodeURIComponent(req.url));
        const u = new URL(req.url);
        const apply = u.searchParams.get('$apply') ?? '';
        const json = (value: unknown[], next?: string) => ({ status: 200, body: JSON.stringify({ value, ...(next ? { '@odata.nextLink': next } : {}) }) });
        if (/groupby\(\(DateSK\)/.test(apply)) return json([
            { DateSK: 20261121, Total: 10, Passed: 6, Failed: 4, Flaky: 1, NotExecuted: 0, Duration: 12.5 },
            { DateSK: 20261123, Total: 10, Passed: 9, Failed: 1, Flaky: 0, NotExecuted: 0, Duration: 11 },
        ]);
        if (/ResultFailCount gt 0/.test(apply)) return json([{ Last: 20261123, Test: test2 }, { Last: 20261121, Test: test3 }]);
        if (/groupby\(\(Test\/TestName/.test(apply)) {
            // Two pages.
            if (!u.searchParams.get('page')) return json([{ Test: test1, Total: 6, Passed: 6, Failed: 0, Flaky: 0, NotExecuted: 0, Duration: 6 }], `${req.url}&page=2`);
            return json([{ Test: test2, Total: 4, Passed: 0, Failed: 4, Flaky: 0, NotExecuted: 0, Duration: 8 }, { Test: test3, Total: 10, Passed: 9, Failed: 1, Flaky: 1, NotExecuted: 0, Duration: 9.5 }]);
        }
        if (/\/aggregate\(/.test(apply)) return json([{ Total: 18, Passed: 17, Failed: 1, Flaky: 0, NotExecuted: 0, Duration: 20 }]);
        if (/groupby\(\(Pipeline/.test(apply)) return json([{ Pipeline: { PipelineName: 'QA regression' }, Branch: { BranchName: 'refs/heads/main' } }, { Pipeline: { PipelineName: null }, Branch: { BranchName: 'refs/heads/release/2.1' } }]);
        return { status: 404, body: '' };
    };
}

test('filters and the traffic light', () => {
    assert.equal(trendFilter({ days: 7, pipeline: "Bob's pipeline", branch: 'main', workflow: 'Build' }, 20261117, 20261123),
        "DateSK ge 20261117 and DateSK le 20261123 and Pipeline/PipelineName eq 'Bob''s pipeline' and Branch/BranchName eq 'refs/heads/main' and Workflow eq 'Build'");
    const t = (o: Partial<Parameters<typeof classify>[0]>) => classify({ name: 'x', container: 'c', total: 4, passed: 2, failed: 2, flaky: 0, notExecuted: 0, failRate: 0.5, avgSec: 1, ...o });
    assert.deepEqual([t({ failed: 0, failRate: 0, passed: 4 }), t({ passed: 0, failed: 4, failRate: 1 }), t({}), t({ failed: 0, failRate: 0, flaky: 1 })], ['stable', 'failing', 'flaky', 'flaky']);
    assert.equal(trendSummary({ totals: { total: 0, passed: 0, failed: 0, flaky: 0, notExecuted: 0, passRate: null }, previous: { passRate: null, total: 0 }, tests: [] }, 30).status, 'none');
    const g = trendSummary({ totals: { total: 100, passed: 99, failed: 1, flaky: 0, notExecuted: 0, passRate: 0.99 }, previous: { passRate: 0.99, total: 90 }, tests: [] }, 30);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, container: 'c', total: 2, passed: 0, failed: 2, flaky: 0, notExecuted: 0, failRate: 1, avgSec: 1, kind: 'failing' as const }));
    assert.match(trendSummary({ totals: { total: 6, passed: 0, failed: 6, flaky: 0, notExecuted: 0, passRate: 0 }, previous: { passRate: null, total: 0 }, tests: many(3) }, 30).summary, /3 tests fail every time they run: likely real problems or outdated tests\./);
    assert.deepEqual(g, { status: 'green', summary: '99% of 100 test results passed in the last 30 days, about the same as the period before.' });
});

test('team trends through the client: host, days, tests, comparison, summary', async () => {
    const seen: string[] = [];
    const c = new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'QA Team', pat: 'p', transport: fake(seen) } as ConstructorParameters<typeof AdoClient>[0]);
    const r = await teamTrends(c, { days: 3, today: TODAY, pipeline: 'QA regression' });
    assert.ok(seen.every((u) => u.startsWith('https://analytics.dev.azure.com/acme/QA Team/_odata/v4.0-preview/TestResultsDaily?')), seen[0]);
    assert.ok(seen.some((u) => u.includes("DateSK ge 20261121 and DateSK le 20261123 and Pipeline/PipelineName eq 'QA regression'")));
    assert.ok(seen.some((u) => u.includes('DateSK ge 20261118 and DateSK le 20261120')), 'the period before');
    assert.deepEqual(r.days.map((d) => [d.date, d.total, d.passRate]), [['2026-11-21', 10, 0.6], ['2026-11-22', 0, null], ['2026-11-23', 10, 0.9]]);
    assert.deepEqual(r.totals, { total: 20, passed: 15, failed: 5, flaky: 1, notExecuted: 0, passRate: 0.75 });
    assert.deepEqual(r.tests.map((t) => [t.name, t.kind, t.lastFailed ?? null]), [["Order's total", 'failing', '2026-11-23'], ['Search works', 'flaky', '2026-11-21'], ['Customer can sign in', 'stable', null]]);
    assert.equal(r.status, 'red');
    assert.equal(r.summary, "75% of 20 test results passed in the last 3 days, down from 94.4% the period before. 1 test fails every time it runs: likely a real problem or an outdated test. 1 test is flaky (pass and fail on the same code): it makes results less trustworthy.");
    assert.deepEqual(r.options, { pipelines: ['QA regression'], branches: ['main', 'release/2.1'] });
});

test('other hosts, and what a refusal says', async () => {
    const urls: string[] = [];
    const ok = async (req: { url: string }) => { urls.push(req.url); return { status: 200, body: '{"value":[]}' }; };
    await new AdoClient({ orgUrl: 'https://acme.visualstudio.com', project: 'qa', pat: 'p', transport: ok } as ConstructorParameters<typeof AdoClient>[0]).odata('TestRuns');
    await new AdoClient({ orgUrl: 'https://ado.bank.local/tfs/DefaultCollection', project: 'qa', pat: 'p', transport: ok } as ConstructorParameters<typeof AdoClient>[0]).odata('TestRuns');
    assert.deepEqual(urls, ['https://acme.analytics.visualstudio.com/qa/_odata/v4.0-preview/TestRuns', 'https://ado.bank.local/tfs/DefaultCollection/qa/_odata/v4.0-preview/TestRuns']);
    const refuse = (status: number) => new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'qa', pat: 'p', transport: async () => ({ status, body: '' }) } as ConstructorParameters<typeof AdoClient>[0]);
    await assert.rejects(refuse(403).odata('TestRuns'), /"Analytics \(Read\)" scope/);
    await assert.rejects(refuse(404).odata('TestRuns'), /Analytics is not available/);
});
