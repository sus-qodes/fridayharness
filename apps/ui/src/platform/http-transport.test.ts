import { describe, expect, it, vi } from 'vitest';
import { FridayApi } from '../api/client.js';
import { HttpTransport } from './http-transport.js';

describe('HttpTransport keepalive', () => {
  it('lets only the preferences saved as the page hides outlive the page', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const transport = new HttpTransport('http://127.0.0.1:4310', () => 'tok', fetchImpl as unknown as typeof fetch);
    const api = new FridayApi(transport, 'proj_1');
    await api.saveUiPrefs({ volume: 0.3 }, { keepalive: true });
    await api.saveUiPrefs({ volume: 0.3 });
    await api.uiPrefs();
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([, init]) => init.keepalive)).toEqual([true, undefined, undefined]);
    const [url, init] = calls[0] ?? ['', {}];
    expect(url).toBe('http://127.0.0.1:4310/api/v1/projects/proj_1/ui/prefs');
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ prefs: { volume: 0.3 } }),
      credentials: 'omit',
    });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
});
