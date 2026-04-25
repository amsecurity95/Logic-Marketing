// Run with: node migrate.js
import { readFileSync } from 'node:fs';
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

try {
  await pool.query(sql);
  console.log('✅ Schema applied');
} catch (e) {
  console.error('❌ Migration failed:', e);
  process.exit(1);
} finally {
  await pool.end();
}
