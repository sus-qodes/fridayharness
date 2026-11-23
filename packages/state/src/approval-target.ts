/**
 * What an approval is matched on (2026-11-18). A grant covers "this exact target", and for a
 * command the target is the command line the person was shown. An agent rarely types the same
 * line twice: it runs `npm install 2>&1 | tail -15`, asks for `npm install`, and after the grant
 * runs `npm install | tail -30`. Matched character by character, the grant covered none of those,
 * the person saw two cards for one need, and the approved command stayed refused.
 *
 * So the plumbing that only trims what the command prints is left out of the comparison: a
 * trailing `2>&1`, and a trailing `| tail -N` or `| head -N` (with or without `-n`). Nothing else
 * is: a pipe into any other program, a redirection into a file, another flag or another argument
 * is another command, and needs its own decision. The stored target stays the line as it was
 * asked, since that is what the person read.
 */
const TRIMS_OUTPUT = /\s*\|\s*(?:tail|head)(?:\s+-n)?\s+-?\d+\s*$/i;
const MERGES_STREAMS = /\s+2>&1\s*$/;

export function approvalKey(target: string): string {
  let t = target.trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 8; i += 1) {
    const next = t.replace(TRIMS_OUTPUT, '').replace(MERGES_STREAMS, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** Whether two targets are the same thing to approve. */
export function sameApprovalTarget(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a === b || approvalKey(a) === approvalKey(b);
}
