create table if not exists signups (
  email      text primary key,
  ip_hash    text not null,
  country    text,
  confirmed  integer not null default 0,
  created_at text not null
);

-- supports the per-IP rate limit lookup
create index if not exists signups_ip_recent on signups (ip_hash, created_at);
