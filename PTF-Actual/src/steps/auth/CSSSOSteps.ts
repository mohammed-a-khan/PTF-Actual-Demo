/**
 * SSO Authentication Step Definitions
 *
 * BDD steps for Microsoft Azure AD / Entra ID SSO login automation.
 * Supports session persistence, Microsoft SSO login flow, and session management.
 *
 * Usage in feature files:
 *   Given I login to Microsoft SSO with credentials from config
 *   Given I login to Microsoft SSO as "admin"
 *   Given I save the browser session to "auth/admin.json"
 *   Given I load the browser session from "auth/admin.json"
 *   Given I ensure SSO login is active
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSReporter } from '../../reporter/CSReporter';
import { CSScenarioContext } from '../../bdd/CSScenarioContext';

export class CSSSOSteps {
    private scenarioContext: CSScenarioContext;

    constructor() {
        this.scenarioContext = CSScenarioContext.getInstance();
    }

    // =================================================================
    // SESSION PERSISTENCE STEPS (Phase 1)
    // =================================================================

    /**
     * Save current browser session (cookies + localStorage) to a JSON file
     * Example: Given I save the browser session to "auth/admin.json"
     */
    @CSBDDStepDef('I save the browser session to {string}')
    async saveBrowserSession(filePath: string): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();
        const savedPath = await browserManager.saveStorageState(filePath);
        CSReporter.pass(`Browser session saved to: ${savedPath}`);
    }

    /**
     * Load a previously saved browser session from a JSON file
     * Example: Given I load the browser session from "auth/admin.json"
     */
    @CSBDDStepDef('I load the browser session from {string}')
    async loadBrowserSession(filePath: string): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();
        await browserManager.loadStorageState(filePath);
        CSReporter.pass(`Browser session loaded from: ${filePath}`);
    }

    /**
     * Clear the saved browser session file
     * Example: Given I clear the saved browser session
     */
    @CSBDDStepDef('I clear the saved browser session')
    async clearSavedSession(): Promise<void> {
        const { CSConfigurationManager } = await import('../../core/CSConfigurationManager');
        const config = CSConfigurationManager.getInstance();
        const sessionPath = config.get('AUTH_STORAGE_STATE_PATH');

        if (sessionPath) {
            const fs = require('fs');
            const path = require('path');
            const resolvedPath = path.resolve(sessionPath);
            if (fs.existsSync(resolvedPath)) {
                fs.unlinkSync(resolvedPath);
                CSReporter.pass(`Saved session cleared: ${resolvedPath}`);
            } else {
                CSReporter.info('No saved session file to clear');
            }
        } else {
            CSReporter.warn('AUTH_STORAGE_STATE_PATH not configured — nothing to clear');
        }
    }

    // =================================================================
    // MICROSOFT SSO LOGIN STEPS (Phase 2)
    // =================================================================

    /**
     * Login to Microsoft SSO using credentials from config (SSO_USERNAME, SSO_PASSWORD)
     * Example: Given I login to Microsoft SSO with credentials from config
     */
    @CSBDDStepDef('I login to Microsoft SSO with credentials from config')
    async loginToMicrosoftSSO(): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        await handler.loginWithConfigCredentials();
    }

    /**
     * Login to Microsoft SSO as a specific user
     * Uses SSO_{NAME}_USERNAME / SSO_{NAME}_PASSWORD from config,
     * or treats the parameter as the actual username with SSO_PASSWORD
     *
     * Example: Given I login to Microsoft SSO as "admin"
     * Example: Given I login to Microsoft SSO as "test.user@company.com"
     */
    @CSBDDStepDef('I login to Microsoft SSO as {string}')
    async loginAsUser(userNameOrAlias: string): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        await handler.loginAsUser(userNameOrAlias);
    }

    /**
     * Login to Microsoft SSO and save the session for future reuse
     * Example: Given I login to Microsoft SSO and save session to "auth/sso.json"
     */
    @CSBDDStepDef('I login to Microsoft SSO and save session to {string}')
    async loginAndSaveSession(filePath: string): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        await handler.loginWithConfigCredentials({ saveSessionPath: filePath });
    }

    /**
     * Login to Microsoft SSO as a specific user and save the session
     * Example: Given I login to Microsoft SSO as "admin" and save session to "auth/admin.json"
     */
    @CSBDDStepDef('I login to Microsoft SSO as {string} and save session to {string}')
    async loginAsUserAndSave(userNameOrAlias: string, filePath: string): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        await handler.loginAsUser(userNameOrAlias, { saveSessionPath: filePath });
    }

    /**
     * Smart login: Use saved session if valid, otherwise perform fresh SSO login
     * This is the recommended step for test suites — avoids unnecessary logins
     *
     * Example: Given I ensure SSO login is active
     */
    @CSBDDStepDef('I ensure SSO login is active')
    async ensureSSOLogin(): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        await handler.ensureLoggedIn();
    }

    /**
     * Navigate to a URL that triggers SSO login and handle the flow
     * Example: Given I navigate to "https://org.crm.dynamics.com" with SSO login
     */
    @CSBDDStepDef('I navigate to {string} with SSO login')
    async navigateWithSSOLogin(url: string): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        await handler.loginWithConfigCredentials({ loginUrl: url });
    }

    /**
     * Check if currently on Microsoft login page
     * Example: Then I should be on Microsoft login page
     */
    @CSBDDStepDef('I should be on Microsoft login page')
    async verifyOnMicrosoftLoginPage(): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        const isOnLogin = await handler.isOnMicrosoftLoginPage();
        if (!isOnLogin) {
            throw new Error('Expected to be on Microsoft login page, but current URL is not a Microsoft login page');
        }
        CSReporter.pass('Confirmed: on Microsoft login page');
    }

    /**
     * Check if saved session is still valid
     * Example: Then the saved SSO session should be valid
     */
    @CSBDDStepDef('the saved SSO session should be valid')
    async verifySSOSessionValid(): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const handler = new CSMicrosoftSSOHandler();
        const isValid = handler.isSessionValid();
        if (!isValid) {
            throw new Error('Saved SSO session is not valid (expired or not found)');
        }
        CSReporter.pass('SSO session is valid');
    }

    /**
     * Handle "Sign in required" popup that Dynamics 365 shows when session is partially valid.
     * Safe to call even if no popup is present — returns immediately.
     *
     * Example: Then I handle the sign in required popup if present
     */
    @CSBDDStepDef('I handle the sign in required popup if present')
    async handleSignInPopup(): Promise<void> {
        const { CSMicrosoftSSOHandler } = await import('../../auth/CSMicrosoftSSOHandler');
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const handler = new CSMicrosoftSSOHandler();
        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();
        const handled = await handler.handleSignInRequiredPopup(page);
        if (handled) {
            CSReporter.pass('Sign in required popup handled successfully');
        } else {
            CSReporter.info('No sign in required popup detected — continuing');
        }
    }
}

export default CSSSOSteps;
