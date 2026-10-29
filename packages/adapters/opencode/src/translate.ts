import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ToolAction } from '@friday/protocol';

export interface OpenCodeCall {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}
const text = (v: unknown): string => {
  if (typeof v !== 'string' || !v.trim() || v.includes('\0')) throw new Error('missing or malformed tool argument');
  return v;
};
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Initial closed catalog: unsupported tools never become a generic read or shell call. Token cost: none. */
export function translateOpenCode(call: OpenCodeCall, cwd: string): ToolAction {
  const args = call.args;
  const file = (value: unknown): string => {
    const input = text(value);
    if (
      process.platform === 'win32' &&
      /^\/(?:[a-zA-Z]:?(?:\/|$)|(?:cygdrive|mnt)\/[a-zA-Z](?:\/|$))/.test(input.replaceAll('\\', '/'))
    )
      throw new Error('host-specific Windows drive aliases are unsupported');
    const target = path.resolve(cwd, input);
    if (!inside(cwd, target)) throw new Error('tool path is outside the bound execution root');
    return target;
  };
  const optionalPath = () => (args.path === undefined ? cwd : file(args.path));
  let action: ToolAction;
  switch (call.tool) {
    case 'bash':
      // tool.check judges commands at the run's execution root; never silently discard workdir.
      if (args.workdir !== undefined && file(args.workdir) !== cwd)
        throw new Error('alternate shell workdir is unsupported');
      action = { kind: 'command', command: text(args.command) };
      break;
    case 'read':
      action = { kind: 'read', paths: [file(args.filePath)] };
      break;
    case 'write':
    case 'edit':
      text(args.filePath);
      if (call.tool === 'write' && typeof args.content !== 'string') throw new Error('write content is missing');
      if (call.tool === 'edit' && (typeof args.oldString !== 'string' || typeof args.newString !== 'string'))
        throw new Error('edit strings are missing');
      action = { kind: 'write', paths: [file(args.filePath)] };
      break;
    case 'apply_patch':
      action = { kind: 'write', paths: patchPaths(text(args.patchText), file) };
      break;
    case 'glob':
      action = { kind: 'search', patterns: [text(args.pattern)], paths: [optionalPath()] };
      break;
    case 'grep': {
      // The regex searches contents; include selects filenames. A file path searches its parent.
      text(args.pattern);
      const requested = optionalPath();
      const info = statSync(requested, { throwIfNoEntry: false });
      const resolved = info ? realpathSync(requested) : requested;
      const searchRoot = info?.isDirectory() ? resolved : path.dirname(resolved);
      if (!inside(cwd, resolved) || !inside(cwd, searchRoot))
        throw new Error('grep search directory is outside the bound execution root');
      action = {
        kind: 'search',
        patterns: args.include === undefined ? [] : [text(args.include)],
        paths: [...new Set([requested, searchRoot])],
      };
      break;
    }
    case 'webfetch': {
      const url = new URL(text(args.url));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('unsupported fetch URL');
      action = { kind: 'network', url: url.href };
      break;
    }
    // websearch needs a search-specific policy contract, not a fabricated URL. MCP is disabled
    // in this no-model profile; task/custom/resource/code-mode tools have no implicit authority.
    default:
      throw new Error('unsupported OpenCode tool');
  }
  return ToolAction.parse(action);
}

/** Parse the pinned apply_patch envelope completely enough to refuse ambiguous targets. */
function patchPaths(patch: string, file: (v: unknown) => string): string[] {
  const lines = patch.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch')
    throw new Error('malformed patch envelope');
  const paths = new Set<string>();
  let kind: string | undefined;
  let canMove = false;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      kind = header[1];
      canMove = kind === 'Update';
      paths.add(file(header[2]));
    } else if (line.startsWith('*** Move to: ')) {
      if (!canMove) throw new Error('malformed patch move');
      paths.add(file(line.slice('*** Move to: '.length)));
      canMove = false;
    } else if (line.startsWith('***')) {
      if (line !== '*** End of File' || kind !== 'Update') throw new Error('unknown patch directive');
    } else if (!kind || (kind === 'Delete' && line) || (line && !/^[ +@-]/.test(line))) {
      throw new Error('malformed patch body');
    }
  }
  if (!paths.size) throw new Error('patch has no paths');
  return [...paths];
}
