/**
 * @friday/daemon
 * The Friday daemon (`friday run`): REST API, harness protocol, status page, lease manager.
 */
export const PACKAGE_NAME = '@friday/daemon';

export { type AppDeps, buildApp } from './app.js';
export { type CompileInput, compileContext, withStaleness } from './context.js';
export { createDaemon, type Daemon, type DaemonContext, type DaemonOptions } from './daemon.js';
export { createLogger, type Level, type Logger, silentLogger } from './log.js';
export { type AuthInfo, callerFor, dispatchRpc } from './rpc.js';
