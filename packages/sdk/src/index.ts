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
  checkPrivateAccess,
  currentUserSid,
  protectPrivateDir,
  resetAccessCache,
} from './access.js';
export { DaemonClient, type DaemonClientOptions, DaemonUnreachableError, type RequestOptions } from './client.js';
export {
  type CheckConfig,
  FridayConfig,
  loadConfig,
  type MasterBrainConfig,
  type ProviderConfig,
  parseConfig,
  renderInitialConfig,
} from './config.js';
export {
  CONFIG_FILE,
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
export {
  approveProvider,
  type ProviderApproval,
  providerApproval,
  providerEndpoint,
  revokeProvider,
  setProviderEndpoint,
} from './provider-trust.js';
export { renderContextMarkdown } from './render.js';
export { credentialsDir, listSecrets, readSecret, removeSecret, writeSecret } from './secrets.js';
export { formatSse, type SseMessage, SseParser } from './sse.js';
