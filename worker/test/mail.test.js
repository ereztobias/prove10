import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearAll, signup, row, call } from './helpers.js';

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

// Value: protects=the welcome mail's List-Unsubscribe names the row's own
// token, and the Post header asks for One-Click; fails_when=sendConfirmation
// stops passing the headers, or either value drifts from RFC 8058;
// why_new=nothing else reads what is posted to Resend; seam=none;
// no_claim=nothing about where a mailbox provider files the mail
describe('the welcome mail', () => {
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
  //
  // Value: protects=the URL the header names removes the address on a bare
  // POST; fails_when=the /unsubscribe POST route starts requiring a form body
  // or stops writing unsubscribed_at; why_new=unsubscribe.test.js covers the
  // route, not the URL the header hands a provider; seam=none;
  // no_claim=that any provider actually sends the one-click POST
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

// Value: protects=owner notification carries no List-Unsubscribe; fails_when=unsubscribeHeaders moves into sendMail or notifyOwner; why_new=only the confirmation mail's headers are asserted; seam=none; no_claim=says nothing about the notification's body
describe('the owner notification', () => {
  it('goes out without the list headers, which are not its to say', async () => {
    await signup('reader@example.com', {
      over: { ...SENDING, NOTIFY_TO: 'owner@example.com' },
    });

    const owner = sent.find((s) => s.body.to[0] === 'owner@example.com');
    expect(owner).toBeDefined();
    expect(owner.body).not.toHaveProperty('headers');
    // Named the field, so renaming it would leave the line above green
    // while the header went out anyway. This one reads the whole payload.
    expect(JSON.stringify(owner.body)).not.toContain('List-Unsubscribe');
  });
});

// The footer used to promise "a one-click unsubscribe link" while the only
// unsubscribe lived in a header the reader cannot see. Outlook weighs a
// visible way out, and the claim was false either way.
//
// Value: protects=both parts of the confirmation carry a clickable unsubscribe
// URL, and it is the same route the header names; fails_when=the visible link
// is dropped from either part, or starts pointing somewhere the header does
// not; why_new=the header tests read what is posted to Resend, nothing reads
// the mail body; seam=none; no_claim=nothing about where Outlook files the mail
describe('the welcome body', () => {
  it('shows the same unsubscribe URL the header names, in both parts', async () => {
    await signup('reader@example.com', { over: SENDING });

    const { token } = await row('reader@example.com');
    const url = 'https://api.prove10.com/unsubscribe?t=' + token;
    const { text, html, headers } = sent[0].body;

    expect(headers['List-Unsubscribe']).toBe('<' + url + '>');
    expect(text).toContain(url);
    // Clickable, not just mentioned: an href, so a mail client renders it.
    expect(html).toContain('href="' + url + '"');
  });

  it('no longer promises a link it does not carry', async () => {
    await signup('reader@example.com', { over: SENDING });
    const { text, html } = sent[0].body;

    expect(text).not.toContain('Every email we send carries');
    expect(html).not.toContain('Every email we send carries');
  });
});

// The welcome asks for nothing, so there is no second click to lose. A
// confirm link in it would be exactly the dependency this change removed.
//
// Value: protects=the mail sent on signup carries no /confirm link and no
// instruction to act; fails_when=the confirm button or its paste-the-link
// fallback comes back; why_new=the body tests read the unsubscribe link, not
// what is absent; seam=none; no_claim=nothing about the /confirm route, which
// still answers for links already sent
describe('the welcome mail', () => {
  it('asks for nothing', async () => {
    await signup('reader@example.com', { over: SENDING });
    const { text, html, subject } = sent[0].body;

    expect(subject).toBe('You are on the list');
    expect(text).not.toContain('/confirm');
    expect(html).not.toContain('/confirm');
  });
});

// Value: protects=one welcome per arrival, so the public form cannot be used
// to mail an address repeatedly; fails_when=the send stops being gated on
// isNew or wasAway; why_new=no test submits the same address twice with
// sending on; seam=none; no_claim=nothing about the rate limit, which counts
// per IP rather than per address
describe('a second submit of the same address', () => {
  it('sends nothing, but a return after unsubscribing does', async () => {
    await signup('reader@example.com', { over: SENDING });
    expect(sent).toHaveLength(1);

    await signup('reader@example.com', { over: SENDING });
    expect(sent).toHaveLength(1);

    await call('/unsubscribe?t=' + (await row('reader@example.com')).token,
      { method: 'POST' });
    await signup('reader@example.com', { over: SENDING });
    expect(sent).toHaveLength(2);
  });
});

// A 2xx from Resend used to be silent, so "nothing arrived" and "nothing
// was sent" looked the same in the logs. The id is the only handle that
// reaches Resend's own delivery and suppression records.
//
// Value: protects=an accepted send logs its Resend id and which mail it
// was, and logs no recipient address; fails_when=the success log is dropped,
// stops reading id off the response, or starts naming the recipient;
// why_new=no test reads what a successful send writes to the log;
// seam=console.log spy; no_claim=nothing about log retention in production
describe('an accepted send', () => {
  let logged;

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logged.push(args));
  });

  afterEach(() => vi.restoreAllMocks());

  it('logs the Resend id and the kind of mail, and no address', async () => {
    await signup('reader@example.com', {
      over: { ...SENDING, NOTIFY_TO: 'owner@example.com' },
    });

    const accepted = logged.filter((a) => a[0] === 'resend accepted');
    expect(accepted).toEqual([
      ['resend accepted', 'welcome', 'stub'],
      ['resend accepted', 'owner-notification', 'stub'],
    ]);
    // The id alone is the lookup key; an address in a retained log is not.
    expect(JSON.stringify(logged)).not.toContain('reader@example.com');
  });

  // A receipt that is not JSON must not turn a delivered mail into a
  // failure: the 2xx already said Resend took it.
  it('still counts as sent when the body is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('accepted', { status: 200 }));

    const r = await signup('reader@example.com', { over: SENDING });

    expect(r.status).toBe(200);
    expect(logged).toContainEqual(['resend accepted', 'welcome', '(no id)']);
  });
});

// Value: protects=a refused send never logs "resend accepted" and never costs
// the signup; fails_when=the success log moves above the r.ok check or a refusal
// throws out of sendMail; why_new=every other test stubs a 2xx; seam=console
// spy; no_claim=nothing about the text of the refusal log
describe('a refused send', () => {
  it('is not logged as accepted and does not fail the signup', async () => {
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logged.push(args));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('{"message":"no"}', { status: 422 }));

    const r = await signup('reader@example.com', { over: SENDING });

    expect(r.status).toBe(200);
    expect(logged.filter((a) => a[0] === 'resend accepted')).toEqual([]);
    vi.restoreAllMocks();
  });
});
