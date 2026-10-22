# prove10 signup endpoint

A Cloudflare Worker that takes an email address from the landing page and
stores it in D1. Roughly 120 lines, no dependencies.

## Why it lives on api.prove10.com

The apex `prove10.com` is served by GitHub Pages and must stay **DNS-only**
in Cloudflare (grey cloud). Proxying the apex would stop GitHub completing
its HTTP-01 certificate renewals, and would put a second certificate in
front of one that already works. So the Worker gets its own hostname and
the page calls it cross-origin, with CORS limited to the two real origins.

## Deploy

```sh
cd worker
npx wrangler d1 create prove10-signups
#   -> paste the printed database_id into wrangler.toml
npx wrangler d1 execute prove10-signups --remote --file=./schema.sql
npx wrangler secret put IP_SALT
#   -> any long random string; it salts the stored IP hashes
npx wrangler deploy
```

`custom_domain = true` makes Wrangler create the `api.prove10.com` DNS
record itself. Nothing to add by hand.

## Check it

```sh
curl -X POST https://api.prove10.com/subscribe \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://prove10.com' \
  -d '{"email":"you@example.com"}'
# {"ok":true}
```

## Read the list

```sh
npx wrangler d1 execute prove10-signups --remote \
  --command "select email, country, created_at from signups order by created_at desc"
```

## What it does and does not do

- Answers `200` whether the address is new or already present, so nobody
  can use the endpoint to test who signed up.
- Stores a salted SHA-256 of the IP, never the IP, and only to rate limit
  (10 per hour per address-hash).
- Rejects a browser `Origin` that is not prove10.com or www.prove10.com.
- Caps the address at 254 characters and checks a deliberately plain
  pattern.

**No confirmation email.** Rows land with `confirmed = 0`. Double opt-in
needs an email provider (Resend, Postmark, SES) and an API token, so it is
not wired up. Until it is, treat the list as unverified: it will contain
typos and other people's addresses typed by mistake. Do not mail it as if
every row consented.

**No unsubscribe route.** The page promises one click to stop. That
promise needs a token per row and a `GET /unsubscribe?t=...` handler before
the first campaign goes out, not before the first signup.
