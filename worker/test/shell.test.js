import { describe, it, expect } from 'vitest';
import { call, TOKEN_A } from './helpers.js';

// These pages are on api.prove10.com, which holds none of the site's
// files, so every asset they name has to be absolute.
describe('the shell every Worker page shares', () => {
  const load = () => call('/confirm?t=' + TOKEN_A).then((r) => r.text());

  it('carries the lockup, drawn rather than set in type', async () => {
    const html = await load();
    expect(html).toContain('class="mark"');
    expect(html).toContain('Prove<b>10</b>');
  });

  it('points the lockup back at the site', async () => {
    expect(await load()).toContain('<a class="wordmark" href="https://prove10.com">');
  });

  it('names its icons absolutely, because this host does not hold them', async () => {
    const html = await load();
    expect(html).toContain('href="https://prove10.com/logo.svg"');
    expect(html).toContain('href="https://prove10.com/favicon.ico"');
    expect(html).toContain('href="https://prove10.com/apple-touch-icon.png"');
  });

  it('is served as HTML and never indexed', async () => {
    const r = await call('/confirm?t=' + TOKEN_A);
    expect(r.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });
});
