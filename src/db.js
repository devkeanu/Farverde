/**
 * Neon Postgres connection and row mapping.
 *
 * The serverless driver speaks HTTP, so there is no pool to manage — each
 * query is one round trip, which suits a container that may be scaled to zero.
 */
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
}

/** @type {ReturnType<typeof neon>} Tagged-template SQL client. */
export const sql = neon(process.env.DATABASE_URL);

/**
 * Shape a raw `accounts` row for the client.
 *
 * Two conversions matter: the password hash is dropped, and `numeric` columns
 * arrive from Postgres as strings — the dashboard does arithmetic on them, so
 * they have to come back as numbers.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function toAccount(row) {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    email: row.email,
    status: row.status,
    tier: row.tier,
    currency: row.currency,
    leverage: row.leverage,
    creditLimit: Number(row.credit_limit ?? 0),
    notice: row.notice ?? "",
    balances: row.balances ?? { credit: 0, withdraw: 0, outstanding: 0, loan: 0 },
    history: row.history ?? { credit: [], withdraw: [], outstanding: [], loan: [] },
    holdings: row.holdings ?? [],
    transactions: row.transactions ?? [],
    joined: row.joined ? String(row.joined).slice(0, 10) : null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Write one row to the audit trail.
 * @param {string} action Short verb phrase, e.g. "Balances updated".
 * @param {string} detail Human-readable specifics.
 * @param {string} actor  Display name of whoever caused the change.
 * @returns {Promise<void>}
 */
export async function audit(action, detail, actor) {
  await sql`
    INSERT INTO audit_log (id, action, detail, actor)
    VALUES (${"log_" + Math.random().toString(36).slice(2, 12)}, ${action}, ${detail}, ${actor})
  `;
}
