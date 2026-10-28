/** Bundle entry for `dist/hook.mjs`: runs the launcher and exits with its code. */
import { main } from './launcher.js';

process.exitCode = await main();
