/**
 * GET /state — everything the caller is allowed to see.
 *
 * An admin gets every client plus the audit trail; a client gets only their
 * own account. One endpoint means the frontend store can resync with a single
 * request after any mutation.
 */
import { Router } from "express";
import { sql, toAccount, toDeposit } from "../db.js";
import { requireSession } from "../middleware/auth.js";

const router = Router();

router.get("/", requireSession, async (req, res) => {
  if (req.session.role === "admin") {
    const [clients, auditLog, deposits] = await Promise.all([
      sql`SELECT * FROM accounts WHERE role = 'client' ORDER BY created_at ASC`,
      sql`SELECT id, at, action, detail, actor FROM audit_log ORDER BY at DESC LIMIT 60`,
      // Pending first: that queue is the reason an admin opens this page.
      sql`SELECT d.*, a.name AS account_name FROM deposits d
          JOIN accounts a ON a.id = d.account_id
          ORDER BY (d.status = 'Pending') DESC, d.created_at DESC LIMIT 60`,
    ]);
    return res.json({ clients: clients.map(toAccount), auditLog, deposits: deposits.map(toDeposit) });
  }

  const [rows, deposits] = await Promise.all([
    sql`SELECT * FROM accounts WHERE id = ${req.session.id}`,
    sql`SELECT * FROM deposits WHERE account_id = ${req.session.id} ORDER BY created_at DESC LIMIT 20`,
  ]);
  if (!rows.length) return res.status(404).json({ error: "Account not found." });
  return res.json({ clients: [toAccount(rows[0])], auditLog: [], deposits: deposits.map(toDeposit) });
});

export default router;
