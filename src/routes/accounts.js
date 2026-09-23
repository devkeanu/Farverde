/**
 * The Control desk's write path. Admin only, throughout.
 */
import { Router } from "express";
import { sql, toAccount, audit } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { revokeAllForAccount } from "../tokens.js";

const router = Router();

const BALANCE_KEYS = ["credit", "withdraw", "outstanding", "loan"];
const MAX_HISTORY = 12;
const STATUSES = ["Pending", "Active", "Restricted", "Suspended", "Closed"];
const TIERS = ["Standard", "Prime", "Raw Spread", "Islamic"];

/**
 * Append a datapoint, keeping the series at its fixed length.
 * @param {number[]} series @param {number} value @returns {number[]}
 */
function pushHistory(series = [], value) {
  const next = [...series, value];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

/** @param {unknown} raw @returns {number} A money value rounded to cents. */
function parseAmount(raw) {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Load the client named in the route, or answer 404.
 * @type {import('express').RequestHandler}
 */
async function loadClient(req, res, next) {
  const rows = await sql`SELECT * FROM accounts WHERE id = ${req.params.id} AND role = 'client'`;
  if (!rows.length) return res.status(404).json({ error: "No such client." });
  req.client = toAccount(rows[0]);
  next();
}

router.use("/:id", requireAdmin, loadClient);

/* ---- PATCH /accounts/:id ------------------------------------------ */
router.patch("/:id", async (req, res) => {
  const client = req.client;
  const { id } = req.params;

  /* absolute balances */
  if (req.body?.balances) {
    const balances = { ...client.balances };
    const history = { ...client.history };
    const changes = [];

    for (const key of BALANCE_KEYS) {
      if (req.body.balances[key] === undefined) continue;
      const value = parseAmount(req.body.balances[key]);
      if (value === client.balances[key]) continue;
      changes.push(`${key} ${client.balances[key].toFixed(2)} → ${value.toFixed(2)}`);
      balances[key] = value;
      history[key] = pushHistory(client.history[key], value);
    }
    if (!changes.length) return res.json({ client });

    const [updated] = await sql`
      UPDATE accounts SET balances = ${JSON.stringify(balances)}, history = ${JSON.stringify(history)},
                          updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    await audit("Balances updated", `${client.name}: ${changes.join(", ")}`, req.session.name);
    return res.json({ client: toAccount(updated) });
  }

  /* nudge one balance */
  if (req.body?.adjust) {
    const { key, delta } = req.body.adjust;
    if (!BALANCE_KEYS.includes(key)) return res.status(422).json({ error: "Unknown balance." });
    const value = Math.round((client.balances[key] + Number(delta)) * 100) / 100;
    const balances = { ...client.balances, [key]: value };
    const history = { ...client.history, [key]: pushHistory(client.history[key], value) };

    const [updated] = await sql`
      UPDATE accounts SET balances = ${JSON.stringify(balances)}, history = ${JSON.stringify(history)},
                          updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    const sign = Number(delta) > 0 ? "+" : "−";
    await audit("Balance adjusted", `${client.name}: ${key} ${sign}${Math.abs(Number(delta)).toFixed(2)}`, req.session.name);
    return res.json({ client: toAccount(updated) });
  }

  /* profile, status and the approval step */
  if (req.body?.profile) {
    const p = req.body.profile;
    if (p.status && !STATUSES.includes(p.status)) return res.status(422).json({ error: "Unknown status." });
    if (p.tier && !TIERS.includes(p.tier)) return res.status(422).json({ error: "Unknown tier." });

    const next = {
      status: p.status ?? client.status,
      tier: p.tier ?? client.tier,
      currency: p.currency ?? client.currency,
      leverage: p.leverage ?? client.leverage,
      creditLimit: p.creditLimit === undefined ? client.creditLimit : parseAmount(p.creditLimit),
      notice: p.notice === undefined ? client.notice : String(p.notice),
    };

    const [updated] = await sql`
      UPDATE accounts SET status = ${next.status}, tier = ${next.tier}, currency = ${next.currency},
                          leverage = ${next.leverage}, credit_limit = ${next.creditLimit},
                          notice = ${next.notice}, updated_at = now()
      WHERE id = ${id} RETURNING *
    `;

    // Closing an account must also end its sessions, or the holder keeps a
    // working refresh token for up to a week.
    if (next.status === "Closed") await revokeAllForAccount(id);

    const approved = client.status === "Pending" && next.status === "Active";
    const changed = Object.keys(next).filter((k) => String(next[k]) !== String(client[k]));
    await audit(
      approved ? "Account approved" : "Profile updated",
      approved ? `${client.name} · ${client.id} activated` : `${client.name}: ${changed.join(", ") || "no change"}`,
      req.session.name
    );
    return res.json({ client: toAccount(updated) });
  }

  return res.status(422).json({ error: "Nothing to update." });
});

/* ---- POST /accounts/:id/transactions ------------------------------ */
router.post("/:id/transactions", async (req, res) => {
  const client = req.client;
  const entry = {
    id: `tx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    date: req.body?.date ?? new Date().toISOString().slice(0, 10),
    type: req.body?.type ?? "Deposit",
    channel: String(req.body?.channel ?? "").trim(),
    amount: parseAmount(req.body?.amount),
    status: req.body?.status ?? "Cleared",
  };

  const transactions = [entry, ...client.transactions];
  let balances = client.balances;
  let history = client.history;

  if (BALANCE_KEYS.includes(req.body?.applyTo)) {
    const key = req.body.applyTo;
    const value = Math.round((client.balances[key] + entry.amount) * 100) / 100;
    balances = { ...client.balances, [key]: value };
    history = { ...client.history, [key]: pushHistory(client.history[key], value) };
  }

  const [updated] = await sql`
    UPDATE accounts SET transactions = ${JSON.stringify(transactions)},
                        balances = ${JSON.stringify(balances)},
                        history = ${JSON.stringify(history)},
                        updated_at = now()
    WHERE id = ${req.params.id} RETURNING *
  `;
  await audit("Transaction added", `${client.name}: ${entry.type} ${entry.amount}`, req.session.name);
  return res.status(201).json({ client: toAccount(updated) });
});

/* ---- DELETE /accounts/:id/transactions/:txId ---------------------- */
router.delete("/:id/transactions/:txId", async (req, res) => {
  const client = req.client;
  const remaining = client.transactions.filter((t) => t.id !== req.params.txId);
  if (remaining.length === client.transactions.length) {
    return res.status(404).json({ error: "No such movement." });
  }

  const [updated] = await sql`
    UPDATE accounts SET transactions = ${JSON.stringify(remaining)}, updated_at = now()
    WHERE id = ${req.params.id} RETURNING *
  `;
  await audit("Transaction removed", `${client.name}: ${req.params.txId}`, req.session.name);
  return res.json({ client: toAccount(updated) });
});

export default router;
