/**
 * @friday/sdk
 * Project discovery, configuration, the daemon HTTP/RPC client, SSE parsing and context rendering.
 * Shared by the CLI, the MCP server, the hook launcher and the adapters.
 */
export const PACKAGE_NAME = '@friday/sdk';
export const FRIDAY_VERSION = '0.1.0';

export {
  type AccessReport,
  allowedPrincipals,
  checkFolderAccess,
  checkPrivateAccess,
  currentUserSid,
  protectPrivateDir,
  resetAccessCache,
} from './access.js';
export { DaemonClient, type DaemonClientOptions, DaemonUnreachableError, type RequestOptions } from './client.js';
export {
  ApprovalSettings,
  type CheckConfig,
  EnvName,
  ExecutionSettings,
  FridayConfig,
  loadConfig,
  type MasterBrainConfig,
  McpSettings,
  OPERATION_NAME,
  OperationSpec,
  type ProviderConfig,
  parseConfig,
  policyVersion,
  RoutingSettings,
  renderInitialConfig,
} from './config.js';
export {
  CONFIG_FILE,
  checkoutRoot,
  type DaemonDiscovery,
  ensurePrivateDir,
  FRIDAY_DIR,
  findProjectRoot,
  type InstallInfo,
  type LocalTokenClass,
  loadProject,
  type ProjectRef,
  privateDirFor,
  projectKey,
  readDiscovery,
  readInstallInfo,
  readToken,
  stateDir,
  writePrivateFile,
} from './discovery.js';
export { dpapiAvailable } from './dpapi.js';
export {
  POLICY_DIR,
  PolicyFile,
  type PolicySourceData,
  readPolicySources,
  readPolicyTrust,
  writePolicyTrust,
} from './policy-files.js';
export {
  approveProvider,
  type ProviderApproval,
  providerApproval,
  providerEndpoint,
  revokeProvider,
  setProviderEndpoint,
} from './provider-trust.js';
export { renderContextMarkdown } from './render.js';
export {
  credentialsDir,
  hasSecret,
  listSecrets,
  removeSecret,
  resolveSecret,
  type SecretProtection,
  secretProtection,
  storeSecret,
} from './secrets.js';
export { formatSse, type SseMessage, SseParser } from './sse.js';
