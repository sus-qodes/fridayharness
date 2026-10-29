/**
 * The interface end to end (docs/frontend/PLAN.md §10.3): the real bundle served by a real daemon,
 * driven in the installed Edge or Chrome through playwright-core (no browser download).
 *
 * Gated by FRIDAY_TEST_UI_E2E=1 (Turbo passes only FRIDAY_TEST_* variables; LESSONS UI-26):
 *   TERMINAL (PowerShell): $env:FRIDAY_TEST_UI_E2E='1'; pnpm vitest run --project ui-e2e
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DaemonOptions } from '@friday/daemon';
import type { UiLoginCode } from '@friday/protocol';
import type { TestWorkspace } from '@friday/test-support';
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from 'playwright-core';
import { REPO_ROOT } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';

export const E2E = process.env.FRIDAY_TEST_UI_E2E === '1';
if (!E2E) {
  process.stdout.write('ui-e2e: skipped (set FRIDAY_TEST_UI_E2E=1 to drive the interface in Edge or Chrome)\n');
}

export const UI_DIST = path.join(REPO_ROOT, 'apps', 'ui', 'dist');
export const SHOTS = path.join(REPO_ROOT, 'tests', '.artifacts', 'ui');

/** Builds the bundle once per run when it is missing or older than its sources. */
export function ensureBundle(force = process.env.FRIDAY_TEST_UI_REBUILD === '1'): string {
  if (force || !existsSync(path.join(UI_DIST, 'index.html'))) {
    const vite = path.join(REPO_ROOT, 'apps', 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
    execFileSync(process.execPath, [vite, 'build'], {
      cwd: path.join(REPO_ROOT, 'apps', 'ui'),
      stdio: 'pipe',
      windowsHide: true,
    });
  }
  return UI_DIST;
}

let browser: Browser | null = null;

/** The installed Edge, else Chrome; headless unless FRIDAY_TEST_UI_HEADED=1. */
export async function launchBrowser(): Promise<Browser> {
  if (browser) return browser;
  const headless = process.env.FRIDAY_TEST_UI_HEADED !== '1';
  const errors: string[] = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      browser = await chromium.launch({ channel, headless });
      return browser;
    } catch (e) {
      errors.push(`${channel}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`no installed Edge or Chrome could be started:\n${errors.join('\n')}`);
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/**
 * Moves the mouse onto an element the way a hand does, in several steps. Decisions arm only after
 * a real move onto their card (plan FD-28); a one-step hover is a single event with no movement.
 */
export async function pointAt(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('the element is not on screen');
  await page.mouse.move(box.x + box.width / 2 - 24, box.y + box.height / 2 - 12, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
}

export interface UiRig {
  td: TestDaemon;
  context: BrowserContext;
  page: Page;
  /** Console errors and failed requests the page produced (a test asserts none). */
  problems: string[];
  shot(name: string): Promise<string>;
  close(): Promise<void>;
}

/** A daemon serving the bundle, a fresh browser context, and a page signed in by a one-time link. */
export async function openStudio(
  ws: TestWorkspace,
  opts: {
    extensions?: DaemonOptions['extensions'];
    extraConfig?: string;
    viewport?: { width: number; height: number };
  } = {},
): Promise<UiRig> {
  const uiDir = ensureBundle();
  const td = await startTestDaemon(ws, {
    git: true,
    uiDir,
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
    ...(opts.extraConfig ? { extraConfig: opts.extraConfig } : {}),
  });
  const b = await launchBrowser();
  const context = await b.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const login = await td.operator.post<UiLoginCode>(td.operator.projectPath('/ui/login-codes'), {});
  await page.goto(login.url);
  mkdirSync(SHOTS, { recursive: true });
  return {
    td,
    context,
    page,
    problems,
    shot: async (name) => {
      const file = path.join(SHOTS, `${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    },
    close: async () => {
      await context.close();
    },
  };
}
