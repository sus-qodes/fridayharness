/**
 * @friday/cli
 * The friday command-line interface.
 */
export const PACKAGE_NAME = '@friday/cli';

import './plugins.js';

export { type ChildSpec, cliEntry, createAgentLauncher, harnessKeyOf, type LauncherOptions } from './agent-launcher.js';
export { AgentProfiles, optionFlags, validateOptions } from './agent-profiles.js';
export { claudeSetupExtension } from './claude-setup-ext.js';
export { type GlobalOptions, UsageError } from './context.js';
export { type CheckResult, doctor, extraDoctorChecks, renderDoctor } from './doctor.js';
export { FIXTURE_SHOP_PROJECT_ID, fixtureShopSource, materializeFixtureShop } from './fixture.js';
export { openTarget, runningDaemon, setOpener, startDetached } from './open-link.js';
export { lineDiff } from './plugins.js';
export { buildProgram, commandPlugins, runCli } from './program.js';
export { daemonPlugins, runDaemon, uiBundleDir } from './run.js';
export { createShortcut } from './shortcut.js';
export { FRIDAY_DIR_GITIGNORE, FRIDAY_RUNTIME_PATHS, FRIDAY_TRACKED_PATHS } from './templates.js';
