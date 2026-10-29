import { env } from 'cloudflare:workers';
import { afterAll, expect, it } from 'vitest';
import schema from '../schema.sql?raw';
import { applySql, shapeOf } from './helpers.js';

// Every migration, in filename order, which is the order Wrangler applies
// them in. Imported as a glob so a new 0004 is covered by this test the
// moment it lands, without anyone remembering to add it here.
const migrations = Object.entries(
  import.meta.glob('../migrations/*.sql', { query: '?raw', import: 'default', eager: true })
).sort(([a], [b]) => a.localeCompare(b));

// CI applies the migrations to the deployed database and then deploys the
// Worker against it. That is only safe if the chain ends up where
// schema.sql says it should: schema.sql is what the suite builds from, so
// a chain that drifts from it would leave the tests passing against a
// shape production does not have.
it('ends up where schema.sql says, starting from nothing', async () => {
  const wanted = await shapeOf('signups');

  await env.DB.prepare('drop table signups').run();
  for (const [, sql] of migrations) await applySql(sql);

  // Compared as sets, not lists: the chain adds token and consent by
  // ALTER TABLE, so they land after created_at, while schema.sql lists
  // them where they read best. Same columns, different order on disk, and
  // SQLite does not care which.
  expect(await shapeOf('signups')).toEqual(wanted);
});

it('starts at 0001, with no gap for a migration that was never written', () => {
  const numbers = migrations.map(([path]) => Number(path.match(/(\d+)_/)[1]));
  expect(numbers).toEqual(numbers.map((_, i) => i + 1));
});

// Left as it was found, so this file can run in any order against shared
// storage: the other files expect the table schema.sql describes.
afterAll(async () => {
  await env.DB.prepare('drop table if exists signups').run();
  await applySql(schema);
});
