import { env } from 'cloudflare:workers';
import worker from '../src/index.js';

/** One request through the whole Worker, the way a browser or mail client sends it. */
export const call = (path, init = {}, over = {}) =>
  worker.fetch(new Request('https://api.prove10.com' + path, init), { ...env, ...over });

/**
 * Run a .sql file the way Wrangler does: statement by statement.
 *
 * Comments are stripped before the split, not after: these files have a
 * ";" inside a comment, and splitting first leaves half a sentence where a
 * statement should be.
 */
export async function applySql(sql) {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await env.DB.prepare(statement).run();
}

/**
 * A table's shape, as two sets that do not depend on the order columns
 * were added in: what SQLite would have to disagree about for the Worker
 * to behave differently.
 */
export async function shapeOf(table) {
  const by = (k) => (a, b) => a[k].localeCompare(b[k]);
  const { results: columns } = await env.DB.prepare(`pragma table_info(${table})`).all();
  const { results: indexes } = await env.DB
    .prepare("select name, sql from sqlite_master where type = 'index' and tbl_name = ?1")
    .bind(table)
    .all();
  return {
    columns: columns
      .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
      .sort(by('name')),
    indexes: indexes
      .map(({ name, sql }) => ({ name, sql: sql?.replace(/\s+/g, ' ').trim() ?? null }))
      .sort(by('name')),
  };
}

export async function clearAll() {
  await env.DB.prepare('delete from signups').run();
}

export const TOKEN_A = 'a'.repeat(64);
export const TOKEN_B = 'b'.repeat(64);
export const PASSWORD = 'correct-horse-battery-staple';

/** A row in whatever state a test needs, without going through /subscribe. */
export async function seed({
  email = 'reader@example.com',
  token = TOKEN_A,
  confirmed = 0,
  confirmedAt = null,
  unsubscribedAt = null,
  ipHash = 'hash',
  country = 'IL',
} = {}) {
  await env.DB
    .prepare(
      'insert into signups (email, ip_hash, country, confirmed, token, ' +
      'confirmed_at, unsubscribed_at, created_at) ' +
      "values (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))"
    )
    .bind(email, ipHash, country, confirmed, token, confirmedAt, unsubscribedAt)
    .run();
}

export const row = (email = 'reader@example.com') =>
  env.DB.prepare('select * from signups where email = ?1').bind(email).first();

export const count = () =>
  env.DB.prepare('select count(*) as n from signups').first().then((r) => r.n);

/** The single <h1> each shell page carries, which is how it names itself. */
export const heading = (html) => html.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? null;

export const basic = (password, user = 'anyone') => 'Basic ' + btoa(user + ':' + password);

/** A signup, with the headers a browser on the site would send. */
export function signup(email, { origin = null, ip = '203.0.113.1', over = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  return call('/subscribe', { method: 'POST', headers, body: JSON.stringify({ email }) }, over);
}
