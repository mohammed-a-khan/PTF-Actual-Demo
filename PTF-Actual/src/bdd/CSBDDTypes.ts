/**
 * BDD Type Definitions
 * 
 * Extracted to a separate file to avoid circular dependencies
 * and improve import performance
 */
export interface ParsedFeature{
    name: string;
    description?: string;
    tags: string[];
    scenarios: ParsedScenario[];
    background?: ParsedBackground;
    backgroundSteps: ParsedBackground;
    rules?: ParsedRule[];
    url?: string;
}

export interface ParsedScenario{
    name: string;
    tags: string[];
    steps: ParsedStep[];
    examples?: ParsedExamples;
    type: 'Scenario' | 'Scenario Outline' | 'ScenarioOutline';
}

export interface ParsedBackground{
    name?: string;
    steps: ParsedStep[];
}

export interface ParsedStep{
    keyword: string;
    text: string;
    dataTable?: any[][];
    docString?: string;
}

export interface ParsedRule{
    name: string;
    scenarios: ParsedScenario[];
}

export interface ParsedExamples {
    name?: string;
    headers: string[];
    rows: string[][];
    dataSource?: ExternalDataSource;

}

export interface ExternalDataSource {
    type: 'excel' | 'csv' | 'json' | 'xml' | 'database' | 'api';
    source: string;
    sheet?: string;
    delimiter?: string;
    path?: string;
    xpath?: string;
    filter?: string;
    query?: string;
    connection?: string;
}