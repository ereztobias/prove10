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
| `GET /confirm?t=` | shows a confirm button; changes nothing |
| `POST /confirm?t=` | sets `confirmed = 1` and `confirmed_at` |
| `GET /unsubscribe?t=` | shows an unsubscribe button; changes nothing |
| `POST /unsubscribe?t=` | sets `unsubscribed_at`, clears `confirmed`; also the RFC 8058 one-click target |
| `GET /admin`, `GET /emails` | the same list, behind HTTP basic auth |

`/confirm` and `/unsubscribe` return a small dark page in the site's own
clothes. The token is 32 random bytes as hex and is per address, not per
send, so an old link keeps working.

## Deploy

A push to `main` that touches `worker/` deploys it:
`.github/workflows/deploy.yml` runs the suite, applies any pending
migration to the deployed database, then deploys the Worker. It needs two
repository secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`,
and fails loudly without them rather than going green having shipped
nothing.

By hand, when that is what you want:

```sh
cd worker
npx wrangler d1 migrations apply prove10-signups --remote
npx wrangler deploy
```

Secrets are not part of a deploy. `IP_SALT`, `ADMIN_PASSWORD`,
`RESEND_API_KEY` and `MAIL_FROM` live on the Worker and survive it
untouched.

Already provisioned: database `prove10-signups`
(`c3ddbd73-6496-4751-8084-6c78d9acd36e`, region WEUR), the
`api.prove10.com` custom domain, and the `IP_SALT` secret.

From scratch it would be:

```sh
npx wrangler d1 create prove10-signups   # paste database_id into wrangler.toml
npx wrangler d1 migrations apply prove10-signups --remote
npx wrangler secret put IP_SALT          # any long random string
npx wrangler deploy
```

## Migrations

`migrations/` is the history and the only thing that touches a real
database. `schema.sql` is the shape that history should arrive at: the
suite builds from it, and `test/schema.test.js` applies the whole chain to
an empty database and fails if the two have drifted. Never apply
`schema.sql` to a database that already exists.

```sh
npm run migrate:local    # the local copy under .wrangler/
npm run migrate:remote   # the deployed one
```

### Baselining the deployed database

**Done once, on 2026-10-29. Kept here as the record of why the ledger has
rows nothing applied.**

The deployed database was built before `migrations/` existed: an older
five-column `schema.sql` run by hand, then `0002` and `0003` run by hand
on top. So it had the final shape but no `d1_migrations` ledger, and the
first `migrations apply --remote` would have tried `0002` again and failed
on `duplicate column name: token`.

`0001_init.sql` reconstructs the five-column table it started from, which
is why that file is the old shape and not the current one. Applying the
chain to an empty database now reproduces the deployed `signups` DDL
byte for byte. The ledger was then written to say so:

```sh
npx wrangler d1 execute prove10-signups --remote --command 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'

npx wrangler d1 execute prove10-signups --remote --command "insert or ignore into d1_migrations (name) values ('0001_init.sql'), ('0002_tokens.sql'), ('0003_consent.sql')"
```

Two commands, not one file, and not one command either. `--remote --file`
goes through D1's import API and answered `Authentication error [code:
10000]` on an OAuth login that has `d1 (write)`; both statements in a
single `--command` answered `incomplete input: SQLITE_ERROR`. One
statement per `--command` works.

The table definition is Wrangler's own, copied from
`node_modules/wrangler` so the ledger it later reads is the one it would
have made itself. `insert or ignore` makes it safe to run twice.
Afterwards `npx wrangler d1 migrations apply prove10-signups --remote`
reports `No migrations to apply!`, which is what it reported on
2026-10-29 with the five existing rows still in place.

## The list page

`https://api.prove10.com/emails` (or `/admin`) shows every address with its state and
the three counts that matter: mailable, awaiting confirmation,
unsubscribed. It is the reason not to go hunting in the Resend log,
which only records sends and expires.

```sh
npx wrangler secret put ADMIN_PASSWORD   # any long random string
```

**No password, no page.** With `ADMIN_PASSWORD` unset the route answers
`401` to everyone, so an unconfigured Worker is closed rather than open.
The username is ignored; only the password is checked, by constant-time
comparison of SHA-256 digests. The page sends `Cache-Control:
no-store, private`, `X-Robots-Tag: noindex` and `Referrer-Policy:
no-referrer`, because real addresses are on it.

It cannot live at `prove10.com/admin`. Worker routes only fire on
proxied hostnames, and the apex must stay DNS-only for GitHub Pages, so
`api.prove10.com` is the only place it can go without a second
certificate in front of a working one.

Basic auth over TLS is adequate for one person and one list. If more
people ever need it, put Cloudflare Access in front of the hostname
instead of sharing the password.

## Telling yourself about a signup

```sh
npx wrangler secret put NOTIFY_TO         # where to send the alert
```

Set it and every genuinely new address sends you a note with the
address, the country and the running total, with `Reply-To` set to the
person who signed up. Unset it and nothing is sent. That secret is the
whole switch.

A re-submit of an address already on the list sends nothing. The code
asks whether the row exists *before* the upsert, because
`insert ... on conflict do update` reports `changes = 1` either way and
cannot tell an insert from an update.

## Turning sending on

Nothing is mailed until both of these exist:

```sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM        # e.g. prove10 <hello@prove10.com>
```

Without them a signup is still stored, just unconfirmed, and no mail goes
out. The sender is Resend; swapping providers means editing `sendMail`
and nothing else.

Verified and live for `prove10.com`: DKIM at `resend._domainkey`, SPF
through the `send` and `rsend` CNAMEs. The envelope sender is
`send.prove10.com`, which is why the apex SPF record needs no Resend
entry; DMARC passes on relaxed alignment.

A sending domain has to be verified with the provider before anything
delivers, which means DKIM and SPF records in Cloudflare DNS for
`prove10.com`. Those are additions, and they do not touch the apex A
records GitHub Pages needs.

## The postal address

```sh
npx wrangler secret put POSTAL_ADDRESS   # e.g. prove10, 12 Example St, Tel Aviv 6120101, Israel
```

Set it and it prints on its own line in every mail footer, under the
contact address. Unset and the line is simply absent, which is why the
code checks rather than interpolating: a footer reading `undefined`
under the sender's name is worse than no footer line.

A commercial email is expected to carry a real postal address; a
home address is lawful and ordinary for a company that has none yet.
The confirmation mail is transactional and arguably exempt, but it
costs nothing to carry the line there too, and it means the first real
send inherits it instead of needing a code change on the day.

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

It must also carry that row's unsubscribe headers, which is what
`unsubscribeHeaders(token)` builds and `sendMail`'s `headers` option passes
through to Resend:

```
List-Unsubscribe: <https://api.prove10.com/unsubscribe?t=<token>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Same URL as the footer link, so the POST a provider sends is the one the
unsubscribe page's own button sends. The confirmation mail already carries
both; the owner notification does not, because it is not a list mail.

## Read the list

The page at `/admin` is the easy way. From a terminal:

```sh
npx wrangler d1 execute prove10-signups --remote \
  --command "select email, country, confirmed, created_at from signups order by created_at desc"
```

## Logs

`[observability]` is on, so the Worker's own `console` output is kept
for a week and readable in the Cloudflare dashboard under the Worker's
Logs tab. That is where a refused send shows up with Resend's exact
status and body; Resend's own dashboard never sees a send it rejected.
Live instead of retained:

```sh
npx wrangler tail
```

No address is ever logged. Addresses are read on `/admin`.

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
link and unsubscribe headers, or the promise on the page is broken.
- Serves `/admin` only when `ADMIN_PASSWORD` is set, never cached, never
  indexed, no referrer.
