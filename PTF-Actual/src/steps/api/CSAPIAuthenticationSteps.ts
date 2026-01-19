import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSAPIClient } from '../../api/CSAPIClient';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSAuthConfig, CSAuthType } from '../../api/types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';
import { CSPingAuthHandler, CSPingAuthConfig, pingAuthManager } from '../../api/auth/CSPingAuthHandler';

export class CSAPIAuthenticationSteps {
    private apiClient: CSAPIClient;
    private contextManager: CSApiContextManager;
    private pingHandler: CSPingAuthHandler | null = null;

    constructor() {
        this.apiClient = new CSAPIClient();
        this.contextManager = CSApiContextManager.getInstance();
    }

    @CSBDDStepDef("I use basic authentication with username {string} and password {string}")
    async useBasicAuth(username: string, password: string): Promise<void> {
        const authConfig: CSAuthConfig = {
            type: 'basic' as CSAuthType,
            credentials: {
                username,
                password
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info(`Basic authentication configured for user: ${username}`);
    }

    @CSBDDStepDef("I use bearer token {string}")
    async useBearerToken(token: string): Promise<void> {
        // Token is already resolved by the framework (decrypted and variables substituted)

        const authConfig: CSAuthConfig = {
            type: 'bearer' as CSAuthType,
            credentials: {
                token: token
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('Bearer token authentication configured');
    }

    @CSBDDStepDef("I use API key {string} with value {string}")
    async useApiKey(keyName: string, keyValue: string): Promise<void> {
        // keyValue is already resolved by the framework (decrypted and variables substituted)

        const authConfig: CSAuthConfig = {
            type: 'apikey' as CSAuthType,
            credentials: {
                apiKey: keyValue
            },
            options: {
                headerName: keyName
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info(`API key authentication configured: ${keyName}`);
    }

    @CSBDDStepDef("I use OAuth2 with client credentials:")
    async useOAuth2ClientCredentials(dataTable: any): Promise<void> {
        const rows = dataTable.raw();
        const config: any = {};

        for (const [key, value] of rows) {
            config[key] = value;
        }

        const authConfig: CSAuthConfig = {
            type: 'oauth2' as CSAuthType,
            credentials: {
                clientId: config.clientId,
                clientSecret: config.clientSecret
            },
            options: {
                grantType: 'client_credentials',
                tokenUrl: config.tokenUrl,
                scope: config.scope
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('OAuth2 client credentials authentication configured');
    }

    @CSBDDStepDef("I use OAuth2 with password grant:")
    async useOAuth2Password(dataTable: any): Promise<void> {
        const rows = dataTable.raw();
        const config: any = {};

        for (const [key, value] of rows) {
            config[key] = value;
        }

        const authConfig: CSAuthConfig = {
            type: 'oauth2' as CSAuthType,
            credentials: {
                username: config.username,
                password: config.password,
                clientId: config.clientId,
                clientSecret: config.clientSecret
            },
            options: {
                grantType: 'password',
                tokenUrl: config.tokenUrl,
                scope: config.scope
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('OAuth2 password grant authentication configured');
    }

    @CSBDDStepDef("I use AWS signature authentication with access key {string} and secret key {string}")
    async useAWSAuth(accessKey: string, secretKey: string): Promise<void> {
        const authConfig: CSAuthConfig = {
            type: 'aws' as CSAuthType,
            credentials: {
                accessKey,
                secretKey
            },
            options: {
                region: 'us-east-1',
                service: 'execute-api',
                signatureVersion: 'v4'
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('AWS signature authentication configured');
    }

    @CSBDDStepDef("I use AWS signature authentication with region {string} and service {string}")
    async useAWSAuthWithRegionService(region: string, service: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const existingAuth = context?.auth;

        if (!existingAuth || existingAuth.type !== 'aws') {
            throw new Error('AWS authentication must be configured first');
        }

        existingAuth.options = {
            ...existingAuth.options,
            region,
            service
        };

        this.apiClient.setAuthentication(existingAuth);
        CSReporter.info(`AWS authentication updated: region=${region}, service=${service}`);
    }

    @CSBDDStepDef("I use JWT authentication with token {string}")
    async useJWTAuth(token: string): Promise<void> {
        const authConfig: CSAuthConfig = {
            type: 'bearer' as CSAuthType,  // JWT typically uses Bearer scheme
            credentials: {
                token
            }
        };
        this.apiClient.setAuthentication(authConfig);
        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }
        CSReporter.info('JWT authentication configured');
    }

    @CSBDDStepDef("I use digest authentication with username {string} and password {string}")
    async useDigestAuth(username: string, password: string): Promise<void> {
        const authConfig: CSAuthConfig = {
            type: 'digest' as CSAuthType,
            credentials: {
                username,
                password
            }
        };
        this.apiClient.setAuthentication(authConfig);
        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }
        CSReporter.info(`Digest authentication configured for user: ${username}`);
    }

    @CSBDDStepDef("I use NTLM authentication with domain {string} username {string} and password {string}")
    async useNTLMAuth(domain: string, username: string, password: string): Promise<void> {
        const authConfig: CSAuthConfig = {
            type: 'ntlm' as CSAuthType,
            credentials: {
                domain,
                username,
                password
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info(`NTLM authentication configured for ${domain}\\${username}`);
    }


    @CSBDDStepDef("I use certificate authentication with cert {string} and key {string}")
    async useCertificateAuth(certPath: string, keyPath: string): Promise<void> {
        const authConfig: CSAuthConfig = {
            type: 'certificate' as CSAuthType,
            credentials: {
                certificate: certPath,
                privateKey: keyPath
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('Certificate authentication configured');
    }

    @CSBDDStepDef("user loads certificate from {string} with password {string}")
    async loadCertificateWithPassword(certificatePath: string, password: string): Promise<void> {
        // Both path and password are already resolved by the framework (decrypted and variables substituted)

        const authConfig: CSAuthConfig = {
            type: 'certificate' as CSAuthType,
            credentials: {
                certificate: certificatePath,
                password: password
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info(`Certificate loaded from: ${certificatePath}`);
    }

    // ================== Ping Identity Authentication Steps ==================

    @CSBDDStepDef("I use Ping Identity with client credentials:")
    async usePingClientCredentials(dataTable: any): Promise<void> {
        const rows = dataTable.raw();
        const config: any = {};

        for (const [key, value] of rows) {
            config[key] = value;
        }

        const pingConfig: CSPingAuthConfig = {
            baseUrl: config.baseUrl || config.issuerUrl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            grantType: 'client_credentials',
            scope: config.scope,
            environmentId: config.environmentId,
            productType: config.productType || 'auto',
            tokenAuthMethod: config.tokenAuthMethod || 'client_secret_basic',
            tokenEndpoint: config.tokenEndpoint,
            skipSslVerification: config.skipSslVerification === 'true'
        };

        this.pingHandler = new CSPingAuthHandler(pingConfig);

        // Register with manager for later access
        pingAuthManager.createHandler('default', pingConfig);

        const authConfig: CSAuthConfig = {
            type: 'ping' as CSAuthType,
            credentials: {
                clientId: config.clientId,
                clientSecret: config.clientSecret
            },
            options: {
                grantType: 'client_credentials',
                pingIssuerUrl: config.baseUrl || config.issuerUrl,
                pingEnvironmentId: config.environmentId,
                pingProvider: config.productType,
                scope: config.scope,
                tokenUrl: config.tokenEndpoint
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('Ping Identity client credentials authentication configured');
    }

    @CSBDDStepDef("I use Ping Identity with password grant:")
    async usePingPasswordGrant(dataTable: any): Promise<void> {
        const rows = dataTable.raw();
        const config: any = {};

        for (const [key, value] of rows) {
            config[key] = value;
        }

        const pingConfig: CSPingAuthConfig = {
            baseUrl: config.baseUrl || config.issuerUrl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            username: config.username,
            password: config.password,
            grantType: 'password',
            scope: config.scope,
            environmentId: config.environmentId,
            productType: config.productType || 'auto',
            tokenAuthMethod: config.tokenAuthMethod || 'client_secret_basic',
            tokenEndpoint: config.tokenEndpoint,
            skipSslVerification: config.skipSslVerification === 'true'
        };

        this.pingHandler = new CSPingAuthHandler(pingConfig);
        pingAuthManager.createHandler('default', pingConfig);

        const authConfig: CSAuthConfig = {
            type: 'ping' as CSAuthType,
            credentials: {
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                username: config.username,
                password: config.password
            },
            options: {
                grantType: 'password',
                pingIssuerUrl: config.baseUrl || config.issuerUrl,
                pingEnvironmentId: config.environmentId,
                pingProvider: config.productType,
                scope: config.scope,
                tokenUrl: config.tokenEndpoint
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('Ping Identity password grant authentication configured');
    }

    @CSBDDStepDef("I use PingFederate authentication with base URL {string} client ID {string} and client secret {string}")
    async usePingFederateAuth(baseUrl: string, clientId: string, clientSecret: string): Promise<void> {
        const pingConfig: CSPingAuthConfig = {
            baseUrl,
            clientId,
            clientSecret,
            grantType: 'client_credentials',
            productType: 'pingfederate',
            tokenAuthMethod: 'client_secret_basic'
        };

        this.pingHandler = new CSPingAuthHandler(pingConfig);
        pingAuthManager.createHandler('pingfederate', pingConfig);

        const authConfig: CSAuthConfig = {
            type: 'ping' as CSAuthType,
            credentials: {
                clientId,
                clientSecret
            },
            options: {
                grantType: 'client_credentials',
                pingIssuerUrl: baseUrl,
                pingProvider: 'pingfederate'
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info(`PingFederate authentication configured for: ${baseUrl}`);
    }

    @CSBDDStepDef("I use PingOne authentication with environment {string} client ID {string} and client secret {string}")
    async usePingOneAuth(environmentId: string, clientId: string, clientSecret: string): Promise<void> {
        const baseUrl = 'https://auth.pingone.com';

        const pingConfig: CSPingAuthConfig = {
            baseUrl,
            clientId,
            clientSecret,
            environmentId,
            grantType: 'client_credentials',
            productType: 'pingone',
            tokenAuthMethod: 'client_secret_basic'
        };

        this.pingHandler = new CSPingAuthHandler(pingConfig);
        pingAuthManager.createHandler('pingone', pingConfig);

        const authConfig: CSAuthConfig = {
            type: 'ping' as CSAuthType,
            credentials: {
                clientId,
                clientSecret
            },
            options: {
                grantType: 'client_credentials',
                pingIssuerUrl: baseUrl,
                pingEnvironmentId: environmentId,
                pingProvider: 'pingone'
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info(`PingOne authentication configured for environment: ${environmentId}`);
    }

    @CSBDDStepDef("I use Ping Identity with PKCE:")
    async usePingWithPKCE(dataTable: any): Promise<void> {
        const rows = dataTable.raw();
        const config: any = {};

        for (const [key, value] of rows) {
            config[key] = value;
        }

        const pingConfig: CSPingAuthConfig = {
            baseUrl: config.baseUrl || config.issuerUrl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            grantType: 'authorization_code',
            redirectUri: config.redirectUri,
            scope: config.scope,
            environmentId: config.environmentId,
            productType: config.productType || 'auto',
            pkce: true,
            codeChallengeMethod: (config.codeChallengeMethod as 'plain' | 'S256') || 'S256',
            tokenEndpoint: config.tokenEndpoint,
            authorizationEndpoint: config.authorizationEndpoint,
            skipSslVerification: config.skipSslVerification === 'true'
        };

        this.pingHandler = new CSPingAuthHandler(pingConfig);
        pingAuthManager.createHandler('pkce', pingConfig);

        const authConfig: CSAuthConfig = {
            type: 'ping' as CSAuthType,
            credentials: {
                clientId: config.clientId,
                clientSecret: config.clientSecret
            },
            options: {
                grantType: 'authorization_code',
                pingIssuerUrl: config.baseUrl || config.issuerUrl,
                pingEnvironmentId: config.environmentId,
                pingProvider: config.productType,
                pingUsePkce: true,
                codeChallengeMethod: config.codeChallengeMethod || 'S256',
                scope: config.scope,
                redirectUri: config.redirectUri
            }
        };

        this.apiClient.setAuthentication(authConfig);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = authConfig;
        }

        CSReporter.info('Ping Identity authentication with PKCE configured');
    }

    @CSBDDStepDef("I get Ping Identity authorization URL")
    async getPingAuthorizationUrl(): Promise<string> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const authUrl = await this.pingHandler.getAuthorizationUrl();

        // Store in context for later use
        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.setVariable('pingAuthorizationUrl', authUrl);
        }

        CSReporter.info(`Ping authorization URL: ${authUrl}`);
        return authUrl;
    }

    @CSBDDStepDef("I exchange Ping authorization code {string} for token")
    async exchangePingCodeForToken(code: string): Promise<void> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const token = await this.pingHandler.exchangeCodeForToken(code);

        // Store token in context
        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.setVariable('pingAccessToken', token.accessToken);
            if (token.refreshToken) {
                context.setVariable('pingRefreshToken', token.refreshToken);
            }
            if (token.idToken) {
                context.setVariable('pingIdToken', token.idToken);
            }
        }

        CSReporter.info('Ping authorization code exchanged for tokens');
    }

    @CSBDDStepDef("I get Ping Identity access token")
    async getPingAccessToken(): Promise<string> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const token = await this.pingHandler.getAccessToken();

        // Store in context
        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.setVariable('pingAccessToken', token);
        }

        CSReporter.info('Ping access token obtained');
        return token;
    }

    @CSBDDStepDef("I refresh Ping Identity access token")
    async refreshPingAccessToken(): Promise<void> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const token = await this.pingHandler.getAccessToken(true); // Force refresh

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.setVariable('pingAccessToken', token);
        }

        CSReporter.info('Ping access token refreshed');
    }

    @CSBDDStepDef("I introspect Ping Identity token")
    async introspectPingToken(): Promise<any> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const result = await this.pingHandler.introspectToken();

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.setVariable('pingTokenIntrospection', result);
        }

        CSReporter.info(`Ping token introspection: active=${result.active}`);
        return result;
    }

    @CSBDDStepDef("I validate Ping Identity token is active")
    async validatePingTokenActive(): Promise<void> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const isValid = await this.pingHandler.validateToken();

        if (!isValid) {
            throw new Error('Ping Identity token is not active or has expired');
        }

        CSReporter.info('Ping Identity token is active and valid');
    }

    @CSBDDStepDef("I revoke Ping Identity token")
    async revokePingToken(): Promise<void> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        await this.pingHandler.revokeToken();
        CSReporter.info('Ping Identity token revoked');
    }

    @CSBDDStepDef("I clear Ping Identity token cache")
    async clearPingTokenCache(): Promise<void> {
        if (this.pingHandler) {
            this.pingHandler.clearCache();
        }
        pingAuthManager.clearAll();
        CSReporter.info('Ping Identity token cache cleared');
    }

    @CSBDDStepDef("I use Ping Identity handler {string}")
    async usePingHandler(handlerName: string): Promise<void> {
        const handler = pingAuthManager.getHandler(handlerName);

        if (!handler) {
            throw new Error(`Ping Identity handler '${handlerName}' not found`);
        }

        this.pingHandler = handler;
        CSReporter.info(`Using Ping Identity handler: ${handlerName}`);
    }

    @CSBDDStepDef("I set Ping Identity scope {string}")
    async setPingScope(scope: string): Promise<void> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        this.pingHandler.updateConfig({ scope });
        CSReporter.info(`Ping Identity scope updated: ${scope}`);
    }

    @CSBDDStepDef("I set Ping Identity additional parameters:")
    async setPingAdditionalParams(dataTable: any): Promise<void> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const rows = dataTable.raw();
        const additionalParams: Record<string, string> = {};

        for (const [key, value] of rows) {
            additionalParams[key] = value;
        }

        this.pingHandler.updateConfig({ additionalParams });
        CSReporter.info('Ping Identity additional parameters configured');
    }

    @CSBDDStepDef("I discover Ping Identity endpoints")
    async discoverPingEndpoints(): Promise<void> {
        if (!this.pingHandler) {
            throw new Error('Ping Identity authentication must be configured first');
        }

        const discovery = await this.pingHandler.discoverEndpoints();

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.setVariable('pingDiscovery', discovery);
            context.setVariable('pingTokenEndpoint', discovery.token_endpoint);
            context.setVariable('pingAuthorizationEndpoint', discovery.authorization_endpoint);
            if (discovery.introspection_endpoint) {
                context.setVariable('pingIntrospectionEndpoint', discovery.introspection_endpoint);
            }
            if (discovery.revocation_endpoint) {
                context.setVariable('pingRevocationEndpoint', discovery.revocation_endpoint);
            }
        }

        CSReporter.info(`Ping Identity endpoints discovered from: ${discovery.issuer}`);
    }

    // ================== End of Ping Identity Steps ==================

    @CSBDDStepDef("I clear authentication")
    async clearAuthentication(): Promise<void> {
        this.apiClient.clearAuthentication();

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.auth = undefined;
        }

        CSReporter.info('Authentication cleared');
    }

    @CSBDDStepDef("I add custom authentication header {string} with value {string}")
    async addCustomAuthHeader(headerName: string, headerValue: string): Promise<void> {
        // headerValue is already resolved by the framework (decrypted and variables substituted)

        this.apiClient.setDefaultHeader(headerName, headerValue);

        const context = this.contextManager.getCurrentContext();
        if (context) {
            context.setHeader(headerName, headerValue);
        }

        CSReporter.info(`Custom authentication header added: ${headerName}`);
    }

}