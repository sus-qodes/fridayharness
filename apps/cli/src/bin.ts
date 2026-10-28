#!/usr/bin/env node
/** Entry point of the `friday` command. */
import './plugins.js';
import { runCli } from './program.js';

const code = await runCli(process.argv);
// Long-running commands (run, events tail --follow) resolve only when they are done.
process.exitCode = code;
