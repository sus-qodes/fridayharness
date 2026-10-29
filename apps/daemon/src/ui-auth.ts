import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { type Actor, FridayError, type UiLoginCode, type UiSession } from '@friday/protocol';
import { writePrivateFile } from '@friday/sdk';
import type { FridayState } from '@friday/state';

/**
 * Browser sign-in by one-time link (plan M9, `docs/frontend/PLAN.md` §5.2, ADR-0033 §3).
 *
 * Only a holder of the operator token (`friday ui`, the desktop shell) mints a code. The page
 * exchanges it, from the daemon's own origin only, for a UI session: an operator-class credential
 * issued per login, revocable on its own, capped in age, and ended by every daemon restart and
 * token rotation (they revoke every operator-class credential). Codes live in memory as sha256
 * only, for one use within 60 seconds.
 *
 * The browser gets the link through a redirect file in the private directory (user-only), which
 * is what the CLI opens: the code is never on a process command line, where other accounts (on
 * Linux) and the user's own agents could read it (LESSONS UI-22). The file goes with its code.
 */

export const LOGIN_CODE_TTL_MS = 60_000;
export const MAX_OUTSTANDING_CODES = 5;
export const UI_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const SYSTEM: Actor = { kind: 'system', id: 'friday' };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class UiAuth {
  /** sha256(code) → expiry (ms) and its redirect file, oldest first. */
  readonly #codes = new Map<string, { expiresAt: number; code: string; file: string | null }>();
  /** credential id → issued at (ms). */
  readonly #sessions = new Map<string, number>();

  constructor(
    private readonly state: FridayState,
    private readonly projectId: string,
    private readonly now: () => number,
    private readonly opts: { privateDir?: string } = {},
  ) {}

  /** Forgets one code: its redaction and its redirect file. */
  #drop(hash: string): void {
    const entry = this.#codes.get(hash);
    if (!entry) return;
    this.#codes.delete(hash);
    this.state.redactor.removeSecret(entry.code);
    if (entry.file) rmSync(entry.file, { force: true });
  }

  #prune(now: number): void {
    for (const [hash, entry] of this.#codes) if (entry.expiresAt <= now) this.#drop(hash);
  }

  /** A new one-time code; the oldest outstanding codes are dropped beyond the limit. */
  mint(): { code: string; expiresAt: number } {
    const now = this.now();
    this.#prune(now);
    while (this.#codes.size >= MAX_OUTSTANDING_CODES) {
      const oldest = this.#codes.keys().next().value as string;
      this.#drop(oldest);
    }
    const code = randomBytes(32).toString('base64url');
    const expiresAt = now + LOGIN_CODE_TTL_MS;
    this.#codes.set(sha256(code), { expiresAt, code, file: null });
    this.state.redactor.addSecret(code);
    return { code, expiresAt };
  }

  /**
   * Redeems a code for a UI session. The code is deleted before anything is issued, in one
   * synchronous step, so a code can never be used twice (LESSONS §0 item 14).
   */
  redeem(code: unknown): { token: string; credentialId: string; expiresAt: number } | undefined {
    if (typeof code !== 'string' || code.length < 16 || code.length > 128) return undefined;
    const now = this.now();
    const hash = sha256(code);
    const entry = this.#codes.get(hash);
    this.#drop(hash);
    this.#prune(now);
    if (!entry || entry.expiresAt <= now) return undefined;
    const token = this.state.issueToken(this.projectId, 'operator');
    const info = this.state.resolveToken(token);
    if (!info) return undefined;
    this.#sessions.set(info.credential_id, now);
    this.state.recordObservation(
      this.projectId,
      SYSTEM,
      'ui.session_started',
      { credential_id: info.credential_id },
      [],
    );
    return { token, credentialId: info.credential_id, expiresAt: now + UI_SESSION_MAX_AGE_MS };
  }

  isSession(credentialId: string | undefined): boolean {
    return !!credentialId && this.#sessions.has(credentialId);
  }

  /** True when the credential is a UI session older than the cap; it is then revoked. */
  expire(credentialId: string | undefined): boolean {
    if (!credentialId) return false;
    const issued = this.#sessions.get(credentialId);
    if (issued === undefined || this.now() - issued < UI_SESSION_MAX_AGE_MS) return false;
    this.end(credentialId, 'the interface session reached its age limit');
    return true;
  }

  /** Revokes one UI session (logout or expiry). */
  end(credentialId: string, reason: string): void {
    if (!this.#sessions.delete(credentialId)) return;
    this.state.revokeTokens({ credential_id: credentialId, project_id: this.projectId }, reason);
    this.state.recordObservation(
      this.projectId,
      SYSTEM,
      'ui.session_ended',
      { credential_id: credentialId, reason },
      [],
    );
  }

  /** Forgets every code and session (the daemon stops; its credentials are revoked separately). */
  clear(): void {
    for (const hash of [...this.#codes.keys()]) this.#drop(hash);
    this.#sessions.clear();
  }

  /** A one-time link to `uiPath` (the bundle's per-start path) and, with a private directory, its redirect file. */
  loginCode(port: number, uiPath = '/ui/'): UiLoginCode {
    const { code, expiresAt } = this.mint();
    const url = `http://127.0.0.1:${port}${uiPath}#code=${code}`;
    let file: string | null = null;
    if (this.opts.privateDir) {
      // Only a refresh: no script, nothing but the link (the code is base64url, safe in the attribute).
      const html = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${url}">
<title>Opening Friday</title>
<p>Opening Friday…</p>
`;
      file = writePrivateFile(this.opts.privateDir, `ui-login-${randomBytes(4).toString('hex')}.html`, html);
      const entry = this.#codes.get(sha256(code));
      if (entry) entry.file = file;
    }
    return { url, redirect_file: file, expires_at: new Date(expiresAt).toISOString() };
  }

  session(code: unknown): UiSession {
    const s = this.redeem(code);
    // Unknown, used and expired codes get the same answer.
    if (!s) throw new FridayError('authentication_failed', 'that sign-in link is not valid; open Friday again');
    return { token: s.token, expires_at: new Date(s.expiresAt).toISOString(), project_id: this.projectId };
  }
}
