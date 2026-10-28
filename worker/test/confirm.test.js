import { describe, it, expect, beforeEach } from 'vitest';
import { call, clearAll, seed, row, heading, signup, TOKEN_A, TOKEN_B } from './helpers.js';

const look = (t) => call('/confirm?t=' + t);
const press = (t) => call('/confirm?t=' + t, { method: 'POST' });

beforeEach(clearAll);

describe('GET, which is what a link scanner fetches', () => {
  it('changes nothing', async () => {
    await seed();
    await look(TOKEN_A);
    const r = await row();
    expect(r.confirmed).toBe(0);
    expect(r.confirmed_at).toBeNull();
  });

  it('offers a button that posts back to the same token', async () => {
    await seed();
    const html = await (await look(TOKEN_A)).text();
    expect(html).toContain('<form method="post" action="/confirm?t=' + TOKEN_A + '"');
    expect(html).toContain('Confirm my email');
  });

  it('rejects a token that is not 64 hex characters', async () => {
    const r = await look('zzz');
    expect(r.status).toBe(400);
    expect(heading(await r.text())).toBe('That link is not valid');
  });

  it('rejects a missing token', async () => {
    expect((await call('/confirm')).status).toBe(400);
  });

  it('is never cached, because it names a token', async () => {
    await seed();
    const r = await look(TOKEN_A);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('POST, which is the person pressing the button', () => {
  it('confirms the row', async () => {
    await seed();
    const r = await press(TOKEN_A);
    expect(r.status).toBe(200);
    expect(heading(await r.text())).toBe('Confirmed');
    expect((await row()).confirmed).toBe(1);
  });

  it('stamps when it happened', async () => {
    await seed();
    await press(TOKEN_A);
    expect((await row()).confirmed_at).not.toBeNull();
  });

  it('keeps the first timestamp when pressed twice', async () => {
    await seed({ confirmed: 1, confirmedAt: '2026-01-01 00:00:00' });
    await press(TOKEN_A);
    expect((await row()).confirmed_at).toBe('2026-01-01 00:00:00');
  });

  it('says the link expired when no row carries that token', async () => {
    const r = await press(TOKEN_B);
    expect(r.status).toBe(404);
    expect(heading(await r.text())).toBe('That link has expired');
  });

  it('rejects a malformed token before touching the database', async () => {
    expect((await press('nope')).status).toBe(400);
  });
});

// The token never rotates, so the first confirmation email stays live in
// the inbox for good. It must not be a way back onto a list someone left.
describe('a confirm link replayed after unsubscribing', () => {
  const left = () => seed({ confirmed: 0, unsubscribedAt: '2026-02-02 00:00:00' });

  it('does not put them back on the list', async () => {
    await left();
    await press(TOKEN_A);
    expect((await row()).confirmed).toBe(0);
  });

  it('leaves the unsubscribe on the record', async () => {
    await left();
    await press(TOKEN_A);
    expect((await row()).unsubscribed_at).toBe('2026-02-02 00:00:00');
  });

  it('says so, rather than claiming the link expired', async () => {
    await left();
    const r = await press(TOKEN_A);
    expect(r.status).toBe(409);
    expect(heading(await r.text())).toBe('You unsubscribed from this list');
  });

  it('still confirms once they have deliberately signed up again', async () => {
    await left();
    await signup('reader@example.com');
    const r = await press(TOKEN_A);
    expect(r.status).toBe(200);
    expect((await row()).confirmed).toBe(1);
  });
});
