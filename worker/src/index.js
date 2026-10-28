/**
 * Prove10 signup endpoint.
 *
 * Runs on api.prove10.com so the apex stays DNS-only and GitHub Pages
 * keeps renewing its own certificate. Stores addresses in D1.
 *
 * Routes:
 *   POST /subscribe      { email } -> { ok: true }
 *   GET  /confirm?t=     double opt-in link from the confirmation email
 *   GET  /unsubscribe?t= the one click the page promises
 *   GET  /admin          the list, behind HTTP basic auth
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
 *  - Every outbound mail is optional. Without RESEND_API_KEY and
 *    MAIL_FROM the address is stored and nothing is sent.
 *  - /admin exists only while ADMIN_PASSWORD is set. Unset means the
 *    route is closed, not open: no password, no page.
 */

const ALLOWED_ORIGINS = new Set([
  'https://prove10.com',
  'https://www.prove10.com',
]);

// Deliberately boring: catches typos, does not try to out-parse RFC 5322.
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

const MAX_PER_IP_PER_HOUR = 10;
const SITE = 'https://prove10.com';

/**
 * The sentence printed beside the form, stored verbatim with every new
 * row. Article 7(1) of the GDPR puts the burden of showing consent on
 * us, and a timestamp does not show what was agreed to. Change the
 * wording on the page and change it here in the same commit; older rows
 * keep the wording that was actually on screen for them.
 *
 * Consent is deliberately narrow. Sending anything beyond the one email
 * named here would go past what these people agreed to.
 */
const CONSENT = 'One email when there is something to use. Nothing else, ever.';

// The list is small for a long time yet, and a cap keeps one bad query
// from pulling the whole table into a phone browser.
const ADMIN_PAGE_ROWS = 500;

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

async function sha256Bytes(input) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
}

async function sha256Hex(input) {
  const digest = await sha256Bytes(input);
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

/** Shared chrome, so every reply from this Worker looks like the site. */
const SHELL_CSS =
  ':root{color-scheme:dark}' +
  'body{margin:0;min-height:100svh;background:#06080e;color:#e9edf6;' +
  'font-family:Sora,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;' +
  'font-weight:300;line-height:1.6;' +
  'padding-left:max(16px,env(safe-area-inset-left,0px));' +
  'padding-right:max(16px,env(safe-area-inset-right,0px))}' +
  'h1{margin:0;font-size:clamp(1.6rem,1rem + 2.4vw,2.4rem);font-weight:300;letter-spacing:-0.03em}' +
  'a{color:#8fa6ff;text-underline-offset:3px}' +
  '.wordmark{display:inline-flex;align-items:center;font-size:1.0625rem;font-weight:600;' +
  'letter-spacing:-0.02em;color:#e9edf6;text-decoration:none}' +
  '.wordmark b{font-weight:600;color:#8fa6ff}' +
  '.mark{flex:none;width:1.3em;height:1.3em;margin-right:0.45em}' +
  '.mark circle{fill:none;stroke:#8fa6ff;stroke-width:3.2}' +
  '.mark .bolt{fill:currentColor;stroke:none}';

/**
 * The same lockup the site carries. Drawn as geometry rather than set in
 * type, which matters more here than on the site: these pages are built
 * from a string and load no font of their own.
 */
const LOCKUP =
  '<a class="wordmark" href="' + SITE + '">' +
  '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true">' +
  '<circle cx="16" cy="16" r="11"/>' +
  '<path class="bolt" d="M18.6 7.1 10.5 17.5h4.6l-1.7 7.3 8.1-10.3h-4.6z"/>' +
  '</svg>Prove<b>10</b></a>';

/* Absolute, because this host is not the one holding the files. Without
   it a tab opened from an email shows the browser's blank page icon. */
const ICONS =
  '<link rel="icon" href="' + SITE + '/logo.svg" type="image/svg+xml">' +
  '<link rel="icon" href="' + SITE + '/favicon.ico" sizes="48x48">' +
  '<link rel="apple-touch-icon" href="' + SITE + '/apple-touch-icon.png">';

/** A reply in the same clothes as the page, so a link does not land somewhere strange. */
function page(status, heading, body) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark"><title>Prove10</title>' + ICONS +
    '<style>' + SHELL_CSS +
    'body{display:grid;place-items:center;text-align:center}' +
    'main{display:grid;gap:1rem;max-width:34ch;justify-items:center}' +
    'p{margin:0;color:#7c879c}' +
    '</style></head><body><main>' +
    // The lockup is the way back, so the bare domain below it goes: one
    // link home is enough, and this one carries the mark.
    LOCKUP +
    '<h1>' + escapeHtml(heading) + '</h1>' +
    '<p>' + escapeHtml(body) + '</p>' +
    '</main></body></html>';
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/**
 * One way out for every mail this Worker sends. Returns false rather
 * than throwing: a mail problem must never cost a signup.
 */
async function sendMail(env, { to, subject, text, html, replyTo }) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  const payload = { from: env.MAIL_FROM, to: [to], subject, text };
  // Always send text as well. Some clients prefer it, some people read
  // only it, and a mail with both parts is treated better by filters.
  if (html) payload.html = html;
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      // Logged, not swallowed: retained logs are how a refused send
      // gets read after the fact. Never log the key.
      console.error('resend refused', r.status, await r.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('mail failed', err);
    return false;
  }
}

// Email clients are not browsers. Tables, inline styles, a web-safe
// stack instead of Sora, and a button built as a padded anchor inside a
// bgcolor cell so it survives Outlook's Word rendering engine.
const MAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * The postal address a commercial email is expected to carry. Kept in a
 * secret rather than in this file so it can be set once the company has
 * an address to give, without a code change.
 *
 * Unset, nothing is printed. A footer line reading "undefined" under the
 * sender's name is worse than no line at all.
 */
function postalLine(env) {
  const value = (env.POSTAL_ADDRESS ?? '').trim();
  return value.length ? value : null;
}

function confirmationHtml(link, postal) {
  const href = escapeHtml(link);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark light">' +
    '<meta name="supported-color-schemes" content="dark light">' +
    '<title>Confirm your email</title></head>' +
    '<body style="margin:0;padding:0;background-color:#06080e;">' +
    // Preview line in the inbox list, hidden in the body itself.
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' +
    'One tap and you are on the list.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="background-color:#06080e;"><tr>' +
    '<td align="center" style="padding:44px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="max-width:460px;"><tr><td>' +

    '<p style="margin:0 0 32px;font-family:' + MAIL_FONT + ';font-size:17px;' +
    'font-weight:600;letter-spacing:-0.02em;color:#e9edf6;">' +
    'Prove<span style="color:#8fa6ff;">10</span></p>' +

    '<h1 style="margin:0 0 14px;font-family:' + MAIL_FONT + ';font-size:26px;' +
    'font-weight:400;line-height:1.25;letter-spacing:-0.02em;color:#e9edf6;">' +
    'One tap and you are on the list.</h1>' +

    '<p style="margin:0 0 30px;font-family:' + MAIL_FONT + ';font-size:16px;' +
    'line-height:1.6;color:#9aa4b8;">' +
    'Confirm this address and we will send one email when there is ' +
    'something to use. Nothing else, ever.</p>' +

    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td align="center" bgcolor="#e9edf6" style="border-radius:2px;">' +
    '<a href="' + href + '" style="display:inline-block;padding:15px 30px;' +
    'font-family:' + MAIL_FONT + ';font-size:16px;font-weight:500;' +
    'color:#060810;text-decoration:none;border-radius:2px;">' +
    'Confirm your email</a></td></tr></table>' +

    // The button can be stripped, blocked or rendered unclickable. The
    // address itself has to be here too, or the mail is a dead end.
    '<p style="margin:30px 0 0;font-family:' + MAIL_FONT + ';font-size:13px;' +
    'line-height:1.6;color:#7c879c;">' +
    'Button not working? Paste this into your browser:<br>' +
    '<a href="' + href + '" style="color:#8fa6ff;word-break:break-all;">' +
    href + '</a></p>' +

    // Identity and the way out, in the mail itself. Israeli law wants
    // the sender named with contact details; GDPR wants withdrawal to
    // be as easy as consent was.
    '<p style="margin:34px 0 0;padding-top:22px;border-top:1px solid #1d2435;' +
    'font-family:' + MAIL_FONT + ';font-size:13px;line-height:1.6;color:#5b6479;">' +
    'If you did not ask for this, ignore it and nothing happens. ' +
    'We will not write again unless you confirm.<br><br>' +
    'Sent by Prove10 &middot; ' +
    '<a href="mailto:hello@prove10.com" style="color:#7c879c;">hello@prove10.com</a><br>' +
    (postal ? escapeHtml(postal) + '<br>' : '') +
    'You asked for: ' + escapeHtml(CONSENT) + ' ' +
    'Every email we send carries a one-click unsubscribe link, and ' +
    'our <a href="' + SITE + '/privacy/" style="color:#7c879c;">privacy policy</a> ' +
    'says what we store.</p>' +

    '</td></tr></table></td></tr></table></body></html>';
}

async function sendConfirmation(env, email, token) {
  const link = 'https://api.prove10.com/confirm?t=' + token;
  const postal = postalLine(env);
  return sendMail(env, {
    to: email,
    subject: 'Confirm your email',
    html: confirmationHtml(link, postal),
    text:
      'One tap and you are on the list.\n\n' +
      'Confirm this address and we will send one email when there is ' +
      'something to use. Nothing else, ever.\n\n' +
      'Confirm your email:\n' + link + '\n\n' +
      'If you did not ask for this, ignore it and nothing happens. ' +
      'We will not write again unless you confirm.\n\n' +
      '--\n' +
      'Sent by Prove10 - hello@prove10.com\n' +
      (postal ? postal + '\n' : '') +
      'You asked for: ' + CONSENT + '\n' +
      'Every email we send carries a one-click unsubscribe link.\n' +
      'Privacy policy: ' + SITE + '/privacy/',
  });
}

/**
 * Tells the owner about a new signup, but only once NOTIFY_TO is set.
 * That secret is the on switch: no address, no notification.
 */
async function notifyOwner(env, { email, country, total }) {
  if (!env.NOTIFY_TO) return false;
  return sendMail(env, {
    to: env.NOTIFY_TO,
    subject: 'New Prove10 signup: ' + email,
    replyTo: email,
    text:
      email + '\n' +
      'Country: ' + (country || 'unknown') + '\n' +
      'Total on the list: ' + total + '\n\n' +
      'They still have to confirm before anything can be sent to them.\n' +
      'The list: https://api.prove10.com/admin',
  });
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
  const country = request.cf?.country ?? null;

  try {
    // Asked before the upsert, because `insert ... on conflict do update`
    // reports changes = 1 either way and cannot tell us which happened.
    const existing = await env.DB
      .prepare('select email from signups where email = ?1')
      .bind(email)
      .first();
    const isNew = !existing;

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
        'insert into signups (email, ip_hash, country, token, consent, created_at) ' +
        "values (?1, ?2, ?3, ?4, ?5, datetime('now')) " +
        'on conflict(email) do update set unsubscribed_at = null, ' +
        // Someone re-entering their address is consenting again, under
        // whatever wording is on the page now.
        'consent = excluded.consent'
      )
      .bind(email, ipHash, country, newToken(), CONSENT)
      .run();

    const row = await env.DB
      .prepare('select token, confirmed from signups where email = ?1')
      .bind(email)
      .first();

    if (row?.token && !row.confirmed) {
      await sendConfirmation(env, email, row.token);
    }

    // Only a genuinely new row is worth telling the owner about; a
    // re-submit of an address already on the list is not news.
    if (isNew) {
      // No address here on purpose: retained logs are not the place for
      // one. The admin page is where addresses are read.
      console.log('signup stored: new row');
      const totals = await env.DB
        .prepare('select count(*) as n from signups')
        .first();
      await notifyOwner(env, { email, country, total: totals?.n ?? 0 });
    } else {
      console.log('signup stored: existing row');
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

  // The token never rotates, so the first confirmation email stays live
  // in the inbox forever. Clearing unsubscribed_at here meant one tap on
  // that old mail put someone back on a list they had left, which is the
  // opposite of what /privacy/ promises. Re-subscribing is the only way
  // back, and subscribe() clears the flag itself.
  const r = await env.DB
    .prepare(
      'update signups set confirmed = 1, ' +
      "confirmed_at = coalesce(confirmed_at, datetime('now')) " +
      'where token = ?1 and unsubscribed_at is null'
    )
    .bind(token)
    .run();

  if (!r.meta?.changes) {
    const left = await env.DB
      .prepare('select 1 as n from signups where token = ?1 and unsubscribed_at is not null')
      .bind(token)
      .first();
    if (left) {
      return page(409, 'You unsubscribed from this list',
        'This is an older email, and the link in it no longer adds you back. ' +
        'If that was a mistake, sign up again at prove10.com.');
    }
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

/**
 * HTTP basic auth. The username is ignored; only the password is
 * checked, against a constant-time comparison of SHA-256 digests so a
 * wrong guess takes the same time whatever its first characters are.
 */
async function authorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;

  const header = request.headers.get('Authorization') ?? '';
  const space = header.indexOf(' ');
  if (space < 0 || header.slice(0, space).toLowerCase() !== 'basic') return false;

  let decoded;
  try {
    decoded = atob(header.slice(space + 1).trim());
  } catch {
    return false;
  }

  const colon = decoded.indexOf(':');
  if (colon < 0) return false;

  const [supplied, expected] = await Promise.all([
    sha256Bytes(decoded.slice(colon + 1)),
    sha256Bytes(env.ADMIN_PASSWORD),
  ]);
  return crypto.subtle.timingSafeEqual(supplied, expected);
}

function askForPassword() {
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Prove10", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/** The list. Addresses are on this page, so it is never cached or indexed. */
async function admin(request, env) {
  if (!await authorized(request, env)) return askForPassword();

  const { results } = await env.DB
    .prepare(
      'select email, country, confirmed, confirmed_at, unsubscribed_at, created_at ' +
      'from signups order by created_at desc limit ?1'
    )
    .bind(ADMIN_PAGE_ROWS)
    .all();

  const rows = results ?? [];
  const mailable = rows.filter((r) => r.confirmed && !r.unsubscribed_at).length;
  const waiting = rows.filter((r) => !r.confirmed && !r.unsubscribed_at).length;
  const gone = rows.filter((r) => r.unsubscribed_at).length;

  const state = (r) => {
    if (r.unsubscribed_at) return ['gone', 'unsubscribed'];
    if (r.confirmed) return ['ok', 'confirmed'];
    return ['wait', 'unconfirmed'];
  };

  const body = rows.map((r) => {
    const [cls, label] = state(r);
    return '<tr><td class="e">' + escapeHtml(r.email) + '</td>' +
      '<td>' + escapeHtml(r.country || '—') + '</td>' +
      '<td><span class="tag ' + cls + '">' + label + '</span></td>' +
      '<td class="t">' + escapeHtml(r.created_at) + '</td></tr>';
  }).join('');

  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark"><meta name="robots" content="noindex, nofollow">' +
    '<title>Prove10 list</title>' + ICONS + '<style>' + SHELL_CSS +
    'body{padding-block:clamp(1.5rem,5vh,2.75rem)}' +
    'main{max-width:60rem;margin-inline:auto;display:grid;gap:1.5rem}' +
    '.counts{display:flex;flex-wrap:wrap;gap:1.5rem;margin:0;padding:0;list-style:none;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.8125rem;color:#7c879c}' +
    '.counts b{display:block;font-size:1.5rem;font-weight:400;color:#e9edf6}' +
    '.wrap{overflow-x:auto}' +
    'table{width:100%;border-collapse:collapse;font-size:0.875rem}' +
    'th{text-align:left;font-weight:400;color:#7c879c;padding:0.5rem 0.75rem 0.5rem 0;' +
    'border-bottom:1px solid #39425a;white-space:nowrap}' +
    'td{padding:0.6rem 0.75rem 0.6rem 0;border-bottom:1px solid #141a2a;vertical-align:top}' +
    '.e{word-break:break-all}' +
    '.t{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
    'font-size:0.75rem;color:#7c879c;white-space:nowrap}' +
    '.tag{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.6875rem;' +
    'padding:0.15rem 0.45rem;border:1px solid currentColor;border-radius:2px;white-space:nowrap}' +
    '.tag.ok{color:#8fa6ff}.tag.wait{color:#7c879c}.tag.gone{color:#5b6479}' +
    '.foot{margin:0;font-size:0.8125rem;color:#7c879c}' +
    '</style></head><body><main>' +
    LOCKUP +
    '<h1>The list</h1>' +
    '<ul class="counts">' +
    '<li><b>' + mailable + '</b>mailable</li>' +
    '<li><b>' + waiting + '</b>awaiting confirmation</li>' +
    '<li><b>' + gone + '</b>unsubscribed</li>' +
    '</ul>' +
    (rows.length
      ? '<div class="wrap"><table><thead><tr><th>Email</th><th>Country</th>' +
        '<th>State</th><th>Signed up (UTC)</th></tr></thead><tbody>' + body +
        '</tbody></table></div>'
      : '<p class="foot">Nobody yet.</p>') +
    '<p class="foot">Only the mailable count may be sent to. ' +
    'Newest first, up to ' + ADMIN_PAGE_ROWS + ' rows.</p>' +
    '</main></body></html>';

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  });
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

    // /emails is the name that gets typed, /admin the one that got
    // built. Both open the same page rather than one being a redirect,
    // so a basic-auth prompt is never thrown away by a 30x hop.
    if (url.pathname === '/admin' || url.pathname === '/emails') {
      if (request.method !== 'GET') {
        return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      }
      return admin(request, env);
    }

    // robots.txt is per-host, and this host is not prove10.com. Every
    // response here already carries X-Robots-Tag: noindex, but a crawler
    // reads robots.txt before it fetches anything else, so the rule is
    // stated up front rather than left to a header it has not seen yet.
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    return json(404, { error: 'not found' }, headers);
  },
};
