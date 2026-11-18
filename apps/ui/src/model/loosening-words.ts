/**
 * What a project's setting lets Friday or an agent do, in a person's words (2026-11-17).
 *
 * The list a person is asked to trust showed each setting as config.yaml writes it
 * ("verification.auto_on_completion: false → true"): exact, and unreadable to someone who never
 * opened that file. Each known setting is said as what it allows; the exact form stays beside it,
 * since trust is in exactly that list. A setting this module does not know is shown as written.
 * Pure module: no DOM.
 */
import { truncate } from '../ui/format.js';
import { visible } from './text.js';

export interface LooseningItem {
  source: string;
  setting: string;
  from: string;
  to: string;
}

/** What an agent does under each command class, as the end of "Agents may … without asking". */
const COMMANDS: Record<string, string> = {
  'file.write': 'run commands that change files Friday cannot name',
  'git.mutate': 'commit and change branches',
  'package.install': 'install packages',
  'fs.destructive': 'delete files with a command',
  'process.kill': 'stop running programs',
  'network.fetch': 'download with a command',
  unknown: 'run commands Friday does not recognise',
  'git.push': 'push to a remote',
  'git.force': 'force-push',
  'network.publish': 'publish a package',
};

/** A value of the project's file as a person decides on it: hidden characters as visible marks, shortened. */
const short = (text: string, max = 160): string => truncate(visible(text), max);

/** The setting as what it allows, or null when it is not one this interface can put into words. */
export function looseningWords(l: Pick<LooseningItem, 'setting' | 'to'>): string | null {
  const { setting, to } = l;
  if (setting === 'verification.auto_on_completion') return 'Finished work is checked automatically';
  if (setting === 'landing.mode') {
    return to === 'task'
      ? 'Each task that passes its checks is put into your project without asking'
      : 'A goal that has passed its checks is put into your project without asking';
  }
  if (setting === 'master_brain.auto_approve') return 'Plans start without waiting for your approval';
  if (setting === 'sandbox') {
    return 'This folder is treated as disposable: commands that would wait for your approval run on their own';
  }
  if (setting === 'reservations.mode') return 'Agents are not kept from changing the same files at the same time';
  if (setting === 'daemon.port') return `Friday always answers on port ${short(to, 12)}`;
  if (setting === 'worktrees.setup.command') return `Task folders are prepared by running: ${short(to)}`;
  if (setting === 'worktrees.files') {
    return `Every copy of the project an agent works in gets your file ${short(to, 120)}; programs run there can read it`;
  }
  if (setting === 'execution.binaries') return `Checks may run the program “${short(to, 60)}”`;
  if (setting === 'execution.env_passthrough') return `Checks see this computer’s variable ${short(to, 60)}`;
  if (setting.startsWith('autonomy.')) {
    const what = COMMANDS[setting.slice('autonomy.'.length)];
    if (!what) return null;
    if (to === 'auto') return `Agents may ${what} without asking`;
    if (to === 'review') return `Agents may ${what} once you approve it in Friday`;
    return null;
  }
  if (setting.startsWith('operations.')) {
    return `Friday runs “${short(setting.slice('operations.'.length), 60)}” for agents: ${short(to)}`;
  }
  if (setting.startsWith('mcp.')) {
    const [server, ...rest] = setting.slice('mcp.'.length).split('.');
    const tool = rest.join('.');
    if (!server || to !== 'auto') return null;
    return tool === 'default'
      ? `Every tool of “${short(server, 60)}” runs without asking`
      : `The tool “${short(tool, 60)}” of “${short(server, 60)}” runs without asking`;
  }
  return null;
}

/** The setting exactly as the project's file has it: what trust is recorded in. */
export function looseningExact(l: LooseningItem): string {
  return `${short(l.setting, 120)}: ${short(l.from, 60)} → ${short(l.to, 120)}`;
}

/**
 * One line for a confirmation: the words, then the exact setting and the file it comes from; a
 * setting with no words is the exact form alone, as before.
 */
export function looseningLine(l: LooseningItem): string {
  const words = looseningWords(l);
  const exact = looseningExact(l);
  const source = short(l.source, 120);
  return words ? `${words} (${exact}, ${source})` : `${exact} (${source})`;
}
