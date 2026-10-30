import { describe, expect, it } from 'vitest';
import { claudeEnvironment } from './environment.js';

describe('the environment of a spawned Claude Code session', () => {
  it("keeps Claude Code's own login and settings, drops a parent session's variables and other secrets", () => {
    const out = claudeEnvironment({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      // The subscription token `claude setup-token` prints: the login of a container session.
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat',
      CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
      CLAUDE_CODE_USE_BEDROCK: '1',
      FRIDAY_STATE_DIR: '/state',
      // A parent Claude Code session's variables.
      CLAUDECODE: '1',
      CLAUDE_CODE_SSE_PORT: '4321',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      MCP_CONNECTION_NONBLOCKING: '1',
      // Friday's own, and secrets that are not Claude Code's login.
      FRIDAY_AGENT: 'cl-1',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GITHUB_TOKEN: 'gh',
      undefined_one: undefined,
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat',
      CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
      CLAUDE_CODE_USE_BEDROCK: '1',
      FRIDAY_STATE_DIR: '/state',
    });
  });

  it('matches names without regard to case', () => {
    expect(claudeEnvironment({ claudecode: '1', friday_agent: 'x', Github_Token: 'g', Path: 'p' })).toEqual({
      Path: 'p',
    });
  });
});
