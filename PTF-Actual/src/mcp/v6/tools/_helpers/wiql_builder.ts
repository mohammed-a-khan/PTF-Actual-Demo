/**
 * Parameterized WIQL query builder.
 *
 * ADO's Work Item Query Language (WIQL) has no server-side parameterization —
 * you build the query as a single string and POST it. That makes user-supplied
 * values (tag names, area paths, work-item titles) an injection risk: a
 * closing apostrophe in the value ends the literal early and lets the rest of
 * the value inject clauses.
 *
 * This builder auto-escapes every value that flows through it. Apostrophes are
 * doubled per T-SQL / WIQL escaping rules (`O'Brien` -> `O''Brien`). Values
 * are always wrapped in single quotes; field names never are.
 *
 * Not opinionated about ADO WI schema — pass whatever field name ADO expects.
 *
 * Example:
 *
 *   new WiqlQuery()
 *     .select(['[System.Id]', '[System.Title]'])
 *     .from('WorkItems')
 *     .where().equals('[System.WorkItemType]', 'Test Case')
 *     .and().tag('smoke')
 *     .and().iteration('current')
 *     .orderBy('[System.Id]', 'ASC')
 *     .build()
 */

type Order = 'ASC' | 'DESC';

function escapeString(v: string): string {
    // Double the apostrophes. Do NOT strip / re-encode anything else — WIQL
    // string literals only special-case '.
    return v.replace(/'/g, "''");
}

function quote(v: string | number | boolean | Date): string {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : "''";
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Date) return `'${v.toISOString()}'`;
    return `'${escapeString(String(v))}'`;
}

export class WiqlClauseBuilder {
    private readonly parts: string[] = [];
    private readonly parent: WiqlQuery;

    constructor(parent: WiqlQuery) {
        this.parent = parent;
    }

    public equals(field: string, value: string | number | boolean | Date): WiqlClauseChain {
        this.parts.push(`${field} = ${quote(value)}`);
        return this.chain();
    }

    public notEquals(field: string, value: string | number | boolean | Date): WiqlClauseChain {
        this.parts.push(`${field} <> ${quote(value)}`);
        return this.chain();
    }

    public in(field: string, values: Array<string | number>): WiqlClauseChain {
        if (values.length === 0) {
            // Empty IN clause is invalid WIQL — emit a self-false predicate instead so
            // callers get an empty result set rather than a syntax error.
            this.parts.push(`(1 = 0)`);
            return this.chain();
        }
        const list = values.map((v) => quote(v)).join(', ');
        this.parts.push(`${field} IN (${list})`);
        return this.chain();
    }

    public contains(field: string, value: string): WiqlClauseChain {
        // WIQL uses `CONTAINS` for text fields and `CONTAINS WORDS` for full-text
        // indexed fields; CONTAINS is the safer default.
        this.parts.push(`${field} CONTAINS ${quote(value)}`);
        return this.chain();
    }

    public containsWords(field: string, value: string): WiqlClauseChain {
        this.parts.push(`${field} CONTAINS WORDS ${quote(value)}`);
        return this.chain();
    }

    public between(field: string, lo: string | number | Date, hi: string | number | Date): WiqlClauseChain {
        this.parts.push(`${field} >= ${quote(lo)} AND ${field} <= ${quote(hi)}`);
        return this.chain();
    }

    public tag(name: string): WiqlClauseChain {
        // ADO tags query: [System.Tags] CONTAINS 'name'
        this.parts.push(`[System.Tags] CONTAINS ${quote(name)}`);
        return this.chain();
    }

    public iteration(value: 'current' | string): WiqlClauseChain {
        if (value === 'current') {
            this.parts.push(`[System.IterationPath] = @CurrentIteration`);
        } else {
            this.parts.push(`[System.IterationPath] UNDER ${quote(value)}`);
        }
        return this.chain();
    }

    public areaPathUnder(path: string): WiqlClauseChain {
        this.parts.push(`[System.AreaPath] UNDER ${quote(path)}`);
        return this.chain();
    }

    public raw(clause: string): WiqlClauseChain {
        // Escape hatch for edge cases. Callers using this take responsibility for
        // escaping. Marked explicitly so grep can find every use.
        this.parts.push(`(${clause})`);
        return this.chain();
    }

    public toString(): string {
        return this.parts.join(' ');
    }

    private chain(): WiqlClauseChain {
        return {
            and: () => {
                this.parts.push('AND');
                return this;
            },
            or: () => {
                this.parts.push('OR');
                return this;
            },
            done: () => this.parent,
        };
    }
}

export interface WiqlClauseChain {
    and(): WiqlClauseBuilder;
    or(): WiqlClauseBuilder;
    done(): WiqlQuery;
}

export class WiqlQuery {
    private fields: string[] = ['[System.Id]'];
    private table = 'WorkItems';
    private whereBuilder: WiqlClauseBuilder | null = null;
    private orderByField: string | null = null;
    private orderByDir: Order = 'ASC';
    private limitN: number | null = null;

    public select(fields: string[]): WiqlQuery {
        if (fields.length === 0) throw new Error('WIQL SELECT requires at least one field');
        // Wrap unbracketed field names for safety.
        this.fields = fields.map((f) => f.startsWith('[') ? f : `[${f}]`);
        return this;
    }

    public from(table: 'WorkItems' | 'WorkItemLinks'): WiqlQuery {
        this.table = table;
        return this;
    }

    public where(): WiqlClauseBuilder {
        if (!this.whereBuilder) this.whereBuilder = new WiqlClauseBuilder(this);
        return this.whereBuilder;
    }

    public orderBy(field: string, dir: Order = 'ASC'): WiqlQuery {
        this.orderByField = field.startsWith('[') ? field : `[${field}]`;
        this.orderByDir = dir;
        return this;
    }

    public limit(n: number): WiqlQuery {
        if (n <= 0) throw new Error('WIQL LIMIT must be positive');
        this.limitN = Math.floor(n);
        return this;
    }

    public build(): string {
        const parts: string[] = [`SELECT ${this.fields.join(', ')}`, `FROM ${this.table}`];
        if (this.whereBuilder) {
            const clause = this.whereBuilder.toString().trim();
            if (clause.length > 0) parts.push(`WHERE ${clause}`);
        }
        if (this.orderByField) parts.push(`ORDER BY ${this.orderByField} ${this.orderByDir}`);
        // WIQL has no LIMIT keyword; we use ASOF? No — ADO clamps at 20000 by default.
        // For a real cap, callers should paginate or use the top param on the REST call.
        // We stash limit as a hint that consumers can pass to POST /wiql?$top=N.
        return parts.join(' ');
    }

    /** For POST /_apis/wit/wiql?$top=N — surface the requested limit. */
    public getLimit(): number | null {
        return this.limitN;
    }
}

/** Convenience — build a WIQL from scratch. */
export function wiql(): WiqlQuery {
    return new WiqlQuery();
}
