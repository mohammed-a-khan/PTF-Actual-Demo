/**
 * CI/CD Environment Detector
 * Detects if running in CI pipeline and identifies the provider
 * @module suite/CSCIDetector
 */

/**
 * Supported CI provider types
 */
export type CIProvider =
    | 'Azure DevOps'
    | 'GitHub Actions'
    | 'Jenkins'
    | 'GitLab CI'
    | 'CircleCI'
    | 'Travis CI'
    | 'Unknown CI'
    | 'Local';

/**
 * CI/CD Environment Detector
 * Provides static methods to detect CI environment and provider
 */
export class CSCIDetector {

    /**
     * Check if running in any CI/CD environment
     * Checks various CI-specific environment variables
     * @returns true if running in CI, false otherwise
     */
    public static isCI(): boolean {
        return !!(
            process.env.CI ||                                  // Generic CI flag (used by most CI systems)
            process.env.TF_BUILD ||                            // Azure DevOps
            process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI ||  // Azure DevOps
            process.env.BUILD_BUILDID ||                       // Azure DevOps
            process.env.GITHUB_ACTIONS ||                      // GitHub Actions
            process.env.JENKINS_URL ||                         // Jenkins
            process.env.GITLAB_CI ||                           // GitLab CI
            process.env.CIRCLECI ||                            // CircleCI
            process.env.TRAVIS ||                              // Travis CI
            process.env.BITBUCKET_BUILD_NUMBER ||              // Bitbucket Pipelines
            process.env.TEAMCITY_VERSION                       // TeamCity
        );
    }

    /**
     * Check if running in Azure DevOps specifically
     * @returns true if running in Azure DevOps pipeline
     */
    public static isAzureDevOps(): boolean {
        return !!(
            process.env.TF_BUILD ||
            process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI ||
            process.env.BUILD_BUILDID ||
            process.env.AGENT_ID  // ADO build agent
        );
    }

    /**
     * Check if running in GitHub Actions specifically
     * @returns true if running in GitHub Actions
     */
    public static isGitHubActions(): boolean {
        return !!(process.env.GITHUB_ACTIONS || process.env.GITHUB_WORKSPACE);
    }

    /**
     * Check if running in Jenkins specifically
     * @returns true if running in Jenkins
     */
    public static isJenkins(): boolean {
        return !!(process.env.JENKINS_URL || process.env.JENKINS_HOME);
    }

    /**
     * Get the detected CI provider name
     * @returns CI provider name or 'Local' if not in CI
     */
    public static getProvider(): CIProvider {
        // Azure DevOps
        if (process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI ||
            process.env.BUILD_BUILDID ||
            process.env.TF_BUILD ||
            process.env.AGENT_ID) {
            return 'Azure DevOps';
        }

        // GitHub Actions
        if (process.env.GITHUB_ACTIONS || process.env.GITHUB_WORKSPACE) {
            return 'GitHub Actions';
        }

        // Jenkins
        if (process.env.JENKINS_URL || process.env.JENKINS_HOME) {
            return 'Jenkins';
        }

        // GitLab CI
        if (process.env.GITLAB_CI) {
            return 'GitLab CI';
        }

        // CircleCI
        if (process.env.CIRCLECI) {
            return 'CircleCI';
        }

        // Travis CI
        if (process.env.TRAVIS) {
            return 'Travis CI';
        }

        // Generic CI flag set but provider unknown
        if (process.env.CI) {
            return 'Unknown CI';
        }

        // Not in CI
        return 'Local';
    }

    /**
     * Get build information from CI environment
     * @returns Object with build details or null if not in CI
     */
    public static getBuildInfo(): { buildId: string; buildNumber: string; branch: string } | null {
        if (!this.isCI()) {
            return null;
        }

        // Azure DevOps
        if (this.isAzureDevOps()) {
            return {
                buildId: process.env.BUILD_BUILDID || '',
                buildNumber: process.env.BUILD_BUILDNUMBER || '',
                branch: process.env.BUILD_SOURCEBRANCH || ''
            };
        }

        // GitHub Actions
        if (this.isGitHubActions()) {
            return {
                buildId: process.env.GITHUB_RUN_ID || '',
                buildNumber: process.env.GITHUB_RUN_NUMBER || '',
                branch: process.env.GITHUB_REF || ''
            };
        }

        // Jenkins
        if (this.isJenkins()) {
            return {
                buildId: process.env.BUILD_ID || '',
                buildNumber: process.env.BUILD_NUMBER || '',
                branch: process.env.GIT_BRANCH || process.env.BRANCH_NAME || ''
            };
        }

        // Generic fallback
        return {
            buildId: process.env.BUILD_ID || 'unknown',
            buildNumber: process.env.BUILD_NUMBER || '0',
            branch: process.env.BRANCH || 'unknown'
        };
    }
}

export default CSCIDetector;
