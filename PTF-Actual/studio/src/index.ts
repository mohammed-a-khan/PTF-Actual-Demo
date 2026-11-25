/** Public API of the CS Test Studio core services. */
export { GitService, explainGitFailure } from './git/service';
export type { GateResult, Override, BranchInfo } from './git/service';
export { installHooks, uninstallHooks } from './git/hooks';
export { scanLines, scanPath, toPublic, findingsDigest } from './scanner/scanner';
export { scanStaged, scanUnpushed } from './scanner/gitScan';
export { readPolicy } from './scanner/policy';
export { SecretStore, secretsAsEnv } from './secrets/store';
export { defaultProtector, KeyFileProtector, DpapiProtector } from './secrets/protector';
export { studioHome } from './core/paths';
export { createServer } from './server/server';
export { discover, fileLayerPaths } from './env/layers';
export { resolveConfig, compareEnvironments, isSensitiveKey } from './env/resolve';
export { setValue, removeKey, storeSecret, createEnvironment } from './env/edit';
export { ActivityLog } from './core/activity';
