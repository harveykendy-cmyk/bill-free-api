require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});
(async () => {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Bill-Free database schema initialized.');
  } finally { await pool.end(); }
})().catch(err => { console.error(err); process.exit(1); });