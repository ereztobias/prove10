import { describe, it, expect, beforeEach } from 'vitest';
import { call, clearAll, row, count, signup, seed } from './helpers.js';

beforeEach(clearAll);

describe('what it refuses', () => {
  it('rejects a body that is not JSON', async () => {
    const r = await call('/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('expected json');
  });

  it.each([
    ['', 'nothing'],
    ['nope', 'no at sign'],
    ['a@b', 'no dot'],
    ['a@b.c', 'one-letter tld'],
    ['two words@example.com', 'a space'],
    ['a@@example.com', 'two at signs'],
  ])('rejects %j (%s)', async (email) => {
    const r = await signup(email);
    expect(r.status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('rejects an address longer than 254 characters', async () => {
    expect((await signup('x'.repeat(250) + '@example.com')).status).toBe(400);
  });

  it('rejects an Origin it does not know', async () => {
    const r = await signup('a@example.com', { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('accepts no Origin at all, which is what curl and a server send', async () => {
    expect((await signup('a@example.com')).status).toBe(200);
  });

  it('accepts the site itself', async () => {
    const r = await signup('a@example.com', { origin: 'https://prove10.com' });
    expect(r.status).toBe(200);
  });
});

describe('what it stores', () => {
  it('stores the address', async () => {
    await signup('reader@example.com');
    expect((await row()).email).toBe('reader@example.com');
  });

  it('lowercases and trims, so one person is one row', async () => {
    await signup('  Reader@Example.COM  ');
    await signup('reader@example.com');
    expect(await count()).toBe(1);
    expect((await row()).email).toBe('reader@example.com');
  });

  // Submitting the form is the consent, so the row is mailable at once.
  // The gate used to live in a mail, and a mail that went to junk meant
  // the person never joined.
  it('is confirmed on submit, and records when', async () => {
    await signup('reader@example.com');
    const r = await row();
    expect(r.confirmed).toBe(1);
    expect(r.confirmed_at).not.toBeNull();
  });

  // confirmed_at is the record of when consent was first given, so a
  // re-submit must not move it forward.
  it('keeps the first consent date when the same address comes back', async () => {
    const first = '2020-01-02 03:04:05';
    await seed({ confirmed: 1, confirmedAt: first });
    await signup('reader@example.com');
    expect((await row()).confirmed_at).toBe(first);
  });

  it('mints a token that looks like the ones the links carry', async () => {
    await signup('reader@example.com');
    expect((await row()).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the consent wording, not just a timestamp', async () => {
    await signup('reader@example.com');
    expect((await row()).consent)
      .toBe('One email when there is something to use. Nothing else, ever.');
  });

  it('stores a hash of the IP and never the IP', async () => {
    await signup('reader@example.com', { ip: '203.0.113.9' });
    const hash = (await row()).ip_hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('203.0.113.9');
  });

  it('gives two different IPs two different hashes', async () => {
    await signup('one@example.com', { ip: '203.0.113.1' });
    await signup('two@example.com', { ip: '203.0.113.2' });
    expect((await row('one@example.com')).ip_hash)
      .not.toBe((await row('two@example.com')).ip_hash);
  });

  it('salts the hash, so the same IP hashes differently under another salt', async () => {
    await signup('one@example.com', { ip: '203.0.113.1' });
    await signup('two@example.com', { ip: '203.0.113.1', over: { IP_SALT: 'another salt' } });
    expect((await row('one@example.com')).ip_hash)
      .not.toBe((await row('two@example.com')).ip_hash);
  });
});

describe('without IP_SALT', () => {
  it('refuses rather than storing an unsalted hash', async () => {
    const r = await signup('reader@example.com', { over: { IP_SALT: undefined } });
    expect(r.status).toBe(500);
    expect(await count()).toBe(0);
  });
});

describe('signing up again', () => {
  it('does not mint a second token for an address that has one', async () => {
    await signup('reader@example.com');
    const first = (await row()).token;
    await signup('reader@example.com');
    expect((await row()).token).toBe(first);
    expect(await count()).toBe(1);
  });

  it('clears an unsubscribe, which is the only way back onto the list', async () => {
    await seed({ confirmed: 0, unsubscribedAt: '2026-01-01 00:00:00' });
    await signup('reader@example.com');
    expect((await row()).unsubscribed_at).toBeNull();
  });

  it('puts them straight back on the list', async () => {
    await seed({ confirmed: 0, unsubscribedAt: '2026-01-01 00:00:00' });
    await signup('reader@example.com');
    const r = await row();
    expect(r.confirmed).toBe(1);
    expect(r.unsubscribed_at).toBeNull();
  });
});

describe('rate limit', () => {
  const ten = async (ip) => {
    for (let i = 0; i < 10; i++) await signup('p' + i + '@example.com', { ip });
  };

  it('lets ten through from one address in an hour', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await signup('p' + i + '@example.com', { ip: '198.51.100.7' })).status).toBe(200);
    }
  });

  it('refuses the eleventh and says when to come back', async () => {
    await ten('198.51.100.7');
    const r = await signup('eleventh@example.com', { ip: '198.51.100.7' });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('3600');
  });

  it('counts per address, so one machine cannot shut out another', async () => {
    await ten('198.51.100.7');
    expect((await signup('elsewhere@example.com', { ip: '198.51.100.8' })).status).toBe(200);
  });
});
