#!/usr/bin/env node
/** Entry point of the `friday` command. */
import './plugins.js';
import { runCli } from './program.js';

// Windows looks for a program started by its bare name (git, explorer.exe) in the current folder
// before PATH. Friday runs inside repositories, whose content it does not trust: it never looks
// there, nor do the daemon and the processes it starts (LESSONS D-52).
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

const code = await runCli(process.argv);
// Long-running commands (run, events tail --follow) resolve only when they are done.
process.exitCode = code;
