# prove10 signup endpoint

A Cloudflare Worker that takes an email address from the landing page,
stores it in D1, and handles double opt-in. No dependencies.

## Why it lives on api.prove10.com

The apex `prove10.com` is served by GitHub Pages and must stay **DNS-only**
in Cloudflare (grey cloud). Proxying the apex would stop GitHub completing
its HTTP-01 certificate renewals, and would put a second certificate in
front of one that already works. So the Worker gets its own hostname and
the page calls it cross-origin, with CORS limited to the two real origins.

## Routes

| Route | Does |
|---|---|
| `POST /subscribe` | `{ "email": "..." }` → `{ "ok": true }`, stores the row, mails the confirmation link if a provider is configured |
| `GET /confirm?t=` | sets `confirmed = 1` and `confirmed_at` |
| `GET /unsubscribe?t=` | sets `unsubscribed_at`, clears `confirmed` |

`/confirm` and `/unsubscribe` return a small dark page in the site's own
clothes. The token is 32 random bytes as hex and is per address, not per
send, so an old link keeps working.

## Deploy

```sh
cd worker
npx wrangler deploy
```

Already provisioned: database `prove10-signups`
(`c3ddbd73-6496-4751-8084-6c78d9acd36e`, region WEUR), the
`api.prove10.com` custom domain, and the `IP_SALT` secret.

From scratch it would be:

```sh
npx wrangler d1 create prove10-signups   # paste database_id into wrangler.toml
npx wrangler d1 execute prove10-signups --remote --file=./schema.sql
npx wrangler secret put IP_SALT          # any long random string
npx wrangler deploy
```

## Turning sending on

Nothing is mailed until both of these exist:

```sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM        # e.g. prove10 <hello@prove10.com>
```

Without them a signup is still stored, just unconfirmed, and no mail goes
out. That is the current state. The sender is Resend; swapping providers
means editing `sendConfirmation` and nothing else.

A sending domain has to be verified with the provider before anything
delivers, which means DKIM and SPF records in Cloudflare DNS for
`prove10.com`. Those are additions, and they do not touch the apex A
records GitHub Pages needs.

## Who may be mailed

**Only this set.** Nothing else should ever feed a send:

```sql
select email from signups
where confirmed = 1 and unsubscribed_at is null;
```

Not `confirmed_at is not null`. That column records when consent was first
given and stays put; someone who unsubscribes and later re-enters their
address has `confirmed` back at `0` until they click a fresh confirmation
link.

Every send must carry the unsubscribe link for that row:

```
https://api.prove10.com/unsubscribe?t=<token>
```

## Read the list

```sh
npx wrangler d1 execute prove10-signups --remote \
  --command "select email, country, confirmed, created_at from signups order by created_at desc"
```

## What it does and does not do

- Answers `200` whether the address is new or already present, so nobody
  can use the endpoint to test who signed up.
- Stores a salted SHA-256 of the IP, never the IP, and only to rate limit
  (10 per hour per address-hash).
- Rejects a browser `Origin` that is not prove10.com or www.prove10.com.
- Caps the address at 254 characters and checks a deliberately plain
  pattern.
- Keeps unsubscribed rows, marked, so a later import cannot quietly
  re-add someone who left.

**No send machinery beyond the confirmation mail.** There is no campaign
sender, no template, no scheduling. When the first real email goes out it
has to pull the mailable set above and include each row's unsubscribe
link, or the promise on the page is broken.
