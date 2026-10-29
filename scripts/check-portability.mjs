#!/usr/bin/env node
/**
 * Portability gate (build plan E.3). Runs locally and in CI on tracked/staged files; with
 * `--working-tree` it also checks untracked files git does not ignore, so a new file is caught
 * before it is staged (M3.1):
 *  - no shell scripts (*.sh) in the repository
 *  - no executable bits or symlinks in the index
 *  - every text file stored with LF (except *.cmd / *.bat)
 *  - no NUL byte in a text file (git would treat it as binary and hide its diffs)
 *  - no `localhost` literal in source (use 127.0.0.1); add `portability-allow: localhost` on a line to exempt it
 *  - no POSIX-only constructs in package.json scripts (rm -rf, VAR=value prefixes, $VAR, export)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const problems = [];
const workingTree = process.argv.includes('--working-tree');
// Files deleted in the working tree but not yet staged are skipped.
const files = git('ls-files', '-z', ...(workingTree ? ['-c', '-o', '--exclude-standard'] : []))
  .split('\0')
  .filter((f, i, all) => f && all.indexOf(f) === i && existsSync(path.join(root, f)));
const untracked = new Set(
  workingTree ? git('ls-files', '-z', '-o', '--exclude-standard').split('\0').filter(Boolean) : [],
);

// 0. untracked files: the index checks below cannot see them
const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|yml|yaml|txt|html|css)$/i;
for (const f of untracked) {
  const abs = path.join(root, f);
  if (!existsSync(abs)) continue;
  if (lstatSync(abs).isSymbolicLink()) problems.push(`${f}: symlinks are not allowed (Windows)`);
  else if (TEXT.test(f) && readFileSync(abs, 'utf8').includes('\r\n')) problems.push(`${f}: CRLF line endings`);
}

// 1. shell scripts
for (const f of files)
  if (f.endsWith('.sh')) problems.push(`${f}: shell scripts are not allowed; write a Node .mjs script`);

// 2. modes
for (const line of git('ls-files', '-s').split('\n').filter(Boolean)) {
  const [mode, , , file] = line.split(/\s+/, 4);
  if (mode === '100755') problems.push(`${file}: executable bit set in the index`);
  if (mode === '120000') problems.push(`${file}: symlinks are not allowed (Windows)`);
}

// 3. line endings stored in the index
for (const line of git('ls-files', '--eol').split('\n').filter(Boolean)) {
  const match = line.match(/^i\/(\S+)\s+w\/\S+\s+attr\/.*?\t(.+)$/);
  if (!match) continue;
  const [, indexEol, file] = match;
  if (/\.(cmd|bat)$/i.test(file)) continue;
  if (indexEol === 'crlf' || indexEol === 'mixed') problems.push(`${file}: stored with ${indexEol} line endings`);
}

// 3b. NUL bytes in text files (a literal NUL typed through a shell instead of the escape \0)
for (const f of files) {
  if (TEXT.test(f) && readFileSync(path.join(root, f)).includes(0)) {
    problems.push(`${f}: contains a NUL byte; git treats the file as binary (write the escape \\0 instead)`);
  }
}

// 4. localhost literal in source
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json)$/;
const SOURCE_DIRS = ['apps/', 'packages/', 'tests/', 'scripts/'];
for (const f of files) {
  if (!SOURCE.test(f) || !SOURCE_DIRS.some((d) => f.startsWith(d))) continue;
  if (f === 'scripts/check-portability.mjs') continue;
  const lines = readFileSync(path.join(root, f), 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (/\blocalhost\b/.test(text) && !text.includes('portability-allow: localhost')) {
      problems.push(`${f}:${i + 1}: use 127.0.0.1 instead of localhost`);
    }
  });
}

// 5. package.json scripts
const POSIX_ONLY = [
  [/\brm\s+-[rf]+/, 'rm -rf'],
  [/(^|&&|;)\s*[A-Z_][A-Z0-9_]*=\S+\s+\S/, 'VAR=value prefix'],
  [/\$[A-Za-z_][A-Za-z0-9_]*/, '$VAR expansion'],
  [/(^|&&|;)\s*export\s/, 'export'],
];
for (const f of files) {
  if (path.basename(f) !== 'package.json') continue;
  const { scripts = {} } = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const [re, label] of POSIX_ONLY) {
      if (re.test(cmd)) problems.push(`${f}: script "${name}" uses ${label}, which fails under cmd.exe`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Portability check failed (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `Portability check passed (${files.length} files${workingTree ? `, ${untracked.size} untracked` : ', all tracked'}).`,
);
