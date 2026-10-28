create table if not exists signups (
  email           text primary key,
  ip_hash         text not null,
  country         text,
  confirmed       integer not null default 0,
  token           text,
  confirmed_at    text,
  unsubscribed_at text,
  created_at      text not null,
  -- What each person agreed to, verbatim. Added by migration 0003 and
  -- carried here too: this file is what a fresh database is built from,
  -- and the Worker writes this column on every signup.
  consent         text
);

-- supports the per-IP rate limit lookup
create index if not exists signups_ip_recent on signups (ip_hash, created_at);

-- confirm and unsubscribe links are looked up by token
create unique index if not exists signups_token on signups (token);
