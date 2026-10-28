import { describe, it, expect, beforeEach } from 'vitest';
import { call, clearAll, TOKEN_A } from './helpers.js';

beforeEach(clearAll);

const preflight = (origin) =>
  call('/subscribe', { method: 'OPTIONS', headers: { Origin: origin } });

describe('CORS', () => {
  it('answers a preflight without a body', async () => {
    const r = await preflight('https://prove10.com');
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
  });

  it('echoes an allowed origin back', async () => {
    const r = await preflight('https://prove10.com');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://prove10.com');
  });

  it('allows the www host too', async () => {
    const r = await preflight('https://www.prove10.com');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://www.prove10.com');
  });

  it('does not echo an origin it does not know', async () => {
    const r = await preflight('https://evil.example');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('varies on Origin, so a cache cannot serve one site another answer', async () => {
    const r = await preflight('https://prove10.com');
    expect(r.headers.get('Vary')).toBe('Origin');
  });
});

describe('methods', () => {
  it('refuses GET on /subscribe and says what is allowed', async () => {
    const r = await call('/subscribe');
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('refuses PUT on /confirm and offers both GET and POST', async () => {
    const r = await call('/confirm?t=' + TOKEN_A, { method: 'PUT' });
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET, POST, OPTIONS');
  });

  it('refuses PUT on /unsubscribe', async () => {
    const r = await call('/unsubscribe?t=' + TOKEN_A, { method: 'PUT' });
    expect(r.status).toBe(405);
  });

  it('refuses POST on /emails', async () => {
    const r = await call('/emails', { method: 'POST' });
    expect(r.status).toBe(405);
  });
});

describe('robots.txt', () => {
  it('shuts the whole host out', async () => {
    const r = await call('/robots.txt');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('is served as plain text', async () => {
    const r = await call('/robots.txt');
    expect(r.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });
});

describe('anything else', () => {
  it('is a 404', async () => {
    const r = await call('/nope');
    expect(r.status).toBe(404);
  });
});
