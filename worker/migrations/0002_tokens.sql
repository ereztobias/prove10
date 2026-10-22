-- Adds the per-row token that confirm and unsubscribe links carry, and
-- the two timestamps they set. Existing rows get a token backfilled by
-- hand below; at the time of writing the table is empty.
alter table signups add column token text;
alter table signups add column confirmed_at text;
alter table signups add column unsubscribed_at text;

create unique index if not exists signups_token on signups (token);
