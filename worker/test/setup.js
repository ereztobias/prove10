import { beforeAll } from 'vitest';
import schema from '../schema.sql?raw';
import { applySql } from './helpers.js';

// Built from schema.sql, so a column the Worker writes but schema.sql has
// forgotten fails here rather than on the first signup after a rebuild.
// The migrations are the record of how the deployed database got here;
// this file is what it should look like now, and schema.test.js is what
// keeps the two from drifting apart.
beforeAll(async () => {
  await applySql(schema);
});
