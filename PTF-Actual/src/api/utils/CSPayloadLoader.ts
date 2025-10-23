/**
 * Payload Loader Utility
 * Loads API payloads from files with template processing
 * Supports JSON, XML, YAML, and text files
 * Implements dual syntax support for ${} and {{}} placeholders
 */

import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSPlaceholderResolver, placeholderResolver } from '../templates/CSPlaceholderResolver';
import { CSTemplateProcessor } from './CSTemplateProcessor';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSReporter } from '../../reporter/CSReporter';
import { parseStringPromise } from 'xml2js';

export interface PayloadLoadOptions {
    /** Base path for payload files (overrides config) */
    basePath?: string;
    /** Variables to use for template resolution */
    variables?: Record<string, any>;
    /** Skip template processing */
    skipTemplateProcessing?: boolean;
    /** Encoding for file reading */
    encoding?: BufferEncoding;
}

export class CSPayloadLoader {
    private static instance: CSPayloadLoader;
    private config: CSConfigurationManager;
    private resolver: CSPlaceholderResolver;
    private payloadBasePath: string;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.resolver = new CSPlaceholderResolver();
        this.payloadBasePath = this.config.get('PAYLOAD_BASE_PATH', 'test-data/payloads');
    }

    public static getInstance(): CSPayloadLoader {
        if (!CSPayloadLoader.instance) {
            CSPayloadLoader.instance = new CSPayloadLoader();
        }
        return CSPayloadLoader.instance;
    }

    /**
     * Load payload from file with template processing
     * Supports: .json, .xml, .yaml, .yml, .txt
     *
     * @param payloadFile - File path (relative to payload base path or absolute)
     * @param options - Load options
     * @returns Processed payload
     */
    public async loadPayload(payloadFile: string, options?: PayloadLoadOptions): Promise<any> {
        CSReporter.debug(`Loading payload file: ${payloadFile}`);

        // Resolve file path
        const filePath = this.resolveFilePath(payloadFile, options?.basePath);

        // Read file content
        const encoding = options?.encoding || 'utf-8';
        const content = await readFile(filePath, encoding);

        // Process content based on file type
        const ext = extname(filePath).toLowerCase();

        let processedContent: any;

        if (options?.skipTemplateProcessing) {
            // Return raw content based on type
            switch (ext) {
                case '.json':
                    processedContent = JSON.parse(content);
                    break;
                case '.yaml':
                case '.yml':
                    const yaml = require('js-yaml');
                    processedContent = yaml.load(content);
                    break;
                default:
                    processedContent = content;
            }
        } else {
            // Process with template resolution
            switch (ext) {
                case '.json':
                    processedContent = await this.processJsonPayload(content, options?.variables);
                    break;
                case '.xml':
                    processedContent = await this.processXmlPayload(content, options?.variables);
                    break;
                case '.yaml':
                case '.yml':
                    processedContent = await this.processYamlPayload(content, options?.variables);
                    break;
                case '.txt':
                    processedContent = await this.processTextPayload(content, options?.variables);
                    break;
                default:
                    throw new Error(`Unsupported payload file type: ${ext}`);
            }
        }

        CSReporter.debug('Payload loaded and processed successfully');
        return processedContent;
    }

    /**
     * Process inline payload string
     * Auto-detects format (JSON, XML, or text)
     *
     * @param payloadString - Payload content as string
     * @param variables - Variables for template resolution
     * @returns Processed payload
     */
    public async processPayloadString(
        payloadString: string,
        variables?: Record<string, any>
    ): Promise<any> {
        CSReporter.debug('Processing inline payload string');

        // Try to detect format
        const trimmed = payloadString.trim();

        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            // JSON
            return await this.processJsonPayload(trimmed, variables);
        } else if (trimmed.startsWith('<')) {
            // XML
            return await this.processXmlPayload(trimmed, variables);
        } else {
            // Plain text with template variables
            return await this.processTextPayload(trimmed, variables);
        }
    }

    /**
     * Process JSON payload with template resolution
     * Supports both ${} and {{}} syntax
     */
    private async processJsonPayload(
        content: string,
        variables?: Record<string, any>
    ): Promise<any> {
        // Step 1: Convert Java ${} syntax to PTF {{}} syntax
        const normalized = CSTemplateProcessor.normalizeSyntax(content);

        // Step 2: Get variables from BDD context
        const context = CSBDDContext.getInstance();
        const mergedVariables = {
            ...this.buildVariableContext(context),
            ...variables
        };

        // Step 3: Update resolver context
        for (const [key, value] of Object.entries(mergedVariables)) {
            this.resolver.setVariable(key, value);
        }

        // Step 4: Resolve placeholders
        const resolved = this.resolver.resolve(normalized);

        // Step 5: Parse JSON
        try {
            return JSON.parse(resolved);
        } catch (error: any) {
            CSReporter.error(`Failed to parse JSON payload: ${error.message}`);
            CSReporter.debug(`Resolved content: ${resolved}`);
            throw new Error(`Invalid JSON payload: ${error.message}`);
        }
    }

    /**
     * Process XML payload with template resolution
     * Returns XML string (not parsed object)
     */
    private async processXmlPayload(
        content: string,
        variables?: Record<string, any>
    ): Promise<string> {
        // Step 1: Convert Java ${} syntax to PTF {{}} syntax
        const normalized = CSTemplateProcessor.normalizeSyntax(content);

        // Step 2: Get variables from BDD context
        const context = CSBDDContext.getInstance();
        const mergedVariables = {
            ...this.buildVariableContext(context),
            ...variables
        };

        // Step 3: Update resolver context
        for (const [key, value] of Object.entries(mergedVariables)) {
            this.resolver.setVariable(key, value);
        }

        // Step 4: Resolve placeholders
        const resolved = this.resolver.resolve(normalized);

        // Step 5: Validate XML structure
        try {
            await parseStringPromise(resolved);
            return resolved;
        } catch (error: any) {
            CSReporter.error(`Failed to parse XML payload: ${error.message}`);
            throw new Error(`Invalid XML payload: ${error.message}`);
        }
    }

    /**
     * Process YAML payload with template resolution
     */
    private async processYamlPayload(
        content: string,
        variables?: Record<string, any>
    ): Promise<any> {
        const yaml = require('js-yaml');

        // Step 1: Convert Java ${} syntax to PTF {{}} syntax
        const normalized = CSTemplateProcessor.normalizeSyntax(content);

        // Step 2: Resolve placeholders
        const context = CSBDDContext.getInstance();
        const mergedVariables = {
            ...this.buildVariableContext(context),
            ...variables
        };

        for (const [key, value] of Object.entries(mergedVariables)) {
            this.resolver.setVariable(key, value);
        }

        const resolved = this.resolver.resolve(normalized);

        // Step 3: Parse YAML
        try {
            return yaml.load(resolved);
        } catch (error: any) {
            throw new Error(`Invalid YAML payload: ${error.message}`);
        }
    }

    /**
     * Process text payload with template resolution
     */
    private async processTextPayload(
        content: string,
        variables?: Record<string, any>
    ): Promise<string> {
        // Step 1: Convert Java ${} syntax to PTF {{}} syntax
        const normalized = CSTemplateProcessor.normalizeSyntax(content);

        // Step 2: Resolve placeholders
        const context = CSBDDContext.getInstance();
        const mergedVariables = {
            ...this.buildVariableContext(context),
            ...variables
        };

        for (const [key, value] of Object.entries(mergedVariables)) {
            this.resolver.setVariable(key, value);
        }

        return this.resolver.resolve(normalized);
    }

    /**
     * Resolve file path (absolute or relative to base path)
     */
    private resolveFilePath(payloadFile: string, basePath?: string): string {
        // If absolute path, use as-is
        if (payloadFile.startsWith('/') || payloadFile.match(/^[A-Za-z]:/)) {
            return payloadFile;
        }

        // Relative to payload base path
        const base = basePath || this.payloadBasePath;
        return join(process.cwd(), base, payloadFile);
    }

    /**
     * Build variable context from BDD context
     */
    private buildVariableContext(context: CSBDDContext): Record<string, any> {
        const variables: Record<string, any> = {};

        // Get all variables from world data
        const worldData = (context as any).worldData as Map<string, any>;

        if (worldData) {
            for (const [key, value] of worldData.entries()) {
                variables[key] = value;
            }
        }

        return variables;
    }

    /**
     * Set payload base path
     */
    public setPayloadBasePath(path: string): void {
        this.payloadBasePath = path;
        CSReporter.debug(`Payload base path set to: ${path}`);
    }

    /**
     * Get current payload base path
     */
    public getPayloadBasePath(): string {
        return this.payloadBasePath;
    }

    /**
     * Load payload and return raw content (no template processing)
     */
    public async loadRawPayload(payloadFile: string, options?: PayloadLoadOptions): Promise<string> {
        const filePath = this.resolveFilePath(payloadFile, options?.basePath);
        const encoding = options?.encoding || 'utf-8';
        return await readFile(filePath, encoding);
    }
}
