/**
 * Friday's tools for the sessions a Claude spawn adapter starts (review M8-R06, ADR-0032 §11),
 * served over MCP on 127.0.0.1 by the adapter itself. Each attempt has its own address and secret,
 * written into that attempt's MCP configuration only. The secret grants nothing beyond what the
 * session already has: the attempt's own tools, acting for its own task and run through the
 * adapter's registration. An attempt's address stops answering when the attempt ends.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createToolServer, type FridayTool } from '@friday/mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

interface Route {
  secret: Buffer;
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

export class ToolEndpoints {
  readonly #routes = new Map<string, Route>();
  #server: Server | undefined;
  #port = 0;

  /** Serves an attempt's tools; resolves with where its session finds them, and the secret it sends. */
  async open(id: string, tools: FridayTool[]): Promise<{ url: string; secret: string }> {
    await this.#listen();
    await this.close(id);
    const secret = randomBytes(32).toString('hex');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      allowedHosts: [`127.0.0.1:${this.#port}`],
      enableDnsRebindingProtection: true,
    });
    const server = createToolServer(tools);
    await server.connect(transport);
    this.#routes.set(id, {
      secret: Buffer.from(secret),
      transport,
      close: async () => {
        await server.close().catch(() => undefined);
      },
    });
    return { url: `http://127.0.0.1:${this.#port}/mcp/${id}`, secret };
  }

  /** The attempt's address stops answering. */
  async close(id: string): Promise<void> {
    const r = this.#routes.get(id);
    if (!r) return;
    this.#routes.delete(id);
    await r.close();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#routes.keys()].map((id) => this.close(id)));
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #listen(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => void this.#serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refuse = (status: number, why: string) => {
      res.writeHead(status, { 'content-type': 'text/plain' }).end(why);
    };
    const id = /^\/mcp\/([A-Za-z0-9_]+)$/.exec(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)?.[1];
    const route = id ? this.#routes.get(id) : undefined;
    // A browser page never reaches these tools, nor does a caller without the attempt's secret.
    if (!route || req.headers.origin) return refuse(404, 'not found');
    const given = Buffer.from(/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '');
    if (given.length !== route.secret.length || !timingSafeEqual(given, route.secret))
      return refuse(401, 'unauthorized');
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 1_000_000) return refuse(413, 'too large');
        chunks.push(c as Buffer);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return refuse(400, 'not JSON');
      }
    }
    await route.transport.handleRequest(req, res, body).catch(() => {
      if (!res.headersSent) refuse(500, 'failed');
    });
  }
}
