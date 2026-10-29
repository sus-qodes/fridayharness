import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ParamsOf, type ResultOf, ToolCheckResult } from '@friday/protocol';
import type { ControlledProfile } from './profile.js';
import { type OpenCodeCall, translateOpenCode } from './translate.js';

export type ToolCheck = (params: ParamsOf<'tool.check'>) => Promise<ResultOf<'tool.check'>>;
class TimeoutError extends Error {}
/** One host/session/nonce only; no bootstrap credential or general RPC surface reaches the host. */
export class PolicyBridge {
  #server: Server | undefined;
  #profile: ControlledProfile | undefined;
  #session: string | undefined;
  #ready = false;
  #calls = new Set<string>();
  readonly secret = randomBytes(32).toString('hex');
  readonly nonce = randomBytes(32).toString('hex');
  url = '';
  constructor(
    private readonly check: ToolCheck,
    readonly timeoutMs = 4000,
  ) {}
  get ready(): boolean {
    return this.#ready;
  }
  setProfile(profile: ControlledProfile): void {
    this.#profile = profile;
  }
  bind(session: string): void {
    if (!this.#ready || this.#session) throw new Error('policy plugin is not ready or session is already bound');
    this.#session = session;
  }
  /**
   * Moves the one binding to a new session (checkpoint C, plan M8b.6): the session it leaves loses
   * its authority at once, so at most one session is ever bound.
   */
  rebind(session: string): void {
    if (!this.#ready || !this.#session) throw new Error('policy plugin is not ready or no session is bound');
    this.#session = session;
  }
  async open(): Promise<void> {
    const server = createServer((req, res) => {
      void (async () => {
        const reply = (status: number, data: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
        const token = Buffer.from(String(req.headers.authorization ?? ''));
        const wanted = Buffer.from(`Bearer ${this.secret}`);
        if (
          req.method !== 'POST' ||
          req.url !== '/policy' ||
          req.headers.host !== new URL(this.url).host ||
          req.headers.origin ||
          token.length !== wanted.length ||
          !timingSafeEqual(token, wanted)
        )
          return reply(401, { ok: false });
        let raw = '';
        for await (const chunk of req) {
          raw += String(chunk);
          if (Buffer.byteLength(raw) > 64 * 1024) return reply(413, { ok: false });
        }
        const body = JSON.parse(raw) as Record<string, unknown>;
        const p = this.#profile;
        if (!p || body.nonce !== this.nonce || body.directory !== p.cwd || body.pluginHash !== p.pluginHash)
          return reply(403, { ok: false });
        p.verify();
        if (body.kind === 'ready') {
          if (this.#ready) return reply(409, { ok: false });
          this.#ready = true;
          return reply(200, { ok: true });
        }
        if (body.kind !== 'check' || !this.#ready) return reply(403, { ok: false });
        // From here the caller is Friday's own plugin in its own profile: each refusal says why, so
        // the model and the record read the reason instead of a bare failure (plan M14.1).
        const deny = (reason: string) => reply(200, { ok: true, decision: 'deny', reason });
        if (!this.#session || body.sessionID !== this.#session)
          return deny('this session is not the one Friday bound to the task');
        if (typeof body.callID !== 'string' || !body.callID || body.callID.length > 200)
          return deny('the call has no usable call id');
        if (this.#calls.has(body.callID)) return deny('a call with this id was already judged');
        if (this.#calls.size >= 2000) return deny('this session has made more calls than Friday judges');
        if (typeof body.tool !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args))
          return deny('the call is malformed');
        this.#calls.add(body.callID);
        let action: ReturnType<typeof translateOpenCode>;
        try {
          action = translateOpenCode(body as unknown as OpenCodeCall, p.cwd);
        } catch (e) {
          return deny(`Friday does not judge this call: ${(e as Error).message}`);
        }
        let timer: NodeJS.Timeout | undefined;
        let verdict: ReturnType<typeof ToolCheckResult.parse>;
        try {
          verdict = ToolCheckResult.parse(
            await Promise.race([
              this.check({
                tool: body.tool === 'bash' ? (process.platform === 'win32' ? 'PowerShell' : 'Bash') : body.tool,
                action,
              }),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new TimeoutError()), this.timeoutMs);
              }),
            ]),
          );
        } catch (e) {
          return deny(
            e instanceof TimeoutError
              ? `Friday did not answer within ${this.timeoutMs} ms`
              : 'Friday could not judge the call (it is out of reach or the check failed)',
          );
        } finally {
          clearTimeout(timer);
        }
        p.verify();
        // Only an explicit allow proceeds; a refusal or a question for a human carries Friday's reason.
        if (verdict?.decision === 'allow') return reply(200, { ok: true, decision: 'allow', reason: '' });
        const why = typeof verdict?.reason === 'string' && verdict.reason ? verdict.reason.slice(0, 300) : '';
        return deny(
          verdict?.decision === 'ask'
            ? `a human decides this, and no human answers this session${why ? `: ${why}` : ''}`
            : why || 'Friday policy did not allow this call',
        );
      })().catch(() => {
        if (!res.headersSent) res.writeHead(403, { 'content-type': 'application/json' }).end('{"ok":false}');
        else res.destroy();
      });
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.#server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/policy`;
  }
  async close(): Promise<void> {
    this.#ready = false;
    this.#session = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
