import { describe, it, expect, beforeEach } from 'vitest';
import { call, clearAll, seed, row, heading, TOKEN_A, TOKEN_B } from './helpers.js';

const look = (t) => call('/unsubscribe?t=' + t);
const press = (t, init = {}) => call('/unsubscribe?t=' + t, { method: 'POST', ...init });

beforeEach(clearAll);

describe('GET', () => {
  it('changes nothing', async () => {
    await seed({ confirmed: 1 });
    await look(TOKEN_A);
    const r = await row();
    expect(r.confirmed).toBe(1);
    expect(r.unsubscribed_at).toBeNull();
  });

  it('offers the button', async () => {
    await seed({ confirmed: 1 });
    const html = await (await look(TOKEN_A)).text();
    expect(html).toContain('<form method="post" action="/unsubscribe?t=' + TOKEN_A + '"');
    expect(html).toContain('Unsubscribe');
  });

  it('rejects a malformed token', async () => {
    expect((await look('nope')).status).toBe(400);
  });
});

describe('POST', () => {
  it('marks the row rather than deleting it', async () => {
    await seed({ confirmed: 1 });
    const r = await press(TOKEN_A);
    expect(r.status).toBe(200);
    expect(heading(await r.text())).toBe('Removed');
    const after = await row();
    expect(after).not.toBeNull();
    expect(after.unsubscribed_at).not.toBeNull();
  });

  it('stops them being mailable', async () => {
    await seed({ confirmed: 1 });
    await press(TOKEN_A);
    expect((await row()).confirmed).toBe(0);
  });

  it('says there is nothing to remove for an unknown token', async () => {
    const r = await press(TOKEN_B);
    expect(r.status).toBe(404);
    expect(heading(await r.text())).toBe('Nothing to remove');
  });
});

// RFC 8058. Gmail and Outlook post this body to the List-Unsubscribe URL
// when someone uses the mail client's own unsubscribe control.
describe('one-click', () => {
  it('accepts the form post a mail provider sends', async () => {
    await seed({ confirmed: 1 });
    const r = await press(TOKEN_A, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(r.status).toBe(200);
    expect((await row()).unsubscribed_at).not.toBeNull();
  });
});
