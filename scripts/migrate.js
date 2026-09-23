/**
 * Create the schema and seed the first admin.
 *
 *   node --env-file=.env scripts/migrate.js
 *
 * Safe to re-run: every statement is idempotent and the admin is upserted.
 */
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set so there is someone to sign in as.");
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 12) {
  console.error("ADMIN_PASSWORD must be at least 12 characters.");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS accounts (
    id            text PRIMARY KEY,
    role          text NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
    name          text NOT NULL,
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    status        text NOT NULL DEFAULT 'Pending',
    tier          text NOT NULL DEFAULT 'Standard',
    currency      text NOT NULL DEFAULT 'USD',
    leverage      text NOT NULL DEFAULT '1:20',
    credit_limit  numeric NOT NULL DEFAULT 0,
    notice        text NOT NULL DEFAULT '',
    balances      jsonb NOT NULL DEFAULT '{"credit":0,"withdraw":0,"outstanding":0,"loan":0}'::jsonb,
    history       jsonb NOT NULL DEFAULT '{"credit":[],"withdraw":[],"outstanding":[],"loan":[]}'::jsonb,
    holdings      jsonb NOT NULL DEFAULT '[]'::jsonb,
    transactions  jsonb NOT NULL DEFAULT '[]'::jsonb,
    joined        date NOT NULL DEFAULT current_date,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS audit_log (
    id     text PRIMARY KEY,
    at     timestamptz NOT NULL DEFAULT now(),
    action text NOT NULL,
    detail text NOT NULL,
    actor  text NOT NULL
  )
`;

await sql`CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_idx ON accounts (lower(email))`;
await sql`CREATE INDEX IF NOT EXISTS accounts_role_idx ON accounts (role)`;
await sql`CREATE INDEX IF NOT EXISTS refresh_tokens_account_idx ON refresh_tokens (account_id)`;
await sql`CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC)`;

const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
await sql`
  INSERT INTO accounts (id, role, name, email, password_hash, status, tier, credit_limit)
  VALUES ('adm_01', 'admin', ${ADMIN_NAME ?? "Desk Administrator"}, ${ADMIN_EMAIL.toLowerCase()},
          ${hash}, 'Active', 'Prime', 0)
  ON CONFLICT (id) DO UPDATE
    SET email = excluded.email, password_hash = excluded.password_hash, name = excluded.name
`;

const [{ count }] = await sql`SELECT count(*)::int AS count FROM accounts`;
console.log(`Schema ready. Admin is ${ADMIN_EMAIL.toLowerCase()}. Accounts on file: ${count}.`);
