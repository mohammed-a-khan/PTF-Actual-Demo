// src/steps/database/StoredProcedureSteps.ts

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { DatabaseContext } from '../../database/context/DatabaseContext';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { StoredProcedureCall, ProcedureParameter, QueryResult, StoredProcedureMetadata } from '../../database/types/database.types';

export class StoredProcedureSteps {
    private databaseContext: DatabaseContext = new DatabaseContext();
    private configManager: CSConfigurationManager;
    private contextVariables: Map<string, any> = new Map();
    private lastOutputParameters: Record<string, any> = {};
    private lastResultSets: QueryResult[] = [];
    private lastReturnValue: any;

    constructor() {
        this.configManager = CSConfigurationManager.getInstance();
    }

    @CSBDDStepDef('user executes stored procedure {string}')
    async executeStoredProcedure(procedureName: string): Promise<void> {
        CSReporter.info(`Executing stored procedure: ${procedureName}`);

        try {
            const interpolatedName = this.interpolateVariables(procedureName);

            const startTime = Date.now();
            const adapter = this.databaseContext.getActiveAdapter();
            const connection = this.getActiveConnection();
            const queryResult = await adapter.executeStoredProcedure(connection, interpolatedName);
            const executionTime = Date.now() - startTime;

            const result: StoredProcedureCall = {
                resultSets: [queryResult],
                outputParameters: {},
                returnValue: undefined
            };

            this.handleProcedureResult(result, interpolatedName, executionTime);

            CSReporter.info(`Stored procedure '${interpolatedName}' executed successfully. Rows: ${queryResult.rowCount}, Time: ${executionTime}ms`);

        } catch (error) {
            CSReporter.error(`Failed to execute stored procedure '${procedureName}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute stored procedure '${procedureName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user executes stored procedure {string} with parameters:')
    async executeStoredProcedureWithParams(procedureName: string, dataTable: any): Promise<void> {
        CSReporter.info(`Executing stored procedure '${procedureName}' with parameters`);

        try {
            const interpolatedName = this.interpolateVariables(procedureName);
            const parameters = this.parseProcedureParameters(dataTable);

            const startTime = Date.now();
            const adapter = this.databaseContext.getActiveAdapter();
            const connection = this.getActiveConnection();
            const paramArray = parameters.map(p => p.value);
            const queryResult = await adapter.executeStoredProcedure(connection, interpolatedName, paramArray);
            const executionTime = Date.now() - startTime;

            const result: StoredProcedureCall = {
                resultSets: [queryResult],
                outputParameters: this.extractOutputParameters(parameters, paramArray),
                returnValue: undefined
            };

            this.handleProcedureResult(result, interpolatedName, executionTime);

            CSReporter.info(`Stored procedure '${interpolatedName}' executed with ${parameters.length} parameters. Rows: ${queryResult.rowCount}, Time: ${executionTime}ms`);

        } catch (error) {
            CSReporter.error(`Failed to execute stored procedure with parameters: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute stored procedure with parameters: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user calls function {string} and stores result as {string}')
    async executeFunctionAndStore(functionName: string, alias: string): Promise<void> {
        CSReporter.info(`Calling function '${functionName}' and storing result as '${alias}'`);

        try {
            const interpolatedName = this.interpolateVariables(functionName);

            const adapter = this.databaseContext.getActiveAdapter();
            const connection = this.getActiveConnection();
            const result = await adapter.executeFunction(connection, interpolatedName);

            this.contextVariables.set(alias, result);
            this.lastReturnValue = result;

            CSReporter.info(`Function '${interpolatedName}' executed and result stored as '${alias}': ${result}`);

        } catch (error) {
            CSReporter.error(`Failed to execute function '${functionName}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute function '${functionName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user calls function {string} with parameters:')
    async executeFunctionWithParams(functionName: string, dataTable: any): Promise<void> {
        CSReporter.info(`Calling function '${functionName}' with parameters`);

        try {
            const interpolatedName = this.interpolateVariables(functionName);
            const parameters = this.parseFunctionParameters(dataTable);

            const adapter = this.databaseContext.getActiveAdapter();
            const connection = this.getActiveConnection();
            const result = await adapter.executeFunction(connection, interpolatedName, parameters);

            this.lastReturnValue = result;

            CSReporter.info(`Function '${interpolatedName}' executed with ${parameters.length} parameters. Result: ${result}`);

        } catch (error) {
            CSReporter.error(`Failed to execute function with parameters: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute function with parameters: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the output parameter {string} should be {string}')
    async validateOutputParameter(parameterName: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Validating output parameter '${parameterName}' should be '${expectedValue}'`);

        const outputParams = this.lastOutputParameters;
        if (!outputParams || Object.keys(outputParams).length === 0) {
            throw new Error('No output parameters available. Execute a stored procedure first');
        }

        const interpolatedExpected = this.interpolateVariables(expectedValue);
        const actualValue = outputParams[parameterName];

        if (actualValue === undefined) {
            const available = Object.keys(outputParams).join(', ');
            throw new Error(
                `Output parameter '${parameterName}' not found. ` +
                `Available parameters: ${available}`
            );
        }

        const convertedExpected = this.convertParameterValue(interpolatedExpected);

        if (!this.valuesEqual(actualValue, convertedExpected)) {
            throw new Error(
                `Output parameter mismatch for '${parameterName}'\n` +
                `Expected: ${interpolatedExpected} (${typeof convertedExpected})\n` +
                `Actual: ${actualValue} (${typeof actualValue})`
            );
        }

        CSReporter.info(`Output parameter validation passed: '${parameterName}' = '${actualValue}'`);
    }

    @CSBDDStepDef('user stores output parameter {string} as {string}')
    async storeOutputParameter(parameterName: string, variableName: string): Promise<void> {
        CSReporter.info(`Storing output parameter '${parameterName}' as variable '${variableName}'`);

        const outputParams = this.lastOutputParameters;
        if (!outputParams || Object.keys(outputParams).length === 0) {
            throw new Error('No output parameters available. Execute a stored procedure first');
        }

        const value = outputParams[parameterName];
        if (value === undefined) {
            const available = Object.keys(outputParams).join(', ');
            throw new Error(
                `Output parameter '${parameterName}' not found. ` +
                `Available parameters: ${available}`
            );
        }

        this.contextVariables.set(variableName, value);

        CSReporter.info(`Output parameter '${parameterName}' stored as '${variableName}': ${value} (${typeof value})`);
    }

    @CSBDDStepDef('the stored procedure should return {int} result sets')
    async validateResultSetCount(expectedCount: number): Promise<void> {
        CSReporter.info(`Validating stored procedure returns ${expectedCount} result sets`);

        const resultSets = this.lastResultSets;
        if (!resultSets || resultSets.length === 0) {
            throw new Error('No result sets available. Execute a stored procedure first');
        }

        const actualCount = resultSets.length;
        if (actualCount !== expectedCount) {
            throw new Error(
                `Result set count mismatch\n` +
                `Expected: ${expectedCount}\n` +
                `Actual: ${actualCount}`
            );
        }

        CSReporter.info(`Result set count validation passed: ${actualCount} result sets`);
    }

    @CSBDDStepDef('user selects result set {int}')
    async selectResultSet(resultSetIndex: number): Promise<void> {
        CSReporter.info(`Selecting result set ${resultSetIndex}`);

        const resultSets = this.lastResultSets;
        if (!resultSets || resultSets.length === 0) {
            throw new Error('No result sets available. Execute a stored procedure first');
        }

        const index = resultSetIndex - 1;
        if (index < 0 || index >= resultSets.length) {
            throw new Error(
                `Result set index ${resultSetIndex} out of bounds. ` +
                `Available: 1-${resultSets.length}`
            );
        }

        const selectedResultSet = resultSets[index];
        if (selectedResultSet) {
            this.databaseContext.storeResult('last', selectedResultSet);

            CSReporter.info(`Result set ${resultSetIndex} selected. Rows: ${selectedResultSet.rowCount}, Columns: ${selectedResultSet.fields.length}`);
        }
    }

    @CSBDDStepDef('the return value should be {string}')
    async validateReturnValue(expectedValue: string): Promise<void> {
        CSReporter.info(`Validating return value should be '${expectedValue}'`);

        const returnValue = this.lastReturnValue;
        if (returnValue === undefined) {
            throw new Error('No return value available. Execute a procedure/function first');
        }

        const interpolatedExpected = this.interpolateVariables(expectedValue);
        const convertedExpected = this.convertParameterValue(interpolatedExpected);

        if (!this.valuesEqual(returnValue, convertedExpected)) {
            throw new Error(
                `Return value mismatch\n` +
                `Expected: ${interpolatedExpected} (${typeof convertedExpected})\n` +
                `Actual: ${returnValue} (${typeof returnValue})`
            );
        }

        CSReporter.info(`Return value validation passed: ${returnValue}`);
    }

    @CSBDDStepDef('user executes system stored procedure {string}')
    async executeSystemProcedure(procedureName: string): Promise<void> {
        CSReporter.info(`Executing system stored procedure: ${procedureName}`);

        try {
            const interpolatedName = this.interpolateVariables(procedureName);

            const adapter = this.databaseContext.getActiveAdapter();
            const connection = this.getActiveConnection();
            const queryResult = await adapter.executeStoredProcedure(connection, interpolatedName);

            const result: StoredProcedureCall = {
                resultSets: [queryResult],
                outputParameters: {},
                returnValue: undefined
            };

            this.handleProcedureResult(result, interpolatedName, 0);

            CSReporter.info(`System procedure '${interpolatedName}' executed successfully. Rows: ${queryResult.rowCount}`);

        } catch (error) {
            CSReporter.error(`Failed to execute system procedure '${procedureName}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute system procedure '${procedureName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user lists available stored procedures')
    async listStoredProcedures(): Promise<void> {
        CSReporter.info('Listing available stored procedures');

        try {
            const procedures: StoredProcedureMetadata[] = [];

            console.log('\n=== Available Stored Procedures ===');
            procedures.forEach((proc: StoredProcedureMetadata, index: number) => {
                console.log(`${index + 1}. ${proc.schema}.${proc.name}`);
                if (proc.parameters && proc.parameters.length > 0) {
                    console.log(`   Parameters: ${proc.parameters.map((p: any) => p.name).join(', ')}`);
                }
            });
            console.log(`Total: ${procedures.length} procedure(s)\n`);

            this.contextVariables.set('availableProcedures', procedures);

            CSReporter.info(`Listed ${procedures.length} available stored procedures`);

        } catch (error) {
            CSReporter.error(`Failed to list stored procedures: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to list stored procedures: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private getActiveConnection(): any {
        const connectionField = 'activeConnection';
        const connection = (this.databaseContext as any)[connectionField];
        if (!connection) {
            throw new Error('No database connection established. Use "user connects to ... database" first');
        }
        return connection;
    }

    private parseProcedureParameters(dataTable: any): ProcedureParameter[] {
        const parameters: ProcedureParameter[] = [];

        if (dataTable && dataTable.rawTable) {
            const headers = dataTable.rawTable[0].map((h: string) => h.toLowerCase().trim());

            for (let i = 1; i < dataTable.rawTable.length; i++) {
                const row = dataTable.rawTable[i];
                const param: ProcedureParameter = {
                    name: '',
                    value: null,
                    type: 'VARCHAR',
                    direction: 'IN'
                };

                headers.forEach((header: string, index: number) => {
                    const cellValue = row[index]?.trim() || '';

                    switch (header) {
                        case 'name':
                        case 'parameter':
                            param.name = cellValue;
                            break;
                        case 'value':
                            param.value = this.convertParameterValue(this.interpolateVariables(cellValue));
                            break;
                        case 'type':
                        case 'datatype':
                            param.type = cellValue.toUpperCase();
                            break;
                        case 'direction':
                        case 'mode':
                            param.direction = cellValue.toUpperCase() as any;
                            break;
                    }
                });

                if (!param.name) {
                    throw new Error(`Parameter name is required at row ${i}`);
                }

                parameters.push(param);
            }
        }

        return parameters;
    }

    private parseFunctionParameters(dataTable: any): any[] {
        const parameters: any[] = [];

        if (dataTable && dataTable.rawTable) {
            dataTable.rawTable.forEach((row: string[]) => {
                if (row && row.length > 0 && row[0]) {
                    const value = this.interpolateVariables(row[0].trim());
                    parameters.push(this.convertParameterValue(value));
                }
            });
        }

        return parameters;
    }

    private handleProcedureResult(result: StoredProcedureCall, procedureName: string, executionTime: number): void {
        if (result.resultSets && result.resultSets.length > 0) {
            this.lastResultSets = result.resultSets;
            const firstResultSet = result.resultSets[0];
            if (firstResultSet) {
                this.databaseContext.storeResult('last', firstResultSet);
            }
        }

        if (result.outputParameters) {
            this.lastOutputParameters = result.outputParameters;
        }

        if (result.returnValue !== undefined) {
            this.lastReturnValue = result.returnValue;
        }

        this.contextVariables.set('lastProcedureExecution', {
            procedureName,
            executionTime,
            resultSetCount: result.resultSets?.length || 0,
            outputParameterCount: Object.keys(result.outputParameters || {}).length,
            timestamp: new Date()
        });
    }

    private convertParameterValue(value: string): any {
        if (value.toLowerCase() === 'null') return null;

        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;

        if (/^-?\d+$/.test(value)) return parseInt(value);
        if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

        if (/^\d{4}-\d{2}-\d{2}/.test(value)) return new Date(value);

        if (value === "''") return '';

        return value;
    }

    private valuesEqual(actual: any, expected: any): boolean {
        if (actual === null || actual === undefined) {
            return expected === null || expected === undefined || expected === 'null';
        }

        if (actual instanceof Date && expected instanceof Date) {
            return actual.getTime() === expected.getTime();
        }

        if (typeof actual === 'number' && typeof expected === 'number') {
            return Math.abs(actual - expected) < 0.001;
        }

        return actual === expected;
    }

    private extractOutputParameters(parameters: ProcedureParameter[], values: any[]): Record<string, any> {
        const outputParams: Record<string, any> = {};
        parameters.forEach((param, index) => {
            if (param.direction === 'OUT' || param.direction === 'INOUT') {
                outputParams[param.name] = values[index];
            }
        });
        return outputParams;
    }

    private interpolateVariables(text: string): string {
        text = text.replace(/\${([^}]+)}/g, (match, varName) => {
            return process.env[varName] || match;
        });

        text = text.replace(/{{([^}]+)}}/g, (match, varName) => {
            const retrieved = this.contextVariables.get(varName);
            return retrieved !== undefined ? String(retrieved) : match;
        });

        text = text.replace(/%([^%]+)%/g, (match, varName) => {
            return this.configManager.get(varName, match) as string;
        });

        return text;
    }
}