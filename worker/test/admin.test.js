import { describe, it, expect, beforeEach } from 'vitest';
import { call, clearAll, seed, basic, PASSWORD } from './helpers.js';

const open = (path, auth, over = {}) =>
  call(path, auth === undefined ? {} : { headers: { Authorization: auth } }, over);

beforeEach(clearAll);

describe('getting in', () => {
  it('asks for a password when none is offered', async () => {
    const r = await open('/emails');
    expect(r.status).toBe(401);
    expect(r.headers.get('WWW-Authenticate')).toBe('Basic realm="Prove10", charset="UTF-8"');
  });

  it('refuses the wrong password', async () => {
    expect((await open('/emails', basic('hunter2'))).status).toBe(401);
  });

  it('refuses a password that is merely a prefix of the right one', async () => {
    expect((await open('/emails', basic(PASSWORD.slice(0, -1)))).status).toBe(401);
  });

  it('refuses a header that is not basic auth', async () => {
    expect((await open('/emails', 'Bearer ' + PASSWORD)).status).toBe(401);
  });

  it('refuses a header that is not valid base64', async () => {
    expect((await open('/emails', 'Basic !!!!')).status).toBe(401);
  });

  it('refuses base64 with no colon in it', async () => {
    expect((await open('/emails', 'Basic ' + btoa('nocolon'))).status).toBe(401);
  });

  it('lets the right password in', async () => {
    expect((await open('/emails', basic(PASSWORD))).status).toBe(200);
  });

  it('ignores the username, which is not part of the secret', async () => {
    expect((await open('/emails', basic(PASSWORD, 'whoever'))).status).toBe(200);
  });

  it('takes a password with colons in it, which basic auth allows', async () => {
    const r = await open('/emails', basic('pass:with:colons'),
      { ADMIN_PASSWORD: 'pass:with:colons' });
    expect(r.status).toBe(200);
  });

  it('opens at /admin as well, so neither name is a dead end', async () => {
    expect((await open('/admin', basic(PASSWORD))).status).toBe(200);
  });
});

describe('with no ADMIN_PASSWORD set', () => {
  const shut = { ADMIN_PASSWORD: undefined };

  it('is shut, not open', async () => {
    expect((await open('/emails', basic(PASSWORD), shut)).status).toBe(401);
  });

  it('is shut to an empty password too', async () => {
    expect((await open('/emails', basic(''), shut)).status).toBe(401);
  });
});

describe('the page', () => {
  const page = () => open('/emails', basic(PASSWORD)).then((r) => r.text());

  it('lists an address that is on it', async () => {
    await seed({ email: 'reader@example.com', confirmed: 1 });
    expect(await page()).toContain('reader@example.com');
  });

  it('escapes an address that carries markup', async () => {
    await seed({ email: '<img src=x onerror=alert(1)>@example.com' });
    const html = await page();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('is never cached, shared or indexed: it is a list of addresses', async () => {
    const r = await open('/emails', basic(PASSWORD));
    expect(r.headers.get('Cache-Control')).toBe('no-store, private');
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('says so plainly when there is nobody', async () => {
    expect(await page()).toContain('Nobody yet.');
  });
});
