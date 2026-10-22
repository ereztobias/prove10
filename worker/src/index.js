/**
 * prove10 signup endpoint.
 *
 * Runs on api.prove10.com so the apex stays DNS-only and GitHub Pages
 * keeps renewing its own certificate. Stores addresses in D1.
 *
 * Deliberate choices:
 *  - Answers 200 whether the address is new or already stored, so the
 *    endpoint cannot be used to test who is on the list.
 *  - Keeps a salted hash of the IP, never the address itself, and only
 *    to rate limit.
 *  - Marks rows unconfirmed. Double opt-in needs an email provider,
 *    which is not wired up yet; see README.
 */

const ALLOWED_ORIGINS = new Set([
  'https://prove10.com',
  'https://www.prove10.com',
]);

// Deliberately boring: catches typos, does not try to out-parse RFC 5322.
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

const MAX_PER_IP_PER_HOUR = 10;

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin);
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (pathname !== '/subscribe') {
      return json(404, { error: 'not found' }, headers);
    }
    if (request.method !== 'POST') {
      return json(405, { error: 'method not allowed' }, { ...headers, Allow: 'POST, OPTIONS' });
    }
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

    const ip = request.headers.get('CF-Connecting-IP') ?? '';
    const ipHash = await sha256Hex(ip + env.IP_SALT);

    try {
      const recent = await env.DB
        .prepare(
          "select count(*) as n from signups " +
          "where ip_hash = ?1 and created_at > datetime('now', '-1 hour')"
        )
        .bind(ipHash)
        .first();

      if ((recent?.n ?? 0) >= MAX_PER_IP_PER_HOUR) {
        return json(429, { error: 'too many requests' }, { ...headers, 'Retry-After': '3600' });
      }

      await env.DB
        .prepare(
          "insert into signups (email, ip_hash, country, created_at) " +
          "values (?1, ?2, ?3, datetime('now')) on conflict(email) do nothing"
        )
        .bind(email, ipHash, request.cf?.country ?? null)
        .run();
    } catch (err) {
      console.error('d1 write failed', err);
      return json(500, { error: 'could not store that' }, headers);
    }

    return json(200, { ok: true }, headers);
  },
};
