/**
 * @friday/daemon
 * The Friday daemon (`friday run`): REST API, harness protocol, status page, lease manager.
 */
export const PACKAGE_NAME = '@friday/daemon';

export { type AppDeps, type AppEnv, buildApp } from './app.js';
export { type BrainHandle, type BrainStatus, createMasterBrain } from './brain.js';
export { buildBrainContext } from './brain-context.js';
export { escalationView } from './brain-routes.js';
export { type CompileInput, type ContextService, createContextService } from './context.js';
export { ControlManager } from './control.js';
export { createDaemon, type Daemon, type DaemonContext, type DaemonOptions } from './daemon.js';
export { countMatches, listFiles } from './files.js';
export { GraphService } from './graph-service.js';
export { createLogger, type Level, type Logger, silentLogger } from './log.js';
export { type AuthInfo, callerFor, dispatchRpc } from './rpc.js';
export { DIFF_FILE_CAP, DIFF_SIDE_CAP, DIFF_TOTAL_CAP, goalDiff, readWorkingFile, taskDiff } from './task-diff.js';
export { LOGIN_CODE_TTL_MS, MAX_OUTSTANDING_CODES, UI_SESSION_MAX_AGE_MS, UiAuth } from './ui-auth.js';
export { UI_PREFS_FILE, UI_PREFS_MAX_BYTES, UiPrefs } from './ui-prefs.js';
export { buildUiSnapshot, fileHasher, SNAPSHOT_CAPS, UI_API_VERSION, type UiSnapshotInfo } from './ui-snapshot.js';
export {
  openUiBundle,
  readBundleFile,
  SELF_REMOVING_WORKER,
  UI_SECURITY_HEADERS,
  type UiBundle,
  uiPath,
} from './ui-static.js';
