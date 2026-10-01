/**
 * Client deposit requests.
 *
 * A client tells us they have sent funds to the address on their account. That
 * creates a **Pending** row and moves no money: the balance only changes when
 * an admin confirms it, once the transaction is actually visible on-chain.
 * Confirming credits the deposit and available balances and writes a ledger
 * row, so the client's statement matches what the desk did.
 */
import { Router } from "express";
import { sql, toAccount, toDeposit, audit } from "../db.js";
import { requireSession, requireAdmin } from "../middleware/auth.js";

const router = Router();

const MAX_HISTORY = 12;

/** @param {number[]} series @param {number} value @returns {number[]} */
function pushHistory(series = [], value) {
  const next = [...series, value];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

/** @param {unknown} raw @returns {number} */
function parseAmount(raw) {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/* ---- POST /deposits — a client announces an incoming transfer ------ */
router.post("/", requireSession, async (req, res) => {
  const rows = await sql`SELECT * FROM accounts WHERE id = ${req.session.id}`;
  if (!rows.length) return res.status(404).json({ error: "Account not found." });
  const account = toAccount(rows[0]);

  if (account.status === "Pending") {
    return res.status(403).json({ error: "Your account is still under review." });
  }
  if (!account.walletAddress) {
    return res.status(409).json({ error: "No deposit address is set on your account yet. Contact your desk." });
  }

  const amount = parseAmount(req.body?.amount);
  if (amount <= 0) return res.status(422).json({ error: "Enter the amount you sent.", field: "amount" });

  const [row] = await sql`
    INSERT INTO deposits (id, account_id, amount, currency, asset, wallet_address, reference)
    VALUES (${"dep_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)},
            ${account.id}, ${amount}, ${account.currency}, ${account.walletAsset},
            ${account.walletAddress}, ${String(req.body?.reference ?? "").trim().slice(0, 200)})
    RETURNING *
  `;

  await audit("Deposit declared", `${account.name}: ${account.currency} ${amount.toFixed(2)} awaiting confirmation`, account.name);
  return res.status(201).json({ deposit: toDeposit(row) });
});

/* ---- PATCH /deposits/:id — the desk confirms or rejects ------------ */
router.patch("/:id", requireAdmin, async (req, res) => {
  const status = req.body?.status;
  if (!["Confirmed", "Rejected"].includes(status)) {
    return res.status(422).json({ error: "Status must be Confirmed or Rejected." });
  }

  const found = await sql`SELECT * FROM deposits WHERE id = ${req.params.id}`;
  if (!found.length) return res.status(404).json({ error: "No such deposit." });
  const deposit = toDeposit(found[0]);
  if (deposit.status !== "Pending") {
    return res.status(409).json({ error: `This deposit is already ${deposit.status.toLowerCase()}.` });
  }

  const accountRows = await sql`SELECT * FROM accounts WHERE id = ${deposit.accountId}`;
  if (!accountRows.length) return res.status(404).json({ error: "Account not found." });
  const account = toAccount(accountRows[0]);

  const note = String(req.body?.note ?? "").trim().slice(0, 200);

  const [updated] = await sql`
    UPDATE deposits SET status = ${status}, note = ${note}, settled_at = now()
    WHERE id = ${deposit.id} RETURNING *
  `;

  if (status === "Rejected") {
    await audit("Deposit rejected", `${account.name}: ${deposit.currency} ${deposit.amount.toFixed(2)}${note ? ` · ${note}` : ""}`, req.session.name);
    return res.json({ deposit: toDeposit(updated), client: account });
  }

  // Confirmed: credit both the running deposit total and the tradable balance,
  // and leave a ledger row so the client can see where the money came from.
  const balances = {
    ...account.balances,
    deposit: Math.round((account.balances.deposit + deposit.amount) * 100) / 100,
    available: Math.round((account.balances.available + deposit.amount) * 100) / 100,
  };
  const history = {
    ...account.history,
    deposit: pushHistory(account.history.deposit, balances.deposit),
    available: pushHistory(account.history.available, balances.available),
  };
  const entry = {
    id: `tx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    date: new Date().toISOString().slice(0, 10),
    type: "Deposit",
    channel: `${deposit.asset} · ${deposit.walletAddress.slice(0, 10)}…`,
    amount: deposit.amount,
    status: "Cleared",
  };

  const [creditedRow] = await sql`
    UPDATE accounts SET balances = ${JSON.stringify(balances)},
                        history = ${JSON.stringify(history)},
                        transactions = ${JSON.stringify([entry, ...account.transactions])},
                        updated_at = now()
    WHERE id = ${account.id} RETURNING *
  `;

  await audit("Deposit confirmed", `${account.name}: ${deposit.currency} ${deposit.amount.toFixed(2)} credited`, req.session.name);
  return res.json({ deposit: toDeposit(updated), client: toAccount(creditedRow) });
});

export default router;
