import type { ClaudeSetupPlan } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { applyWarning, claudeSetupModal, DEFAULT_SETUP_KEY } from './claude-setup.js';
import { BIDI, buttonBy, controlBy, flush, HOSTILE, type } from './test-support.js';

function plan(over: Partial<ClaudeSetupPlan> = {}): ClaudeSetupPlan {
  return {
    agent_key: 'dev-1',
    applied: false,
    changes: [
      {
        path: '.mcp.json',
        action: 'create',
        tracked: true,
        note: 'the MCP server "friday"',
        diff: `+{"mcpServers": {"friday": {}}}\n+${HOSTILE}`,
      },
      { path: `.claude/${BIDI}`, action: 'update', tracked: false, note: null, diff: '-old\n+new' },
    ],
    claude_code: { version: '2.1.301', source: 'PATH', hook_level: 'L1' },
    ...over,
  };
}

const CONFIG_FIX = 're-run "friday harness config claude-code"';

describe('claude code setup', () => {
  it('names tracked files in the confirmation', () => {
    expect(applyWarning(plan().changes)).toEqual([
      'Friday writes 2 files for Claude Code in this project.',
      'Git tracks this one, so the change shows in your next commit:',
      '  .mcp.json',
    ]);
    expect(applyWarning([{ path: 'a', action: 'create', tracked: false, note: null, diff: null }])[1]).toBe(
      'None of them is tracked by git.',
    );
  });

  it('previews, applies on confirm, shows the doctor and the VS Code steps', async () => {
    const copied: string[] = [];
    const opened: string[] = [];
    const ctx = makeContext({
      answers: {
        'GET /agent-setup/claude-code': plan(),
        'POST /agent-setup/claude-code': {
          plan: plan({ applied: true }),
          // The check's answer as `harness doctor claude-code --json` gives it.
          doctor: {
            achieved: 'L1 degraded',
            checks: [
              { id: 'cc.binary', status: 'ok', message: `Claude Code 2.1.301 ${HOSTILE}` },
              { id: 'cc.skill', status: 'warn', message: 'the friday skill is missing', fix: CONFIG_FIX },
              { id: 'cc.launcher', status: 'fail', message: 'launch-mcp.mjs is missing', fix: CONFIG_FIX },
            ],
          },
        },
      },
    });
    (ctx.platform as { copy: (t: string) => Promise<boolean> }).copy = async (t) => {
      copied.push(t);
      return true;
    };
    (ctx.platform as { openInEditor: (p: string) => void }).openInEditor = (p) => opened.push(p);
    const m = claudeSetupModal(ctx, { kind: 'claude-setup' }, () => undefined);
    expect(controlBy(m.el, 'Agent key').value).toBe(DEFAULT_SETUP_KEY);
    expect(buttonBy(m.el, 'Apply').disabled).toBe(true);
    buttonBy(m.el, 'Preview').click();
    await flush();
    expect(ctx.transport.calls[0]?.path).toContain('/agent-setup/claude-code?agent=dev-1');
    expect(m.el.textContent).toContain('tracked by git');
    expect(m.el.textContent).toContain('not tracked');
    expect(m.el.querySelector('img')).toBeNull();
    expect(m.el.textContent).toContain(HOSTILE);
    expect(m.el.textContent).toContain('⟨U+202E⟩');
    ctx.confirmAnswer = false;
    buttonBy(m.el, 'Apply').click();
    await flush();
    expect(ctx.transport.to('POST', '/agent-setup/claude-code')).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonBy(m.el, 'Apply').click();
    await flush();
    expect(ctx.confirms[1]?.body).toEqual(expect.arrayContaining(['  .mcp.json']));
    expect(ctx.transport.to('POST', '/agent-setup/claude-code')[0]?.body).toEqual({ agent_key: 'dev-1' });
    const text = m.el.textContent ?? '';
    // One sentence on whether it is connected, then what needs attention, the worst first, with
    // what to do in this dialog's terms; no check codes and no terminal command.
    expect(text).toContain('Connected, with gaps: part of Friday’s checks is not in place for Claude Code.');
    const attention = Array.from(m.el.querySelectorAll('.pn-checks-attention > li')).map((li) => li.textContent);
    expect(attention).toEqual([
      'Needs fixinglaunch-mcp.mjs is missingWhat to do: Apply this setup again: Preview, then Apply.',
      'Worth a lookthe friday skill is missingWhat to do: Apply this setup again: Preview, then Apply.',
    ]);
    expect(text).not.toContain('cc.launcher');
    expect(text).not.toContain('friday harness config');
    // The code is still there for whoever needs it, in the tooltip; what passed is folded away.
    expect(m.el.querySelector('.pn-checks-attention > li')?.getAttribute('title')).toBe('cc.launcher');
    const passed = m.el.querySelector('details.pn-checks-passed') as HTMLDetailsElement;
    expect(passed.open).toBe(false);
    expect(passed.querySelector('summary')?.textContent).toBe('1 check with nothing to do');
    expect(passed.textContent).toContain(HOSTILE);
    expect(m.el.querySelector('img')).toBeNull();
    expect(text).toContain('it shows in the Agents list as “attached in VS Code”');
    expect(text).toContain('accept the folder-trust prompt'.replace('accept', 'Accept'));
    expect(text).toContain('/friday start');
    buttonBy(m.el, 'Copy the start command').click();
    buttonBy(m.el, 'Open in VS Code').click();
    await flush();
    expect(copied).toEqual(['/friday start']);
    expect(opened).toEqual(['C:/demo/shop']);
    m.destroy();
  });

  it('refuses a bad agent key and forgets a preview when the key changes', async () => {
    const ctx = makeContext({ answers: { 'GET /agent-setup/claude-code': plan() } });
    const m = claudeSetupModal(ctx, { kind: 'claude-setup' }, () => undefined);
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
        'GET /agent-setup/claude-code': () => {
          throw new Error('Claude Code is not installed');
        },
      },
    });
    const m = claudeSetupModal(ctx, { kind: 'claude-setup' }, () => undefined);
    buttonBy(m.el, 'Preview').click();
    await flush();
    expect(m.el.querySelector('.pn-server-error')?.textContent).toBe('Claude Code is not installed');
    m.destroy();
  });
});
