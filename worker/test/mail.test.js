import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearAll, signup, row } from './helpers.js';

// The suite is otherwise off the network because RESEND_API_KEY and
// MAIL_FROM are unset. Here they are bound for one call and fetch is
// replaced, so what the Worker would have posted to Resend can be read
// without a packet leaving the machine.
const SENDING = {
  RESEND_API_KEY: 'test-key-never-real',
  MAIL_FROM: 'prove10 <hello@prove10.com>',
};

let sent;

beforeEach(async () => {
  await clearAll();
  sent = [];
  vi.stubGlobal('fetch', async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"id":"stub"}', { status: 200 });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('the confirmation mail', () => {
  it('carries one-click unsubscribe headers pointing at the real route', async () => {
    await signup('reader@example.com', { over: SENDING });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.resend.com/emails');

    const { token } = await row('reader@example.com');
    expect(sent[0].body.headers).toEqual({
      'List-Unsubscribe': '<https://api.prove10.com/unsubscribe?t=' + token + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  // The header promises a POST works without a form, which is all RFC 8058
  // sends. If that ever stops being true the promise is a dead link.
  it('names a URL that unsubscribes on a bare POST', async () => {
    await signup('reader@example.com', { over: SENDING });
    const url = sent[0].body.headers['List-Unsubscribe'].slice(1, -1);

    const r = await fetchThroughWorker(url);
    expect(r.status).toBe(200);
    expect((await row('reader@example.com')).unsubscribed_at).not.toBeNull();
  });
});

// The stub above owns the global fetch, so the second test reaches the
// Worker the way helpers.call does rather than through it.
async function fetchThroughWorker(url) {
  const { default: worker } = await import('../src/index.js');
  const { env } = await import('cloudflare:workers');
  return worker.fetch(new Request(url, { method: 'POST' }), env);
}
