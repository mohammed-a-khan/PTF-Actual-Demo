/**
 * Agentic Test Platform — Live-App Context Resolver
 *
 * Pure-text input modes (`document_path`, `source_code_path`, and the ADO
 * modes when the test case lacks a URL) cannot ground locators or
 * navigation in real DOM without an application URL. This helper collects
 * the live-app anchor — URL, optional login flow, optional pre-flight
 * navigation steps — through a four-step priority cascade:
 *
 *   1. `classified.extractedFields.{appUrl|url|username|passwordConfigKey|navigationSteps}`
 *   2. `CSConfigurationManager` (APP_URL, APP_USERNAME, APP_PASSWORD)
 *   3. MCP elicitation (`elicitation/create`) — text/confirm/text…
 *   4. Decline cleanly with an active-imperative reason
 *
 * The MCP spec forbids form-mode elicitation of password fields — the
 * helper therefore captures the **config key name** that holds the
 * password (e.g., `APP_PASSWORD`) and verifies the resolved value is
 * non-empty. The actual password stays in the env file with an
 * `ENCRYPTED:` prefix.
 *
 * @module agent-platform/CSLiveAppContext
 */

import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { MCPToolContext } from '../types/CSMCPTypes';
import { CSElicitation } from './CSElicitation';
import { ClassifiedInput } from './types';

// ============================================================================
// Public Types
// ============================================================================

export type LiveAppEntryFlow = 'no-auth' | 'basic-login' | 'sso-redirect';

export interface LiveAppContext {
    appUrl: string;
    entryFlow: LiveAppEntryFlow;
    username?: string;
    passwordConfigKey?: string;
    navigationSteps: string[];
    source: 'extracted' | 'config' | 'elicited';
}

export type LiveAppContextOutcome =
    | { status: 'ok'; context: LiveAppContext }
    | { status: 'declined'; reason: string }
    | { status: 'unsupported'; reason: string };

// ============================================================================
// CSLiveAppContext
// ============================================================================

export class CSLiveAppContext {
    /**
     * True for modes that produce executable tests but lack a built-in
     * way to discover real DOM (doc / source / ADO). False for legacy
     * (already has working tests to migrate from), app_url (URL is the
     * mode itself), and chat (no test artefacts produced).
     */
    public static modeNeedsLiveApp(mode: string): boolean {
        return (
            mode === 'document_path' ||
            mode === 'source_code_path' ||
            mode === 'ado_test_case_id' ||
            mode === 'ado_test_suite_id' ||
            mode === 'ado_test_plan_id'
        );
    }

    /**
     * Resolve the live-app anchor through the four-step cascade. Idempotent:
     * if the URL is already in extractedFields or config, returns immediately
     * without prompting.
     *
     * Returns:
     *   - `ok`            — anchor found / collected; pass `context` through
     *   - `declined`      — user said no (cancel/decline) or the elicited
     *                       value failed validation; reason is active-imperative
     *   - `unsupported`   — host has no elicitation; same reason shape
     */
    public static async ensure(
        classified: ClassifiedInput,
        context: MCPToolContext,
    ): Promise<LiveAppContextOutcome> {
        const ef = classified.extractedFields ?? {};

        // Step 1 — explicit URL in input.
        const efUrl = (ef.appUrl || ef.url || '').trim();
        if (efUrl && /^https?:\/\//i.test(efUrl)) {
            return CSLiveAppContext.fromAvailable(efUrl, ef, 'extracted');
        }

        // Step 2 — config fallback.
        const cfgUrl = CSLiveAppContext.readConfig('APP_URL').trim();
        if (cfgUrl && /^https?:\/\//i.test(cfgUrl)) {
            return CSLiveAppContext.fromAvailable(cfgUrl, ef, 'config');
        }

        // Step 3 — elicitation.
        if (!CSElicitation.isSupported(context)) {
            return {
                status: 'unsupported',
                reason: 'set APP_URL in your env file (and APP_USERNAME / APP_PASSWORD when login is required) before re-invoking — this host does not support interactive prompts. Without a real application URL the doc / source / ADO mode can only produce a planning scaffold, not executable tests.',
            };
        }

        const urlAns = await CSElicitation.text(context, {
            message:
                'Enter the application URL the agent should explore to anchor real DOM and selectors',
            fieldName: 'appUrl',
            description:
                'Full URL with protocol, e.g., https://demo-app.example.com/login',
            format: 'uri',
            minLength: 8,
            maxLength: 500,
        });
        if (!urlAns.supported) {
            return {
                status: 'unsupported',
                reason: 'set APP_URL in your env file before re-invoking — this host stopped supporting prompts mid-flow.',
            };
        }
        if (urlAns.action !== 'accept') {
            return CSLiveAppContext.declineFor('the URL prompt');
        }
        const appUrl = String(urlAns.content.appUrl ?? '').trim();
        if (!/^https?:\/\//i.test(appUrl)) {
            return {
                status: 'declined',
                reason: `re-invoke with a valid http(s) appUrl in your input — got '${appUrl}' which is not a URL.`,
            };
        }

        const loginAns = await CSElicitation.confirm(context, {
            message: 'Does the application require a login on the entry URL?',
            fieldName: 'loginRequired',
            defaultValue: false,
        });
        if (!loginAns.supported || loginAns.action !== 'accept') {
            return CSLiveAppContext.declineFor('the login prompt');
        }
        const loginRequired = !!loginAns.content.loginRequired;

        let username: string | undefined;
        let passwordConfigKey: string | undefined;

        if (loginRequired) {
            const userAns = await CSElicitation.text(context, {
                message: 'Enter the username for the test login',
                fieldName: 'username',
                description: 'Username or email used by the test account.',
                minLength: 1,
                maxLength: 200,
            });
            if (!userAns.supported || userAns.action !== 'accept') {
                return CSLiveAppContext.declineFor('the username prompt');
            }
            username = String(userAns.content.username ?? '').trim();
            if (!username) {
                return {
                    status: 'declined',
                    reason: 're-invoke and provide a non-empty username — the field came back blank.',
                };
            }

            const keyAns = await CSElicitation.text(context, {
                message:
                    'Name of the env config key holding the password (NOT the password itself)',
                fieldName: 'passwordConfigKey',
                description:
                    'e.g., APP_PASSWORD. The actual password lives in the .env file (ENCRYPTED: prefix supported). MCP form-mode elicitation forbids capturing passwords directly.',
                minLength: 1,
                maxLength: 100,
                pattern: '^[A-Z][A-Z0-9_]*$',
            });
            if (!keyAns.supported || keyAns.action !== 'accept') {
                return CSLiveAppContext.declineFor('the config-key prompt');
            }
            passwordConfigKey = String(keyAns.content.passwordConfigKey ?? '').trim();
            if (!passwordConfigKey) {
                return {
                    status: 'declined',
                    reason: 're-invoke and provide a non-empty passwordConfigKey — the field came back blank.',
                };
            }

            const resolved = CSLiveAppContext.readConfig(passwordConfigKey).trim();
            if (!resolved) {
                return {
                    status: 'declined',
                    reason: `add ${passwordConfigKey} (with an ENCRYPTED: value) to your env file before re-invoking — the key is empty in the resolved configuration. Run 'npx cs-playwright-framework encrypt-value --value <password>' to produce the ENCRYPTED: payload.`,
                };
            }
        }

        const navAns = await CSElicitation.text(context, {
            message: 'Pre-flight navigation steps (optional — leave blank to skip)',
            fieldName: 'navSteps',
            description:
                'Comma- or newline-separated, e.g., "Click Admin menu, Click Users, Click New User". Used by the agent to walk to the workflow under test before recording locators.',
            maxLength: 2000,
        });
        let navigationSteps: string[] = [];
        if (navAns.supported && navAns.action === 'accept') {
            const raw = String(navAns.content.navSteps ?? '').trim();
            if (raw) {
                navigationSteps = raw
                    .split(/[,\n]+/)
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }

        return {
            status: 'ok',
            context: {
                appUrl,
                entryFlow: loginRequired ? 'basic-login' : 'no-auth',
                username,
                passwordConfigKey,
                navigationSteps,
                source: 'elicited',
            },
        };
    }

    /**
     * Mutate the classified input so downstream handlers and the heal loop
     * see the live-app anchor as if the user had supplied it from the start.
     * Idempotent: if the URL is already present, only fills missing fields.
     */
    public static merge(
        classified: ClassifiedInput,
        ctx: LiveAppContext,
    ): ClassifiedInput {
        const ef = { ...(classified.extractedFields ?? {}) };
        if (!ef.appUrl) ef.appUrl = ctx.appUrl;
        if (!ef.url) ef.url = ctx.appUrl;
        if (!ef.entryFlow) ef.entryFlow = ctx.entryFlow;
        if (ctx.username && !ef.username) ef.username = ctx.username;
        if (ctx.passwordConfigKey && !ef.passwordConfigKey) {
            ef.passwordConfigKey = ctx.passwordConfigKey;
        }
        if (ctx.navigationSteps.length > 0 && !ef.navigationSteps) {
            ef.navigationSteps = ctx.navigationSteps.join('\n');
        }
        return { ...classified, extractedFields: ef };
    }

    // ------------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------------

    private static fromAvailable(
        appUrl: string,
        ef: Record<string, string>,
        source: 'extracted' | 'config',
    ): LiveAppContextOutcome {
        const username =
            ef.username || CSLiveAppContext.readConfig('APP_USERNAME') || undefined;
        const passwordKey =
            ef.passwordConfigKey ||
            (CSLiveAppContext.readConfig('APP_PASSWORD') ? 'APP_PASSWORD' : undefined);
        const entryFlow: LiveAppEntryFlow = username ? 'basic-login' : 'no-auth';
        const rawNav = ef.navigationSteps || ef.navSteps || '';
        const navigationSteps = rawNav
            ? rawNav
                  .split(/[,\n]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
            : [];
        return {
            status: 'ok',
            context: {
                appUrl,
                entryFlow,
                username,
                passwordConfigKey: passwordKey,
                navigationSteps,
                source,
            },
        };
    }

    private static declineFor(stage: string): LiveAppContextOutcome {
        return {
            status: 'declined',
            reason: `re-invoke with appUrl (and optionally username + passwordConfigKey) in your input — ${stage} was cancelled or declined. Without a real application URL the doc / source / ADO mode can only produce a planning scaffold, not executable tests.`,
        };
    }

    private static readConfig(key: string): string {
        try {
            return CSConfigurationManager.getInstance().get(key, '') || '';
        } catch {
            return '';
        }
    }
}
