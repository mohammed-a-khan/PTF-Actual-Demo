import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSAPIClient } from '../../api/CSAPIClient';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSAuthConfig, CSAuthType } from '../../api/types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSAPIAuthenticationSteps {
    private apiClient: CSAPIClient;
    private contextManager: CSApiContextManager;

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