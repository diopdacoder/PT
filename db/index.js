import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in env');
}

// Azure Postgres requires SSL. rejectUnauthorized: false is fine for personal use;
// switch to a pinned CA bundle if you ever harden this for prod.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Idempotent — runs schema.sql every boot. Safe to call repeatedly.
export async function initDb() {
  const sql = await readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}
