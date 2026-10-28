/**
 * @friday/cli
 * The friday command-line interface.
 */
export const PACKAGE_NAME = '@friday/cli';

export { type GlobalOptions, UsageError } from './context.js';
export { type CheckResult, doctor, extraDoctorChecks, renderDoctor } from './doctor.js';
export { buildProgram, commandPlugins, runCli } from './program.js';
export { daemonPlugins, runDaemon } from './run.js';
export { FRIDAY_DIR_GITIGNORE, FRIDAY_RUNTIME_PATHS, FRIDAY_TRACKED_PATHS } from './templates.js';
