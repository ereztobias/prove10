/**
 * prove10 signup endpoint.
 *
 * Runs on api.prove10.com so the apex stays DNS-only and GitHub Pages
 * keeps renewing its own certificate. Stores addresses in D1.
 *
 * Routes:
 *   POST /subscribe      { email } -> { ok: true }
 *   GET  /confirm?t=     double opt-in link from the confirmation email
 *   GET  /unsubscribe?t= the one click the page promises
 *
 * Deliberate choices:
 *  - /subscribe answers 200 whether the address is new or already
 *    stored, so the endpoint cannot be used to test who is on the list.
 *  - Keeps a salted hash of the IP, never the address itself, and only
 *    to rate limit.
 *  - A row is mailable only where confirmed = 1 and unsubscribed_at is
 *    null. Not confirmed_at: that stays as a record of when consent was
 *    first given, and someone who unsubscribes and later re-enters their
 *    address still has to confirm again before anything is sent.
 *  - Sending is optional. Without RESEND_API_KEY the address is stored
 *    unconfirmed and no mail goes out, which is the state the project
 *    is in until a provider is chosen.
 */

const ALLOWED_ORIGINS = new Set([
  'https://prove10.com',
  'https://www.prove10.com',
]);

// Deliberately boring: catches typos, does not try to out-parse RFC 5322.
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

const MAX_PER_IP_PER_HOUR = 10;
const SITE = 'https://prove10.com';

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(status, payload, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** A reply in the same clothes as the page, so a link does not land somewhere strange. */
function page(status, heading, body) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark"><title>prove10</title>' +
    '<style>' +
    ':root{color-scheme:dark}' +
    'body{margin:0;min-height:100svh;display:grid;place-items:center;' +
    'background:#06080e;color:#e9edf6;text-align:center;' +
    'font-family:Sora,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;' +
    'font-weight:300;line-height:1.6;' +
    'padding-left:max(16px,env(safe-area-inset-left,0px));' +
    'padding-right:max(16px,env(safe-area-inset-right,0px))}' +
    'main{display:grid;gap:1rem;max-width:34ch}' +
    'h1{margin:0;font-size:clamp(1.6rem,1rem + 2.4vw,2.4rem);font-weight:300;letter-spacing:-0.03em}' +
    'p{margin:0;color:#7c879c}' +
    'a{color:#8fa6ff;text-underline-offset:3px}' +
    '</style></head><body><main>' +
    '<h1>' + escapeHtml(heading) + '</h1>' +
    '<p>' + escapeHtml(body) + '</p>' +
    '<p><a href="' + SITE + '">prove10.com</a></p>' +
    '</main></body></html>';
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Sends the confirmation mail when a provider is configured. Returns
 * quietly otherwise: a missing key must never cost the signup.
 */
async function sendConfirmation(env, email, token) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return;
  const link = 'https://api.prove10.com/confirm?t=' + token;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [email],
        subject: 'Confirm your email',
        text:
          'Tap to confirm you want one email from prove10 when there is ' +
          'something to use:\n\n' + link + '\n\n' +
          'If you did not ask for this, ignore it and nothing happens.',
      }),
    });
    if (!r.ok) console.error('resend refused', r.status, await r.text());
  } catch (err) {
    console.error('confirmation mail failed', err);
  }
}

async function subscribe(request, env, headers) {
  const origin = request.headers.get('Origin');
  // A browser always sends Origin on a cross-origin POST. Absent is fine
  // (curl, a server), present-and-unknown is not.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json(403, { error: 'forbidden' }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'expected json' }, headers);
  }

  const email = String(body?.email ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    return json(400, { error: 'that address does not look right' }, headers);
  }

  if (!env.IP_SALT) {
    console.error('IP_SALT is not set; refusing to store an unsalted hash');
    return json(500, { error: 'misconfigured' }, headers);
  }

  const ipHash = await sha256Hex((request.headers.get('CF-Connecting-IP') ?? '') + env.IP_SALT);

  try {
    const recent = await env.DB
      .prepare(
        'select count(*) as n from signups ' +
        "where ip_hash = ?1 and created_at > datetime('now', '-1 hour')"
      )
      .bind(ipHash)
      .first();

    if ((recent?.n ?? 0) >= MAX_PER_IP_PER_HOUR) {
      return json(429, { error: 'too many requests' }, { ...headers, 'Retry-After': '3600' });
    }

    // Re-subscribing after an unsubscribe should work, and must not mint
    // a second token for an address that already has one.
    await env.DB
      .prepare(
        'insert into signups (email, ip_hash, country, token, created_at) ' +
        "values (?1, ?2, ?3, ?4, datetime('now')) " +
        'on conflict(email) do update set unsubscribed_at = null'
      )
      .bind(email, ipHash, request.cf?.country ?? null, newToken())
      .run();

    const row = await env.DB
      .prepare('select token, confirmed from signups where email = ?1')
      .bind(email)
      .first();

    if (row?.token && !row.confirmed) {
      await sendConfirmation(env, email, row.token);
    }
  } catch (err) {
    console.error('d1 write failed', err);
    return json(500, { error: 'could not store that' }, headers);
  }

  return json(200, { ok: true }, headers);
}

async function confirm(url, env) {
  const token = url.searchParams.get('t') ?? '';
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return page(400, 'That link is not valid', 'Check it and try again.');
  }

  const r = await env.DB
    .prepare(
      'update signups set confirmed = 1, ' +
      "confirmed_at = coalesce(confirmed_at, datetime('now')), " +
      'unsubscribed_at = null where token = ?1'
    )
    .bind(token)
    .run();

  if (!r.meta?.changes) {
    return page(404, 'That link has expired', 'Sign up again and we will send a fresh one.');
  }
  return page(200, 'Confirmed',
    'You are on the list. One email when there is something to use, and nothing else.');
}

async function unsubscribe(url, env) {
  const token = url.searchParams.get('t') ?? '';
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return page(400, 'That link is not valid', 'Check it and try again.');
  }

  // Keep the row, marked, so a later import cannot quietly re-add them.
  const r = await env.DB
    .prepare(
      "update signups set unsubscribed_at = datetime('now'), confirmed = 0 where token = ?1"
    )
    .bind(token)
    .run();

  if (!r.meta?.changes) {
    return page(404, 'Nothing to remove', 'That address is not on the list.');
  }
  return page(200, 'Removed', 'You will not hear from us again. No hard feelings.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === '/subscribe') {
      if (request.method !== 'POST') {
        return json(405, { error: 'method not allowed' }, { ...headers, Allow: 'POST, OPTIONS' });
      }
      return subscribe(request, env, headers);
    }

    if (url.pathname === '/confirm' || url.pathname === '/unsubscribe') {
      if (request.method !== 'GET') {
        return json(405, { error: 'method not allowed' }, { ...headers, Allow: 'GET' });
      }
      return url.pathname === '/confirm' ? confirm(url, env) : unsubscribe(url, env);
    }

    return json(404, { error: 'not found' }, headers);
  },
};
