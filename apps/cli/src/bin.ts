#!/usr/bin/env node
/**
 * Placeholder entry point for the `friday` CLI (M0 skeleton).
 * The real command set (init, run, status, doctor, task, harness config, ...) arrives in M1.
 */
import { PACKAGE_NAME } from './index.js';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('friday 0.0.0');
} else {
  console.log(`friday 0.0.0 (${PACKAGE_NAME}) - M0 skeleton. Commands arrive in M1; see docs/BUILD_PLAN.md.`);
}
