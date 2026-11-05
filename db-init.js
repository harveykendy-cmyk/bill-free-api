// Creates or updates all tables. Safe to run as many times as you like.
// Works without psql: it only needs DATABASE_URL and the "pg" package.
require('dotenv').config();
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    console.log('Database is ready.');
  } catch (e) { console.error('Database setup failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
