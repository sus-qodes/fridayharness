#!/usr/bin/env node
// A scripted stand-in for Antigravity's CLI `agy`, for tests: it answers `--version` and nothing
// else, and never starts a conversation, signs in or calls a model. The real output format of
// `agy --version` is not documented; Friday reads the first x.y.z it prints. The version printed
// is FAKE_AGY_VERSION, else 1.4.2.
const version = process.env.FAKE_AGY_VERSION || '1.4.2';
if (process.argv.includes('--version')) {
  process.stdout.write(`agy ${version}\n`);
  process.exit(0);
}
process.stderr.write('fake-agy: only --version is scripted\n');
process.exit(2);
