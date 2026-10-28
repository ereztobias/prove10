import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';
import schema from '../schema.sql?raw';

// Built from the file a fresh database is built from, so a column the
// Worker writes but schema.sql has forgotten fails here rather than on the
// first signup after a rebuild. The migrations are the record of how the
// deployed database got here; this file is what it should look like now.
//
// Comments go before the split, not after: these files have a ";" inside a
// comment, and splitting first leaves half a sentence where a statement
// should be.
beforeAll(async () => {
  const statements = schema
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await env.DB.prepare(statement).run();
});
