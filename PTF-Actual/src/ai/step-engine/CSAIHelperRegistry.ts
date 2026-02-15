/**
 * CSAIHelperRegistry - Consumer Helper Registration & Invocation
 *
 * Allows consumer projects to register custom helper classes that can be
 * invoked from AI steps via the "Call helper 'ClassName.methodName'" grammar.
 *
 * Usage in consumer project (hooks/beforeAll):
 *   CSAIHelperRegistry.register('DataHelper', new DataHelper());
 *   CSAIHelperRegistry.register('CredentialManager', new CredentialManager());
 *
 * Then in feature files:
 *   When AI "Call helper 'DataHelper.getById' with '["42"]'" and store as "record"
 *
 * @module ai/step-engine
 */

import { CSReporter } from '../../reporter/CSReporter';

export class CSAIHelperRegistry {
    private static helpers: Map<string, any> = new Map();

    /** Register a helper instance by name */
    static register(name: string, instance: any): void {
        this.helpers.set(name, instance);
        CSReporter.debug(`CSAIHelperRegistry: Registered helper '${name}'`);
    }

    /** Unregister a helper by name */
    static unregister(name: string): boolean {
        const result = this.helpers.delete(name);
        if (result) {
            CSReporter.debug(`CSAIHelperRegistry: Unregistered helper '${name}'`);
        }
        return result;
    }

    /**
     * Call a helper method.
     * @param classAndMethod - Format: 'ClassName.methodName'
     * @param args - Optional arguments array
     * @returns The method's return value
     */
    static async call(classAndMethod: string, args?: any[]): Promise<any> {
        const dotIndex = classAndMethod.lastIndexOf('.');
        if (dotIndex === -1) {
            throw new Error(`Expected 'ClassName.methodName' format, got: '${classAndMethod}'`);
        }

        const className = classAndMethod.substring(0, dotIndex);
        const methodName = classAndMethod.substring(dotIndex + 1);

        const helper = this.helpers.get(className);
        if (!helper) {
            const available = Array.from(this.helpers.keys()).join(', ') || 'none';
            throw new Error(`Helper '${className}' not registered. Available: ${available}`);
        }

        const method = helper[methodName];
        if (typeof method !== 'function') {
            const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(helper))
                .filter(m => m !== 'constructor' && typeof helper[m] === 'function');
            throw new Error(
                `Method '${methodName}' not found on '${className}'. ` +
                `Available methods: ${methods.join(', ')}`
            );
        }

        CSReporter.debug(`CSAIHelperRegistry: Calling ${classAndMethod}(${args ? JSON.stringify(args).substring(0, 100) : ''})`);
        return await method.apply(helper, args || []);
    }

    /** Check if a helper is registered */
    static isRegistered(name: string): boolean {
        return this.helpers.has(name);
    }

    /** Get all registered helper names */
    static getRegisteredNames(): string[] {
        return Array.from(this.helpers.keys());
    }

    /** Clear all registered helpers */
    static clear(): void {
        this.helpers.clear();
        CSReporter.debug('CSAIHelperRegistry: All helpers cleared');
    }
}
