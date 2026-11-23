import type { AntigravitySetupPlan } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeAgent, makeHarness, makeSnapshot } from '../test/fixtures.js';
import {
  ANTIGRAVITY_ATTACH_NOTE,
  ANTIGRAVITY_FALLBACK_PROMPT,
  ANTIGRAVITY_FIRST_PROMPT,
  ANTIGRAVITY_SETUP_KEY,
  antigravitySetupModal,
  foundText,
  namesTakenByOthers,
} from './antigravity-setup.js';
import { BIDI, buttonBy, controlBy, flush, HOSTILE, type } from './test-support.js';

function plan(over: Partial<AntigravitySetupPlan> = {}): AntigravitySetupPlan {
  return {
    agent_key: 'dev-1',
    applied: false,
    changes: [
      {
        path: '.agents/mcp_config.json',
        action: 'create',
        tracked: true,
        note: 'registers the friday MCP server',
        diff: `+{"mcpServers": {"friday": {}}}\n+${HOSTILE}`,
      },
      { path: `.agents/${BIDI}`, action: 'update', tracked: false, note: null, diff: '-old\n+new' },
    ],
    antigravity: { cli: { binary: 'C:/agy/bin/agy.exe', version: '1.4.4' }, app: null, hook_level: 'unverified' },
    ...over,
  };
}

describe('antigravity setup', () => {
  it('names what it found, and nothing when it found nothing', () => {
    expect(foundText(plan().antigravity)).toBe('Antigravity CLI 1.4.4');
    expect(
      foundText({
        cli: { binary: 'agy', version: null },
        app: { binary: 'Antigravity.exe', version: '2.0.1' },
        hook_level: 'unverified',
      }),
    ).toBe('Antigravity CLI (version unknown) and the Antigravity App 2.0.1');
    expect(foundText({ cli: null, app: null, hook_level: 'unverified' })).toBeNull();
    expect(foundText(null)).toBeNull();
  });

  it('says why it has no Start button, and offers none', () => {
    const ctx = makeContext({ answers: {} });
    const m = antigravitySetupModal(ctx, { kind: 'antigravity-setup' }, () => undefined);
    expect(m.title).toBe('Connect Antigravity');
    expect(m.el.textContent).toContain(ANTIGRAVITY_ATTACH_NOTE);
    expect(Array.from(m.el.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Preview',
      'Apply',
      'Close',
    ]);
    m.destroy();
  });

  it('previews, applies on confirm, shows the doctor and the steps in Antigravity', async () => {
    const copied: string[] = [];
    const ctx = makeContext({
      answers: {
        'GET /agent-setup/antigravity': plan(),
        'POST /agent-setup/antigravity': {
          plan: plan({ applied: true }),
          doctor: {
            achieved: 'L1 unverified',
            checks: [
              { id: 'ag.binary', status: 'ok', message: HOSTILE },
              { id: 'ag.trust', status: 'info', message: 'hooks run only in a trusted folder', fix: 'trust it' },
            ],
          },
        },
      },
    });
    (ctx.platform as { copy: (t: string) => Promise<boolean> }).copy = async (t) => {
      copied.push(t);
      return true;
    };
    const m = antigravitySetupModal(ctx, { kind: 'antigravity-setup' }, () => undefined);
    // Its own name: with Claude Code's `dev-1` the second of the two to connect could take no task.
    expect(controlBy(m.el, 'Agent key').value).toBe(ANTIGRAVITY_SETUP_KEY);
    expect(ANTIGRAVITY_SETUP_KEY).toBe('antigravity-1');
    expect(buttonBy(m.el, 'Apply').disabled).toBe(true);
    buttonBy(m.el, 'Preview').click();
    await flush();
    expect(ctx.transport.calls[0]?.path).toContain('/agent-setup/antigravity?agent=antigravity-1');
    expect(m.el.textContent).toContain('Antigravity CLI 1.4.4 found');
    expect(m.el.textContent).toContain('tracked by git');
    expect(m.el.textContent).toContain('not tracked');
    expect(m.el.querySelector('img')).toBeNull();
    expect(m.el.textContent).toContain('⟨U+202E⟩');
    ctx.confirmAnswer = false;
    buttonBy(m.el, 'Apply').click();
    await flush();
    expect(ctx.transport.to('POST', '/agent-setup/antigravity')).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonBy(m.el, 'Apply').click();
    await flush();
    expect(ctx.confirms[1]?.body).toEqual([
      'Friday writes 2 files for Antigravity in this project.',
      'Git tracks this one, so the change shows in your next commit:',
      '  .agents/mcp_config.json',
    ]);
    expect(ctx.transport.to('POST', '/agent-setup/antigravity')[0]?.body).toEqual({ agent_key: 'antigravity-1' });
    const text = m.el.textContent ?? '';
    // The level in a person's words; a note that is neither a failure nor a warning is folded away
    // with what passed, and no check code shows.
    expect(text).toContain(
      'Connected. Friday’s checks are in place; Antigravity does not say what it does when a check cannot run',
    );
    expect(text).not.toContain('L1 unverified');
    expect(text).not.toContain('ag.trust');
    expect(text).toContain('Nothing needs attention.');
    expect(m.el.querySelector('details.pn-checks-passed summary')?.textContent).toBe('2 checks with nothing to do');
    expect(m.el.querySelector('details.pn-checks-passed')?.textContent).toContain('hooks run only in a trusted folder');
    expect(text).toContain('close it and open it again so it takes the name');
    expect(text).toContain('Open this project folder in Antigravity yourself');
    expect(text).toContain('Trust the folder');
    expect(ANTIGRAVITY_FIRST_PROMPT).toBe('/friday');
    expect(text).toContain('each time is one task');
    expect(text).toContain(ANTIGRAVITY_FALLBACK_PROMPT);
    buttonBy(m.el, 'Copy the folder path').click();
    buttonBy(m.el, 'Copy the first prompt').click();
    await flush();
    expect(copied).toEqual(['C:/demo/shop', ANTIGRAVITY_FIRST_PROMPT]);
    m.destroy();
  });

  it('says so when Antigravity is not installed or the doctor gave no answer', async () => {
    const ctx = makeContext({
      answers: {
        'GET /agent-setup/antigravity': plan({ antigravity: { cli: null, app: null, hook_level: 'unverified' } }),
        'POST /agent-setup/antigravity': { plan: plan({ applied: true, changes: [] }), doctor: { error: 'timed out' } },
      },
    });
    const m = antigravitySetupModal(ctx, { kind: 'antigravity-setup' }, () => undefined);
    buttonBy(m.el, 'Preview').click();
    await flush();
    expect(m.el.textContent).toContain('Friday did not find Antigravity on this machine');
    buttonBy(m.el, 'Apply').click();
    await flush();
    expect(m.el.textContent).toContain('Friday could not check the setup: timed out');
    expect(m.el.textContent).toContain('Nothing to change.');
    m.destroy();
  });

  it('refuses the name another app works under, and takes Antigravity’s own', async () => {
    // Claude Code in VS Code is dev-1; an Antigravity session already connected is antigravity-1.
    const board = makeSnapshot({
      agents: [
        makeAgent({ agent_key: 'dev-1', harness_id: 'h-claude' }),
        makeAgent({ agent_id: 'agent_2', agent_key: 'antigravity-1', harness_id: 'h-ag' }),
        makeAgent({ agent_id: 'agent_3', agent_key: 'gone-1', harness_id: 'h-old', status: 'TERMINATED' }),
      ],
      harnesses: [
        makeHarness({ harness_id: 'h-claude', vendor: 'claude-code' }),
        makeHarness({ harness_id: 'h-ag', vendor: 'antigravity' }),
      ],
    });
    expect([...namesTakenByOthers(board)]).toEqual(['dev-1']);
    expect([...namesTakenByOthers(null)]).toEqual([]);
    const ctx = makeContext({ snapshot: board, answers: { 'GET /agent-setup/antigravity': plan() } });
    const m = antigravitySetupModal(ctx, { kind: 'antigravity-setup' }, () => undefined);
    // Its own name is free to set up again, though a session holds it.
    expect(buttonBy(m.el, 'Preview').disabled).toBe(false);
    type(controlBy(m.el, 'Agent key'), 'dev-1');
    expect(m.el.textContent).toContain(
      'dev-1 is the name another agent works under; choose another, or the two cannot both take tasks',
    );
    expect(buttonBy(m.el, 'Preview').disabled).toBe(true);
    expect(buttonBy(m.el, 'Apply').disabled).toBe(true);
    type(controlBy(m.el, 'Agent key'), 'gone-1');
    expect(buttonBy(m.el, 'Preview').disabled).toBe(false);
    m.destroy();
  });

  it('refuses a bad agent key and forgets a preview when the key changes', async () => {
    const ctx = makeContext({ answers: { 'GET /agent-setup/antigravity': plan() } });
    const m = antigravitySetupModal(ctx, { kind: 'antigravity-setup' }, () => undefined);
    buttonBy(m.el, 'Preview').click();
    await flush();
    expect(buttonBy(m.el, 'Apply').disabled).toBe(false);
    type(controlBy(m.el, 'Agent key'), 'Bad Key');
    expect(buttonBy(m.el, 'Preview').disabled).toBe(true);
    expect(buttonBy(m.el, 'Apply').disabled).toBe(true);
    expect(m.el.querySelector('.pn-changes-files')).toBeNull();
    m.destroy();
  });

  it('shows a refusal beside the form', async () => {
    const ctx = makeContext({
      answers: {
        'GET /agent-setup/antigravity': () => {
          throw new Error('AGENTS.md is not a file Friday can read');
        },
      },
    });
    const m = antigravitySetupModal(ctx, { kind: 'antigravity-setup' }, () => undefined);
    buttonBy(m.el, 'Preview').click();
    await flush();
    expect(m.el.querySelector('.pn-server-error')?.textContent).toBe('AGENTS.md is not a file Friday can read');
    m.destroy();
  });
});
