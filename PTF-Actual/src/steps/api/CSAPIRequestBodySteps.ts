import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSRequestTemplateEngine } from '../../api/templates/CSRequestTemplateEngine';
import { CSReporter } from '../../reporter/CSReporter';
import * as fs from 'fs';
import * as path from 'path';

/**
 * BDD Step Definitions for API Request Body Management
 * Provides comprehensive body manipulation operations
 */
export class CSAPIRequestBodySteps {
    private contextManager: CSApiContextManager;
    private templateEngine: CSRequestTemplateEngine;

    constructor() {
        this.contextManager = CSApiContextManager.getInstance();
        this.templateEngine = new CSRequestTemplateEngine();
    }

    private getCurrentContext(): CSApiContext {
        const context = this.contextManager.getCurrentContext();
        if (!context) {
            throw new Error('No API context set. Please use "user is working with" step first');
        }
        return context;
    }

    @CSBDDStepDef("user sets request body to:")
    async setRequestBodyContent(bodyContent: string): Promise<void> {
        CSReporter.info('Setting request body');

        try {
            const context = this.getCurrentContext();

            // Process template variables
            const processedBody = await this.templateEngine.processRequest({
                body: bodyContent
            } as any, context);

            const contentType = this.detectContentType(processedBody.body);
            const validatedBody = this.validateAndParseBody(processedBody.body, contentType);

            context.setVariable('requestBody', validatedBody);

            // Set content type if not already set
            if (!context.getHeader('Content-Type')) {
                context.setHeader('Content-Type', contentType);
            }

            CSReporter.pass(`Request body set (${contentType})`);
        } catch (error) {
            CSReporter.fail(`Failed to set request body: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request body from {string} file")
    async setRequestBodyFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Setting request body from file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`Request body file not found: ${resolvedPath}`);
            }

            const fileContent = fs.readFileSync(resolvedPath, 'utf8');

            // Process template variables
            const processedBody = await this.templateEngine.processRequest({
                body: fileContent
            } as any, context);

            const contentType = this.detectContentTypeFromFile(resolvedPath) || this.detectContentType(processedBody.body);
            const validatedBody = this.validateAndParseBody(processedBody.body, contentType);

            context.setVariable('requestBody', validatedBody);

            // Set content type if not already set
            if (!context.getHeader('Content-Type')) {
                context.setHeader('Content-Type', contentType);
            }

            CSReporter.pass(`Request body set from file (${contentType})`);
        } catch (error) {
            CSReporter.fail(`Failed to set request body from file: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets form field {string} to {string}")
    async setFormField(fieldName: string, fieldValue: string): Promise<void> {
        CSReporter.info(`Setting form field ${fieldName}`);

        try {
            const context = this.getCurrentContext();

            let formData = context.getVariable('requestBody') || {};
            if (typeof formData !== 'object') {
                formData = {};
            }

            const interpolatedValue = this.interpolateValue(fieldValue, context);
            formData[fieldName] = interpolatedValue;

            context.setVariable('requestBody', formData);

            // Set content type for form data
            if (!context.getHeader('Content-Type')) {
                context.setHeader('Content-Type', 'application/x-www-form-urlencoded');
            }

            CSReporter.pass(`Form field ${fieldName} set`);
        } catch (error) {
            CSReporter.fail(`Failed to set form field: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets form fields:")
    async setFormFields(dataTable: any): Promise<void> {
        CSReporter.info('Setting multiple form fields');

        try {
            const context = this.getCurrentContext();

            let formData = context.getVariable('requestBody') || {};
            if (typeof formData !== 'object') {
                formData = {};
            }

            const rows = dataTable.raw ? dataTable.raw() : dataTable;

            for (const row of rows) {
                const fieldName = row[0];
                const fieldValue = row[1];

                if (!fieldName) {
                    throw new Error('Form field name cannot be empty');
                }

                const interpolatedValue = this.interpolateValue(fieldValue || '', context);
                formData[fieldName] = interpolatedValue;
            }

            context.setVariable('requestBody', formData);

            // Set content type for form data
            if (!context.getHeader('Content-Type')) {
                context.setHeader('Content-Type', 'application/x-www-form-urlencoded');
            }

            CSReporter.pass(`Set ${Object.keys(formData).length} form fields`);
        } catch (error) {
            CSReporter.fail(`Failed to set form fields: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets JSON body:")
    async setJSONBody(jsonContent: string | any): Promise<void> {
        CSReporter.info('Setting JSON body');

        try {
            const context = this.getCurrentContext();

            if (typeof jsonContent === 'string') {
                // Process template and parse JSON
                const processedJSON = this.interpolateValue(jsonContent, context);

                let jsonObject;
                try {
                    jsonObject = JSON.parse(processedJSON);
                } catch (e) {
                    throw new Error(`Invalid JSON format: ${(e as Error).message}`);
                }

                context.setVariable('requestBody', jsonObject);
            } else if (jsonContent.raw) {
                // DataTable format
                const jsonObject: Record<string, any> = {};
                const rows = jsonContent.raw();

                for (const row of rows) {
                    const key = row[0];
                    const value = row[1];

                    if (!key) {
                        throw new Error('JSON property name cannot be empty');
                    }

                    const interpolatedValue = this.interpolateValue(value || '', context);
                    jsonObject[key] = this.parseJSONValue(interpolatedValue);
                }

                context.setVariable('requestBody', jsonObject);
            }

            context.setHeader('Content-Type', 'application/json');
            CSReporter.pass('JSON body set');
        } catch (error) {
            CSReporter.fail(`Failed to set JSON body: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets XML body:")
    async setXMLBody(xmlContent: string): Promise<void> {
        CSReporter.info('Setting XML body');

        try {
            const context = this.getCurrentContext();

            const processedXML = this.interpolateValue(xmlContent, context);
            this.validateXML(processedXML);

            context.setVariable('requestBody', processedXML);
            context.setHeader('Content-Type', 'application/xml');

            CSReporter.pass('XML body set');
        } catch (error) {
            CSReporter.fail(`Failed to set XML body: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets raw body to {string}")
    async setRawBody(bodyContent: string): Promise<void> {
        CSReporter.info('Setting raw body');

        try {
            const context = this.getCurrentContext();

            const interpolatedBody = this.interpolateValue(bodyContent, context);
            context.setVariable('requestBody', interpolatedBody);

            // Set content type if not already set
            if (!context.getHeader('Content-Type')) {
                context.setHeader('Content-Type', 'text/plain');
            }

            CSReporter.pass('Raw body set');
        } catch (error) {
            CSReporter.fail(`Failed to set raw body: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user clears request body")
    async clearRequestBody(): Promise<void> {
        CSReporter.info('Clearing request body');

        try {
            const context = this.getCurrentContext();
            context.setVariable('requestBody', null);
            CSReporter.pass('Request body cleared');
        } catch (error) {
            CSReporter.fail(`Failed to clear request body: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets multipart field {string} to {string}")
    async setMultipartField(fieldName: string, fieldValue: string): Promise<void> {
        CSReporter.info(`Setting multipart field ${fieldName}`);

        try {
            const context = this.getCurrentContext();

            let multipartData = context.getVariable('requestBody') as any;
            if (!multipartData || !multipartData._isMultipart) {
                multipartData = {
                    _isMultipart: true,
                    fields: {},
                    files: {}
                };
            }

            const interpolatedValue = this.interpolateValue(fieldValue, context);
            multipartData.fields[fieldName] = interpolatedValue;

            context.setVariable('requestBody', multipartData);

            // Set content type for multipart
            if (!context.getHeader('Content-Type') || !context.getHeader('Content-Type')?.includes('multipart')) {
                context.setHeader('Content-Type', 'multipart/form-data');
            }

            CSReporter.pass(`Multipart field ${fieldName} set`);
        } catch (error) {
            CSReporter.fail(`Failed to set multipart field: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user adds file {string} as {string} to multipart")
    async addFileToMultipart(filePath: string, fieldName: string): Promise<void> {
        CSReporter.info(`Adding file ${filePath} as ${fieldName} to multipart`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`File not found: ${resolvedPath}`);
            }

            const fileStats = fs.statSync(resolvedPath);
            const fileName = path.basename(resolvedPath);
            const mimeType = this.getMimeType(resolvedPath);

            let multipartData = context.getVariable('requestBody') as any;
            if (!multipartData || !multipartData._isMultipart) {
                multipartData = {
                    _isMultipart: true,
                    fields: {},
                    files: {}
                };
            }

            multipartData.files[fieldName] = {
                path: resolvedPath,
                filename: fileName,
                contentType: mimeType,
                size: fileStats.size
            };

            context.setVariable('requestBody', multipartData);

            // Set content type for multipart
            if (!context.getHeader('Content-Type') || !context.getHeader('Content-Type')?.includes('multipart')) {
                context.setHeader('Content-Type', 'multipart/form-data');
            }

            CSReporter.pass(`File ${fileName} added to multipart`);
        } catch (error) {
            CSReporter.fail(`Failed to add file to multipart: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets GraphQL query:")
    async setGraphQLQuery(query: string): Promise<void> {
        CSReporter.info('Setting GraphQL query');

        try {
            const context = this.getCurrentContext();

            let graphqlBody = context.getVariable('requestBody') || {};
            if (typeof graphqlBody !== 'object') {
                graphqlBody = {};
            }

            const processedQuery = this.interpolateValue(query, context);
            (graphqlBody as any).query = processedQuery;

            context.setVariable('requestBody', graphqlBody);
            context.setHeader('Content-Type', 'application/json');

            CSReporter.pass('GraphQL query set');
        } catch (error) {
            CSReporter.fail(`Failed to set GraphQL query: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets GraphQL variables:")
    async setGraphQLVariables(variablesJson: string): Promise<void> {
        CSReporter.info('Setting GraphQL variables');

        try {
            const context = this.getCurrentContext();

            let graphqlBody = context.getVariable('requestBody') || {};
            if (typeof graphqlBody !== 'object') {
                graphqlBody = {};
            }

            const processedVariables = this.interpolateValue(variablesJson, context);

            let variables: any;
            try {
                variables = JSON.parse(processedVariables);
            } catch (e) {
                throw new Error(`Invalid JSON in GraphQL variables: ${(e as Error).message}`);
            }

            (graphqlBody as any).variables = variables;

            context.setVariable('requestBody', graphqlBody);
            context.setHeader('Content-Type', 'application/json');

            CSReporter.pass(`GraphQL variables set (${Object.keys(variables).length} variables)`);
        } catch (error) {
            CSReporter.fail(`Failed to set GraphQL variables: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request body to JSON:")
    async setRequestBodyToJSON(jsonContent: string): Promise<void> {
        CSReporter.info('Setting request body to JSON');

        try {
            const context = this.getCurrentContext();

            const interpolatedJson = this.interpolateValue(jsonContent, context);
            const jsonBody = JSON.parse(interpolatedJson);

            context.setVariable('requestBody', jsonBody);
            context.setHeader('Content-Type', 'application/json');

            CSReporter.pass('Request body set to JSON');
        } catch (error) {
            CSReporter.fail(`Failed to set request body to JSON: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets binary body from {string} file")
    async setBinaryBodyFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Setting binary body from file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`Binary file not found: ${resolvedPath}`);
            }

            const fileContent = fs.readFileSync(resolvedPath);
            context.setVariable('requestBody', fileContent);

            // Set content type based on file
            const mimeType = this.getMimeType(resolvedPath);
            context.setHeader('Content-Type', mimeType);

            CSReporter.pass(`Binary body set from file (${mimeType})`);
        } catch (error) {
            CSReporter.fail(`Failed to set binary body: ${(error as Error).message}`);
            throw error;
        }
    }

    // Helper methods
    private detectContentType(body: any): string {
        if (typeof body === 'string') {
            if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
                return 'application/json';
            }
            if (body.trim().startsWith('<')) {
                return 'application/xml';
            }
            return 'text/plain';
        }

        if (typeof body === 'object') {
            return 'application/json';
        }

        return 'application/octet-stream';
    }

    private detectContentTypeFromFile(filePath: string): string | null {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            '.json': 'application/json',
            '.xml': 'application/xml',
            '.html': 'text/html',
            '.txt': 'text/plain',
            '.csv': 'text/csv',
            '.yaml': 'application/x-yaml',
            '.yml': 'application/x-yaml'
        };

        return mimeTypes[ext] || null;
    }

    private validateAndParseBody(body: any, contentType: string): any {
        if (contentType === 'application/json' && typeof body === 'string') {
            try {
                return JSON.parse(body);
            } catch (e) {
                throw new Error(`Invalid JSON body: ${(e as Error).message}`);
            }
        }

        if (contentType === 'application/xml' && typeof body === 'string') {
            this.validateXML(body);
        }

        return body;
    }

    private validateXML(xml: string): void {
        // Basic XML validation - check for matching tags
        const openTags = xml.match(/<(\w+)[^>]*>/g) || [];
        const closeTags = xml.match(/<\/(\w+)>/g) || [];

        if (openTags.length === 0 || closeTags.length === 0) {
            throw new Error('Invalid XML: No valid tags found');
        }

        // Basic check for well-formedness
        if (!xml.includes('<?xml') && !xml.includes('<') && !xml.includes('>')) {
            throw new Error('Invalid XML format');
        }
    }

    private interpolateValue(value: string, context: CSApiContext): string {
        if (!value.includes('{{')) {
            return value;
        }

        let interpolated = value;
        interpolated = interpolated.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            const varValue = context.getVariable(varName);
            return varValue !== undefined ? String(varValue) : match;
        });

        return interpolated;
    }

    private parseJSONValue(value: string): any {
        // Try to parse as JSON value
        if (value === 'true') return true;
        if (value === 'false') return false;
        if (value === 'null') return null;

        // Try to parse as number
        const num = Number(value);
        if (!isNaN(num)) return num;

        // Try to parse as JSON
        try {
            return JSON.parse(value);
        } catch {
            // Return as string
            return value;
        }
    }

    private resolveFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        // Try relative to current working directory
        const cwdPath = path.join(process.cwd(), filePath);
        if (fs.existsSync(cwdPath)) {
            return cwdPath;
        }

        // Try test data directory
        const testDataPath = path.join(process.cwd(), 'test', 'data', filePath);
        if (fs.existsSync(testDataPath)) {
            return testDataPath;
        }

        return filePath;
    }

    private getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            '.txt': 'text/plain',
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.xml': 'application/xml',
            '.pdf': 'application/pdf',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.zip': 'application/zip',
            '.tar': 'application/x-tar',
            '.gz': 'application/gzip'
        };

        return mimeTypes[ext] || 'application/octet-stream';
    }
}