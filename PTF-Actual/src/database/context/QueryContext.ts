// src/database/context/QueryContext.ts

import { QueryResult } from '../types/database.types';
import { CSReporter } from '../../reporter/CSReporter';

export class QueryContext {
    private queryId: string;
    private startTime: Date;
    private endTime?: Date;
    private parameters: Map<string, any> = new Map();
    private metadata: Map<string, any> = new Map();
    private result?: QueryResult;
    private error?: Error;
    private warnings: string[] = [];
    private affectedTables: Set<string> = new Set();
    private usedIndexes: Set<string> = new Set();
    private executionPlan?: any;
    private statistics: QueryStatistics = {
        rowsRead: 0,
        rowsWritten: 0,
        bytesRead: 0,
        bytesWritten: 0,
        cpuTime: 0,
        ioTime: 0
    };

    constructor(queryId: string) {
        this.queryId = queryId;
        this.startTime = new Date();
    }

    getId(): string {
        return this.queryId;
    }

    setParameter(name: string, value: any): void {
        this.parameters.set(name, value);
    }

    getParameter(name: string): any {
        return this.parameters.get(name);
    }

    getParameters(): Record<string, any> {
        return Object.fromEntries(this.parameters);
    }

    setMetadata(key: string, value: any): void {
        this.metadata.set(key, value);
    }

    getMetadata(key: string): any {
        return this.metadata.get(key);
    }

    setResult(result: QueryResult): void {
        this.result = result;
        this.endTime = new Date();
        
        if (result.rowCount !== undefined) {
            this.statistics.rowsRead = result.rowCount;
        }
    }

    getResult(): QueryResult | undefined {
        return this.result;
    }

    setError(error: Error): void {
        this.error = error;
        this.endTime = new Date();
    }

    getError(): Error | undefined {
        return this.error;
    }

    addWarning(warning: string): void {
        this.warnings.push(warning);
        CSReporter.warn(`Query ${this.queryId} warning: ${warning}`);
    }

    getWarnings(): string[] {
        return [...this.warnings];
    }

    addAffectedTable(tableName: string): void {
        this.affectedTables.add(tableName);
    }

    getAffectedTables(): string[] {
        return Array.from(this.affectedTables);
    }

    addUsedIndex(indexName: string): void {
        this.usedIndexes.add(indexName);
    }

    getUsedIndexes(): string[] {
        return Array.from(this.usedIndexes);
    }

    setExecutionPlan(plan: any): void {
        this.executionPlan = plan;
    }

    getExecutionPlan(): any {
        return this.executionPlan;
    }

    updateStatistics(stats: Partial<QueryStatistics>): void {
        Object.assign(this.statistics, stats);
    }

    getStatistics(): QueryStatistics {
        return { ...this.statistics };
    }

    getDuration(): number {
        if (!this.endTime) {
            return Date.now() - this.startTime.getTime();
        }
        return this.endTime.getTime() - this.startTime.getTime();
    }

    isComplete(): boolean {
        return this.endTime !== undefined;
    }

    isSuccess(): boolean {
        return this.isComplete() && !this.error;
    }

    getExecutionSummary(): QueryExecutionSummary {
        const summary: QueryExecutionSummary = {
            queryId: this.queryId,
            startTime: this.startTime,
            duration: this.getDuration(),
            success: this.isSuccess(),
            warnings: [...this.warnings],
            affectedTables: this.getAffectedTables(),
            usedIndexes: this.getUsedIndexes(),
            statistics: this.getStatistics(),
            parameters: this.getParameters(),
            metadata: Object.fromEntries(this.metadata)
        };

        if (this.endTime) {
            summary.endTime = this.endTime;
        }
        if (this.error) {
            summary.error = this.error.message;
        }
        if (this.result?.rowCount !== undefined) {
            summary.rowCount = this.result.rowCount;
        }

        return summary;
    }

    generatePerformanceReport(): string {
        const summary = this.getExecutionSummary();
        const lines: string[] = [
            `Query Performance Report`,
            `=======================`,
            `Query ID: ${summary.queryId}`,
            `Duration: ${summary.duration}ms`,
            `Status: ${summary.success ? 'Success' : 'Failed'}`,
            ``
        ];

        if (summary.error) {
            lines.push(`Error: ${summary.error}`, '');
        }

        if (summary.rowCount !== undefined) {
            lines.push(`Rows Returned: ${summary.rowCount}`);
        }

        if (summary.statistics.rowsRead > 0 || summary.statistics.rowsWritten > 0) {
            lines.push(
                ``,
                `I/O Statistics:`,
                `  Rows Read: ${summary.statistics.rowsRead}`,
                `  Rows Written: ${summary.statistics.rowsWritten}`,
                `  Bytes Read: ${this.formatBytes(summary.statistics.bytesRead)}`,
                `  Bytes Written: ${this.formatBytes(summary.statistics.bytesWritten)}`
            );
        }

        if (summary.statistics.cpuTime > 0 || summary.statistics.ioTime > 0) {
            lines.push(
                ``,
                `Time Statistics:`,
                `  CPU Time: ${summary.statistics.cpuTime}ms`,
                `  I/O Time: ${summary.statistics.ioTime}ms`
            );
        }

        if (summary.affectedTables.length > 0) {
            lines.push(
                ``,
                `Affected Tables:`,
                ...summary.affectedTables.map(t => `  - ${t}`)
            );
        }

        if (summary.usedIndexes.length > 0) {
            lines.push(
                ``,
                `Used Indexes:`,
                ...summary.usedIndexes.map(i => `  - ${i}`)
            );
        }

        if (summary.warnings.length > 0) {
            lines.push(
                ``,
                `Warnings:`,
                ...summary.warnings.map(w => `  - ${w}`)
            );
        }

        if (this.executionPlan) {
            lines.push(
                ``,
                `Execution Plan Available: Yes`
            );
        }

        return lines.join('\n');
    }

    clone(): QueryContext {
        const cloned = new QueryContext(`${this.queryId}_clone`);
        
        cloned.startTime = new Date(this.startTime);
        if (this.endTime) {
            cloned.endTime = new Date(this.endTime);
        }
        cloned.parameters = new Map(this.parameters);
        cloned.metadata = new Map(this.metadata);
        if (this.result) {
            cloned.result = this.result;
        }
        if (this.error) {
            cloned.error = this.error;
        }
        cloned.warnings = [...this.warnings];
        cloned.affectedTables = new Set(this.affectedTables);
        cloned.usedIndexes = new Set(this.usedIndexes);
        cloned.executionPlan = this.executionPlan;
        cloned.statistics = { ...this.statistics };
        
        return cloned;
    }


    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
    }
}


interface QueryStatistics {
    rowsRead: number;
    rowsWritten: number;
    bytesRead: number;
    bytesWritten: number;
    cpuTime: number;
    ioTime: number;
}

interface QueryExecutionSummary {
    queryId: string;
    startTime: Date;
    endTime?: Date;
    duration: number;
    success: boolean;
    error?: string;
    rowCount?: number;
    warnings: string[];
    affectedTables: string[];
    usedIndexes: string[];
    statistics: QueryStatistics;
    parameters: Record<string, any>;
    metadata: Record<string, any>;
}
