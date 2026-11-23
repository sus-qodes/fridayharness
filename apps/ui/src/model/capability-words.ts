/**
 * What an agent asks to do, in a person's words (2026-11-17).
 *
 * An approval named what was asked as the policy names it ("shell.git.commit", "package.install"),
 * in a monospaced line a person had to decode before deciding. Each capability is said as the act
 * it is; the code stays in the tooltip, and the target (the exact command or file) is shown in full
 * under it, as before: that is what the decision is about. A capability this module does not know
 * is shown as written. Pure module: no DOM.
 */
import { truncate } from '../ui/format.js';
import { visible } from './text.js';

/** The policy's capabilities (packages/policy `CAPABILITIES`), each as what the agent wants to do. */
const WORDS: Record<string, string> = {
  'file.read': 'Read a file',
  'file.write': 'Change a file',
  'file.delete': 'Delete a file',
  'shell.test': 'Run tests',
  'shell.build': 'Run a build',
  'shell.git.read': 'Look at the git history',
  'shell.git.commit': 'Commit or change branches',
  'shell.git.push': 'Push to a remote',
  'network.read': 'Read from the internet',
  'network.write': 'Send something to the internet',
  'package.install': 'Install packages',
  'secret.resolve': 'Use a stored secret',
  'process.spawn': 'Run a command',
  'agent.communicate': 'Message another agent',
  'task.reassign': 'Hand a task to another agent',
  'policy.request': 'Be allowed more than its task allows',
  'human.escalate': 'Ask you a question',
  'operation.run': 'Run one of the project’s operations',
  'mcp.call': 'Use a tool of a connected server',
};

/** The act a capability stands for, or the capability as written when it is not one Friday knows. */
export function capabilityWords(capability: string): string {
  return WORDS[capability] ?? truncate(visible(capability), 80);
}

/** Whether the capability is one this interface has words for. */
export function knownCapability(capability: string): boolean {
  return Object.hasOwn(WORDS, capability);
}
