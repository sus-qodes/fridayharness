#!/usr/bin/env node
/**
 * Friday's install archive (plan M12.5). `pnpm pack:release` builds every package, bundles the CLI
 * (the daemon runs inside it) and the MCP server with esbuild, lays them out as one package named
 * `friday`, and runs `npm pack`: the result is dist-release/friday-<version>.tgz, installed with
 * `npm install -g ./friday-<version>.tgz` on a machine that has Node and Git and nothing else of
 * Friday. The script then installs the archive into a temporary npm prefix and runs
 * `friday --version`, `friday setup` and `friday start` in a temporary git repository, so an
 * archive is known to work before anyone installs it. Nothing is published.
 *
 * The archive keeps the repository's layout, so every path a module resolves next to itself keeps
 * resolving: the CLI finds its launcher (apps/cli/bin/friday.mjs), the Studio bundle (apps/ui/dist)
 * and the MCP server's launcher (packages/mcp-server/bin/friday-mcp.mjs) exactly as in a checkout.
 * Modules inlined into a bundle resolve relative to that bundle instead, so the files they read are
 * copied next to it: the routing registry's model-guide.yaml and friday_registry.json and the Claude
 * adapter's hook launcher (apps/cli/model-guide.yaml, apps/cli/friday_registry.json, apps/cli/hook.mjs).
 *
 * Third-party packages stay declared dependencies, which npm installs with the archive:
 * better-sqlite3 and @vscode/tree-sitter-wasm carry a native or WebAssembly binary and are loaded
 * with `require` at run time; the others are plain packages the bundles import.
 *
 * Flags: --no-build reuses the built packages; --no-verify skips the install test.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RELEASE_DIR = path.join(REPO_ROOT, 'dist-release');
const PACKAGE_DIR = path.join(RELEASE_DIR, 'package');

/** The two programs of the archive, each bundled from its TypeScript entry into the repository's own place. */
const BUNDLES = [
  { name: 'friday', entry: 'apps/cli/src/bin.ts', out: 'apps/cli/dist/bin.js', launcher: 'apps/cli/bin/friday.mjs' },
  {
    name: 'friday-mcp',
    entry: 'packages/mcp-server/src/bin.ts',
    out: 'packages/mcp-server/dist/bin.js',
    launcher: 'packages/mcp-server/bin/friday-mcp.mjs',
  },
];

/** Files a module reads next to itself; copied beside every bundle that inlines that module. */
const BESIDE = [
  {
    module: 'packages/routing/src/registry.ts',
    source: 'packages/routing/model-guide.yaml',
    beside: '../model-guide.yaml',
  },
  {
    module: 'packages/routing/src/registry-artifact.ts',
    source: 'packages/routing/friday_registry.json',
    beside: '../friday_registry.json',
  },
  {
    module: 'packages/adapters/claude/src/config/claude-code.ts',
    source: 'packages/adapters/claude/dist/hook.mjs',
    beside: '../hook.mjs',
  },
];

/** Whole folders the programs serve or copy at run time. */
const FOLDERS = [{ source: 'apps/ui/dist', check: 'index.html' }];

/** Loaded with `require` at run time, so no import names them: declared from their packages' manifests. */
const RUNTIME_REQUIRED = ['better-sqlite3', '@vscode/tree-sitter-wasm'];

/** Where each workspace package.json is. */
function workspaceManifests() {
  const parents = ['apps', 'packages', 'packages/adapters'];
  const files = [];
  for (const parent of parents) {
    const abs = path.join(REPO_ROOT, parent);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const file = path.join(abs, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** Friday's version: the root package.json's when it has one, else the SDK's FRIDAY_VERSION (what `friday --version` prints). */
export function fridayVersion() {
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof root.version === 'string' && root.version) return root.version;
  const sdk = readFileSync(path.join(REPO_ROOT, 'packages', 'sdk', 'src', 'index.ts'), 'utf8');
  const m = /FRIDAY_VERSION = '([^']+)'/.exec(sdk);
  if (!m) throw new Error('no version: neither package.json "version" nor FRIDAY_VERSION in packages/sdk/src/index.ts');
  return m[1];
}

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: opts.shell ?? false,
    timeout: opts.timeout ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  if (r.status !== 0 && !opts.okFail) {
    throw new Error(`${path.basename(file)} ${args.join(' ')} exited with ${r.status}\n${stdout}${stderr}`.trim());
  }
  return { status: r.status, stdout, stderr };
}

/** npm's own entry script beside this node, so no `.cmd` shim is run (npm-cli.js lives in node's folder on Windows, in lib/ elsewhere). */
function npmCli() {
  const bin = path.dirname(process.execPath);
  for (const c of [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(c)) return c;
  }
  throw new Error(`npm-cli.js was not found next to ${process.execPath}`);
}

/** Environment for npm: none of the npm_* variables pnpm sets for scripts, which would steer npm. */
function npmEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function npm(args, opts = {}) {
  return run(process.execPath, [npmCli(), ...args], { ...opts, env: npmEnv(opts.env) });
}

function turbo(args) {
  run(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'turbo', 'bin', 'turbo'), ...args], { inherit: true });
}

/** esbuild as the Claude adapter's development dependency (it bundles the hook launcher with it); the root has none. */
function esbuild() {
  return createRequire(path.join(REPO_ROOT, 'packages', 'adapters', 'claude', 'package.json'))('esbuild');
}

const packageNameOf = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

/**
 * Bundles the two programs into `pkgDir`. Workspace packages are inlined from their TypeScript
 * sources (the `development` condition); every other package stays an import, to be installed.
 */
async function bundleInto(pkgDir, log) {
  const { build } = esbuild();
  const externals = new Set();
  const external = {
    name: 'third-party-external',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point' || path.isAbsolute(args.path)) return undefined;
        if (args.path.startsWith('@friday/')) return undefined;
        if (!args.path.startsWith('node:') && !builtinModules.includes(args.path))
          externals.add(packageNameOf(args.path));
        return { path: args.path, external: true };
      });
    },
  };
  const bundles = [];
  for (const b of BUNDLES) {
    const outfile = path.join(pkgDir, b.out);
    mkdirSync(path.dirname(outfile), { recursive: true });
    const result = await build({
      entryPoints: [path.join(REPO_ROOT, b.entry)],
      outfile,
      absWorkingDir: REPO_ROOT,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      conditions: ['development'],
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'warning',
      metafile: true,
      plugins: [external],
    });
    const inputs = Object.keys(result.metafile.inputs).map((p) => p.replaceAll('\\', '/'));
    const beside = [];
    for (const f of BESIDE) {
      if (!inputs.includes(f.module)) continue;
      const target = path.resolve(path.dirname(outfile), f.beside);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(REPO_ROOT, f.source), target);
      beside.push(path.relative(pkgDir, target).replaceAll('\\', '/'));
    }
    const launcher = path.join(pkgDir, b.launcher);
    mkdirSync(path.dirname(launcher), { recursive: true });
    cpSync(path.join(REPO_ROOT, b.launcher), launcher);
    const bytes = readFileSync(outfile).length;
    log(
      `bundled ${b.name}: ${b.out} (${Math.round(bytes / 1024)} KB, ${inputs.length} modules; beside it: ${beside.join(', ') || 'nothing'})`,
    );
    bundles.push({ name: b.name, out: b.out, bytes, modules: inputs.length, beside });
  }
  return { bundles, externals: [...externals].sort() };
}

/** The version each third-party package is declared with in the workspace (the same everywhere, or the pack fails). */
function dependenciesFor(names) {
  const declared = new Map();
  for (const file of workspaceManifests()) {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (version.startsWith('workspace:')) continue;
      const seen = declared.get(name);
      if (seen && seen !== version) {
        throw new Error(
          `${name} is declared as ${seen} and as ${version} in the workspace; make them one before packing`,
        );
      }
      declared.set(name, version);
    }
  }
  const dependencies = {};
  for (const name of [...new Set([...names, ...RUNTIME_REQUIRED])].sort()) {
    const version = declared.get(name);
    if (!version)
      throw new Error(`${name} is imported by a bundle but no workspace package declares it as a dependency`);
    dependencies[name] = version;
  }
  return dependencies;
}

function layoutInto(pkgDir, { version, dependencies }) {
  for (const f of FOLDERS) {
    const source = path.join(REPO_ROOT, f.source);
    if (!existsSync(path.join(source, f.check))) throw new Error(`${f.source}/${f.check} is missing; build first`);
    cpSync(source, path.join(pkgDir, f.source), { recursive: true });
  }
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const manifest = {
    name: 'friday',
    version,
    // The owner has no npm name yet: the archive is installed from its file, never published.
    private: true,
    description: root.description,
    type: 'module',
    bin: Object.fromEntries(BUNDLES.map((b) => [b.name, b.launcher])),
    engines: root.engines,
    dependencies,
  };
  writeFileSync(path.join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // An empty .npmignore: npm packs every file here, and reads no .gitignore of the repository's.
  writeFileSync(path.join(pkgDir, '.npmignore'), '');
  writeFileSync(
    path.join(pkgDir, 'README.md'),
    [
      '# Friday',
      '',
      `Friday ${version}, installed from its archive: \`npm install -g ./friday-${version}.tgz\`.`,
      '',
      'In a git repository, `friday start` makes it a Friday project when it is not one yet, starts Friday',
      'hidden when it is not running, and opens the Studio in your browser, signed in. `friday --help`',
      'lists every command.',
      '',
    ].join('\n'),
  );
}

function packArchive(pkgDir, version, log) {
  const archive = path.join(RELEASE_DIR, `friday-${version}.tgz`);
  rmSync(archive, { force: true });
  npm(['pack', '--pack-destination', RELEASE_DIR, '--loglevel', 'error'], { cwd: pkgDir });
  if (!existsSync(archive)) throw new Error(`npm pack produced no ${archive}`);
  log(`packed ${path.relative(REPO_ROOT, archive)} (${Math.round(readFileSync(archive).length / 1024)} KB)`);
  return archive;
}

async function fetchStatus(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: '' };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Installs the archive into a temporary npm prefix and uses it as a user would: `friday --version`,
 * `friday setup`, then `friday start` in a fresh git repository (no commit yet) with
 * FRIDAY_STATE_DIR in the temporary folder, checking that the daemon answers and the Studio is
 * served; then stops it. Answers a report; throws at the first thing that is not as it should be.
 */
export async function verifyArchive(archive, { log = () => {} } = {}) {
  const version = /friday-(.+)\.tgz$/.exec(path.basename(archive))?.[1] ?? fridayVersion();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'friday-release-'));
  const prefix = path.join(tmp, 'prefix');
  const state = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repo');
  for (const d of [prefix, state, repo]) mkdirSync(d, { recursive: true });
  const win = process.platform === 'win32';
  const shim = win ? path.join(prefix, 'friday.cmd') : path.join(prefix, 'bin', 'friday');
  const installed = win
    ? path.join(prefix, 'node_modules', 'friday')
    : path.join(prefix, 'lib', 'node_modules', 'friday');
  const env = { ...npmEnv(), FRIDAY_STATE_DIR: state, NO_COLOR: '1' };
  // The installed command, as a user runs it: on Windows through npm's .cmd shim (which only cmd.exe runs).
  // One command line, quoted here (a shell never escapes an argument array, and Node warns about one).
  const friday = (args, cwd = tmp) =>
    win
      ? run([`"${shim}"`, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' '), [], {
          cwd,
          env,
          shell: true,
          okFail: true,
          timeout: 120_000,
        })
      : run(shim, args, { cwd, env, okFail: true, timeout: 120_000 });
  const report = { archive, version, prefix, installed, checks: [] };
  const check = (name, ok, detail = '') => {
    report.checks.push({ name, ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) throw new Error(`the archive failed a check: ${name}${detail ? ` (${detail})` : ''}`);
  };
  let pid = null;
  try {
    log(`installing ${path.basename(archive)} into ${prefix}`);
    npm(['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', '--loglevel', 'error', archive], { cwd: tmp });
    check('installed', existsSync(shim) && existsSync(path.join(installed, 'apps', 'cli', 'bin', 'friday.mjs')), shim);

    const v = friday(['--version']);
    check('friday --version', v.status === 0 && v.stdout.trim() === version, v.stdout.trim() || v.stderr.trim());

    const help = friday(['setup', '--help']);
    check('friday setup --help', help.status === 0 && /setup/.test(help.stdout), help.stderr.trim());

    const setup = friday(['--json', 'setup']);
    const info = setup.status === 0 ? JSON.parse(setup.stdout) : {};
    check(
      'friday setup finds the CLI and the MCP server inside the archive',
      Boolean(
        info.cli_entry && existsSync(info.cli_entry) && info.mcp_server_entry && existsSync(info.mcp_server_entry),
      ),
      setup.status === 0 ? `${info.cli_entry}, ${info.mcp_server_entry}` : setup.stderr.trim(),
    );

    run('git', ['init', '-q'], { cwd: repo });
    const started = friday(['--json', 'start', '--no-open'], repo);
    let outcome = null;
    try {
      outcome = JSON.parse(started.stdout);
    } catch {
      outcome = null;
    }
    const log_ = path.join(repo, '.friday', 'logs', 'daemon-console.log');
    check(
      'friday start in a fresh repository initializes it and starts Friday',
      started.status === 0 &&
        outcome?.initialized === true &&
        outcome?.started === true &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(outcome?.url ?? ''),
      started.status === 0
        ? outcome?.url
        : `${started.stderr.trim()}\n${existsSync(log_) ? readFileSync(log_, 'utf8').trim().split('\n').slice(-8).join('\n') : ''}`,
    );
    pid = outcome.pid;
    report.url = outcome.url;
    report.studio = outcome.studio;
    check(
      'the project files were written',
      existsSync(path.join(repo, '.friday', 'config.yaml')) && existsSync(path.join(repo, '.friday', '.gitignore')),
    );
    const registry = friday(['--json', 'registry', 'validate'], repo);
    const registryInfo = registry.status === 0 ? JSON.parse(registry.stdout) : {};
    check(
      'friday registry validate matches the packaged artifact',
      registry.status === 0 && registryInfo.ok === true && registryInfo.artifact === 'matches',
      registry.status === 0 ? registry.stdout.trim() : registry.stderr.trim(),
    );
    const health = await fetchStatus(`${outcome.url}/health`);
    check('the daemon answers /health', health.status === 200 || health.status === 401, String(health.status));
    // /ui/ redirects to the per-start path; fetch follows it to the Studio's page.
    const studio = await fetchStatus(outcome.studio);
    check(
      'the Studio is served from the archive',
      studio.status === 200 && /Friday Studio/.test(studio.body),
      String(studio.status),
    );

    const again = friday(['--json', 'start', '--no-open'], repo);
    const second = again.status === 0 ? JSON.parse(again.stdout) : {};
    check(
      'a second start reuses the running Friday',
      second.started === false && second.initialized === false && second.url === outcome.url,
    );

    const stop = friday(['daemon', 'stop'], repo);
    check('friday daemon stop', stop.status === 0, stop.stderr.trim());
    let down = false;
    for (let i = 0; i < 300 && !down; i += 1) {
      await sleep(100);
      down = (await fetchStatus(`${outcome.url}/health`)).status === 0;
    }
    check('Friday stopped', down);
    pid = null;
  } finally {
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    await sleep(250);
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  return report;
}

/** Builds, bundles, packs and (unless told not to) verifies the archive. */
export async function pack({ build = true, verify = true, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const version = fridayVersion();
  mkdirSync(RELEASE_DIR, { recursive: true });
  // The folder ignores itself, so nothing here is ever committed.
  writeFileSync(path.join(RELEASE_DIR, '.gitignore'), '*\n');
  if (build) {
    log('building every package (turbo run build)');
    turbo(['run', 'build']);
  }
  for (const f of BESIDE) {
    if (!existsSync(path.join(REPO_ROOT, f.source))) throw new Error(`${f.source} is missing; build first`);
  }
  rmSync(PACKAGE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  mkdirSync(PACKAGE_DIR, { recursive: true });
  const { bundles, externals } = await bundleInto(PACKAGE_DIR, log);
  const dependencies = dependenciesFor(externals);
  log(`declared dependencies: ${Object.keys(dependencies).join(', ')}`);
  layoutInto(PACKAGE_DIR, { version, dependencies });
  const archive = packArchive(PACKAGE_DIR, version, log);
  const verification = verify ? await verifyArchive(archive, { log }) : null;
  return { archive, version, packageDir: PACKAGE_DIR, dependencies, bundles, verification };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = new Set(process.argv.slice(2));
  const result = await pack({ build: !flags.has('--no-build'), verify: !flags.has('--no-verify') });
  process.stdout.write(
    `${path.relative(REPO_ROOT, result.archive)}: install it with "npm install -g ${result.archive}"${
      result.verification
        ? '; verified: it installs, starts Friday and serves the Studio'
        : '; not verified (--no-verify)'
    }\n`,
  );
}
