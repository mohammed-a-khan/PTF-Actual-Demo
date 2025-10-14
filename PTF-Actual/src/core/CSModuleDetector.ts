/**
 * Intelligent Module Detection System
 *
 * Detects which modules (Browser/UI, API, Database, SOAP) are required
 * for test scenarios based on tags and step patterns.
 *
 * Thread-Safe: Uses worker-aware singleton pattern for parallel execution
 * Backward Compatible: Feature-flag controlled, defaults to disabled
 */

import * as fs from 'fs';
import * as path from 'path';
import  type {ParsedScenario, ParsedStep, ParsedFeature } from '../bdd/CSBDDTypes';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from './CSConfigurationManager';

export interface ModuleRequirements {
    browser: boolean;
    api: boolean;
    database: boolean;
    soap: boolean;
}

export type DetectionMode = 'auto' | 'explicit' | 'hybrid';

export class CSModuleDetector {
    private static instance: CSModuleDetector;
    private static workerInstances: Map<number, CSModuleDetector> = new Map();
    private config: CSConfigurationManager;

    /**
     * Tag to module mapping
     * Tags are case-insensitive and normalized to lowercase
     */
    private readonly TAG_MAPPING: Record<string, keyof ModuleRequirements> = {
        '@ui': 'browser',
        '@browser': 'browser',
        '@web': 'browser',
        '@api': 'api',
        '@rest': 'api',
        '@http': 'api',
        '@database': 'database',
        '@db': 'database',
        '@sql': 'database',
        '@soap': 'soap'
    };

    /**
     * Step pattern regex for implicit detection
     * Patterns detect step text to infer required modules
     * Flexible patterns support multiple subjects: I, user, we, they, etc.
     */
    private readonly STEP_PATTERNS: Record<keyof ModuleRequirements, RegExp[]> = {
        browser: [
            // Navigation patterns (flexible subject)
            /(?:I|user|users|we|they|he|she)\s+navigate/i,
            /(?:I|user|users|we|they|he|she)\s+(?:go|goes)\s+to/i,
            /(?:I|user|users|we|they|he|she)\s+(?:am|is|are)\s+on\s+.*page/i,
            // Interaction patterns
            /(?:I|user|users|we|they|he|she)\s+click/i,
            /(?:I|user|users|we|they|he|she)\s+(?:enter|type|input)/i,
            /(?:I|user|users|we|they|he|she)\s+select/i,
            /(?:I|user|users|we|they|he|she)\s+(?:wait|scroll|hover|press)/i,
            /(?:I|user|users|we|they|he|she)\s+(?:upload|download)/i,
            // Verification patterns
            /(?:I|user|users|we|they|he|she)\s+should\s+(?:see|not see)/i,
            /(?:I|user|users|we|they|he|she)\s+should\s+(?:still be|NOT be)\s+logged in/i,
            // Element/Browser keywords (subject-independent)
            /(?:switch|close|open).*browser/i,
            /the\s+(?:page|element|button|link|input|dropdown|checkbox|radio|tab|window)/i,
            /(?:browser|webpage|current\s+page)/i
        ],
        api: [
            // HTTP Request patterns (flexible subject)
            /(?:I|user|users|we|they|he|she)\s+send.*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+request/i,
            /(?:I|user|users|we|they|he|she)\s+(?:call|invoke).*(?:API|endpoint)/i,
            /(?:I|user|users|we|they|he|she)\s+set.*(?:header|query parameter|body|authentication)/i,
            /(?:I|user|users|we|they|he|she)\s+validate.*response/i,
            // Response patterns (subject-independent)
            /(?:the\s+)?response\s+(?:status|code|body)/i,
            /(?:the\s+)?(?:JSON|XML)\s+response/i,
            /status\s+code\s+should/i,
            // Keywords (subject-independent)
            /\b(?:API|REST|HTTP|endpoint)\b/i,
            /request\s+to\s+[/"']/i
        ],
        database: [
            // Connection patterns (flexible subject)
            /(?:I|user|users|we|they|he|she)\s+connect.*(?:to\s+)?database/i,
            /(?:I|user|users|we|they|he|she)\s+(?:disconnect|close).*database/i,
            // Query patterns (flexible subject)
            /(?:I|user|users|we|they|he|she)\s+(?:execute|run).*query/i,
            /(?:I|user|users|we|they|he|she)\s+execute.*stored\s+procedure/i,
            // Transaction patterns (flexible subject)
            /(?:I|user|users|we|they|he|she)\s+(?:begin|start).*transaction/i,
            /(?:I|user|users|we|they|he|she)\s+(?:commit|rollback).*transaction/i,
            // SQL Keywords (subject-independent)
            /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b.*\b(?:FROM|INTO|TABLE|DATABASE)\b/i,
            // Database keywords (subject-independent)
            /\b(?:SQL|database|query\s+result|stored\s+procedure)\b/i,
            /(?:the\s+)?(?:database|table|query)/i
        ],
        soap: [
            // SOAP patterns (flexible subject)
            /(?:I|user|users|we|they|he|she)\s+send.*SOAP/i,
            /(?:I|user|users|we|they|he|she)\s+(?:call|invoke).*(?:web\s+service|SOAP\s+service)/i,
            // Keywords (subject-independent)
            /\b(?:SOAP|WSDL|web\s+service)\b/i
        ]
    };

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    /**
     * Worker-aware singleton pattern
     * Each worker process gets its own instance
     * Main thread gets a single instance
     */
    public static getInstance(): CSModuleDetector {
        // Check if running in worker thread
        if (typeof process !== 'undefined' && process.env.WORKER_ID) {
            const workerId = parseInt(process.env.WORKER_ID);
            if (!CSModuleDetector.workerInstances.has(workerId)) {
                CSModuleDetector.workerInstances.set(workerId, new CSModuleDetector());
            }
            return CSModuleDetector.workerInstances.get(workerId)!;
        }

        // Main thread singleton
        if (!CSModuleDetector.instance) {
            CSModuleDetector.instance = new CSModuleDetector();
        }
        return CSModuleDetector.instance;
    }

    /**
     * Detect module requirements for a scenario
     *
     * Priority Order:
     * 1. Explicit module specification (MODULES config/CLI)
     * 2. Tag-based detection (explicit tags)
     * 3. Step pattern detection (implicit)
     * 4. Default fallback (browser=true)
     *
     * @param scenario - Parsed scenario object
     * @param feature - Parsed feature object
     * @returns Module requirements object
     */
    public detectRequirements(
        scenario: ParsedScenario,
        feature: ParsedFeature
    ): ModuleRequirements {
        // PRIORITY 1: Check for explicit module specification via config/CLI
        const explicitModules = this.config.get('MODULES', '').trim();
        if (explicitModules) {
            const requirements = this.parseExplicitModules(explicitModules);
            if (this.config.getBoolean('MODULE_DETECTION_LOGGING', false)) {
                const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
                CSReporter.debug(`[${workerId}] Explicit Modules (MODULES config): ${explicitModules} | Scenario: ${scenario.name}`);
            }
            return requirements;
        }

        // Check if module detection is enabled (default: true for intelligent browser launch)
        const enabled = this.config.getBoolean('MODULE_DETECTION_ENABLED', true);
        if (!enabled) {
            // Feature disabled - return default (browser always enabled for backward compatibility)
            return {
                browser: true,
                api: false,
                database: false,
                soap: false
            };
        }

        const mode = this.config.get('MODULE_DETECTION_MODE', 'hybrid') as DetectionMode;

        // Combine feature and scenario tags
        const allTags = [...(feature.tags || []), ...(scenario.tags || [])];

        let requirements: ModuleRequirements;

        switch (mode) {
            case 'explicit':
                // Only use tags, no pattern detection
                requirements = this.detectFromTags(allTags);
                break;

            case 'auto':
                // Only use patterns, ignore tags
                requirements = this.detectFromSteps(scenario.steps || []);
                break;

            case 'hybrid':
            default:
                // Tags first (explicit), then patterns (implicit) as fallback
                const tagRequirements = this.detectFromTags(allTags);
                const hasExplicitTags = Object.values(tagRequirements).some(v => v === true);

                if (hasExplicitTags) {
                    requirements = tagRequirements;
                } else {
                    requirements = this.detectFromSteps(scenario.steps || []);
                }
                break;
        }

        // Log detection results if logging enabled
        if (this.config.getBoolean('MODULE_DETECTION_LOGGING', false)) {
            const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
            const modules = Object.entries(requirements)
                .filter(([_, enabled]) => enabled)
                .map(([module]) => module)
                .join(', ') || 'none';

            CSReporter.debug(`[${workerId}] Module Detection (${mode}): ${modules} | Scenario: ${scenario.name}`);
        }

        return requirements;
    }

    /**
     * Detect requirements from tags (explicit detection)
     */
    private detectFromTags(tags: string[]): ModuleRequirements {
        const requirements: ModuleRequirements = {
            browser: false,
            api: false,
            database: false,
            soap: false
        };

        for (const tag of tags) {
            const normalizedTag = tag.toLowerCase().trim();

            // Check exact matches
            for (const [tagPattern, module] of Object.entries(this.TAG_MAPPING)) {
                if (normalizedTag === tagPattern) {
                    requirements[module] = true;
                }
            }
        }

        return requirements;
    }

    /**
     * Detect requirements from step patterns (implicit detection)
     */
    private detectFromSteps(steps: ParsedStep[]): ModuleRequirements {
        const requirements: ModuleRequirements = {
            browser: false,
            api: false,
            database: false,
            soap: false
        };

        for (const step of steps) {
            const stepText = `${step.keyword || ''} ${step.text || ''}`.trim();

            // Check each module's patterns
            for (const [module, patterns] of Object.entries(this.STEP_PATTERNS)) {
                if (this.matchesAnyPattern(stepText, patterns)) {
                    requirements[module as keyof ModuleRequirements] = true;
                }
            }
        }

        // Default to browser if no patterns matched (backward compatibility)
        const hasAnyMatch = Object.values(requirements).some(v => v === true);
        if (!hasAnyMatch) {
            const defaultToBrowser = this.config.getBoolean('MODULE_DETECTION_DEFAULT_BROWSER', true);
            if (defaultToBrowser) {
                requirements.browser = true;
            }
        }

        return requirements;
    }

    /**
     * Check if text matches any pattern in array
     */
    private matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
        return patterns.some(pattern => pattern.test(text));
    }

    /**
     * Parse explicit module specification from config/CLI
     *
     * Supported formats:
     * - "api"                    → api only
     * - "api,database"           → api + database
     * - "ui,api,database"        → ui + api + database
     * - "browser,api"            → browser + api (browser is alias for ui)
     *
     * @param moduleSpec - Comma-separated list of modules
     * @returns Module requirements object
     */
    private parseExplicitModules(moduleSpec: string): ModuleRequirements {
        const requirements: ModuleRequirements = {
            browser: false,
            api: false,
            database: false,
            soap: false
        };

        // Split by comma and normalize
        const modules = moduleSpec.toLowerCase().split(',').map(m => m.trim());

        for (const module of modules) {
            switch (module) {
                case 'ui':
                case 'browser':
                case 'web':
                    requirements.browser = true;
                    break;
                case 'api':
                case 'rest':
                case 'http':
                    requirements.api = true;
                    break;
                case 'database':
                case 'db':
                case 'sql':
                    requirements.database = true;
                    break;
                case 'soap':
                case 'wsdl':
                    requirements.soap = true;
                    break;
                default:
                    CSReporter.warn(`Unknown module in MODULES specification: "${module}". Valid: ui, api, database, soap`);
            }
        }

        return requirements;
    }

    /**
     * Get a summary string of detected modules
     */
    public getRequirementsSummary(requirements: ModuleRequirements): string {
        const modules = Object.entries(requirements)
            .filter(([_, enabled]) => enabled)
            .map(([module]) => module)
            .join(', ');

        return modules || 'none';
    }

    /**
     * Check if browser is required
     */
    public isBrowserRequired(requirements: ModuleRequirements): boolean {
        // Check for override
        if (this.config.getBoolean('BROWSER_ALWAYS_LAUNCH', false)) {
            return true;
        }

        return requirements.browser;
    }
}
