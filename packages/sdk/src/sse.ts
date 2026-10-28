export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser: feed it text chunks in any split, get complete
 * messages back. Handles CRLF, multi-line `data:`, comments and `id:` (for Last-Event-ID).
 */
export class SseParser {
  #buffer = '';
  #lastId: string | null = null;

  get lastEventId(): string | null {
    return this.#lastId;
  }

  #pendingCr = false;

  push(chunk: string): SseMessage[] {
    // A CRLF can be split across chunks: hold a trailing CR until we see what follows it.
    let text = (this.#pendingCr ? '\r' : '') + chunk;
    this.#pendingCr = text.endsWith('\r');
    if (this.#pendingCr) text = text.slice(0, -1);
    this.#buffer += text.replace(/\r\n?/g, '\n');
    const out: SseMessage[] = [];
    let idx = this.#buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + 2);
      const msg = this.#parseBlock(block);
      if (msg) out.push(msg);
      idx = this.#buffer.indexOf('\n\n');
    }
    return out;
  }

  #parseBlock(block: string): SseMessage | undefined {
    let event = 'message';
    const data: string[] = [];
    let id: string | null = null;
    let sawField = false;
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      sawField = true;
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (!sawField) return undefined;
    if (id !== null) this.#lastId = id;
    if (data.length === 0 && id === null) return undefined;
    return { id: id ?? this.#lastId, event, data: data.join('\n') };
  }
}

/** Formats one SSE message. */
export function formatSse(msg: { id?: string | number; event?: string; data: string }): string {
  let out = '';
  if (msg.id !== undefined) out += `id: ${msg.id}\n`;
  if (msg.event) out += `event: ${msg.event}\n`;
  for (const line of msg.data.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}
