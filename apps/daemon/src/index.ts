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
export { createDaemon, type Daemon, type DaemonContext, type DaemonOptions } from './daemon.js';
export { GraphService } from './graph-service.js';
export { createLogger, type Level, type Logger, silentLogger } from './log.js';
export { type AuthInfo, callerFor, dispatchRpc } from './rpc.js';
