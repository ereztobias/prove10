-- The table as it stood before 0002, reconstructed from the deployed
-- database rather than written fresh.
--
-- It is deliberately the *old* five-column shape, not the current one:
-- 0002 and 0003 add their columns with ALTER TABLE, so a baseline that
-- already had `token` or `consent` would make the chain fail on a database
-- built from nothing. schema.sql is where the current shape lives; this
-- file is only the starting point the two migrations after it assume.
--
-- The deployed database was built by hand before any of this existed and
-- so has no row for this migration either. It is marked applied there by
-- the one-off in README.md, under "Baselining the deployed database".
create table if not exists signups (
  email      text primary key,
  ip_hash    text not null,
  country    text,
  confirmed  integer not null default 0,
  created_at text not null
);

-- supports the per-IP rate limit lookup
create index if not exists signups_ip_recent on signups (ip_hash, created_at);
