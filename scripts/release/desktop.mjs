#!/usr/bin/env node
/**
 * The copy of Friday the desktop installer carries (2026-11-19, the fix list's G3: "an installer for
 * other computers"). The desktop app found Friday's files only in the checkout it was built from
 * (or FRIDAY_HOME, or install.json): on any other computer it asked where Friday was installed.
 *
 * `pnpm pack:desktop` makes the install archive as `pnpm pack:release` does (and, unless told not
 * to, proves it installs and starts), then installs it into
 * apps/desktop/src-tauri/target/friday-bundle, the folder the release configuration
 * (apps/desktop/src-tauri/Tauri.release.toml) gives the installer as `friday\`. The app looks there
 * first (`daemon::bundled_home`).
 *
 * Node.js is not carried: the agents' hooks in every project run `node` by its name, so it has to be
 * on the computer anyway; the app sends a person without it to its download page. Compiled add-ons
 * are left out (better-sqlite3): a running Friday keeps one locked, so an update could not replace
 * it, and Friday then uses the SQLite built into Node.js.
 *
 * Flags: --no-build reuses the built packages; --no-verify skips the archive's install test.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { npm, pack, REPO_ROOT, run } from './pack.mjs';

export const BUNDLE_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'friday-bundle');
/** Where the archive's package sits in the bundle: what the app takes for Friday's home. */
export const BUNDLE_HOME = path.join(BUNDLE_DIR, 'node_modules', 'friday');

/** Compiled add-ons Friday can do without, and what it uses instead. */
const LEFT_OUT = { 'better-sqlite3': 'the SQLite built into Node.js' };

/** Every file under a folder: how many, how big, and the compiled add-ons (`*.node`) among them. */
function survey(dir) {
  const out = { files: 0, bytes: 0, native: [] };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        out.files += 1;
        out.bytes += statSync(p).size;
        if (e.name.endsWith('.node')) out.native.push(path.relative(dir, p).replaceAll('\\', '/'));
      }
    }
  };
  walk(dir);
  return out;
}

/** Every folder named `name` under a node_modules tree. */
function packageDirs(root, name) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 8 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name === name && path.basename(d) === 'node_modules') found.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** `friday start` from the bundle in a new git repository, its status read, then stopped. */
async function tryBundle(launcher, log) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'friday-bundle-'));
  const repo = path.join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, FRIDAY_STATE_DIR: path.join(tmp, 'state'), NO_COLOR: '1' };
  delete env.FRIDAY_SQLITE_DRIVER;
  const friday = (args) =>
    run(process.execPath, [launcher, ...args], { cwd: repo, env, okFail: true, timeout: 120_000 });
  let pid = null;
  try {
    run('git', ['init', '-q'], { cwd: repo });
    const started = friday(['--json', 'start', '--no-open']);
    const out = JSON.parse(started.stdout.slice(started.stdout.indexOf('{')) || '{}');
    if (started.status !== 0 || out.started !== true) {
      throw new Error(`Friday did not start from the bundle: ${started.stderr.trim().split('\n').slice(-4).join(' ')}`);
    }
    pid = out.pid;
    const status = friday(['--json', 'status']);
    if (status.status !== 0) throw new Error(`friday status failed from the bundle: ${status.stderr.trim()}`);
    friday(['daemon', 'stop']);
    pid = null;
    log('ok   Friday starts from the bundle, without better-sqlite3, and stops');
  } finally {
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

export async function desktopBundle({
  build = true,
  verify = true,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const { archive, version } = await pack({ build, verify, log });
  rmSync(BUNDLE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  log(`installing ${path.basename(archive)} into ${path.relative(REPO_ROOT, BUNDLE_DIR)}`);
  npm(['install', '-g', '--prefix', BUNDLE_DIR, '--no-fund', '--no-audit', '--loglevel', 'error', archive], {
    cwd: REPO_ROOT,
  });
  if (!existsSync(path.join(BUNDLE_HOME, 'apps', 'cli', 'bin', 'friday.mjs'))) {
    throw new Error(`the archive did not install as expected: no ${BUNDLE_HOME}\\apps\\cli\\bin\\friday.mjs`);
  }
  // npm's command shims are for a terminal; the app starts Friday's launcher itself.
  for (const e of readdirSync(BUNDLE_DIR, { withFileTypes: true })) {
    if (e.isFile()) rmSync(path.join(BUNDLE_DIR, e.name));
  }
  for (const [name, instead] of Object.entries(LEFT_OUT)) {
    for (const dir of packageDirs(BUNDLE_DIR, name)) {
      rmSync(dir, { recursive: true, force: true });
      log(`left out ${name} (${path.relative(BUNDLE_DIR, dir).replaceAll('\\', '/')}): Friday uses ${instead}`);
    }
  }
  const s = survey(BUNDLE_DIR);
  if (s.native.length) {
    throw new Error(
      `compiled add-ons are left in the bundle, which a running Friday would keep locked during an update: ${s.native.join(', ')}`,
    );
  }
  // The copy runs as the installed app will run it: its version, and Friday started on a new
  // project with a database that has no better-sqlite3, answering, then stopped.
  const launcher = path.join(BUNDLE_HOME, 'apps', 'cli', 'bin', 'friday.mjs');
  const v = run(process.execPath, [launcher, '--version'], { cwd: BUNDLE_DIR });
  if (v.stdout.trim() !== version) throw new Error(`the bundled friday says ${v.stdout.trim()}, not ${version}`);
  if (verify) await tryBundle(launcher, log);
  writeFileSync(
    path.join(BUNDLE_DIR, 'bundle.json'),
    `${JSON.stringify({ friday_version: version, built_at: new Date().toISOString(), files: s.files, bytes: s.bytes }, null, 2)}\n`,
  );
  log(`bundle ready: Friday ${version}, ${s.files} files, ${Math.round(s.bytes / 1024 / 1024)} MB`);
  return { version, dir: BUNDLE_DIR, home: BUNDLE_HOME, files: s.files, bytes: s.bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = new Set(process.argv.slice(2));
  const r = await desktopBundle({ build: !flags.has('--no-build'), verify: !flags.has('--no-verify') });
  process.stdout.write(
    `${path.relative(REPO_ROOT, r.dir)}: Friday ${r.version} for the desktop installer. Build it with:\n  FRIDAY_RELEASE=1 cargo tauri build --config Tauri.release.toml   (in apps/desktop/src-tauri)\n`,
  );
}
