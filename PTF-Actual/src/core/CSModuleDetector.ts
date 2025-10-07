/**
 * Intelligent Module Detection System
 *
 * Detects which modules (Browser/UI, API, Database, SOAP) are required
 * for test scenarios based on tags and step patterns.
 *
 * Thread-Safe: Uses worker-aware singleton pattern for parallel execution
 * Backward Compatible: Feature-flag controlled, defaults to disabled
 */

import { ParsedScenario, ParsedStep, ParsedFeature } from '../bdd/CSBDDEngine';
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
     */
    private readonly STEP_PATTERNS: Record<keyof ModuleRequirements, RegExp[]> = {
        browser: [
            /I navigate to/i,
            /I click/i,
            /I enter .* into/i,
            /I type/i,
            /I should see/i,
            /I select/i,
            /I switch .*browser/i,
            /the page/i,
            /browser/i,
            /I should (still be|NOT be) logged in/i,
            /current browser should be/i,
            /I am on the .* page/i,
            /I wait for/i,
            /I scroll/i,
            /I hover/i,
            /I press/i,
            /I upload/i,
            /I download/i,
            /the element/i,
            /the button/i,
            /the link/i,
            /the input/i,
            /the dropdown/i,
            /the checkbox/i,
            /the radio/i
        ],
        api: [
            /I send a (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) request/i,
            /I set .*header/i,
            /the response status/i,
            /the response body/i,
            /the response.*should/i,
            /I validate response/i,
            /API/i,
            /request to/i,
            /HTTP/i,
            /REST/i,
            /endpoint/i,
            /I set (query parameter|body|authentication)/i,
            /the API/i,
            /JSON response/i,
            /XML response/i,
            /status code/i
        ],
        database: [
            /I execute query/i,
            /I connect to database/i,
            /the query result/i,
            /I execute stored procedure/i,
            /database/i,
            /query/i,
            /I begin transaction/i,
            /I rollback transaction/i,
            /I commit transaction/i,
            /SQL/i,
            /SELECT.*FROM/i,
            /INSERT INTO/i,
            /UPDATE.*SET/i,
            /DELETE FROM/i,
            /the database/i,
            /table/i,
            /I run.*query/i
        ],
        soap: [
            /SOAP/i,
            /WSDL/i,
            /I send.*SOAP/i,
            /web service/i
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
     * @param scenario - Parsed scenario object
     * @param feature - Parsed feature object
     * @returns Module requirements object
     */
    public detectRequirements(
        scenario: ParsedScenario,
        feature: ParsedFeature
    ): ModuleRequirements {
        // Check if module detection is enabled
        const enabled = this.config.getBoolean('MODULE_DETECTION_ENABLED', false);
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
